import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { adbPath, ensureDir, log, runAdb } from './adb';
import { getSettings } from './settings';
import { getLogs } from './logger';
import { getMirrorStatus } from './mirror';
import { foregroundApp } from './quick-actions';
import { getAiConfig, askOnce } from './ai';
import { isAiUsable } from '../../shared/ai-conf';
import type { CrashReportFull, CrashReportMeta, CrashWatchStatus } from '../../shared/types';

/**
 * 崩溃自动分析（v1.1.14）
 * ============================================================
 * 需求：设置页打开「检测崩溃自动 AI 分析日志」后，**投屏期间**前台应用闪退时，
 * 自动走完「导出日志 → 取最近 N 分钟 → 交给 AI → 生成报告」这条链，
 * 并在左侧 AI 入口亮红点。
 *
 * 三个关键设计决定：
 *
 * ① **只在投屏运行时监听**（需求原话就是「通过 ADB 连接投屏的前台应用」）。
 *    投屏没开就没有「前台应用」这个语境，硬监听只会白烧一个常驻 logcat 进程。
 *    投屏的启停通过 ipc.ts 里的 mirror status sink 回调本模块的 syncCrashWatch()。
 *
 * ② **用 logcat 的 crash / main 缓冲区做判据，不用「轮询进程还在不在」**。
 *    轮询 pidof 只能知道「进程没了」，分不清是闪退、被清理还是用户主动退出，
 *    误报率极高。崩溃缓冲区里的 `FATAL EXCEPTION` 是系统自己写的判据，最准。
 *
 * ③ **一次崩溃只出一份报告**（冷却窗口 + 单飞锁）。崩溃时系统往 logcat 里写的
 *    行有好几条（FATAL → Force finishing → 进程死亡），逐条触发会连出三份报告；
 *    而 AI 调用是要花钱的，重复发起不可接受。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 前台应用轮询间隔。2.5s 与主进程的设备轮询同量级，不会明显增加设备负担 */
const FOREGROUND_POLL_MS = 2500;

/** 「前台应用」的保鲜期：崩溃后系统会立刻把前台切回桌面，所以允许用这个窗口内的历史值 */
const FOREGROUND_TTL_MS = 20000;

/** 同一台设备同一应用的崩溃冷却时间（防同一次崩溃连出多份报告） */
const CRASH_COOLDOWN_MS = 60000;

/** 崩溃日志抽取上限（防止一次 dump 把内存吃爆） */
const MAX_DUMP_LINES = 200000;

/** 操作记录最多带多少条给 AI */
const MAX_OP_ENTRIES = 300;

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

interface WatchHandle {
  serial: string;
  deviceLabel: string;
  child: ChildProcess;
  /** logcat 停了（设备拔了 / adb 挂了）时为原因字符串，用于状态提示 */
  dead?: string;
}

let watch: WatchHandle | null = null;
/** 正在跑分析（单飞锁：一次只允许一条流水线） */
let analyzing = false;
/** `${serial}|${pkg}` → 上次触发时间 */
const lastFired = new Map<string, number>();
/** 最近一次探测到的前台应用 */
let foreground = { pkg: '', at: 0, serial: '' };
let foregroundTimer: NodeJS.Timeout | null = null;
/** 本次进程内已产出的报告数 */
let reportCount = 0;
/** 上一帧的状态字符串，用于去重推送 */
let lastStatusKey = '';

type StatusSink = (s: CrashWatchStatus) => void;
type ReportSink = (r: CrashReportMeta) => void;
let statusSink: StatusSink | null = null;
let reportSink: ReportSink | null = null;

export function setCrashWatchSink(status: StatusSink, report: ReportSink) {
  statusSink = status;
  reportSink = report;
}

/* ------------------------------------------------------------------ */
/* 报告存储                                                            */
/* ------------------------------------------------------------------ */

function reportStorePath(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'crash-reports.json');
}

let reports: CrashReportMeta[] | null = null;

function loadReports(): CrashReportMeta[] {
  if (reports) return reports;
  try {
    const raw = JSON.parse(readFileSync(reportStorePath(), 'utf8'));
    reports = Array.isArray(raw) ? (raw as CrashReportMeta[]) : [];
  } catch {
    reports = [];
  }
  return reports;
}

function persistReports(): void {
  try {
    writeFileSync(reportStorePath(), JSON.stringify(loadReports(), null, 2), 'utf8');
  } catch (e) {
    log('warn', '崩溃分析', `报告索引写入失败：${(e as Error).message}`);
  }
}

export function listCrashReports(): CrashReportMeta[] {
  return [...loadReports()].sort((a, b) => b.at - a.at);
}

export function unreadCrashCount(): number {
  return loadReports().filter((r) => !r.read).length;
}

export function getCrashReport(id: string): CrashReportFull | null {
  const meta = loadReports().find((r) => r.id === id);
  if (!meta) return null;
  let content: string | null = null;
  try {
    if (existsSync(meta.reportPath)) content = readFileSync(meta.reportPath, 'utf8');
  } catch {
    content = null;
  }
  return { meta, content };
}

export function markCrashReportRead(id: string, read = true): CrashReportMeta[] {
  for (const r of loadReports()) {
    if (r.id === id) r.read = read;
  }
  persistReports();
  return listCrashReports();
}

export function deleteCrashReport(id: string): CrashReportMeta[] {
  reports = loadReports().filter((r) => r.id !== id);
  persistReports();
  return listCrashReports();
}

/* ------------------------------------------------------------------ */
/* 目录与设备信息                                                       */
/* ------------------------------------------------------------------ */

/** Windows 文件名非法字符 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

function safeSegment(raw: string, fallback: string): string {
  const s = (raw || '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
  return (s || fallback).slice(0, 80);
}

/** 崩溃产物根目录：优先 ai.json 的 crashDir，D 盘不存在时退到下载目录 */
export function resolveCrashRoot(): string {
  let configured = '';
  try {
    configured = (getAiConfig(false).crashDir || '').trim();
  } catch {
    configured = '';
  }
  const fallbackDrive = 'D:\\adbcrash';
  if (!configured || configured === fallbackDrive) {
    try {
      if (existsSync('D:\\')) return fallbackDrive;
    } catch {
      /* ignore */
    }
    return join(app.getPath('downloads'), 'adbcrash');
  }
  return configured;
}

function dateSegment(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stamp(ts: number, withSep = true): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withSep ? base : base.replace(/[-: ]/g, '');
}

/** 设备名称（机型 · Android 版本）—— 报告里的「设备名称」这一栏 */
export async function deviceLabelOf(serial: string): Promise<string> {
  try {
    const res = await runAdb(
      [
        '-s',
        serial,
        'shell',
        'getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release',
      ],
      { silent: true, timeout: 8000 },
    );
    const [brand, model, ver] = res.stdout.split(/\r?\n/).map((x) => x.trim());
    const name = [brand, model].filter(Boolean).join(' ') || serial;
    return ver ? `${name} · Android ${ver}` : name;
  } catch {
    return serial;
  }
}

/* ------------------------------------------------------------------ */
/* 崩溃监听                                                            */
/* ------------------------------------------------------------------ */

/**
 * 跟随「开关 + 投屏状态」重建监听器。幂等，随便调。
 *
 * 由三处触发：设置变化（开关）、投屏状态推送、以及定时的自愈检查。
 */
export function syncCrashWatch(): void {
  let enabled = false;
  try {
    enabled = !!getSettings().crashAutoAnalyze;
  } catch {
    enabled = false;
  }

  const mirror = getMirrorStatus();
  const shouldWatch = enabled && mirror.running && !!mirror.serial;

  if (!shouldWatch) {
    stopWatch();
    emitStatus();
    return;
  }
  if (watch && watch.serial === mirror.serial && !watch.dead) {
    emitStatus();
    return;
  }
  startWatch(mirror.serial!);
}

function startWatch(serial: string): void {
  stopWatch();
  log('info', '崩溃分析', `开始监听崩溃日志：${serial}`);

  /*
   * 过滤规格说明：
   *   -b crash -b main  —— 崩溃现场在 crash 缓冲区，而 ActivityManager 的
   *                        「Force finishing / 进程死亡」写在 main，两个都要。
   *   AndroidRuntime:E  —— FATAL EXCEPTION 的宿主 TAG。
   *   ActivityManager:I —— force-finish / 进程死亡（I 级）。
   *   DEBUG:E libc:F    —— native crash / tombstone。
   *   *:S               —— 其余全部静音：不静音的话主缓冲区会把设备所有日志
   *                        都推过来，解析开销白白翻几十倍。
   */
  const args = [
    '-s',
    serial,
    'logcat',
    '-v',
    'threadtime',
    '-b',
    'crash',
    '-b',
    'main',
    'AndroidRuntime:E',
    'ActivityManager:I',
    'DEBUG:E',
    'libc:F',
    '*:S',
  ];

  let child: ChildProcess;
  try {
    child = spawn(adbPath(), args, { windowsHide: true });
  } catch (e) {
    log('warn', '崩溃分析', `启动日志监听失败：${(e as Error).message}`);
    return;
  }

  const handle: WatchHandle = { serial, deviceLabel: serial, child };
  watch = handle;

  deviceLabelOf(serial).then((label) => {
    if (watch === handle) {
      handle.deviceLabel = label;
      emitStatus();
    }
  });

  /* 崩溃块解析器：看到 FATAL EXCEPTION 后，往下几行里捞 `Process: <pkg>` */
  let inFatal = false;
  let fatalLines = 0;
  let buf = '';

  const onLine = (line: string) => {
    // 1) 直接命中 AndroidRuntime 的标准崩溃块
    if (/FATAL EXCEPTION/i.test(line)) {
      inFatal = true;
      fatalLines = 0;
      // 部分 ROM 会把 Process 写在同一行
      const m = line.match(/Process:\s*([A-Za-z][\w.]*)/);
      if (m) fire(serial, m[1], line);
      return;
    }
    if (inFatal) {
      fatalLines += 1;
      const m = line.match(/Process:\s*([A-Za-z][\w.]*)/);
      if (m) {
        fire(serial, m[1], line);
        inFatal = false;
        return;
      }
      // 崩溃块通常紧跟着堆栈，超过 30 行还没找到 Process 就不再等
      if (fatalLines > 30) inFatal = false;
    }

    // 2) ActivityManager 的兜底判据
    const ff = line.match(/Force finishing activity\s+([A-Za-z][\w.]*)\//);
    if (ff) return fire(serial, ff[1], line);

    const anr = line.match(/ANR in\s+([A-Za-z][\w.]*)/);
    if (anr) return fire(serial, anr[1], line);

    const died = line.match(/Process\s+([A-Za-z][\w.]*)\s.*has died/);
    if (died) return fire(serial, died[1], line);
  };

  const pump = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    stream.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const l of lines) {
        if (l.trim()) onLine(l);
      }
    });
    stream.on('error', () => {
      /* 管道错误由 close 统一处理 */
    });
  };
  pump(child.stdout);
  pump(child.stderr);

  child.on('error', (e) => {
    handle.dead = e.message;
    log('warn', '崩溃分析', `日志监听出错：${e.message}`);
    if (watch === handle) watch = null;
    emitStatus();
  });

  child.on('close', (code) => {
    if (watch === handle) {
      watch = null;
      if (code !== 0) log('warn', '崩溃分析', `日志监听退出（exit ${code}）`);
    }
    emitStatus();
  });

  startForegroundPoll(serial);
  emitStatus();
}

function stopWatch(): void {
  if (foregroundTimer) {
    clearInterval(foregroundTimer);
    foregroundTimer = null;
  }
  if (watch) {
    try {
      watch.child.kill();
    } catch {
      /* ignore */
    }
    watch = null;
  }
  foreground = { pkg: '', at: 0, serial: '' };
}

function startForegroundPoll(serial: string): void {
  if (foregroundTimer) clearInterval(foregroundTimer);
  const tick = async () => {
    if (!watch || watch.serial !== serial) return;
    try {
      const info = await foregroundApp(serial);
      if (info.packageName && !info.isLauncher) {
        if (foreground.pkg !== info.packageName || foreground.serial !== serial) {
          foreground = { pkg: info.packageName, at: Date.now(), serial };
          emitStatus();
        } else {
          foreground.at = Date.now();
        }
      }
    } catch {
      /* 设备忙 / 掉线：下一轮再试，不打断监听 */
    }
  };
  void tick();
  foregroundTimer = setInterval(tick, FOREGROUND_POLL_MS);
}

/**
 * 判定「这次崩溃是不是前台应用闪退」，是则拉起分析流水线。
 *
 * 判据：崩溃包名 == 当前前台（或 20 秒内还是前台的应用）。
 * 之所以给这个时间窗：崩溃瞬间系统就把前台切回桌面，等我们看到日志时
 * 前台已经是 launcher 了，严格相等会一条都命中不了。
 */
function fire(serial: string, pkg: string, evidence: string): void {
  if (!pkg) return;
  /*
   * 判据：崩溃包名必须就是**当前（或 20 秒内还是）前台的那个应用**。
   * 20 秒的保鲜期是必需的 —— 崩溃瞬间系统就把前台切回桌面，等我们读到日志时
   * 前台已经是 launcher，严格相等一条都命中不了。
   * 但包名仍然要逐字相等：后台应用崩溃（用户已经切走了）不属于这个功能的范围。
   */
  const isForeground =
    foreground.serial === serial &&
    foreground.pkg === pkg &&
    Date.now() - foreground.at < FOREGROUND_TTL_MS;
  if (!isForeground) return;

  const key = `${serial}|${pkg}`;
  const now = Date.now();
  const prev = lastFired.get(key) || 0;
  if (now - prev < CRASH_COOLDOWN_MS) return;
  lastFired.set(key, now);

  log('warn', '崩溃分析', `检测到前台应用闪退：${pkg}（${serial}）`, evidence.slice(0, 300));
  void runAnalysis(serial, pkg).catch((e) => {
    log('error', '崩溃分析', `分析流程失败：${(e as Error).message}`);
  });
}

/* ------------------------------------------------------------------ */
/* 分析流水线                                                          */
/* ------------------------------------------------------------------ */

/** `MM-DD HH:MM:SS.mmm` / `YYYY-MM-DD HH:MM:SS.mmm` → 毫秒（解析不出返回 null） */
const TS_WITH_YEAR = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3,6})/;
const TS_NO_YEAR = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3,6})/;

function parseLogTime(line: string, refMs: number): number | null {
  let m = TS_WITH_YEAR.exec(line);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7].slice(0, 3)).getTime();
  }
  m = TS_NO_YEAR.exec(line);
  if (m) {
    const ref = new Date(refMs);
    let year = ref.getFullYear();
    const month = +m[1];
    // 跨年：设备时间是 12 月而参考时间是 1 月，说明这条日志属于上一年
    if (month === 12 && ref.getMonth() === 0) year -= 1;
    return new Date(year, month - 1, +m[2], +m[3], +m[4], +m[5], +m[6].slice(0, 3)).getTime();
  }
  return null;
}

/** dump 一次设备日志并按时间窗裁剪 */
async function dumpWindow(
  serial: string,
  crashTime: number,
  minutes: number,
): Promise<{ excerpt: string[]; rawLines: number; keptLines: number }> {
  const res = await runAdb(
    [
      '-s',
      serial,
      'logcat',
      '-d',
      '-v',
      'year',
      '-b',
      'main',
      '-b',
      'system',
      '-b',
      'crash',
      '-t',
      String(MAX_DUMP_LINES),
    ],
    { silent: true, timeout: 60000 },
  );

  const raw = (res.stdout || '').split(/\r?\n/).filter((l) => l.length > 0);
  const from = crashTime - minutes * 60000;
  const to = crashTime + 5000; // 崩溃后几秒的收尾日志（进程死亡、Force finishing）也要

  const kept: string[] = [];
  for (const line of raw) {
    const t = parseLogTime(line, crashTime);
    // 解析不出时间的行（堆栈续行）就近跟随：只要当前窗口已经开始就保留
    if (t === null) {
      if (kept.length > 0) kept.push(line);
      continue;
    }
    if (t >= from && t <= to) kept.push(line);
  }

  // 时间解析全军覆没（个别 ROM 的 -v year 不生效）时退化成「取尾部 3000 行」
  const excerpt = kept.length > 0 ? kept : raw.slice(-3000);
  return { excerpt, rawLines: raw.length, keptLines: excerpt.length };
}

/** 崩溃前的操作记录（工具侧运行日志） */
function operationsBefore(crashTime: number, minutes: number): string {
  const from = crashTime - minutes * 60000;
  const picked = getLogs()
    .filter((e) => e.time >= from && e.time <= crashTime)
    .slice(-MAX_OP_ENTRIES);
  if (picked.length === 0) return '（这段时间内没有记录到操作）';
  return picked
    .map((e) => {
      const d = new Date(e.time);
      const p = (n: number) => String(n).padStart(2, '0');
      const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      const extra = e.detail ? ` ｜ ${String(e.detail).replace(/\s+/g, ' ').slice(0, 200)}` : '';
      return `${ts} [${e.source}] ${e.message}${extra}`;
    })
    .join('\n');
}

/** 把提示词里的占位符换掉；一个占位符都没有时把资料追加在后面（保证日志不丢） */
function fillPrompt(
  tpl: string,
  vars: { device: string; package: string; time: string; ops: string; log: string; minutes: number },
): string {
  const hasAny = /\{\{(device|package|time|ops|log|minutes)\}\}/.test(tpl);
  let out = tpl
    .replace(/\{\{device\}\}/g, vars.device)
    .replace(/\{\{package\}\}/g, vars.package)
    .replace(/\{\{time\}\}/g, vars.time)
    .replace(/\{\{ops\}\}/g, vars.ops)
    .replace(/\{\{minutes\}\}/g, String(vars.minutes))
    .replace(/\{\{log\}\}/g, vars.log);
  if (!/\{\{log\}\}/.test(tpl)) {
    out += `\n\n【崩溃前后的设备日志（最近 ${vars.minutes} 分钟）】\n${vars.log}`;
  }
  if (!/\{\{ops\}\}/.test(tpl)) {
    out += `\n\n【崩溃前的操作记录】\n${vars.ops}`;
  }
  return out;
}

/** 从 AI 回答里摘一句能当列表摘要的话 */
function summarize(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s\d.、一二三四五六七八九十]+/, '').trim())
    .find((l) => l.length > 6);
  const s = (line || content.replace(/\s+/g, ' ').trim()).slice(0, 80);
  return s || '（无摘要）';
}

/**
 * 跑一次完整分析。
 *
 * 手动触发（AI 页面「立即分析」）与自动触发（崩溃监听）走的是同一条路，
 * 区别只在 `serial` 是否显式给出。
 */
export async function runAnalysis(
  serialIn: string | undefined,
  packageIn: string | undefined,
  manual = false,
): Promise<CrashReportMeta> {
  if (analyzing) throw new Error('已有一份崩溃分析正在进行，请稍候');

  const mirror = getMirrorStatus();
  const serial = (serialIn || mirror.serial || '').trim();
  if (!serial) throw new Error('没有可分析的设备：先连接设备并开始投屏');

  // 手动触发时若没指定应用，就用当前前台
  let pkg = (packageIn || '').trim();
  const cfg = getAiConfig(true);
  const crashTime = Date.now();

  analyzing = true;
  try {
    if (!pkg) {
      const info = await foregroundApp(serial).catch(() => null);
      pkg = info?.packageName && !info.isLauncher ? info.packageName : info?.lastApp || '';
    }
    const deviceLabel =
      watch && watch.serial === serial && watch.deviceLabel !== serial
        ? watch.deviceLabel
        : await deviceLabelOf(serial);
    const timeText = stamp(crashTime);

    log('info', '崩溃分析', `${manual ? '手动' : '自动'}分析开始：${deviceLabel} / ${pkg || '未知应用'}`);

    // 1) 落盘目录：<root>\<设备>\<日期>\
    const dir = join(
      resolveCrashRoot(),
      safeSegment(deviceLabel, serial),
      dateSegment(crashTime),
    );
    ensureDir(dir);

    // 2) dump 日志并裁到最近 N 分钟
    const minutes = cfg.crashLogMinutes || 10;
    let excerpt: string[] = [];
    let rawLines = 0;
    let dumpError = '';
    try {
      const d = await dumpWindow(serial, crashTime, minutes);
      excerpt = d.excerpt;
      rawLines = d.rawLines;
    } catch (e) {
      dumpError = (e as Error).message;
      log('warn', '崩溃分析', `读取设备日志失败：${dumpError}`);
    }

    const ops = operationsBefore(crashTime, minutes);

    // 3) 导出日志文件（交给用户的现场证据，也是 AI 分析的那份内容）
    const baseName = `crash_${stamp(crashTime, false)}`;
    const logPath = join(dir, `${baseName}.log.txt`);
    const logHeader = [
      '='.repeat(72),
      '  ADB 桌面助手 - 崩溃现场日志',
      '='.repeat(72),
      `崩溃时间：${timeText}`,
      `设备：${deviceLabel}（${serial}）`,
      `应用：${pkg || '未知'}`,
      `时间窗：最近 ${minutes} 分钟`,
      `行数：${excerpt.length}（设备日志共 ${rawLines} 行）`,
      dumpError ? `读取异常：${dumpError}` : '',
      '-'.repeat(72),
      '',
    ].filter(Boolean);
    try {
      writeFileSync(logPath, '\ufeff' + logHeader.concat(excerpt).join('\r\n'), 'utf8');
    } catch (e) {
      log('warn', '崩溃分析', `日志文件写入失败：${(e as Error).message}`);
    }

    // 4) 交给 AI 分析
    let aiContent = '';
    let model = '';
    let error = '';
    if (!isAiUsable(cfg)) {
      error = 'AI 未配置：请在 Conf/ai.json 里填好 baseUrl / apiKey / model';
    } else if (excerpt.length === 0 && !dumpError) {
      error = '没有取到日志内容（设备缓冲区可能已被清空）';
    } else {
      const prompt = fillPrompt(cfg.crashPrompt, {
        device: deviceLabel,
        package: pkg || '未知',
        time: timeText,
        ops,
        log: excerpt.join('\n').slice(0, 400000),
        minutes,
      });
      try {
        const r = await askOnce(undefined, prompt);
        aiContent = r.content;
        model = r.model;
      } catch (e) {
        error = (e as Error).message;
        log('warn', '崩溃分析', `AI 分析失败：${error}`);
      }
    }

    // 5) 生成报告 Markdown
    const reportPath = join(dir, `crash-report_${stamp(crashTime, false)}.md`);
    const summary = aiContent ? summarize(aiContent) : `（AI 分析未完成：${error}）`;
    const md: string[] = [
      '# 崩溃分析报告',
      '',
      `- **崩溃发生时间**：${timeText}`,
      `- **设备名称**：${deviceLabel}（${serial}）`,
      `- **崩溃应用**：${pkg || '未知'}`,
      `- **日志文件**：${logPath}`,
      `- **报告生成**：${stamp(Date.now())}`,
      `- **分析模型**：${model || '未调用'}`,
      `- **触发方式**：${manual ? '手动' : '自动（检测到闪退）'}`,
      '',
      '## 崩溃前执行的操作',
      '',
      '```text',
      ops,
      '```',
      '',
      '## AI 分析',
      '',
      error && !aiContent ? `> ⚠️ ${error}` : '',
      aiContent || '（无内容）',
      '',
      '---',
      '',
      `日志原文见：\`${logPath}\``,
    ].filter((x) => x !== undefined) as string[];

    try {
      writeFileSync(reportPath, '\ufeff' + md.join('\r\n'), 'utf8');
    } catch (e) {
      throw new Error(`报告写入失败：${(e as Error).message}`);
    }

    const meta: CrashReportMeta = {
      id: randomUUID(),
      at: crashTime,
      deviceLabel,
      serial,
      packageName: pkg || '',
      summary,
      reportPath,
      logPath,
      dir,
      read: false,
      error: error || undefined,
      model: model || undefined,
    };
    loadReports().push(meta);
    if (loadReports().length > 200) {
      // 只保留最近 200 份索引（磁盘上的文件不动）
      reports = loadReports().sort((a, b) => b.at - a.at).slice(0, 200);
    }
    persistReports();
    reportCount += 1;

    log('success', '崩溃分析', `报告已生成：${reportPath}`, summary);
    reportSink?.(meta);
    emitStatus();
    return meta;
  } finally {
    analyzing = false;
  }
}

/* ------------------------------------------------------------------ */
/* 状态上报                                                            */
/* ------------------------------------------------------------------ */

export function getCrashWatchStatus(): CrashWatchStatus {
  let enabled = false;
  try {
    enabled = !!getSettings().crashAutoAnalyze;
  } catch {
    /* ignore */
  }
  const mirror = getMirrorStatus();

  let note = '';
  if (!enabled) note = '开关未开启（设置 → 检测崩溃自动AI分析日志）';
  else if (!mirror.running) note = '等待投屏开始（该功能只分析投屏中的设备）';
  else if (watch?.dead) note = `日志监听已中断：${watch.dead}`;

  return {
    enabled,
    watching: !!watch && !watch.dead,
    serial: mirror.serial,
    /*
     * 显式写 `watch &&` 而不是 `watch?.serial === ...`：
     * 后者只是**比较结果**为真，TS 不会据此把 watch 窄化成非空，
     * 下一段的 watch.deviceLabel 就报「possibly null」。
     */
    deviceLabel: watch && watch.serial === mirror.serial ? watch.deviceLabel : undefined,
    foreground: foreground.pkg || undefined,
    note: note || undefined,
    reportCount,
  };
}

function emitStatus(): void {
  const s = getCrashWatchStatus();
  const key = `${s.enabled}|${s.watching}|${s.serial || ''}|${s.foreground || ''}|${s.note || ''}`;
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  statusSink?.(s);
}

/** 退出前收干净（投屏结束 / 程序退出） */
export function shutdownCrashWatch(): void {
  stopWatch();
}
