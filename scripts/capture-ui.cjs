/**
 * 加载生产构建的 dist/index.html，用 Electron capturePage 抓取各页面截图
 * 用法：electron scripts/capture-ui.cjs
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ['device', '#/'],
  ['mirror', '#/mirror'],
  ['tools', '#/tools'],
  ['command', '#/command'],
  ['logs', '#/logs'],
  ['settings', '#/settings'],
];

app.whenReady().then(async () => {
  // 注册真实 IPC，这样页面能拿到数据（设备列表、自检结果等）
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
  await win.loadFile(indexHtml);
  await new Promise((r) => setTimeout(r, 3000));

  for (const [name, hash] of ROUTES) {
    await win.webContents.executeJavaScript(
      `window.location.hash = ${JSON.stringify(hash)}; undefined;`,
    );
    await new Promise((r) => setTimeout(r, 1800));
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(path.join(OUT, name + '.png'), png);
    console.log('captured', name, png.length, 'bytes');
  }

  // 深色主题：回到设备页并切主题，等数据加载完再抓
  await win.webContents.executeJavaScript(
    `window.location.hash = '#/'; undefined;`,
  );
  await new Promise((r) => setTimeout(r, 1200));
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme','dark'); undefined;`,
  );
  await new Promise((r) => setTimeout(r, 2200));
  const dark = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'device-dark.png'), dark.toPNG());
  console.log('captured device-dark', dark.toPNG().length, 'bytes');

  app.exit(0);
});
