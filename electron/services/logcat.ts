import { writeFileSync } from 'fs';
import type { ChildProcess } from 'child_process';
import { spawnBinary, adbPath, ensureDevice, log } from './adb';
import type { LogcatFilter, LogcatLevel, LogcatLine, LogcatStatus } from '../../shared/types';

/**
 * 实时 Logcat 服务
 *
 * 实现要点：
 * - 用 `adb logcat -v threadtime` 拉流，threadtime 是唯一同时带
 *   「日期 时间 PID TID 级别 TAG」的格式，便于结构化解析。
 * - 子进程通过 spawnBinary 启动，stdout/stderr 必须消费（否则管道写满会阻塞）。
 * - 行数据按批次推送给渲染进程（默认 120ms 一批），避免高频 IPC 打满主线程。
 * - 主进程侧保留环形缓冲，随时可导出为 txt，不依赖渲染进程是否在前台。
 */

const LEVEL_ORDER: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };

/** threadtime 行格式：
 *  09-11 17:58:07.123  1234  1250 I ActivityManager: Start proc ... */
const THREADTIME_RE =
  /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?)\s*:\s?(.*)$/;

/** 无年份的 threadtime 时间，跨年时 -v year 会多一列，这里也兼容 year 模式 */
const THREADTIME_YEAR_RE =
  /^(\d{4})-(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?)\s*:\s?(.*)$/;

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

interface Session {
  serial: string;
  child: ChildProcess;
  startedAt: number;
  filter: LogcatFilter;
  /** 原始行环形缓冲（用于导出） */
  buffer: string[];
  /** 待推送批次 */
  pending: LogcatLine[];
  flushTimer: NodeJS.Timeout | null;
  seq: number;
  /** stderr 里的提示（例如权限问题） */
  stderrTail: string[];
}

const MAX_BUFFER = 20000;
const FLUSH_INTERVAL = 120;

let session: Session | null = null;

type LinesSink = (lines: LogcatLine[]) => void;
type StatusSink = (status: LogcatStatus) => void;

let linesSink: LinesSink | null = null;
let statusSink: StatusSink | null = null;

export function setLogcatLinesSink(sink: LinesSink) {
  linesSink = sink;
}

export function setLogcatStatusSink(sink: StatusSink) {
  statusSink = sink;
}

function emitStatus() {
  statusSink?.(getLogcatStatus());
}

export function getLogcatStatus(): LogcatStatus {
  if (!session) return { running: false, lines: 0 };
  return {
    running: true,
    serial: session.serial,
    pid: session.child.pid,
    startedAt: session.startedAt,
    lines: session.seq,
    filter: session.filter,
  };
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

const DEFAULT_FILTER: LogcatFilter = {
  minLevel: 'V',
  buffers: ['main', 'system', 'crash'],
};

export async function startLogcat(
  serial: string | undefined,
  filter?: Partial<LogcatFilter>,
): Promise<LogcatStatus> {
  const s = await ensureDevice(serial);

  if (session) {
    if (session.serial === s) {
      log('info', 'Logcat', '已在运行中，忽略重复启动');
      return getLogcatStatus();
    }
    await stopLogcat();
  }

  const merged: LogcatFilter = { ...DEFAULT_FILTER, ...filter };
  const buffers = (merged.buffers || DEFAULT_FILTER.buffers || ['main']).filter(Boolean);
  if (buffers.length === 0) buffers.push('main');

  // 先清空一次，让用户从"当下"开始看；失败不阻塞（部分 ROM 权限受限）
  await clearDeviceLog(s, buffers);

  const args = ['-s', s, 'logcat', '-v', 'threadtime'];
  for (const b of buffers) {
    args.push('-b', b);
  }
  // 设备端尽量把级别下推到 logcat，减少传输量
  if (merged.minLevel && merged.minLevel !== 'V') {
    args.push(`${merged.minLevel}*:S`);
  }

  const child = spawnBinary(adbPath(), args, 'Logcat');

  const sess: Session = {
    serial: s,
    child,
    startedAt: Date.now(),
    filter: merged,
    buffer: [],
    pending: [],
    flushTimer: null,
    seq: 0,
    stderrTail: [],
  };
  session = sess;

  const handleChunk = (data: Buffer) => {
    const text = data.toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.replace(/\r$/, '');
      if (!t) continue;
      onRawLine(sess, t);
    }
  };

  child.stdout?.on('data', handleChunk);
  child.stderr?.on('data', handleChunk);

  child.on('error', (err) => {
    log('error', 'Logcat', `进程启动失败：${err.message}`);
    if (session === sess) {
      session = null;
      emitStatus();
    }
  });

  child.on('close', (code) => {
    if (sess.stderrTail.length) {
      log('warn', 'Logcat', sess.stderrTail.slice(-3).join(' / '));
    }
    if (session === sess) {
      session = null;
      flush(sess);
      log('info', 'Logcat', `已停止（exit ${code}）`);
      emitStatus();
    }
  });

  log('info', 'Logcat', `开始抓取 [${buffers.join(',')}] >=${merged.minLevel}`);
  emitStatus();
  return getLogcatStatus();
}

export async function stopLogcat(): Promise<boolean> {
  const sess = session;
  if (!sess) return false;
  session = null;

  if (sess.flushTimer) {
    clearTimeout(sess.flushTimer);
    sess.flushTimer = null;
  }
  flush(sess);

  try {
    sess.child.kill();
  } catch {
    /* 忽略 */
  }
  emitStatus();
  return true;
}

async function clearDeviceLog(serial: string, buffers: string[]) {
  // adb logcat -c 只清 main，其它缓冲区需要分别清
  const { runAdb } = await import('./adb');
  for (const b of buffers) {
    if (b === 'all') continue;
    try {
      await runAdb(['-s', serial, 'logcat', '-b', b, '-c'], {
        silent: true,
        timeout: 8000,
      });
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 解析与过滤                                                          */
/* ------------------------------------------------------------------ */

function onRawLine(sess: Session, raw: string) {
  // logcat 自身的一些提示行（如 "--------- beginning of main"）原样保留
  const parsed = parseLine(raw);

  if (!passes(sess.filter, parsed, raw)) return;

  sess.seq += 1;
  const line: LogcatLine = { seq: sess.seq, ...parsed, raw };

  sess.buffer.push(raw);
  if (sess.buffer.length > MAX_BUFFER) {
    sess.buffer.splice(0, sess.buffer.length - MAX_BUFFER);
  }

  sess.pending.push(line);
  // 单批上限，极端刷屏时丢弃中间部分（保留最新）
  if (sess.pending.length > 4000) {
    sess.pending.splice(0, sess.pending.length - 4000);
  }
  if (!sess.flushTimer) {
    sess.flushTimer = setTimeout(() => {
      sess.flushTimer = null;
      flush(sess);
    }, FLUSH_INTERVAL);
  }
}

function flush(sess: Session) {
  if (sess.pending.length === 0) return;
  const batch = sess.pending;
  sess.pending = [];
  linesSink?.(batch);
}

function parseLine(raw: string): Omit<LogcatLine, 'seq'> {
  let m = THREADTIME_YEAR_RE.exec(raw);
  if (m) {
    return {
      raw,
      time: m[2],
      pid: safeInt(m[3]),
      tid: safeInt(m[4]),
      level: m[5] as LogcatLevel,
      tag: m[6].trim(),
      message: m[7],
    };
  }

  m = THREADTIME_RE.exec(raw);
  if (m) {
    return {
      raw,
      time: m[1],
      pid: safeInt(m[2]),
      tid: safeInt(m[3]),
      level: m[4] as LogcatLevel,
      tag: m[5].trim(),
      message: m[6],
    };
  }

  return { raw };
}

function safeInt(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function passes(filter: LogcatFilter, parsed: Omit<LogcatLine, 'seq'>, raw: string): boolean {
  // 级别
  if (parsed.level) {
    const min = LEVEL_ORDER[filter.minLevel] ?? 0;
    const cur = LEVEL_ORDER[parsed.level] ?? 0;
    if (cur < min) return false;
  }

  // PID
  if (filter.pid && parsed.pid !== filter.pid) return false;

  // TAG（支持 * 通配、逗号分隔）
  const tagFilter = (filter.tags || '').trim();
  if (tagFilter) {
    const tag = parsed.tag || '';
    const ok = tagFilter
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .some((p) => wildcardMatch(p, tag));
    if (!ok) return false;
  }

  // 关键字（任一命中即保留）
  const kw = (filter.keyword || '').trim();
  if (kw) {
    const lower = raw.toLowerCase();
    const ok = kw
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .some((k) => lower.includes(k));
    if (!ok) {
      // matchOnly / 设了关键字时默认就是「只看命中」
      return false;
    }
  }

  // 进程名（子串）
  const proc = (filter.process || '').trim();
  if (proc && !raw.toLowerCase().includes(proc.toLowerCase())) return false;

  return true;
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.toLowerCase() === pattern.toLowerCase();
  const re = new RegExp(
    '^' + pattern.split('*').map(escapeRe).join('.*') + '$',
    'i',
  );
  return re.test(value);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* 导出 / 查询                                                         */
/* ------------------------------------------------------------------ */

export function clearLogcatBuffer(): boolean {
  if (session) {
    session.buffer.length = 0;
    session.seq = 0;
    session.pending = [];
  }
  return true;
}

export function saveLogcat(filePath: string, meta?: Record<string, string>): {
  path: string;
  bytes: number;
  lines: number;
} {
  const lines: string[] = [];
  lines.push('='.repeat(72));
  lines.push('  ADB 桌面助手 - 实时 Logcat 导出');
  lines.push('='.repeat(72));
  lines.push(`导出时间：${stamp(Date.now())}`);
  if (meta) {
    for (const [k, v] of Object.entries(meta)) lines.push(`${k}：${v}`);
  }
  lines.push(`行数：${session?.buffer.length ?? 0}`);
  lines.push('-'.repeat(72));
  lines.push('');

  if (session) {
    lines.push(...session.buffer);
  }

  const content = lines.join('\r\n');
  writeFileSync(filePath, '\ufeff' + content, 'utf8');
  return { path: filePath, bytes: Buffer.byteLength(content, 'utf8'), lines: lines.length };
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* 进程列表（供进程名过滤）                                            */
/* ------------------------------------------------------------------ */

export interface ProcEntry {
  pid: number;
  name: string;
}

export async function listProcesses(serial: string | undefined): Promise<ProcEntry[]> {
  const { runAdb } = await import('./adb');
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'ps', '-A', '-o', 'PID,NAME'], {
    silent: true,
    timeout: 15000,
  });

  const out: ProcEntry[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!m) continue;
    const name = m[2];
    if (name.startsWith('[')) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ pid: parseInt(m[1], 10), name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
