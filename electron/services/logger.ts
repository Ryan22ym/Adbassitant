import { writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { log } from './adb';
import type { LogEntry } from '../../shared/types';

/**
 * 会话日志：内存环形缓冲 + 一键导出
 * 上限 5000 条，避免长时间运行内存膨胀
 */
const MAX_ENTRIES = 5000;
const entries: LogEntry[] = [];

type PushSink = (entry: LogEntry) => void;
let pushSink: PushSink | null = null;

export function setLogPushSink(sink: PushSink) {
  pushSink = sink;
}

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

  lines.push('=' .repeat(72));
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
