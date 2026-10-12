import { app, BrowserWindow, nativeTheme, shell, Menu, nativeImage, Tray } from 'electron';
import type { NativeImage } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { registerIpc, setSettingsChangedHook } from './ipc';
import { cleanupLogs } from './services/logger';
import { listDevices, log, binDir } from './services/adb';
import { startMirror } from './services/mirror';
import { getSettings } from './services/settings';
import { pickAutoConnectTarget } from './services/auto-connect';
import { hasActiveWeakNetSession, recoverStaleSession, stopWeakNet } from './services/weaknet';
import { refreshShortcutIcons } from './services/shortcuts';
import { syncAutoLaunch } from './services/auto-launch';
import { IPC, TITLEBAR_HEIGHT } from '../shared/types';
import { MIRROR_DEFAULTS } from '../shared/mirror-defaults';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

/** 托盘图标：只在「插入自动投屏」开着的时候存在，见 trayEnabled() */
let tray: Tray | null = null;
/** 「已收进托盘」的气泡只提示一次，免得每次关窗都弹 */
let trayHintShown = false;
/** 应用是否正在退出 —— 退出流程中不能再把 close 拦成「收进托盘」 */
let appQuitting = false;

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

/* ------------------------------------------------------------------ */
/* 插入自动投屏（v1.1.9）：托盘 + 前台唤起                             */
/* ------------------------------------------------------------------ */

/**
 * 托盘只在「插入自动投屏」开启时存在。
 *
 * 这样开关没开的用户**完全感知不到程序多了一个托盘图标** —— 关闭窗口照旧退出，
 * 与以前一模一样。开了开关的用户等于接受了一个交换：程序常驻后台，
 * 换取「插上手机就自动打开并投屏」。
 */
function trayEnabled(): boolean {
  return !!getSettings().autoMirrorOnConnect;
}

/**
 * 把主窗口带到前台。
 *
 * ⚠️ Windows 有前台锁（Foreground Lock）：后台进程直接调 SetForegroundWindow
 * 会被系统**静默拒绝**，现象是「任务栏闪一下、窗口不弹出来」。
 * Electron 的 show() + focus() 走的正是这条链路，所以**不保证成功**。
 *
 * 实测成功率最高的组合是「临时置顶再撤掉」：置顶期间窗口必然可见，
 * 800ms 后撤掉，用户不会觉得有个窗口莫名其妙压在别人上面。
 * 若还是没抢到前台也不做更多挣扎 —— 托盘气泡已经给过提示了，够用。
 */
function bringToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 800);
}

function buildTray() {
  if (tray) return;
  try {
    tray = new Tray(appIcon() ?? nativeImage.createEmpty());
  } catch (e) {
    log('warn', '系统', `托盘创建失败：${(e as Error).message}`);
    return;
  }
  tray.setToolTip('ADB 桌面助手');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => bringToFront() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          appQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => bringToFront());
  log('info', '系统', '已启用托盘常驻（插入自动投屏开启期间）');
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
  trayHintShown = false;
  log('info', '系统', '已退出托盘常驻');
}

/** 供回归脚本查询托盘是否存在（Tray 没有全局枚举 API，只能自己暴露一个） */
export function isTrayActive(): boolean {
  return !!tray;
}

/**
 * 设置变化后调用，让托盘状态跟上开关。由 ipc.ts 的 settingsChangedHook 触发。
 * 导出是为了能被 check-auto-mirror-tray.cjs 直接驱动（不必绕一圈去点界面）。
 */
export function syncTray() {
  if (trayEnabled()) {
    buildTray();
    return;
  }
  const wasHidden = !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible();
  destroyTray();
  // 开关关掉的瞬间如果窗口正被藏在托盘里，得把它放出来，否则用户找不到程序了
  if (wasHidden) mainWindow?.show();
}

/**
 * 「插入自动投屏」真正动手的地方：先把助手唤到前台，再起投屏。
 *
 * 顺序是先窗口后投屏 —— scrcpy 会自己抢焦点，于是最终停在用户眼前的是投屏窗口，
 * 这正是他要的；助手窗口在下面等着，切回去就能用。
 *
 * ⚠️ 全程静默失败：投屏起不来只记日志，不弹对话框。用户此刻多半不在电脑前，
 * 弹一个「投屏失败」只会在他回来时添乱（而且失败原因通常就是设备又被拔了）。
 */
async function fireAutoConnect(device: { serial: string; model?: string }) {
  const label = device.model ? `${device.model}（${device.serial}）` : device.serial;
  log('info', '投屏', `检测到 ${label} 插入，自动打开助手并开始投屏`);
  bringToFront();
  try {
    await startMirror({ serial: device.serial, ...MIRROR_DEFAULTS });
  } catch (e) {
    log('warn', '投屏', `自动投屏未启动：${(e as Error).message}`);
  }
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

  /*
   * 「插入自动投屏」开启时，关闭窗口 = 收进托盘，而不是退出。
   *
   * 这是该功能能成立的前提：进程一退就没人监听 USB 插入了，
   * 所谓「插上手机自动打开」根本无从发生。所以这是一次**有代价的行为交换**，
   * 代价（关窗不退出）在设置页的说明里写明了，用户开了开关就等于接受它。
   *
   * 开关关着时这里直接放行 —— 行为与 v1.1.8 完全一致（关窗即退出）。
   */
  mainWindow.on('close', (e) => {
    if (appQuitting || !trayEnabled()) return;
    e.preventDefault();
    mainWindow?.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      try {
        tray.displayBalloon({
          title: 'ADB 助手仍在后台运行',
          content: '插入手机将自动打开并投屏。双击托盘图标可重新打开窗口。',
        });
      } catch {
        /* 系统不支持气泡通知时忽略：托盘图标本身还在，用户能自己找到 */
      }
    }
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
   * 按设置对齐开机自启动项（v1.1.7）。
   * 幂等：开启就重写一遍注册表路径（重装换过目录的老条目靠这一步修回来），
   * 关闭就删掉那条。内部吞掉所有异常，不影响启动。
   */
  try {
    const on = syncAutoLaunch();
    log('info', '系统', `开机自启动：${on ? '已开启' : '未开启'}`);
  } catch {
    /* 对齐失败不影响启动 */
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

  // 设置一变就同步托盘：开关就是「程序要不要常驻」的开关，必须立刻生效
  setSettingsChangedHook(() => syncTray());

  createWindow();

  // 开机时开关可能已经是开的（上次开过），托盘要在窗口出现之前就位
  syncTray();

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

  /*
   * 周期扫描设备变化 —— 同时是「插入自动投屏」的触发源（v1.1.9）。
   *
   * 相比 v1.1.8 的两处调整：
   *   · 不再以「窗口存在」为前提。收进托盘时窗口只是 hide（对象还在），
   *     这条其实照跑；但去掉这个前置判断，语义上也就不会和托盘状态耦合。
   *   · 间隔 5s → 2s。插上线最多等 2 秒就弹投屏，体感差别很明显。
   *     `adb devices -l` 是本地 adb server 调用，开销毫秒级，2 秒一次可以忽略；
   *     加 in-flight 保护，避免 adb 卡住时请求越堆越多。
   */
  let scanning = false;
  setInterval(async () => {
    if (scanning) return;
    scanning = true;
    try {
      const ds = await listDevices(false);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.PUSH_DEVICE_CHANGED, ds);
      }
      const target = pickAutoConnectTarget(ds);
      if (target) await fireAutoConnect(target);
    } catch {
      /* ignore */
    } finally {
      scanning = false;
    }
  }, 2000);

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
/*
 * 标记「正在退出」。
 *
 * 窗口的 close 拦截（见 createWindow）靠它放行，否则「退出」会被自己拦成「收进托盘」，
 * 程序永远退不掉。刻意用 before-quit 而不是复用下面 will-quit 的 `quitting` ——
 * 那个是弱网清理的哨兵，要到更晚才会置位，而 close 在它之前就发生了。
 */
app.on('before-quit', () => {
  appQuitting = true;
});

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
