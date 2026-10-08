/**
 * 安装包管理 —— 磁盘层（扫描 / 移动）
 * ============================================================
 * 这里只做两件事：**递归找包** 与 **把包挪到该去的地方**。
 * 规则（哪个包算哪一类、该落到哪个目录）全在 `shared/packages.ts`，
 * 这个文件不重复实现一遍判据。
 *
 * 刻意**不 import electron** —— 这样 `scripts/check-packages.cjs` 能在纯 node 下
 * 直接 require 编译产物、拿临时目录跑真实的移动用例（见该脚本注释）。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  DEFAULT_PACKAGE_KEYWORDS,
  classifyWithOverride,
  compareEntries,
  formatOf,
  targetDirOf,
} from '../../shared/packages';
import type {
  PackageDirNames,
  PackageEntry,
  PackageKeywords,
  PackageOrganizeResult,
  PackageOverrideMap,
  PackageScanResult,
  PackageStructure,
} from '../../shared/types';

/** 一套整理配置（根目录 + 目录名 + 结构 + 关键字 + 手动标签） */
export interface PackageConfig {
  root: string;
  dirNames: PackageDirNames;
  structure: PackageStructure;
  keywords?: PackageKeywords;
  /** 用户手工钉死的 类型/通道/版本（按文件名），优先级高于自动识别 */
  overrides?: PackageOverrideMap;
}

/** 递归深度上限：仓库最多也就「版本/类型/通道」三层的量级，防呆用 */
const MAX_DEPTH = 6;
/** 永不进入的目录 */
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information']);

/** 统一成 POSIX 分隔符：界面展示、筛选比较、排序都用它 */
export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Windows 下路径大小写不敏感，比较位置时要抹平 */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * 工作目录的安全闸门。
 *
 * 「整理」是按规则移动文件，配置错一个字符就可能把整个磁盘翻个遍 ——
 * 盘符根、用户主目录这类位置一律拒绝，让用户挑一个专用文件夹。
 */
export function checkRootUsable(root: string, homeDir?: string): string | null {
  const r = String(root || '').trim();
  if (!r) return '还没有设置工作目录';
  if (!isAbsolute(r)) return '工作目录必须是绝对路径';
  const norm = resolve(r);
  if (samePath(norm, dirname(norm))) return '工作目录不能是盘符根目录，请选一个专用文件夹';
  if (homeDir && samePath(norm, resolve(homeDir))) return '工作目录不能直接选用户主目录，请选一个专用文件夹';
  return null;
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

interface FoundFile {
  absPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  /** 从近到远的上级目录名（不含工作目录本身），用于兜底版本号 */
  parents: string[];
}

function walk(root: string, dir: string, depth: number, parents: string[], out: FoundFile[], counters: { ignored: number }): void {
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch {
    // 目录读不了（权限 / 被占用）不该让整次扫描失败
    return;
  }

  for (const name of items) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      if (depth >= MAX_DEPTH) continue;
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      if (name.startsWith('.')) continue;
      walk(root, abs, depth + 1, [name, ...parents], out, counters);
      continue;
    }
    if (!st.isFile()) continue;

    // 临时文件 / 隐藏文件不参与整理
    if (name.startsWith('~$') || name.startsWith('.')) continue;

    if (!formatOf(name)) {
      counters.ignored += 1;
      continue;
    }
    out.push({ absPath: abs, name, size: st.size, mtimeMs: st.mtimeMs, parents });
  }
}

/** 扫描工作目录并算出每个包「应该在哪」（不落盘、不动文件） */
export function scanPackages(cfg: PackageConfig): PackageScanResult {
  const root = resolve(cfg.root);
  const kw = cfg.keywords ?? DEFAULT_PACKAGE_KEYWORDS;
  const empty: PackageScanResult = {
    root,
    exists: false,
    entries: [],
    pending: 0,
    versions: [],
    stats: {
      total: 0,
      bytes: 0,
      byKind: { official: 0, google: 0, single: 0 },
      byChannel: { release: 0, test: 0 },
      byFormat: { apk: 0, aab: 0 },
      ignored: 0,
    },
    dirs: [],
    scannedAt: Date.now(),
  };

  if (!existsSync(root)) return empty;

  const found: FoundFile[] = [];
  const counters = { ignored: 0 };
  walk(root, root, 0, [], found, counters);

  const entries: PackageEntry[] = [];
  for (const f of found) {
    const format = formatOf(f.name)!;
    // 自动识别 → 再套用户手工标签（手工优先），整理与筛选都看这最终一份
    const c = classifyWithOverride(f.name, format, f.parents, kw, cfg.overrides);
    const targetDir = targetDirOf(c, cfg.dirNames, cfg.structure);
    const targetPath = join(root, ...targetDir.split('/'), f.name);
    entries.push({
      absPath: f.absPath,
      relPath: toPosix(relative(root, f.absPath)),
      name: f.name,
      format,
      size: f.size,
      mtimeMs: f.mtimeMs,
      version: c.version,
      versionFrom: c.versionFrom,
      rawVersion: c.rawVersion,
      build: c.build,
      kind: c.kind,
      channel: c.channel,
      targetDir,
      targetPath,
      organized: samePath(f.absPath, targetPath),
      overridden: !!c.overridden,
    });
  }

  entries.sort(compareEntries);

  const stats = empty.stats;
  stats.total = entries.length;
  stats.ignored = counters.ignored;
  for (const e of entries) {
    stats.bytes += e.size;
    stats.byKind[e.kind] += 1;
    stats.byFormat[e.format] += 1;
    if (e.channel) stats.byChannel[e.channel] += 1;
  }

  const versions = Array.from(
    new Set(entries.map((e) => e.version).filter((v): v is string => !!v && !!v.trim())),
  );
  versions.sort((a, b) => {
    const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
    const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });

  return {
    root,
    exists: true,
    entries,
    pending: entries.filter((e) => !e.organized).length,
    versions,
    stats,
    dirs: Array.from(new Set(entries.map((e) => e.targetDir))).sort(),
    scannedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* 移动                                                                */
/* ------------------------------------------------------------------ */

/** 同目录内找一个不撞名的路径：`x.apk` → `x (2).apk` */
function uniquePath(target: string): string {
  const dir = dirname(target);
  const ext = extname(target);
  const base = basename(target, ext);
  for (let i = 2; i < 1000; i++) {
    const p = join(dir, `${base} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
  return join(dir, `${base} (${Date.now()})${ext}`);
}

/** 跨盘 rename 会 EXDEV，退化成「拷贝 + 删源」 */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw e;
  }
  copyFileSync(from, to);
  unlinkSync(from);
}

/**
 * 执行整理。**幂等**：已经在该在位置的文件不动，重复调用只会有 0 次移动。
 *
 * 同名冲突的处理：目标位置已有同名文件时，**先比大小** ——
 * 一样大按「同一个包」处理（原地留下、计入 skipped），
 * 不一样大才加 `(2)` 后缀搬过去，绝不覆盖任何一个文件。
 */
export function organizePackages(cfg: PackageConfig): PackageOrganizeResult {
  const before = scanPackages(cfg);
  const details: { from: string; to: string }[] = [];
  const failed: { name: string; error: string }[] = [];
  let moved = 0;
  let skipped = 0;

  for (const e of before.entries) {
    if (e.organized) {
      skipped += 1;
      continue;
    }

    let target = e.targetPath;
    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch (err) {
      failed.push({ name: e.name, error: `建目录失败：${(err as Error).message}` });
      continue;
    }

    if (existsSync(target)) {
      let sameSize = false;
      try {
        sameSize = statSync(target).size === e.size;
      } catch {
        sameSize = false;
      }
      if (sameSize) {
        // 同名同大小：认定是同一个包，原地不动（信息不丢，运行日志里也会写一行）
        skipped += 1;
        continue;
      }
      target = uniquePath(target);
    }

    try {
      moveFile(e.absPath, target);
      moved += 1;
      details.push({ from: e.absPath, to: target });
    } catch (err) {
      failed.push({ name: e.name, error: (err as Error).message });
    }
  }

  return { root: before.root, moved, skipped, failed, details, scan: scanPackages(cfg) };
}
