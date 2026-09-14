/**
 * v1.0 界面验证：启动应用并依次截图三个新页面
 * 用法：electron scripts/capture-v1-pages.cjs
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const LOG = path.join(OUT, '_capture.log');
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) {
  log('FATAL 未在 Electron 运行时中执行, typeof=' + typeof electronMain);
  process.exit(2);
}
const { app, BrowserWindow } = electronMain;

const ROUTES = [
  ['apps', '#/apps'],
  ['logcat', '#/logcat'],
  ['weaknet', '#/weaknet'],
];

const EXPECT = {
  apps: '应用管理',
  logcat: '实时 Logcat',
  weaknet: '弱网模拟',
};

app.whenReady().then(async () => {
  log('=== start, electron ' + process.versions.electron + ' ===');
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();
  log('registerIpc done');

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const report = [];

  for (const [name, hash] of ROUTES) {
    await win.webContents.executeJavaScript(
      `window.location.hash = ${JSON.stringify(hash)}; undefined;`,
    );
    await new Promise((r) => setTimeout(r, 1600));

    const info = await win.webContents.executeJavaScript(`
      (() => {
        const t = document.querySelector('.header-title')?.textContent || '';
        const nav = document.querySelectorAll('.sidebar-nav .nav-item').length;
        const cards = document.querySelectorAll('.page-inner .card').length;
        const activeNav = document.querySelector('.nav-item.active .nav-label')?.textContent || '';
        return { t, nav, cards, activeNav, hasApi: typeof window.adbApi === 'object' };
      })()
    `);

    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(path.join(OUT, `v1-${name}.png`), png);

    const ok = info.t === EXPECT[name];
    report.push(
      `${ok ? 'PASS' : 'FAIL'}  ${hash} 标题="${info.t}" 侧栏高亮="${info.activeNav}" 卡片=${info.cards} api=${info.hasApi} 截图=${png.length}B`,
    );
    log('SHOT', name, png.length);
  }

  log('===== v1.0 PAGE CHECK =====');
  for (const r of report) log(r);

  if (errors.length) {
    log('===== RENDERER ERRORS =====');
    for (const e of errors) log(e);
  } else {
    log('渲染层无错误');
  }

  const failed = report.some((r) => r.startsWith('FAIL'));
  app.exit(failed || errors.length ? 1 : 0);
});
