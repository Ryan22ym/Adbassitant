import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { basename, dirname } from 'path';
import { adbPath, log } from './adb';
import { createLineSplitter, DEFAULT_MAX_LINE_CHARS } from './line-splitter';

/**
 * 流式 adb 执行器（性能优化 B5）
 *
 * 为什么需要它
 * ---------------------------------------------------------------
 * `runBinary()`（adb.ts）是「攒完再给」的模型：`stdout += chunk` 直到进程退出，
 * 然后调用方再 `.split('\n')` 得到行数组。对 `adb logcat -d -t 200000` 这种命令，
 * 这意味着**同一份内容在内存里同时存在三份**：
 *   ① 拼接中的 GB 级临时字符串（V8 拼接会反复分配，峰值比最终体积还大）；
 *   ② 最终的全量字符串；
 *   ③ 切出来的 20 万个行字符串 —— 而且 `.filter()` 还会再产生一份新数组。
 * 实测崩溃分析一次 dump 的峰值可以打到 80~200MB，是全程序最大的单次内存事件。
 *
 * 本模块把「读取」和「处理」接成流水线：块进来 → 切行 → 立刻交给 `onLine`，
 * 行在回调返回后即可被回收。峰值内存与**输出总量**解耦，只与**单块大小**和
 * 调用方自己决定保留多少有关（Node 官方 Backpressuring in Streams 的思路）。
 *
 * 三个必须处理对的细节
 * ---------------------------------------------------------------
 * ① **多字节字符跨块断裂**：`Buffer.toString('utf8')` 在一个中文汉字被切在块边界时
 *    会产出替换符 U+FFFD，而且**静默**（runBinary 现在就有这个问题）。这里用
 *    `StringDecoder`，它会把不完整的尾巴留到下一块再拼。
 * ② **背压**：下游（写文件）比 adb 输出慢时，`write()` 返回 false 说明流缓冲在涨。
 *    不管它的话，几十 MB 会一层层堆在 WriteStream 的队列里 —— 等于白改。
 *    所以给回调一个 `StreamControl`，下游写不动时 `pause()`，drain 后 `resume()`。
 * ③ **主动提前收工**：`onLine` 返回 false 表示「后面的不需要了」，立即 kill 子进程。
 *    这要求命令的输出是**有序**的（logcat dump 是按时间升序的），否则会漏数据。
 */

export interface StreamControl {
  /** 暂停读取（下游写不动时调，避免数据堆在流缓冲里） */
  pause(): void;
  /** 恢复读取（下游 drain 之后调） */
  resume(): void;
}

export interface StreamOptions {
  /** 整体超时，超时后 kill 并返回已处理的部分（默认 60s） */
  timeout?: number;
  /**
   * 单行最大字符数。超过就**截断并丢弃该行剩余部分**直到下一个换行。
   * 防御异常输出（某条日志没有换行、几 MB 全在同一行）把 `pending` 撑爆。
   */
  maxLineChars?: number;
  /** stderr 最多保留多少字符（默认 8KB，只留头部，够定位问题） */
  maxStderrChars?: number;
  /** 日志来源标签 */
  source?: string;
  /** 是否写运行日志，默认 true */
  silent?: boolean;
  /** 返回 false 表示提前终止（子进程会被 kill） */
  onLine: (line: string, index: number, ctl: StreamControl) => boolean | void;
}

export interface StreamResult {
  /** 进程正常退出（或被主动终止 / 拿到部分输出） */
  ok: boolean;
  /** 退出码；被 kill 或 spawn 失败时为 null */
  code: number | null;
  stderr: string;
  /** 交给 `onLine` 的行数（不含空行） */
  lines: number;
  /** 从设备收到的字节数 */
  bytes: number;
  /** 是否因 `onLine` 返回 false 而提前终止 */
  aborted: boolean;
  /** 是否超时被 kill */
  timedOut: boolean;
  /** 是否出现过超长行截断（排查异常输出用） */
  truncatedLines: number;
  /** 耗时 ms */
  duration: number;
}

/** 默认单行上限：正常 logcat 行远小于此，超过基本就是「没有换行的二进制垃圾」 */
const DEFAULT_MAX_STDERR = 8 * 1024;

/** 简单的引号包装，只为日志可读（不用于 spawn 参数，spawn 不走 shell） */
function quoteArg(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/**
 * 流式执行 adb 命令，逐行回调。
 *
 * 与 `runAdb()` 的关系：**并存**，不是替代。只有「输出量大且可逐行处理」的命令
 * （logcat dump、logcat 导出）走这里；其余几百条请求-响应式命令继续用 runAdb
 * —— 它们的输出是几百字节的 JSON，攒完再解析更简单也更快。
 */
export function streamAdb(
  args: string[],
  options: StreamOptions,
): Promise<StreamResult> {
  const {
    timeout = 60000,
    maxLineChars = DEFAULT_MAX_LINE_CHARS,
    maxStderrChars = DEFAULT_MAX_STDERR,
    source = 'ADB',
    silent = true,
    onLine,
  } = options;

  const file = adbPath();
  const commandLine = `"${basename(file)}" ${args.map(quoteArg).join(' ')}`;
  const started = Date.now();

  if (!silent) log('command', source, commandLine);

  return new Promise<StreamResult>((resolve) => {
    let finished = false;
    let aborted = false;
    let timedOut = false;
    let lines = 0;
    let bytes = 0;
    let stderr = '';
    let stderrDropped = false;

    const child = spawn(file, args, { windowsHide: true, cwd: dirname(file) });

    const decoder = new StringDecoder('utf8');
    const splitter = createLineSplitter(maxLineChars);

    const ctl: StreamControl = {
      pause: () => {
        if (!finished) child.stdout?.pause();
      },
      resume: () => {
        if (!finished) child.stdout?.resume();
      },
    };

    /** 交付一行；返回 false 表示要提前终止 */
    const deliver = (line: string): boolean => {
      lines += 1;
      // 序号从 0 开始，与「第几行」的口径一致
      return onLine(line, lines - 1, ctl) !== false;
    };

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      stderr += `\n[超时] 命令执行超过 ${timeout}ms，已终止`;
      child.kill();
    }, timeout);

    child.stdout?.on('data', (d: Buffer) => {
      if (finished || aborted) return;
      bytes += d.length;
      /*
       * 🔴 必须经 StringDecoder：`d.toString('utf8')` 在一个汉字被切在块边界时
       *    会产出替换符 U+FFFD 且**静默**（runBinary 的现有行为），日志里中文
       *    全变问号时很难想到是这里。
       */
      if (!splitter.push(decoder.write(d), deliver)) {
        aborted = true;
        child.kill();
      }
    });

    child.stderr?.on('data', (d: Buffer) => {
      if (stderrDropped) return;
      stderr += d.toString('utf8');
      if (stderr.length > maxStderrChars) {
        stderr = stderr.slice(0, maxStderrChars);
        stderrDropped = true;
      }
    });

    const settle = (code: number | null, spawnError?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      /* 收尾：最后一行可能没有换行符（adb 输出偶尔如此），补交出去 */
      if (!aborted) {
        const tailText = decoder.end();
        if (tailText && !splitter.push(tailText, deliver)) {
          aborted = true;
        }
        if (!aborted) splitter.flush(deliver);
      }

      if (spawnError) stderr = `${stderr}\n${spawnError}`.trim();

      /* 被主动终止 / 超时 kill 时退出码不可信，用「有没有拿到输出」判成功 */
      const ok = aborted || timedOut ? lines > 0 || aborted : code === 0;

      const result: StreamResult = {
        ok,
        code,
        stderr: stderr.trim(),
        lines,
        bytes,
        aborted,
        timedOut,
        truncatedLines: splitter.truncated,
        duration: Date.now() - started,
      };

      if (!silent) {
        if (timedOut) log('warn', source, `超时终止（已收 ${lines} 行 / ${bytes} 字节）`);
        else if (aborted) log('info', source, `提前收工（已收 ${lines} 行 / ${bytes} 字节）`);
        else if (ok) log('success', source, `完成（${result.duration}ms，${lines} 行 / ${bytes} 字节）`);
        else log('error', source, `失败（exit ${code}）`, stderr.trim());
      }

      resolve(result);
    };

    child.on('error', (err) => settle(null, `执行失败：${err.message}`));
    child.on('close', (code) => settle(code));
  });
}
