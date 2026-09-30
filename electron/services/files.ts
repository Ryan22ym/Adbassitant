import { existsSync, statSync, readdirSync } from 'fs';
import { basename, join, extname } from 'path';
import { randomUUID } from 'crypto';
import { runAdb, ensureDevice, log, spawnBinary, adbPath, ensureDir, listDevices } from './adb';
import { readApkInfo } from './apk';
import { INSTALL_MODE_LABEL } from '../../shared/types';
import type { AppInfo, AppDetail, InstallMode, InstallResult } from '../../shared/types';

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
 * 当前正在安装的文件名，null = 空闲。
 *
 * `adb install` 会独占 adb 通道并可能触发设备端的安装确认弹窗，两路并发
 * （比如一边按钮点安装、一边又拖了个 APK 进来）会互相打断，表现为
 * 「安装失败」或设备上弹两个确认框。这里做进程级互斥，保证同一时刻只有一个安装任务。
 */
let installInFlight: string | null = null;

/** 是否已有安装任务在进行中（供 UI 侧查询） */
export function isInstalling(): boolean {
  return installInFlight !== null;
}

/**
 * 明确安装目标。
 *
 * `ensureDevice()` 在 serial 为空时取的是「在线列表第一台」——三台设备同时在线时，
 * 这等于随机挑一台，界面照样报「安装成功」，但用户在自己手机上找不到应用。
 * 所以安装路径上必须卡死：serial 缺失且多台在线就直接拒绝。
 */
async function resolveInstallTarget(serial?: string): Promise<string> {
  if (serial) return ensureDevice(serial);

  const devices = await listDevices(false);
  const online = devices.filter((d) => d.state === 'device');
  if (online.length > 1) {
    throw new Error(
      `有 ${online.length} 台设备在线（${online.map((d) => d.serial).join('、')}），` +
        '无法确定装到哪台，请先在设备选择里指定一台',
    );
  }
  return ensureDevice(serial);
}

/** 设备上是否已装该包 */
async function deviceHasPackage(s: string, pkg: string): Promise<boolean> {
  const res = await runAdb(['-s', s, 'shell', 'pm', 'path', pkg], {
    silent: true,
    timeout: 20000,
  });
  return /^package:/m.test(res.stdout);
}

/**
 * 等设备端**真的**查不到这个包。
 *
 * `adb uninstall` 返回 Success 只代表设备接受了卸载指令，包在设备侧真正消失
 * 还有一段窗口期。清洁安装是在卸载完的下一行立刻发 install，会直接撞上这个窗口 ——
 * 实测 OPPO / ColorOS（CPH1931，Android 10）上表现为 adb 在 1.7s 内失败，且
 * **不返回任何失败原因**（`adb: failed to install xxx.apk:` 冒号后为空）。
 * 同一台机器改用覆盖安装、或隔一会儿再装都能成功，说明包与参数都没问题。
 *
 * 超时不当作错误：包真没卸掉时后面的 install 会给出正常的失败原因，
 * 这里只负责削掉那段竞态窗口。
 */
async function waitPackageGone(s: string, pkg: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await deviceHasPackage(s, pkg))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  log('warn', '安装', `卸载后 ${pkg} 仍能被 pm 查到（已等 ${timeoutMs}ms），继续安装`);
}

/** 设备端安装失败码 → 人话。表里没有的码原样保留，至少让用户能拿去搜。 */
const INSTALL_FAILURE_HINTS: Record<string, string> = {
  INSTALL_FAILED_ALREADY_EXISTS:
    '设备上已存在同包名的应用 —— 用「覆盖安装」升级，或先卸载再装',
  INSTALL_FAILED_UPDATE_INCOMPATIBLE:
    '与设备上已装版本的签名不一致 —— 必须卸载旧版本（会清数据）后再装',
  INSTALL_FAILED_VERSION_DOWNGRADE: '版本号低于设备上已装的版本 —— 系统不允许降级安装',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: '设备存储空间不足 —— 清理空间后重试',
  INSTALL_FAILED_NO_MATCHING_ABIS:
    '安装包里没有该设备 CPU 架构的原生库 —— 需要 arm64-v8a / armeabi-v7a 的包',
  INSTALL_FAILED_OLDER_SDK: '安装包要求的最低系统版本高于这台设备 —— 设备太旧，装不了',
  INSTALL_FAILED_NEWER_SDK: '设备系统版本高于安装包允许的上限',
  INSTALL_FAILED_USER_RESTRICTED:
    '设备系统（多为厂商安全策略）阻止了本次安装 —— 到系统设置里放开「USB 安装 / 外部来源应用」',
  INSTALL_FAILED_TEST_ONLY: '安装包带 testOnly 标记（Android Studio 直接 Run 出来的包）—— 需正式签名出包',
  INSTALL_FAILED_INVALID_APK: '安装包结构不合法 —— 多半是传输或下载过程中损坏了',
  INSTALL_FAILED_DUPLICATE_PERMISSION: '与设备上其他应用声明了同名自定义权限 —— 先卸载冲突的那个应用',
  INSTALL_FAILED_MISSING_SHARED_LIBRARY: '缺少安装包依赖的共享库（通常是厂商定制库）—— 该机型装不了这个包',
  INSTALL_PARSE_FAILED_NO_CERTIFICATES: '安装包没有签名 —— 必须签名后才能安装',
  INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES: '包内各部分签名不一致 —— 需要重新打包',
  INSTALL_PARSE_FAILED_NOT_APK: '这不是一个有效的 APK —— 文件损坏，或根本不是安装包',
  INSTALL_PARSE_FAILED_UNEXPECTED_EXCEPTION: '设备解析安装包时异常 —— 包损坏，或与系统版本不兼容',
  INSTALL_PARSE_FAILED_MANIFEST_MALFORMED: '安装包的 AndroidManifest.xml 不合法 —— 包本身有问题',
};

/** adb 输出里是否带设备返回的失败码（`Failure [XXX]`），有码说明设备明确拒绝了 */
function hasInstallFailureCode(output: string): boolean {
  return /Failure\s*\[/i.test(output);
}

/** adb 的进度/成功噪音行，对排障没有信息量，展示时剔掉 */
const ADB_INSTALL_NOISE = /^(Performing Streamed Install|Success)$/i;

/**
 * 把 adb 的安装失败输出整理成用户能直接看懂的一段话。
 *
 * 为什么不能把 adb 原文直接丢出去：
 *  · adb 会把进度和错误混在同一段文本里（先 `Performing Streamed Install`，
 *    再 `adb: failed to install xxx.apk: Failure [XXXX]`），照抄等于让用户自己去挑；
 *  · 设备侧有时只回一个「失败」而**不带失败码** —— 实测 OPPO/ColorOS 上
 *    「卸载后立刻安装」就会给出 `adb: failed to install xxx.apk:`（冒号后为空）。
 *    这种输出原文照抄等于什么都没说，必须补上可执行的下一步。
 */
function describeInstallFailure(output: string, serial: string, pkg?: string): string {
  const code = /Failure\s*\[([^\]]+)\]/i.exec(output)?.[1]?.trim();
  /* 失败码后面常跟着一段英文详情（signatures do not match 之类），
     取码本身去查表，详情仍留在正文里 */
  const head = code?.split(':')[0]?.trim();

  const body = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !ADB_INSTALL_NOISE.test(l))
    .map((l) => l.replace(/^adb:\s*/i, ''))
    .join('\n')
    .trim();

  const lines: string[] = [];
  if (body) lines.push(body);

  const hint = head ? INSTALL_FAILURE_HINTS[head] : undefined;
  if (hint) {
    lines.push(`⚠ ${hint}`);
  } else if (!hasInstallFailureCode(output)) {
    lines.push(
      '⚠ 设备没有返回失败原因，adb 只收到一个「失败」。这类空原因失败通常是设备侧的瞬时状态：',
      '· 刚卸载完旧版本，设备的安装服务还在收尾 —— 隔几秒重装（本工具已自动重试过一次）',
      '· 厂商安全策略临时拦截 USB 安装 —— 到系统设置里放开「USB 安装 / 外部来源应用」',
      '· 仍不行就重启设备，或把安装方式换成「覆盖安装」再试',
    );
  }

  lines.push(`· 目标设备 ${serial}${pkg ? `（${pkg}）` : ''}`);
  return lines.join('\n');
}

/** 「没拿到失败码就秒退」的判定阈值：低于它的失败几乎必然是瞬时状态，值得重试 */
const INSTALL_RETRY_MAX_MS = 8000;
/** 自动重试前的等待，给设备侧的服务收尾留时间 */
const INSTALL_RETRY_DELAY_MS = 2000;

/**
 * APK 安装
 *
 * 三种模式见 shared/types.ts 的 InstallMode。
 * 无论哪种模式，装完都会按包名 `pm path` 复核一遍 —— adb 说 Success 不等于
 * 设备上真有这个包（多用户/系统分身、存储或权限受限、厂商拦截都可能假成功），
 * 复核不到就直接判失败，不再让界面出现「显示成功但手机上没有」。
 */
export async function installApk(
  serial: string | undefined,
  apkPath: string,
  mode: InstallMode = 'overwrite',
  grantAll = false,
): Promise<InstallResult> {
  if (installInFlight !== null) {
    throw new Error(`正在安装 ${installInFlight}，请等它完成后再试`);
  }

  // 同步占位：ensureDevice / runAdb 里有多处 await，若等拿到设备再上锁，
  // 两个并发请求会在锁之前双双通过检查。basename 是同步的，先占住再进流程。
  installInFlight = basename(apkPath) || 'APK';

  try {
    const s = await resolveInstallTarget(serial);

    if (!existsSync(apkPath)) throw new Error(`APK 不存在：${apkPath}`);
    if (extname(apkPath).toLowerCase() !== '.apk') {
      throw new Error('所选文件不是 .apk 文件');
    }

    const info = readApkInfo(apkPath);
    const pkg = info.packageName;
    const size = safeSize(apkPath);
    const who = pkg ? `${pkg}${info.versionName ? ` v${info.versionName}` : ''}` : basename(apkPath);

    log(
      'info',
      '安装',
      `目标设备 ${s}｜${INSTALL_MODE_LABEL[mode]}：${who}（${formatBytesFallback(size)}）`,
    );
    if (!pkg) {
      log(
        'warn',
        '安装',
        `读不出 APK 包名（${info.error ?? '未知原因'}），装完将不做复核`,
        basename(apkPath),
      );
    }

    /* ---- 清洁安装：先按包名卸载旧版本，数据一并清掉 ---- */
    let uninstalled = false;
    if (mode === 'clean') {
      if (!pkg) {
        throw new Error(
          '读不出 APK 包名，无法清洁安装（清洁安装要先按包名卸载旧版本）。可改用「覆盖安装」。',
        );
      }
      if (await deviceHasPackage(s, pkg)) {
        log('info', '安装', `清洁安装：先卸载 ${pkg}，应用数据会一起清掉`);
        const res = await runAdb(['-s', s, 'uninstall', pkg], { source: '安装', timeout: 90000 });
        const text = (res.stdout + '\n' + res.stderr).trim();
        if (/Failure|Error/i.test(text) || !res.ok || !/Success/i.test(text)) {
          throw new Error(
            `卸载旧版本失败：${text.replace(/^.*?Failure\s*/i, '').trim() || '未知原因'}`,
          );
        }
        uninstalled = true;
        // 卸载返回 Success ≠ 设备端已经清理完 —— 立刻 install 会撞上竞态窗口
        await waitPackageGone(s, pkg);
      } else {
        log('info', '安装', `清洁安装：设备上没有 ${pkg}，直接全新安装`);
      }
    }

    /* ---- 全新安装：设备上已有该包就必须拒绝 ----
     * 不能只靠「不加 -r」实现：实测 Android 12 上 `adb install` 不带 -r 也会
     * 直接覆盖已装应用（老版本才会报 INSTALL_FAILED_ALREADY_EXISTS），
     * 语义随 ROM 变化，所以自己按包名判一次，保证行为确定。 */
    if (mode === 'fresh' && pkg && (await deviceHasPackage(s, pkg))) {
      throw new Error(
        `设备 ${s} 上已存在 ${pkg}，已按「全新安装」的约定中止，没有动到旧版本。` +
          '如需升级请用「覆盖安装」，如需清空数据重装请用「清洁安装」。',
      );
    }

    /* ---- 组装安装命令 ---- */
    const args = ['-s', s, 'install'];
    if (mode === 'overwrite') args.push('-r');
    if (grantAll) args.push('-g');
    args.push(toPosixPath(apkPath));

    let res = await runAdb(args, { source: '安装', timeout: 5 * 60 * 1000 });
    let output = (res.stdout + '\n' + res.stderr).trim();

    /*
     * 「没有失败码 + 秒退」＝ 设备侧瞬时状态，自动重试一次。
     *
     * 实测（OPPO / ColorOS，清洁安装 177 MB 的包）：卸载刚结束就 install，
     * adb 会在 1.7s 内退出，只打印 `failed to install xxx.apk:`（冒号后为空），
     * 同机改用覆盖安装、或隔几秒再装都能成 —— 与包、与参数都无关。
     * 这种情况下隔两秒重来一次几乎必然成功，比把失败直接甩给用户划算。
     *
     * 只在「没有 Failure[码] 且耗时很短」时重试：带失败码说明设备明确拒绝了
     * （签名冲突、空间不足……），重试只是白等；耗时长说明真的推过包，同理。
     */
    if (
      (!res.ok || /Failure|Error/i.test(output)) &&
      !hasInstallFailureCode(output) &&
      res.duration < INSTALL_RETRY_MAX_MS
    ) {
      log(
        'warn',
        '安装',
        `未拿到失败原因且仅用时 ${res.duration}ms，判定为设备侧瞬时失败，${INSTALL_RETRY_DELAY_MS}ms 后自动重试一次`,
      );
      await new Promise((r) => setTimeout(r, INSTALL_RETRY_DELAY_MS));
      res = await runAdb(args, { source: '安装', timeout: 5 * 60 * 1000 });
      output = (res.stdout + '\n' + res.stderr).trim();
    }

    if (/Failure|Error/i.test(output) || !res.ok) {
      throw new Error(describeInstallFailure(output, s, pkg));
    }

    /* ---- 装后复核 ---- */
    let verified: boolean | undefined;
    if (pkg) {
      for (let i = 0; i < 5; i += 1) {
        if (await deviceHasPackage(s, pkg)) {
          verified = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      if (verified !== true) {
        verified = false;
        throw new Error(
          `adb 报告安装成功，但在设备 ${s} 上查不到 ${pkg} —— 实际没有装上。` +
            '常见原因：设备有多个用户 / 系统分身，装到了别的用户下；存储空间或权限受限；厂商安全策略拦截。' +
            '可改用「清洁安装」再试一次。',
        );
      }
      log('success', '安装', `安装成功并已复核：${who} → ${s}`);
    } else {
      log('success', '安装', `安装成功（读不出包名，未复核）：${basename(apkPath)} → ${s}`);
    }

    return {
      serial: s,
      packageName: pkg,
      versionName: info.versionName,
      versionCode: info.versionCode,
      output,
      uninstalled,
      verified,
    };
  } finally {
    // 无论成功、失败还是抛异常都必须释放，否则安装功能会被永久锁死
    installInFlight = null;
  }
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
/* 应用管理（v1.0）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 批量读取应用元信息（显示名 / 版本 / 安装时间 / 体积）
 *
 * 走 `pm list packages -3 --show-versioncode -U -i` 拿包名与基础信息，
 * 再用 `dumpsys package` 一次性补齐 label 与大小。
 * 单条 shell 命令开销大，因此这里只发 3 条命令，不做逐包查询。
 */
export async function listAppsDetailed(
  serial: string | undefined,
  includeSystem = true,
): Promise<AppInfo[]> {
  const s = await ensureDevice(serial);

  const pkgArgs = ['-s', s, 'shell', 'pm', 'list', 'packages'];
  if (!includeSystem) pkgArgs.push('-3');
  pkgArgs.push('--show-versioncode', '-U');

  const [pkgRes, sizeRes, disabledRes] = await Promise.all([
    runAdb(pkgArgs, { source: '应用', silent: true, timeout: 40000 }),
    runAdb(['-s', s, 'shell', 'du', '-s', '/data/app/*'], {
      silent: true,
      timeout: 40000,
    }),
    runAdb(['-s', s, 'shell', 'pm', 'list', 'packages', '-d'], {
      silent: true,
      timeout: 20000,
    }),
  ]);

  /* pm list packages 行样例：
   *   package:com.tencent.mm versionCode:2600 uid:10123
   * 老版本 ROM 不带 versionCode/uid，做兼容。 */
  const apps: AppInfo[] = [];
  for (const line of pkgRes.stdout.split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(/^package:(\S+)(?:\s+versionCode:(\d+))?(?:\s+uid:(\d+))?/);
    if (!m) continue;
    const packageName = m[1];
    apps.push({
      packageName,
      system: isSystemPackage(packageName),
      versionCode: m[2] ? parseInt(m[2], 10) : undefined,
    });
  }

  if (apps.length === 0) return apps;

  // 目录体积：/data/app/~~xxx==/com.foo-abc==/base.apk → 用包名匹配
  const sizeMap = parseDuOutput(sizeRes.stdout);

  // 已停用包
  const disabled = new Set<string>();
  for (const line of disabledRes.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^package:(\S+)/);
    if (m) disabled.add(m[1]);
  }

  for (const a of apps) {
    const hit = matchSize(sizeMap, a.packageName);
    if (hit !== undefined) a.sizeBytes = hit;
    if (disabled.has(a.packageName)) a.disabled = true;
  }

  apps.sort((a, b) => a.packageName.localeCompare(b.packageName));
  log('info', '应用', `已读取 ${apps.length} 个应用`);
  return apps;
}

/**
 * du -s /data/app/* 输出解析
 * 形如： 12345   /data/app/~~AbC==/com.foo.bar-XyZ==
 */
function parseDuOutput(stdout: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!m) continue;
    const kb = parseInt(m[1], 10);
    const path = m[2];
    const base = path.split('/').pop() || '';
    // com.foo.bar-XyZ== → com.foo.bar
    const pkg = base.replace(/-[^-]*==?$/, '').replace(/==$/, '');
    if (!pkg) continue;
    map.set(pkg, (map.get(pkg) || 0) + kb * 1024);
  }
  return map;
}

function matchSize(map: Map<string, number>, pkg: string): number | undefined {
  if (map.has(pkg)) return map.get(pkg);
  // 前缀匹配兜底（有的 ROM 目录名做了混淆）
  for (const [k, v] of map) {
    if (k === pkg) return v;
  }
  return undefined;
}

/**
 * 读取单个应用的详细信息（dumpsys package <pkg>）
 */
export async function getAppDetail(
  serial: string | undefined,
  packageName: string,
): Promise<AppDetail> {
  const s = await ensureDevice(serial);
  const pkg = (packageName || '').trim();
  if (!pkg) throw new Error('包名为空');

  const res = await runAdb(['-s', s, 'shell', 'dumpsys', 'package', pkg], {
    silent: true,
    timeout: 25000,
  });
  const out = res.stdout;
  if (!out.trim()) throw new Error(`未找到应用 ${pkg}`);

  const pick = (re: RegExp): string | undefined => out.match(re)?.[1]?.trim();

  const versionName = pick(/versionName=(\S+)/);
  const versionCodeStr = pick(/versionCode=(\d+)/);
  const firstInstallStr = pick(/firstInstallTime=(.+)/);
  const lastUpdateStr = pick(/lastUpdateTime=(.+)/);
  const codePath = pick(/codePath=(\S+)/);
  const dataDir = pick(/dataDir=(\S+)/);
  const targetSdkStr = pick(/targetSdk=(\d+)/) || pick(/targetSdkVersion=(\d+)/);
  const minSdkStr = pick(/minSdk=(\d+)/) || pick(/minSdkVersion=(\d+)/);
  const enabledStr = pick(/enabled=(\w+)/);

  const activities = (out.match(/android\.intent\.action\.MAIN/g) || []).length;

  // 权限列表
  const permissions: string[] = [];
  const permBlock = out.match(/requested permissions:([\s\S]*?)(?:\n\s*\n|install permissions:)/);
  if (permBlock) {
    for (const l of permBlock[1].split(/\r?\n/)) {
      const m = l.trim().match(/^([\w.]+)$/);
      if (m) permissions.push(m[1]);
    }
  }

  return {
    packageName: pkg,
    versionName,
    versionCode: versionCodeStr ? parseInt(versionCodeStr, 10) : undefined,
    installedAt: parseDumpTime(firstInstallStr),
    updatedAt: parseDumpTime(lastUpdateStr),
    apkPath: codePath,
    codePath,
    dataDir,
    system: isSystemPackage(pkg),
    enabled: enabledStr ? enabledStr === 'true' || enabledStr === '1' : undefined,
    targetSdk: targetSdkStr ? parseInt(targetSdkStr, 10) : undefined,
    minSdk: minSdkStr ? parseInt(minSdkStr, 10) : undefined,
    activities,
    permissions: permissions.slice(0, 40),
  };
}

/** dumpsys 时间形如 2024-05-11 09:32:14 */
function parseDumpTime(s?: string): number | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}`);
  return Number.isFinite(t) ? t : undefined;
}

/** 卸载应用 */
export async function uninstallApp(
  serial: string | undefined,
  packageName: string,
  keepData = false,
): Promise<string> {
  const s = await ensureDevice(serial);
  const args = ['-s', s, 'uninstall'];
  if (keepData) args.push('-k');
  args.push(packageName);

  const res = await runAdb(args, { source: '应用', timeout: 90000 });
  const text = (res.stdout + '\n' + res.stderr).trim();
  if (/Failure|Error/i.test(text) || !res.ok) {
    throw new Error(text.replace(/^.*?Failure\s*/i, '').trim() || '卸载失败');
  }
  log('success', '应用', `已卸载 ${packageName}`);
  return text;
}

/** 强制停止 */
export async function forceStopApp(serial: string | undefined, packageName: string): Promise<string> {
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'am', 'force-stop', packageName], {
    source: '应用',
    timeout: 20000,
  });
  if (!res.ok && /Error|Exception/i.test(res.stderr + res.stdout)) {
    throw new Error((res.stderr || res.stdout).trim());
  }
  log('success', '应用', `已强制停止 ${packageName}`);
  return 'ok';
}

/** 清除数据（等价于系统设置里的「清除数据」） */
export async function clearAppData(serial: string | undefined, packageName: string): Promise<string> {
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'pm', 'clear', packageName], {
    source: '应用',
    timeout: 30000,
  });
  const text = (res.stdout + res.stderr).trim();
  if (!/Success/i.test(text)) throw new Error(text || '清除失败');
  log('success', '应用', `已清除 ${packageName} 的数据`);
  return text;
}

/** 启动应用（monkey 单事件最通用，避免拿不到 launcher activity） */
export async function launchApp(serial: string | undefined, packageName: string): Promise<string> {
  const s = await ensureDevice(serial);
  const res = await runAdb(
    ['-s', s, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
    { source: '应用', timeout: 20000 },
  );
  const text = (res.stdout + res.stderr).trim();
  if (/No activities found|monkey aborted/i.test(text)) {
    throw new Error('该应用没有可启动的桌面入口');
  }
  log('success', '应用', `已启动 ${packageName}`);
  return text;
}

/** 启用 / 停用应用 */
export async function setAppEnabled(
  serial: string | undefined,
  packageName: string,
  enabled: boolean,
): Promise<string> {
  const s = await ensureDevice(serial);
  const res = await runAdb(
    ['-s', s, 'shell', 'pm', enabled ? 'enable' : 'disable-user', '--user', '0', packageName],
    { source: '应用', timeout: 20000 },
  );
  const text = (res.stdout + res.stderr).trim();
  if (/Error|Exception|does not exist/i.test(text)) throw new Error(text);
  log('success', '应用', `${enabled ? '已启用' : '已停用'} ${packageName}`);
  return text || 'ok';
}

/**
 * 提取 APK 到电脑
 *
 * 流程：pm path 拿设备上的 apk 路径 → 复制到 /sdcard 临时目录
 *      → adb pull 到本地 → 删掉设备临时文件。
 * 直接 pull /data/app/... 多数设备会被 SELinux 拦，所以需要中转一次。
 */
export async function extractApk(
  serial: string | undefined,
  packageName: string,
  localDir: string,
): Promise<{ localPath: string; size: number }> {
  const s = await ensureDevice(serial);

  const pathRes = await runAdb(['-s', s, 'shell', 'pm', 'path', packageName], {
    silent: true,
    timeout: 15000,
  });
  const remote = pathRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('package:') && l.includes('base.apk'))
    ?.replace(/^package:/, '');

  const fallback = pathRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('package:'))
    ?.replace(/^package:/, '');

  const apkRemote = remote || fallback;
  if (!apkRemote) throw new Error(`未找到 ${packageName} 的 APK 路径（可能是系统应用）`);

  ensureDir(localDir);

  const tempName = `.adbextract_${randomUUID().replace(/-/g, '').slice(0, 10)}.apk`;
  const tempPath = `/sdcard/${tempName}`;

  // 1) 设备内复制到可读目录
  const cp = await runAdb(['-s', s, 'shell', 'cp', '-f', apkRemote, tempPath], {
    silent: true,
    timeout: 60000,
  });
  if (!cp.ok) {
    // 部分设备 cp 不可用，退回 cat 重定向
    const cat = await runAdb(['-s', s, 'shell', `cat "${apkRemote}" > ${tempPath}`], {
      silent: true,
      timeout: 120000,
    });
    if (!cat.ok) {
      throw new Error(`无法读取 APK：${(cp.stderr || cat.stderr).trim() || '权限不足'}`);
    }
  }

  // 2) 拉回本地
  const localPath = join(localDir, `${packageName}.apk`);
  const pull = await runAdb(['-s', s, 'pull', tempPath, toPosixPath(localPath)], {
    source: '应用',
    silent: true,
    timeout: 10 * 60 * 1000,
  });

  // 3) 清理设备临时文件（无论成功与否）
  await runAdb(['-s', s, 'shell', 'rm', '-f', tempPath], { silent: true, timeout: 15000 });

  if (!pull.ok) {
    throw new Error(`拉取失败：${(pull.stderr || pull.stdout).trim()}`);
  }

  const size = safeSize(localPath);
  log('success', '应用', `已提取 ${packageName}.apk（${formatBytesFallback(size)}）`);
  return { localPath, size };
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
