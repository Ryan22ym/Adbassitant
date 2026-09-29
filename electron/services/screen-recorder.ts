import { join } from 'path';
import { existsSync } from 'fs';
import { runAdb, ensureDevice, log, fileSize } from './adb';
import { getSettings } from './settings';
import {
  startCapture,
  stopCapture,
  setPaused as setTouchPaused,
  capturedTouches,
  resetCapture,
  prepare as prepareTouch,
  type CapturedTouch,
} from './touch-capture';
import type {
  RecorderInfo,
  RecorderStatus,
  RecorderPrepare,
  RecordedSession,
  RecordedTouch,
  RecordedFrame,
  RecordedSysEvent,
  ClickerRecordMeta,
} from '../../shared/types';

/**
 * 屏幕录制采集端 —— 电脑侧客户端
 * ============================================================
 *
 * 设备侧那个 App（`com.xiaoyang.screenrecorder`，随包 `bin/screen-recorder.apk`）
 * 在 127.0.0.1:18081 上开了个 HTTP 控制端口。本文件通过
 * `adb forward tcp:18081 tcp:18081` 把它映射到电脑，用普通 HTTP 调用。
 *
 * ## 数据来源的分工（v1.0.33 起的改造）
 *
 * | 数据       | 来源                          | 为什么                          |
 * |------------|-------------------------------|---------------------------------|
 * | 屏幕画面   | 设备侧 App（MediaProjection）  | 只有系统 API 能读画面            |
 * | 前台 App   | 设备侧 App（UsageStats）       | 同上                            |
 * | **触摸**   | **电脑侧 `adb getevent`**      | shell 在 input 组，能读全局触摸   |
 *
 * 为什么触摸要挪到电脑侧：第三方 App 读不到自己以外的触摸
 * （见 `touch-capture.ts` 的详细说明）。原先只能在采集端画布上操作，
 * 用户没法"一边用别的 App 一边录"。改由电脑读 `getevent` 后，
 * 设备侧 App 退居后台，用户在**任意 App**上操作都会被采到。
 *
 * ## 编排：电脑是唯一的主控
 *
 * 「开始录制」= 电脑同时做两件事：
 *   1. `POST /start` 让设备侧开始采集画面；
 *   2. `startCapture()` 起 `getevent` 子进程采触摸。
 * 任一失败都要回滚另一件，否则会出现「只有画面没触摸」这种半截状态。
 *
 * ## 方向：forward 不是 reverse
 *
 *   · `adb forward tcp:A tcp:B` = 电脑的 A → 设备的 B（**电脑主动访问设备**）← 用这个
 *   · `adb reverse` = 设备的 A → 电脑的 B（设备主动访问电脑）
 *
 * 与弱网 App 同方向（都要"电脑指挥设备"）。两个 App 端口不同
 * （弱网 18080 / 采集 18081），可以同时跑。
 *
 * ## 端口清理很重要
 *
 * `adb forward` 的映射**不会随进程退出自动清除**，会一直挂在 adb server 上。
 * 换了设备、或设备侧 App 重装后端口变了，旧映射会让请求打到错误的地方
 * （表现为「连上了但一直超时」）。所以 [ensureForward] 每次都会先
 * `--remove` 再 `--no-rebind`，幂等地重建。
 */

/** 采集端包名（与 android/recorder 的 applicationId 一致） */
const RECORDER_PKG = 'com.xiaoyang.screenrecorder';
const RECORDER_ACTIVITY = `${RECORDER_PKG}/.RecorderActivity`;

/**
 * 「停止录制」那一刻从电脑侧采集器接住的触摸数据。
 *
 * 存在的理由：采集器内部的缓冲在 stopCapture() 时会被清空，
 * 而「停止」和「拉取并转成脚本」是界面上**两个分开的点击** ——
 * 中间这段时间数据只能放在这里，否则第二次点击时已经什么都读不到了。
 */
let stoppedTouches: CapturedTouch[] = [];

/** 随包 APK 位置（bun 根下，理由见 build-weaknet-apk.mjs 的注释） */
function bundledApk(): string {
  // 打包后 resources/bin/screen-recorder.apk；开发时 bin/screen-recorder.apk
  const candidates = [
    join(process.resourcesPath || '', 'bin', 'screen-recorder.apk'),
    join(process.cwd(), 'bin', 'screen-recorder.apk'),
    join(__dirname, '..', '..', 'bin', 'screen-recorder.apk'),
    join(__dirname, '..', '..', '..', 'bin', 'screen-recorder.apk'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return '';
}

function port(): number {
  const p = getSettings().recorderPort;
  return Number.isFinite(p) && p > 0 ? Math.round(p) : 18081;
}

/* ------------------------------------------------------------------ */
/* HTTP 调用                                                           */
/* ------------------------------------------------------------------ */

/**
 * 调设备侧控制端点。
 *
 * 用 Node 内置 http 而不是 fetch：需要控制超时，而 fetch 的 abort 在
 * Node 18 的某些版本上对 localhost 连接不生效（会一直挂着）。
 */
function httpGet(path: string, timeoutMs = 6000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // 延迟 require：这个模块在 Electron 主进程里跑，顶层 import http 没问题，
    // 但保持一致写法便于将来搬到别的运行时
    const http = require('http') as typeof import('http');
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(
  path: string,
  body: unknown,
  timeoutMs = 8000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const http = require('http') as typeof import('http');
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** 取二进制（关键帧 JPEG） */
function httpGetBinary(path: string, timeoutMs = 10000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const http = require('http') as typeof import('http');
    const req = http.request(
      { host: '127.0.0.1', port: port(), path, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          if ((res.statusCode || 0) !== 200) {
            reject(new Error(Buffer.concat(chunks).toString('utf8') || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('取帧超时')));
    req.on('error', reject);
    req.end();
  });
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error('设备侧返回的不是合法 JSON（可能连到了别的服务）');
  }
}

/* ------------------------------------------------------------------ */
/* forward 管理                                                        */
/* ------------------------------------------------------------------ */

/**
 * 确保 adb forward 存在（幂等）。
 *
 * 先 remove 再 add：`adb forward` 在映射已存在时会静默失败（或按 rebind
 * 语义保持旧的），而旧映射可能指向已经不存在的 socket。先移除最干净。
 */
async function ensureForward(serial: string): Promise<void> {
  const p = port();
  await runAdb(['-s', serial, 'forward', '--remove', `tcp:${p}`], {
    source: '录制', silent: true, timeout: 8000,
  });
  const res = await runAdb(['-s', serial, 'forward', `tcp:${p}`, `tcp:${p}`], {
    source: '录制', silent: true, timeout: 8000,
  });
  if (!res.ok) {
    throw new Error(`建立 adb forward 失败：${res.stderr.trim() || '未知原因'}`);
  }
}

/** 清掉本工具用的那个 forward（停止/切换设备时调，别留垃圾映射） */
export async function clearForward(serial?: string): Promise<void> {
  const p = port();
  const args = ['forward', '--remove', `tcp:${p}`];
  if (serial) await runAdb(['-s', serial, ...args], { source: '录制', silent: true, timeout: 8000 });
  else await runAdb(args, { source: '录制', silent: true, timeout: 8000 });
}

/* ------------------------------------------------------------------ */
/* 探活 / 安装                                                         */
/* ------------------------------------------------------------------ */

/** 设备上是否装了采集端，以及它的 versionCode */
async function probeInstalled(serial: string): Promise<{ installed: boolean; versionCode: number | null }> {
  const res = await runAdb(['-s', serial, 'shell', 'dumpsys', 'package', RECORDER_PKG], {
    source: '录制', silent: true, timeout: 12000,
  });
  const out = res.stdout || '';
  // 没装时 dumpsys 也会返回 0，输出里有 "Unable to find package" 之类
  if (!out || /Unable to find|unknown package|No package/i.test(out)) {
    return { installed: false, versionCode: null };
  }
  // versionCode 在新老系统上字段名不同：versionCode / versionCodeMajor
  const m = out.match(/versionCode=(\d+)/);
  return { installed: true, versionCode: m ? parseInt(m[1], 10) : null };
}

/** 综合状态：装了没、授权没、在录没 */
export async function recorderInfo(serial?: string): Promise<RecorderInfo> {
  const s = await ensureDevice(serial);
  const inst = await probeInstalled(s);

  if (!inst.installed) {
    return {
      ready: false,
      installed: false,
      versionCode: null,
      authorized: false,
      recording: false,
      protocol: 0,
      note: '设备上还没有装屏幕录制采集端，点「安装采集端」即可',
    };
  }

  // 装了但服务没起来（用户没打开过 App）—— forward 也会失败，这里兜住
  try {
    await ensureForward(s);
    const res = await httpGet('/ping', 5000);
    const j = parseJson<Record<string, unknown>>(res.body);
    return {
      ready: true,
      installed: true,
      versionCode: inst.versionCode,
      authorized: !!j.authorized,
      recording: !!j.recording,
      protocol: Number(j.protocol) || 0,
      model: typeof j.model === 'string' ? j.model : undefined,
      note: j.authorized
        ? '采集端已就绪'
        : '采集端已就绪，但还没获得录屏授权 —— 点「授权录屏」后在手机上确认',
    };
  } catch (e) {
    return {
      ready: false,
      installed: true,
      versionCode: inst.versionCode,
      authorized: false,
      recording: false,
      protocol: 0,
      note: `采集端已安装，但控制端口连不上（${(e as Error).message}）—— 请在手机上打开一次「屏幕录制」App`,
    };
  }
}

/**
 * 安装 / 覆盖安装随包的采集端 APK。
 *
 * `-r` 覆盖安装（保留数据，避免每次都要重新授权）。
 * 与项目里其它安装路径一样：**必须带 `-s <serial>`**，多设备时不猜。
 */
export async function installRecorder(serial?: string): Promise<{ ok: boolean; message: string }> {
  const s = await ensureDevice(serial);
  const apk = bundledApk();
  if (!apk) {
    return { ok: false, message: '随包找不到 screen-recorder.apk（应位于 bin/screen-recorder.apk）' };
  }

  log('info', '录制', `正在安装采集端（${(fileSize(apk) / 1024).toFixed(0)} KB）…`);
  const res = await runAdb(['-s', s, 'install', '-r', '-t', apk.replace(/\\/g, '/')], {
    source: '录制',
    timeout: 180_000,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  if (!res.ok || /Failure|Error/i.test(out)) {
    return { ok: false, message: out.trim().slice(0, 400) || '安装失败' };
  }

  /*
   * `Success` ≠ 真装上 —— 与项目里其它安装一致的复核：
   * adb install 可能报 Success 而实际没落盘（多设备/空间不足等）。
   */
  const after = await probeInstalled(s);
  if (!after.installed) {
    return { ok: false, message: 'adb 报告安装成功，但按包名复核不到，请重试' };
  }

  log('success', '录制', `采集端已安装（versionCode ${after.versionCode ?? '未知'}）`);
  return { ok: true, message: `采集端已安装（versionCode ${after.versionCode ?? '未知'}）` };
}

/**
 * 拉起授权：打开采集端界面并请求 MediaProjection 权限。
 *
 * **这步必须用户在手机上点确认** —— Android 的录屏授权框只能由 Activity
 * 请求，没有自动化余地。所以这里只负责把界面拉起来。
 */
export async function authorizeRecorder(serial?: string): Promise<boolean> {
  const s = await ensureDevice(serial);
  const res = await runAdb(
    ['-s', s, 'shell', 'am', 'start', '-n', RECORDER_ACTIVITY, '--ez', 'request_auth', 'true'],
    { source: '录制', silent: true, timeout: 12000 },
  );
  if (!res.ok || /Error|Exception/i.test(res.stdout + res.stderr)) {
    log('warn', '录制', `拉起采集端界面失败：${(res.stdout + res.stderr).trim().slice(0, 200)}`);
    return false;
  }
  log('info', '录制', '已在设备上打开采集端，请在手机上点「授权录屏」后确认');
  return true;
}

/**
 * 只把界面拉到前台（不请求授权）。
 *
 * ⚠️ **不要再在「开始录制」里调它** —— 那正是「一点开始就跳回录制界面」
 * 的根因。现在录制全程由电脑控制、设备侧退居后台，用户需要在**任意 App**
 * 上操作，任何把采集端拉到前台的动作都会打断他。
 *
 * 保留只是为了：「采集端状态」里点一下看预览，或排查问题时手动打开。
 */
export async function openRecorderUi(serial?: string): Promise<boolean> {
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'am', 'start', '-n', RECORDER_ACTIVITY], {
    source: '录制', silent: true, timeout: 12000,
  });
  return res.ok;
}

/**
 * 把采集端界面**退回后台**。
 *
 * 用途：万一用户手动打开了采集端、又不想被它挡着，
 * 电脑端可以主动把它推回去。用 `am start` 同一个 Activity 再配合
 * HOME 键等效操作 —— 但直接按 HOME 最稳（不需要知道 Activity 名）。
 *
 * ⚠️ 按 HOME 会让用户回到桌面而不是他原来的 App。真正正确的做法是
 * 在设备侧 `moveTaskToBack`（授权后已经自动做了）。这里只作兜底，
 * 调用前请确认用户能接受"回到桌面"。
 */
export async function backgroundRecorderUi(serial?: string): Promise<boolean> {
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'], {
    source: '录制', silent: true, timeout: 10000,
  });
  return res.ok;
}

/**
 * 录制前置检查：报告「画面链路 + 触摸链路」各自是否可用。
 *
 * 界面在点「开始录制」之前调它 —— 把「这台设备读不到触摸」这类问题
 * **提前**暴露出来，而不是录完了才发现触摸是空的。
 */
export async function prepareRecorder(serial?: string): Promise<RecorderPrepare> {
  const s = await ensureDevice(serial);
  const info = await recorderInfo(s);
  if (!info.installed) {
    return {
      ok: false,
      installed: false,
      authorized: false,
      touchOk: false,
      touchNote: '',
      note: '设备上还没装屏幕录制采集端',
    };
  }
  const prep = await prepareTouch(s);
  const ok = info.ready && prep.ok;
  return {
    ok,
    installed: true,
    authorized: info.authorized,
    touchOk: prep.ok,
    touchNote: prep.note,
    note: !info.ready
      ? info.note
      : !info.authorized
        ? '还没获得录屏授权 —— 点「授权录屏」后在手机上确认一次即可，之后不用再点'
        : !prep.ok
          ? `触摸采集不可用：${prep.note}`
          : '画面与触摸两条链路都就绪，可以直接开始录制',
  };
}

/* ------------------------------------------------------------------ */
/* 录制控制                                                            */
/* ------------------------------------------------------------------ */

/** 前置：确保 forward 通 + 服务在跑，否则给出可读的错误 */
async function requireReady(serial?: string): Promise<string> {
  const s = await ensureDevice(serial);
  const info = await recorderInfo(s);
  if (!info.ready) throw new Error(info.note);
  return s;
}

/**
 * 开始录制 —— 电脑端一次性拉起**两路**采集。
 *
 * 两路都成了才算成功；后续那路失败要**回滚前面那路**，
 * 否则会留下「画面在采、触摸没采」或反过来的半截状态，
 * 拉回来的数据缺一半还看不出来。
 *
 * 顺序：先探触摸节点（纯读，失败代价最低）→ 再起设备侧 → 最后起 getevent。
 * 这样最可能失败的（触摸节点探测）摆在最前面，不会白起设备侧。
 */
export async function startRecording(serial?: string): Promise<RecorderStatus> {
  const s = await requireReady(serial);

  // 新一次录制开始：丢掉上一次停止时接住的快照，免得拉取到上一轮的旧数据
  stoppedTouches = [];

  // 1) 先确认这台设备能读触摸 —— 读不到就没必要往下走
  const prep = await prepareTouch(s);
  if (!prep.ok) {
    throw new Error(`无法采集触摸：${prep.note}`);
  }
  log('info', '录制', prep.note);

  // 2) 设备侧开始采集画面
  const res = await httpPost('/start', {}, 10000);
  const j = parseJson<Record<string, unknown>>(res.body);
  if (!j.ok) {
    const code = String(j.code || '');
    if (code === 'need_authorize') {
      throw new Error('还没获得录屏授权 —— 请点「授权录屏」，在手机上点「立即开始」后重试');
    }
    throw new Error(String(j.error || '开始录制失败'));
  }

  // 3) 电脑侧开始采触摸。失败要回滚设备侧，不能留半截状态
  try {
    const status = await recorderStatus(s);
    await startCapture(s, {
      screenWidth: status.meta.width,
      screenHeight: status.meta.height,
    });
  } catch (e) {
    try {
      await httpPost('/stop', {}, 8000);
    } catch {
      /* 回滚失败就把原始错误抛出去，别掩盖 */
    }
    throw new Error(`设备侧已开始但触摸采集起不来，已回滚：${(e as Error).message}`);
  }

  log('info', '录制', '已在设备侧与电脑侧同时开始采集（画面 + 触摸）');
  return recorderStatus(s);
}

/**
 * 暂停 / 恢复 —— 两路同步。
 *
 * 顺序：**先停触摸再停画面**？不 —— 反了。正确顺序是
 * **先让两边都进入暂停**，任何一路先停都会导致另一路多记一段。
 * 由于两边都是"置标记"而非"断流"，实际差别只在毫秒级；
 * 这里统一先设备侧后电脑侧，与 start 的顺序对称（先设备后电脑）。
 */
export async function pauseRecording(paused: boolean, serial?: string): Promise<RecorderStatus> {
  const s = await requireReady(serial);
  await httpPost('/pause', { paused }, 8000);
  setTouchPaused(paused);
  return recorderStatus(s);
}

/**
 * 停止录制 —— 两路一起收。
 *
 * 先停触摸：`getevent` 子进程要收干净（否则设备上留个 shell 挂着）。
 * 再停设备侧：HTTP 断开就行，不会有残留进程。
 */
export async function stopRecording(serial?: string): Promise<RecorderStatus> {
  const s = await requireReady(serial);

  /*
   * 🔴 `stopCapture()` 会把模块内的触摸缓冲**交出来并清空** —— 这里必须接住它，
   * 不能只取 `.length` 就丢掉。否则用户点完「停止录制」再点「拉取并转成脚本」时，
   * `capturedTouches()` 已经是空数组，转不出任何步骤，表现就是「录了半天没有脚本」。
   */
  stoppedTouches = await stopCapture();
  await httpPost('/stop', {}, 8000);

  log('info', '录制', `已停止：电脑侧触摸 ${stoppedTouches.length} 条 + 设备侧画面`);
  return recorderStatus(s);
}

export async function resetRecording(serial?: string): Promise<void> {
  const s = await requireReady(serial);
  // 电脑侧如果还在采，先收干净再清
  if (capturedTouches().length > 0) await stopCapture();
  resetCapture();
  stoppedTouches = [];
  await httpPost('/reset', {}, 8000);
}

/**
 * 彻底放弃本次录制（换设备、关页面时调）。
 *
 * 与 [stopRecording] 的区别：这个**不留数据**，纯粹是把资源收干净。
 * 出错也要保证两条链路都断 —— 所以各自 try/catch，不让一个失败
 * 把另一个漏掉（漏了就是设备上挂着一个 getevent 进程）。
 */
export async function cancelRecording(serial?: string): Promise<void> {
  try {
    await stopCapture();
  } catch (e) {
    log('warn', '录制', `停止触摸采集失败：${(e as Error).message}`);
  }
  resetCapture();
  try {
    const s = await ensureDevice(serial);
    await httpPost('/stop', {}, 6000);
    void s;
  } catch {
    /* 设备可能已经断了，忽略 */
  }
}

export async function recorderStatus(serial?: string): Promise<RecorderStatus> {
  const s = await ensureDevice(serial);
  await ensureForward(s);
  const res = await httpGet('/status', 6000);
  const j = parseJson<Record<string, unknown>>(res.body);
  const meta = (j.meta || {}) as Record<string, unknown>;
  // 触摸计数以**电脑侧**为准：设备侧那块计数已经废了（它只看自己画布）
  const touchCount = capturedTouches().length;
  return {
    recording: !!j.recording,
    paused: !!j.paused,
    capturing: !!j.capturing,
    elapsedMs: Number(j.elapsedMs) || 0,
    meta: {
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      density: Number(meta.density) || 0,
      landscape: !!meta.landscape,
    },
    touchCount: touchCount > 0 ? touchCount : Number(j.touchCount) || 0,
    frameCount: Number(j.frameCount) || 0,
    sysCount: Number(j.sysCount) || 0,
    note: typeof j.note === 'string' ? j.note : '',
  };
}

/**
 * 拉取完整录制数据。
 *
 * 触摸来自**电脑侧**（`getevent`），画面与系统事件来自**设备侧**。
 * 两路的时间基准要对齐：
 *   · 设备侧 `t` = 相对它 `/start` 时刻的毫秒（暂停不累加）；
 *   · 电脑侧 `t` = 相对 `getevent` 起来那一刻的毫秒。
 *
 * 两个起算点相差约 100~300ms（先发 HTTP 再起子进程）。这个偏差
 * 对连点器回放的影响很小（脚本按步骤顺序执行，不是在绝对时刻插桩），
 * 所以这里**只做日志提示，不强行平移** —— 强行平移要引入一个估算
 * 常数，反而把事情搞复杂。
 */
export async function pullRecording(serial?: string): Promise<RecordedSession> {
  const s = await requireReady(serial);

  const [touchRes, eventRes] = await Promise.all([
    httpGet('/touches', 20000),
    httpGet('/events', 20000),
  ]);
  const touchJson = parseJson<Record<string, unknown>>(touchRes.body);
  const eventJson = parseJson<Record<string, unknown>>(eventRes.body);

  const metaRaw = (touchJson.meta || eventJson.meta || {}) as Record<string, unknown>;
  const meta: ClickerRecordMeta = {
    width: Number(metaRaw.width) || 0,
    height: Number(metaRaw.height) || 0,
    density: Number(metaRaw.density) || 0,
    landscape: !!metaRaw.landscape,
  };

  // 触摸优先用电脑侧采集的（覆盖全 App）。
  // 录制中读实时缓冲；已经「停止」过就读停止那一刻接住的快照（否则会是空数组）。
  const live = capturedTouches();
  const localTouches = live.length > 0 ? live : stoppedTouches;
  let touches: RecordedTouch[];
  if (localTouches.length > 0) {
    touches = localTouches.map((t: CapturedTouch) => ({
      type: t.type,
      nx: t.nx,
      ny: t.ny,
      t: t.t,
    }));
  } else {
    touches = Array.isArray(touchJson.touches)
      ? (touchJson.touches as Record<string, unknown>[]).map((t) => ({
          type: String(t.type) as RecordedTouch['type'],
          nx: Number(t.nx) || 0,
          ny: Number(t.ny) || 0,
          t: Number(t.t) || 0,
        }))
      : [];
    if (touches.length > 0) {
      log('warn', '录制', '电脑侧触摸为空，回退到设备侧采集的触摸数据（可能只有采集端画布上的操作）');
    }
  }

  // 从合并时间线里挑出帧与系统事件
  const frames: RecordedFrame[] = [];
  const sysEvents: RecordedSysEvent[] = [];
  if (Array.isArray(eventJson.events)) {
    for (const raw of eventJson.events as Record<string, unknown>[]) {
      const kind = String(raw.kind || '');
      const data = (raw.data || {}) as Record<string, unknown>;
      if (kind === 'frame') {
        frames.push({
          t: Number(data.t) || 0,
          id: Number(data.id) || 0,
          bytes: Number(data.bytes) || 0,
        });
      } else if (kind === 'sys') {
        sysEvents.push({
          kind: String(data.kind || ''),
          pkg: String(data.pkg || ''),
          t: Number(data.t) || 0,
          label: String(data.label || ''),
        });
      }
    }
  }

  log(
    'success',
    '录制',
    `已拉取录制数据：触摸 ${touches.length} 条（${localTouches.length > 0 ? '电脑侧' : '设备侧'}）/ ` +
      `帧 ${frames.length} 张 / 事件 ${sysEvents.length} 条`,
  );

  return { meta, touches, frames, sysEvents };
}

/**
 * 取一张关键帧的 JPEG（转 base64 给界面直接塞进 img src）。
 *
 * 为什么走 base64 而不是写临时文件：
 * 界面只是显示缩略图，不值得为它管理一套临时文件的生命周期（谁删、何时删）。
 * data: URL 虽大一点，但一次性用完就随组件卸载释放了，最省心。
 */
export async function fetchFrame(frameId: number, serial?: string): Promise<string> {
  const s = await ensureDevice(serial);
  await ensureForward(s);
  const buf = await httpGetBinary(`/frame?id=${frameId}`);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * 把采集端 APK 装到设备上（供「一键准备」用）。
 * 与 installRecorder 同一实现，只是命名更贴近调用处的语义。
 */
export { installRecorder as ensureRecorderInstalled };
