import { writeFileSync, statSync, existsSync, mkdirSync, createWriteStream, createReadStream, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import { join, dirname } from 'path';
import { ensureDevice, log } from './adb';
import { streamAdb } from './adb-stream';
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
  /** 实际写入的目录（`path` 的父目录），供界面「导出后跳转」用 */
  dir: string;
  /** 写盘字节数（UTF-8） */
  bytes: number;
  /** 实际写入的日志行数（不含头部信息） */
  lines: number;
  /** 从设备读到的原始行数（过滤前） */
  rawLines: number;
  /** 被过滤掉的行数 */
  filtered: number;
}

/* ------------------------------------------------------------------ */
/* 导出目录：<根>\<设备>\<日期>\                                        */
/* ------------------------------------------------------------------ */

/** Windows 文件名非法字符（设备型号里常带 `/`、`:` 之类） */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 清成合法且不空、不过长的单层目录名 */
export function safeSegment(raw: string, fallback: string): string {
  let s = (raw || '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  // Windows 不允许目录名以点或空格结尾
  s = s.replace(/[. ]+$/, '').trim();
  if (!s) s = fallback;
  // 单层目录名上限保守取 80，避免整条路径超 MAX_PATH
  if (s.length > 80) s = s.slice(0, 80).trim().replace(/[. ]+$/, '');
  return s || fallback;
}

/** `<机型 序列号>`，例如 `Pixel 6 emulator-5556` */
export function deviceSegment(deviceLabel?: string, serial?: string): string {
  const label = (deviceLabel || '').trim();
  const sn = (serial || '').trim();
  // deviceLabel 里带了 (serial)，先把它剥掉，避免重复
  const withoutSerial = label.replace(/\([^()]*\)\s*$/, '').trim();
  const parts = [withoutSerial, sn].filter(Boolean);
  const name = parts.join(' ').trim();
  return safeSegment(name, sn || 'unknown-device');
}

/** `YYYY-MM-DD`（本地时区） */
export function dateSegment(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 算出这次实际要写进哪个目录（**不建目录**，纯计算 + 拼路径）。
 * `splitByDevice` 为 true 时在 root 下再分一层设备、一层日期。
 */
export function resolveExportDir(
  root: string,
  opts: { splitByDevice?: boolean; deviceLabel?: string; serial?: string; now?: number } = {},
): string {
  const base = (root || '').trim();
  if (!base) throw new Error('导出目录为空');
  if (!opts.splitByDevice) return base;
  return join(
    base,
    deviceSegment(opts.deviceLabel, opts.serial),
    dateSegment(opts.now ?? Date.now()),
  );
}

/**
 * 把设备当前日志 dump 出来并按条件过滤，写入 filePath。
 *
 * 抛出的错误会经 wrap() 转成界面 toast。
 *
 * 🔴 B5：**流式落盘**，不把设备日志整段读进内存。
 *    原实现 `runAdb()` 攒完 20 万行的 stdout → `.split()` 出 20 万行数组 →
 *    `.filter()` 再留一份 `kept` → `.join()` 拼成整篇字符串才写盘，同一份内容
 *    在内存里同时存在 4 份（拼接中间串 + 全量串 + 行数组 + kept），峰值上百 MB。
 *    现在正文边读边写进 `<目标>.part`，结束时才拼表头 —— 峰值只跟单块大小有关。
 *
 *    两个配套处理：
 *     · 写不动时 `ctl.pause()`：否则 WriteStream 的队列会把几十 MB 又攒回来，
 *       等于白改（见 adb-stream.ts 的背压说明）。
 *     · 表头里的「行数 / 过滤掉多少」依赖统计结果，所以正文必须先落临时文件，
 *       最后拼成「表头 + 正文」。.part 在成功路径与失败路径都会被删掉。
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

  /* ---------- 本地过滤条件预编译 ---------- */

  /*
   * 🔴 原来每行都 `tagPats.some(p => wildcardMatch(p, tag))`，
   *    而 wildcardMatch 内部每次 `new RegExp(...)` —— 几万行就是几万次正则编译。
   *    这里在循环外编一次，逐行只剩一次 test。
   */
  const tagMatchers = (tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [])
    .map(compileTagMatcher);
  const kwList = keyword
    ? keyword.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
    : [];
  const minRank = LEVEL_ORDER[minLevel] ?? 0;

  const keep = (raw: string): boolean => {
    const parsed = parseLine(raw);

    // 级别（dump 模式下设备端不筛，全靠这里）
    if (parsed.level && (LEVEL_ORDER[parsed.level] ?? 0) < minRank) return false;

    // TAG
    if (tagMatchers.length) {
      const tag = parsed.tag || '';
      let hit = false;
      for (let i = 0; i < tagMatchers.length; i += 1) {
        if (tagMatchers[i](tag)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }

    // 关键字（正文/TAG/整行任一命中）
    if (kwList.length) {
      const lower = raw.toLowerCase();
      let hit = false;
      for (let i = 0; i < kwList.length; i += 1) {
        if (lower.includes(kwList[i])) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }

    return true;
  };

  /* ---------- 流式 dump + 过滤 + 落临时文件 ---------- */

  const partPath = `${filePath}.part`;
  const ws = createWriteStream(partPath, { encoding: 'utf8' });
  let wsError: Error | null = null;
  ws.on('error', (e) => {
    wsError = e as Error;
  });

  let rawLines = 0;
  let kept = 0;
  /** 已经 pause 过、正在等 drain —— 防止重复注册 drain 监听 */
  let waitingDrain = false;

  try {
    const res = await streamAdb(args, {
      timeout: 60000,
      silent: true,
      source: 'Logcat导出',
      onLine: (line, _i, ctl) => {
        rawLines += 1;
        if (!keep(line)) return true;
        kept += 1;
        /* 正文只写行本身 + CRLF，表头等统计出来再拼 */
        if (!ws.write(`${line}\r\n`) && !waitingDrain) {
          waitingDrain = true;
          ctl.pause();
          ws.once('drain', () => {
            waitingDrain = false;
            ctl.resume();
          });
        }
        return true;
      },
    });

    // 等文件真正落盘（finish / close 任一即可，error 会走到下面的 wsError）
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      ws.once('finish', fin);
      ws.once('close', fin);
      ws.end();
    });

    if (wsError) throw wsError;

    if (!res.ok && kept === 0) {
      throw new Error(res.stderr || `读取设备日志失败（adb exit ${res.code}）`);
    }
    // 少数 ROM 权限受限，缓冲区为空是正常情况，但 stderr 里有话就带上
    if (res.stderr && /permission|denied|not found/i.test(res.stderr)) {
      throw new Error(`设备日志不可读：${res.stderr}`);
    }

    /* ---------- 拼表头 + 正文 ---------- */

    const header: string[] = [];
    header.push('='.repeat(72));
    header.push('  ADB 桌面助手 - Logcat 日志导出');
    header.push('='.repeat(72));
    header.push(`导出时间：${stamp(Date.now())}`);
    if (options.deviceLabel) header.push(`设备：${options.deviceLabel}`);
    header.push(`缓冲区：${buffers.join(', ')}`);
    header.push(`级别：>=${minLevel}${tags ? `　TAG：${tags}` : ''}${keyword ? `　关键字：${keyword}` : ''}`);
    header.push(`行数：${kept}（设备原始 ${rawLines} 行，过滤掉 ${rawLines - kept} 行）`);
    header.push('-'.repeat(72));
    header.push('');

    // 带 BOM，Windows 记事本打开不乱码。表头末尾已经有分隔用的 CRLF（最后一项是空串）
    writeFileSync(filePath, `\ufeff${header.join('\r\n')}`, 'utf8');
    // 正文从 .part 追加，全程流式，不经过内存里的整篇字符串
    await pipeline(createReadStream(partPath), createWriteStream(filePath, { flags: 'a' }));

    /* 原返回值的 bytes 口径是「不含 BOM 的 UTF-8 字节数」 */
    const total = statSync(filePath).size;
    const bytes = Math.max(0, total - 3);

    log('success', 'Logcat导出', `已导出 ${kept} 行到 ${filePath}`);

    return {
      path: filePath,
      dir: dirname(filePath),
      bytes,
      lines: kept,
      rawLines,
      filtered: rawLines - kept,
    };
  } finally {
    /* 不管成败都要收掉临时文件：成功时它已被追加进正式文件，失败时它是半成品 */
    if (!ws.closed) ws.destroy();
    try {
      if (existsSync(partPath)) unlinkSync(partPath);
    } catch {
      /* 极端情况（被杀毒占着）删不掉也不影响正式文件，下次导出会覆盖 */
    }
  }
}

/**
 * 目录模式导出：自动建目录（含缺失的父级）→ 生成带时间戳的文件名 → 走上面的导出。
 *
 * 这是界面默认走的路径 —— 用户不用每次挑目录，日志按 `<设备>\<日期>\` 自动归位。
 */
export async function exportLogcatToDir(
  rootOrDir: string,
  options: LogcatExportOptions = {},
): Promise<LogcatExportResult> {
  const root = (rootOrDir || '').trim();
  if (!root) throw new Error('导出目录为空');

  const dir = resolveExportDir(root, {
    splitByDevice: options.splitByDevice,
    deviceLabel: options.deviceLabel,
    serial: options.serial,
  });

  // 目录不存在就建（recursive 顺带把缺失的父级一起建出来）
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log('info', 'Logcat导出', `已创建导出目录 ${dir}`);
  }

  // 撞名就顺延，别静默覆盖上一份
  return exportLogcatToFile(uniqueFilePath(dir, Date.now()), options);
}

/** `logcat_20260921_170412.txt` */
export function logcatFileName(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `logcat_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
}

/**
 * 文件名时间戳只到「秒」，连点两次导出会撞名 —— 而 writeFileSync 是**静默覆盖**，
 * 用户会以为导了两份、实际只剩一份。所以落盘前探一下，撞了就加 `_2`、`_3`…
 * （不做毫秒后缀：文件名保持人可读，且同秒多次导出是少数情况。）
 */
export function uniqueFilePath(dir: string, ts: number): string {
  const base = logcatFileName(ts).replace(/\.txt$/i, '');
  let candidate = join(dir, `${base}.txt`);
  let n = 1;
  while (existsSync(candidate)) {
    n += 1;
    candidate = join(dir, `${base}_${n}.txt`);
  }
  return candidate;
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

/**
 * 把单个 TAG 通配模式编译成判定函数（一次编译、多行复用）。
 * 语义与原来的 `wildcardMatch(pattern, value)` 逐条一致：
 *   `*` → 全通过；无 `*` → **整串**不区分大小写相等；含 `*` → 编译成锚定正则。
 */
function compileTagMatcher(pattern: string): (value: string) => boolean {
  if (pattern === '*') return () => true;
  if (!pattern.includes('*')) {
    const lower = pattern.toLowerCase();
    return (value) => value.toLowerCase() === lower;
  }
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    'i',
  );
  return (value) => re.test(value);
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
