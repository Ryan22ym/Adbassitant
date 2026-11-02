import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import { getHeapStatistics } from 'v8';
import { log } from './adb';

/**
 * 内存探针（性能优化 B11）
 *
 * 为什么先做这个
 * ---------------------------------------------------------------
 * 「刷屏久了变卡」「开一晚上内存涨到 1G」这类反馈，靠任务管理器截图是判不了的：
 * 分不清是主进程缓冲、渲染层 React 树、还是 GPU 合成。没有基线就没法验收任何优化，
 * 所以第一步先放一个**只读、可开关、零副作用**的采样器。
 *
 * 采什么
 * ---------------------------------------------------------------
 * - `process.getProcessMemoryInfo()` —— 主进程工作集（和任务管理器同口径）；
 * - `process.memoryUsage()` + `v8.getHeapStatistics()` —— 主进程堆 / external / ArrayBuffer；
 * - `app.getAppMetrics()` —— 逐个 Electron 进程（main / renderer / GPU / utility）的
 *   工作集与峰值，能直接看出「涨的是渲染层还是主进程」；
 * - 外部上下文（由 main.ts 注入）：logcat 抓取状态与缓冲行数，用来把内存曲线和日志量对齐。
 *
 * 注意：`app.getAppMetrics()` 只覆盖 Electron 自己的进程，adb / scrcpy / FFmpeg
 * 是外部子进程，不在这份数字里 —— 看总内存时别把它们算漏。
 *
 * 怎么开
 * ---------------------------------------------------------------
 * 启动参数 `--memory-probe`（或环境变量 `ADB_MEM_PROBE=1`）。
 * 默认每 30s 采一次，写运行日志 + `<userData>/memory-probe.jsonl`（JSONL 供脚本解析，
 * 每次启动截断重写）。不打开开关时本模块不注册任何定时器。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface ProbeProcess {
  type: string;
  pid: number;
  /** 工作集（MB） */
  wsMB: number;
  /** 进程生命周期内的工作集峰值（MB） */
  peakWsMB: number;
}

export interface MemorySample {
  /** 采样时刻 */
  t: number;
  /** 应用已运行秒数 */
  upSec: number;
  main: {
    /** 主进程 RSS（MB，来自 process.memoryUsage） */
    rssMB: number;
    /** 主进程工作集（MB，来自 getProcessMemoryInfo，任务管理器口径） */
    residentMB: number;
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    arrayBuffersMB: number;
  };
  v8: {
    usedMB: number;
    totalMB: number;
    limitMB: number;
    mallocedMB: number;
    peakMallocedMB: number;
    contexts: number;
  };
  electron: ProbeProcess[];
  /** 所有 Electron 进程工作集之和（MB） */
  totalWSMB: number;
  /** 各进程峰值之和（MB，只增不减，用于看历史最高） */
  peakTotalWSMB: number;
  /** main.ts 注入的上下文（logcat 状态等） */
  extra?: Record<string, unknown>;
}

export interface MemoryProbeOptions {
  /** 采样间隔（ms），默认 30000 */
  intervalMs?: number;
  /** 内存里保留多少个样本，默认 240（30s × 2 小时） */
  keep?: number;
  /** JSONL 落盘路径；传 null 表示不落盘 */
  file?: string | null;
}

/* ------------------------------------------------------------------ */
/* 内部状态                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_INTERVAL = 30_000;
const DEFAULT_KEEP = 240;
/** 低于这个间隔只可能是回归脚本在用，日志降级为 debug 级（不刷运行日志） */
const QUIET_INTERVAL = 5_000;
/** 所有 Electron 进程工作集合计超过这个值就告警（MB） */
const WARN_TOTAL_MB = 1_200;

let timer: NodeJS.Timeout | null = null;
let intervalMs = DEFAULT_INTERVAL;
let keep = DEFAULT_KEEP;
let samples: MemorySample[] = [];
let filePath: string | null = null;
let inFlight = false;
let extraProvider: (() => Record<string, unknown>) | null = null;
let startedAt = 0;

/* ------------------------------------------------------------------ */
/* 开关                                                                */
/* ------------------------------------------------------------------ */

/** 启动参数 / 环境变量里是否要求开探针 */
export function isMemoryProbeRequested(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes('--memory-probe') || env.ADB_MEM_PROBE === '1';
}

/** `--memory-probe-file=<path>` 覆盖默认落盘路径 */
export function memoryProbeFileFromArgv(argv: string[] = process.argv): string | undefined {
  const hit = argv.find((a) => a.startsWith('--memory-probe-file='));
  return hit ? hit.slice('--memory-probe-file='.length) : undefined;
}

/** main.ts 注入上下文（例如 logcat 抓取行数）；不注入就只采进程数字 */
export function setMemoryProbeExtra(fn: (() => Record<string, unknown>) | null): void {
  extraProvider = fn;
}

/* ------------------------------------------------------------------ */
/* 采样                                                                */
/* ------------------------------------------------------------------ */

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function mbFromBytes(n: number): number {
  return round1(n / 1024 / 1024);
}

/** 采样一次。任何一步取不到都降级为 0，绝不抛 */
export async function sampleMemoryNow(): Promise<MemorySample> {
  const now = Date.now();
  const mu = process.memoryUsage();
  const hs = getHeapStatistics();

  let residentMB = 0;
  try {
    const pm = await process.getProcessMemoryInfo();
    residentMB = round1(pm.residentSet / 1024);
  } catch {
    /* 取不到就留 0：Windows 上极少发生，但别让它影响主流程 */
  }

  const electron: ProbeProcess[] = [];
  try {
    if (app.isReady()) {
      for (const m of app.getAppMetrics()) {
        const mem = m.memory;
        electron.push({
          type: m.type,
          pid: m.pid,
          wsMB: mem ? round1(mem.workingSetSize / 1024) : 0,
          peakWsMB: mem ? round1(mem.peakWorkingSetSize / 1024) : 0,
        });
      }
    }
  } catch {
    /* 同上 */
  }

  let extra: Record<string, unknown> | undefined;
  if (extraProvider) {
    try {
      extra = extraProvider();
    } catch {
      extra = undefined;
    }
  }

  return {
    t: now,
    upSec: startedAt ? Math.round((now - startedAt) / 1000) : 0,
    main: {
      rssMB: mbFromBytes(mu.rss),
      residentMB,
      heapUsedMB: mbFromBytes(mu.heapUsed),
      heapTotalMB: mbFromBytes(mu.heapTotal),
      externalMB: mbFromBytes(mu.external),
      arrayBuffersMB: mbFromBytes(mu.arrayBuffers),
    },
    v8: {
      usedMB: mbFromBytes(hs.used_heap_size),
      totalMB: mbFromBytes(hs.total_heap_size),
      limitMB: mbFromBytes(hs.heap_size_limit),
      mallocedMB: mbFromBytes(hs.malloced_memory),
      peakMallocedMB: mbFromBytes(hs.peak_malloced_memory),
      contexts: hs.number_of_native_contexts,
    },
    electron,
    totalWSMB: round1(electron.reduce((s, p) => s + p.wsMB, 0)),
    peakTotalWSMB: round1(electron.reduce((s, p) => s + p.peakWsMB, 0)),
    extra,
  };
}

function formatSample(s: MemorySample): string {
  const byType = new Map<string, number>();
  for (const p of s.electron) {
    byType.set(p.type, round1((byType.get(p.type) || 0) + p.wsMB));
  }
  const parts = [...byType.entries()].map(([k, v]) => `${k} ${v}MB`).join(' / ');
  const lc = s.extra?.logcat as { running?: boolean; seq?: number; buffered?: number } | undefined;
  const logcat = lc
    ? ` ｜ logcat ${lc.running ? '抓取中' : '未运行'} ${lc.seq ?? 0} 行（缓冲 ${lc.buffered ?? 0}）`
    : '';
  return (
    `内存探针 主进程工作集 ${s.main.residentMB}MB（RSS ${s.main.rssMB}MB，堆 ${s.main.heapUsedMB}/` +
    `${s.main.heapTotalMB}MB，external ${s.main.externalMB}MB）｜ ` +
    `Electron 合计 ${s.totalWSMB}MB${parts ? `（${parts}）` : ''}${logcat}`
  );
}

function persist(s: MemorySample): void {
  if (!filePath) return;
  try {
    appendFileSync(filePath, JSON.stringify(s) + '\n', 'utf8');
  } catch {
    /* 落盘失败不影响采样 */
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const s = await sampleMemoryNow();
    samples.push(s);
    if (samples.length > keep) samples.splice(0, samples.length - keep);

    const quiet = intervalMs < QUIET_INTERVAL;
    /*
     * 高频率采样只可能来自回归脚本（30s 的正式节奏不会这么密）。
     * 这种时候只落 JSONL、不写运行日志 —— 否则 1 秒几十行会把日志缓冲刷满，
     * 反过来污染被测对象的内存数字。
     */
    if (!quiet) {
      if (s.totalWSMB > WARN_TOTAL_MB) {
        log('warn', '内存', `${formatSample(s)} —— 超过 ${WARN_TOTAL_MB}MB 告警线`);
      } else {
        log('info', '内存', formatSample(s));
      }
    }
    persist(s);
  } catch (e) {
    log('warn', '内存', `采样失败：${(e as Error).message}`);
  } finally {
    inFlight = false;
  }
}

/* ------------------------------------------------------------------ */
/* 启停                                                                */
/* ------------------------------------------------------------------ */

/**
 * 启动探针。重复调用是幂等的（已在跑就直接返回 true）。
 *
 * 定时器 `unref()`：探针绝不能拖着应用不退出。
 */
export function startMemoryProbe(opts: MemoryProbeOptions = {}): boolean {
  if (timer) return true;

  intervalMs = Math.max(20, Math.floor(opts.intervalMs ?? DEFAULT_INTERVAL));
  keep = Math.max(1, Math.floor(opts.keep ?? DEFAULT_KEEP));
  samples = [];
  startedAt = Date.now();

  const explicit = opts.file;
  if (explicit === null) {
    filePath = null;
  } else {
    filePath = explicit || defaultFile();
  }
  if (filePath) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      // 每次启动截断：文件只对应「这一次运行」，避免多天数据混在一起看不出趋势
      writeFileSync(filePath, '', 'utf8');
    } catch {
      filePath = null;
    }
  }

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  log(
    'info',
    '内存',
    `探针已启动：每 ${Math.round(intervalMs / 1000)}s 一次` +
      (filePath ? `，落盘 ${filePath}` : '，不落盘'),
  );
  // 立刻采一次，别让基线要等一个间隔
  void tick();
  return true;
}

export function stopMemoryProbe(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  inFlight = false;
}

export function isMemoryProbeRunning(): boolean {
  return !!timer;
}

/** 清空已采样本（回归脚本每轮之间用；不影响定时器） */
export function resetMemoryProbeSamples(): void {
  samples = [];
  startedAt = Date.now();
}

function defaultFile(): string {
  try {
    return join(app.getPath('userData'), 'memory-probe.jsonl');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 汇总（供脚本 / 后续界面使用）                                       */
/* ------------------------------------------------------------------ */

export interface MemoryProbeReport {
  count: number;
  /** 首个 / 末个样本时间 */
  firstAt: number;
  lastAt: number;
  spanSec: number;
  /** 合计工作集：首 / 末 / 峰值 */
  totalStartMB: number;
  totalLastMB: number;
  totalPeakMB: number;
  /** 末值相对首值的变化（MB，正数为涨） */
  growthMB: number;
  /** 主进程堆用量首 / 末 */
  mainHeapStartMB: number;
  mainHeapLastMB: number;
  samples: MemorySample[];
}

export function getMemoryProbeReport(): MemoryProbeReport | null {
  if (samples.length === 0) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, s.totalWSMB);
  return {
    count: samples.length,
    firstAt: first.t,
    lastAt: last.t,
    spanSec: Math.round((last.t - first.t) / 1000),
    totalStartMB: first.totalWSMB,
    totalLastMB: last.totalWSMB,
    totalPeakMB: round1(peak),
    growthMB: round1(last.totalWSMB - first.totalWSMB),
    mainHeapStartMB: first.main.heapUsedMB,
    mainHeapLastMB: last.main.heapUsedMB,
    samples: samples.slice(),
  };
}
