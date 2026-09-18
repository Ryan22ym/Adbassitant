/**
 * AAB（Android App Bundle）安装 与 拆包。
 *
 * 为什么 AAB 不能像 APK 那样直接装
 * ---------------------------------------------------------------
 * AAB 不是安装包，是「给 Play 商店用的原料」：里面装的是不带签名的模块
 * （base + 各动态功能），R 资源与 dex 都是未拆包状态，`adb install` 根本不认。
 * 官方路线只有一条：
 *     bundletool build-apks  →  一套按目标设备拆好的 APK（base.apk + *.apk）
 *     bundletool install-apks →  用 adb install-multiple 把它们一起装上去
 *
 * 「拆包」与「安装」是两件事
 * ---------------------------------------------------------------
 * 上面两步的输入完全不同：build-apks 吃「AAB + 一台设备的规格」，产出
 * .apks 文件；install-apks 吃「.apks + 一台在线的设备」。把它们绑在一起
 * 意味着每换一台设备/每重装一次都要重跑几十秒的拆包。
 * 于是拆成两个可独立调用的函数：
 *     convertBundle()  →  AAB → .apks（可另存，可复用）
 *     installBundle()  →  走 convertBundle() 拿产物，再 install-apks
 * installBundle 只是 convertBundle 的第一个消费者。
 *
 * 为什么装 .apks 仍走 `install-apks` 而不是自己解 zip
 * ---------------------------------------------------------------
 * 自己解 .apks 再 `adb install-multiple` 要求我们复刻 bundletool 的
 * 「挑哪些 split / 什么顺序 / 何时用 install-multi-package」逻辑，
 * 且 .apks 里的 toc.pb 是 protobuf，解析成本高、还容易跟不上版本。
 * 只装「本工具自己产的 .apks」时没有任何理由放弃 install-apks；
 * 这条约束由缓存目录的命名（含文件指纹 + 设备 key）天然保证。
 *
 * 缓存
 * ---------------------------------------------------------------
 * build-apks 是纯本机计算，但一个 200MB 的 bundle 要跑十几秒到几十秒，
 * 而「装到另一台设备」往往要连装好几次。所以在临时目录里按
 * 「文件内容指纹 + 目标设备 + 签名标签」缓存 apks 产物，第二次起直接复用。
 * 签名必须进缓存键：换了签名却吃旧产物等于白改（装上去的还是旧 key hash 的包）。
 *
 * 工具链
 * ---------------------------------------------------------------
 * 需要 java 11+ 与 bundletool-all-<ver>.jar。两者本程序都不预装，
 * 由用户点「一键下载」（只下 jar）或自己放到 resources/bin/jre/，
 * 缺哪一样都会给出明确的、可照做的提示。
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  createWriteStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { adbPath, binDir, log, runAdb } from './adb';
import { readAabInfo } from './apk';
import { findJava, javaVersionOk, describeJava, JavaInfo } from './java';
import { resolveSigning } from './aab-signing';
import { listZipEntries, readZipEntry } from './zip';
import { INSTALL_MODE_LABEL } from '../../shared/types';
import type { InstallMode, InstallResult, AabEnv, AabSigningConfig } from '../../shared/types';

/* ------------------------------------------------------------------ */
/* 环境与工具链                                                        */
/* ------------------------------------------------------------------ */

/** bundletool 版本 —— 与 Google 官方 release 对齐（见 README） */
export const BUNDLETOOL_VERSION = '1.18.3';
const BUNDLETOOL_FILE = `bundletool-all-${BUNDLETOOL_VERSION}.jar`;
const BUNDLETOOL_URL = `https://github.com/google/bundletool/releases/download/${BUNDLETOOL_VERSION}/${BUNDLETOOL_FILE}`;

/**
 * 镜像地址：GitHub 直链在国内经常连不上，
 * 依次尝试 ghproxy → 直链（可用的先赢）。
 */
const BUNDLETOOL_URLS = [
  `https://ghfast.top/${BUNDLETOOL_URL}`,
  `https://ghproxy.net/${BUNDLETOOL_URL}`,
  BUNDLETOOL_URL,
];

/** bundletool 存放目录：binDir() 下的 bundletool/ */
function toolsDir(): string {
  return join(binDir(), 'bundletool');
}

/** bundletool jar 的本机路径（不一定存在） */
export function bundletoolJarPath(): string {
  return join(toolsDir(), BUNDLETOOL_FILE);
}

/** 是否已就位：优先用随包（bin/bundletool/）的那个 */
export function findBundletool(): string | null {
  const p = bundletoolJarPath();
  return existsSync(p) ? p : null;
}

/**
 * AAB 安装能力全景（界面据此决定显示「可以装」还是「缺什么」）。
 * 这个是同步快速版，不跑 java -version；详细版见 inspectAabEnv()。
 */
export function aabEnvQuick(): Omit<AabEnv, 'javaPath' | 'javaVersion' | 'javaOk' | 'javaDesc' | 'reason' | 'ready'> {
  return {
    bundletoolReady: !!findBundletool(),
    bundletoolPath: bundletoolJarPath(),
    bundletoolVersion: BUNDLETOOL_VERSION,
    downloadUrl: BUNDLETOOL_URL,
    javaBundled: existsSync(join(binDir(), 'jre')),
  };
}

export interface AabRuntime {
  java: JavaInfo | null;
  jar: string | null;
  /** 两者齐备且 Java 版本够 */
  ready: boolean;
  /** 不可用时的原因（可直接展示给用户） */
  reason?: string;
}

let runtimeCache: AabRuntime | undefined;

/** 清缓存（下载完 jar / 用户手动放了 JRE 后调用） */
export function resetAabRuntime(): void {
  runtimeCache = undefined;
}

/**
 * 检查 AAB 安装所需的运行时。
 * 缺 Java 与缺 jar 的提示分开写 —— 用户需要知道到底该补哪一样。
 */
export async function resolveAabRuntime(force = false): Promise<AabRuntime> {
  if (!force && runtimeCache) return runtimeCache;

  const java = await findJava(force);
  const jar = findBundletool();

  if (!java) {
    runtimeCache = {
      java,
      jar,
      ready: false,
      reason:
        'AAB 安装需要 Java 运行时（bundletool 是 Java 程序），本机没找到。' +
        '可以安装 Java 11 及以上，或把便携版 JRE 放到程序的 bin\\jre 目录。',
    };
    return runtimeCache;
  }
  if (!javaVersionOk(java)) {
    runtimeCache = {
      java,
      jar,
      ready: false,
      reason: `检测到的 Java 版本过低（${java.version ?? '未知'}），bundletool 需要 Java 11 及以上。`,
    };
    return runtimeCache;
  }
  if (!jar) {
    runtimeCache = {
      java,
      jar,
      ready: false,
      reason:
        `缺少 bundletool（${BUNDLETOOL_FILE}）。` +
        '可点下方「下载 bundletool」自动获取，或手动放进 ' +
        toolsDir(),
    };
    return runtimeCache;
  }

  runtimeCache = { java, jar, ready: true };
  return runtimeCache;
}

/** 给设置页 / 安装页用的完整环境信息 */
export async function inspectAabEnv(force = false): Promise<AabEnv> {
  const rt = await resolveAabRuntime(force);
  return {
    ...aabEnvQuick(),
    javaPath: rt.java?.path,
    javaVersion: rt.java?.version,
    javaOk: javaVersionOk(rt.java),
    javaDesc: describeJava(rt.java),
    ready: rt.ready,
    reason: rt.reason,
  };
}

/* ------------------------------------------------------------------ */
/* 下载 bundletool                                                     */
/* ------------------------------------------------------------------ */

export interface DownloadProgress {
  received: number;
  total: number;
  percent: number;
}

function httpGet(url: string): Promise<{ status: number; stream: NodeJS.ReadableStream; total: number }> {
  return new Promise((resolve, reject) => {
    let mod: typeof import('http');
    try {
      // 延迟 require：Electron 主进程里 https 可用，但这个模块在测试里也会被加载
      mod = require('https') as typeof import('http');
    } catch (e) {
      reject(e);
      return;
    }
    const req = mod.get(
      url,
      {
        headers: { 'User-Agent': 'ADBAssistant', Accept: '*/*' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // 跟随重定向（GitHub release 一定会 302 到 objects.githubusercontent）
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve(httpGet(res.headers.location));
          return;
        }
        resolve({
          status,
          stream: res,
          total: parseInt(String(res.headers['content-length'] ?? '0'), 10) || 0,
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('连接超时'));
    });
  });
}

/**
 * 下载 bundletool jar 到 bin/bundletool/。
 * 先下到 .part 再改名 —— 中途断网不会留下一个看起来正常的坏 jar。
 */
export async function downloadBundletool(
  onProgress?: (p: DownloadProgress) => void,
): Promise<{ path: string; size: number; url: string }> {
  const dir = toolsDir();
  mkdirSync(dir, { recursive: true });
  const dest = bundletoolJarPath();
  const part = `${dest}.part`;

  const errors: string[] = [];

  for (const url of BUNDLETOOL_URLS) {
    try {
      log('info', 'AAB', `正在下载 bundletool：${url}`);
      const res = await httpGet(url);
      if (res.status !== 200) {
        errors.push(`${url} → HTTP ${res.status}`);
        continue;
      }

      const total = res.total;
      let received = 0;
      const out = createWriteStream(part);
      await new Promise<void>((resolve, reject) => {
        res.stream.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (onProgress) {
            onProgress({
              received,
              total,
              percent: total ? Math.round((received / total) * 100) : 0,
            });
          }
        });
        res.stream.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
        res.stream.on('error', reject);
      });

      const size = statSync(part).size;
      // jar 一定是 ZIP（PK\x03\x04）开头；下到 HTML 错误页要认出来
      const head = readFileSync(part).subarray(0, 4);
      if (size < 1024 * 1024 || head[0] !== 0x50 || head[1] !== 0x4b) {
        try {
          rmSync(part, { force: true });
        } catch {
          /* ignore */
        }
        errors.push(`${url} → 下载内容不是有效的 jar（${size} 字节）`);
        continue;
      }

      if (existsSync(dest)) {
        try {
          rmSync(dest, { force: true });
        } catch {
          /* ignore */
        }
      }
      // rename 可能跨卷失败，退化成复制
      try {
        renameSync(part, dest);
      } catch {
        writeFileSync(dest, readFileSync(part));
        rmSync(part, { force: true });
      }

      resetAabRuntime();
      log('success', 'AAB', `bundletool 已就位（${(size / 1024 / 1024).toFixed(1)} MB）`, dest);
      return { path: dest, size, url };
    } catch (e) {
      errors.push(`${url} → ${(e as Error).message}`);
    }
  }

  throw new Error(
    `bundletool 下载失败：${errors.join('；')}。` +
      `可手动下载 ${BUNDLETOOL_URL} 放到 ${dir}\\ 后再试。`,
  );
}

/* ------------------------------------------------------------------ */
/* 签名                                                                */
/* ------------------------------------------------------------------ */

/**
 * 为什么必须自己带一份调试密钥库
 * ---------------------------------------------------------------
 * bundletool 的文档说「不给 --ks 就用默认调试密钥库」，但那个默认值指的是
 * `~/.android/debug.keystore` —— 只有装过 Android SDK 并跑过一次构建的机器才有。
 * 本机（以及大多数只装了我们这个助手的机器）根本没有这个文件，
 * 于是 bundletool 只会打一行 WARNING 然后产出**未签名**的 APK，
 * install-multiple 阶段被系统以「没有证书」拒掉，报错还很难懂。
 * 实测确认：那一版全是 `WARNING: The APKs won't be signed...`。
 *
 * 但「用调试密钥库」本身也有代价 —— 见 aab-signing.ts 开头的说明：
 * 换签名会改 key hash，Facebook / 微信 / Google 登录、推送全都会失配。
 * 所以签名方式做成了可配置的三选一（随包调试 / 我的密钥库 / 不签名），
 * 真正的解析逻辑在 aab-signing.ts，这里只负责取参数拼命令行。
 */

/** 签名相关的命令行参数（跳过签名时返回空数组） */
async function signingArgs(override?: Partial<AabSigningConfig>): Promise<{
  args: string[];
  desc: string;
  ok: boolean;
  reason?: string;
}> {
  const { info, args } = await resolveSigning(override);
  return { args, desc: info.desc, ok: info.ok, reason: info.reason };
}

/* ------------------------------------------------------------------ */
/* bundletool 调用                                                     */
/* ------------------------------------------------------------------ */

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runJava(
  java: string,
  args: string[],
  onLine: ((line: string) => void) | undefined,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(java, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    }, timeoutMs);

    const feed = (buf: Buffer, isErr: boolean) => {
      const text = buf.toString('utf8');
      if (isErr) stderr += text;
      else stdout += text;
      if (onLine) {
        text.split(/\r?\n/).forEach((l) => {
          const t = l.trim();
          if (t) onLine(t);
        });
      }
    };

    child.stdout?.on('data', (d: Buffer) => feed(d, false));
    child.stderr?.on('data', (d: Buffer) => feed(d, true));
    child.on('error', (e) => {
      clearTimeout(timer);
      done = true;
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done = true;
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 把 bundletool 的输出压成一行一句有用的信息 */
function pickErrorLine(stderr: string, stdout: string): string {
  const lines = (stderr + '\n' + stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 优先挑带 Exception / Error 的那一行
  const key = lines.find((l) => /(Exception|Error|FAILED|失败)/i.test(l));
  const raw = key || lines[lines.length - 1] || '';
  return raw
    .replace(/^Exception in thread "[^"]*"\s*/, '')
    .replace(/^(java\.lang\.|com\.android\.tools\.bundletool\.)[\w$.]*?(Exception|Error):\s*/, '');
}

/* ------------------------------------------------------------------ */
/* 产物缓存                                                            */
/* ------------------------------------------------------------------ */

/** 缓存根目录：临时目录下的固定位置，进程退出不清（下次安装直接复用） */
function cacheRoot(): string {
  return join(tmpdir(), 'adb-assistant-aab');
}

/**
 * 文件指纹：大小 + 前 256KB + 后 256KB 的 sha1。
 * 读全量 200MB 太亏，而 AAB 的中央目录在尾部、版本信息在头部，
 * 两头都取到就足以区分不同构建。
 */
function fingerprint(file: string): string {
  const size = statSync(file).size;
  const h = createHash('sha1');
  h.update(`${size}|`);
  const fd = openSync(file, 'r');
  try {
    const chunk = 256 * 1024;
    const head = Buffer.alloc(Math.min(chunk, size));
    readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (size > chunk) {
      const tailLen = Math.min(chunk, size - chunk);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex').slice(0, 16);
}

/** 设备指纹：同一颗设备（同 serial + 同 Android 版本）之间缓存才可复用 */
async function deviceKey(serial: string): Promise<string> {
  const res = await runAdb(['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'], {
    silent: true,
    timeout: 15000,
  });
  const sdk = res.stdout.trim().replace(/[^\d]/g, '') || '0';
  return `${serial.replace(/[^\w.-]/g, '_')}-sdk${sdk}`;
}

/**
 * 签名标签：把签名参数压成一段短 hash 拼进缓存目录名。
 *
 * 为什么不直接把路径拼进去：路径含盘符/反斜杠/中文，做目录名不安全，
 * 而且密码也会跟着进名字（虽然只是本地临时目录，也没必要）。
 * 用 hash 既短又不会泄漏，还能保证「同签名复用、不同签名重拆」。
 */
function signingKeyTag(args: string[]): string {
  if (!args.length) return 'nosign';
  return createHash('sha1').update(args.join('|')).digest('hex').slice(0, 10);
}

function cachedApksDir(file: string, key: string, signTag = 'nosign'): string {
  return join(cacheRoot(), `${fingerprint(file)}-${key}-${signTag}`);
}

/**
 * 产物目录里记着「我是从哪个 .aab 拆出来的」的文件名。
 *
 * .apks 本身不含包名（toc.pb 是 protobuf，不值得为它引入解析器），
 * 而「装完按包名复核」是我们对 APK/AAB 一贯的硬规矩 —— 所以拆包时
 * 顺手把源 AAB 的路径写在这里，装现成 .apks 时就有据可查。
 */
const APKS_SOURCE_FILE = 'source.aab.txt';

/* ------------------------------------------------------------------ */
/* 拆包（AAB → .apks，不碰设备侧状态）                                 */
/* ------------------------------------------------------------------ */

export interface BundleConvertOptions {
  /** 目标设备（必填 —— 拆包要按它的屏幕/ABI/SDK 挑 split） */
  serial: string;
  /** 输出路径（默认写进缓存目录的 app.apks；另存给用户时传他的路径） */
  outPath?: string;
  /** 输出已存在时是否覆盖 */
  overwrite?: boolean;
  /** 是否允许使用上一次的拆包产物（默认允许） */
  useCache?: boolean;
  /** 本次拆包使用的签名配置（不传则用用户设置里那份） */
  signing?: Partial<AabSigningConfig>;
  /** 输出一行日志（往界面推） */
  onLine?: (line: string) => void;
}

export interface BundleConvertResult {
  /** 产物 .apks 的绝对路径 */
  apksPath: string;
  /** 本次工作的缓存目录（含 device-spec.json） */
  cacheDir: string;
  /** 读出来的包名（读不出为 undefined） */
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  /** 源 AAB 的字节数 */
  sizeBytes: number;
  /** 是否复用了上一次的产物 */
  fromCache: boolean;
  /** 是否真的重新拆了包（复用缓存时为 false） */
  rebuilt: boolean;
  /** 拆包耗时（毫秒；复用缓存时为 0） */
  buildMs: number;
  /** 签名描述（给界面/日志看） */
  signingDesc: string;
  /** 产物是否直接落在用户指定的 outPath 上 */
  savedToOutPath: boolean;
}

/**
 * 把 AAB 拆成 .apks（针对指定设备）。
 *
 * 只做「本机计算 + 取一次 device spec」，不改设备上的任何状态：
 * 不卸载、不安装、不判断覆盖/清洁/全新。装与不装由调用方决定。
 *
 * 缓存命中时的产物落在缓存目录里（source）；调用方要另存时我们复制一份
 * 到 outPath。反向（产物本就在 outPath）时直接返回，不重复复制。
 */
export async function convertBundle(
  aabPath: string,
  options: BundleConvertOptions,
): Promise<BundleConvertResult> {
  const serial = options.serial;
  if (!serial) throw new Error('拆包必须明确指定目标设备（要按它的配置挑 split）');

  const say = (line: string) => {
    options.onLine?.(line);
  };

  if (!existsSync(aabPath)) throw new Error(`文件不存在：${aabPath}`);
  const lower = basename(aabPath).toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  if (ext !== '.aab') throw new Error('所选文件不是 .aab 文件');

  /* ---- 0. 先认文件：不是真正的 app bundle 就别浪费 bundletool 的时间 ---- */
  const info = readAabInfo(aabPath);
  const pkg = info.packageName;
  const size = statSync(aabPath).size;

  /* ---- 1. 运行时 ---- */
  const rt = await resolveAabRuntime();
  if (!rt.ready) throw new Error(rt.reason || 'AAB 拆包环境不完整（需要 Java 11+ 与 bundletool）');
  say(`Java：${describeJava(rt.java)}`);
  say(`bundletool：${basename(rt.jar!)}`);

  /* ---- 2. 签名 ---- */
  const signing = await signingArgs(options.signing);
  if (!signing.ok) {
    throw new Error(
      `签名配置不可用：${signing.reason || signing.desc}。` +
        '可在安装页的「签名方式」里改用随包调试密钥库，或指定自己的密钥库。',
    );
  }
  say(`签名：${signing.desc}`);

  /* ---- 3. 缓存目录 ---- */
  const key = await deviceKey(serial);
  const cacheDir = cachedApksDir(aabPath, key, signingKeyTag(signing.args));
  const cachedFile = join(cacheDir, 'app.apks');
  const specFile = join(cacheDir, 'device-spec.json');
  const cacheHit = options.useCache !== false && existsSync(cachedFile);

  let buildMs = 0;
  if (cacheHit) {
    say(`复用上次的拆包产物：${cacheDir}`);
    log('info', 'AAB', '复用上次的拆包产物（同一个 AAB、同一颗设备、同一份签名）');
  } else {
    /* ---- 4. build-apks ---- */
    try {
      rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    mkdirSync(cacheDir, { recursive: true });

    say(`正在为这台设备拆包（${(size / 1024 / 1024).toFixed(1)} MB，首次较慢）…`);
    log('info', 'AAB', `bundletool build-apks（device-spec=${serial}｜${signing.desc}）`);

    // 把本次签名写进产物目录，方便下次诊断「这份缓存是哪个签名拆的」
    try {
      writeFileSync(join(cacheDir, 'signing.txt'), signing.desc, 'utf8');
    } catch {
      /* ignore */
    }

    // 记下源 AAB 的路径：装现成的 .apks 时靠它反查包名做装后复核
    try {
      writeFileSync(join(cacheDir, APKS_SOURCE_FILE), resolve(aabPath), 'utf8');
    } catch {
      /* ignore */
    }

    const started = Date.now();
    // 先取设备规格（缓存命中则零成本），build 阶段就完全不用碰 adb 了
    await ensureDeviceSpec(serial, rt.java!.path, rt.jar!, specFile, (l) => say(l));

    const build = await runJava(
      rt.java!.path,
      [
        '-jar',
        rt.jar!,
        'build-apks',
        `--bundle=${aabPath}`,
        `--output=${cachedFile}`,
        `--device-spec=${specFile}`,
        // 必须显式带上密钥库，否则产出的是未签名 APK，安装阶段直接被拒
        ...signing.args,
        '--overwrite',
      ],
      (l) => say(l),
      // 200MB+ 的 bundle 在慢机器上可能跑好几分钟，给足余量
      10 * 60 * 1000,
    );
    buildMs = Date.now() - started;

    if (build.code !== 0 || !existsSync(cachedFile)) {
      const reason = pickErrorLine(build.stderr, build.stdout);
      // 产物目录清掉，避免一个半成品缓存一直挂着（device-spec 也一起清，
      // 免得设备换了配置还一直用旧的规格文件）
      try {
        rmSync(cacheDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw new Error(
        `拆包失败（bundletool build-apks）：${reason || '未知原因'}` +
          (/unsigned|not signed|签名/i.test(reason)
            ? '。这个 AAB 没有签名或签名方式不受支持，请用 bundletool 直接产出的 .aab，' +
              '或改用已经签好名的 APK。'
            : ''),
      );
    }
    say(`拆包完成（${((Date.now() - started) / 1000).toFixed(1)}s）`);
    log('success', 'AAB', `拆包完成，产物 ${cachedFile}`);
  }

  /* ---- 5. 另存（只有用户给了 outPath 且跟缓存不是同一个文件时才复制） ---- */
  const outPath = options.outPath;
  let apksPath = cachedFile;
  let savedToOutPath = false;

  if (outPath) {
    if (resolve(outPath) !== resolve(cachedFile)) {
      if (existsSync(outPath) && options.overwrite === false) {
        throw new Error(`目标文件已存在：${outPath}`);
      }
      mkdirSync(dirname(outPath), { recursive: true });
      // 先写 .part 再改名：中途失败不会在用户目录里留一个看起来正常的半截包
      const part = `${outPath}.part`;
      try {
        rmSync(part, { force: true });
      } catch {
        /* ignore */
      }
      copyFileSync(cachedFile, part);
      try {
        rmSync(outPath, { force: true });
      } catch {
        /* ignore */
      }
      renameSync(part, outPath);
      say(`已保存到：${outPath}`);
      log('success', 'AAB', `已另存拆包产物：${outPath}`);
    }
    apksPath = outPath;
    savedToOutPath = true;
  }

  return {
    apksPath,
    cacheDir,
    packageName: pkg,
    versionName: info.versionName,
    versionCode: info.versionCode,
    sizeBytes: size,
    fromCache: cacheHit,
    rebuilt: !cacheHit,
    buildMs,
    signingDesc: signing.desc,
    savedToOutPath,
  };
}

/* ------------------------------------------------------------------ */
/* 通用 APK（AAB → 单个 .apk，与设备无关）                              */
/* ------------------------------------------------------------------ */

/**
 * 通用 APK（universal）：一个能装进任何 Android 设备的 .apk。
 *
 * 与「按设备拆包」的关系
 * ---------------------------------------------------------------
 * build-apks 的默认行为是「按目标设备的 ABI / 屏幕密度 / SDK 挑一份 split 组合」，
 * 装到别的机器上未必合适。`--mode=universal` 反其道而行：把 base 与**所有**配置的
 * 资源、so 全塞进同一个 APK —— 任何设备都能装，也能直接发给别人（微信、网盘、
 * 数据线拷贝都行），代价只有一个：体积大（每个 ABI 的 so、每种密度的图都在里面）。
 *
 * 三处结构性差异（所以没有复用 convertBundle）
 * ---------------------------------------------------------------
 *   1. **完全不碰设备**。universal 与设备配置无关，不需要 device-spec，
 *      也就不依赖 adb —— 一台设备都没连也能导出，正好覆盖「把手上几十个 AAB
 *      批量转成能分发的 APK」这个场景。
 *   2. **缓存键里没有设备**。同一份 AAB + 同一份签名只会有一个通用产物，
 *      把设备 key 拼进去等于同一份数据存好几份。
 *   3. **产物是 .apk 而不是 .apks**。用户拿到的必须是一个能直接
 *      `adb install` / 微信发送的单文件，所以要从 .apks 里把 universal.apk
 *      抠出来（.apks 本身就是 zip，用项目自带的读取器即可，不引第三方依赖）。
 */

/** .apks 里那个「万能包」的条目名（bundletool --mode=universal 的固定输出） */
const UNIVERSAL_APK_FILE = 'universal.apk';

/** 通用产物的缓存目录：文件指纹 + 签名标签，**不含设备** */
function cachedUniversalDir(file: string, signTag: string): string {
  return join(cacheRoot(), `${fingerprint(file)}-universal-${signTag}`);
}

function quietRm(target: string, recursive = true): void {
  try {
    rmSync(target, { recursive, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 从 universal 模式的 .apks 里取出那个 apk。
 * 落盘前验一次 ZIP 魔数 —— 宁可在这里报错，也不要把坏文件写进用户的目录。
 */
function extractUniversalFromApks(apksPath: string, destFile: string): void {
  const buf = readFileSync(apksPath);
  const entries = listZipEntries(buf);
  const hit =
    entries.find((e) => !e.isDir && e.name === UNIVERSAL_APK_FILE) ||
    entries.find((e) => !e.isDir && e.name.toLowerCase().endsWith(`/${UNIVERSAL_APK_FILE}`)) ||
    entries.find((e) => !e.isDir && e.name.toLowerCase().endsWith('.apk'));

  if (!hit) {
    throw new Error(
      `产物里没有 ${UNIVERSAL_APK_FILE}（实际条目：${entries.map((e) => e.name).join('、') || '空'}）` +
        '，说明这份 .apks 不是 universal 模式生成的。',
    );
  }

  const data = readZipEntry(buf, hit);
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error(`提取出的 ${UNIVERSAL_APK_FILE} 不是有效的 APK（${data.length} 字节）`);
  }

  const part = `${destFile}.part`;
  quietRm(part, false);
  writeFileSync(part, data);
  quietRm(destFile, false);
  renameSync(part, destFile);
}

export interface UniversalApkOptions {
  /** 另存路径（不传就只留在缓存目录里） */
  outPath?: string;
  /** 目标文件已存在时是否覆盖 */
  overwrite?: boolean;
  /** 是否允许复用上一次的产物（默认允许） */
  useCache?: boolean;
  /** 本次使用的签名配置（不传则用用户设置里那份） */
  signing?: Partial<AabSigningConfig>;
  /** 输出一行日志（往界面推） */
  onLine?: (line: string) => void;
}

export interface UniversalApkResult {
  /** 产出的 .apk 的绝对路径（另存时为 outPath） */
  apkPath: string;
  /** 本次工作的缓存目录 */
  cacheDir: string;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  /** 源 AAB 的字节数 */
  bundleBytes: number;
  /** 产出的 .apk 的字节数（放缓存里那份，与另存无关） */
  apkBytes: number;
  /** 是否复用了上一次的产物 */
  fromCache: boolean;
  /** 是否真的重新生成（复用缓存时为 false） */
  rebuilt: boolean;
  /** 生成耗时（毫秒；复用缓存时为 0） */
  buildMs: number;
  signingDesc: string;
  /** 产物是否直接落在用户指定的 outPath 上 */
  savedToOutPath: boolean;
}

/**
 * 把 AAB 转成一个能装进任何设备的通用 APK。
 *
 * 不读设备、不改设备状态、不需要设备在线 —— 纯本机转换。
 */
export async function buildUniversalApk(
  aabPath: string,
  options: UniversalApkOptions = {},
): Promise<UniversalApkResult> {
  const say = (line: string) => {
    options.onLine?.(line);
  };

  if (!existsSync(aabPath)) throw new Error(`文件不存在：${aabPath}`);
  if (!basename(aabPath).toLowerCase().endsWith('.aab')) throw new Error('所选文件不是 .aab 文件');

  /* ---- 0. 先认文件 ---- */
  const info = readAabInfo(aabPath);
  const pkg = info.packageName;
  const bundleBytes = statSync(aabPath).size;

  /* ---- 1. 运行时 ---- */
  const rt = await resolveAabRuntime();
  if (!rt.ready) throw new Error(rt.reason || 'AAB 环境不完整（需要 Java 11+ 与 bundletool）');
  say(`Java：${describeJava(rt.java)}`);
  say(`bundletool：${basename(rt.jar!)}`);

  /* ---- 2. 签名 ---- */
  // 签名同样必须显式给：bundletool 找不到 ~/.android/debug.keystore 时会
  // 静默产出未签名 APK，用户拿去装才会发现装不上。
  const signing = await signingArgs(options.signing);
  if (!signing.ok) {
    throw new Error(
      `签名配置不可用：${signing.reason || signing.desc}。` +
        '可在安装页的「签名方式」里改用随包调试密钥库，或指定自己的密钥库。',
    );
  }
  say(`签名：${signing.desc}`);

  /* ---- 3. 缓存（键里没有设备） ---- */
  const cacheDir = cachedUniversalDir(aabPath, signingKeyTag(signing.args));
  const apkFile = join(cacheDir, UNIVERSAL_APK_FILE);
  const rawApks = join(cacheDir, 'universal.apks');
  const cacheHit = options.useCache !== false && existsSync(apkFile);

  let buildMs = 0;
  if (cacheHit) {
    say(`复用上次的通用 APK：${apkFile}`);
    log('info', 'AAB', '复用上次的通用 APK 产物（同一个 AAB、同一份签名）');
  } else {
    quietRm(cacheDir);
    mkdirSync(cacheDir, { recursive: true });

    // 顺手记下这份缓存的来源与签名，便于以后诊断
    try {
      writeFileSync(join(cacheDir, 'signing.txt'), signing.desc, 'utf8');
    } catch {
      /* ignore */
    }
    try {
      writeFileSync(join(cacheDir, APKS_SOURCE_FILE), resolve(aabPath), 'utf8');
    } catch {
      /* ignore */
    }

    say(
      `正在生成通用 APK（源包 ${(bundleBytes / 1024 / 1024).toFixed(1)} MB，` +
        '含全部 ABI 与屏幕资源，产物体积会明显更大、首次较慢）…',
    );
    log('info', 'AAB', `bundletool build-apks --mode=universal（${signing.desc}）`);

    const started = Date.now();
    const build = await runJava(
      rt.java!.path,
      [
        '-jar',
        rt.jar!,
        'build-apks',
        `--bundle=${aabPath}`,
        `--output=${rawApks}`,
        // universal：不分设备挑 split，产出一个包含全部资源的 APK
        '--mode=universal',
        ...signing.args,
        '--overwrite',
      ],
      (l) => say(l),
      10 * 60 * 1000,
    );
    buildMs = Date.now() - started;

    if (build.code !== 0 || !existsSync(rawApks)) {
      const reason = pickErrorLine(build.stderr, build.stdout);
      quietRm(cacheDir);
      throw new Error(
        `生成通用 APK 失败（bundletool build-apks --mode=universal）：${reason || '未知原因'}` +
          (/unsigned|not signed|签名/i.test(reason)
            ? '。这个 AAB 没有签名或签名方式不受支持，请改用已经签好名的 APK。'
            : ''),
      );
    }

    try {
      extractUniversalFromApks(rawApks, apkFile);
    } catch (e) {
      quietRm(cacheDir);
      throw new Error(`通用 APK 已生成但提取失败：${(e as Error).message}`);
    }

    // 中间产物用完即弃：universal.apks 解出来几乎就是那个 apk 本身
    // （uncompressed），留着等于同一份数据占两倍磁盘
    quietRm(rawApks, false);

    const apkSize = statSync(apkFile).size;
    say(
      `通用 APK 完成（${((Date.now() - started) / 1000).toFixed(1)}s，` +
        `${(apkSize / 1024 / 1024).toFixed(1)} MB）`,
    );
    log('success', 'AAB', `通用 APK 已生成：${apkFile}`);
  }

  /* ---- 4. 另存（与拆包产物同一套写法：先 .part 再改名） ---- */
  const outPath = options.outPath;
  let apkPathOut = apkFile;
  let savedToOutPath = false;

  if (outPath) {
    if (resolve(outPath) !== resolve(apkFile)) {
      if (existsSync(outPath) && options.overwrite === false) {
        throw new Error(`目标文件已存在：${outPath}`);
      }
      mkdirSync(dirname(outPath), { recursive: true });
      const part = `${outPath}.part`;
      quietRm(part, false);
      copyFileSync(apkFile, part);
      quietRm(outPath, false);
      renameSync(part, outPath);
      say(`已保存到：${outPath}`);
      log('success', 'AAB', `通用 APK 已另存：${outPath}`);
    }
    apkPathOut = outPath;
    savedToOutPath = true;
  }

  return {
    apkPath: apkPathOut,
    cacheDir,
    packageName: pkg,
    versionName: info.versionName,
    versionCode: info.versionCode,
    bundleBytes,
    apkBytes: statSync(apkFile).size,
    fromCache: cacheHit,
    rebuilt: !cacheHit,
    buildMs,
    signingDesc: signing.desc,
    savedToOutPath,
  };
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

export interface BundleInstallOptions {
  /** 目标设备（必填 —— 上层已经保证不猜设备） */
  serial: string;
  /** 安装方式，语义与 APK 一致 */
  mode?: InstallMode;
  /** 自动授予全部权限（install-apks 的 --grant-all） */
  grantAll?: boolean;
  /** 输出一行日志（往界面推） */
  onLine?: (line: string) => void;
  /** 是否允许使用上一次的 build 产物 */
  useCache?: boolean;
  /** 安装成功后是否删除临时产物（默认保留，便于连装第二台） */
  cleanAfter?: boolean;
  /**
   * 本次安装使用的签名配置（不传则用用户设置里那份）。
   * 注意：签名参与拆包结果的指纹 —— 换了签名必须重拆，不能吃缓存。
   */
  signing?: Partial<AabSigningConfig>;
}

export interface BundleInstallResult extends InstallResult {
  /** AAB 里读出的信息 */
  fromBundle: boolean;
  /** 是否来自一份现成的 .apks（没有再拆包） */
  fromApks?: boolean;
  /** build-apks 是否复用了缓存 */
  fromCache?: boolean;
  /** build-apks 耗时（毫秒） */
  buildMs?: number;
  /** install-apks 耗时（毫秒） */
  installMs?: number;
  /** 本次产物目录 */
  apksDir?: string;
}

/**
 * 把 AAB 装到设备上。
 *
 * 与 installApk 保持同样的「两条硬规矩」：
 *  1. 目标设备由参数明确指定（调用方保证不猜）；
 *  2. 装完按包名 `pm path` 复核 —— bundletool 说 Success 不等于设备上真有这个包。
 *
 * 拆包那一段全部交给 convertBundle()，这里只负责设备侧的状态变更
 * （clean 的卸载、fresh 的拦截、install-apks、装后复核）。
 */
export async function installBundle(
  aabPath: string,
  options: BundleInstallOptions,
): Promise<BundleInstallResult> {
  const serial = options.serial;
  if (!serial) throw new Error('安装 AAB 必须明确指定目标设备');

  const mode: InstallMode = options.mode ?? 'overwrite';
  const grantAll = options.grantAll ?? false;
  const say = (line: string) => {
    options.onLine?.(line);
  };

  if (!existsSync(aabPath)) throw new Error(`文件不存在：${aabPath}`);
  const ext = basename(aabPath).toLowerCase().slice(basename(aabPath).lastIndexOf('.'));
  if (ext !== '.aab') throw new Error('所选文件不是 .aab 文件');

  const size = statSync(aabPath).size;
  const pkg = readAabInfo(aabPath).packageName;

  log(
    'info',
    'AAB',
    `目标设备 ${serial}｜${INSTALL_MODE_LABEL[mode]}：${pkg ?? basename(aabPath)}（${(size / 1024 / 1024).toFixed(1)} MB）`,
  );

  /*
   * 设备侧的准备工作跟「有没有拆包缓存」无关，必须每次都做 ——
   * 否则「第二次装到同一台设备」会命中缓存，跳过 fresh 的拦截与 clean 的卸载，
   * 变成一个行为不一致的覆盖安装。所以先做设备侧判断，再拆包。
   */

  /* 清洁安装：先按包名卸掉旧版本 */
  if (mode === 'clean') {
    if (!pkg) {
      throw new Error(
        '读不出 AAB 的包名，无法清洁安装（清洁安装要先按包名卸载旧版本）。可改用「覆盖安装」。',
      );
    }
    if (await deviceHasPackage(serial, pkg)) {
      say(`清洁安装：先卸载 ${pkg}，应用数据会一起清掉`);
      const res = await runAdb(['-s', serial, 'uninstall', pkg], {
        source: 'AAB',
        timeout: 90000,
      });
      const text = (res.stdout + '\n' + res.stderr).trim();
      if (/Failure|Error/i.test(text) || !res.ok || !/Success/i.test(text)) {
        throw new Error(
          `卸载旧版本失败：${text.replace(/^.*?Failure\s*/i, '').trim() || '未知原因'}`,
        );
      }
    } else {
      say(`清洁安装：设备上没有 ${pkg}，直接全新安装`);
    }
  }

  /* 全新安装：设备上已经有了就直接中止 */
  if (mode === 'fresh' && pkg && (await deviceHasPackage(serial, pkg))) {
    throw new Error(
      `设备 ${serial} 上已存在 ${pkg}，已按「全新安装」的约定中止，没有动到旧版本。` +
        '如需升级请用「覆盖安装」，如需清空数据重装请用「清洁安装」。',
    );
  }

  /* ---- 拆包（内部处理缓存；每一步都往界面推日志） ---- */
  const conv = await convertBundle(aabPath, {
    serial,
    useCache: options.useCache,
    signing: options.signing,
    onLine: options.onLine,
  });

  // 拆包失败时 convertBundle 已把半成品目录清掉，这里只接住结果
  const apksFile = conv.apksPath;
  const apksDir = conv.cacheDir;

  const rt = await resolveAabRuntime();
  if (!rt.ready) throw new Error(rt.reason || 'AAB 安装环境不完整（需要 Java 11+ 与 bundletool）');

  /* ---- install-apks ---- */
  // install-apks 支持 --adb，显式指到随包的 adb，避免它去 PATH 上找错一个
  const args = [
    '-jar',
    rt.jar!,
    'install-apks',
    `--apks=${apksFile}`,
    `--adb=${adbPath()}`,
    `--device-id=${serial}`,
  ];
  if (grantAll) args.push('--grant-all');
  // install-apks 不接受 -r：它内部一律用 install-multiple，覆盖语义本来就是默认的

  say('正在安装到设备…');
  const installStarted = Date.now();
  const inst = await runJava(rt.java!.path, args, (l) => say(l), 10 * 60 * 1000);
  const installMs = Date.now() - installStarted;

  const output = (inst.stdout + '\n' + inst.stderr).trim();
  if (inst.code !== 0) {
    const reason = pickErrorLine(inst.stderr, inst.stdout);
    throw new Error(
      `安装失败：${reason || output || '未知原因'}` +
        (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(output)
          ? '。设备上已装的版本与本次拆包所用的签名不一致，可改用「清洁安装」，' +
            '或在「签名方式」里换成这台设备上原有版本所用的密钥库。'
          : ''),
    );
  }

  /* ---- 装后复核（与 APK 同一条硬规矩） ---- */
  let verified: boolean | undefined;
  if (pkg) {
    for (let i = 0; i < 5; i += 1) {
      if (await deviceHasPackage(serial, pkg)) {
        verified = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    if (verified !== true) {
      throw new Error(
        `bundletool 报告安装成功，但在设备 ${serial} 上查不到 ${pkg} —— 实际没有装上。` +
          '常见原因：设备有多个用户 / 系统分身，装到了别的用户下；存储空间或权限受限；厂商安全策略拦截。',
      );
    }
    log('success', 'AAB', `安装成功并已复核：${pkg} → ${serial}`);

    /*
     * 装了但用调试签名拆的包 —— 应用能跑，但凡是「按签名校验」的地方都会挂。
     * 这条提示必须显式打出来，否则用户会把它当成我们工具的 bug 来报。
     */
    if (/调试密钥库/.test(conv.signingDesc)) {
      log(
        'warn',
        'AAB',
        '本次用的是调试密钥库，应用的签名已被替换 —— ' +
          'Facebook / 微信 / Google 等三方登录、推送、地图 key 都可能失效。' +
          '如需保持原签名，请在「签名方式」里选「我的密钥库」并指定该应用的正式签名文件。',
      );
    }
  } else {
    log('success', 'AAB', `安装成功（读不出包名，未复核）：${basename(aabPath)} → ${serial}`);
  }

  if (options.cleanAfter) {
    try {
      rmSync(apksDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return {
    serial,
    packageName: pkg,
    versionName: conv.versionName,
    versionCode: conv.versionCode,
    output,
    uninstalled: mode === 'clean',
    verified,
    fromBundle: true,
    fromCache: conv.fromCache,
    buildMs: conv.buildMs,
    installMs,
    apksDir,
  };
}

/** 设备上是否已装该包 */
async function deviceHasPackage(s: string, pkg: string): Promise<boolean> {
  const res = await runAdb(['-s', s, 'shell', 'pm', 'path', pkg], {
    silent: true,
    timeout: 20000,
  });
  return /^package:/m.test(res.stdout);
}

/** 让 bundletool 用我们自带的 adb，避免它去 PATH 上找一个版本不同的 */
function adbForBundletool(): string {
  return adbPath();
}

/* ------------------------------------------------------------------ */
/* 装现成的 .apks                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把「一份现成的 .apks」装到设备上。
 *
 * 边界说明（重要）
 * ---------------------------------------------------------------
 * 这里只接受**本工具自己拆出来的** .apks。走 install-apks 要求
 * 「文件里有一套正常 split 结构」，这个结构只有 build-apks 会给，
 * 所以外部工具产的同名文件天然装不了 —— 不需要额外设防。
 *
 * 版本 1.0.19 起本工具的每个拆包产物目录里都会写一份 `source.aab.txt`
 * （指向拆它的那个 .aab），装现成 .apks 时就靠它反查包名做装后复核。
 * 更早版本的缓存没有这个文件 → 复核退化为「不复核 + 打一条 warn」，
 * 不会因此装不上。
 *
 * 不做设备适配校验：拆包 cache 目录名里已经带了设备 key（serial+sdk），
 * 而「拆给 A 设备的 split 装到 B 设备」属于用户自己的操作，adb 会给出报错。
 * 我们只负责把这个报错翻译成人话。
 *
 * 更不会「装不上就偷偷重拆」——那会让用户以为装 .apks 比装 .aab 还慢，
 * 而且违背了「拆包与安装分开」的初衷。
 */
export async function installApksFile(
  apksPath: string,
  options: BundleInstallOptions,
): Promise<BundleInstallResult> {
  const serial = options.serial;
  if (!serial) throw new Error('安装 .apks 必须明确指定目标设备');

  const mode: InstallMode = options.mode ?? 'overwrite';
  const grantAll = options.grantAll ?? false;
  const say = (line: string) => options.onLine?.(line);

  if (!existsSync(apksPath)) throw new Error(`文件不存在：${apksPath}`);
  const lower = basename(apksPath).toLowerCase();
  if (!lower.endsWith('.apks')) throw new Error('所选文件不是 .apks 文件');

  /* ---- 0. 认来源 ---- */
  const apksDir = dirname(apksPath);
  let inCache = false;
  try {
    const rel = relative(resolve(cacheRoot()), resolve(apksDir));
    // 缓存根目录下的一级子目录 = 本工具拆出来的产物目录
    inCache = !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep);
  } catch {
    inCache = false;
  }

  let pkg: string | undefined;
  const srcFile = join(apksDir, APKS_SOURCE_FILE);
  if (existsSync(srcFile)) {
    try {
      const srcAab = readFileSync(srcFile, 'utf8').trim();
      if (srcAab && existsSync(srcAab)) pkg = readAabInfo(srcAab).packageName;
    } catch {
      /* ignore */
    }
  }

  log(
    'info',
    'APKS',
    `${INSTALL_MODE_LABEL[mode]}：${basename(apksPath)}${pkg ? `（${pkg}）` : ''} → ${serial}` +
      `${inCache ? '' : '｜缓存外的文件，不做设备适配校验'}`,
  );

  /* ---- 1. 设备侧准备（与 AAB 同一套语义） ---- */
  if (mode === 'clean') {
    if (!pkg) {
      throw new Error(
        '读不出这个 .apks 对应的包名，无法清洁安装（要先按包名卸载旧版本）。可改用「覆盖安装」。',
      );
    }
    if (await deviceHasPackage(serial, pkg)) {
      say(`清洁安装：先卸载 ${pkg}，应用数据会一起清掉`);
      const res = await runAdb(['-s', serial, 'uninstall', pkg], {
        source: 'APKS',
        timeout: 90000,
      });
      const text = (res.stdout + '\n' + res.stderr).trim();
      if (/Failure|Error/i.test(text) || !res.ok || !/Success/i.test(text)) {
        throw new Error(
          `卸载旧版本失败：${text.replace(/^.*?Failure\s*/i, '').trim() || '未知原因'}`,
        );
      }
    } else {
      say(`清洁安装：设备上没有 ${pkg}，直接全新安装`);
    }
  }

  if (mode === 'fresh' && pkg && (await deviceHasPackage(serial, pkg))) {
    throw new Error(
      `设备 ${serial} 上已存在 ${pkg}，已按「全新安装」的约定中止，没有动到旧版本。` +
        '如需升级请用「覆盖安装」，如需清空数据重装请用「清洁安装」。',
    );
  }

  /* ---- 2. 运行时 ---- */
  const rt = await resolveAabRuntime();
  if (!rt.ready) throw new Error(rt.reason || 'AAB 安装环境不完整（需要 Java 11+ 与 bundletool）');

  /* ---- 3. install-apks ---- */
  say('正在安装已有产物（不再拆包）…');
  const args = [
    '-jar',
    rt.jar!,
    'install-apks',
    `--apks=${apksPath}`,
    `--adb=${adbPath()}`,
    `--device-id=${serial}`,
  ];
  if (grantAll) args.push('--grant-all');

  const installStarted = Date.now();
  const inst = await runJava(rt.java!.path, args, (l) => say(l), 10 * 60 * 1000);
  const installMs = Date.now() - installStarted;

  const output = (inst.stdout + '\n' + inst.stderr).trim();
  if (inst.code !== 0) {
    const reason = pickErrorLine(inst.stderr, inst.stdout);
    throw new Error(
      `安装失败：${reason || output || '未知原因'}` +
        (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(output)
          ? '。设备上已装的版本与这份产物的签名不一致，可改用「清洁安装」。'
          : '') +
        (inCache
          ? ''
          : '。这是一份不在拆包缓存里的 .apks，如果它不是给这台设备拆的' +
            '（ABI / 屏幕 / SDK 不匹配），请改用对应的 .aab，让本工具按这台设备重新拆包。'),
    );
  }

  /* ---- 4. 装后复核 ---- */
  let verified: boolean | undefined;
  if (pkg) {
    for (let i = 0; i < 5; i += 1) {
      if (await deviceHasPackage(serial, pkg)) {
        verified = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    if (verified !== true) {
      throw new Error(
        `bundletool 报告安装成功，但在设备 ${serial} 上查不到 ${pkg} —— 实际没有装上。` +
          '常见原因：设备有多个用户 / 系统分身，装到了别的用户下；存储空间或权限受限；厂商安全策略拦截。',
      );
    }
    log('success', 'APKS', `安装成功并已复核：${pkg} → ${serial}`);
  } else {
    log(
      'warn',
      'APKS',
      `安装成功，但这份 .apks 没有来源记录（装现成产物的老缓存），无法按包名复核：` +
        `${basename(apksPath)} → ${serial}`,
    );
  }

  return {
    serial,
    packageName: pkg,
    output,
    uninstalled: mode === 'clean',
    verified,
    fromBundle: false,
    fromApks: true,
    fromCache: true,
    installMs,
    apksDir,
  };
}

/* ------------------------------------------------------------------ */
/* 设备规格（device spec）                                             */
/* ------------------------------------------------------------------ */

/**
 * 取目标设备的 device spec（JSON），供 build-apks --device-spec 用。
 *
 * 为什么不用 `--connected-device --device-id=<serial>`
 * ---------------------------------------------------------------
 * bundletool 自己去找 adb，我们没法保证它找到的就是随包那个（用户机器上
 * 可能还有另一个版本的 adb，甚至它可能压根找不到）。而且实测在
 * `--device-id` 缺 `--connected-device` 时它会直接报
 * `Setting --device-id requires using the --connected-device flag`。
 *
 * 拆成「先 get-device-spec 落盘、再 build-apks --device-spec=<文件>」两步后：
 *   - get-device-spec 支持 --adb + --device-id，设备归属完全由我们决定；
 *   - build-apks 只吃一个本地 JSON，不再碰 adb，也就没有了「认哪台设备」的不确定性；
 *   - spec 文件顺手落进缓存目录，同一台设备的第二次安装可以省掉这几秒。
 */
async function ensureDeviceSpec(
  serial: string,
  java: string,
  jar: string,
  specFile: string,
  say?: (line: string) => void,
): Promise<string> {
  if (existsSync(specFile) && statSync(specFile).size > 0) return specFile;

  mkdirSync(join(specFile, '..'), { recursive: true });
  const r = await runJava(
    java,
    ['-jar', jar, 'get-device-spec', `--output=${specFile}`, `--adb=${adbPath()}`, `--device-id=${serial}`, '--overwrite'],
    (l) => say?.(l),
    2 * 60 * 1000,
  );
  if (r.code !== 0 || !existsSync(specFile)) {
    const reason = pickErrorLine(r.stderr, r.stdout);
    throw new Error(
      `读取设备规格失败（bundletool get-device-spec ${serial}）：${reason || '未知原因'}` +
        '。请确认设备仍在线且已授权 USB 调试。',
    );
  }
  return specFile;
}

/* ------------------------------------------------------------------ */
/* 缓存管理（设置页 / 安装页可以清掉）                                  */
/* ------------------------------------------------------------------ */

/** 当前占用空间的拆包产物（含大小），供界面展示 */
export function listBundleCache(): { dir: string; sizeBytes: number; mtime: number }[] {
  const root = cacheRoot();
  if (!existsSync(root)) return [];
  const out: { dir: string; sizeBytes: number; mtime: number }[] = [];

  const dirSize = (d: string): number => {
    let total = 0;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      try {
        total += f.isDirectory() ? dirSize(p) : statSync(p).size;
      } catch {
        /* ignore */
      }
    }
    return total;
  };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      out.push({ dir, sizeBytes: dirSize(dir), mtime: statSync(dir).mtimeMs });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 清空拆包缓存，返回释放的字节数 */
export function clearBundleCache(): { removed: number; freedBytes: number } {
  const items = listBundleCache();
  let removed = 0;
  let freed = 0;
  for (const it of items) {
    try {
      rmSync(it.dir, { recursive: true, force: true });
      removed += 1;
      freed += it.sizeBytes;
    } catch {
      /* ignore */
    }
  }
  if (removed > 0) log('info', 'AAB', `已清理 ${removed} 份拆包缓存，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
  return { removed, freedBytes: freed };
}
