/*
 * 投屏窗口的悬浮功能栏 + pin（v1.1.22）。
 *
 * 需求（小杨 2026-11-04）：
 *   ① 投屏窗口右侧挂一条功能栏，第一个按钮是 pin —— 钉住后投屏窗口压在所有
 *      窗口之上、位置与大小都锁死；再点一次解除并**恢复原状**；
 *   ② 预留以后接别的功能（这一版不做，代码里留插槽）；
 *   ③ 断连 / 下次投屏要记住 pin 状态与位置尺寸，**按机型分开记**；
 *   ④ 横屏、竖屏**各记一份**；
 *   ⑤ 默认开，设置页能单独关（关掉 = 解除 pin + 清空全部记录）；
 *   ⑥ 功能栏只在**拖动投屏窗口时**或**鼠标靠近**时出现，静置后自己淡出。
 *   ⑦ 第二个按钮：一键开关手机飞行模式（v1.1.28）—— 点一次开，再点一次关。
 *      开着时按钮点亮，状态每 6s 从手机读一次（用户也可能在手机上手动改）。
 *
 * 🔴 为什么要单开一个 Electron 窗口：scrcpy 是别的进程的窗口，HTML 画不进去。
 *    功能栏只能是「一个透明无边框小窗，贴在它右边的空白处，跟着它走」。
 *    窗口的位置来自 services/mirror-win.ts 的 Win32 代理（30ms 上报一次）。
 *
 * 🔴 三个必须踩对的点：
 *   ① **坐标单位**：代理给的是**物理像素**，BrowserWindow 要 **DIP**。
 *      全程用 screen.screenToDipPoint 换算，不要自己乘除 scaleFactor ——
 *      多显示器混合缩放时按主屏算必然错位。
 *   ② **窗口不能抢焦点**：focusable:false。抢一下焦点，用户正在手机里打字的
 *      输入就会被断掉，这条比好看重要得多。
 *   ③ **隐藏时同时做两件事**：setOpacity(0) + setIgnoreMouseEvents(true)。
 *      只做透明度的话，一条看不见的条子会吃掉窗口右边那一片的鼠标点击。
 *
 * 🔴 只支持 Windows（Win32 代理是 PowerShell + user32）。非 Windows 直接整个不工作，
 *    投屏本身不受影响。
 */

import { app, BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { log, runAdb } from './adb';
import { getSettings, saveSettings } from './settings';
import {
  onMirrorWinState,
  pinMirrorWin,
  pinMirrorWinHere,
  startMirrorWin,
  stopMirrorWin,
  unpinMirrorWin,
  isMirrorWinReady,
} from './mirror-win';
import type { MirrorWinRect } from './mirror-win';
import type {
  MirrorBarState,
  MirrorOrientation,
  MirrorPinRecord,
  MirrorPinRecordMap,
} from '../../shared/types';

/** 功能栏宽度（DIP）—— 44 的按钮 + 两侧各 6 的留白 */
const BAR_WIDTH_DIP = 56;
/**
 * 每个功能按钮占的高度（DIP）。
 * 现在两项：pin（下）+ 飞行模式（上），窗口高度和竖排布局自动跟着 BAR_SLOTS 走。
 * 以后再加别的功能：只改 BAR_SLOTS，窗口高度、CSS 的 gap 都不用动
 * （`.mbar` 是 flex column + justify-center，多一个按钮就往下排一格）。
 */
const BAR_SLOT_DIP = 56;
const BAR_SLOTS = 2;
const BAR_HEIGHT_DIP = BAR_SLOT_DIP * BAR_SLOTS;

/** 飞行模式状态的轮询间隔（ms）—— 用户可能在手机上手动改，按钮得跟上 */
const AIRPLANE_POLL_MS = 6000;

/** 拖动/鼠标靠近之后，功能栏再停留这么久（ms）才淡出 */
const REVEAL_MS = 1400;
/** 跟随轮询间隔（ms）：只做显隐判断，位置由代理的状态推送驱动 */
const TICK_MS = 60;
/** pin 期间窗口几何变化的落盘防抖（ms） */
const SAVE_DEBOUNCE_MS = 700;

let barWin: BrowserWindow | null = null;
/** 当前代理盯着的 scrcpy pid（0 = 没挂） */
let agentPid = 0;
let serial = '';
/** 机型（ro.product.model）；拿不到时退化成 serial 当 key */
let model: string | null = null;
let pinned = false;
let orientation: MirrorOrientation | null = null;
let lastRect: MirrorWinRect | null = null;
/** 投屏窗口当前是否真的显示着（隐藏期间不要去 pin，见 maybeApplyRecord） */
let lastVisible = false;
/** 手机当前飞行模式状态（按钮点亮态；真值以手机读回来的为准） */
let airplane = false;
/** 切换飞行模式时禁止并发（连点两下会互相打架） */
let airplaneBusy = false;
let airplaneTimer: NodeJS.Timeout | null = null;
/** 上一次「该露脸」的时刻：拖动窗口、鼠标靠近、点按钮都会刷新它 */
let revealedAt = 0;
/** 功能栏当前是不是可见（避免每 tick 都调 setOpacity） */
let barVisible = false;
/** 功能栏窗口当前有没有被我们设成置顶（跟 pinned 同步，见 syncTopmost） */
let barTopmost = false;
/** 本次投屏已经「自动露过一次脸」——只露这一次，用来告诉用户这里有东西 */
let revealedOnce = false;

let offState: (() => void) | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let saveTimer: NodeJS.Timeout | null = null;
/** 本次投屏里「已经处理过」的方向（恢复成功 / 记录不可用 / 放弃重试） */
const restored = new Set<string>();
/** 恢复时因为尺寸还没定而失败的次数（scrcpy 首帧前是占位尺寸，会自己变一次） */
const restoreTries = new Map<string, number>();
/** 恢复记录最多重试多少次：尺寸一直对不上就说明分辨率变了，别一直试 */
const RESTORE_MAX_TRIES = 20;

const listeners = new Set<(s: MirrorBarState) => void>();

/* ------------------------------------------------------------------ */
/* 对外状态                                                            */
/* ------------------------------------------------------------------ */

export function onMirrorBarChange(cb: (s: MirrorBarState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emitChange() {
  const s = getMirrorBarState();
  for (const cb of listeners) {
    try {
      cb(s);
    } catch {
      /* 监听方出错不影响主流程 */
    }
  }
}

export function getMirrorBarState(): MirrorBarState {
  return {
    enabled: !!getSettings().mirrorBarEnabled,
    running: agentPid > 0,
    pinned,
    orientation,
    model,
    serial: serial || null,
    airplane,
  };
}

/** 这个窗口是不是功能栏自己的窗口（ipc.ts 的 win() 必须把它排除掉） */
export function isMirrorBarWindow(w: BrowserWindow): boolean {
  return !!barWin && !barWin.isDestroyed() && w === barWin;
}

/* ------------------------------------------------------------------ */
/* 记录（按机型 + 方向）                                               */
/* ------------------------------------------------------------------ */

function keyOf(modelName: string | null, o: MirrorOrientation | null): string | null {
  if (!o) return null;
  const who = (modelName || serial || '').trim();
  if (!who) return null;
  return `${who}#${o}`;
}

function records(): MirrorPinRecordMap {
  const m = getSettings().mirrorPinRecords;
  return m && typeof m === 'object' ? m : {};
}

function recordFor(o: MirrorOrientation | null): MirrorPinRecord | null {
  const k = keyOf(model, o);
  if (!k) return null;
  const r = records()[k];
  return r && typeof r === 'object' ? r : null;
}

/** 一条记录是否还能用（尺寸合理 + 至少有一部分落在某块屏幕上） */
function usable(r: MirrorPinRecord): boolean {
  if (![r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))) return false;
  if (r.width < 200 || r.height < 200) return false;
  // 记录是物理像素，显示器 bounds 是 DIP —— 用 dipToScreenPoint 反推
  return screen.getAllDisplays().some((d) => {
    const p = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
    const scale = d.scaleFactor || 1;
    const w = d.bounds.width * scale;
    const h = d.bounds.height * scale;
    const ox = Math.min(r.x + r.width, p.x + w) - Math.max(r.x, p.x);
    const oy = Math.min(r.y + r.height, p.y + h) - Math.max(r.y, p.y);
    return ox >= 120 && oy >= 120;
  });
}

function saveRecord(
  rect: MirrorWinRect | null,
  isPinned: boolean,
  /* 显式指定方向：旋转那一刻要写的是**旧**方向，不能读全局 orientation */
  ori: MirrorOrientation | null = orientation,
) {
  if (!rect) return;
  const k = keyOf(model, ori);
  if (!k) return;
  const map: MirrorPinRecordMap = { ...records() };
  map[k] = {
    pinned: isPinned,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    at: Date.now(),
  };
  saveSettings({ mirrorPinRecords: map });
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (pinned) saveRecord(lastRect, true);
  }, SAVE_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ */
/* 功能栏窗口                                                          */
/* ------------------------------------------------------------------ */

function ensureWindow(): BrowserWindow | null {
  if (barWin && !barWin.isDestroyed()) return barWin;
  if (process.platform !== 'win32') return null;

  const win = new BrowserWindow({
    width: BAR_WIDTH_DIP,
    height: BAR_HEIGHT_DIP,
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
    /*
     * 🔴 不抢焦点：否则点一下 pin 就把手机里的输入法/键盘焦点抢走，
     *    用户正在投屏里打字时会直接断掉。
     */
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setIgnoreMouseEvents(true);
  win.setOpacity(0);

  /*
   * 🔴 建窗时**不置顶**（v1.1.23）。原来这里写的是 setAlwaysOnTop(true)，
   *    结果没 pin 的时候这条悬浮栏也压在所有应用上面 —— 别的窗口从旁边过
   *    都被它挡一块，像是程序粘在了最上层。层级改由 syncTopmost 跟着 pin 走。
   */
  barTopmost = false;
  win.setAlwaysOnTop(false);

  /*
   * 加载同一份前端 bundle，只换 hash（见 src/main.tsx 的分流）。
   *
   * ⚠️ 只有 `npm run dev`（dev:electron 会带 NODE_ENV=development）才连 dev server；
   *    回归脚本是 `electron scripts/xxx.cjs` 直接起服务的，那时 isPackaged 也是 false
   *    但没有 dev server —— 按 isPackaged 判断会加载一个空白的 localhost，
   *    功能栏永远显示不出来（这个坑在主窗口那里也存在，只是主窗口有 dist 兜底需求）。
   */
  const useDevServer = !app.isPackaged && process.env.NODE_ENV === 'development';
  if (useDevServer) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5273';
    void win.loadURL(`${devUrl}#/mirror-bar`);
  } else {
    // __dirname = dist-electron/electron/services → 回退三级到项目根/dist
    void win.loadFile(join(__dirname, '..', '..', '..', 'dist', 'index.html'), {
      hash: '/mirror-bar',
    });
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  barWin = win;
  barVisible = false;
  return win;
}

function destroyWindow() {
  if (!barWin) return;
  const w = barWin;
  barWin = null;
  barVisible = false;
  try {
    if (!w.isDestroyed()) w.destroy();
  } catch {
    /* ignore */
  }
}

/** 把功能栏贴到投屏窗口右侧（垂直居中），全程 DIP */
function placeWindow(rect: MirrorWinRect) {
  const win = ensureWindow();
  if (!win) return;

  // 物理像素 → DIP：按「该点所在显示器」的缩放换算，别用主屏的
  const origin = screen.screenToDipPoint
    ? screen.screenToDipPoint({ x: rect.x, y: rect.y })
    : { x: rect.x, y: rect.y };

  const display = screen.getDisplayNearestPoint(origin);
  const scale = display.scaleFactor || 1;
  const widthDip = rect.width / scale;
  const heightDip = rect.height / scale;

  const barH = Math.min(
    BAR_HEIGHT_DIP,
    Math.max(44, Math.round(heightDip - 16)),
  );

  const x = Math.round(origin.x + widthDip);
  const y = Math.round(origin.y + Math.max(0, (heightDip - barH) / 2));

  const cur = win.getBounds();
  if (cur.x === x && cur.y === y && cur.width === BAR_WIDTH_DIP && cur.height === barH) return;
  win.setBounds({ x, y, width: BAR_WIDTH_DIP, height: barH }, false);
}

/**
 * 功能栏窗口的置顶层级跟着 pin 走（v1.1.23）。
 *
 * 语义要求和投屏窗口一致：
 *   · 未 pin：普通窗口层级 —— 别的应用盖上来它就跟着沉到下面，
 *     pin 按钮不会浮在别人的窗口上；
 *   · pin 住：跟投屏窗口一起浮到最上层，不然被盖住就点不到了。
 *
 * 调用点：每 60ms 的 tick（兜底，覆盖「代理上报 pinned 变化」等异步路径）、
 * pinned 每次真正变化的地方（状态立刻跟上，不用等下一拍）。
 * 内部比对上次结果，重复调用等于空转，不会每帧都去调 Win32。
 */
function syncTopmost() {
  const win = barWin;
  if (!win || win.isDestroyed()) return;
  if (barTopmost === pinned) return;
  barTopmost = pinned;
  win.setAlwaysOnTop(pinned, pinned ? 'pop-up-menu' : 'normal');
}

/** 显隐判断：光标靠近 or 刚拖过/刚点过 → 显示；否则淡出 */
function tick() {
  syncTopmost();
  if (!barWin || barWin.isDestroyed() || !lastRect) return;
  if (!barWin.isVisible()) return;

  const b = barWin.getBounds();
  const c = screen.getCursorScreenPoint();
  const pad = 14;
  const near =
    c.x >= b.x - pad && c.x <= b.x + b.width + pad && c.y >= b.y - pad && c.y <= b.y + b.height + pad;
  const want = near || Date.now() - revealedAt < REVEAL_MS;

  if (want === barVisible) return;
  barVisible = want;
  barWin.setOpacity(want ? 1 : 0);
  barWin.setIgnoreMouseEvents(!want);
}

function show() {
  revealedAt = Date.now();
  const win = barWin;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
}

/* ------------------------------------------------------------------ */
/* 状态机                                                              */
/* ------------------------------------------------------------------ */

function aspectClose(a: MirrorWinRect, b: MirrorWinRect): boolean {
  const ra = a.width / Math.max(1, a.height);
  const rb = b.width / Math.max(1, b.height);
  return Math.abs(ra - rb) / Math.max(ra, rb) < 0.12;
}

/** 按记录把窗口钉回去（只用于「恢复上次的 pin」） */
function restorePin(rec: MirrorPinRecord) {
  if (!usable(rec)) return;
  const rect: MirrorWinRect = { x: rec.x, y: rec.y, width: rec.width, height: rec.height };
  if (!pinMirrorWin(rect)) return;
  pinned = true;
  syncTopmost();
  log('info', '投屏', `已恢复上次的投屏窗口位置（${model || serial} · ${orientation}）`);
}

function handleState(s: {
  hwnd: number;
  visible: boolean;
  minimized: boolean;
  pinned: boolean;
  rect: MirrorWinRect;
}) {
  if (!s.hwnd || s.rect.width < 80 || s.rect.height < 80) {
    // 窗口还没建好 / 已经销毁 —— 条子跟着藏起来
    lastRect = null;
    lastVisible = false;
    if (barWin && !barWin.isDestroyed() && barWin.isVisible()) barWin.hide();
    return;
  }

  const rect = s.rect;
  const moved = !lastRect || Math.abs(lastRect.x - rect.x) > 1 || Math.abs(lastRect.y - rect.y) > 1;
  const resized =
    !lastRect || Math.abs(lastRect.width - rect.width) > 1 || Math.abs(lastRect.height - rect.height) > 1;
  const prevOri = orientation;
  const nextOri: MirrorOrientation = rect.width >= rect.height ? 'landscape' : 'portrait';

  if (s.pinned !== pinned) {
    pinned = s.pinned;
    syncTopmost();
    emitChange();
  }

  if (prevOri !== nextOri) {
    /*
     * 🔴 只有「正钉着」才把旧方向那一刻的几何落盘。
     *    pin 期间几何是被锁死的，这个值才可信；没钉着时这一帧经常还是
     *    **首帧前的占位尺寸**（实测 274×303，正片 738×367），写下去会把
     *    上次真正记住的位置尺寸冲成一条 pinned=false 的垃圾记录 ——
     *    下次投屏就再也恢复不了位置了（v1.1.22 踩过）。
     *    另外要显式传 prevOri：`orientation` 已赋值成新方向，
     *    靠全局变量写会把旧方向的几何写进新方向的 key。
     */
    if (prevOri && pinned) saveRecord(lastRect, true, prevOri);
    orientation = nextOri;
    if (prevOri) restored.add(`${model || serial}#${prevOri}`);
  }
  lastRect = rect;
  lastVisible = s.visible && !s.minimized;

  if (moved || resized) {
    // 拖动 / 缩放：把条子露出来（需求 ⑥ 的「拖动时才显示」就靠这句）
    revealedAt = Date.now();
    show();
  }

  placeWindow(rect);
  const win = barWin;
  if (win && !win.isDestroyed()) {
    if (!s.visible || s.minimized) {
      if (win.isVisible()) win.hide();
    } else if (!win.isVisible()) {
      win.showInactive();
      tick();
      /*
       * 投屏刚起来时让条子露一下（约 1.4s 后自己淡出）。
       * 只露这一次：需求是「只在拖动/靠近时才显示」，但完全不给一眼的话
       * 用户根本不知道右边多了个东西 —— 这一下算提示，不算常驻。
       */
      if (!revealedOnce) {
        revealedOnce = true;
        show();
      }
    }
  }

  if (pinned && (moved || resized)) scheduleSave();

  // 方向刚定下来 / 机型刚拿到 → 试着套用这个方向的记录
  maybeApplyRecord(rect, lastVisible);

  // 旋转到新方向且正 pin 着 → 换用该方向的记录（需求 ⑤）
  if (prevOri && prevOri !== nextOri && pinned) {
    const rec = recordFor(nextOri);
    if (rec?.pinned && usable(rec) && aspectClose(rec, rect)) {
      pinMirrorWin({ x: rec.x, y: rec.y, width: rec.width, height: rec.height });
    }
    /*
     * 没有可用记录时**什么都不做**：代理发现横竖屏类别变了会先跟随、等尺寸稳定
     * 再自己上锁（mirror-win.ts 的 Settling）。这里再发一条 LOCK 等于把刚跳过的
     * 过渡尺寸钉死，旋转完 pin 住的会是个很小的窗。
     */
  }
}

/** 本次投屏里第一次知道「机型 + 方向」时，按记录恢复 pin */
function maybeApplyRecord(rect: MirrorWinRect, visible: boolean) {
  if (!orientation) return;
  if (!model && !serial) return;
  const k = `${model || serial}#${orientation}`;
  if (restored.has(k)) return;
  const rec = recordFor(orientation);
  if (!rec?.pinned || !usable(rec)) {
    restored.add(k);
    return;
  }
  /*
   * 🔴 三条必须按顺序来的理由（v1.1.22 实测踩过）：
   *   ① **窗口还没真正显示出来时不要钉**：pin 的 SetWindowPos 带 SWP_SHOWWINDOW，
   *      会抢在 win-reveal 前面把窗口放出来 —— 用户又看到那个黑屏占位窗口。
   *   ② **首帧之前窗口是占位尺寸**（实测 274×303，正片是 338×767），
   *      这时候拿记录去比宽高比永远对不上。所以「对不上」不能当成结论，
   *      要等它自己变一次再说（下面 restoreTries 计次，别无限试）。
   *   ③ 真恢复了 / 记录不可用 / 试够了 —— 才标记这个方向处理完，避免反复套用。
   */
  if (!visible) return;
  if (!aspectClose(rec, rect)) {
    const n = (restoreTries.get(k) ?? 0) + 1;
    restoreTries.set(k, n);
    if (n >= RESTORE_MAX_TRIES) restored.add(k);
    return;
  }
  restorePin(rec);
  restored.add(k);
}

/* ------------------------------------------------------------------ */
/* 对外动作                                                            */
/* ------------------------------------------------------------------ */

/**
 * 开始投屏时挂上（由 services/mirror.ts 调用）。
 * 关掉开关时什么都不做。
 */
export function attachMirrorBar(opts: { pid: number; serial: string }): void {
  if (process.platform !== 'win32') return;
  if (!getSettings().mirrorBarEnabled) return;
  if (!opts.pid) return;
  if (agentPid === opts.pid) return;

  detachMirrorBar(false);

  agentPid = opts.pid;
  serial = opts.serial || '';
  model = null;
  pinned = false;
  orientation = null;
  lastRect = null;
  lastVisible = false;
  revealedAt = 0;
  revealedOnce = false;
  airplane = false;
  airplaneBusy = false;
  restored.clear();
  restoreTries.clear();

  startMirrorWin(opts.pid);
  offState = onMirrorWinState(handleState);
  tickTimer = setInterval(tick, TICK_MS);

  /*
   * 飞行模式状态：先立刻读一次（按钮别一上来就是灭的），之后每 6s 跟一次。
   * 只在投屏期间轮询 —— 没投屏就没有功能栏，也没有读它的必要。
   */
  void refreshAirplane();
  if (airplaneTimer) clearInterval(airplaneTimer);
  airplaneTimer = setInterval(() => void refreshAirplane(), AIRPLANE_POLL_MS);

  // 机型单独问一次（要按机型分开记，不能按 serial）；失败就退化成 serial
  void (async () => {
    try {
      const res = await runAdb(['-s', opts.serial, 'shell', 'getprop', 'ro.product.model'], {
        silent: true,
        timeout: 6000,
      });
      const name = (res?.stdout || '').trim();
      if (name && agentPid === opts.pid) {
        model = name;
        if (lastRect) maybeApplyRecord(lastRect, lastVisible);
        emitChange();
      }
    } catch {
      /* 拿不到机型不影响功能，只是记录粒度退化成 serial */
    }
  })();

  emitChange();
}

/**
 * 停止投屏 / 关闭功能栏时拆掉。
 * @param savePin true = 先把当前 pin 状态与几何落盘（正常停止投屏时用）
 */
export function detachMirrorBar(savePin = true): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (savePin && pinned) saveRecord(lastRect, true);
  else if (savePin && !pinned && lastRect && orientation) saveRecord(lastRect, false);

  if (pinned) unpinMirrorWin();

  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (airplaneTimer) {
    clearInterval(airplaneTimer);
    airplaneTimer = null;
  }
  offState?.();
  offState = null;
  stopMirrorWin();
  destroyWindow();

  agentPid = 0;
  serial = '';
  model = null;
  pinned = false;
  orientation = null;
  lastRect = null;
  lastVisible = false;
  airplane = false;
  airplaneBusy = false;
  restored.clear();
  restoreTries.clear();
  emitChange();
}

/** 设置页的开关 / 功能栏上的 pin 按钮都走这里 */
export function setMirrorPin(want: boolean): MirrorBarState {
  if (!isMirrorWinReady()) throw new Error('投屏窗口还没准备好');
  if (want) {
    if (!lastRect) throw new Error('投屏窗口还没准备好');
    /*
     * 显式点 pin 就钉**当前**这个位置 —— 不要套用记录里的旧矩形：
     * 用户可能刚把窗口拖到想要的地方再钉，套旧记录等于把他刚摆好的位置抢走。
     * （记录只在「下次投屏」和「旋转方向」这两种场景自动套用。）
     *
     * 🔴 这里用 PINHERE（就地钉），不是拿 lastRect 去 SetWindowPos：
     *    lastRect 是 30ms 上报的缓存，可能落后一帧，拿它去摆窗口就等于把窗口
     *    往回拽一下 —— 用户看到的就是「点 pin 抖一下」。
     */
    if (!pinMirrorWinHere()) throw new Error('窗口置顶失败');
    pinned = true;
    syncTopmost();
    saveRecord(lastRect, true);
    log('info', '投屏', '投屏窗口已钉住（置顶 + 固定位置尺寸）');
  } else {
    unpinMirrorWin();
    pinned = false;
    syncTopmost();
    saveRecord(lastRect, false);
    log('info', '投屏', '投屏窗口已解除钉住');
  }
  revealedAt = Date.now();
  show();
  emitChange();
  return getMirrorBarState();
}

/** 设置页「清除钉住记录」：解除 pin + 清空所有机型的记录 */
export function clearMirrorPins(): MirrorBarState {
  if (pinned) {
    unpinMirrorWin();
    pinned = false;
    syncTopmost();
  }
  saveSettings({ mirrorPinRecords: {} });
  restored.clear();
  restoreTries.clear();
  log('info', '投屏', '已清除全部投屏窗口钉住记录');
  emitChange();
  return getMirrorBarState();
}

/* ------------------------------------------------------------------ */
/* 飞行模式（v1.1.28）                                                 */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * serial 是不是网络连接（`192.168.1.7:5555` / `adb-xxx._adb-tls-connect._tcp`）。
 *
 * 🔴 网络连接的设备**不能**开飞行模式：飞行模式会关掉 Wi-Fi，adb 立刻断，
 *    投屏跟着黑掉，而且用户再也没法通过这条功能栏点回来（连接都没了）。
 *    USB 连接不受影响 —— adb 走 USB，跟手机的 radio 状态无关。
 */
export function isWirelessSerial(s: string): boolean {
  const v = (s || '').trim();
  return v.includes(':') || v.includes('_adb-tls') || v.includes('._tcp');
}

/**
 * 读手机当前飞行模式；读不到返回 null（老机型 / 命令被拒），别当成 false。
 *
 * 两条查询路：
 *   ① Android 11+ 的 `cmd connectivity airplane-mode` —— 不带参数即查询，
 *      输出 `enabled` / `disabled`，问的是 ConnectivityService 的真实状态
 *      （2026-11-20 在 OPPO CPH2579 / Android 13 上实测可用）；
 *   ② 回退读 global 设置，4.2 起都有。
 */
async function readAirplane(s: string): Promise<boolean | null> {
  try {
    const res = await runAdb(['-s', s, 'shell', 'cmd', 'connectivity', 'airplane-mode'], {
      silent: true,
      timeout: 6000,
    });
    const v = (res?.stdout || '').trim().toLowerCase();
    if (v === 'enabled') return true;
    if (v === 'disabled') return false;
  } catch {
    /* 老系统没有这个子命令，往下走 */
  }
  try {
    const res = await runAdb(
      ['-s', s, 'shell', 'settings', 'get', 'global', 'airplane_mode_on'],
      { silent: true, timeout: 6000 },
    );
    const v = (res?.stdout || '').trim();
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* 读不到就当未知 */
  }
  return null;
}

/**
 * 把手机切到目标状态，并**核对**有没有真的切过去。
 *
 * ① 先走 Android 11+ 的官方 shell 命令 —— 它直接改 ConnectivityService 的状态，
 *    顺带把 global 设置同步好，实测 Android 13 上立即可用；
 * ② 不生效（老系统没这个子命令、或被策略挡了）再回退：
 *    `settings put global airplane_mode_on` + `am broadcast AIRPLANE_MODE`。
 *    system_server 的 AirplaneModeObserver 监听那个键，值变了就切 radio；
 *    4.x~7.x 还得靠广播补刀，state 相同时广播幂等，多发一次没副作用。
 */
async function applyAirplane(s: string, on: boolean): Promise<void> {
  const cmd = await runAdb(
    ['-s', s, 'shell', 'cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable'],
    { silent: true, timeout: 8000 },
  );
  if (cmd.ok) {
    // 开/关 radio 要几百毫秒，等它落下来再核对
    await sleep(600);
    if ((await readAirplane(s)) === on) return;
  }

  const put = await runAdb(
    ['-s', s, 'shell', 'settings', 'put', 'global', 'airplane_mode_on', on ? '1' : '0'],
    { silent: true, timeout: 8000 },
  );
  if (!put.ok) throw new Error((put.stderr || '').trim() || '设备拒绝了飞行模式设置');

  await runAdb(
    [
      '-s',
      s,
      'shell',
      'am',
      'broadcast',
      '-a',
      'android.intent.action.AIRPLANE_MODE',
      '--ez',
      'state',
      on ? 'true' : 'false',
    ],
    { silent: true, timeout: 8000 },
  );

  await sleep(700);
  if ((await readAirplane(s)) !== on) {
    throw new Error('手机没有接受飞行模式切换（可能被系统策略拦住）');
  }
}

/** 从手机读一次状态，跟缓存不一致才推送（轮询用，别每 6s 白推一次） */
async function refreshAirplane(): Promise<void> {
  const s = serial;
  if (!s || airplaneBusy) return;
  const v = await readAirplane(s);
  if (v === null) return;
  // 读的这 100ms 里可能换了设备 / 用户点了按钮 —— 读数作废
  if (s !== serial || airplaneBusy) return;
  if (v !== airplane) {
    airplane = v;
    emitChange();
  }
}

/**
 * 功能栏上的飞行模式按钮（一键开 / 再点关）。
 * 切换期间按钮 disabled（渲染层 busy），这里再加一道 airplaneBusy 兜底。
 */
export async function setMirrorAirplane(on: boolean): Promise<MirrorBarState> {
  const s = serial;
  if (!s) throw new Error('还没有设备在投屏');
  if (isWirelessSerial(s)) throw new Error('无线连接的设备不能开飞行模式（会直接断开投屏）');
  if (airplaneBusy) return getMirrorBarState();

  airplaneBusy = true;
  revealedAt = Date.now();
  show();
  try {
    await applyAirplane(s, !!on);
    airplane = !!on;
    log('info', '投屏', `手机飞行模式已${on ? '打开' : '关闭'}`);
  } finally {
    airplaneBusy = false;
  }
  emitChange();
  return getMirrorBarState();
}

/**
 * 设置开关同步（main.ts 的 settingsChangedHook 调）。
 * 关闭 = 立刻解除 pin + 清空全部记录 + 拆掉功能栏。
 */export function syncMirrorBarSetting(enabled: boolean): void {
  if (enabled) return;
  if (agentPid) {
    if (pinned) unpinMirrorWin();
    pinned = false;
    saveSettings({ mirrorPinRecords: {} });
    detachMirrorBar(false);
    log('info', '投屏', '投屏窗口功能栏已关闭（已解除钉住并清空记录）');
  } else if (Object.keys(records()).length > 0) {
    saveSettings({ mirrorPinRecords: {} });
  }
}
