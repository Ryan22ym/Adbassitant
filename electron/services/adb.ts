import { spawn, ChildProcess, execFile } from 'child_process';
import { existsSync, mkdirSync, statSync, createWriteStream } from 'fs';
import { join, dirname, basename } from 'path';
import { randomUUID } from 'crypto';
import type { CommandResult, DeviceInfo } from '../../shared/types';

/**
 * 二进制目录解析
 * 打包后：resources/bin/
 * 开发期：项目根目录 bin/（__dirname = dist-electron/electron/services）
 */
export function resolveBinDir(): string {
  const candidates: string[] = [];

  // 打包后：process.resourcesPath/bin
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'bin'));
  }

  // 开发期：从 dist-electron/electron/services 回退到项目根
  candidates.push(join(__dirname, '..', '..', '..', 'bin'));
  // 容错：如果编译输出层级变化
  candidates.push(join(__dirname, '..', '..', 'bin'));
  candidates.push(join(process.cwd(), 'bin'));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // 都不存在时返回最可能的开发期路径，便于错误信息定位
  return join(__dirname, '..', '..', '..', 'bin');
}

let binDirCache: string | null = null;
export function binDir(): string {
  if (!binDirCache) binDirCache = resolveBinDir();
  return binDirCache;
}

export function adbPath(): string {
  const p = join(binDir(), process.platform === 'win32' ? 'adb.exe' : 'adb');
  return p;
}

export function scrcpyPath(): string {
  const p = join(binDir(), process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
  return p;
}

/**
 * 投屏窗口专用图标。
 *
 * 为什么需要它：scrcpy 默认从自己 exe 同目录读 `icon.png`（debug 日志里会打印
 * `Using icon (portable): ...\bin\icon.png`），而 `bin/icon.png` 是我们的应用
 * 图标 —— 于是投屏窗口和主窗口在任务栏里长得一模一样，分不清谁是谁。
 *
 * 解决：scrcpy 支持 `SCRCPY_ICON_PATH` 环境变量指定图标，指向单独的
 * `scrcpy-icon.png`（scrcpy 官方那个绿色机器人）。这样两个窗口图标就区分开了。
 */
export function scrcpyIconPath(): string | null {
  const names = ['scrcpy-icon.png', 'scrcpy.ico'];
  for (const n of names) {
    const p = join(binDir(), n);
    if (existsSync(p)) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 日志广播                                                            */
/* ------------------------------------------------------------------ */

type LogSink = (payload: {
  level: 'info' | 'success' | 'warn' | 'error' | 'command';
  source: string;
  message: string;
  detail?: string;
}) => void;

let logSink: LogSink | null = null;
export function setLogSink(sink: LogSink) {
  logSink = sink;
}

export function log(
  level: 'info' | 'success' | 'warn' | 'error' | 'command',
  source: string,
  message: string,
  detail?: string,
) {
  logSink?.({ level, source, message, detail });
}

/* ------------------------------------------------------------------ */
/* 核心执行器                                                          */
/* ------------------------------------------------------------------ */

export interface RunOptions {
  /** 超时毫秒，默认 30s */
  timeout?: number;
  /** 是否写入操作日志，默认 true */
  silent?: boolean;
  /** 日志来源标签 */
  source?: string;
  /** 是否禁用 adb server 自动启动 */
  noDaemonStart?: boolean;
}

/**
 * 执行 adb 命令
 * 统一入口，所有设备操作都经过这里，保证日志可追溯
 */
export function runAdb(args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return runBinary(adbPath(), args, { source: 'ADB', ...options });
}

/**
 * 执行任意二进制
 */
export function runBinary(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const { timeout = 30000, silent = false, source = 'ADB' } = options;
  const started = Date.now();

  const commandLine = `"${basename(file)}" ${args.map(quoteArg).join(' ')}`;

  if (!silent) {
    log('command', source, commandLine);
  }

  return new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;

    const child = spawn(file, args, {
      windowsHide: true,
      cwd: dirname(file),
    });

    const timer = setTimeout(() => {
      if (!finished) {
        stderr += `\n[超时] 命令执行超过 ${timeout}ms，已终止`;
        child.kill();
      }
    }, timeout);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      finished = true;
      clearTimeout(timer);
      const result: CommandResult = {
        ok: false,
        code: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        commandLine,
        duration: Date.now() - started,
      };
      if (!silent) {
        log('error', source, `执行失败：${err.message}`, result.stderr.trim());
      }
      resolve(result);
    });

    child.on('close', (code) => {
      finished = true;
      clearTimeout(timer);
      const result: CommandResult = {
        ok: code === 0,
        code,
        stdout,
        stderr,
        commandLine,
        duration: Date.now() - started,
      };
      if (!silent) {
        if (result.ok) {
          log('success', source, `完成（${result.duration}ms）`);
        } else {
          log('error', source, `失败（exit ${code}）`, (stderr || stdout).trim());
        }
      }
      resolve(result);
    });
  });
}

/**
 * 启动一个长驻子进程（scrcpy / 录屏 / monkey），返回句柄
 * 会注入 ADB 环境变量，确保 scrcpy 使用随包的 adb 而非系统里缺失/错误的版本。
 */
export function spawnBinary(
  file: string,
  args: string[],
  source: string,
  extraEnv?: NodeJS.ProcessEnv,
): ChildProcess {
  log('command', source, `"${basename(file)}" ${args.map(quoteArg).join(' ')}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // scrcpy 通过 ADB 环境变量定位 adb 可执行文件
    ADB: adbPath(),
    ...extraEnv,
  };

  const child = spawn(file, args, {
    // ⚠️ 绝对不要加 windowsHide: true。
    //
    // windowsHide 会在子进程 STARTUPINFO 里设置 STARTF_USESHOWWINDOW + SW_HIDE，
    // 这个"默认隐藏窗口"的首选项会被 scrcpy(SDL2) 继承：SDL_CreateWindow 之后
    // 调用 ShowWindow 时受该首选项影响而无效，结果是——
    //   scrcpy 进程存活、日志显示 "Renderer: direct3d" / "Texture: WxH" 渲染正常、
    //   窗口对象也被创建（有 HWND、尺寸位置都对），
    //   但 IsWindowVisible() 恒为 false，屏幕上和任务栏里都看不到窗口。
    // 该参数只适用于"不希望弹出控制台"的 CLI 程序（见 runBinary 里的用法），
    // GUI 程序必须让它自己决定窗口可见性。
    // 实测对照：windowsHide:false → 3s 内可见；windowsHide:true → 15s+ 仍不可见。
    cwd: dirname(file),
    env,
  });

  // ── 诊断开关：设置 ADB_DIAG=1 时，把子进程原始输出落盘，便于排查
  //    "进程存活但无窗口/无输出"类问题。生产环境不设置该变量。
  if (process.env.ADB_DIAG) {
    try {
      // 延迟 require，避免与 electron 主模块产生循环依赖
      const { app: electronApp } = require('electron') as typeof import('electron');
      const diagPath = join(electronApp.getPath('temp'), 'scrcpy-diag.log');
      const ds = createWriteStream(diagPath, { flags: 'a' });
      ds.write(
        `\n===== ${new Date().toISOString()} spawn ${basename(file)} pid=${child.pid}\n` +
          `cwd=${dirname(file)}\n` +
          `ADB=${env.ADB}\n` +
          `args=${args.join(' ')}\n`,
      );
      child.stdout?.pipe(ds, { end: false });
      child.stderr?.pipe(ds, { end: false });
      child.on('close', (code, signal) => ds.write(`===== close code=${code} signal=${signal}\n`));
      child.on('error', (e) => ds.write(`===== error ${e.message}\n`));
    } catch {
      /* 诊断失败不影响主流程 */
    }
  }

  // ★ 必须消费 stdout/stderr。
  //
  // spawn 默认 stdio:'pipe'。若不读取，子进程输出会填满管道缓冲区
  // （Windows 约 4KB），此后子进程每次写输出都会阻塞 —— scrcpy 会卡死在
  // 启动阶段，表现为：界面提示"投屏窗口已启动"、状态卡显示运行中，
  // 但投屏窗口始终不出现，且 getMirrorStatus 因进程未真正就绪而异常。
  //
  // 这里把输出转发到运行日志（截断单行长度，避免刷屏），并保留尾部
  // 200 行供排障使用。
  const TAIL_LIMIT = 200;
  const tail = (child as ChildProcess & { _tail?: string[] })._tail || [];
  (child as ChildProcess & { _tail?: string[] })._tail = tail;

  const pump = (stream: NodeJS.ReadableStream | null, level: 'info' | 'warn') => {
    if (!stream) return;
    let buf = '';
    stream.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        tail.push(t);
        if (tail.length > TAIL_LIMIT) tail.shift();
        // scrcpy 的输出较频繁，仅记录关键行，避免日志被刷爆
        if (/ERROR|WARN|error|failed|Exception|Device:|Renderer:|Texture:/i.test(t)) {
          log(level, source, t.slice(0, 300));
        }
      }
    });
    stream.on('error', () => {
      /* 忽略管道读取错误 */
    });
  };

  pump(child.stdout, 'info');
  pump(child.stderr, 'warn');

  return child;
}

function quoteArg(a: string): string {
  if (a === '') return '""';
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/* ------------------------------------------------------------------ */
/* 设备管理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 列出所有 adb 设备，并补齐型号/系统信息
 */
export async function listDevices(deep = true): Promise<DeviceInfo[]> {
  const res = await runAdb(['devices', '-l'], { source: '设备', timeout: 15000 });
  if (!res.ok && !res.stdout) {
    log('error', '设备', '无法获取设备列表，请检查 adb 是否可用', res.stderr.trim());
    return [];
  }

  const devices: DeviceInfo[] = [];
  const lines = res.stdout.split(/\r?\n/).slice(1);

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    const [serial, stateRaw, ...rest] = t.split(/\s+/);
    if (!serial) continue;

    const props: Record<string, string> = {};
    for (const kv of rest) {
      const idx = kv.indexOf(':');
      if (idx > 0) props[kv.slice(0, idx)] = kv.slice(idx + 1);
    }

    const state = normalizeState(stateRaw);
    const device: DeviceInfo = {
      serial,
      state,
      connection: /^\d+\.\d+\.\d+\.\d+/i.test(serial) || serial.includes(':') ? 'tcp' : 'usb',
      model: props['model'],
      product: props['product'],
      device: props['device'],
      isEmulator: /emulator|sdk_gphone|vbox/i.test(props['model'] || serial),
    };

    devices.push(device);
  }

  // 在线设备补齐 Android 版本等（并发获取）
  if (deep) {
    const online = devices.filter((d) => d.state === 'device');
    await Promise.all(
      online.map(async (d) => {
        const info = await getDeviceProps(d.serial);
        Object.assign(d, info);
      }),
    );
  }

  return devices;
}

function normalizeState(s: string): DeviceInfo['state'] {
  switch (s) {
    case 'device':
      return 'device';
    case 'offline':
      return 'offline';
    case 'unauthorized':
      return 'unauthorized';
    case 'bootloader':
      return 'bootloader';
    case 'recovery':
      return 'recovery';
    default:
      return 'unknown';
  }
}

/**
 * 批量读取设备属性（一次 shell 调用，快）
 */
async function getDeviceProps(serial: string): Promise<Partial<DeviceInfo>> {
  const res = await runAdb(
    [
      '-s',
      serial,
      'shell',
      'getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.name; getprop ro.product.device',
    ],
    { silent: true, timeout: 10000 },
  );
  const lines = res.stdout.split(/\r?\n/).map((x) => x.trim());
  const sdk = parseInt(lines[3] || '', 10);

  return {
    brand: lines[0] || undefined,
    model: lines[1] || undefined,
    androidVersion: lines[2] || undefined,
    sdk: Number.isFinite(sdk) ? sdk : undefined,
    product: lines[4] || undefined,
    device: lines[5] || undefined,
    isEmulator: /emulator|sdk_gphone|vbox/i.test((lines[1] || '') + serial),
  };
}

/**
 * 检查指定设备是否在线，可抛出友好错误
 */
export async function ensureDevice(serial?: string): Promise<string> {
  const devices = await listDevices(false);
  const online = devices.filter((d) => d.state === 'device');

  if (online.length === 0) {
    throw new Error(
      devices.some((d) => d.state === 'unauthorized')
        ? '设备未授权，请在手机屏幕上点击「允许 USB 调试」'
        : '未检测到可用设备，请连接手机并开启 USB 调试',
    );
  }

  if (serial) {
    const found = online.find((d) => d.serial === serial);
    if (!found) throw new Error(`设备 ${serial} 不在线`);
    return serial;
  }

  return online[0].serial;
}

/* ------------------------------------------------------------------ */
/* ADB Server 控制                                                     */
/* ------------------------------------------------------------------ */

export async function adbStartServer(): Promise<CommandResult> {
  return runAdb(['start-server'], { source: 'ADB服务', timeout: 20000 });
}

export async function adbKillServer(): Promise<CommandResult> {
  return runAdb(['kill-server'], { source: 'ADB服务', timeout: 15000 });
}

/* ------------------------------------------------------------------ */
/* 目录工具                                                            */
/* ------------------------------------------------------------------ */

export function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function newId(): string {
  return randomUUID();
}
