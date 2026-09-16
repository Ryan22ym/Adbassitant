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
import type { UpdateManifest, LocalKind } from '../../shared/types';
import { UPDATE_SCHEMA, UPDATE_PRODUCT_NAME, UPDATE_APP_ID } from '../../shared/types';

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

  // 便携版整包自带运行时，不受电子版本 / 运行库约束；安装版增量必须两者都对得上
  if (m.kind === 'asar') {
    if (m.electronVersion !== local.electronVersion) {
      return {
        ok: false,
        reason: `更新包基于 Electron ${m.electronVersion} 构建，当前程序是 Electron ${local.electronVersion} —— 运行时发生了变化，请改用完整安装包。`,
      };
    }
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
  return {
    ok: true,
    warning: runtimeFiles.length
      ? `本次更新同时会替换 ${runtimeFiles.length} 个运行库文件（${runtimeFiles.slice(0, 3).join('、')}${runtimeFiles.length > 3 ? ' 等' : ''}）。`
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
