import { app, BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { getSettings, saveSettings } from './settings';
import { log } from './adb';
import { IPC } from '../../shared/types';
import type { MiniWinBounds, MiniWinInfo } from '../../shared/types';

/**
 * 页面浮动小窗（v1.1.28）：**独立的系统窗口**。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么从 DOM 浮层改成 BrowserWindow
 * ────────────────────────────────────────────────────────────────
 * v1.1.27 的小窗是应用内的一层 fixed DOM，它的坐标空间就是主窗口的内容区 ——
 * 用户把主窗口缩到一半，小窗只能在那一半里活动。而需求是「拖到屏幕任意位置，
 * 不局限在软件页内」，这在渲染层无解：DOM 永远出不了自己的窗口。
 *
 * 所以改成真正的窗口，和 mirror-bar / mirror-splash 用的是同一套办法：
 * 加载同一份前端 bundle，用 hash 分流（见 src/main.tsx 的 `#/mini/<id>`）。
 *
 * ────────────────────────────────────────────────────────────────
 * 几条硬约束
 * ────────────────────────────────────────────────────────────────
 * 1. **不设 parent**：设了父子关系，主窗口最小化 / 关闭时小窗会跟着没，
 *    而用户要的正是「主窗口收起来，小窗还钉在桌面上看状态」。
 * 2. **skipTaskbar: true**：它是配件窗，不是第二个主界面；每开一个页面就在任务栏
 *    多一条会很吵。找回来的路径是主窗口侧栏的同名入口（再点一次就聚焦）。
 * 3. **位置必须落盘**：用户把小窗拖到副屏角落是在布置自己的工作台，
 *    关掉再开、重启程序都该回到原处，而不是每次弹在鼠标旁边。
 * 4. **位置要做可见性校验**：显示器拔掉 / 分辨率变小后，记录可能落在屏幕外，
 *    那时必须拉回工作区 —— 否则窗口存在但用户永远看不见，以为功能坏了。
 * 5. **置顶 = pin**：v1.1.27 的 pin 是「点外部不关」，独立窗口没有这个概念，
 *    它现在的语义是 alwaysOnTop（钉在所有窗口之上），标题栏那个图标原样保留。
 */

const MIN_W = 320;
const MIN_H = 240;
const DEFAULT_W = 420;
const DEFAULT_H = 540;

/** 位置/尺寸变化的落盘防抖（ms）——拖动窗口时 moved 会连发几十次 */
const SAVE_DEBOUNCE_MS = 500;

/** 页面 id → 窗口 */
const wins = new Map<string, BrowserWindow>();
/** 置顶状态（窗口销毁后仍保留，下次打开沿用） */
const pinnedSet = new Set<string>();
const saveTimers = new Map<string, NodeJS.Timeout>();

/** 主窗口引用（main.ts 注册；玻璃主题重建窗口时这个回调始终返回当前那一个） */
let mainWindowProvider: () => BrowserWindow | null = () => null;

export function setMiniWinMainWindowProvider(fn: () => BrowserWindow | null): void {
  mainWindowProvider = fn;
}

function mainWindow(): BrowserWindow | null {
  const w = mainWindowProvider();
  return w && !w.isDestroyed() ? w : null;
}

/* ------------------------------------------------------------------ */
/* 几何                                                                */
/* ------------------------------------------------------------------ */

/** 出厂位置：贴着鼠标（新开一扇窗时，窗口左上角落在指针左上方一点） */
function spawnBounds(): MiniWinBounds {
  const pt = screen.getCursorScreenPoint();
  return {
    x: Math.round(pt.x - 60),
    y: Math.round(pt.y - 18),
    width: DEFAULT_W,
    height: DEFAULT_H,
  };
}

/**
 * 把矩形收回某个显示器的工作区。
 *
 * 判据与主窗口的 window-state 一致：至少要露出标题栏那一条，否则拖不回来。
 * 这里做得更宽一点 —— 小窗整体挪进工作区，只要放得下。
 */
function clampToWorkArea(b: MiniWinBounds): MiniWinBounds {
  const width = Math.max(MIN_W, Math.round(b.width));
  const height = Math.max(MIN_H, Math.round(b.height));
  const display = screen.getDisplayMatching({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width,
    height,
  });
  const area = display.workArea;
  const x = Math.min(Math.max(area.x, Math.round(b.x)), area.x + area.width - width);
  const y = Math.min(Math.max(area.y, Math.round(b.y)), area.y + area.height - height);
  return { x, y, width, height };
}

function boundsOf(win: BrowserWindow): MiniWinBounds {
  const r = win.getBounds();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function saveBoundsSoon(id: string, win: BrowserWindow): void {
  const prev = saveTimers.get(id);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    saveTimers.delete(id);
    if (win.isDestroyed()) return;
    // 最小化时 getBounds 仍返回还原尺寸，可以直接存
    const b = boundsOf(win);
    const all = { ...(getSettings().miniWinBounds || {}) };
    all[id] = b;
    try {
      saveSettings({ miniWinBounds: all });
    } catch (e) {
      log('warn', '小窗', `位置保存失败：${(e as Error).message}`);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(id, timer);
}

/** 立刻保存（关闭窗口前用 —— 拖完立刻按 Alt+F4 也不会丢位置） */
function saveBoundsNow(id: string, win: BrowserWindow): void {
  const t = saveTimers.get(id);
  if (t) {
    clearTimeout(t);
    saveTimers.delete(id);
  }
  if (win.isDestroyed()) return;
  const all = { ...(getSettings().miniWinBounds || {}) };
  all[id] = boundsOf(win);
  try {
    saveSettings({ miniWinBounds: all });
  } catch (e) {
    log('warn', '小窗', `位置保存失败：${(e as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 广播                                                                */
/* ------------------------------------------------------------------ */

export function listMiniWins(): MiniWinInfo[] {
  return Array.from(wins.keys()).map((id) => ({ id, pinned: pinnedSet.has(id) }));
}

/**
 * 把当前窗口列表推给**所有**窗口。
 *
 * 主窗口用它同步侧栏的「已开」状态；小窗自己也收（虽然目前不用），
 * 免得将来要显示「共有几扇窗」时又多一条通道。
 */
export function broadcastMiniWins(): void {
  const payload = listMiniWins();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(IPC.PUSH_MINI_WINS, payload);
    } catch {
      /* 窗口正在销毁，忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 开 / 关 / pin                                                       */
/* ------------------------------------------------------------------ */

function devServerUrl(): string | null {
  if (app.isPackaged || process.env.NODE_ENV !== 'development') return null;
  return process.env.VITE_DEV_SERVER_URL || 'http://localhost:5273';
}

function loadMiniPage(win: BrowserWindow, id: string): void {
  const hash = `/mini/${id}`;
  const dev = devServerUrl();
  if (dev) {
    void win.loadURL(`${dev}#${hash}`);
  } else {
    // __dirname = dist-electron/electron/services → 回退三级到项目根/dist
    void win.loadFile(join(__dirname, '..', '..', '..', 'dist', 'index.html'), { hash });
  }
}

/**
 * 打开（或聚焦）某个页面的小窗。
 *
 * 已开着时只聚焦、不改位置 —— 用户刚把它摆好，再点一次入口不该把它弹回默认处。
 */
export function openMiniWin(id: string): MiniWinInfo[] {
  const exists = wins.get(id);
  if (exists && !exists.isDestroyed()) {
    if (exists.isMinimized()) exists.restore();
    exists.show();
    exists.focus();
    return listMiniWins();
  }

  const saved = getSettings().miniWinBounds?.[id];
  const bounds = clampToWorkArea(saved ?? spawnBounds());

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    show: false,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: pinnedSet.has(id),
    backgroundColor: '#0f1218',
    title: `ADB 桌面助手 · ${id}`,
    webPreferences: {
      preload: join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  wins.set(id, win);
  loadMiniPage(win, id);

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
  });

  /*
   * 加载失败也要把窗露出来（v1.1.28）。
   *
   * ready-to-show 只在首帧渲染成功时触发；dev server 没起、dist 缺文件时
   * 它永远不来 —— 表现是「点了入口，任务栏没动静，桌面上也什么都没有」，
   * 用户完全无法判断是功能坏了还是自己点漏了。留一扇白窗反而能说明问题。
   */
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (!win.isDestroyed()) win.show();
    log('warn', '小窗', `「${id}」页面加载失败：${code} ${desc}`);
  });

  win.on('moved', () => saveBoundsSoon(id, win));
  win.on('resized', () => saveBoundsSoon(id, win));

  /*
   * 兜底轮询（v1.1.28）。
   *
   * 🔴 只靠 moved / resized 会漏：`setBounds` 这类**程序化**移动在 Windows 上
   *    不一定触发 moved（自检脚本正是踩到这个才发现的），
   *    而系统侧的吸附（拖到屏幕边缘、Aero Snap）也可能只改一次位置。
   *    这里每 2 秒比对一次「实际 bounds vs 已落盘 bounds」，不同才写 ——
   *    本地读一次 getBounds 的开销可以忽略，换来的是「位置一定记得住」。
   */
  const watch = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(watch);
      return;
    }
    const b = boundsOf(win);
    const saved = (getSettings().miniWinBounds || {})[id];
    if (
      !saved ||
      saved.x !== b.x ||
      saved.y !== b.y ||
      saved.width !== b.width ||
      saved.height !== b.height
    ) {
      saveBoundsSoon(id, win);
    }
  }, 2000);

  win.on('close', () => saveBoundsNow(id, win));

  win.on('closed', () => {
    clearInterval(watch);
    wins.delete(id);
    const t = saveTimers.get(id);
    if (t) {
      clearTimeout(t);
      saveTimers.delete(id);
    }
    broadcastMiniWins();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  broadcastMiniWins();
  log('info', '小窗', `打开「${id}」小窗（${bounds.x},${bounds.y} ${bounds.width}×${bounds.height}）`);
  return listMiniWins();
}

/** 关闭某一扇（id 省略 = 全部关闭） */
export function closeMiniWin(id?: string): MiniWinInfo[] {
  if (!id) {
    for (const [key, w] of wins) {
      if (!w.isDestroyed()) {
        saveBoundsNow(key, w);
        w.destroy();
      }
    }
    wins.clear();
    broadcastMiniWins();
    return [];
  }
  const win = wins.get(id);
  if (win && !win.isDestroyed()) {
    saveBoundsNow(id, win);
    win.destroy();
  }
  wins.delete(id);
  broadcastMiniWins();
  return listMiniWins();
}

/** 置顶开关（标题栏那个 pin 图标） */
export function setMiniWinPin(id: string, pinned: boolean): MiniWinInfo[] {
  if (pinned) pinnedSet.add(id);
  else pinnedSet.delete(id);
  const win = wins.get(id);
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(pinned);
    win.show();
  }
  broadcastMiniWins();
  return listMiniWins();
}

/** 小窗里点「打开完整页面」：主窗口显示、聚焦，并导航到目标路径 */
export function focusMainAndNavigate(path: string): void {
  const main = mainWindow();
  if (!main) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  try {
    main.webContents.send(IPC.PUSH_NAV_TO, path);
  } catch {
    /* 主窗口正在加载，导航请求丢掉即可 */
  }
}

/** 主窗口关闭（退出 / 收进托盘）时不要动小窗 —— 它本来就是独立的。 */
export function hasAnyMiniWin(): boolean {
  return wins.size > 0;
}
