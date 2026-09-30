import { app, BrowserWindow, nativeTheme, shell, Menu, nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { registerIpc } from './ipc';
import { cleanupLogs } from './services/logger';
import { listDevices, log, binDir } from './services/adb';
import { hasActiveWeakNetSession, recoverStaleSession, stopWeakNet } from './services/weaknet';
import { refreshShortcutIcons } from './services/shortcuts';
import { IPC, TITLEBAR_HEIGHT } from '../shared/types';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

/** 与 electron-builder.json 的 appId 一致；任务栏分组与通知归属都靠它 */
const APP_USER_MODEL_ID = 'com.xiaoyang.adbassistant';

/**
 * 窗口 / 任务栏图标：**运行期从文件读**，不用 exe 内嵌的那份。
 *
 * 因为在线更新只替换 app.asar 与 resources/bin、从不替换 exe ——
 * 靠 exe 的话，老用户更新上来图标永远还是旧的。
 * 这个 png 在 asar 里（electron/assets/app-icon.png，由 scripts/make-icon.py 生成），
 * 每次更新都会跟着换。桌面快捷方式的图标另见 services/shortcuts.ts。
 */
let cachedIcon: NativeImage | null | undefined;
function appIcon(): NativeImage | undefined {
  if (cachedIcon !== undefined) return cachedIcon ?? undefined;
  try {
    // 走 createFromBuffer 而不是 createFromPath：asar 内的路径没必要赌绑定层认不认
    const png = join(__dirname, '..', 'assets', 'app-icon.png');
    cachedIcon = existsSync(png) ? nativeImage.createFromBuffer(readFileSync(png)) : null;
  } catch {
    cachedIcon = null;
  }
  return cachedIcon ?? undefined;
}

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
  /*
   * 标题栏改成自绘（v1.1.3）。
   *
   * 起因：Windows 原生标题栏那条只会跟着系统深浅色，**不跟主题色** ——
   * 选了「雾青 / 远山」之后，顶上永远杵着一条灰色（或白色）带，和下面的界面断层。
   *
   * 做法：titleBarStyle:'hidden' + titleBarOverlay。系统标题栏让位，
   * 窗口控制按钮（最小化/最大化/关闭）变成右上角的 overlay，
   * 而顶部那一条由渲染层的 .titlebar 自己画（整宽一条 --bg-titlebar，内部无竖线）。
   * overlay 的底色**只能从主进程给**，所以渲染层读到 CSS 变量后通过
   * IPC.WINDOW_SET_TITLEBAR 回传（见 ipc.ts 与 App.tsx 里的同步 effect）。
   *
   * ⚠️ height 必须和 CSS 的 --titlebar-h 一致（都取 TITLEBAR_HEIGHT），
   *    否则系统按钮会和自绘色带错位。
   * 🔴 而且它**不能小于系统标题栏高度**，否则按钮退回系统高度、在右上角糊出台阶 ——
   *    约束与实测数字见 shared/types.ts 里 TITLEBAR_HEIGHT 的注释。真要做更薄，
   *    得放弃系统按钮、改成自绘（那时 titleBarOverlay 整个去掉）。
   */
  const dark = nativeTheme.shouldUseDarkColors;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'ADB 桌面助手',
    icon: appIcon(),
    // 首帧（页面还没画出来）的底色，尽量贴近默认主题色，避免闪一下别的颜色
    backgroundColor: dark ? '#161b28' : '#f5f8fe',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: dark ? '#161b28' : '#f5f8fe',
      symbolColor: dark ? '#e8ebf4' : '#1a1d29',
      height: TITLEBAR_HEIGHT,
    },
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

  /*
   * 任务栏图标 / 分组依赖 AppUserModelID，且必须在建窗口之前设好，
   * 否则 Windows 会把窗口归到 electron 默认的组里，任务栏图标也不受我们控制。
   */
  app.setAppUserModelId(APP_USER_MODEL_ID);

  /*
   * 刷新桌面 / 开始菜单 / 任务栏固定项的图标。
   * 同步执行、耗时只有几次文件读；放在建窗口前，避免窗口先出现时任务栏还挂着旧图标。
   * 内部已吞掉所有异常，不会影响启动。
   */
  try {
    refreshShortcutIcons(__dirname);
  } catch {
    /* 兜底：这个函数自己已经 try/catch 过，这里只是不让它有任何机会拖垮启动 */
  }

  /*
   * 运行日志只保留 24 小时：启动时清一次（删掉过期文件 + 裁掉文件内的过期行）。
   * 放在 registerIpc 之前，这样界面拿到的第一份日志里就带着清理记录。
   */
  try {
    const { removed } = cleanupLogs();
    if (removed.length) {
      log('info', '日志', `已清理 ${removed.length} 个超过 24 小时的日志文件`);
    }
  } catch {
    /* 清理失败不影响启动 */
  }

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

      // 弱网模拟会改动设备状态（全局代理 / 网络开关），若上次进程被强杀，
      // 这里按落盘的标记把设备恢复干净，避免用户遇到「手机莫名上不了网」。
      try {
        const msg = await recoverStaleSession();
        if (msg) log('warn', '弱网', msg);
      } catch (e) {
        log('warn', '弱网', `残留会话恢复失败：${(e as Error).message}`);
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

/**
 * 退出前先把弱网模拟恢复掉。
 *
 * 三种实现留下的东西不同，但都必须清：
 *   · 代理模式：设备上的代理设置 + reverse 通道 —— 不清会**持续断网**
 *   · 断网模式：关掉的 WiFi / 移动数据 —— 不清用户就一直没网
 *   · VPN 模式：设备上还开着的 tun —— 不清会一直走整形链路
 *     （设备侧有 15s 心跳超时兜底，但正常退出没理由让用户等那 15s）
 *
 * 这里阻塞一次退出，等清理完成再真正退出。
 */
let quitting = false;
app.on('will-quit', (e) => {
  if (quitting || !hasActiveWeakNetSession()) return;
  e.preventDefault();
  quitting = true;
  void stopWeakNet()
    .catch(() => undefined)
    .finally(() => app.quit());
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
