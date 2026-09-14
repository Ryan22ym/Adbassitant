import { ChildProcess } from 'child_process';
import { existsSync, statSync } from 'fs';
import { basename, join } from 'path';
import {
  scrcpyPath,
  scrcpyIconPath,
  spawnBinary,
  runAdb,
  ensureDevice,
  ensureDir,
  log,
} from './adb';
import type { MirrorOptions, MirrorStatus } from '../../shared/types';

let current: {
  child: ChildProcess;
  serial: string;
  startedAt: number;
  options: MirrorOptions;
} | null = null;

type StatusSink = (s: MirrorStatus) => void;
let statusSink: StatusSink | null = null;

export function setMirrorStatusSink(sink: StatusSink) {
  statusSink = sink;
}

function emitStatus() {
  statusSink?.(getMirrorStatus());
}

export function getMirrorStatus(): MirrorStatus {
  if (!current) return { running: false };
  return {
    running: true,
    serial: current.serial,
    pid: current.child.pid,
    startedAt: current.startedAt,
    options: current.options,
  };
}

/**
 * 启动 scrcpy 独立窗口
 */
export async function startMirror(options: MirrorOptions): Promise<MirrorStatus> {
  if (current) {
    throw new Error('投屏已在运行中，请先停止');
  }

  const exe = scrcpyPath();
  if (!existsSync(exe)) {
    throw new Error(`未找到 scrcpy：${exe}`);
  }

  const serial = await ensureDevice(options.serial);

  const args: string[] = ['-s', serial];

  // 画质
  const maxSize = options.maxSize ?? 1920;
  args.push('--max-size', String(maxSize));
  args.push('--video-bit-rate', `${options.bitRateMbps ?? 8}M`);
  args.push('--max-fps', String(options.maxFps ?? 60));

  // 音频
  if (options.noAudio !== false) args.push('--no-audio');

  // 输入：sdk 键盘模式 + 文本优先，兼容中文输入法
  const keyboard = options.keyboard ?? 'sdk';
  args.push('--keyboard', keyboard);
  if (keyboard === 'sdk') args.push('--prefer-text');

  // 便利选项
  args.push('--window-title', `ADB助手 - ${serial}`);
  args.push('--shortcut-mod=lctrl');
  args.push('--push-target=/sdcard/Download/');

  if (options.stayAwake) args.push('--stay-awake');
  if (options.alwaysOnTop) args.push('--always-on-top');

  // 录制
  if (options.recordPath) {
    ensureDir(join(options.recordPath, '..'));
    args.push('--record', options.recordPath);
    args.push('--record-format', 'mp4');
  }

  log('info', '投屏', `启动投屏（最大 ${maxSize}px / ${options.bitRateMbps ?? 8}Mbps / ${options.maxFps ?? 60}fps）`);

  // 投屏窗口用 scrcpy 原生图标，避免和主程序在任务栏里混淆。
  // scrcpy 支持 SCRCPY_ICON_PATH 指定图标（否则读同目录的 icon.png，
  // 那是我们的应用图标）。详见 scrcpyIconPath() 的注释。
  const iconPath = scrcpyIconPath();
  const extraEnv = iconPath ? { SCRCPY_ICON_PATH: iconPath } : undefined;

  const child = spawnBinary(exe, args, '投屏', extraEnv);

  // 先登记当前实例，再挂事件回调：
  // 否则进程若快速退出，close 回调会在 current 赋值前触发，
  // 导致 current 被清空后又被赋值为已退出进程（或反向覆盖），状态错乱。
  const handle = {
    child,
    serial,
    startedAt: Date.now(),
    options: { ...options, serial },
  };
  current = handle;

  // 仅当句柄仍是本次启动的实例时才清理，避免误杀后续启动的投屏
  const clearIfCurrent = () => {
    if (current === handle) {
      current = null;
      emitStatus();
    }
  };

  child.on('error', (err) => {
    log('error', '投屏', `启动失败：${err.message}`);
    clearIfCurrent();
  });

  child.on('close', (code) => {
    if (code === 0) {
      log('info', '投屏', '投屏已结束');
    } else {
      log('warn', '投屏', `投屏进程退出（exit ${code}）`);
    }
    clearIfCurrent();
  });

  emitStatus();
  return getMirrorStatus();
}

/**
 * 停止投屏
 */
export async function stopMirror(): Promise<void> {
  if (!current) {
    log('warn', '投屏', '当前没有运行中的投屏');
    return;
  }
  const { child, serial } = current;
  const handle = current;
  log('info', '投屏', '正在停止投屏…');

  try {
    child.kill();
  } catch {
    /* ignore */
  }

  // Windows 上强制兜底
  await new Promise((r) => setTimeout(r, 400));
  if (child.exitCode === null && child.pid) {
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process') as typeof import('child_process');
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* ignore */
    }
  }

  // 清理设备端 scrcpy 服务
  try {
    await runAdb(['-s', serial, 'shell', 'pkill', '-f', 'com.genymobile.scrcpy'], {
      silent: true,
      timeout: 8000,
    });
  } catch {
    /* ignore */
  }

  if (current === handle) current = null;
  log('success', '投屏', '投屏已停止');
  emitStatus();
}

/**
 * 录制投屏到文件（后台录制，不显示窗口）
 * 用 scrcpy 自带的 --record + --time-limit，由 scrcpy 自己优雅收尾 MP4 容器，
 * 避免强杀进程导致文件未封口。
 */
export async function recordMirror(
  serial: string | undefined,
  outputPath: string,
  durationSec: number,
  bitRateMbps = 8,
): Promise<string> {
  const s = await ensureDevice(serial);
  ensureDir(join(outputPath, '..'));

  const args = [
    '-s',
    s,
    '--record',
    outputPath,
    '--record-format',
    'mp4',
    '--no-playback',
    '--no-audio',
    '--video-bit-rate',
    `${bitRateMbps}M`,
    '--time-limit',
    String(durationSec),
  ];

  log('info', '录制', `开始录制投屏到 ${basename(outputPath)}，时长 ${durationSec}s`);

  await new Promise<void>((resolve, reject) => {
    const child = spawnBinary(scrcpyPath(), args, '录制');
    // 兜底：超过设定时长 + 10s 仍未退出则强杀，防止流程卡死
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, (durationSec + 10) * 1000);

    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new Error('录制文件未生成或为空');
  }

  log('success', '录制', `录制完成：${outputPath}`);
  return outputPath;
}

/**
 * 设备录屏（不需要投屏窗口）——直接用 scrcpy 的录制通道。
 * 比设备端 screenrecord 更可靠：部分厂商 ROM 精简了 /system/bin/screenrecord。
 */
export async function recordDevice(
  serial: string | undefined,
  outputPath: string,
  durationSec: number,
  bitRateMbps = 8,
  sizePx?: number,
): Promise<string> {
  const s = await ensureDevice(serial);
  ensureDir(join(outputPath, '..'));

  const args = [
    '-s',
    s,
    '--record',
    outputPath,
    '--record-format',
    'mp4',
    '--no-playback',
    '--no-audio',
    '--video-bit-rate',
    `${bitRateMbps}M`,
    '--time-limit',
    String(durationSec),
  ];
  if (sizePx) args.push('--max-size', String(sizePx));

  log('info', '录屏', `开始设备录屏 ${durationSec}s（${bitRateMbps}Mbps）`);

  await new Promise<void>((resolve, reject) => {
    const child = spawnBinary(scrcpyPath(), args, '录屏');
    const timer = setTimeout(
      () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      },
      (durationSec + 10) * 1000,
    );
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new Error('录屏文件未生成或为空');
  }

  log('success', '录屏', `已保存：${outputPath}`);
  return outputPath;
}

export function isMirrorRunning(): boolean {
  return current !== null;
}
