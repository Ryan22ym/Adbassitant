import type { LogcatLine } from '@shared/types';

/**
 * Logcat 渲染层数据仓（性能优化 B3）
 *
 * 问题
 * ---------------------------------------------------------------
 * 原实现每次推送（120ms 一批）都做三件 O(n) 的事，n = 4000：
 *   ① `setLines(prev => trimLines(prev.concat(batch)))` —— 新数组 + 复制 4000 个引用；
 *   ② `visible` useMemo 重算 —— 带关键字/进程过滤时再 4000 次 `toLowerCase` + filter；
 *   ③ `counts` useMemo 重算 —— 再遍历 4000 条数级别。
 * 刷屏时每秒 8 批 ≈ 每秒十几万次元素操作 + 每秒十几张 4000 元素数组的垃圾。
 * DOM 早就虚拟化了，剩下的全是**纯数据层**的开销。
 *
 * 做法
 * ---------------------------------------------------------------
 * - 原始行用「数组 + head 偏移」的环形语义，裁旧只前移 head（O(1)），
 *   等 head 涨到超过一整个容量再整体压实一次（摊还 O(1)）；
 * - 有过滤条件时增量维护「命中行」列表：新批次只判新行，不重扫全量；
 * - 级别计数增量加减（push +1，被裁掉 -1），不再每批遍历；
 * - 过滤条件本身预编译（TAG 通配只编一次正则），只在条件变化时重建一次。
 *
 * 过滤语义与原 `wildOk` 完全一致：非通配模式是**子串**匹配（不是等值），
 * 通配模式锚定首尾、忽略大小写。
 */

/** 界面保留的最大行数（主进程回放缓冲同量级，见 services/logcat.ts 的 MAX_RECENT） */
export const LOG_MAX_LINES = 4000;

export interface LogcatFilterSpec {
  keyword: string;
  tags: string;
  process: string;
}

type Predicate = (line: LogcatLine) => boolean;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编译过滤条件。三个条件全空时返回 null（= 不过滤，visible 直接指向全量）。
 *
 * 原实现对每条日志、每次渲染都重新 `split(',')` + `new RegExp()`，
 * 这里把这两步提到编译期，逐行只剩 `includes` / `test`。
 */
function compilePredicate(spec: LogcatFilterSpec): Predicate | null {
  const kw = spec.keyword.trim().toLowerCase();
  const tags = spec.tags.trim();
  const proc = spec.process.trim().toLowerCase();
  if (!kw && !tags && !proc) return null;

  const tagMatchers: ((tag: string) => boolean)[] = tags
    ? tags
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((p) => {
          if (p === '*') return () => true;
          if (!p.includes('*')) {
            const low = p.toLowerCase();
            return (tag: string) => tag.toLowerCase().includes(low);
          }
          const re = new RegExp(
            '^' + p.split('*').map(escapeRe).join('.*') + '$',
            'i',
          );
          return (tag: string) => re.test(tag);
        })
    : [];

  return (line) => {
    // 整行只小写一次：关键字与进程名共用
    const needsRaw = !!kw || !!proc;
    const raw = needsRaw ? line.raw.toLowerCase() : '';
    if (kw && !raw.includes(kw)) return false;
    if (proc && !raw.includes(proc)) return false;
    if (tags) {
      /*
       * 注意判据是「trim 后有没有内容」而不是「拆出了几个模式」：
       * 用户填 `, ,` 这种只有分隔符的内容时，原实现 map/filter 之后一条模式都没有，
       * `some()` 恒为 false → **整片过滤掉**。这行为看着像 bug，但它是既有语义，
       * 换实现不能顺手改可见结果（要与主进程 services/logcat-filter.ts 保持一致）。
       */
      if (tagMatchers.length === 0) return false;
      const tag = line.tag || '';
      let hit = false;
      for (let i = 0; i < tagMatchers.length; i += 1) {
        if (tagMatchers[i](tag)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    return true;
  };
}

export class LogcatStore {
  /** 全量行（环形语义：head 之前的都是已丢弃的） */
  private all: LogcatLine[] = [];
  private head = 0;

  /** 过滤命中行（同样 head 偏移；无过滤时不用） */
  private filtered: LogcatLine[] = [];
  private fHead = 0;

  private pred: Predicate | null = null;
  private filterKey = '\u0000\u0000';

  /** 各级别条数（增量维护，供工具栏徽标用） */
  readonly counts: Record<string, number> = {};

  get total(): number {
    return this.all.length - this.head;
  }

  get visibleCount(): number {
    return this.pred ? this.filtered.length - this.fHead : this.total;
  }

  get filteredActive(): boolean {
    return !!this.pred;
  }

  /** 可见列表第 i 条 */
  at(i: number): LogcatLine | undefined {
    const arr = this.pred ? this.filtered : this.all;
    const base = this.pred ? this.fHead : this.head;
    if (i < 0 || base + i >= arr.length) return undefined;
    return arr[base + i];
  }

  /** 可见列表 [start, end) —— 虚拟滚动每帧只要几十条 */
  slice(start: number, end: number): LogcatLine[] {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(Math.floor(end), this.visibleCount);
    const out: LogcatLine[] = [];
    for (let i = from; i < to; i += 1) {
      const l = this.at(i);
      if (l) out.push(l);
    }
    return out;
  }

  /** 重置为给定内容（挂载回放 / 开始抓取 / 清空） */
  reset(list: LogcatLine[] = []): void {
    this.all =
      list.length > LOG_MAX_LINES ? list.slice(list.length - LOG_MAX_LINES) : list.slice();
    this.head = 0;

    for (const k of Object.keys(this.counts)) delete this.counts[k];
    for (const l of this.all) this.addCount(l);

    this.rebuildFiltered();
  }

  /** 追加一批（推送 / 暂停恢复） */
  push(batch: LogcatLine[]): void {
    if (batch.length === 0) return;
    for (const l of batch) {
      this.all.push(l);
      this.addCount(l);
    }
    this.trimAll();

    if (this.pred) {
      const pred = this.pred;
      for (const l of batch) if (pred(l)) this.filtered.push(l);
      this.trimFiltered();
    }
  }

  /**
   * 更新过滤条件。签名没变时**什么都不做** —— 这个方法会在每次渲染时被调用
   * （见页面里的说明），必须自己幂等。
   */
  setFilter(spec: LogcatFilterSpec): void {
    const key = `${spec.keyword}\u0000${spec.tags}\u0000${spec.process}`;
    if (key === this.filterKey) return;
    this.filterKey = key;
    this.pred = compilePredicate(spec);
    this.rebuildFiltered();
  }

  /* ---------------- 内部 ---------------- */

  private addCount(l: LogcatLine): void {
    const k = l.level || '?';
    this.counts[k] = (this.counts[k] || 0) + 1;
  }

  private decCount(l: LogcatLine): void {
    const k = l.level || '?';
    const v = (this.counts[k] || 0) - 1;
    if (v > 0) this.counts[k] = v;
    else delete this.counts[k];
  }

  private trimAll(): void {
    let over = this.all.length - this.head - LOG_MAX_LINES;
    if (over > 0) {
      const end = this.head + over;
      for (let i = this.head; i < end; i += 1) this.decCount(this.all[i]);
      this.head = end;
    }
    // 压实：数组里全是死引用会一直占着内存，攒够一整个容量再搬一次
    if (this.head > LOG_MAX_LINES) {
      this.all = this.all.slice(this.head);
      this.head = 0;
    }
  }

  private trimFiltered(): void {
    if (!this.pred) {
      this.filtered = [];
      this.fHead = 0;
      return;
    }
    // 全量里已被丢弃的行，在过滤列表里也不该继续占位（seq 单调递增，比下标可比）
    const firstSeq = this.total > 0 ? this.all[this.head].seq : Number.MAX_SAFE_INTEGER;
    while (this.fHead < this.filtered.length && this.filtered[this.fHead].seq < firstSeq) {
      this.fHead += 1;
    }
    const over = this.filtered.length - this.fHead - LOG_MAX_LINES;
    if (over > 0) this.fHead += over;
    if (this.fHead > LOG_MAX_LINES) {
      this.filtered = this.filtered.slice(this.fHead);
      this.fHead = 0;
    }
  }

  private rebuildFiltered(): void {
    this.filtered = [];
    this.fHead = 0;
    if (!this.pred) return;
    const pred = this.pred;
    for (let i = this.head; i < this.all.length; i += 1) {
      const l = this.all[i];
      if (pred(l)) this.filtered.push(l);
    }
  }
}
