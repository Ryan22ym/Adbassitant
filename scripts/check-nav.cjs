/**
 * 侧栏高亮校验：每个路由用「直接加载」方式打开，避免 hash 注入导致的时序假象。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_navcheck.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const CASES = [
  ['#/', '设备'],
  ['#/mirror', '投屏'],
  ['#/tools', '常用工具'],
  ['#/apps', '应用管理'],
  ['#/logcat', '实时 Logcat'],
  ['#/weaknet', '弱网模拟'],
  ['#/command', '命令终端'],
  ['#/logs', '运行日志'],
  ['#/settings', '设置'],
];

app.whenReady().then(async () => {
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

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

  const rows = [];
  const file = path.join(ROOT, 'dist', 'index.html');

  for (const [hash, expect] of CASES) {
    await win.loadFile(file, { hash: hash.replace('#', '') });
    await new Promise((r) => setTimeout(r, 900));

    const info = await win.webContents.executeJavaScript(`
      (() => {
        const title = document.querySelector('.header-title')?.textContent || '';
        const active = [...document.querySelectorAll('.nav-item.active .nav-label')]
          .map(e => e.textContent);
        const count = document.querySelectorAll('.nav-item.active').length;
        return { title, active, count };
      })()
    `);

    const ok = info.title === expect && info.active.length === 1 && info.active[0] === expect;
    rows.push(`${ok ? 'PASS' : 'FAIL'}  ${hash.padEnd(11)} 标题="${info.title}" 高亮=${JSON.stringify(info.active)}`);
  }

  log('=== NAV CHECK ===');
  for (const r of rows) log(r);
  if (errors.length) {
    log('=== ERRORS ===');
    for (const e of errors) log(e);
  } else log('渲染层无错误');

  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
