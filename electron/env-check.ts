import { app } from 'electron';
import { existsSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import {
  adbPath,
  scrcpyPath,
  binDir,
  listDevices,
  runAdb,
  adbStartServer,
  adbKillServer,
  ensureDevice,
  log,
} from './services/adb';
import type { EnvCheckResult, EnvCheckItem } from '../shared/types';

/* ------------------------------------------------------------------ */
/* 环境自检                                                            */
/* ------------------------------------------------------------------ */

export async function checkEnv(): Promise<EnvCheckResult> {
  const items: EnvCheckItem[] = [];

  /* adb */
  const adb = adbPath();
  if (!existsSync(adb)) {
    items.push({ name: 'adb', ok: false, message: `未找到：${adb}` });
  } else {
    try {
      const res = await runAdb(['version'], { silent: true, timeout: 8000 });
      const first = res.stdout.split(/\r?\n/)[0] || '';
      const ver = first.match(/version\s+([\d.]+)/i)?.[1];
      items.push({
        name: 'adb',
        ok: res.ok,
        path: adb,
        version: ver,
        message: res.ok ? undefined : res.stderr.trim(),
      });
    } catch (e) {
      items.push({ name: 'adb', ok: false, path: adb, message: (e as Error).message });
    }
  }

  /* scrcpy */
  const scrcpy = scrcpyPath();
  if (!existsSync(scrcpy)) {
    items.push({ name: 'scrcpy', ok: false, message: `未找到：${scrcpy}` });
  } else {
    try {
      const res = await runBinarySafe(scrcpy, ['--version']);
      const text = res.stdout || res.stderr;
      const ver = text.match(/scrcpy\s+([\d.]+)/i)?.[1];
      items.push({
        name: 'scrcpy',
        ok: true,
        path: scrcpy,
        version: ver,
        message: ver ? undefined : '已找到（版本号解析失败）',
      });
    } catch (e) {
      // scrcpy --version 有时返回非 0，只要有输出就算可用
      items.push({ name: 'scrcpy', ok: existsSync(scrcpy), path: scrcpy, message: (e as Error).message });
    }
  }

  /* scrcpy-server */
  const server = join(binDir(), 'scrcpy-server');
  items.push({
    name: 'scrcpy-server',
    ok: existsSync(server),
    path: server,
    message: existsSync(server) ? undefined : '缺失，投屏将无法启动',
  });

  /* 关键 DLL（Windows） */
  if (process.platform === 'win32') {
    const dlls = ['AdbWinApi.dll', 'AdbWinUsbApi.dll'];
    for (const d of dlls) {
      const p = join(binDir(), d);
      items.push({ name: d, ok: existsSync(p), path: p });
    }
  }

  const allOk = items.every((i) => i.ok);
  return { items, allOk };
}

function runBinarySafe(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return Promise.resolve({ stdout: r.stdout || '', stderr: r.stderr || '' });
}

/* ------------------------------------------------------------------ */
/* 路径辅助                                                            */
/* ------------------------------------------------------------------ */

export function defaultScreenshotName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `screenshot_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

export function validateLocalFile(p: string, allowedExt?: string[]): void {
  if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
  const st = statSync(p);
  if (st.isDirectory()) throw new Error('这是一个目录，不是文件');
  if (allowedExt) {
    const ext = extname(p).toLowerCase();
    if (!allowedExt.includes(ext)) {
      throw new Error(`文件类型不支持，需要 ${allowedExt.join(' / ')}`);
    }
  }
}

export { basename };
