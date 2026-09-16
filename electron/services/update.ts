/**
 * 应用内增量更新（v1.0.7）。
 *
 * 核心约束（都实测过，见 docs/update-design.md）：
 * 1. 运行期间 resources/app.asar 被独占锁定 → 不能在自己的进程里替换自己，
 *    也不能「再起一个自己的实例来替换」（那个实例同样锁 asar），只能用外部的
 *    PowerShell 助手（见 electron/assets/update-helper.ps1）。
 * 2. 「更新成功」的判据 = 新版渲染层完成一次 IPC 握手，而不是「主进程活着」——
 *    否则主进程活着但白屏会被判成成功。
 * 3. 装错 / 装坏的代价很高，所以凡是拿不准的情况一律拒绝，让用户去装全量包。
 *
 * 纯逻辑（指纹 / 版本比较 / manifest 校验 / zip 核对）在 update-core.ts，
 * 那边不 import electron，验收脚本可以直接 require。
 */
import { app, shell } from 'electron';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { binDir, log, adbKillServer } from './adb';
import { stopMirror } from './mirror';
import { stopLogcat } from './logcat';
import { stopWeakNet } from './weaknet';
import {
  checkZipContents,
  computeRuntimeHash,
  cmpVersion,
  destFor,
  extractToStage,
  helperScriptCandidates,
  stagePathOf,
  validateManifest,
  verifyPortableExe,
  type LocalSnapshot,
} from './update-core';
import { readZipFileText } from './zip';
import type { LocalKind, UpdateContext, UpdateInfo, UpdateManifest, UpdateResult } from '../../shared/types';

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

function stateDir(): string {
  return join(app.getPath('userData'), 'update');
}
function pendingPath(): string {
  return join(stateDir(), 'pending.json');
}
function healthPath(): string {
  return join(stateDir(), 'health.ok');
}
function resultPath(): string {
  return join(stateDir(), 'result.json');
}
function helperLogPath(): string {
  return join(stateDir(), 'helper.log');
}
function backupRoot(): string {
  return join(stateDir(), 'backup');
}
function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function readJson<T>(p: string): T | null {
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(p: string, data: unknown) {
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function tsStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* 本机快照                                                            */
/* ------------------------------------------------------------------ */

function localKind(): LocalKind {
  if (!app.isPackaged) return 'dev';
  return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'asar';
}

export function localSnapshot(): LocalSnapshot {
  const kind = localKind();
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || '';
  const bd = binDir();
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'dist');
  const targetPath =
    kind === 'portable'
      ? portableExe
      : kind === 'asar'
        ? join(resourcesDir, 'app.asar')
        : '';
  return {
    version: app.getVersion(),
    kind,
    packaged: app.isPackaged,
    electronVersion: process.versions.electron || '',
    runtimeHash: computeRuntimeHash(bd),
    resourcesDir,
    binDir: bd,
    targetPath,
  };
}

/** 目标目录能不能写（提前拦住只读位置 / U 盘写保护） */
function isWritableDir(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  const probe = join(dir, `.adba-wtest-${process.pid}`);
  try {
    writeFileSync(probe, 'x');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

interface BackupMeta {
  dir: string;
  fromVersion: string;
  toVersion: string;
  at: string;
}

/** 最近一份备份（只保留一份，便携版备份有 84 MB，不能堆积） */
export function latestBackup(): BackupMeta | null {
  const root = backupRoot();
  if (!existsSync(root)) return null;
  let best: BackupMeta | null = null;
  let bestTime = 0;
  for (const name of readdirSync(root)) {
    const rp = join(root, name, 'restore.json');
    const meta = readJson<{ fromVersion?: string; toVersion?: string; at?: string }>(rp);
    if (!meta) continue;
    let t = 0;
    try {
      t = statSync(rp).mtimeMs;
    } catch {
      continue;
    }
    if (t > bestTime) {
      bestTime = t;
      best = {
        dir: join(root, name),
        fromVersion: meta.fromVersion || '',
        toVersion: meta.toVersion || '',
        at: meta.at || '',
      };
    }
  }
  return best;
}

export function getUpdateContext(): UpdateContext {
  const s = localSnapshot();
  const updateDir = stateDir();
  ensureDir(updateDir);
  const backup = latestBackup();
  const targetDir = s.targetPath ? dirname(s.targetPath) : '';
  const writable = targetDir ? isWritableDir(targetDir) : false;

  let disabledReason: string | undefined;
  if (!s.packaged) disabledReason = '开发模式（未打包）下不提供应用内更新';
  else if (!s.targetPath) disabledReason = '无法定位需要替换的程序文件';
  else if (!writable) disabledReason = '程序所在目录不可写（可能装在受保护位置或移动设备上）';

  return {
    version: s.version,
    kind: s.kind,
    packaged: s.packaged,
    electronVersion: s.electronVersion,
    runtimeHash: s.runtimeHash,
    targetPath: s.targetPath,
    targetWritable: writable,
    canUpdate: !disabledReason,
    disabledReason,
    hasBackup: !!backup,
    backupVersion: backup?.fromVersion || undefined,
    updateDir,
  };
}

/* ------------------------------------------------------------------ */
/* 准备（选包 → 校验 → 解压到暂存）                                     */
/* ------------------------------------------------------------------ */

interface Prepared {
  info: UpdateInfo;
  manifest: UpdateManifest;
  stageDir: string;
  snapshot: LocalSnapshot;
  targets: { name: string; src: string; dest: string }[];
}

let prepared: Prepared | null = null;

export function cancelUpdate(): boolean {
  const had = !!prepared;
  if (prepared) {
    try {
      rmSync(prepared.stageDir, { recursive: true, force: true });
    } catch {
      /* 暂存目录在 %TEMP%，删不掉也无所谓 */
    }
  }
  prepared = null;
  return had;
}

export function preparedInfo(): UpdateInfo | null {
  return prepared?.info ?? null;
}

export async function prepareUpdate(zipPath: string): Promise<UpdateInfo> {
  cancelUpdate();

  const s = localSnapshot();
  const base: UpdateInfo = { ok: false, zipPath, zipSize: 0 };
  const fail = (reason: string, manifest?: UpdateManifest): UpdateInfo => ({ ...base, manifest, reason });

  if (!zipPath || !existsSync(zipPath)) return fail('更新包文件不存在');
  try {
    base.zipSize = statSync(zipPath).size;
  } catch {
    return fail('无法读取更新包文件');
  }
  if (base.zipSize > 2 * 1024 * 1024 * 1024) return fail('更新包体积异常，已拒绝');

  let manifest: UpdateManifest;
  try {
    const txt = readZipFileText(zipPath, 'manifest.json');
    if (!txt) {
      return fail('这个文件里没有 manifest.json —— 请选择「*-patch.zip」形式的小更新包（完整安装包 .exe 不能在这里更新）。');
    }
    manifest = JSON.parse(txt) as UpdateManifest;
  } catch (e) {
    return fail(`无法读取更新包：${(e as Error).message}`);
  }

  const meta = { ...base, manifest };
  const v = validateManifest(manifest, s);
  if (!v.ok) return { ...meta, reason: v.reason };
  if (v.warning) meta.warning = v.warning;

  const zc = checkZipContents(zipPath, manifest);
  if (!zc.ok) return { ...meta, reason: zc.reason };

  const stageDir = join(tmpdir(), `adba-update-${Date.now()}`);
  try {
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    extractToStage(zipPath, stageDir);
  } catch (e) {
    return { ...meta, reason: `解压更新包失败：${(e as Error).message}` };
  }

  if (manifest.kind === 'portable') {
    const pe = verifyPortableExe(stagePathOf(stageDir, 'portable/app.exe'), manifest.version);
    if (!pe.ok) {
      rmSync(stageDir, { recursive: true, force: true });
      return { ...meta, reason: pe.reason };
    }
  }

  const targets: Prepared['targets'] = [];
  for (const f of manifest.files) {
    const src = stagePathOf(stageDir, f.path);
    const dest = destFor(f.path, s);
    if (!dest) {
      rmSync(stageDir, { recursive: true, force: true });
      return { ...meta, reason: `更新包里的 ${f.path} 无法映射到本机位置` };
    }
    if (!existsSync(src)) {
      rmSync(stageDir, { recursive: true, force: true });
      return { ...meta, reason: `解压后缺少 ${f.path}，更新包可能已损坏` };
    }
    targets.push({ name: f.path, src, dest });
  }

  // 目标目录可写性：现在就探测，别等到应用退出了才发现换不了
  for (const dir of new Set(targets.map((t) => dirname(t.dest)))) {
    if (!isWritableDir(dir)) {
      rmSync(stageDir, { recursive: true, force: true });
      return { ...meta, reason: `目录不可写，无法替换程序文件：${dir}` };
    }
  }

  const info: UpdateInfo = {
    ...meta,
    ok: true,
    stageDir,
    fileCount: targets.length,
    totalBytes: zc.totalBytes,
    runtimeFiles: manifest.files.filter((f) => f.path.startsWith('bin/')).map((f) => f.path.slice(4)),
  };

  prepared = { info, manifest, stageDir, snapshot: s, targets };
  log('info', '更新', `已就绪：v${s.version} → v${manifest.version}（${(base.zipSize / 1024).toFixed(0)} KB，${targets.length} 个文件）`);
  return info;
}

/* ------------------------------------------------------------------ */
/* 应用 / 回滚                                                         */
/* ------------------------------------------------------------------ */

/** 更新助手脚本：优先取编译产物，退回源码目录（开发/测试时） */
function resolveHelperScript(): string {
  const cands = helperScriptCandidates(__dirname, process.cwd());
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error('找不到更新助手脚本（update-helper.ps1）');
}

interface HelperJob {
  schema: number;
  mode: 'apply' | 'restore';
  kind: string;
  pid: number;
  staging: string;
  resultPath: string;
  pendingPath: string;
  healthPath: string;
  backupDir: string;
  logPath: string;
  fromVersion: string;
  toVersion: string;
  targets: { name: string; src: string; dest: string }[];
  launchExe: string;
  launchArgs: string[];
  workDir: string;
  healthTimeoutSec: number;
}

/**
 * 把助手脚本落到暂存目录（__STAGING__ 换成真实路径），返回落地的 .ps1 路径。
 *
 * 为什么落地成文件再 -File 跑，而不是整段 -EncodedCommand：
 *  · 命令行里只有路径，不用塞几十 KB 的 base64；
 *  · 落地必须带 UTF-8 BOM —— PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解，
 *    脚本里的中文注释会变成乱码，严重时把引号吃掉、整个脚本解析失败（静默不执行）。
 */
function stageHelperScript(staging: string): string {
  const src = resolveHelperScript();
  let text = readFileSync(src, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.includes('__STAGING__')) throw new Error('更新助手脚本缺少 __STAGING__ 占位符');
  const out = join(staging, 'update-helper.ps1');
  writeFileSync(out, '\ufeff' + text.split('__STAGING__').join(staging), 'utf8');
  return out;
}

/**
 * 启动更新助手。**这是整个更新里最容易踩坑的一处，改之前先看 README 的对应条目。**
 *
 * 为什么不能直接 `spawn(powershell, ...)`：
 *  1. 应用进程处在一个带 KILL_ON_JOB_CLOSE 的作业对象里（实测 LimitFlags=0x3C00，
 *     含 KILL_ON_JOB_CLOSE / BREAKAWAY_OK / SILENT_BREAKAWAY_OK / DIE_ON_UNHANDLED_EXCEPTION）。
 *     直接生的子进程也在这个作业里 —— app.exit(0) 一执行，助手立刻被连坐杀掉。
 *     症状是「helper.log 一行都没有 / 自动回滚永远不触发」，而且不报任何错。
 *  2. 加 detached:true 更糟：那是 DETACHED_PROCESS，PowerShell 会**退出码 0 但一行都不执行**
 *     （连它自己的日志都不写），比被杀掉还难查。
 *  3. stdio 也不能用 'ignore' 之外的花样：给 pipe 却不读，子进程写满就卡住。
 *
 * 实测可行的做法是让进程由 ShellExecute 代建（`cmd /c start "" /b`），这样起来的
 * PowerShell 不属于应用的作业对象：宿主退出后它照样跑（20 秒长任务实测 10/10 全活）。
 * 同理，助手最后 Start-Process 拉起的新版也不会被连坐。
 */
function spawnHelper(staging: string): { pid: number; scriptPath: string } {
  const scriptPath = stageHelperScript(staging);

  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const psMaybe = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const ps = existsSync(psMaybe) ? psMaybe : 'powershell.exe';
  const cmdExe = join(sysRoot, 'System32', 'cmd.exe');

  const child = spawn(
    cmdExe,
    ['/c', 'start', '', '/b', ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { stdio: 'ignore', cwd: tmpdir() },
  );
  child.unref();
  return { pid: child.pid ?? -1, scriptPath };
}

function helperLogSize(): number {
  try {
    return statSync(helperLogPath()).size;
  } catch {
    return 0;
  }
}

/**
 * 等助手落下第一行日志。
 *
 * 为什么非要等：`cmd /c start` 是异步交接。宿主若在 PowerShell 真起来之前就退出，
 * 中间那个 cmd.exe（它还在作业里）会被连坐杀掉，助手于是永远不启动 —— 用户看到的是
 * 「应用自己没了、版本也没变」，属于最难排查的一种。等到了再退，这一环就是确定性的。
 */
async function waitHelperStarted(prevLogSize: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (helperLogSize() > prevLogSize) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * 助手没起来就撤：删掉 pending.json 和暂存目录里的 job.json（助手启动第一件事就是读它），
 * 这样「迟到的助手」即使稍后真起来了也只会立刻退出，不会去动任何程序文件。
 */
function abortHelperStart(staging: string, reason: string): never {
  rmSync(pendingPath(), { force: true });
  try {
    rmSync(join(staging, 'job.json'), { force: true });
    rmSync(join(staging, 'update-helper.ps1'), { force: true });
  } catch {
    /* 暂存目录在 %TEMP%，删不掉也不影响 */
  }
  throw new Error(reason);
}

/** 更新前把在动设备的东西全停掉：投屏、Logcat、弱网（会改设备网络状态，必须恢复） */
async function stopRunningTasks(): Promise<void> {
  const tasks: [string, () => Promise<unknown>][] = [
    ['投屏', () => stopMirror()],
    ['Logcat', () => stopLogcat()],
    ['弱网', () => stopWeakNet()],
  ];
  for (const [name, fn] of tasks) {
    try {
      await fn();
    } catch (e) {
      log('warn', '更新', `停止${name}失败（继续）：${(e as Error).message}`);
    }
  }
  try {
    await adbKillServer();
  } catch {
    /* kill-server 失败不影响文件替换 */
  }
}

/** 只保留最近一份备份 */
function pruneBackups(keep: string) {
  const root = backupRoot();
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (name === keep) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      /* 备份删不掉不影响更新 */
    }
  }
}

export async function applyUpdate(): Promise<{ started: boolean }> {
  if (!prepared) throw new Error('还没有选择并校验更新包');
  const { manifest, stageDir, snapshot, targets } = prepared;

  if (snapshot.kind === 'dev') throw new Error('开发模式下不提供应用内更新');
  if (cmpVersion(manifest.version, snapshot.version) <= 0) throw new Error('更新包版本不比当前新');

  await stopRunningTasks();

  const launchExe = snapshot.kind === 'portable' ? snapshot.targetPath : app.getPath('exe');
  if (!launchExe || !existsSync(launchExe)) throw new Error(`找不到要启动的程序：${launchExe || '(空)'}`);

  const stamp = `v${snapshot.version}-to-v${manifest.version}-${tsStamp()}`;
  const backupDir = join(backupRoot(), stamp);
  pruneBackups(stamp);
  ensureDir(backupDir);
  ensureDir(stageDir);

  const job: HelperJob = {
    schema: 1,
    mode: 'apply',
    kind: manifest.kind,
    pid: process.pid,
    staging: stageDir,
    resultPath: resultPath(),
    pendingPath: pendingPath(),
    healthPath: healthPath(),
    backupDir,
    logPath: helperLogPath(),
    fromVersion: snapshot.version,
    toVersion: manifest.version,
    targets: targets.map((t) => ({ name: t.name, src: t.src, dest: t.dest })),
    launchExe,
    launchArgs: [],
    workDir: dirname(launchExe),
    healthTimeoutSec: 30,
  };

  // 清掉上一轮的残留，避免新版读到旧结果 / 助手看到旧健康标记
  rmSync(resultPath(), { force: true });
  rmSync(healthPath(), { force: true });
  writeJson(join(stageDir, 'job.json'), job);
  writeJson(pendingPath(), {
    from: snapshot.version,
    to: manifest.version,
    kind: manifest.kind,
    backupDir,
    at: new Date().toISOString(),
  });

  const prevLog = helperLogSize();
  let pid = -1;
  try {
    pid = spawnHelper(stageDir).pid;
  } catch (e) {
    rmSync(pendingPath(), { force: true });
    throw new Error(`启动更新助手失败：${(e as Error).message}`);
  }

  if (!(await waitHelperStarted(prevLog))) {
    abortHelperStart(
      stageDir,
      '更新助手没能启动（可能有安全软件拦了 powershell），本次更新已取消，程序文件没有任何改动。可以重试，或直接用完整安装包覆盖安装。',
    );
  }

  log('success', '更新', `更新助手已启动（PID ${pid}），应用即将退出并替换文件…`);
  prepared = null;
  // app.exit 会跳过 before-quit / will-quit：上面的清理已经显式做完了，
  // 走正常退出反而可能被 will-quit 里的弱网恢复逻辑卡住，让助手白等 60 秒超时。
  setTimeout(() => app.exit(0), 600);
  return { started: true };
}

export async function rollbackUpdate(): Promise<{ started: boolean }> {
  const backup = latestBackup();
  if (!backup) throw new Error('没有可用的备份，无法回滚');

  const snapshot = localSnapshot();
  const restore = readJson<{
    fromVersion: string;
    launchExe: string;
    launchArgs?: string[];
    workDir?: string;
    files: { name: string; dest: string; existed: boolean }[];
  }>(join(backup.dir, 'restore.json'));
  if (!restore || !Array.isArray(restore.files) || restore.files.length === 0) {
    throw new Error('备份信息不完整，无法回滚');
  }

  await stopRunningTasks();

  const launchExe = snapshot.kind === 'portable' ? snapshot.targetPath : app.getPath('exe');
  const stageDir = join(tmpdir(), `adba-restore-${Date.now()}`);
  ensureDir(stageDir);

  const job: HelperJob = {
    schema: 1,
    mode: 'restore',
    kind: snapshot.kind,
    pid: process.pid,
    staging: stageDir,
    resultPath: resultPath(),
    pendingPath: pendingPath(),
    healthPath: healthPath(),
    backupDir: backup.dir,
    logPath: helperLogPath(),
    fromVersion: snapshot.version,
    toVersion: backup.fromVersion,
    targets: [],
    launchExe,
    launchArgs: [],
    workDir: dirname(launchExe),
    healthTimeoutSec: 0,
  };

  rmSync(resultPath(), { force: true });
  rmSync(healthPath(), { force: true });
  writeJson(join(stageDir, 'job.json'), job);
  writeJson(pendingPath(), {
    from: snapshot.version,
    to: backup.fromVersion,
    kind: snapshot.kind,
    backupDir: backup.dir,
    at: new Date().toISOString(),
    mode: 'restore',
  });

  const prevLog = helperLogSize();
  let pid = -1;
  try {
    pid = spawnHelper(stageDir).pid;
  } catch (e) {
    rmSync(pendingPath(), { force: true });
    throw new Error(`启动更新助手失败：${(e as Error).message}`);
  }

  if (!(await waitHelperStarted(prevLog))) {
    abortHelperStart(stageDir, '回滚助手没能启动，回滚已取消（当前版本不受影响），可以稍后重试。');
  }

  log('warn', '更新', `开始回滚到 v${backup.fromVersion}（助手 PID ${pid}），应用即将退出…`);
  setTimeout(() => app.exit(0), 600);
  return { started: true };
}

/* ------------------------------------------------------------------ */
/* 启动握手                                                            */
/* ------------------------------------------------------------------ */

/** pending.json 超过这个时间还没结果，就认为助手已经挂了（不是「还在干活」） */
const PENDING_STALE_MS = 30_000;
/** 收到健康标记后助手写结果很快，最多等这么久 */
const RESULT_WAIT_MS = 8_000;

let handshaken = false;

/**
 * 渲染层就绪后调用一次。
 * 作用有两层：
 *  1. 落健康标记 —— 更新助手正靠它判断「新版真的起来了」，白屏时会等超时并自动回滚；
 *  2. 回读本次更新的结果（成功 / 失败 / 已回滚），交给界面提示。
 */
export async function updateHandshake(): Promise<UpdateResult | null> {
  if (handshaken) return null;
  handshaken = true;

  const dir = stateDir();
  ensureDir(dir);
  try {
    writeJson(healthPath(), { at: new Date().toISOString(), version: app.getVersion(), pid: process.pid });
  } catch {
    /* 写不了健康标记也不是致命问题，顶多让助手走超时回滚的老路 */
  }

  const pending = readJson<{ from?: string; to?: string; at?: string; mode?: string }>(pendingPath());
  if (!pending) return null; // 正常启动，没有更新在途

  const deadline = Date.now() + RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    const res = readJson<UpdateResult>(resultPath());
    if (res) {
      rmSync(resultPath(), { force: true });
      rmSync(pendingPath(), { force: true });
      return res;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // 等不到结果：看 pending 有多老。很新说明助手还在干活，留着下次启动再判。
  let age = Number.POSITIVE_INFINITY;
  try {
    age = Date.now() - statSync(pendingPath()).mtimeMs;
  } catch {
    /* 文件没了就是没在途了 */
  }
  if (age < PENDING_STALE_MS) return null;

  rmSync(pendingPath(), { force: true });
  return {
    ok: false,
    mode: 'apply',
    from: pending.from,
    to: pending.to,
    at: new Date().toISOString(),
    error: '上次更新没有完成（更新助手可能被中断或被杀掉），当前仍运行旧版本。可以重新选择更新包再试一次。',
    logPath: helperLogPath(),
  };
}

/** 供界面「打开更新目录」——里面有 helper.log 和备份 */
export function openUpdateDir(): string {
  const dir = stateDir();
  ensureDir(dir);
  void shell.openPath(dir);
  return dir;
}

/**
 * 仅供 scripts/check-helper-launch.cjs 使用。
 *
 * 启动助手这一段是「本地静态检查全绿、真机才炸」的重灾区（作业对象连坐 / detached 不执行），
 * 所以单独给它一个行为检查入口：真 Electron 里走一遍 stageHelperScript + spawnHelper，
 * 退出后由驱动脚本断言助手确实把活干完了。
 */
export function spawnHelperForCheck(staging: string): { pid: number; scriptPath: string } {
  return spawnHelper(staging);
}

export function helperLog(): string {
  try {
    return readFileSync(helperLogPath(), 'utf8');
  } catch {
    return '';
  }
}
