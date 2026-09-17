/**
 * 最小 APK 解析：只为拿到包名 / 版本号。
 *
 * 为什么要自己解析
 * ---------------------------------------------------------------
 *  - platform-tools 里没有 aapt / aapt2，项目也不打算再捆一个二进制；
 *  - 但「清洁安装」必须先按包名卸载旧版本，「装完校验」必须按包名
 *    `pm path` 确认真装上了 —— 两件事都离不开包名。
 *
 * 做法
 * ---------------------------------------------------------------
 * APK 是 ZIP，读出里面的 `AndroidManifest.xml`（二进制 XML，即 AXML），
 * 再解出 <manifest> 元素上的 package / versionName / versionCode。
 *
 * 为了避免把上百 MB 的 APK 整体读进内存，全程用 fd 定位读取：
 *   尾部 EOCD → 中央目录 → AndroidManifest.xml 的本地头 → 只读这一段。
 */
import { closeSync, openSync, readSync, statSync } from 'fs';
import { inflateRawSync } from 'zlib';

export interface ApkInfo {
  /** 包名，形如 com.example.app */
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  /** 解析失败时的原因（用于日志，不影响主流程） */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, offset);
  return n === length ? buf : buf.subarray(0, n);
}

/** 找到中央目录的结束记录（EOCD） */
function findEocd(fd: number, size: number): { cdOffset: number; cdSize: number } | null {
  const tailLen = Math.min(size, MAX_COMMENT + 22);
  const tail = readAt(fd, size - tailLen, tailLen);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    return { cdOffset: tail.readUInt32LE(i + 16), cdSize: tail.readUInt32LE(i + 12) };
  }
  return null;
}

/** 从中央目录里捞出某个条目的压缩参数与本地头偏移 */
function findEntry(
  cd: Buffer,
  name: string,
): { method: number; compressedSize: number; localOffset: number } | null {
  let p = 0;
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== CEN_SIG) break;
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const entryName = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) return { method, compressedSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** 读出 ZIP 里某个条目的内容（只支持 stored / deflate，够 APK 用了） */
function readZipEntry(fd: number, name: string, size: number): Buffer | null {
  const eocd = findEocd(fd, size);
  if (!eocd) return null;

  const cd = readAt(fd, eocd.cdOffset, eocd.cdSize);
  const entry = findEntry(cd, name);
  if (!entry) return null;

  const head = readAt(fd, entry.localOffset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) return null;
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const dataOffset = entry.localOffset + 30 + nameLen + extraLen;

  const raw = readAt(fd, dataOffset, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* AXML（二进制 AndroidManifest.xml）                                   */
/* ------------------------------------------------------------------ */

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

function readUleb128(buf: Buffer, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos.i >= buf.length) break;
    const b = buf[pos.i];
    pos.i += 1;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) break;
  }
  return result >>> 0;
}

/** 解析字符串池。UTF-8 / UTF-16 两种编码都要支持——不同打包器产出的不一样 */
function parseStringPool(buf: Buffer, offset: number): string[] | null {
  if (buf.readUInt16LE(offset) !== RES_STRING_POOL_TYPE) return null;

  const headerSize = buf.readUInt16LE(offset + 2);
  const stringCount = buf.readUInt32LE(offset + 8);
  const flags = buf.readUInt32LE(offset + 16);
  const stringsStart = buf.readUInt32LE(offset + 20);
  const isUtf8 = (flags & 0x100) !== 0;

  const offsetsBase = offset + headerSize;
  const dataBase = offset + stringsStart;
  if (offsetsBase + stringCount * 4 > buf.length) return null;

  /* ---- UTF-8：长度是两段 uleb128（字符数、字节数） ---- */
  if (isUtf8) {
    const out: string[] = [];
    for (let i = 0; i < stringCount; i += 1) {
      const pos = { i: dataBase + buf.readUInt32LE(offsetsBase + i * 4) };
      try {
        readUleb128(buf, pos); // 字符数；UTF-8 下用字节数更准
        const byteLen = readUleb128(buf, pos);
        out.push(buf.toString('utf8', pos.i, Math.min(pos.i + byteLen, buf.length)));
      } catch {
        out.push('');
      }
    }
    return out;
  }

  /* ---- UTF-16：先切出每条原始字节，再判字节序 ---- */
  const slices: Buffer[] = [];
  for (let i = 0; i < stringCount; i += 1) {
    const pos = { i: dataBase + buf.readUInt32LE(offsetsBase + i * 4) };
    const charLen = readUleb128(buf, pos);
    let end = pos.i;
    for (let c = 0; c < charLen; c += 1) {
      if (end + 2 > buf.length) break;
      if (buf.readUInt16LE(end) === 0) break; // 0x0000 在 LE/BE 下都是全零
      end += 2;
    }
    slices.push(buf.subarray(pos.i, end));
  }

  /*
   * UTF-16 的字节序并不固定：aapt1 产的 manifest 是大端，aapt2 有出小端的。
   * 按「ASCII 可读字符」投票即可判别 —— manifest 里的标签名、属性名、包名
   * 几乎全是 ASCII，选错字节序会把 't'(0x0074) 读成 U+7400 这种汉字区乱码，
   * ASCII 计数会直接掉到 0。
   */
  let leScore = 0;
  let beScore = 0;
  for (const s of slices) {
    for (let p = 0; p + 1 < s.length; p += 2) {
      const le = s.readUInt16LE(p);
      const be = s.readUInt16BE(p);
      if (le >= 0x20 && le <= 0x7e) leScore += 1;
      if (be >= 0x20 && be <= 0x7e) beScore += 1;
    }
  }
  const useBE = beScore > leScore;

  return slices.map((s) => {
    let out = '';
    for (let p = 0; p + 1 < s.length; p += 2) {
      out += String.fromCharCode(useBE ? s.readUInt16BE(p) : s.readUInt16LE(p));
    }
    return out;
  });
}

/** 属性在 AXML 里的固定宽度（Android 自己也是按这个值跳的） */
const ATTR_SIZE = 20;

interface StartElementInfo {
  attrs: { name: string; dataType: number; data: number }[];
  strings: string[];
}

/**
 * 取 <manifest> 元素（文档里的第一个 start element）上的属性。
 *
 * 元素在 AXML 里的布局：
 *   chunk 头 8B | lineNumber 4B | comment 4B | ← 这里才是 ResXMLTree_attrExt
 *   attrExt: ns(4) name(4) attributeStart(2) attributeSize(2)
 *            attributeCount(2) idIndex(2) classIndex(2) styleIndex(2)
 *   属性数组起点 = attrExt + attributeStart（普通打包器 attributeStart=20）
 *
 * 属性按 resource id 排序，而 package 没有 resource id，只能按名字匹配。
 */
function parseManifest(xml: Buffer): StartElementInfo | null {
  if (xml.length < 8 || xml.readUInt16LE(0) !== RES_XML_TYPE) return null;

  let strings: string[] | null = null;
  let p = 8; // 跳过顶层头（type 2B / headerSize 2B / size 4B）

  while (p + 8 <= xml.length) {
    const type = xml.readUInt16LE(p);
    const size = xml.readUInt32LE(p + 4);
    if (size <= 0 || p + size > xml.length) break;

    if (type === RES_STRING_POOL_TYPE) {
      strings = parseStringPool(xml, p);
    } else if (type === RES_XML_START_ELEMENT_TYPE && strings) {
      const ext = p + 16;
      const attrStart = xml.readUInt16LE(ext + 8);
      const attrSize = xml.readUInt16LE(ext + 10) || ATTR_SIZE;
      const attrCount = xml.readUInt16LE(ext + 12);

      const attrs: StartElementInfo['attrs'] = [];
      for (let a = 0; a < attrCount; a += 1) {
        const off = ext + attrStart + a * attrSize;
        if (off + attrSize > xml.length) break;
        // attribute: ns(4) name(4) rawValue(4) typedValue{size(2) res0(1) dataType(1) data(4)}
        attrs.push({
          name: strings[xml.readUInt32LE(off + 4)] ?? '',
          dataType: xml.readUInt8(off + 15),
          data: xml.readUInt32LE(off + 16),
        });
      }
      return { attrs, strings };
    }

    p += size;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/** 取 ZIP 里第一个存在的条目（按给定顺序试） */
function readFirstEntry(
  fd: number,
  names: string[],
  size: number,
): { name: string; buf: Buffer } | null {
  for (const n of names) {
    const buf = readZipEntry(fd, n, size);
    if (buf) return { name: n, buf };
  }
  return null;
}

/**
 * 读出 APK / AAB 的包名与版本信息。
 *
 * AAB 里 manifest 的位置与 APK 不同：
 *  - APK  → 根目录 `AndroidManifest.xml`
 *  - AAB  → `base/manifest/AndroidManifest.xml`（注意基模块名可能不是 base，
 *           但 app bundle 的基模块恒为 base；动态功能模块另有 manifest，
 *           我们只要基模块的）
 * 两处的 manifest 都是 AXML（二进制 XML），解析逻辑完全一样。
 *
 * 任何一步失败都只填 `error` 返回，不抛异常 —— 安装主流程不该被解析失败打断。
 */
export function readApkInfo(apkPath: string): ApkInfo {
  let fd = -1;
  try {
    const size = statSync(apkPath).size;
    fd = openSync(apkPath, 'r');
    const hit = readFirstEntry(
      fd,
      ['AndroidManifest.xml', 'base/manifest/AndroidManifest.xml'],
      size,
    );
    if (!hit) {
      return { error: '读不出 AndroidManifest.xml（不是有效的 APK / AAB？）' };
    }

    const parsed = parseManifest(hit.buf);
    if (!parsed) return { error: 'AndroidManifest.xml 解析失败' };
    const { attrs, strings } = parsed;

    const str = (n: string): string | undefined => {
      const a = attrs.find((x) => x.name === n);
      if (!a || a.dataType !== TYPE_STRING) return undefined;
      return strings[a.data] || undefined;
    };
    const int = (n: string): number | undefined => {
      const a = attrs.find((x) => x.name === n);
      if (!a) return undefined;
      if (a.dataType === TYPE_INT_DEC || a.dataType === TYPE_INT_HEX) return a.data >>> 0;
      if (a.dataType === TYPE_STRING) {
        const parsedNum = parseInt(strings[a.data] ?? '', 10);
        return Number.isFinite(parsedNum) ? parsedNum : undefined;
      }
      return undefined;
    };

    return {
      packageName: str('package'),
      versionName: str('versionName'),
      versionCode: int('versionCode'),
    };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 只要包名（安装流程最常用） */
export function readApkPackageName(apkPath: string): string | undefined {
  return readApkInfo(apkPath).packageName;
}

/* ------------------------------------------------------------------ */
/* AAB 附加信息                                                        */
/* ------------------------------------------------------------------ */

/** AAB 基模块的 manifest 路径（与 APK 的不同，这里固化下来给外部用） */
export const AAB_MANIFEST_ENTRY = 'base/manifest/AndroidManifest.xml';

/**
 * 从 AAB 的 manifest 里抠出包名 / 版本号。
 *
 * ⚠️ AAB 里的 `AndroidManifest.xml` **不是** AXML，而是
 * `com.android.bundle.AndroidManifestProto`（protobuf）。整包解析它需要 protoc，
 * 但我们只要包名与版本号 —— 而 protobuf 的字符串在字节流里是**明文**，
 * 旁边紧跟着 attribute 的 name 与 value。所以这里不建完整 AST，只做
 * 「按字符串切分 + 找相邻的 name / value」，够用且没有额外依赖。
 *
 * 已经用真实的 Unity 出包（com.neptune.domino / 2.80 / 2803）与
 * 另一个游戏包交叉验证过：包名、versionName、versionCode 都能正确取到。
 * 取不到也绝不抛错 —— 安装主流程只把它当作「复核用的包名」，没有就少一道复核。
 */
function parseAabManifestProto(xml: Buffer): ApkInfo {
  /*
   * 字段的排布（`\x12\x0b` 这种就是 protobuf 的「字段号+长度」前缀）：
   *   \x12 \x0b versionName \x1a \x04 2.80 ( \x9c\x84\x84\x08 ...
   *                        ^^^^^^^^ ^^^^ ^^^^^^
   *                        字段头    长度   值
   * 关键点：**值后面紧跟着的是下一个字段号字节**（上例里的 0x28 = '('），
   * 它同样是可打印 ASCII，所以「按引号切段」会把 `2.80(` 当成一个整体。
   * 因此必须用长度前缀把值精确切出来，不能靠引号。
   */
  const extractField = (name: string): string | undefined => {
    const needle = Buffer.from(name, 'ascii');
    for (let at = xml.indexOf(needle); at >= 0; at = xml.indexOf(needle, at + 1)) {
      // 字段名前面应该是长度前缀（< 0x20）或字段头，后面应该是长度前缀
      const before = at > 0 ? xml[at - 1] : 0;
      const after = at + needle.length < xml.length ? xml[at + needle.length] : 0;
      if (before >= 0x20) continue;
      if (after < 0x20 && after !== 0x22 && after !== 0x1a) continue;

      // 一般紧跟着 0x1a <len> <value>
      if (xml[at + needle.length] === 0x1a) {
        const len = xml[at + needle.length + 1];
        const start = at + needle.length + 2;
        const end = start + len;
        if (len > 0 && end <= xml.length) {
          const raw = xml.subarray(start, end);
          // 只接受可打印 ASCII，避免长度判断错位时取出二进制垃圾
          if (raw.every((c) => c >= 0x20 && c <= 0x7e)) {
            return raw.toString('ascii');
          }
        }
      }
    }
    return undefined;
  };

  const isPackageLike = (s: string): boolean =>
    /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/.test(s) &&
    !/^(android|http|https)$/i.test(s) &&
    !/\.(com|org|net)$/i.test(s); // 排除 schemas.android.com 这种域名尾巴

  // 包名优先从 package 属性取；取不到再退回「第一个像包名的字符串」
  let packageName = extractField('package');
  if (!packageName || !isPackageLike(packageName)) {
    let scan = '';
    for (let i = 0; i < xml.length; i += 1) {
      const b = xml[i];
      scan += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '\n';
    }
    packageName = scan.split('\n').find((s) => isPackageLike(s));
  }

  // versionCode 在 proto 里是 int64（值字节不是可打印 ASCII），只能靠 versionName
  // 与它相邻的规律去认；取不到就算了 —— 它只用于展示，不参与安装逻辑。
  const versionName = extractField('versionName');
  let versionCode: number | undefined;
  {
    const at = xml.indexOf(Buffer.from('versionCode', 'ascii'));
    if (at >= 0) {
      // 形如 versionCode \x1a \x04 2803 —— 恰好 4 位十进制时可以直接读
      const len = xml[at + 11 + 1];
      if (len >= 1 && len <= 9) {
        const raw = xml.subarray(at + 13, at + 13 + len);
        if (raw.every((c) => c >= 0x30 && c <= 0x39)) {
          versionCode = parseInt(raw.toString('ascii'), 10);
        }
      }
    }
  }

  if (!packageName) return { error: 'AAB manifest 里没找到 package 属性' };
  return { packageName, versionName, versionCode };
}

export interface AabInfo extends ApkInfo {
  /** 基模块目录名（正常都是 base） */
  baseModule?: string;
  /** 是否含 AAB 特征文件（BundleConfig.pb / base/manifest/） */
  isBundle?: boolean;
}

/**
 * 读出 AAB 的信息。
 *
 * 比 APK 多一层判断：`BundleConfig.pb` 是 app bundle 的必备文件，
 * 有些渠道把 .aab 当 zip 下载会把文件装坏（或干脆给了个 APK 改名），
 * 提前认出来能给出比「bundletool 报错」清楚得多的提示。
 */
export function readAabInfo(aabPath: string): AabInfo {
  let fd = -1;
  try {
    const size = statSync(aabPath).size;
    fd = openSync(aabPath, 'r');

    const bundleConfig = readZipEntry(fd, 'BundleConfig.pb', size);
    const rawManifest = readZipEntry(fd, AAB_MANIFEST_ENTRY, size);

    if (!bundleConfig && !rawManifest) {
      return {
        isBundle: false,
        error: '这个 .aab 里既没有 BundleConfig.pb，也没有基模块 manifest —— 不是有效的 app bundle',
      };
    }

    /* manifest 是 protobuf；先按 proto 解，解不出来再退回 AXML（以防某个打包器不一样） */
    let info = parseAabManifestProto(rawManifest ?? Buffer.alloc(0));
    if (!info.packageName && rawManifest) {
      const asAxml = parseManifest(rawManifest);
      if (asAxml) {
        const str = (n: string): string | undefined => {
          const a = asAxml.attrs.find((x) => x.name === n);
          if (!a || a.dataType !== TYPE_STRING) return undefined;
          return asAxml.strings[a.data] || undefined;
        };
        info = { packageName: str('package'), versionName: str('versionName') };
      }
    }

    return { ...info, isBundle: true, baseModule: 'base' };
  } catch (e) {
    return { error: (e as Error).message, isBundle: false };
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 自测入口（scripts/check-apk-parse.cjs 用）                           */
/* ------------------------------------------------------------------ */

/** 取出 APK 里的 AndroidManifest.xml 原始 AXML 内容 */
export function readApkManifestXml(apkPath: string): Buffer | null {
  let fd = -1;
  try {
    const size = statSync(apkPath).size;
    fd = openSync(apkPath, 'r');
    return readZipEntry(fd, 'AndroidManifest.xml', size);
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 解析一段 AXML，返回首元素的全部属性（便于排查是字符串池还是属性表的问题） */
export function parseManifestXml(
  xml: Buffer,
): { attrs: { name: string; dataType: number; data: number }[]; strings: string[] } | null {
  return parseManifest(xml);
}
