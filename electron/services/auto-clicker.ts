import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { runAdb, ensureDevice, newId, log, ensureDir } from './adb';
import { getSettings, resolveDir } from './settings';
import { captureScreen } from './device-ops';
import type {
  ClickerScript,
  ClickerStep,
  ClickerStepKind,
  ClickerStatus,
  ClickerProgress,
  ClickerRecordMeta,
  RecordedSession,
} from '../../shared/types';
import { CLICKER_STEP_LABEL } from '../../shared/types';

/**
 * 自动连点器服务
 * ============================================================
 *
 * 两块职责，刻意分开：
 *
 *   1. **脚本仓库**（持久化 + 增删改查）：全在 <userData>/clicker-scripts.json。
 *   2. **回放引擎**（把 ClickerStep[] 变成真实 adb 输入）。
 *
 * ## 坐标：全程用归一化比例
 *
 * 步骤里存的是 0~1 的比例（`nx`/`ny`），执行时才乘上设备的真实分辨率。
 * 这是刻意的 —— 录制时的屏幕、回放时可能换了台设备、分辨率也可能不同，
 * 只有比例是两边都认的。见 [resolvePx]。
 *
 * ## 「模拟真实点击」= 随机偏移
 *
 * 每次点击前在 [0, jitterPx) 内随机偏移 x/y（[jitter]）。
 * 目的不是"看起来自然"，而是**规避机械点击检测** ——
 * 很多游戏/风控会把「每次都在同一像素点」当成脚本特征。
 * 偏移量是**半径**语义：实际落点分散在一个 jitterPx×jitterPx 的方块里。
 *
 * ## 倍速只缩时间，不缩动作时长
 *
 * [scaled] 只作用于 `wait` 步骤与步骤间隙；**长按/滑动的持续时长不缩放**。
 * 理由：把「长按 500ms」缩成 250ms 就不再是长按了（很多长按判定有阈值），
 * 滑块也同理 —— 倍速的语义应该是"操作之间等多久"，而不是"改动作本身"。
 * 这一点与主流连点器（如 Auto Clicker 类工具）的惯例一致，也是唯一不会
 * 让脚本语义失真的选择。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 连击时两次点击之间的间隔 */
const CLICK_GAP_MS = 60;

/** 步骤之间插入的最小间隙，避免 adb 命令背靠背导致事件被丢 */
const STEP_GAP_MS = 120;

/** 单个 adb 命令的超时 */
const CMD_TIMEOUT_MS = 20_000;

/** 默认的 keycode 选项（界面下拉用；用户仍可手填任意数字） */
export const CLICKER_KEYCODES: { code: number; label: string }[] = [
  { code: 3, label: 'HOME（回桌面）' },
  { code: 4, label: 'BACK（返回）' },
  { code: 187, label: 'APP_SWITCH（最近任务）' },
  { code: 26, label: 'POWER（电源）' },
  { code: 223, label: 'SLEEP（息屏）' },
  { code: 224, label: 'WAKEUP（亮屏）' },
  { code: 19, label: 'DPAD_UP（上）' },
  { code: 20, label: 'DPAD_DOWN（下）' },
  { code: 21, label: 'DPAD_LEFT（左）' },
  { code: 22, label: 'DPAD_RIGHT（右）' },
  { code: 23, label: 'DPAD_CENTER（确认）' },
  { code: 24, label: 'VOLUME_UP（音量+）' },
  { code: 25, label: 'VOLUME_DOWN（音量-）' },
  { code: 66, label: 'ENTER（回车）' },
  { code: 67, label: 'DEL（删除）' },
  { code: 82, label: 'MENU（菜单）' },
  { code: 85, label: 'MEDIA_PLAY_PAUSE（播放/暂停）' },
  { code: 86, label: 'MEDIA_STOP（停止）' },
  { code: 87, label: 'MEDIA_NEXT（下一首）' },
  { code: 88, label: 'MEDIA_PREVIOUS（上一首）' },
  { code: 122, label: 'MEDIA_PLAY（播放）' },
  { code: 123, label: 'MEDIA_PAUSE（暂停）' },
];

/* ------------------------------------------------------------------ */
/* 脚本仓库                                                            */
/* ------------------------------------------------------------------ */

function storeFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'clicker-scripts.json');
}

const STEP_KINDS: ClickerStepKind[] = [
  'tap', 'longPress', 'swipe', 'key', 'wait', 'screenshot', 'shell', 'launch', 'note',
];

/**
 * 清洗外部数据。
 *
 * 两个调用方都会经过这里：读磁盘、以及渲染层传进来的新脚本。
 * 后者是必须的 —— IPC 传进来的东西不能信（界面 bug 或手改的 JSON
 * 都可能塞进来一堆乱七八糟的值，直接拿去拼 adb 命令是危险的）。
 */
function sanitizeScript(raw: unknown): ClickerScript | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : '未命名脚本';
  const stepsRaw = Array.isArray(o.steps) ? o.steps : [];
  const steps: ClickerStep[] = [];
  for (const s of stepsRaw) {
    const st = sanitizeStep(s);
    if (st) steps.push(st);
  }
  if (steps.length === 0) return null;

  const now = new Date().toISOString();
  const meta = sanitizeMeta(o.recordedMeta);

  return {
    id: typeof o.id === 'string' && o.id ? o.id : newId(),
    name,
    steps,
    loop: clampInt(o.loop, 0, 0, 100000, 1),
    speed: clampNum(o.speed, 1, 0.1, 10),
    jitterPx: clampNum(o.jitterPx, 6, 0, 200),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : now,
    updatedAt: now,
    source: o.source === 'record' ? 'record' : 'manual',
    ...(meta ? { recordedMeta: meta } : {}),
  };
}

function sanitizeMeta(raw: unknown): ClickerRecordMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const width = Number(o.width);
  const height = Number(o.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return {
    width: Math.round(width),
    height: Math.round(height),
    density: Number.isFinite(Number(o.density)) ? Math.round(Number(o.density)) : 0,
    landscape: !!o.landscape,
  };
}

function sanitizeStep(raw: unknown): ClickerStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind as ClickerStepKind;
  if (!STEP_KINDS.includes(kind)) return null;

  switch (kind) {
    case 'tap':
      return {
        kind: 'tap',
        nx: clampNum(o.nx, 0.5, 0, 1),
        ny: clampNum(o.ny, 0.5, 0, 1),
        count: clampInt(o.count, 1, 1, 100, 1),
      };
    case 'longPress':
      return {
        kind: 'longPress',
        nx: clampNum(o.nx, 0.5, 0, 1),
        ny: clampNum(o.ny, 0.5, 0, 1),
        // 上限 60s：再长就该用 shell + sleep 了，而且卡在那儿没意义
        ms: clampInt(o.ms, 800, 50, 60000, 800),
      };
    case 'swipe':
      return {
        kind: 'swipe',
        nx1: clampNum(o.nx1, 0.5, 0, 1),
        ny1: clampNum(o.ny1, 0.5, 0, 1),
        nx2: clampNum(o.nx2, 0.5, 0, 1),
        ny2: clampNum(o.ny2, 0.5, 0, 1),
        durationMs: clampInt(o.durationMs, 300, 10, 60000, 300),
      };
    case 'key':
      return { kind: 'key', code: clampInt(o.code, 3, 0, 100000, 3) };
    case 'wait':
      // 上限 10 分钟：更长的等待应该用 shell sleep，否则会占着 JS 定时器
      return { kind: 'wait', ms: clampInt(o.ms, 1000, 0, 600000, 1000) };
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'shell': {
      const cmd = typeof o.cmd === 'string' ? o.cmd.trim() : '';
      if (!cmd) return null;
      return { kind: 'shell', cmd };
    }
    case 'launch': {
      const pkg = typeof o.pkg === 'string' ? o.pkg.trim() : '';
      if (!pkg || !/^[A-Za-z0-9_.]+$/.test(pkg)) return null;
      return { kind: 'launch', pkg };
    }
    case 'note':
      return { kind: 'note', text: typeof o.text === 'string' ? o.text.slice(0, 200) : '' };
    default:
      return null;
  }
}

function clampNum(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v: unknown, dflt: number, min: number, max: number, _unused = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.round(Math.min(max, Math.max(min, n)));
}

export function listScripts(): ClickerScript[] {
  const file = storeFile();
  try {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeScript).filter((s): s is ClickerScript => !!s);
  } catch (e) {
    log('warn', '连点器', `读取脚本失败：${(e as Error).message}`);
    return [];
  }
}

function writeAll(list: ClickerScript[]) {
  writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf8');
}

/**
 * 保存（新建或更新），返回**保存后的那份脚本**与最新列表。
 *
 * 按 id 判定：有 id 且已存在就是更新，否则新建。
 * 这样界面上「保存」一个按钮就能同时覆盖两种意图，不用分成两个入口。
 *
 * 为什么要把保存后的脚本一起回传，而不是只给列表：
 * 新建时 id 是后端生成的，界面拿不到 —— 只能靠「名字 + 步数」去列表里猜，
 * 猜错了（同名脚本、或者步数刚好一样）就会把后续的编辑写到错误的记录上。
 * 直接把权威结果回给界面，这类猜测就整个消失了。
 *
 * `created` 告诉调用方这次是新建还是覆盖，界面据此决定提示文案。
 */
export function saveScript(raw: unknown): { script: ClickerScript; list: ClickerScript[]; created: boolean } {
  const clean = sanitizeScript(raw);
  if (!clean) throw new Error('脚本内容无效（至少要有一个有效步骤）');

  const list = listScripts();
  const idx = list.findIndex((s) => s.id === clean.id);
  const created = idx < 0;
  let saved: ClickerScript;
  if (idx >= 0) {
    // 保留原创建时间，只更新修改时间
    saved = { ...clean, createdAt: list[idx].createdAt };
    list[idx] = saved;
  } else {
    saved = clean;
    list.push(saved);
  }
  writeAll(list);
  log(
    'success',
    '连点器',
    `${created ? '新建' : '更新'}脚本「${saved.name}」（${saved.steps.length} 步）`,
  );
  return { script: saved, list, created };
}

export function deleteScript(id: string): ClickerScript[] {
  const list = listScripts().filter((s) => s.id !== id);
  writeAll(list);
  return list;
}

export function resetScripts(): ClickerScript[] {
  writeAll([]);
  return [];
}

/* ------------------------------------------------------------------ */
/* 录制数据 → 脚本                                                     */
/* ------------------------------------------------------------------ */

/**
 * 把采集端录到的原始事件转成脚本步骤。
 *
 * ## 为什么不能「一个触摸事件 = 一个步骤」
 *
 * 手指按下会连续产生几十上百个 `move`（每秒 60+）。原样转成步骤，
 * 一个简单滑动就会变成 200 个步骤，既没法看也没法执行。
 * 所以必须**归并**：
 *
 *   · `down` → 记住起点与时间
 *   · `move` → 只更新「当前点」与「是否移动过阈值」
 *   · `up`   → 此时才知道这是「点击」还是「滑动」，产出**一个**步骤
 *
 * ## 点击 / 长按 / 滑动 的判定
 *
 * | 条件                                    | 判定     |
 * |-----------------------------------------|----------|
 * | 位移 **超过** [MOVE_THRESHOLD]（比例）     | 滑动     |
 * | 位移在阈值内 & 时长 >= [LONG_PRESS_MS]     | 长按     |
 * | 位移在阈值内 & 时长 <  [LONG_PRESS_MS]     | 点击     |
 *
 * 阈值用**归一化比例**（0.02 ≈ 屏幕宽度的 2%），这样换分辨率也成立。
 * 「恰好等于阈值」算未移动 —— 见 [didMove] 里关于浮点边界的说明。
 *
 * ## 步骤之间的等待
 *
 * 两个动作之间的真实间隔（`t` 差值）会转成一个 `wait` 步骤 ——
 * 这是录制的价值所在（保留了操作节奏）。但太短的间隔不值得生成步骤
 * （[MIN_WAIT_MS]），太长的（比如用户中途去倒了杯水）会被截断到
 * [MAX_WAIT_MS]，免得回放时在那儿干等。
 *
 * ## 系统事件
 *
 * 转成 `note` 步骤插在时间线上的对应位置 —— 不执行，只在步骤列表里起分节作用
 * （「这里跳到了设置页」），方便定位失败点。
 */
const MOVE_THRESHOLD = 0.02;
const LONG_PRESS_MS = 450;
const MIN_WAIT_MS = 80;
const MAX_WAIT_MS = 10_000;

/**
 * 判断「手指是否真的移动过」。
 *
 * ## 为什么不能直接写 `Math.abs(dx) > MOVE_THRESHOLD`
 *
 * 归一化坐标是浮点数，而 IEEE754 的减法在这里会咬人：
 *
 *   0.52 - 0.50 === 0.020000000000000018   →  `> 0.02` 为 **true**
 *
 * 也就是说，一个**恰好**移动了 2% 屏幕宽度的手势，会被判成"滑动"。
 * 这不是理论问题：录制端把坐标 round 到 4 位小数，落点**正好压在阈值上**
 * 是很常见的情形；而一旦压线，判定结果就会在 tap / longPress / swipe
 * 之间随机翻转 —— 同一段录制转两次可能给出不同的脚本，用户完全无法理解。
 *
 * 修法：留一个远小于坐标精度的容差（1e-6 ≈ 0.0001% 屏宽，人眼与触摸屏
 * 都远不到这个量级），并且用 `>` 之外再显式表达"达到阈值即视为未移动"的语义。
 * 这样 0.52 vs 0.50 稳定判为"没动"，0.53 vs 0.50 稳定判为"动了"。
 */
function didMove(dx: number, dy: number): boolean {
  const EPS = 1e-6;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // 两个方向都要超过阈值 + 容差才算移动（任一方向超了就够）
  return ax > MOVE_THRESHOLD + EPS || ay > MOVE_THRESHOLD + EPS;
}

export function sessionToSteps(session: RecordedSession): ClickerStep[] {
  const steps: ClickerStep[] = [];
  const touches = [...(session.touches || [])].sort((a, b) => a.t - b.t);
  const sysEvents = [...(session.sysEvents || [])].sort((a, b) => a.t - b.t);

  /** 上一步动作结束的时间点，用于生成 wait */
  let lastT = touches.length ? touches[0].t : 0;
  let sysIdx = 0;

  // 在两个动作之间插入 note（系统事件）
  const flushNotesBefore = (t: number) => {
    while (sysIdx < sysEvents.length && sysEvents[sysIdx].t <= t) {
      const e = sysEvents[sysIdx];
      sysIdx += 1;
      // 只保留有信息量的事件；no_permission / unavailable 这类是环境说明，
      // 放在脚本里没有意义（回放时不会重现），丢掉
      if (e.kind !== 'foreground' && e.kind !== 'launched') continue;
      const text = e.label || (e.pkg ? `切换到 ${e.pkg}` : '');
      if (text) steps.push({ kind: 'note', text });
    }
  };

  /** 把真实间隔转成 wait 步骤 */
  const pushWait = (from: number, to: number) => {
    const gap = to - from;
    if (gap < MIN_WAIT_MS) return;
    steps.push({ kind: 'wait', ms: Math.min(MAX_WAIT_MS, Math.round(gap)) });
  };

  let i = 0;
  while (i < touches.length) {
    const e = touches[i];
    if (e.type !== 'down') { i += 1; continue; }

    const startX = e.nx;
    const startY = e.ny;
    const startT = e.t;

    // 收集这一个手势的所有点，直到 up（或数据结束）
    let lastX = startX;
    let lastY = startY;
    let lastTouchT = startT;
    let moved = false;
    let j = i + 1;
    let sawUp = false;
    while (j < touches.length) {
      const n = touches[j];
      if (n.type === 'down') break;            // 下一根手指，收尾当前这段
      lastX = n.nx;
      lastY = n.ny;
      lastTouchT = n.t;
      if (didMove(n.nx - startX, n.ny - startY)) {
        moved = true;
      }
      if (n.type === 'up') { sawUp = true; j += 1; break; }
      j += 1;
    }

    // 先补上「上一个动作到这个动作之间」的系统事件与等待
    flushNotesBefore(startT);
    pushWait(lastT, startT);

    const duration = lastTouchT - startT;

    if (moved) {
      steps.push({
        kind: 'swipe',
        nx1: round4(startX), ny1: round4(startY),
        nx2: round4(lastX), ny2: round4(lastY),
        // 下限 100ms：录到的滑动经常只有几十 ms（快速一划），
        // 但 adb input swipe 太快会被系统当成 fling 而不是拖拽
        durationMs: Math.max(100, Math.round(duration)),
      });
    } else if (sawUp && duration >= LONG_PRESS_MS) {
      steps.push({ kind: 'longPress', nx: round4(startX), ny: round4(startY), ms: Math.round(duration) });
    } else {
      steps.push({ kind: 'tap', nx: round4(startX), ny: round4(startY), count: 1 });
    }

    /*
     * 推进到下一个手势。
     *
     * `lastT` 用 `lastTouchT`（本手势最后一个采样点的时间），**不看 sawUp**：
     * 数据被截断时 lastTouchT 就是最后一个 move 的时间，用它算间隔仍然成立
     * （比起 startT，它更接近用户真实松开手的时刻）。
     */
    lastT = lastTouchT;
    i = j;
  }

  // 尾巴上剩余的系统事件也补进去
  flushNotesBefore(Number.MAX_SAFE_INTEGER);

  return steps;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/* ------------------------------------------------------------------ */
/* 回放引擎                                                            */
/* ------------------------------------------------------------------ */

interface RunState {
  script: ClickerScript;
  serial: string;
  stop: boolean;
  status: ClickerStatus;
}

let current: RunState | null = null;

/** 进度推送回调（由 ipc.ts 注入，避免这里直接依赖 Electron 的 webContents） */
type Pusher = (p: ClickerProgress) => void;
let pusher: Pusher | null = null;

export function setClickerPusher(p: Pusher | null) {
  pusher = p;
}

export function clickerStatus(): ClickerStatus {
  if (!current) {
    return {
      running: false,
      round: 0,
      index: -1,
      total: 0,
      done: 0,
      startedAt: 0,
      note: '未运行',
    };
  }
  return { ...current.status, running: true };
}

export function stopClicker(): ClickerStatus {
  if (current) {
    current.stop = true;
    current.status.note = '正在停止…';
  }
  return clickerStatus();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 倍速缩放。
 *
 * **只用于等待与间隙**，不用于动作本身的时长（长按、滑动）。
 * 理由见文件头注释 —— 缩了动作时长会让脚本语义失真。
 */
function scaled(ms: number, speed: number): number {
  const s = speed > 0 ? speed : 1;
  return Math.max(0, Math.round(ms / s));
}

/**
 * 归一化比例 → 设备真实像素。
 *
 * 屏幕尺寸从设备现读（`wm size`），每次回放开始读一次并缓存 ——
 * 回放过程中用户改分辨率是极罕见的情况，不值得每步都查。
 * 真改了的话下一次回放自然生效。
 */
async function deviceSize(serial: string): Promise<{ w: number; h: number }> {
  const res = await runAdb(['-s', serial, 'shell', 'wm', 'size'], {
    source: '连点器',
    silent: true,
    timeout: 8000,
  });
  // 输出形如：Physical size: 1080x2400 / Override size: 720x1600（有 override 时以它为准）
  let physical = { w: 1080, h: 2400 };
  let override: { w: number; h: number } | null = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.match(/(\d+)\s*x\s*(\d+)/);
    if (!m) continue;
    const size = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
    if (/override/i.test(line)) override = size;
    else if (/physical/i.test(line)) physical = size;
  }
  return override || physical;
}

/**
 * 随机偏移。
 *
 * 语义是**半径**：在 [-jitter, +jitter] 内随机取（闭区间外沿）。
 * 用四舍五入取整 —— adb 的 input tap 只认整数像素。
 *
 * 为什么不用正态分布：均匀分布更简单，且效果上已经足够打破
 * 「每次同一像素」这个特征。正态分布反而会让绝大多数点挤在中心附近，
 * 分散度不如均匀。
 */
function jitter(v: number, jitterPx: number): number {
  if (jitterPx <= 0) return Math.round(v);
  const off = (Math.random() * 2 - 1) * jitterPx;
  return Math.round(v + off);
}

/** 步骤 → 人类可读描述（界面进度条与日志用） */
export function describeStep(s: ClickerStep, size?: { w: number; h: number }): string {
  const px = (n: number, dim: number) => (size ? Math.round(n * dim) : n);
  switch (s.kind) {
    case 'tap':
      return `点击 (${px(s.nx, size?.w ?? 1)}, ${px(s.ny, size?.h ?? 1)})${s.count && s.count > 1 ? ` ×${s.count}` : ''}`;
    case 'longPress':
      return `长按 (${px(s.nx, size?.w ?? 1)}, ${px(s.ny, size?.h ?? 1)}) ${s.ms}ms`;
    case 'swipe':
      return `滑动 (${px(s.nx1, size?.w ?? 1)},${px(s.ny1, size?.h ?? 1)}) → (${px(s.nx2, size?.w ?? 1)},${px(s.ny2, size?.h ?? 1)}) ${s.durationMs}ms`;
    case 'key': {
      const known = CLICKER_KEYCODES.find((k) => k.code === s.code);
      return `按键 ${known ? known.label : `keycode ${s.code}`}`;
    }
    case 'wait':
      return `等待 ${s.ms}ms`;
    case 'screenshot':
      return '截图';
    case 'shell':
      return `命令 ${s.cmd}`;
    case 'launch':
      return `启动 ${s.pkg}`;
    case 'note':
      return s.text;
    default:
      return String(CLICKER_STEP_LABEL[(s as ClickerStep).kind] ?? '未知步骤');
  }
}

/**
 * 执行单个步骤。
 *
 * 抽出来是为了让「立即执行这一步」这个调试功能复用同一份逻辑 ——
 * 否则调试时验证过的行为，回放时可能不一样（两份实现必然漂移）。
 */
export async function runStep(
  serial: string,
  step: ClickerStep,
  size: { w: number; h: number },
  jitterPx: number,
  speed: number,
): Promise<void> {
  switch (step.kind) {
    case 'tap': {
      const count = Math.max(1, step.count ?? 1);
      for (let i = 0; i < count; i += 1) {
        const x = jitter(step.nx * size.w, jitterPx);
        const y = jitter(step.ny * size.h, jitterPx);
        // 夹到屏幕内：偏移不能把点推到屏幕外（会被系统忽略或点到别的控件）
        const cx = Math.min(size.w - 1, Math.max(0, x));
        const cy = Math.min(size.h - 1, Math.max(0, y));
        const r = await runAdb(['-s', serial, 'shell', 'input', 'tap', String(cx), String(cy)], {
          source: '连点器',
          silent: true,
          timeout: CMD_TIMEOUT_MS,
        });
        if (!r.ok) throw new Error(r.stderr.trim() || `点击 (${cx},${cy}) 失败`);
        if (i < count - 1) await wait(CLICK_GAP_MS);
      }
      return;
    }

    case 'longPress': {
      /*
       * 长按用 `input swipe x y x y ms` 实现（原地不动 + 指定时长）——
       * 这是免 root 下唯一可靠的"长按"手段：`input tap` 只有瞬时按下抬起，
       * 而 `input keyevent` 没有坐标概念。原地 swipe 会被系统识别为长按。
       */
      const x = jitter(step.nx * size.w, jitterPx);
      const y = jitter(step.ny * size.h, jitterPx);
      const cx = Math.min(size.w - 1, Math.max(0, x));
      const cy = Math.min(size.h - 1, Math.max(0, y));
      const r = await runAdb(
        ['-s', serial, 'shell', 'input', 'swipe', String(cx), String(cy), String(cx), String(cy), String(step.ms)],
        { source: '连点器', silent: true, timeout: step.ms + CMD_TIMEOUT_MS },
      );
      if (!r.ok) throw new Error(r.stderr.trim() || '长按失败');
      return;
    }

    case 'swipe': {
      const x1 = Math.min(size.w - 1, Math.max(0, jitter(step.nx1 * size.w, jitterPx)));
      const y1 = Math.min(size.h - 1, Math.max(0, jitter(step.ny1 * size.h, jitterPx)));
      const x2 = Math.min(size.w - 1, Math.max(0, jitter(step.nx2 * size.w, jitterPx)));
      const y2 = Math.min(size.h - 1, Math.max(0, jitter(step.ny2 * size.h, jitterPx)));
      const r = await runAdb(
        ['-s', serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(step.durationMs)],
        { source: '连点器', silent: true, timeout: step.durationMs + CMD_TIMEOUT_MS },
      );
      if (!r.ok) throw new Error(r.stderr.trim() || '滑动失败');
      return;
    }

    case 'key': {
      const r = await runAdb(['-s', serial, 'shell', 'input', 'keyevent', String(step.code)], {
        source: '连点器',
        silent: true,
        timeout: CMD_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(r.stderr.trim() || `按键 ${step.code} 失败`);
      return;
    }

    case 'wait':
      // 倍速在这里生效（动作时长不缩）
      await wait(scaled(step.ms, speed));
      return;

    case 'screenshot': {
      const dir = resolveDir('screenshot');
      ensureDir(dir);
      await captureScreen(serial, dir);
      return;
    }

    case 'shell': {
      /*
       * 交给 adb 的 shell 执行。刻意不自己切分引号：
       * `adb shell "a b c"` 在 Windows 下会被转义搞乱（见 quick-actions.ts 的注释）。
       * 直接把整串作为一个参数传，让 adb 自己交给设备端 shell 解析。
       */
      const r = await runAdb(['-s', serial, 'shell', step.cmd], {
        source: '连点器',
        silent: true,
        timeout: CMD_TIMEOUT_MS,
      });
      // shell 步骤允许"失败也不中断"：命令返回非 0 很常见（grep 没匹配到等），
      // 不该因此让整个脚本停在那儿。真正的错误靠运行日志看。
      if (!r.ok) {
        log('warn', '连点器', `shell 步骤返回非零：${step.cmd} —— ${r.stderr.trim().slice(0, 200)}`);
      }
      return;
    }

    case 'launch': {
      // 与快捷动作一致的启动方式：monkey 发一个 LAUNCHER 事件（比 am start 更省心，
      // 不需要知道具体 Activity 名）
      const r = await runAdb(
        ['-s', serial, 'shell', 'monkey', '-p', step.pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
        { source: '连点器', silent: true, timeout: CMD_TIMEOUT_MS },
      );
      if (!r.ok) throw new Error(r.stderr.trim() || `启动 ${step.pkg} 失败`);
      return;
    }

    case 'note':
      // 说明步骤不执行任何设备操作
      return;

    default:
      return;
  }
}

/**
 * 回放一个脚本。
 *
 * 立即返回（不 await 整个回放）：回放可能要跑几小时，IPC 调用不能挂在那儿。
 * 进度通过 [pusher] 推给界面，状态用 [clickerStatus] 查。
 */
export async function startClicker(script: ClickerScript, serial?: string): Promise<ClickerStatus> {
  if (current) throw new Error('已有脚本正在运行，请先停止');

  // sanitize：即便脚本来自界面（已经 sanitize 过一遍），这里再走一次 ——
  // 拼 adb 命令的地方必须只接受白名单化的结构
  const clean = sanitizeScript(script);
  if (!clean) throw new Error('脚本内容无效');

  const s = await ensureDevice(serial);

  if (clean.steps.filter((x) => x.kind !== 'note').length === 0) {
    throw new Error('脚本里没有可执行的步骤');
  }

  const state: RunState = {
    script: clean,
    serial: s,
    stop: false,
    status: {
      running: true,
      scriptId: clean.id,
      round: 0,
      index: -1,
      total: clean.steps.length,
      done: 0,
      startedAt: Date.now(),
      note: '准备中…',
    },
  };
  current = state;

  log('info', '连点器', `开始回放「${clean.name}」：${clean.steps.length} 步 · ${clean.loop === 0 ? '无限循环' : `${clean.loop} 轮`} · ${clean.speed}× · 偏移 ${clean.jitterPx}px`);

  // 后台跑，不阻塞 IPC 返回
  void (async () => {
    try {
      const size = await deviceSize(s);
      log('info', '连点器', `目标设备 ${s} 分辨率 ${size.w}x${size.h}`);

      const totalRounds = clean.loop <= 0 ? Number.MAX_SAFE_INTEGER : clean.loop;
      let done = 0;

      for (let round = 1; round <= totalRounds; round += 1) {
        if (state.stop) break;
        state.status.round = round;

        for (let i = 0; i < clean.steps.length; i += 1) {
          if (state.stop) break;
          const step = clean.steps[i];
          state.status.index = i;
          const label = describeStep(step, size);
          state.status.note = label;

          pusher?.({
            scriptId: clean.id,
            round,
            index: i,
            total: clean.steps.length,
            done,
            label,
          });

          await runStep(s, step, size, clean.jitterPx, clean.speed);

          done += 1;
          state.status.done = done;

          // 步骤间隙（倍速生效）—— note 是纯说明，不需要等
          if (step.kind !== 'note' && i < clean.steps.length - 1) {
            await wait(scaled(STEP_GAP_MS, clean.speed));
          }
        }
      }

      state.status.note = state.stop ? '已手动停止' : '回放完成';
      log('success', '连点器', `回放结束：共执行 ${done} 步`);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      state.status.error = msg;
      state.status.note = `出错：${msg}`;
      log('error', '连点器', `回放中断：${msg}`);
      pusher?.({
        scriptId: clean.id,
        round: state.status.round,
        index: state.status.index,
        total: clean.steps.length,
        done: state.status.done,
        label: state.status.note,
        failed: true,
        error: msg,
      });
    } finally {
      // 留最后一份状态给界面看（running 由 current 决定），
      // 然后清空 current 允许下一次回放
      current = null;
    }
  })();

  return clickerStatus();
}

/** 立即执行一个步骤（调试用，不进入回放循环） */
export async function runSingleStep(step: unknown, serial?: string): Promise<string> {
  const clean = sanitizeStep(step);
  if (!clean) throw new Error('步骤内容无效');
  const s = await ensureDevice(serial);
  const size = await deviceSize(s);
  const st = getSettings();
  await runStep(s, clean, size, st.clickerJitterPx ?? 0, st.clickerSpeed ?? 1);
  const label = describeStep(clean, size);
  log('success', '连点器', `单步执行：${label}`);
  return label;
}
