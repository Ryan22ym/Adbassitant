#!/usr/bin/env node
/**
 * 跨版本在线更新验收（v1.0.31）。
 *
 * 回答两个问题，都用**真实产物**跑，不靠推理：
 *   ① 一台落后的机器（运行库基线 ≠ 最新版基线）点在线更新，到底能不能升上来？
 *   ② 新版本需要「新增随包资源」时，能不能靠在线更新把文件送下去？
 *
 * 做法：
 *   1. 用产物目录 `out-vX/win-unpacked/resources/bin` 造两棵假安装树：
 *      · NEW 树 = 与上一版一致（运行库指纹 == 主小包的 baseRuntimeHash）
 *      · OLD 树 = 去掉随包弱网 APK（= 1.0.28 那批机器，指纹 de427368…）
 *   2. 桩掉 electron，直接 require 编译产物 update.js，对三种包各跑一次 prepareUpdate：
 *      主小包 / 老基线变体小包 / 完整资源包 —— 断言「谁该过、谁该被拒」。
 *   3. 起本地 http 服务，走真实 httpSource，断言**挑包**结果：
 *      新机器挑主小包、老机器挑它自己的变体、更老的机器自动退到完整资源包。
 *   4. 真跑一次 electron/assets/update-helper.ps1，把完整资源包应用到 OLD 树，
 *      断言文件都换对了，且**新增的 weaknet-vpn.apk 确实被写进去了**（问题②）。
 *
 * 用法：
 *   node scripts/check-update-crossversion.cjs
 *   node scripts/check-update-crossversion.cjs --out out-v1.0.31
 *
 * 退出码 0 = 全过。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : null;

/**
 * 被检查的是 dist-electron 里的编译产物 —— 过期产物 = 拿旧代码验收。
 * 先自己编一遍（与 check-update-online.cjs 同一套理由）。
 */
function ensureBuilt() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.log('找不到 typescript（' + tsc + '），先 npm install 再跑。');
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.electron.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.log('主进程编译失败，验收无意义（先修 tsc）：');
    console.log((r.stdout || '') + (r.stderr || ''));
    process.exit(2);
  }
}
ensureBuilt();

const DIST = path.join(ROOT, 'dist-electron', 'electron', 'services');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const OUT_DIR = path.join(ROOT, OUT || ('out-v' + PKG_VERSION));
const UPD = path.join(OUT_DIR, 'update');
const SRC_RES = path.join(OUT_DIR, 'win-unpacked', 'resources');
/** 随包资源里「最近才加入」的那个 —— 老树的标志性缺失文件 */
const NEW_RESOURCE = 'weaknet-vpn.apk';
/** 老树里连**目录**都没有的那一块（用来验证助手会先把目录建出来） */
const NEW_SUBDIR = 'bundletool';

let pass = 0;
let fail = 0;
function rec(ok, name, detail = '') {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '  :: ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  :: ' + detail); }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fingerprint(binDir) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  })(binDir);
  const lines = files
    .map((p) => ({ rel: path.relative(binDir, p).replace(/\\/g, '/'), p }))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1))
    .map((f) => `${f.rel}|${fs.statSync(f.p).size}|${sha256(fs.readFileSync(f.p))}`);
  return sha256(Buffer.from(lines.join('\n'), 'utf8'));
}

/* ------------------------------------------------------------------ */
/* 桩：直接 require 编译产物，不必起 Electron                            */
/* ------------------------------------------------------------------ */

let stubbed = null;
/** 真身上报的 Electron 版本 —— 从产物包内的 manifest 读，别写死（写死迟早对不上） */
let ELECTRON_VER = '';
/**
 * 🔴 注意 STUB 列表里**故意没有 './adb'**：update.ts 的 localSnapshot() 要调它拿 bin 目录，
 *    桩成空函数会让运行库指纹算成空串，整轮验收就变成自欺欺人。
 *    真实 ./adb 只依赖 electron（已被桩掉），加载它没有副作用。
 */
const STUB = ['./settings', './mirror', './logcat', './weaknet'];
function installStubs(localVersion) {
  const fakeElectron = {
    app: {
      isPackaged: true,
      getVersion: () => localVersion,
      getPath: () => stubbed.tmp,
      getAppPath: () => stubbed.tmp,
      on() {},
      whenReady: () => Promise.resolve(),
    },
    shell: { openPath() {}, openExternal() {} },
    ipcMain: { handle() {} },
    BrowserWindow: function () {},
  };
  const noop = () => new Proxy({}, { get: (t, k) => (typeof k === 'symbol' ? undefined : () => {}) });
  const cache = {};
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return fakeElectron;
    if (STUB.includes(req)) {
      if (!cache[req]) cache[req] = noop();
      return cache[req];
    }
    return orig.apply(this, arguments);
  };
}

function loadService(name, localVersion, resourcesDir, tmpDir) {
  stubbed = { tmp: tmpDir, electron: ELECTRON_VER };
  for (const k of Object.keys(require.cache)) {
    if (k.replace(/\\/g, '/').includes('/dist-electron/')) delete require.cache[k];
  }
  Object.defineProperty(process, 'resourcesPath', { value: resourcesDir, configurable: true });
  Object.defineProperty(process.versions, 'electron', { value: stubbed.electron, configurable: true });  installStubs(localVersion);
  return require(path.join(DIST, name));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 递归拷贝目录。
 *
 * 🔴 不用 `fs.cpSync(..., {recursive:true})`：本机实测拷 bin/（含 32 MB 的
 *    bundletool jar）时**整个进程直接消失、连异常都不抛**（exit 127，日志停在调用点），
 *    排查代价极高。逐个 copyFileSync 稳定可靠。
 */
function copyTree(src, dest) {
  for (const rel of fs.readdirSync(src, { recursive: true })) {
    const sp = path.join(src, rel);
    if (!fs.statSync(sp).isFile()) continue;
    const dp = path.join(dest, rel);
    fs.mkdirSync(path.dirname(dp), { recursive: true });
    fs.copyFileSync(sp, dp);
  }
}

(async () => {
  if (!fs.existsSync(path.join(SRC_RES, 'app.asar'))) {
    console.log('找不到 ' + path.join(SRC_RES, 'app.asar') + ' —— 先跑 python scripts/build.py --out ' + OUT);
    process.exit(2);
  }
  const latest = JSON.parse(fs.readFileSync(path.join(UPD, 'latest.json'), 'utf8'));
  const version = latest.latest.version;
  const packs = latest.latest.packages || {};
  const variants = latest.latest.variants || [];
  ELECTRON_VER = JSON.parse(
    require(path.join(DIST, 'zip.js')).readZipFileText(
      path.join(UPD, path.basename(packs.asar.url)), 'manifest.json',
    ),
  ).electronVersion;

  const zip = (n) => path.join(UPD, n);
  const primaryZip = zip(path.basename(packs.asar.url));
  const fullZip = packs.full ? zip(path.basename(packs.full.url)) : null;
  const variantZips = variants.map((v) => ({ ref: v, file: zip(path.basename(v.url)) }));

  console.log('== A. 产物与清单 ==');
  rec(version === PKG_VERSION, '清单版本 = package.json 版本', version);
  rec(!!packs.asar, '有主小包', packs.asar && packs.asar.url);
  rec(!!packs.full, '有完整资源包（跨版本兜底）', packs.full ? packs.full.url : '(缺失 —— make-update.py 要加 --full)');
  rec(variantZips.length >= 2, '有多基线变体', variantZips.map((v) => 'v' + (v.ref.baseRuntimeHash || '?').slice(0, 8)).join(' '));
  if (!fullZip || !fs.existsSync(fullZip)) {
    console.log('\n完整资源包不存在，无法验证跨版本 —— 中止。');
    console.log(`RESULT pass=${pass} fail=${fail + 1}`);
    process.exit(1);
  }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adba-xver-'));
  /** 与上一版一致的机器（= 主小包能直接装的那批） */
  const NEW_RES = path.join(TMP, 'new', 'resources');
  /** 1.0.28 那批机器：bin 里还没有随包弱网 APK */
  const OLD_RES = path.join(TMP, 'old', 'resources');
  /** 更老的机器：连 bundletool 子目录都没有（用来验证助手会先建目录） */
  const SUB_RES = path.join(TMP, 'sub', 'resources');

  console.log('== B. 造三棵假安装树 ==');
  for (const [res, drop] of [
    [NEW_RES, []],
    [OLD_RES, [NEW_RESOURCE]],
    [SUB_RES, [NEW_RESOURCE, NEW_SUBDIR]],
  ]) {
    fs.mkdirSync(res, { recursive: true });
    copyTree(path.join(SRC_RES, 'bin'), path.join(res, 'bin'));
    fs.copyFileSync(path.join(SRC_RES, 'app.asar'), path.join(res, 'app.asar'));
    for (const d of drop) fs.rmSync(path.join(res, 'bin', d), { recursive: true, force: true });
  }
  const binCount = fs.readdirSync(path.join(SRC_RES, 'bin'), { recursive: true })
    .filter((f) => fs.statSync(path.join(SRC_RES, 'bin', f)).isFile()).length;
  const hashNew = fingerprint(path.join(NEW_RES, 'bin'));
  const hashOld = fingerprint(path.join(OLD_RES, 'bin'));
  const hashSub = fingerprint(path.join(SUB_RES, 'bin'));
  rec(hashNew !== hashOld && hashOld !== hashSub, '三棵树的运行库指纹互不相同（真造出了「落后版本」）',
    `${hashNew.slice(0, 8)}… / ${hashOld.slice(0, 8)}… / ${hashSub.slice(0, 8)}…`);
  rec(packs.asar.baseRuntimeHash === hashNew,
    '主小包的 baseRuntimeHash 正好等于「上一版机器」的指纹（装得上）', String(packs.asar.baseRuntimeHash || '').slice(0, 12) + '…');
  const oldVariant = variantZips.find((v) => v.ref.baseRuntimeHash === hashOld);
  rec(!!oldVariant, '存在一份基准正好等于「1.0.28 那批机器」的小包变体',
    oldVariant ? `${oldVariant.ref.url}（bin 差量 ${fs.statSync(oldVariant.file).size} B）` : '(没有 --also-from 对应的基线)');

  console.log('== C. prepareUpdate：谁该过、谁该被拒 ==');
  const oldTmp = path.join(TMP, 'old-userdata');
  const newTmp = path.join(TMP, 'new-userdata');
  fs.mkdirSync(oldTmp, { recursive: true });
  fs.mkdirSync(newTmp, { recursive: true });

  const updOld = loadService('update.js', '1.0.28', OLD_RES, oldTmp);
  const r1 = await updOld.prepareUpdate(primaryZip);
  rec(r1.ok === false && /运行库不一致/.test(String(r1.reason || '')),
    '老机器 + 主小包 → 如实拒绝（这就是「漏更几版就更新不了」的现场）',
    String(r1.reason || '').slice(0, 46));

  if (oldVariant) {
    const r2 = await updOld.prepareUpdate(oldVariant.file);
    rec(r2.ok === true, '老机器 + 适配它基线的小包 → 通过，且体积小',
      `ok=${r2.ok} ${(fs.statSync(oldVariant.file).size / 1024).toFixed(0)} KB reason=${r2.reason || '(无)'}`);
  }

  const r3 = await updOld.prepareUpdate(fullZip);
  rec(r3.ok === true, '老机器 + 完整资源包 → 通过（跨版本一次到位）',
    `ok=${r3.ok} 文件数=${r3.fileCount} ${(fs.statSync(fullZip).size / 1048576).toFixed(1)} MB`);
  rec(Array.isArray(r3.runtimeFiles) && r3.runtimeFiles.length === binCount,
    '完整资源包带回全部运行库文件（不是差量）', `${r3.runtimeFiles && r3.runtimeFiles.length} / ${binCount}`);

  const updNew = loadService('update.js', '1.0.30', NEW_RES, newTmp);
  const r4 = await updNew.prepareUpdate(primaryZip);
  rec(r4.ok === true, '最新机器 + 主小包 → 通过（没有把好路堵死）',
    `ok=${r4.ok} 文件数=${r4.fileCount} ${(fs.statSync(primaryZip).size / 1024).toFixed(0)} KB`);
  const r5 = await updNew.prepareUpdate(fullZip);
  rec(r5.ok === true, '最新机器 + 完整资源包 → 也通过（兜底路径对谁都成立）', `ok=${r5.ok}`);

  console.log('== D. 挑包（本地 http 服务 + 真实 httpSource） ==');
  const srcMod = loadService('update-source.js', '1.0.28', OLD_RES, oldTmp);
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/+/, ''));
    const p = name ? path.join(UPD, name) : null;
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/zip' });
    res.end(fs.readFileSync(p));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const pick = async (localVersion, runtimeHash) => {
    const s = srcMod.httpSource({
      baseUrl: base, localVersion, kind: 'asar', channel: 'stable', runtimeHash, downloadDir: TMP,
    });
    return s.check();
  };

  const iNew = await pick('1.0.30', hashNew);
  rec(iNew.form === 'asar' && /patch\.zip$/.test(iNew.pkg.url) && !iNew.note,
    '最新机器 → 挑中主小包（最小那份，无额外提示）', iNew.pkg && iNew.pkg.url);

  const iOld = await pick('1.0.28', hashOld);
  const oldWanted = oldVariant ? path.basename(oldVariant.ref.url) : '';
  // 注意 URL 里的中文/空格是百分号编码的，不能直接 endsWith 原始文件名
  const iOldName = decodeURIComponent(String(iOld.pkg ? iOld.pkg.url : '').split('/').pop() || '');
  rec(iOld.form === 'asar' && !!oldWanted && iOldName === oldWanted,
    '老机器 → 挑中适配它自己的那份小包，而不是几十 MB 的完整包', iOldName || '(空)');

  const iAncient = await pick('1.0.2', 'a'.repeat(64));
  rec(iAncient.form === 'full' && /full\.zip$/.test(iAncient.pkg.url),
    '更老的机器（一份都对不上）→ 自动改走完整资源包', iAncient.pkg && iAncient.pkg.url);
  rec(/完整资源包/.test(String(iAncient.note || '')), '并提前说明会用完整资源包', String(iAncient.note || '').slice(0, 40));

  server.close();

  console.log('== E. 真跑更新助手：把完整资源包应用到「更老的机器」 ==');
  const coreMod = require(path.join(DIST, 'update-core.js'));
  const zipMod = require(path.join(DIST, 'zip.js'));
  const manifest = JSON.parse(zipMod.readZipFileText(fullZip, 'manifest.json'));
  const stage = path.join(TMP, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  coreMod.extractToStage(fullZip, stage);

  const snapshotOld = {
    version: '1.0.2', kind: 'asar', packaged: true, electronVersion: ELECTRON_VER,
    runtimeHash: hashSub, resourcesDir: SUB_RES, binDir: path.join(SUB_RES, 'bin'),
    targetPath: path.join(SUB_RES, 'app.asar'),
  };
  const targets = manifest.files.map((f) => ({
    name: f.path,
    src: coreMod.stagePathOf(stage, f.path),
    dest: coreMod.destFor(f.path, snapshotOld),
  }));
  rec(targets.every((t) => !!t.dest && fs.existsSync(t.src)), '每个文件都能映射到本机位置并已解压',
    `${targets.length} 个`);

  const jobPath = path.join(stage, 'job.json');
  fs.writeFileSync(jobPath, JSON.stringify({
    schema: 1, mode: 'apply', kind: 'asar', pid: 0, staging: stage,
    resultPath: path.join(stage, 'result.json'),
    pendingPath: path.join(stage, 'pending.json'),
    healthPath: path.join(stage, 'health.ok'),
    backupDir: path.join(stage, 'backup'),
    logPath: path.join(stage, 'helper.log'),
    fromVersion: '1.0.28', toVersion: manifest.version,
    targets, launchExe: '', launchArgs: [], workDir: '', healthTimeoutSec: 0,
  }, null, 2), 'utf8');

  let helper = fs.readFileSync(path.join(ROOT, 'electron', 'assets', 'update-helper.ps1'), 'utf8');
  if (helper.charCodeAt(0) === 0xfeff) helper = helper.slice(1);
  if (!helper.includes('__STAGING__')) { console.log('助手脚本缺少 __STAGING__ 占位符'); process.exit(2); }
  const helperPath = path.join(stage, 'update-helper.ps1');
  fs.writeFileSync(helperPath, '\ufeff' + helper.split('__STAGING__').join(stage), 'utf8');

  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const pr = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
    { encoding: 'utf8', timeout: 180000 });
  const helperLog = fs.existsSync(path.join(stage, 'helper.log'))
    ? fs.readFileSync(path.join(stage, 'helper.log'), 'utf8') : '';
  let result = null;
  try { result = JSON.parse(fs.readFileSync(path.join(stage, 'result.json'), 'utf8')); } catch { /* 没落盘 */ }

  rec(!!result && result.ok === true, '助手把这一轮更新判成成功',
    result ? JSON.stringify(result).slice(0, 80) : (pr.stdout || '') + (pr.stderr || ''));
  rec(/mkdir /.test(helperLog), '助手在替换前建出了缺失的目录（新增资源能落地）',
    (helperLog.match(/mkdir .*/) || ['(没建目录)'])[0].slice(0, 70));

  const bad = [];
  for (const f of manifest.files) {
    const dest = coreMod.destFor(f.path, snapshotOld);
    if (!dest || !fs.existsSync(dest)) { bad.push(f.path + '(缺)'); continue; }
    if (sha256(fs.readFileSync(dest)) !== f.sha256) bad.push(f.path + '(内容不符)');
  }
  rec(bad.length === 0, '落盘的每个文件都与清单 sha256 一致', bad.length ? bad.slice(0, 4).join(' ') : `${manifest.files.length} 个`);

  const newResPath = path.join(SUB_RES, 'bin', NEW_RESOURCE);
  rec(fs.existsSync(newResPath), '「本机原先没有的随包资源」被在线更新送了下来（问题②）',
    fs.existsSync(newResPath) ? `${NEW_RESOURCE} ${fs.statSync(newResPath).size} B` : '(还是没有)');
  rec(fingerprint(path.join(SUB_RES, 'bin')) === fingerprint(path.join(SRC_RES, 'bin')),
    '老机器的运行库指纹已变成新版（= 下次可以走小包了）',
    fingerprint(path.join(SUB_RES, 'bin')).slice(0, 12) + '…');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录删不掉无所谓 */ }

  console.log();
  console.log(`${pass} 通过 / ${fail} 失败`);
  console.log('CROSSVERSION CHECK DONE');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('EXCEPTION: ' + (e && e.stack ? e.stack : e));
  console.log('CROSSVERSION CHECK DONE');
  process.exit(1);
});
