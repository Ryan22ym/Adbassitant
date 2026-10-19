/**
 * 透明玻璃主题截图（v1.1.13）
 *
 * 与 capture-ui.cjs 的两个关键区别：
 *
 * 1) **必须显示真窗口**。
 *    Acrylic / 透明是**系统合成**出来的 —— 隐藏窗口（show:false）不参与桌面合成，
 *    capturePage 抓到的会是一片黑或纯底色，完全看不出玻璃效果。
 *    所以这里 show:true，让它真的出现在桌面上再截。
 *
 * 2) **必须让应用以「玻璃主题」启动**，而不能事后改 DOM。
 *    只改 `document.documentElement` 的 data-theme 是没用的：React 的 store 里
 *    theme 仍是 light，凡是读 store 的地方（自绘交通灯的条件渲染、
 *    设置页分段控件的选中态）都不会跟着变，看起来就是「主题没生效」。
 *    ✅ 正确做法：往 userData 里预置一份 settings.json，主题写 glass ——
 *       应用启动读设置时自动进玻璃形态，走的是**和真实用户完全一样**的路径。
 *
 * 用法：python scripts/run-electron.py scripts/capture-glass.cjs \
 *         --watch ui-shots/_glass.log --until "GLASS CAPTURE DONE" --timeout 300
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, screen } = electronMain;
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 预置设置：把 theme 写成 glass，两个参数按调用方给的档位。
 * 🔴 必须在 app.whenReady() **之前**写 —— getSettings() 是懒加载 + 缓存，
 *    窗口一建就读盘，晚一步写就来不及了。
 */
function seedSettings(opacity, roughness) {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try {
    if (fs.existsSync(file)) cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cur = {};
  }
  fs.writeFileSync(
    file,
    JSON.stringify(
      { ...cur, theme: 'glass', glassOpacity: opacity, glassRoughness: roughness },
      null,
      2,
    ),
  );
}

// 先从参数取档位，在 ready 之前落盘。
// 🔴 参数走 `--key=value` 的 argv 而不是环境变量：Git Bash（MSYS）会把
//    环境变量里以 `/` 开头的内容当成路径改写成 Windows 路径 ——
//    `GLASS_HASH='#/'` 传进来变成了 `#C:/Users/.../PortableGit/`，
//    页面直接 404 白屏。argv 不做这种改写（见 run-electron.py 的 -- 透传）。
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const OP = Number(arg('op', 62));
const ROUGH = Number(arg('rough', 55));
const SHOT = arg('shot', 'glass-device');
/*
 * 🔴 路由用「路由名」而不是 `#/xxx` 字面量传参。
 *    Git Bash（MSYS）会在命令行解析阶段就把以 `/` 开头的裸参数改写成
 *    Windows 路径（`#/` → `#C:/Users/.../PortableGit/`），在它到达
 *    Python / Node 之前就已经坏了 —— 用引号也挡不住这种 path conversion。
 *    所以这里收 route 名，自己拼 `#/`，从根上避开那个斜杠。
 */
const ROUTE = arg('route', '');
const HASH = ROUTE ? `#/${ROUTE}` : '#/';
seedSettings(OP, ROUGH);

app.whenReady().then(async () => {
  const { registerIpc, setGlassWindowHook } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const work = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1180, work.width - 80);
  const h = Math.min(820, work.height - 80);

  /*
   * 🔴 窗口尺寸与内容必须**严丝合缝**，否则四角/边缘会露出没被裁切的部分，
   *    在截图里就是一圈黑色直角 —— 因为窗口是透明的，没被 app-shell 圆角
   *    盖住的地方就是「透到桌面」，capturePage 抓不到桌面，只能抓到黑。
   *    所以这里用 useContentSize + 精确高度，并在页面里断言 shell 撑满。
   */
  const win = new BrowserWindow({
    width: w,
    height: h,
    useContentSize: true,
    x: Math.round((work.width - w) / 2),
    y: Math.round((work.height - h) / 2),
    show: true,
    // 与主进程 createWindow 的玻璃分支保持一致
    transparent: true,
    frame: false,
    roundedCorners: true,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  setGlassWindowHook((on) => {
    try {
      win.setBackgroundMaterial(on ? 'acrylic' : 'none');
      win.setBackgroundColor(on ? '#00000000' : '#f5f8fe');
    } catch {}
  });

  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  // 首屏要拉设置、扫设备、跑自检，给足时间再截（否则抓到骨架屏）
  await wait(4500);

  await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(HASH)}; undefined;`);
  await wait(2500);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, SHOT + '.png'), img.toPNG());
  console.log(`captured ${SHOT} (opacity=${OP} roughness=${ROUGH} hash=${HASH})`, img.toPNG().length, 'bytes');

  console.log('GLASS CAPTURE DONE');
  app.exit(0);
});
