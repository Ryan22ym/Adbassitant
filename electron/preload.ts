import { contextBridge, ipcRenderer } from 'electron';

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
