import { RingBuffer } from './ring-buffer';

/**
 * 崩溃日志「时间窗裁剪」纯逻辑（性能优化 B5）
 *
 * 为什么单独抽出来
 * ---------------------------------------------------------------
 * 这段逻辑原来内嵌在 `crash.ts` 的 `dumpWindow()` 里，输入是「已经切成数组的
 * 20 万行」、输出是裁剪后的数组 —— 也就是说内存峰值在此之前就已经发生了。
 * 改流式之后，它必须在**每来一行**时被调用一次，同时承担三个职责：
 *   ① 判断这行落在窗口内与否；
 *   ② 保存「时间解析全失败时」要退化的尾部 N 行；
 *   ③ 判断是否可以提前结束（后面全是要丢的）。
 *
 * 抽成不依赖 adb / electron 的纯模块，回归脚本才能直接对拍新旧语义
 * （scripts/check-dump-stream.cjs），不用真的造一次崩溃。
 */

/* ------------------------------------------------------------------ */
/* 时间戳解析                                                          */
/* ------------------------------------------------------------------ */

/** `YYYY-MM-DD HH:MM:SS.mmm`（`-v year` 的输出） */
const TS_WITH_YEAR = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3,6})/;
/** `MM-DD HH:MM:SS.mmm`（`-v time` / 默认 threadtime 的输出） */
const TS_NO_YEAR = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3,6})/;

/** `MM-DD HH:MM:SS.mmm` / `YYYY-MM-DD HH:MM:SS.mmm` → 毫秒（解析不出返回 null） */
export function parseLogTime(line: string, refMs: number): number | null {
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

/* ------------------------------------------------------------------ */
/* 时间窗裁剪器                                                        */
/* ------------------------------------------------------------------ */

export interface WindowSlicerOptions {
  /** 崩溃时刻（ms） */
  crashTime: number;
  /** 时间窗分钟数（往前取多久） */
  minutes: number;
  /** 崩溃点之后再多保留多久，默认 5000ms（进程死亡、Force finishing 这几行要） */
  afterMs?: number;
  /** 最多保留多少行，默认 40000 */
  maxKept?: number;
  /** 时间解析全失败时退化取尾部多少行，默认 3000 */
  fallbackTail?: number;
  /** 提前收工：至少要成功解析出多少行时间戳，默认 50 */
  earlyStopMinTimed?: number;
  /** 提前收工：连续多少行越过窗口右界，默认 200 */
  earlyStopPastLines?: number;
  /** 时间解析实现（测试可注入） */
  parseTime?: (line: string, refMs: number) => number | null;
}

export interface WindowResult {
  /** 要交给 AI / 写进现场文件的日志行 */
  excerpt: string[];
  /** 从设备读到的原始行数（含被丢弃的） */
  rawLines: number;
  /** = excerpt.length，单独给出便于直接记账 */
  keptLines: number;
  /** 是否因为「后面必然全丢」而提前结束读取 */
  earlyStopped: boolean;
  /** 成功解析出时间戳的行数（诊断用：太低说明这个 ROM 的 -v year 没生效） */
  timedLines: number;
}

export interface WindowSlicer {
  /**
   * 喂一行。
   * @returns false 表示「后面的行都不需要了」——调用方应立刻终止子进程。
   */
  accept(line: string): boolean;
  /** 取结果（幂等；首次调用会释放尾部缓冲的引用） */
  result(): WindowResult;
}

const DEFAULTS = {
  afterMs: 5000,
  maxKept: 40000,
  fallbackTail: 3000,
  earlyStopMinTimed: 50,
  earlyStopPastLines: 200,
};

export function createWindowSlicer(opts: WindowSlicerOptions): WindowSlicer {
  const {
    crashTime,
    minutes,
    afterMs = DEFAULTS.afterMs,
    maxKept = DEFAULTS.maxKept,
    fallbackTail = DEFAULTS.fallbackTail,
    earlyStopMinTimed = DEFAULTS.earlyStopMinTimed,
    earlyStopPastLines = DEFAULTS.earlyStopPastLines,
    parseTime = parseLogTime,
  } = opts;

  const from = crashTime - minutes * 60000;
  const to = crashTime + afterMs;

  const kept: string[] = [];
  /*
   * 只在「时间窗内一行都没命中」时才会用到（见 result 的退化分支）。
   * 🔴 一旦 kept 有了内容就停止收集 —— 否则它会一直持有最后 N 行的引用，
   *    而那个退化分支此时已经不可能再走到。
   */
  const tail = new RingBuffer<string>(fallbackTail);

  let rawLines = 0;
  let timedLines = 0;
  /** 连续超出窗口右界的行数（容忍多缓冲区合并时的轻微乱序） */
  let pastWindowRun = 0;
  let earlyStopped = false;
  let cached: WindowResult | null = null;

  const accept = (line: string): boolean => {
    rawLines += 1;
    if (kept.length === 0) tail.push(line);

    const t = parseTime(line, crashTime);

    // 解析不出时间的行（堆栈续行）就近跟随：只要当前窗口已经开始就保留
    if (t === null) {
      if (kept.length > 0 && kept.length < maxKept) kept.push(line);
      return true;
    }

    timedLines += 1;
    if (t >= from && t <= to) {
      if (kept.length < maxKept) kept.push(line);
      pastWindowRun = 0;
      return true;
    }

    if (t > to) {
      pastWindowRun += 1;
      /*
       * 🔴 提前收工的前提是 `kept` 已经非空（说明时间窗**确实命中过**）。
       *    设备时钟与主机时钟不同步时（差几分钟很常见），整批行都会越界、
       *    kept 永远为空 —— 这时必须老实读完，好让 result() 的退化分支
       *    还能拿到「尾部 N 行」。只按「越界行数」判断会在这里砍掉全部日志。
       */
      if (
        kept.length > 0 &&
        timedLines >= earlyStopMinTimed &&
        pastWindowRun >= earlyStopPastLines
      ) {
        earlyStopped = true;
        return false;
      }
    }
    return true;
  };

  const result = (): WindowResult => {
    if (cached) return cached;
    // 时间解析全军覆没（个别 ROM 的 -v year 不生效）时退化成「取尾部 N 行」
    const excerpt = kept.length > 0 ? kept : tail.toArray();
    tail.clear();
    cached = {
      excerpt,
      rawLines,
      keptLines: excerpt.length,
      earlyStopped,
      timedLines,
    };
    return cached;
  };

  return { accept, result };
}
