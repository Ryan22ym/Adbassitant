/**
 * 增量更新（v1.0.7）验证
 *
 * 三种跑法：
 *   1) 纯逻辑 + 助手沙箱（默认，普通 Node，秒级）
 *        node scripts/check-update.cjs
 *   2) 产物侧（需要先打过包，小包在 out-vX/update/）
 *        node scripts/check-update.cjs --out out-v1.0.7
 *   3) 安装版界面（CDP 连安装目录的真身）
 *        node scripts/check-update.cjs --installed --expect-version 1.0.7
 *
 * 为什么这么分
 * ---------------------------------------------------------------
 * 「替换文件 → 重启 → 版本变了」这条链路一旦做错就是打不开程序，代价很高，
 * 所以拆成三层分别钉死：
 *   A. 纯逻辑：指纹、版本比较、路径映射、每一条拒绝规则各一个反例。
 *      update-core.ts 刻意不 import electron，就是为了让普通 Node 能直接 require。
 *   B. 助手沙箱：在临时目录里造一套假的「安装目录 + 假启动器」，真跑
 *      update-helper.ps1，验证替换 / 备份 / 握手超时回滚 / 还原四条路径。
 *      假启动器是**独立 node.exe** 的一份副本改名（避免 Stop-Process 按进程名误杀
 *      本脚本）；不能用 process.execPath —— 经 Electron 跑时那是 electron.exe，
 *      离开同目录的 dll 就起不来，见 resolveNodeExe() 的注释。
 *   C. 安装版界面：更新面板真的在、形态/版本对、按钮在、无渲染层异常。
 *
 * 注意：这里的 hash / 校验全是纯计算，不碰真实安装目录，也不碰设备。
 *
 * 宿主无关：A/B/C 段在「普通 Node」和「Electron 主进程」下都必须给出同样结论。
 * 沙箱里的文件读写走 FS（Electron 下是 original-fs），因为宿主给 fs 打了 asar 补丁，
 * 会把普通文件 `app.asar` 当容器解析 —— 详见 FS 的注释。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const INSTALLED = process.argv.includes('--installed');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const EXPECT_VERSION = argOf('--expect-version');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// 默认跟 package.json 的版本走：改了版本号却忘了同步这里，是最容易发生的「检查了个旧目录」
const OUT_DIR = argOf('--out') || `out-v${PKG.version}`;

const LOG = path.join(OUT, INSTALLED ? '_update-installed.log' : '_update.log');
const TMP = path.join(os.tmpdir(), 'adba-update-check');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rows = [];
let infos = [];
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* ignore */
  }
}
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
const info = (m) => infos.push(m);
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r')
    .replace(/failure/g, 'f*ilure');

/* ------------------------------------------------------------------ */
/* 被测模块（dist-electron 产物，普通 Node 可加载）                      */
/* ------------------------------------------------------------------ */

const CORE = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'update-core.js'));
const ZIP = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'zip.js'));
const PE = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'pe-version.js'));

/**
 * 沙箱里的文件读写走这份 FS，而不是直接 fs。
 *
 * 🔴 在 Electron 宿主里跑时（`npm run check:update` 就是），Electron 给 `fs` 打了
 *    asar 补丁：任何**以 `.asar` 结尾的路径**会被当成 asar 容器去解析，普通文件因此
 *    读不出来（抛错 → 我们这里的 read() 返回 null）。
 *    于是沙箱里的 cur/resources/app.asar 明明是 11 字节的 "NEW-ASAR-V2"，断言却报 null ——
 *    看着像「助手没替换」，其实是测试脚本被宿主骗了。
 *    这正是更新代码要把落盘名改成 `app.asar.__asar` 的同一个坑，方向反过来而已。
 *
 * `original-fs` 是 Electron 提供的未打补丁版本；纯 Node 下不存在，退回普通 fs。
 */
const FS = (() => {
  try {
    return process.versions.electron ? require('original-fs') : fs;
  } catch {
    return fs;
  }
})();

/* ------------------------------------------------------------------ */
/* A. 纯逻辑                                                            */
/* ------------------------------------------------------------------ */

function rmdir(p) {
  try {
    FS.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
const wr = (p, s) => {
  FS.mkdirSync(path.dirname(p), { recursive: true });
  FS.writeFileSync(p, s);
};

function baseLocal(over = {}) {
  return {
    version: '1.0.6',
    kind: 'asar',
    packaged: true,
    electronVersion: '33.3.1',
    runtimeHash: 'RH-CURRENT',
    resourcesDir: 'C:/app/resources',
    binDir: 'C:/app/resources/bin',
    targetPath: 'C:/app/resources/app.asar',
    ...over,
  };
}
function baseManifest(over = {}) {
  return {
    schema: 1,
    productName: 'ADB桌面助手',
    appId: 'com.xiaoyang.adbassistant',
    version: '1.0.7',
    builtAt: '2026-09-16T12:00:00',
    electronVersion: '33.3.1',
    baseRuntimeHash: 'RH-CURRENT',
    resultRuntimeHash: 'RH-CURRENT',
    kind: 'asar',
    files: [{ path: 'app.asar', size: 10, sha256: 'x' }],
    ...over,
  };
}
const rej = (name, m, l) => {
  const r = CORE.validateManifest(m, l);
  record(!r.ok && !!r.reason, `拒绝：${name}`, r.ok ? '竟然通过了' : String(r.reason).slice(0, 70));
};
const acc = (name, m, l) => {
  const r = CORE.validateManifest(m, l);
  record(r.ok, `接受：${name}`, r.ok ? String(r.warning || '').slice(0, 60) : String(r.reason).slice(0, 70));
  return r;
};

function partA() {
  /* --- 指纹 --- */
  const h1 = path.join(TMP, 'hashsrc');
  rmdir(h1);
  wr(path.join(h1, 'adb.exe'), 'AAA');
  wr(path.join(h1, 'sub', 'scrcpy.exe'), 'BBB');

  const a = CORE.computeRuntimeHash(h1);
  const b = CORE.computeRuntimeHash(h1);
  record(a === b && a.length === 64, '运行库指纹稳定（同一目录两次一致）', a.slice(0, 16));

  wr(path.join(h1, 'adb.exe'), 'AAA2');
  const c = CORE.computeRuntimeHash(h1);
  record(c !== a, '运行库指纹对文件内容敏感', `${a.slice(0, 8)} → ${c.slice(0, 8)}`);

  wr(path.join(h1, 'extra.dll'), 'x');
  record(CORE.computeRuntimeHash(h1) !== c, '运行库指纹对新增文件敏感', '');

  const empty = CORE.computeRuntimeHash(path.join(TMP, 'does-not-exist'));
  record(empty === CORE.computeRuntimeHash(path.join(TMP, 'also-missing')), '目录不存在时指纹可比较（不抛错）', empty.slice(0, 16));

  /* --- 版本比较 --- */
  const cmpOk =
    CORE.cmpVersion('1.0.7', '1.0.6') === 1 &&
    CORE.cmpVersion('1.0.6', '1.0.7') === -1 &&
    CORE.cmpVersion('1.0.7', '1.0.7') === 0 &&
    CORE.cmpVersion('1.0.10', '1.0.9') === 1 &&
    CORE.cmpVersion('1.1.0', '1.0.9') === 1 &&
    CORE.cmpVersion('1.0.7', '1.0.7.0') === 0;
  record(cmpOk, '版本号比较（含 1.0.10 > 1.0.9 这种字符串比较会错的场景）', '');

  /* --- 路径映射 --- */
  const L = baseLocal();
  const mAsar = CORE.destFor('app.asar', L);
  record(/app\.asar$/.test(String(mAsar)) && /resources/.test(String(mAsar)), '目标映射：app.asar → resources/app.asar', String(mAsar));
  record(String(CORE.destFor('bin/adb.exe', L)).replace(/\\/g, '/') === 'C:/app/resources/bin/adb.exe', '目标映射：bin/adb.exe → resources/bin/adb.exe', String(CORE.destFor('bin/adb.exe', L)));
  record(CORE.destFor('evil.txt', L) === null, '目标映射：不认识的路径返回 null（防乱写）', '');
  record(CORE.destFor('../escape.asar', L) === null, '目标映射：目录穿越路径被拒', '');
  const LP = baseLocal({ kind: 'portable', targetPath: 'D:/port/helper.exe' });
  record(CORE.destFor('portable/app.exe', LP) === 'D:/port/helper.exe', '目标映射：便携版 portable/app.exe → 便携版 exe 本体', '');
  record(CORE.destFor('app.asar', LP) === null, '目标映射：便携版不认 app.asar', '');

  /* --- 暂存物理名（绕开 Electron 的 .asar 拦截）--- */
  // Electron 的 asar fs shim 以 basename 是否以 .asar 结尾判断「是不是 asar 容器」，
  // 于是暂存时写 app.asar 会抛 Invalid package（纯 Node 下不会，所以 B/C 段全绿也照样炸）。
  record(CORE.stageRel('app.asar') !== 'app.asar' && !/\.asar$/i.test(CORE.stageRel('app.asar')), '暂存名：app.asar 落盘时改成非 .asar 结尾（绕开 Electron asar shim）', CORE.stageRel('app.asar'));
  record(CORE.stageRel('bin/adb.exe') === 'bin/adb.exe', '暂存名：普通文件不改名', CORE.stageRel('bin/adb.exe'));
  record(CORE.stageRel('portable/app.exe') === 'portable/app.exe', '暂存名：便携版 exe 不改名', CORE.stageRel('portable/app.exe'));
  record(CORE.stageRel('a/b/APP.ASAR') !== 'APP.ASAR', '暂存名：大写 .ASAR 同样改名（shim 大小写不敏感）', CORE.stageRel('a/b/APP.ASAR'));
  record(!/\.asar$/i.test(CORE.stagePathOf('C:\\stage', 'app.asar')), '暂存名：stagePathOf 拼出的绝对路径不以 .asar 结尾', CORE.stagePathOf('C:\\stage', 'app.asar'));

  /* --- 助手脚本定位（打包后踩过：候选路径少一层）--- */
  // tsc 输出 dist-electron/electron/services/update.js，脚本在 dist-electron/assets/ —— 往上两层。
  // 少写一层时 dev 下靠 cwd 兜底能跑，打包后 asar 里只有 dist-electron/**，直接报「找不到更新助手脚本」。
  const hc = CORE.helperScriptCandidates(path.join(ROOT, 'dist-electron', 'electron', 'services'), ROOT);
  record(hc.length >= 2, '助手脚本：候选路径列表可用', String(hc.length));
  record(hc.some((c) => fs.existsSync(c)), '助手脚本：按真实 dist-electron 布局能找得到（dev 与打包都要能）', String(hc[0]));
  record(fs.existsSync(path.join(ROOT, 'electron', 'assets', 'update-helper.ps1')), '助手脚本：源码侧 electron/assets/update-helper.ps1 存在', '');
  record(fs.existsSync(path.join(ROOT, 'dist-electron', 'assets', 'update-helper.ps1')), '助手脚本：构建后已复制到 dist-electron/assets/（copy-assets 生效）', '');

  /* --- 助手「启动方式」（真机血案：作业对象连坐 / detached 静默不执行）--- */
  // 这两条坏法都不报错，纯静态检查永远抓不到，所以真判据在 scripts/check-helper-launch.py
  // （真 Electron 里跑一遍，宿主死掉之后再断言助手把活干完了）。
  // 这里只是廉价回归闸门：防止有人「顺手」把启动方式改回直连 spawn。
  const updSrc = fs.readFileSync(path.join(ROOT, 'electron', 'services', 'update.ts'), 'utf8');
  const spawnBlock = updSrc.slice(updSrc.indexOf('function spawnHelper('), updSrc.indexOf('function helperLogSize'));
  record(spawnBlock.length > 200, '助手启动：能在 update.ts 里定位到 spawnHelper 源码', String(spawnBlock.length));
  record(/['"]\/c['"]\s*,\s*['"]start['"]\s*,\s*['"]['"]\s*,\s*['"]\/b['"]/.test(spawnBlock), '助手启动：经 cmd /c start "" /b 代建（否则被 KILL_ON_JOB_CLOSE 连坐）', '');
  record(!/detached\s*:\s*true/.test(spawnBlock), '助手启动：没有 detached:true（DETACHED_PROCESS 会让 PowerShell 静默不执行）', '');
  record(/stdio\s*:\s*['"]ignore['"]/.test(spawnBlock), '助手启动：stdio 用 ignore（给 pipe 却不读会把子进程写卡死）', '');
  record(!/EncodedCommand/.test(spawnBlock), '助手启动：不再塞 -EncodedCommand（改成落 .ps1 + -File）', '');
  record(/\ufeff/.test(updSrc) || updSrc.includes("'\\ufeff'"), '助手脚本落地带 UTF-8 BOM（PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解中文）', '');
  record(/await waitHelperStarted\(/.test(updSrc), '助手启动：退出前等助手落下第一行日志（cmd 交接是异步的）', '');
  record(/abortHelperStart\(/.test(updSrc), '助手启动：起不来时撤销本次更新（删 pending.json + job.json）', '');

  /* --- 校验规则 --- */
  acc('合法安装版小包', baseManifest(), L);
  rej('schema 不认识', baseManifest({ schema: 2 }), L);
  rej('productName 不符', baseManifest({ productName: '别的工具' }), L);
  rej('appId 不符', baseManifest({ appId: 'com.other.app' }), L);
  rej('版本相同（不是更新）', baseManifest({ version: '1.0.6' }), L);
  rej('版本更低（降级）', baseManifest({ version: '1.0.5' }), L);
  rej('开发模式（未打包）', baseManifest(), baseLocal({ kind: 'dev' }));
  rej('便携版整包投给安装版', baseManifest({ kind: 'portable', files: [{ path: 'portable/app.exe', size: 1, sha256: 'x' }] }), L);
  rej(
    '安装版增量包投给便携版',
    baseManifest(),
    baseLocal({ kind: 'portable', targetPath: 'D:/port/helper.exe' }),
  );
  rej('Electron 版本变了', baseManifest({ electronVersion: '34.0.0' }), L);
  rej('基准运行库为空（不知道基准）', baseManifest({ baseRuntimeHash: '' }), L);
  rej('基准运行库不匹配', baseManifest({ baseRuntimeHash: 'RH-OTHER' }), L);
  rej('files 为空', baseManifest({ files: [] }), L);
  rej('files 含未知路径', baseManifest({ files: [{ path: 'app.asar', size: 1, sha256: 'x' }, { path: 'weird.bin', size: 1, sha256: 'y' }] }), L);
  rej('安装版包缺 app.asar', baseManifest({ files: [{ path: 'bin/adb.exe', size: 1, sha256: 'x' }] }), L);
  rej(
    '便携版整包缺可执行文件',
    baseManifest({ kind: 'portable', files: [{ path: 'app.asar', size: 1, sha256: 'x' }] }),
    baseLocal({ kind: 'portable', targetPath: 'D:/port/helper.exe' }),
  );

  // 便携版整包自带运行时 → 不该被 Electron / 运行库约束拦住
  const portOk = acc(
    '便携版整包忽略 Electron 与运行库差异',
    baseManifest({
      kind: 'portable',
      electronVersion: '99.0.0',
      baseRuntimeHash: '',
      files: [{ path: 'portable/app.exe', size: 1, sha256: 'x' }],
    }),
    baseLocal({ kind: 'portable', targetPath: 'D:/port/helper.exe' }),
  );
  record(portOk.ok === true, '便携版整包在 Electron 变化时仍然可用（它自带运行时）', '');

  const withBin = acc(
    '含 bin 差量时给出提醒',
    baseManifest({ files: [{ path: 'app.asar', size: 1, sha256: 'x' }, { path: 'bin/adb.exe', size: 1, sha256: 'y' }] }),
    L,
  );
  record(!!withBin.warning, '含 bin 差量会提醒用户「同时替换运行库文件」', String(withBin.warning || '').slice(0, 50));

  /* --- 完整资源包（v1.0.31）：跨版本升级的实现方式 --- */
  // 它把 bin 整份带过来，本来就不依赖目标机原有的运行库 → 必须放行，
  // 哪怕清单里的 baseRuntimeHash 与本机完全不同（这正是「1.0.2 直升 1.0.35」的场景）。
  const fullOk = acc(
    '完整资源包忽略运行库基准（跨版本可升）',
    baseManifest({
      full: true,
      baseRuntimeHash: '',
      files: [
        { path: 'app.asar', size: 1, sha256: 'x' },
        { path: 'bin/adb.exe', size: 1, sha256: 'y' },
      ],
    }),
    L,
  );
  record(fullOk.ok === true, '完整资源包在基准完全对不上时仍然可用', String(fullOk.reason || '').slice(0, 60));
  record(/完整资源包/.test(String(fullOk.warning || '')), '完整资源包给出「会覆盖 N 个运行库文件」的提醒', String(fullOk.warning || '').slice(0, 60));
  // 但 Electron 换代仍然拦得住：完整资源包里没有 electron.exe / 那堆 dll
  rej('完整资源包也不能跨 Electron 大版本', baseManifest({ full: true, electronVersion: '34.0.0' }), L);
  // 差量包带 full 之外的字段不能顺手放行 —— 只有 full:true 才跳过基准
  rej('非 full 的包照旧校验基准', baseManifest({ baseRuntimeHash: 'RH-OTHER' }), L);
}

/* ------------------------------------------------------------------ */
/* B. 助手沙箱                                                          */
/* ------------------------------------------------------------------ */

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * 找一个**独立的 node.exe**，用来做沙箱里的假启动器。
 *
 * 🔴 这里曾经直接写 `process.execPath`，注释却说是「node.exe 的副本」——
 *    于是从 `run-electron.py`（npm 脚本就是这条）跑时，execPath 是 electron.exe，
 *    而 electron.exe **必须和它同目录的那堆 dll 在一起**（ffmpeg.dll / libEGL.dll /
 *    vk_swiftshader.dll …）。单独拷到一个空目录再启动，Windows 直接给
 *    STATUS_DLL_NOT_FOUND(0xC0000135)，假启动器根本不跑：
 *      → 健康标记永不出现 → 助手按「新版白屏」回滚 → 9 条断言连锁失败。
 *    症状极具误导性：看着像「助手替换坏了」，其实是启动器没起来。
 *
 * 优先用 electron 以外、能独立启动的 node.exe；实在找不到就让调用方明确失败，
 * 不要退化成「假装通过」。
 */
let _nodeExe;
function resolveNodeExe() {
  if (_nodeExe !== undefined) return _nodeExe;
  const cands = [];
  if (path.basename(process.execPath).toLowerCase() === 'node.exe') cands.push(process.execPath);
  if (process.env.npm_node_execpath) cands.push(process.env.npm_node_execpath);
  if (process.env.NODE_EXE) cands.push(process.env.NODE_EXE);
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, 'node.exe');
    if (fs.existsSync(p)) cands.push(p);
  }
  cands.push('C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe');
  _nodeExe = cands.find((p) => p && path.basename(p).toLowerCase() === 'node.exe' && fs.existsSync(p)) || null;
  return _nodeExe;
}

function runHelper(staging, timeoutMs = 90_000) {
  let text = fs.readFileSync(path.join(ROOT, 'electron', 'assets', 'update-helper.ps1'), 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.includes('__STAGING__')) throw new Error('helper 脚本缺少 __STAGING__ 占位符');
  const script = text.split('__STAGING__').join(staging);
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync(
    fs.existsSync(PS) ? PS : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    { timeout: timeoutMs, encoding: 'utf8' },
  );
  return { status: r.status, stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

/** 造一套沙箱：假安装目录 + 假启动器 + job.json */
function makeSandbox(tag, { health = true, breakSrc = false, mode = 'apply', healthTimeoutSec = 12, noLaunchArgs = false } = {}) {
  const sb = path.join(TMP, `sb-${tag}`);
  rmdir(sb);
  const cur = path.join(sb, 'cur');
  const staging = path.join(sb, 'staging');
  const state = path.join(sb, 'state');
  const launcher = path.join(sb, 'launcher');

  wr(path.join(cur, 'resources', 'app.asar'), 'OLD-ASAR');
  wr(path.join(cur, 'resources', 'bin', 'adb.exe'), 'OLD-BIN');
  wr(path.join(staging, 'new', 'app.asar'), 'NEW-ASAR-V2');
  wr(path.join(staging, 'new', 'bin', 'adb.exe'), 'NEW-BIN-V2');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(launcher, { recursive: true });

  // 假启动器 = 独立 node.exe 的副本改名（名字唯一，Stop-Process 按名字杀不会误伤本脚本）
  // ⚠️ 不能用 process.execPath：electron.exe 离了同目录的 dll 起不来，见 resolveNodeExe()
  const myApp = path.join(launcher, 'MyApp.exe');
  const nodeExe = resolveNodeExe();
  if (!nodeExe) throw new Error('沙箱需要一份独立的 node.exe 做假启动器，但 PATH 与常见安装位置都没找到');
  fs.copyFileSync(nodeExe, myApp);

  const healthPath = path.join(state, 'health.ok');
  const src = health
    ? `const fs=require('fs');fs.writeFileSync(${JSON.stringify(healthPath)},'ok');`
    : `/* 故意不写健康标记：模拟新版启动后白屏 / 起不来 */`;
  wr(
    path.join(launcher, 'boot.cjs'),
    `${src}setTimeout(()=>process.exit(0), 600);\n`,
  );

  const job = {
    schema: 1,
    mode,
    kind: 'asar',
    pid: 0, // 0 = 跳过「等旧进程退出」，沙箱里没有真进程要等
    staging,
    resultPath: path.join(state, 'result.json'),
    pendingPath: path.join(state, 'pending.json'),
    healthPath,
    backupDir: path.join(state, 'backup'),
    logPath: path.join(state, 'helper.log'),
    fromVersion: '1.0.6',
    toVersion: '1.0.7',
    targets: [
      { name: 'app.asar', src: path.join(staging, 'new', 'app.asar'), dest: path.join(cur, 'resources', 'app.asar') },
      {
        name: 'bin/adb.exe',
        src: breakSrc ? path.join(staging, 'new', 'MISSING.exe') : path.join(staging, 'new', 'bin', 'adb.exe'),
        dest: path.join(cur, 'resources', 'bin', 'adb.exe'),
      },
    ],
    launchExe: myApp,
    // 生产形态：launchArgs 恒为空数组；沙箱以前一直给非空，于是漏掉了 B6 那个坑
    launchArgs: noLaunchArgs ? [] : [path.join(launcher, 'boot.cjs')],
    workDir: launcher,
    healthTimeoutSec,
  };
  wr(path.join(staging, 'job.json'), JSON.stringify(job, null, 2));
  wr(job.pendingPath, JSON.stringify({ from: '1.0.6', to: '1.0.7', at: new Date().toISOString() }));

  return { sb, cur, staging, state, job };
}

/**
 * 读文件；读不出来时**返回带错误码的标记**而不是裸 null。
 * 裸 null 分不清「文件不在（ENOENT）」和「内容不对」，排查时白猜一轮；
 * 而且 Electron 宿主的 asar 补丁会把普通的 `*.asar` 文件读成 `Invalid package`，
 * 这种情况更得把错误原样带出来。
 */
const read = (p) => {
  try {
    return FS.readFileSync(p, 'utf8');
  } catch (e) {
    const code = (e && e.code) || '';
    const msg = String((e && e.message) || e).slice(0, 60);
    return `<ERR ${code || '?'} ${msg}>`;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(FS.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function partB() {
  /* ---- B1：正常更新，新版握手成功 ---- */
  {
    const s = makeSandbox('ok');
    const r = runHelper(s.staging);
    const res = readJson(s.job.resultPath);
    record(res && res.ok === true, '助手：正常更新后报告成功', JSON.stringify(res && { ok: res.ok, to: res.to }));
    record(read(path.join(s.cur, 'resources', 'app.asar')) === 'NEW-ASAR-V2', '助手：app.asar 已被替换为新版', String(read(path.join(s.cur, 'resources', 'app.asar'))));
    record(read(path.join(s.cur, 'resources', 'bin', 'adb.exe')) === 'NEW-BIN-V2', '助手：bin 差量文件已替换', String(read(path.join(s.cur, 'resources', 'bin', 'adb.exe'))));
    record(read(path.join(s.state, 'backup', 'files', 'app.asar')) === 'OLD-ASAR', '助手：替换前的 app.asar 已备份', read(path.join(s.state, 'backup', 'files', 'app.asar')));
    const rj = readJson(path.join(s.state, 'backup', 'restore.json'));
    record(!!(rj && Array.isArray(rj.files) && rj.files.length === 2 && rj.fromVersion === '1.0.6'), '助手：备份里写了 restore.json（供手动回滚用）', JSON.stringify(rj && { n: rj.files.length, from: rj.fromVersion }));
    record(fs.existsSync(s.job.pendingPath), '助手：pending.json 保留（由新版握手后自行删）', fs.existsSync(s.job.pendingPath) ? '存在' : '被误删');
    record(!fs.existsSync(s.job.healthPath), '助手：成功后清掉健康标记，避免下一轮误判', fs.existsSync(s.job.healthPath) ? '仍在' : '已清');
    record(!!read(s.job.logPath), '助手：写了操作日志', String(read(s.job.logPath) || '').split('\n').length + ' 行');
    record(!r.error, '助手：进程正常退出', r.error || `status=${r.status}`);
  }

  /* ---- B2：新版不握手（白屏）→ 30s 内自动回滚 ---- */
  {
    const s = makeSandbox('rollback', { health: false, healthTimeoutSec: 8 });
    const t0 = Date.now();
    const r = runHelper(s.staging, 120_000);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const res = readJson(s.job.resultPath);
    record(res && res.ok === false && res.rolledBack === true, '助手：新版不握手 → 报告失败且已回滚', JSON.stringify(res && { ok: res.ok, rolledBack: res.rolledBack, error: String(res.error || '').slice(0, 40) }));
    record(read(path.join(s.cur, 'resources', 'app.asar')) === 'OLD-ASAR', '助手：回滚后 app.asar 恢复成旧内容', String(read(path.join(s.cur, 'resources', 'app.asar'))));
    record(read(path.join(s.cur, 'resources', 'bin', 'adb.exe')) === 'OLD-BIN', '助手：回滚后 bin 文件也恢复', String(read(path.join(s.cur, 'resources', 'bin', 'adb.exe'))));
    record(Number(secs) >= 8 && Number(secs) < 60, '助手：回滚发生在健康超时之后（不是立刻误判）', `${secs}s`);
    record(!r.error, '助手：回滚流程没有把助手自己卡死', r.error || `status=${r.status}`);
  }

  /* ---- B3：替换阶段失败（源文件缺失）→ 报错且还原 ---- */
  {
    const s = makeSandbox('broken', { breakSrc: true });
    runHelper(s.staging, 120_000);
    const res = readJson(s.job.resultPath);
    record(res && res.ok === false, '助手：替换失败时报告失败', JSON.stringify(res && { ok: res.ok, rolledBack: res.rolledBack }));
    record(res && res.rolledBack === true, '助手：替换失败也走还原', String(res && res.error).slice(0, 50));
    record(read(path.join(s.cur, 'resources', 'app.asar')) === 'OLD-ASAR', '助手：还原把已替换的文件也改回去了', String(read(path.join(s.cur, 'resources', 'app.asar'))));
  }

  /* ---- B4：手动回滚（mode=restore）---- */
  {
    const s = makeSandbox('restore');
    // 先正常更新一次（产生备份），再把当前文件改成「坏版本」，然后走还原
    runHelper(s.staging, 90_000);
    wr(path.join(s.cur, 'resources', 'app.asar'), 'BROKEN-V2');
    const job2 = { ...s.job, mode: 'restore', staging: path.join(s.sb, 'staging2') };
    fs.mkdirSync(job2.staging, { recursive: true });
    wr(path.join(job2.staging, 'job.json'), JSON.stringify(job2, null, 2));
    fs.rmSync(s.job.resultPath, { force: true });
    runHelper(job2.staging, 90_000);
    const res = readJson(s.job.resultPath);
    record(!!(res && res.ok === true), '助手：手动回滚（restore）报告成功', JSON.stringify(res && { ok: res.ok, mode: res.mode }));
    record(read(path.join(s.cur, 'resources', 'app.asar')) === 'OLD-ASAR', '助手：手动回滚把文件还原成更新前的内容', String(read(path.join(s.cur, 'resources', 'app.asar'))));
    record(read(path.join(s.cur, 'resources', 'bin', 'adb.exe')) === 'OLD-BIN', '助手：手动回滚同时还原 bin 文件', String(read(path.join(s.cur, 'resources', 'bin', 'adb.exe'))));
  }

  /* ---- B5：中文路径（PowerShell -EncodedCommand 的意义）---- */
  {
    const s = makeSandbox('中文路径');
    const r = runHelper(s.staging, 90_000);
    const res = readJson(s.job.resultPath);
    record(res && res.ok === true, '助手：中文路径下依然工作（-EncodedCommand 生效）', JSON.stringify(res && { ok: res.ok }));
    record(!r.error, '助手：中文路径下没有编码报错', r.error || `status=${r.status}`);
  }

  /* ---- B6：生产形态的 launchArgs（空数组）不能把「启动新版」打挂 ---- */
  // 真机上 update.ts 永远给 launchArgs: []，而 `Start-Process -ArgumentList @()` 会抛
  // 「无法对参数"ArgumentList"执行参数验证。该参数为 Null、为空…」——
  // 助手恰好死在「启动新版」这一步，紧接着 catch 把刚替换好的文件全还原回去，
  // 用户看到的是「更新了一趟、版本却没变」。
  // 沙箱以前一直给非空的 launchArgs，所以这条一直没被覆盖（又是「本地全绿、真机才炸」）。
  {
    const s = makeSandbox('noargs', { noLaunchArgs: true, healthTimeoutSec: 0 });
    runHelper(s.staging, 90_000);
    const logText = read(s.job.logPath) || '';
    const res = readJson(s.job.resultPath);
    const failed = (logText.match(/FAILED:.*/) || [''])[0];
    record(!/FAILED:/.test(logText), '助手：launchArgs 为空数组时「启动新版」不报错（生产形态）', failed.slice(0, 90));
    record(!!(res && res.ok === true), '助手：launchArgs 为空数组时仍判成功', JSON.stringify(res && { ok: res.ok, to: res.to }));
    record(read(path.join(s.cur, 'resources', 'app.asar')) === 'NEW-ASAR-V2', '助手：launchArgs 为空数组时文件替换被保留（没有被误回滚）', String(read(path.join(s.cur, 'resources', 'app.asar'))));
  }
}

/* ------------------------------------------------------------------ */
/* C. 产物侧（小包 + 指纹跨语言一致 + PE 版本）                          */
/* ------------------------------------------------------------------ */

function partC() {
  const dir = path.join(ROOT, OUT_DIR);
  const upd = path.join(dir, 'update');
  if (!fs.existsSync(upd)) {
    record(false, '产物侧：小包目录存在', `${upd} 不存在（先跑 python scripts/build.py --out ${OUT_DIR}）`);
    return;
  }
  const zips = fs.readdirSync(upd).filter((f) => f.endsWith('-patch.zip') && !f.includes('portable'));
  record(zips.length === 1, '产物侧：生成了安装版小包', zips.join(', '));
  if (!zips.length) return;

  const zipPath = path.join(upd, zips[0]);
  const txt = ZIP.readZipFileText(zipPath, 'manifest.json');
  let m = null;
  try {
    m = JSON.parse(txt);
  } catch {
    /* ignore */
  }
  record(!!m, '产物侧：小包内含 manifest.json', '');
  if (!m) return;

  record(
    m.schema === 1 && m.productName === 'ADB桌面助手' && m.appId === 'com.xiaoyang.adbassistant' && m.kind === 'asar',
    '产物侧：manifest 身份字段正确',
    JSON.stringify({ schema: m.schema, kind: m.kind, v: m.version }),
  );
  record(m.version === PKG.version, '产物侧：manifest 版本与 package.json 一致', `${m.version} / ${PKG.version}`);
  record(m.files.some((f) => f.path === 'app.asar'), '产物侧：小包内含 app.asar', `共 ${m.files.length} 个文件`);

  const chk = CORE.checkZipContents(zipPath, m);
  record(chk.ok, '产物侧：小包内容 sha256 与 manifest 完全对得上', chk.ok ? `${chk.totalBytes} bytes` : String(chk.reason));

  const localReal = {
    version: '0.0.1', // 故意比它小，让版本检查通过
    kind: 'asar',
    packaged: true,
    electronVersion: m.electronVersion,
    runtimeHash: m.baseRuntimeHash,
    resourcesDir: path.join(dir, 'win-unpacked', 'resources'),
    binDir: path.join(dir, 'win-unpacked', 'resources', 'bin'),
    targetPath: path.join(dir, 'win-unpacked', 'resources', 'app.asar'),
  };

  if (m.baseRuntimeHash) {
    const vr = CORE.validateManifest(m, localReal);
    record(vr.ok, '产物侧：本机运行库与包内基准一致时校验通过', vr.ok ? '' : String(vr.reason));
    const vr2 = CORE.validateManifest(m, { ...localReal, runtimeHash: 'RH-DIFFERENT' });
    record(!vr2.ok, '产物侧：运行库换成别的指纹即被拒', String(vr2.reason || '').slice(0, 50));
  } else {
    // 首版小包没有差分基准（拿不到「上一版」的 runtime json），此时应用侧必须拒绝
    // 并提示改用完整安装包 —— 这是设计行为，不是缺陷。这里正着验一遍。
    const vr = CORE.validateManifest(m, localReal);
    record(
      !vr.ok && /运行库基准/.test(String(vr.reason)),
      '产物侧：无差分基准的首版小包被拒（提示改用完整安装包）',
      String(vr.reason || '').slice(0, 50),
    );
    info('首版小包（无上一版基准）：只有 app.asar + 全部 bin，体积偏大属预期；下一版起才是纯增量');
  }

  // 跨语言一致性：Python 算的指纹必须和 TS 算的一样
  const rtFile = path.join(upd, `runtime-v${PKG.version}.json`);
  const rj = readJson(rtFile);
  if (rj) {
    const mine = CORE.computeRuntimeHash(localReal.binDir);
    record(mine === rj.runtimeHash, '指纹跨语言一致：Python(make-update.py) 与 TypeScript(update-core.ts) 结果相同', `${mine.slice(0, 16)} / ${String(rj.runtimeHash).slice(0, 16)}`);
    record(rj.binFiles && Object.keys(rj.binFiles).length > 0, '产物侧：runtime json 记录了 bin 逐文件摘要', `${Object.keys(rj.binFiles || {}).length} 个文件`);

    // 坑：package.json 的 devDependencies 里写的是区间（如 ^33.3.1），npm 实际解析到 33.4.11。
    // 应用侧比对的是 process.versions.electron（真实运行时），所以 manifest 里必须放「实际版本」，
    // 否则小包会被自己人判成「运行时发生变化」而拒收（真机 e2e 上栽过：33.3.1 vs 33.4.11）。
    const realElectron = (() => {
      const f = path.join(ROOT, 'node_modules', 'electron', 'dist', 'version');
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
      try {
        return String(require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version || '');
      } catch {
        return '';
      }
    })();
    record(
      !!realElectron && m.electronVersion === realElectron,
      '产物侧：manifest 的 Electron 版本取的是「实际运行时」而非 devDependencies 区间',
      `manifest=${m.electronVersion} 实际=${realElectron}`,
    );
    record(
      !/[~^]/.test(String(m.electronVersion || '')),
      '产物侧：manifest 的 Electron 版本不是区间表达式（^/~）',
      String(m.electronVersion),
    );
    record(
      String(rj.electronVersion) === String(m.electronVersion),
      '产物侧：runtime json 与 manifest 的 Electron 版本一致',
      `${rj.electronVersion} / ${m.electronVersion}`,
    );
  } else {
    record(false, '产物侧：runtime json 存在', `${rtFile} 缺失`);
  }

  // 篡改一个字节 → 必须被 sha256 拦住
  const bad = path.join(TMP, 'tampered.zip');
  const buf = fs.readFileSync(zipPath);
  const idx = buf.indexOf(Buffer.from('PK\x03\x04', 'latin1'), 4);
  const at = idx >= 0 ? Math.min(idx + 60, buf.length - 1) : buf.length - 10;
  buf[at] = buf[at] ^ 0xff;
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(bad, buf);
  let tamperCaught = false;
  try {
    const m2 = JSON.parse(ZIP.readZipFileText(bad, 'manifest.json'));
    tamperCaught = !CORE.checkZipContents(bad, m2).ok;
  } catch {
    tamperCaught = true; // 解压阶段就炸了，同样算拦住
  }
  record(tamperCaught, '产物侧：被篡改一个字节的小包会被校验拦下', '');

  // PE 版本
  // v1.0.24 起打包只出 NSIS 安装版（不再有便携版 exe），PE 校验对象改为 win-unpacked 主程序。
  // verifyPortableExe 实质是「PE 身份 + 版本一致性」校验，与产物形态无关，继续覆盖这条能力。
  const unpacked = path.join(dir, 'win-unpacked');
  let exePath = null;
  let exeLabel = '';
  if (fs.existsSync(unpacked)) {
    const m = fs.readdirSync(unpacked).find((f) => f.endsWith('.exe') && !f.includes('portable'));
    if (m) {
      exePath = path.join(unpacked, m);
      exeLabel = 'win-unpacked/' + m;
    }
  }
  if (!exePath) {
    const p = fs.readdirSync(dir).find((f) => f.endsWith('.exe') && f.includes('portable'));
    if (p) {
      exePath = path.join(dir, p);
      exeLabel = p;
    }
  }
  if (exePath) {
    const pe = PE.readPeVersion(exePath);
    const v3 = String(pe.fileVersion).split('.').slice(0, 3).join('.');
    record(v3 === PKG.version, 'PE：主程序 exe 内嵌版本与 package.json 一致', `${pe.fileVersion} ← ${exeLabel}`);
    record(pe.strings.ProductName === 'ADB桌面助手', 'PE：主程序 exe 内嵌 ProductName 正确（身份校验依据）', String(pe.strings.ProductName));
    const okv = CORE.verifyPortableExe(exePath, PKG.version);
    record(okv.ok, 'PE：主程序身份校验通过', okv.ok ? '' : String(okv.reason));
    const badv = CORE.verifyPortableExe(exePath, '9.9.9');
    record(!badv.ok, 'PE：声明版本与实际不符即被拒', String(badv.reason || '').slice(0, 60));

    // 用非 PE 文件冒充主程序必须被拒
    const fake = path.join(TMP, 'fake-portable.exe');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(fake, Buffer.from('MZ not really a pe'));
    const fv = CORE.verifyPortableExe(fake, PKG.version);
    record(!fv.ok, 'PE：非 PE 文件冒充主程序被拒', String(fv.reason || '').slice(0, 50));
  } else {
    record(false, 'PE：找到主程序 exe', 'win-unpacked 与产物根目录都没有可用 exe');
  }

  // latest.json（传静态托管的那份清单）—— 「发版时最容易抄错 size/sha256」的一步。
  // 生成归 npm run make:manifest（scripts/make-manifest.py）；这里只钉死「清单与产物还对得上」，
  // 抄错的话客户端第一道校验就会拒，而且要到发出去才发现。
  const manifestPath = path.join(upd, 'latest.json');
  if (fs.existsSync(manifestPath)) {
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      /* 下面按 null 报 */
    }
    record(!!doc, '清单侧：latest.json 是合法 JSON', doc ? '' : '解析失败');
    if (doc) {
      record(
        doc.schema === 1 && doc.productName === 'ADB桌面助手'
          && doc.appId === 'com.xiaoyang.adbassistant' && doc.channel === 'stable',
        '清单侧：身份四件套正确（schema / productName / appId / channel）',
        JSON.stringify({ schema: doc.schema, productName: doc.productName, channel: doc.channel }),
      );
      const lv = String((doc.latest || {}).version || '');
      record(lv === PKG.version, '清单侧：version 与 package.json 一致', `${lv} / ${PKG.version}`);

      const ref = ((doc.latest || {}).packages || {}).asar;
      record(!!(ref && ref.url), '清单侧：带 asar 包（v1.0.24 起唯一形态）', ref ? String(ref.url) : '缺失');
      if (ref && ref.url) {
        const fp = path.join(upd, path.basename(String(ref.url)));
        if (!fs.existsSync(fp)) {
          record(false, '清单侧：url 指向的包在产物里存在', String(ref.url));
        } else {
          const st = fs.statSync(fp);
          const real = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
          record(ref.size === st.size, '清单侧：size 与包的实际字节数一致', `${ref.size} / ${st.size}`);
          record(
            String(ref.sha256 || '').toLowerCase() === real,
            '清单侧：sha256 与包的实际摘要一致',
            `${String(ref.sha256).slice(0, 16)}… / ${real.slice(0, 16)}…`,
          );
        }
      }
      const notes = String((doc.latest || {}).notes || '');
      record(notes.trim().length > 0, '清单侧：notes 非空（更新卡片直接显示）', `${notes.length} 字`);
    }
  } else {
    info(`未生成 latest.json（${manifestPath}）：跑 npm run make:manifest 生成，清单侧断言已跳过`);
  }
}

/* ------------------------------------------------------------------ */
/* D. 安装版界面（CDP）                                                 */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url, errors) {
    this.id = 0;
    this.pending = new Map();
    this.errors = errors || [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = (msg.params && msg.params.exceptionDetails) || {};
        this.errors.push(d.text || (d.exception && d.exception.description) || 'exception');
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
        this.errors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function openInstalled() {
  const EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', 'ADB桌面助手.exe');
  if (!fs.existsSync(EXE)) throw new Error(`安装版不存在：${EXE}`);
  const PORT = 9351;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 必须：否则 Electron 退化成纯 Node
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
    env,
  });
  child.unref();

  const waitTarget = async (retries = 90, interval = 500) => {
    for (let i = 0; i < retries; i++) {
      const found = await new Promise((resolve) => {
        http
          .get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const list = JSON.parse(body);
                resolve(list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null);
              } catch {
                resolve(null);
              }
            });
          })
          .on('error', () => resolve(null));
      });
      if (found) return found;
      await sleep(interval);
    }
    return null;
  };

  const target = await waitTarget();
  if (!target) throw new Error('安装版未能在预期时间内开出调试端点');

  const errors = [];
  const cdp = new CDP(target.webSocketDebuggerUrl, errors);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  return {
    page: {
      evalJS: (expr) => cdp.eval(expr),
      screenshot: async (file) => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (!r || !r.data) return 0;
        const buf = Buffer.from(r.data, 'base64');
        fs.writeFileSync(file, buf);
        return buf.length;
      },
    },
    errors,
    close: () => {
      cdp.close();
      try {
        process.kill(child.pid);
      } catch {
        /* ignore */
      }
    },
  };
}

async function partD(page) {
  await page.evalJS(`(() => { location.hash = '#/settings'; return location.hash; })()`);
  await sleep(1200);
  for (let i = 0; i < 20; i++) {
    const has = await page.evalJS(`!!document.querySelector('[data-update-panel]')`);
    if (has) break;
    await sleep(400);
  }

  const got = await page.evalJS(`
    (() => {
      const p = document.querySelector('[data-update-panel]');
      if (!p) return { found: false };
      const txt = p.innerText || '';
      const btns = Array.from(p.querySelectorAll('button')).map((b) => b.textContent.trim());
      const kv = {};
      p.querySelectorAll('.kv').forEach((r) => {
        const k = r.querySelector('.kv-key'); const v = r.querySelector('.kv-value');
        if (k && v) kv[k.textContent.trim()] = v.textContent.trim();
      });
      return { found: true, kind: p.getAttribute('data-update-kind'), text: txt, btns, kv };
    })()
  `);

  record(!!got.found, '界面：关于页存在「软件更新」面板', JSON.stringify(got.found));
  if (!got.found) return;

  record(got.kind === 'asar', '界面：安装版被正确识别为「安装版（增量更新）」形态', String(got.kind));
  const want = EXPECT_VERSION || PKG.version;
  record(String(got.kv['当前版本'] || '') === `v${want}`, '界面：面板显示的版本正确', `${got.kv['当前版本']} (期望 v${want})`);
  record(/安装版（增量更新）/.test(String(got.kv['程序形态'] || '')), '界面：程序形态显示为安装版', String(got.kv['程序形态']));
  record(got.btns.some((b) => b.includes('选择更新包')), '界面：有「选择更新包…」按钮', got.btns.join(' | '));
  const openDir = await page.evalJS(`!!document.querySelector('[data-update-open-dir]')`);
  record(!!openDir, '界面：有「更新目录」按钮（日志与备份可查）', String(openDir));
  record(!/当前不支持应用内更新/.test(String(got.text)), '界面：安装版没有被判成「不支持应用内更新」', '');
  record(/SHA-256/.test(String(got.text)), '界面：说明了校验项（产品/版本/运行时/运行库/SHA-256）', '');
  record(/立即更新并重启/.test(String(got.text)) === false, '界面：未选包时不显示「立即更新并重启」（不会误点）', '');

  // 装机后的运行库指纹必须与打包时记录的基准一致 —— 这是小包能不能用的前提，
  // 也是「装完版」与「打包产物」之间最容易悄悄漂移的地方。
  const installedBin = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', 'resources', 'bin');
  if (fs.existsSync(installedBin)) {
    const installedHash = CORE.computeRuntimeHash(installedBin);
    info(`装机运行库指纹: ${installedHash}`);
    const rt = path.join(ROOT, OUT_DIR, 'update', `runtime-v${EXPECT_VERSION || PKG.version}.json`);
    const rj = readJson(rt);
    if (rj) {
      record(
        installedHash === rj.runtimeHash,
        '装机版：resources/bin 指纹与打包记录一致（小包基准能对上）',
        `${installedHash.slice(0, 16)} / ${String(rj.runtimeHash).slice(0, 16)}`,
      );
    } else {
      info(`未找到 ${rt}，跳过装机指纹比对`);
    }
  }

  await page.screenshot(path.join(OUT, 'update-settings-installed.png'));
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  try {
    fs.writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }
  fs.mkdirSync(TMP, { recursive: true });

  const errs = [];
  try {
    partA();
    info('A 段（纯逻辑）完成');
    partB();
    info('B 段（助手沙箱）完成');
  } catch (e) {
    record(false, 'A/B 段执行', safe(e && e.stack ? e.stack.split('\n')[0] : e));
  }
  try {
    partC();
    info('C 段（产物侧）完成');
  } catch (e) {
    record(false, 'C 段执行', safe(e && e.message));
  }

  if (INSTALLED) {
    let session = null;
    try {
      session = await openInstalled();
      await partD(session.page);
    } catch (e) {
      record(false, 'D 段执行', safe(e && e.message));
    }
    if (session) {
      errs.push(...session.errors);
      session.close();
    }
  } else {
    info('跳过 D 段（安装版界面）；加 --installed 才会连安装目录的真身');
  }

  log(`===== 增量更新 CHECK（${INSTALLED ? '安装版' : '本地'}）=====`);
  for (const r of rows) log(r);
  if (infos.length) {
    log('===== INFO =====');
    for (const i of infos) log(safe(i));
  }
  if (errs.length) {
    log('===== 渲染层异常 =====');
    for (const e of errs) log(safe(e));
  } else {
    log('渲染层无异常');
  }
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log(`${pass} 通过 / ${fail} 失败`);
  log('UPDATE CHECK DONE');
  process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
})();
