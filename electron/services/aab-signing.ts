/**
 * AAB 拆包用的「签名」配置。
 *
 * 为什么需要这个模块
 * ---------------------------------------------------------------
 * bundletool build-apks 产出的 APK 必须签名，否则设备拒装。默认做法是拿
 * 一个调试密钥库签（见 aab.ts 里的 DEBUG_KS 那一节），但**换签名会改
 * 应用的 key hash**，而很多三方 SDK 是按「包名 + 签名」校验的：
 *
 *   - Facebook 登录      → Invalid key hash（本模块最初就是为它加的）
 *   - 微信 / QQ 登录      → 应用签名不匹配
 *   - Google 登录 / 地图  → API key 绑定包名+签名
 *   - 各家的推送、统计    → 同样是签名白名单
 *
 * 也就是说：拿调试 key 去拆一个「正式签名打的 AAB」，应用能装上，但所有
 * 依赖签名的地方全废。正确做法是用**这个应用自己的发布签名**去拆。
 *
 * 三种签名来源
 * ---------------------------------------------------------------
 *   bundled-debug : 随包的 debug.keystore（默认，开箱即用，只适合纯本地调试）
 *   custom        : 用户自己的 .jks / .keystore（正式签名，三方 SDK 能过）
 *   none          : 不加签名参数（让 bundletool 用自己的默认逻辑）
 *
 * key hash
 * ---------------------------------------------------------------
 * 界面要能直接看到「当前签名对应的 key hash」，用户才好拿去三方后台登记：
 *   - Facebook : base64(sha1(cert))          ← 最常用的那个
 *   - 微信/QQ  : md5(cert) 小写去冒号
 *   - Google   : sha1 大写带冒号
 * 三个一起给，省得用户再来回问。
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import { binDir, log } from './adb';
import { findJava } from './java';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type SigningMode = 'bundled-debug' | 'custom' | 'none';

export interface AabSigningConfig {
  mode: SigningMode;
  /** custom 模式下的密钥库路径 */
  keystorePath?: string;
  /** 密钥库密码（storepass） */
  storePass?: string;
  /** 私钥密码（keypass），留空表示与 storepass 相同 */
  keyPass?: string;
  /** 私钥别名，留空表示自动取密钥库里唯一那个（多个时报错让用户填） */
  keyAlias?: string;
}

export interface AabKeyHash {
  /** Facebook 用的 base64 SHA1 */
  facebook: string;
  /** 微信 / QQ 用的 MD5（小写无冒号） */
  wechat: string;
  /** Google 用的 SHA1（大写带冒号） */
  sha1: string;
  /** SHA256（部分后台要，如 Google Play App Signing） */
  sha256: string;
}

export interface AabSigningInfo {
  config: AabSigningConfig;
  /** 随包调试密钥库的绝对路径（可能不存在） */
  bundledKeystore: string;
  /** 解析出来的、当前真正要用的密钥库路径；none / 不可用时为 null */
  activeKeystore: string | null;
  /** 是否可用（配置合法且密钥库能读） */
  ok: boolean;
  /** 不可用原因 */
  reason?: string;
  /** 当前签名对应的 key hash（需要 keytool 能跑；跑不了就没有） */
  keyHash?: AabKeyHash;
  /** 密钥库里的别名（读到时回填，方便界面展示/自动填） */
  aliases?: string[];
  /** 一句话描述，直接给界面用 */
  desc: string;
}

const DEFAULT_CONFIG: AabSigningConfig = { mode: 'bundled-debug' };

const FILE_NAME = 'aab-signing.json';

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

function configFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, FILE_NAME);
}

let cached: AabSigningConfig | null = null;

export function getSigningConfig(): AabSigningConfig {
  if (cached) return cached;
  try {
    const f = configFile();
    if (existsSync(f)) {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<AabSigningConfig>;
      const mode: SigningMode =
        raw.mode === 'custom' || raw.mode === 'none' ? raw.mode : 'bundled-debug';
      cached = {
        mode,
        keystorePath: typeof raw.keystorePath === 'string' ? raw.keystorePath : undefined,
        storePass: typeof raw.storePass === 'string' ? raw.storePass : undefined,
        keyPass: typeof raw.keyPass === 'string' ? raw.keyPass : undefined,
        keyAlias: typeof raw.keyAlias === 'string' ? raw.keyAlias : undefined,
      };
      return cached;
    }
  } catch {
    /* 配置坏了就回到默认，别把用户卡住 */
  }
  cached = { ...DEFAULT_CONFIG };
  return cached;
}

export function setSigningConfig(patch: Partial<AabSigningConfig>): AabSigningConfig {
  const cur = getSigningConfig();
  const next: AabSigningConfig = {
    mode: patch.mode === 'custom' || patch.mode === 'none' ? patch.mode : patch.mode === 'bundled-debug' ? 'bundled-debug' : cur.mode,
    keystorePath: patch.keystorePath !== undefined ? patch.keystorePath : cur.keystorePath,
    storePass: patch.storePass !== undefined ? patch.storePass : cur.storePass,
    keyPass: patch.keyPass !== undefined ? patch.keyPass : cur.keyPass,
    keyAlias: patch.keyAlias !== undefined ? patch.keyAlias : cur.keyAlias,
  };
  cached = next;
  writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8');
  log('info', 'AAB', `签名方式已设为：${describeConfig(next)}`);
  return next;
}

/* ------------------------------------------------------------------ */
/* 随包调试密钥库                                                      */
/* ------------------------------------------------------------------ */

export const DEBUG_KS_FILE = 'debug.keystore';
export const DEBUG_KS_PASS = 'android';
export const DEBUG_KS_ALIAS = 'androiddebugkey';

/** 随包调试密钥库路径（bin/bundletool/debug.keystore） */
export function bundledKeystorePath(): string {
  return join(binDir(), 'bundletool', DEBUG_KS_FILE);
}

/** 用户装了 Android SDK 时系统自带的那份 */
function sdkKeystorePath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return home ? join(home, '.android', DEBUG_KS_FILE) : '';
}

/* ------------------------------------------------------------------ */
/* keytool                                                             */
/* ------------------------------------------------------------------ */

const WIN = process.platform === 'win32';
const KEYTOOL_BIN = WIN ? 'keytool.exe' : 'keytool';

let keytoolCache: string | null | undefined;

/** 清缓存（用户新装了 JDK 后点「重新检测」时用） */
export function resetKeytoolCache(): void {
  keytoolCache = undefined;
}

/**
 * 找一个可用的 keytool。
 *
 * 为什么不能只靠「java 同目录」：findJava() 在 PATH 命中时会返回**裸名**
 * （如 `java.exe`），dirname 出来是 `.`，拼不出 keytool —— 而这是最常见的
 * 情况（系统装了 JDK 并进了 PATH）。实测就撞过这个：签名参数一切正常，
 * 但 key hash 永远读不出来，用户完全不知道为什么。
 *
 * 所以就按四种来源依次探，且**逐个真跑一次**（PATH 上的裸名要 spawn 才知道）：
 *   1. 已找到的 java 同目录（JDK 布局，最理想）
 *   2. JAVA_HOME/bin
 *   3. PATH 裸名（交给 spawn 解析）
 *   4. 常见安装目录扫描
 *
 * 找不到返回 null —— 只是「读不出指纹」，不影响签名本身。
 */
async function findKeytool(): Promise<string | null> {
  if (keytoolCache !== undefined) return keytoolCache;

  const cands: string[] = [];

  /* 1. java 同目录 —— 只有拿到绝对路径才有意义 */
  const java = await findJava();
  if (java?.path && /[\\/]/.test(java.path)) {
    cands.push(join(dirname(java.path), KEYTOOL_BIN));
  }

  /* 2. JAVA_HOME */
  const home = process.env.JAVA_HOME;
  if (home) cands.push(join(home, 'bin', KEYTOOL_BIN));

  /* 3. PATH 裸名 */
  cands.push(KEYTOOL_BIN);

  /* 4. 常见安装位置 */
  const roots = WIN
    ? [
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Zulu',
        'C:\\Program Files\\Microsoft\\jdk',
        'C:\\Program Files\\Android\\Android Studio\\jbr',
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio', 'jbr'),
      ]
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const direct = join(root, 'bin', KEYTOOL_BIN);
    cands.push(direct);
    try {
      for (const d of readdirSync(root)) {
        cands.push(join(root, d, 'bin', KEYTOOL_BIN));
        cands.push(join(root, d, 'Contents', 'Home', 'bin', KEYTOOL_BIN));
      }
    } catch {
      /* ignore */
    }
  }

  for (const c of cands) {
    // 裸名不预检（交给 spawn 解析）；绝对路径先看存在
    const isBare = !/[\\/]/.test(c);
    if (!isBare && !existsSync(c)) continue;

    const r = await run(c, [KT_JVM_OPTS, '-help'], 15000);

    /*
     * 判定「这个 keytool 真的能跑」。
     *
     * 坑：spawn 失败时我们往 stderr 塞的是 Node 的错误文案
     * `spawn keytool.exe ENOENT` —— 里面**自带 "keytool" 这个词**，
     * 所以任何「输出里含 keytool 就算成功」的宽松判定都会把
     * 根本没找到的程序误判成可用（实测踩过：PATH 里没有 keytool，
     * 却一路带着一个假的路径走下去，最后报「读取密钥库失败：未知原因」）。
     *
     * 硬判据：必须以「真的跑起来」为准 —— 非负退出码，且输出里有
     * keytool 自己的用法文本（"Key and Certificate Management"）。
     */
    if (r.code < 0) continue; // spawn error / 被信号杀掉
    const text = cleanText(r.stdout + r.stderr);
    if (r.code === 0 || /Key and Certificate|密钥和证书/i.test(text)) {
      keytoolCache = c;
      return c;
    }
  }

  keytoolCache = null;
  return null;
}

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  exe: string,
  args: string[],
  timeoutMs = 30000,
): Promise<RunOut> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: (e as Error).message });
      return;
    }
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

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      done = true;
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done = true;
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 把 keytool 的输出转成可读文本。
 *
 * Windows 中文环境下 keytool 按 GBK 输出，Node 按 utf8 解会得到一堆
 * U+FFFD。**这不是「只影响无关字段」的小事** —— 别名一栏中文 JDK 打的是
 * 「别名: xxx」，乱码后连这个标签都认不出来，别名解析会静默失败。
 *
 * 解法分两层：
 *   1. **让 keytool 说 UTF-8**：所有调用都带上 `-J-Dfile.encoding=UTF-8`
 *      （见 KT_JVM_OPTS），从源头避免乱码 —— 这是主要手段；
 *   2. 万一还有残留，把替换字符换掉，至少不污染正则匹配。
 */
const KT_JVM_OPTS = '-J-Dfile.encoding=UTF-8';

function cleanText(s: string): string {
  return s.replace(/\uFFFD/g, '?');
}

/* ------------------------------------------------------------------ */
/* 密钥库探测                                                          */
/* ------------------------------------------------------------------ */

export interface KeystoreProbe {
  ok: boolean;
  /** 失败原因（可直接展示） */
  reason?: string;
  aliases: string[];
  /** 别名 → 指纹 */
  entries: { alias: string; sha1: string; sha256: string; md5: string }[];
}

/**
 * 用 keytool 探一个密钥库：能不能打开、里面有哪些别名、各是什么指纹。
 *
 * 为什么要真跑 keytool 而不是自己解析 JKS：
 * 密钥库有 JKS / PKCS12 / BKS 多种格式，密码校验与私有格式细节多，
 * 自己实现容易漏。keytool 是 JDK 自带的权威实现，直接用。
 */
export async function probeKeystore(
  path: string,
  storePass: string,
): Promise<KeystoreProbe> {
  if (!path) return { ok: false, reason: '没有指定密钥库文件', aliases: [], entries: [] };
  if (!existsSync(path)) {
    return { ok: false, reason: `密钥库文件不存在：${path}`, aliases: [], entries: [] };
  }

  const kt = await findKeytool();
  if (!kt) {
    return {
      ok: false,
      reason:
        '找不到 keytool（只有 JRE 而没有 JDK 时会出现）。' +
        '签名本身不受影响，只是无法读取证书指纹与 key hash；' +
        '想看 key hash 可以装一个完整 JDK，或用命令行 keytool 自行查看。',
      aliases: [],
      entries: [],
    };
  }

  const r = await run(kt, [
    KT_JVM_OPTS,
    '-list',
    '-v',
    '-keystore',
    path,
    '-storepass',
    storePass,
  ]);
  const text = cleanText(r.stdout + '\n' + r.stderr);

  if (r.code !== 0) {
    /*
     * 退出码为负 = 进程根本没跑起来（spawn 失败）。
     * 这时 stderr 里是 Node 的错误文案（如 `spawn keytool.exe ENOENT`），
     * 拿它当业务报错会给出「未知原因」这种没用的提示 —— 单独识别。
     */
    if (r.code < 0) {
      return {
        ok: false,
        reason: `无法运行 keytool（${firstUsefulLine(text) || path}）`,
        aliases: [],
        entries: [],
      };
    }

    // keytool 的报错里最常见的就是密码错，其余是格式/文件损坏
    const isPass = /password was incorrect|keystore password|密码/i.test(text);
    const isFormat = /Invalid keystore format|not a keystore/i.test(text);
    return {
      ok: false,
      reason: isPass
        ? '密钥库密码不对'
        : isFormat
          ? '不是有效的密钥库文件（支持 .jks / .keystore / .p12 等 Java 密钥库格式）'
          : `读取密钥库失败：${firstUsefulLine(text) || '未知原因'}`,
      aliases: [],
      entries: [],
    };
  }

  // 解析：别名行形如 "别名: pokercity"（中英 JDK 都可能是 Alias name: / 别名:）
  const aliases: string[] = [];
  const entries: KeystoreProbe['entries'] = [];

  const lines = text.split(/\r?\n/);
  let curAlias: string | null = null;
  let curSha1 = '';
  let curSha256 = '';

  const flush = () => {
    if (curAlias && curSha1) {
      entries.push({
        alias: curAlias,
        sha1: curSha1,
        sha256: curSha256,
        md5: '',
      });
    }
    curAlias = null;
    curSha1 = '';
    curSha256 = '';
  };

  for (const line of lines) {
    const t = line.trim();
    const am = t.match(/^(?:Alias name|别名)\s*[:：]\s*(.+)$/i);
    if (am) {
      flush();
      curAlias = am[1].trim();
      if (!aliases.includes(curAlias)) aliases.push(curAlias);
      continue;
    }
    const s1 = t.match(/SHA1\s*[:：]\s*([0-9A-Fa-f:]{20,})/);
    if (s1) {
      curSha1 = s1[1].toUpperCase();
      continue;
    }
    const s2 = t.match(/SHA256\s*[:：]\s*([0-9A-Fa-f:]{40,})/);
    if (s2) {
      curSha256 = s2[1].toUpperCase();
      continue;
    }
  }
  flush();

  return { ok: true, aliases, entries };
}

function firstUsefulLine(text: string): string {
  const l = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .find((x) => /error|exception|失败|错误/i.test(x));
  return l || '';
}

/* ------------------------------------------------------------------ */
/* key hash 计算                                                       */
/* ------------------------------------------------------------------ */

/**
 * 从 SHA1 十六进制算 Facebook 用的 key hash：base64(raw sha1 bytes)。
 * 微信 / QQ 用的是 md5(cert) 十六进制小写去冒号 —— 这里拿不到原始证书
 * 就用 sha1 之外的另一路：keytool 的 -exportcert 输出 DER，再用 md5。
 */
export function facebookHashFromSha1(sha1Hex: string): string {
  const hex = sha1Hex.replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length !== 40) return '';
  return Buffer.from(hex, 'hex').toString('base64');
}

/** 导出证书 DER（keytool -exportcert），用于算 MD5（微信 / QQ 要） */
async function exportCert(path: string, storePass: string, alias: string): Promise<Buffer | null> {
  const kt = await findKeytool();
  if (!kt) return null;
  const out = join(app.getPath('temp'), `aab-cert-${Date.now()}.der`);
  try {
    const r = await run(kt, [
      KT_JVM_OPTS,
      '-exportcert',
      '-keystore',
      path,
      '-storepass',
      storePass,
      '-alias',
      alias,
      '-file',
      out,
    ]);
    if (r.code !== 0 || !existsSync(out)) return null;
    return readFileSync(out);
  } finally {
    try {
      if (existsSync(out)) {
        // 临时文件，删掉失败也无所谓
        require('fs').rmSync(out, { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * 算出当前签名的全套 key hash。
 * alias 为空时，如果密钥库里只有一个条目就自动用它（绝大多数情况）。
 */
export async function computeKeyHash(
  path: string,
  storePass: string,
  alias?: string,
): Promise<{ keyHash?: AabKeyHash; reason?: string; aliases?: string[] }> {
  const probe = await probeKeystore(path, storePass);
  if (!probe.ok) return { reason: probe.reason, aliases: probe.aliases };

  let target = alias?.trim() || '';
  if (!target) {
    if (probe.entries.length === 1) target = probe.entries[0].alias;
    else if (probe.entries.length === 0) {
      return { reason: '密钥库里没有可用的私钥条目', aliases: probe.aliases };
    } else {
      return {
        reason: `密钥库里有 ${probe.entries.length} 个条目，请指定要用哪一个（别名）`,
        aliases: probe.aliases,
      };
    }
  }

  const entry = probe.entries.find((e) => e.alias === target);
  const sha1 = entry?.sha1 || '';
  const sha256 = entry?.sha256 || '';

  // 微信 / QQ 用的 MD5 需要原始证书，走一次 exportcert
  const der = await exportCert(path, storePass, target);
  let md5 = '';
  if (der) {
    md5 = require('crypto').createHash('md5').update(der).digest('hex');
  }

  return {
    aliases: probe.aliases,
    keyHash: {
      facebook: facebookHashFromSha1(sha1),
      wechat: md5,
      sha1,
      sha256,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 解析「当前生效的签名」                                               */
/* ------------------------------------------------------------------ */

/**
 * 把配置解析成 bundletool 能用的参数 + 可供界面展示的信息。
 *
 * 返回值里的 `args` 直接拼到 build-apks 命令行上。
 * 三种模式的行为：
 *   - bundled-debug：随包 keystore 存在就用它；不存在就回退系统 SDK 的；
 *                    都没有则视为不可用（宁可报错也不要产未签名 APK）
 *   - custom：必须路径/密码齐备且能打开
 *   - none：不给任何签名参数（bundletool 会尝试自己的默认逻辑，
 *           找不到 debug.keystore 时会 WARNING 并产出未签名 APK —— 界面要警告）
 */
export async function resolveSigning(
  override?: Partial<AabSigningConfig>,
  opts?: { withKeyHash?: boolean },
): Promise<{
  info: AabSigningInfo;
  args: string[];
}> {
  const cfg: AabSigningConfig = { ...getSigningConfig(), ...override };
  const bundled = bundledKeystorePath();

  const base: AabSigningInfo = {
    config: cfg,
    bundledKeystore: bundled,
    activeKeystore: null,
    ok: false,
    desc: '',
  };

  if (cfg.mode === 'none') {
    return {
      info: {
        ...base,
        ok: true,
        desc: '不使用签名（bundletool 走自己的默认逻辑；多数情况下会产出未签名 APK，仅用于排查问题）',
      },
      args: [],
    };
  }

  if (cfg.mode === 'bundled-debug') {
    const ks = existsSync(bundled) ? bundled : sdkKeystorePath();
    if (!ks || !existsSync(ks)) {
      return {
        info: {
          ...base,
          ok: false,
          reason:
            `随包调试密钥库不存在（${bundled}）。` +
            '可改用「我的密钥库」指定自己的签名文件。',
          desc: '调试密钥库缺失',
        },
        args: [],
      };
    }
    const args = [
      `--ks=${ks}`,
      `--ks-pass=pass:${DEBUG_KS_PASS}`,
      `--key-pass=pass:${DEBUG_KS_PASS}`,
      `--ks-key-alias=${DEBUG_KS_ALIAS}`,
    ];
    const info: AabSigningInfo = {
      ...base,
      activeKeystore: ks,
      ok: true,
      desc: `调试密钥库（${ks === bundled ? '随包自带' : '来自 Android SDK'}）—— 换过签名，三方登录/推送可能失效`,
    };
    if (opts?.withKeyHash) {
      const kh = await computeKeyHash(ks, DEBUG_KS_PASS, DEBUG_KS_ALIAS);
      info.keyHash = kh.keyHash;
      info.aliases = kh.aliases;
    }
    return { info, args };
  }

  /* ---- custom ---- */
  const path = (cfg.keystorePath || '').trim();
  const storePass = cfg.storePass ?? '';
  if (!path) {
    return {
      info: { ...base, ok: false, reason: '没有选择密钥库文件', desc: '未指定密钥库' },
      args: [],
    };
  }
  if (!existsSync(path)) {
    return {
      info: { ...base, ok: false, reason: `密钥库文件不存在：${path}`, desc: '密钥库文件丢失' },
      args: [],
    };
  }
  if (!storePass) {
    return {
      info: { ...base, ok: false, reason: '没有填写密钥库密码', desc: '缺少密钥库密码' },
      args: [],
    };
  }

  /*
   * 探测密钥库需要 keytool。但 keytool 只属于 JDK，用户机器上可能只有 JRE ——
   * 这时**不能把整个 custom 模式判死**：签名本身只靠 bundletool，
   * 它自己有打开密钥库的能力，密码错了它会明确报错。
   * 所以 keytool 缺席时降级放行，只跳过「别名预校验」与「key hash 展示」。
   */
  const keytoolMissing = !(await findKeytool());

  const probe = await probeKeystore(path, storePass);
  if (!probe.ok && !keytoolMissing) {
    return {
      info: {
        ...base,
        activeKeystore: path,
        ok: false,
        reason: probe.reason,
        desc: '密钥库不可用',
      },
      args: [],
    };
  }

  // 别名：用户填了就用；没填时，只有能读到库里条目才敢自动挑
  let alias = (cfg.keyAlias || '').trim();
  if (!alias && !keytoolMissing) {
    if (probe.entries.length === 1) alias = probe.entries[0].alias;
    else if (probe.entries.length > 1) {
      return {
        info: {
          ...base,
          activeKeystore: path,
          ok: false,
          reason: `密钥库里有 ${probe.entries.length} 个条目（${probe.aliases.join('、')}），请指定别名`,
          aliases: probe.aliases,
          desc: '需要指定别名',
        },
        args: [],
      };
    }
  } else if (alias && !keytoolMissing && probe.aliases.length && !probe.aliases.includes(alias)) {
    return {
      info: {
        ...base,
        activeKeystore: path,
        ok: false,
        reason: `密钥库里没有别名「${alias}」，可用的有：${probe.aliases.join('、') || '（无）'}`,
        aliases: probe.aliases,
        desc: '别名不存在',
      },
      args: [],
    };
  }

  const keyPass = (cfg.keyPass ?? '').trim() || storePass;
  const args = [
    `--ks=${path}`,
    `--ks-pass=pass:${storePass}`,
    `--key-pass=pass:${keyPass}`,
  ];
  if (alias) args.push(`--ks-key-alias=${alias}`);

  const name = path.split(/[\\/]/).pop();
  const info: AabSigningInfo = {
    ...base,
    activeKeystore: path,
    ok: true,
    aliases: probe.aliases,
    desc: `我的密钥库：${name}${alias ? `（别名 ${alias}）` : ''}`,
  };
  // keytool 缺席时说明清楚「能用但看不到指纹」，别让用户以为是坏了
  if (keytoolMissing) {
    info.reason = '未检测到 keytool（属于 JDK），无法展示 key hash；签名本身可以正常使用。';
  }
  if (opts?.withKeyHash && !keytoolMissing) {
    const kh = await computeKeyHash(path, storePass, alias);
    info.keyHash = kh.keyHash;
  }
  return { info, args };
}

/** 一句话描述配置（日志用，不含密码） */
export function describeConfig(c: AabSigningConfig): string {
  if (c.mode === 'none') return '不签名';
  if (c.mode === 'bundled-debug') return '随包调试密钥库';
  const f = (c.keystorePath || '').split(/[\\/]/).pop() || '(未指定)';
  return `自定义密钥库 ${f}${c.keyAlias ? ` / ${c.keyAlias}` : ''}`;
}

/** 暴露给界面：完整签名信息（含 key hash） */
export async function getSigningInfo(): Promise<AabSigningInfo> {
  const { info } = await resolveSigning(undefined, { withKeyHash: true });
  return info;
}
