/**
 * 无头冒烟测试：在 Electron 中加载真实应用，验证
 * 1. 主进程能启动、preload 桥接正常
 * 2. 环境自检能找到 adb / scrcpy
 * 3. 渲染层能挂载并渲染出 DOM
 * 用法：electron scripts/smoke.cjs
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) {
  console.error('未运行在 Electron 主进程中，请用 electron.exe 启动本脚本');
  process.exit(2);
}
const { app, BrowserWindow } = electronMain;
const path = require('path');

// 以生产模式加载已构建产物
process.env.NODE_ENV = 'production';

const results = [];
function log(name, ok, extra) {
  results.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' :: ' + extra : ''}`);
}

app.whenReady().then(async () => {
  // 复用真实主进程
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  const adbSvc = require('../dist-electron/electron/services/adb.js');

  try {
    registerIpc();
    log('IPC 注册', true);
  } catch (e) {
    log('IPC 注册', false, e.message);
  }

  // 环境自检
  try {
    const { checkEnv } = require('../dist-electron/electron/env-check.js');
    const env = await checkEnv();
    for (const it of env.items) {
      log(`环境: ${it.name}`, it.ok, it.version ? 'v' + it.version : it.message || '');
    }
    log('环境自检总体', env.allOk);
  } catch (e) {
    log('环境自检', false, e.message);
  }

  // 设备枚举
  try {
    const devices = await adbSvc.listDevices(false);
    log('设备枚举', true, `发现 ${devices.length} 台: ${devices.map((d) => d.serial + '(' + d.state + ')').join(', ') || '无'}`);
  } catch (e) {
    log('设备枚举', false, e.message);
  }

  // 渲染层加载
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

  const errors = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    errors.push(`[L${level}] ${message} (${String(sourceId).split(/[\\/]/).pop()}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('渲染进程崩溃', false, JSON.stringify(details));
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log('preload 加载失败', false, `${preloadPath} :: ${error.message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('页面加载', false, `${code} ${desc}`);
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    log('页面加载', true);

    await new Promise((r) => setTimeout(r, 1500));

    // 探测渲染出的 DOM
    const probe = await win.webContents.executeJavaScript(`(() => {
      const q = (s) => !!document.querySelector(s);
      return {
        root: q('#root'),
        sidebar: q('.sidebar'),
        navItems: document.querySelectorAll('.nav-item').length,
        brand: document.querySelector('.brand-text strong')?.textContent || '',
        title: document.querySelector('.header-title')?.textContent || '',
        theme: document.documentElement.getAttribute('data-theme'),
        api: typeof window.adbApi === 'object' && window.adbApi !== null,
        apiMethods: window.adbApi ? Object.keys(window.adbApi).length : 0,
        bodyText: (document.body.innerText || '').slice(0, 200),
      };
    })()`);

    log('React 挂载', probe.root);
    log('侧边栏渲染', probe.sidebar, `导航项 ${probe.navItems} 个`);
    log('品牌标题', !!probe.brand, probe.brand);
    log('页面标题', !!probe.title, probe.title);
    log('主题属性', !!probe.theme, probe.theme);
    log('preload 桥接', probe.api, `${probe.apiMethods} 个方法`);

    // 在渲染层里实际调一次 IPC，验证端到端通路
    const ipcTest = await win.webContents.executeJavaScript(`
      window.adbApi.listDevices().then(r => ({ ok: r.ok, count: (r.data||[]).length, err: r.error }))
    `);
    log('渲染层→主进程 IPC', ipcTest.ok, `设备 ${ipcTest.count} 台${ipcTest.err ? ' err=' + ipcTest.err : ''}`);

    const envTest = await win.webContents.executeJavaScript(`
      window.adbApi.checkEnv().then(r => ({ ok: r.ok, allOk: r.data?.allOk, items: (r.data?.items||[]).length }))
    `);
    log('渲染层环境自检 IPC', envTest.ok, `allOk=${envTest.allOk}, ${envTest.items} 项`);

    if (errors.length) {
      errors.slice(0, 10).forEach((e) => log('控制台输出', false, e.slice(0, 300)));
    } else {
      log('控制台错误', true, '无');
    }
  } catch (e) {
    log('页面加载', false, e.message);
  }

  const failed = results.filter((r) => r.startsWith('[FAIL]')).length;
  console.log('\n========== 冒烟测试结果 ==========');
  console.log(results.join('\n'));
  console.log('==================================');
  console.log(`总计 ${results.length} 项，失败 ${failed} 项`);

  app.exit(failed > 0 ? 1 : 0);
});
