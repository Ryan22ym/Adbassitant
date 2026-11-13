/*
 * 投屏启动期间的「正在投屏」浮窗（v1.1.23）。
 *
 * 🔴 它解决的问题：scrcpy 的窗口要等**画面真的上屏**才放出来（见 mirror.ts 的
 *    「藏到首帧」与 mirror-signal.ts），设备忙的时候这一步能拖到 5~8 秒。这段空档里
 *    屏幕上什么都不出现，用户会以为点了没反应 —— 之前为了"不空档"提前放窗口，
 *    结果露出的是 scrcpy 的黑色空壳（正是小杨截图那个界面）。
 *    现在两边都要：空档期由这个自己画的小窗顶着，画面一到它就让位。
 *
 * 🔴 三条硬约束（和 mirror-bar 同一套道理，踩过的坑别再踩）：
 *   ① `focusable: false` + `showInactive()`：绝不能抢焦点，否则会把手机里正在输的
 *      IME 断掉。
 *   ② `setIgnoreMouseEvents(true)`：它只是一块提示牌，不许吃掉底下的点击。
 *   ③ 透明窗口**不要写 backdrop-filter**：背后是桌面，采样不到东西，只有假模糊。
 *
 * ⚠️ 尺寸用 DIP、位置用 DIP：`screen.getDisplayNearestPoint` 吃的是 DIP 坐标，
 *    不要自己乘 scaleFactor（多显示器混合缩放会错位）。
 */

import { app, BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { log } from './adb';

/** 小窗尺寸（DIP）：够放一个转圈 + 四个字，别做成一整块遮罩 */
const SPLASH_W = 236;
const SPLASH_H = 76;
/**
 * 保险绳：万一 reveal 因为任何原因没回调过来（进程卡死、日志措辞变了），
 * 这个窗也不能永远挂在屏幕上。正常路径 3~4s 就收掉了，8s 兜底放窗（见 mirror.ts），
 * 这里取 12s 纯粹是最后一道保险。
 */
const SPLASH_MAX_MS = 12000;

let splash: BrowserWindow | null = null;
let guard: NodeJS.Timeout | null = null;

function clearGuard() {
  if (guard) {
    clearTimeout(guard);
    guard = null;
  }
}

/** 小窗摆在「鼠标所在显示器」的中央（用户刚在那一屏点的投屏） */
function centeredBounds() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  return {
    x: Math.round(x + (width - SPLASH_W) / 2),
    y: Math.round(y + (height - SPLASH_H) / 2),
    width: SPLASH_W,
    height: SPLASH_H,
  };
}

/**
 * 显示「正在投屏」。
 *
 * 幂等：已经显示着就只刷新保险绳，不重复建窗（重复投屏调用不会闪两下）。
 * 任何异常都自己吞掉 —— 它只是个提示牌，坏了也不能影响投屏。
 */
export function showMirrorSplash(): void {
  try {
    clearGuard();
    guard = setTimeout(hideMirrorSplash, SPLASH_MAX_MS);

    if (splash && !splash.isDestroyed()) {
      if (!splash.isVisible()) splash.showInactive();
      return;
    }

    const win = new BrowserWindow({
      ...centeredBounds(),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      webPreferences: {
        preload: join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setIgnoreMouseEvents(true);

    // 加载同一份 bundle，只换 hash（分流见 src/main.tsx）
    const useDevServer = !app.isPackaged && process.env.NODE_ENV === 'development';
    if (useDevServer) {
      const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5273';
      void win.loadURL(`${devUrl}#/mirror-splash`);
    } else {
      // __dirname = dist-electron/electron/services → 回退三级到项目根/dist
      void win.loadFile(join(__dirname, '..', '..', '..', 'dist', 'index.html'), {
        hash: '/mirror-splash',
      });
    }

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    /*
     * 🔴 用 ready-to-show 再 showInactive：透明窗口在首帧前 show 会先闪一块白，
     *    这个窗的存在感必须比黑窗还低，不能反过来自己闪一下。
     */
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      log('info', '投屏', '等待首帧：已显示「正在投屏」提示');
    });

    splash = win;
  } catch (e) {
    log('warn', '投屏', `「正在投屏」提示显示失败（不影响投屏）：${(e as Error).message}`);
  }
}

/** 收掉提示牌（画面已上屏 / 投屏结束 / 启动失败）。可重复调用。 */export function hideMirrorSplash(): void {
  clearGuard();
  const win = splash;
  splash = null;
  if (!win) return;
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* ignore */
  }
}

/**
 * 这个 BrowserWindow 是不是「正在投屏」提示牌。
 *
 * 🔴 ipc.ts 的 `win()`（找主窗口）必须把它一起排除：它和功能栏一样是额外的小窗，
 *    `getAllWindows()` 里排在前面时，最小化 / 最大化 / 标题栏配色 / 窗口尺寸查询
 *    会打到这块 236×76 的牌子上（这个坑功能栏已经踩过一次）。
 */
export function isMirrorSplashWindow(w: BrowserWindow): boolean {
  return !!splash && !splash.isDestroyed() && splash.id === w.id;
}
