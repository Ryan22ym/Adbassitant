import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { runAdb, ensureDevice, ensureDir, log, newId } from './adb';
import { captureScreen } from './device-ops';
import { resolveDir } from './settings';
import {
  QUICK_ACTION_MAX,
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
 */

const FILE_NAME = 'quick-actions.json';

/* ------------------------------------------------------------------ */
/* 默认配置                                                            */
/* ------------------------------------------------------------------ */

/**
 * 出厂默认：正好覆盖最常做的三件事。
 * 前两个放行内（短文案），第三个名字长，收进 ⚡ 菜单。
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
  const target = String(x.target ?? '').trim() || QUICK_TARGET_FOREGROUND;
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
    if (inlineCount > 3) a.inline = false;
  }
  return out;
}

export function listQuickActions(): QuickAction[] {
  try {
    const f = storeFile();
    if (!existsSync(f)) return [...DEFAULT_QUICK_ACTIONS];
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    return sanitize(parsed);
  } catch {
    return [...DEFAULT_QUICK_ACTIONS];
  }
}

export function saveQuickActions(list: unknown): QuickAction[] {
  const clean = sanitize(list);
  writeFileSync(storeFile(), JSON.stringify(clean, null, 2), 'utf8');
  log('success', '快捷动作', `配置已保存（${clean.filter((a) => a.enabled).length} 个启用）`);
  return clean;
}

export function resetQuickActions(): QuickAction[] {
  const def = [...DEFAULT_QUICK_ACTIONS];
  writeFileSync(storeFile(), JSON.stringify(def, null, 2), 'utf8');
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
  const fixed = (action.target || '').trim();
  if (fixed && fixed !== QUICK_TARGET_FOREGROUND) return fixed;

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
  const res = await sh(s, `pm clear ${pkg}`, 40000);
  const text = (res.stdout + ' ' + res.stderr).trim();
  if (!/Success/i.test(text)) throw new Error(text || '清除数据失败');
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
