import type { MirrorOptions } from './types';

/**
 * 投屏参数默认值 —— 投屏页、设备行「快速投屏」、以及「插入自动投屏」共用同一份。
 *
 * 放在 shared/ 而不是 src/lib/ 是因为它现在有两个消费者：
 *   · 渲染层（src/lib/mirror.ts 转出，投屏页与快速投屏用）
 *   · 主进程（services/auto-connect.ts 在自动投屏时直接用）
 *
 * 分两份写迟早会漂移 —— 「手动投屏 1440p、插上线自动变成 1920p」这种割裂很难查。
 * 改动这里，三处同时生效。
 */
export const MIRROR_DEFAULTS: Omit<MirrorOptions, 'serial'> = {
  maxSize: 1440,
  bitRateMbps: 8,
  maxFps: 60,
  noAudio: true,
  stayAwake: true,
  /*
   * 双击投屏窗口 = 点亮手机屏幕。
   * 手机熄屏后 scrcpy 是一块黑板（熄屏状态 Android 会丢掉注入的 touch），
   * 这个开关省掉"伸手按电源键"。默认开：keyevent 224 是幂等的，亮屏时无副作用。
   */
  wakeOnDoubleClick: true,
  alwaysOnTop: false,
  /*
   * 默认用 uhid：scrcpy 的 sdk 模式只能注入 ASCII、走不了设备的中文输入法
   * （IME 组合字符），uhid 模拟真实 HID 键盘，数字 / 英文 / 中文 IME 都能输。
   * 少数老设备若 uhid 权限受限，可在投屏页改回「标准 SDK」。
   */
  keyboard: 'uhid',
};
