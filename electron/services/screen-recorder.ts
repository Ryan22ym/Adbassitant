import { join } from 'path';
import { existsSync } from 'fs';
import { runAdb, ensureDevice, log, fileSize } from './adb';
import { getSettings } from './settings';
import type {
  RecorderInfo,
  RecorderStatus,
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
 * ## 为什么采集必须放在设备侧
 *
 * Android 5.0 起，第三方 App **读不到自己以外的触摸事件**
 * （要 INJECT_EVENTS，只有系统签名或 root 有）。所以在电脑侧"看"用户
 * 在手机上的操作是不可能的。可行路径只有一个：让设备侧 App 自己
 * 用 MediaProjection 把屏幕画面采集到自己的窗口里，用户在这个窗口上操作 ——
 * 触摸事件落在它自己身上，天然就拿得到。
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

/** 只把界面拉到前台（不请求授权）—— 让用户能看到那块画布 */
export async function openRecorderUi(serial?: string): Promise<boolean> {
  const s = await ensureDevice(serial);
  const res = await runAdb(['-s', s, 'shell', 'am', 'start', '-n', RECORDER_ACTIVITY], {
    source: '录制', silent: true, timeout: 12000,
  });
  return res.ok;
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

export async function startRecording(serial?: string): Promise<RecorderStatus> {
  const s = await requireReady(serial);
  const res = await httpPost('/start', {}, 10000);
  const j = parseJson<Record<string, unknown>>(res.body);
  if (!j.ok) {
    const code = String(j.code || '');
    if (code === 'need_authorize') {
      throw new Error('还没获得录屏授权 —— 请点「授权录屏」，在手机上点「立即开始」后重试');
    }
    throw new Error(String(j.error || '开始录制失败'));
  }
  log('info', '录制', '已在设备侧开始录制');
  return recorderStatus(s);
}

export async function pauseRecording(paused: boolean, serial?: string): Promise<RecorderStatus> {
  const s = await requireReady(serial);
  await httpPost('/pause', { paused }, 8000);
  return recorderStatus(s);
}

export async function stopRecording(serial?: string): Promise<RecorderStatus> {
  const s = await requireReady(serial);
  await httpPost('/stop', {}, 8000);
  log('info', '录制', '已停止设备侧录制');
  return recorderStatus(s);
}

export async function resetRecording(serial?: string): Promise<void> {
  const s = await requireReady(serial);
  await httpPost('/reset', {}, 8000);
}

export async function recorderStatus(serial?: string): Promise<RecorderStatus> {
  const s = await ensureDevice(serial);
  await ensureForward(s);
  const res = await httpGet('/status', 6000);
  const j = parseJson<Record<string, unknown>>(res.body);
  const meta = (j.meta || {}) as Record<string, unknown>;
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
    touchCount: Number(j.touchCount) || 0,
    frameCount: Number(j.frameCount) || 0,
    sysCount: Number(j.sysCount) || 0,
    note: typeof j.note === 'string' ? j.note : '',
  };
}

/**
 * 拉取完整录制数据。
 *
 * 拉两个端点拼起来（/events 太重且 frame 只有元信息，/touches 轻）：
 * 其实 /events 已经包含全部，但它把帧的 id 也带上了，
 * 这里用 /touches + /events 各取所需反而更清晰 —— 不用在一个大数组里筛。
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

  const touches: RecordedTouch[] = Array.isArray(touchJson.touches)
    ? (touchJson.touches as Record<string, unknown>[]).map((t) => ({
        type: String(t.type) as RecordedTouch['type'],
        nx: Number(t.nx) || 0,
        ny: Number(t.ny) || 0,
        t: Number(t.t) || 0,
      }))
    : [];

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
    `已拉取录制数据：触摸 ${touches.length} 条 / 帧 ${frames.length} 张 / 事件 ${sysEvents.length} 条`,
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
