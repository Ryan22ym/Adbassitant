/**
 * 专项检查：在**真 Electron 运行时**里把真实更新包解压到暂存目录。
 *
 * 为什么单独一个脚本：
 *   Electron 的 asar fs shim 以「basename 是否以 .asar 结尾」判断这是不是一个 asar 容器。
 *   于是往暂存目录写一个普通文件 `app.asar` 会抛 `Invalid package …`，
 *   而且 `writeFileSync` 与 `openSync+writeSync` 两条路都被拦（大小写不敏感）。
 *   纯 Node 下完全没有这个 shim —— 所以 check-update.cjs 的 A/B/C 段全绿照样会在真身里炸。
 *   这段交互只能靠「真的在 Electron 里跑一次」来验，放在这里 5 秒出结果，
 *   不用等 3 分钟的安装版 e2e。
 *
 * 用法（必须用 Electron 跑，不能用 node）：
 *   python scripts/run-electron.py scripts/check-asar-stage.cjs \
 *     --watch ui-shots/_asar-stage.log --until "ASAR STAGE CHECK DONE" --timeout 180
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_asar-stage.log');
try {
  // 用「截断」而不是「删除」：run-electron.py 靠「日志文件体积变化」判定脚本是否跑起来，
  // 文件一开始不存在会让它误判成「日志没有新内容」，最后返回非 0（结果其实是对的）。
  fs.writeFileSync(LOG, '');
} catch {
  /* ignore */
}

const CORE = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'update-core.js'));
const ZIP = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'zip.js'));

let rows = [];
const infos = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* ignore */
  }
};
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);

/** 找一个真实的安装版小包：优先 package.json 当前版本对应的 out-vX */
function findPatchZip() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cands = [];
  for (const d of fs.readdirSync(ROOT)) {
    if (!/^out-v/.test(d)) continue;
    const u = path.join(ROOT, d, 'update');
    if (!fs.existsSync(u)) continue;
    for (const f of fs.readdirSync(u)) {
      if (f.endsWith('-patch.zip') && !f.includes('portable')) cands.push(path.join(u, f));
    }
  }
  // 把与当前 package.json 版本一致的排在前面
  cands.sort((a, b) => (b.includes(`v${pkg.version}-`) ? 1 : 0) - (a.includes(`v${pkg.version}-`) ? 1 : 0));
  return cands[0] || null;
}

const zipPath = findPatchZip();
if (!zipPath) {
  record(false, '找到真实的安装版小包（先跑 python scripts/build.py --out out-vX）', '');
} else {
  infos.push(`使用小包: ${zipPath} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB)`);

  const manifest = JSON.parse(ZIP.readZipFileText(zipPath, 'manifest.json'));
  const stageDir = path.join(os.tmpdir(), `adba-asar-stage-${Date.now()}`);

  // 0) 先自证环境里确实有那个 shim —— 否则下面的 PASS 是假的（比如误用 node 跑）
  const hasShim = (() => {
    const p = path.join(stageDir, 'shim-probe.asar');
    try {
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(p, Buffer.from('x'));
      return false; // 居然写成功了 → 没有 shim
    } catch (e) {
      infos.push(`shim 探针: ${String(e.message).slice(0, 80)}`);
      return /Invalid package/i.test(String(e.message));
    }
  })();
  record(hasShim, '前置：本运行时确实有 Electron asar shim（否则本检查无意义）', hasShim ? '' : '没有 shim —— 是不是用 node 跑的？');

  // 1) 解压
  let written = null;
  let err = '';
  try {
    written = CORE.extractToStage(zipPath, stageDir);
  } catch (e) {
    err = String(e && e.message);
  }
  record(written !== null, '解压不再抛错（旧写法在这里会是 Invalid package）', err.slice(0, 120));

  // 2) 落盘的物理名都不以 .asar 结尾
  const bad = (written || []).filter((w) => /\.asar$/i.test(w));
  record(written !== null && bad.length === 0, '暂存目录里没有任何以 .asar 结尾的路径', bad.join(', '));

  // 3) manifest 里每个文件都真的落了盘，且 sha256 与 manifest 一致
  const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  let allOk = true;
  const detail = [];
  for (const f of manifest.files || []) {
    const p = CORE.stagePathOf(stageDir, f.path);
    if (!fs.existsSync(p)) {
      allOk = false;
      detail.push(`${f.path}: 缺失`);
      continue;
    }
    const got = sha256(p);
    if (got !== f.sha256) {
      allOk = false;
      detail.push(`${f.path}: sha256 不符`);
    } else {
      detail.push(`${f.path} → ${path.basename(p)} ✓`);
    }
  }
  record(!!manifest.files && manifest.files.length > 0 && allOk, '暂存内容与 manifest 逐项对上（名字换了，内容没变）', detail.join(' | '));

  // 4) 逻辑名保持原样（写进 job.json 的目标名不能被改名牵连）
  const nAsar = (manifest.files || []).filter((f) => f.path === 'app.asar').length;
  record(nAsar === 0 || CORE.destFor('app.asar', { resourcesDir: 'C:\\app\\resources' }) === path.join('C:\\app\\resources', 'app.asar'), '逻辑名与目标路径未被改名影响（仍是 resources/app.asar）', String(CORE.destFor('app.asar', { resourcesDir: 'C:\\app\\resources' })));

  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

log(`===== 真 Electron 暂存检查（electron ${process.versions.electron || 'n/a'}）=====`);
for (const r of rows) log(r);
if (infos.length) {
  log('===== INFO =====');
  for (const i of infos) log(i);
}
const pass = rows.filter((r) => r.startsWith('PASS')).length;
const fail = rows.filter((r) => r.startsWith('FAIL')).length;
log(`${pass} 通过 / ${fail} 失败`);
log('ASAR STAGE CHECK DONE');
process.exit(fail === 0 ? 0 : 1);
