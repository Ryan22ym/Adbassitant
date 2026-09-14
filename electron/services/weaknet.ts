import { randomUUID } from 'crypto';
import { runAdb, ensureDevice, log } from './adb';
import type {
  WeakNetDirectionParams,
  WeakNetMode,
  WeakNetParams,
  WeakNetPreset,
  WeakNetStatus,
} from '../../shared/types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

/**
 * 弱网模拟（对标 clumsy）
 *
 * 两条技术路线，按设备能力自动选择：
 *
 *   ① tc + netem（首选，需 Root）
 *      `tc qdisc add dev <iface> root netem delay 100ms 20ms loss 3% corrupt 1%`
 *      入向流量需要挂 ifb 虚拟网卡 + ingress 重定向才能真正生效：
 *        tc qdisc add dev <iface> handle ffff: ingress
 *        tc filter add dev <iface> parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0
 *        tc qdisc add dev ifb0 root netem ...
 *      这是 clumsy 在 Windows 上的同构做法，参数语义一一对应。
 *
 *   ② svc wifi/data（免 Root 保底）
 *      只能开关整个数据通道，用于模拟「完全断网 / 弱信号」这类场景。
 *      无法做带宽、延迟、丢包等精细控制。
 *
 * netem 参数映射：
 *   bandwidth → tbf/netem rate（这里用 tbf 做限速更准，netem 的 rate 是整形）
 *   delay     → netem delay
 *   jitter    → netem delay <base> <jitter>
 *   loss      → netem loss
 *   corrupt   → netem corrupt
 *   reorder   → netem reorder（需配合 delay 才能看出效果）
 *   duplicate → netem duplicate
 */

/* ------------------------------------------------------------------ */
/* 会话状态                                                            */
/* ------------------------------------------------------------------ */

interface Session {
  serial: string;
  startedAt: number;
  params: WeakNetParams;
  mode: WeakNetMode;
  rooted: boolean;
  iface: string;
  /** 已挂上的 qdisc 描述，用于回滚 */
  applied: AppliedRule[];
  /** 定时停止 */
  timer: NodeJS.Timeout | null;
  note?: string;
}

interface AppliedRule {
  kind: 'netem' | 'ingress' | 'ifb' | 'svc';
  iface: string;
  /** 对应的还原命令 */
  cleanup: string[];
}

let session: Session | null = null;

type StatusSink = (status: WeakNetStatus) => void;
let statusSink: StatusSink | null = null;

export function setWeakNetStatusSink(sink: StatusSink) {
  statusSink = sink;
}

function emitStatus() {
  statusSink?.(getWeakNetStatus());
}

export function getWeakNetStatus(): WeakNetStatus {
  if (!session) return { running: false, remainSec: 0, mode: 'none' };
  const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
  const remainSec = session.params.durationSec > 0
    ? Math.max(0, session.params.durationSec - elapsed)
    : -1;

  return {
    running: true,
    serial: session.serial,
    startedAt: session.startedAt,
    remainSec,
    params: session.params,
    mode: session.mode,
    rooted: session.rooted,
    iface: session.iface,
    note: session.note,
  };
}

/* ------------------------------------------------------------------ */
/* 设备能力探测                                                        */
/* ------------------------------------------------------------------ */

export interface ProbeResult {
  rooted: boolean;
  hasTc: boolean;
  hasIfb: boolean;
  iface: string;
  ifaces: string[];
  hasSvc: boolean;
  sdk?: number;
  note: string;
}

export async function probeDevice(serial: string | undefined): Promise<ProbeResult> {
  const s = await ensureDevice(serial);

  const [rootRes, tcRes, ifbRes, ifaceRes, procNetRes, sdkRes] = await Promise.all([
    runAdb(['-s', s, 'shell', 'su', '-c', 'id'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'which', 'tc'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'ls', '/sys/module/ifb'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'ip', '-o', 'link', 'show'], { silent: true, timeout: 8000 }),
    // 兜底：ColorOS / MIUI 等精简 ROM 常常没有 ip 命令，/proc/net/dev 一定存在
    runAdb(['-s', s, 'shell', 'cat', '/proc/net/dev'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'getprop', 'ro.build.version.sdk'], { silent: true, timeout: 8000 }),
  ]);

  const rooted = /uid=0/.test(rootRes.stdout);
  // which 在部分 ROM 上不可用；再退一步看 `tc` 本身能否执行
  let hasTc = /tc/.test(tcRes.stdout.trim());
  if (!hasTc) {
    const probeTc = await runAdb(['-s', s, 'shell', 'tc', 'qdisc', 'show'], {
      silent: true,
      timeout: 8000,
    });
    hasTc = probeTc.ok || /qdisc|netem|RTNETLINK/i.test(probeTc.stdout + probeTc.stderr);
  }
  // ifb 可能未加载但模块存在：ls /sys/module 有目录 = 已加载，
  // 内核配置里可编译则可 modprobe，这里按「目录存在」判定
  let hasIfb = ifbRes.ok && /ifb/i.test(ifbRes.stdout);
  if (!hasIfb && rooted) {
    const mod = await runAdb(['-s', s, 'shell', 'su', '-c', 'modprobe ifb numifbs=1 && echo IFB_OK'], {
      silent: true,
      timeout: 8000,
    });
    hasIfb = /IFB_OK/.test(mod.stdout);
  }
  const sdk = parseInt(sdkRes.stdout.trim(), 10);

  // 优先用 ip 的解析结果；为空则退到 /proc/net/dev
  let ifaces = parseIfaces(ifaceRes.stdout);
  if (ifaces.length === 0) ifaces = parseProcNetDev(procNetRes.stdout);
  const iface = pickIface(ifaces);

  const note = !rooted
    ? '设备未 Root：无法使用 tc/netem 精细控制，将降级为「开关网络」模式'
    : !hasTc
      ? '设备缺少 tc 命令，降级为「开关网络」模式'
      : !hasIfb
        ? '内核未提供 ifb 模块，下行（入向）限速可能不生效，上行不受影响'
        : '设备支持完整 tc/netem 模拟（含上下行独立控制）';

  return {
    rooted,
    hasTc,
    hasIfb,
    iface,
    ifaces,
    hasSvc: true,
    sdk: Number.isFinite(sdk) ? sdk : undefined,
    note,
  };
}

/**
 * 解析 /proc/net/dev
 * 格式（前两行是表头）：
 *   Inter-|   Receive ...
 *    face |bytes    packets ...
 *     wlan0: 12345 67 ...
 */
function parseProcNetDev(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+):\s*\d+/);
    if (!m) continue;
    const name = m[1];
    if (name === 'lo') continue;
    if (/^ifb\d/.test(name)) continue;
    // 过滤掉没有收发流量的虚拟接口（全 0 的通常是未启用的）
    const nums = line.split(':')[1]?.trim().split(/\s+/).map(Number) || [];
    const rxBytes = nums[0] || 0;
    if (rxBytes === 0 && names.length > 0) continue;
    names.push(name);
  }
  return names;
}

function parseIfaces(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // 2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> ...
    const m = line.match(/^\d+:\s+([^:@]+)(?:@\S+)?:\s+<([^>]*)>/);
    if (!m) continue;
    const name = m[1].trim();
    const flags = m[2];
    if (name === 'lo') continue;
    if (!/UP/i.test(flags)) continue;
    if (/^ifb\d/.test(name)) continue;
    names.push(name);
  }
  return names;
}

function pickIface(ifaces: string[]): string {
  // 优先级：wlan0 > eth0 > rmnet* > ccmni* > 第一个
  const byPrefix = (p: string) => ifaces.find((i) => i.startsWith(p));
  return (
    byPrefix('wlan') ||
    byPrefix('eth') ||
    byPrefix('rmnet') ||
    byPrefix('ccmni') ||
    ifaces[0] ||
    'wlan0'
  );
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

export async function startWeakNet(
  serial: string | undefined,
  params: WeakNetParams,
): Promise<WeakNetStatus> {
  const s = await ensureDevice(serial);

  if (session) await stopWeakNet();

  const probe = await probeDevice(s);
  const iface = (params.iface || '').trim() || probe.iface;

  // 先清掉上一次可能残留的规则，避免叠加
  await resetAll(s, iface, probe.rooted);

  const ctx: Session = {
    serial: s,
    startedAt: Date.now(),
    params,
    mode: 'none',
    rooted: probe.rooted,
    iface,
    applied: [],
    timer: null,
    note: probe.note,
  };

  const hasShaping =
    hasAnyParam(params.up) || hasAnyParam(params.down) || !!params.blockNetwork;

  if (!hasShaping) {
    throw new Error('参数全为空，没有需要模拟的内容');
  }

  /* ---------- 断网模式：直接开关网络 ---------- */
  if (params.blockNetwork) {
    await setNetworkEnabled(s, false);
    ctx.mode = 'svc';
    ctx.applied.push({
      kind: 'svc',
      iface,
      cleanup: enableNetworkCmd(),
    });
    ctx.note = '网络已整体关闭（svc wifi/data disable），所有流量中断';
  } else if (probe.rooted && probe.hasTc) {
    /* ---------- netem 精细控制 ---------- */
    const { rules, notes } = await applyNetem(s, iface, params, probe.hasIfb);
    ctx.applied = rules;
    ctx.mode = 'tc';
    if (notes.length) ctx.note = notes.join('；');
  } else {
    // 没有 root：如果用户设了接近断网的参数（丢包 100%），退化为关网络
    const upLoss = params.up.lossPercent ?? 0;
    const downLoss = params.down.lossPercent ?? 0;
    if (upLoss >= 100 || downLoss >= 100) {
      await setNetworkEnabled(s, false);
      ctx.mode = 'svc';
      ctx.applied.push({ kind: 'svc', iface, cleanup: enableNetworkCmd() });
      ctx.note = '设备未 Root，丢包率设为 100%，已降级为整体断网';
    } else {
      ctx.mode = 'none';
      ctx.note =
        '设备未 Root，无法应用精细弱网参数。请在下方启用「整体断网」或改用已 Root 的设备。';
      ctx.timer && clearTimeout(ctx.timer);
      session = ctx;
      emitStatus();
      log('warn', '弱网', ctx.note);
      return getWeakNetStatus();
    }
  }

  session = ctx;

  // 限时自动停止
  if (params.durationSec > 0) {
    ctx.timer = setTimeout(() => {
      log('info', '弱网', `已达设定时长 ${params.durationSec}s，自动恢复网络`);
      void stopWeakNet();
    }, params.durationSec * 1000);
  }

  log('success', '弱网', `已生效（${ctx.mode === 'tc' ? 'tc/netem' : 'svc 开关'}）`);
  emitStatus();
  return getWeakNetStatus();
}

export async function stopWeakNet(): Promise<WeakNetStatus> {
  const ctx = session;
  if (!ctx) return getWeakNetStatus();
  session = null;

  if (ctx.timer) {
    clearTimeout(ctx.timer);
    ctx.timer = null;
  }

  // 逆序回滚
  for (const rule of [...ctx.applied].reverse()) {
    for (const cmd of rule.cleanup) {
      try {
        await runRoot(ctx.serial, cmd, ctx.rooted);
      } catch {
        /* 单条失败不中断 */
      }
    }
  }

  // 兜底：整体清一遍，防止残留导致设备一直没网
  await resetAll(ctx.serial, ctx.iface, ctx.rooted);

  log('info', '弱网', '已恢复网络');
  emitStatus();
  return getWeakNetStatus();
}

/* ------------------------------------------------------------------ */
/* netem 规则构造                                                      */
/* ------------------------------------------------------------------ */

function hasAnyParam(d: WeakNetDirectionParams): boolean {
  return [
    d.bandwidthMbps,
    d.delayMs,
    d.jitterMs,
    d.lossPercent,
    d.corruptPercent,
    d.reorderPercent,
    d.duplicatePercent,
  ].some((v) => typeof v === 'number' && v > 0);
}

/**
 * netem 参数串（不含带宽，带宽用 tbf 单独做）
 */
function netemArgs(d: WeakNetDirectionParams): string[] {
  const a: string[] = [];

  const delay = d.delayMs ?? 0;
  const jitter = d.jitterMs ?? 0;
  if (delay > 0 || jitter > 0) {
    if (jitter > 0) a.push('delay', `${delay}ms`, `${jitter}ms`);
    else a.push('delay', `${delay}ms`);
  }

  if ((d.lossPercent ?? 0) > 0) a.push('loss', `${d.lossPercent}%`);
  if ((d.corruptPercent ?? 0) > 0) a.push('corrupt', `${d.corruptPercent}%`);
  if ((d.duplicatePercent ?? 0) > 0) a.push('duplicate', `${d.duplicatePercent}%`);

  // reorder 需要 delay 配合（内核要求）
  if ((d.reorderPercent ?? 0) > 0) {
    if (delay <= 0 && jitter <= 0) a.push('delay', '10ms');
    a.push('reorder', `${d.reorderPercent}%`, '50%');
  }

  return a;
}

async function applyNetem(
  serial: string,
  iface: string,
  params: WeakNetParams,
  hasIfb: boolean,
): Promise<{ rules: AppliedRule[]; notes: string[] }> {
  const rules: AppliedRule[] = [];
  const notes: string[] = [];

  const upArgs = netemArgs(params.up);
  const downArgs = netemArgs(params.down);
  const upRate = params.up.bandwidthMbps ?? 0;
  const downRate = params.down.bandwidthMbps ?? 0;

  /* -------- 上行（设备出方向，直接挂 root qdisc） -------- */
  if (upArgs.length || upRate > 0) {
    await runRoot(serial, `tc qdisc del dev ${iface} root 2>/dev/null`, true);

    if (upRate > 0) {
      // tbf 限速：rate / burst / latency
      const burst = Math.max(10, Math.round(upRate * 1250)); // 约 10ms 缓存
      await runRoot(
        serial,
        `tc qdisc add dev ${iface} root handle 1: tbf rate ${upRate}mbit burst ${burst}kbit latency 400ms`,
        true,
      );
      rules.push({
        kind: 'netem',
        iface,
        cleanup: [`tc qdisc del dev ${iface} root 2>/dev/null`],
      });

      if (upArgs.length) {
        await runRoot(
          serial,
          `tc qdisc add dev ${iface} parent 1:1 handle 10: netem ${upArgs.join(' ')}`,
          true,
        );
      }
    } else {
      await runRoot(
        serial,
        `tc qdisc add dev ${iface} root handle 1: netem ${upArgs.join(' ')}`,
        true,
      );
      rules.push({
        kind: 'netem',
        iface,
        cleanup: [`tc qdisc del dev ${iface} root 2>/dev/null`],
      });
    }
  }

  /* -------- 下行（入向，需要 ifb 中转） -------- */
  if (downArgs.length || downRate > 0) {
    if (!hasIfb) {
      notes.push('内核无 ifb 模块，下行参数未生效（仅上行受限）');
    } else {
      const ifb = 'ifb0';
      // 加载模块 + 拉起 ifb
      await runRoot(serial, `modprobe ifb numifbs=1 2>/dev/null`, true);
      await runRoot(serial, `ip link set ${ifb} up 2>/dev/null`, true);

      // ingress 重定向
      await runRoot(serial, `tc qdisc del dev ${iface} ingress 2>/dev/null`, true);
      await runRoot(serial, `tc qdisc add dev ${iface} handle ffff: ingress`, true);
      await runRoot(
        serial,
        `tc filter add dev ${iface} parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ${ifb}`,
        true,
      );
      rules.push({
        kind: 'ingress',
        iface,
        cleanup: [
          `tc qdisc del dev ${iface} ingress 2>/dev/null`,
          `tc qdisc del dev ${iface} handle ffff: ingress 2>/dev/null`,
        ],
      });

      await runRoot(serial, `tc qdisc del dev ${ifb} root 2>/dev/null`, true);

      if (downRate > 0) {
        const burst = Math.max(10, Math.round(downRate * 1250));
        await runRoot(
          serial,
          `tc qdisc add dev ${ifb} root handle 1: tbf rate ${downRate}mbit burst ${burst}kbit latency 400ms`,
          true,
        );
        rules.push({
          kind: 'ifb',
          iface: ifb,
          cleanup: [`tc qdisc del dev ${ifb} root 2>/dev/null`],
        });

        if (downArgs.length) {
          await runRoot(
            serial,
            `tc qdisc add dev ${ifb} parent 1:1 handle 10: netem ${downArgs.join(' ')}`,
            true,
          );
        }
      } else {
        await runRoot(
          serial,
          `tc qdisc add dev ${ifb} root handle 1: netem ${downArgs.join(' ')}`,
          true,
        );
        rules.push({
          kind: 'ifb',
          iface: ifb,
          cleanup: [`tc qdisc del dev ${ifb} root 2>/dev/null`],
        });
      }
    }
  }

  return { rules, notes };
}

/* ------------------------------------------------------------------ */
/* svc 开关网络                                                       */
/* ------------------------------------------------------------------ */

function disableNetworkCmd(): string[] {
  return ['svc wifi disable', 'svc data disable'];
}

function enableNetworkCmd(): string[] {
  return ['svc wifi enable', 'svc data enable'];
}

async function setNetworkEnabled(serial: string, enabled: boolean) {
  const cmds = enabled ? ['svc wifi enable', 'svc data enable'] : disableNetworkCmd();
  for (const c of cmds) {
    await runRoot(serial, c, true);
  }
}

/* ------------------------------------------------------------------ */
/* 兜底清理                                                            */
/* ------------------------------------------------------------------ */

async function resetAll(serial: string, iface: string, rooted: boolean) {
  const cmds = [
    `tc qdisc del dev ${iface} root 2>/dev/null`,
    `tc qdisc del dev ${iface} ingress 2>/dev/null`,
    'tc qdisc del dev ifb0 root 2>/dev/null',
    'tc qdisc del dev ifb1 root 2>/dev/null',
  ];

  if (rooted) {
    for (const c of cmds) await runRoot(serial, c, true);
  } else {
    // 无 root 时可能仍残留（之前有 root 运行过），也尝试清一次
    for (const c of cmds) await runRoot(serial, c, true);
  }

  // 确保网络是开着的（上次可能留下断网状态）
  await setNetworkEnabled(serial, true);
}

/**
 * 统一执行（自动决定是否加 su -c）
 */
async function runRoot(serial: string, cmd: string, useSu: boolean) {
  if (useSu) {
    const res = await runAdb(['-s', serial, 'shell', `su -c "${escapeForSu(cmd)}"`], {
      silent: true,
      timeout: 15000,
    });
    if (!res.ok && /not found|permission|denied/i.test(res.stderr + res.stdout)) {
      // su 不可用时退回普通 shell
      await runAdb(['-s', serial, 'shell', cmd], { silent: true, timeout: 15000 });
    }
    return res;
  }
  return runAdb(['-s', serial, 'shell', cmd], { silent: true, timeout: 15000 });
}

function escapeForSu(cmd: string): string {
  return cmd.replace(/"/g, '\\"');
}

/* ------------------------------------------------------------------ */
/* 预设持久化                                                          */
/* ------------------------------------------------------------------ */

const BUILTIN_PRESETS: WeakNetPreset[] = [
  {
    id: 'builtin-2g',
    name: '2G 弱网',
    builtin: true,
    createdAt: 0,
    params: {
      up: { bandwidthMbps: 0.25, delayMs: 500, jitterMs: 100, lossPercent: 2 },
      down: { bandwidthMbps: 0.25, delayMs: 500, jitterMs: 100, lossPercent: 2 },
      durationSec: 60,
    },
  },
  {
    id: 'builtin-3g',
    name: '3G 普通',
    builtin: true,
    createdAt: 0,
    params: {
      up: { bandwidthMbps: 1, delayMs: 200, jitterMs: 40, lossPercent: 1 },
      down: { bandwidthMbps: 1.5, delayMs: 200, jitterMs: 40, lossPercent: 1 },
      durationSec: 60,
    },
  },
  {
    id: 'builtin-4g-weak',
    name: '4G 抖动',
    builtin: true,
    createdAt: 0,
    params: {
      up: { bandwidthMbps: 4, delayMs: 80, jitterMs: 60, lossPercent: 3, corruptPercent: 0.5 },
      down: { bandwidthMbps: 8, delayMs: 80, jitterMs: 60, lossPercent: 3, corruptPercent: 0.5 },
      durationSec: 60,
    },
  },
  {
    id: 'builtin-loss',
    name: '高丢包（地铁/电梯）',
    builtin: true,
    createdAt: 0,
    params: {
      up: { lossPercent: 15, delayMs: 150, jitterMs: 80 },
      down: { lossPercent: 15, delayMs: 150, jitterMs: 80 },
      durationSec: 60,
    },
  },
  {
    id: 'builtin-corrupt',
    name: '错误包（弱信号抓包）',
    builtin: true,
    createdAt: 0,
    params: {
      up: { corruptPercent: 5, lossPercent: 2, reorderPercent: 2 },
      down: { corruptPercent: 5, lossPercent: 2, reorderPercent: 2 },
      durationSec: 60,
    },
  },
  {
    id: 'builtin-offline',
    name: '完全断网',
    builtin: true,
    createdAt: 0,
    params: {
      up: {},
      down: {},
      durationSec: 30,
      blockNetwork: true,
    },
  },
];

function presetFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'weaknet-presets.json');
}

export function listPresets(): WeakNetPreset[] {
  let user: WeakNetPreset[] = [];
  try {
    const f = presetFile();
    if (existsSync(f)) {
      const parsed = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(parsed)) user = parsed;
    }
  } catch {
    user = [];
  }
  return [...BUILTIN_PRESETS, ...user];
}

export function savePreset(name: string, params: WeakNetParams): WeakNetPreset[] {
  const clean = (name || '').trim();
  if (!clean) throw new Error('预设名称不能为空');

  const list = listPresets().filter((p) => !p.builtin);
  const idx = list.findIndex((p) => p.name === clean);
  const item: WeakNetPreset = {
    id: idx >= 0 ? list[idx].id : randomUUID(),
    name: clean,
    params,
    builtin: false,
    createdAt: idx >= 0 ? list[idx].createdAt : Date.now(),
  };
  if (idx >= 0) list[idx] = item;
  else list.push(item);

  writeFileSync(presetFile(), JSON.stringify(list, null, 2), 'utf8');
  log('success', '弱网', `已保存预设「${clean}」`);
  return listPresets();
}

export function deletePreset(id: string): WeakNetPreset[] {
  const list = listPresets().filter((p) => !p.builtin && p.id !== id);
  writeFileSync(presetFile(), JSON.stringify(list, null, 2), 'utf8');
  return listPresets();
}
