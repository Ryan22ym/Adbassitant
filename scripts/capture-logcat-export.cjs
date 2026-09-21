/**
 * 抓「常用工具 → Logcat 导出」面板截图（生产构建 dist/）
 *
 *   python scripts/run-electron.py scripts/capture-logcat-export.cjs \
 *       --watch ui-shots/_logcat-export-ui.log --until "CAPTURE DONE" --timeout 300
 *
 * 顺带断言：tab 存在、切过去后面板出现（data-logcat-export=1）。
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_logcat-export-ui.log');
const log = (s) => fs.appendFileSync(LOG, s + '\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '=== CAPTURE LOGCAT EXPORT UI ===\n');
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
    },
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(3000);

  // 深色主题（与当前 IDE 一致）
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme','dark'); undefined;`,
  );
  await win.webContents.executeJavaScript(`window.location.hash = '#/tools'; undefined;`);
  await sleep(1800);

  // 找到并点击「Logcat 导出」tab
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const btns = Array.from(document.querySelectorAll('.tab'));
      const t = btns.find((b) => (b.textContent || '').includes('Logcat'));
      if (!t) return 'NOT_FOUND:' + btns.map(b=>b.textContent).join('|');
      t.click();
      return 'CLICKED';
    })();
  `);
  log('tab click: ' + clicked);
  // capturePage 会抓到合成前的旧帧，等久一点保证面板画出来
  await sleep(2600);

  const hasPanel = await win.webContents.executeJavaScript(
    `!!document.querySelector('[data-logcat-export="1"]')`,
  );
  log((hasPanel ? 'PASS' : 'FAIL') + '  面板出现  ::  data-logcat-export=' + hasPanel);

  const levelAttr = await win.webContents.executeJavaScript(`
    (() => { const e = document.querySelector('[data-logx-level]'); return e ? e.getAttribute('data-logx-level') : 'none'; })();
  `);
  log((levelAttr !== 'none' ? 'PASS' : 'FAIL') + '  级别选择器存在  ::  data-logx-level=' + levelAttr);

  // 导出目录行：必须渲染出来，且默认根是 D:\adblogs
  const dirInfo = await win.webContents.executeJavaScript(`
    (() => {
      const e = document.querySelector('[data-logx-dir]');
      if (!e) return null;
      return { text: (e.textContent || '').trim(), root: e.getAttribute('data-logx-root'), custom: e.getAttribute('data-logx-custom') };
    })();
  `);
  log(
    (dirInfo && dirInfo.text ? 'PASS' : 'FAIL') +
      '  导出目录行存在  ::  ' +
      (dirInfo ? JSON.stringify(dirInfo) : 'null'),
  );
  log(
    (dirInfo && /adblogs/i.test(dirInfo.root || '') ? 'PASS' : 'FAIL') +
      '  默认根目录 = D:\\\\adblogs  ::  root=' +
      (dirInfo ? dirInfo.root : 'n/a'),
  );
  // 目录文案：要么是已算出的完整路径（根\设备\日期），要么是等待设备的占位
  const looksResolved = !!dirInfo && dirInfo.text.includes(dirInfo.root) && dirInfo.text.length > dirInfo.root.length + 8;
  const isPlaceholder = !!dirInfo && dirInfo.text.includes('连接设备');
  log(
    (looksResolved || isPlaceholder ? 'PASS' : 'FAIL') +
      '  目录路径已计算/占位  ::  text=' +
      (dirInfo ? dirInfo.text : 'n/a'),
  );

  // 有「选择…」「恢复默认」两个按钮
  const btns = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('[data-logx-dir]');
      if (!row) return [];
      const host = row.closest('label') || row.parentElement;
      return Array.from(host ? host.querySelectorAll('button') : []).map((b) => (b.textContent || '').trim());
    })();
  `);
  log(
    (btns.includes('选择…') ? 'PASS' : 'FAIL') + '  有「选择…」按钮  ::  ' + JSON.stringify(btns),
  );

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'tools-logcat-export.png'), img.toPNG());
  log((img.toPNG().length > 10000 ? 'PASS' : 'FAIL') + '  截图落盘  ::  tools-logcat-export.png ' + img.toPNG().length + ' bytes');

  log('\nCAPTURE DONE');
  app.exit(0);
});
