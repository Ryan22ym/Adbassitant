import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { runAdb, ensureDevice, ensureDir, log, newId } from './adb';
import { captureScreen } from './device-ops';
import { resolveDir } from './settings';
import {
  QUICK_ACTION_MAX,
  QUICK_ACTION_INLINE_MAX,
  QUICK_TARGET_FOREGROUND,
  QUICK_ACTION_NEEDS_TARGET,
  type QuickAction,
  type QuickActionKind,
  type QuickForegroundInfo,
  type QuickRunResult,
} from '../../shared/types';

/**
 * 设备行「快捷动作」
 * ============================================================
 * 调试时反复做的就那么几件事：清数据、退到桌面再进、杀掉进程冷启动。
 * 这里把它们做成设备行上的一键按钮，配置持久化到本机：
 *   - 增删改、排序、自定义 shell 命令
 *   - 作用对象默认取「当前前台应用」，也可以钉死某个包名
 *
 * 存储位置：<userData>/quick-actions.json
 *
 * 🔴 存储格式在 v1.1.19 从「裸数组」升级为 `{ version, actions }`。
 *    升级的原因不是洁癖：新增的「初始化启动」必须能**补进已有配置**一次，
 *    而裸数组没有地方放「已经补过了」这个标记 —— 不记标记就会变成
 *    「用户删掉它，下次启动又自己长回来」。旧数组格式仍然可以读（按 v1 处理）。
 */

const FILE_NAME = 'quick-actions.json';

/** 存储格式版本：1 = 裸数组；2 = { version, actions } */
const STORE_VERSION = 2;

/* ------------------------------------------------------------------ */
/* 默认配置                                                            */
/* ------------------------------------------------------------------ */

/** 「初始化启动」的出厂定义（默认配置和旧配置迁移共用同一份） */
const INIT_LAUNCH_ACTION: QuickAction = {
  id: 'qa-init-launch',
  label: '初始化启动',
  kind: 'initLaunch',
  target: QUICK_TARGET_FOREGROUND,
  inline: true,
  confirm: true,
  tone: 'danger',
  enabled: true,
};

/**
 * 出厂默认：正好铺满设备行上的四个直显位置（v1.1.19 起上限是 4）。
 * 顺序就是常用的先后：清数据 → 初始化启动 → 桌面重进 → 杀进程重进。
 */
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'qa-clear-data',
    label: '清数据',
    kind: 'clearData',
    target: QUICK_TARGET_FOREGROUND,
    inline: true,
    confirm: true,
    tone: 'danger',
    enabled: true,
  },
  { ...INIT_LAUNCH_ACTION },
  {
    id: 'qa-home-return',
    label: '桌面重进',
    kind: 'homeReturn',
    target: QUICK_TARGET_FOREGROUND,
    inline: true,
    tone: 'default',
    enabled: true,
  },
  {
    id: 'qa-restart',
    label: '杀进程重进',
    kind: 'restart',
    target: QUICK_TARGET_FOREGROUND,
    inline: true,
    tone: 'default',
    enabled: true,
  },
];

const VALID_KINDS = new Set<string>(Object.keys(QUICK_ACTION_NEEDS_TARGET));

/* ------------------------------------------------------------------ */
/* 配置读写                                                            */
/* ------------------------------------------------------------------ */

function storeFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, FILE_NAME);
}

/** 把外部数据（磁盘 / 渲染层传入）归一化成可信的 QuickAction */
function normalize(raw: unknown): QuickAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Record<string, unknown>;
  const kind = String(x.kind || '') as QuickActionKind;
  if (!VALID_KINDS.has(kind)) return null;

  const label = String(x.label ?? '').trim();
  if (!label) return null;

  const id = String(x.id || '').trim() || newId();
  /*
   * target 的语义（v1.1.6 起把「空」和「前台」分开）：
   *   'foreground' / 缺省 → 当前前台应用
   *   ''                  → 选了「指定包名」但包名还没填（界面正在输入）
   *   其它                → 固定包名
   *
   * 以前写成 `String(x.target ?? '').trim() || QUICK_TARGET_FOREGROUND`，
   * 空串被强行掰成前台应用 —— 于是界面上「指定包名」选完即失效，
   * 存下去配置里也永远只有前台应用，这个功能等于没做。
   */
  const rawTarget = x.target;
  const target = typeof rawTarget === 'string' ? rawTarget.trim() : QUICK_TARGET_FOREGROUND;
  const command = typeof x.command === 'string' ? x.command : undefined;
  const tone = x.tone === 'primary' || x.tone === 'danger' ? x.tone : 'default';

  return {
    id,
    label: label.slice(0, 12),
    kind,
    target,
    command,
    inline: x.inline === true,
    confirm: x.confirm === true,
    tone,
    enabled: x.enabled !== false,
  };
}

/** 上盘前做一次清洗：非法项丢弃、总数与行内数量封顶 */
export function sanitize(list: unknown): QuickAction[] {
  if (!Array.isArray(list)) return [...DEFAULT_QUICK_ACTIONS];

  const out: QuickAction[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const a = normalize(item);
    if (!a) continue;
    // 同 id 重复只保留第一条，否则 React key 会撞
    if (seen.has(a.id)) a.id = newId();
    seen.add(a.id);
    out.push(a);
    if (out.length >= QUICK_ACTION_MAX) break;
  }
  if (out.length === 0) return [...DEFAULT_QUICK_ACTIONS];

  // 行内直显封顶（设备行宽度有限，超出的自动降级进菜单）
  let inlineCount = 0;
  for (const a of out) {
    if (!a.inline) continue;
    inlineCount += 1;
    if (inlineCount > QUICK_ACTION_INLINE_MAX) a.inline = false;
  }
  return out;
}

/** 按当前格式把动作写盘 */
function writeStore(list: QuickAction[]): void {
  writeFileSync(
    storeFile(),
    JSON.stringify({ version: STORE_VERSION, actions: list }, null, 2),
    'utf8',
  );
}

/** 读盘：兼容 v1 的裸数组，缺失 / 损坏时 actions 为 null（调用方回落出厂默认） */
function readStore(): { version: number; actions: unknown } {
  try {
    const f = storeFile();
    if (!existsSync(f)) return { version: STORE_VERSION, actions: null };
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    // v1：整份就是动作数组
    if (Array.isArray(parsed)) return { version: 1, actions: parsed };
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).actions)) {
      const v = Number((parsed as any).version);
      return { version: Number.isFinite(v) ? v : 1, actions: (parsed as any).actions };
    }
  } catch {
    /* 坏 JSON 与「没有配置」同样处理 */
  }
  return { version: STORE_VERSION, actions: null };
}

/**
 * v1 → v2：把「初始化启动」补进已有配置，紧跟在「清数据」后面。
 *
 * 只在**读盘时发现文件是旧格式**才做，做完立刻按新格式写回 ——
 * 之后用户删掉它就不会再长回来（这正是需要 STORE_VERSION 的原因）。
 */
function migrateToV2(list: QuickAction[]): QuickAction[] {
  if (list.some((a) => a.kind === 'initLaunch')) return list;

  const out = [...list];
  const at = out.findIndex((a) => a.kind === 'clearData');
  const inlineCount = out.filter((a) => a.inline).length;
  const added: QuickAction = {
    ...INIT_LAUNCH_ACTION,
    // 行内位置已经满了就让它进 ⚡ 菜单，别把别人的直显挤掉
    inline: inlineCount < QUICK_ACTION_INLINE_MAX,
  };
  out.splice(at >= 0 ? at + 1 : 0, 0, added);
  return out.slice(0, QUICK_ACTION_MAX);
}

export function listQuickActions(): QuickAction[] {
  const stored = readStore();
  if (stored.actions === null) return [...DEFAULT_QUICK_ACTIONS];

  let list = sanitize(stored.actions);
  if (stored.version < STORE_VERSION) {
    list = migrateToV2(list);
    try {
      writeStore(list);
      log('info', '快捷动作', '已把「初始化启动」补进快捷动作配置（配置文件升到 v2）');
    } catch (e) {
      // 写不进去不影响本次使用，下次启动还会再补一次
      log('warn', '快捷动作', `快捷动作配置升级失败：${(e as Error).message}`);
    }
  }
  return list;
}

export function saveQuickActions(list: unknown): QuickAction[] {
  const clean = sanitize(list);
  writeStore(clean);
  log('success', '快捷动作', `配置已保存（${clean.filter((a) => a.enabled).length} 个启用）`);
  return clean;
}

export function resetQuickActions(): QuickAction[] {
  const def = [...DEFAULT_QUICK_ACTIONS];
  writeStore(def);
  log('info', '快捷动作', '已恢复默认配置');
  return def;
}

/* ------------------------------------------------------------------ */
/* 前台应用探测                                                        */
/* ------------------------------------------------------------------ */

/**
 * 用 grep 在设备端先过滤，避免把几 MB 的 dumpsys 输出搬到电脑上。
 * 全程不使用引号 —— Windows 下 spawn 传参时引号会被转义，命令到设备端就废了。
 */
const FOCUS_CMDS = [
  'dumpsys window | grep -e mCurrentFocus -e mFocusedApp',
  'dumpsys activity activities | grep -e mResumedActivity -e topResumedActivity',
  'dumpsys window',
];

/** 包名/Activity 的通用形状，如 com.foo.bar/.MainActivity */
const PKG_RE = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/;

/** 系统层 UI（通知栏 / 权限弹窗 / 桌面）不算「用户正在看的应用」 */
const SYS_UI_RE =
  /^(com\.android\.systemui|com\.android\.permissioncontroller|com\.android\.settings\.intentresolver|android)$/i;

/** 桌面：包名最后一段是 launcher / home 之类 */
const LAUNCHER_TAIL = new Set([
  'launcher',
  'launcher3',
  'nexuslauncher',
  'trebuchet',
  'home',
  'lawnchair',
  'nova',
  'apex',
]);

export function isLauncherPackage(pkg?: string): boolean {
  if (!pkg) return false;
  const seg = pkg.toLowerCase().split('.');
  const tail = seg[seg.length - 1] || '';
  if (LAUNCHER_TAIL.has(tail)) return true;
  return /launcher\d*$/i.test(tail);
}

/** 从 dumpsys 文本里挑出前台包名（优先 mCurrentFocus 行） */
export function parseForegroundLine(text: string): { packageName?: string; activity?: string } {
  const lines = text.split(/\r?\n/);
  const priority = [
    /mCurrentFocus/i,
    /mFocusedApp/i,
    /topResumedActivity/i,
    /mResumedActivity/i,
  ];
  for (const re of priority) {
    for (const line of lines) {
      if (!re.test(line)) continue;
      const m = line.match(PKG_RE);
      if (m) return { packageName: m[1], activity: m[2] };
    }
  }
  // 兜底：随便挑一个带包名/Activity 形状的
  const m = text.match(PKG_RE);
  return m ? { packageName: m[1], activity: m[2] } : {};
}

/** 每台设备最近一次「真正的应用」（非桌面 / 非系统 UI），当前台是桌面时当回退目标 */
const lastAppBySerial = new Map<string, string>();

export function rememberLastApp(serial: string, pkg?: string) {
  if (!pkg || isLauncherPackage(pkg) || SYS_UI_RE.test(pkg)) return;
  lastAppBySerial.set(serial, pkg);
}

export function lastAppOf(serial: string): string | undefined {
  return lastAppBySerial.get(serial);
}

/**
 * 探测当前前台应用。
 * 拿不到时返回空对象（不抛错）—— 上层据此提示用户而不是报错。
 */
export async function foregroundApp(serial?: string): Promise<QuickForegroundInfo> {
  const s = await ensureDevice(serial);
  let text = '';
  for (const cmd of FOCUS_CMDS) {
    const res = await runAdb(['-s', s, 'shell', cmd], {
      source: '快捷动作',
      silent: true,
      timeout: 15000,
    });
    if (res.stdout && PKG_RE.test(res.stdout)) {
      text = res.stdout;
      break;
    }
  }

  const { packageName, activity } = parseForegroundLine(text);
  if (packageName) rememberLastApp(s, packageName);

  const info: QuickForegroundInfo = {
    serial: s,
    packageName,
    activity,
    isLauncher: isLauncherPackage(packageName) || (!!packageName && SYS_UI_RE.test(packageName)),
    lastApp: lastAppBySerial.get(s),
  };
  return info;
}

/**
 * 解析动作真正作用的包名。
 * 钉死包名的直接用；取「当前前台」时若前台是桌面，回退到最近一次的应用并记日志。
 */
async function resolveTargetPackage(s: string, action: QuickAction): Promise<string> {
  const t = (action.target ?? '').trim();
  // 选了「指定包名」却空着：给一句能照着做的提示，别等到 adb 报一堆用法
  if (!t) {
    throw new Error(
      `「${action.label}」选了「指定包名」，但包名是空的 —— 打开「配置快捷动作」填上，或改成「当前前台应用」`,
    );
  }
  if (t !== QUICK_TARGET_FOREGROUND) return t;

  const info = await foregroundApp(s);
  if (info.packageName && !info.isLauncher) return info.packageName;

  if (info.lastApp) {
    log(
      'warn',
      '快捷动作',
      `当前前台是桌面，改用最近一次的应用 ${info.lastApp}`,
    );
    return info.lastApp;
  }
  throw new Error('当前前台不是应用（可能是桌面），请在配置里把目标改成固定包名');
}

/* ------------------------------------------------------------------ */
/* 原子操作                                                            */
/* ------------------------------------------------------------------ */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sh(s: string, cmd: string, timeout = 30000) {
  return runAdb(['-s', s, 'shell', cmd], { source: '快捷动作', timeout });
}

/** pm clear 的输出必须以 Success 开头才算真的清掉 */
async function clearData(s: string, pkg: string) {
  /*
   * 先停再清。Android 10+ 对「正在前台 / 持有前台服务」的应用有进程保护，
   * 边跑边清经常是「返回了但没清干净」；先把进程停掉还能顺带规避一部分占用。
   * 停不掉不算错（有些应用本来就拉不起来），所以这里吞掉异常。
   */
  await forceStop(s, pkg).catch(() => {});

  const res = await sh(s, `pm clear ${pkg}`, 40000);
  const text = (res.stdout + ' ' + res.stderr).trim();
  if (/Success/i.test(text)) return;

  /*
   * 国产 ROM（实测 OPPO / ColorOS + Android 13，一加 / realme 同类）会把调试账号
   * (uid 2000 shell) 的 CLEAR_APP_USER_DATA 权限收走：
   *   java.lang.SecurityException: PID xxxx does not have permission
   *   android.permission.CLEAR_APP_USER_DATA to clear data of package ...
   * 这是设备侧策略，**没有免 root 的通用绕过**（cmd package clear / pm clear --user 0
   * 走的是同一条权限检查，实测同样失败；同一台机器上换包名也一样报，所以不是某个应用的问题）。
   * 唯一可行的解法是用户在开发者选项里放开权限监控 —— 直接把这句话给用户，
   * 别把一坨 Java 堆栈原样抛到界面上让他猜。
   */
  if (/CLEAR_APP_USER_DATA/i.test(text)) {
    throw new Error(
      '这台手机的系统策略禁止了调试账号清除应用数据（常见于 OPPO / 一加 / realme）。' +
        '手机进入「设置 → 关于手机」，连点「版本号」7 次打开开发者模式，' +
        '再到「开发者选项」中打开「禁止权限监控」，然后回来重试即可。',
    );
  }

  throw new Error(text || '清除数据失败');
}

async function forceStop(s: string, pkg: string) {
  const res = await sh(s, `am force-stop ${pkg}`, 20000);
  const text = (res.stdout + ' ' + res.stderr).trim();
  if (/Error|Exception|not found/i.test(text)) throw new Error(text);
}

/** monkey 单事件启动最通用：不用预先知道 launcher activity */
async function launch(s: string, pkg: string) {
  const res = await sh(
    s,
    `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
    20000,
  );
  const text = (res.stdout + ' ' + res.stderr).trim();
  if (/No activities found|monkey aborted|Error:/i.test(text)) {
    throw new Error('该应用没有可启动的桌面入口');
  }
}

async function keyevent(s: string, code: number) {
  await sh(s, `input keyevent ${code}`, 15000);
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

/**
 * 执行一个快捷动作。
 * 抛错即失败，UI 侧统一弹 toast；成功返回执行步骤便于展示「到底做了什么」。
 */
export async function runQuickAction(
  serial: string | undefined,
  action: QuickAction,
): Promise<QuickRunResult> {
  const a = normalize(action);
  if (!a) throw new Error('动作配置不合法');
  if (!a.enabled) throw new Error(`「${a.label}」已停用`);

  const s = await ensureDevice(serial);
  const steps: string[] = [];
  let pkg: string | undefined;

  if (QUICK_ACTION_NEEDS_TARGET[a.kind]) {
    pkg = await resolveTargetPackage(s, a);
    steps.push(`目标应用 ${pkg}`);
  }

  switch (a.kind) {
    case 'clearData':
      await clearData(s, pkg!);
      steps.push('数据已清除');
      break;

    case 'homeReturn':
      // 不杀进程：退到桌面再唤起，走热启动
      await keyevent(s, 3);
      steps.push('回到桌面');
      await wait(400);
      await launch(s, pkg!);
      steps.push('重新进入应用');
      break;

    case 'restart':
      // 冷启动：先结束进程再拉起
      await forceStop(s, pkg!);
      steps.push('进程已结束');
      await wait(600);
      await launch(s, pkg!);
      steps.push('重新启动');
      break;

    case 'restartFresh':
      await clearData(s, pkg!);
      steps.push('数据已清除');
      await wait(400);
      await launch(s, pkg!);
      steps.push('重新启动');
      break;

    /*
     * 初始化启动（v1.1.19）：清数据 → 显式杀进程 → 冷启动。
     * 比 restartFresh 多一步「确认进程真的没了 + 等一下让系统回收」——
     * 国产 ROM 上 pm clear 之后前台服务 / 通知栏经常还挂着，
     * 直接拉起会拿到一个半死不活的旧进程，看起来就像「数据没清干净」。
     */
    case 'initLaunch':
      await clearData(s, pkg!);
      steps.push('数据已清除');
      await forceStop(s, pkg!).catch(() => {
        /* 进程本来就不在了，不算失败 */
      });
      steps.push('进程已结束');
      await wait(900);
      await launch(s, pkg!);
      steps.push('重新进入应用');
      break;

    case 'forceStop':
      await forceStop(s, pkg!);
      steps.push('进程已结束');
      break;

    case 'launch':
      await launch(s, pkg!);
      steps.push('已唤起');
      break;

    case 'screenshot': {
      const dir = resolveDir('screenshot');
      ensureDir(dir);
      const r = await captureScreen(s, dir);
      steps.push(`已截图 ${r.localPath}`);
      break;
    }

    case 'home':
      await keyevent(s, 3);
      steps.push('已回桌面');
      break;

    case 'back':
      await keyevent(s, 4);
      steps.push('已返回');
      break;

    case 'wake':
      await keyevent(s, 224);
      steps.push('已点亮屏幕');
      break;

    case 'sleep':
      await keyevent(s, 223);
      steps.push('已息屏');
      break;

    case 'shell': {
      const tpl = (a.command || '').trim();
      if (!tpl) throw new Error('自定义命令为空，请在配置里填写');
      const cmd = tpl.replace(/\{pkg\}/g, pkg || '').replace(/\{serial\}/g, s).trim();
      if (!cmd) throw new Error('自定义命令为空，请在配置里填写');
      const res = await sh(s, cmd, 60000);
      const text = (res.stdout + ' ' + res.stderr).trim();
      steps.push(`$ ${cmd}`);
      if (/^(error|exception|failure)/im.test(text) || /Error:|Exception:/i.test(text)) {
        throw new Error(text);
      }
      break;
    }
  }

  log('success', '快捷动作', `${a.label}${pkg ? ` · ${pkg}` : ''}（${s}）`, steps.join(' → '));
  return { id: a.id, label: a.label, packageName: pkg, steps };
}
