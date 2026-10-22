import { BrowserWindow, screen } from 'electron';
import { getSettings, saveSettings } from './settings';
import type { WindowBoundsState } from '../../shared/types';

/**
 * 记录窗口大小与位置（v1.1.16）。
 *
 * 需求很朴素：拖过窗口、下次打开还是那个大小。但有几个地方容易做歪，都写在这里：
 *
 * ① **必须在建窗时就把 bounds 交出去**，不能建完再 setBounds ——
 *    后者会先闪一下出厂尺寸再跳过去，观感像窗口抽了一下。
 *    所以对外的主要入口是 savedWindowState()，由 main.ts 的 createWindow 展开进参数。
 *
 * ② **最大化时存的是「还原尺寸」**，来自 `getNormalBounds()`（不是 getBounds）。
 *    用 getBounds 的话，最大化退出时记下的是一整屏，下次还原就变成一整屏的窗口，
 *    用户上次特意调小的那个尺寸永久丢失。
 *
 * ③ **读到记录必须先校验可见性**：显示器拔了、分辨率改小了、笔记本换了外接屏，
 *    保存的坐标都可能落在屏幕外。判断标准不是「完整可见」，而是
 *    「还露出够大的一块、能把它拖回来」（见 MIN_VISIBLE_*）——
 *    要求完整可见的话，用户稍微把窗口拖出屏幕边缘一点点，记录就整个失效了。
 *
 * ④ 写盘用 debounce：拖动窗口时 Windows 会连续发 resize/move。
 *    这里只监听 `resized` / `moved`（尺寸与位置**真正定下来**之后才发），
 *    再叠一层 400ms 的 debounce 兜住极端情况（程序化 setBounds 也会触发这两个事件）。
 */

/** 出厂尺寸 —— 与 v1.1.15 及以前一致（1280×860），别改，用户的肌肉记忆和截图基线都在这 */
export const WINDOW_DEFAULT_WIDTH = 1280;
export const WINDOW_DEFAULT_HEIGHT = 860;

/** 最小尺寸 —— 与 main.ts 建窗时的 minWidth/minHeight 保持一致 */
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

/**
 * 记录值至少要露出这么大的矩形才算「还在屏幕上」（DIP）。
 * 横向要够宽到能看见标题栏并按住，纵向只要露出一条边就够拖回来。
 */
const MIN_VISIBLE_W = 160;
const MIN_VISIBLE_H = 48;

/** 位置/尺寸是否为有限数字（settings.json 是手改得动的文本，脏数据不能让窗口建不出来） */
function sane(b: WindowBoundsState): boolean {
  return [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n));
}

/** 这块矩形是否还有足够部分落在某个显示器的可用区域内 */
function visibleOnSomeDisplay(b: WindowBoundsState): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const overlapX = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const overlapY = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return overlapX >= MIN_VISIBLE_W && overlapY >= MIN_VISIBLE_H;
  });
}

/** 出厂尺寸 + 居中（主显示器可用区域内） */
export function centeredDefaultBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const a = screen.getPrimaryDisplay().workArea;
  /* 屏幕比出厂尺寸还小时（小笔记本 / 高缩放）不能硬塞，按可用区收窄 */
  const width = Math.max(MIN_WIDTH, Math.min(WINDOW_DEFAULT_WIDTH, a.width));
  const height = Math.max(MIN_HEIGHT, Math.min(WINDOW_DEFAULT_HEIGHT, a.height));
  return {
    x: Math.round(a.x + (a.width - width) / 2),
    y: Math.round(a.y + (a.height - height) / 2),
    width,
    height,
  };
}

/**
 * 建窗时该用的尺寸与状态。
 *
 * 返回 `bounds` 为空 = 没有可用记录（关过开关 / 从没记录过 / 记录已失效），
 * 此时调用方用 centeredDefaultBounds() 给一个居中的出厂尺寸。
 *
 * ⚠️ 只有 `rememberWindowBounds` 开着才读记录。关掉开关时**不清**已存的值 ——
 *    用户可能只是临时试一下关闭的效果，重新打开还要能回到原来的大小。
 */
export function savedWindowState(): {
  bounds?: { x: number; y: number; width: number; height: number };
  maximized: boolean;
} {
  const s = getSettings();
  if (!s.rememberWindowBounds) return { maximized: false };

  const b = s.windowBounds;
  if (!b || !sane(b)) return { maximized: false };
  if (b.width < MIN_WIDTH || b.height < MIN_HEIGHT) return { maximized: false };
  if (!visibleOnSomeDisplay(b)) return { maximized: false };

  return {
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    maximized: !!b.maximized,
  };
}

/**
 * 「看起来没变」的容差（DIP）。
 *
 * 🔴🔴 这个常量不是随手给的，是 2026-10-22 实测出来的（check-window-state 的 A7/A8
 *     + 安装版脚本 _verify-winstate-installed.py）：
 *    · 脚本里的普通 frame 窗口：`setBounds({height:860})` → 读回 **862**，`y` 少 1；
 *    · 真实主窗口（titleBarStyle:'hidden' + overlay）：出厂 1280×860 实际是 **1280×864**，
 *      摆到 1100×700 后 `getNormalBounds()` 记成 **1101×700**，按这份记录重开又是 **1105×702**
 *      —— 宽度一路 +4。
 *    原因是 DWM 那圈不可见的 resize 边框/阴影：**写进去的是可见矩形、读回来带着边框**，
 *    无边框形态下相差更多。
 *
 *    危害不是「差 4px 不好看」，而是**每次启动都会长大 4px**：
 *    记 860 → 实际 864 → 下次按 864 开 → 读回 868 → …
 *    几十次启动后窗口明显变大，用户根本查不出哪来的。
 *
 *    ⇒ 修法：新旧记录差在容差内、且最大化状态没变，就当「没动过」跳过写盘。
 *      记录值锚在用户真正设定的那个数上，不会被边框误差带跑。
 *
 *    ⚠️ 取 **8** 而不是 4：真机实测到的最大偏差就是 4（1101→1105），
 *       贴着边界写等于没余量 —— 换个显示器 / 系统缩放档位就可能顶出去重新累积。
 *       8px 人眼分辨不出，又远小于任何有意为之的尺寸调整（没人会把窗口调小 8px 就为这个）。
 */
const PX_TOLERANCE = 8;

/**
 * 尺寸/位置是否在容差内（不看最大化标记）。
 *
 * 配合上面的 PX_TOLERANCE 用：`nearState()` 为真就说明「用户没动过这个窗口」，
 * 此时唯一还可能变的就是最大化标记 —— 见 commit 里的处理。
 */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= PX_TOLERANCE;
}

function nearState(prev: WindowBoundsState, next: WindowBoundsState): boolean {
  return (
    near(prev.x, next.x) &&
    near(prev.y, next.y) &&
    near(prev.width, next.width) &&
    near(prev.height, next.height)
  );
}

/**
 * 订阅某个窗口的尺寸变化并落盘。
 *
 * 只对**主窗口**挂一次（main.ts 的 createWindow 末尾）。玻璃主题跨形态重建时，
 * 旧窗口走的是 destroy()（不发 close），不会被这里抢存一次把新窗口的记录写歪。
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;

  const commit = () => {
    timer = null;
    if (win.isDestroyed()) return;
    if (getSettings().rememberWindowBounds !== true) return;

    /*
     * 最小化 / 全屏时不记：这两种状态下的 bounds 不是「用户摆好的窗口」。
     * （全屏退出后的尺寸 Electron 会还原，不需要我们掺和。）
     */
    if (win.isMinimized() || win.isFullScreen()) return;

    const nb = win.getNormalBounds();
    const next: WindowBoundsState = {
      x: nb.x,
      y: nb.y,
      width: nb.width,
      height: nb.height,
      maximized: win.isMaximized(),
    };
    if (!sane(next)) return;

    /*
     * 🔴 用容差判，不用逐字相等 —— 理由见 PX_TOLERANCE 的注释（边框误差会导致
     *    每次启动长 2px）。两种「在容差内」的情况分开处理：
     *      · 最大化标记也没变 → 真没动，什么都不写；
     *      · 只有最大化标记变了 → 只翻标记，**尺寸/位置沿用旧记录**，
     *        否则「最大化 → 还原」会把 862 那种实际值写进去，又破了那条修法。
     */
    const prev = getSettings().windowBounds;
    if (prev && nearState(prev, next)) {
      if (prev.maximized === next.maximized) return;
      saveSettings({ windowBounds: { ...prev, maximized: next.maximized } });
      return;
    }

    /*
     * 直接写 settings.json（不经过 IPC 的 SETTINGS_SET），所以不会触发
     * 设置变更钩子里的托盘/崩溃监听同步 —— 那些跟窗口尺寸无关，没必要跟着跑。
     */
    saveSettings({ windowBounds: next });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    /* 400ms：拖动结束时 Windows 会连发 resized + moved，等它们都到齐再写一次 */
    timer = setTimeout(commit, 400);
  };

  /*
   * 四个事件都挂上：
   *   · `resize` / `move` —— 拖动过程中持续触发，靠 debounce 合并成「停手后写一次」；
   *   · `resized` / `moved` —— 尺寸/位置**定下来**之后各发一次，是兜底。
   *
   * 🔴 不能只挂后两个：`resized` 是 Windows 在拖动结束（WM_EXITSIZEMOVE）时给的，
   *    **程序化 setBounds 不一定发**（「恢复默认尺寸」按钮走的就是这条路）。
   *    只靠它的话，按钮点了、窗口也变了，记录却没更新 —— 下次启动又弹回旧尺寸。
   *    四个一起挂不会多写盘：debounce 把它们全合并成一次。
   */
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('resized', schedule);
  win.on('moved', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('enter-full-screen', schedule);
  win.on('leave-full-screen', schedule);
  /*
   * 退出前抢存一次：用户可能刚拖完窗口就点关闭，400ms 的 debounce 还没到期。
   * 「关窗收进托盘」也会走这里，但那时窗口只是隐藏、尺寸仍然有效，写盘无害。
   */
  win.on('close', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    commit();
  });
}

/**
 * 恢复出厂尺寸（设置页的「恢复默认尺寸」按钮）。
 *
 * 先退出最大化/全屏再 setBounds —— 最大化状态下调 setBounds 是不生效的
 * （窗口尺寸由系统管着），必须让窗口先回到普通状态。
 */
export function resetWindowSize(win: BrowserWindow): WindowBoundsState {
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  const b = centeredDefaultBounds();
  win.setBounds(b);
  const next: WindowBoundsState = { ...b, maximized: false };
  saveSettings({ windowBounds: next });
  return next;
}

/** 设置页展示用：当前实际尺寸 + 上次记录值 */
export function windowStateSnapshot(win: BrowserWindow | null): {
  current: { width: number; height: number; maximized: boolean } | null;
  saved: WindowBoundsState | null;
} {
  const saved = getSettings().windowBounds;
  if (!win || win.isDestroyed()) return { current: null, saved };
  const b = win.getNormalBounds();
  return {
    current: { width: b.width, height: b.height, maximized: win.isMaximized() },
    saved,
  };
}
