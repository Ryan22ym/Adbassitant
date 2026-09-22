import { runAdb, log, binDir } from './adb';
import { existsSync } from 'fs';
import { join } from 'path';
import type { WeakNetDirectionParams, WeakNetParams, WeakNetStats } from '../../shared/types';

/**
 * 弱网模拟 · VPN 引擎（v2 实现方式）
 * ================================================================
 *
 * 思路：在设备上装一个配套 App（android/ 目录里的 `com.xiaoyang.weaknetvpn`），
 * 由它用 Android `VpnService` 建一条 tun，在 **IP 层** 逐包整形。
 *
 * 为什么这比旧的代理方案好（旧方案保留在 weaknet.ts，作为回退）
 * ----------------------------------------------------------------
 *   ① **覆盖全**：代理方案只能管到「愿意读系统 HTTP 代理」的 App，
 *      大量 App（自研网络库、走 QUIC 的、纯 socket 的）直接绕过代理 →
 *      用户看到「设了弱网但这个 App 一点没变」。VPN 是全量接管 0.0.0.0/0，
 *      没有应用能绕开。
 *   ② **不依赖 ROM 写权限**：旧方案的免 Root 路线要 `settings put global
 *      http_proxy`，ColorOS 之类的 ROM 直接把 shell 的写权限掐了（只能退化成
 *      让用户手动去 WLAN 界面填）。VPN 授权走的是系统 VPN 对话框，与 ROM 无关。
 *   ③ **保真度高**：IP 层可以真丢包、真错报、真乱序 —— TCP 自己会重传重排，
 *      观测到的就是真实弱网行为。旧方案在字节流层只能做「队头阻塞」近似，
 *      因为字节流层丢一段就等于篡改内容，只能装得很像。
 *
 * 本文件只负责「指挥」：装 App、开通道、调授权、下发参数、心跳、收尸。
 * 整形本身全在设备的 App 里跑（android/ 目录源码）。
 *
 * ── 控制通道方向：必须用 forward ────────────────────────────────
 *   旧方案：`adb reverse tcp:P tcp:P` —— 设备把流量打到电脑（设备主动）。
 *   本方案：`adb forward tcp:P tcp:P` —— 电脑主动访问设备上的控制端口。
 *   两者方向相反，写错就是"连不上"，且报错信息很含糊（connection refused）。
 *
 * ── 恢复网络的四层保障（这是本方案最需要想清楚的地方）────────────
 *   弱网如果没关干净，用户会遇到「手机突然上不了网」，这是最难自查的问题。
 *   所以不能只靠「用户点停止」：
 *     ① 手动停止      —— 用户点「停止」，走 stop() 的完整清理
 *     ② 双端定时器    —— 电脑侧 setTimeout + 设备侧 watchdog 独立计时，
 *                        任何一边活着都能到点自动关
 *     ③ 应用退出      —— main.ts 的 will-quit 里调 stopWeakNetVpn()
 *     ④ 心跳超时自停  —— 电脑每秒轮询 /status；设备侧 15s 收不到任何控制请求
 *                        就自己关隧道。这样即使电脑进程被任务管理器强杀
 *                        （第 ③ 层来不及执行），设备也会自己恢复。
 *   兜底：设备侧一旦关掉 tun fd（`shutdown()` 第 ③ 步），系统立刻拆 VPN、
 *   路由回到真实网卡 —— 即使 App 进程随后被杀，网络也已经好了。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** APK 包名（必须与 android/app/build.gradle.kts 的 applicationId 一致） */
export const VPN_PKG = 'com.xiaoyang.weaknetvpn';

/**
 * 控制端口。
 *
 * 选 18080 而不是旧代理方案的 17890：两个方案可能同时在代码里存在
 * （vpn 为首选、proxy 为回退），不同端口避免互相踩。
 */
export const VPN_CONTROL_PORT = 18080;

/** 设备侧协议版本，与 android/.../ControlServer.kt 的 PROTOCOL_VERSION 对齐 */
const VPN_PROTOCOL_VERSION = 1;

/** 装机后等待控制端口就绪的最长时间 */
const READY_TIMEOUT_MS = 12_000;

/** 单次控制请求超时 */
const REQ_TIMEOUT_MS = 6_000;

/** 心跳间隔：设备侧超时是 15s，1s 轮询留了足够余量 */
const HEARTBEAT_MS = 1_000;

/**
 * 下发 `/start` 后，等设备侧真正把隧道建起来的上限。
 *
 * 🔴 `/start` 只是「把 Intent 交给系统」，设备侧的
 * `startForegroundService → onStartCommand → establish()` 全是**异步**的：
 * 实测从下发到 `/status` 报 `vpnActive=true` 需要数百毫秒到数秒
 * （App 冷启动 / 被系统冻结过时更久）。
 *
 * 所以「下发成功」≠「已生效」，必须轮询确认。不确认就会踩这个坑：
 * 下发后立刻查 `/status` 拿到 `vpnActive=false` → 被心跳误判成
 * 「设备侧已停止」→ 反手发 `/stop` 把**刚建好的**隧道关掉 ——
 * 用户看到的就是「点了启动，手机上 VPN 一闪即逝，弱网完全没效果」。
 */
const TUNNEL_READY_TIMEOUT_MS = 12_000;

/**
 * 启动宽限期：下发 `/start` 之后这么久内的「查不到 / 报未运行」都不算异常。
 *
 * 上面那条坑的第二道保险 —— 即使某条路径没等到隧道就绪就进了心跳，
 * 宽限期内也不会把会话收摊。
 */
const START_GRACE_MS = 8_000;

/* ------------------------------------------------------------------ */
/* HTTP over adb forward                                               */
/* ------------------------------------------------------------------ */

interface HttpReply {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
  raw: string;
}

/**
 * 通过 `adb forward tcp:P tcp:P` 把设备的控制端口映射到本机，然后用普通
 * HTTP 调用。
 *
 * 为什么用 Node 的 fetch 而不是 `adb shell curl`：
 *   · 设备上不一定有 curl / busybox
 *   · 走 forward 之后对端就是 127.0.0.1，Node 原生 fetch 直接能用，
 *     也没有 shell 转义地狱
 */
async function call(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = REQ_TIMEOUT_MS,
): Promise<HttpReply | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* 非 JSON 响应：保留 raw，交给调用方判断 */
    }
    return { ok: res.ok, status: res.status, json, raw };
  } catch {
    // 连不上 = App 没起 / 端口没通 / 设备拔了。调用方按 null 处理，
    // 不要在这里抛 —— 心跳轮询时这是正常情况（比如 App 被系统回收中）
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 设备侧应用的存在性检查                                               */
/* ------------------------------------------------------------------ */

/** `pm path` 输出形如 `package:/data/app/.../base.apk`；空输出表示未安装 */
function parsePmPath(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('package:'));
  return line ? line.slice('package:'.length) : null;
}

export interface VpnAppInfo {
  installed: boolean;
  /** 设备上的 APK 路径 */
  path?: string;
  /** 设备上已装版本的 versionCode（读不到则为 null） */
  versionCode: number | null;
}

/**
 * 查设备上装没装配套 App。
 *
 * 用 `pm path` 而不是 `pm list packages`：前者能找到 APK 实际路径，
 * 后者在新版本 Android 上可能因为过滤参数变化而误判（踩过）。
 */
export async function getVpnAppInfo(serial: string): Promise<VpnAppInfo> {
  const res = await runAdb(['-s', serial, 'shell', 'pm', 'path', VPN_PKG], {
    silent: true,
    timeout: 8000,
  });
  const path = parsePmPath(res.stdout || '');
  if (!path) return { installed: false, versionCode: null };

  const dump = await runAdb(
    ['-s', serial, 'shell', 'dumpsys', 'package', VPN_PKG],
    { silent: true, timeout: 10000 },
  );
  const m = /versionCode=(\d+)/.exec(dump.stdout || '');
  return { installed: true, path, versionCode: m ? parseInt(m[1], 10) : null };
}

/**
 * 安装配套 App。
 *
 * `-r` 覆盖安装：已装旧版时直接替换，不会丢授权状态（VPN 授权是按包名记的）。
 * `-g` 授予运行时权限：本 App 没有危险权限，但写上无害；
 *      真正的 VPN 授权是系统对话框，adb 无权代授（这是设计如此，不是缺陷）。
 */
export async function installVpnApp(
  serial: string,
  apkPath: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await runAdb(['-s', serial, 'install', '-r', '-g', apkPath], {
    silent: true,
    timeout: 120_000,
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();

  // adb install 的坑：**退出码 0 也可能是失败**，必须看输出里有没有 Success。
  // 反过来，输出里有 Success 就一定是成功（可能有 Warning 噪声）。
  if (/Success/i.test(out)) return { ok: true, message: '配套 App 已安装' };

  // INSTALL_FAILED_UPDATE_INCOMPATIBLE = 签名不一致，只能卸载重装
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(out)) {
    return {
      ok: false,
      message: '设备上已有一个签名不同的同包名应用，请先卸载再装（或换一个包名）',
    };
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(out)) {
    return { ok: false, message: '设备上的版本比随包 APK 更新，已跳过安装（用 --downgrade 可强降）' };
  }
  return { ok: false, message: out || '安装失败（无输出）' };
}

/* ------------------------------------------------------------------ */
/* 控制通道                                                            */
/* ------------------------------------------------------------------ */

/**
 * 建立控制通道：`adb forward tcp:P tcp:P`。
 *
 * 幂等：重复调用不会报错（adb forward 同端口重复建立是允许的，会覆盖）。
 * 会话结束时必须 `--remove`，否则下次启动会连到一个已经死掉的映射。
 */
async function openChannel(serial: string, port: number): Promise<void> {
  const res = await runAdb(['-s', serial, 'forward', `tcp:${port}`, `tcp:${port}`], {
    silent: true,
    timeout: 10_000,
  });
  if (!res.ok) {
    throw new Error(
      `adb forward 未建立：${(res.stderr || res.stdout || '').trim() || '未知原因'}`,
    );
  }
}

async function closeChannel(serial: string, port: number): Promise<void> {
  try {
    await runAdb(['-s', serial, 'forward', '--remove', `tcp:${port}`], {
      silent: true,
      timeout: 8_000,
    });
  } catch {
    /* 通道可能本来就不存在，无所谓 */
  }
}

/**
 * 拉起设备的控制端口并等它就绪。
 *
 * 这里有个**鸡生蛋**问题：授权必须在设备上弹框（`VpnService.prepare` 只能由
 * Activity 调），但电脑要指挥这次弹框就必须先有控制端口。所以 App 里做了两层：
 *   · `App`（Application 子类）：进程一启动就拉起 ControlHostService，
 *     只开控制端口、**不建隧道、不改网络**
 *   · `WeakNetVpnService`：真正干活的 VPN 服务，按需启动
 *
 * 这里用 `monkey` 拉起 App 主进程（比 `am start` 稳，不受 Activity 栈状态影响）。
 * 老版本 Android 用 `am start` 更常见，所以两条都试。
 */
async function ensureControlApp(serial: string, port: number): Promise<void> {
  // 已经是活的就不用再拉，避免每次都闪一下
  const ping = await call(port, 'GET', '/ping', undefined, 2000);
  if (ping?.status === 200) return;

  await runAdb(['-s', serial, 'shell', 'monkey', '-p', VPN_PKG, '-c',
    'android.intent.category.LAUNCHER', '1'], { silent: true, timeout: 10_000 });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await call(port, 'GET', '/ping', undefined, 2000);
    if (r?.status === 200) {
      const proto = r.json.protocol;
      if (proto !== VPN_PROTOCOL_VERSION) {
        throw new Error(
          `配套 App 协议版本不匹配（设备 ${proto}，本机支持 ${VPN_PROTOCOL_VERSION}）——` +
            '请更新设备上的 App（通常是主机端版本与随包 APK 不是同一版）',
        );
      }
      return;
    }
    await sleep(400);
  }
  throw new Error(
    `设备上的配套 App 无响应（等待 ${READY_TIMEOUT_MS / 1000}s）——` +
      '可能是被系统的后台限制冻结了，请先手动打开一次「弱网模拟」App',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 参数转换                                                            */
/* ------------------------------------------------------------------ */

/** 前端参数 → 设备侧 SessionParams 的 JSON（字段名与 Protocol.kt 一一对应） */
function toSessionBody(params: WeakNetParams): Record<string, unknown> {
  const dir = (d: WeakNetDirectionParams) => ({
    bandwidthMbps: d.bandwidthMbps ?? 0,
    delayMs: d.delayMs ?? 0,
    jitterMs: d.jitterMs ?? 0,
    lossPercent: d.lossPercent ?? 0,
    corruptPercent: d.corruptPercent ?? 0,
    reorderPercent: d.reorderPercent ?? 0,
    duplicatePercent: d.duplicatePercent ?? 0,
  });
  return {
    up: dir(params.up),
    down: dir(params.down),
    durationSec: params.durationSec ?? 0,
    blockNetwork: !!params.blockNetwork,
  };
}

/** 设备侧回来的 stats → 前端 WeakNetStats（字段已对齐，这里只做类型收窄） */
function toStats(o: Record<string, unknown> | undefined): WeakNetStats | undefined {
  if (!o) return undefined;
  const n = (k: string) => {
    const v = o[k];
    return typeof v === 'number' ? v : 0;
  };
  return {
    connections: n('connections'),
    active: n('active'),
    upBytes: n('upBytes'),
    downBytes: n('downBytes'),
    upRetrans: n('upRetrans'),
    downRetrans: n('downRetrans'),
    upReorder: n('upReorder'),
    downReorder: n('downReorder'),
    upCorrupt: n('upCorrupt'),
    downCorrupt: n('downCorrupt'),
  };
}

/* ------------------------------------------------------------------ */
/* 会话状态                                                            */
/* ------------------------------------------------------------------ */

export interface VpnSession {
  serial: string;
  port: number;
  startedAt: number;
  /**
   * 下发 `/start` 的时刻。
   *
   * 用于启动宽限期判断：设备侧建隧道是异步的，这之后的一小段时间内
   * 「查不到状态 / 报未运行」都只是「还在启动」，不能当成已停止去收摊。
   */
  dispatchedAt: number;
  /** 心跳定时器（同时负责把 stats 推给 UI） */
  heartbeat: NodeJS.Timeout | null;
  /** 电脑侧自己算的剩余秒数，与设备侧相互独立（双端定时器） */
  timer: NodeJS.Timeout | null;
  note: string;
  /** 最近一次控制请求是否成功 —— 连续失败就要提示用户 */
  reachable: boolean;
}

let vpnSession: VpnSession | null = null;

/** 状态变化回调（由 weaknet.ts 注入，用于向前端推状态） */
type TickSink = () => void;
let tickSink: TickSink | null = null;
export function setVpnTickSink(sink: TickSink) {
  tickSink = sink;
}

export function getVpnSession(): VpnSession | null {
  return vpnSession;
}

export function isVpnActive(): boolean {
  return !!vpnSession;
}

/* ------------------------------------------------------------------ */
/* 授权                                                                */
/* ------------------------------------------------------------------ */

/**
 * 触发设备上的 VPN 授权对话框。
 *
 * ⚠️ **授权无法绕过**。Android 要求 `VpnService.prepare()` 必须由 Activity
 * 通过 `startActivityForResult` 唤起系统对话框，用户必须手动点「确定」。
 * 这是安全设计（VPN 能看全部流量），任何"自动化授权"都是做不到的 ——
 * 所以本方案的流程天然是「点开始 → 手机上点确定 → 生效」。
 *
 * 这里只负责「把框弹出来」，授权结果是异步回写的，由调用方轮询授权态。
 */
export async function requestVpnAuthorization(serial: string): Promise<boolean> {
  const port = vpnSession?.port ?? VPN_CONTROL_PORT;
  const r = await call(port, 'POST', '/authorize');
  if (!r?.json.ok) {
    // 通道没起来时补一次 —— 首次使用最容易碰到
    return false;
  }
  log('info', '弱网', '已请求在设备上弹出 VPN 授权框，请在手机上点「确定」');
  void serial;
  return true;
}

/**
 * 查询授权态。
 *
 * 顺带把「VPN 已在系统设置里被撤销」这种情况也识别出来 ——
 * 那时设备侧会 `onRevoke` 关隧道，我们这边看到的就是 authorized=false。
 */
export async function queryVpnState(
  port = VPN_CONTROL_PORT,
): Promise<{
  reachable: boolean;
  authorized: boolean;
  vpnActive: boolean;
  note: string;
  remainSec: number;
  stats?: WeakNetStats;
} | null> {
  const r = await call(port, 'GET', '/status', undefined, 3000);
  if (!r || r.status !== 200) return null;
  const j = r.json;
  return {
    reachable: true,
    authorized: !!j.authorized,
    vpnActive: !!j.vpnActive,
    note: typeof j.note === 'string' ? j.note : '',
    remainSec: typeof j.remainSec === 'number' ? j.remainSec : -1,
    stats: toStats(j.stats as Record<string, unknown> | undefined),
  };
}

/* ------------------------------------------------------------------ */
/* 随包 APK 路径                                                       */
/* ------------------------------------------------------------------ */

/**
 * 随包 APK 的位置。
 *
 * 🔴 必须放在 `bin/` 根下（`bin/weaknet-vpn.apk`），**不能**放进子目录。
 *    原因不在整洁，在升级：应用内增量更新只替换 manifest.files 里那几个文件，
 *    **不会新建目录**（v1.0.28 及以前的更新助手连 mkdir 都没有），而更新前的
 *    预检曾把「目标目录还不存在」误判成「目录不可写」直接拒收整包 ——
 *    APK 一旦放进 `bin/weaknet/`，「还没有这个子目录」的旧版本就再也升不上来。
 *    v1.0.29 首版正是踩了这个坑，详见 electron/services/update.ts 的同名注释。
 *
 * 为什么要随包：本机没有 Android SDK / NDK / Gradle，APK 必须预先构建好
 * 一起发；而且用户装工具时不应该被迫再装一套安卓构建链。
 * 详见 docs/weaknet-vpn-design.md「为什么 APK 要随包发布」。
 *
 * 找不到时返回 null —— 上层会给出明确提示（而不是让 adb install 报一个
 * 含糊的 "cannot open file"）。
 */
export function findVpnApk(): string | null {
  const candidates = [
    join(binDir(), 'weaknet-vpn.apk'), // 现行布局（放 bin 根下，更新安全）
    join(binDir(), 'weaknet', 'weaknet-vpn.apk'), // 历史布局，仅兼容老安装
    join(binDir(), 'weaknet', 'app-release.apk'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

export interface StartVpnOptions {
  serial: string;
  params: WeakNetParams;
  /** 随包 APK 路径；设备上没装时用 */
  apkPath?: string;
  /** 是否允许自动安装（用户可能在设置里关掉） */
  autoInstall?: boolean;
}

/**
 * 用 VPN 引擎开始弱网。
 *
 * 步骤与失败处理（任何一步失败都**不留半生效状态**）：
 *   ① 设备在装 App 吗       → 不在且允许自动装，就装
 *   ② 建控制通道 forward
 *   ③ 拉起 App 主进程 + 握手版本
 *   ④ 查授权                → 没授权就弹框并抛「需要授权」这个可识别的错
 *   ⑤ 下发 /start
 *   ⑥ 起心跳（顺便推 stats 与双端定时器）
 *
 * 返回值里的 `needAuthorize` 让调用方能把「等用户点确定」和「真失败」区分开。
 */
export async function startVpn(
  opts: StartVpnOptions,
): Promise<{ ok: boolean; needAuthorize?: boolean; message: string }> {
  const { serial, params } = opts;
  const port = VPN_CONTROL_PORT;

  if (vpnSession) await stopVpn();

  /* ① 装机检查 */
  const info = await getVpnAppInfo(serial);
  if (!info.installed) {
    if (!opts.apkPath) {
      return {
        ok: false,
        message: '设备上未安装弱网配套 App，且找不到随包 APK（bin/weaknet-vpn.apk）',
      };
    }
    if (opts.autoInstall === false) {
      return { ok: false, message: '设备上未安装弱网配套 App（自动安装已被关闭）' };
    }
    const ins = await installVpnApp(serial, opts.apkPath);
    if (!ins.ok) return { ok: false, message: ins.message };
  }

  /* ② 控制通道（forward！方向别搞反） */
  await openChannel(serial, port);

  /* ③ 拉起 App 并握手 */
  try {
    await ensureControlApp(serial, port);
  } catch (e) {
    await closeChannel(serial, port);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  /* ④ 授权检查 */
  const st = await queryVpnState(port);
  if (!st) {
    await closeChannel(serial, port);
    return { ok: false, message: '控制端口已通但状态查询失败，请重试' };
  }
  // ⚠️ `authorized` 为 false 不一定代表「没授权」：只要设备上有 VPN 正在运行
  // （包括我们自己上一轮还没停干净的），`VpnService.prepare()` 就会返回非 null，
  // 于是 /status 报 authorized=false。这种情况直接放行 —— 真没授权的话，
  // 设备侧 /start 里还会再查一次 prepare()，会明确回 need_authorize，兜得住。
  if (!st.authorized && !st.vpnActive) {
    // 弹框，但不关通道 —— 用户点完确定我们还要继续
    await call(port, 'POST', '/authorize');
    return {
      ok: false,
      needAuthorize: true,
      message: '需要在设备上授权 VPN：请在弹出的系统对话框里点「确定」，然后重新点开始',
    };
  }

  /* ⑤ 下发启动指令 */
  const start = await call(port, 'POST', '/start', toSessionBody(params));
  if (!start) {
    await closeChannel(serial, port);
    return { ok: false, message: '启动指令下发失败（设备侧无响应）' };
  }
  if (!start.json.ok) {
    const code = start.json.code;
    if (code === 'need_authorize') {
      return { ok: false, needAuthorize: true, message: String(start.json.error || '需要授权') };
    }
    await closeChannel(serial, port);
    return { ok: false, message: String(start.json.error || '设备侧拒绝了启动请求') };
  }

  /* ⑤.5 等设备侧把隧道真正建起来
   *
   * `/start` 是「把 Intent 交给系统」后就立即返回的，设备侧 establish() 是异步的。
   * 不等就往下走的话，第一次心跳会看到 vpnActive=false，被误判成
   * 「设备侧已停止」→ 反手一个 /stop 关掉**刚建好的**隧道 →
   * 用户看到「点了启动，手机上 VPN 一闪即逝，弱网完全没效果」。
   */
  if (!(await waitTunnelReady(port, TUNNEL_READY_TIMEOUT_MS))) {
    await call(port, 'POST', '/stop');
    await closeChannel(serial, port);
    return {
      ok: false,
      message:
        `设备侧未能在 ${TUNNEL_READY_TIMEOUT_MS / 1000}s 内建立 VPN 隧道。` +
        '设备上的「弱网模拟」App 若长时间未用可能被系统冻结，' +
        '先手动打开一次它再重试。',
    };
  }

  /* ⑥ 会话登记 + 心跳 */
  const ctx: VpnSession = {
    serial,
    port,
    startedAt: Date.now(),
    dispatchedAt: Date.now(),
    heartbeat: null,
    timer: null,
    note: 'VPN 已下发，等待设备侧确认',
    reachable: true,
  };
  vpnSession = ctx;

  // 双端定时器：电脑侧这一份独立计时，即使设备侧 watchdog 没跑，
  // 只要电脑活着也能到点关。设备侧那一份负责「电脑死了」的情况。
  if (params.durationSec > 0) {
    ctx.timer = setTimeout(() => {
      log('info', '弱网', `已达设定时长 ${params.durationSec}s，自动关闭 VPN`);
      void stopVpn();
    }, params.durationSec * 1000);
    ctx.timer.unref?.();
  }

  ctx.heartbeat = setInterval(() => void tickVpn(), HEARTBEAT_MS);
  ctx.heartbeat.unref?.();

  // 立刻拉一次，把真实状态拿到（不要等到 1s 后）
  await tickVpn();

  log('success', '弱网', 'VPN 弱网已生效（IP 层全量整形）');
  return { ok: true, message: 'VPN 弱网已生效' };
}

/**
 * 心跳。
 *
 * 三个职责：
 *   ① 探活 —— 每秒一次 /status，让设备侧的 lastControlTouch 保持新鲜，
 *      否则设备会在 15s 后判定「电脑没了」自己关掉
 *   ② 同步 —— 把设备侧真实状态（含 stats）拉回来推给 UI
 *   ③ 收尸 —— 发现设备侧已经不在跑（用户手动关了通知里的停止、
 *      或在系统设置里撤销了授权、或系统回收了），我们也要跟着收摊，
 *      不然 UI 会一直显示「运行中」而实际早停了
 */
/**
 * 轮询等设备侧把隧道真正建起来。
 *
 * 每 300ms 查一次 `/status`，命中 `vpnActive=true` 立刻返回 true。
 * 轮询本身顺带刷新了设备侧的 `lastControlTouch`，所以等待期间
 * 也不会被「15s 无控制请求就自停」的保护误伤。
 *
 * @returns true = 隧道已就绪；false = 超时（调用方负责清理，别留半生效状态）
 */
async function waitTunnelReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await queryVpnState(port);
    if (st?.vpnActive) return true;
    await sleep(300);
  }
  return false;
}

async function tickVpn(): Promise<void> {
  const ctx = vpnSession;
  if (!ctx) return;

  const st = await queryVpnState(ctx.port);
  if (vpnSession !== ctx) return; // 期间被停了

  // 启动宽限期：刚下发 /start 的这几秒里设备侧可能还在 establish()，
  // 此时「查不到 / 报未运行」都只代表「还在启动」，绝不能收摊。
  const starting = Date.now() - ctx.dispatchedAt < START_GRACE_MS;

  if (!st) {
    if (starting) {
      ctx.reachable = true;
      ctx.note = '正在等待设备侧建立隧道……';
      tickSink?.();
      return;
    }
    ctx.reachable = false;
    ctx.note = '与设备侧控制通道失联 —— 若持续如此，设备会在 15s 后自动恢复网络';
    tickSink?.();
    return;
  }
  ctx.reachable = true;

  // 设备侧说没在跑了 → 跟着收摊（启动宽限期内除外：那只是还没起完）
  if (!st.vpnActive) {
    if (starting) {
      ctx.note = '正在等待设备侧建立隧道……';
      tickSink?.();
      return;
    }
    ctx.note = st.note || '设备侧已停止 VPN';
    log('info', '弱网', `设备侧已停止 VPN：${ctx.note}`);
    await stopVpn(true);
    return;
  }

  ctx.note = st.note || 'VPN 运行中';
  tickSink?.();
}

/**
 * 停止并恢复网络。
 *
 * `internal = true` 表示是心跳发现设备侧已经停了而调用的 —— 这时候
 * 仍然要发一次 /stop（幂等，不亏），因为「设备侧报 vpnActive=false」
 * 有可能是它刚崩正在重启，补一刀确保干净。
 *
 * @returns 设备侧是否确认已被通知到
 */
export async function stopVpn(internal = false): Promise<boolean> {
  const ctx = vpnSession;
  if (!ctx) return true;

  // 先摘掉状态，防止 stop 过程中被 tick 重入
  vpnSession = null;

  if (ctx.heartbeat) {
    clearInterval(ctx.heartbeat);
    ctx.heartbeat = null;
  }
  if (ctx.timer) {
    clearTimeout(ctx.timer);
    ctx.timer = null;
  }

  // ① 发停止指令（可能连不上 —— 设备拔了 / App 被杀了，都不算致命）
  const r = await call(ctx.port, 'POST', '/stop');
  const told = !!r?.json.ok;

  // ② 撤控制通道，避免残留映射
  await closeChannel(ctx.serial, ctx.port);

  if (!told && !internal) {
    log(
      'warn',
      '弱网',
      '未能确认设备侧已关闭 VPN（可能已断开 USB）。' +
        '若设备仍无法上网，请打开「弱网模拟」App 手动点「停止」，或在系统设置里关闭该 VPN。',
    );
  } else {
    log('info', '弱网', '已关闭 VPN，设备网络恢复正常');
  }

  tickSink?.();
  return told;
}

/**
 * 启动时调用：清理上一次异常退出残留的控制通道。
 *
 * 与旧方案的区别值得说明一下：旧方案残留的是**设备上的代理设置**，
 * 不清掉设备就一直断网，所以必须写标记文件、下次启动补救。
 * VPN 方案最坏情况残留的是**一个还开着的 VPN** —— 而它会因为心跳超时
 * 在 15s 内自停，网络自动恢复。所以这里只需要撤掉本机的端口映射。
 *
 * 仍然提供这个函数是为了让上层逻辑统一（都要在启动时跑一遍 recover）。
 */
export async function recoverStaleVpn(serial: string | undefined): Promise<string | null> {
  if (!serial) return null;
  try {
    const res = await runAdb(
      ['-s', serial, 'forward', '--list'],
      { silent: true, timeout: 8000 },
    );
    const lines = (res.stdout || '').split(/\r?\n/);
    const hit = lines.find((l) => l.includes(`tcp:${VPN_CONTROL_PORT}`));
    if (!hit) return null;

    await closeChannel(serial, VPN_CONTROL_PORT);
    // 顺手补一刀停止指令（幂等；如果设备上 VPN 还开着，这一下就关了）
    await openChannel(serial, VPN_CONTROL_PORT);
    await call(VPN_CONTROL_PORT, 'POST', '/stop', undefined, 3000);
    await closeChannel(serial, VPN_CONTROL_PORT);

    return '检测到上次弱网会话残留的控制通道，已清理并确认设备侧 VPN 关闭';
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 参数热更新                                                          */
/* ------------------------------------------------------------------ */

/**
 * 热更新参数：不重建隧道。
 *
 * 为什么不重启隧道：tun 一关一开会让设备上的连接全断（TCP 连接绑在
 * 路由上），体感是"闪断"。滑块拖动时每次重启隧道完全不可用。
 * 设备侧的 `updateParams` 只刷新整形器参数，隧道保持不动。
 */
export async function updateVpnParams(params: WeakNetParams): Promise<boolean> {
  const ctx = vpnSession;
  if (!ctx) return false;
  const r = await call(ctx.port, 'POST', '/params', toSessionBody(params));
  return !!r?.json.ok;
}
