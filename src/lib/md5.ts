/**
 * MD5（RFC 1321）—— 纯前端实现，无依赖。
 *
 * 为什么自己写，而不是调现成的：
 *   ① 浏览器的 Web Crypto（`crypto.subtle.digest`）**根本不支持 MD5**，只有 SHA 家族；
 *   ② 渲染层是 `contextIsolation: true` + `nodeIntegration: false`（见 electron/main.ts），
 *      拿不到 `node:crypto`；
 *   ③ 为一次摘要开一条 IPC 往主进程跑一趟完全没必要 —— 纯计算在渲染层是同步且极快的。
 *
 * 🔴 输入一律按 **UTF-8** 编码（TextEncoder）。这样结果与 `md5sum`、各类在线工具一致；
 *    如果按 `charCodeAt` 逐字符取，中文会被算成完全不同的另一串。
 */

/** 每轮左移位数 */
const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** T[i] = floor(abs(sin(i + 1)) * 2^32)，标准里就是这么定义的，现算比抄 64 个常量更不容易抄错 */
const K = (() => {
  const t = new Int32Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  return t;
})();

/** 32 位循环左移 */
function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) | 0;
}

/** 一个 32 位字 → 4 字节小端 hex */
function wordToHexLE(w: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * 算 MD5，返回 32 位小写 hex。
 *
 * @param input 字符串按 UTF-8 编码；也可以直接传字节（算二进制内容时用）
 */
export function md5(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const bitLen = bytes.length * 8;

  /*
   * 补位：追加 0x80，再用 0 填到「比 64 的倍数少 8 字节」，最后 8 字节放原始比特长度（小端）。
   * 这个长度算式 = ceil((len + 9) / 64) * 64，比手写 while 循环少一次边界判断。
   */
  const total = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;

  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getInt32(off + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + M[g]) | 0, SHIFT[i])) | 0;
      a = tmp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return wordToHexLE(a0) + wordToHexLE(b0) + wordToHexLE(c0) + wordToHexLE(d0);
}
