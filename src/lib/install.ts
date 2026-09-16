import { useApp, type InstallTask } from '@/store/app';
import { call } from '@/lib/ipc';

/**
 * 拖放 / 按钮安装的统一入口。
 *
 * 不管是「拖到窗口」还是「安装 APK 页点按钮」，都必须走这里，原因：
 * 1. 防重复 —— 同一时刻只允许一个安装任务（后面还有主进程互斥锁兜底）；
 * 2. 进度反馈 —— 安装中 / 成功 / 失败三种状态都写进 store，由同一个弹窗渲染。
 */

/** 一个待安装的 APK */
export interface InstallFile {
  /** 本地绝对路径 */
  path: string;
  /** 展示用文件名 */
  name: string;
  /** 文件大小（字节），拖放时可由 File.size 得到 */
  size?: number;
}

export interface InstallOptions {
  /** 覆盖安装（-r），默认 true */
  reinstall?: boolean;
  /** 自动授予全部权限（-g），默认 false */
  grantAll?: boolean;
}

/** 成功弹窗自动关闭的延时（毫秒）—— 失败弹窗不自动关，需要用户看到原因 */
const SUCCESS_AUTO_CLOSE_MS = 1600;

/** 是否有安装任务正在进行（拖放与按钮共用同一判据） */
export function isInstalling(): boolean {
  return useApp.getState().install?.phase === 'installing';
}

/** 关闭安装结果弹窗（安装中不允许关闭） */
export function dismissInstall(): void {
  if (isInstalling()) return;
  useApp.getState().setInstall(null);
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
 * 当前选中的在线设备。
 * 拖放安装没有「点的是哪台设备」这个上下文，只能用界面上选中的那台。
 */
function currentOnlineDevice() {
  const st = useApp.getState();
  return st.devices.find((d) => d.serial === st.currentSerial && d.state === 'device');
}

/**
 * 顺序安装一批 APK。多文件时逐个安装（adb install 本身不能并行），
 * 任意一个失败就停下并展示失败原因，避免连续弹一串错误。
 */
export async function installApkFiles(
  files: InstallFile[],
  options: InstallOptions = {},
): Promise<void> {
  const st = useApp.getState();

  if (files.length === 0) return;

  /* ---- 防重复：安装中一律拒绝新任务 ---- */
  if (isInstalling()) {
    const cur = useApp.getState().install;
    st.toast('warn', '正在安装中，请稍候', `当前任务：${cur?.fileName ?? '安装中'}`);
    return;
  }

  const device = currentOnlineDevice();
  if (!device) {
    st.toast('warn', '请先连接设备', '拖放安装需要一台已授权 USB 调试的在线设备');
    return;
  }

  const reinstall = options.reinstall ?? true;
  const grantAll = options.grantAll ?? false;
  const total = files.length;

  const beginTask = (index: number): InstallTask => ({
    phase: 'installing',
    fileName: total > 1 ? `${files[index].name}（${index + 1}/${total}）` : files[index].name,
    apkPath: files[index].path,
    sizeBytes: files[index].size,
    index: index + 1,
    total,
    startedAt: Date.now(),
  });

  for (let i = 0; i < total; i += 1) {
    const task = beginTask(i);
    useApp.getState().setInstall(task);

    try {
      const output = await call<string>(
        () => window.adbApi.installApk(device.serial, files[i].path, reinstall, grantAll),
        { silent: true },
      );

      // 中间文件安装成功不改变 phase，继续装下一个（弹窗仍显示「正在安装中」）
      if (i === total - 1) {
        const done: InstallTask = {
          ...task,
          phase: 'success',
          message: cleanOutput(output) || 'Success',
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
