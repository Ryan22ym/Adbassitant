import { create } from 'zustand';
import type { MiniWinInfo } from '@shared/types';

/**
 * 浮动小窗的渲染层状态（v1.1.28 重写）。
 *
 * ────────────────────────────────────────────────────────────────
 * 与 v1.1.27 的根本区别
 * ────────────────────────────────────────────────────────────────
 * v1.1.27 里这个 store 自己就是真相：它存着每扇窗的 x/y/w/h、z 序、pin，
 * 由 React 渲染成一层 fixed DOM。代价是小窗只能在**主窗口矩形内**活动 ——
 * 用户要求「拖到屏幕任意位置」，DOM 做不到。
 *
 * 现在小窗是主进程建的 BrowserWindow（见 electron/services/mini-win.ts），
 * 这个 store 退化成**一份镜像**：它只知道「哪些页面开着、置顶了没」，
 * 用来画侧栏的已开标记、以及在开关关掉时清场。
 * 位置、尺寸、z 序、拖动全归主进程和操作系统管，渲染层不碰 ——
 * 也就不存在「渲染层以为窗在这、实际在别处」的错位。
 *
 * 🔴 唯一的写入源是主进程的 PUSH_MINI_WINS / IPC 返回值。不要在本地新增窗口条目：
 *    那样会出现「侧栏显示开着、屏幕上并没有窗」。
 */

/** 一扇小窗（与主进程下发的 MiniWinInfo 同构） */
export type MiniWin = MiniWinInfo;

interface MiniState {
  wins: MiniWin[];
  /** 打开（或聚焦）某个页面的小窗 —— 位置由主进程按鼠标当前位置决定 */
  open: (id: string) => void;
  close: (id: string) => void;
  /** 关掉所有小窗 */
  closeAll: () => void;
  togglePin: (id: string) => void;
  /** 被主进程推送覆盖（PUSH_MINI_WINS） */
  sync: (wins: MiniWinInfo[]) => void;
}

/** 调用失败（白名单拦截 / 窗口正在销毁）时不要把 store 弄脏 */
function apply(p: Promise<unknown>, set: (s: { wins: MiniWin[] }) => void): void {
  void p.then(
    (r) => {
      if (Array.isArray(r)) set({ wins: r as MiniWin[] });
    },
    () => {
      /* 忽略：调用方最多是没开成，换个入口再点一次即可 */
    },
  );
}

export const useMiniWindows = create<MiniState>((set, get) => ({
  wins: [],

  open: (id) => {
    // 已经开着就只聚焦，主进程会处理（不要在这里提前插一条假数据）
    apply(window.adbApi.miniWinOpen(id), set);
  },

  close: (id) => apply(window.adbApi.miniWinClose(id), set),

  closeAll: () => apply(window.adbApi.miniWinClose(), set),

  togglePin: (id) => {
    const cur = get().wins.find((w) => w.id === id);
    if (!cur) return;
    apply(window.adbApi.miniWinPin(id, !cur.pinned), set);
  },

  sync: (wins) => set({ wins: Array.isArray(wins) ? wins : [] }),
}));

/** 组件外（例如「开关关掉」时）也能清场 */
export function closeAllMiniWindows(): void {
  useMiniWindows.getState().closeAll();
}

/** 某页是否已经开着小窗（侧栏标记用） */
export function isMiniWinOpen(id: string): boolean {
  return useMiniWindows.getState().wins.some((w) => w.id === id);
}
