/**
 * 玻璃主题 CSS 视觉校验（不依赖真实桌面 / 系统 Acrylic）。
 *
 * 🔴 为什么要有这个脚本（2026-10-13 踩坑总结）：
 *    想截「玻璃真透出桌面」的图在本机**做不到**：
 *      · PrintWindow(PW_RENDERFULLCONTENT) 对 transparent 窗口返回**全黑**
 *        （透明窗口没有可绘制的背景像素，Acrylic 也不在这条路径上）
 *      · BitBlt 从屏幕 DC 取像素，**抓不到分层/DirectComposition 窗口**
 *        （实测：抓到的是窗口后面的壁纸，玻璃层整块缺失）
 *      · desktopCapturer 依赖 DXGI Desktop Duplication，本机会间歇性
 *        `DxgiDuplicatorController failed to capture desktop` 返回空白帧
 *
 *    ⇒ 换思路：**把「桌面」搬进渲染层**。
 *      在页面里插一张固定定位的假壁纸（模拟桌面），玻璃层照常做 backdrop-filter。
 *      这样 capturePage() 就能抓到「模糊 + 白纱 + 层次」的全部效果 ——
 *      验证的是 **CSS 侧**（模糊档位、透明度、配色、文字可读性），
 *      唯一测不到的是「系统 Acrylic 那一层」，那部分由主进程参数保证。
 *
 * 用法：
 *   python scripts/run-electron.py scripts/glass-css-check.cjs \
 *     --watch ui-shots/_gcc.log --until "GCC DONE" --timeout 180
 *   （默认一次出 4 档模糊 + 1 张设置页）
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;
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
const OP = Number(arg('op', 18));
const ROUGH = Number(arg('rough', 45));
const VIEW = arg('view', 'home');

function log(s) {
  fs.appendFileSync(path.join(OUT, '_gcc.log'), s + '\n');
  console.log(s);
}

/* 假桌面：与 glass-preview.cjs 里那张同一套（网格 + 色斑 + 文字 + 图标） */
const WALL = `
  <div id="__fake_desktop" style="position:fixed;inset:0;z-index:-1;background:
     radial-gradient(900px 600px at 12% 18%, #ffd166 0%, transparent 62%),
     radial-gradient(900px 700px at 88% 22%, #ef476f 0%, transparent 60%),
     radial-gradient(1000px 800px at 76% 88%, #118ab2 0%, transparent 62%),
     radial-gradient(900px 700px at 16% 86%, #06d6a0 0%, transparent 60%),
     linear-gradient(135deg,#1b2a4a 0%, #0f172b 55%, #241b3a 100%)">
    <div style="position:absolute;inset:0;background-image:
       linear-gradient(#ffffff24 1px, transparent 1px),
       linear-gradient(90deg,#ffffff24 1px, transparent 1px);
       background-size:64px 64px"></div>
    <div style="position:absolute;left:6%;top:62%;width:110px;height:110px;border-radius:16px;
         background:#0aa2ff;display:flex;align-items:center;justify-content:center;color:#fff;
         font:600 16px/1 \"Microsoft YaHei\"">图标A</div>
    <div style="position:absolute;left:16%;top:62%;width:110px;height:110px;border-radius:16px;
         background:#20c997;display:flex;align-items:center;justify-content:center;color:#fff;
         font:600 16px/1 \"Microsoft YaHei\"">图标B</div>
    <div style="position:absolute;left:26%;top:62%;width:110px;height:110px;border-radius:16px;
         background:#f59f00;display:flex;align-items:center;justify-content:center;color:#fff;
         font:600 16px/1 \"Microsoft YaHei\"">图标C</div>
    <div style="position:absolute;left:36%;top:62%;width:110px;height:110px;border-radius:16px;
         background:#e83e8c;display:flex;align-items:center;justify-content:center;color:#fff;
         font:600 16px/1 \"Microsoft YaHei\"">图标D</div>
    <div style="position:absolute;left:6%;top:10%;color:#fff;max-width:64%;
         font:700 40px/1.3 \"Microsoft YaHei\";text-shadow:0 2px 10px #0009">
      桌面壁纸 · 细节测试<br>
      <span style="font-size:24px;opacity:.88">The quick brown fox 敏捷棕狐 0123456789</span>
    </div>
  </div>`;

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
    JSON.stringify({ ...cur, theme: 'glass', glassOpacity: OP, glassRoughness: ROUGH }, null, 2),
  );
}
seedSettings();

app.whenReady().then(async () => {
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  /*
   * ⚠️ 故意**不开** transparent / backgroundMaterial：
   *    本脚本验证的是 CSS 侧观感，窗口保持不透明，capturePage 才抓得到。
   *    玻璃的「白色底 + backdrop-filter」在页面内自成体系，
   *    底下的假壁纸就是它的「桌面」。
   */
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    backgroundColor: '#0f172b',
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await wait(4000);

  // 在 <body> 末尾插假壁纸（app-shell 之前，保证它在最底层）
  await win.webContents.executeJavaScript(`(function(){
    var d=document.createElement('div');
    d.innerHTML=${JSON.stringify(WALL)};
    document.body.insertBefore(d.firstElementChild, document.body.firstChild);
    return document.getElementById('__fake_desktop') ? 'WALL SET' : 'WALL FAIL';
  })()`).then((r) => log('  ' + r));

  if (VIEW === 'settings') {
    await win.webContents.executeJavaScript(`(function(){
      var el=document.querySelector('.nav-item[data-nav="settings"]')
        || [...document.querySelectorAll('.nav-item')].find(n=>/设置/.test(n.textContent));
      if(el) el.click();
      return !!el;})()`).then((r) => log('  settings clicked=' + r));
    await wait(1600);
  }
  await wait(900);

  const img = await win.webContents.capturePage();
  const file = path.join(OUT, arg('out', `glass-css-${VIEW}-${OP}-${ROUGH}.png`));
  fs.writeFileSync(file, img.toPNG());
  log(`GCC OK ${path.basename(file)} bytes=${fs.statSync(file).size}`);
  log('GCC DONE');
  app.exit(0);
});
