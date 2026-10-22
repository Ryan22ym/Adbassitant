import { create } from 'zustand';
import type {
  DeviceInfo,
  LogEntry,
  MirrorStatus,
  AppSettings,
  RecordSession,
  InstallMode,
  InstallKind,
  SigningMode,
  AccentId,
  GlassBackdropMode,
  GlassTintId,
  CrashReportMeta,
  CrashWatchStatus,
  UpdateTipInfo,
} from '@shared/types';
import { cloneDefaultUiConf, type UiConf } from '@shared/ui-conf';

/* ------------------------------------------------------------------ */
/* 透明玻璃主题的参数映射（v1.1.13）                                    */
/* ------------------------------------------------------------------ */

/**
 * 把两个玻璃参数写到 <html> 的内联变量上。
 *
 * 🔴 为什么写内联 style 而不是加一个 class：
 *    这是**连续可调**的值（滑杆），class 只能枚举有限档位。内联变量的优先级
 *    高于 theme-glass.css 里 :root 上的默认值，所以一写就生效。
 *
 * 数值映射（两个滑杆都是 0~100 的整数，取值来自设置页）：
 *
 *   opacity → --glass-alpha  0.08 ~ 0.95
 *     「白纱盖多厚」。不给 0：全透明时面板彻底消失，连字都看不见，用户会以为
 *     界面坏了。不给 1：全不透明就不是玻璃了，那不是这个主题要的东西。
 *
 *   roughness → --glass-blur  0 ~ 60px
 *     「高斯模糊多强」。系数 0.6 是对着小杨给的目标图**实测标定**出来的（2026-10-13）：
 *       目标图是 iOS 26 控制中心，在 546px 宽的截图上 blur ≈ 12px，
 *       换算到本机 1184 CSS px 的窗口 ≈ 26px —— 也就是滑杆 **43 档**。
 *       所以默认取 45 档（27px），正落在目标观感上。
 *     ⚠️ 之前是 `* 0.48` / 上限 48px：滑杆 100 → 48px 已经糊成一片纯色，
 *        后段全是死区（拖了看不出变化）。改成 0.6 / 60px 后，
 *        整条滑杆 0~100 都能看出渐变，且 100 档仍保留「完全糊掉」的用法。
 *     ⚠️ 0 档 = 真的**零模糊**（清晰玻璃，能看到桌面图标，也保留这个用法）。
 */
function paintGlassVars(opacity: number, roughness: number): void {
  const a = Math.min(0.95, Math.max(0.08, opacity / 100));
  const blur = Math.min(60, Math.max(0, roughness * 0.6));
  const el = document.documentElement;
  el.style.setProperty('--glass-alpha', a.toFixed(3));
  el.style.setProperty('--glass-blur', `${blur.toFixed(1)}px`);
}

/* ------------------------------------------------------------------ */
/* 主题色：自定义色（v1.1.14）                                          */
/* ------------------------------------------------------------------ */
/* 具体派生逻辑在 src/lib/accent-custom.ts —— 那边从**一个** hex 算出整套变量。 */

/** 玻璃主题底图色系的合法值（settings.json 可能被手改，读回来要兜底） */
const GLASS_TINTS: GlassTintId[] = ['blue', 'pink', 'gray', 'pearl'];

/** 把底图色系写到 <html data-glass-tint="...">（theme-glass.css 按它选变量块） */
function paintGlassTint(tint: GlassTintId): void {
  document.documentElement.setAttribute('data-glass-tint', tint);
}

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
  /**
   * 弹窗标题覆盖。
   *
   * 单台安装时标题就是「安装成功 / 安装失败」，由 phase 推出来即可；
   * 但「一次装到 N 台」是汇总语义 —— 可能是「3/4 台安装成功」这种
   * 既不算全成功也不算全失败的中间态，光靠 phase 表达不了。
   */
  title?: string;
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
 * 已接下、但还没确定「装到哪台、怎么装」的安装请求。
 *
 * 两种情况会挂到这里，都是为了不让程序替用户做决定：
 * 1. **多台设备在线** —— 安装目标必须由用户回答（谁也没法从「拖了一个 APK 进来」
 *    推断出用户想装到手机还是模拟器）；
 * 2. **单台设备 + 拖放来源** —— 目标没有歧义，但安装方式有：拖进来的包如果
 *    一声不响按默认的覆盖安装跑掉，用户就没有机会选清洁 / 全新安装。
 *    （点「开始安装」按钮那条路不算 —— 页面上那个选择器已经是用户的明确回答。）
 */
export interface PendingInstall {
  files: InstallFile[];
  mode: InstallMode;
  grantAll: boolean;
  /** AAB 本次要用的签名覆盖（界面上临时改的），不传则用后端设置里那份 */
  signing?: InstallSigningOverride;
  /** 这次待定安装是不是「整窗拖放」来的（只影响那一屏的文案） */
  fromDrop?: boolean;
  /**
   * 只有一台在线设备：这一屏退化成「确认安装方式」，没有可挑的目标。
   *
   * 不能靠 `devices.length === 1` 现推 —— 弹窗开着时插拔设备会让标题/按钮
   * 在「装到哪台」和「确认方式」之间来回跳。
   */
  single?: boolean;
}

/**
 * AAB 安装时的签名覆盖 —— 与后端 AabSigningConfig 同构。
 * 持久化由主进程负责，这里只是界面上那份缓存。
 */
export interface InstallSigningOverride {
  mode: SigningMode;
  keystorePath?: string;
  storePass?: string;
  keyPass?: string;
  keyAlias?: string;
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

  /*
   * 界面配置（Conf/*.json，v1.1.12）。
   *
   * 初值取**出厂默认**而不是 null，是为了首屏就有东西可画：IPC 是异步的，
   * 如果初值是 null，导航与各功能块会先按「什么都没有」渲染一帧再跳变。
   * 用户没改过配置时，主进程回来的结果与初值相同，界面一次都不会抖。
   */
  uiConf: UiConf;
  setUiConf: (c: UiConf) => void;

  /*
   * 主题（v1.1.11 起是三选一，同一级，见 shared/types.ts 的 ThemeId）。
   *
   * 'genshin' 不是「第 3 个主题色」，而是和浅色/深色平级的**另一套主题**：
   * 它自带配色 + 描边 + 角饰 + 圆角尺度，并且**没有深色变体** ——
   * 选中它就锁定这一套外观，不参与浅/深切换。
   * 'system' 是早期遗留值，在 setSettings 里就已经解析成 light/dark，这里不出现。
   */
  theme: 'light' | 'dark' | 'genshin' | 'glass';
  applyTheme: (t: 'light' | 'dark' | 'genshin' | 'glass') => void;

  /*
   * 透明玻璃主题的两个可调参数（v1.1.13）。
   *
   * 与 theme / accent 同一个套路：真值持久化在主进程 settings.json，
   * 这里只是界面上的那份缓存。改的时候除了落盘，还要立刻写进 DOM ——
   * 拖滑杆必须实时看到效果，等 IPC 往返就卡了。
   *
   * 玻璃主题生效时才有意义；其它主题下这两个值不参与渲染（CSS 只认
   * data-theme='glass'），但**仍然保留**，这样来回切主题手感不丢。
   */
  glassOpacity: number;
  glassRoughness: number;
  /** 同时设置两个玻璃参数（滑杆拖动时用；写 DOM + 落盘由调用方决定） */
  setGlass: (opacity: number, roughness: number) => void;
  /** 只写 DOM 不落盘（拖动过程中用，松手才落盘，避免刷爆 settings.json） */
  paintGlass: (opacity: number, roughness: number) => void;

  /*
   * 玻璃主题的底图（v1.1.14）：壁纸 / 主题色，**互斥**（见 GlassBackdropMode）。
   *
   * glassWall 是抓回来的桌面壁纸（data URL）—— 从 App 的局部 state 搬进 store，
   * 是因为设置页要能「重新读取桌面壁纸」（换了壁纸不用重启程序）。
   * 只在 glassBackdrop='wallpaper' 时才有值；切到主题色模式会被清掉。
   */
  glassBackdrop: GlassBackdropMode;
  glassTint: GlassTintId;
  glassWall: string | null;
  setGlassBackdrop: (m: GlassBackdropMode) => void;
  setGlassTint: (t: GlassTintId) => void;
  /** 抓一张当前桌面壁纸（幂等；抓不到就保持 null，CSS 退回纯色底） */
  loadGlassWall: () => Promise<void>;

  /* 主题色（决定 --accent 与整套界面底色，见 shared/types.ts 的 AccentId） */
  accent: AccentId;
  applyAccent: (a: AccentId) => void;

  /*
   * 自定义主题色的色值（v1.1.14，`#rrggbb`；空串 = 还没挑过）。
   * 只有 accent === 'custom' 时参与渲染，派生逻辑见 lib/accent-custom.ts。
   */
  accentCustom: string;
  applyAccentCustom: (hex: string) => void;

  /*
   * 左侧功能栏收起状态（v1.1.8）。
   *
   * 与 theme / accent 同一个套路：真值持久化在主进程 settings.json 里，
   * 这里只是界面上的那份缓存（启动读设置时同步，切换时写回）。
   */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;

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
  /**
   * AAB 拆包签名（与后端持久化的那份同步）。
   *
   * 独立于 installMode 之外的原因：签名的作用域是「这个应用」而不是「这次安装」，
   * 用户换一次签名（比如换成游戏的正式签名）后，之后装同一个包一直用它才合理。
   * 但设备上原有版本是用什么签名装的，只有用户自己知道 —— 所以必须可改。
   */
  installSigning: InstallSigningOverride;
  setInstallSigning: (s: InstallSigningOverride) => void;
  /** 是否正把文件拖在窗口上方（用于显示全窗拖放提示） */
  dragActive: boolean;
  setDragActive: (v: boolean) => void;
  /**
   * 等待用户指定目标设备的安装请求（null = 没有）。
   * 多台设备在线时先落到这里，由界面向用户问「装到哪台」，不猜。
   */
  pendingInstall: PendingInstall | null;
  setPendingInstall: (p: PendingInstall | null) => void;
  /**
   * 原地改这次待定安装的字段（目前只用于「选设备弹窗里改安装方式」）。
   *
   * v1.0.28：安装方式从「拖入那一刻就冻结」改成「选设备这一屏还能改」。
   * 拖放时按的是全局 installMode，但用户点这一屏往往才想起要清洁装 ——
   * 改的是 pending 里的副本，**不写回 store.installMode**：
   * 全局默认必须一直是覆盖安装，否则下次拖进来会莫名其妙清数据。
   */
  updatePendingInstall: (patch: Partial<PendingInstall>) => void;

  /*
   * 在线更新（v1.0.22）：
   * updateAvailable 只表示「检查到有新版本」，用于侧栏红点与页面提示；
   * 真正的检查结果（版本、更新说明、包地址）由「关于」页自己按需拉取，不在这里复制一份。
   */
  updateAvailable: boolean;
  setUpdateAvailable: (v: boolean) => void;

  /*
   * 左下角「检测到新版本」小卡片要用的最小信息（v1.1.15）。
   *
   * 只存版本号 / 是否重要 / 更新说明 —— 包地址之类仍由设置页自己按需拉。
   * 整份 UpdateCheckResult 放进来会让侧栏的任何一次重渲染都拖着几十个字段跑。
   */
  updateInfo: UpdateTipInfo | null;
  setUpdateInfo: (v: UpdateTipInfo | null) => void;
  /**
   * 用户点过「取消」的那个版本号（v1.1.15）。
   *
   * 语义是「这个版本别再提醒我了」，不是「永远别提醒」—— 换了新版本还会再出来。
   * 落盘在 localStorage（不是 settings.json）：它只是一次界面取舍，
   * 不进主进程的设置模型；而且主进程那份设置要重启才刷新，这里不必绕一圈。
   */
  updateTipDismissed: string;
  dismissUpdateTip: (version: string) => void;

  /**
   * 「去设置页下载」的一次性交接条（v1.1.15）。
   *
   * 点左下角卡片的「更新」时置位，跳到设置页后由 UpdatePanel 消费：
   * 展开更新卡片 → 检查 → 直接开始下载。用 store 而不是路由 state，
   * 是因为这块是「跨页面的动作交接」，而且消费完要能可靠地清掉。
   */
  updateIntent: 'download' | null;
  setUpdateIntent: (v: 'download' | null) => void;

  /*
   * AI 崩溃分析（v1.1.14）。
   *
   * crashReports 只放**索引**（meta），报告正文按需从主进程取 ——
   * 一份报告可能几万字，全量塞进 store 会让侧栏的任何一次重渲染都变慢。
   *
   * 为什么未读数要单独存一个字段而不是每次 filter：
   *   侧栏的 NavLink 每次渲染都要读它，filter 一遍 200 条只是浪费；
   *   而且它是「红点要不要亮」的唯一依据，单独存更不容易算错。
   */
  crashReports: CrashReportMeta[];
  crashUnread: number;
  crashStatus: CrashWatchStatus | null;
  /**
   * 报告索引是否已经**从主进程取回来过一次**。
   *
   * 🔴 存在的唯一理由是给 AI 页面一个可靠的「可以决定默认停在哪个标签」的信号：
   *    未读数与界面配置都是启动后异步到位的，早了会读到 0（于是永远停在「对话」）；
   *    而如果拿 crashStatus / uiConf 之类去猜「另一个大概也到了」，耦合太脆。
   *    它一旦为 true 就不再变。
   */
  crashReady: boolean;
  setCrashReports: (list: CrashReportMeta[]) => void;
  /** 收到一份新报告（推送）：插到最前并把未读数 +1 */
  pushCrashReport: (r: CrashReportMeta) => void;
  /** 本地把某份报告标记为已读（主进程也会同步一份） */
  markCrashRead: (id: string) => void;
  setCrashStatus: (s: CrashWatchStatus | null) => void;
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
    // 'system'（只有老配置文件里才可能有）与任何未知值都按浅色处理
    const t: 'light' | 'dark' | 'genshin' | 'glass' =
      settings.theme === 'dark'
        ? 'dark'
        : settings.theme === 'genshin'
          ? 'genshin'
          : settings.theme === 'glass'
            ? 'glass'
            : 'light';
    if (get().theme !== t) {
      document.documentElement.setAttribute('data-theme', t);
      set({ theme: t });
    }
    /*
     * 透明玻璃主题：把落盘的两个参数写进 DOM，并让主进程切整窗 Acrylic。
     *
     * 🔴 这两件事必须在这里做（不能只在设置页做）：
     *    启动时 App 拉一次 settings 就会走到这里，用户上次选的玻璃主题
     *    要能「开箱即玻璃」；只在设置页做的话，别处切主题就漏了。
     * 🔴 主进程那份由 App.tsx 的 effect 统一同步（它还要处理启动首帧），
     *    这里只负责 DOM 变量。
     */
    const go = settings.glassOpacity ?? 20;
    const gr = settings.glassRoughness ?? 45;
    paintGlassVars(go, gr);
    if (get().glassOpacity !== go || get().glassRoughness !== gr) {
      set({ glassOpacity: go, glassRoughness: gr });
    }
    /*
     * 主题色同理：主进程持久化的那份才是真值。
     * 必须在这里同步，不能只在设置页挂载时读 —— 别处（比如顶栏切主题）会绕过设置页，
     * 那样换完主题回来主题色就丢了。老 settings.json 没有这个字段，回落默认值。
     */
    const a: AccentId = settings.accent || 'cangqiong';
    document.documentElement.setAttribute('data-accent', a);
    if (get().accent !== a) set({ accent: a });
    /*
     * 自定义主题色的色值（v1.1.14）。
     * 这里**只同步到 store**，不在这里动 DOM —— 派生值要按当前明暗重算，
     * 统一由 App.tsx 的一个 effect 负责（deps = accent / accentCustom / theme），
     * 否则「浅色下算一套、切深色不重算」就串色了。
     */
    const ac = settings.accentCustom || '';
    if (get().accentCustom !== ac) set({ accentCustom: ac });

    /*
     * 玻璃主题的底图模式与色系（v1.1.14）。
     * 色系走 <html data-glass-tint>（CSS 按它选变量块），所以必须在这里就写 ——
     * 启动时若用户上次选的是淡粉，界面第一帧就该是淡粉，不能等设置页。
     * settings.json 被手改成非法值时回落 blue / wallpaper。
     */
    const gb: GlassBackdropMode = settings.glassBackdrop === 'tint' ? 'tint' : 'wallpaper';
    const gt: GlassTintId = GLASS_TINTS.includes(settings.glassTint) ? settings.glassTint : 'blue';
    paintGlassTint(gt);
    if (get().glassBackdrop !== gb || get().glassTint !== gt) {
      set({ glassBackdrop: gb, glassTint: gt });
    }

    /*
     * 左侧功能栏的收起状态。
     *
     * 默认取主进程记住的那份（settings.json，老文件里没这个字段时
     * `!!undefined` 落到展开，正好是想要的默认值）。
     * 但 Conf 里 `rememberCollapsed: false` 时改用 Conf 的 `defaultCollapsed` ——
     * 那是「每次启动都回到固定形态、不记住手动切换」的语义。
     */
    const sidebarConf = get().uiConf.layout.sidebar;
    const collapsed = sidebarConf.rememberCollapsed
      ? !!settings.sidebarCollapsed
      : sidebarConf.defaultCollapsed;
    if (get().sidebarCollapsed !== collapsed) set({ sidebarCollapsed: collapsed });
  },

  /* ---------------- 界面配置（Conf） ---------------- */
  // 出厂默认的深拷贝：防止任何一处误改把「默认值」本身改掉（与 settings.ts 里
  // 对象字段都给新副本同一个理由）
  uiConf: cloneDefaultUiConf(),
  setUiConf: (uiConf) => set({ uiConf }),

  /* ---------------- 主题 ---------------- */
  theme: 'light',
  applyTheme: (theme) => {
    if (get().theme === theme) return;
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
    /*
     * 透明玻璃主题要动**窗口本身**（无边框形态 vs 系统 overlay 按钮），这只有主进程能做。
     * 所以切主题时顺带通知一声：进玻璃切到无边框形态，离开玻璃切回 overlay 形态。
     * ⚠️ frame / titleBarOverlay 都是建窗参数，运行期改不回去 ——
     *    跨形态时主进程会**按新形态重建主窗口**（保留位置与最大化状态），
     *    同形态内的主题切换不受影响（见 electron/main.ts 的 applyGlassWindow）。
     */
    void window.adbApi?.setGlass(theme === 'glass');
  },

  /* ---------------- 主题色 ---------------- */
  accent: 'cangqiong',
  applyAccent: (accent) => {
    if (get().accent === accent) return;
    document.documentElement.setAttribute('data-accent', accent);
    set({ accent });
    /*
     * ⚠️ 这里**不**处理自定义色值的写入 / 清除：
     *    'custom' 用的是内联变量，而内联值要按明暗（light/dark）各算一套。
     *    统一交给 App.tsx 那个 deps=[accent, accentCustom, theme] 的 effect，
     *    保证「切主题色」与「切浅深」走同一条路径，不会漏掉任何一种组合。
     */
  },

  /* ---------------- 自定义主题色 ---------------- */
  accentCustom: '',
  applyAccentCustom: (accentCustom) => {
    if (get().accentCustom === accentCustom) return;
    set({ accentCustom });
  },

  /* ---------------- 玻璃主题底图 ---------------- */
  glassBackdrop: 'wallpaper',
  glassTint: 'blue',
  glassWall: null,

  setGlassBackdrop: (glassBackdrop) => {
    if (get().glassBackdrop === glassBackdrop) return;
    /*
     * 切到「主题色」模式时**立刻把壁纸丢掉**（置 null）。
     * 这是「两种模式互斥」在状态层的落点：留着那张 data URL 的话，
     * 切回壁纸模式时可能先渲染一张过期壁纸再刷新，看起来像闪了一下；
     * 而且让「有壁纸 data URL」这件事与 mode 严格一一对应，读代码时不会有歧义。
     */
    set({ glassBackdrop, glassWall: glassBackdrop === 'tint' ? null : get().glassWall });
  },

  setGlassTint: (glassTint) => {
    if (get().glassTint === glassTint) return;
    paintGlassTint(glassTint);
    set({ glassTint });
  },

  loadGlassWall: async () => {
    try {
      /*
       * 🔴 返回的是 { ok, data, error } 信封（ipc.ts 的 wrap()），必须取 .data。
       *    漏了这层会拿到整个信封对象当 data URL 用（表现：url.slice is not a function）。
       */
      const res = await window.adbApi?.grabDesktop?.();
      const url = res && res.ok ? res.data : null;
      set({ glassWall: typeof url === 'string' && url ? url : null });
    } catch {
      /* 抓不到就保持 null：CSS 会退回纯色底，不影响使用 */
      set({ glassWall: null });
    }
  },

  /* ---------------- 透明玻璃参数 ---------------- */
  glassOpacity: 20,
  glassRoughness: 45,

  paintGlass: (opacity, roughness) => {
    paintGlassVars(opacity, roughness);
    set({ glassOpacity: opacity, glassRoughness: roughness });
  },

  setGlass: (opacity, roughness) => {
    paintGlassVars(opacity, roughness);
    set({ glassOpacity: opacity, glassRoughness: roughness });
  },

  /* ---------------- 左侧功能栏收起 ---------------- */
  sidebarCollapsed: false,
  setSidebarCollapsed: (sidebarCollapsed) => {
    if (get().sidebarCollapsed === sidebarCollapsed) return;
    set({ sidebarCollapsed });
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

  installSigning: { mode: 'bundled-debug' },
  setInstallSigning: (installSigning) => set({ installSigning }),

  dragActive: false,
  setDragActive: (dragActive) => {
    if (get().dragActive !== dragActive) set({ dragActive });
  },

  pendingInstall: null,
  setPendingInstall: (pendingInstall) => set({ pendingInstall }),
  updatePendingInstall: (patch) =>
    set((s) => (s.pendingInstall ? { pendingInstall: { ...s.pendingInstall, ...patch } } : {})),

  updateAvailable: false,
  setUpdateAvailable: (updateAvailable) => set({ updateAvailable }),

  updateInfo: null,
  setUpdateInfo: (updateInfo) => set({ updateInfo }),

  updateTipDismissed:
    (typeof localStorage !== 'undefined' && localStorage.getItem('adb-update-tip-dismissed')) || '',
  dismissUpdateTip: (version) => {
    try {
      localStorage.setItem('adb-update-tip-dismissed', version);
    } catch {
      /* 隐私模式等写不进去：本次会话内仍然生效，只是下次启动会再提醒一次 */
    }
    set({ updateTipDismissed: version });
  },

  updateIntent: null,
  setUpdateIntent: (updateIntent) => set({ updateIntent }),

  /* ---------------- AI 崩溃分析（v1.1.14） ---------------- */
  crashReports: [],
  crashUnread: 0,
  crashStatus: null,
  crashReady: false,

  setCrashReports: (list) =>
    set({
      crashReports: list,
      crashUnread: list.filter((r) => !r.read).length,
      crashReady: true,
    }),

  pushCrashReport: (r) =>
    set((s) => {
      // 同一份报告可能既被推送、又在随后的列表接口里回来一次：按 id 去重
      if (s.crashReports.some((x) => x.id === r.id)) return {};
      return {
        crashReports: [r, ...s.crashReports],
        crashUnread: s.crashUnread + (r.read ? 0 : 1),
      };
    }),

  markCrashRead: (id) =>
    set((s) => {
      let changed = false;
      const next = s.crashReports.map((r) => {
        if (r.id === id && !r.read) {
          changed = true;
          return { ...r, read: true };
        }
        return r;
      });
      if (!changed) return {};
      return { crashReports: next, crashUnread: Math.max(0, s.crashUnread - 1) };
    }),

  setCrashStatus: (crashStatus) => set({ crashStatus }),
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
