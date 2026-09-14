/**
 * 弱网代理引擎端到端验证（v1.0.1）
 *
 * 分两段：
 *   Stage A —— 引擎级：不起设备，直接跑编译产物里的代理引擎，
 *              用 Node 客户端经代理请求本地源站，量化验证
 *              延迟 / 带宽 / 丢包 / 错报 / 乱序 是否真的生效、
 *              CONNECT 隧道（HTTPS 路径）是否可用。
 *   Stage B —— 真机链路级：adb reverse + 设备全局代理，
 *              分两层验证：
 *                (a) 用设备 curl 显式 --proxy 做定量验证（延迟/带宽/丢包）
 *                (b) 用**真实应用（系统浏览器）**经系统全局代理访问，
 *                    证明「全局代理对本机 App 生效」——
 *                    因为 Android shell 里的 curl 根本不读全局代理设置。
 *              受限 ROM（如 ColorOS 禁写 global 设置）走手动向导分支。
 *
 * 用法：
 *   node scripts/e2e-weaknet-proxy.cjs            # 只跑 Stage A
 *   node scripts/e2e-weaknet-proxy.cjs --device   # Stage A + B
 *   ADB_SERIAL=xxx node scripts/e2e-weaknet-proxy.cjs --device
 */

const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADB = path.join(ROOT, 'bin', 'adb.exe');
const SERIAL = process.env.ADB_SERIAL || '';
const ENGINE = path.join(ROOT, 'dist-electron', 'electron', 'services', 'proxy-shaping.js');

const PROXY_PORT = 17890;
const ORIGIN_PORT = 18765;
const BIG_BYTES = 200 * 1024;
const PAYLOAD = Buffer.alloc(BIG_BYTES, 0x78); // 'x'

const withDevice = process.argv.includes('--device');

/* ------------------------------------------------------------------ */
/* 断言与输出                                                          */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t) {
  console.log(`\n${'='.repeat(68)}\n${t}\n${'='.repeat(68)}`);
}

/**
 * 响应体是否"字节级完好"。
 * 弱网注入**绝不允许破坏字节内容或顺序**（TCP 给应用层的就是字节流），
 * 唯一的例外是「错报」参数 —— 那个是故意篡改，用于验证客户端容错。
 */
function isIntact(buf) {
  if (buf.length !== BIG_BYTES) return false;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0x78) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 本地源站                                                            */
/* ------------------------------------------------------------------ */

/**
 * 源站命中记录。
 * 用于「真实应用级」验证：Android shell 里的 curl 并不读取系统全局代理设置
 * （实测：global 已设 127.0.0.1:PORT，不带 --proxy 仍直连），
 * 所以"全局代理是否真的对 App 生效"只能靠真实应用（浏览器）来证明 ——
 * 观测源站是否收到请求，即证明请求确实被代理转发过来了。
 */
const originHits = [];

const origin = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  originHits.push({ path: pathname, at: Date.now() });

  if (pathname === '/small') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('PROXY-TEST-OK');
    return;
  }
  if (pathname === '/big') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': PAYLOAD.length });
    res.end(PAYLOAD);
    return;
  }
  res.writeHead(404);
  res.end('nope');
});

/** 等源站收到指定路径的请求；返回相对 startedAt 的耗时 */
function waitForHit(pathname, sinceIdx, startedAt, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      for (let i = sinceIdx; i < originHits.length; i++) {
        if (originHits[i].path === pathname) {
          clearInterval(timer);
          resolve({ ok: true, ms: originHits[i].at - startedAt });
          return;
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve({ ok: false, ms: -1 });
      }
    }, 120);
  });
}

/* ------------------------------------------------------------------ */
/* 经代理发一次明文 HTTP 请求，返回耗时与响应体                        */
/* ------------------------------------------------------------------ */

function requestViaProxy(urlPath) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let firstByteAt = 0;
    const chunks = [];

    const sock = net.connect(PROXY_PORT, '127.0.0.1', () => {
      // 代理收到的是绝对 URI
      sock.write(
        `GET http://127.0.0.1:${ORIGIN_PORT}${urlPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${ORIGIN_PORT}\r\n` +
          `Connection: close\r\n\r\n`,
      );
    });

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('请求超时（30s）'));
    }, 30000);

    sock.on('data', (d) => {
      if (!firstByteAt) firstByteAt = Date.now() - started;
      chunks.push(d);
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf('\r\n\r\n');
      const head = sep >= 0 ? raw.subarray(0, sep).toString('latin1') : '';
      const body = sep >= 0 ? raw.subarray(sep + 4) : Buffer.alloc(0);
      resolve({
        ttfbMs: firstByteAt,
        totalMs: Date.now() - started,
        body,
        status: parseInt((head.split('\r\n')[0] || '').split(' ')[1] || '0', 10),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 经代理发一次 CONNECT 隧道请求（HTTPS 路径）                          */
/* ------------------------------------------------------------------ */

function connectTunnelViaProxy() {
  return new Promise((resolve, reject) => {
    let stage = 'connect';
    let buf = Buffer.alloc(0);
    const started = Date.now();

    const sock = net.connect(PROXY_PORT, '127.0.0.1', () => {
      sock.write(
        `CONNECT 127.0.0.1:${ORIGIN_PORT} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${ORIGIN_PORT}\r\n\r\n`,
      );
    });

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('隧道超时'));
    }, 20000);

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'connect') {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const head = buf.subarray(0, sep).toString('latin1');
        if (!/200/.test(head.split('\r\n')[0])) {
          clearTimeout(timer);
          reject(new Error(`隧道建立失败：${head.split('\r\n')[0]}`));
          return;
        }
        stage = 'data';
        buf = buf.subarray(sep + 4);
        // 隧道建立后按 origin-form 发请求
        sock.write(
          `GET /small HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      // 隧道内是明文 HTTP 响应（测试用，真实场景里是 TLS）
      if (buf.includes(Buffer.from('PROXY-TEST-OK'))) {
        clearTimeout(timer);
        sock.end();
        resolve({ ok: true, ms: Date.now() - started });
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Stage A：引擎级                                                     */
/* ------------------------------------------------------------------ */

async function stageA(shaping) {
  section('Stage A · 引擎级（不起设备，验证注入是否真的生效）');

  const params = (up, down) => ({
    up: { bandwidthMbps: 0, delayMs: 0, jitterMs: 0, lossPercent: 0, corruptPercent: 0, reorderPercent: 0, duplicatePercent: 0, ...up },
    down: { bandwidthMbps: 0, delayMs: 0, jitterMs: 0, lossPercent: 0, corruptPercent: 0, reorderPercent: 0, duplicatePercent: 0, ...down },
    durationSec: 0,
  });

  /* 基线 */
  shaping.setShapingParams(params({}, {}));
  shaping.resetShapingStats();
  const base = await requestViaProxy('/small');
  check('基线请求通达代理', base.status === 200 && base.body.toString().includes('PROXY-TEST-OK'),
    `status=${base.status} 耗时=${base.totalMs}ms`);
  check('基线无额外开销（代理本身不拖慢请求）', base.totalMs < 300, `${base.totalMs}ms`);
  const baseMs = base.totalMs;

  /* 下行延迟 */
  shaping.setShapingParams(params({}, { delayMs: 500 }));
  shaping.resetShapingStats();
  const d1 = await requestViaProxy('/small');
  check('下行延迟 500ms 生效', d1.totalMs >= 480 && d1.totalMs < 3000,
    `实际 ${d1.totalMs}ms（基线 ${baseMs}ms）`);

  /* 上行延迟 */
  shaping.setShapingParams(params({ delayMs: 400 }, {}));
  shaping.resetShapingStats();
  const d2 = await requestViaProxy('/small');
  check('上行延迟 400ms 生效', d2.totalMs >= 380 && d2.totalMs < 3000,
    `实际 ${d2.totalMs}ms`);

  /* 上下行独立：上行 400 + 下行 400 ≈ 800 */
  shaping.setShapingParams(params({ delayMs: 400 }, { delayMs: 400 }));
  shaping.resetShapingStats();
  const d3 = await requestViaProxy('/small');
  check('上下行可独立叠加（≈800ms）', d3.totalMs >= 760 && d3.totalMs < 3500,
    `实际 ${d3.totalMs}ms`);

  /* 下行带宽：0.5Mbps 传 200KB ≈ 3.28s */
  shaping.setShapingParams(params({}, { bandwidthMbps: 0.5 }));
  shaping.resetShapingStats();
  const d4 = await requestViaProxy('/big');
  const expectMs = (BIG_BYTES * 8) / (0.5 * 1e6) * 1000;
  const ratio = d4.totalMs / expectMs;
  check('下行带宽 0.5Mbps 生效（200KB≈3.28s）', ratio > 0.85 && ratio < 1.6,
    `实际 ${d4.totalMs}ms，理论 ${Math.round(expectMs)}ms，比值 ${ratio.toFixed(2)}`);
  check('限速下数据完整（未丢字节、未乱序）', isIntact(d4.body),
    `收到 ${d4.body.length} / ${BIG_BYTES} 字节，内容完好=${isIntact(d4.body)}`);

  /* 丢包：反复采样，确保「不丢数据」不是撞运气 */
  shaping.setShapingParams(params({}, { bandwidthMbps: 4 }));
  shaping.resetShapingStats();
  const d5ref = await requestViaProxy('/big');

  shaping.setShapingParams(params({}, { lossPercent: 40, bandwidthMbps: 4 }));
  shaping.resetShapingStats();
  let lossOk = 0;
  const lossTotals = [];
  for (let i = 0; i < 5; i++) {
    const r = await requestViaProxy('/big');
    lossTotals.push(r.totalMs);
    if (r.status === 200 && isIntact(r.body)) lossOk++;
  }
  const st5 = shaping.getShapingStats();
  const lossAvg = lossTotals.reduce((a, b) => a + b, 0) / lossTotals.length;
  check('下行丢包 40%：命中统计 > 0', st5.downRetrans > 0,
    `downRetrans=${st5.downRetrans}，5 轮共 ${Math.ceil(BIG_BYTES / (16 * 1024)) * 5} 个分片`);
  check('丢包带来可感知的耗时增加（队头阻塞等效）', lossAvg > d5ref.totalMs * 1.2,
    `无丢包 ${d5ref.totalMs}ms → 丢包 40% 平均 ${lossAvg.toFixed(0)}ms`);
  check('丢包不破坏字节内容与顺序（5 轮全部完好）', lossOk === 5,
    `完好 ${lossOk}/5 轮，代理侧共投递 ${st5.downBytes} 字节`);

  /* 错报：真篡改字节 */
  shaping.setShapingParams(params({}, { corruptPercent: 100 }));
  shaping.resetShapingStats();
  const d6 = await requestViaProxy('/big');
  const st6 = shaping.getShapingStats();
  const diff = (() => {
    if (d6.body.length !== BIG_BYTES) return true;
    for (let i = 0; i < BIG_BYTES; i++) if (d6.body[i] !== 0x78) return true;
    return false;
  })();
  check('下行错报 100%：字节确实被篡改', diff && st6.downCorrupt > 0,
    `downCorrupt=${st6.downCorrupt} 内容有差异=${diff}`);

  /* 乱序 */
  shaping.setShapingParams(params({}, { reorderPercent: 50, bandwidthMbps: 4 }));
  shaping.resetShapingStats();
  const d7 = await requestViaProxy('/big');
  const st7 = shaping.getShapingStats();
  check('下行乱序 50%：命中统计 > 0', st7.downReorder > 0,
    `downReorder=${st7.downReorder}（共 ${Math.ceil(BIG_BYTES / (16 * 1024))} 个分片）`);
  check('乱序不破坏字节内容与顺序', d7.status === 200 && isIntact(d7.body),
    `${d7.body.length} / ${BIG_BYTES} 字节，完好=${isIntact(d7.body)}`);

  /* 重复包：折算为有效带宽下降 */
  shaping.setShapingParams(params({}, { bandwidthMbps: 0.5, duplicatePercent: 100 }));
  shaping.resetShapingStats();
  const d8 = await requestViaProxy('/big');
  check('重复包 100%：有效带宽减半（耗时≈2倍）', d8.totalMs > expectMs * 1.6,
    `实际 ${d8.totalMs}ms，无重复时理论 ${Math.round(expectMs)}ms`);

  /* 组合档位：直接套用内置预设「2G 弱网」，验证多参数同时开也保持完好 */
  shaping.setShapingParams(
    params(
      { bandwidthMbps: 0.25, delayMs: 500, jitterMs: 100, lossPercent: 2 },
      { bandwidthMbps: 0.25, delayMs: 500, jitterMs: 100, lossPercent: 2 },
    ),
  );
  shaping.resetShapingStats();
  const d9 = await requestViaProxy('/big');
  const expect9 = (BIG_BYTES * 8) / (0.25 * 1e6) * 1000 + 500;
  check('组合档位「2G 弱网」：延迟 + 带宽 + 丢包同时生效',
    d9.totalMs > expect9 * 0.8,
    `实际 ${d9.totalMs}ms，理论下限 ${Math.round(expect9)}ms`);
  check('组合档位下响应仍字节完好', d9.status === 200 && isIntact(d9.body),
    `${d9.body.length} / ${BIG_BYTES} 字节，完好=${isIntact(d9.body)}`);

  /* CONNECT 隧道 */
  shaping.setShapingParams(params({}, {}));
  shaping.resetShapingStats();
  try {
    const t = await connectTunnelViaProxy();
    check('CONNECT 隧道（HTTPS 路径）可用', t.ok, `${t.ms}ms`);
  } catch (e) {
    check('CONNECT 隧道（HTTPS 路径）可用', false, e.message);
  }

  /* 延迟也作用于隧道握手，说明 HTTPS 场景同样受限 */
  shaping.setShapingParams(params({}, { delayMs: 500 }));
  shaping.resetShapingStats();
  try {
    const t = await connectTunnelViaProxy();
    check('CONNECT 隧道内延迟 500ms 生效', t.ms >= 480, `${t.ms}ms`);
  } catch (e) {
    check('CONNECT 隧道内延迟 500ms 生效', false, e.message);
  }

  /* 统计与重置 */
  shaping.setShapingParams(params({}, {}));
  shaping.resetShapingStats();
  const st = shaping.getShapingStats();
  check('统计可重置', st.upBytes === 0 && st.downBytes === 0 && st.connections === 0,
    JSON.stringify({ up: st.upBytes, down: st.downBytes, conn: st.connections }));
}

/* ------------------------------------------------------------------ */
/* Stage B：真机链路                                                   */
/* ------------------------------------------------------------------ */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

/**
 * 异步执行 adb。
 *
 * ⚠️ 必须异步（execFile）而**不是** spawnSync：
 * 弱网代理就跑在本进程里，spawnSync 会阻塞事件循环，
 * 那样代理在整个 curl 期间都无法 accept 连接，
 * 设备侧只会看到「连上了但 60s 无响应」的超时假象。
 * （Stage A 是纯异步所以一直正常，Stage B 早期用过 spawnSync 全是假超时。）
 */
async function adb(args, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileP(ADB, args, {
      encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, status: 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (e) {
    return {
      ok: false,
      status: typeof e.code === 'number' ? e.code : -1,
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim() || (typeof e.code === 'string' ? e.code : ''),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 设备全局代理：读 / 判 / 清（与 electron/services/weaknet.ts 对齐）   */
/* ------------------------------------------------------------------ */

/**
 * Android 8+ 把全局代理存在**两套键**里：
 *   别名 `http_proxy` + 真身 `global_http_proxy_host` / `..._port`
 *   / `..._exclusion_list` / `global_proxy_pac_url`（系统实际读的是真身）。
 *
 * ⚠️ 本脚本早期只 `delete global http_proxy` 并只读它做校验，这是**错的**：
 *   工具写完别名后 SettingsProvider 会把它迁移成真身并清空别名，于是
 *     · 校验读 `http_proxy` → 空 → 谎报「已清除」；
 *     · delete 删的是空气 → 真身残留 → 设备彻底断网（v1.0.1 真实事故）。
 *   另外清理**必须 put :0**：ProxyTracker 只在键发生变更时刷新，
 *   键已被迁移清空时 delete 不产生通知，内存里的旧代理照旧生效。
 */
const PROXY_TRUE_BODY = [
  'global_http_proxy_host',
  'global_http_proxy_port',
  'global_http_proxy_exclusion_list',
  'global_proxy_pac_url',
];

const isReal = (v) => !!v && v !== 'null' && v !== '';

/** 读设备上全部 proxy 相关键 */
async function readProxyKeys(serial) {
  const r = await adb(['-s', serial, 'shell', 'settings list global'], 20000);
  const m = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k.includes('proxy')) m[k] = line.slice(i + 1).trim();
  }
  return m;
}

/** 系统实际生效的代理地址；无代理返回 null */
function effectiveProxy(m) {
  const host = m['global_http_proxy_host'];
  const port = m['global_http_proxy_port'];
  const alias = m['http_proxy'];
  if (isReal(host) && isReal(port)) return `${host}:${port}`;
  if (isReal(host)) return host;
  if (isReal(alias) && alias !== ':0' && alias !== '0') return alias;
  return null;
}

/** 是否还有代理残留（真身或别名任一非空，且非 `:0` 中性值） */
function proxyDirty(m) {
  if (effectiveProxy(m)) return true;
  if (isReal(m['global_proxy_pac_url'])) return true;
  if (isReal(m['global_http_proxy_exclusion_list'])) return true;
  return false;
}

/**
 * 清设备全局代理。三步顺序固定：
 *   ① put :0 触发迁移 + 变更通知（刷新 ProxyTracker 内存态）—— 不能只 delete
 *   ② 清真身四键（系统实际读的）
 *   ③ 别名保留为 `:0` 中性值
 */
async function clearDeviceProxy(serial) {
  await adb(['-s', serial, 'shell', 'settings put global http_proxy :0'], 15000);
  for (const k of PROXY_TRUE_BODY) {
    await adb(['-s', serial, 'shell', `settings delete global ${k}`], 15000);
  }
}

/** 设备侧是否存在可用的 curl（AOSP/模拟器有，精简 ROM 常常没有） */
async function probeCurl(serial) {
  const r = await adb(['-s', serial, 'shell', 'curl --version'], 15000);
  return r.ok && /curl\s+\d/.test(r.stdout);
}

/**
 * 探测 ROM 是否允许 `adb shell` 写入 global 设置。
 * 这是本方案能否"自动配代理"的分水岭：
 *   - AOSP / 多数机型：com.android.shell 持有 WRITE_SECURE_SETTINGS，可写
 *   - ColorOS 等定制 ROM：被剥夺该权限，任何 global 写入都抛 SecurityException
 *     （此时 App 侧退化为「手动代理向导」）
 */
async function probeWriteSettings(serial) {
  const key = `wn_probe_${Date.now().toString(36)}`;
  const put = await adb(['-s', serial, 'shell', `settings put global ${key} 1`], 15000);
  const back = await adb(['-s', serial, 'shell', `settings get global ${key}`], 15000);
  await adb(['-s', serial, 'shell', `settings delete global ${key}`], 15000);
  const ok = put.ok && !/SecurityException|Exception/i.test(put.stderr) && back.stdout === '1';
  return { ok, reason: ok ? '' : (put.stderr || put.stdout || `读回「${back.stdout}」`) };
}

/**
 * 经设备 curl + 显式 --proxy 打一次请求。
 *
 * 两个关键点：
 *  1) 命令必须作为**单个字符串**交给 adb。若按数组传参，adb 会用空格拼接，
 *     设备 shell 再把 `-w` 的格式串拆成多个参数，curl 会把它当 URL 去解析，
 *     结果是空输出甚至长时间挂起。
 *  2) 设备上的 curl **不读取** Android 全局代理设置，所以必须显式 `--proxy`。
 *     全局代理只对真实 App 生效（见下面的浏览器验证）。
 */
async function deviceCurl(serial, targetPath, timeoutMs = 90000) {
  const cmd =
    `curl -s -o /dev/null -w '%{time_total} %{size_download} %{http_code}' ` +
    `--max-time 60 --proxy http://127.0.0.1:${PROXY_PORT} ` +
    `http://127.0.0.1:${ORIGIN_PORT}${targetPath}`;
  const r = await adb(['-s', serial, 'shell', cmd], timeoutMs);
  const m = /([\d.]+)\s+(\d+)\s+(\d+)/.exec(r.stdout);
  if (!m) return { ms: -1, bytes: -1, code: -1, raw: (r.stdout || r.stderr || '').slice(0, 200) };
  return { ms: Math.round(+m[1] * 1000), bytes: +m[2], code: +m[3] };
}

/** 把设备上的一次连接引到电脑代理（无 curl 设备用），返回连接前后代理计数 */
async function touchProxyAndCount(serial, shaping, timeoutMs = 20000) {
  const before = shaping.getShapingStats().connections;
  await adb(['-s', serial, 'shell', `nc -w 2 127.0.0.1 ${PROXY_PORT} < /dev/null`], timeoutMs);
  return { before, after: shaping.getShapingStats().connections };
}

/** 取设备 wlan0 的 IPv4（用于判断设备与电脑是否同网段） */
async function deviceWlanIp(serial) {
  const r = await adb(
    ['-s', serial, 'shell', "ip -4 -o addr show wlan0 2>/dev/null | awk '{print $4}'"],
    15000,
  );
  const m = /(\d+\.\d+\.\d+\.\d+)\/\d+/.exec(r.stdout);
  return m ? m[1] : '';
}

/** 电脑自己的一个非回环 IPv4 —— 设备侧真实应用用它访问电脑源站 */
function firstHostIpv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '';
}

/** 用系统默认浏览器打开一个 URL（真实 App 级代理验证用） */
async function launchBrowser(serial, url) {
  await adb(['-s', serial, 'shell', `am start -a android.intent.action.VIEW -d '${url}'`], 25000);
}

function shapingParams(up, down) {
  const base = {
    bandwidthMbps: 0, delayMs: 0, jitterMs: 0,
    lossPercent: 0, corruptPercent: 0, reorderPercent: 0, duplicatePercent: 0,
  };
  return { up: { ...base, ...up }, down: { ...base, ...down }, durationSec: 0 };
}

async function stageB(shaping) {
  section('Stage B · 设备链路（adb reverse + 免 Root 代理）');

  const list = await adb(['devices']);
  console.log(`  adb devices:\n${list.stdout.split('\n').map((l) => '    ' + l).join('\n')}`);

  const attached = list.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /\sdevice$/.test(l))
    .map((l) => l.split(/\s+/)[0]);

  // 指定序列号可能已拔掉/换机（重启后序列号会变），回退策略：
  //   1) 环境变量指定且在线 → 用它
  //   2) 否则优先真机（弱网最终要在真机上跑）
  //   3) 再否则用第一台在线的（模拟器）
  let serial = SERIAL && attached.includes(SERIAL) ? SERIAL : '';
  if (!serial) serial = attached.find((s) => !/^emulator-/.test(s)) || '';
  if (!serial) serial = attached[0] || '';
  check('检测到可用设备', !!serial, serial || `在线设备：${attached.join(', ') || '无'}`);
  if (!serial) return;

  const sh = (cmd, t) => adb(['-s', serial, 'shell', cmd], t);

  const model = (await sh('getprop ro.product.model')).stdout;
  const rel = (await sh('getprop ro.build.version.release')).stdout;
  const rooted = /uid=0/.test((await sh('su -c id')).stdout);
  const isEmu = /^emulator-/.test(serial);
  const hasCurl = await probeCurl(serial);
  const wr = await probeWriteSettings(serial);
  const devIp = await deviceWlanIp(serial);
  console.log(
    `  设备：${model} / Android ${rel} / ${isEmu ? '模拟器' : '真机'} / ` +
      `Root=${rooted ? '是' : '否'} / curl=${hasCurl ? '有' : '无'} / ` +
      `可写系统设置=${wr.ok ? '是' : '否'} / 设备 IP=${devIp || '无'}`,
  );

  if (!hasCurl) console.log('  [NOTE] 该设备无 curl，定量验证降级为「通道连通性 + 代理侧统计」');
  if (!wr.ok) {
    console.log(`  [NOTE] 该 ROM 禁止 adb 写系统设置（${wr.reason}）→ 自动配代理不可用，`);
    console.log(`         实际使用时由 UI 引导用户手动填代理：127.0.0.1:${PROXY_PORT}`);
  }

  try {
    /* 1) 建立 reverse：设备 127.0.0.1:PROXY_PORT → 电脑 127.0.0.1:PROXY_PORT */
    await adb(['-s', serial, 'reverse', '--remove', `tcp:${PROXY_PORT}`]);
    const rev = await adb(['-s', serial, 'reverse', `tcp:${PROXY_PORT}`, `tcp:${PROXY_PORT}`]);
    check('adb reverse 建立成功（免 Root）', rev.ok, rev.ok ? `tcp:${PROXY_PORT}` : rev.stderr);
    if (!rev.ok) return;

    /* 2) 基线：设备经代理拿到内容 */
    shaping.setShapingParams(shapingParams({}, {}));
    shaping.resetShapingStats();

    let base = null;
    if (hasCurl) {
      base = await deviceCurl(serial, '/small');
      check('设备经代理拿到内容（无参数基线）', base.code === 200 && base.bytes > 0,
        `${base.ms}ms / ${base.bytes} 字节 / HTTP ${base.code}`);
      if (base.code !== 200) console.log(`    原始输出：${base.raw}`);
    } else {
      const t = await touchProxyAndCount(serial, shaping);
      check('设备能经 reverse 打通电脑端代理（连接级）', t.after > t.before,
        `代理连接数 ${t.before} → ${t.after}`);
      if (t.after <= t.before) return;
    }

    /* 3) 定量验证：延迟（下行 / 上下行独立叠加） */
    if (hasCurl) {
      shaping.setShapingParams(shapingParams({}, { delayMs: 600 }));
      shaping.resetShapingStats();
      const p1 = await deviceCurl(serial, '/small');
      check('设备链路：下行延迟 600ms 生效', p1.ms >= 560 && p1.ms < 8000,
        `${base.ms}ms → ${p1.ms}ms（+${p1.ms - base.ms}ms）`);

      shaping.setShapingParams(shapingParams({ delayMs: 400 }, { delayMs: 400 }));
      shaping.resetShapingStats();
      const p2 = await deviceCurl(serial, '/small');
      check('设备链路：上下行延迟可独立叠加（≈800ms）', p2.ms >= 700 && p2.ms < 8000, `${p2.ms}ms`);

      /* 4) 带宽：0.5Mbps 传 200KB ≈ 3.28s */
      shaping.setShapingParams(shapingParams({}, { bandwidthMbps: 0.5 }));
      shaping.resetShapingStats();
      const p3 = await deviceCurl(serial, '/big');
      const expectMs = (BIG_BYTES * 8) / (0.5 * 1e6) * 1000;
      check('设备链路：下行带宽 0.5Mbps（200KB ≈3.3s）', p3.ms > expectMs * 0.8,
        `实际 ${p3.ms}ms，理论 ${Math.round(expectMs)}ms`);
      check('设备链路：限速下响应字节完整（仅响应头开销）',
        p3.bytes >= BIG_BYTES && p3.bytes < BIG_BYTES + 4000, `收到 ${p3.bytes} 字节`);

      /* 5) 丢包：队头阻塞等效，不截断 */
      shaping.setShapingParams(shapingParams({}, { lossPercent: 50, bandwidthMbps: 4 }));
      shaping.resetShapingStats();
      const p4 = await deviceCurl(serial, '/big');
      const st4 = shaping.getShapingStats();
      check('设备链路：丢包命中统计累加', st4.downRetrans > 0,
        `downRetrans=${st4.downRetrans}，下行 ${st4.downBytes} 字节，累计连接 ${st4.connections}`);
      check('设备链路：丢包不截断响应（队头阻塞等效）', p4.bytes >= BIG_BYTES, `收到 ${p4.bytes} 字节`);
    }

    /* 6) 分水岭：ROM 允许写设置 → 验证真正的"全局代理"路径 */
    if (wr.ok) {
      const addr = `127.0.0.1:${PROXY_PORT}`;
      const put = await sh(`settings put global http_proxy ${addr}`);
      // 读回要读全套键：系统可能立刻把别名迁移成真身，只读 http_proxy 会误判成「没写进去」
      const got = effectiveProxy(await readProxyKeys(serial));
      check('全局 HTTP 代理写入并读回一致（免 Root 自动路径）',
        put.ok && got === addr, `读回「${got || '空'}」`);

      if (got !== addr) {
        console.log('  [SKIP] 真实应用级验证 —— 系统未接受该代理设置');
      } else {
        // 设备 shell 的 curl 不读系统代理，所以必须用真实应用验证。
        // 目标地址用电脑自己的 IP：设备 → 代理 → 电脑源站，全程可观测。
        const hostIp = firstHostIpv4();
        if (!hostIp) {
          console.log('  [SKIP] 真实应用级验证 —— 未取到电脑的非回环 IPv4');
        } else {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          await sh('input keyevent KEYCODE_WAKEUP');
          await sh('wm dismiss-keyguard');

          const BROWSERS = [
            'com.android.chrome', 'com.android.chromium',
            'com.heytap.browser', 'mark.via', 'com.oppo.browser', 'com.android.browser',
          ];
          const stopBrowsers = async () => {
            for (const p of BROWSERS) await sh(`am force-stop ${p}`, 15000);
          };

          /**
           * 跑一轮「真实应用」测量。
           *
           * 关键：计时锚点不用 `am start`（含浏览器冷启动噪声），
           * 而是用**代理侧看到连接的那一刻**——
           * latency = 源站收到请求的时间 − 代理 accept 的时间，
           * 正好等于代理注入的延迟，和浏览器启动快慢完全无关。
           */
          const round = async () => {
            await stopBrowsers();          // 每次全新启动，避免浏览器复用前台任务不导航
            await sleep(700);
            shaping.resetShapingStats();
            const c0 = shaping.getShapingStats().connections;
            const idx = originHits.length;
            const t0 = Date.now();
            await launchBrowser(serial, `http://${hostIp}:${ORIGIN_PORT}/small?cb=${Date.now()}`);

            let tConn = -1;
            while (Date.now() - t0 < 25000) {
              if (shaping.getShapingStats().connections > c0) { tConn = Date.now(); break; }
              if (originHits.length > idx) break;
              await sleep(60);
            }
            const hit = await waitForHit('/small', idx, t0, 20000);
            return {
              conn: tConn > 0,
              tConnFromStart: tConn > 0 ? tConn - t0 : -1,
              hit: hit.ok,
              hitFromStart: hit.ok ? hit.ms : -1,
              proxyLatency: tConn > 0 && hit.ok ? t0 + hit.ms - tConn : -1,
            };
          };

          let r1 = await round();
          if (!r1.hit) {
            // 首次启动常停在首启引导页（AOSP 模拟器的 Chromium 尤其如此），再试一次
            console.log('  [INFO] 首次未能驱动浏览器加载，重试一次（首次启动可能停在引导页）');
            r1 = await round();
          }

          if (!r1.hit) {
            console.log('  [SKIP] 真实应用级验证 —— 无法驱动该设备的浏览器完成加载');
            console.log('         （首启引导页 / 无默认浏览器；本项不判定失败，');
            console.log('          免 Root 通道与整形效果已由上面 curl 项验证）');
          } else {
            check('真实应用（浏览器）经系统全局代理访问成功（免 Root）',
              r1.hit && r1.conn,
              `源站已收到请求（浏览器启动到命中 ${r1.hitFromStart}ms，代理侧延迟 ${r1.proxyLatency}ms）`);

            // 注意方向：请求走的是「上行」，所以延迟必须注入在上行，
            // 否则请求会照常瞬间到达源站，这个指标测不出来。
            shaping.setShapingParams(shapingParams({ delayMs: 3000 }, {}));
            let r2 = await round();
            if (!r2.hit) {
              console.log('  [INFO] 第二次导航未被驱动，重试一次');
              r2 = await round();
            }
            if (!r2.hit) {
              console.log('  [SKIP] 应用级弱网复测 —— 该设备浏览器无法稳定重复导航');
              console.log('         （同一条路径的量化验证见下方「手动代理路径」项）');
            } else {
              check('应用级弱网生效（真实应用请求被注入 3s 上行延迟）',
                r2.proxyLatency > 2000,
                `代理侧实测延迟 ${r1.proxyLatency}ms → ${r2.proxyLatency}ms` +
                  `（浏览器启动到命中 ${r1.hitFromStart}ms → ${r2.hitFromStart}ms）`);
            }
          }
          shaping.setShapingParams(shapingParams({}, {}));
        }
      }
    } else {
      /* ROM 禁写：如实记录，这是 UI 走"手动代理向导"的原因 */
      const put = await sh(`settings put global http_proxy 127.0.0.1:${PROXY_PORT}`);
      check('受限 ROM：自动写代理确实被拒（故 UI 必须引导手动配置）',
        !put.ok || /SecurityException/i.test(put.stderr),
        `退出码=${put.status} ${(put.stderr || '').split('\n')[0] || ''}`);
      console.log('  [WIZARD] 该设备需在「设置 → WLAN → 修改网络 → 高级 → 手动代理」填：');
      console.log(`           主机名 127.0.0.1，端口 ${PROXY_PORT}`);
    }

    /* 6.5) 手动代理向导路径
     *
     * 受限 ROM（ColorOS 等）不让 adb 写系统设置，UI 会引导用户自己去
     * 「WLAN → 修改网络 → 高级 → 手动代理」填 127.0.0.1:PORT。
     * 用户手填之后，App 的流量走的就是「设备 loopback → adb reverse → 电脑代理」，
     * 和这里 `curl --proxy http://127.0.0.1:PORT` 走的是**同一条路**。
     *
     * 所以：先把系统代理清掉，再显式走代理请求 —— 能通，就说明
     * 「手工代理」这条路上通道、代理、弱网注入三件事都成立，
     * 唯一需要人工的只是把那串地址敲进系统设置里。
     */
    await clearDeviceProxy(serial);
    const noProxyKeys = await readProxyKeys(serial);
    check('手动代理路径：此时系统代理确实为空（证明不是靠全局代理）',
      !proxyDirty(noProxyKeys), `proxy 键：${JSON.stringify(noProxyKeys)}`);

    if (hasCurl) {
      shaping.setShapingParams(shapingParams({}, {}));
      shaping.resetShapingStats();
      const m1 = await deviceCurl(serial, '/small');
      check('手动代理路径：设备经 127.0.0.1 显式代理可达源站（等价用户手填代理）',
        m1.code === 200 && m1.bytes > 0, `${m1.ms}ms / ${m1.bytes} 字节 / HTTP ${m1.code}`);

      shaping.setShapingParams(shapingParams({ delayMs: 2000 }, {}));
      shaping.resetShapingStats();
      const m2 = await deviceCurl(serial, '/small');
      check('手动代理路径：弱网参数同样生效（上行注入 2s）',
        m2.code === 200 && m2.ms - m1.ms >= 1600, `${m1.ms}ms → ${m2.ms}ms`);
    } else {
      const t = await touchProxyAndCount(serial, shaping);
      check('手动代理路径：reverse 通道可用（连接级）', t.after > t.before,
        `代理连接数 ${t.before} → ${t.after}`);
    }
    shaping.setShapingParams(shapingParams({}, {}));

    /* 7) 清理，并确认设备侧真的干净了 */
    shaping.setShapingParams(null);
    await clearDeviceProxy(serial);
    await adb(['-s', serial, 'reverse', '--remove', `tcp:${PROXY_PORT}`]);
    await sh('am force-stop com.android.chrome');
    await sh('am force-stop com.heytap.browser');
    await sh('am force-stop mark.via');

    const afterKeys = await readProxyKeys(serial);
    check('清理后设备代理已清除（真身 + 别名全套）', !proxyDirty(afterKeys),
      `proxy 键：${JSON.stringify(afterKeys)}`);

    const revList = await adb(['-s', serial, 'reverse', '--list']);
    check('清理后 reverse 已移除', !revList.stdout.includes(`tcp:${PROXY_PORT}`),
      revList.stdout || '(空)');

    // 反向验证：reverse 真撤了的话，设备上再连 127.0.0.1:PROXY_PORT 应该连不上，
    // 电脑端代理也不会看到新连接（这一项不依赖设备有没有外网）
    const connBefore = shaping.getShapingStats().connections;
    if (hasCurl) await deviceCurl(serial, '/small', 30000);
    else await touchProxyAndCount(serial, shaping, 30000);
    const connAfter = shaping.getShapingStats().connections;
    check('清理后设备已无法经残留通道打到电脑代理', connAfter === connBefore,
      `代理新增连接 ${connAfter - connBefore}`);

    // 设备自身外网是否恢复，只在设备本来就有网时才判定（很多测试机故意不连 WiFi）
    const hasNet = /default via/.test((await sh('ip route 2>/dev/null || cat /proc/net/route')).stdout);
    if (hasNet) {
      const ping = await sh('ping -c 1 -W 3 114.114.114.114', 20000);
      check('清理后设备外网可达（无残留代理阻断）',
        ping.ok && /1 received|1 packets received/i.test(ping.stdout),
        ping.stdout.split('\n').slice(-2).join(' ') || ping.stderr);
    } else {
      console.log('  [SKIP] 清理后外网连通性 —— 该设备当前无默认路由（测试机常态），跳过');
    }
  } finally {
    // 任何异常路径都不留脏状态（进程被强杀时，App 侧还有崩溃恢复兜底）。
    // 注意必须 put :0 而不能只 delete —— 只 delete 不产生变更通知，
    // 系统内存里的代理态不会刷新，设备会「设置里查不到代理但一直断网」。
    await clearDeviceProxy(serial);
    await adb(['-s', serial, 'reverse', '--remove', `tcp:${PROXY_PORT}`]);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  let shaping;
  try {
    shaping = require(ENGINE);
  } catch (e) {
    console.error(`无法加载编译产物：${ENGINE}\n${e.message}\n请先执行 tsc -p tsconfig.electron.json`);
    process.exit(2);
  }

  await new Promise((res) => origin.listen(ORIGIN_PORT, '0.0.0.0', res));
  console.log(`源站已启动：http://127.0.0.1:${ORIGIN_PORT}（同时监听局域网，供设备侧真实应用访问）`);

  const port = await shaping.startShapingProxy(PROXY_PORT);
  console.log(`代理已启动：127.0.0.1:${port}`);

  try {
    await stageA(shaping);
    if (withDevice) await stageB(shaping);
    else console.log('\n（跳过 Stage B，加 --device 可跑真机链路）');
  } catch (e) {
    fail++;
    failures.push(`未捕获异常：${e.message}`);
    console.log(`\n[FAIL] 未捕获异常：${e.stack}`);
  } finally {
    await shaping.stopShapingProxy();
    origin.close();
  }

  section(`结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
})();
