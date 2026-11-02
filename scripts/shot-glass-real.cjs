/**
 * 玻璃主题真实形态截图（B4 验收用）。
 *
 * 与 `capture-glass.cjs` 的区别（**别再用那个判断玻璃效果**）：
 *   那个脚本还停在 v1.1.12 的 `transparent:true + backgroundMaterial:'acrylic'`，
 *   而 v1.1.13 起已经确认这条路在本机（Win10）上「透明了但零模糊」——
 *   它截出来的图**不代表真实效果**，不能拿来验收。
 *
 * 这里照抄 `main.ts` 里玻璃分支的建窗参数：
 *   frame:false、**不透明**、backgroundColor '#101319'；
 * 页面自己铺 `.glass-backdrop`（主进程读壁纸文件）→ 面板 backdrop-filter 糊它。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/shot-glass-real.cjs \
 *     --watch ui-shots/_glass-real.log --until "GLASS SHOT DONE" --timeout 300
 *
 * 产物：ui-shots/glass-real-<route>.png，以及日志里的底图尺寸与 data URL 体积。
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, screen } = electronMain;
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_glass-real.log');

const say = (s) => {
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const ROUTE = arg('route', '');
const SHOT = arg('shot', 'glass-real');

/* 🔴 必须在 getSettings() 之前落盘：设置是懒加载 + 缓存，窗口一建就读盘 */
function seedSettings() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cur = {};
  }
  fs.writeFileSync(
    file,
    JSON.stringify(
      { ...cur, theme: 'glass', glassBackdrop: 'wallpaper', glassOpacity: 62, glassRoughness: 55 },
      null,
      2,
    ),
    'utf8',
  );
}

seedSettings();
fs.writeFileSync(LOG, '');

app.whenReady().then(async () => {
  const { registerIpc, setGlassWindowHook } = require(path.join(ROOT, 'dist-electron', 'electron', 'ipc.js'));
  registerIpc();

  /* 底图实际规格：这一行就是 B4 的核心指标，改分辨率策略后必须看它 */
  try {
    const { getWallpaperDataURL, backdropPixelSize } = require(
      path.join(ROOT, 'dist-electron', 'electron', 'services', 'wallpaper.js'),
    );
    /* 与 ipc.ts 同口径：窗口 CSS 尺寸 × scaleFactor = 物理像素 */
    const dpr = screen.getPrimaryDisplay().scaleFactor || 1;
    const css = { width: 1180, height: 820 };
    const phys = { width: Math.round(css.width * dpr), height: Math.round(css.height * dpr) };
    const px = backdropPixelSize(phys);
    say(`窗口 ${css.width}×${css.height}（dpr ${dpr}）→ 物理 ${phys.width}×${phys.height}`);
    say(`底图目标尺寸 ${px.width}×${px.height}`);
    const url = await getWallpaperDataURL(phys);
    if (url) {
      const kb = Math.round(url.length / 1024);
      const img = require('electron').nativeImage.createFromDataURL(url);
      const size = img.getSize();
      say(`底图 data URL ${kb}KB，解码后 ${size.width}×${size.height}`);
      say(`预估位图内存 ${Math.round((size.width * size.height * 4) / 1048576)}MB`);
    } else {
      say('底图 read 失败（将走整屏截图 / 纯色兜底）');
    }
  } catch (e) {
    say('底图规格探测失败：' + (e && e.message));
  }

  const work = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1180, work.width - 80);
  const h = Math.min(820, work.height - 80);

  const win = new BrowserWindow({
    width: w,
    height: h,
    useContentSize: true,
    x: Math.round((work.width - w) / 2),
    y: Math.round((work.height - h) / 2),
    show: true,
    /* 🔴 与 main.ts 玻璃分支一致：不透明 + 无边框 */
    frame: false,
    backgroundColor: '#101319',
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  setGlassWindowHook((on) => {
    try {
      win.setBackgroundColor(on ? '#101319' : '#f5f8fe');
    } catch {
      /* ignore */
    }
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  /* 首屏要读设置、抓壁纸、扫设备；玻璃底图是异步抓的，宁可多等 */
  await wait(6000);

  if (ROUTE) {
    await win.webContents.executeJavaScript(`window.location.hash = '#/${ROUTE}'; undefined;`);
    await wait(2500);
  }

  /* 断言底图真的铺上了（否则截到的是纯色，白验收） */
  const probe = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.glass-backdrop');
    if (!el) return { ok: false, why: 'no .glass-backdrop' };
    const cs = getComputedStyle(el);
    return {
      ok: true,
      hasImage: cs.backgroundImage !== 'none',
      len: (cs.backgroundImage || '').length,
      theme: document.documentElement.getAttribute('data-theme'),
      mainBlur: getComputedStyle(document.querySelector('.main') || document.body).backdropFilter,
    };
  })()`);
  say('底图探针：' + JSON.stringify(probe));
  if (!probe.ok || !probe.hasImage) say('FAIL 底图没铺上，截图不能用于验收');
  else say('PASS 底图已铺上（data URL 长度 ' + probe.len + '）');

  const img = await win.webContents.capturePage();
  const file = path.join(OUT, `${SHOT}.png`);
  fs.writeFileSync(file, img.toPNG());
  say(`captured ${file}  ${Math.round(img.toPNG().length / 1024)}KB`);
  if (errors.length) say('渲染层警告：' + errors.slice(0, 3).join(' | '));

  say('GLASS SHOT DONE');
  app.exit(0);
});
