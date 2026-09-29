import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { log } from './adb';
import type { LogEntry } from '../../shared/types';

/**
 * 会话日志：内存环形缓冲（供界面实时查看）+ 按日期落盘的本地文件。
 *
 * 内存上限 5000 条，避免长时间运行内存膨胀；
 * 文件落在 <userData>/logs/YYYY-MM-DD.log，**只保留最近 24 小时**（见 cleanupLogs）。
 */
const MAX_ENTRIES = 5000;

/** 日志保留时长：24 小时。超过的文件直接删，文件内超期行也一并裁掉 */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** 行首时间戳，用于裁剪文件内过期行 —— 格式必须与 formatTime 的输出一致 */
const LINE_TS = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/;

const entries: LogEntry[] = [];

type PushSink = (entry: LogEntry) => void;
let pushSink: PushSink | null = null;

export function setLogPushSink(sink: PushSink) {
  pushSink = sink;
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

let logDirCache: string | null = null;

/**
 * 日志目录：<userData>/logs。
 *
 * 惰性取 app.getPath —— logger 在部分自检脚本里会先于 app ready 被 require，
 * 模块顶层直接调会拿到空路径。
 */
export function getLogDir(): string {
  if (logDirCache) return logDirCache;
  const dir = join(app.getPath('userData'), 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  logDirCache = dir;
  return dir;
}

function fileFor(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return join(getLogDir(), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

function appendToFile(entry: LogEntry): void {
  try {
    const lines = [
      `[${formatTime(entry.time)}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`,
    ];
    if (entry.detail) {
      for (const dl of entry.detail.split(/\r?\n/)) lines.push(`    ${dl}`);
    }
    appendFileSync(fileFor(entry.time), lines.join('\r\n') + '\r\n', 'utf8');
  } catch {
    // 落盘失败不能影响主流程（磁盘满 / 目录被占用等），静默降级为「只有内存日志」
  }
}

/** 把文件里超过 24 小时的行裁掉（只保留末尾未超期的部分） */
function trimFile(file: string, now: number): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const cutoff = now - RETENTION_MS;
  const lines = text.split(/\r?\n/);

  let keepFrom: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_TS.exec(lines[i]);
    if (m) {
      const t = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
        Number(m[7]),
      ).getTime();
      if (t >= cutoff) {
        keepFrom = i;
        break;
      }
    }
  }

  if (keepFrom === null) {
    // 整份都是过期行 → 清空（空文件不碍事，下次启动按 mtime 会被删掉）
    if (lines.some((l) => l.trim())) {
      try {
        writeFileSync(file, '', 'utf8');
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (keepFrom === 0) return; // 没有过期行，不动文件

  try {
    writeFileSync(file, lines.slice(keepFrom).join('\r\n'), 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * 启动时调用：建目录 + 清理超过 24 小时的日志文件与文件内的过期行。
 * 返回值供日志与自检脚本使用。
 */
export function cleanupLogs(now = Date.now()): { removed: string[]; trimmed: string[] } {
  const removed: string[] = [];
  const trimmed: string[] = [];

  let dir: string;
  try {
    dir = getLogDir();
  } catch {
    return { removed, trimmed };
  }

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { removed, trimmed };
  }

  for (const f of files) {
    if (!f.endsWith('.log')) continue;
    const full = join(dir, f);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > RETENTION_MS) {
      try {
        unlinkSync(full);
        removed.push(f);
      } catch {
        /* 被占用就留到下次启动再清 */
      }
      continue;
    }
    trimFile(full, now);
    trimmed.push(f);
  }

  return { removed, trimmed };
}

/* ------------------------------------------------------------------ */
/* 写入 / 读取                                                          */
/* ------------------------------------------------------------------ */

export function addLog(
  level: LogEntry['level'],
  source: string,
  message: string,
  detail?: string,
): LogEntry {
  const entry: LogEntry = {
    id: randomUUID(),
    time: Date.now(),
    level,
    source,
    message,
    detail,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  appendToFile(entry);
  pushSink?.(entry);
  return entry;
}

export function getLogs(): LogEntry[] {
  return [...entries];
}

export function clearLogs(): void {
  entries.length = 0;
}

/**
 * 导出日志为 UTF-8 文本
 */
export function exportLogs(filePath: string, header?: Record<string, string>): {
  path: string;
  bytes: number;
  lines: number;
} {
  const now = new Date();
  const lines: string[] = [];

  lines.push('='.repeat(72));
  lines.push('  ADB 桌面助手 - 操作日志');
  lines.push('='.repeat(72));
  lines.push(`导出时间：${formatTime(now.getTime())}`);
  if (header) {
    for (const [k, v] of Object.entries(header)) {
      lines.push(`${k}：${v}`);
    }
  }
  lines.push(`日志条数：${entries.length}`);
  lines.push('-'.repeat(72));
  lines.push('');

  for (const e of entries) {
    lines.push(`[${formatTime(e.time)}] [${e.level.toUpperCase().padEnd(7)}] [${e.source}] ${e.message}`);
    if (e.detail) {
      for (const dl of e.detail.split(/\r?\n/)) {
        lines.push(`    ${dl}`);
      }
    }
  }

  lines.push('');
  lines.push('-'.repeat(72));
  lines.push('日志结束');

  const content = lines.join('\r\n');
  writeFileSync(filePath, '\ufeff' + content, 'utf8');

  const bytes = Buffer.byteLength(content, 'utf8');
  return { path: filePath, bytes, lines: lines.length };
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
