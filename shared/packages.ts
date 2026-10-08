/**
 * 安装包管理 —— 纯逻辑（不碰 fs / electron，渲染层与主进程共用）
 * ============================================================
 * 只有一件事：**给一个文件名，算出它应该落到哪个目录**。
 * 真正的扫描与移动在 `electron/services/package-fs.ts`，
 * 配置读写与目录选择在 `electron/services/packages.ts`。
 *
 * 为什么单独拆一份：这段规则是「产品约定」，主进程要用、界面要预览、
 * 自测脚本 `scripts/check-packages.cjs` 也要直接跑 —— 放这里三边都能引，
 * 而且**不能 import fs**（渲染层会跟着打包进来）。
 *
 * 命名约定（默认，关键字可在设置里改）：
 *   官网包   Domino_GW_V2.83_release_18.apk   → 2.83 / 官网包 / release
 *   Google包 app-dmno_release-release_10.aab  → 2.83|未识别版本 / Google包 / release
 *   单包     weixin_8.0.50.apk                → 8.0.50 / 单包   （认不出官网/Google 的都归这里）
 *
 * 🔴 单包是「兜底档」：只要类型关键字（GW / dmno…）没命中，一律进单包 ——
 *    不再拿扩展名去猜（早年 apk→官网、aab→Google 的兜底会把第三方包塞错目录）。
 *    判错了就让用户在界面上手工改标签（见 PackageOverride）。
 */

import type {
  PackageChannel,
  PackageDirNames,
  PackageEntry,
  PackageFilters,
  PackageFormat,
  PackageKeywords,
  PackageKind,
  PackageOverride,
  PackageOverrideMap,
  PackageStructure,
} from './types';

/* ------------------------------------------------------------------ */
/* 默认值                                                              */
/* ------------------------------------------------------------------ */

export const DEFAULT_PACKAGE_DIR_NAMES: PackageDirNames = {
  official: '官网包',
  google: 'Google包',
  single: '单包',
  release: 'release',
  test: 'test',
  unknownVersion: '未识别版本',
};

/**
 * 识别关键字。
 *
 * 刻意**不放 `domino`** —— 官网包与 Google 包的公共前缀就是应用名（Domino / dmno），
 * 拿它当关键字会把两种包判成一个（真正区分二者的是 `GW` 与 `dmno`）。
 */
export const DEFAULT_PACKAGE_KEYWORDS: PackageKeywords = {
  official: ['gw', 'official', 'guanwang'],
  google: ['dmno', 'google', 'play', 'gplay'],
  release: ['release'],
  test: ['test', 'beta', 'alpha', 'debug', 'dev'],
};

export const DEFAULT_PACKAGE_FILTERS: PackageFilters = {
  versions: [],
  kinds: [],
  channels: [],
  formats: [],
  keyword: '',
};

/** 版本筛选里代表「版本号解析不出来」的那一档 */
export const PACKAGE_UNKNOWN_VERSION_KEY = '__unknown__';

/** 版本筛选用在这个值上，表示「不限版本」 */
export const PACKAGE_ANY_VERSION_KEY = '__any__';

export const PACKAGE_KIND_LABEL: Record<PackageKind, string> = {
  official: '官网包',
  google: 'Google包',
  single: '单包',
};

export const PACKAGE_CHANNEL_LABEL: Record<PackageChannel, string> = {
  release: 'release',
  test: 'test',
};

/** 目录顺序（界面里按这个顺序渲染分区） */
export const PACKAGE_KIND_ORDER: PackageKind[] = ['official', 'google', 'single'];

/* ------------------------------------------------------------------ */
/* 目录名 / 配置清洗                                                    */
/* ------------------------------------------------------------------ */

/** Windows 目录名里不能出现的字符 */
const ILLEGAL_DIR_CHARS = /[\\/:*?"<>|]/g;

/** 清洗一个目录名：去非法字符、去首尾空白与点；清洗后为空则用兜底值 */
export function safeDirName(raw: unknown, fallback: string): string {
  const s = String(raw ?? '')
    .replace(ILLEGAL_DIR_CHARS, '')
    .replace(/[\s.]+$/g, '')
    .trim();
  return s || fallback;
}

/** 把外部（磁盘 / 界面）来的目录名配置归一化成可信值 */
export function normalizeDirNames(raw: unknown): PackageDirNames {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PACKAGE_DIR_NAMES;
  return {
    official: safeDirName(x.official, d.official),
    google: safeDirName(x.google, d.google),
    single: safeDirName(x.single, d.single),
    release: safeDirName(x.release, d.release),
    test: safeDirName(x.test, d.test),
    unknownVersion: safeDirName(x.unknownVersion, d.unknownVersion),
  };
}

export function normalizeStructure(raw: unknown): PackageStructure {
  return raw === 'type-first' ? 'type-first' : 'version-first';
}

/** 把磁盘上的筛选条件归一化；损坏 / 缺字段一律回落默认（空 = 不限） */
export function normalizeFilters(raw: unknown): PackageFilters {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((i) => String(i)).filter(Boolean) : []);
  const kinds = arr(x.kinds).filter((k): k is PackageKind =>
    k === 'official' || k === 'google' || k === 'single',
  );
  const channels = arr(x.channels).filter((c): c is PackageChannel => c === 'release' || c === 'test');
  const formats = arr(x.formats).filter((f): f is PackageFormat => f === 'apk' || f === 'aab');
  return {
    versions: arr(x.versions),
    kinds,
    channels,
    formats,
    keyword: typeof x.keyword === 'string' ? x.keyword : '',
  };
}

/* ------------------------------------------------------------------ */
/* 文件名解析                                                          */
/* ------------------------------------------------------------------ */

/** 去掉扩展名 */
export function stemOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function formatOf(name: string): PackageFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === 'apk' || ext === 'aab' ? (ext as PackageFormat) : null;
}

/**
 * 按分隔符切成小写词。
 *
 * 中文字符保留（当词处理），这样「多米诺_官网包_test.apk」也能切出「官网包」。
 */
export function tokenize(name: string): string[] {
  return stemOf(name)
    .toLowerCase()
    .split(/[^0-9a-z\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

/** 带 v 前缀的版本号：V2.83 / v2 / V2.3.1（优先，最不容易误判） */
const VER_PREFIXED = /(?:^|[^0-9a-z])v(\d+(?:\.\d+){0,3})(?![0-9])/i;
/** 裸版本号：必须带小数点，避免把构建号 / 日期当版本 */
const VER_PLAIN = /(?:^|[^0-9.])(\d+(?:\.\d+){1,3})(?![0-9])/;

/** 从一串文本里找版本号（文件名或目录名都能用） */
export function parseVersion(text: string): string | undefined {
  const m = VER_PREFIXED.exec(text) || VER_PLAIN.exec(text);
  if (!m) return undefined;
  return normalizeVersion(m[1]);
}

/** 2.083 → 2.83；2.0 → 2.0（只去掉每段的前导 0，语义不变） */
export function normalizeVersion(v: string): string {
  const parts = v.split('.');
  // 至少保留一段（不能空）
  const fixed = parts.map((p, i) => (i === 0 ? String(parseInt(p, 10) || 0) : String(parseInt(p, 10) || 0)));
  return fixed.join('.');
}

/**
 * 构建号：把版本号从名字里挖掉之后，剩下的最后一段数字。
 * `..._release_18.apk` → 18；`...release_10.aab` → 10。
 */
export function parseBuild(name: string): string | undefined {
  let stem = stemOf(name);
  const m = VER_PREFIXED.exec(stem) || VER_PLAIN.exec(stem);
  if (m) stem = stem.replace(m[1], ' ');
  const all = stem.match(/\d{1,5}/g);
  if (!all || all.length === 0) return undefined;
  return all[all.length - 1];
}

/** 通道关键字在名字里出现的位置（取最后一个命中，`x_release_test_3` 归 test） */
function pickKeyword(name: string, words: string[]): { hit: string; at: number } | null {
  const low = name.toLowerCase();
  let best: { hit: string; at: number } | null = null;
  for (const w of words) {
    if (!w) continue;
    const at = low.lastIndexOf(w);
    if (at < 0) continue;
    // 只认「整词」：前后都不是字母数字，避免 release 命中 prerelease 之类
    const before = at === 0 ? '' : low[at - 1];
    const after = low[at + w.length] ?? '';
    const isWord = (c: string) => /[0-9a-z]/.test(c);
    if (before && isWord(before)) continue;
    if (after && isWord(after)) continue;
    if (!best || at > best.at) best = { hit: w, at };
  }
  return best;
}

/** 判通道：test 与 release 都在时，取位置更靠后的那个 */
export function pickChannel(name: string, kw: PackageKeywords): PackageChannel | undefined {
  const t = pickKeyword(name, kw.test);
  const r = pickKeyword(name, kw.release);
  if (!t && !r) return undefined;
  if (t && !r) return 'test';
  if (r && !t) return 'release';
  return t!.at > r!.at ? 'test' : 'release';
}

/** 判类型关键字 */
export function pickKindKeyword(name: string, kw: PackageKeywords): PackageKind | undefined {
  const tokens = tokenize(name);
  const hit = (words: string[]) =>
    words.some((w) => {
      const lw = w.toLowerCase();
      return tokens.includes(lw);
    });
  if (hit(kw.official)) return 'official';
  if (hit(kw.google)) return 'google';
  return undefined;
}

export interface Classified {
  version?: string;
  rawVersion?: string;
  /** 版本从哪来：文件名 / 上级目录（兜底）/ 用户手工填 */
  versionFrom?: 'name' | 'folder' | 'manual';
  build?: string;
  kind: PackageKind;
  channel?: PackageChannel;
  /** 类型 / 通道 / 版本 里有被手工钉死的项 */
  overridden?: boolean;
}

/**
 * 归类一个包。
 *
 * @param name     文件名（含扩展名）
 * @param format   扩展名判出来的格式（只用于展示/兜底，不参与类型判断）
 * @param folderVersions 从近到远的上级目录名（用它们兜底版本号）
 */
export function classify(
  name: string,
  format: PackageFormat,
  folderVersions: string[] = [],
  kw: PackageKeywords = DEFAULT_PACKAGE_KEYWORDS,
): Classified {
  const keywordKind = pickKindKeyword(name, kw);
  const channel = pickChannel(name, kw);
  let version = parseVersion(name);
  let versionFrom: 'name' | 'folder' | undefined = version ? 'name' : undefined;
  if (!version) {
    for (const f of folderVersions) {
      const v = parseVersion(f);
      if (v) {
        version = v;
        versionFrom = 'folder';
        break;
      }
    }
  }

  /*
   * 「单包」= 认不出官网 / Google 类型的一切（v1.1.6 收敛）。
   *
   * 早先的判据是「既没有类型关键字、也没有通道标记」，还叠了一层扩展名兜底
   * （apk→官网包、aab→Google 包）。结果是 `something_release_3.aab` 这种第三方
   * 包被当成 Google 包、`随手下的.apk` 被当成官网包 —— 用户看到的就是「划分不对」。
   * 现在只认类型关键字：命中不了就老实地进单包目录，想纠正由用户手工改标签。
   */
  if (!keywordKind) {
    return {
      version,
      rawVersion: rawVersionOf(name),
      versionFrom,
      build: parseBuild(name),
      kind: 'single',
    };
  }

  return {
    version,
    rawVersion: rawVersionOf(name),
    versionFrom,
    build: parseBuild(name),
    kind: keywordKind,
    // 有类型关键字但没写通道的按 release 归置（下面 targetDirOf 里也用同一个值）
    channel: channel ?? 'release',
  };
}

/* ------------------------------------------------------------------ */
/* 手动标签（覆盖自动识别）                                            */
/* ------------------------------------------------------------------ */

/** 版本号输入清洗：接受 `2.83` / `v2.83` / `2.83.1`；认不出来返回空串 */
export function sanitizeOverrideVersion(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .replace(/^v/i, '')
    .trim();
  return /^\d+(\.\d+){0,3}$/.test(s) ? normalizeVersion(s) : '';
}

/** 把磁盘 / 界面上来的一条手动标签归一化；没有任何有效字段时返回 null */
export function normalizeOverride(raw: unknown): PackageOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Record<string, unknown>;
  const out: PackageOverride = {};
  if (x.kind === 'official' || x.kind === 'google' || x.kind === 'single') out.kind = x.kind;
  if (x.channel === 'release' || x.channel === 'test' || x.channel === '') out.channel = x.channel;
  if (typeof x.version === 'string') out.version = sanitizeOverrideVersion(x.version);
  if (typeof x.at === 'number' && Number.isFinite(x.at)) out.at = x.at;
  if (out.kind === undefined && out.channel === undefined && out.version === undefined) return null;
  return out;
}

/** 归一化整张手动标签表；键是文件名，带路径分隔符 / 空键的一律丢掉 */
export function normalizeOverrides(raw: unknown): PackageOverrideMap {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PackageOverrideMap = {};
  for (const [key, value] of Object.entries(src)) {
    const k = key.trim();
    if (!k || /[\\/]/.test(k)) continue;
    const ov = normalizeOverride(value);
    if (ov) out[k] = ov;
  }
  return out;
}

/**
 * 把手动标签套到自动识别结果上。
 *
 * 通道的收敛规则：单包永远没有通道层（覆盖成官网/Google 时若没给通道，按 release 走）。
 */
export function applyOverride(c: Classified, ov?: PackageOverride): Classified {
  if (!ov) return { ...c, overridden: false };

  const kind: PackageKind = ov.kind ?? c.kind;

  let channel: PackageChannel | undefined;
  if (kind === 'single') {
    channel = undefined;
  } else if (ov.channel !== undefined) {
    channel = ov.channel === 'test' ? 'test' : 'release';
  } else {
    channel = c.channel ?? 'release';
  }

  let version = c.version;
  let versionFrom = c.versionFrom;
  if (ov.version !== undefined) {
    const v = sanitizeOverrideVersion(ov.version);
    version = v || undefined;
    versionFrom = v ? 'manual' : undefined;
  }

  return { ...c, kind, channel, version, versionFrom, overridden: true };
}

/** 归类 + 套手动标签（扫描与展示统一走这个，别再直接调 classify） */
export function classifyWithOverride(
  name: string,
  format: PackageFormat,
  folderVersions: string[],
  kw: PackageKeywords,
  overrides?: PackageOverrideMap,
): Classified {
  return applyOverride(classify(name, format, folderVersions, kw), overrides?.[name]);
}


/** 文件名里出现的原始版本串（V2.83），只用于展示 */
function rawVersionOf(name: string): string | undefined {
  const stem = stemOf(name);
  const m = VER_PREFIXED.exec(stem);
  if (m) return `V${m[1]}`;
  const p = VER_PLAIN.exec(stem);
  return p ? p[1] : undefined;
}

/* ------------------------------------------------------------------ */
/* 目标目录                                                            */
/* ------------------------------------------------------------------ */

/**
 * 算相对目录（POSIX 分隔符，方便跨平台比较与展示）。
 *
 * version-first（默认）：`<版本>/<类型>/<通道>`，单包不带通道
 * type-first          ：`<类型>/<版本>/<通道>`
 */
export function targetDirOf(
  c: { version?: string; kind: PackageKind; channel?: PackageChannel },
  dirNames: PackageDirNames,
  structure: PackageStructure,
): string {
  const version = c.version && c.version.trim() ? c.version.trim() : dirNames.unknownVersion;

  if (c.kind === 'single') {
    return structure === 'type-first'
      ? `${dirNames.single}/${version}`
      : `${version}/${dirNames.single}`;
  }

  const kindDir = c.kind === 'official' ? dirNames.official : dirNames.google;
  const chDir = c.channel === 'test' ? dirNames.test : dirNames.release;
  return structure === 'type-first'
    ? `${kindDir}/${version}/${chDir}`
    : `${version}/${kindDir}/${chDir}`;
}

/* ------------------------------------------------------------------ */
/* 筛选与排序                                                          */
/* ------------------------------------------------------------------ */

/** 一个包是否命中筛选条件（多选之间是「或」，不同维度之间是「与」） */
export function matchesFilters(
  e: Pick<PackageEntry, 'version' | 'kind' | 'channel' | 'format' | 'name'>,
  f: PackageFilters,
): boolean {
  if (f.versions.length) {
    const key = e.version && e.version.trim() ? e.version : PACKAGE_UNKNOWN_VERSION_KEY;
    if (!f.versions.includes(key)) return false;
  }
  if (f.kinds.length && !f.kinds.includes(e.kind)) return false;
  if (f.channels.length) {
    if (!e.channel || !f.channels.includes(e.channel)) return false;
  }
  if (f.formats.length && !f.formats.includes(e.format)) return false;
  const k = f.keyword.trim().toLowerCase();
  if (k && !e.name.toLowerCase().includes(k)) return false;
  return true;
}

/** 筛选条件是否为空（用于界面上「清除筛选」按钮的可用态） */
export function isEmptyFilters(f: PackageFilters): boolean {
  return (
    f.versions.length === 0 &&
    f.kinds.length === 0 &&
    f.channels.length === 0 &&
    f.formats.length === 0 &&
    !f.keyword.trim()
  );
}

/** 版本号倒序（新版本在前）；解析不出来的排最后 */
export function compareVersionsDesc(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const KIND_RANK: Record<PackageKind, number> = { official: 0, google: 1, single: 2 };

/** 列表排序：版本倒序 → 类型 → 通道 → 名字 */
export function compareEntries(
  a: Pick<PackageEntry, 'version' | 'kind' | 'channel' | 'name'>,
  b: Pick<PackageEntry, 'version' | 'kind' | 'channel' | 'name'>,
): number {
  const v = compareVersionsDesc(a.version, b.version);
  if (v) return v;
  const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (k) return k;
  const ca = a.channel === 'test' ? 1 : 0;
  const cb = b.channel === 'test' ? 1 : 0;
  if (ca !== cb) return ca - cb;
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}
