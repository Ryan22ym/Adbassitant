import { randomUUID } from 'crypto';
import { runAdb, ensureDevice, log, binDir } from './adb';
import { getShapingStats, setShapingParams, startShapingProxy, stopShapingProxy } from './proxy-shaping';
import {
  VPN_PKG,
  VPN_CONTROL_PORT,
  findVpnApk,
  getVpnAppInfo,
  queryVpnState,
  recoverStaleVpn,
  setVpnTickSink,
  startVpn,
  stopVpn,
} from './weaknet-vpn';
import type {
  WeakNetDirectionParams,
  WeakNetMode,
  WeakNetParams,
  WeakNetPreset,
  WeakNetProxyInfo,
  WeakNetStats,
  WeakNetStatus,
  WeakNetVpnInfo,
} from '../../shared/types';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

/**
 * 弱网模拟（对标 clumsy）
 *
 * 四条技术路线，按设备能力与用户选择自动切换：
 *
 *   ⓪ VPN + 配套 App（**v2 首选**，免 Root，IP 层全量整形）
 *      在设备上装一个配套 App，由它用 Android `VpnService` 建 tun 接管
 *      0.0.0.0/0 的全部流量，在 **IP 层**逐包做延迟/丢包/错报/乱序/限速。
 *      电脑侧通过 `adb forward` 用 HTTP 指挥它（见 services/weaknet-vpn.ts）。
 *
 *      为什么它取代代理成为首选：代理只管得到「愿意读系统 HTTP 代理」的 App，
 *      大量 App 直接绕过 → 用户会看到「设了弱网但没变化」。VPN 是全量接管，
 *      没有应用能绕开；而且 IP 层能真丢包、真乱序（TCP 负责重传重排），
 *      不像字节流层只能做「队头阻塞」近似。
 *
 *   ① tc + netem（保真度最高，**需要 Root**）
 *      `tc qdisc add dev <iface> root netem delay 100ms 20ms loss 3% corrupt 1%`
 *      入向流量需要挂 ifb 虚拟网卡 + ingress 重定向才能真正生效：
 *        tc qdisc add dev <iface> handle ffff: ingress
 *        tc filter add dev <iface> parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0
 *        tc qdisc add dev ifb0 root netem ...
 *      这是 clumsy 在 Windows 上的同构做法，参数语义一一对应。
 *
 *   ② 本地代理（**免 Root**，v1.0.1 引入，现作为 VPN 不可用时的回退）
 *      adb reverse tcp:P tcp:P  +  settings put global http_proxy 127.0.0.1:P
 *      设备的 HTTP/HTTPS 流量经 USB 通道打到电脑上的代理，由代理注入延迟、
 *      带宽、丢包等参数。这两个环节都不需要 Root。
 *      实现见 services/proxy-shaping.ts（丢包/乱序/重复在应用层做等效近似）。
 *
 *      ⚠️ 代理设置的**读 / 写 / 清**都必须走下方「设备全局代理状态」那段里的
 *      成套 helper，不能直接摸 `http_proxy`。Android 8+ 把它拆成了遗留别名 +
 *      真身三件套两套键，只认别名会漏判残留、清理删到空气，最终把设备搞成
 *      「ping 通但所有 App 都上不了网」。详见那段注释里的事故复盘。
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
  /** VPN 模式：设备侧 App 与授权状态（UI 展示用） */
  vpn?: WeakNetVpnInfo;
  /** 代理模式：统计推送定时器（UI 需要看到实时连接数与流量） */
  statsTimer?: NodeJS.Timeout | null;
  /** VPN 模式：心跳定时器（兼作统计推送） */
  vpnTimer?: NodeJS.Timeout | null;
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
  /** VPN 模式：控制端口，用于下次启动撤掉残留的 forward 映射 */
  vpnPort?: number;
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
    vpnPort: ctx.vpn?.port,
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
    // 0) VPN 残留：撤掉上次留下的 forward 映射，并确认设备侧隧道已关。
    //    与代理残留相比这个危害小得多 —— 设备侧有 15s 心跳超时会自停，
    //    最坏情况是 VPN 多开了十几秒，网络会自动恢复；这里只是收个尾。
    if (m.vpnPort || m.mode === 'vpn') {
      const msg = await recoverStaleVpn(s);
      if (msg) done.push(msg);
    }

    // 1) 代理残留：先撤代理设置，再断 reverse
    if (m.proxyPort) {
      // 走统一的成套清理（put :0 触发内存态刷新 + 清真身四键）。
      // 这里**不能**只 `delete global http_proxy`：那一下只删掉别名（`Deleted 1 rows`），
      // 真身 `global_http_proxy_host/port` 全留着 → 设备带着残留代理一直断网。
      const left = await cleanupProxy(s, { port: m.proxyPort, reversed: true });
      await stopShapingProxy();
      done.push(
        left
          ? `设备代理残留未清干净（${left}），请到 WLAN 设置里把代理改回「无」`
          : `已清除设备代理 127.0.0.1:${m.proxyPort}`,
      );
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

/**
 * 参数热更新后同步会话里的副本。
 *
 * 为什么需要：`getWeakNetStatus()` 返回的是 `session.params`，而热更新走的是
 * VPN 引擎的控制通道 —— 只改了设备侧，电脑侧这份副本还是旧值。
 * 不同步的话界面上的滑块会"弹回"原值，看起来像没生效。
 */
export function touchSessionParams(params: WeakNetParams) {
  if (!session) return;
  session.params = params;
  // 剩余时长跟着新参数重算，否则改了时长界面不动
  if (params.durationSec > 0) {
    session.startedAt = Date.now();
  }
  emitStatus();
}

/** 给用户看的模式名称 */
const MODE_LABEL: Record<WeakNetMode, string> = {
  vpn: 'VPN 全量整形（免 Root）',
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

// VPN 引擎内部也会触发状态变更（心跳发现设备侧停了、参数热更新等），
// 让它直接走同一个出口，保证界面看到的永远是同一份状态。
setVpnTickSink(emitStatus);

/**
 * 主动触发一次设备上的 VPN 授权弹框（界面上的「去授权」按钮用）。
 *
 * 单独暴露出来是因为有个尴尬场景：用户第一次点「开始」→ 弹框被他不小心
 * 划掉了 → 界面停在"等待授权"。这时候得能再弹一次，而不是让他重走一遍开始。
 */
export async function requestVpnAuthorize(serial: string | undefined): Promise<boolean> {
  const s = await ensureDevice(serial);
  const { requestVpnAuthorization } = await import('./weaknet-vpn');

  // 通道可能还没建（用户没点开始就来点授权）—— 先建一个临时的
  const already = await queryVpnState(VPN_CONTROL_PORT);
  if (!already) {
    await runAdb(['-s', s, 'forward', `tcp:${VPN_CONTROL_PORT}`, `tcp:${VPN_CONTROL_PORT}`], {
      silent: true,
      timeout: 8000,
    });
    // 拉起 App 主进程（它才会开控制端口）
    await runAdb(
      ['-s', s, 'shell', 'monkey', '-p', VPN_PKG, '-c',
        'android.intent.category.LAUNCHER', '1'],
      { silent: true, timeout: 10_000 },
    );
    // 给 App 一点时间起端口；起不来也照样试着发授权指令
    for (let i = 0; i < 12; i++) {
      const st = await queryVpnState(VPN_CONTROL_PORT);
      if (st) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  return requestVpnAuthorization(s);
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
    // 读全套键并归一化：用户手填后系统同样可能把别名迁移成真身
    const st = await readGlobalProxyState(ctx.serial);
    // 会话可能在等待期间被停掉了
    if (session !== ctx) return;

    const got = st.effective;
    ctx.proxy.current = got;
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

/**
 * VPN 心跳：从设备侧拉真实状态与统计，刷新会话备注后推给界面。
 *
 * 与 tickProxy 分开是因为两件事的语义不同 —— VPN 的状态是**设备侧说了算**
 * （它以 15s 心跳超时自立门户，见 weaknet-vpn.ts），我们只是搬运工；
 * 代理是电脑侧说了算。混在一起会写出"两边都以为自己是对的"的代码。
 */
let vpnTicking = false;
async function tickVpnSession() {
  const ctx = session;
  if (!ctx || ctx.mode !== 'vpn' || !ctx.vpn) return;
  if (vpnTicking) return;
  vpnTicking = true;
  try {
    const st = await queryVpnState(ctx.vpn.port);
    if (session !== ctx) return;
    if (!st) {
      ctx.vpn.reachable = false;
      ctx.note = '与设备侧控制通道失联 —— 若持续如此，设备会在 15s 后自动恢复网络';
    } else {
      ctx.vpn.reachable = true;
      ctx.vpn.authorized = st.authorized;
      ctx.note = st.note || ctx.note;
      if (st.stats) vpnStats = st.stats;
    }
  } catch {
    /* 单次失败不影响会话 */
  } finally {
    vpnTicking = false;
    emitStatus();
  }
}

/** 设备侧回报的最新统计（VPN 模式用） */
let vpnStats: WeakNetStats | undefined;

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
    vpn: session.vpn,
    stats: session.mode === 'proxy' ? getShapingStats() : vpnStats,
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
  /* ---------- VPN 相关（v2 首选方案） ---------- */
  /** 设备上是否已安装随包配套 App */
  hasVpnApp: boolean;
  /** 已装 App 的 versionCode */
  vpnAppVersion?: number | null;
  /**
   * VPN 是否已获系统授权。
   *
   * 只在 App 已装且能握上手时才能读到真实值；未装 / 通道不通时为 null
   * （表示"未知"，与 false"明确未授权"要区分开，前者不该催用户去点确定）。
   */
  vpnAuthorized: boolean | null;
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
    // 读当前的全局代理设置 —— 用于识别上一次会话残留（改了代理却没恢复会让人断网）。
    // 必须读 `settings list global` 拿全量，只读 `http_proxy` 会漏掉真身
    // `global_http_proxy_host/port`（别名可能已被系统迁移清空）。
    runAdb(['-s', s, 'shell', 'settings', 'list', 'global'], { silent: true, timeout: 8000 }),
  ]);

  const canWriteSettings = await probeWriteSettings(s);

  // VPN 首选方案：并行探一下配套 App 与授权态。
  // 不阻塞主线 —— 装没装 App 都不影响 tc / 代理两条老路线的可用性。
  const [vpnApp, vpnAuth] = await Promise.all([
    getVpnAppInfo(s).catch(() => ({ installed: false, versionCode: null })),
    probeVpnAuthorized(s).catch(() => null),
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

  // 归一化成「系统实际生效的代理地址」，UI 直接展示这个值
  const proxyState = parseGlobalProxyState(proxyRes.stdout);
  const httpProxy = proxyState.effective;

  // 探测结论：**VPN 是首选**，其余按能力排。
  // 这里只在「同一次探测里」给最合理的默认建议，真正的引擎选择在 startWeakNet。
  let note: string;
  if (vpnApp.installed && vpnAuth === true) {
    note = '配套 App 已安装且已授权：将使用 VPN 模式（IP 层全量整形，免 Root，覆盖所有 App）';
  } else if (vpnApp.installed) {
    note = '配套 App 已安装但尚未授权 VPN：首次开始时会弹出系统授权框，在手机上点「确定」即可';
  } else {
    note = '设备上未安装配套 App：开始时会自动安装（随包 APK），安装后在手机上点一次「确定」授权';
  }
  if (!vpnApp.installed && !canWriteSettings && !rooted) {
    // 老方案在这种设备上只能走「手动向导」，所以额外说明一句 VPN 的收益
    note += '。该机 ROM 禁止 adb 写代理设置，旧方案需手动填代理 —— 用 VPN 模式可免去这一步';
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
    hasVpnApp: vpnApp.installed,
    vpnAppVersion: vpnApp.versionCode,
    vpnAuthorized: vpnAuth,
    note,
  };
}

/**
 * 探一次设备侧的 VPN 授权态。
 *
 * 只在 App 已装的前提下才有意义 —— 未装时直接返回 null（== 未知）。
 * 这里刻意**不自动拉起 App**：probe 会被 UI 频繁调用（切页面、切设备），
 * 每次都拉起一次 App 会闪屏，用户会以为程序在乱动东西。
 * 真正的拉起放在 startWeakNet 里，那才是用户明确要开始的时候。
 */
async function probeVpnAuthorized(serial: string): Promise<boolean | null> {
  const info = await getVpnAppInfo(serial);
  if (!info.installed) return null;

  // 先看通道是否已经在（说明之前建过）
  const st = await queryVpnState(VPN_CONTROL_PORT);
  if (st) return st.authorized;

  // 通道不在：起一个临时的 forward 探一下，探完立刻撤掉，不留痕迹
  try {
    await runAdb(
      ['-s', serial, 'forward', `tcp:${VPN_CONTROL_PORT}`, `tcp:${VPN_CONTROL_PORT}`],
      { silent: true, timeout: 8000 },
    );
    // 控制端口是 App 主进程拉的，可能没起 —— 试着 ping 一次，不通就算未知
    const r = await queryVpnState(VPN_CONTROL_PORT);
    await runAdb(
      ['-s', serial, 'forward', '--remove', `tcp:${VPN_CONTROL_PORT}`],
      { silent: true, timeout: 8000 },
    );
    return r ? r.authorized : null;
  } catch {
    return null;
  }
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
/* VPN：等待授权后自动续跑                                              */
/* ------------------------------------------------------------------ */

/**
 * 等用户在设备上点完 VPN 授权，然后自动继续启动。
 *
 * 为什么要有这一步：Android 的 VPN 授权**必须**由用户在系统对话框里手动点
 * 「确定」（`VpnService.prepare()` 只能 Activity 调，见 weaknet-vpn.ts 的说明）。
 * 如果不做这个轮询，用户点完确定后得自己再回来点一次"开始"——多一步且容易懵。
 *
 * 超时上限 3 分钟：足够慢手用户操作，又不会把会话永远挂在那里。
 */
async function waitAuthorizeThenStart(ctx: Session, params: WeakNetParams): Promise<void> {
  // 会话已被替换（用户点了别的）→ 自己退出
  if (session !== ctx) {
    if (ctx.vpnTimer) { clearInterval(ctx.vpnTimer); ctx.vpnTimer = null; }
    return;
  }
  if (Date.now() - ctx.startedAt > 180_000) {
    if (ctx.vpnTimer) { clearInterval(ctx.vpnTimer); ctx.vpnTimer = null; }
    ctx.note = '等待授权超时（3 分钟），已取消。请重新点击开始。';
    emitStatus();
    return;
  }

  const st = await queryVpnState(VPN_CONTROL_PORT);
  if (session !== ctx) return;
  if (!st) return; // 通道暂时不通，下个 tick 再试

  if (!st.authorized) {
    ctx.note = '等待设备上点「确定」授权 VPN……（在手机上弹出的对话框里点确定）';
    emitStatus();
    return;
  }

  // 授权到位：停轮询，重新走一遍完整启动
  if (ctx.vpnTimer) { clearInterval(ctx.vpnTimer); ctx.vpnTimer = null; }
  ctx.note = '已获得授权，正在启动 VPN……';
  emitStatus();
  log('success', '弱网', '检测到已授权，正在启动 VPN');

  // 用当前会话替换掉自己再启动，避免 startWeakNet 里的 stop 把状态搅乱
  session = null;
  try {
    await startWeakNet(ctx.serial, params);
  } catch (e) {
    log('error', '弱网', `授权后启动失败：${e instanceof Error ? e.message : String(e)}`);
  }
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
  // 顺序即优先级：VPN（首选）→ tc（有 Root）→ 代理（免 Root 回退）→ svc（保底）
  //
  // 为什么 VPN 排在 tc 前面：本机实测主流设备都未 Root，tc 走不通；
  // 而 VPN 不需要 Root 就能做到 IP 层全量整形，覆盖面与保真度都优于代理。
  // 即使用户 Root 了，VPN 的「不依赖 ROM、不写系统设置、不留代理残留」
  // 也更安全，所以仍作默认首选。想用 tc 的用户可以显式选 engine='tc'。
  const engine = params.engine || 'auto';
  const canTc = probe.rooted && probe.hasTc;

  const useVpn =
    !params.blockNetwork && (engine === 'vpn' || engine === 'auto');

  let useProxy: boolean;
  if (params.blockNetwork) useProxy = false; // 断网交给 svc
  else if (engine === 'vpn') useProxy = false; // 明确要 VPN：失败就直接报错，不偷偷换路线
  else if (engine === 'proxy') useProxy = true;
  else if (engine === 'svc') useProxy = false;
  else if (engine === 'tc') useProxy = !canTc; // 强制 tc 但设备不支持时退回代理
  else useProxy = !canTc; // auto（VPN 不可用时启用）：能 tc 就 tc，否则用代理

  /* ---------- ⓪ VPN：配套 App 建隧道，IP 层全量整形（首选） ---------- */
  if (useVpn) {
    const r = await startVpn({
      serial: s,
      params,
      apkPath: findVpnApk() ?? undefined,
      autoInstall: true,
    });

    if (r.ok) {
      const st = await queryVpnState(VPN_CONTROL_PORT);
      ctx.vpn = {
        pkg: VPN_PKG,
        appInstalled: true,
        authorized: st?.authorized ?? true,
        channelOpen: true,
        port: VPN_CONTROL_PORT,
        reachable: !!st,
      };
      ctx.mode = 'vpn';
      ctx.note = st?.note || 'VPN 已生效：设备全部 IPv4 流量经设备侧 App 在 IP 层整形';

      // 心跳定时器：兼作 stats 推送与失联检测
      ctx.vpnTimer = setInterval(() => {
        void tickVpnSession();
      }, 1000);
      ctx.vpnTimer.unref?.();

      session = ctx;
      writeMarker(ctx);
      log('success', '弱网', `已生效（${MODE_LABEL.vpn}）`);
      emitStatus();
      return getWeakNetStatus();
    }

    // 需要授权：**这不是失败**，是一个需要用户配合的中间态。
    // 把会话登记下来，让界面能持续显示"等待手机上点确定"，
    // 而不是弹个错误框就完事（用户点完确定还得再点一次开始，体验太差）。
    if (r.needAuthorize) {
      ctx.mode = 'none';
      ctx.note = r.message;
      session = ctx;
      clearMarker();
      emitStatus();
      log('warn', '弱网', r.message);

      // 后台轮询授权结果：用户点完「确定」后自动接着启动，无需他再点开始。
      // 这是本方案唯一需要"等用户"的地方，等得优雅一点。
      ctx.vpnTimer = setInterval(() => {
        void waitAuthorizeThenStart(ctx, params);
      }, 1200);
      ctx.vpnTimer.unref?.();
      return getWeakNetStatus();
    }

    // 真失败：engine 明确指定 vpn 时直接抛；auto 则继续往下走老路线
    if (engine === 'vpn') {
      session = null;
      throw new Error(r.message);
    }
    log('warn', '弱网', `VPN 模式不可用（${r.message}），改用其他方式`);
  }

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

        // (3) 必须读回确认。写失败却报成功是最坏的情况（用户以为生效了其实没有）。
        //     注意读全套键：系统可能立刻把别名迁移成真身 host/port，
        //     只读 `http_proxy` 会误判成「没写进去」，把一个其实已经生效的会话回滚掉。
        const st = await readGlobalProxyState(s);
        if (st.effective !== addr) {
          throw new Error(
            `代理未写入（期望 ${addr}，读回「${st.effective || '空'}」）——设备可能禁用了 settings 写入`,
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

  // 限时自动停止（tc / 代理 / svc 三条路线共用这一段；
  // VPN 分支在上面已经单独建过定时器并提前 return 了，不会重复）
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
  if (ctx.vpnTimer) {
    clearInterval(ctx.vpnTimer);
    ctx.vpnTimer = null;
  }

  // VPN 模式：关设备侧隧道（这一步就是"恢复网络"），再撤控制通道。
  //
  // 注意顺序：**先发 /stop 再撤 forward**。反过来先撤通道的话，
  // /stop 就发不出去了 —— 设备侧只能靠 15s 心跳超时兜底，用户会白等十几秒。
  // 这是本方案与代理方案在清理顺序上唯一的不同点，其余（先撤设置再断通道）
  // 是代理特有的，因为代理的"设置"本身就是残留源。
  if (ctx.mode === 'vpn') {
    const told = await stopVpn();
    if (told) {
      log('info', '弱网', '已关闭 VPN，设备网络恢复正常');
    } else {
      log(
        'warn',
        '弱网',
        '未能确认设备侧已关闭 VPN（可能已断开 USB）。' +
          '设备侧会在 15s 内自动恢复网络；若仍未恢复，请打开设备上的「弱网模拟」App 手动点停止。',
      );
    }
    vpnStats = undefined;
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

/* ------------------------------------------------------------------ */
/* 设备全局代理状态：读 / 判 / 清                                       */
/* ------------------------------------------------------------------ */

/**
 * Android 8+ 把「全局 HTTP 代理」存在**两套键**里，读、判、清都必须同时覆盖：
 *
 *   1. `http_proxy`  —— 遗留别名，形如 `127.0.0.1:17890`
 *   2. `global_http_proxy_host` / `global_http_proxy_port`
 *      / `global_http_proxy_exclusion_list` / `global_proxy_pac_url`
 *                    —— 系统**实际读取**的真身
 *
 * ⚠️ 事故复盘（真实发生过，把一台设备搞成「ping 通但所有 App 都没网」）：
 *
 *   工具写 `http_proxy = 127.0.0.1:P` 后，SettingsProvider 会**立即同步出真身**
 *   `global_http_proxy_host/port`（别名保持原值，实测两套键并存）。旧代码只认别名，
 *   于是两头都错：
 *     · 清理：`delete global http_proxy` → `Deleted 1 rows`，**删掉的只是别名**，
 *       真身一直留着，系统继续按真身走代理；
 *     · 检测：别名已不在，读 `http_proxy` 得到 null/`:0` → 判定「无残留」→
 *       直接 return，什么都不做，残留永远清不掉。
 *   更隐蔽的是第三层：清理只 `delete` 也**不够**。ProxyTracker（真正决定走不走代理的
 *   组件）只在 `http_proxy` 发生**变更**时才刷新；别名早就不存在时 delete 不产生任何
 *   通知（`Deleted 0 rows`），于是设置里查不到代理，内存里的旧代理却继续把**所有流量**
 *   （含系统自己的联网校验探针）送往那个已经关闭的端口。实测：`put :0` 之前 45 秒抓到
 *   11 条流向死端口的连接（含 `connectivitycheck.gstatic.com/generate_204`），put 之后 0 条。
 *
 *   结论：清理必须先 `put global http_proxy :0` 触发变更通知刷新 ProxyTracker，
 *   再清真身四键。顺序不能反 —— put 触发的同步会把 host/port 又写回来。
 */
const PROXY_TRUE_BODY_KEYS = [
  'global_http_proxy_host',
  'global_http_proxy_port',
  'global_http_proxy_exclusion_list',
  'global_proxy_pac_url',
] as const;

interface DeviceProxyState {
  /** 是否成功读到设置（设备离线 / adb 异常时为 false） */
  reachable: boolean;
  /** 系统实际生效的代理地址，形如 `127.0.0.1:17890`；无代理则为 null */
  effective: string | null;
  host: string | null;
  port: number | null;
  /** 所有非空的 proxy 相关键，便于如实展示与残留判定 */
  raw: Record<string, string>;
}

/** `settings list global` 的输出 → 代理状态（纯函数，便于复用与测试） */
function parseGlobalProxyState(listOutput: string): DeviceProxyState {
  const raw: Record<string, string> = {};
  for (const line of listOutput.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key.includes('proxy')) continue;
    const val = line.slice(eq + 1).trim();
    if (val && val !== 'null') raw[key] = val;
  }

  const alias = raw['http_proxy'];
  const host = raw['global_http_proxy_host'];
  const portStr = raw['global_http_proxy_port'];
  const port = portStr && /^\d+$/.test(portStr) ? parseInt(portStr, 10) : null;

  // 别名取 `:0` / `0` 是 Android 表示「无代理」的中性值，不算生效
  const aliasAddr = alias && alias !== ':0' && alias !== '0' ? alias : null;

  // 真身优先：系统读的是 host/port，别名只是遗留入口
  let effective: string | null = null;
  if (host && port) effective = `${host}:${port}`;
  else if (host) effective = host;
  else effective = aliasAddr;

  return { reachable: true, effective, host: host ?? null, port, raw };
}

async function readGlobalProxyState(serial: string): Promise<DeviceProxyState> {
  // 一次 `settings list global` 拿全，避免多次 get 之间的竞态与漏键
  const res = await runAdb(['-s', serial, 'shell', 'settings', 'list', 'global'], {
    silent: true,
    timeout: 8000,
  });
  if (!res.ok && !res.stdout) {
    return { reachable: false, effective: null, host: null, port: null, raw: {} };
  }
  return parseGlobalProxyState(res.stdout);
}

/**
 * 设备上是否**还有**代理残留。
 * 只要真身或别名任一非空就算脏 —— 只认别名必然漏判。
 */
function isProxyDirty(st: DeviceProxyState): boolean {
  if (st.effective) return true;
  // `put :0` 之后系统可能留下 `global_http_proxy_port=0` 这类中性残留，不算脏
  return Object.entries(st.raw).some(([key, val]) => {
    if (key === 'global_http_proxy_port' && (val === '0' || val === '')) return false;
    if (key === 'http_proxy' && (val === ':0' || val === '0')) return false;
    return true;
  });
}

/** 残留的人类可读描述，用于日志与提示 */
function describeProxyState(st: DeviceProxyState): string {
  const parts: string[] = [];
  if (st.raw['http_proxy']) parts.push(`http_proxy=${st.raw['http_proxy']}`);
  const h = st.raw['global_http_proxy_host'];
  const p = st.raw['global_http_proxy_port'];
  if (h || p) parts.push(`global_http_proxy_host/port=${h || '空'}:${p || '空'}`);
  for (const key of ['global_proxy_pac_url', 'global_http_proxy_exclusion_list']) {
    if (st.raw[key]) parts.push(`${key}=${st.raw[key]}`);
  }
  return parts.join('，') || '未知';
}

/**
 * 清掉设备侧的代理设置与 reverse 通道。
 *
 * 三步都不能省，顺序也不能换：
 *   ① `put global http_proxy :0` —— **必须 put，不能只 delete**（见上方事故复盘）。
 *      `:0` 是表示「无代理」的中性值，put 它会触发 SettingsProvider 的迁移 + 变更通知，
 *      系统内存里的代理态随之刷新。
 *   ② 删掉真身四键 —— 系统实际读的是 `global_http_proxy_host/port`。
 *      顺序不能颠倒：先删真身再 put :0，put 触发的迁移会把 host/port 又写回来。
 *   ③ 撤 reverse，最后才关本地代理。反过来的话，中间会有一小段设备把流量发向已关闭的端口。
 *
 * 返回值：若设备上仍残留代理（ROM 禁止 adb 清设置），返回残留描述，否则返回 null。
 */
async function cleanupProxy(
  serial: string,
  proxy?: Pick<WeakNetProxyInfo, 'port' | 'reversed'>,
): Promise<string | null> {
  // ① 触发变更通知，刷新系统的内存代理态（这一步是「清干净」的关键）
  await runAdb(['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0'], {
    silent: true,
    timeout: 10000,
  });

  // ② 清真身。别名保留为 `:0` 中性值 —— 删它既无意义，还可能丢掉那次变更通知
  for (const key of PROXY_TRUE_BODY_KEYS) {
    await runAdb(['-s', serial, 'shell', 'settings', 'delete', 'global', key], {
      silent: true,
      timeout: 10000,
    });
  }

  // ③ 撤 reverse 通道
  if (proxy?.reversed && proxy.port) {
    await runAdb(['-s', serial, 'reverse', '--remove', `tcp:${proxy.port}`], {
      silent: true,
      timeout: 10000,
    });
  } else {
    // 不确定端口时兜底全清，避免残留映射让后续排查困惑
    await runAdb(['-s', serial, 'reverse', '--remove-all'], { silent: true, timeout: 10000 });
  }

  // 读回确认 —— ROM 上 put/delete 都可能被拦，必须如实上报给用户
  const st = await readGlobalProxyState(serial);
  return isProxyDirty(st) ? describeProxyState(st) : null;
}

/**
 * 清理设备上可能残留的代理设置（上次异常退出没恢复干净时使用）。
 * 返回清理前的值，供 UI 提示用户。
 */
export async function cleanupStaleProxy(
  serial: string | undefined,
): Promise<{ before: string | null; cleaned: boolean; left?: string | null }> {
  const s = await ensureDevice(serial);
  const st = await readGlobalProxyState(s);

  // 读不到设置（设备离线）时不要谎报「已清理」
  if (!st.reachable) return { before: null, cleaned: false };

  const before = st.effective;

  // 判据看真身 + 别名全套；只读 `http_proxy` 会在这里静默 return，什么都不做
  if (!isProxyDirty(st)) return { before, cleaned: false };

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

  log('info', '弱网', `已清理设备上残留的代理设置（${before || '未识别的残留键'}）`);
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
