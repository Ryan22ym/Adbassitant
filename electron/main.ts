import { app, BrowserWindow, nativeTheme, shell, Menu } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { registerIpc } from './ipc';
import { listDevices, log, binDir } from './services/adb';
import { IPC } from '../shared/types';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

/* 单实例锁 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'ADB 桌面助手',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    const url = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5273';
    mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // __dirname 为 dist-electron/electron，需回退两级到项目根
    mainWindow.loadFile(join(__dirname, '..', '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  // 移除默认菜单（保持界面简洁）
  Menu.setApplicationMenu(null);

  registerIpc();
  createWindow();

  // 首屏之后做一次设备扫描，让 UI 快速有数据
  mainWindow?.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const ds = await listDevices(true);
        mainWindow?.webContents.send(IPC.PUSH_DEVICE_CHANGED, ds);
        log('info', '设备', ds.length ? `检测到 ${ds.length} 台设备` : '未检测到设备');
      } catch (e) {
        log('warn', '设备', `设备扫描失败：${(e as Error).message}`);
      }
    }, 300);
  });

  // 周期扫描设备变化
  setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const ds = await listDevices(false);
      mainWindow.webContents.send(IPC.PUSH_DEVICE_CHANGED, ds);
    } catch {
      /* ignore */
    }
  }, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* 确保用户数据目录存在 */
app.whenReady().then(() => {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

/* 未捕获异常兜底，避免进程静默退出 */
process.on('uncaughtException', (err) => {
  log('error', '系统', `未捕获异常：${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log('error', '系统', `未处理的 Promise 拒绝：${String(reason)}`);
});
