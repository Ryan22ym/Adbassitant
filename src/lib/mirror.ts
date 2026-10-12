import type { MirrorOptions } from '@shared/types';
import { MIRROR_DEFAULTS } from '@shared/mirror-defaults';

/*
 * 默认值本体已搬到 @shared/mirror-defaults（v1.1.9）：
 * 主进程的「插入自动投屏」也要用它，放在 src/ 下面主进程读不到。
 * 这里转出去只为不打断既有引用（MirrorPage / DevicePage 仍从 @/lib/mirror 取）。
 */
export { MIRROR_DEFAULTS };

const LS_KEY = 'adb-assistant:last-mirror-options';

export type MirrorPrefs = Omit<MirrorOptions, 'serial'>;

/**
 * 上次成功启动投屏时用的参数（用户在投屏页调过就记下来）。
 * 快速投屏按钮直接沿用，避免「投屏页选了高清、快投却又回落到默认」的割裂感。
 */
export function loadMirrorPrefs(): MirrorPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...MIRROR_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<MirrorPrefs>;
    // 与默认值合并：老版本存下的字段不全时也能用
    return { ...MIRROR_DEFAULTS, ...parsed };
  } catch {
    return { ...MIRROR_DEFAULTS };
  }
}

export function saveMirrorPrefs(prefs: MirrorPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    /* 存储不可用时静默忽略，不影响投屏 */
  }
}

/** 把 MirrorPrefs 转成 startMirror 需要的完整参数 */
export function mirrorOptionsFor(serial: string, prefs?: MirrorPrefs): MirrorOptions {
  return { serial, ...(prefs ?? loadMirrorPrefs()) };
}

/** 该序列号的设备是否正在投屏 */
export function isMirroringDevice(serial?: string, mirrorSerial?: string): boolean {
  return !!serial && !!mirrorSerial && serial === mirrorSerial;
}
