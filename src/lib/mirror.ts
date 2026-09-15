import type { MirrorOptions } from '@shared/types';

/**
 * 投屏参数默认值 —— 投屏页与「快速投屏」按钮共用同一份，避免两处默认值漂移。
 * 改动这里，两处同时生效。
 */
export const MIRROR_DEFAULTS: Omit<MirrorOptions, 'serial'> = {
  maxSize: 1440,
  bitRateMbps: 8,
  maxFps: 60,
  noAudio: true,
  stayAwake: true,
  alwaysOnTop: false,
  keyboard: 'sdk',
};

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
