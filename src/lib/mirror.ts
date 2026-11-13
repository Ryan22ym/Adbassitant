import type { MirrorOptions } from '@shared/types';
import { MIRROR_DEFAULTS } from '@shared/mirror-defaults';

/*
 * 默认值本体已搬到 @shared/mirror-defaults（v1.1.9）：
 * 主进程的「插入自动投屏」也要用它，放在 src/ 下面主进程读不到。
 * 这里转出去只为不打断既有引用（MirrorPage / DevicePage 仍从 @/lib/mirror 取）。
 */
export { MIRROR_DEFAULTS };

const LS_KEY = 'adb-assistant:last-mirror-options';

/**
 * 一次性迁移标记：默认键盘模式从 uhid 换成 sdk（uhid 会让前台应用
 * 因 CONFIG_KEYBOARD 重启 → 拔插必黑屏，见 shared/mirror-defaults.ts）。
 * 老版本存下来的 `uhid` 基本只是把旧默认值记下来了，不是用户主动选的，
 * 所以在升级后第一次读偏好时跟着改一次；之后用户自己选回 uhid 就不再动它。
 */
const KEYBOARD_MIGRATE_KEY = 'adb-assistant:mirror-keyboard-sdk-v1';

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
    if (!localStorage.getItem(KEYBOARD_MIGRATE_KEY)) {
      localStorage.setItem(KEYBOARD_MIGRATE_KEY, '1');
      if (parsed.keyboard === 'uhid') {
        parsed.keyboard = MIRROR_DEFAULTS.keyboard;
        localStorage.setItem(LS_KEY, JSON.stringify(parsed));
      }
    }
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
