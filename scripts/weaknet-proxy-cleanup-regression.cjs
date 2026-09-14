/**
 * 弱网代理「残留检测 + 清理」回归验证（v1.0.1 事故的锁死测试）
 *
 * 事故现场：
 *   工具写完 `settings put global http_proxy 127.0.0.1:P` 之后，Android 的
 *   SettingsProvider 会把它**迁移**成真身键 `global_http_proxy_host` / `..._port`，
 *   并把别名 `http_proxy` 置为中性值 `:0`。旧代码只认别名，于是两头都错：
 *     · 检测：读 `http_proxy` 得到 `:0` / 空 → 判定「无残留」→ 直接 return，什么都不做；
 *     · 清理：`delete global http_proxy` → `Deleted 0 rows`（删的是空气）→ 真身一直留着。
 *   结果设备所有流量（含系统自己的联网校验探针）持续打向一个已经关闭的端口，
 *   表现成「ping 通、DNS 通，但所有 App 都上不了网」。
 *
 * 更隐蔽的一层（本脚本重点覆盖）：
 *   清理只 `delete` 也**不够**。ProxyTracker 只在键发生**变更**时刷新，
 *   键早被迁移清空的情况下 delete 不产生任何通知，内存里的旧代理照旧生效。
 *   必须 `put global http_proxy :0` 才能触发刷新。
 *   ⇒ 所以「设置里查不到代理」不能作为清理成功的判据，只有**流量**能证明。
 *
 * 断言：
 *   A. 面对「别名中性 + 真身有值」这一最难状态，新逻辑能被触发并真的清干净；
 *   B. 清理后系统的内存代理态确实刷新 —— 不再有流量打到那个端口。
 *
 * 用法：
 *   python scripts/run-electron.py scripts/weaknet-proxy-cleanup-regression.cjs \
 *     --watch ui-shots/_proxyclean.log --until "PROXY CLEANUP REGRESSION DONE"
 *
 * 环境变量：ADB_SERIAL 指定设备；SAMPLE_MS 调整流量采样时长（默认 25000）。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const ADB = path.join(ROOT, 'bin', 'adb.exe');
const ENGINE = path.join(ROOT, 'dist-electron', 'electron', 'services', 'weaknet.js');
const LOG_DIR = path.join(ROOT, 'ui-shots');
const LOG = path.join(LOG_DIR, '_proxyclean.log');

const PROXY_PORT = 17890;
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 25000);

/** 系统实际读取的真身键（与 electron/services/weaknet.ts 的 PROXY_TRUE_BODY_KEYS 对齐） */
const PROXY_TRUE_BODY = [
  'global_http_proxy_host',
  'global_http_proxy_port',
  'global_http_proxy_exclusion_list',
  'global_proxy_pac_url',
];

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

function say(line) {
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* 日志写不进去不影响判定 */
  }
}

function section(t) {
  say(`\n${'='.repeat(68)}\n${t}\n${'='.repeat(68)}`);
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
    say(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    say(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name, detail) {
  skip++;
  say(`  [SKIP] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* adb                                                                 */
/* ------------------------------------------------------------------ */

async function adb(args, timeout = 30000) {
  try {
    const { stdout, stderr } = await execFileP(ADB, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (e) {
    return {
      ok: false,
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim() || (typeof e.code === 'string' ? e.code : ''),
    };
  }
}

const sh = (serial, cmd, t) => adb(['-s', serial, 'shell', cmd], t);

/* ------------------------------------------------------------------ */
/* 代理键解析（与 weaknet.ts 的判据保持一致）                           */
/* ------------------------------------------------------------------ */

function proxyKeysOf(listOutput) {
  const m = {};
  for (const line of listOutput.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k.includes('proxy')) continue;
    m[k] = line.slice(i + 1).trim();
  }
  return m;
}

const real = (v) => !!v && v !== 'null' && v !== '';

/** 真身或别名任一非空（且非中性值）即算残留 */
function isDirty(m) {
  if (real(m['global_http_proxy_host'])) return true;
  const port = m['global_http_proxy_port'];
  if (real(port) && port !== '0') return true;
  const alias = m['http_proxy'];
  if (real(alias) && alias !== ':0' && alias !== '0') return true;
  if (real(m['global_proxy_pac_url'])) return true;
  if (real(m['global_http_proxy_exclusion_list'])) return true;
  return false;
}

function describe(m) {
  const parts = Object.entries(m)
    .filter(([, v]) => real(v))
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(' ') : '(空)';
}

/* ------------------------------------------------------------------ */
/* 流量驱动                                                            */
/* ------------------------------------------------------------------ */

/**
 * 驱动一次「真实应用」的 HTTP 请求。
 *
 * 为什么不能用设备 shell 的 curl：设备上的 curl **不读取**系统全局代理设置
 * （AOSP 行为，与桌面 curl 不同），拿它验证「全局代理是否生效」永远是假阴性。
 * 只有真实 App 才会走 ProxyTracker，所以这里必须用系统浏览器。
 */
async function driveBrowser(serial, url) {
  const r = await sh(serial, `am start -a android.intent.action.VIEW -d '${url}'`, 25000);
  return r.ok;
}

/** 查系统默认浏览器包名（用于 force-stop，保证每次都重新导航而不是恢复前台） */
async function defaultBrowserPkg(serial) {
  const r = await sh(
    serial,
    'cmd package resolve-activity --brief -a android.intent.action.VIEW -d http://example.com',
    20000,
  );
  const line = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean).pop() || '';
  const pkg = line.split('/')[0];
  return pkg || '';
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');

  /* ---------------- Stage 0 · 环境 ---------------- */
  section('Stage 0 · 环境准备');

  check('adb 存在', fs.existsSync(ADB), ADB);

  let engine = null;
  try {
    engine = require(ENGINE);
  } catch (e) {
    check('加载编译产物 weaknet.js', false, `${e.message}（先跑 tsc -p tsconfig.electron.json）`);
    return;
  }
  check('编译产物导出 cleanupStaleProxy', typeof engine.cleanupStaleProxy === 'function');

  const list = await adb(['devices']);
  const attached = list.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /\sdevice$/.test(l))
    .map((l) => l.split(/\s+/)[0]);

  let serial = process.env.ADB_SERIAL || '';
  if (!serial || !attached.includes(serial)) {
    serial = attached.find((s) => !/^emulator-/.test(s)) || attached[0] || '';
  }
  check('检测到可用设备', !!serial, serial || `在线设备：${attached.join(', ') || '无'}`);
  if (!serial) return;

  const model = (await sh(serial, 'getprop ro.product.model')).stdout;
  const rel = (await sh(serial, 'getprop ro.build.version.release')).stdout;
  say(`  设备：${model} / Android ${rel} / ${serial}`);

  /* PC 侧监听：设备经 adb reverse 打过来的连接会落在这里 */
  let hits = 0;
  const sink = net.createServer((sock) => {
    hits++;
    sock.on('error', () => {});
    sock.destroy();
  });
  try {
    await new Promise((resolve, reject) => {
      sink.once('error', reject);
      sink.listen(PROXY_PORT, '127.0.0.1', resolve);
    });
    check(`PC 监听 127.0.0.1:${PROXY_PORT}`, true, '用于观测设备是否把流量送到该端口');
  } catch (e) {
    check(`PC 监听 127.0.0.1:${PROXY_PORT}`, false, `${e.message}（端口可能被手机助手占用）`);
    return;
  }

  await adb(['-s', serial, 'reverse', '--remove', `tcp:${PROXY_PORT}`]);
  const rev = await adb(['-s', serial, 'reverse', `tcp:${PROXY_PORT}`, `tcp:${PROXY_PORT}`]);
  check('adb reverse 建立（设备 127.0.0.1 端口 → PC）', rev.ok, rev.ok ? '' : rev.stderr);

  /** 采样窗口内的新增连接数 */
  const sample = async (ms) => {
    const from = hits;
    await new Promise((r) => setTimeout(r, ms));
    return hits - from;
  };

  const browser = await defaultBrowserPkg(serial);
  say(`  默认浏览器：${browser || '(未解析出，将直接 am start)'}`);

  const hostIp = (() => {
    for (const addrs of Object.values(require('os').networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return '';
  })();
  const targetUrl = hostIp ? `http://${hostIp}:9/regress?cb=` : 'http://www.baidu.com/?cb=';

  const navTo = async () => {
    if (browser) await sh(serial, `am force-stop ${browser}`, 15000);
    await sh(serial, 'input keyevent KEYCODE_WAKEUP', 10000);
    await sh(serial, 'wm dismiss-keyguard', 10000);
    await new Promise((r) => setTimeout(r, 600));
    return driveBrowser(serial, targetUrl + Date.now());
  };

  try {
    /* ---------------- Stage 1 · 制造真身残留 ---------------- */
    section('Stage 1 · 制造「别名中性 + 真身有值」残留（旧逻辑的盲区）');

    // 严格复现事故现场。工具旧的 cleanupProxy 只 `delete global http_proxy`：
    //   ① 写代理地址 → SettingsProvider 会**立即同步出真身** host/port，
    //      别名保持原值 → ProxyTracker 加载该代理，系统开始使用它；
    //   ② 只 delete 别名（= 旧清理行为）→ 别名没了、**真身还在**、ProxyTracker 仍在用真身。
    // 这就是「settings 里查不到代理、但所有流量仍打向死端口」的完整成因。
    await sh(serial, `settings put global http_proxy 127.0.0.1:${PROXY_PORT}`);
    await new Promise((r) => setTimeout(r, 2500));
    say(`  ① 写入代理后：${describe(proxyKeysOf((await sh(serial, 'settings list global')).stdout))}`);

    const delOut = (await sh(serial, 'settings delete global http_proxy')).stdout;
    await new Promise((r) => setTimeout(r, 2500));
    say(`  ② 只 delete 别名（旧清理行为）：${delOut || '(无输出)'}`);

    let keys = proxyKeysOf((await sh(serial, 'settings list global')).stdout);

    // 若该 ROM 的 delete 没能删掉别名（受限 ROM），退化：直接写真身
    // —— 仍是「别名中性 + 真身有值」这一最坏状态的等价物
    if (real(keys['http_proxy']) && keys['http_proxy'] !== ':0') {
      say('  [降级] delete 未清掉别名，改为直接写真身键');
      await sh(serial, 'settings put global http_proxy :0');
      await new Promise((r) => setTimeout(r, 1500));
      await sh(serial, 'settings put global global_http_proxy_host 127.0.0.1');
      await sh(serial, `settings put global global_http_proxy_port ${PROXY_PORT}`);
      await new Promise((r) => setTimeout(r, 2500));
      keys = proxyKeysOf((await sh(serial, 'settings list global')).stdout);
    }

    check(
      '真身键有值（host/port），即残留成立',
      real(keys['global_http_proxy_host']) && real(keys['global_http_proxy_port']),
      `当前 ${describe(keys)}`,
    );

    const alias = keys['http_proxy'];
    check(
      '遗留别名读回为中性值（旧判据在此必然漏判）',
      !real(alias) || alias === ':0',
      `http_proxy=「${alias || '空'}」`,
    );

    // 把旧判据原样跑一遍，作为对照证据
    const legacyRaw = (await sh(serial, 'settings get global http_proxy')).stdout;
    const legacyJudge = legacyRaw && legacyRaw !== 'null' && legacyRaw !== ':0' ? legacyRaw : null;
    say(`  [对照] 旧判据（只读 http_proxy）判定结果：${legacyJudge === null ? '「无残留」→ 直接 return' : legacyJudge}`);
    check(
      '对照：旧判据确实漏判（这正是事故根因）',
      legacyJudge === null,
      '新判据必须能识别出下面的残留',
    );
    check('新判据识别出残留', isDirty(keys), `识别到：${describe(keys)}`);

    /* ---------------- Stage 2 · 残留态下系统确实在用该代理 ---------------- */
    section('Stage 2 · 残留态下的真实流量（证明这个状态是「有害」的）');
    say(`  驱动系统浏览器导航，采样 ${SAMPLE_MS / 1000}s …`);
    await navTo();
    let hitsDuringResidue = await sample(SAMPLE_MS);
    if (hitsDuringResidue === 0) {
      say('  本窗口未观测到流量，重试一次导航 …');
      await navTo();
      hitsDuringResidue = await sample(SAMPLE_MS);
    }
    if (hitsDuringResidue > 0) {
      check('残留代理确实在承载设备流量（系统仍在用它）', true, `${hitsDuringResidue} 个连接打到 127.0.0.1:${PROXY_PORT}`);
    } else {
      note(
        '残留代理是否承载流量',
        '本窗口未观测到流量（浏览器可能未完成导航/无网络）——不影响下面的清理判定',
      );
    }

    /* ---------------- Stage 3 · 用真代码清理 ---------------- */
    section('Stage 3 · 调用编译产物 cleanupStaleProxy（真实修复逻辑）');

    const res = await engine.cleanupStaleProxy(serial);
    say(`  返回：${JSON.stringify(res)}`);
    check('检测到残留并执行清理（旧代码在此返回 cleaned:false）', res.cleaned === true, `before=${res.before}`);
    check('上报的残留值非空（真身被识别出来）', !!res.before, `before=${res.before || '(空)'}`);
    check('adb 侧无残留（left 为空）', !res.left, res.left || '');

    /* ---------------- Stage 4 · settings 与内存态双重复核 ---------------- */
    section('Stage 4 · 复核：设置键 + 系统内存代理态');

    const keysAfter = proxyKeysOf((await sh(serial, 'settings list global')).stdout);
    check('settings 全套代理键已干净', !isDirty(keysAfter), `当前 ${describe(keysAfter)}`);

    say(`  再次驱动浏览器导航，采样 ${SAMPLE_MS / 1000}s …`);
    await navTo();
    const hitsAfterClean = await sample(SAMPLE_MS);

    if (hitsDuringResidue > 0) {
      // 有对照组，这是决定性断言
      check(
        '清理后系统不再把流量送到该端口（内存代理态已刷新）',
        hitsAfterClean === 0,
        `残留期 ${hitsDuringResidue} 个连接 → 清理后 ${hitsAfterClean} 个`,
      );
    } else {
      check('清理后该端口无流量', hitsAfterClean === 0, `${hitsAfterClean} 个连接`);
      note('内存态刷新对照', '缺少「残留期」基线，本项只作弱判定（不是决定性证据）');
    }

    // 设备外网恢复（只在该设备本来就有网时判定）。
    // 判据用 ping，**不要**用 `ip route`：Android 的默认路由挂在 per-network 路由表里，
    // main 表里看不到 `default via`，拿它判定会恒为「无默认路由」（误报）。
    const ping = await sh(serial, 'ping -c 1 -W 3 223.5.5.5', 20000);
    if (/1 (packets )?received/.test(ping.stdout)) {
      const c = await sh(serial, "curl -s -o /dev/null -w '%{http_code}' --max-time 12 http://www.baidu.com", 25000);
      check('清理后设备直连外网正常', c.stdout === '200', `HTTP ${c.stdout || c.stderr}`);
    } else {
      note('清理后设备外网连通性', '该设备当前无外网（测试机常态）');
    }
  } finally {
    /* 收尾：任何路径都不留脏状态 */
    for (const k of PROXY_TRUE_BODY) await adb(['-s', serial, 'shell', 'settings', 'delete', 'global', k], 15000);
    await adb(['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0'], 15000);
    await adb(['-s', serial, 'reverse', '--remove', `tcp:${PROXY_PORT}`]);
    await new Promise((r) => sink.close(r));
    if (browser) await adb(['-s', serial, 'shell', `am force-stop ${browser}`], 15000);

    const finalKeys = proxyKeysOf((await adb(['-s', serial, 'shell', 'settings', 'list', 'global'])).stdout);
    say(`  收尾后设备代理键：${describe(finalKeys)}`);
  }
}

(async () => {
  await app.whenReady();
  try {
    await main();
  } catch (e) {
    fail++;
    failures.push(`未捕获异常：${e.message}`);
    say(`\n[FAIL] 未捕获异常：${e.stack}`);
  }

  section(`结果：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
  if (failures.length) {
    say('失败项：');
    failures.forEach((f) => say(`  - ${f}`));
  }
  const code = fail > 0 ? 1 : 0;
  say(`=== PROXY CLEANUP REGRESSION DONE (exit ${code}) ===`);
  app.exit(code);
})();
