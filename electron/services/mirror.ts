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
import { startWakeWatch, stopWakeWatch } from './wake-window';
import { attachMirrorBar, detachMirrorBar } from './mirror-bar';
import { showMirrorSplash, hideMirrorSplash } from './mirror-splash';
import { firstFramePainted, latestFps, textureReady } from './mirror-signal';

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
 *
 * 📌 v1.1.23 由 4000 提到 8000（小杨 2026-11-05 反馈「偶尔先出现黑窗两三秒」）：
 *    真机实测慢启动那次 `Renderer/Texture` 到 5.4s 才出来，4s 兜底会**抢在画面之前**
 *    把 scrcpy 的空壳窗口放出来 —— 屏幕上就是那个「黑底 + 顶部一条浅灰」的窗口。
 *    现在等首帧这段由 mirror-splash 的「正在投屏」小窗顶着，屏幕不再空白，
 *    所以宁可多等几秒也不放黑窗。
 */
const MIRROR_REVEAL_TIMEOUT_MS = 8000;

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

  // 输入模式：默认见 shared/mirror-defaults（现在是 sdk）。
  // 🔴 别随手改回 uhid —— uhid 会注册虚拟硬件键盘，设备侧触发 CONFIG_KEYBOARD，
  //    前台应用（游戏大厅 / 桌面）没声明 configChanges="keyboard" 就会重启 → 黑屏。
  //    详见 shared/mirror-defaults.ts 里 keyboard 那段注释。
  // --prefer-text 只在 sdk 模式下有意义（把字母当文本事件注入），uhid 下不加。
  const keyboard = options.keyboard ?? 'sdk';
  args.push('--keyboard', keyboard);
  if (keyboard === 'sdk') args.push('--prefer-text');

  // 便利选项
  args.push('--window-title', `ADB助手 - ${serial}`);
  args.push('--shortcut-mod=lctrl');
  args.push('--push-target=/sdcard/Download/');
  /*
   * 🔴 首帧判定信号（v1.1.23）：每秒一行 `<n> fps`，n 是**真的渲染上屏的帧数**。
   *    以前用 `INFO: Texture: WxH` 判首帧，那条日志在渲染器建好时就打了（实测比画面
   *    早 0.4s，设备忙时能早 2~3s），于是窗口被提前放出来、露出黑底空壳。
   *    判定逻辑见 services/mirror-signal.ts。
   * ⚠️ 这一行每秒都往 stdout 打，别让它把日志/尾部缓冲刷爆：
   *    adb.ts 的 pump 只把 ERROR/WARN/Device/Renderer/Texture 那几类写日志，
   *    fps 行不进日志；_tail 里也专门跳过（见 pump 里的注释）。
   */
  args.push('--print-fps');

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
   * ── 双击投屏窗口亮屏（2026-10-26）────────────────────────────────────
   *
   * 手机一熄屏，scrcpy 窗口就是一块全黑的板子：熄屏时 Android 会丢掉注入的
   * touch，而 scrcpy 没有"唤醒设备"的快捷键。这里给窗口装一个低级鼠标钩子，
   * 双击就发 `input keyevent 224`（幂等，亮屏时无副作用）。细节见 wake-window.ts。
   *
   * 🔊 不阻塞、不影响投屏：钩子进程起得慢（PowerShell + Add-Type 约 1s），
   *    窗口建好前的点击由 C# 侧的 FindTarget 兜住，不需要在这里等。
   */
  if (options.wakeOnDoubleClick !== false && child.pid) {
    startWakeWatch(child.pid, serial);
  }

  /*
   * ── 投屏窗口功能栏 / pin（v1.1.22）────────────────────────────────
   *
   * 挂在 scrcpy 那个独立窗口右侧的一条悬浮条，第一个按钮是 pin
   * （置顶 + 锁定位置尺寸）。位置跟随、置顶、锁尺寸全在 Win32 层，
   * 详见 services/mirror-win.ts 与 services/mirror-bar.ts。
   *
   * 🔊 同样是「起不来也不能影响投屏」：内部吞掉所有异常，代理起不来
   *    只是没有功能栏，投屏照旧。
   */
  if (child.pid) attachMirrorBar({ pid: child.pid, serial });

  /*
   * ── 投屏窗口「藏到首帧」的放行逻辑（v1.1.15，2026-10-22；v1.1.23 换判据）────
   *
   * 小杨反馈：投屏成功时窗口会先黑一会儿。原因是 scrcpy 在拿到第一帧视频之前
   * 就把窗口建好了（实测建窗 ~1.4s、首帧 ~1.9s），那段时间屏幕上是个黑窗口。
   *
   * 做法：spawn 时 windowsHide 让系统吞掉 scrcpy 的首次 ShowWindow，窗口在屏幕上
   * 完全不出现；等**画面真的上屏**再由 win-reveal 主动 ShowWindow —— 放出来时
   * 画面已经在窗口里了。
   *
   * 📌 v1.1.23 改了两处（小杨 2026-11-05：「偶尔先出现这个黑窗两三秒」）：
   *    ① **判据换成 `<n> fps`**（n>0）。原来认的是 `INFO: Texture: WxH`，那条日志
   *       在渲染器建好时就打了，比画面早 0.4s、设备忙时早 2~3s —— 窗口被提前放出，
   *       露出的正是那个「黑底 + 顶部一条浅灰」的空壳窗口。判定见 mirror-signal.ts。
   *    ② **等首帧的空档由 mirror-splash 的小窗顶着**，所以兜底能从 4s 放宽到 8s，
   *       宁可多等也不放黑窗。
   *
   * 🔴 这个过程只能由我们完成，所以三重保险一个都不能少：
   *    ① 首帧（FPS>0）触发；② 8s 超时兜底；③ reveal 自身失败重试 3 次。
   */
  let revealed = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  /** 纹理就绪后的次级兜底（见 onChunk 里的说明） */
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const tryReveal = (why: string) => {
    if (revealed) return;
    revealed = true;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    // 进程已经退出（启动就失败 / 设备被拔）→ 没有窗口可放，别去 PowerShell 空转
    if (current !== handle) {
      hideMirrorSplash();
      return;
    }
    const pid = child.pid;
    if (!pid) {
      hideMirrorSplash();
      return;
    }
    const attempt = (n: number) => {
      void revealWindow(pid, n === 1 ? 1200 : 800).then((res) => {
        // 投屏已经停了（用户点了停止 / 设备拔掉）→ 不再纠缠
        if (current !== handle) return;
        if (res.ok) {
          log('info', '投屏', `投屏窗口已显示（${why}）`);
          // 真窗口已经出来了，提示牌立刻让位（否则会压在投屏画面上）
          hideMirrorSplash();
          return;
        }
        if (n < 3) {
          setTimeout(() => attempt(n + 1), 300);
          return;
        }
        hideMirrorSplash();
        log('warn', '投屏', `投屏窗口未能显示（${why}）：${res.reason ?? '未知原因'}`);
      });
    };
    attempt(1);
  };

  /*
   * 首帧信号：`--print-fps` 每秒打一行 `<n> fps`，n>0 说明画面真的渲染上屏了。
   * ⚠️ stdout 的 data 事件不保证按行到达，读数可能被切在两次 chunk 之间 ——
   *    所以累积末尾一小段再判定，不能只看单次 chunk。
   * ⚠️ 两路都听：scrcpy 正常走 stdout（SDL_Log），但换版本/换平台后谁写哪一路
   *    不该成为「窗口永远不出现」的理由。
   * ⚠️ `Texture:` 只当诊断：留一条日志，方便事后分清「纹理就绪但还没画面」和
   *    「压根没连上视频流」。
   */
  let probe = '';
  let textureLogged = false;
  /**
   * 纹理就绪后的次级兜底：`<n> fps` 数的是「这一秒真的渲染了几帧」，画面完全静止时
   * 它会连续打 `0 fps`。首帧那一秒一般能数到 ≥1，但万一没数上，光等 FPS 就会一路
   * 掉到 8s 主兜底 —— 用户盯着「正在投屏」干等。所以纹理就绪后再给 3s：
   * 真有帧早被 FPS 触发；3s 还没触发说明画面迟迟不上屏，这时才放窗口。
   * ⚠️ 3s 有依据：实测「纹理就绪 → 画面出现」正常 0.4s，慢的 2~3s，
   *    取 3s 不会在正常场次抢跑，又能把慢的也放过。
   */
  const TEXTURE_GRACE_MS = 3000;

  const onChunk = (d: Buffer | string) => {
    if (revealed) return;
    probe = (probe + d.toString()).slice(-256);
    if (!textureLogged && textureReady(probe)) {
      textureLogged = true;
      log('info', '投屏', '视频纹理已就绪（等画面真正上屏）');
      graceTimer = setTimeout(() => tryReveal('纹理就绪超时'), TEXTURE_GRACE_MS);
    }
    if (firstFramePainted(probe)) {
      const fps = latestFps(probe);
      log('info', '投屏', `检测到画面已上屏（${fps} fps）`);
      tryReveal('首帧就绪');
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  revealTimer = setTimeout(() => tryReveal('等待首帧超时'), MIRROR_REVEAL_TIMEOUT_MS);

  /*
   * 等首帧这段屏幕不能空着：scrcpy 的窗口还藏着，用户点完投屏什么都看不到。
   * 这个自己画的小窗只负责顶着，窗口一放出来就撤（见 mirror-splash.ts）。
   * ⚠️ 放在 spawn 之后：先让 scrcpy 尽快起来，别为了画提示牌拖慢启动。
   */
  showMirrorSplash();

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
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    // 窗口没了，鼠标钩子也就没有目标，拆掉（否则它还在后台吃全局鼠标事件）
    stopWakeWatch();
    // 提示牌跟着投屏一起撤（启动失败 / 用户点停止 都不该留一块「正在投屏」）
    hideMirrorSplash();
    /*
     * 功能栏也要撤（v1.1.22）：那个小窗是独立于 scrcpy 的 BrowserWindow，
     * 不主动拆会一直挂在屏幕右边、还在 30ms 轮询一个已经不存在的窗口。
     * savePin=true → 先把这个机型 + 方向的 pin 状态和几何落盘，下次投屏能还原。
     */
    detachMirrorBar(true);
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

  // 先拆鼠标钩子：窗口马上要没了，多留一秒就会在残留窗口上误触发
  stopWakeWatch();
  // 提示牌同样立刻撤（不用等进程 close 事件那 400ms）
  hideMirrorSplash();

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
