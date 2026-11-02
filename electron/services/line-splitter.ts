/**
 * 文本流 → 行 的切分器（性能优化 B5）
 *
 * 为什么单独抽出来
 * ---------------------------------------------------------------
 * 这是流式读取里**最容易写错**的一段：跨块的半行、CRLF、空行、
 * 「某条日志没有换行把几 MB 塞进一行」的异常输出，每一个都能让
 * `pending` 无限增长或让行边界错位。而错位的表现是「日志少了几行」
 * 或「多出一个替换符」，在真机上极难复现。
 *
 * 所以把它做成不依赖 adb / electron 的纯对象，回归脚本可以逐条咬
 * （scripts/check-dump-stream.cjs）。`adb-stream.ts` 只负责解码与背压。
 *
 * ⚠️ 它接收的是**已解码的文本**，不碰 Buffer —— 多字节字符跨块断裂由调用方的
 * `StringDecoder` 负责（不能在切行层做：那需要知道编码边界）。
 */

export interface LineSplitter {
  /**
   * 喂一段文本。
   * @param emit 每切出一行调用一次；返回 false 表示调用方要求停止（子进程将被 kill）
   * @returns false 表示已被 `emit` 叫停，本次输入的剩余部分不再处理
   */
  push(text: string, emit: (line: string) => boolean): boolean;
  /** 收尾：交出不带换行符的最后一段（adb 输出末尾偶尔如此） */
  flush(emit: (line: string) => boolean): void;
  /** 有多少行因超过单行上限被截断（诊断用） */
  readonly truncated: number;
  /** 当前还没等到换行的残余长度（排查「某条日志没换行」用） */
  readonly pendingChars: number;
}

/** 正常 logcat 行远小于此，超过基本就是「没有换行的二进制垃圾」 */
export const DEFAULT_MAX_LINE_CHARS = 64 * 1024;

export function createLineSplitter(
  maxLineChars: number = DEFAULT_MAX_LINE_CHARS,
): LineSplitter {
  let pending = '';
  /**
   * 当前这行已经超长、被截断了。
   * 之后的片段**全部丢弃**直到下一个换行 —— 否则「截断」只是把前 64KB 留下、
   * 后面的几 MB 继续往 pending 里堆，等于没防。
   */
  let overflow = false;
  let truncated = 0;

  const push = (text: string, emit: (line: string) => boolean): boolean => {
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf('\n', i);

      if (nl === -1) {
        const rest = text.slice(i);
        if (!overflow) {
          if (pending.length + rest.length > maxLineChars) {
            pending = (pending + rest).slice(0, maxLineChars);
            overflow = true;
            truncated += 1;
          } else {
            pending += rest;
          }
        }
        return true;
      }

      let line: string;
      if (overflow) {
        /* 超长行的尾巴结束在这里：交付被截断的前半段（已经计过一次截断） */
        line = pending;
        overflow = false;
      } else {
        line = pending + text.slice(i, nl);
        /*
         * 🔴 整行一次性到达时也要校验长度。
         *    「没找到换行」那个分支里的检查只在**行被切在块边界上**时才走到；
         *    如果一个大 chunk 里就带着一整条 5MB 的无换行内容，会从这里直接
         *    交付出去，等于超长保护失效（实测过：一次喂 50 字符、上限 10，
         *    交付出来就是 50）。
         */
        if (line.length > maxLineChars) {
          line = line.slice(0, maxLineChars);
          truncated += 1;
        }
      }
      pending = '';
      i = nl + 1;

      /* CRLF：行尾的 \r 去掉，否则导出的文件里会变成 \r\r\n */
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
        line = line.slice(0, -1);
      }
      /* 空行直接跳过（logcat 输出里偶发，两个调用方都不需要） */
      if (line.length === 0) continue;

      if (!emit(line)) return false;
    }
    return true;
  };

  const flush = (emit: (line: string) => boolean): void => {
    const last = pending;
    pending = '';
    overflow = false;
    if (last.length > 0) emit(last);
  };

  return {
    push,
    flush,
    get truncated() {
      return truncated;
    },
    get pendingChars() {
      return pending.length;
    },
  };
}
