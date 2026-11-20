import { useEffect } from 'react';
import { useApp } from '@/store/app';
import { closeAllMiniWindows, useMiniWindows } from '@/lib/mini-window';
import { IPC } from '@shared/types';
import type { MiniWinInfo } from '@shared/types';
import './mini.css';

/**
 * 浮动小窗的**主窗口侧同步器**（v1.1.28 重写）。
 *
 * v1.1.27 里这个组件是渲染宿主：把 store 里的每扇窗画成一层 fixed DOM。
 * 现在小窗已经是独立系统窗口（见 electron/services/mini-win.ts），
 * 主窗口这边只剩三件事要做，且都不产生任何 DOM：
 *
 *   1. 启动时拉一次窗口列表 —— 主窗口可能比小窗晚加载（反之亦然），
 *      只靠推送会漏掉「已经开着的窗」；
 *   2. 订阅 PUSH_MINI_WINS，把主进程那份真值镜像到 store（侧栏标记、清场都靠它）；
 *   3. 导航增强被关掉时**清场**：侧栏入口没了之后再留几扇窗飘着，
 *      用户既关不掉也理解不了发生了什么。
 *
 * 返回 null 是刻意的 —— 它不再画任何东西。保留这个组件名是为了让 App 的
 * 挂载顺序（在所有页面之后、Toast 之前）保持不变，出问题时排查路径一致。
 */
export default function MiniWindowHost() {
  const enabled = useApp((s) => s.navAdvanced.effective);
  const sync = useMiniWindows((s) => s.sync);

  useEffect(() => {
    if (!enabled) return;
    void window.adbApi.miniWinList().then(
      (r) => {
        if (Array.isArray(r)) sync(r as MiniWinInfo[]);
      },
      () => {
        /* 主进程还没准备好，等推送即可 */
      },
    );
    const off = window.adbApi.on(IPC.PUSH_MINI_WINS, (list: MiniWinInfo[]) => sync(list));
    return () => off();
  }, [enabled, sync]);

  useEffect(() => {
    if (!enabled) closeAllMiniWindows();
  }, [enabled]);

  return null;
}
