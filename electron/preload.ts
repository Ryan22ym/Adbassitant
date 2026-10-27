import { contextBridge, ipcRenderer, webUtils } from 'electron';
// 仅类型导入：编译后会被擦除，不会把 shared/ 的相对路径带进 preload 运行时。
import type { PackageOverride, QuickAction } from '../shared/types';

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

  /* AAB（Android App Bundle） */
  AAB_INSTALL: 'aab:install',
  AAB_ENV: 'aab:env',
  AAB_DOWNLOAD_TOOL: 'aab:downloadTool',
  AAB_OPEN_TOOL_DIR: 'aab:openToolDir',
  AAB_CACHE_LIST: 'aab:cacheList',
  AAB_CACHE_CLEAR: 'aab:cacheClear',
  /* 拆包与安装分离 */
  AAB_CONVERT: 'aab:convert',
  AAB_SAVE_APKS: 'aab:saveApks',
  /* 通用 APK：AAB → 单个可分发 .apk（与设备无关，不需要连设备） */
  AAB_EXPORT_UNIVERSAL: 'aab:exportUniversal',
  APKS_INSTALL: 'apks:install',
  /* AAB 签名 */
  AAB_SIGNING_GET: 'aab:signingGet',
  AAB_SIGNING_SET: 'aab:signingSet',
  AAB_SIGNING_PICK: 'aab:signingPick',
  AAB_SIGNING_PROBE: 'aab:signingProbe',

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

  /* 设备快捷动作（v1.0.24） */
  QUICK_ACTION_LIST: 'quickAction:list',
  QUICK_ACTION_SAVE: 'quickAction:save',
  QUICK_ACTION_RESET: 'quickAction:reset',
  QUICK_ACTION_RUN: 'quickAction:run',
  QUICK_ACTION_FOREGROUND: 'quickAction:foreground',

  /* 安装包管理（v1.1.6） */
  PACKAGES_SCAN: 'packages:scan',
  PACKAGES_ORGANIZE: 'packages:organize',
  PACKAGES_PICK_DIR: 'packages:pickDir',
  PACKAGES_REVEAL: 'packages:reveal',
  /** 手工指定一个包的类型/通道/版本（null = 恢复自动识别） */
  PACKAGES_SET_TAG: 'packages:setTag',
  /** 清空全部手动标签 */
  PACKAGES_CLEAR_TAGS: 'packages:clearTags',

  /* 实时 Logcat（v1.0） */
  LOGCAT_START: 'logcat:start',
  LOGCAT_STOP: 'logcat:stop',
  LOGCAT_STATUS: 'logcat:status',
  /* 回放最近的行（v1.1.15）：页面重新挂载时用 */
  LOGCAT_HISTORY: 'logcat:history',
  LOGCAT_CLEAR: 'logcat:clear',
  LOGCAT_SAVE: 'logcat:save',
  LOGCAT_PROCESSES: 'logcat:processes',
  /* Logcat 导出工具（常用工具页） */
  LOGX_EXPORT: 'logcat-export:run',
  LOGX_DIR_INFO: 'logcat-export:dirInfo',
  LOGX_DIR_PICK: 'logcat-export:pickDir',
  LOGX_DIR_RESET: 'logcat-export:resetDir',

  /* 弱网模拟（v1.0） */
  WEAKNET_START: 'weaknet:start',
  WEAKNET_STOP: 'weaknet:stop',
  WEAKNET_STATUS: 'weaknet:status',
  WEAKNET_PRESET_LIST: 'weaknet:presetList',
  WEAKNET_PRESET_SAVE: 'weaknet:presetSave',
  WEAKNET_PRESET_DELETE: 'weaknet:presetDelete',
  WEAKNET_PROBE: 'weaknet:probe',
  WEAKNET_CLEANUP: 'weaknet:cleanup',
  WEAKNET_VPN_AUTHORIZE: 'weaknet:vpnAuthorize',
  WEAKNET_VPN_APP_INFO: 'weaknet:vpnAppInfo',
  WEAKNET_VPN_INSTALL: 'weaknet:vpnInstall',
  WEAKNET_VPN_PARAMS: 'weaknet:vpnParams',

  /* 自动连点器（v1.0.32） */
  CLICKER_LIST: 'clicker:list',
  CLICKER_SAVE: 'clicker:save',
  CLICKER_DELETE: 'clicker:delete',
  CLICKER_RESET: 'clicker:reset',
  CLICKER_FROM_RECORD: 'clicker:fromRecord',
  CLICKER_RUN: 'clicker:run',
  CLICKER_STOP: 'clicker:stop',
  CLICKER_STATUS: 'clicker:status',
  CLICKER_RUN_STEP: 'clicker:runStep',
  CLICKER_KEYCODES: 'clicker:keycodes',
  CLICKER_PREVIEW: 'clicker:preview',

  /* 屏幕录制采集端（v1.0.32；v1.0.33 起改为电脑端全程控制） */
  RECORDER_INFO: 'recorder:info',
  RECORDER_INSTALL: 'recorder:install',
  RECORDER_AUTHORIZE: 'recorder:authorize',
  RECORDER_START: 'recorder:start',
  RECORDER_PAUSE: 'recorder:pause',
  RECORDER_STOP: 'recorder:stop',
  RECORDER_RESET: 'recorder:reset',
  RECORDER_STATUS: 'recorder:status',
  RECORDER_PULL: 'recorder:pull',
  RECORDER_FRAME: 'recorder:frame',
  RECORDER_OPEN_UI: 'recorder:openUi',
  RECORDER_BACKGROUND_UI: 'recorder:backgroundUi',
  RECORDER_PREPARE: 'recorder:prepare',
  RECORDER_CANCEL: 'recorder:cancel',

  LOG_EXPORT: 'log:export',
  LOG_CLEAR: 'log:clear',
  LOG_LIST_ALL: 'log:listAll',
  LOG_DIR: 'log:dir',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  /* 界面配置（Conf/*.json，见 shared/ui-conf.ts） */
  CONF_GET: 'conf:get',
  CONF_DIR: 'conf:dir',
  /* 窗口外观（v1.1.3）：自绘标题栏的底色 */
  WINDOW_SET_TITLEBAR: 'window:setTitlebar',
  /* 透明玻璃主题（v1.1.13）：整窗 Acrylic 与自绘窗口按钮 */
  WINDOW_SET_GLASS: 'window:setGlass',
  /*
   * 抓一张桌面壁纸（v1.1.13 修正）。
   * 🔴 字面量必须与 shared/types.ts 的 IPC.WINDOW_GRAB_DESKTOP 一致 ——
   *    preload 是独立打包的，不能 import shared，只能手抄一份（历史坑）。
   */
  WINDOW_GRAB_DESKTOP: 'window:grabDesktop',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAX: 'window:toggleMax',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAX: 'window:isMax',
  /*
   * 记录窗口大小（v1.1.16）。
   * 🔴 字面量必须与 shared/types.ts 的 IPC 同名项逐字一致 ——
   *    preload 是独立打包的，不能 import shared，只能手抄一份（历史坑）。
   */
  WINDOW_GET_STATE: 'window:getState',
  WINDOW_RESET_SIZE: 'window:resetSize',

  /*
   * AI 助手（v1.1.14）。
   * 🔴 字面量必须与 shared/types.ts 的 IPC 同名项逐字一致 ——
   *    preload 是独立打包的，不能 import shared，只能手抄一份（历史坑）。
   */
  AI_CONFIG_GET: 'ai:configGet',
  AI_CONFIG_SET: 'ai:configSet',
  AI_CONFIG_DIR: 'ai:configDir',
  AI_CHAT: 'ai:chat',
  AI_CANCEL: 'ai:cancel',
  AI_TEST: 'ai:test',
  AI_SESSION_LIST: 'ai:sessionList',
  AI_SESSION_GET: 'ai:sessionGet',
  AI_SESSION_DELETE: 'ai:sessionDelete',
  AI_SESSION_CLEAR: 'ai:sessionClear',
  AI_CRASH_ANALYZE: 'ai:crashAnalyze',
  AI_REPORT_LIST: 'ai:reportList',
  AI_REPORT_GET: 'ai:reportGet',
  AI_REPORT_MARK_READ: 'ai:reportMarkRead',
  AI_REPORT_DELETE: 'ai:reportDelete',
  AI_REPORT_REVEAL: 'ai:reportReveal',
  AI_CRASH_STATUS: 'ai:crashStatus',
  /* AI 回复转存成文件 / 粘贴图片（v1.1.17） */
  AI_EXPORT_SAVE: 'ai:exportSave',
  AI_EXPORT_PICK: 'ai:exportPick',
  AI_EXPORT_DIR: 'ai:exportDir',
  AI_PASTE_IMAGE: 'ai:pasteImage',
  /* 系统剪贴板（v1.1.17） */
  CLIPBOARD_WRITE: 'clipboard:write',

  /* 增量更新（v1.0.7） */
  UPDATE_CONTEXT: 'update:context',
  UPDATE_PREPARE: 'update:prepare',
  UPDATE_APPLY: 'update:apply',
  UPDATE_CANCEL: 'update:cancel',
  UPDATE_ROLLBACK: 'update:rollback',
  UPDATE_HANDSHAKE: 'update:handshake',
  UPDATE_OPEN_DIR: 'update:openDir',

  /* 在线更新（v1.0.22） */
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL_DOWNLOAD: 'update:cancelDownload',
  PUSH_LOG: 'push:log',
  PUSH_MIRROR_STATUS: 'push:mirrorStatus',
  PUSH_RECORD_STATUS: 'push:recordStatus',
  PUSH_DEVICE_CHANGED: 'push:deviceChanged',
  PUSH_MONKEY_OUTPUT: 'push:monkeyOutput',
  PUSH_LOGCAT_LINES: 'push:logcatLines',
  PUSH_LOGCAT_STATUS: 'push:logcatStatus',
  PUSH_WEAKNET_STATUS: 'push:weaknetStatus',
  PUSH_AAB_OUTPUT: 'push:aabOutput',
  PUSH_AAB_DOWNLOAD: 'push:aabDownload',
  PUSH_UPDATE_DOWNLOAD: 'push:updateDownload',
  PUSH_CLICKER_PROGRESS: 'push:clickerProgress',
  PUSH_RECORDER_STATUS: 'push:recorderStatus',
  /* AI 崩溃分析（v1.1.14）：报告生成 / 监听状态变化 */
  PUSH_AI_CRASH_REPORT: 'push:aiCrashReport',
  PUSH_AI_CRASH_STATUS: 'push:aiCrashStatus',
  /* AI 自动执行 adb 指令（v1.1.15）：每执行完一条推一次 */
  PUSH_AI_AGENT_STEP: 'push:aiAgentStep',
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
  /** mode: overwrite（-r，保留数据）/ clean（先卸载，清数据）/ fresh（不覆盖） */
  installApk: (
    serial: string | undefined,
    apkPath: string,
    mode: 'overwrite' | 'clean' | 'fresh' = 'overwrite',
    grantAll = false,
  ) => invoke(IPC.APK_INSTALL, serial, apkPath, mode, grantAll),

  /* AAB（Android App Bundle）：走 bundletool 拆包后 install-multiple */
  /** AAB 安装能力全景（Java / bundletool 是否就位） */
  aabEnv: (force = false) => invoke(IPC.AAB_ENV, force),
  /** 安装 AAB —— serial 必须明确，AAB 绝不能猜目标设备 */
  installBundle: (
    serial: string | undefined,
    aabPath: string,
    mode: 'overwrite' | 'clean' | 'fresh' = 'overwrite',
    grantAll = false,
    signing?: Record<string, unknown>,
  ) => invoke(IPC.AAB_INSTALL, serial, aabPath, mode, grantAll, signing),
  /** 下载 bundletool（进度走 push:aabDownload） */
  downloadBundletool: () => invoke(IPC.AAB_DOWNLOAD_TOOL),
  openBundletoolDir: () => invoke(IPC.AAB_OPEN_TOOL_DIR),
  /** AAB 拆包产物缓存 */
  aabCache: () => invoke(IPC.AAB_CACHE_LIST),
  clearAabCache: () => invoke(IPC.AAB_CACHE_CLEAR),

  /*
   * 拆包与安装分离（v1.0.19）
   * 拆包只做本机计算，产物可另存、可复用；装的时候不必再拆一次。
   */
  /** 仅拆包：AAB → 缓存里的 .apks（不另存、不安装） */
  convertBundle: (
    serial: string | undefined,
    aabPath: string,
    signing?: Record<string, unknown>,
    useCache = true,
  ) => invoke(IPC.AAB_CONVERT, serial, aabPath, signing, useCache),
  /**
   * 拆包并另存：先弹保存框（用户取消返回 null），再把产物写到指定路径。
   * defaultName 是保存框里的建议文件名。
   */
  saveApks: (
    serial: string | undefined,
    aabPath: string,
    defaultName?: string,
    signing?: Record<string, unknown>,
  ) => invoke(IPC.AAB_SAVE_APKS, serial, aabPath, defaultName, signing),
  /**
   * 导出通用 APK：AAB → 一个能装进任何设备的 .apk（可微信发给别人）。
   *
   * 参数里**没有 serial** —— universal 模式不按设备挑 split、全程不碰 adb，
   * 所以连设备都不用插。用户在保存框里取消时返回 null。
   */
  exportUniversalApk: (
    aabPath: string,
    defaultName?: string,
    signing?: Record<string, unknown>,
  ) => invoke(IPC.AAB_EXPORT_UNIVERSAL, aabPath, defaultName, signing),
  /** 安装一份现成的 .apks（本工具拆出来的产物，跳过拆包） */
  installApks: (
    serial: string | undefined,
    apksPath: string,
    mode: 'overwrite' | 'clean' | 'fresh' = 'overwrite',
    grantAll = false,
  ) => invoke(IPC.APKS_INSTALL, serial, apksPath, mode, grantAll),

  /**
   * AAB 拆包签名。
   * 换签名会改应用的 key hash —— Facebook / 微信 / Google 登录、推送、
   * 地图 key 都按「包名 + 签名」校验，用错签名装上去这些全废。
   */
  aabSigning: () => invoke(IPC.AAB_SIGNING_GET),
  setAabSigning: (patch: Record<string, unknown>) => invoke(IPC.AAB_SIGNING_SET, patch),
  /** 弹系统文件选择框挑一个密钥库，返回绝对路径（取消返回 null） */
  pickKeystore: () => invoke(IPC.AAB_SIGNING_PICK),
  /** 探测密钥库：能不能打开、有哪些别名、对应什么 key hash */
  probeKeystore: (path: string, storePass: string, alias?: string) =>
    invoke(IPC.AAB_SIGNING_PROBE, path, storePass, alias),

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

  /* 设备快捷动作（v1.0.24）：设备行上的一键操作 */
  quickActions: () => invoke(IPC.QUICK_ACTION_LIST),
  saveQuickActions: (list: QuickAction[]) => invoke(IPC.QUICK_ACTION_SAVE, list),
  resetQuickActions: () => invoke(IPC.QUICK_ACTION_RESET),
  runQuickAction: (serial: string | undefined, action: QuickAction) =>
    invoke(IPC.QUICK_ACTION_RUN, serial, action),
  foregroundApp: (serial?: string) => invoke(IPC.QUICK_ACTION_FOREGROUND, serial),

  /*
   * 安装包管理（v1.1.6）：本地安装包仓库
   * 扫描只读；organize 才会真的移动文件（幂等，可重复点）。
   */
  packagesScan: () => invoke(IPC.PACKAGES_SCAN),
  packagesOrganize: () => invoke(IPC.PACKAGES_ORGANIZE),
  pickPackageDir: (current?: string) => invoke(IPC.PACKAGES_PICK_DIR, current),
  /** 在资源管理器里定位一个包（reveal=false 时只打开所在目录） */
  revealPackage: (path: string, reveal = true) => invoke(IPC.PACKAGES_REVEAL, path, reveal),
  /** 手工改一个包的标签（类型/通道/版本）；tag=null 表示恢复自动识别。返回新的扫描结果 */
  setPackageTag: (name: string, tag: PackageOverride | null) =>
    invoke(IPC.PACKAGES_SET_TAG, name, tag),
  /** 清空全部手动标签。返回新的扫描结果 */
  clearPackageTags: () => invoke(IPC.PACKAGES_CLEAR_TAGS),

  /* 实时 Logcat（v1.0） */
  startLogcat: (serial: string | undefined, filter?: any) =>
    invoke(IPC.LOGCAT_START, serial, filter),
  stopLogcat: () => invoke(IPC.LOGCAT_STOP),
  logcatStatus: () => invoke(IPC.LOGCAT_STATUS),
  /** 回放最近的行（页面重新挂载时铺回来，见 shared/types.ts 的 LogcatHistory） */
  logcatHistory: (limit?: number) => invoke(IPC.LOGCAT_HISTORY, limit),
  clearLogcat: () => invoke(IPC.LOGCAT_CLEAR),
  saveLogcat: (meta?: Record<string, string>) => invoke(IPC.LOGCAT_SAVE, meta),
  logcatProcesses: (serial?: string) => invoke(IPC.LOGCAT_PROCESSES, serial),

  /* Logcat 导出工具（常用工具页）：一次性 dump 设备现有日志并导出 */
  exportLogcat: (options?: any) => invoke(IPC.LOGX_EXPORT, options),
  /** 查默认导出目录（根 / 本次会落的目录 / 是否默认值 / 是否存在） */
  logcatExportDirInfo: (serial?: string, deviceLabel?: string) =>
    invoke(IPC.LOGX_DIR_INFO, serial, deviceLabel),
  /** 选导出根目录（弹系统的选文件夹框）；取消返回 null */
  pickLogcatExportDir: (current?: string) => invoke(IPC.LOGX_DIR_PICK, current),
  /** 恢复默认根目录，返回新的根 */
  resetLogcatExportDir: () => invoke(IPC.LOGX_DIR_RESET),

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

  /* 弱网 v2：VPN 模式（配套 App → VpnService → IP 层整形） */
  weaknetVpnAuthorize: (serial?: string) => invoke(IPC.WEAKNET_VPN_AUTHORIZE, serial),
  weaknetVpnAppInfo: (serial?: string) => invoke(IPC.WEAKNET_VPN_APP_INFO, serial),
  weaknetVpnInstall: (serial?: string, apkPath?: string) =>
    invoke(IPC.WEAKNET_VPN_INSTALL, serial, apkPath),
  weaknetVpnParams: (params: any) => invoke(IPC.WEAKNET_VPN_PARAMS, params),

  /* 自动连点器（v1.0.32） */
  clickerList: () => invoke(IPC.CLICKER_LIST),
  clickerSave: (script: any) => invoke(IPC.CLICKER_SAVE, script),
  clickerDelete: (id: string) => invoke(IPC.CLICKER_DELETE, id),
  clickerReset: () => invoke(IPC.CLICKER_RESET),
  clickerFromRecord: (session: any) => invoke(IPC.CLICKER_FROM_RECORD, session),
  clickerRun: (script: any, serial?: string) => invoke(IPC.CLICKER_RUN, script, serial),
  clickerStop: () => invoke(IPC.CLICKER_STOP),
  clickerStatus: () => invoke(IPC.CLICKER_STATUS),
  clickerRunStep: (step: any, serial?: string) => invoke(IPC.CLICKER_RUN_STEP, step, serial),
  clickerPreview: (serial?: string) => invoke(IPC.CLICKER_PREVIEW, serial),
  clickerKeycodes: () => invoke(IPC.CLICKER_KEYCODES),

  /*
   * 屏幕录制采集端：画面由设备侧 App 采（MediaProjection），
   * 触摸由电脑侧 `adb getevent` 采 —— 两条链路都由电脑端编排。
   */
  recorderInfo: (serial?: string) => invoke(IPC.RECORDER_INFO, serial),
  recorderInstall: (serial?: string) => invoke(IPC.RECORDER_INSTALL, serial),
  recorderAuthorize: (serial?: string) => invoke(IPC.RECORDER_AUTHORIZE, serial),
  recorderOpenUi: (serial?: string) => invoke(IPC.RECORDER_OPEN_UI, serial),
  recorderBackgroundUi: (serial?: string) => invoke(IPC.RECORDER_BACKGROUND_UI, serial),
  recorderPrepare: (serial?: string) => invoke(IPC.RECORDER_PREPARE, serial),
  recorderStart: (serial?: string) => invoke(IPC.RECORDER_START, serial),
  recorderPause: (paused: boolean, serial?: string) =>
    invoke(IPC.RECORDER_PAUSE, paused, serial),
  recorderStop: (serial?: string) => invoke(IPC.RECORDER_STOP, serial),
  recorderReset: (serial?: string) => invoke(IPC.RECORDER_RESET, serial),
  recorderCancel: (serial?: string) => invoke(IPC.RECORDER_CANCEL, serial),
  recorderStatus: (serial?: string) => invoke(IPC.RECORDER_STATUS, serial),
  recorderPull: (serial?: string) => invoke(IPC.RECORDER_PULL, serial),
  recorderFrame: (frameId: number, serial?: string) =>
    invoke(IPC.RECORDER_FRAME, frameId, serial),

  /* 日志 */
  getAllLogs: () => invoke(IPC.LOG_LIST_ALL),
  logDir: () => invoke(IPC.LOG_DIR),
  clearLogs: () => invoke(IPC.LOG_CLEAR),
  exportLogs: () => invoke(IPC.LOG_EXPORT),

  /* 设置 */
  getSettings: () => invoke(IPC.SETTINGS_GET),
  setSettings: (patch: any) => invoke(IPC.SETTINGS_SET, patch),

  /*
   * 界面配置（Conf/*.json）：顺序 / 显隐 / 默认展开。
   * 启动时读一次，契约与出厂默认见 shared/ui-conf.ts。
   */
  getUiConf: () => invoke(IPC.CONF_GET),
  /** 用户可改的那份 Conf 目录绝对路径（用于「打开配置文件夹」） */
  uiConfDir: () => invoke(IPC.CONF_DIR),

  /* 自绘标题栏（v1.1.3）：把当前主题色下的顶栏底色交给主进程 */
  setTitlebar: (opts: { color: string; symbolColor?: string; height?: number }) =>
    invoke(IPC.WINDOW_SET_TITLEBAR, opts),

  /*
   * 透明玻璃主题（v1.1.13）。
   * setGlass 切换整窗 Acrylic；其余四个是自绘交通灯按钮的回调 ——
   * 玻璃主题无边框，系统窗口按钮不存在，只能由渲染层画、主进程执行。
   */
  setGlass: (on: boolean) => invoke(IPC.WINDOW_SET_GLASS, on),
  /**
   * 抓一张桌面壁纸当「模拟玻璃」的底图（v1.1.13 修正）。
   *
   * ⚠️ 返回的是 **IPC 信封** `{ ok, data, error }`（与其它通道一致），
   *    真实 data URL 在 `res.data`；抓失败时 `res.data` 为 null。
   *    调用方必须先判 `res.ok` 再取 `res.data`（见 App.tsx 的用法）。
   */
  grabDesktop: () => invoke(IPC.WINDOW_GRAB_DESKTOP),
  winMinimize: () => invoke(IPC.WINDOW_MINIMIZE),
  winToggleMax: () => invoke(IPC.WINDOW_TOGGLE_MAX),
  winClose: () => invoke(IPC.WINDOW_CLOSE),
  /** 窗口当前是否最大化（自绘按钮据此切换「最大化 / 还原」的图标） */
  winIsMax: () => invoke(IPC.WINDOW_IS_MAX),

  /*
   * 记录窗口大小（v1.1.16）。
   * 存盘是主进程自己做的（监听 resized / moved），这里只给设置页提供
   * 「读一眼当前尺寸」和「恢复默认尺寸」两个动作。
   */
  /** 当前窗口尺寸 + 上次记录值（都是 DIP，不是设备像素） */
  winState: () => invoke(IPC.WINDOW_GET_STATE),
  /** 退出最大化 → 居中 1280×860 → 写入记录；返回写入的那份记录 */
  winResetSize: () => invoke(IPC.WINDOW_RESET_SIZE),

  /*
   * AI 助手（v1.1.14）。
   *
   * 模型调用全程在主进程完成（CORS + apiKey 两条原因，见 services/ai.ts 的文件头），
   * 渲染层这里只是转发。附件也只传**路径**，由主进程去读文件 / 抓网页。
   */
  aiConfig: (force = false) => invoke(IPC.AI_CONFIG_GET, force),
  setAiConfig: (patch: any) => invoke(IPC.AI_CONFIG_SET, patch),
  aiConfigDir: () => invoke(IPC.AI_CONFIG_DIR),
  aiChat: (req: any) => invoke(IPC.AI_CHAT, req),
  /** 停止正在跑的对话（多轮执行 adb 指令时用） */
  aiCancel: (runId?: string) => invoke(IPC.AI_CANCEL, runId),
  aiTest: (providerId?: string) => invoke(IPC.AI_TEST, providerId),
  aiSessions: () => invoke(IPC.AI_SESSION_LIST),
  aiSession: (id: string) => invoke(IPC.AI_SESSION_GET, id),
  aiSessionDelete: (id: string) => invoke(IPC.AI_SESSION_DELETE, id),
  aiSessionClear: () => invoke(IPC.AI_SESSION_CLEAR),
  /* 崩溃分析 */
  crashAnalyze: (serial?: string, packageName?: string) =>
    invoke(IPC.AI_CRASH_ANALYZE, serial, packageName),
  crashReports: () => invoke(IPC.AI_REPORT_LIST),
  crashReport: (id: string) => invoke(IPC.AI_REPORT_GET, id),
  crashReportMarkRead: (id: string, read = true) => invoke(IPC.AI_REPORT_MARK_READ, id, read),
  crashReportDelete: (id: string) => invoke(IPC.AI_REPORT_DELETE, id),
  /** reveal=true 选中文件本身；false 只打开所在文件夹 */
  revealCrashReport: (path: string, reveal = true) => invoke(IPC.AI_REPORT_REVEAL, path, reveal),
  crashWatchStatus: () => invoke(IPC.AI_CRASH_STATUS),

  /*
   * AI 回复转存成文件 + 粘贴图片（v1.1.17）。
   * 正文的格式转换在渲染层做（shared/ai-export.ts），这里只负责落盘与弹框 ——
   * docx / pdf 的生成也在主进程（写 ZIP、起隐藏窗口打印）。
   */
  aiExportSave: (req: any) => invoke(IPC.AI_EXPORT_SAVE, req),
  /** 弹「另存为」，取消返回 null */
  aiExportPick: (req: any) => invoke(IPC.AI_EXPORT_PICK, req),
  /** 默认导出目录（已处理「没有 D 盘」的回落） */
  aiExportDir: () => invoke(IPC.AI_EXPORT_DIR),
  /** 剪贴板图片字节 → 临时文件路径（附件只认路径） */
  aiPasteImage: (bytes: Uint8Array, mime?: string) => invoke(IPC.AI_PASTE_IMAGE, bytes, mime),
  /** 写系统剪贴板：走主进程，不要求窗口处于焦点（渲染层 navigator.clipboard 有那个前提） */
  clipboardWrite: (text: string) => invoke(IPC.CLIPBOARD_WRITE, text),

  /* 增量更新（v1.0.7） */
  updateContext: () => invoke(IPC.UPDATE_CONTEXT),
  /** 选择并校验小更新包（只接受 zip），返回 { ok, reason, manifest, ... } */
  prepareUpdate: (zipPath: string) => invoke(IPC.UPDATE_PREPARE, zipPath),
  applyUpdate: () => invoke(IPC.UPDATE_APPLY),
  cancelUpdate: () => invoke(IPC.UPDATE_CANCEL),
  rollbackUpdate: () => invoke(IPC.UPDATE_ROLLBACK),
  /** 渲染层挂载后调用一次：落健康标记 + 回读本次更新结果 */
  updateHandshake: () => invoke(IPC.UPDATE_HANDSHAKE),
  openUpdateDir: () => invoke(IPC.UPDATE_OPEN_DIR),

  /* 在线更新（v1.0.22）：检查 → 下载 → 复用上面那套校验与替换 */
  /**
   * 检查更新。
   * force=true 绕过 5 分钟缓存（用户手点用 true，启动静默自检用 false）。
   * 返回 UpdateCheckResult：configured / ok / hasUpdate / latest.pkg 四件事要分开看。
   */
  checkUpdate: (force = false) => invoke(IPC.UPDATE_CHECK, force),
  /** 下载更新包并校验；进度走 push:updateDownload，返回 UpdateInfo（同 prepareUpdate） */
  downloadUpdate: (pkgUrl: string, sha256?: string) =>
    invoke(IPC.UPDATE_DOWNLOAD, pkgUrl, sha256),
  cancelUpdateDownload: () => invoke(IPC.UPDATE_CANCEL_DOWNLOAD),

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
      IPC.PUSH_AAB_OUTPUT,
      IPC.PUSH_AAB_DOWNLOAD,
      IPC.PUSH_UPDATE_DOWNLOAD,
      IPC.PUSH_CLICKER_PROGRESS,
      IPC.PUSH_RECORDER_STATUS,
      IPC.PUSH_AI_CRASH_REPORT,
      IPC.PUSH_AI_CRASH_STATUS,
      IPC.PUSH_AI_AGENT_STEP,
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
