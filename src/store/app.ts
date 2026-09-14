import { create } from 'zustand';
import type {
  DeviceInfo,
  LogEntry,
  MirrorStatus,
  AppSettings,
  RecordSession,
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
    // 当前设备掉线时自动切换到第一个在线设备
    if (!currentSerial || !online.some((d) => d.serial === currentSerial)) {
      next = online[0]?.serial;
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
