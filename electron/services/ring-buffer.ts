/**
 * 固定容量环形缓冲（性能优化 B1）
 *
 * 为什么需要它
 * ---------------------------------------------------------------
 * 原实现是 `arr.push(x)` + `arr.splice(0, arr.length - MAX)`：
 * 只要到了上限，**每来一条新数据就要把 MAX 个元素整体左移一格**。
 * logcat 刷屏时（1000 行/秒、上限 20000）等于每秒 2000 万次元素搬移，
 * 全部发生在主进程的解析热路径上 —— 表现为 CPU 占用高、批次延迟抖动、
 * 且每次都产生一张新的 20000 元素数组让 GC 去收。
 *
 * 环形缓冲把这个成本降到 **O(1)**：满了就覆盖最旧的那一格、head 前移一格，
 * 不搬移、不分配。容量固定，内存上限也是确定的。
 *
 * 语义约定（与 Array 对齐的部分）
 * ---------------------------------------------------------------
 * - `length` 是当前有效元素数，不会超过 capacity；
 * - `toArray()` 按**从旧到新**的顺序返回，和原来数组的读取顺序完全一致；
 * - `push()` 在已满时返回被挤掉的那条，调用方可据此做统计。
 */
export class RingBuffer<T> {
  private readonly buf: T[];
  /** 最旧元素所在下标 */
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    const cap = Math.floor(capacity);
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new Error(`RingBuffer capacity 必须为正整数，收到 ${capacity}`);
    }
    this.buf = new Array<T>(cap);
  }

  get length(): number {
    return this.size;
  }

  get isFull(): boolean {
    return this.size === this.buf.length;
  }

  /** 追加一条；已满时覆盖最旧的并把它返回，否则返回 undefined */
  push(item: T): T | undefined {
    const cap = this.buf.length;
    if (this.size < cap) {
      this.buf[(this.head + this.size) % cap] = item;
      this.size += 1;
      return undefined;
    }
    const evicted = this.buf[this.head];
    this.buf[this.head] = item;
    this.head = (this.head + 1) % cap;
    return evicted;
  }

  /** 从旧到新的快照（复制一份，调用方可安全持有） */
  toArray(): T[] {
    const out = new Array<T>(this.size);
    const cap = this.buf.length;
    for (let i = 0; i < this.size; i += 1) {
      out[i] = this.buf[(this.head + i) % cap];
    }
    return out;
  }

  /** 第 i 条（0 = 最旧） */
  at(i: number): T | undefined {
    if (i < 0 || i >= this.size) return undefined;
    return this.buf[(this.head + i) % this.buf.length];
  }

  /**
   * 清空。
   *
   * 🔴 必须把格子填成 undefined：只把 size 归零的话，旧元素仍被数组引用着，
   *    字符串（每条日志几十到几百字节）会一直挂在内存里，等于「假清空」。
   */
  clear(): void {
    this.buf.fill(undefined as unknown as T);
    this.head = 0;
    this.size = 0;
  }
}
