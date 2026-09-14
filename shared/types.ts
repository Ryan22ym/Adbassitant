/**
 * 主进程 <-> 渲染进程 共享类型定义
 * 这是整个项目的通信契约，任何 IPC 接口都必须在此声明
 */

/* ------------------------------------------------------------------ */
/* 设备                                                                */
/* ------------------------------------------------------------------ */

export interface DeviceInfo {
  /** adb 设备序列号 */
  serial: string;
  /** 设备状态：device / offline / unauthorized */
  state: 'device' | 'offline' | 'unauthorized' | 'bootloader' | 'recovery' | 'unknown';
  /** 连接方式 */
  connection: 'usb' | 'tcp';
  /** 型号（如 Pixel 7） */
  model?: string;
  /** 品牌 */
  brand?: string;
  /** Android 版本（如 14） */
  androidVersion?: string;
  /** SDK 等级 */
  sdk?: number;
  /** 产品名 */
  product?: string;
  /** 设备代号 */
  device?: string;
  /** 是否为模拟器 */
  isEmulator?: boolean;
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'command';

export interface LogEntry {
  id: string;
  /** 时间戳（毫秒） */
  time: number;
  level: LogLevel;
  /** 来源模块，如 "设备" / "投屏" / "截图" */
  source: string;
  /** 主消息 */
  message: string;
  /** 附带的详细输出（命令 stdout/stderr） */
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* 通用返回                                                            */
/* ------------------------------------------------------------------ */

export interface CommandResult {
  /** 是否成功（exitCode === 0） */
  ok: boolean;
  /** 进程退出码 */
  code: number | null;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 实际执行的命令行（用于日志展示） */
  commandLine: string;
  /** 耗时（毫秒） */
  duration: number;
}

/* ------------------------------------------------------------------ */
/* 投屏                                                                */
/* ------------------------------------------------------------------ */

export interface MirrorOptions {
  serial: string;
  /** 最大边长，默认 1920 */
  maxSize?: number;
  /** 码率（Mbps），默认 8 */
  bitRateMbps?: number;
  /** 最大帧率，默认 60 */
  maxFps?: number;
  /** 关闭音频（默认 true） */
  noAudio?: boolean;
  /** 键盘模式 */
  keyboard?: 'sdk' | 'uhid' | 'aoa' | 'disabled';
  /** 常亮 */
  stayAwake?: boolean;
  /** 置顶 */
  alwaysOnTop?: boolean;
  /** 录制到文件（可选，传入路径则同时录制） */
  recordPath?: string;
}

export interface MirrorStatus {
  running: boolean;
  serial?: string;
  pid?: number;
  startedAt?: number;
  options?: MirrorOptions;
}

/* ------------------------------------------------------------------ */
/* 屏幕分辨率                                                          */
/* ------------------------------------------------------------------ */

export interface ScreenResolution {
  /** 物理分辨率，如 "1080x2400" */
  physical: string;
  /** 当前覆盖分辨率（wm size 设置过的话） */
  override?: string;
  /** 实际使用分辨率 */
  current: string;
  /** 当前密度 */
  density?: number;
  /** 密度覆盖值 */
  densityOverride?: number;
}

/* ------------------------------------------------------------------ */
/* 录屏                                                                */
/* ------------------------------------------------------------------ */

export interface RecordOptions {
  serial: string;
  /** 录制时长（秒），到点自动停止 */
  duration: number;
  /** 码率（Mbps） */
  bitRateMbps?: number;
  /** 分辨率缩放，如 1080 / 720 */
  size?: number;
  /** 是否录制音频（Android 10+ 部分设备支持） */
  audio?: boolean;
  /** 输出文件路径 */
  outputPath: string;
}

export interface RecordSession {
  id: string;
  serial: string;
  outputPath: string;
  startedAt: number;
  duration: number;
  /** 设备上的临时文件路径 */
  devicePath: string;
  status: 'recording' | 'pulling' | 'done' | 'error' | 'cancelled';
}

/* ------------------------------------------------------------------ */
/* 应用列表 / 应用管理                                                  */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  packageName: string;
  /** 是否为系统应用 */
  system: boolean;
  /** 应用显示名（读取失败时回落为包名） */
  label?: string;
  /** 版本名，如 8.0.42 */
  versionName?: string;
  /** 版本号 */
  versionCode?: number;
  /** 安装时间（毫秒时间戳） */
  installedAt?: number;
  /** 更新时间（毫秒时间戳） */
  updatedAt?: number;
  /** APK 路径 */
  apkPath?: string;
  /** 占用空间（字节，APK + 数据 + 缓存） */
  sizeBytes?: number;
  /** 是否已停止（pm list packages -d） */
  disabled?: boolean;
  /** 是否正在运行（dumpsys 推断，尽力而为） */
  running?: boolean;
}

export interface AppDetail {
  packageName: string;
  label?: string;
  versionName?: string;
  versionCode?: number;
  installedAt?: number;
  updatedAt?: number;
  apkPath?: string;
  codePath?: string;
  dataDir?: string;
  sizeBytes?: number;
  system: boolean;
  enabled?: boolean;
  targetSdk?: number;
  minSdk?: number;
  activities?: number;
  permissions?: string[];
}

/* ------------------------------------------------------------------ */
/* 实时 Logcat                                                         */
/* ------------------------------------------------------------------ */

export type LogcatLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F' | 'S';

export interface LogcatBufferName {
  /** 缓冲区名：main / system / crash / events / radio / all */
  name: string;
}

export interface LogcatLine {
  /** 自增序号 */
  seq: number;
  /** 完整原始行 */
  raw: string;
  /** 解析后的时间字符串（"09-11 17:58:07.123"） */
  time?: string;
  /** 进程号 */
  pid?: number;
  /** 线程号 */
  tid?: number;
  /** 级别 */
  level?: LogcatLevel;
  /** TAG */
  tag?: string;
  /** 正文 */
  message?: string;
  /** 解析失败时为 true（原样展示 raw） */
  rawOnly?: boolean;
}

export interface LogcatFilter {
  /** 最低级别，低于该级别不推送 */
  minLevel: LogcatLevel;
  /** TAG 过滤（支持 * 通配，逗号分隔多个） */
  tags?: string;
  /** 正文关键字（逗号分隔，任一命中即保留） */
  keyword?: string;
  /** 仅显示指定 PID */
  pid?: number;
  /** 进程名过滤（子串匹配） */
  process?: string;
  /** 缓冲区 */
  buffers?: string[];
  /** 是否只在关键字命中时保留 */
  matchOnly?: boolean;
}

export interface LogcatStatus {
  running: boolean;
  serial?: string;
  pid?: number;
  startedAt?: number;
  /** 已接收行数 */
  lines: number;
  filter?: LogcatFilter;
}

/* ------------------------------------------------------------------ */
/* 弱网模拟                                                            */
/* ------------------------------------------------------------------ */

export type WeakNetMode = 'tc' | 'svc' | 'none';

/** 单个方向的参数（上行 = 设备出口，下行 = 入向） */
export interface WeakNetDirectionParams {
  /** 带宽限制（Mbps），0 = 不限速 */
  bandwidthMbps?: number;
  /** 延迟（毫秒） */
  delayMs?: number;
  /** 延迟抖动（毫秒） */
  jitterMs?: number;
  /** 丢包率（%），0-100 */
  lossPercent?: number;
  /** 错误包率（%），0-100，netem corrupt */
  corruptPercent?: number;
  /** 乱序率（%），0-100 */
  reorderPercent?: number;
  /** 重复包率（%），0-100 */
  duplicatePercent?: number;
}

export interface WeakNetParams {
  /** 上行（设备发出的流量） */
  up: WeakNetDirectionParams;
  /** 下行（设备收到的流量） */
  down: WeakNetDirectionParams;
  /** 持续时长（秒），0 = 一直生效直到手动停止 */
  durationSec: number;
  /** 仅作用于指定应用 UID（可选，留空 = 全局） */
  packageName?: string;
  /** 是否同时关闭 WiFi / 移动数据（模拟断网） */
  blockNetwork?: boolean;
  /** 网络接口名，留空自动探测 */
  iface?: string;
}

export interface WeakNetPreset {
  id: string;
  name: string;
  params: WeakNetParams;
  builtin?: boolean;
  createdAt: number;
}

export interface WeakNetStatus {
  running: boolean;
  serial?: string;
  startedAt?: number;
  /** 剩余秒数，-1 表示不限时 */
  remainSec: number;
  params?: WeakNetParams;
  /** 生效方式：tc=内核 netem（需 root），svc=开关网络（免 root），none=未生效 */
  mode: WeakNetMode;
  /** 是否具备 root */
  rooted?: boolean;
  iface?: string;
  /** 上一次的提示信息 */
  note?: string;
}

/* ------------------------------------------------------------------ */
/* 会话设置                                                            */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  /** 截图默认保存目录 */
  screenshotDir: string;
  /** 录屏默认保存目录 */
  recordDir: string;
  /** 拉取文件默认目录 */
  pullDir: string;
  /** 默认目标设备序列号 */
  defaultSerial?: string;
}

/* ------------------------------------------------------------------ */
/* IPC 通道名（统一常量，避免拼写错误）                                 */
/* ------------------------------------------------------------------ */

export const IPC = {
  /* 设备 */
  DEVICE_LIST: 'device:list',
  DEVICE_DETAIL: 'device:detail',
  DEVICE_CONNECT_TCP: 'device:connectTcp',
  DEVICE_DISCONNECT_TCP: 'device:disconnectTcp',
  DEVICE_ADB_KILL: 'device:adbKill',
  DEVICE_ADB_START: 'device:adbStart',

  /* 环境 */
  ENV_CHECK: 'env:check',

  /* 通用命令 */
  ADB_RUN: 'adb:run',

  /* 屏幕 */
  SCREEN_RESOLUTION: 'screen:resolution',
  SCREEN_SET_SIZE: 'screen:setSize',
  SCREEN_RESET: 'screen:reset',

  /* 截图 */
  SCREENSHOT_CAPTURE: 'screenshot:capture',

  /* 录屏 */
  RECORD_START: 'record:start',
  RECORD_STOP: 'record:stop',
  RECORD_LIST: 'record:list',

  /* 投屏 */
  MIRROR_START: 'mirror:start',
  MIRROR_STOP: 'mirror:stop',
  MIRROR_STATUS: 'mirror:status',

  /* 文件 */
  FILE_PUSH: 'file:push',
  FILE_PULL: 'file:pull',
  FILE_PICK: 'file:pick',
  FILE_PICK_DIR: 'file:pickDir',
  FILE_REVEAL: 'file:reveal',
  FILE_OPEN: 'file:open',

  /* APK */
  APK_INSTALL: 'apk:install',

  /* Monkey */
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

  /* 日志 */
  LOG_EXPORT: 'log:export',
  LOG_CLEAR: 'log:clear',
  LOG_LIST_ALL: 'log:listAll',

  /* 设置 */
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  /* 主进程 -> 渲染进程 推送 */
  PUSH_LOG: 'push:log',
  PUSH_MIRROR_STATUS: 'push:mirrorStatus',
  PUSH_RECORD_STATUS: 'push:recordStatus',
  PUSH_DEVICE_CHANGED: 'push:deviceChanged',
  PUSH_MONKEY_OUTPUT: 'push:monkeyOutput',
  PUSH_LOGCAT_LINES: 'push:logcatLines',
  PUSH_LOGCAT_STATUS: 'push:logcatStatus',
  PUSH_WEAKNET_STATUS: 'push:weaknetStatus',
} as const;

/* ------------------------------------------------------------------ */
/* 环境自检                                                            */
/* ------------------------------------------------------------------ */

export interface EnvCheckItem {
  name: string;
  ok: boolean;
  path?: string;
  /** 版本字符串 */
  version?: string;
  message?: string;
}

export interface EnvCheckResult {
  items: EnvCheckItem[];
  allOk: boolean;
}
