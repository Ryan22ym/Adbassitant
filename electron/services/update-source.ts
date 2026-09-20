/**
 * 更新源抽象（v1.0.22）。
 *
 * `docs/update-design.md` §3.1 从 v1.0.7 起就写着「更新源抽象成接口，为第二阶段上服务器铺路」，
 * 但代码里一直只有「用户选本地文件」这一条路，接口从未落地。这里把它补上：
 *
 *   httpSource      —— 从更新源拉 latest.json、按本机形态选包、下载（本次新增）
 *   localFileSource —— 用户手动选的本地包（把 v1.0.7 起的流程包成同一个接口，行为不变）
 *
 * 注意分工：本文件只负责「把包弄到本地」（下载 / 选文件），
 * **包的合法性判定一行都不在这里** —— 那是 update-core.ts 的 manifest 校验，
 * 由 update.ts 的 prepareUpdate() 统一执行。
 */
import { basename, join } from 'path';
import { tmpdir } from 'os';
import type {
  LocalKind,
  UpdateChannel,
  UpdateDownloadProgress,
  UpdateManifest,
  UpdatePackageRef,
} from '../../shared/types';
import {
  cmpVersion,
  latestUrlFor,
  noPackageReason,
  normalizeBaseUrl,
  parseLatestJson,
  resolvePackageUrl,
} from './update-core';
import { downloadToFile, httpGetText } from './update-net';
import { readZipFileText } from './zip';

export interface LatestInfo {
  /** 服务端声明的最新版本 */
  version: string;
  publishedAt?: string;
  notes?: string;
  critical?: boolean;
  /** 是否比本机新（check() 已按本机版本算好） */
  newer: boolean;
  /** 与本机形态匹配的包；null = 该版本未提供此形态（fetch 会拒绝） */
  pkg: UpdatePackageRef | null;
  /** 面向用户的源描述 */
  sourceDesc: string;
  /** 清单里列出的全部形态，供界面提示「这个版本只有便携包」用 */
  allPackages?: Record<string, UpdatePackageRef>;
}

export interface UpdateSource {
  kind: 'local-file' | 'http';
  /** 面向用户的描述，如「更新源（example.com）」 */
  describe(): string;
  /** 拉清单 / 读本地包信息；失败抛错（错误消息面向用户，可直接展示） */
  check(): Promise<LatestInfo>;
  /** 把包弄到本地（http 会下载），返回本地已就绪的 zip 路径 */
  fetch(onProgress?: (p: UpdateDownloadProgress) => void): Promise<string>;
}

export interface HttpSourceOptions {
  /** 更新源根地址（可缺协议前缀，内部会规整） */
  baseUrl: string;
  /** 本机版本，用于判断是否更新 */
  localVersion: string;
  /** 本机形态（dev 时调用方不该走到这里） */
  kind: LocalKind;
  channel: UpdateChannel;
  /** 下载落盘目录；默认 %TEMP%\adba-update-dl-<ts> */
  downloadDir?: string;
}

/** 「更新源（host/末级目录）」—— 只露域名与目录名，不把整条路径糊在界面上 */
export function describeSource(baseUrl: string): string {
  const b = normalizeBaseUrl(baseUrl);
  if (!b) return '未配置';
  try {
    const u = new URL(b);
    const segs = u.pathname.split('/').filter(Boolean);
    const tail = segs.length ? `/${segs[segs.length - 1]}` : '';
    return `更新源（${u.host}${tail}）`;
  } catch {
    return '更新源';
  }
}

/**
 * 从 URL 里取一个安全的本地文件名。
 * 取不到就用 nameHint；后缀强制是 .zip —— 更新包永远是 zip。
 */
export function safeFileNameFromUrl(url: string, nameHint = 'update-patch.zip'): string {
  let name = '';
  try {
    const p = new URL(url).pathname;
    // 以 / 结尾说明这个地址指向的是目录而不是文件 → 用默认名，
    // 否则会把目录名（如 /adb-assistant/ → adb-assistant.zip）当成包名。
    if (!p.endsWith('/')) {
      name = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    }
  } catch {
    name = '';
  }
  name = name.replace(/[\\/:*?"<>|\s]/g, '_').trim();
  if (!name) name = nameHint;
  if (!/\.zip$/i.test(name)) name = `${name.replace(/\.zip$/i, '')}.zip`;
  // 兜底：不能是 `.` / `..` 这类开头的隐藏名
  if (name.startsWith('.')) name = `patch${name}`;
  return name;
}

/** 更新源（HTTP）。check() 只读清单，fetch() 才下包 */
export function httpSource(opts: HttpSourceOptions): UpdateSource {
  const base = normalizeBaseUrl(opts.baseUrl) || '';
  const sourceDesc = describeSource(opts.baseUrl);
  /** fetch() 用的绝对 URL（check() 里解析好，避免 fetch 再拉一次清单） */
  let ready: { absUrl: string; sha256?: string; version: string } | null = null;

  const check = async (): Promise<LatestInfo> => {
    if (!base) throw new Error('更新源地址无效，请到「设置」里检查更新源填写。');
    const latestUrl = latestUrlFor(base);
    if (!latestUrl) throw new Error('更新源地址无效，请到「设置」里检查更新源填写。');

    const res = await httpGetText(latestUrl);
    const parsed = parseLatestJson(res.text, opts.localVersion, opts.kind, opts.channel);
    if (!parsed.ok || !parsed.entry) {
      throw new Error(parsed.reason || '更新源返回的版本清单无法识别。');
    }
    const entry = parsed.entry;

    // 清单允许写相对路径 —— 这里一次性解析成绝对 URL，fetch 直接用
    let pkg: UpdatePackageRef | null = null;
    if (parsed.pkg) {
      const abs = resolvePackageUrl(parsed.pkg.url, base);
      if (!abs) throw new Error(`更新源里的包地址无法解析：${parsed.pkg.url}`);
      pkg = { ...parsed.pkg, url: abs };
    }
    ready = pkg ? { absUrl: pkg.url, sha256: pkg.sha256, version: entry.version } : null;

    return {
      version: entry.version,
      publishedAt: entry.publishedAt,
      notes: entry.notes,
      critical: entry.critical,
      newer: !!parsed.newer,
      pkg,
      sourceDesc,
      allPackages: entry.packages as Record<string, UpdatePackageRef>,
    };
  };

  const fetchPkg = async (onProgress?: (p: UpdateDownloadProgress) => void): Promise<string> => {
    if (!ready) await check();
    if (!ready) {
      throw new Error(
        '这个版本没有提供当前形态的更新包，无法自动更新。请到更新源手动下载完整安装包。',
      );
    }
    if (opts.kind === 'dev') throw new Error('开发模式下不提供应用内更新。');

    const dir = opts.downloadDir || join(tmpdir(), `adba-update-dl-${Date.now()}`);
    const dest = join(dir, safeFileNameFromUrl(ready.absUrl));

    // 下载完先按清单声明的 sha256 校验（第一道），包内 manifest 的逐文件 sha256 是第二道
    const r = await downloadToFile(ready.absUrl, dest, ready.sha256, { onProgress });
    return r.path;
  };

  return { kind: 'http', describe: () => sourceDesc, check, fetch: fetchPkg };
}

/**
 * 本地文件源：把「用户选一个 *-patch.zip」包成同一接口。
 * check() 读 zip 里的 manifest.json 拿版本；fetch() 直接返回该路径（无需搬运）。
 */
export function localFileSource(zipPath: string): UpdateSource {
  const name = basename(zipPath || '');

  const check = async (): Promise<LatestInfo> => {
    const txt = readZipFileText(zipPath, 'manifest.json');
    if (!txt) {
      throw new Error(
        '这个文件里没有 manifest.json —— 请选择「*-patch.zip」形式的小更新包（完整安装包 .exe 不能在这里更新）。',
      );
    }
    let manifest: UpdateManifest;
    try {
      manifest = JSON.parse(txt) as UpdateManifest;
    } catch (e) {
      throw new Error(`无法读取更新包：${(e as Error).message}`);
    }
    return {
      version: String(manifest.version || ''),
      newer: true, // 是否真的能更新由 prepareUpdate 的 manifest 校验说了算
      pkg: null,
      sourceDesc: '本地文件',
    };
  };

  return {
    kind: 'local-file',
    describe: () => (name ? `本地文件（${name}）` : '本地文件'),
    check,
    fetch: async () => zipPath,
  };
}

/** 版本比较的薄封装，便于上层统一口径 */
export function isNewer(latest: string, current: string): boolean {
  return cmpVersion(latest, current) > 0;
}

/** 该版本没提供本机形态的包时，给一句人话 */
export function missingPackageReason(kind: LocalKind, version: string): string {
  return noPackageReason(kind, version);
}
