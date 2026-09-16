/**
 * 手写 PE 资源解析：读出 exe 的 VS_VERSIONINFO（FileVersion / ProductVersion / 字符串表）。
 *
 * 为什么需要：便携版的更新包是一个整包 exe，应用在替换「用户手里那个单文件」之前
 * 必须先确认「它确实是我们的产品、确实是目标版本」—— 只看 zip 里的 manifest.json
 * 是不够的（manifest 是自报的），得读 exe 自己嵌进去的版本资源。
 *
 * 也不用 PowerShell 读 FileVersion：那要起进程、拿到的是本地化字符串（中文系统的
 * 「文件版本」），不如自己解析二进制来得确定。
 *
 * 只实现到「够用」：RT_VERSION(16) 的第一项 + 第一语言，容错优先。
 */
import { readFileSync } from 'fs';

export interface PeVersionInfo {
  /** '1.0.7.0' 形式；解析不到为空串 */
  fileVersion: string;
  productVersion: string;
  /** ProductName / FileDescription / CompanyName / OriginalFilename 等 */
  strings: Record<string, string>;
}

const RT_VERSION = 16;

interface Section {
  va: number;
  vsize: number;
  raw: number;
  rsize: number;
}

function readSections(buf: Buffer): { sections: Section[]; resourceRva: number; resourceSize: number } {
  if (buf.length < 0x40) throw new Error('不是有效的 PE 文件（太小）');
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是有效的 PE 文件（缺少 MZ 头）');

  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) {
    throw new Error('不是有效的 PE 文件（缺少 PE 签名）');
  }

  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  if (optOff + optSize > buf.length) throw new Error('PE 可选头越界');

  const magic = buf.readUInt16LE(optOff);
  const ddOff = optOff + (magic === 0x20b ? 112 : 96);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`不认识的 PE 可选头 magic：0x${magic.toString(16)}`);
  if (ddOff + 8 * 3 > buf.length) throw new Error('PE 数据目录越界');

  const resourceRva = buf.readUInt32LE(ddOff + 8 * 2);
  const resourceSize = buf.readUInt32LE(ddOff + 8 * 2 + 4);

  const sections: Section[] = [];
  const secOff = optOff + optSize;
  for (let i = 0; i < numSections; i++) {
    const p = secOff + i * 40;
    if (p + 40 > buf.length) break;
    sections.push({
      vsize: buf.readUInt32LE(p + 8),
      va: buf.readUInt32LE(p + 12),
      rsize: buf.readUInt32LE(p + 16),
      raw: buf.readUInt32LE(p + 20),
    });
  }

  return { sections, resourceRva, resourceSize };
}

function rvaToOffset(sections: Section[], rva: number): number {
  for (const s of sections) {
    const span = Math.max(s.vsize, s.rsize);
    if (rva >= s.va && rva < s.va + span) return rva - s.va + s.raw;
  }
  // 有些文件的资源节边界算得比较随意，退化成「按节起点猜」
  for (const s of sections) {
    if (rva >= s.va) return rva - s.va + s.raw;
  }
  return -1;
}

/**
 * 在资源目录树里按 id 逐层下钻，返回数据项（RVA + size）。
 *
 * 资源树固定三层：类型(RT_VERSION) → 名称/ID → 语言 → 数据项。
 * ids 只给出要匹配的前几层（一般就 [RT_VERSION]），剩下的层「取第一项」继续往下走 ——
 * 少下钻一层会拿不到数据项，进而退回全文扫描，那才是真正的坑。
 */
function walkResource(
  buf: Buffer,
  base: number,
  idPath: number[],
): { rva: number; size: number } | null {
  let dirOff = 0; // 相对资源目录基址

  // idPath.length 层按 id 匹配 + 最多再补两层（语言、数据项）取第一项
  for (let depth = 0; depth <= idPath.length + 1; depth++) {
    const p = base + dirOff;
    if (p + 16 > buf.length) return null;
    const named = buf.readUInt16LE(p + 12);
    const ided = buf.readUInt16LE(p + 14);
    const count = named + ided;
    if (count <= 0) return null;

    let chosen = -1;
    if (depth < idPath.length) {
      const want = idPath[depth];
      for (let i = 0; i < count; i++) {
        const e = p + 16 + i * 8;
        if (e + 8 > buf.length) break;
        if (buf.readUInt32LE(e) === want) {
          chosen = i;
          break;
        }
      }
      if (chosen < 0) return null;
    } else {
      chosen = 0; // 语言 / 名称层：取第一项
    }

    const e = p + 16 + chosen * 8;
    if (e + 8 > buf.length) return null;
    const offOrData = buf.readUInt32LE(e + 4);

    if (offOrData & 0x80000000) {
      dirOff = offOrData & 0x7fffffff; // 子目录，继续往下
      continue;
    }
    const d = base + offOrData;
    if (d + 16 > buf.length) return null;
    return { rva: buf.readUInt32LE(d), size: buf.readUInt32LE(d + 4) };
  }

  return null;
}

/** 从 VS_VERSIONINFO 起始处读一个 UTF-16 字符串（含结尾 \0），返回 [字符串, 消耗字节数] */
function readUtf16z(buf: Buffer, off: number, maxBytes: number): [string, number] {
  let end = off;
  const limit = Math.min(off + maxBytes, buf.length);
  while (end + 1 < limit) {
    if (buf.readUInt16LE(end) === 0) return [buf.subarray(off, end).toString('utf16le'), end + 2 - off];
    end += 2;
  }
  return [buf.subarray(off, limit).toString('utf16le'), limit - off];
}

const align4 = (n: number) => (n + 3) & ~3;

function parseVersionBlock(buf: Buffer, off: number): PeVersionInfo {
  const out: PeVersionInfo = { fileVersion: '', productVersion: '', strings: {} };
  if (off + 6 > buf.length) return out;

  const totalLen = buf.readUInt16LE(off);
  const valueLen = buf.readUInt16LE(off + 2);
  if (totalLen < 6) return out;

  const [, keyBytes] = readUtf16z(buf, off + 6, 64);
  let p = off + 6 + keyBytes;
  p = align4(p);

  // VS_FIXEDFILEINFO
  if (valueLen >= 52 && p + 52 <= buf.length && buf.readUInt32LE(p) === 0xfeef04bd) {
    const fms = buf.readUInt32LE(p + 8);
    const fls = buf.readUInt32LE(p + 12);
    const pms = buf.readUInt32LE(p + 16);
    const pls = buf.readUInt32LE(p + 20);
    const fmt = (ms: number, ls: number) =>
      `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
    out.fileVersion = fmt(fms, fls);
    out.productVersion = fmt(pms, pls);
  }

  // 子块：StringFileInfo -> StringTable -> String
  let q = align4(p + valueLen);
  const end = Math.min(off + totalLen, buf.length);
  while (q + 6 <= end) {
    const childLen = buf.readUInt16LE(q);
    if (childLen <= 0) break;
    const childValueLen = buf.readUInt16LE(q + 2);
    const [childKey, childKeyBytes] = readUtf16z(buf, q + 6, 64);

    if (childKey === 'StringFileInfo') {
      let t = align4(q + 6 + childKeyBytes);
      const childEnd = Math.min(q + childLen, buf.length);
      while (t + 6 <= childEnd) {
        const tblLen = buf.readUInt16LE(t);
        if (tblLen <= 0) break;
        const [, tblKeyBytes] = readUtf16z(buf, t + 6, 64);
        let s = align4(t + 6 + tblKeyBytes);
        const tblEnd = Math.min(t + tblLen, buf.length);
        while (s + 6 <= tblEnd) {
          const kvLen = buf.readUInt16LE(s);
          if (kvLen <= 0) break;
          const kvValLen = buf.readUInt16LE(s + 2);
          const [kvKey, kvKeyBytes] = readUtf16z(buf, s + 6, 128);
          const valOff = align4(s + 6 + kvKeyBytes);
          const [val] = readUtf16z(buf, valOff, Math.max(2, kvValLen * 2));
          if (kvKey) out.strings[kvKey] = val;
          s += align4(kvLen);
        }
        t += align4(tblLen);
      }
    }

    q += align4(childLen);
  }

  return out;
}

export function readPeVersionFromBuffer(buf: Buffer): PeVersionInfo {
  if (buf.readUInt16LE(0) === 0x5a4d) {
    const info = tryReadResource(buf);
    if (info && (info.fileVersion || Object.keys(info.strings).length)) return info;
    // 是 PE 但资源里没有版本信息（罕见的裸 exe）—— 这种情况下全文扫描只会
    // 扫出压缩数据里的巧合字节序列（实测能把 Electron 主程序读成
    // "9340.36168.8075.18720"），所以宁可直接报错。
    throw new Error('该 PE 文件里没有版本资源（RT_VERSION），无法确认版本');
  }
  // 非 PE：便携版 exe 是 NSIS 自解压包，某些情况下外层 PE 头被剥掉，
  // 退回「全文搜索 VS_FIXEDFILEINFO 签名」碰运气。
  const fallback = scanFixedFileInfo(buf);
  if (fallback) return fallback;
  throw new Error('无法从该文件中读出 PE 版本信息（不是 PE，也找不到版本资源）');
}

function tryReadResource(buf: Buffer): PeVersionInfo | null {
  try {
    const { sections, resourceRva, resourceSize } = readSections(buf);
    if (!resourceRva || !resourceSize) return null;
    const resBase = rvaToOffset(sections, resourceRva);
    if (resBase < 0) return null;

    const data = walkResource(buf, resBase, [RT_VERSION]);
    if (!data) return null;
    const dataOff = rvaToOffset(sections, data.rva);
    if (dataOff < 0 || dataOff >= buf.length) return null;

    return parseVersionBlock(buf, dataOff);
  } catch {
    return null;
  }
}

/** 兜底：全文找 dwSignature=0xFEEF04BD，紧跟其后就是版本四元组 */
function scanFixedFileInfo(buf: Buffer): PeVersionInfo | null {
  const sig = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  let idx = buf.indexOf(sig);
  while (idx >= 0) {
    if (idx + 24 <= buf.length) {
      const fms = buf.readUInt32LE(idx + 8);
      const fls = buf.readUInt32LE(idx + 12);
      const pms = buf.readUInt32LE(idx + 16);
      const pls = buf.readUInt32LE(idx + 20);
      const dec = (ms: number, ls: number) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
      const v = dec(fms, fls);
      // 过滤明显不合理的组合（e.g. 全 0 或 0.0.0.0）
      if (!/^0\.0\.0\.0$/.test(v) && /^\d+\.\d+\./.test(v)) {
        const info: PeVersionInfo = {
          fileVersion: v,
          productVersion: dec(pms, pls),
          strings: {},
        };
        const name = findUtf16Near(buf, 'ProductName', idx);
        if (name) info.strings.ProductName = name;
        return info;
      }
    }
    idx = buf.indexOf(sig, idx + 4);
  }
  return null;
}

/** 在给定位置附近找一个 UTF-16LE 字符串的值（用于兜底路径） */
function findUtf16Near(buf: Buffer, key: string, from: number): string | null {
  const needle = Buffer.from(key.split('').map((c) => c + '\0').join(''), 'latin1');
  const idx = buf.indexOf(needle, from);
  if (idx < 0) return null;
  // 键后面是 UTF-16 的 \0，再按 4 字节对齐才是值；直接跳 2 字节会落在对齐填充上
  let p = idx + needle.length;
  for (let k = 0; k < 8 && p + 1 < buf.length; k++) {
    if (buf.readUInt16LE(p) !== 0) break;
    p += 2;
  }
  const [val] = readUtf16z(buf, p, 256);
  return val || null;
}

export function readPeVersion(filePath: string): PeVersionInfo {
  return readPeVersionFromBuffer(readFileSync(filePath));
}
