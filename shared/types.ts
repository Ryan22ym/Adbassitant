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

/**
 * 设备详情（「设备详情」卡片展示用）。
 *
 * 只放「一眼想看、且换台设备就有差别」的硬指标：屏幕 / CPU / GPU / 内存。
 * 电量、系统版本号、设备代号已移除 —— 它们要么会随时变化（电量）、
 * 要么对日常使用没有意义（buildId / 代号）。
 */
export interface DeviceDetail {
  brand?: string;
  model?: string;
  androidVersion?: string;
  sdk?: number;
  serialno?: string;
  product?: string;
  /** 屏幕分辨率，如 "720x1600"；被临时改过时形如 "1080x1600（物理 720x1600）" */
  resolution?: string;
  /** CPU 型号，如 "Qualcomm SDM665" */
  cpu?: string;
  /** GPU 型号，如 "Adreno (TM) 610" */
  gpu?: string;
  memTotalKB?: number;
  memAvailKB?: number;
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

/**
 * 常用应用（收藏）
 * 按包名持久化到本机，与设备列表解耦 —— 换设备、重插线、重启应用后依然记得。
 */
export interface FavoriteApp {
  packageName: string;
  /** 收藏时的显示名，仅用于列表展示 */
  label?: string;
  addedAt: number;
}

/* ------------------------------------------------------------------ */
/* 设备快捷动作（v1.0.24）                                             */
/* ------------------------------------------------------------------ */

/**
 * 设备行上的「快捷动作」。
 *
 * 调试时反复做的就那么几件事：清数据、退到桌面再进、杀掉进程冷启动。
 * 把它们做成设备行上的一键按钮，省掉「切到应用管理 → 找应用 → 点按钮」的来回。
 *
 * 动作分两类：
 *  - 需要目标应用（clearData / homeReturn / restart / …）—— 作用对象由 target 决定
 *  - 与包名无关（screenshot / home / back / wake / sleep）—— 直接对设备下手
 */
export type QuickActionKind =
  /** 清除应用数据（pm clear） */
  | 'clearData'
  /** 回桌面再重新进入（不杀进程，走热启动） */
  | 'homeReturn'
  /** 结束进程后重新启动（冷启动） */
  | 'restart'
  /** 清数据后重新启动 */
  | 'restartFresh'
  /** 强制停止（不重启） */
  | 'forceStop'
  /** 启动 / 前台唤起 */
  | 'launch'
  /** 截图存到电脑 */
  | 'screenshot'
  /** 回桌面 */
  | 'home'
  /** 返回键 */
  | 'back'
  /** 点亮屏幕 */
  | 'wake'
  /** 息屏 */
  | 'sleep'
  /** 自定义 shell 命令（支持 {pkg} / {serial} 占位） */
  | 'shell';

/** 动作是否需要知道「对哪个应用下手」 */
export const QUICK_ACTION_NEEDS_TARGET: Record<QuickActionKind, boolean> = {
  clearData: true,
  homeReturn: true,
  restart: true,
  restartFresh: true,
  forceStop: true,
  launch: true,
  screenshot: false,
  home: false,
  back: false,
  wake: false,
  sleep: false,
  shell: true,
};

/** 动作类型的中文名（配置界面用） */
export const QUICK_ACTION_KIND_LABEL: Record<QuickActionKind, string> = {
  clearData: '清除数据',
  homeReturn: '回桌面再进（不杀进程）',
  restart: '退出后重进（杀进程）',
  restartFresh: '清数据后重进',
  forceStop: '强制停止',
  launch: '启动应用',
  screenshot: '截图到电脑',
  home: '回桌面',
  back: '返回键',
  wake: '点亮屏幕',
  sleep: '息屏',
  shell: '自定义命令',
};

/** target 取这个值时表示「当前前台应用」 */
export const QUICK_TARGET_FOREGROUND = 'foreground';

export interface QuickAction {
  id: string;
  /** 显示名（行内 chip 位置有限，建议 2~4 个字） */
  label: string;
  kind: QuickActionKind;
  /**
   * 作用对象：QUICK_TARGET_FOREGROUND（当前前台应用，默认）或固定包名。
   * 与包名无关的动作忽略该字段。
   */
  target?: string;
  /** kind === 'shell' 时的命令模板 */
  command?: string;
  /** 在设备行上直接显示成按钮（否则收进 ⚡ 菜单），最多 3 个 */
  inline?: boolean;
  /** 执行前二次确认（清数据这类不可逆动作） */
  confirm?: boolean;
  tone?: 'primary' | 'default' | 'danger';
  enabled: boolean;
}

/** 当前前台应用探测结果 */
export interface QuickForegroundInfo {
  serial: string;
  packageName?: string;
  activity?: string;
  /** 前台是系统桌面 —— 此时「当前前台应用」并不是用户想操作的那个应用 */
  isLauncher: boolean;
  /** 最近一次真正的应用（非桌面），当前台是桌面时可作为回退目标 */
  lastApp?: string;
}

/** 一次动作执行的结果 */
export interface QuickRunResult {
  id: string;
  label: string;
  /** 实际作用的包名 */
  packageName?: string;
  /** 执行步骤（按顺序） */
  steps: string[];
}

/** 设备行上直接显示的按钮数量上限（空间有限） */
export const QUICK_ACTION_INLINE_MAX = 3;
/** 配置里允许的动作总数上限 */
export const QUICK_ACTION_MAX = 16;

/* ------------------------------------------------------------------ */
/* APK 安装                                                            */
/* ------------------------------------------------------------------ */

/**
 * 安装方式：
 *  - overwrite 覆盖安装（adb install -r）：保留数据，适合升级；签名不一致会失败
 *  - clean     清洁安装：先按包名卸载旧版本（数据一起清掉）再全新安装，
 *              用于「覆盖装不上 / 装完行为诡异 / 想从干净状态开始」
 *  - fresh     全新安装（不带 -r）：设备上已有该包则直接报错，不会动旧数据
 */
export type InstallMode = 'overwrite' | 'clean' | 'fresh';

/** 各安装方式的界面文案（主进程日志与渲染层共用，避免两处各写一份） */
export const INSTALL_MODE_LABEL: Record<InstallMode, string> = {
  overwrite: '覆盖安装（保留数据）',
  clean: '清洁安装（先卸载，清除数据）',
  fresh: '全新安装（不覆盖）',
};

/** 安装结果 —— 关键在 serial / verified：装到哪台、到底在不在，都要能说清楚 */
export interface InstallResult {
  /** 实际安装到的设备序列号 */
  serial: string;
  /** 从安装包里读出的包名（读不出时为空） */
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  /** adb install 的原始输出 */
  output: string;
  /** 清洁安装时是否真的卸载了旧版本（没有旧版本或不适用时为 false） */
  uninstalled: boolean;
  /**
   * 装后是否按包名在设备上复核到（`pm path`）。
   * 读不出包名时为 undefined —— 表示「装是装完了，但没能复核」。
   */
  verified?: boolean;
  /** 是否来自 AAB（走了 bundletool 拆包再用 install-multiple 安装） */
  fromBundle?: boolean;
  /** 是否来自一份现成的 .apks（直接装已有产物，没有再拆包） */
  fromApks?: boolean;
  /** AAB：拆包是否复用了本机缓存 */
  fromCache?: boolean;
  /** AAB：拆包耗时（毫秒） */
  buildMs?: number;
  /** AAB：安装耗时（毫秒） */
  installMs?: number;
  /**
   * AAB：本次拆包用的签名（人话描述）。
   *
   * 为什么必须带到结果里：用调试密钥库拆包会**换掉应用签名**，而三方登录 /
   * 推送 / 地图 key 全是按「包名 + 签名」校验的 —— 包装得上、应用能跑，
   * 但登录当场报 Invalid key hash。这条以前只写进运行日志，用户在安装结果
   * 里完全看不到，于是把它当成安装器的 bug（实测踩过）。
   */
  signingDesc?: string;
}

/**
 * 可安装的文件类型。
 *  - apk ：Android 安装包，`adb install` 直接装
 *  - aab ：Android App Bundle，必须先由 bundletool 拆成一组 APK 再安装
 *  - apks：拆包产物（bundletool build-apks 的输出），直接 install-multiple 装
 */
export type InstallKind = 'apk' | 'aab' | 'apks';

/** APK / AAB / APKS 通用的安装方式选择项（AAB 的按钮更少，是 bundletool 的能力限制） */
export const INSTALL_KINDS: InstallKind[] = ['apk', 'aab', 'apks'];

export const INSTALL_KIND_LABEL: Record<InstallKind, string> = {
  apk: 'APK 安装包',
  aab: 'AAB 应用束',
  apks: 'APKS 拆包产物',
};

/**
 * AAB 安装环境。
 * 必需两样：Java 11+（bundletool 是 Java 程序）与 bundletool jar。
 * 都不随程序捆，由界面引导用户补齐。
 */
export interface AabEnv {
  /** Java 与 bundletool 都可用 */
  ready: boolean;
  /** 不可用时的原因（可直接展示） */
  reason?: string;
  /** java 可执行文件路径 */
  javaPath?: string;
  /** java 版本号，如 11.0.9 */
  javaVersion?: string;
  /** java 版本是否满足 bundletool 要求（>=11）；读不出时按满足处理 */
  javaOk: boolean;
  /** Java 来源的中文描述 */
  javaDesc?: string;
  /** bundletool jar 是否就位 */
  bundletoolReady: boolean;
  /** bundletool jar 的本机路径（可能尚不存在） */
  bundletoolPath: string;
  /** 程序内置的 bundletool 版本 */
  bundletoolVersion: string;
  /** 官方下载地址（下载失败时给用户手动下） */
  downloadUrl: string;
  /** 是否检测到随包 JRE（bin/jre） */
  javaBundled: boolean;
}

/* ------------------------------------------------------------------ */
/* AAB 签名                                                            */
/* ------------------------------------------------------------------ */

/**
 * AAB 拆包时用什么签名。
 *
 * 为什么这件事很重要：换签名会改应用的 key hash，而 Facebook / 微信 /
 * Google 登录、推送、地图 key 全都按「包名 + 签名」校验 ——
 * 用调试 key 拆一个正式签名的 AAB，应用能装能跑，但三方登录全废。
 */
export type SigningMode = 'bundled-debug' | 'custom' | 'none';

export interface AabSigningConfig {
  mode: SigningMode;
  /** custom 模式下的密钥库路径 */
  keystorePath?: string;
  /** 密钥库密码（storepass） */
  storePass?: string;
  /** 私钥密码（keypass），留空表示与 storepass 相同 */
  keyPass?: string;
  /** 私钥别名，留空表示自动取密钥库里唯一那个 */
  keyAlias?: string;
}

/** 三方后台登记用的 key hash（一次给全，省得用户来回问） */
export interface AabKeyHash {
  /** Facebook：base64(SHA1) */
  facebook: string;
  /** 微信 / QQ：MD5 小写无冒号 */
  wechat: string;
  /** Google：SHA1 大写带冒号 */
  sha1: string;
  /** SHA256 大写带冒号 */
  sha256: string;
}

export interface AabSigningInfo {
  config: AabSigningConfig;
  /** 随包调试密钥库路径 */
  bundledKeystore: string;
  /** 当前实际生效的密钥库路径（none / 不可用时为 null） */
  activeKeystore: string | null;
  /** 配置是否可用 */
  ok: boolean;
  /** 不可用原因 */
  reason?: string;
  /** 当前签名对应的 key hash */
  keyHash?: AabKeyHash;
  /** 密钥库里的别名列表 */
  aliases?: string[];
  /** 一句话描述 */
  desc: string;
}

/** 选择密钥库文件后的探测结果（界面「测试」按钮用） */
export interface KeystoreProbeResult {
  ok: boolean;
  reason?: string;
  aliases: string[];
  /** 探测成功时顺带给出的 key hash */
  keyHash?: AabKeyHash;
}

export const SIGNING_MODE_LABEL: Record<SigningMode, string> = {
  'bundled-debug': '随包调试密钥库',
  custom: '我的密钥库',
  none: '不签名',
};

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
/* Logcat 导出工具（常用工具页，一次性 dump）                          */
/* ------------------------------------------------------------------ */

export interface LogcatExportOptions {
  /** 目标设备；不传则用当前唯一在线设备 */
  serial?: string;
  /** 最低级别，低于该级别不导出 */
  minLevel?: LogcatLevel;
  /** TAG 过滤（支持 * 通配，逗号分隔） */
  tags?: string;
  /** 正文关键字（逗号分隔，任一命中即保留） */
  keyword?: string;
  /** 缓冲区 */
  buffers?: string[];
  /** 写进文件头部的设备描述，纯展示用 */
  deviceLabel?: string;
  /**
   * 导出目录。传了就**直接写进这个目录**（不存在会自动创建），
   * 文件名为 `logcat_<时间戳>.txt`，不再弹保存框；
   * 不传则退回「弹保存框让用户挑文件」的老行为。
   */
  dir?: string;
  /** 传 true 时，`dir` 视为**根目录**，实际落盘目录 = 根 \<设备机型 序列号>\<YYYY-MM-DD>\。默认 false（dir 就是最终目录） */
  splitByDevice?: boolean;
}

export interface LogcatExportResult {
  path: string;
  /** 实际写入的目录（= path 的父目录），供界面「导出后跳转」用 */
  dir: string;
  /** 写盘字节数（UTF-8） */
  bytes: number;
  /** 实际写入的日志行数（不含头部信息） */
  lines: number;
  /** 从设备读到的原始行数（过滤前） */
  rawLines: number;
  /** 被过滤掉的行数 */
  filtered: number;
}

/** 导出前问主进程「默认往哪写」时返回的信息 */
export interface LogcatExportDirInfo {
  /** 用户选定的根目录（未设置则为 D:\adblogs） */
  root: string;
  /** 本次实际会写入的目录：root\<机型 序列号>\<日期>\ */
  dir: string;
  /** root 是否是默认值（未自定义过） */
  isDefault: boolean;
  /** 该目录是否已存在 */
  exists: boolean;
}

/* ------------------------------------------------------------------ */
/* 弱网模拟                                                            */
/* ------------------------------------------------------------------ */

/** 实际生效方式 */
export type WeakNetMode = 'vpn' | 'tc' | 'svc' | 'proxy' | 'none';

/**
 * 实现引擎：
 *   auto  —— 首选 VPN（配套 App 建 tun，IP 层整形，免 Root、覆盖全量流量），
 *            装不上或不可用时自动退回本地代理（默认）
 *   vpn   —— 强制走配套 App 的 VPN（**推荐**；未装 App 时会尝试自动安装）
 *   proxy —— 强制走本地代理（免 Root，通过 adb reverse + 全局 HTTP 代理）
 *   tc    —— 强制走内核 netem（需 Root）
 *   svc   —— 开关网络（仅能做「整体断网」）
 */
export type WeakNetEngine = 'auto' | 'vpn' | 'proxy' | 'tc' | 'svc';

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
  /** 网络接口名，留空自动探测（仅 tc 模式使用） */
  iface?: string;
  /** 实现引擎，默认 auto */
  engine?: WeakNetEngine;
}

export interface WeakNetPreset {
  id: string;
  name: string;
  params: WeakNetParams;
  builtin?: boolean;
  createdAt: number;
}

/** 代理模式下的实时统计 */
export interface WeakNetStats {
  /** 累计接入连接数 */
  connections: number;
  /** 当前活跃连接数 */
  active: number;
  /** 上行字节（设备发出） */
  upBytes: number;
  /** 下行字节（设备接收） */
  downBytes: number;
  /** 上行丢包（重传近似）命中次数 */
  upRetrans: number;
  downRetrans: number;
  /** 上行乱序命中次数 */
  upReorder: number;
  downReorder: number;
  /** 上行错报命中次数 */
  upCorrupt: number;
  downCorrupt: number;
}

/**
 * VPN 模式的设备侧信息。
 *
 * VPN 与代理是两种完全不同的实现，但界面上要展示的东西高度重合
 * （授权了没 / 通道通不通 / 怎么手动救急），所以做成一个独立的卡片数据，
 * 而不是硬塞进 WeakNetProxyInfo —— 那个结构里有 reverse、manualAddress
 * 这类对 VPN 毫无意义的字段，混用会让人误读。
 */
export interface WeakNetVpnInfo {
  /** 设备上配套 App 的包名 */
  pkg: string;
  /** 设备上是否已安装配套 App */
  appInstalled: boolean;
  /** 设备上已装 App 的 versionCode，未装为 null */
  appVersionCode?: number | null;
  /**
   * VPN 是否已获得系统授权。
   *
   * ⚠️ 这个授权**无法绕过**：Android 要求 VpnService.prepare() 必须由
   * Activity 唤起系统对话框，用户手动点「确定」。所以第一次用必然要
   * 在手机上操作一次；之后系统会记住，不再弹框。
   */
  authorized: boolean;
  /**
   * 控制通道（adb forward tcp:P tcp:P）是否已建立。
   * false 时说明还没开始连接，或 USB 断了。
   */
  channelOpen: boolean;
  /** 控制端口 */
  port: number;
  /** 是否在线（最近一次心跳成功） */
  reachable?: boolean;
}

/** 代理模式下设备需要配置的地址 */
export interface WeakNetProxyInfo {
  /** 设备侧代理主机，固定 127.0.0.1（经 adb reverse 打回电脑） */
  host: string;
  /** 端口（电脑与设备一致） */
  port: number;
  /** adb reverse 通道是否已建立 */
  reversed: boolean;
  /**
   * 代理是否已经真正在设备上生效。
   *
   * 有些 ROM（ColorOS / 部分定制 Android 13）禁止 adb shell 写 global settings，
   * `settings put global http_proxy` 会抛 SecurityException。这时我们会退化为
   * 「手动向导」：代理服务和 reverse 通道都就绪，但需要用户到 WLAN 设置里手填地址。
   * 该字段为 false 表示还在等用户操作。
   */
  active: boolean;
  /** true = ROM 拦住了自动写入，需要用户手动设置代理 */
  manual: boolean;
  /** 手动模式下要填的完整地址，便于直接复制 */
  manualAddress?: string;
  /** 设备上当前读到（或用户手动填好）的代理值 */
  current?: string | null;
}

export interface WeakNetStatus {
  running: boolean;
  serial?: string;
  startedAt?: number;
  /** 剩余秒数，-1 表示不限时 */
  remainSec: number;
  params?: WeakNetParams;
  /**
   * 实际生效方式：
   *   vpn   = 配套 App 的 VpnService，IP 层全量整形（推荐，免 Root）
   *   tc    = 内核 netem（需 Root，保真度最高）
   *   proxy = 本地代理（免 Root，覆盖 HTTP/HTTPS，参数做等效近似）
   *   svc   = 开关网络（仅整体断网）
   *   none  = 未生效
   */
  mode: WeakNetMode;
  /** 是否具备 root */
  rooted?: boolean;
  iface?: string;
  /** 代理模式：设备侧连接信息 */
  proxy?: WeakNetProxyInfo;
  /** VPN 模式：设备侧 App 与授权状态 */
  vpn?: WeakNetVpnInfo;
  /** 代理模式 / VPN 模式：实时统计 */
  stats?: WeakNetStats;
  /** 上一次的提示信息 */
  note?: string;
}

/* ------------------------------------------------------------------ */
/* 安装包管理（v1.1.6）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 安装包归类。
 *
 * - `official` 官网包：给官网/自有渠道分发的构建（默认命名 `Domino_GW_V2.83_release_18.apk`）
 * - `google`  Google 包：给 Google Play 的构建（默认命名 `app-dmno_release-release_10.aab`）
 * - `single`  单包：**认不出官网 / Google 类型的一律归这里**（v1.1.6 收敛规则），
 *             不按 release/test 再分一层
 *
 * 🔴 `single` 的判据是「类型关键字没命中」，与有没有 release/test 标记无关 ——
 *    早先还要求「也没有通道标记」，于是 `xxx_release_3.aab` 会被扩展名兜底塞进
 *    Google 包目录。第三方包恰好带 release 是常事，宁可让它落到单包让人看见，
 *    也别让它冒充 Google 包。
 */
export type PackageKind = 'official' | 'google' | 'single';

/** 发布通道。单包、以及名字里没有任何通道标记的包没有这个值（按 release 归置） */
export type PackageChannel = 'release' | 'test';

/** 包的载体格式（只收这两种，其他文件一律不参与整理） */
export type PackageFormat = 'apk' | 'aab';

/** 分类目录名（全部可自定义，默认中文名直接可见） */
export interface PackageDirNames {
  official: string;
  google: string;
  single: string;
  release: string;
  test: string;
  /** 版本号解析不出来时的兜底目录 */
  unknownVersion: string;
}

/** 目录结构：先版本（默认）还是先类型 */
export type PackageStructure = 'version-first' | 'type-first';

/** 识别关键字（小写；按「整词」匹配文件名里被分隔符切出来的片段） */
export interface PackageKeywords {
  official: string[];
  google: string[];
  release: string[];
  test: string[];
}

/** 安装包管理当前的筛选条件（多选，空数组 = 不限） */
export interface PackageFilters {
  /** 版本号，如 ['2.83','2.84'] */
  versions: string[];
  kinds: PackageKind[];
  channels: PackageChannel[];
  formats: PackageFormat[];
  /** 文件名关键字（子串，忽略大小写） */
  keyword: string;
}

/**
 * 手动标签（v1.1.6 增强）。
 *
 * 自动归类只认文件名里的关键字，判错在所难免（第三方包叫 `xxx_release_3.apk`、
 * 官网包名字里没写 GW…）。这一层让用户把 类型 / 通道 / 版本 三项逐个钉死，
 * 钉完之后整理、筛选、列表显示**全部按手工值走**。
 *
 * 字段是「三元」语义：
 *   - 不给（undefined）→ 该字段仍按自动识别；
 *   - 给了值           → 用这个值；
 *   - 给了空串         → 明确「没有」——通道空 = 不带通道层，版本空 = 归未识别版本目录。
 *
 * 🔴 以**文件名**为键，不是路径：整理会把文件搬到别的目录，路径一变覆盖就丢了，
 *    而移动文件恰恰是本模块的核心动作。整理不改名（只有同名冲突才加 `(2)` 后缀），
 *    所以文件名是这里最稳的锚点。
 */
export interface PackageOverride {
  kind?: PackageKind;
  /** 通道；'' = 明确不带通道 */
  channel?: PackageChannel | '';
  /** 版本号；'' = 明确没有版本号 */
  version?: string;
  /** 打标签的时间戳，仅用于展示 */
  at?: number;
}

/** 文件名 → 手动标签 */
export type PackageOverrideMap = Record<string, PackageOverride>;

/** 一个安装包文件（扫描结果里的一行） */
export interface PackageEntry {
  absPath: string;
  /** 相对工作目录的路径 */
  relPath: string;
  name: string;
  format: PackageFormat;
  size: number;
  mtimeMs: number;
  /** 归一化后的版本号（2.83）；解析不出来时为空 */
  version?: string;
  /** 版本号是从文件名读到的、从上级目录名兜底读到的，还是用户手工填的 */
  versionFrom?: 'name' | 'folder' | 'manual';
  /** 文件名里出现过的原始版本串（V2.83 这种），仅用于界面展示 */
  rawVersion?: string;
  /** 版本号后面的构建号（_18 / _10） */
  build?: string;
  kind: PackageKind;
  /** 判不出通道时按 release 归置，这里给的是最终归置用的通道 */
  channel?: PackageChannel;
  /** 该包「应该」放在哪个相对目录（相对工作目录，POSIX 分隔符） */
  targetDir: string;
  /** 该包「应该」的绝对路径 */
  targetPath: string;
  /** 已经在正确位置（不需要移动） */
  organized: boolean;
  /** 该包的 类型/通道/版本 里有手工指定的项（界面上标「手动」，可一键恢复自动） */
  overridden?: boolean;
  /** 未移动时的原因：duplicate=同名同大小文件已存在 */
  skipReason?: 'duplicate';
}

/** 扫描结果 */
export interface PackageScanResult {
  root: string;
  /** 工作目录是否存在 */
  exists: boolean;
  entries: PackageEntry[];
  /** 需要移动的文件数 */
  pending: number;
  /** 识别到的版本号（倒序） */
  versions: string[];
  stats: {
    total: number;
    bytes: number;
    byKind: Record<PackageKind, number>;
    byChannel: Record<PackageChannel, number>;
    byFormat: Record<PackageFormat, number>;
    /** 工作目录里被忽略的非 apk/aab 文件数（不移动） */
    ignored: number;
  };
  /** 整理时会用到的目录（相对工作目录，用于「目录树」预览） */
  dirs: string[];
  scannedAt: number;
}

export interface PackageOrganizeResult {
  root: string;
  moved: number;
  /** 已经在正确位置、或同名同大小被跳过的数量 */
  skipped: number;
  failed: { name: string; error: string }[];
  details: { from: string; to: string }[];
  /** 整理完重新扫一次的结果，界面直接用它刷新列表 */
  scan: PackageScanResult;
}

/* ------------------------------------------------------------------ */
/* 会话设置                                                            */
/* ------------------------------------------------------------------ */

/**
 * 主题色 id。
 *
 * 每个 id 在 src/styles/global.css 里都对应一对变量块（浅色 + 深色），
 * 在 src/pages/SettingsPage.tsx 的 ACCENTS 里对应一个名称与两个色值（用于画色块）。
 * ⚠️ 三处必须同步；新增主题时别忘了 global.css 里的**深色那条** ——
 * 只写浅色的话，深色模式下会串成浅色配色（原因见 global.css 文件头）。
 *
 * 'cangqiong'（苍穹）是默认值，也是 global.css 里 :root 那一份 —— 所以它不写
 * [data-accent] 块，启动瞬间没闪烁。
 */
export type AccentId = 'cangqiong' | 'cloud' | 'mist' | 'ocean' | 'ink';

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  /** 主题色（v1.1.2）。决定 --accent 及整套界面底色，见 AccentId */
  accent: AccentId;
  /**
   * 左侧功能栏是否收起（v1.1.8）。
   *
   * 收起后侧栏变窄、只显示各功能的图标并隐藏文字标签，展开后恢复。
   * 与主题一样属于「界面偏好」，所以持久化在设置里 —— 下次启动保持用户上次的形态，
   * 而不是每次都弹回展开。默认 false（展开）。
   */
  sidebarCollapsed: boolean;
  /** 截图默认保存目录 */
  screenshotDir: string;
  /** 录屏默认保存目录 */
  recordDir: string;
  /** 拉取文件默认目录 */
  pullDir: string;
  /**
   * Logcat 导出根目录（v1.0.27）。默认 `D:\adblogs`，
   * 实际落盘 = `<logcatExportDir>\<设备机型 序列号>\<YYYY-MM-DD>\`。
   */
  logcatExportDir: string;
  /** 默认目标设备序列号 */
  defaultSerial?: string;
  /**
   * 开机自启动（v1.1.7）。
   *
   * 值由主进程写注册表后**回读校正**（见 services/auto-launch.ts）——
   * 界面上勾了不代表注册表真写成，所以设置里存的始终是「系统实际状态」。
   */
  autoLaunch: boolean;
  /*
   * 在线更新（v1.0.22）。服务器就绪前 updateBaseUrl 一直是空串 ——
   * 此时「检查更新」提示「更新源未配置」是**正常状态**，不是错误。
   */
  /** 更新源根地址（如 https://example.com/adb-assistant/），空 = 未配置 */
  updateBaseUrl: string;
  /** 更新通道；本次只实现 stable，协议里预留 beta */
  updateChannel: UpdateChannel;
  /** 启动后静默检查一次（失败不打扰用户） */
  autoCheckUpdate: boolean;
  /** 上次检查时间（ISO），仅用于界面展示 */
  lastCheckAt: string;
  /*
   * 自动连点器 / 屏幕录制（v1.0.32）
   */
  /** 连点器默认倍速（新建脚本时套用） */
  clickerSpeed: number;
  /** 连点器默认随机偏移半径（像素，0 = 关闭） */
  clickerJitterPx: number;
  /** 采集端控制端口（设备侧，adb forward 映射用） */
  recorderPort: number;
  /*
   * 安装包管理（v1.1.6）：一个按「版本 / 类型 / 通道」自动归类的本地仓库。
   * 与截图/录屏那些「跟系统走」的目录不同，这里默认给一个固定的仓库根
   * （和 logcat 导出根 D:\adblogs 一个道理），用户随时可在模块里改。
   */
  /** 仓库工作目录（整理与浏览都只看这一个目录） */
  packageRootDir: string;
  /** 分类目录名（可自定义） */
  packageDirNames: PackageDirNames;
  /** 目录结构：先版本还是先类型 */
  packageStructure: PackageStructure;
  /** 进入模块时自动整理一次 */
  packageAutoOrganize: boolean;
  /** 上次用的筛选条件（下次进入沿用） */
  packageFilters: PackageFilters;
  /** 手动标签（按文件名），自动识别判错时用户钉死的值 */
  packageOverrides: PackageOverrideMap;
}

/* ------------------------------------------------------------------ */
/* 自动连点器（v1.0.32）                                                */
/* ------------------------------------------------------------------ */

/**
 * 一个脚本步骤。
 *
 * 设计原则：**坐标一律存归一化比例（0~1）**，不存像素。
 * 理由：录制时的屏幕分辨率、回放时的设备分辨率、投屏窗口大小三者都可能不同；
 * 只有「占屏幕宽高的比例」是这些场景都认的。回放时由执行器乘以目标分辨率。
 */
export type ClickerStep =
  /** 点击 / 连击。count > 1 即连击（间隔 clickGapMs） */
  | { kind: 'tap'; nx: number; ny: number; count?: number }
  /** 长按 */
  | { kind: 'longPress'; nx: number; ny: number; ms: number }
  /** 滑动。durationMs 为滑动过程耗时 */
  | { kind: 'swipe'; nx1: number; ny1: number; nx2: number; ny2: number; durationMs: number }
  /** 按键。code 为 Android keycode（3=HOME、4=BACK、26=电源…） */
  | { kind: 'key'; code: number }
  /** 等待 */
  | { kind: 'wait'; ms: number }
  /** 截图（存到截图目录） */
  | { kind: 'screenshot' }
  /** 任意 adb shell 命令 */
  | { kind: 'shell'; cmd: string }
  /** 启动应用 */
  | { kind: 'launch'; pkg: string }
  /** 步骤分组说明（不执行，只用于在列表里分节，来自录制时的系统事件） */
  | { kind: 'note'; text: string };

export type ClickerStepKind = ClickerStep['kind'];

/** 步骤在界面上的中文名 */
export const CLICKER_STEP_LABEL: Record<ClickerStepKind, string> = {
  tap: '点击',
  longPress: '长按',
  swipe: '滑动',
  key: '按键',
  wait: '等待',
  screenshot: '截图',
  shell: 'ADB 命令',
  launch: '启动应用',
  note: '说明',
};

/**
 * 一套连点脚本。
 *
 * `steps` 是本体；`loop` / `speed` / `jitterPx` 是执行参数，
 * 刻意与步骤分开存：调倍速不该改写脚本内容（用户随时能调回来）。
 */
export interface ClickerScript {
  id: string;
  name: string;
  steps: ClickerStep[];
  /** 循环次数。0 = 无限循环（直到手动停止） */
  loop: number;
  /** 倍速。1 = 原速；0.5 = 放慢一倍；2 = 快一倍 */
  speed: number;
  /**
   * 「模拟真实点击」的随机偏移半径（像素）。
   *
   * 每次点击在 [0, jitterPx) 内随机偏移 x/y，避免每次都精确打在同一点 ——
   * 不少游戏/风控会检测「坐标完全一致」的机械点击。
   * 0 = 关闭（精确点击）。
   */
  jitterPx: number;
  /** 创建时间（ISO） */
  createdAt: string;
  /** 最后修改时间（ISO） */
  updatedAt: string;
  /** 来源：录制生成 / 手工创建 */
  source: 'record' | 'manual';
  /** 若来自录制，记录当时的屏幕信息，便于回放时判断比例是否适配 */
  recordedMeta?: ClickerRecordMeta;
}

/** 录制时的屏幕信息（用于换算校验） */
export interface ClickerRecordMeta {
  width: number;
  height: number;
  density: number;
  landscape: boolean;
}

/** 运行状态快照 */
export interface ClickerStatus {
  running: boolean;
  /** 当前脚本 id */
  scriptId?: string;
  /** 当前是第几轮（从 1 开始） */
  round: number;
  /** 当前执行到第几步（索引，0 基） */
  index: number;
  /** 总步数 */
  total: number;
  /** 已完成的步骤总数（跨轮累计，用于算进度） */
  done: number;
  startedAt: number;
  /** 最近一条执行说明（如「点击 (540, 1200)」） */
  note: string;
  /** 出错信息（若有） */
  error?: string;
}

/** 回放引擎推送给界面的进度 */
export interface ClickerProgress {
  scriptId: string;
  round: number;
  index: number;
  total: number;
  done: number;
  /** 当前步骤的中文描述，直接显示 */
  label: string;
  /** 是否为错误终止 */
  failed?: boolean;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 屏幕录制采集端（v1.0.32）                                            */
/* ------------------------------------------------------------------ */

/** 采集端 App 的探活结果 */
export interface RecorderInfo {
  /** 采集端是否就绪（能连上它的控制端口） */
  ready: boolean;
  /** 设备上是否已安装采集端 */
  installed: boolean;
  /** 已装版本号（versionCode） */
  versionCode: number | null;
  /** 是否已获得录屏授权 */
  authorized: boolean;
  /** 是否正在录制 */
  recording: boolean;
  protocol: number;
  model?: string;
  note: string;
}

/** 采集端会话快照 */
export interface RecorderStatus {
  recording: boolean;
  paused: boolean;
  capturing: boolean;
  elapsedMs: number;
  meta: ClickerRecordMeta;
  touchCount: number;
  frameCount: number;
  sysCount: number;
  note: string;
}

/** 采集端录制的一条触摸事件（原始数据，尚未转成步骤） */
export interface RecordedTouch {
  type: 'down' | 'move' | 'up';
  nx: number;
  ny: number;
  t: number;
}

/** 采集端录制的一条系统事件 */
export interface RecordedSysEvent {
  kind: string;
  pkg: string;
  t: number;
  label: string;
}

/** 采集端录制的一张关键帧 */
export interface RecordedFrame {
  t: number;
  id: number;
  bytes: number;
}

/** 拉取到的完整录制数据 */
export interface RecordedSession {
  meta: ClickerRecordMeta;
  touches: RecordedTouch[];
  frames: RecordedFrame[];
  sysEvents: RecordedSysEvent[];
}

/**
 * 录制前置检查结果（v1.0.33）。
 *
 * 触屏采集改到电脑侧（`adb getevent`）之后，「装了没 / 授权没 / 读得到触摸没」
 * 成了三个**互相独立**的前提，任何一个不满足都录不出可用脚本。
 * 这个结构让界面能一次把三条链路的状态都摆出来。
 */
export interface RecorderPrepare {
  /** 三条链路都 OK */
  ok: boolean;
  /** 采集端装了没 */
  installed: boolean;
  /** 录屏授权拿到没（首次需在手机上点一次，之后免） */
  authorized: boolean;
  /** 电脑侧能否读到触摸节点（`getevent`） */
  touchOk: boolean;
  /** 触摸链路的说明（节点名 / 量程 / 不可用原因） */
  touchNote: string;
  /** 面向用户的一句话总结 */
  note: string;
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

  /* AAB（Android App Bundle） */
  AAB_INSTALL: 'aab:install',
  AAB_ENV: 'aab:env',
  AAB_DOWNLOAD_TOOL: 'aab:downloadTool',
  AAB_OPEN_TOOL_DIR: 'aab:openToolDir',
  AAB_CACHE_LIST: 'aab:cacheList',
  AAB_CACHE_CLEAR: 'aab:cacheClear',
  /* 拆包与安装分离：AAB → .apks（可另存、可复用），.apks 直接安装 */
  AAB_CONVERT: 'aab:convert',
  AAB_SAVE_APKS: 'aab:saveApks',
  /* 通用 APK：AAB → 单个可分发 .apk（与设备无关，不需要连设备） */
  AAB_EXPORT_UNIVERSAL: 'aab:exportUniversal',
  APKS_INSTALL: 'apks:install',
  /* AAB 签名（解决三方登录 / 推送的 key hash 失配问题） */
  AAB_SIGNING_GET: 'aab:signingGet',
  AAB_SIGNING_SET: 'aab:signingSet',
  AAB_SIGNING_PICK: 'aab:signingPick',
  AAB_SIGNING_PROBE: 'aab:signingProbe',

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
  /** 只扫描不落盘：把工作目录里的包按规则算出「应该在哪」 */
  PACKAGES_SCAN: 'packages:scan',
  /** 真的把文件挪到分类目录里（幂等，重复跑只会有 0 次移动） */
  PACKAGES_ORGANIZE: 'packages:organize',
  /** 选工作目录（系统选文件夹框） */
  PACKAGES_PICK_DIR: 'packages:pickDir',
  /** 在资源管理器里定位某个包 */
  PACKAGES_REVEAL: 'packages:reveal',
  /** 手工指定一个包的类型/通道/版本（tag=null = 恢复自动识别） */
  PACKAGES_SET_TAG: 'packages:setTag',
  /** 清空全部手动标签 */
  PACKAGES_CLEAR_TAGS: 'packages:clearTags',

  /* 实时 Logcat（v1.0） */
  LOGCAT_START: 'logcat:start',
  LOGCAT_STOP: 'logcat:stop',
  LOGCAT_STATUS: 'logcat:status',
  LOGCAT_CLEAR: 'logcat:clear',
  LOGCAT_SAVE: 'logcat:save',
  LOGCAT_PROCESSES: 'logcat:processes',

  /* Logcat 导出工具（常用工具页，v1.0.26） */
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
  /* 弱网 v2：VPN 模式 —— 设备上装配套 App，由它建 VPN 做 IP 层整形 */
  WEAKNET_VPN_AUTHORIZE: 'weaknet:vpnAuthorize',
  WEAKNET_VPN_APP_INFO: 'weaknet:vpnAppInfo',
  WEAKNET_VPN_INSTALL: 'weaknet:vpnInstall',
  WEAKNET_VPN_PARAMS: 'weaknet:vpnParams',

  /* 自动连点器（v1.0.32） */
  CLICKER_LIST: 'clicker:list',
  CLICKER_SAVE: 'clicker:save',
  CLICKER_DELETE: 'clicker:delete',
  CLICKER_RESET: 'clicker:reset',
  /** 把录制数据转成脚本（不落盘，只回给界面预览） */
  CLICKER_FROM_RECORD: 'clicker:fromRecord',
  /** 回放 */
  CLICKER_RUN: 'clicker:run',
  CLICKER_STOP: 'clicker:stop',
  CLICKER_STATUS: 'clicker:status',
  /** 立即执行单步（调试用：验证一个步骤写对了没） */
  CLICKER_RUN_STEP: 'clicker:runStep',
  /** 可用的 Android keycode 列表 */
  CLICKER_KEYCODES: 'clicker:keycodes',
  /** 屏幕预览图：抓一帧当前屏幕（含像素宽高），供在预览画面上点选坐标 */
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
  /** 取某张关键帧的 JPEG（base64，供界面显示缩略图） */
  RECORDER_FRAME: 'recorder:frame',
  /** 打开采集端界面（只用于看预览 / 排障，**不在录制流程里调**） */
  RECORDER_OPEN_UI: 'recorder:openUi',
  /** 把采集端界面退回后台（兜底用，注意会让用户回到桌面） */
  RECORDER_BACKGROUND_UI: 'recorder:backgroundUi',
  /** 录制前置检查：画面链路 + 触摸链路各自是否可用 */
  RECORDER_PREPARE: 'recorder:prepare',
  /** 放弃本次录制（收干净资源、不留数据） */
  RECORDER_CANCEL: 'recorder:cancel',

  /* 日志 */
  LOG_EXPORT: 'log:export',
  LOG_CLEAR: 'log:clear',
  LOG_LIST_ALL: 'log:listAll',
  /** 运行日志的本地目录（按日期分文件存放，只保留 24 小时） */
  LOG_DIR: 'log:dir',

  /* 设置 */
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  /* 窗口外观（v1.1.3）：标题栏是自绘的，底色要跟着主题色走 */
  WINDOW_SET_TITLEBAR: 'window:setTitlebar',

  /* 增量更新（v1.0.7） */
  UPDATE_CONTEXT: 'update:context',
  UPDATE_PREPARE: 'update:prepare',
  UPDATE_APPLY: 'update:apply',
  UPDATE_CANCEL: 'update:cancel',
  UPDATE_ROLLBACK: 'update:rollback',
  UPDATE_HANDSHAKE: 'update:handshake',
  UPDATE_OPEN_DIR: 'update:openDir',

  /* 在线更新（v1.0.22）：联网检查 + 下载，校验与替换仍走上面那套 */
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL_DOWNLOAD: 'update:cancelDownload',

  /* 主进程 -> 渲染进程 推送 */
  PUSH_LOG: 'push:log',
  PUSH_MIRROR_STATUS: 'push:mirrorStatus',
  PUSH_RECORD_STATUS: 'push:recordStatus',
  PUSH_DEVICE_CHANGED: 'push:deviceChanged',
  PUSH_MONKEY_OUTPUT: 'push:monkeyOutput',
  PUSH_LOGCAT_LINES: 'push:logcatLines',
  PUSH_LOGCAT_STATUS: 'push:logcatStatus',
  PUSH_WEAKNET_STATUS: 'push:weaknetStatus',
  /** AAB 安装过程中 bundletool 的输出行 */
  PUSH_AAB_OUTPUT: 'push:aabOutput',
  /** bundletool 下载进度 */
  PUSH_AAB_DOWNLOAD: 'push:aabDownload',
  /** 在线更新包下载进度（v1.0.22） */
  PUSH_UPDATE_DOWNLOAD: 'push:updateDownload',
  /** 连点器回放进度（v1.0.32） */
  PUSH_CLICKER_PROGRESS: 'push:clickerProgress',
  /** 采集端录制状态变化（v1.0.32） */
  PUSH_RECORDER_STATUS: 'push:recorderStatus',
} as const;

/**
 * 自绘标题栏的高度（DIP）。
 *
 * ⚠️ 三处必须一致，不一致系统按钮就会和自绘色带对不齐：
 *   主进程建窗口时的 `titleBarOverlay.height`、更新配色时的 height、
 *   渲染层 CSS 变量 `--titlebar-h`（src/styles/global.css）。
 *
 * 🔴 **这个值只能比系统标题栏高，不能比它矮** —— 这是 Electron 的硬约束，
 *    源码 shell/browser/ui/views/win_frame_view.cc：
 *
 *        int WinFrameView::TitlebarHeight(int custom_height) const {
 *          int height = TitlebarMaximizedVisualHeight()   // = SM_CYCAPTION（DIP）
 *                     + FrameTopBorderThickness(false) - WindowTopY();
 *          if (custom_height > TitlebarMaximizedVisualHeight())  // ← 只有更大才生效
 *            height = custom_height - WindowTopY();
 *          return height;
 *        }
 *        // 旁边原注释：// Needed for heights larger than default
 *
 *    也就是说：给的 height 一旦 ≤ 系统值，图标按钮就**退回系统高度**（不再跟着缩），
 *    但 overlay 区域（渲染层 reserving 的那块、以及 WCO 上报的 rect）仍然是用你给的值 ——
 *    结果就是右上角那三个按钮比色带高出一截，在角上糊出一块台阶。
 *    本机实测（120 DPI）：SM_CYCAPTION = 23.2 DIP、SM_CYSIZEFRAME = 3.2 DIP
 *    ⇒ 用系统按钮时**带子最低 ≈ 24 DIP**（这里取 25 留 1px 余量，避免不同缩放档位取整后踩线）。
 *    要真的更薄（例如 21），只能不要系统按钮、改成自绘三个按钮（见 main.ts 的说明）。
 */
export const TITLEBAR_HEIGHT = 25;

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

/* ------------------------------------------------------------------ */
/* 增量更新（v1.0.7）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 更新包形态
 * - asar     ：安装版小包（只替换 resources/app.asar，必要时附 bin 差量）
 * - portable ：便携版整包（替换单文件 portable exe 本体）
 */
export type UpdateKind = 'asar' | 'portable';

/** 本机形态：dev = 未打包（开发模式，更新入口禁用） */
export type LocalKind = UpdateKind | 'dev';

/** 小包 manifest.json 的固定 schema 版本；不认识的 schema 一律拒绝 */
export const UPDATE_SCHEMA = 1;

/**
 * 产品身份。必须与 electron-builder.json 的 productName / appId 一致，
 * 用来拒绝「装错产品」的更新包（脚本 scripts/make-update.py 从配置里读同一份值写进 manifest）。
 */
export const UPDATE_PRODUCT_NAME = 'ADB桌面助手';
export const UPDATE_APP_ID = 'com.xiaoyang.adbassistant';

export interface UpdateFileEntry {
  /** zip 内相对路径（全 ASCII）：app.asar / bin/xxx / portable/app.exe */
  path: string;
  size: number;
  sha256: string;
}

export interface UpdateManifest {
  schema: number;
  productName: string;
  appId: string;
  /** 目标版本（必须 > 当前版本） */
  version: string;
  builtAt: string;
  electronVersion: string;
  /**
   * 安装本包**之前**目标机应有的 resources/bin 指纹。
   * 与当前安装不一致 → 说明运行库对不上（换了 Electron 或改了 adb/scrcpy），必须装全量包。
   */
  baseRuntimeHash: string;
  /** 安装本包**之后**的 resources/bin 指纹（无 bin 差量时与 base 相同） */
  resultRuntimeHash: string;
  kind: UpdateKind;
  /**
   * 完整资源包标记（v1.0.31）。
   *
   * true = 本包携带**全部** `bin/` 文件（不是差量），因此不依赖目标机原有的运行库，
   * 可以从任意旧版本一次升到位。为 true 时 baseRuntimeHash 不参与校验
   * （见 update-core.validateManifest）—— 这就是「跨版本在线更新」的实现方式。
   */
  full?: boolean;
  files: UpdateFileEntry[];
}

/** 「关于」页展示的本机更新环境 */
export interface UpdateContext {
  version: string;
  kind: LocalKind;
  packaged: boolean;
  electronVersion: string;
  /** 当前安装的 resources/bin 指纹 */
  runtimeHash: string;
  /** 会被替换的主目标路径（安装版 = app.asar，便携版 = 那个 exe） */
  targetPath: string;
  /** 目标是否可写（提前发现只读目录 / U 盘写保护 / 便携版所在目录不可写） */
  targetWritable: boolean;
  /** 是否允许走增量更新；false 时看 disabledReason */
  canUpdate: boolean;
  disabledReason?: string;
  /** 是否有可回滚的备份 */
  hasBackup: boolean;
  /** 备份对应的版本号 */
  backupVersion?: string;
  /** 更新目录（便于用户查看日志/备份） */
  updateDir: string;
}

/** prepareUpdate 的返回值：通过校验才能拿到 stageDir */
export interface UpdateInfo {
  /** 是否可用（全部校验通过） */
  ok: boolean;
  /** 被拒绝时的原因（面向用户，直接展示） */
  reason?: string;
  /** 通过但有风险时的提醒（例如包含 bin 变更） */
  warning?: string;
  zipPath: string;
  zipSize: number;
  /** 解压暂存目录（ok 时才有） */
  stageDir?: string;
  manifest?: UpdateManifest;
  /** 将被替换的文件数与总字节 */
  fileCount?: number;
  totalBytes?: number;
  /** 会新增/覆盖运行库文件时的清单 */
  runtimeFiles?: string[];
  /** 在线下载得到时记录来源 URL（本地选包时为空） */
  sourceUrl?: string;
}

/** helper 落盘、新版启动后回读的更新结果 */
export interface UpdateResult {
  ok: boolean;
  /** apply = 应用更新 / restore = 回滚 */
  mode?: 'apply' | 'restore';
  from?: string;
  to?: string;
  /** ISO 时间 */
  at?: string;
  /** 失败原因 */
  error?: string;
  /** 是否已经自动还原回旧版本 */
  rolledBack?: boolean;
  /** helper 日志路径 */
  logPath?: string;
}

/* ------------------------------------------------------------------ */
/* 在线更新（v1.0.22）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 服务器上的 latest.json 只能是静态文件（本次确认不走后端接口）。
 * 它只负责「指路」—— 真正的安全判定仍在包内 manifest（产品、版本、
 * Electron 版本、运行库指纹、逐文件 sha256），所以清单本身不签名也能接受。
 */
export const UPDATE_LATEST_SCHEMA = 1;

/** 更新通道；本次只实现 stable（beta 只在协议与类型里预留） */
export type UpdateChannel = 'stable' | 'beta';

/** 更新源返回的单个包引用（url 允许是相对 latest.json 的相对路径） */
export interface UpdatePackageRef {
  url: string;
  size?: number;
  sha256?: string;
  /**
   * 本包要求目标机 `resources/bin` 在**应用之前**是哪个指纹（v1.0.31）。
   *
   * 为什么放进清单：老流程只把基准写在包内 manifest.json 里，客户端必须先下完整包
   * 才能知道对不对得上 —— 跨版本升级的用户会白下几十 MB 再被拒。清单里带上它，
   * 就能在**下载之前**挑出精确匹配的那一份，或者直接改走完整资源包。
   */
  baseRuntimeHash?: string;
}

/** 包形态：asar / portable 之外再多一个 full（完整资源包，跨版本兜底） */
export type UpdatePackageForm = UpdateKind | 'full';

/** 清单里的包集合：按形态索引，另有一个 full 兜底槽 */
export type UpdatePackageRefs = Partial<Record<UpdatePackageForm, UpdatePackageRef>>;

/** latest.json 的 latest 节点 */
export interface UpdateLatestEntry {
  version: string;
  publishedAt?: string;
  /** 更新说明，界面直接显示 */
  notes?: string;
  /** 是否重要更新（本次只做展示，不强制） */
  critical?: boolean;
  packages: UpdatePackageRefs;
  /**
   * 多基线差分小包（v1.0.31）。
   *
   * 同一个新版本可以针对**多个旧版本基线**各出一份补丁，每份自带 baseRuntimeHash。
   * 老客户端不认这个字段，只会读 packages[kind]（原行为不变）；
   * 新客户端优先在这里挑与本机运行库精确匹配的那一份，挑不到再退到 packages.full。
   */
  variants?: UpdatePackageRef[];
}

/** 服务器上的 latest.json 全文 */
export interface UpdateLatestDoc {
  schema: number;
  productName: string;
  appId: string;
  channel: string;
  generatedAt?: string;
  latest: UpdateLatestEntry;
}

/** 下载进度（主进程 → 渲染层推送，走 push:updateDownload） */
export interface UpdateDownloadProgress {
  received: number;
  total: number;
  /** total 未知（无 Content-Length）时为 0 */
  percent: number;
  phase: 'download' | 'verify';
}

/**
 * checkOnlineUpdate 的返回值。
 * 注意 ok 与 hasUpdate 是两件事：网络挂了是 ok=false，服务端说「没新版」是 ok=true + hasUpdate=false。
 */
export interface UpdateCheckResult {
  ok: boolean;
  /** ok=false 时面向用户的原因（直接展示，不加工） */
  reason?: string;
  /** 源描述，如「官方更新源」/「未配置」 */
  sourceDesc: string;
  /** 是否配置了更新源地址（未配置是正常状态，不是错误） */
  configured: boolean;
  /** 是否有比当前更新的版本 */
  hasUpdate: boolean;
  currentVersion: string;
  /** 本次检查时间（ISO 本地格式） */
  checkedAt: string;
  /** hasUpdate 时有值 */
  latest?: {
    version: string;
    publishedAt?: string;
    notes?: string;
    critical?: boolean;
    /** 与本机形态匹配的包；null = 该版本未提供此形态的更新包 */
    pkg: UpdatePackageRef | null;
    /** 选中的包属于哪种形态；'full' = 跨版本完整资源包（v1.0.31） */
    pkgForm?: UpdatePackageForm;
    /** 为什么选了它 / 为什么一个都没选上（面向用户的一句话，界面可直接展示） */
    pkgNote?: string;
  };
}
