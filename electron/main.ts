import { app, BrowserWindow, nativeTheme, shell, Menu, nativeImage, Tray } from 'electron';
import type { NativeImage } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { registerIpc, setSettingsChangedHook, setGlassWindowHook } from './ipc';
import { cleanupLogs } from './services/logger';
import { listDevices, log, binDir } from './services/adb';
import { startMirror } from './services/mirror';
import { stopWakeWatch } from './services/wake-window';
import { getSettings } from './services/settings';
import { getUiConf, resolveUiConfDir } from './services/ui-conf';
import { pickAutoConnectTarget } from './services/auto-connect';
import { hasActiveWeakNetSession, recoverStaleSession, stopWeakNet } from './services/weaknet';
import { shutdownCrashWatch, syncCrashWatch } from './services/crash';
import { refreshShortcutIcons } from './services/shortcuts';
import { syncAutoLaunch } from './services/auto-launch';
import { syncGlassCorners, resetGlassCornerCache } from './services/win-corners';
import {
  centeredDefaultBounds,
  savedWindowState,
  trackWindowState,
} from './services/window-state';
import { IPC, TITLEBAR_HEIGHT } from '../shared/types';
import { MIRROR_DEFAULTS } from '../shared/mirror-defaults';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
/*
 * 当前窗口的「形态」：建窗时是不是按玻璃主题建的（frame:false，无系统按钮）。
 *
 * 🔴 frame / titleBarOverlay 都是 **建窗参数**，运行期改不回去 ——
 *    所以「玻璃 ↔ 普通主题」跨越形态时，唯一正确的做法是**按新形态重建窗口**
 *    （见 applyGlassWindow）。这个标记就是用来判断「这次 setGlass 是否跨形态」。
 */
let windowFormGlass = false;
/* 上一次跨形态重建窗口的时刻（保险丝用，见 recreateWindowForGlassForm） */
let lastGlassRecreateAt = 0;

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

/**
 * 启动时是否直接以「透明玻璃」形态建窗。
 *
 * 读的是上次落盘的设置 —— 用户上次选了玻璃主题，这次就该直接以玻璃形态出现，
 * 而不是先建一个不透明窗口再切换（那会先闪一下深色底）。
 * 读设置失败时按 false（普通窗口），启动不能因为这个挂掉。
 */
function startInGlass(): boolean {
  try {
    return getSettings().theme === 'glass';
  } catch {
    return false;
  }
}

/**
 * 运行期切换「透明玻璃」窗口形态（v1.1.13，2026-10-13 修正为「模拟玻璃」）。
 *
 * 🔴🔴 为什么不再用 Acrylic（这一版的关键决定）：
 *    原本的计划是 `backgroundMaterial:'acrylic'` 让**真实桌面**透上来并被系统磨砂，
 *    这是最理想的形态。但两条实测把它否掉了：
 *      ① Electron 在 **Windows 10 上根本不渲染 Acrylic** —— 它内部调的是 Win11 的
 *         `DwmSetWindowAttribute` 系接口，没有回落到 Win10 的
 *         `SetWindowCompositionAttribute`（上游 issue #48440，报告环境就是
 *         Win10 22H2 build 19045，与本机一致）。表现：窗口透明了，但**零模糊**。
 *      ② 一旦 `transparent:true`，CSS 的 `backdrop-filter` 也**一起失效** ——
 *         它只能模糊「页面内、自己背后的像素」，而透明窗口背后在页面看来是空的。
 *      ⇒ 结果就是「两套模糊全死、壁纸原样清晰」，滑杆怎么拖都没反应。
 *
 * 现在的做法 = **模拟玻璃**：
 *    · 窗口**不透明**（transparent:false），但保留 `frame:false` 无边框 +
 *      渲染层自绘交通灯（外观不变）。
 *    · 页面最底层铺一张 `.glass-backdrop` —— 内容是主进程抓来的**真实桌面截图**
 *      （IPC.WINDOW_GRAB_DESKTOP）。壁纸仍是用户自己的桌面，不是编造的。
 *    · 面板的 `backdrop-filter` 背后终于有实底 ⇒ **模糊滑杆真正生效**。
 *    · 跨 Win10 / Win11 表现一致，不依赖任何系统级私有接口。
 *
 * 🔴🔴 跨形态切换 = 重建窗口（v1.1.14 修复「玻璃切回其它主题后右上角按钮消失」）：
 *    玻璃主题建窗用 `frame:false`（无系统按钮，渲染层画圆点），普通主题用
 *    `titleBarStyle:'hidden' + titleBarOverlay`（系统按钮）。这两套都是
 *    **建窗参数**：frame 运行期改不回去，而 `setTitleBarOverlay` 在没开
 *    overlay 的窗口上必然抛错（被下面的 catch 吞掉）—— 旧版本退出玻璃后
 *    系统按钮就永远消失了，只能重启（重启按新主题建窗，按钮才回来）。
 *    反方向（普通 → 玻璃）还有个隐藏 bug：系统 overlay 按钮还在，和自绘
 *    圆点**同时出现**两套。⇒ 只要「这次要的形态 ≠ 建窗形态」，直接按新形态
 *    重建窗口（保留位置与最大化状态），两个方向的 bug 一起根治。
 *
 * ⚠️ 同形态内（玻璃 → 玻璃、普通 → 普通）只动窗口底色，不重建 ——
 *    主题色之间的切换仍然是平滑的，没有窗口闪动。
 *
 * 🔴 托盘 / 投屏子窗口不受影响：本函数只动 mainWindow。
 */
function applyGlassWindow(on: boolean): void {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  /* 跨形态：玻璃形态的窗口给不了 overlay 按钮，普通形态的窗口给不了
   * frame:false —— 两边都救不回来，只能按新形态重建。 */
  if (on !== windowFormGlass) {
    recreateWindowForGlassForm(on);
    return;
  }
  try {
    if (on) {
      /*
       * 玻璃主题：窗口保持不透明，底色给一个中性深色 —— 它会被页面里的
       * .glass-backdrop 完全盖住，只在「壁纸还没抓回来」的短暂瞬间露一下。
       * 用深色而不是白色：首帧闪白比闪深色刺眼得多。
       */
      w.setBackgroundColor('#101319');
    } else {
      // 退出玻璃：换回不透明的主题底色（与建窗时的首帧色一致）
      const dark = nativeTheme.shouldUseDarkColors;
      w.setBackgroundColor(dark ? '#161b28' : '#f5f8fe');
    }
  } catch {
    /* 系统不支持时静默跳过：界面 CSS 那层玻璃照样在 */
  }
  /*
   * 圆角区域跟着一起切（v1.1.13）。
   * 🔴 必须在这里调：玻璃主题是**唯一**无边框的主题，也就只有它需要
   *    用 SetWindowRgn 补圆角（roundedCorners 在 Windows 上不生效，见 win-corners.ts）。
   *    退出玻璃主题时传 false → 清掉区域，让系统边框窗口自己管。
   */
  syncGlassCorners(w, on);
}

/**
 * 按**新的玻璃形态**重建主窗口（v1.1.14）。
 *
 * 只在「玻璃 ↔ 普通主题」跨越窗口形态时调用（见 applyGlassWindow）：
 * frame / titleBarOverlay 是建窗参数，改不回去，只能拆了重盖。
 *
 * 做法：**先**按新形态建好新窗口（拿到旧窗口的位置与最大化状态），
 * **再** destroy 旧窗口 —— 中间不留「没有窗口」的空档。
 * ⚠️ 必须用 `destroy()` 而不是 `close()`：旧窗口挂着「关窗收进托盘」的
 *    close 拦截（见 createWindow 里那段），close() 会被 preventDefault 变成
 *    藏进托盘，旧窗口永远关不掉、还一直占着资源。
 * 🔴 新窗口加载后会自己读设置、走一遍主题初始化（包括再调一次 setGlass），
 *    那时形态已经一致，不会再触发重建 —— 不会死循环。
 */
function recreateWindowForGlassForm(on: boolean): void {
  const old = mainWindow;
  if (!old || old.isDestroyed()) return;
  /*
   * 🔴 保险丝：正常生命周期里最多只该发生一次（切主题那次）。
   *    如果渲染层有 bug 反复调 setGlass 且值在跳，这里会变成「建了拆、拆了建」
   *    的闪窗死循环 —— 1.5 秒内的第二次重建直接拒绝，宁可形态不对也别转圈。
   */
  const now = Date.now();
  if (now - lastGlassRecreateAt < 1500) {
    log('warn', '窗口', '玻璃形态重建过于频繁，本次已忽略（疑似渲染层反复 setGlass）');
    return;
  }
  lastGlassRecreateAt = now;
  const maximized = old.isMaximized();
  const bounds = maximized ? undefined : old.getBounds();
  createWindow({ glass: on, bounds, maximized });
  /* 让触发本次重建的 IPC 先返回（发送方还是旧窗口的渲染进程），下一拍再拆旧窗口 */
  setTimeout(() => {
    if (!old.isDestroyed()) old.destroy();
  }, 0);
}

function createWindow(restore?: { glass: boolean; bounds?: Electron.Rectangle; maximized?: boolean }) {
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
   *
   * 🔴 玻璃主题下走的是**另一套**（见下面的 glass 分支）：无系统边框、无 overlay，
   *    窗口按钮由渲染层自绘成 macOS 三色圆点。两套不能同时存在。
   */
  const dark = nativeTheme.shouldUseDarkColors;
  /*
   * 透明玻璃主题（v1.1.13）：窗口创建时就得按它来。
   *
   * 🔴 为什么透明/无边框必须在**创建时**定，而不能事后改：
   *    `transparent` 是窗口创建参数，`setBackgroundMaterial` 也要求窗口本来就是
   *    透明+无边框的（否则系统不给画 Acrylic）。所以启动时先读一次设置：
   *    如果上次退出时是玻璃主题，这次就直接以玻璃形态建窗，避免先闪一下不透明窗口。
   *
   * 退出玻璃主题时（运行时切换）反向操作：frame/transparent 这些创建参数**改不回去**，
   * 只能靠 setBackgroundMaterial('none') + setBackgroundColor(不透明) 把观感拉回来，
   * 并让渲染层不再设 roundedCorners（见 applyGlassWindow 的注释）。
   */
  const glass = restore ? restore.glass : startInGlass();

  /*
   * 窗口尺寸与位置（v1.1.16「记录窗口大小」）。
   *
   * 三级来源，优先级从高到低：
   *   ① restore（跨玻璃形态重建）：沿用**旧窗口那一刻**的 bounds —— 用户正在看这个窗口，
   *      尺寸不能因为「换主题」而变；
   *   ② settings.json 里的记录（services/window-state.ts）：正常启动路径；
   *   ③ 居中的出厂尺寸 1280×860：新装、关过开关、记录被判失效（屏幕变了）时。
   *
   * 🔴 bounds 必须展开在**建窗参数**里，不能建完再 setBounds ——
   *    后者会先按出厂尺寸画一帧再跳，观感上窗口会抽一下。
   * 🔴 最大化状态另存（maximized），在 ready-to-show 里补一刀，
   *    见下面那个 handler 的注释。
   */
  const restored = restore
    ? { bounds: restore.bounds, maximized: !!restore.maximized }
    : savedWindowState();
  const startBounds = restored.bounds ?? centeredDefaultBounds();

  mainWindow = new BrowserWindow({
    ...startBounds,
    minWidth: 960,
    minHeight: 640,
    title: 'ADB 桌面助手',
    icon: appIcon(),
    // 首帧（页面还没画出来）的底色，尽量贴近默认主题色，避免闪一下别的颜色。
    backgroundColor: glass ? '#101319' : dark ? '#161b28' : '#f5f8fe',
    /*
     * 玻璃主题：**无边框**，但**不再透明**（2026-10-13 修正为「模拟玻璃」）。
     *
     * 🔴 为什么去掉 transparent + backgroundMaterial:'acrylic'：
     *    ① Electron 在 Windows 10 上不渲染 Acrylic（上游 #48440，用的 Win11 API，
     *       没有 Win10 回落）→ 透明了但零模糊；
     *    ② 而 transparent:true 会让 CSS 的 backdrop-filter 一起失效
     *       （页面背后是空的，没东西可采样）→ 两套模糊全死。
     *    现在改成：窗口不透明，页面自己用 .glass-backdrop 铺一张真实桌面截图，
     *    面板的 backdrop-filter 糊它 —— 跨 Win10/Win11 稳定生效。
     *
     * ⚠️ 保留 frame:false：玻璃主题仍要渲染层自绘交通灯（见 App.tsx 的 window-lights）。
     *
     * 🔴🔴 圆角**不能靠 roundedCorners**（2026-10-13 修正）：
     *    `roundedCorners: true` 是 **macOS only** 的参数，Windows 上完全无效 ——
     *    无边框窗口在 Win10 上就是方角。Win11 有 DWM 圆角可用，但本机是 Win10。
     *    ⇒ 圆角必须用 Win32 的 SetWindowRgn 自己裁（见 services/win-corners.ts），
     *      由下面「建窗后」那段统一设置 + 跟随 resize / 最大化重设。
     *      这里刻意**不写 roundedCorners** —— 留着它只会让人以为 Windows 上也生效。
     */
    ...(glass
      ? {
          frame: false,
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: dark ? '#161b28' : '#f5f8fe',
            symbolColor: dark ? '#e8ebf4' : '#1a1d29',
            height: TITLEBAR_HEIGHT,
          },
        }),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  /*
   * ⚠️ 这里原本有一句「玻璃主题下把窗口背景设成全透明」
   *    （`setBackgroundColor('#00000000')`），它是给系统 Acrylic 铺路的。
   *    2026-10-13 改成「模拟玻璃」后**必须删掉**：窗口要保持不透明，
   *    背景透明会重新把页面下方暴露成空，backdrop-filter 又会失效。
   */

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    /*
     * 上次退出时是最大化 → 这次也最大化。
     * 为什么要等到 ready-to-show：最大化必须在窗口**显示之后**做才稳
     * （隐藏窗口上调 maximize 在 Windows 上偶发不生效，回来还是个普通窗）。
     * bounds 这时已经被建窗参数设成「还原后的大小」，所以用户点还原能回到上次的尺寸。
     */
    if (restored.maximized) mainWindow?.maximize();
  });

  /*
   * 玻璃主题的窗口圆角（v1.1.13）。
   *
   * 🔴 为什么要在建窗后单独设一次、还要盯着几个事件：
   *    SetWindowRgn 设的是**那一刻**的窗口区域，它**不会**跟着窗口尺寸自动更新 ——
   *    窗口一变大，新长出来的那块区域就是方的（圆角消失，下边两角变直角）。
   *    所以要在这几个时刻重设：
   *      · 建窗后（首次）
   *      · 最大化 / 还原 / 进全屏 —— 而且**最大化时必须清掉区域**，
   *        否则最大化后四角仍被裁，会露出桌面，像窗口缺了四个角
   *      · resize：`resize` 用 debounce（一次拖动触发几十次），
   *        再补一个 `resized`（Electron 在**尺寸真正改变后**才发）兜底。
   *
   * ⚠️ 用建窗时读到的 glass（局部变量）而不是再调 startInGlass()：
   *    那个函数每次都要读一遍 settings.json，而 resize 每秒能触发几十次。
   *
   * 🔴🔴 「下边两角仍是直角」的根因复盘（2026-10-13 第二次反馈）：
   *    一开始事件挂得很全，但 win-corners.ts 里的去重 key **只含半径和窗口 id**
   *    （`r15/${id}`）—— 用户把窗口拉大后，resize → syncGlassCorners →
   *    key 与上次相同 ⇒ **直接被跳过**，region 还是拉大前的小尺寸。
   *    ⇒ 修法是让 key 带上窗口尺寸（见 win-corners.ts），这里的事件只是触发器。
   *
   * 🔴 「边界一直卡在这里」的根因复盘（2026-10-13 第三次反馈）：
   *    key 带上尺寸还不够 —— win-corners 里 `execFile('powershell.exe')` 是**异步**的，
   *    拖边框时几十个 PowerShell 并发跑、**完成顺序乱**，最后落地的是中间尺寸，
   *    而 lastKey 已是最新 ⇒ 永不重设。⇒ 修法是串行队列（见 win-corners.ts）。
   *
   * 🔴🔴 为什么还必须监听 `move`（2026-10-13 实测发现）：
   *    `SetWindowRgn` 设的区域**并非在所有情况下都稳**—— 实测把运行中的窗口
   *    单独 `SetWindowPos` 挪个位置（尺寸不变）之后，`GetWindowRgn` 读回来是
   *    **type=0（区域整个没了）**，四角瞬间变方。
   *    原因不明（可能是 Chromium/Electron 在移动时重建了 native window），
   *    但现象是稳定的 ⇒ 这里加 `move` 兜底重设。
   *    ⚠️ `move` 在拖动窗口时也每秒几十次，所以同样 debounce；
   *    而且 key 不含位置（region 用的是**窗口相对坐标**，移动不需要重设），
   *    所以正常情况下 move 会被 key 去重直接跳过，只有像上面这种
   *    「区域真的丢了」的情况才会因为 key 被 reset 而真正重设。
   */
  const syncCorners = () => syncGlassCorners(mainWindow, glass);
  syncCorners();

  let cornerTimer: NodeJS.Timeout | null = null;
  const debouncedSync = () => {
    if (cornerTimer) clearTimeout(cornerTimer);
    cornerTimer = setTimeout(syncCorners, 120);
  };
  mainWindow.on('resize', debouncedSync);
  /* `resized` 在尺寸真正定下来后触发，作为 debounce 的第二道保险 */
  mainWindow.on('resized', syncCorners);
  /* 🔴 移动后区域可能整个丢失（实测 type=0），必须**强制**重设。
   *    强制 = 清掉去重 key；因为 region 用窗口相对坐标、尺寸没变，
   *    不清 key 的话 syncGlassCorners 会认为「没变化」直接跳过。 */
  mainWindow.on('move', () => {
    resetGlassCornerCache();
    debouncedSync();
  });
  mainWindow.on('maximize', syncCorners);
  mainWindow.on('unmaximize', syncCorners);
  mainWindow.on('enter-full-screen', syncCorners);
  mainWindow.on('leave-full-screen', syncCorners);
  mainWindow.on('restore', syncCorners);

  /*
   * 「插入自动投屏」开启时，关闭窗口 = 收进托盘，而不是退出。
   *
   * 这是该功能能成立的前提：进程一退就没人监听 USB 插入了，
   * 所谓「插上手机自动打开」根本无从发生。所以这是一次**有代价的行为交换**，
   * 代价（关窗不退出）在设置页的说明里写明了，用户开了开关就等于接受它。
   *
   * 开关关着时这里直接放行 —— 行为与 v1.1.8 完全一致（关窗即退出）。
   */
  /*
   * 🔴 下面两个 handler 必须**捕获本窗口实例**（win），不能引用模块级 mainWindow：
   *    跨玻璃形态切换会先建新窗口（mainWindow 已指向新窗口）再销毁旧窗口 ——
   *    旧窗口的 closed 若无条件 `mainWindow = null`，会把**新窗口**的引用清掉，
   *    后面 bringToFront / syncTray 全部失灵。
   */
  const win = mainWindow;
  mainWindow.on('close', (e) => {
    if (appQuitting || !trayEnabled()) return;
    e.preventDefault();
    win.hide();
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
    /* 只有当挂掉的确实是「当前窗口」才清引用（重建场景下挂的是旧窗口） */
    if (mainWindow === win) mainWindow = null;
    /*
     * 🔴 圆角缓存是模块级单例，窗口换了（退出重进 / macOS 的 activate 重建）
     *    必须清掉，否则新窗口沿用旧 key，圆角会被「跳过设置」而消失。
     */
    resetGlassCornerCache();
  });

  // 记录本窗口的形态（玻璃 ↔ 普通的运行期切换靠它判断要不要重建）
  windowFormGlass = glass;

  /*
   * 记录窗口大小（v1.1.16）：拖动结束 / 最大化状态变化时存盘，下次启动按这个尺寸打开。
   *
   * 挂的是**本窗口实例**（win），不是模块级 mainWindow：跨玻璃形态重建时
   * mainWindow 已指向新窗口，旧窗口的事件如果还去操作新窗口的记录会把值写歪。
   * 旧窗口是 destroy() 退出、不发 close，所以也不会在拆掉时抢存一次。
   */
  trackWindowState(win);

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

  /*
   * 界面配置（Conf/*.json）启动时读一次并预热缓存。
   *
   * 放在 registerIpc 之后、建窗口之前：渲染层一挂载就会来取，
   * 这里先读一次能把「配置目录在哪 / 哪份文件没读进来」写进运行日志 ——
   * 用户找不到 Conf 文件夹时，日志里那一行就是答案。
   */
  try {
    const conf = getUiConf();
    log(
      'info',
      '配置',
      `界面配置目录：${resolveUiConfDir()}（导航 ${conf.layout.sidebar.order.length} 项，` +
        `工具标签 ${conf.layout.toolTabs.order.length} 项）`,
    );
  } catch (e) {
    log('warn', '配置', `界面配置读取异常，已按出厂默认运行：${(e as Error).message}`);
  }

  // 设置一变就同步托盘：开关就是「程序要不要常驻」的开关，必须立刻生效
  setSettingsChangedHook(() => {
    syncTray();
    /*
     * 崩溃自动分析（v1.1.14）跟着同一个钩子走。
     * 它不另开一条「设置监听」：设置落盘的唯一出口就是 ipc.ts 的 SETTINGS_SET，
     * 而那个出口只调这一个钩子 —— 两处各监听一次必然有一处会漏。
     * 监听器内部自己判断「开关开没开 + 投屏在不在跑」，这里无脑调即可（幂等）。
     */
    syncCrashWatch();
  });

  /*
   * 玻璃主题的窗口切换钩子（v1.1.13）：渲染层点了「透明玻璃」就切整窗 Acrylic。
   * 注入而不是让 ipc.ts import main.ts，避免循环依赖（同 setSettingsChangedHook）。
   */
  setGlassWindowHook(applyGlassWindow);

  createWindow();

  // 开机时开关可能已经是开的（上次开过），托盘要在窗口出现之前就位
  syncTray();
  /* 崩溃监听器同样对齐一次（此时投屏没跑，等价于「不监听」，幂等） */
  syncCrashWatch();

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
  /* 崩溃监听器的自愈节拍：每 5 次设备扫描（约 10 秒）对齐一次 */
  let healTick = 0;
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

      /*
       * 崩溃监听器的自愈（v1.1.14）。
       *
       * 正常路径下它由「投屏状态推送 / 设置变化」驱动，但有两种情况会让它悄悄停摆：
       *   · 设备掉线导致 logcat 子进程退出（watch 被清空，但投屏状态没变，不会再有推送）；
       *   · 投屏进程被外部强杀，状态推送没来得及发出。
       * 这类「监听器死了但没人知道」的静默失效最难查 —— 用户以为在守着，
       * 实际崩溃了什么都没发生。所以定期无脑对齐一次（幂等，代价是一次布尔判断）。
       */
      healTick += 1;
      if (healTick >= 5) {
        healTick = 0;
        syncCrashWatch();
      }
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
  /* 崩溃监听挂着一条 adb logcat 子进程，退出时收干净（否则它会变成孤儿进程） */
  shutdownCrashWatch();
  /* 投屏窗口的鼠标钩子同理：拆掉，别留一个进程在后台吃全局鼠标事件 */
  stopWakeWatch();
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
