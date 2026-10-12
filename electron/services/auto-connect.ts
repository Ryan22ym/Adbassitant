import type { DeviceInfo } from '../../shared/types';
import {
  AUTO_CONNECT_COOLDOWN_MS,
  createAutoConnectState,
  isEligible,
  pickTarget,
} from '../../shared/auto-connect-core';
import { getSettings, saveSettings } from './settings';
import { log } from './adb';

/**
 * 「插入 USB 设备 → 自动打开助手并投屏」的**有副作用**的那一半（v1.1.9）。
 *
 * 判定规则本身在 shared/auto-connect-core.ts（纯函数、可离线回归），
 * 这里只负责：读写白名单、持有跨轮状态、把设置喂进判定。
 *
 * 调用链：
 *   main.ts 设备轮询 → pickAutoConnectTarget() → bringToFront() + startMirror()
 *   mirror.ts 投屏稳定运行 → rememberMirroredSerial()（唯一写入白名单的地方）
 */

/** 判定用的跨轮状态（模块单例，整个进程共用一份） */
const state = createAutoConnectState();

/* ------------------------------------------------------------------ */
/* 白名单（曾投屏成功过的设备）                                        */
/* ------------------------------------------------------------------ */

/** 读取白名单。存坏了（比如手工改过 settings.json）就当空表，不让它把功能带崩 */
export function mirroredSerials(): string[] {
  const v = getSettings().mirroredSerials;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
}

export function isMirrored(serial: string): boolean {
  return mirroredSerials().includes(serial);
}

/**
 * 把一台设备记进白名单。
 *
 * 由 services/mirror.ts 在 scrcpy **稳定运行**之后调用 —— 不是 spawn 成功就记，
 * 原因见那边的注释。这里只做去重与落盘。
 */
export function rememberMirroredSerial(serial: string): void {
  if (!serial) return;
  const list = mirroredSerials();
  if (list.includes(serial)) return;
  saveSettings({ mirroredSerials: [...list, serial] });
  log('info', '投屏', `已记录「可自动投屏」设备：${serial}`);
}

/*
 * 清空白名单走的是通用设置接口（渲染层 setSettings({ mirroredSerials: [] })），
 * 不在这里再包一层 —— 少一个 IPC 通道就少一处要同步的字面量。
 */

/* ------------------------------------------------------------------ */
/* 主进程入口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 主进程的设备轮询每轮调一次。返回非 null 就该去唤起窗口 + 起投屏。
 *
 * 这里把「当前设置」和「时钟」注进纯函数 —— 判定本身因此能被单独测，
 * 而设置与系统时间这两样在脚本里没法复现。
 */
export function pickAutoConnectTarget(devices: DeviceInfo[]): DeviceInfo | null {
  const s = getSettings();
  return pickTarget(devices, state, {
    enabled: !!s.autoMirrorOnConnect,
    mirrored: mirroredSerials(),
    now: Date.now(),
  });
}

/* 供需要直接判门槛的地方使用（目前只有测试脚本） */
export { AUTO_CONNECT_COOLDOWN_MS, createAutoConnectState, isEligible, pickTarget };
