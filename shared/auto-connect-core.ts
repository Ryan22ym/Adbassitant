import type { DeviceInfo } from './types';

/**
 * 「插入 USB 设备 → 自动打开助手并投屏」的判定规则（v1.1.9）。
 *
 * 刻意放在 shared/ 且**不 import 任何东西**（除了类型）：规则要能脱离 Electron
 * 单独跑回归（scripts/check-auto-connect.cjs），和 shared/packages.ts 一个思路。
 * 读写设置、落盘、起投屏这些副作用都留在 electron/services/auto-connect.ts。
 *
 * ## 边界（2026-10-10 定的口径）
 *
 * 只对**同时满足三条**的设备动手：
 *   1. USB 连接的真机 —— 排除模拟器，也排除 `ip:port` 的无线设备
 *   2. 已授权（state = device）—— 未授权的设备投屏必然失败，只会白报一次错
 *   3. **曾在本机手动投屏成功过**（在白名单里）
 *
 * 第 3 条是这套功能最关键的收敛：它不是「插上就投」，而是「插上你已经信任的那台就投」。
 * 于是「插上只为充电」「插陌生设备调试」这些高频场景天然不会被误触发，
 * 既不必做白名单配置界面，也不必加引导弹窗。
 *
 * ## 为什么用边沿触发而不是「设备出现」
 *
 * 设备刚插入时 adb 报的 state 往往是 `unauthorized` / `offline` / `unknown`，
 * 过一会儿（或用户点完授权）才转成 `device`。若按「serial 首次出现」触发，
 * 真正可投的那一刻反而不在触发窗口里（serial 早被记过了）。
 * 所以这里比的是**「是否满足门槛」这件事的上升沿**：
 * 上一轮不满足、这一轮满足 → 就是该动手的时刻，无论原因是刚插上还是刚点完授权。
 */

/** 同一台设备两次触发之间的最小间隔，防 adb 抖动导致反复投屏 */
export const AUTO_CONNECT_COOLDOWN_MS = 8000;

/** 判定过程需要跨轮保存的状态。显式建模，好让判定本身是纯函数 */
export interface AutoConnectState {
  /** 上一轮「已满足门槛」的设备集合，用来求上升沿 */
  armed: Set<string>;
  /** 是否已经建立过基线（应用启动后的第一轮只采样、不触发） */
  primed: boolean;
  /** 上次看到的开关状态，用于识别「刚被拨动」 */
  lastEnabled: boolean | null;
  /** 上次触发时间，用于冷却 */
  lastFireAt: number;
}

export function createAutoConnectState(): AutoConnectState {
  return { armed: new Set(), primed: false, lastEnabled: null, lastFireAt: 0 };
}

/**
 * 三重门槛，全中才算「可以自动投屏的设备」。
 *
 * `isEmulator` 必须判：本机常年挂着一台模拟器，它的 serial 是 `emulator-5556` 这种
 * 短串，光靠 `connection === 'usb'` 拦不住某些把自己报成物理设备的定制镜像。
 */
export function isEligible(d: DeviceInfo, mirrored: Set<string>): boolean {
  return d.connection === 'usb' && !d.isEmulator && d.state === 'device' && mirrored.has(d.serial);
}

/**
 * 喂一轮设备快照，返回**本次应当自动投屏**的设备（没有则 null）。
 *
 * 状态与设置全部从参数进来（不外读设置、不读时钟），所以它是可测的纯函数。
 * 主进程的调用入口是 electron/services/auto-connect.ts 的 pickAutoConnectTarget()。
 */
export function pickTarget(
  devices: DeviceInfo[],
  st: AutoConnectState,
  opts: { enabled: boolean; mirrored: string[]; now: number },
): DeviceInfo | null {
  const mirrorSet = new Set(opts.mirrored);
  const nowArmed = new Set(
    opts.enabled ? devices.filter((d) => isEligible(d, mirrorSet)).map((d) => d.serial) : [],
  );

  /*
   * 两种情况只重建基线、绝不触发：
   *   · 应用启动后的第一轮 —— 那时候已经插着的设备不算「插入事件」；
   *   · 开关刚被拨动 —— 打开开关的瞬间不该立刻弹一个投屏出来。
   */
  if (!st.primed || opts.enabled !== st.lastEnabled) {
    st.primed = true;
    st.lastEnabled = opts.enabled;
    st.armed = nowArmed;
    return null;
  }

  const rising = [...nowArmed].filter((s) => !st.armed.has(s));
  st.armed = nowArmed;
  if (!rising.length) return null;

  // 冷却期内不触发，且**不补触发** —— armed 已经记下它了，下一轮不会再算上升沿。
  if (opts.now - st.lastFireAt < AUTO_CONNECT_COOLDOWN_MS) return null;
  st.lastFireAt = opts.now;

  return devices.find((d) => d.serial === rising[0]) ?? null;
}
