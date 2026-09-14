import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  runAdb,
  ensureDevice,
  ensureDir,
  log,
  newId,
  fileSize,
  adbPath,
  scrcpyPath,
  spawnBinary,
} from './adb';
import type { ScreenResolution } from '../../shared/types';

/* ------------------------------------------------------------------ */
/* 分辨率                                                              */
/* ------------------------------------------------------------------ */

const SIZE_RE = /(\d+)x(\d+)/;

/**
 * 读取设备分辨率与密度
 * wm size 输出示例：
 *   Physical size: 1080x2400
 *   Override size: 720x1600
 */
export async function getResolution(serial?: string): Promise<ScreenResolution> {
  const s = await ensureDevice(serial);

  const [sizeRes, densityRes] = await Promise.all([
    runAdb(['-s', s, 'shell', 'wm', 'size'], { source: '分辨率', silent: true }),
    runAdb(['-s', s, 'shell', 'wm', 'density'], { source: '分辨率', silent: true }),
  ]);

  let physical = '';
  let override: string | undefined;
  for (const line of sizeRes.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (/physical/i.test(t)) {
      const m = t.match(SIZE_RE);
      if (m) physical = m[0];
    } else if (/override/i.test(t)) {
      const m = t.match(SIZE_RE);
      if (m) override = m[0];
    }
  }

  let density: number | undefined;
  let densityOverride: number | undefined;
  for (const line of densityRes.stdout.split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(/(\d+)/);
    if (/physical/i.test(t) && m) density = parseInt(m[1], 10);
    else if (/override/i.test(t) && m) densityOverride = parseInt(m[1], 10);
  }

  log('success', '分辨率', `当前分辨率 ${override || physical}${densityOverride ? ` / ${densityOverride} dpi` : ''}`);

  return {
    physical,
    override,
    current: override || physical,
    density,
    densityOverride,
  };
}

/**
 * 设置分辨率 / 密度
 */
export async function setSize(
  serial: string | undefined,
  size?: string,
  dpi?: number,
): Promise<string> {
  const s = await ensureDevice(serial);
  const notes: string[] = [];

  if (size) {
    const res = await runAdb(['-s', s, 'shell', 'wm', 'size', size], { source: '分辨率' });
    if (!res.ok) throw new Error(res.stderr.trim() || '设置分辨率失败');
    notes.push(`分辨率 → ${size}`);
  }
  if (dpi) {
    const res = await runAdb(['-s', s, 'shell', 'wm', 'density', String(dpi)], { source: '分辨率' });
    if (!res.ok) throw new Error(res.stderr.trim() || '设置密度失败');
    notes.push(`密度 → ${dpi}`);
  }
  if (notes.length === 0) throw new Error('未指定要修改的项');

  return notes.join('，');
}

/**
 * 恢复默认分辨率与密度
 */
export async function resetSize(serial?: string): Promise<void> {
  const s = await ensureDevice(serial);
  await runAdb(['-s', s, 'shell', 'wm', 'size', 'reset'], { source: '分辨率' });
  await runAdb(['-s', s, 'shell', 'wm', 'density', 'reset'], { source: '分辨率' });
  log('success', '分辨率', '已恢复默认分辨率与密度');
}

/* ------------------------------------------------------------------ */
/* 截图                                                                */
/* ------------------------------------------------------------------ */

const DEVICE_SHOT_PATH = '/sdcard/.adbtool_shot.png';

export interface ScreenshotResult {
  /** 本地保存路径 */
  localPath: string;
  /** 文件大小（字节） */
  size: number;
  /** 耗时 */
  duration: number;
}

/**
 * 截图：exec-out 直出二进制，比 screencap + pull 快且不占设备存储
 */
export async function captureScreen(
  serial: string | undefined,
  saveDir: string,
  fileName?: string,
): Promise<ScreenshotResult> {
  const s = await ensureDevice(serial);
  ensureDir(saveDir);

  const started = Date.now();
  const name = fileName || `screenshot_${timestamp()}.png`;
  const localPath = join(saveDir, name);

  log('info', '截图', `正在截取 ${s} 的屏幕…`);

  const buffer = await execOutBinary(s, ['exec-out', 'screencap', '-p']);

  if (!buffer || buffer.length === 0) {
    throw new Error('截图返回空数据，设备可能处于息屏或异常状态');
  }

  const { writeFileSync } = await import('fs');
  writeFileSync(localPath, buffer);

  const size = fileSize(localPath);
  const duration = Date.now() - started;
  log('success', '截图', `已保存 ${name}（${formatSize(size)}，${duration}ms）`, localPath);

  return { localPath, size, duration };
}

/**
 * 备用截图路径：screencap 到设备再 pull（exec-out 不可用时）
 */
export async function captureScreenFallback(
  serial: string | undefined,
  saveDir: string,
): Promise<ScreenshotResult> {
  const s = await ensureDevice(serial);
  ensureDir(saveDir);
  const started = Date.now();

  await runAdb(['-s', s, 'shell', 'screencap', '-p', DEVICE_SHOT_PATH], { source: '截图' });
  const name = `screenshot_${timestamp()}.png`;
  const localPath = join(saveDir, name);
  const res = await runAdb(['-s', s, 'pull', DEVICE_SHOT_PATH, localPath], { source: '截图' });
  await runAdb(['-s', s, 'shell', 'rm', '-f', DEVICE_SHOT_PATH], { source: '截图', silent: true });

  if (!res.ok) throw new Error(res.stderr.trim() || '截图拉取失败');

  const size = fileSize(localPath);
  log('success', '截图', `已保存 ${name}（${formatSize(size)}）`, localPath);
  return { localPath, size, duration: Date.now() - started };
}

/**
 * exec-out 获取二进制流
 */
function execOutBinary(serial: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath(), ['-s', serial, ...args], { windowsHide: true });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];

    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', (d: Buffer) => errs.push(d));
    child.on('error', reject);
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      // 某些设备在 exec-out 下会把 CRLF 混入，PNG 头校验
      if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
        resolve(buf);
      } else {
        reject(new Error(Buffer.concat(errs).toString('utf8').trim() || '截图数据异常'));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* 录屏                                                                */
/* ------------------------------------------------------------------ */

export interface RecordHandle {
  id: string;
  serial: string;
  localPath: string;
  devicePath: string;
  startedAt: number;
  duration: number;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

const activeRecords = new Map<string, RecordHandle>();

/**
 * 开始录屏：优先设备端 screenrecord；若设备未内置该二进制（部分厂商 ROM 精简），
 * 自动回退到 scrcpy 录制通道。
 */
export async function startRecord(
  serial: string | undefined,
  saveDir: string,
  durationSec: number,
  bitRateMbps = 8,
  sizePx?: number,
  audio = false,
): Promise<RecordHandle> {
  const s = await ensureDevice(serial);
  ensureDir(saveDir);

  const id = newId();
  const startedAt = Date.now();
  const localPath = join(saveDir, `screenrecord_${timestamp()}.mp4`);

  // 探测设备端 screenrecord 是否可用
  const probe = await runAdb(['-s', s, 'shell', 'which', 'screenrecord'], {
    silent: true,
    timeout: 8000,
  });
  const hasScreenRecord =
    probe.ok && !/not found|inaccessible|^\s*$/i.test(probe.stdout.trim());

  if (!hasScreenRecord) {
    log('warn', '录屏', '设备未内置 screenrecord，自动改用投屏录制通道');
    return startScrcpyRecord(s, id, localPath, startedAt, durationSec, bitRateMbps, sizePx);
  }

  const devicePath = `/sdcard/.adbtool_rec_${id.slice(0, 8)}.mp4`;

  const args = [
    '-s',
    s,
    'shell',
    'screenrecord',
    '--bit-rate',
    `${bitRateMbps * 1000 * 1000}`,
    '--time-limit',
    String(durationSec),
  ];
  if (sizePx) args.push('--size', `${sizePx}x${sizePx}`);
  if (audio) args.push('--audio');
  args.push(devicePath);

  const child = spawnBinary(adbPath(), args, '录屏');

  let running = true;
  child.on('close', () => {
    running = false;
  });

  const handle: RecordHandle = {
    id,
    serial: s,
    localPath,
    devicePath,
    startedAt,
    duration: durationSec,
    isRunning: () => running,
    stop: async () => {
      if (running) {
        // screenrecord 收到 SIGINT 会正常收尾 MP4
        try {
          child.kill('SIGINT');
        } catch {
          /* ignore */
        }
        // Windows 下 kill 可能无效，走设备侧收尾
        await wait(600);
        if (handle.isRunning()) {
          await runAdb(
            ['-s', s, 'shell', 'pkill', '-l', '-2', 'screenrecord'],
            { source: '录屏', silent: true },
          );
        }
        await wait(900);
      }
      running = false;

      log('info', '录屏', '正在从设备拉取视频…');
      // 本地路径转正斜杠，规避旧版 adb 对反斜杠的转义处理
      const res = await runAdb(['-s', s, 'pull', devicePath, localPath.replace(/\\/g, '/')], {
        source: '录屏',
      });
      await runAdb(['-s', s, 'shell', 'rm', '-f', devicePath], {
        source: '录屏',
        silent: true,
      });

      if (!res.ok || !existsSync(localPath)) {
        throw new Error(res.stderr.trim() || '录屏文件拉取失败');
      }

      const size = fileSize(localPath);
      log('success', '录屏', `已保存（${formatSize(size)}）`, localPath);
      activeRecords.delete(id);
      return;
    },
  };

  activeRecords.set(id, handle);
  log('info', '录屏', `开始录制，时长 ${durationSec}s${sizePx ? `，缩放到 ${sizePx}p` : ''}`);
  return handle;
}

/**
 * 用 scrcpy 录制通道实现的设备录屏（screenrecord 不可用时的回退方案）
 */
async function startScrcpyRecord(
  s: string,
  id: string,
  localPath: string,
  startedAt: number,
  durationSec: number,
  bitRateMbps: number,
  sizePx?: number,
): Promise<RecordHandle> {
  const args = [
    '-s',
    s,
    '--record',
    localPath.replace(/\\/g, '/'),
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

  const child = spawnBinary(scrcpyPath(), args, '录屏');

  let running = true;
  let done = false;

  const handle: RecordHandle = {
    id,
    serial: s,
    localPath,
    devicePath: '(scrcpy)',
    startedAt,
    duration: durationSec,
    isRunning: () => running,
    stop: async () => {
      if (!running) return;
      // 等 scrcpy 自行收尾（--time-limit），最多再等 8s
      for (let i = 0; i < 16 && running; i++) await wait(500);
      if (running) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        await wait(1200);
      }
      running = false;
      if (!existsSync(localPath) || fileSize(localPath) === 0) {
        throw new Error('录屏文件未生成或为空');
      }
      log('success', '录屏', `已保存（${formatSize(fileSize(localPath))}）`, localPath);
      activeRecords.delete(id);
    },
  };

  child.on('close', () => {
    running = false;
    done = true;
  });
  child.on('error', () => {
    running = false;
  });

  activeRecords.set(id, handle);
  log('info', '录屏', `开始录制（scrcpy 通道），时长 ${durationSec}s`);
  void done;
  return handle;
}

export function getRecord(id: string): RecordHandle | undefined {
  return activeRecords.get(id);
}

export function listRecords(): RecordHandle[] {
  return Array.from(activeRecords.values());
}

export function removeRecord(id: string) {
  activeRecords.delete(id);
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

export function timestamp(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
