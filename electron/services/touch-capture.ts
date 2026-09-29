import { ChildProcess } from 'child_process';
import { runAdb, spawnBinary, ensureDevice, log, adbPath } from './adb';

/**
 * 电脑侧触摸采集（`adb shell getevent`）
 * ============================================================
 *
 * ## 为什么触摸要由电脑来读
 *
 * Android 5.0 起，第三方 App **只能拿到落在自己窗口上的触摸**（要读全局触摸
 * 必须 INJECT_EVENTS，只有系统签名或 root 有）。所以设备侧那个采集端 App
 * 无论如何都看不到用户在**别的 App** 上的操作 —— 这正是上一版「必须在这个
 * App 的画布上操作」的根因。
 *
 * 但 `adb shell` 不一样：**shell 用户（uid 2000）在 `input` 组（gid 1004）里**，
 * 对 `/dev/input/event*` 有读权限。于是电脑执行
 * `adb shell getevent -lt /dev/input/eventN` 就能拿到设备**全屏、全 App** 的
 * 原始触摸事件 —— 免 root，也不需要在设备上做任何事。
 *
 * ## 整体分工（改造后的录制链路）
 *
 * | 数据       | 谁来采                        | 为什么                        |
 * |------------|-------------------------------|-------------------------------|
 * | 屏幕画面   | 设备侧 App（MediaProjection）  | 只有系统 API 能拿画面          |
 * | 前台 App   | 设备侧 App（UsageStats）       | 同上                          |
 * | **触摸**   | **本文件（adb getevent）**     | shell 在 input 组，能读全局     |
 *
 * 开始 / 暂停 / 停止由电脑编排：电脑同时控制设备侧（HTTP `/start` 等）
 * 和本文件（起停 getevent 子进程）。
 *
 * ## `getevent -lt` 的输出格式（这是解析的全部依据）
 *
 * ```
 * [   12345.678901] /dev/input/event2: EV_ABS       ABS_MT_POSITION_X    00000abc
 * [   12345.679012] /dev/input/event2: EV_ABS       ABS_MT_POSITION_Y    0000192f
 * [   12345.680123] /dev/input/event2: EV_KEY       BTN_TOUCH            DOWN
 * [   12345.681234] /dev/input/event2: EV_SYN       SYN_REPORT           00000000
 * ```
 *
 *   · 行首 `[ 秒.微秒]` 是**设备开机以来的时间**（单调，与墙钟无关）；
 *     同一批（一个 SYN_REPORT 周期）内多行时间戳略有差异，取最后一个为准。
 *   · `EV_ABS` 行给坐标，**像素值是 hex**（`00000abc`）。
 *   · `EV_KEY BTN_TOUCH DOWN/UP` 标记按下/抬起。
 *   · `EV_SYN SYN_REPORT` 表示「这一帧的事件齐了，可以消费」——
 *     不等到 SYN_REPORT 就下结论会把半个手势误判成点击。
 *
 * ## 坐标标定（这一步不做，录出来的点位全是错的）
 *
 * `ABS_MT_POSITION_X` 的 max **不等于**屏幕宽度。真机实测（OPPO CPH2579，
 * 720x1612 屏）：X max = 2879、Y max = 6447 —— 触摸屏控制器的分辨率跟
 * 显示分辨率是两套坐标系。所以：
 *
 *   1. `getevent -p` 读出该节点的 `ABS_MT_POSITION_X` / `_Y` 的 min/max；
 *   2. 归一化 `nx = (rawX - minX) / (maxX - minX)`，ny 同理；
 *   3. 存 0~1 比例（与项目里其它坐标一律 0~1 的约定一致），
 *      回放时乘目标分辨率即可，换机也不用改脚本。
 *
 * ## 节点怎么选
 *
 * 一台设备可能有多块 input 设备（触摸屏、按键、传感器…）。挑法：
 *   · `getevent -pl` 列出所有节点及其能力；
 *   · 找**同时具备 `ABS_MT_POSITION_X` 与 `ABS_MT_POSITION_Y`** 的那个 ——
 *     这是多点触摸屏的唯一特征（音量键之类的没有 ABS_MT_*）。
 *   · 若有多块（极少见），取名字里含 `touch` 的，否则取第一个。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 一个可用的触摸输入节点 */
export interface TouchNode {
  /** `/dev/input/eventN` */
  path: string;
  /** 设备名，如 `touchpanel` */
  name: string;
  /** 原始坐标范围（标定用） */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 采集到的一条触摸点（已归一化） */
export interface CapturedTouch {
  type: 'down' | 'move' | 'up';
  /** 0~1 比例（相对触摸节点原始范围） */
  nx: number;
  ny: number;
  /** 相对录制开始的毫秒数 */
  t: number;
}

/** 采集器状态（给界面显示） */
export interface TouchCaptureState {
  running: boolean;
  serial: string;
  node: TouchNode | null;
  /** 已采集条数 */
  count: number;
  /** 起止时间（墙钟 ms） */
  startedAt: number;
  /** 采集时的屏幕尺寸（归一化以屏幕为基准；见下方说明） */
  screenWidth: number;
  screenHeight: number;
  note: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 内部状态                                                            */
/* ------------------------------------------------------------------ */

let child: ChildProcess | null = null;
let state: TouchCaptureState = {
  running: false,
  serial: '',
  node: null,
  count: 0,
  startedAt: 0,
  screenWidth: 0,
  screenHeight: 0,
  note: '',
};

/** 采集到的触摸序列（内存里累积，停止后由 screen-recorder 取走） */
let touches: CapturedTouch[] = [];

/** 录制开始时刻（墙钟 ms）—— `t` 以它为基准 */
let epoch = 0;

/** 暂停标记：暂停期间事件丢弃（不累加 t） */
let paused = false;
let pausedTotalMs = 0;
let pauseBeganAt = 0;

/* ------------------------------------------------------------------ */
/* 节点探测                                                            */
/* ------------------------------------------------------------------ */

/**
 * 列出设备上所有具备多点触摸能力的节点。
 *
 * 为什么用 `getevent -pl` 而不是 `-p`：`-pl` 会**同时打印设备名**，
 * 我们需要名字做择优（多块触摸屏时优先选名字含 touch 的）。
 */
export async function listTouchNodes(serial?: string): Promise<TouchNode[]> {
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'getevent', '-pl'], {
    source: '触摸采集',
    silent: true,
    timeout: 15000,
  });
  if (!res.ok && !res.stdout) {
    throw new Error(`读取输入设备列表失败：${res.stderr.trim() || '无输出'}`);
  }
  return parseNodes(res.stdout || '');
}

/**
 * 解析 `getevent -pl` 的输出。
 *
 * 输出形如：
 *
 * ```
 * add device 1: /dev/input/event2
 *   name:     "touchpanel"
 *   events:
 *     ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
 *                 ABS_MT_POSITION_X     : value 0, min 0, max 2879, fuzz 0, flat 0, resolution 0
 *                 ABS_MT_POSITION_Y     : value 0, min 0, max 6447, fuzz 0, flat 0, resolution 0
 * ```
 *
 * 关键点：`min/max` 是**该节点的原始量程**，不是屏幕像素。
 */
export function parseNodes(raw: string): TouchNode[] {
  const nodes: TouchNode[] = [];
  const lines = raw.split(/\r?\n/);

  let cur: TouchNode | null = null;

  for (const line of lines) {
    // 新设备段落
    const add = line.match(/^add device \d+:\s*(\/dev\/input\/event\d+)/);
    if (add) {
      if (cur) nodes.push(cur);
      cur = { path: add[1], name: '', minX: 0, maxX: 0, minY: 0, maxY: 0 };
      continue;
    }
    if (!cur) continue;

    // 设备名
    const nm = line.match(/^\s*name:\s*"([^"]*)"/);
    if (nm) {
      cur.name = nm[1];
      continue;
    }

    // 坐标量程 —— 只认 ABS_MT_*，普通 ABS_X/Y 在单点设备上也可能出现，
    // 但多点触摸屏一定有 ABS_MT_*；用 ABS_MT_* 才不会误判按键节点。
    const axis = line.match(/\b(ABS_MT_POSITION_[XY])\s*:.*?min\s+(-?\d+),\s*max\s+(-?\d+)/);
    if (axis) {
      const [, which, minS, maxS] = axis;
      const min = parseInt(minS, 10);
      const max = parseInt(maxS, 10);
      if (which === 'ABS_MT_POSITION_X') {
        cur.minX = min;
        cur.maxX = max;
      } else {
        cur.minY = min;
        cur.maxY = max;
      }
    }
  }
  if (cur) nodes.push(cur);

  // 只留下两个轴都拿到量程的节点 —— 这才是真正的触摸屏
  return nodes.filter((n) => n.maxX > n.minX && n.maxY > n.minY);
}

/**
 * 挑一个触摸节点。
 *
 * 优先名字含 `touch`（绝大多数设备的惯例），否则取第一个。
 * 多块都在的话（外接触摸屏 / 手写笔），取量程最大的那个 ——
 * 量程大的一般是主屏。
 */
export function pickNode(nodes: TouchNode[]): TouchNode | null {
  if (nodes.length === 0) return null;
  const named = nodes.filter((n) => /touch|touchscreen|touchpanel|_ts/i.test(n.name));
  const pool = named.length > 0 ? named : nodes;
  return pool.slice().sort((a, b) => b.maxX * b.maxY - a.maxX * a.maxY)[0];
}

/* ------------------------------------------------------------------ */
/* 解析 getevent -lt 流                                                */
/* ------------------------------------------------------------------ */

/**
 * 采集过程的**解析器**。
 *
 * 把「一行一行的事件」揉成「一次触摸动作」。做成类是为了让单测
 * 能直接喂字符串验证（见 `scripts/check-touch-capture.cjs`），
 * 不用真接设备。
 *
 * 状态机（`getevent -lt` 是事件流，必须攒到 `SYN_REPORT` 才作数）：
 *
 * ```
 *   按下前：  EV_ABS(X/Y) 先到（预压坐标），BTN_TOUCH DOWN 才算真正按下
 *   按下后：  EV_ABS 变化 → move；BTN_TOUCH UP → up
 * ```
 *
 * ⚠️ 触摸屏的常见时序是 **先报坐标、后报 DOWN**（`ABS_MT_POSITION_*` 在
 * `BTN_TOUCH DOWN` 之前）。所以不能"见到 DOWN 才开始记坐标" ——
 * 那样第一条 down 的坐标会丢。这里**始终缓存最近一次坐标**，
 * DOWN 时直接取缓存值。
 */
export class GetEventParser {
  constructor(
    private readonly node: TouchNode,
    /**
     * 起始墙钟（ms）。
     *
     * ⚠️ **不要拿它去减设备时间戳**：设备时间戳是「开机以来的秒数」
     * （真机上是 `12345.678901`），跟电脑墙钟是两个完全无关的坐标系，
     * 直接相减会得到巨大的负数。
     *
     * 这里的用法是：把**第一条事件的设备时间戳**当作时间零点，
     * 之后的事件按「与零点的差」算相对毫秒。所以 `epochMs` 只作为
     * 「设备时间戳还没出现时的兜底」以及对外汇报的起始墙钟。
     */
    private readonly epochMs: number,
    /** @deprecated 保留形参兼容；当前实现不依赖跨时钟偏移 */
    private readonly clockOffsetMs: number = 0,
    /** 暂停判定：返回 true 时丢弃该事件 */
    private readonly isPaused: () => boolean = () => false,
  ) {}

  /** 最近一次 ABS 坐标（原始值） */
  private lastX: number | null = null;
  private lastY: number | null = null;
  /** 当前是否已按下 */
  private down = false;
  /** 上一笔已上报的位置（用于 move 去重） */
  private lastNx = -1;
  private lastNy = -1;

  /** 本批（一个 SYN 周期）里最后看到的设备时间（秒，开机以来） */
  private batchTime = -1;

  /** 第一条事件的设备时间（秒）—— 时间零点；null 表示还没见到第一条 */
  private zeroTime: number | null = null;

  /** 上一次输出的相对时间（保证 t 单调不减，避免浮点回退） */
  private lastT = 0;

  /** 计算出来的结果（供调用方取） */
  private out: CapturedTouch[] = [];

  /** 喂一行原始输出 */
  feed(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // 行首时间戳：`[   12345.678901]`
    const tm = trimmed.match(/^\[\s*([\d.]+)\]/);
    if (tm) {
      const sec = parseFloat(tm[1]);
      if (Number.isFinite(sec)) this.batchTime = sec;
    }

    // 事件体：`/dev/input/eventN: EV_ABS ABS_MT_POSITION_X 00000abc`
    const body = trimmed.replace(/^\[\s*[\d.]+\]\s*/, '');
    const ev = body.match(/^(\S+):\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!ev) return;
    const [, dev, evType, evCode, evVal] = ev;

    // 只认自己那一个节点：同一台设备常有多个 event 节点在刷（按键等）
    if (dev !== this.node.path) return;

    if (evType === 'EV_ABS') {
      if (evCode === 'ABS_MT_POSITION_X') {
        const v = parseAxisValue(evVal, this.node.maxX);
        if (v != null) this.lastX = v;
      } else if (evCode === 'ABS_MT_POSITION_Y') {
        const v = parseAxisValue(evVal, this.node.maxY);
        if (v != null) this.lastY = v;
      }
      return;
    }

    if (evType === 'EV_KEY' && evCode === 'BTN_TOUCH') {
      const down = /DOWN|1/.test(evVal);
      if (down && !this.down) {
        this.down = true;
        // 用缓存的坐标上报 down（时序上坐标通常先到）
        this.emit('down', /*force*/ true);
      } else if (!down && this.down) {
        this.down = false;
        this.emit('up', /*force*/ true);
      }
      return;
    }

    if (evType === 'EV_SYN' && evCode === 'SYN_REPORT') {
      // 一帧齐了。若手指按着且坐标有变化 → 这是 move。
      if (this.down) this.emit('move', /*force*/ false);
      return;
    }
  }

  /** 拿结果并清空缓冲（调用方每帧调一次，或停止时调一次） */
  drain(): CapturedTouch[] {
    if (this.out.length === 0) return [];
    const r = this.out;
    this.out = [];
    return r;
  }

  /* -------------------------------------------------------------- */

  private emit(type: 'down' | 'move' | 'up', force: boolean): void {
    if (this.isPaused()) return;
    if (this.lastX == null || this.lastY == null) {
      // up 事件即使没坐标也要发 —— 否则手势会永远"悬着"
      if (type !== 'up') return;
    }

    const nx = this.lastX == null ? this.lastNx : this.normX(this.lastX);
    const ny = this.lastY == null ? this.lastNy : this.normY(this.lastY);
    if (nx < 0 || ny < 0) return;

    // move 去重：坐标没动就不必产出（触摸屏空闲时会继续报同一点）
    if (type === 'move' && !force) {
      if (Math.abs(nx - this.lastNx) < 1e-4 && Math.abs(ny - this.lastNy) < 1e-4) return;
    }

    this.lastNx = nx;
    this.lastNy = ny;

    this.out.push({
      type,
      nx: round4(nx),
      ny: round4(ny),
      t: this.timeMs(),
    });
  }

  private normX(raw: number): number {
    const span = this.node.maxX - this.node.minX;
    if (span <= 0) return -1;
    return clamp01((raw - this.node.minX) / span);
  }

  private normY(raw: number): number {
    const span = this.node.maxY - this.node.minY;
    if (span <= 0) return -1;
    return clamp01((raw - this.node.minY) / span);
  }

  /**
   * 相对录制的毫秒数。
   *
   * ## 时间零点怎么定的
   *
   * 设备时间戳是**开机以来的秒数**（真机上是 `12345.678901`），
   * 跟电脑墙钟毫无关系 —— 直接相减必然得到巨大的负数（这是第一版实现
   * 的 bug：所有 `t` 都退化成 0）。
   *
   * 所以正确做法是：**第一条事件的时间戳就是零点**（`zeroTime`），
   * 之后按差值算。这样设备时钟跟电脑时钟的绝对偏差完全不参与运算，
   * 结果也不受设备开机多久影响。
   *
   * 兜底：万一输出里没有时间戳（极少数 rom 的 `-lt` 行为不一致），
   * 退回「当前墙钟 - epochMs」。
   */
  private timeMs(): number {
    let rel: number;
    if (this.batchTime >= 0) {
      if (this.zeroTime === null) this.zeroTime = this.batchTime;
      rel = (this.batchTime - this.zeroTime) * 1000;
    } else {
      rel = Date.now() - this.epochMs;
    }
    if (!Number.isFinite(rel) || rel < 0) rel = this.lastT;
    // 单调不减：设备时间戳在同一批里可能重复，浮点相减也可能回退
    if (rel < this.lastT) rel = this.lastT;
    this.lastT = rel;
    return Math.round(rel);
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return -1;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * 解析 getevent 的数值列。
 *
 * ⚠️ **这一列永远是 hex**（`getevent` 用 `%08x` 打印，包括 `-lt` 模式）。
 * 曾经的写法是"含 a-f 就当 hex，纯数字当十进制" —— 那是**错的**：
 * `00000120` 里没有 a-f，会被读成十进制 120，而它真正的值是 288。
 * 表现是坐标**静默偏移**（本机真机实测：所有点位只有正确值的 41.7%，
 * 且不报任何错）。
 *
 * 所以规则改成：**先按 hex 解**；只有当 hex 的结果明显不合理
 * （超出该轴的量程）时，才退回十进制 —— 覆盖个别 rom 用十进制打印的情况。
 *
 * @param axisMax 该轴的量程上限（用于判断 hex/十进制哪个可信）
 */
function parseAxisValue(s: string, axisMax: number): number | null {
  const t = s.trim();
  if (!t) return null;

  // 明确的 hex 字样（x 前缀）或含 a-f → 一定是 hex
  if (/^0x/i.test(t)) return parseInt(t, 16);
  if (/[a-f]/i.test(t)) return parseInt(t, 16);

  const asHex = parseInt(t, 16);
  const asDec = parseInt(t, 10);

  // 纯数字：优先 hex。如果 hex 落在量程内 → 用它（这是 getevent 的正常情况）
  if (Number.isFinite(asHex) && axisMax > 0 && asHex <= axisMax) return asHex;

  // hex 超量程 → 可能这台设备真的打十进制
  if (Number.isFinite(asDec)) return asDec;

  return Number.isFinite(asHex) ? asHex : null;
}

/* ------------------------------------------------------------------ */
/* 采集控制                                                            */
/* ------------------------------------------------------------------ */

/**
 * 开始采集。
 *
 * 前置：设备上有可用的触摸节点。做这步之前请先调 [listTouchNodes] 探一遍
 * （界面上的「开始录制」会走 [prepare]）。
 *
 * @param screenW/H 屏幕像素尺寸（仅用于界面显示与日志，归一化以节点量程为准）
 */
export async function startCapture(
  serial: string | undefined,
  opts: { screenWidth?: number; screenHeight?: number } = {},
): Promise<TouchCaptureState> {
  if (child) await stopCapture();

  const s = await ensureDevice(serial);
  const nodes = await listTouchNodes(s);
  const node = pickNode(nodes);
  if (!node) {
    throw new Error(
      '没找到可用的触摸节点（getevent 列不出带 ABS_MT_POSITION_X/Y 的设备）—— ' +
        '可能是设备厂商限制了 shell 读取 /dev/input',
    );
  }

  // 记录起始墙钟。getevent 的时间戳是设备开机时间，
  // 我们用一个「当前墙钟 - 首条事件设备时间」来建立桥接 —— 见 parser 的 clockOffset。
  epoch = Date.now();
  paused = false;
  pausedTotalMs = 0;
  pauseBeganAt = 0;
  touches = [];

  const parser = new GetEventParser(node, epoch, 0, () => paused);

  const c = spawnBinary(
    adbPath(),
    ['-s', s, 'shell', 'getevent', '-lt', node.path],
    '触摸采集',
  );
  child = c;

  state = {
    running: true,
    serial: s,
    node,
    count: 0,
    startedAt: epoch,
    screenWidth: opts.screenWidth || 0,
    screenHeight: opts.screenHeight || 0,
    note: `采集中：${node.name || node.path}（X ${node.minX}~${node.maxX} / Y ${node.minY}~${node.maxY}）`,
  };
  log('info', '触摸采集', state.note);

  // 逐行喂给解析器
  let buf = '';
  const onData = (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    // 保留最后一段（可能是不完整的行）
    buf = lines.pop() || '';
    for (const line of lines) parser.feed(line);
    const got = parser.drain();
    if (got.length > 0) {
      for (const t of got) touches.push({ ...t, t: t.t });
      state.count = touches.length;
    }
  };

  c.stdout?.on('data', onData);
  c.stderr?.on('data', onData);

  c.on('error', (e) => {
    state.running = false;
    state.error = `getevent 启动失败：${e.message}`;
    log('error', '触摸采集', state.error);
    child = null;
  });

  c.on('close', (code) => {
    if (state.running) {
      // 非我们主动停的退出（设备掉线等）
      state.running = false;
      state.error = `getevent 意外退出（code ${code}）`;
      log('warn', '触摸采集', state.error);
    }
    if (child === c) child = null;
  });

  return { ...state };
}

/**
 * 停止采集，返回本次采集到的全部触摸点。
 *
 * 顺序很重要：先杀子进程（不再有新事件进来），再收尾解析器里剩下的。
 */
export async function stopCapture(): Promise<CapturedTouch[]> {
  const c = child;
  if (!c) {
    state.running = false;
    return touches;
  }
  child = null;
  state.running = false;

  // Windows 上 adb shell 的子进程树要连 adb 一起收掉；
  // 直接 kill 本地 adb 进程即可 —— 服务端的 shell 会随连接断开而结束
  try {
    c.kill();
  } catch {
    /* 忽略 */
  }

  // 给一点时间让最后几行输出落地（否则最后一个 up 可能丢）
  await sleep(250);

  const out = touches;
  touches = [];
  log('info', '触摸采集', `已停止，共采集 ${out.length} 条触摸点`);
  return out;
}

/** 暂停 / 恢复（暂停期间事件丢弃，恢复后时间轴继续） */
export function setPaused(p: boolean): void {
  if (p === paused) return;
  if (p) {
    pauseBeganAt = Date.now();
    paused = true;
  } else {
    if (pauseBeganAt > 0) pausedTotalMs += Date.now() - pauseBeganAt;
    pauseBeganAt = 0;
    paused = false;
  }
  log('info', '触摸采集', p ? '已暂停（事件丢弃）' : '已恢复');
}

/** 当前已采集的触摸点（拷贝） */
export function capturedTouches(): CapturedTouch[] {
  return touches.slice();
}

/** 采集器状态 */
export function captureState(): TouchCaptureState {
  return { ...state, count: touches.length };
}

/** 清空（换设备/重录前调） */
export function resetCapture(): void {
  touches = [];
  paused = false;
  pausedTotalMs = 0;
  pauseBeganAt = 0;
  state.count = 0;
  state.error = undefined;
}

/**
 * 一次性准备：探测节点是否可用（不发流）。
 * 界面在「开始录制」前调它，能把"这台设备读不到触摸"提前暴露出来，
 * 而不是录完了才发现触摸是空的。
 */
export async function prepare(serial?: string): Promise<{ ok: boolean; node: TouchNode | null; note: string }> {
  try {
    const s = await ensureDevice(serial);
    const nodes = await listTouchNodes(s);
    const node = pickNode(nodes);
    if (!node) {
      return {
        ok: false,
        node: null,
        note: '没找到触摸节点：设备可能限制了 shell 读 /dev/input（少数定制 rom）',
      };
    }
    return {
      ok: true,
      node,
      note: `触摸节点 ${node.path}（${node.name || '未命名'}），量程 X ${node.maxX} / Y ${node.maxY}`,
    };
  } catch (e) {
    return { ok: false, node: null, note: (e as Error).message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
