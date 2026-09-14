import { randomUUID } from 'crypto';
import { runAdb, ensureDevice, log } from './adb';
import {
  getShapingProxyPort,
  getShapingStats,
  isShapingProxyRunning,
  setShapingParams,
  startShapingProxy,
  stopShapingProxy,
} from './proxy-shaping';
import type {
  WeakNetDirectionParams,
  WeakNetMode,
  WeakNetParams,
  WeakNetPreset,
  WeakNetProxyInfo,
  WeakNetStatus,
} from '../../shared/types';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

/**
 * 弱网模拟（对标 clumsy）
 *
 * 三条技术路线，按设备能力与用户选择自动切换：
 *
 *   ① tc + netem（保真度最高，**需要 Root**）
 *      `tc qdisc add dev <iface> root netem delay 100ms 20ms loss 3% corrupt 1%`
 *      入向流量需要挂 ifb 虚拟网卡 + ingress 重定向才能真正生效：
 *        tc qdisc add dev <iface> handle ffff: ingress
 *        tc filter add dev <iface> parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0
 *        tc qdisc add dev ifb0 root netem ...
 *      这是 clumsy 在 Windows 上的同构做法，参数语义一一对应。
 *
 *   ② 本地代理（**免 Root**，v1.0.1 新增，未 Root 设备的主力方案）
 *      adb reverse tcp:P tcp:P  +  settings put global http_proxy 127.0.0.1:P
 *      设备的 HTTP/HTTPS 流量经 USB 通道打到电脑上的代理，由代理注入延迟、
 *      带宽、丢包等参数。这两个环节都不需要 Root。
 *      实现见 services/proxy-shaping.ts（丢包/乱序/重复在应用层做等效近似）。
 *
 *   ③ svc wifi/data（最低保底）
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
  /** 代理模式：设备侧代理地址与生效状态，回滚时用于确认清干净 */
  proxy?: WeakNetProxyInfo;
  /** 代理模式：统计推送定时器（UI 需要看到实时连接数与流量） */
  statsTimer?: NodeJS.Timeout | null;
  note?: string;
}

interface AppliedRule {
  kind: 'netem' | 'ingress' | 'ifb' | 'svc';
  iface: string;
  /** 对应的还原命令 */
  cleanup: string[];
}

let session: Session | null = null;

/* ------------------------------------------------------------------ */
/* 崩溃恢复标记                                                        */
/* ------------------------------------------------------------------ */

/**
 * 会话标记文件。
 *
 * 弱网模拟会**改变设备的状态**（全局代理、网络开关、tc 规则），
 * 如果程序被强杀（任务管理器结束进程 / 断电），这些改动就没人回收了 ——
 * 用户会遇到「手机突然上不了网」这种最难排查的问题。
 *
 * 所以只要会话生效，就落一个标记；正常停止时删掉。下次启动若发现标记还在，
 * 说明上次是异常退出，直接按标记把设备恢复干净。
 * （单实例锁保证了不会有两个进程同时跑，所以标记残留 = 上次真的崩了。）
 */
interface SessionMarker {
  serial: string;
  mode: WeakNetMode;
  proxyPort?: number;
  blockedNetwork?: boolean;
  iface?: string;
  startedAt: number;
}

function markerFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'weaknet-session.json');
}

function writeMarker(ctx: Session) {
  const m: SessionMarker = {
    serial: ctx.serial,
    mode: ctx.mode,
    iface: ctx.iface,
    startedAt: ctx.startedAt,
    blockedNetwork: ctx.mode === 'svc' || !!ctx.params.blockNetwork,
    proxyPort: ctx.proxy?.port,
  };
  try {
    writeFileSync(markerFile(), JSON.stringify(m, null, 2), 'utf8');
  } catch {
    /* 落盘失败不影响功能，只是失去崩溃恢复能力 */
  }
}

function clearMarker() {
  try {
    const f = markerFile();
    if (existsSync(f)) unlinkSync(f);
  } catch {
    /* ignore */
  }
}

/**
 * 启动时调用：若上次异常退出留下了标记，按标记把设备恢复干净。
 * 返回给日志看的描述；没有残留则返回 null。
 */
export async function recoverStaleSession(): Promise<string | null> {
  let m: SessionMarker | null = null;
  try {
    const f = markerFile();
    if (!existsSync(f)) return null;
    m = JSON.parse(readFileSync(f, 'utf8')) as SessionMarker;
  } catch {
    clearMarker();
    return null;
  }
  if (!m?.serial) {
    clearMarker();
    return null;
  }

  const s = m.serial;
  const done: string[] = [];

  try {
    // 1) 代理残留：先撤代理设置，再断 reverse
    if (m.proxyPort) {
      await runAdb(['-s', s, 'shell', 'settings', 'delete', 'global', 'http_proxy'], {
        silent: true,
        timeout: 8000,
      });
      await runAdb(['-s', s, 'reverse', '--remove', `tcp:${m.proxyPort}`], {
        silent: true,
        timeout: 8000,
      });
      await stopShapingProxy();
      done.push(`已清除设备代理 127.0.0.1:${m.proxyPort}`);
    }

    // 2) 上次是断网模式：把网络开回来
    if (m.blockedNetwork) {
      await setNetworkEnabled(s, true);
      done.push('已恢复 WiFi / 移动数据');
    }

    // 3) tc 规则兜底清理
    if (m.iface) await resetAll(s, m.iface, false);
  } catch {
    /* 设备可能已经拔掉了 —— 标记照样清掉，避免下次启动反复尝试 */
  }

  clearMarker();
  return done.length ? `检测到上次弱网会话异常退出，已自动恢复：${done.join('；')}` : null;
}

/** 当前是否有生效中的弱网会话（退出前清理用） */
export function hasActiveWeakNetSession(): boolean {
  return !!session;
}

/** 给用户看的模式名称 */
const MODE_LABEL: Record<WeakNetMode, string> = {
  tc: 'tc/netem 内核级',
  proxy: '本地代理（免 Root）',
  svc: '开关网络',
  none: '未生效',
};

type StatusSink = (status: WeakNetStatus) => void;
let statusSink: StatusSink | null = null;

export function setWeakNetStatusSink(sink: StatusSink) {
  statusSink = sink;
}

function emitStatus() {
  statusSink?.(getWeakNetStatus());
}

/**
 * 代理模式的心跳。
 *
 * 两种职责：
 *   1) 定时把实时统计推给界面（连接数 / 上下行流量）
 *   2) **手动向导模式下轮询设备上的代理值** ——
 *      受限 ROM 不让 adb 写设置，只能等用户到 WLAN 界面手填；
 *      这里每秒读一次，读到地址一致就自动点亮「已生效」，不需要用户点任何按钮。
 */
let ticking = false;
async function tickProxy() {
  const ctx = session;
  if (!ctx || ctx.mode !== 'proxy' || !ctx.proxy) return;

  if (!ctx.proxy.manual || ctx.proxy.active) {
    emitStatus();
    return;
  }
  if (ticking) return;
  ticking = true;

  try {
    const r = await runAdb(['-s', ctx.serial, 'shell', 'settings', 'get', 'global', 'http_proxy'], {
      silent: true,
      timeout: 6000,
    });
    // 会话可能在等待期间被停掉了
    if (session !== ctx) return;

    const got = r.stdout.trim();
    ctx.proxy.current = got && got !== 'null' ? got : null;
    const addr = `${ctx.proxy.host}:${ctx.proxy.port}`;

    if (got === addr) {
      ctx.proxy.active = true;
      ctx.note = `代理已生效：设备 HTTP/HTTPS 流量 → ${addr} → 电脑代理（识别到你手动设置的代理）`;
      log('success', '弱网', '检测到设备上手动设置的代理，弱网注入已开始');
    } else if (ctx.proxy.current) {
      // 用户配了别的代理 —— 如实说明，绝不假装生效
      ctx.note = `设备当前代理是「${ctx.proxy.current}」，不是本工具需要的 ${addr} —— 请改成 ${addr}`;
    } else {
      ctx.note = `代理服务已就绪，等待你在设备上设置代理：${addr}（设置 → WLAN → 修改网络 → 高级 → 代理 → 手动）`;
    }
  } catch {
    /* 单次读取失败不影响会话 */
  } finally {
    ticking = false;
    emitStatus();
  }
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
    proxy: session.proxy,
    stats: session.mode === 'proxy' ? getShapingStats() : undefined,
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
  /** 本地代理模式：不需要任何设备侧能力，恒为 true */
  hasProxy: boolean;
  /**
   * 是否能用 adb 自动写入系统全局代理。
   *
   * 不是所有 ROM 都允许：AOSP / 多数机型上 `settings put global` 可用，
   * 但 ColorOS 等定制 ROM 直接把 com.android.shell 的写权限屏蔽了
   * （任何 global 键都写不了，报 SecurityException）。
   * 这里**实测**一次写读删，而不是猜。
   * false 时代理模式退化到「手动向导」。
   */
  canWriteSettings: boolean;
  /** 设备当前设置的全局 HTTP 代理，null 表示未设置 */
  httpProxy: string | null;
  sdk?: number;
  note: string;
}

export async function probeDevice(serial: string | undefined): Promise<ProbeResult> {
  const s = await ensureDevice(serial);

  const [rootRes, tcRes, ifbRes, ifaceRes, procNetRes, sdkRes, proxyRes] = await Promise.all([
    runAdb(['-s', s, 'shell', 'su', '-c', 'id'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'which', 'tc'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'ls', '/sys/module/ifb'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'ip', '-o', 'link', 'show'], { silent: true, timeout: 8000 }),
    // 兜底：ColorOS / MIUI 等精简 ROM 常常没有 ip 命令，/proc/net/dev 一定存在
    runAdb(['-s', s, 'shell', 'cat', '/proc/net/dev'], { silent: true, timeout: 8000 }),
    runAdb(['-s', s, 'shell', 'getprop', 'ro.build.version.sdk'], { silent: true, timeout: 8000 }),
    // 读当前的全局代理设置 —— 用于识别上一次会话残留（改了代理却没恢复会让人断网）
    runAdb(['-s', s, 'shell', 'settings', 'get', 'global', 'http_proxy'], {
      silent: true,
      timeout: 8000,
    }),
  ]);

  const canWriteSettings = await probeWriteSettings(s);

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

  const rawProxy = proxyRes.stdout.trim();
  const httpProxy = rawProxy && rawProxy !== 'null' ? rawProxy : null;

  // 注意：现在未 Root 也有可用方案了 —— 本地代理不需要任何设备侧权限
  let note: string;
  if (rooted && hasTc) {
    note = hasIfb
      ? '已 Root 且内核支持 tc/netem：上下行均可精细控制（保真度最高）'
      : '已 Root，但内核无 ifb 模块：下行（入向）参数可能不生效，建议改用本地代理模式';
  } else if (canWriteSettings) {
    note = '未 Root：将使用「本地代理」模式，无需 Root 即可生效，覆盖 HTTP/HTTPS 流量';
  } else {
    note =
      '未 Root，且该 ROM 禁止 adb 写系统设置（ColorOS 等定制 ROM 常见）——' +
      '代理服务可正常启动，但需要你到 WLAN 设置里手动填一次代理地址（界面会给出）';
  }

  return {
    rooted,
    hasTc,
    hasIfb,
    iface,
    ifaces,
    hasSvc: true,
    hasProxy: true,
    canWriteSettings,
    httpProxy,
    sdk: Number.isFinite(sdk) ? sdk : undefined,
    note,
  };
}

/**
 * 实测能否用 adb 写系统 global 设置。
 *
 * 为什么不直接信 `settings put` 的退出码：coloros 等 ROM 会让命令返回 0 但内容没写进去，
 * 也可能直接抛 SecurityException。所以策略是「写一个探针键 → 读回 → 删掉」，
 * 读回值对得上才算通过。探针键用一次性的随机名，不留任何痕迹。
 */
async function probeWriteSettings(serial: string): Promise<boolean> {
  const key = `wt_probe_${Date.now().toString(36)}`;
  const val = 'ok';
  try {
    const put = await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', key, val], {
      silent: true,
      timeout: 8000,
    });
    if (/SecurityException|Permission denial|denied/i.test(put.stderr + put.stdout)) return false;

    const get = await runAdb(['-s', serial, 'shell', 'settings', 'get', 'global', key], {
      silent: true,
      timeout: 8000,
    });
    // 无论成败都尝试清掉探针键
    await runAdb(['-s', serial, 'shell', 'settings', 'delete', 'global', key], {
      silent: true,
      timeout: 8000,
    });

    return get.stdout.trim() === val;
  } catch {
    return false;
  }
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

  // 先清掉上一次可能残留的 tc 规则，避免叠加。
  // 注意**不动网络开关**：把用户手动关掉的 WiFi 打开属于越权副作用。
  // 断网模式的崩溃恢复由 recoverStaleSession() 在启动时按标记处理。
  await resetAll(s, iface, false);

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

  /* ---------- 选择技术路线 ---------- */
  const engine = params.engine || 'auto';
  const canTc = probe.rooted && probe.hasTc;
  let useProxy: boolean;
  if (params.blockNetwork) useProxy = false; // 断网交给 svc
  else if (engine === 'proxy') useProxy = true;
  else if (engine === 'svc') useProxy = false;
  else if (engine === 'tc') useProxy = !canTc; // 强制 tc 但设备不支持时退回代理
  else useProxy = !canTc; // auto：能 tc 就 tc，否则用代理

  /* ---------- ① 整体断网：直接开关网络 ---------- */
  if (params.blockNetwork) {
    await setNetworkEnabled(s, false);
    ctx.mode = 'svc';
    ctx.applied.push({
      kind: 'svc',
      iface,
      cleanup: enableNetworkCmd(),
    });
    ctx.note = '网络已整体关闭（svc wifi/data disable），所有流量中断';
  } else if (useProxy) {
    /* ---------- ② 本地代理（免 Root，v1.0.1 主力方案） ---------- */
    const port = await startShapingProxy();
    setShapingParams(params);
    ctx.proxy = {
      host: '127.0.0.1',
      port,
      reversed: false,
      active: false,
      manual: !probe.canWriteSettings,
      manualAddress: `127.0.0.1:${port}`,
      current: probe.httpProxy,
    };

    try {
      // (1) 把设备的 loopback 端口反打到电脑。
      //     走 USB 通道，既不依赖同网段，也不受 WiFi AP 隔离影响（实测同网段直连会被 AP 隔离）。
      const rev = await runAdb(['-s', s, 'reverse', `tcp:${port}`, `tcp:${port}`], {
        silent: true,
        timeout: 10000,
      });
      if (!rev.ok) {
        throw new Error(`adb reverse 未建立：${(rev.stderr || rev.stdout || '').trim() || '未知原因'}`);
      }
      ctx.proxy.reversed = true;

      const addr = `127.0.0.1:${port}`;

      if (probe.canWriteSettings) {
        // (2) 设置全局 HTTP 代理 —— AOSP / 多数机型可用
        await runAdb(['-s', s, 'shell', 'settings', 'put', 'global', 'http_proxy', addr], {
          silent: true,
          timeout: 10000,
        });

        // (3) 必须读回确认。写失败却报成功是最坏的情况（用户以为生效了其实没有）
        const back = await runAdb(
          ['-s', s, 'shell', 'settings', 'get', 'global', 'http_proxy'],
          { silent: true, timeout: 8000 },
        );
        const got = back.stdout.trim();
        if (got !== addr) {
          throw new Error(
            `代理未写入（期望 ${addr}，读回「${got || '空'}」）——设备可能禁用了 secure settings 写入`,
          );
        }
        ctx.proxy.active = true;
      } else {
        // (4) ROM 拦住了自动写入：通道就绪，等用户到 WLAN 设置里手填。
        //     代理服务与 reverse 都保持运行，用户一填好就能直接用上，不需要重启会话。
        //     如果设备上本来就配着我们要的地址（上次手动设完没清），直接算生效。
        ctx.proxy.active = probe.httpProxy === addr;
      }
    } catch (e) {
      // 任何一环没打通就整体回滚，绝不留下「半生效」状态
      await cleanupProxy(s, ctx.proxy);
      await stopShapingProxy();
      throw e;
    }

    ctx.mode = 'proxy';
    ctx.note = ctx.proxy.active
      ? `代理已生效：设备 HTTP/HTTPS 流量 → 127.0.0.1:${port} → 电脑代理`
      : `代理服务已就绪，但本机 ROM 禁止 adb 写系统设置 —— 请到「设置 → WLAN → 修改网络 → 高级 → 代理（手动）」填 ${ctx.proxy.manualAddress}，填好后自动开始注入`;

    // 代理模式要暴露实时统计（连接数 / 流量），UI 每秒刷新一次。
    // 手动向导模式顺带轮询设备上的代理值，用户填好就能自动"点亮"。
    ctx.statsTimer = setInterval(() => {
      void tickProxy();
    }, 1000);
    ctx.statsTimer.unref?.();
  } else if (canTc) {
    /* ---------- ③ tc/netem 精细控制 ---------- */
    const { rules, notes } = await applyNetem(s, iface, params, probe.hasIfb);
    ctx.applied = rules;
    ctx.mode = 'tc';
    if (notes.length) ctx.note = notes.join('；');
  } else {
    // 两条路都走不通：只有丢包 100% 这种极端值还能用「断网」近似
    const upLoss = params.up.lossPercent ?? 0;
    const downLoss = params.down.lossPercent ?? 0;
    if (upLoss >= 100 || downLoss >= 100) {
      await setNetworkEnabled(s, false);
      ctx.mode = 'svc';
      ctx.applied.push({ kind: 'svc', iface, cleanup: enableNetworkCmd() });
      ctx.note = '丢包率设为 100%，已按「整体断网」处理';
    } else {
      ctx.mode = 'none';
      ctx.note = '无法应用弱网参数：设备不支持 tc 且本地代理未建立，请检查 USB 连接。';
      session = ctx;
      clearMarker();
      emitStatus();
      log('warn', '弱网', ctx.note);
      return getWeakNetStatus();
    }
  }

  session = ctx;
  // 落标记：万一程序被强杀，下次启动能自动把设备恢复干净
  writeMarker(ctx);

  // 限时自动停止
  if (params.durationSec > 0) {
    ctx.timer = setTimeout(() => {
      log('info', '弱网', `已达设定时长 ${params.durationSec}s，自动恢复网络`);
      void stopWeakNet();
    }, params.durationSec * 1000);
  }

  log('success', '弱网', `已生效（${MODE_LABEL[ctx.mode]}）`);
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
  if (ctx.statsTimer) {
    clearInterval(ctx.statsTimer);
    ctx.statsTimer = null;
  }

  // 代理模式：先撤设备侧的代理与 reverse，再关掉本地代理服务
  if (ctx.mode === 'proxy') {
    const left = await cleanupProxy(ctx.serial, ctx.proxy);
    await stopShapingProxy();
    if (left) {
      // 受限 ROM 上 `settings delete` 也会被拦，只能提醒用户自己去关 ——
      // 不提醒的话设备会一直指着一个已经关掉的代理端口，表现成"突然上不了网"
      log(
        'warn',
        '弱网',
        `设备上的代理设置（${left}）无法通过 adb 清除（本机 ROM 限制），` +
          '请到「设置 → WLAN → 修改网络 → 高级 → 代理」改回「无」，否则设备将无法上网',
      );
    } else {
      log('info', '弱网', '已移除设备代理并停止本地代理服务');
    }
  }

  // 逆序回滚 tc/svc 规则
  for (const rule of [...ctx.applied].reverse()) {
    for (const cmd of rule.cleanup) {
      try {
        await runRoot(ctx.serial, cmd, ctx.rooted);
      } catch {
        /* 单条失败不中断 */
      }
    }
  }

  // 兜底清理 tc 残留。只有确实是我们关过网络时才去开网络，
  // 否则会把用户手动关掉的 WiFi 打开 —— 属于越权副作用。
  const restoreNetwork = ctx.mode === 'svc' || !!ctx.params.blockNetwork;
  await resetAll(ctx.serial, ctx.iface, restoreNetwork);

  // 设备已恢复干净，标记可以删了
  clearMarker();

  log('info', '弱网', '已恢复网络');
  emitStatus();
  return getWeakNetStatus();
}

/**
 * 清掉设备侧的代理设置与 reverse 通道。
 *
 * 顺序很重要：**先撤代理设置，再断 reverse，最后才关本地代理**。
 * 反过来的话，中间会有一小段时间设备把流量发向已经关闭的端口。
 *
 * 返回值：若设备上仍残留代理（ROM 禁止 adb 清设置），返回残留值，否则返回 null。
 */
async function cleanupProxy(
  serial: string,
  proxy?: WeakNetProxyInfo,
): Promise<string | null> {
  await runAdb(['-s', serial, 'shell', 'settings', 'delete', 'global', 'http_proxy'], {
    silent: true,
    timeout: 10000,
  });

  if (proxy?.reversed) {
    await runAdb(['-s', serial, 'reverse', '--remove', `tcp:${proxy.port}`], {
      silent: true,
      timeout: 10000,
    });
  } else {
    // 不确定端口时兜底全清，避免残留映射让后续排查困惑
    await runAdb(['-s', serial, 'reverse', '--remove-all'], { silent: true, timeout: 10000 });
  }

  // 读回确认 —— 拦截 ROM 上 delete 会失败，必须如实上报给用户
  const back = await runAdb(['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy'], {
    silent: true,
    timeout: 8000,
  });
  const left = back.stdout.trim();
  return left && left !== 'null' ? left : null;
}

/**
 * 清理设备上可能残留的代理设置（上次异常退出没恢复干净时使用）。
 * 返回清理前的值，供 UI 提示用户。
 */
export async function cleanupStaleProxy(
  serial: string | undefined,
): Promise<{ before: string | null; cleaned: boolean; left?: string | null }> {
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'settings', 'get', 'global', 'http_proxy'], {
    silent: true,
    timeout: 8000,
  });
  const raw = res.stdout.trim();
  const before = raw && raw !== 'null' ? raw : null;

  if (!before) return { before: null, cleaned: false };

  const left = await cleanupProxy(s);
  await stopShapingProxy();
  clearMarker();

  if (left) {
    log(
      'warn',
      '弱网',
      `设备残留代理（${left}）无法通过 adb 清除（本机 ROM 限制），请到「设置 → WLAN → 修改网络 → 高级 → 代理」改回「无」`,
    );
    return { before, cleaned: false, left };
  }

  log('info', '弱网', `已清理设备上残留的代理设置（${before}）`);
  return { before, cleaned: true };
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

/**
 * 兜底清理 tc 残留规则。
 *
 * restoreNetwork 只在「确实是我们关掉了网络」时才置 true ——
 * 无脑把网络打开会覆盖用户手动关闭的 WiFi，属于越权副作用。
 */
async function resetAll(serial: string, iface: string, restoreNetwork = false) {
  const cmds = [
    `tc qdisc del dev ${iface} root 2>/dev/null`,
    `tc qdisc del dev ${iface} ingress 2>/dev/null`,
    'tc qdisc del dev ifb0 root 2>/dev/null',
    'tc qdisc del dev ifb1 root 2>/dev/null',
  ];
  // 无 root 时也照跑一遍：设备可能被 Root 环境改过，残留规则会一直挂着
  for (const c of cmds) await runRoot(serial, c, true);

  if (restoreNetwork) await setNetworkEnabled(serial, true);
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
