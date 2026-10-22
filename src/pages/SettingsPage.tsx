import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Button,
  Field,
  Input,
  Segmented,
  Slider,
  Switch,
  Progress,
  Notice,
  Badge,
  Spinner,
} from '@/components/ui';
import { useApp } from '@/store/app';
import { useFeature, usePanelOpen } from '@/lib/ui-conf';
import { call, tryCall } from '@/lib/ipc';
import { IPC } from '@shared/types';
import type {
  AccentId,
  EnvCheckResult,
  GlassBackdropMode,
  GlassTintId,
  UpdateCheckResult,
  UpdateContext,
  UpdateDownloadProgress,
  UpdateInfo,
} from '@shared/types';

/**
 * 主题色清单。
 *
 * ⚠️ 三处必须同步：这里（名称 + 取色）、`shared/types.ts` 的 `AccentId`、
 *    `src/styles/global.css` 里 `[data-accent]` 那两块变量（**浅色一条、深色一条**，
 *    只写浅色的话深色模式下会串色）。
 *
 * 每项只给**一个主色**（= 该主题的 --accent）。以前画的是「左窄条 + 右大块」两块色
 * （--bg-sidebar + --bg-app），想顺带预览侧栏/内容区那对底色；
 * 但两个色拼在一起反而不好认，看起来也乱 —— 只留主色。
 * 取的是 --accent 而不是底色：底色（侧栏灰 / 内容区近白）五个主题之间几乎看不出差别，
 * 深色下更是一排黑点，等于没预览。
 * 数组顺序 = 界面上的排列顺序，默认项（苍穹）刻意放在正中。
 */
const ACCENTS: {
  id: AccentId;
  name: string;
  light: string;
  dark: string;
}[] = [
  { id: 'cloud', name: '云灰', light: '#4b5563', dark: '#a3aebb' },
  { id: 'mist', name: '雾青', light: '#2e7c9c', dark: '#6fb0cf' },
  { id: 'cangqiong', name: '苍穹', light: '#3b6ae1', dark: '#6b8cf0' },
  { id: 'ocean', name: '远山', light: '#2a5cc4', dark: '#5b8bf0' },
  { id: 'ink', name: '墨玉', light: '#46566f', dark: '#8fa3c4' },
  /* v1.1.14：两组粉色系。淡粉偏冷、饱和度低；樱花偏暖、更艳一点 —— 并排能看出差别 */
  { id: 'blush', name: '淡粉', light: '#d4718f', dark: '#ef9ab4' },
  { id: 'sakura', name: '樱花', light: '#e2637f', dark: '#ee8496' },
];

/**
 * 自定义色（v1.1.14）。
 *
 * 界面上是色块列表末尾的一枚**彩虹色圆点**，点开才出现色盘 ——
 * 它不是「第 8 套配色」，而是「让你自己挑一个色值」，
 * 所以刻意和其它主题色长得不一样（渐变底 + 齿轮感的图标性）。
 *
 * 🔴 色值只有**一个**：整套界面的十几个变量由它现算（src/lib/accent-custom.ts）。
 *    默认值给一个粉红而不是纯红/纯蓝 —— 用户第一次点进来看到的是一个
 *    已经调好明度的成片观感，而不是一个需要自己摸索的空白。
 */
const CUSTOM_ACCENT_ID: AccentId = 'custom';
/** 第一次点「自定义」时先用这个色（之后一直用用户上次挑的） */
const CUSTOM_ACCENT_FALLBACK = '#e06b8b';
/**
 * 色盘里的常用色快选。
 * 不追求「覆盖所有色相」，而是给几个**一眼就能定下来的方向** ——
 * 有了它们，多数人不用去拖那个系统色盘。
 */
const CUSTOM_ACCENT_PRESETS = [
  '#e06b8b',
  '#e2637f',
  '#d4718f',
  '#3b6ae1',
  '#2e7c9c',
  '#5b8c5a',
  '#c08a2e',
  '#8a6bd1',
];

/**
 * 玻璃主题「主题色底图」的色系（v1.1.14）。
 *
 * 与上面的主题色**不是一回事**：这里的每一项决定的是**整窗底图**长什么样
 * （生成的低饱和渐变），同时顺带把主色换成同色系 —— 底色是淡粉、按钮还是蓝的，
 * 整屏就不是一套东西了。
 * 色值与渐变停靠色在 src/styles/theme-glass.css 的 [data-glass-tint] 块里。
 */
const GLASS_TINTS: { id: GlassTintId; name: string; swatch: string }[] = [
  { id: 'blue', name: '淡蓝', swatch: '#dce9fb' },
  { id: 'pink', name: '淡粉', swatch: '#fbe6ee' },
  { id: 'gray', name: '雅灰', swatch: '#e6e8ec' },
  { id: 'pearl', name: '珍珠白', swatch: '#f1eee9' },
];

/**
 * 玻璃主题的底图模式（v1.1.14）—— **互斥**，见 shared/types.ts 的 GlassBackdropMode。
 * 用分段控件而不是两个开关：两个开关会出现「都开 / 都关」这种没有意义的状态。
 */
const GLASS_BACKDROPS: { value: GlassBackdropMode; label: string }[] = [
  { value: 'wallpaper', label: '桌面壁纸' },
  { value: 'tint', label: '主题色' },
];

/**
 * 主题模式清单（v1.1.11 起三选一，同一级）。
 *
 * 「原神」和浅色/深色是**平级**的第三个选项，不是主题色、也不是浅/深的下级：
 * 它是一整套自成一体、且**没有深色变体**的视觉方案
 * （配色 + 描边 + 角饰 + 圆角尺度，见 shared/types.ts 的 ThemeId）。
 *
 * ⚠️ 主题自带固定配色（原神就是暖金），所以它生效时主题色那一行换成一句说明 ——
 *    不给入口，但要让用户知道为什么没有，否则会以为是坏了。
 *
 * ⚠️ 扩展位：加「崩铁」这类主题时，这里加一项 + 建一个 theme-<id>.css 即可。
 *
 * 「透明玻璃」（v1.1.13）和原神同类（都是自成一套的主题），但改造范围更大：
 * 它还要**窗口本身**透明无边框（主进程配合），并自带两个可调参数 ——
 * 见下面 theme === 'glass' 那两个滑杆。
 */
const THEME_MODES: { value: 'light' | 'dark' | 'genshin' | 'glass'; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'genshin', label: '原神' },
  { value: 'glass', label: '透明玻璃' },
];

/**
 * 每个版本的一句话更新说明，key 为 package.json 的完整版本号。
 *
 * 写法约定（2026-09-30 定）：**一句话说清改了什么**就行 ——
 * 「修复 xx」「新增 xx 模块 / 功能」。不写背景、不解释为什么、不对比旧方案，
 * 那些留在 commit message 里。界面上的更新说明只是给用户扫一眼的。
 *
 * ⚠️ 发版改 package.json version 时，这里同步加一条（漏加会回退到默认文案）。
 */
const VERSION_NOTES: Record<string, string> = {
  '1.1.16':
    '新增「记录窗口大小」：拖动改变窗口大小或位置后会自动记下，下次启动按上次的样子打开；最大化的状态也会记住，点还原能回到你上次调好的尺寸，不会弹回一整屏。设置页新增「窗口」卡片，可随时关掉这个记录，或一键恢复默认的 1280 × 860。',
  '1.1.15':
    '拖入安装包时，只有一台设备在线也会先让你确认覆盖 / 清洁 / 全新安装，不再默认静默覆盖安装。左下角新增「检测到新版本」提示，卡片上直接显示新版本号与更新内容（长说明按条列出、可在卡片里滚动看全），点「更新」直达设置页并自动开始下载；不在设置页时程序也会每 10 分钟自动检测一次（间隔可改，也可关）。实时 Logcat 切到其它模块再回来日志不再消失，新增「后台保持抓取」开关，日志列表改为只渲染可见行，设备刷屏时不再卡顿。AI 助手现在能自己动手查设备：提问后它会根据目标生成 adb 指令、程序自动执行并把返回结果交回对话，一轮轮查到你问的那个目标有结论为止（最多 6 轮），执行过程在对话里逐条显示、可随时点「停止」中断；卸载应用、清应用数据、刷机等破坏性命令会被拦下不执行，也可以关掉「执行 adb 指令」开关让它只回答问题。',
  '1.1.14':
    '新增「AI 助手」：模型接口写在程序目录的 Conf\\ai.json 里，DeepSeek / 通义千问 / Kimi / 智谱 GLM / OpenAI / Claude 已预填好地址与模型，填上自己的 Key 即可用，也能在页面里直接改；对话支持图片、文件与网页链接三种附件。设置页最后一行新增「检测崩溃自动AI分析日志」开关，开启后投屏中的前台应用一发生闪退就自动导出日志、把最近 10 分钟的日志与崩溃前的操作记录交给 AI 分析，并生成含崩溃时间、设备、崩溃前操作与原因分析的报告；侧栏 AI 入口亮红点提醒，报告页可一键定位到日志与报告所在的文件夹。新增淡粉、樱花两套主题色与自定义主题色（色盘自由选色，整套界面配色自动派生）；透明玻璃主题新增淡蓝 / 淡粉 / 雅灰 / 珍珠白四种主题色底图（低饱和柔光底，与桌面壁纸模式二选一互斥）；修复玻璃主题切回其它主题后右上角窗口按钮消失。',
  '1.1.13':
    '新增「玻璃」主题：整窗透明磨砂玻璃效果，透明度与模糊程度可在设置里调节；修复实时 Logcat 切换设备后「保存为文件」导出仍是旧设备日志的问题；投屏键盘输入改为 UHID 模式，数字、英文、中文输入法都能直接输入。',
  '1.1.12':
    '新增界面配置文件：程序目录下的 Conf 文件夹可直接调整左侧功能栏顺序、各功能块默认展开还是收起、以及单独开关某个功能入口，改完重启生效；在线更新不会覆盖你改过的配置，改坏了删掉对应文件即可恢复出厂。设置页底部的「打开配置文件夹」可直达该目录。',
  '1.1.11':
    '新增「原神」主题：米白底、深靛蓝卡片、淡金衬色的整体外观，主题配色固定不提供切换；该主题下左侧功能栏换成配套的金色标志与金色应用名。',
  '1.1.10':
    '内置 Java 运行环境：装好即可直接安装 AAB，不必再自己装 Java；顺带把设置页「开机自启动」标题的字号与其它卡片对齐。',
  '1.1.9':
    '新增「插入手机自动投屏」开关：开启后，插上曾在本机投屏成功过的 USB 真机就自动打开助手并开始投屏；开启期间关闭窗口改为最小化到托盘，默认关闭。',
  '1.1.8':
    '左侧功能栏支持收起与展开：收起后只显示各功能图标、鼠标悬停显示名称，展开后恢复，收起状态下次启动仍然保持；修复弹窗变暗时右上角窗口按钮区仍是一块亮色的问题。',
  '1.1.7':
    '设置页新增「开机自启动」开关，一行显示、改动立即生效；其余设置项默认折叠，只留标题与一句说明，点开与原来一致（「外观」「关于」两栏保持展开）。',
  '1.1.6':
    '新增「安装包管理」：指定目录按版本自动归类为官网包 / Google 包 / 单包，认不出类型的一律归单包并可在列表里手工改标签，筛选后直接安装、条件自动记住；修复快捷动作「指定包名」点不动且不生效；精简投屏页说明文案。',
  '1.1.5':
    '顶部标题栏压薄到 25px、去掉了穿过它的那条竖线；主题色色块改单色。',
  '1.1.4':
    '顶部标题栏改为独立的一档配色，五个主题自动适配；侧栏底部分割线两端留空，视觉更柔和。',
  '1.1.3':
    '修复任务栏与快捷方式图标四角出现白底；窗口标题栏改为跟随主题色；精简弱网与连点器页面说明。',
  '1.1.2':
    '新增 5 套主题色，界面配色可整体切换；设置页重排、卡片可折叠；设备详情改为屏幕分辨率与 CPU / GPU 型号；应用图标随版本自动更新；界面说明文案精简。',
  '1.1.1': '修复清洁安装在 OPPO / 一加 / realme 上失败；安装失败原因改为中文提示。',
  '1.1.0': '新增连点器屏幕预览图、拖拽安装到多台设备；日志按日期落盘。修复清数据报权限错误。',
  '1.0.33': '手机端录制改为电脑全程控制；修复录制坐标偏移与时间轴归零。',
  '1.0.32': '新增自动连点器，以及配套的手机端屏幕录制采集 App。',
  '1.0.31': '在线更新支持跨版本升级，中间漏更几版也能小包升上来。',
  '1.0.30': '修复启动弱网后立刻被判定成已停止；修复弱网生效时误报未授权 VPN。',
  '1.0.29': '弱网改用设备侧 VPN 实现，所有 App 的流量都被覆盖。',
  '1.0.28': '拖拽安装弹窗里可直接改安装方式，且只影响这一次。',
  '1.0.27': 'Logcat 导出目录固定为 D:\\adblogs，按机型与日期自动分层。',
  '1.0.26': '新增 Logcat 导出：直接导出设备已有的日志，不用先开抓取。',
  '1.0.25': '调整：全应用图标统一为一套细线图标，替换掉原先的 emoji。',
  '1.0.24': '新增设备行快捷动作（清数据 / 桌面重进 / 杀进程重进等 12 种）。',
  '1.0.23': '在线更新默认填好更新源，装上即用。',
  '1.0.22': '新增应用内增量更新：在线检查、下载、校验并更新。',
  '1.0.21': '修复拖放安装时正式签名不生效。',
  '1.0.20': '新增「导出通用 APK」：不需要设备，AAB 转成所有机型都能装的包。',
  '1.0.19': '调整：AAB 的拆包与安装分开，可仅拆包另存为 .apks。',
  '1.0.18': '新增 AAB 签名方式可选，并可一键计算各平台需要的 key hash。',
  '1.0.17': '新增 AAB 安装支持（按目标设备拆包后安装）。',
  '1.0.16': '本版无功能改动，为应用内增量更新的真机验证。',
  '1.0.15': '修复应用内更新失败后没有自动还原。',
  '1.0.13': '修复应用内更新启动了却什么都没发生。',
  '1.0.12': '本版无功能改动，为应用内增量更新的真机验证。',
  '1.0.11': '修复应用内增量更新在真机上完全走不通。',
  '1.0.7': '新增应用内增量更新：用小包替换文件并重启，失败自动回滚。',
  '1.0.6': '修复多台设备同时在线时装错机器。',
  '1.0.5': '新增安装方式选择（覆盖 / 清洁 / 全新），装完按包名复核。',
  '1.0.4': '新增拖放安装 APK，安装过程有实时进度。',
  '1.0.3': '新增设备行的「快速投屏」按钮。',
  '1.0.2': '新增常用应用收藏；弱网模拟改为免 Root 代理方案。修复弱网代理残留导致断网。',
  '1.0.1': '新增应用管理页常用应用收藏。',
  '1.0.0': '首个版本：设备管理、投屏、截图录屏、分辨率调节、Monkey、APK 安装、文件传输、命令终端、日志导出。',
};

export default function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const navigate = useNavigate();
  const [logDir, setLogDir] = useState('');

  /*
   * 界面配置（Conf）：设置页各卡片的默认展开态，以及三张可选卡片的显隐。
   * 出厂默认与这里原来写死的 defaultOpen 逐项一致，所以不配置时观感不变。
   */
  const appearanceOpen = usePanelOpen('settings', 'appearance');
  const aboutOpen = usePanelOpen('settings', 'about');
  const dirsOpen = usePanelOpen('settings', 'dirs');
  const logsOpen = usePanelOpen('settings', 'logs');
  const envOpen = usePanelOpen('settings', 'env');
  const autoMirrorOpen = usePanelOpen('settings', 'autoMirror');
  const autoMirrorOn = useFeature('settings', 'autoMirror');
  const envCheckOn = useFeature('settings', 'envCheck');
  const updateOn = useFeature('settings', 'update');

  /* 运行日志目录：只用于展示与「打开文件夹」（日志按日期落盘、只保留 24 小时） */
  useEffect(() => {
    void window.adbApi.logDir().then((r) => {
      if (r.ok && r.data) setLogDir(String(r.data));
    });
  }, []);
  const theme = useApp((s) => s.theme);
  const applyTheme = useApp((s) => s.applyTheme);
  const accent = useApp((s) => s.accent);
  const applyAccent = useApp((s) => s.applyAccent);
  /* 自定义主题色（v1.1.14）：色值与「界面上那份缓存」都在 store 里 */
  const accentCustom = useApp((s) => s.accentCustom);
  const applyAccentCustom = useApp((s) => s.applyAccentCustom);
  /* 透明玻璃主题的两个参数（v1.1.13）—— 拖动实时写 DOM，松手才落盘 */
  const glassOpacity = useApp((s) => s.glassOpacity);
  const glassRoughness = useApp((s) => s.glassRoughness);
  const paintGlass = useApp((s) => s.paintGlass);
  /* 玻璃主题的底图（v1.1.14）：壁纸 / 主题色，互斥 */
  const glassBackdrop = useApp((s) => s.glassBackdrop);
  const glassTint = useApp((s) => s.glassTint);
  const glassWall = useApp((s) => s.glassWall);
  const toast = useApp((s) => s.toast);

  const [env, setEnv] = useState<EnvCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  /*
   * 记录窗口大小（v1.1.16）。
   *
   * 界面这一侧**只读**：真正写盘在主进程（监听 resized / moved，见
   * electron/services/window-state.ts）。这里读一次是为了把「当前 1280 × 860」
   * 显示出来 —— 用户拖完窗口想知道记没记住，看一眼数字比拖回去重启一次快得多。
   */
  const windowOpen = usePanelOpen('settings', 'window');
  const [winState, setWinState] = useState<{
    current: { width: number; height: number; maximized: boolean } | null;
    saved: { x: number; y: number; width: number; height: number; maximized: boolean } | null;
  } | null>(null);
  const refreshWinState = async () => {
    const s = await tryCall(() => window.adbApi.winState());
    if (s) setWinState(s);
  };
  useEffect(() => {
    void refreshWinState();
  }, []);

  const checkEnv = async () => {
    setChecking(true);
    try {
      const r = await call<EnvCheckResult>(() => window.adbApi.checkEnv(), { silent: true });
      setEnv(r);
      if (r?.allOk) toast('success', '环境自检通过，所有组件就绪');
      else toast('warn', '部分组件缺失，请查看下方详情');
    } catch (e) {
      toast('error', '自检失败', (e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    checkEnv();
  }, []);

  const update = async (patch: Partial<NonNullable<typeof settings>>) => {
    const r = await call<any>(() => window.adbApi.setSettings(patch), { silent: true });
    if (r) {
      setSettings(r);
      toast('success', '设置已保存');
    }
  };

  const changeTheme = (t: 'light' | 'dark' | 'genshin' | 'glass') => {
    applyTheme(t);
    update({ theme: t });
  };

  /**
   * 恢复默认窗口尺寸（v1.1.16）。
   *
   * 主进程会退出最大化 → 居中 1280×860 → 把这份值写进记录。
   * 这里刷一次状态并提示，让用户看到数字真的变了（而不是只听见一句话）。
   */
  const resetWinSize = async () => {
    try {
      await call(() => window.adbApi.winResetSize());
      await refreshWinState();
      toast('success', '窗口已恢复默认尺寸');
    } catch (e) {
      toast('error', '恢复默认尺寸失败', (e as Error).message);
    }
  };

  /*
   * 玻璃主题的两个参数（v1.1.13）。
   *
   * 两条路分开（见 ui.tsx 的 Slider 注释）：
   *   · 拖动中 onInput → paintGlass：只写 DOM 变量，画面立刻跟手，不落盘；
   *   · 松手 onCommit → setGlass + update：写 DOM 的同时把值存进 settings.json。
   * 拖动时每像素都落盘会同步刷爆磁盘（settings 那条是同步 IPC），必须分开。
   */
  const onGlassInput = (opacity: number, roughness: number) => {
    paintGlass(opacity, roughness);
  };

  const commitGlass = (opacity: number, roughness: number) => {
    update({ glassOpacity: opacity, glassRoughness: roughness });
  };

  const changeAccent = (a: AccentId) => {
    // 先落 DOM 再落盘：画面上立刻变，主进程那份最终由 setSettings 回来的结果校准
    applyAccent(a);
    update({ accent: a });
  };

  /*
   * 自定义主题色（v1.1.14）。
   *
   * 🔴 落盘要**防抖**：系统色盘在拖动过程中会连续触发 input（每个色相档一次），
   *    而保存设置是同步 IPC + 整文件重写 —— 不防抖的话拖一次色盘要写几十次磁盘。
   *    所以：改色立刻写 DOM（画面跟手），400ms 内不再动才落盘。
   *    浅/深两套派生值由 App 的 effect 按当前主题重算，这里只管色值本身。
   */
  const persistTimer = useRef<number | null>(null);
  const clearPersistTimer = () => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
  };
  /* 组件卸载时把挂着的落盘取消掉，避免在已卸载的组件上 setSettings */
  useEffect(() => clearPersistTimer, []);

  const setCustomAccent = (hex: string) => {
    applyAccentCustom(hex);
    // 色值变了才需要重挂 data-accent（'custom' 是它自己的值，重复设也无害）
    if (accent !== CUSTOM_ACCENT_ID) applyAccent(CUSTOM_ACCENT_ID);
    clearPersistTimer();
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      update({ accent: CUSTOM_ACCENT_ID, accentCustom: hex });
    }, 400);
  };

  /** 点「自定义」色块：还没挑过色就先给一个默认色，色盘才不会一进来是黑的 */
  const openCustomAccent = () => {
    if (!accentCustom) {
      setCustomAccent(CUSTOM_ACCENT_FALLBACK);
      return;
    }
    changeAccent(CUSTOM_ACCENT_ID);
  };

  const reloadGlassWallpaper = async () => {
    toast('info', '正在读取桌面壁纸…');
    await useApp.getState().loadGlassWall();
    if (useApp.getState().glassWall) toast('success', '已按当前桌面壁纸更新底图');
    else toast('warn', '没读到桌面壁纸', '可能壁纸被系统加密或路径变了，底图会退回纯色');
  };

  /*
   * 玻璃底图模式切换（v1.1.14）——**互斥**的那一步就发生在这里。
   *
   * 切到壁纸模式时**顺手补一次抓取**：从主题色模式切回来时 store 里的
   * glassWall 是 null（切走时被清掉了），不补的话底图会空白一块，
   * 得等 App 的 effect 再跑一轮 —— 而那个 effect 的依赖里就有 glassBackdrop，
   * 所以其实也会自己跑；这里显式补一次是为了让「刚切过去就有图」这件事
   * 不依赖 effect 的执行顺序（观感上更干脆）。
   */
  const changeGlassBackdrop = (mode: GlassBackdropMode) => {
    if (mode === glassBackdrop) return;
    useApp.getState().setGlassBackdrop(mode);
    void update({ glassBackdrop: mode });
    if (mode === 'wallpaper' && !useApp.getState().glassWall) {
      void useApp.getState().loadGlassWall();
    }
  };

  /** 换玻璃底图的色系（只改 <html data-glass-tint>，由 store 负责写） */
  const changeGlassTint = (t: GlassTintId) => {
    if (glassTint === t) return;
    useApp.getState().setGlassTint(t);
    void update({ glassTint: t });
  };

  const pickDir = async (key: 'screenshotDir' | 'recordDir' | 'pullDir') => {
    const dir = await call<string | null>(() => window.adbApi.pickDir(), { silent: true });
    if (dir) update({ [key]: dir });
  };

  if (!settings) {
    return (
      <Card title="设置">
        <Spinner size={20} />
      </Card>
    );
  }

  /* 老版本 settings.json 里没有这个字段，运行期兜一层，避免白屏 */
  const mirroredCount = settings.mirroredSerials?.length ?? 0;

  return (
    <>
      {/*
        设置页的卡片默认折叠，只留标题 + 一句说明；想改哪一项再展开 —— 设置项本身不多，
        但都摊开时整页要滚很久，找东西反而慢。
        **前两栏（外观 / 关于）例外，默认展开**：主题是最常改的一项，版本信息也常要一眼看到。
        折叠只是视觉收起（body 仍在 DOM 里），所以自检、检查更新那几处副作用照常跑。
      */}
      <Card
        collapsible
        defaultOpen={appearanceOpen}
        title="外观"
        subtitle="主题模式、主题色与底图"
      >
        <Field label="主题模式">
          <Segmented
            value={theme}
            onChange={(v) => changeTheme(v as 'light' | 'dark' | 'genshin' | 'glass')}
            options={THEME_MODES}
          />
        </Field>

        {/*
          主题色 / 底图那一块，按主题分三种形态（v1.1.14 起）：
          · 原神        → 配色是它世界观的一部分（暖金），不提供切换，只留一句交代；
          · 透明玻璃    → 「底图模式（壁纸 / 主题色）」+ 色系选择，两者**互斥**；
          · 浅色 / 深色 → 主题色（7 套 + 自定义色盘）。
        */}
        {theme === 'genshin' ? (
          <div className="field accent-field">
            <span className="field-label">主题色</span>
            <div className="text-dim">原神主题使用固定配色（米白 / 淡金），不提供主题色切换</div>
          </div>
        ) : theme === 'glass' ? (
          /*
            透明玻璃主题的底图（v1.1.14 重构）。
            原方案是「固定配色（白色磨砂 + 蓝）」+ 一句说明；现在改成可选：
            底图模式二选一（互斥），主题色模式下再挑色系。
          */
          <>
            <Field label="底图模式" hint="两者互斥，一次只能用一种">
              <Segmented
                value={glassBackdrop}
                onChange={(v) => changeGlassBackdrop(v as GlassBackdropMode)}
                options={GLASS_BACKDROPS}
              />
            </Field>

            <div className="field accent-field">
              <span className="field-label">主题色</span>
              <div className="accent-picker">
                {GLASS_TINTS.map((t) => {
                  const usable = glassBackdrop === 'tint';
                  const active = usable && glassTint === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`accent-chip${active ? ' active' : ''}`}
                      data-glass-tint-id={t.id}
                      aria-pressed={active}
                      disabled={!usable}
                      title={
                        usable
                          ? `${t.name}底图`
                          : `当前是桌面壁纸模式，先切到「主题色」才能选色系`
                      }
                      onClick={() => changeGlassTint(t.id)}
                    >
                      <span
                        className="accent-swatch"
                        style={{ '--swatch': t.swatch } as CSSProperties}
                      />
                      <span className="accent-name">{t.name}</span>
                    </button>
                  );
                })}
              </div>
              {/*
                这段提示是「互斥」这件事在界面上的落点：
                选中一种模式后，另一种就是**不可用**状态，而不是「两个都能开」。
                不把话说出来的话，用户会以为色系旁边少了什么开关。
              */}
              <div className="text-dim accent-note">
                {glassBackdrop === 'tint'
                  ? '底图按所选色系自动生成（低饱和柔和渐变），桌面壁纸已停用。需要用壁纸请先把上面的「底图模式」切回「桌面壁纸」。'
                  : '当前用你电脑的桌面壁纸当底图。想换成主题色底图，先把上面的「底图模式」切到「主题色」。'}
              </div>
            </div>

            {glassBackdrop === 'wallpaper' && (
              <div className="field accent-field">
                <span className="field-label">壁纸来源</span>
                <div className="row row-wrap">
                  <span className="text-dim">
                    {glassWall ? '已读取到当前桌面壁纸' : '尚未读取到（底图会退回纯色）'}
                  </span>
                  <Button size="sm" variant="default" onClick={reloadGlassWallpaper}>
                    重新读取桌面壁纸
                  </Button>
                </div>
                <div className="text-dim accent-note">
                  壁纸在启动时读取一次；换了桌面壁纸后点上面这个按钮即可立刻更新。
                </div>
              </div>
            )}
          </>
        ) : (
          /*
            浅色 / 深色：主题色一行（色块 = 该主题的主色）+ 自定义色盘。
            故意不用 <Field>（它渲染的是 <label>）—— 里面放 <button> 会让点击被 label
            再触发一次，所以这里手写同样的 .field / .field-label 结构。
          */
          <>
            <div className="field accent-field">
              <span className="field-label">主题色</span>
              <div className="accent-picker">
                {ACCENTS.map((a) => {
                  const color = theme === 'dark' ? a.dark : a.light;
                  const active = accent === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={`accent-chip${active ? ' active' : ''}`}
                      data-accent-id={a.id}
                      aria-pressed={active}
                      title={a.name}
                      onClick={() => changeAccent(a.id)}
                    >
                      <span
                        className="accent-swatch"
                        style={{ '--swatch': color } as CSSProperties}
                      />
                      <span className="accent-name">{a.name}</span>
                    </button>
                  );
                })}

                {/*
                  自定义色（v1.1.14）：刻意和上面几枚长得不一样 ——
                  彩虹渐变底 + 加号，一眼能认出「这不是一套现成配色，是自己调」。
                */}
                <button
                  type="button"
                  className={`accent-chip${accent === CUSTOM_ACCENT_ID ? ' active' : ''}`}
                  data-accent-id="custom"
                  aria-pressed={accent === CUSTOM_ACCENT_ID}
                  title="自定义颜色"
                  onClick={openCustomAccent}
                >
                  <span className="accent-swatch accent-swatch-custom" />
                  <span className="accent-name">自定义</span>
                </button>
              </div>

              {/*
                色盘只在「自定义」被选中时展开。
                🔴 用原生 <input type="color">，不自己画色盘：
                  它是系统色盘（Windows 上是那个完整的颜色选择器，带取色器 /
                  色相环 / RGB / HEX），自己画一个既费事又做不到那么好用。
              */}
              {accent === CUSTOM_ACCENT_ID && (
                <div className="custom-accent">
                  <div className="custom-accent-line">
                    <input
                      type="color"
                      className="custom-accent-input"
                      aria-label="自定义主题色"
                      value={/^#[0-9a-fA-F]{6}$/.test(accentCustom) ? accentCustom : CUSTOM_ACCENT_FALLBACK}
                      onChange={(e) => setCustomAccent(e.target.value.toLowerCase())}
                    />
                    <span className="mono custom-accent-hex">
                      {/^#[0-9a-fA-F]{6}$/.test(accentCustom)
                        ? accentCustom.toLowerCase()
                        : CUSTOM_ACCENT_FALLBACK}
                    </span>
                    <span className="text-dim custom-accent-tip">
                      点左侧色块打开色盘，拖动时界面实时跟随
                    </span>
                  </div>

                  <div className="custom-accent-presets">
                    {CUSTOM_ACCENT_PRESETS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`custom-accent-dot${
                          accentCustom.toLowerCase() === c ? ' active' : ''
                        }`}
                        style={{ '--swatch': c } as CSSProperties}
                        title={c}
                        onClick={() => setCustomAccent(c)}
                      />
                    ))}
                  </div>

                  <div className="text-dim accent-note">
                    只挑一个颜色，整套界面的底色、边框、按钮会按它自动派生
                    （背景往灰里压、按钮的明度也会校正，避免挑到接近纯白或纯黑时看不清）。
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/*
          透明玻璃的两个专属参数（v1.1.13）。
          只在选中玻璃主题时出现 —— 它们改的是玻璃那层皮的质感，
          其余主题下没有对象可调。
        */}
        {theme === 'glass' && (
          <div className="glass-tune">
            <Field label="不透明度" hint="数值越小越通透，越大越实">
              <Slider
                value={glassOpacity}
                onInput={(v) => onGlassInput(v, glassRoughness)}
                onCommit={(v) => commitGlass(v, glassRoughness)}
              />
            </Field>

            <Field label="模糊程度" hint="数值越大底图磨得越糊（只剩色块）；0 为不模糊">
              <Slider
                value={glassRoughness}
                onInput={(v) => onGlassInput(glassOpacity, v)}
                onCommit={(v) => commitGlass(glassOpacity, v)}
              />
            </Field>

            {/*
              一句必要的提醒：这里说的是**两个滑杆的关系**。
              不写清楚的话，用户在浅色底图上把模糊拉满却觉得「本来就挺清楚」，
              会以为滑杆坏了。
              ⚠️ 别写「桌面那层磨砂由系统提供，需要 Win10 1809+」——
                 那是 v1.1.13 之前走系统 Acrylic 时代的说法，现在是「模拟玻璃」：
                 底图由程序自己铺（壁纸文件或现画的渐变），模糊由 CSS backdrop-filter
                 做，跟系统版本无关（Win10 也能用）。
            */}
            <div className="text-dim glass-tune-hint">
              模糊程度决定「看得见多少细节」：45 左右底图只剩柔和的色块（默认）；
              调到 20 以下会重新认出图标和文字轮廓；拉到 0 则完全清晰。
              两个滑杆对「桌面壁纸」与「主题色」两种底图都生效。
            </div>
          </div>
        )}

      </Card>

      {/*
        记录窗口大小（v1.1.16）。
        放在「外观」后面：它同样是「界面长什么样」这一类偏好，紧挨着最自然。
        默认收起（见 Conf/panels.json 的 settings.window）—— 基本是一次性设置，
        调好就不会再动，不该占主流程的位置。

        🔴 这里**不负责写盘**：拖动窗口时主进程自己记（resized / moved + debounce），
           本卡片只做两件事 —— 显示当前尺寸、提供一个回到出厂的按钮。
      */}
      <Card
        title="窗口"
        subtitle="记住窗口大小和位置，下次打开还是这个样子"
        collapsible
        defaultOpen={windowOpen}
      >
        <div className="setting-line">
          <span className="setting-line-label">记住窗口大小和位置</span>
          <span className="spacer" />
          <Switch
            checked={!!settings.rememberWindowBounds}
            onChange={(v) => update({ rememberWindowBounds: v })}
            aria-label="记住窗口大小和位置"
          />
        </div>

        <div className="setting-line">
          <span className="setting-line-label">当前窗口</span>
          <span className="spacer" />
          <span className="text-dim" data-win-size="1">
            {winState?.current
              ? `${winState.current.width} × ${winState.current.height}${
                  winState.current.maximized ? '（最大化）' : ''
                }`
              : '读取中…'}
          </span>
          <Button size="sm" variant="default" onClick={resetWinSize} data-win-reset="1">
            恢复默认尺寸
          </Button>
        </div>

        <p className="setting-note">
          拖过窗口边缘后会自动记下大小和位置，下次启动按这个样子打开（最大化状态也会记住，
          点还原能回到你上次调好的尺寸）。这里的数字是界面逻辑像素，不受系统缩放影响。
          关掉开关后下次启动回到默认的 1280 × 860 居中，但已记下的尺寸会保留 ——
          重新打开开关就能回到原来的样子。
        </p>
      </Card>

      <Card
        title="关于"
        subtitle="程序信息与当前版本的更新说明"
        collapsible
        defaultOpen={aboutOpen}
      >
        <div className="kv-list">
          <About k="程序名称" v="ADB 桌面助手" />
          <About k="版本" v={`v${__APP_VERSION__}`} />
          <About k="UI 技术栈" v="Electron + React 18 + TypeScript" />
          <About k="投屏引擎" v="scrcpy 3.1" />
          <About k="设备通信" v="Android Platform-Tools (adb)" />
        </div>
        <Notice tone="accent">
          {VERSION_NOTES[__APP_VERSION__] ??
            '更多高级功能将在后续版本加入。'}
        </Notice>
      </Card>

      <Card
        title="默认保存目录"
        subtitle="截图、录屏、日志导出与文件拉取的默认位置"
        collapsible
        defaultOpen={dirsOpen}
      >
        <div className="col">
          <DirRow
            label="截图保存目录"
            value={settings.screenshotDir}
            onPick={() => pickDir('screenshotDir')}
          />
          <DirRow
            label="录屏保存目录"
            value={settings.recordDir}
            onPick={() => pickDir('recordDir')}
          />
          <DirRow
            label="文件拉取目录"
            value={settings.pullDir}
            onPick={() => pickDir('pullDir')}
          />
        </div>
      </Card>

      {/* 「软件更新」可用 Conf/features.json 的 settings.update 整块关掉 */}
      {updateOn && <UpdatePanel />}

      <Card
        title="运行日志"
        subtitle="操作记录按日期存成本地文件，只保留最近 24 小时"
        collapsible
        defaultOpen={logsOpen}
      >
        <div className="col">
          <div className="kv-list">
            <About k="存放位置" v={logDir || '读取中…'} />
            <About k="保留时长" v="24 小时（启动时自动清理过期日志）" />
          </div>
          <div className="row">
            <Button variant="default" onClick={() => navigate('/logs')}>
              查看运行日志
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (logDir) void window.adbApi.openPath(logDir);
              }}
            >
              打开日志文件夹
            </Button>
          </div>
        </div>
      </Card>

      {/* 环境自检：默认收起 —— 只有出问题时才需要展开看详情（可用 settings.envCheck 整块关掉） */}
      {envCheckOn && (
        <Card
          title="环境自检"
          subtitle="检查 adb、scrcpy 等组件是否完整"
          collapsible
          defaultOpen={envOpen}
        extra={
          <Button size="sm" variant="default" onClick={checkEnv} loading={checking}>
            重新检测
          </Button>
        }
      >
        {!env ? (
          <div className="row">
            <Spinner />
            <span className="text-dim">正在检测…</span>
          </div>
        ) : (
          <div className="col">
            <div className="env-list">
              {env.items.map((it) => (
                <div key={it.name} className="env-row">
                  <span className={`env-dot ${it.ok ? 'ok' : 'bad'}`} />
                  <span className="env-name mono">{it.name}</span>
                  <span className="env-ver text-dim">
                    {it.version ? `v${it.version}` : it.ok ? '已就绪' : it.message || '缺失'}
                  </span>
                  {it.ok ? (
                    <Badge tone="success">正常</Badge>
                  ) : (
                    <Badge tone="danger">异常</Badge>
                  )}
                </div>
              ))}
            </div>

            {!env.allOk && (
              <Notice tone="danger">
                部分组件缺失会导致对应功能不可用。请确认程序的 <span className="mono">bin</span>{' '}
                目录中包含完整的 adb 与 scrcpy 文件。
              </Notice>
            )}
          </div>
        )}
        </Card>
      )}

      {/*
        开机自启动（v1.1.7）：所有设置项的最下方。
        刻意跟其它项区分 —— 别的都是「标题 + 说明 + 控件」两行，这里**只有一行**：
        左边名称、右边开关。所以**不传 title**（Card 无 title 时不渲染标题行），
        整张卡片就这一条内容，不重复、不啰嗦。
        也不折叠：开关藏起来就没意义了。
      */}
      <Card>
        <div className="setting-line">
          {/* 这张卡片没有 title，这个标签本身就充当卡片标题 —— 用 setting-line-title
              对齐 .card-title（14px/600），否则和上面几张卡片的标题对不齐、看着别扭。
              注意别改 .setting-line-label 本身：「启用」是普通设置项标签，不该跟着变粗。 */}
          <span className="setting-line-label setting-line-title">开机自启动</span>
          <span className="spacer" />
          <Switch
            checked={!!settings.autoLaunch}
            onChange={(v) => update({ autoLaunch: v })}
            aria-label="开机自启动"
          />
        </div>
      </Card>

      {/*
        插入自动投屏（v1.1.9）。
        和上面的「开机自启动」是同一类东西（都在改变程序自身的运行方式），所以紧挨着放。
        这一张**需要解释**：三重门槛（USB 真机 / 已授权 / 曾投屏成功过）和一个副作用
        （关窗改为最小化到托盘）都不是一个开关名字能装下的 —— 所以默认展开把话说清楚，
        但允许用户通过 Conf 把它收起（真正想做的是「整个入口藏掉」，见 features 的
        settings.autoMirror）。
      */}
      {autoMirrorOn && (
        <Card
          collapsible
          defaultOpen={autoMirrorOpen}
          title="插入手机自动投屏"
          subtitle="插上 USB 就自动打开助手并投屏"
        >
        <div className="setting-line">
          <span className="setting-line-label">启用</span>
          <span className="spacer" />
          {mirroredCount > 0 && (
            <button
              type="button"
              className="setting-link"
              title="清空后，各设备都需要再手动投屏成功一次才会被自动投屏"
              onClick={() => update({ mirroredSerials: [] })}
            >
              清除已记录设备（{mirroredCount}）
            </button>
          )}
          <Switch
            checked={!!settings.autoMirrorOnConnect}
            onChange={(v) => update({ autoMirrorOnConnect: v })}
            aria-label="插入手机自动投屏"
          />
        </div>
        <p className="setting-note">
          只对同时满足三条的设备生效：USB 连接的真机、已授权、且曾在本机手动投屏成功过。
          {mirroredCount > 0
            ? `当前已记录 ${mirroredCount} 台。`
            : '目前还没记录到设备 —— 先手动投屏成功一次，那台设备才会进入自动投屏范围。'}{' '}
          开启后关闭窗口会改为最小化到托盘（否则程序退出后没人监听插入），双击托盘图标可重新打开。
        </p>
        </Card>
      )}

      {/*
        界面配置入口（v1.1.12）。
        所有设置项的最下方、独立成一行：配置文件是给愿意动手的人用的，
        不占主流程的注意力，所以既不放「外观」卡片里、也不加说明文字 ——
        留一个按钮，谁需要谁认得出来。
        与上面的「开机自启动」同一种形态：Card 不传 title，整张卡片只有一行内容。
      */}
      <Card>
        <div className="setting-line">
          <span className="setting-line-label setting-line-title">界面配置</span>
          <span className="spacer" />
          <Button
            size="sm"
            variant="default"
            onClick={async () => {
              const r = await window.adbApi.uiConfDir();
              if (r.ok && r.data) void window.adbApi.openPath(String(r.data));
            }}
          >
            打开配置文件夹
          </Button>
        </div>
      </Card>

      {/*
        检测崩溃自动 AI 分析日志（v1.1.14）。
        需求明确要求它是**设置页的最后一行**、且**只有开关、不写说明**，
        所以形态和上面「开机自启动」完全一致：Card 不传 title、整张卡片一行。
        别顺手补 setting-note —— 开关打开后什么行为，写在 AI 页面顶部的状态条里。

        开关本身只写 settings.crashAutoAnalyze；监听器的启停由主进程的
        syncCrashWatch() 跟着这个值走（设置变更钩子在 electron/main.ts）。
      */}
      <Card>
        <div className="setting-line">
          <span className="setting-line-label setting-line-title">检测崩溃自动AI分析日志</span>
          <span className="spacer" />
          <Switch
            checked={!!settings.crashAutoAnalyze}
            onChange={(v) => update({ crashAutoAnalyze: v })}
            aria-label="检测崩溃自动AI分析日志"
          />
        </div>
      </Card>
    </>
  );
}

/**
 * 软件更新面板。
 *
 * 更新这件事的代价很高（装坏了就打不开），所以这里的原则是「拿不准就不做」：
 * 任何一项校验不过，都只提示改用完整安装包，绝不硬来。校验在主进程做
 * （electron/services/update-core.ts），这里只负责展示与确认。
 *
 * v1.0.22 起多了「在线更新」这条入口（检查更新 → 下载 → 复用同一套校验与替换）。
 * 两条入口的关系要摆清楚：
 *   · 在线更新是**主路径**，但它依赖服务器 —— 服务器没就绪时「更新源未配置」是正常状态；
 *   · 「选择更新包…」是**兜底路径**，断网、内网隔离、临时内测包全靠它，永远保留。
 */
const KIND_LABEL: Record<string, string> = {
  asar: '安装版（增量更新）',
  portable: '便携版（整包替换）',
  dev: '开发模式（未打包）',
};

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * 检查更新的六种状态。注意「未配置」不是错误 —— 服务器还没上线时它才是常态，
 * 界面按灰字提示处理，不弹错、不飘红。
 */
type CheckState = 'idle' | 'checking' | 'unconfigured' | 'error' | 'latest' | 'available';

function UpdatePanel() {
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const setUpdateAvailable = useApp((s) => s.setUpdateAvailable);

  /*
   * 这张卡片的展开态是**受控**的（下面 ensureOpen 要在点「下载并更新」后自己摊开），
   * 所以不能只靠 Card 的 defaultOpen —— 把 Conf 里的默认值喂给受控状态，
   * 并在配置异步到位时同步一次（见下面 useState 之后那个 effect）。
   */
  const updatePanelDefaultOpen = usePanelOpen('settings', 'update');

  const [ctx, setCtx] = useState<UpdateContext | null>(null);
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState<'' | 'prepare' | 'download' | 'go'>('');
  const [confirming, setConfirming] = useState<null | 'apply' | 'rollback'>(null);
  const [dl, setDl] = useState<UpdateDownloadProgress | null>(null);
  /*
   * 卡片开合由这里托管（Card 的受控模式）：默认收起。
   * 收起态里能点的按钮（「下载并更新」）点下去之后，进度条、确认框、「立即更新并重启」
   * 全在收起区里 —— 用户看到的就是「点了没反应」。所以凡是会引出后续步骤的动作，
   * 先 ensureOpen() 把卡片摊开（见 download / 收起态里的「立即更新并重启」）。
   */
  const [panelOpen, setPanelOpen] = useState(() => updatePanelDefaultOpen);
  /* Conf 是启动后异步到位的：到齐时把受控展开态对齐到配置里的默认值 */
  useEffect(() => {
    setPanelOpen(updatePanelDefaultOpen);
  }, [updatePanelDefaultOpen]);
  const ensureOpen = () => setPanelOpen(true);

  /*
   * 左下角「更新」按钮交过来的动作（v1.1.15，见 components/layout.tsx 的 UpdateTip）。
   * 置位后本面板要做三件事：展开 → 滚到视野里 → 检查并直接开始下载。
   */
  const updateIntent = useApp((s) => s.updateIntent);
  const setUpdateIntent = useApp((s) => s.setUpdateIntent);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * 检查间隔的输入草稿（v1.1.15）。
   *
   * 不能直接绑到 settings.updateCheckIntervalMin 上：用户清空输入框准备重打时，
   * 值会先变成空/0，那一瞬间落盘等于把轮询关掉。所以打字只改草稿，
   * 失焦（onBlur）才写回设置。
   */
  const [intervalDraft, setIntervalDraft] = useState(settings?.updateCheckIntervalMin ?? 10);
  useEffect(() => {
    setIntervalDraft(settings?.updateCheckIntervalMin ?? 10);
  }, [settings?.updateCheckIntervalMin]);

  /** 就地改一条设置并同步本地副本（UpdatePanel 拿不到父组件的 update） */
  const patchSettings = async (patch: Record<string, unknown>) => {
    const r = await call<NonNullable<typeof settings>>(() => window.adbApi.setSettings(patch), {
      silent: true,
    });
    if (r) setSettings(r);
  };

  const refresh = async () => {
    const r = await call<UpdateContext>(() => window.adbApi.updateContext(), { silent: true });
    setCtx(r ?? null);
  };

  useEffect(() => {
    void refresh();
    /*
     * 进页面先拿一次结果：主进程有 5 分钟缓存，启动时的静默自检若已跑过就立即返回；
     * 没缓存也只是发一次请求（更新源没配时主进程直接返回，不发网络请求）。
     * 这一次 silent —— 失败原因就摆在面板里，不用弹窗再打扰一遍。
     */
    void runCheck(false, true);

    // 下载进度（主进程推送）
    const off = window.adbApi.on(IPC.PUSH_UPDATE_DOWNLOAD, (p: UpdateDownloadProgress) => setDl(p));
    return () => off();
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = async (force: boolean, silent = false): Promise<UpdateCheckResult | null> => {
    setChecking(true);
    if (!silent) setConfirming(null);
    try {
      const r = await window.adbApi.checkUpdate(force);
      const res = (r?.data ?? null) as UpdateCheckResult | null;
      setCheck(res);
      if (!res) {
        if (!silent) toast('warn', '检查更新失败', r?.error);
        return null;
      }
      // 侧栏红点跟着结果走
      setUpdateAvailable(!!(res.ok && res.hasUpdate));
      /*
       * 左下角那张「检测到新版本」卡片要版本号，一并写进 store。
       * 查成功且没有新版时把它清掉，否则卡片会一直挂着一个过期的版本号。
       */
      if (res.ok && res.hasUpdate && res.latest?.version) {
        useApp.getState().setUpdateInfo({
          version: res.latest.version,
          critical: res.latest.critical,
          // 左下角那张卡片现在也要把更新内容摊出来，所以 notes 一并带过去
          notes: res.latest.notes,
        });
      } else if (res.ok && !res.hasUpdate) {
        useApp.getState().setUpdateInfo(null);
      }
      /*
       * 主进程会把这次检查时间写进设置（lastCheckAt），但渲染层的 settings 是启动时
       * 读的那一份副本 —— 不同步的话界面上「最近检查」会一直停在旧值。
       */
      void window.adbApi.getSettings().then((s2) => {
        if (s2?.ok && s2.data) setSettings(s2.data);
      });
      if (silent) return res;
      if (!res.configured) toast('info', '还没有配置更新源', res.reason);
      else if (!res.ok) toast('warn', '检查更新失败', res.reason);
      else if (res.hasUpdate) toast('success', `发现新版本 v${res.latest?.version ?? ''}`, res.reason);
      else toast('success', '已是最新版本', `当前 v${res.currentVersion}`);
      return res;
    } finally {
      setChecking(false);
    }
  };

  /**
   * 在线下载（下载完的校验与替换，跟「选择更新包…」走同一条链路）。
   *
   * 参数可以显式传入：从「左下角卡片」那条路进来时，检查结果刚拿到手、还没落进
   * `check` state（setState 是异步的），闭包里读 check 会读到上一轮的值。
   */
  const download = async (explicitPkg?: { url: string; sha256?: string }) => {
    const pkg = explicitPkg ?? check?.latest?.pkg;
    if (!pkg) return;
    // 收起态点进来的：先把卡片摊开，进度与后续步骤才看得见
    ensureOpen();
    setBusy('download');
    setDl(null);
    setConfirming(null);
    try {
      const r = await window.adbApi.downloadUpdate(pkg.url, pkg.sha256);
      if (!r?.ok) {
        toast('error', '下载更新包失败', r?.error);
        return;
      }
      const res = r.data as UpdateInfo;
      setInfo(res);
      if (res.ok) {
        toast(
          'success',
          `更新包已就绪：v${ctx?.version} → v${res.manifest?.version}`,
          res.warning,
        );
      } else {
        toast('warn', '下载到的更新包不能用', res.reason);
      }
    } catch (e) {
      toast('error', '下载更新包失败', (e as Error).message);
    } finally {
      setBusy('');
      setDl(null);
    }
  };

  const cancelDownload = async () => {
    await window.adbApi.cancelUpdateDownload();
    toast('info', '已取消下载');
  };

  /*
   * 「左下角卡片 → 更新」这条路的落地（v1.1.15）。
   *
   * 三件事按顺序做：把卡片摊开 → 滚进视野 → 检查并**直接开始下载**。
   * 用户点的就是「更新」，所以不能再让他去点一次「下载并更新」。
   *
   * 🔴 触发器是 store 里的 updateIntent，不是路由 state：
   *    用户很可能本来就停在设置页，page 不会重新挂载，路由 state 也就不会变化。
   * 🔴 一进来就把它清掉（消费语义）：否则从别的页面再切回设置页时，
   *    这段逻辑会因为读到残留的 intent 又下载一遍。
   */
  useEffect(() => {
    if (updateIntent !== 'download') return;
    setUpdateIntent(null);
    ensureOpen();
    // 等展开后再滚：收起 → 展开会把后面的内容整体下推
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));

    void (async () => {
      const res = await runCheck(false, true);
      const pkg = res?.ok && res.hasUpdate ? res.latest?.pkg : undefined;
      if (!pkg) {
        toast('info', '暂时没有可下载的更新包', res?.reason ?? `当前已是最新版本 v${res?.currentVersion ?? ''}`);
        return;
      }
      // 包已经下好并校验过（info.ok）：直接停在「立即更新并重启」，别重复下载
      if (info?.ok) return;
      await download(pkg);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateIntent]);

  const pick = async () => {
    const files = await call<string[]>(
      () => window.adbApi.pickFiles(false, [{ name: '小更新包', extensions: ['zip'] }]),
      { silent: true },
    );
    if (!files?.[0]) return;

    setBusy('prepare');
    setConfirming(null);
    try {
      const r = await call<UpdateInfo>(() => window.adbApi.prepareUpdate(files[0]), { silent: true });
      setInfo(r ?? null);
      if (r?.ok) {
        toast('success', `更新包可用：v${ctx?.version} → v${r.manifest?.version}`, r.warning);
      } else {
        toast('warn', '这个更新包不能用', r?.reason);
      }
    } finally {
      setBusy('');
    }
  };

  const doApply = async () => {
    setConfirming(null);
    setBusy('go');
    try {
      const r = await window.adbApi.applyUpdate();
      if (!r.ok) {
        toast('error', '无法开始更新', r.error);
        setBusy('');
      } else {
        toast('info', '更新助手已启动', '程序即将退出并替换文件，随后自动重启');
      }
    } catch (e) {
      toast('error', '无法开始更新', (e as Error).message);
      setBusy('');
    }
  };

  const doRollback = async () => {
    setConfirming(null);
    setBusy('go');
    try {
      const r = await window.adbApi.rollbackUpdate();
      if (!r.ok) {
        toast('error', '无法回滚', r.error);
        setBusy('');
      } else {
        toast('info', '正在回滚', '程序即将退出并还原上一版本，随后自动重启');
      }
    } catch (e) {
      toast('error', '无法回滚', (e as Error).message);
      setBusy('');
    }
  };

  const busyNow = busy !== '';

  const checkState: CheckState = checking
    ? 'checking'
    : !check
      ? 'idle'
      : !check.configured
        ? 'unconfigured'
        : !check.ok
          ? 'error'
          : check.hasUpdate
            ? 'available'
            : 'latest';

  return (
    /*
     * data-update-* 挂最外层：验收脚本按 [data-update-panel][data-update-check=...] 取，
     * 卡片默认收起也要能拿到（收起只是视觉隐藏，DOM 一直在）。
     */
    <div
      ref={panelRef}
      data-update-panel="1"
      data-update-kind={ctx?.kind ?? 'unknown'}
      data-update-check={checkState}
    >
      <Card
        title="软件更新"
        subtitle={`当前版本 v${ctx?.version ?? __APP_VERSION__}`}
        collapsible
        defaultOpen={updatePanelDefaultOpen}
        open={panelOpen}
        onToggle={setPanelOpen}
        /* 标题行右边的元素比较多（红点+New、版本徽标、检查更新、下载并更新、更新目录），
           要能换行 —— 见 pages.css 的 .update-card 那组规则 */
        className="update-card"
        extra={
          <div className="row row-wrap">
            {checkState === 'available' && check?.latest && (
              <>
                {/* 只说「是版本更新」这一件事：一枚红字 New，前面不带红点、自身不带底，见 pages.css 的 .update-new */}
                <span className="update-new" data-update-new="1" title="有新版本可以更新">
                  New
                </span>
                <Badge tone="success">新版本 v{check.latest.version}</Badge>
              </>
            )}
            <Button
              size="sm"
              variant="default"
              onClick={() => runCheck(true)}
              loading={checking}
              /* 检查更新是只读操作：即使当前形态不支持应用内更新（开发模式等），也允许点 */
              disabled={busyNow}
              data-update-check-btn="1"
            >
              检查更新
            </Button>
            {checkState === 'available' &&
              check?.latest?.pkg &&
              !info?.ok &&
              confirming !== 'apply' && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => download()}
                  loading={busy === 'download'}
                  disabled={busyNow}
                  data-update-download="1"
                >
                  下载并更新
                </Button>
              )}
            {/*
             * 包已就绪、而卡片处在收起态时，把「立即更新并重启」也搬到标题行 ——
             * 否则收起态里点不动最后一步，只能靠用户自己想到去展开。
             * 展开态不用重一份（下面正文里本来就有），所以这里限定 !panelOpen。
             */}
            {!panelOpen && info?.ok && confirming !== 'apply' && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  ensureOpen();
                  setConfirming('apply');
                }}
                disabled={busyNow}
                data-update-apply-quick="1"
              >
                立即更新并重启
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-update-open-dir="1"
              onClick={() => window.adbApi.openUpdateDir()}
            >
              更新目录
            </Button>
          </div>
        }
      >
        {!ctx ? (
          <div className="row">
            <Spinner />
            <span className="text-dim">正在读取更新环境…</span>
          </div>
        ) : (
          <div className="col">
          <div className="kv-list">
            <About k="当前版本" v={`v${ctx.version}`} />
            <About k="程序形态" v={KIND_LABEL[ctx.kind] ?? ctx.kind} />
            <About
              k="更新源"
              v={check?.sourceDesc ?? (String(settings?.updateBaseUrl || '') ? '读取中…' : '未配置')}
            />
            <About k="最近检查" v={check?.checkedAt || settings?.lastCheckAt || '尚未检查'} />
            <About k="运行时" v={`Electron ${ctx.electronVersion || '未知'}`} />
            {/* 运行库指纹：更新包被「运行库不一致」拒掉时，拿它跟包里记录的一对就知道差在哪 */}
            <About k="运行库指纹" v={ctx.runtimeHash ? `${ctx.runtimeHash.slice(0, 16)}…` : '—'} />
          </div>

          {/*
            自动检测（v1.1.15）。
            以前只有「启动时查一次」这个开关，而且没有间隔可调；现在检测是「启动一次 +
            按间隔轮询」，间隔就摆在这里。落在 settings.json（updateCheckIntervalMin），
            改完立刻生效 —— 轮询的定时器挂在 App 的 useUpdateWatcher 上，依赖 settings。
          */}
          <div className="row row-wrap update-auto" data-update-auto="1">
            <Switch
              checked={!!settings?.autoCheckUpdate}
              onChange={(v) => patchSettings({ autoCheckUpdate: v })}
            />
            <span className="update-auto-label">自动检查更新</span>
            <span className="text-dim">每</span>
            <Input
              type="number"
              min={0}
              max={1440}
              value={String(settings?.updateCheckIntervalMin ?? 10)}
              onChange={(e) => {
                /*
                 * 空串 / 非法值先当 0 处理但**不落盘** —— 用户清空输入框准备重打时，
                 * 立刻把 0 写进设置会让轮询停下来。失焦（onBlur）才真正保存。
                 */
                const n = parseInt(e.target.value, 10);
                setIntervalDraft(Number.isFinite(n) ? Math.max(0, Math.min(1440, n)) : 0);
              }}
              onBlur={() => patchSettings({ updateCheckIntervalMin: intervalDraft })}
              style={{ width: 72, height: 28 }}
              data-update-interval="1"
            />
            <span className="text-dim">分钟检查一次（0 = 只在启动时查）</span>
          </div>

          {/* ---------------- 在线检查结果（六态，见 CheckState 注释） ---------------- */}
          <div className="col">
            {checkState === 'checking' && (
              <div className="row">
                <Spinner />
                <span className="text-dim">正在检查更新…</span>
              </div>
            )}

            {checkState === 'idle' && (
              <div className="text-dim update-note">正在读取更新环境…</div>
            )}

            {/* 未配置：服务器没就绪时的**正常**状态，灰字一行，不飘红不弹错 */}
            {checkState === 'unconfigured' && (
              <div className="text-dim update-note" data-update-unconfigured="1">
                {check?.reason ?? '还没有配置更新源地址。'}
              </div>
            )}

            {checkState === 'error' && (
              <div className="text-dim update-note" data-update-error="1">
                检查更新失败：{check?.reason}
                {check?.sourceDesc ? `（${check.sourceDesc}）` : ''}
              </div>
            )}

            {checkState === 'latest' && (
              <div className="text-dim update-note" data-update-latest="1">
                已是最新版本 · 当前 v{check?.currentVersion}
              </div>
            )}

            {checkState === 'available' && check?.latest && (
              <div className="update-ready" data-update-available="1">
                <div className="update-ready-head">
                  <Badge tone="success">新版本</Badge>
                  <span className="update-ver">
                    v{check.currentVersion} → <b>v{check.latest.version}</b>
                  </span>
                  {check.latest.pkg?.size ? (
                    <span className="text-dim">{fmtSize(check.latest.pkg.size)}</span>
                  ) : null}
                  {check.latest.critical ? <Badge tone="warn">重要更新</Badge> : null}
                </div>

                {check.latest.publishedAt ? (
                  <div className="text-dim update-note">发布时间 {check.latest.publishedAt}</div>
                ) : null}

                {/* 跨版本：这张清单里没有适配本机运行库的差分小包，自动改走了完整资源包 */}
                {check.latest.pkgForm === 'full' ? (
                  <div className="text-dim update-note" data-update-full="1">
                    本机版本与最新版跨度较大，本次将下载完整资源包（含全部随包资源），一次升到位。
                  </div>
                ) : null}

                {check.latest.notes ? (
                  <div className="update-notes">{check.latest.notes}</div>
                ) : null}

                {/* 有新版本但没提供本机形态的包（例如便携版只发了安装版增量包） */}
                {!check.latest.pkg && <Notice tone="warn">{check.reason}</Notice>}

                {busy === 'download' && (
                  <div className="col" data-update-progress="1">
                    <Progress value={dl?.percent ?? 0} />
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="text-dim">
                        {dl?.phase === 'verify'
                          ? '正在校验下载内容…'
                          : dl
                            ? `正在下载 ${fmtSize(dl.received)}${
                                dl.total ? ` / ${fmtSize(dl.total)}` : ''
                              }（${dl.percent}%）`
                            : '正在连接更新源…'}
                      </span>
                      <Button variant="ghost" size="sm" onClick={cancelDownload}>
                        取消下载
                      </Button>
                    </div>
                    <div className="text-dim update-note">
                      下载完成后会自动走一遍与本地包完全相同的校验，通过后才会出现「立即更新并重启」。
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {!ctx.canUpdate && (
            <Notice tone="warn">
              当前不支持应用内更新：{ctx.disabledReason}。
              {ctx.kind === 'dev' ? '' : '请直接使用完整安装包。'}
            </Notice>
          )}

          {info && !info.ok && (
            <Notice tone="danger">
              <b>这个更新包不能用：</b>
              {info.reason}
            </Notice>
          )}

          {info?.ok && info.manifest && (
            <div className="update-ready" data-update-ready="1">
              <div className="update-ready-head">
                <Badge tone="success">已就绪</Badge>
                <span className="update-ver">
                  v{ctx.version} → <b>v{info.manifest.version}</b>
                </span>
                <span className="text-dim">
                  {info.zipSize ? `${(info.zipSize / 1024).toFixed(0)} KB` : ''}
                  {info.fileCount ? ` · ${info.fileCount} 个文件` : ''}
                </span>
              </div>
              <div className="text-dim update-note">
                {info.warning ? `${info.warning} ` : ''}
                开始后程序会自动退出，由外部助手替换文件，然后自动重启。
              </div>
            </div>
          )}

          {confirming === 'apply' && (
            <Notice tone="danger">
              确定现在更新到 v{info?.manifest?.version} 吗？
              <b>程序会立即退出</b>，替换完文件后自动重启。更新前的版本会保留一份备份。
              <div className="row" style={{ marginTop: 8 }}>
                <Button variant="primary" size="sm" onClick={doApply}>
                  确认更新并重启
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                  再想想
                </Button>
              </div>
            </Notice>
          )}

          {confirming === 'rollback' && (
            <Notice tone="danger">
              确定回滚到 <b>v{ctx.backupVersion}</b> 吗？
              <b>程序会立即退出</b>，还原成更新前的版本后重启。
              <div className="row" style={{ marginTop: 8 }}>
                <Button variant="primary" size="sm" onClick={doRollback}>
                  确认回滚并重启
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                  再想想
                </Button>
              </div>
            </Notice>
          )}

          <div className="row">
            {info?.ok && confirming !== 'apply' && (
              <Button
                variant="primary"
                onClick={() => setConfirming('apply')}
                disabled={busyNow}
              >
                立即更新并重启
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={pick}
              loading={busy === 'prepare'}
              disabled={!ctx.canUpdate || busyNow}
              data-update-pick="1"
            >
              选择更新包…
            </Button>
            {ctx.hasBackup && confirming !== 'rollback' && (
              <Button
                variant="ghost"
                onClick={() => setConfirming('rollback')}
                disabled={busyNow}
                title="把程序还原成上一次更新前的版本"
              >
                回滚到 v{ctx.backupVersion}
              </Button>
            )}
          </div>

          {busy === 'go' && (
            <div className="row">
              <Spinner />
              <span className="text-dim">正在交接给更新助手，程序马上退出…</span>
            </div>
          )}

          <div className="text-dim update-note">
            两条更新入口：<b>在线更新</b>从「更新源设置」里的地址取版本与更新包（下载过程可取消，
            中途断网不会留下坏包）；<b>选择更新包…</b>用于离线 / 内网环境，行为与以前完全一致。
            更新包校验项：产品与版本号、Electron 运行时、运行库指纹（adb / scrcpy 等）、
            每个文件的 SHA-256。任一项不符都会拒绝，并提示改用完整安装包。
            日志与备份在 <span className="mono">{ctx.updateDir}</span>。
          </div>
        </div>
        )}
      </Card>
    </div>
  );
}


function DirRow({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string;
  onPick: () => void;
}) {
  return (
    <Field label={label}>
      <div className="row">
        <Input readOnly value={value} onClick={onPick} style={{ cursor: 'pointer' }} />
        <Button variant="default" onClick={onPick} style={{ flex: 'none' }}>
          更改…
        </Button>
        <Button
          variant="ghost"
          onClick={() => value && window.adbApi.reveal(value)}
          style={{ flex: 'none' }}
          title="在资源管理器中打开"
        >
          打开
        </Button>
      </div>
    </Field>
  );
}

function About({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="kv-key">{k}</span>
      <span className="kv-value">{v}</span>
    </div>
  );
}
