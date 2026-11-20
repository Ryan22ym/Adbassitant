import { BrowserWindow } from 'electron';
import { getSettings } from './settings';
import { IPC } from '../../shared/types';
import type { AccentId, SharedUiState, ThemeId } from '../../shared/types';

/**
 * 跨窗口共享的界面状态（v1.1.28）。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ────────────────────────────────────────────────────────────────
 * 主窗口和浮动小窗是**两个渲染进程**，各自一份 zustand store。没有这条通道时：
 *   · 在小窗里选了设备 A，主窗口的设备页还停在 B（截图/安装会打到 B 上）；
 *   · 主窗口切成深色，小窗仍是白底 —— 一扇白窗飘在深色桌面上。
 *
 * 只同步「界面级」的三项（当前设备 / 主题 / 主题色）。业务状态不进这里：
 * 投屏、弱网、连点器的真相本来就在主进程，两边各自拉取自然是同一份。
 *
 * 🔴 循环防护：这条通道**只由渲染层的用户动作触发写入**；收到推送的一方
 *    直接写 store（不回调 setSharedUi），所以不会出现 A→B→A 的来回弹。
 */

let cached: SharedUiState | null = null;

function init(): SharedUiState {
  const s = getSettings();
  return {
    currentSerial: s.defaultSerial ?? '',
    theme: s.theme as ThemeId,
    accent: s.accent as AccentId,
  };
}

export function getSharedUi(): SharedUiState {
  if (!cached) cached = init();
  return cached;
}

/**
 * 合并写入并广播。
 *
 * 只接受这三个键：这条通道是给界面同步用的，不该变成第二个 settings.json。
 */
export function setSharedUi(patch: Partial<SharedUiState>): SharedUiState {
  const cur = getSharedUi();
  const next: SharedUiState = {
    currentSerial:
      typeof patch.currentSerial === 'string' ? patch.currentSerial : cur.currentSerial,
    theme: (patch.theme as ThemeId) ?? cur.theme,
    accent: (patch.accent as AccentId) ?? cur.accent,
  };

  /*
   * 等值不广播（v1.1.28）。
   *
   * 这是跨窗口同步的**防回环闸门**：B 窗口收到推送后会写自己的 store，
   * store 的 setter 又会回报一次 setSharedUi。没有这道判断就是
   * A→B→A→B 的无限乒乓，两边一起卡死。
   */
  if (
    cur.currentSerial === next.currentSerial &&
    cur.theme === next.theme &&
    cur.accent === next.accent
  ) {
    return cur;
  }
  cached = next;

  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(IPC.PUSH_UI_SHARED, next);
    } catch {
      /* 窗口正在销毁 */
    }
  }
  return next;
}

/** 主题变化也走这里 —— 主窗口保存设置后调一次，小窗立刻跟着换色 */
export function syncSharedTheme(theme: ThemeId, accent: AccentId): void {
  const cur = getSharedUi();
  if (cur.theme === theme && cur.accent === accent) return;
  setSharedUi({ theme, accent });
}
