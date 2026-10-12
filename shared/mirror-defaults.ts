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
  alwaysOnTop: false,
  keyboard: 'sdk',
};
