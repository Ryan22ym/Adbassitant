import { create } from 'zustand';
import type {
  DeviceInfo,
  LogEntry,
  MirrorStatus,
  AppSettings,
  RecordSession,
  InstallMode,
  InstallKind,
} from '@shared/types';

/* ------------------------------------------------------------------ */
/* 全局应用状态                                                        */
/* ------------------------------------------------------------------ */

interface ToastItem {
  id: string;
  tone: 'success' | 'error' | 'warn' | 'info';
  message: string;
  detail?: string;
}

/**
 * 拖放安装任务的界面状态。
 *
 * 它同时承担两个职责：
 * 1. 驱动「正在安装中 / 安装成功 / 安装失败」弹窗；
 * 2. 作为渲染层的防重复依据 —— phase === 'installing' 时，拖放与安装按钮
 *    都必须拒绝新任务（主进程还有一道 installApk 互斥锁兜底）。
 */
export interface InstallTask {
  phase: 'installing' | 'success' | 'error';
  /** 展示用文件名，多文件时为「名字（2/3）」 */
  fileName: string;
  /** 本地安装包绝对路径 */
  apkPath: string;
  /** 安装包类型：apk 直接装；aab 要先拆包，耗时明显更长 */
  kind?: InstallKind;
  /** 文件大小（字节），拖放时由 File.size 提供，可能为空 */
  sizeBytes?: number;
  /** 成功时为 adb 输出，失败时为失败原因 */
  message?: string;
  /** 安装方式的中文标签（覆盖 / 清洁 / 全新）—— 让用户知道数据会不会被清 */
  modeLabel?: string;
  /**
   * 目标设备标签（型号 · Android 版本）+ 序列号。
   * 多台设备在线时必须能看到究竟装到哪台，否则「装到别的机器上」无从察觉。
   */
  device?: string;
  /** 从 APK 里读出的包名 / 版本，装完复核用 */
  packageName?: string;
  /** 装后是否按包名复核到（undefined = 读不出包名没复核） */
  verified?: boolean;
  /** 第几个 / 总共几个（多文件顺序安装时用） */
  index?: number;
  total?: number;
  startedAt: number;
  finishedAt?: number;
}

/** 一个待安装的包（只放渲染层需要的最少信息） */
export interface InstallFile {
  /** 本地绝对路径 */
  path: string;
  /** 展示用文件名 */
  name: string;
  /** 文件大小（字节），拖放时可由 File.size 得到 */
  size?: number;
  /** 类型：不填时按扩展名推断（.apk / .aab） */
  kind?: InstallKind;
}

/**
 * 已接下、但还没确定装到哪台设备的安装请求。
 *
 * 多台设备同时在线时，安装目标是个必须由用户回答的问题：
 * 谁也没法从「拖了一个 APK 进来」推断出用户想装到手机还是模拟器。
 * 交给用户点一下，比默默挑一台然后显示「安装成功」安全得多。
 */
export interface PendingInstall {
  files: InstallFile[];
  mode: InstallMode;
  grantAll: boolean;
}

interface AppState {
  /* 设备 */
  devices: DeviceInfo[];
  currentSerial?: string;
  scanning: boolean;
  setDevices: (d: DeviceInfo[]) => void;
  setCurrentSerial: (s?: string) => void;
  setScanning: (v: boolean) => void;

  /* 日志 */
  logs: LogEntry[];
  appendLog: (e: LogEntry) => void;
  setLogs: (l: LogEntry[]) => void;
  clearLogs: () => void;

  /* 投屏 */
  mirror: MirrorStatus;
  setMirror: (s: MirrorStatus) => void;

  /* 录屏 */
  record: RecordSession | null;
  setRecord: (r: RecordSession | null) => void;

  /* 设置 */
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;

  /* 主题 */
  theme: 'light' | 'dark';
  applyTheme: (t: 'light' | 'dark') => void;

  /* Toast */
  toasts: ToastItem[];
  toast: (tone: ToastItem['tone'], message: string, detail?: string) => void;
  dismissToast: (id: string) => void;

  /* 拖放安装 */
  install: InstallTask | null;
  setInstall: (t: InstallTask | null) => void;
  /**
   * 当前安装方式。放在 store 里是为了让「整窗拖放」和「安装 APK 页的按钮/拖放区」
   * 走同一个值 —— 否则用户选了清洁安装，拖进去却是覆盖安装，会莫名其妙丢数据。
   * 故意不做持久化：默认永远是覆盖安装这个不破坏数据的选项。
   */
  installMode: InstallMode;
  setInstallMode: (m: InstallMode) => void;
  /** 是否正把文件拖在窗口上方（用于显示全窗拖放提示） */
  dragActive: boolean;
  setDragActive: (v: boolean) => void;
  /**
   * 等待用户指定目标设备的安装请求（null = 没有）。
   * 多台设备在线时先落到这里，由界面向用户问「装到哪台」，不猜。
   */
  pendingInstall: PendingInstall | null;
  setPendingInstall: (p: PendingInstall | null) => void;
}

const MAX_LOGS = 3000;

export const useApp = create<AppState>((set, get) => ({
  /* ---------------- 设备 ---------------- */
  devices: [],
  currentSerial: undefined,
  scanning: false,

  setDevices: (devices) => {
    const { currentSerial } = get();
    const online = devices.filter((d) => d.state === 'device');
    let next = currentSerial;
    // 当前设备掉线时自动切换：优先物理设备。
    // 取 online[0] 是不行的 —— 列表顺序就是 adb 的返回顺序，模拟器常排在前面，
    // 于是「插着手机却一路装到模拟器上」，界面上还显示安装成功。
    if (!currentSerial || !online.some((d) => d.serial === currentSerial)) {
      next = (online.find((d) => !d.isEmulator) ?? online[0])?.serial;
    }
    // 设备列表与当前选择都未变化时跳过，避免触发无意义的重渲染
    const prev = get().devices;
    const sameList =
      prev.length === devices.length &&
      prev.every((d, i) => d.serial === devices[i]?.serial && d.state === devices[i]?.state);
    if (sameList && next === currentSerial) return;

    set({ devices, currentSerial: next });
  },

  setCurrentSerial: (currentSerial) => set({ currentSerial }),
  setScanning: (scanning) => set({ scanning }),

  /* ---------------- 日志 ---------------- */
  logs: [],

  appendLog: (e) => {
    const logs = get().logs;
    const next = logs.length >= MAX_LOGS ? [...logs.slice(-MAX_LOGS + 1), e] : [...logs, e];
    set({ logs: next });
  },

  setLogs: (logs) => set({ logs }),
  clearLogs: () => set({ logs: [] }),

  /* ---------------- 投屏 ---------------- */
  mirror: { running: false },
  setMirror: (mirror) => set({ mirror }),

  /* ---------------- 录屏 ---------------- */
  record: null,
  setRecord: (record) => set({ record }),

  /* ---------------- 设置 ---------------- */
  settings: null,
  setSettings: (settings) => {
    set({ settings });
    // 同步主题到 DOM（不写回 settings，避免循环）
    const t = settings.theme === 'dark' ? 'dark' : 'light';
    if (get().theme !== t) {
      document.documentElement.setAttribute('data-theme', t);
      set({ theme: t });
    }
  },

  /* ---------------- 主题 ---------------- */
  theme: 'light',
  applyTheme: (theme) => {
    if (get().theme === theme) return;
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  /* ---------------- Toast ---------------- */
  toasts: [],

  toast: (tone, message, detail) => {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { id, tone, message, detail }] });
    setTimeout(() => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, tone === 'error' ? 5200 : 3200);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  /* ---------------- 拖放安装 ---------------- */
  install: null,
  setInstall: (install) => set({ install }),

  installMode: 'overwrite',
  setInstallMode: (installMode) => set({ installMode }),

  dragActive: false,
  setDragActive: (dragActive) => {
    if (get().dragActive !== dragActive) set({ dragActive });
  },

  pendingInstall: null,
  setPendingInstall: (pendingInstall) => set({ pendingInstall }),
}));

/* ------------------------------------------------------------------ */
/* 当前设备选择器                                                      */
/* ------------------------------------------------------------------ */

/**
 * 注意：选择器必须返回稳定引用，否则 zustand 每次比较都会认为状态变化，
 * 导致 React 无限重渲染。设备查找只依赖 devices 与 currentSerial 两个原子值。
 */

/** 当前选中的设备（返回对象引用，来自 devices 数组内部，引用稳定） */
export function useCurrentDevice(): DeviceInfo | undefined {
  const devices = useApp((s) => s.devices);
  const currentSerial = useApp((s) => s.currentSerial);
  return devices.find((d) => d.serial === currentSerial);
}

/** 在线设备数量（返回数字，天然稳定） */
export function useOnlineCount(): number {
  return useApp((s) => s.devices.filter((d) => d.state === 'device').length);
}
