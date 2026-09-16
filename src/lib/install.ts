import { useApp, type InstallFile, type InstallTask } from '@/store/app';
import type { DeviceInfo } from '@shared/types';
import { deviceLabel } from '@/components/layout';
import { call } from '@/lib/ipc';
import { INSTALL_MODE_LABEL, type InstallMode, type InstallResult } from '@shared/types';

/**
 * 拖放 / 按钮安装的统一入口。
 *
 * 不管是「拖到窗口」还是「安装 APK 页点按钮」，都必须走这里，原因：
 * 1. 防重复 —— 同一时刻只允许一个安装任务（后面还有主进程互斥锁兜底）；
 * 2. 进度反馈 —— 安装中 / 成功 / 失败三种状态都写进 store，由同一个弹窗渲染；
 * 3. **目标设备必须落实** —— 多台设备在线时不允许猜（见 installApkFiles）。
 */

export type { InstallFile };

export interface InstallOptions {
  /** 安装方式，默认 overwrite（-r 覆盖、保留数据） */
  mode?: InstallMode;
  /** 自动授予全部权限（-g），默认 false */
  grantAll?: boolean;
  /**
   * 明确指定目标设备。只有调用方确实知道该装哪台时才传。
   * 默认不传 → 由本模块决定（单设备直接装，多设备问用户）。
   */
  serial?: string;
}

/** 成功弹窗自动关闭的延时（毫秒）—— 失败弹窗不自动关，需要用户看到原因 */
const SUCCESS_AUTO_CLOSE_MS = 1600;

/** 是否有安装任务正在执行（拖放与按钮共用同一判据） */
export function isInstalling(): boolean {
  return useApp.getState().install?.phase === 'installing';
}

/** 是否正在等用户指定目标设备 */
export function isAwaitingTarget(): boolean {
  return useApp.getState().pendingInstall !== null;
}

/** 安装相关的一切「占用中」状态：安装中 或 等用户选设备 */
export function isBusy(): boolean {
  return isInstalling() || isAwaitingTarget();
}

/** 关闭安装结果弹窗（安装中不允许关闭） */
export function dismissInstall(): void {
  if (isInstalling()) return;
  useApp.getState().setInstall(null);
}

/** 放弃这次安装（用户在选择目标设备的弹窗里点了取消） */
export function cancelPendingInstall(): void {
  useApp.getState().setPendingInstall(null);
}

/**
 * 取拖入文件在磁盘上的真实路径。
 *
 * 走 preload 暴露的 webUtils.getPathForFile（Electron 32+ 已移除 File.path）。
 * 兼容性兜底：极老版本 Electron 上回落到 file.path。
 */
export function pathOfDroppedFile(file: File): string {
  const api = window.adbApi as unknown as {
    getPathForFile?: (f: File) => string;
  };
  if (typeof api.getPathForFile === 'function') {
    try {
      const p = api.getPathForFile(file);
      if (p) return p;
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return (file as File & { path?: string }).path || '';
}

/** 从拖放事件的 File 列表里挑出 APK，并解析出磁盘路径 */
export function collectApks(files: File[]): { apks: InstallFile[]; skipped: number } {
  const apks: InstallFile[] = [];
  let skipped = 0;

  for (const f of files) {
    if (!/\.apk$/i.test(f.name)) {
      skipped += 1;
      continue;
    }
    const path = pathOfDroppedFile(f);
    if (!path) {
      // 明确是 APK 但拿不到路径（如从压缩包里直接拖出来的虚拟文件）
      skipped += 1;
      continue;
    }
    apks.push({ path, name: f.name, size: f.size });
  }

  return { apks, skipped };
}

/**
 * 可供安装选择的在线设备，**物理设备排在模拟器前面**。
 *
 * 顺序是有意义的：模拟器常年在线，若按 adb 的返回顺序排在前面，
 * 用户「拖个包上去」很容易一路装到模拟器，而手机上什么都没有。
 */
export function selectableDevices(): DeviceInfo[] {
  const online = useApp.getState().devices.filter((d) => d.state === 'device');
  const real = online.filter((d) => !d.isEmulator);
  const emu = online.filter((d) => d.isEmulator);
  return [...real, ...emu];
}

/** 当前选中的在线设备 */
function currentOnlineDevice(): DeviceInfo | undefined {
  const st = useApp.getState();
  return st.devices.find((d) => d.serial === st.currentSerial && d.state === 'device');
}

/** 供界面使用：当前选中的在线设备（页面展示「将安装到」用） */
export function currentTarget(): DeviceInfo | undefined {
  return currentOnlineDevice();
}

/**
 * 顺序安装一批 APK。
 *
 * 目标设备的确定顺序（关键）：
 *   1. 调用方明确指定的 serial（且那台在线）；
 *   2. 只有一台在线设备 → 就是它，无歧义；
 *   3. **多台在线 → 不猜**，把请求挂到 pendingInstall 上，由弹窗问用户装到哪台。
 *
 * 第 3 条是这个模块存在的最大理由：多设备同时在线时，界面上的「当前设备」
 * 很可能不是用户以为的那台（模拟器先连上、或被点过一次就一直沿用），
 * 于是出现「显示安装成功、手机上没有」—— 而且装后复核也查不出问题，
 * 因为包确实装上了，只是装到了另一台设备上。
 */
export async function installApkFiles(
  files: InstallFile[],
  options: InstallOptions = {},
): Promise<void> {
  const st = useApp.getState();

  if (files.length === 0) return;

  /* ---- 防重复：安装中 / 正在选设备，一律拒绝新任务 ---- */
  if (isBusy()) {
    st.toast(
      'warn',
      isInstalling() ? '正在安装中，请稍候' : '请先选择安装到哪台设备',
      isInstalling() ? `当前任务：${st.install?.fileName ?? '安装中'}` : undefined,
    );
    return;
  }

  const mode = options.mode ?? 'overwrite';
  const grantAll = options.grantAll ?? false;

  const online = selectableDevices();
  if (online.length === 0) {
    st.toast('warn', '请先连接设备', '安装需要一台已授权 USB 调试的在线设备');
    return;
  }

  // 1. 调用方指定了目标，且那台在线 → 直接装
  if (options.serial) {
    const picked = online.find((d) => d.serial === options.serial);
    if (picked) return runInstall(files, mode, grantAll, picked);
    st.toast('warn', `指定的设备 ${options.serial} 不在线`, '请重新选择安装目标');
  }

  // 2. 只有一台在线设备 → 没有歧义，直接装
  if (online.length === 1) return runInstall(files, mode, grantAll, online[0]);

  // 3. 多台在线 → 问用户，不猜
  st.setInstall(null);
  st.setPendingInstall({ files, mode, grantAll });
}

/**
 * 用户在「装到哪台设备」弹窗里点了某台设备。
 * 顺手把它设成全局当前设备 —— 用户的选择就是当前设备，不该只对本批安装生效。
 */
export async function startInstallOn(serial: string): Promise<void> {
  const st = useApp.getState();
  const pending = st.pendingInstall;
  if (!pending) return;

  const device = st.devices.find((d) => d.serial === serial && d.state === 'device');
  st.setPendingInstall(null);

  if (!device) {
    st.toast('warn', `设备 ${serial} 已掉线`, '请重新连接后再试');
    return;
  }

  st.setCurrentSerial(serial);
  await runInstall(pending.files, pending.mode, pending.grantAll, device);
}

/** 真正执行安装（目标设备已确定） */
async function runInstall(
  files: InstallFile[],
  mode: InstallMode,
  grantAll: boolean,
  device: DeviceInfo,
): Promise<void> {
  const total = files.length;

  /* 目标设备要在弹窗里露出来 —— 多台设备在线时装错机器，光看「安装成功」是发现不了的 */
  const target = `${deviceLabel(device)} · ${device.serial}`;

  const beginTask = (index: number): InstallTask => ({
    phase: 'installing',
    fileName: total > 1 ? `${files[index].name}（${index + 1}/${total}）` : files[index].name,
    apkPath: files[index].path,
    sizeBytes: files[index].size,
    modeLabel: INSTALL_MODE_LABEL[mode],
    device: target,
    index: index + 1,
    total,
    startedAt: Date.now(),
  });

  for (let i = 0; i < total; i += 1) {
    const task = beginTask(i);
    useApp.getState().setInstall(task);

    try {
      const result = await call<InstallResult>(
        () => window.adbApi.installApk(device.serial, files[i].path, mode, grantAll),
        { silent: true },
      );

      // 中间文件安装成功不改变 phase，继续装下一个（弹窗仍显示「正在安装中」）
      if (i === total - 1) {
        const done: InstallTask = {
          ...task,
          phase: 'success',
          message: successMessage(result),
          packageName: result?.packageName,
          verified: result?.verified,
          finishedAt: Date.now(),
        };
        useApp.getState().setInstall(done);
        scheduleAutoClose(done.startedAt);
      }
    } catch (e) {
      useApp.getState().setInstall({
        ...task,
        phase: 'error',
        message: (e as Error).message || '安装失败',
        finishedAt: Date.now(),
      });
      return;
    }
  }
}

/** 成功详情：把「装到哪台、哪个包、有没有复核过」都写出来 */
function successMessage(r?: InstallResult): string {
  if (!r) return 'Success';
  const lines: string[] = [];

  const out = cleanOutput(r.output);
  if (out) lines.push(out);

  if (r.packageName) {
    lines.push(`包名：${r.packageName}${r.versionName ? ` v${r.versionName}` : ''}`);
  }
  if (r.uninstalled) lines.push('清洁安装：已先卸载旧版本，应用数据已清除');
  if (r.verified === true) lines.push(`已复核：${r.serial} 上确实存在该包`);
  else if (r.verified === undefined) lines.push('提示：读不出 APK 包名，本次未做装后复核');

  return lines.join('\n') || 'Success';
}

/** 去掉 adb install 输出里的空行与 Success 前缀噪音 */
function cleanOutput(output: string): string {
  return (output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 成功弹窗延时自动关闭。
 * 必须校验 startedAt —— 否则用户很快又拖了第二个 APK 时，
 * 上一个任务的定时器会把新任务的弹窗一起关掉。
 */
function scheduleAutoClose(startedAt: number): void {
  setTimeout(() => {
    const cur = useApp.getState().install;
    if (cur && cur.startedAt === startedAt && cur.phase === 'success') {
      useApp.getState().setInstall(null);
    }
  }, SUCCESS_AUTO_CLOSE_MS);
}
