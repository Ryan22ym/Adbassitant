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
import { rememberMirroredSerial } from './auto-connect';
import { revealWindow } from './win-reveal';

/**
 * 「这次投屏算成功了」的判定延时。
 *
 * scrcpy 起来后一两秒内自己退出是常见失败（设备紧接着拔了、编码器不支持、
 * 屏幕尺寸被 override 成怪值等），spawn 成功不等于投屏成功。
 * 熬过这个稳定期的才记进「可自动投屏」白名单（见 services/auto-connect.ts）。
 */
const MIRROR_OK_DELAY_MS = 3000;

/**
 * 首帧迟迟不来时，也必须在这么长时间内把投屏窗口放出来。
 *
 * 🔴 窗口被 windowsHide 藏起来后，**只有我们能让它出现**（见 win-reveal.ts）。
 *    所以这个兜底不能省：日志措辞变了 / 设备卡住 / 首帧根本不来的情况下，
 *    少了它会变成「投屏在跑但窗口永远看不见」，比原来的黑屏更糟。
 *    正常路径下首帧约 1.5~2.5s 到达，兜底基本不会触发。
 */
const MIRROR_REVEAL_TIMEOUT_MS = 4000;

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

  // 输入：默认 uhid（模拟真实 HID 键盘）—— sdk 模式只支持 ASCII、过不了设备
  // 的中文输入法（IME 组合），uhid 才能数字 / 英文 / 中文 IME 全都能输。
  // --prefer-text 只在 sdk 模式下有意义（把字母当文本事件注入），uhid 下不加。
  const keyboard = options.keyboard ?? 'uhid';
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

  const child = spawnBinary(exe, args, '投屏', extraEnv, {
    // 窗口先藏起来，等首帧到了再由 win-reveal 放出来（见文件头注释）
    hideOwnWindow: process.platform === 'win32',
  });

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

  /*
   * ── 投屏窗口「藏到首帧」的放行逻辑（v1.1.15，2026-10-22）───────────────
   *
   * 小杨反馈：投屏成功时窗口会先黑一会儿。原因是 scrcpy 在拿到第一帧视频之前
   * 就把窗口建好了（实测建窗 ~1.4s、首帧 ~1.9s），那段时间屏幕上是个黑窗口。
   *
   * 现在反过来：spawn 时 windowsHide 让系统吞掉 scrcpy 的首次 ShowWindow，
   * 窗口在屏幕上完全不出现；等它的日志打出 `INFO: Texture: WxH`（首帧解码完成）
   * 再由 win-reveal 主动 ShowWindow —— 放出来时画面已经在窗口里了。
   *
   * 🔴 这个过程只能由我们完成，所以三重保险一个都不能少：
   *    ① 首帧日志触发；② 4s 超时兜底；③ reveal 自身失败重试 3 次。
   */
  let revealed = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  const tryReveal = (why: string) => {
    if (revealed) return;
    revealed = true;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    // 进程已经退出（启动就失败 / 设备被拔）→ 没有窗口可放，别去 PowerShell 空转
    if (current !== handle) return;
    const pid = child.pid;
    if (!pid) return;
    const attempt = (n: number) => {
      void revealWindow(pid, n === 1 ? 1200 : 800).then((res) => {
        // 投屏已经停了（用户点了停止 / 设备拔掉）→ 不再纠缠
        if (current !== handle) return;
        if (res.ok) {
          log('info', '投屏', `投屏窗口已显示（${why}）`);
          return;
        }
        if (n < 3) {
          setTimeout(() => attempt(n + 1), 300);
          return;
        }
        log('warn', '投屏', `投屏窗口未能显示（${why}）：${res.reason ?? '未知原因'}`);
      });
    };
    attempt(1);
  };

  /*
   * 首帧信号：scrcpy 解码出第一帧后打印 `INFO: Texture: <宽>x<高>`。
   * ⚠️ stdout 的 data 事件不保证按行到达，"Texture:" 可能被切成两段 ——
   *    所以累积末尾一小段再判断，不能只看单次 chunk。
   * ⚠️ 两路都听：scrcpy 正常走 stdout（SDL_Log），但换版本/换平台后谁写哪一路
   *    不该成为「窗口永远不出现」的理由。
   */
  let probe = '';
  const onChunk = (d: Buffer | string) => {
    if (revealed) return;
    probe = (probe + d.toString()).slice(-256);
    if (probe.includes('Texture:')) tryReveal('首帧就绪');
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  revealTimer = setTimeout(() => tryReveal('等待首帧超时'), MIRROR_REVEAL_TIMEOUT_MS);

  /*
   * 熬过稳定期就认为「这台设备在本机投屏成功过」，记进自动投屏白名单。
   * 这是 v1.1.9 那个开关唯一会更新白名单的地方 —— 用户手动投成功过，才允许自动投。
   */
  const confirmTimer = setTimeout(() => {
    if (current !== handle) return;
    rememberMirroredSerial(serial);
  }, MIRROR_OK_DELAY_MS);

  // 仅当句柄仍是本次启动的实例时才清理，避免误杀后续启动的投屏
  const clearIfCurrent = () => {
    clearTimeout(confirmTimer);
    // 进程都没了，别再排「放出窗口」的超时（窗口也随之消失）
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
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
