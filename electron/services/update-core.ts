/**
 * 增量更新的「纯逻辑」部分：指纹计算、版本比较、manifest 校验、zip 内容核对。
 *
 * 刻意不 import electron —— 这样验收脚本可以拿普通 Node require 进来，
 * 用构造出来的本机快照把每一条拒绝规则各跑一遍（不需要真的装两个版本）。
 * 依赖 electron 的部分（路径解析、spawn helper、app.quit）都在 update.ts。
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, sep } from 'path';
import { extractZip, listZipEntries, readZipEntry, fileSize } from './zip';
import { readPeVersion } from './pe-version';
import type {
  UpdateManifest,
  LocalKind,
  UpdateKind,
  UpdateChannel,
  UpdateLatestDoc,
  UpdateLatestEntry,
  UpdatePackageForm,
  UpdatePackageRef,
  UpdatePackageRefs,
} from '../../shared/types';
import {
  UPDATE_SCHEMA,
  UPDATE_PRODUCT_NAME,
  UPDATE_APP_ID,
  UPDATE_LATEST_SCHEMA,
} from '../../shared/types';

/** 本机状态快照（由 update.ts 依 app / process 组装） */
export interface LocalSnapshot {
  version: string;
  kind: LocalKind;
  packaged: boolean;
  electronVersion: string;
  /** resources/bin 指纹 */
  runtimeHash: string;
  /** 安装版 = <app>/resources；便携版 = 便携版 exe 所在目录 */
  resourcesDir: string;
  binDir: string;
  /** 会被替换的主目标：安装版 = resources/app.asar；便携版 = 便携版 exe 本体 */
  targetPath: string;
}

export interface ValidateResult {
  ok: boolean;
  reason?: string;
  warning?: string;
}

/** 递归列出目录下所有文件（相对路径用 / 分隔） */
export function walkRelFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p.slice(root.length + 1).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * resources/bin 指纹。定义必须与 scripts/make-update.py 的 runtime_fingerprint 一致：
 *   "{相对路径}|{字节数}|{sha256}" 按路径排序 → \n 连接 → sha256
 */
export function computeRuntimeHash(binDirPath: string): string {
  const lines: string[] = [];
  for (const rel of walkRelFiles(binDirPath)) {
    const p = join(binDirPath, rel.split('/').join(sep));
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      continue;
    }
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    lines.push(`${rel}|${size}|${sha}`);
  }
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 语义化版本比较：a>b 返回 1，相等 0，a<b 返回 -1 */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number(pa[i] ?? 0) || 0;
    const y = Number(pb[i] ?? 0) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 取版本前 3 段（PE 里是 4 段，末段常为 0） */
function ver3(v: string): string {
  const p = String(v).split('.');
  while (p.length < 3) p.push('0');
  return p.slice(0, 3).join('.');
}

/** zip 内相对路径 → 本机落盘目标；不认识的路径返回 null */
export function destFor(rel: string, local: LocalSnapshot): string | null {
  if (local.kind === 'portable') {
    return rel === 'portable/app.exe' ? local.targetPath : null;
  }
  if (rel === 'app.asar') return join(local.resourcesDir, 'app.asar');
  if (rel.startsWith('bin/')) return join(local.binDir, rel.slice(4).split('/').join(sep));
  return null;
}

/**
 * 校验 manifest 能不能用在本机。
 * 任何一条不满足都返回明确原因 —— 宁可让用户再去下全量包，也不做「硬来」的替换。
 */
export function validateManifest(m: UpdateManifest, local: LocalSnapshot): ValidateResult {
  if (!m || typeof m !== 'object') return { ok: false, reason: '更新包里没有可用的 manifest.json' };

  if (m.schema !== UPDATE_SCHEMA) {
    return {
      ok: false,
      reason: `更新包格式版本为 ${m.schema}，当前程序只认识 ${UPDATE_SCHEMA}，请使用完整安装包。`,
    };
  }
  if (m.productName !== UPDATE_PRODUCT_NAME) {
    return { ok: false, reason: `这个更新包属于「${m.productName || '未知产品'}」，不是 ${UPDATE_PRODUCT_NAME} 的更新包。` };
  }
  if (m.appId !== UPDATE_APP_ID) {
    return { ok: false, reason: `更新包的产品标识（${m.appId || '缺失'}）与当前程序（${UPDATE_APP_ID}）不符，已拒绝。` };
  }
  if (!m.version || cmpVersion(m.version, local.version) <= 0) {
    return {
      ok: false,
      reason: `更新包版本 v${m.version || '?'} 不比当前版本 v${local.version} 新，已拒绝（需要降级请用「回滚到上一版」）。`,
    };
  }
  if (local.kind === 'dev') {
    return { ok: false, reason: '当前是开发模式（未打包），不提供应用内更新，请使用打包后的版本。' };
  }
  if (m.kind !== local.kind) {
    if (m.kind === 'portable') {
      return { ok: false, reason: '这是便携版整包，当前是安装版。请改用安装版增量包，或直接运行全量安装包。' };
    }
    return {
      ok: false,
      reason: '这是安装版增量包，便携版无法就地替换内部文件（便携版每次启动都会重新解压），请改用便携版整包。',
    };
  }

  // 便携版整包自带运行时，不受电子版本 / 运行库约束；安装版增量必须两者都对得上。
  //
  // ⚠️ 例外：**完整资源包**（m.full === true）不校验运行库基准 —— 它把 `bin/` 整份带过来，
  //    本来就不依赖目标机原有的运行库，这正是「跨版本在线更新」的实现方式
  //    （v1.0.31：让 1.0.2 这种落后很多版本的机器也能一路升到最新）。
  //    Electron 版本仍然要校验：完整资源包里也没有 electron.exe / 那些 dll，
  //    运行时换代只能靠完整安装包。
  if (m.kind === 'asar') {
    if (m.electronVersion !== local.electronVersion) {
      return {
        ok: false,
        reason: `更新包基于 Electron ${m.electronVersion} 构建，当前程序是 Electron ${local.electronVersion} —— 运行时发生了变化，请改用完整安装包。`,
      };
    }
    if (!m.full) {
      if (!m.baseRuntimeHash) {
        return { ok: false, reason: '更新包没有记录运行库基准，无法确认与当前安装匹配，请改用完整安装包。' };
      }
      if (m.baseRuntimeHash !== local.runtimeHash) {
        return {
          ok: false,
          reason: '更新包与当前安装的运行库不一致（adb / scrcpy 等文件有变化），请改用完整安装包。',
        };
      }
    }
  }

  if (!Array.isArray(m.files) || m.files.length === 0) {
    return { ok: false, reason: '更新包里没有任何文件，可能已损坏。' };
  }
  const unknown = m.files.filter((f) => !f || !destFor(f.path, local));
  if (unknown.length) {
    return { ok: false, reason: `更新包里有当前形态无法处理的文件：${unknown.map((x) => x?.path).join('、')}` };
  }
  if (m.kind === 'asar' && !m.files.some((f) => f.path === 'app.asar')) {
    return { ok: false, reason: '更新包里缺少 app.asar，无法构成一次有效更新。' };
  }
  if (m.kind === 'portable' && !m.files.some((f) => f.path === 'portable/app.exe')) {
    return { ok: false, reason: '便携版整包里没有可执行文件。' };
  }

  const runtimeFiles = m.files.filter((f) => f.path.startsWith('bin/')).map((f) => f.path.slice(4));
  const preview = `${runtimeFiles.slice(0, 3).join('、')}${runtimeFiles.length > 3 ? ' 等' : ''}`;
  return {
    ok: true,
    warning: m.full
      ? `本次是完整资源包更新（跨版本），会一并覆盖 ${runtimeFiles.length} 个运行库文件（${preview}）。`
      : runtimeFiles.length
        ? `本次更新同时会替换 ${runtimeFiles.length} 个运行库文件（${preview}）。`
        : undefined,
  };
}

export interface ZipCheck {
  ok: boolean;
  reason?: string;
  totalBytes: number;
  /** rel → 在 zip 内的字节数 */
  sizes: Record<string, number>;
}

/** 核对 zip 里每个文件的大小与 sha256 是否与 manifest 一致 */
export function checkZipContents(zipPath: string, m: UpdateManifest): ZipCheck {
  const buf = readFileSync(zipPath);
  let entries;
  try {
    entries = listZipEntries(buf);
  } catch (e) {
    return { ok: false, reason: `更新包不是有效的压缩包：${(e as Error).message}`, totalBytes: 0, sizes: {} };
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const sizes: Record<string, number> = {};
  let total = 0;

  for (const f of m.files) {
    const e = byName.get(f.path);
    if (!e) return { ok: false, reason: `更新包里缺少 ${f.path}`, totalBytes: total, sizes };
    let data: Buffer;
    try {
      data = readZipEntry(buf, e);
    } catch (err) {
      return { ok: false, reason: `更新包内 ${f.path} 无法解压：${(err as Error).message}`, totalBytes: total, sizes };
    }
    if (data.length !== f.size) {
      return { ok: false, reason: `更新包已损坏：${f.path} 大小应为 ${f.size}，实际 ${data.length}`, totalBytes: total, sizes };
    }
    const sha = sha256Buffer(data);
    if (sha !== f.sha256) {
      return { ok: false, reason: `更新包已损坏：${f.path} 校验值不匹配`, totalBytes: total, sizes };
    }
    sizes[f.path] = data.length;
    total += data.length;
  }

  if (!byName.has('manifest.json')) {
    return { ok: false, reason: '更新包里没有 manifest.json', totalBytes: total, sizes };
  }
  return { ok: true, totalBytes: total, sizes };
}

/**
 * 暂存文件的物理后缀。
 *
 * 🔴 为什么需要：Electron 的 asar fs shim 只看 basename 是不是以 `.asar` 结尾，
 * 是就当成 asar 容器去开 —— 于是普通文件只要叫 `app.asar`，
 * `writeFileSync` 和 `openSync+writeSync` 都会抛 `Invalid package <path>`
 * （大小写不敏感；`payload.asar.new`、`x.asar.txt` 这类不结尾的不受影响）。
 * 本机探针 `scripts/_probe-asar-write.cjs` 实测确认（Electron 33.4.11）。
 *
 * 纯 Node 下没有这个 shim，所以 check-update 的 B/C 段全绿也照样会在真身里炸。
 *
 * 结论：`manifest.files[].path` 这类**逻辑名**保持 `app.asar` 不变（写进 job.json、
 * 交给 PowerShell 助手替换的目标路径都不受影响），只把**暂存目录里的物理名**改掉。
 */
export const STAGE_ASAR_SFX = '.__asar';

/** 逻辑相对路径 → 暂存目录里的物理相对路径（只有以 .asar 结尾的那一段会改名） */
export function stageRel(logical: string): string {
  const segs = logical.split('/');
  const i = segs.length - 1;
  if (/\.asar$/i.test(segs[i])) segs[i] = segs[i] + STAGE_ASAR_SFX;
  return segs.join('/');
}

/** 逻辑相对路径 → 暂存目录里的绝对路径 */
export function stagePathOf(stageDir: string, logical: string): string {
  return join(stageDir, ...stageRel(logical).split('/'));
}

/** 解压到暂存目录，返回落盘的文件相对路径（物理名） */
export function extractToStage(zipPath: string, stageDir: string): string[] {
  return extractZip(readFileSync(zipPath), stageDir, undefined, stageRel);
}

/**
 * 更新助手脚本（update-helper.ps1）的候选路径，按优先顺序。
 *
 * 🔴 这里曾经少写一层目录：tsc 把 `electron/services/update.ts` 输出到
 * `dist-electron/electron/services/update.js`，而 `scripts/copy-assets.cjs` 把脚本
 * 复制到 `dist-electron/assets/` —— 从 services 往上是**两层**。
 * 写成一层时，dev 下靠 `cwd/electron/assets` 那条兜底照样能跑，
 * 打包后 asar 里只有 `dist-electron/**`，直接报「找不到更新助手脚本」。
 *
 * 打包后这些路径都落在 app.asar 内部：`existsSync` / `readFileSync` 走 Electron 的
 * asar shim 可以正常读（脚本正文最终是经 `-EncodedCommand` 传给 PowerShell 的，
 * 不需要磁盘上的真实 .ps1 —— PowerShell 也读不了 asar）。
 */
export function helperScriptCandidates(here: string, cwd: string): string[] {
  return [
    join(here, '..', '..', 'assets', 'update-helper.ps1'), // dist-electron/assets/
    join(here, '..', 'assets', 'update-helper.ps1'), // 旧布局兜底
    join(cwd, 'dist-electron', 'assets', 'update-helper.ps1'), // cwd = 项目根
    join(cwd, 'electron', 'assets', 'update-helper.ps1'), // 原始 TS 资源
  ];
}

/**
 * 便携版整包：校验里面那个 exe 确实是我们的产品、确实是目标版本。
 * 读的是 exe 自己嵌的 PE 版本资源，不信任 manifest 的自报值。
 */
export function verifyPortableExe(exePath: string, manifestVersion: string): ValidateResult {
  if (!existsSync(exePath)) return { ok: false, reason: '便携版整包里没有可执行文件' };
  let info;
  try {
    info = readPeVersion(exePath);
  } catch (e) {
    return { ok: false, reason: `无法读取便携版程序的版本信息：${(e as Error).message}` };
  }
  const name = (info.strings.ProductName || info.strings.FileDescription || '').trim();
  if (name && name !== UPDATE_PRODUCT_NAME) {
    return { ok: false, reason: `便携版整包里的程序是「${name}」，不是 ${UPDATE_PRODUCT_NAME}。` };
  }
  if (info.fileVersion && ver3(info.fileVersion) !== ver3(manifestVersion)) {
    return {
      ok: false,
      reason: `便携版整包里的程序版本是 v${ver3(info.fileVersion)}，与更新包声明的 v${manifestVersion} 不一致。`,
    };
  }
  return { ok: true };
}

export function sizeOf(p: string): number {
  return fileSize(p);
}

/* ------------------------------------------------------------------ */
/* 在线更新：latest.json 解析与选包（纯函数，验收脚本可直接 require）    */
/* ------------------------------------------------------------------ */

/**
 * 规整用户填的更新源地址：缺协议时补 https://，补结尾斜杠。
 * 非法（含非 http/https、乱写的字符串）返回 null。
 * 丢掉 query / hash —— 更新源不该带这些。
 */
export function normalizeBaseUrl(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

/** 更新源地址 → latest.json 的完整 URL */
export function latestUrlFor(baseUrl: string): string | null {
  const b = normalizeBaseUrl(baseUrl);
  if (!b) return null;
  try {
    return new URL('latest.json', b).toString();
  } catch {
    return null;
  }
}

/**
 * 把清单里的包地址解析成绝对 URL。
 * 允许清单写相对路径（如 `ADB桌面助手-v1.0.22-patch.zip`）—— 这样换域名 / 换 CDN
 * 不用重新生成清单，清单本身也不用知道自己的公网地址。
 */
export function resolvePackageUrl(raw: string, baseUrl: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const b = normalizeBaseUrl(baseUrl);
  if (!b) return null;
  try {
    const u = new URL(s, b);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 版本号形状：纯数字点分（1.0.22 / 1.0.22.1） */
function looksLikeVersion(v: unknown): boolean {
  return typeof v === 'string' && /^\d+(\.\d+)*$/.test(v.trim());
}

export interface LatestParseResult {
  ok: boolean;
  /** ok=false 时面向用户的原因 */
  reason?: string;
  /** 解析成功即有（服务端声明的最新版本） */
  entry?: UpdateLatestEntry;
  /** 是否比本机版本新 */
  newer?: boolean;
  /** 与本机形态匹配的包；null = 该版本未提供此形态 */
  pkg?: UpdatePackageRef | null;
}

/**
 * 解析并校验 latest.json。
 *
 * 校验原则与 manifest 一致：拿不准就拒绝，宁可让用户去下全量包。
 * 这里**不做**安全判定（那在包内 manifest 里），只保证「这份清单是本产品的、
 * 结构可认、指向的包形态对得上」。
 */
export function parseLatestJson(
  text: string,
  localVersion: string,
  kind: LocalKind,
  channel: UpdateChannel,
): LatestParseResult {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: '更新源返回了空内容，请稍后重试。' };

  let doc: UpdateLatestDoc;
  try {
    doc = JSON.parse(raw) as UpdateLatestDoc;
  } catch {
    return {
      ok: false,
      reason: '更新源返回的内容不是合法 JSON —— 可能是网络网关、公司代理或 CDN 的错误页。',
    };
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, reason: '更新源返回的内容结构不对（不是对象）。' };
  }

  if (doc.schema !== UPDATE_LATEST_SCHEMA) {
    return {
      ok: false,
      reason: `更新源使用格式版本 ${doc.schema ?? '(缺失)'}，当前程序只认识 ${UPDATE_LATEST_SCHEMA}，请改用完整安装包升级。`,
    };
  }
  if (doc.productName !== UPDATE_PRODUCT_NAME) {
    return {
      ok: false,
      reason: `这个更新源提供的是「${doc.productName || '未知产品'}」的更新，不是 ${UPDATE_PRODUCT_NAME}。`,
    };
  }
  if (doc.appId !== UPDATE_APP_ID) {
    return {
      ok: false,
      reason: `更新源的产品标识（${doc.appId || '缺失'}）与当前程序（${UPDATE_APP_ID}）不符，已拒绝。`,
    };
  }
  if (doc.channel !== channel) {
    return {
      ok: false,
      reason: `更新源当前提供的是「${doc.channel || '未知'}」通道，本机设置的是「${channel}」通道。`,
    };
  }

  const entry = doc.latest;
  if (!entry || typeof entry !== 'object') {
    return { ok: false, reason: '更新源里没有 latest 版本信息。' };
  }
  if (!looksLikeVersion(entry.version)) {
    return { ok: false, reason: `更新源里的版本号「${String(entry.version)}」不是合法版本号。` };
  }
  if (!entry.packages || typeof entry.packages !== 'object') {
    return { ok: false, reason: '更新源里没有列出任何更新包。' };
  }

  const newer = cmpVersion(entry.version, localVersion) > 0;
  const pkgRaw = kind === 'dev' ? undefined : entry.packages[kind as UpdateKind];
  const pkg: UpdatePackageRef | null =
    pkgRaw && typeof pkgRaw === 'object' && String(pkgRaw.url || '').trim() ? pkgRaw : null;

  return { ok: true, entry, newer, pkg };
}

export interface PackagePick {
  /** 选中的包；null = 这个版本没有能用在本机的包（看 note 里的原因） */
  pkg: UpdatePackageRef | null;
  /** 选中包的形态；null = 没选上 */
  form: UpdatePackageForm | null;
  /** 选了非首选包（或一个都没选上）时，面向用户的一句话 */
  note?: string;
}

/**
 * 从 latest.json 里挑出**最合适本机**的那一份包（v1.0.31 起）。
 *
 * 为什么要单独成函数：老流程写死 `packages[kind]`，而 `baseRuntimeHash` 是**严格相等**校验 ——
 * 一个版本只能服务一种运行库基线。于是「落后几个版本没更新」的用户必然被拒
 * （1.0.2 用户面对 1.0.35 的补丁就是这种情况），只能自己去下全量安装包。
 *
 * 现在的挑包顺序：
 *   ① 变体 / 默认包里 baseRuntimeHash **精确匹配**本机 → 用它（体积最小）
 *   ② 没有任何一份声明基准 → 用默认那份，把判定交给包内 manifest（保持 v1.0.22~v1.0.30 老行为）
 *   ③ 有 `packages.full`（完整资源包）→ 用它。它带全部 bin，**不看运行库基准**，
 *      跨多少个版本都能一次升到位 —— 这就是「跨版本在线更新」
 *   ④ 有包但都对不上、又没有 full → 返回 null + note，让界面直接告诉用户去下全量包，
 *      而不是让人白下几十 MB 再被拒
 *
 * 纯函数、不碰网络，验收脚本可以直接 require 进来逐条跑。
 */
export function pickPackage(
  entry: UpdateLatestEntry,
  kind: LocalKind,
  localRuntimeHash?: string,
): PackagePick {
  if (kind === 'dev') return { pkg: null, form: null };

  const packs = (entry.packages || {}) as UpdatePackageRefs;
  const usable = (r?: UpdatePackageRef | null): r is UpdatePackageRef =>
    !!r && typeof r === 'object' && String(r.url || '').trim() !== '';

  // 变体只对安装版小包有意义（我们只出 asar 变体；便携版是「替换 exe 本体」的整包，
  // 没有差分这回事）。不加这个门，便携版会被当成能装 asar 的补丁 —— 实测就是这么中的招。
  const variants = kind === 'asar' && Array.isArray(entry.variants) ? entry.variants : [];
  const patches = [...variants, packs[kind as UpdateKind]].filter(usable);
  const full = usable(packs.full) ? packs.full : null;

  // ① 精确匹配的差分小包
  if (localRuntimeHash) {
    const exact = patches.find((v) => v.baseRuntimeHash === localRuntimeHash);
    if (exact) return { pkg: exact, form: kind as UpdatePackageForm };
  }

  // ② 没声明基准的「老式」包：基准在包内 manifest 里，交给它判
  const legacy = patches.find((v) => !v.baseRuntimeHash);
  if (legacy) return { pkg: legacy, form: kind as UpdatePackageForm };

  // ③ 完整资源包兜底：不看运行库基准，跨版本一次到位
  if (full) {
    return {
      pkg: full,
      form: 'full',
      note: `本机版本（运行库与本版不一致）与最新版之间跨度较大，本次将下载完整资源包，一次升到位。`,
    };
  }

  // ④ 有包但一个都对不上 → 明确说清楚，别让用户白下
  if (patches.length) {
    return {
      pkg: null,
      form: null,
      note: '更新源里没有适配本机运行库的增量包（版本跨度较大）。请到更新源下载完整安装包覆盖安装。',
    };
  }
  return { pkg: null, form: null };
}

/** 该版本没有本机形态的包时，给一句人话（两种形态的说法不一样） */
export function noPackageReason(kind: LocalKind, version: string): string {
  if (kind === 'portable') {
    return `v${version} 没有提供便携版整包（只有安装版增量包）。便携版无法就地替换内部文件，请下载完整便携包手动替换。`;
  }
  return `v${version} 没有提供安装版增量包（可能只带了便携版整包）。请下载完整安装包。`;
}

/** 人类可读的包体积 */
export function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
