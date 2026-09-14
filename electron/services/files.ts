import { existsSync, statSync, readdirSync } from 'fs';
import { basename, join, extname } from 'path';
import { randomUUID } from 'crypto';
import { runAdb, ensureDevice, log, spawnBinary, adbPath } from './adb';

function formatBytesFallback(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ------------------------------------------------------------------ */
/* 文件传输                                                            */
/* ------------------------------------------------------------------ */

export interface TransferResult {
  ok: boolean;
  fileCount: number;
  totalBytes: number;
  message: string;
}

/**
 * 推送到设备
 */
export async function pushFiles(
  serial: string | undefined,
  localPaths: string[],
  remoteDir: string,
): Promise<TransferResult> {
  const s = await ensureDevice(serial);

  if (localPaths.length === 0) throw new Error('未选择任何文件');
  for (const p of localPaths) {
    if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
  }

  const remote = normalizeRemote(remoteDir);
  await runAdb(['-s', s, 'shell', 'mkdir', '-p', remote], { source: '文件', silent: true });

  let totalBytes = 0;
  for (const p of localPaths) {
    totalBytes += safeSize(p);
  }

  log(
    'info',
    '文件',
    `正在推送 ${localPaths.length} 个文件到 ${remote}（${formatBytesFallback(totalBytes)}）`,
  );

  // 逐个推送：中文/空格路径下多源单命令容易触发 adb 目标解析异常，
  // 逐个推送同时便于定位到底哪个文件失败。
  let okCount = 0;
  const failures: string[] = [];

  for (const local of localPaths) {
    // 本地路径转正斜杠（旧版 adb 会把反斜杠当转义符）
    const localArg = toPosixPath(local);
    const wanted = basename(local);

    // 中文路径下旧版 adb（1.0.41）会把目标文件名截断，
    // 因此先用纯 ASCII 临时名推送，再在设备端 mv 成真实文件名。
    const tempName = `.adbtmp_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const tempPath = `${remote}/${tempName}`;

    const res = await runAdb(['-s', s, 'push', localArg, tempPath], {
      source: '文件',
      silent: true,
      timeout: 10 * 60 * 1000,
    });

    if (!res.ok) {
      const detail = (res.stderr || res.stdout).trim();
      failures.push(`${wanted}：${detail}`);
      log('error', '文件', `推送失败：${wanted}`, detail);
      continue;
    }

    // 设备端改名到目标文件名（shell 侧处理，避开 adb 传参编码问题）
    const finalPath = `${remote}/${wanted}`;
    const mv = await runAdb(
      ['-s', s, 'shell', 'mv', '-f', tempPath, `"${finalPath}"`],
      { source: '文件', silent: true, timeout: 30000 },
    );

    // 若 mv 失败（如文件名含特殊字符），退化为保留临时名
    const landed = mv.ok ? wanted : tempName;
    if (!mv.ok) {
      log('warn', '文件', `${wanted} 改名失败，已保留为 ${tempName}`, mv.stderr.trim());
    }

    okCount++;
    log('success', '文件', `${wanted} → ${remote}/${landed}`);
  }

  if (okCount === 0) {
    throw new Error(failures.join('\n') || '推送失败');
  }

  const message =
    failures.length > 0
      ? `成功 ${okCount} 个，失败 ${failures.length} 个`
      : `已推送 ${okCount} 个文件到 ${remote}`;

  return {
    ok: failures.length === 0,
    fileCount: okCount,
    totalBytes,
    message,
  };
}

/**
 * 从设备拉取
 */
export async function pullFiles(
  serial: string | undefined,
  remotePaths: string[],
  localDir: string,
): Promise<TransferResult> {
  const s = await ensureDevice(serial);

  if (remotePaths.length === 0) throw new Error('未指定要拉取的文件');

  log('info', '文件', `正在拉取 ${remotePaths.map((p) => basename(p)).join('、')} 到 ${localDir}`);

  // 逐个拉取，避免多源单命令在中文路径下的解析异常
  const failures: string[] = [];
  let okCount = 0;

  for (const remote of remotePaths) {
    const res = await runAdb(['-s', s, 'pull', remote, toPosixPath(localDir)], {
      source: '文件',
      silent: true,
      timeout: 10 * 60 * 1000,
    });
    if (res.ok) {
      okCount++;
      log('success', '文件', `${basename(remote)} → ${localDir}`);
    } else {
      const detail = (res.stderr || res.stdout).trim();
      failures.push(`${basename(remote)}：${detail}`);
      log('error', '文件', `拉取失败：${basename(remote)}`, detail);
    }
  }

  if (okCount === 0) {
    throw new Error(failures.join('\n') || '拉取失败');
  }

  let totalBytes = 0;
  let fileCount = 0;
  for (const p of remotePaths) {
    const local = join(localDir, basename(p));
    if (existsSync(local)) {
      const st = statSync(local);
      if (st.isDirectory()) {
        const walk = walkDir(local);
        fileCount += walk.count;
        totalBytes += walk.bytes;
      } else {
        fileCount += 1;
        totalBytes += st.size;
      }
    }
  }

  log('success', '文件', `拉取完成：${fileCount} 个文件（${formatBytesFallback(totalBytes)}）`);
  return {
    ok: failures.length === 0,
    fileCount,
    totalBytes,
    message:
      failures.length > 0
        ? `成功 ${okCount} 项，失败 ${failures.length} 项`
        : `已拉取 ${fileCount} 个文件到 ${localDir}`,
  };
}

/**
 * APK 安装
 */
export async function installApk(
  serial: string | undefined,
  apkPath: string,
  reinstall = true,
  grantAll = false,
): Promise<string> {
  const s = await ensureDevice(serial);

  if (!existsSync(apkPath)) throw new Error(`APK 不存在：${apkPath}`);
  if (extname(apkPath).toLowerCase() !== '.apk') {
    throw new Error('所选文件不是 .apk 文件');
  }

  const size = safeSize(apkPath);
  log('info', '安装', `正在安装 ${basename(apkPath)}（${formatBytesFallback(size)}）…`);

  const args = ['-s', s, 'install'];
  if (reinstall) args.push('-r');
  if (grantAll) args.push('-g');
  args.push(toPosixPath(apkPath));

  const res = await runAdb(args, { source: '安装', timeout: 5 * 60 * 1000 });

  const output = (res.stdout + '\n' + res.stderr).trim();
  if (/Failure|Error/i.test(output) || !res.ok) {
    const reason = output.replace(/^.*?Failure\s*/i, '').trim();
    throw new Error(reason || output || '安装失败');
  }

  log('success', '安装', `安装成功：${basename(apkPath)}`);
  return output;
}

/* ------------------------------------------------------------------ */
/* 应用列表                                                            */
/* ------------------------------------------------------------------ */

export interface SimpleApp {
  packageName: string;
  system: boolean;
}

/**
 * 列出设备上所有包名（第三方 + 系统）
 */
export async function listPackages(
  serial: string | undefined,
  includeSystem = true,
): Promise<SimpleApp[]> {
  const s = await ensureDevice(serial);
  const args = ['-s', s, 'shell', 'pm', 'list', 'packages'];
  if (!includeSystem) args.push('-3');

  const res = await runAdb(args, { source: '应用', silent: true, timeout: 30000 });
  const apps: SimpleApp[] = [];

  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^package:(.+)$/);
    if (m) {
      const pkg = m[1].trim();
      apps.push({ packageName: pkg, system: isSystemPackage(pkg) });
    }
  }

  apps.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return apps;
}

const SYSTEM_PREFIXES = [
  'com.android.',
  'android',
  'com.google.android.',
  'com.qualcomm.',
  'com.mediatek.',
  'com.samsung.android.',
  'com.huawei.',
  'com.miui.',
  'com.xiaomi.',
  'vendor.',
  'com.sec.',
];

function isSystemPackage(pkg: string): boolean {
  return SYSTEM_PREFIXES.some((p) => pkg === p || pkg.startsWith(p));
}

/* ------------------------------------------------------------------ */
/* Monkey                                                              */
/* ------------------------------------------------------------------ */

/**
 * 运行 Monkey 稳定性测试
 */
export async function runMonkey(
  serial: string | undefined,
  packageName: string | undefined,
  events: number,
  throttleMs = 100,
  seed?: number,
  onOutput?: (line: string) => void,
  onExit?: (code: number | null) => void,
) {
  const s = await ensureDevice(serial);

  const args = ['-s', s, 'shell', 'monkey'];
  if (packageName) {
    args.push('-p', packageName);
  }
  args.push('--throttle', String(throttleMs));
  args.push('-s', String(seed ?? Math.floor(Math.random() * 100000)));
  args.push('--ignore-crashes');
  args.push('--ignore-timeouts');
  args.push('--monitor-native-crashes');
  args.push('-v');
  args.push(String(events));

  const child = spawnBinary(adbPath(), args, 'Monkey');

  const pipe = (data: Buffer) => {
    const text = data.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t) onOutput?.(t);
    }
  };

  child.stdout?.on('data', pipe);
  child.stderr?.on('data', pipe);

  child.on('close', (code) => {
    if (code === 0) log('success', 'Monkey', '测试完成');
    else log('warn', 'Monkey', `测试结束（exit ${code}）`);
    onExit?.(code);
  });

  child.on('error', (err) => {
    log('error', 'Monkey', `启动失败：${err.message}`);
    onExit?.(-1);
  });

  log('info', 'Monkey', `已启动：${packageName || '全部应用'}，${events} 次事件，节流 ${throttleMs}ms`);
  return child;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把 Windows 路径转成 POSIX 风格
 * adb 在 Windows 上把反斜杠当作转义字符，中文/空格路径下会导致文件名被截断，
 * 统一使用正斜杠可规避该问题（Windows API 本身也接受正斜杠）。
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function normalizeRemote(dir: string): string {
  let d = (dir || '').trim().replace(/\\/g, '/');
  if (!d) return '/sdcard/Download';
  if (!d.startsWith('/')) d = '/' + d;
  return d.replace(/\/+$/, '') || '/sdcard';
}

function safeSize(p: string): number {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return walkDir(p).bytes;
    return st.size;
  } catch {
    return 0;
  }
}

function walkDir(dir: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else {
          count += 1;
          bytes += st.size;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { count, bytes };
}
