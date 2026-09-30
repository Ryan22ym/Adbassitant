import { spawn, ChildProcess, execFile } from 'child_process';
import { existsSync, mkdirSync, statSync, createWriteStream } from 'fs';
import { join, dirname, basename } from 'path';
import { randomUUID } from 'crypto';
import type { CommandResult, DeviceDetail, DeviceInfo } from '../../shared/types';

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
      isEmulator: looksLikeEmulator(
        serial,
        props['model'],
        props['product'],
        props['device'],
      ),
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
 * 判断一台设备是不是模拟器。
 *
 * ⚠️ 只看 `model` 是不行的：常见的模拟器（雷电 / MuMu / AOSP 定制镜像）会把
 * model 伪装成真机型号（我们的两个模拟器就报 `PGT_AN00` / `SM_S9210`），
 * 于是模拟器被判成「手机」，界面上「手机 / 模拟器」标签错误、
 * 「默认优先物理设备」这类按 isEmulator 做的决策全部失效。
 *
 * 所以：serial 前缀是硬判据（AOSP 模拟器固定 `emulator-xxxx`），
 * 其余字段只做补充。
 */
function looksLikeEmulator(serial: string, ...fields: (string | undefined)[]): boolean {
  if (/^emulator-/i.test(serial)) return true;
  const text = fields.filter(Boolean).join(' ');
  return /emulator|sdk_gphone|vbox|genymotion|bluestacks|nox_|mumu|ldplayer|microvirt|andyos/i.test(
    text,
  );
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
    isEmulator: looksLikeEmulator(serial, lines[0], lines[1], lines[4], lines[5]),
  };
}

/**
 * 设备详情（「设备详情」卡片用）：品牌 / 型号 / 系统版本 / 分辨率 / CPU / GPU / 内存。
 *
 * 一次 shell 调用把全部采样串起来（设备端只跑一趟，比多次 adb 往返明显快），
 * 各段用 `__XXX__` 标记分隔 —— 某一段失败不会影响其它段。
 *
 * 采集口径（真机 OPPO / Android 10 + AOSP 模拟器 / Android 12 实测）：
 *   · 屏幕：`wm size` 的 Physical size；被 override 过时附上物理值
 *   · CPU ：ro.soc.model（Android 12+）→ /proc/cpuinfo 的 Hardware（ARM 真机常见）
 *           → model name（x86 / 模拟器）→ ro.board.platform（兜底，如 trinket）
 *   · GPU ：`dumpsys SurfaceFlinger` 的 `GLES: <vendor>, <renderer>, OpenGL ES ...`
 *           → 取 renderer 段；拿不到再退 ro.hardware.egl（adreno / mali）
 *
 * ⚠️ 这里不再读电量 / buildId / 设备代号：电量随时在变、后两个日常用不上。
 */
export async function getDeviceDetail(serial: string): Promise<DeviceDetail> {
  const [props, mem] = await Promise.all([
    runAdb(
      [
        '-s',
        serial,
        'shell',
        'echo __PROPS__; ' +
          'getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release; ' +
          'getprop ro.build.version.sdk; getprop ro.serialno; getprop ro.product.name; ' +
          'getprop ro.soc.model; getprop ro.board.platform; getprop ro.hardware.egl; ' +
          'echo __CPU__; cat /proc/cpuinfo | grep -i -e Hardware -e model; ' +
          'echo __GPU__; dumpsys SurfaceFlinger | grep -i GLES; ' +
          'echo __SIZE__; wm size',
      ],
      { silent: true, timeout: 20000 },
    ),
    runAdb(['-s', serial, 'shell', 'cat', '/proc/meminfo'], { silent: true, timeout: 10000 }),
  ]);

  const sec = splitSections(props.stdout, ['PROPS', 'CPU', 'GPU', 'SIZE']);
  const p = (sec.PROPS ?? '').split(/\r?\n/).map((x) => x.trim());

  const memTotal = mem.stdout.match(/MemTotal:\s*(\d+)/)?.[1];
  const memAvail = mem.stdout.match(/MemAvailable:\s*(\d+)/)?.[1];

  return {
    brand: p[0] || undefined,
    model: p[1] || undefined,
    androidVersion: p[2] || undefined,
    sdk: parseInt(p[3], 10) || undefined,
    serialno: p[4] || undefined,
    product: p[5] || undefined,
    cpu: parseCpuModel(sec.CPU ?? '', p[6], p[7]),
    gpu: parseGpuModel(sec.GPU ?? '', p[8]),
    resolution: parseResolution(sec.SIZE ?? ''),
    memTotalKB: memTotal ? parseInt(memTotal, 10) : undefined,
    memAvailKB: memAvail ? parseInt(memAvail, 10) : undefined,
  };
}

/**
 * 按 `__TAG__` 把一段 shell 输出切成多段。
 *
 * ⚠️ 必须逐个 indexOf 再取「下一个标记之前」—— 用 split 的正则在设备端输出
 * 混入 `\r`（adb 在 Windows 上是 CRLF）时会漏匹配，切出来整段错位。
 */
function splitSections(text: string, tags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const marks = tags.map((t) => `__${t}__`);
  const at = marks.map((m) => text.indexOf(m));

  for (let i = 0; i < tags.length; i++) {
    if (at[i] < 0) continue;
    const from = at[i] + marks[i].length;
    let to = text.length;
    for (let j = 0; j < tags.length; j++) {
      if (j !== i && at[j] > from && at[j] < to) to = at[j];
    }
    out[tags[i]] = text.slice(from, to).trim();
  }
  return out;
}

/** CPU 型号：优先 SoC 型号，其次 cpuinfo 的 Hardware / model name，最后退芯片平台代号 */
function parseCpuModel(cpuInfoOut: string, socModel?: string, board?: string): string | undefined {
  const hw = cpuInfoOut.match(/^Hardware\s*:\s*(.+)$/im)?.[1]?.trim();
  const modelName = cpuInfoOut.match(/^model name\s*:\s*(.+)$/im)?.[1]?.trim();

  const raw = socModel?.trim() || hw || modelName || board?.trim();
  if (!raw) return undefined;

  // "Qualcomm Technologies, Inc SDM665" → "Qualcomm SDM665"
  return raw
    .replace(/,\s*Inc\.?/i, '')
    .replace(/\bTechnologies\b/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** GPU 型号：从 SurfaceFlinger 的 GLES 行取 renderer，取不到退 ro.hardware.egl */
function parseGpuModel(glesOut: string, eglProp?: string): string | undefined {
  const line = glesOut.match(/GLES:\s*(.+)/i)?.[1]?.split('\n')[0]?.trim();
  if (line) {
    // "Qualcomm, Adreno (TM) 610, OpenGL ES 3.2 V@..." → 取中间那段 renderer
    const segs = line.split(',').map((s) => s.trim()).filter(Boolean);
    const name = (segs.length >= 2 ? segs[1] : segs[0])?.replace(/\s*OpenGL.*$/i, '').trim();
    if (name) return name;
  }
  const egl = eglProp?.trim();
  if (egl) return egl.charAt(0).toUpperCase() + egl.slice(1);
  return undefined;
}

/** 分辨率：以物理分辨率为主，被临时改过时把当前值与物理值一起给出 */
function parseResolution(sizeOut: string): string | undefined {
  const phys = sizeOut.match(/Physical size:\s*(\d+x\d+)/i)?.[1];
  const over = sizeOut.match(/Override size:\s*(\d+x\d+)/i)?.[1];
  if (phys && over && over !== phys) return `${over}（物理 ${phys}）`;
  return phys ?? over;
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
