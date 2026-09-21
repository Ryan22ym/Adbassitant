import { writeFileSync, statSync } from 'fs';
import { runAdb, ensureDevice, log } from './adb';
import type { LogcatLevel, LogcatExportOptions } from '../../shared/types';

/**
 * Logcat 导出工具（常用工具页）
 *
 * 与「实时 Logcat」页的区别：
 * - 实时版是**流式抓取**：要先开始、看着刷、再保存，拿到的是抓取那一刻之后的内容。
 * - 本工具是**一次性 dump**：`adb logcat -d` 把设备缓冲区里**已有的**日志读出来
 *   立刻退出，按参数过滤后直接写文件。用户不用先开抓取，适合「复现完问题，
 *   把刚才那段日志导出来」的场景。
 *
 * ⚠️ 为什么过滤全放本地（实测结论，别改回设备端下推）：
 * `adb logcat -d`（dump 模式）下，logcat 的 filter spec 与 `-s` 都不可靠 ——
 * 实测在 AOSP 模拟器上：
 *   · `logcat -d ... E*:S`      → 级别完全没被过滤，全量返回；
 *   · `logcat -d -t 500 -s Tag` → 返回 **0 行**（`-t` 与 `-s` 打架，语义被吃掉）。
 * 也就是说 dump 模式下设备端过滤要么无效、要么误伤。因此这里只用 `-b` 选缓冲区、
 * 用 `-t` 兜底行数上限，级别 / TAG / 关键字**一律在 JS 侧过滤**。
 * 代价是多传一段数据 —— 但 dump 是一次性的，几万行完全可以接受，换来的是
 * 「界面上选了什么，导出的就是什么」这条确定性。
 */

const LEVEL_ORDER: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };

/** 一次 dump 最多取多少行（防止设备缓冲区巨大时把内存吃爆），默认取尾部 */
const MAX_LINES = 200000;

export interface LogcatExportResult {
  path: string;
  /** 写盘字节数（UTF-8） */
  bytes: number;
  /** 实际写入的日志行数（不含头部信息） */
  lines: number;
  /** 从设备读到的原始行数（过滤前） */
  rawLines: number;
  /** 被过滤掉的行数 */
  filtered: number;
}

/**
 * 把设备当前日志 dump 出来并按条件过滤，写入 filePath。
 *
 * 抛出的错误会经 wrap() 转成界面 toast。
 */
export async function exportLogcatToFile(
  filePath: string,
  options: LogcatExportOptions = {},
): Promise<LogcatExportResult> {
  const serial = await ensureDevice(options.serial);

  const buffers = (options.buffers && options.buffers.length ? options.buffers : ['main', 'system', 'crash'])
    .map((b) => String(b).trim())
    .filter(Boolean);
  if (buffers.length === 0) buffers.push('main');

  const minLevel: LogcatLevel = options.minLevel || 'V';
  const tags = (options.tags || '').trim();
  const keyword = (options.keyword || '').trim();

  /* ---------- 组装 adb 命令 ---------- */

  /*
   * threadtime 是唯一同时带「日期 时间 PID TID 级别 TAG」的格式，便于本地解析。
   * dump 模式下不加任何 filter spec / -s —— 见文件头注释，那些在 -d 下不可靠。
   */
  const args = ['-s', serial, 'logcat', '-d', '-v', 'threadtime'];
  for (const b of buffers) args.push('-b', b);
  // 行数上限：取尾部 N 行（-t 在 dump 模式下有效，实测截断正确）
  args.push('-t', String(MAX_LINES));

  log('info', 'Logcat导出', `读取设备日志 [${buffers.join(',')}]，过滤条件：>=${minLevel}${tags ? ` TAG=${tags}` : ''}${keyword ? ` 关键=${keyword}` : ''}`);

  const res = await runAdb(args, { silent: true, timeout: 60000 });

  const stdout = res.stdout || '';
  const stderr = (res.stderr || '').trim();

  if (!res.ok && !stdout) {
    throw new Error(stderr || `读取设备日志失败（adb exit ${res.code}）`);
  }
  // 少数 ROM 权限受限，缓冲区为空是正常情况，但 stderr 里有话就带上
  if (stderr && /permission|denied|not found/i.test(stderr)) {
    throw new Error(`设备日志不可读：${stderr}`);
  }

  const rawLines = stdout.split(/\r?\n/).filter((l) => l.length > 0);

  /* ---------- 本地过滤 ---------- */

  const tagPats = tags
    ? tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const kwList = keyword
    ? keyword.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
    : [];
  const minRank = LEVEL_ORDER[minLevel] ?? 0;

  const kept: string[] = [];
  for (const raw of rawLines) {
    const parsed = parseLine(raw);

    // 级别（dump 模式下设备端不筛，全靠这里）
    if (parsed.level) {
      const rank = LEVEL_ORDER[parsed.level] ?? 0;
      if (rank < minRank) continue;
    }

    // TAG
    if (tagPats.length) {
      const tag = parsed.tag || '';
      if (!tagPats.some((p) => wildcardMatch(p, tag))) continue;
    }

    // 关键字（正文/TAG/整行任一命中）
    if (kwList.length) {
      const lower = raw.toLowerCase();
      if (!kwList.some((k) => lower.includes(k))) continue;
    }

    kept.push(raw);
  }

  /* ---------- 写文件 ---------- */

  const header: string[] = [];
  header.push('='.repeat(72));
  header.push('  ADB 桌面助手 - Logcat 日志导出');
  header.push('='.repeat(72));
  header.push(`导出时间：${stamp(Date.now())}`);
  if (options.deviceLabel) header.push(`设备：${options.deviceLabel}`);
  header.push(`缓冲区：${buffers.join(', ')}`);
  header.push(`级别：>=${minLevel}${tags ? `　TAG：${tags}` : ''}${keyword ? `　关键字：${keyword}` : ''}`);
  header.push(`行数：${kept.length}（设备原始 ${rawLines.length} 行，过滤掉 ${rawLines.length - kept.length} 行）`);
  header.push('-'.repeat(72));
  header.push('');

  const content = header.concat(kept).join('\r\n');
  // 带 BOM，Windows 记事本打开不乱码
  writeFileSync(filePath, '\ufeff' + content, 'utf8');

  const bytes = Buffer.byteLength(content, 'utf8');
  log('success', 'Logcat导出', `已导出 ${kept.length} 行到 ${filePath}`);

  return {
    path: filePath,
    bytes,
    lines: kept.length,
    rawLines: rawLines.length,
    filtered: rawLines.length - kept.length,
  };
}

/* ------------------------------------------------------------------ */
/* 解析（与实时版一致的 threadtime 语法）                               */
/* ------------------------------------------------------------------ */

const THREADTIME_YEAR_RE =
  /^(\d{4})-(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?)\s*:\s?(.*)$/;
const THREADTIME_RE =
  /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?)\s*:\s?(.*)$/;

interface Parsed {
  level?: LogcatLevel;
  tag?: string;
}

function parseLine(raw: string): Parsed {
  let m = THREADTIME_YEAR_RE.exec(raw);
  if (m) return { level: m[5] as LogcatLevel, tag: m[6].trim() };
  m = THREADTIME_RE.exec(raw);
  if (m) return { level: m[4] as LogcatLevel, tag: m[5].trim() };
  return {};
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.toLowerCase() === pattern.toLowerCase();
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 供界面预估用：返回目标文件是否存在及大小（不存在返回 null） */
export function statExport(path: string): { bytes: number } | null {
  try {
    const s = statSync(path);
    return { bytes: s.size };
  } catch {
    return null;
  }
}
