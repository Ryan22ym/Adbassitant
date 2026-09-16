import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * IPC 通道常量
 * 注意：preload 运行在受限上下文，不引入 shared/ 模块（编译后相对路径会失效），
 * 这里保留一份字面量副本。修改通道名时需同步 shared/types.ts。
 */
const IPC = {
  DEVICE_LIST: 'device:list',
  DEVICE_DETAIL: 'device:detail',
  DEVICE_CONNECT_TCP: 'device:connectTcp',
  DEVICE_DISCONNECT_TCP: 'device:disconnectTcp',
  DEVICE_ADB_KILL: 'device:adbKill',
  DEVICE_ADB_START: 'device:adbStart',
  ENV_CHECK: 'env:check',
  ADB_RUN: 'adb:run',
  SCREEN_RESOLUTION: 'screen:resolution',
  SCREEN_SET_SIZE: 'screen:setSize',
  SCREEN_RESET: 'screen:reset',
  SCREENSHOT_CAPTURE: 'screenshot:capture',
  RECORD_START: 'record:start',
  RECORD_STOP: 'record:stop',
  RECORD_LIST: 'record:list',
  MIRROR_START: 'mirror:start',
  MIRROR_STOP: 'mirror:stop',
  MIRROR_STATUS: 'mirror:status',
  FILE_PUSH: 'file:push',
  FILE_PULL: 'file:pull',
  FILE_PICK: 'file:pick',
  FILE_PICK_DIR: 'file:pickDir',
  FILE_REVEAL: 'file:reveal',
  FILE_OPEN: 'file:open',
  APK_INSTALL: 'apk:install',
  MONKEY_RUN: 'monkey:run',
  MONKEY_STOP: 'monkey:stop',
  APP_LIST: 'app:list',

  /* 应用管理（v1.0） */
  APP_DETAIL: 'app:detail',
  APP_UNINSTALL: 'app:uninstall',
  APP_FORCE_STOP: 'app:forceStop',
  APP_CLEAR_DATA: 'app:clearData',
  APP_LAUNCH: 'app:launch',
  APP_EXTRACT_APK: 'app:extractApk',
  APP_SET_ENABLED: 'app:setEnabled',

  /* 常用应用（v1.0.1） */
  APP_FAVORITE_LIST: 'app:favoriteList',
  APP_FAVORITE_TOGGLE: 'app:favoriteToggle',
  APP_FAVORITE_REMOVE: 'app:favoriteRemove',

  /* 实时 Logcat（v1.0） */
  LOGCAT_START: 'logcat:start',
  LOGCAT_STOP: 'logcat:stop',
  LOGCAT_STATUS: 'logcat:status',
  LOGCAT_CLEAR: 'logcat:clear',
  LOGCAT_SAVE: 'logcat:save',
  LOGCAT_PROCESSES: 'logcat:processes',

  /* 弱网模拟（v1.0） */
  WEAKNET_START: 'weaknet:start',
  WEAKNET_STOP: 'weaknet:stop',
  WEAKNET_STATUS: 'weaknet:status',
  WEAKNET_PRESET_LIST: 'weaknet:presetList',
  WEAKNET_PRESET_SAVE: 'weaknet:presetSave',
  WEAKNET_PRESET_DELETE: 'weaknet:presetDelete',
  WEAKNET_PROBE: 'weaknet:probe',
  WEAKNET_CLEANUP: 'weaknet:cleanup',

  LOG_EXPORT: 'log:export',
  LOG_CLEAR: 'log:clear',
  LOG_LIST_ALL: 'log:listAll',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  PUSH_LOG: 'push:log',
  PUSH_MIRROR_STATUS: 'push:mirrorStatus',
  PUSH_RECORD_STATUS: 'push:recordStatus',
  PUSH_DEVICE_CHANGED: 'push:deviceChanged',
  PUSH_MONKEY_OUTPUT: 'push:monkeyOutput',
  PUSH_LOGCAT_LINES: 'push:logcatLines',
  PUSH_LOGCAT_STATUS: 'push:logcatStatus',
  PUSH_WEAKNET_STATUS: 'push:weaknetStatus',
} as const;

/**
 * 暴露给渲染进程的安全 API
 * 所有 Node / Electron 能力都封装在这里，渲染层不直接接触 Node
 */
const api = {
  /* 环境 */
  checkEnv: () => invoke(IPC.ENV_CHECK),

  /* 设备 */
  listDevices: () => invoke(IPC.DEVICE_LIST),
  deviceDetail: (serial: string) => invoke(IPC.DEVICE_DETAIL, serial),
  connectTcp: (address: string) => invoke(IPC.DEVICE_CONNECT_TCP, address),
  disconnectTcp: (address: string) => invoke(IPC.DEVICE_DISCONNECT_TCP, address),
  adbStart: () => invoke(IPC.DEVICE_ADB_START),
  adbKill: () => invoke(IPC.DEVICE_ADB_KILL),

  /* 命令 */
  runAdb: (serial: string | undefined, command: string) => invoke(IPC.ADB_RUN, serial, command),

  /* 屏幕 */
  getResolution: (serial?: string) => invoke(IPC.SCREEN_RESOLUTION, serial),
  setSize: (serial: string | undefined, size?: string, dpi?: number) =>
    invoke(IPC.SCREEN_SET_SIZE, serial, size, dpi),
  resetSize: (serial?: string) => invoke(IPC.SCREEN_RESET, serial),

  /* 截图 */
  captureScreenshot: (serial?: string) => invoke(IPC.SCREENSHOT_CAPTURE, serial),

  /* 录屏 */
  startRecord: (
    serial: string | undefined,
    durationSec: number,
    bitRateMbps: number,
    sizePx?: number,
    audio?: boolean,
  ) => invoke(IPC.RECORD_START, serial, durationSec, bitRateMbps, sizePx, audio),
  stopRecord: (id: string) => invoke(IPC.RECORD_STOP, id),

  /* 投屏 */
  startMirror: (options: any) => invoke(IPC.MIRROR_START, options),
  stopMirror: () => invoke(IPC.MIRROR_STOP),
  mirrorStatus: () => invoke(IPC.MIRROR_STATUS),

  /* 文件 */
  pickFiles: (multi = true, filters?: any[]) => invoke(IPC.FILE_PICK, multi, filters),
  pickDir: () => invoke(IPC.FILE_PICK_DIR),
  pushFiles: (serial: string | undefined, paths: string[], remoteDir: string) =>
    invoke(IPC.FILE_PUSH, serial, paths, remoteDir),
  pullFiles: (serial: string | undefined, remotePaths: string[], localDir: string) =>
    invoke(IPC.FILE_PULL, serial, remotePaths, localDir),
  reveal: (path: string) => invoke(IPC.FILE_REVEAL, path),
  openPath: (path: string) => invoke(IPC.FILE_OPEN, path),

  /* APK */
  installApk: (serial: string | undefined, apkPath: string, reinstall = true, grantAll = false) =>
    invoke(IPC.APK_INSTALL, serial, apkPath, reinstall, grantAll),

  /**
   * 取拖放进来的文件在磁盘上的真实路径。
   *
   * Electron 32 起移除了非标准的 `File.path`，拖放场景下渲染进程拿不到路径，
   * 只能用官方替代品 webUtils.getPathForFile()。它必须在本层（preload）调用，
   * 因为 webUtils 只有 preload / renderer 的原生侧才可用。
   * 返回空串表示该 File 不是来自磁盘（例如从网页拖进来的虚拟文件）。
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  /* 应用 / Monkey */
  listApps: (serial?: string, includeSystem = true) => invoke(IPC.APP_LIST, serial, includeSystem),
  runMonkey: (
    serial: string | undefined,
    pkg: string | undefined,
    events: number,
    throttle: number,
    seed?: number,
  ) => invoke(IPC.MONKEY_RUN, serial, pkg, events, throttle, seed),
  stopMonkey: () => invoke(IPC.MONKEY_STOP),

  /* 应用管理（v1.0） */
  appDetail: (serial: string | undefined, pkg: string) => invoke(IPC.APP_DETAIL, serial, pkg),
  uninstallApp: (serial: string | undefined, pkg: string, keepData = false) =>
    invoke(IPC.APP_UNINSTALL, serial, pkg, keepData),
  forceStopApp: (serial: string | undefined, pkg: string) =>
    invoke(IPC.APP_FORCE_STOP, serial, pkg),
  clearAppData: (serial: string | undefined, pkg: string) =>
    invoke(IPC.APP_CLEAR_DATA, serial, pkg),
  launchApp: (serial: string | undefined, pkg: string) => invoke(IPC.APP_LAUNCH, serial, pkg),
  extractApk: (serial: string | undefined, pkg: string, localDir: string) =>
    invoke(IPC.APP_EXTRACT_APK, serial, pkg, localDir),
  setAppEnabled: (serial: string | undefined, pkg: string, enabled: boolean) =>
    invoke(IPC.APP_SET_ENABLED, serial, pkg, enabled),

  /* 常用应用（v1.0.1） */
  favoriteApps: () => invoke(IPC.APP_FAVORITE_LIST),
  toggleFavorite: (pkg: string, label?: string) => invoke(IPC.APP_FAVORITE_TOGGLE, pkg, label),
  removeFavorite: (pkg: string) => invoke(IPC.APP_FAVORITE_REMOVE, pkg),

  /* 实时 Logcat（v1.0） */
  startLogcat: (serial: string | undefined, filter?: any) =>
    invoke(IPC.LOGCAT_START, serial, filter),
  stopLogcat: () => invoke(IPC.LOGCAT_STOP),
  logcatStatus: () => invoke(IPC.LOGCAT_STATUS),
  clearLogcat: () => invoke(IPC.LOGCAT_CLEAR),
  saveLogcat: (meta?: Record<string, string>) => invoke(IPC.LOGCAT_SAVE, meta),
  logcatProcesses: (serial?: string) => invoke(IPC.LOGCAT_PROCESSES, serial),

  /* 弱网模拟（v1.0） */
  weaknetStart: (serial: string | undefined, params: any) =>
    invoke(IPC.WEAKNET_START, serial, params),
  weaknetStop: () => invoke(IPC.WEAKNET_STOP),
  weaknetStatus: () => invoke(IPC.WEAKNET_STATUS),
  weaknetPresets: () => invoke(IPC.WEAKNET_PRESET_LIST),
  weaknetSavePreset: (name: string, params: any) =>
    invoke(IPC.WEAKNET_PRESET_SAVE, name, params),
  weaknetDeletePreset: (id: string) => invoke(IPC.WEAKNET_PRESET_DELETE, id),
  weaknetProbe: (serial?: string) => invoke(IPC.WEAKNET_PROBE, serial),
  weaknetCleanup: (serial?: string) => invoke(IPC.WEAKNET_CLEANUP, serial),

  /* 日志 */
  getAllLogs: () => invoke(IPC.LOG_LIST_ALL),
  clearLogs: () => invoke(IPC.LOG_CLEAR),
  exportLogs: () => invoke(IPC.LOG_EXPORT),

  /* 设置 */
  getSettings: () => invoke(IPC.SETTINGS_GET),
  setSettings: (patch: any) => invoke(IPC.SETTINGS_SET, patch),

  /* 事件订阅，返回取消函数 */
  on: (channel: string, cb: (payload: any) => void) => {
    const allowed = [
      IPC.PUSH_LOG,
      IPC.PUSH_MIRROR_STATUS,
      IPC.PUSH_RECORD_STATUS,
      IPC.PUSH_DEVICE_CHANGED,
      IPC.PUSH_MONKEY_OUTPUT,
      IPC.PUSH_LOGCAT_LINES,
      IPC.PUSH_LOGCAT_STATUS,
      IPC.PUSH_WEAKNET_STATUS,
      'push:screenshot',
    ];
    if (!allowed.includes(channel as any)) {
      console.warn(`[preload] 未允许的通道：${channel}`);
      return () => {};
    }
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  /* 通道常量，供渲染层引用 */
  channels: IPC,
};

function invoke(channel: string, ...args: any[]) {
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('adbApi', api);

export type AdbApi = typeof api;
