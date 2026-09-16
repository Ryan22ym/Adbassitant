/**
 * 极简 ZIP 读取器（只读，够用就行）。
 *
 * 为什么手写：Node 标准库只有 zlib，没有 zip 容器解析；主进程零第三方依赖是本项目的
 * 既定约定（asar 自包含、不打包 node_modules），所以更新包的解压也自己来。
 * 与 electron/services/apk.ts 的 ZIP 部分同源，但那边只读「某个 entry 的原始字节」，
 * 这边要支持目录遍历 + 落盘解压。
 *
 * 支持：stored(0) / deflate(8)、数据描述符（读中央目录里的真实长度）、UTF-8 文件名。
 * 不支持：zip64（我们的包远小于 4GB，遇到就直接报错，避免静默读错）、加密。
 */
import { inflateRawSync } from 'zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { dirname, join, normalize, sep } from 'path';

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localOffset: number;
  isDir: boolean;
}

/** 从尾部扫 EOCD（End Of Central Directory），返回中央目录的偏移与条目数 */
function findEocd(buf: Buffer): { cdOffset: number; total: number } {
  const maxBack = Math.min(buf.length, 22 + 0xffff);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const total = buf.readUInt16LE(i + 10);
    const cdSize = buf.readUInt32LE(i + 12);
    const cdOffset = buf.readUInt32LE(i + 16);
    if (cdOffset + cdSize > buf.length) continue; // 伪签名，继续往前找
    return { cdOffset, total };
  }
  throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
}

export function listZipEntries(buf: Buffer): ZipEntry[] {
  const { cdOffset, total } = findEocd(buf);
  const out: ZipEntry[] = [];
  let p = cdOffset;

  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) {
      throw new Error(`ZIP 中央目录第 ${i + 1} 项损坏`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameRaw = buf.subarray(p + 46, p + 46 + nameLen);

    if (flags & 0x1) throw new Error('更新包被加密，无法读取');
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('不支持 ZIP64 格式的更新包');
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`更新包使用了不支持的压缩方式（method=${method}）`);
    }

    // bit 11 = 文件名是 UTF-8；我们的包名都是 ASCII，非 UTF-8 时也按 utf8 解不会出错
    const name = nameRaw.toString('utf8');
    out.push({
      name,
      method,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      crc32,
      localOffset,
      isDir: name.endsWith('/'),
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/** 取出某个 entry 的完整内容 */
export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw new Error(`更新包内 ${e.name} 的本地头损坏`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + e.compressedSize);

  if (e.method === 0) return raw; // 只是 zip 缓冲区上的视图，调用方只读，避免大包多复制一份
  const out = inflateRawSync(raw);
  if (out.length !== e.uncompressedSize) {
    throw new Error(`更新包内 ${e.name} 解压后长度不符（期望 ${e.uncompressedSize}，实际 ${out.length}）`);
  }
  return out;
}

/** 校验：路径必须是干净的相对路径（防目录穿越） */
function safeRel(name: string): string {
  const n = normalize(name).replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..')) {
    throw new Error(`更新包内存在非法路径：${name}`);
  }
  return n;
}

/**
 * 把 zip 全部解压到 destDir。
 * 返回值即「落盘的文件相对路径列表」（目录项不计）。
 *
 * mapRel：把「逻辑名」映射成「物理落盘名」。存在的唯一理由是绕开 Electron 的
 * asar fs shim —— 它以 basename 是否以 .asar 结尾来判断「这是不是一个 asar 容器」，
 * 于是普通文件只要叫 app.asar，writeFileSync / openSync+writeSync 都会抛
 * `Invalid package`（大小写不敏感，见 README 踩坑）。filter 看到的是逻辑名。
 */
export function extractZip(
  buf: Buffer,
  destDir: string,
  filter?: (name: string) => boolean,
  mapRel?: (name: string) => string,
): string[] {
  const entries = listZipEntries(buf);
  const written: string[] = [];

  for (const e of entries) {
    const rel = safeRel(e.name);
    if (e.isDir) {
      mkdirSync(join(destDir, rel), { recursive: true });
      continue;
    }
    if (filter && !filter(rel)) continue;
    const out = mapRel ? mapRel(rel) : rel;
    const dest = join(destDir, out.split('/').join(sep));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readZipEntry(buf, e));
    written.push(out);
  }

  return written;
}

/** 从磁盘上的 zip 直接解压 */
export function extractZipFile(
  zipPath: string,
  destDir: string,
  filter?: (name: string) => boolean,
  mapRel?: (name: string) => string,
): string[] {
  return extractZip(readFileSync(zipPath), destDir, filter, mapRel);
}

/** 只读 zip 里的一个小文件（如 manifest.json），不解压整包 */
export function readZipFileText(zipPath: string, innerName: string): string | null {
  if (!existsSync(zipPath)) throw new Error(`文件不存在：${zipPath}`);
  const buf = readFileSync(zipPath);
  const e = listZipEntries(buf).find((x) => x.name === innerName);
  if (!e) return null;
  return readZipEntry(buf, e).toString('utf8');
}

export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}
