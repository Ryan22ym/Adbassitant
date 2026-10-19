/**
 * 玻璃主题效果窗口 —— 只负责「把窗口摆出来并保持存活到被截图」。
 *
 * 🔴 抓图不在本脚本里做，交给 scripts/run-electron.py 的 `--grab`：
 *    本进程内 spawn 第二个 python 会 EBUSY（实测），
 *    而 desktopCapturer 依赖 DXGI，本机会间歇性失效并返回空白帧。
 *    runner 是旁观进程，用 PrintWindow 抓窗口自身合成像素最稳。
 *
 * 用法：
 *   python scripts/run-electron.py scripts/glass-preview.cjs \
 *     --watch ui-shots/_gp.log --until "GP READY" --timeout 90 \
 *     --grab ui-shots/_gp.pid:ui-shots/glass-preview.png \
 *     -- --op=18 --rough=45
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, screen } = electronMain;
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

/*
 * 日志/pid 路径由调用方通过参数给出，**不要写死**。
 * 🔴 踩过：写死成 ui-shots/_gp.log 时，runner 用 --watch e2e-tmp/_gp-xxx.log 去监视
 *    一个**永远不会被写的文件**，于是「日志没有新内容 → 判为失败」，
 *    而脚本其实早就写好了 GP READY（落在另一个路径）—— 看起来像脚本没跑起来，实为路径不一致。
 */
const LOG = arg('log', path.join(OUT, '_gp.log'));
const PIDFILE = arg('pidfile', path.join(OUT, '_gp.pid'));

const OP = Number(arg('op', 18));
const ROUGH = Number(arg('rough', 45));
const VIEW = arg('view', 'home');   // home | settings

function log(s) {
  try {
    fs.appendFileSync(LOG, s + '\n');
  } catch {}
  console.log(s);
}

/* 预置设置：必须在 whenReady 之前落盘，窗口一建就读它 */
function seedSettings() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try {
    if (fs.existsSync(file)) cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  fs.writeFileSync(
    file,
    JSON.stringify(
      { ...cur, theme: 'glass', glassOpacity: OP, glassRoughness: ROUGH },
      null,
      2,
    ),
  );
}
seedSettings();

/*
 * 测试壁纸：一张高对比、高饱和、带网格与文字的假桌面。
 * 🔴 为什么必须铺：真实桌面如果是纯色（或 DXGI 抓不到），
 *    「桌面透上来」就无从验证；有网格线能一眼看出「糊到什么程度还认得出格子」，
 *    有色块能看出「色域还在不在」，有文字能看出「还认不认得出字」。
 * ⚠️ 纯验收脚手架，不进产品包。
 */
const WALL_HTML = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;overflow:hidden}
  .pc{position:absolute;border-radius:16px;display:flex;align-items:center;
      justify-content:center;font:600 16px/1.2 "Microsoft YaHei",sans-serif;
      color:#fff;text-shadow:0 1px 4px #0009}
</style>
<body>
<div style="position:absolute;inset:0;background:
 radial-gradient(900px 600px at 12% 18%, #ffd166 0%, transparent 62%),
 radial-gradient(900px 700px at 88% 22%, #ef476f 0%, transparent 60%),
 radial-gradient(1000px 800px at 76% 88%, #118ab2 0%, transparent 62%),
 radial-gradient(900px 700px at 16% 86%, #06d6a0 0%, transparent 60%),
 linear-gradient(135deg,#1b2a4a 0%, #0f172b 55%, #241b3a 100%)"></div>
<div style="position:absolute;inset:0;background-image:
 linear-gradient(#ffffff24 1px, transparent 1px),
 linear-gradient(90deg,#ffffff24 1px, transparent 1px);background-size:64px 64px"></div>
<div class="pc" style="left:6%;top:62%;width:110px;height:110px;background:#0aa2ff">图标A</div>
<div class="pc" style="left:16%;top:62%;width:110px;height:110px;background:#20c997">图标B</div>
<div class="pc" style="left:26%;top:62%;width:110px;height:110px;background:#f59f00">图标C</div>
<div class="pc" style="left:36%;top:62%;width:110px;height:110px;background:#e83e8c">图标D</div>
<div class="pc" style="left:46%;top:62%;width:110px;height:110px;background:#845ef7">图标E</div>
<div class="pc" style="left:56%;top:62%;width:110px;height:110px;background:#f03e3e">图标F</div>
<div style="position:absolute;left:6%;top:10%;color:#fff;max-width:70%;
 font:700 40px/1.3 "Microsoft YaHei",sans-serif;text-shadow:0 2px 10px #0009">
  桌面壁纸 · 细节测试<br>
  <span style="font-size:24px;opacity:.88">The quick brown fox 敏捷棕狐 0123456789</span>
</div>
</body>`;

app.whenReady().then(async () => {
  const { registerIpc, setGlassWindowHook } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const wa = screen.getPrimaryDisplay().workAreaSize;

  // ---- 底层假壁纸（不透明，铺满整个工作区）----
  const bgWin = new BrowserWindow({
    x: 0, y: 0, width: wa.width, height: wa.height,
    frame: false, show: true, skipTaskbar: true,
    focusable: false, resizable: false, movable: false,
  });
  bgWin.setAlwaysOnTop(false);
  await bgWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(WALL_HTML));
  await wait(900);

  // ---- 上层玻璃窗（与主进程 createWindow 的 glass 分支保持一致）----
  const w = Math.min(1180, wa.width - 140);
  const h = Math.min(820, wa.height - 140);
  const win = new BrowserWindow({
    width: w, height: h, useContentSize: true,
    x: Math.round((wa.width - w) / 2),
    y: Math.round((wa.height - h) / 2),
    show: true,
    transparent: true,
    frame: false,
    roundedCorners: true,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  setGlassWindowHook((on) => {
    try {
      win.setBackgroundMaterial(on ? 'acrylic' : 'none');
      win.setBackgroundColor(on ? '#00000000' : '#f5f8fe');
    } catch {}
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await wait(5000);

  if (VIEW === 'settings') {
    await win.webContents.executeJavaScript(
      `(function(){const el=document.querySelector('.nav-item[data-nav="settings"]')
        || [...document.querySelectorAll('.nav-item')].find(n=>/设置/.test(n.textContent));
        if(el) el.click(); return !!el;})()`,
    );
    await wait(1800);
  }

  win.setBackgroundMaterial('acrylic');
  win.setBackgroundColor('#00000000');
  await wait(2200);

  // 让 runner 知道该抓谁（并把窗口尺寸带出去，避免它抓到满屏的假壁纸）
  const cb = win.getBounds();
  fs.writeFileSync(PIDFILE, String(process.pid));
  log(`GP READY pid=${process.pid} op=${OP} rough=${ROUGH} view=${VIEW} wxh=${cb.width}x${cb.height}`);

  // 保持存活，等 runner 抓完再杀
  await wait(60000);
  app.exit(0);
});
