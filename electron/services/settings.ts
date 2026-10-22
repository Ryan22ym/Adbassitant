import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { DEFAULT_PACKAGE_DIR_NAMES, DEFAULT_PACKAGE_FILTERS } from '../../shared/packages';
import type { AppSettings } from '../../shared/types';

/** 安装包仓库默认根目录（产品约定放 D 盘，和 logcat 导出根一个思路） */
export const DEFAULT_PACKAGE_ROOT = 'D:\\ApkPackages';

/**
 * 没有 D 盘（或 D 盘不可写）时退到系统下载目录 —— 只在 defaultDirs 里用，
 * 因为 DEFAULTS 是模块级常量，那时候 app 可能还没 ready，取不了系统路径。
 */
function defaultPackageRoot(): string {
  try {
    if (existsSync('D:\\')) return DEFAULT_PACKAGE_ROOT;
  } catch {
    /* ignore */
  }
  return join(app.getPath('downloads'), 'ApkPackages');
}

const DEFAULTS: AppSettings = {
  theme: 'light',
  accent: 'cangqiong',
  // 自定义主题色（v1.1.14）：空串 = 还没挑过，此时 accent='custom' 也没意义
  accentCustom: '',
  // 左侧功能栏默认展开（新装的用户先看到带文字的完整导航）
  sidebarCollapsed: false,
  screenshotDir: '',
  recordDir: '',
  pullDir: '',
  logcatExportDir: '',
  // 开机自启动默认关（不擅自往用户的开机项里加东西）
  autoLaunch: false,
  // 在线更新：默认不配置更新源 —— 服务器就绪前「检查更新」提示「更新源未配置」是正常状态
  updateBaseUrl: 'https://buddybase-d8g4m4rz6306e4648-1485935404.tcloudbaseapp.com/adb-assistant/',
  updateChannel: 'stable',
  autoCheckUpdate: true,
  lastCheckAt: '',
  // 连点器：1 倍速原速回放、默认开启 6px 随机偏移（模拟真实点击，防机械点击检测）
  clickerSpeed: 1,
  clickerJitterPx: 6,
  // 与设备侧 ControlServer.DEFAULT_PORT 一致；改这里要同步改 android/recorder 里的常量
  recorderPort: 18081,
  // 安装包管理（v1.1.6）
  packageRootDir: DEFAULT_PACKAGE_ROOT,
  packageDirNames: DEFAULT_PACKAGE_DIR_NAMES,
  packageStructure: 'version-first',
  packageAutoOrganize: true,
  packageFilters: DEFAULT_PACKAGE_FILTERS,
  // 手动标签：对象默认给空的一份（与上面几个对象字段同理，别共享引用）
  packageOverrides: {},
  // 插入即自动投屏（v1.1.9）：默认关 —— 和 autoLaunch 一个调性，
  // 不擅自改变用户机器的行为（开启后关窗会最小化到托盘，属于可见的行为变化）
  autoMirrorOnConnect: false,
  // 「曾投屏成功过」的设备白名单，由主进程写入；数组同样别共享引用
  mirroredSerials: [],
  /*
   * 透明玻璃主题（v1.1.13）。
   *
   * 🔴 默认不透明度取 20（不是 62、也不是 18）：这个主题的卖点就是**直接透出
   *    用户自己的桌面**，62 那种「奶白板」把桌面几乎盖没了，小杨验收时直接打回。
   *    ⚠️ 2026-10-13 的取值演进 22 → 18 → **20**（最终）：
   *       面板底从**纯白改成中性纸灰 #f2f4f8** 之后，同样的 alpha 会显得更「压」，
   *       所以先从 22 降到 18；但 18 配上 veil 0.16 后颜色还是偏淡，
   *       再回到 20 —— 20 与 veil 0.16 经 max() 后正好是 0.20，是定稿值。
   *       实测：纯白 α=0.30 会把画面刷到亮度 159，而目标（iOS 26 控制中心）只有 132。
   *
   * 🔴 默认粗糙度 45（→ blur ≈ 27px）是对着小杨给的目标图**实测标定**的：
   *    目标图在 546px 宽截图上 blur ≈ 12px，换算到 1184 CSS px 的窗口约 26px。
   *    这个档位桌面呈现「一团团柔和色块」——看得出偏绿/偏蓝的大色域，
   *    但认不出任何图标或文字，正是小杨要的「能看到大致色彩，看不了这么清楚」。
   *    不是随手给的中位默认。想看清细节可往 20 以下调，想全糊可拉到 100。
   * 只在 theme='glass' 时生效。
   */
  glassOpacity: 20,
  glassRoughness: 45,
  // 玻璃主题的底图：默认仍是「壁纸」（v1.1.13 的行为），色系默认淡蓝
  glassBackdrop: 'wallpaper',
  glassTint: 'blue',
  /*
   * 检测崩溃自动 AI 分析日志（v1.1.14）：默认关。
   *
   * 两个理由：① 开了之后主进程会常驻一个 logcat 子进程（哪怕只在投屏期间）；
   * ② 它会**自动花钱** —— 每识别到一次闪退就调一次模型，用户没配好 key 之前
   *    贸然打开只会在运行日志里刷一屏失败。所以必须由用户显式点头。
   */
  crashAutoAnalyze: false,
  // 实时 Logcat：切走模块后继续在后台抓（v1.1.15）。默认开 —— 「开着抓、去别的
  // 页面操作设备、回来接着看」才是 Logcat 的典型用法，默认停掉会打断它。
  logcatKeepBackground: true,
  // 自动检查更新间隔（v1.1.15）：10 分钟。0 = 只在启动时查一次
  updateCheckIntervalMin: 10,
};

/** Logcat 导出的默认根目录（产品约定，写死；见 defaultDirs 注释） */
export const DEFAULT_LOGX_ROOT = 'D:\\adblogs';

/** 空目录视为未设置，回落到系统默认目录 */
export function resolveDir(kind: 'screenshot' | 'record' | 'pull' | 'logcatExport'): string {
  const s = getSettings();
  const v =
    kind === 'screenshot'
      ? s.screenshotDir
      : kind === 'record'
        ? s.recordDir
        : kind === 'pull'
          ? s.pullDir
          : s.logcatExportDir;
  if (v && v.trim()) return v;
  if (kind === 'logcatExport') return DEFAULT_LOGX_ROOT;
  return defaultDirs()[
    kind === 'screenshot' ? 'screenshotDir' : kind === 'record' ? 'recordDir' : 'pullDir'
  ];
}

let cached: AppSettings | null = null;

function configPath(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'settings.json');
}

/**
 * 默认输出目录：我的图片 / ADB助手 等
 */
function defaultDirs(): AppSettings {
  const pictures = app.getPath('pictures');
  const videos = app.getPath('videos');
  const downloads = app.getPath('downloads');
  return {
    theme: 'light',
    accent: 'cangqiong',
    accentCustom: '',
    sidebarCollapsed: false,
    screenshotDir: join(pictures, 'ADB助手'),
    recordDir: join(videos, 'ADB助手'),
    pullDir: join(downloads, 'ADB助手'),
    /*
     * Logcat 导出根的默认值：**写死 D:\adblogs**，不用系统下载目录。
     * 这个路径是产品约定（日志集中放在一个固定位置，方便交付/归档），
     * 与截图/录屏那几个「跟随系统」的目录性质不同 —— 别顺手改成 downloads。
     * D 盘不存在时由 logcat-export 侧回落，不在这里判断（这里只负责给值）。
     */
    logcatExportDir: 'D:\\adblogs',
    autoLaunch: false,
    updateBaseUrl: 'https://buddybase-d8g4m4rz6306e4648-1485935404.tcloudbaseapp.com/adb-assistant/',
    updateChannel: 'stable',
    autoCheckUpdate: true,
    lastCheckAt: '',
    clickerSpeed: 1,
    clickerJitterPx: 6,
    recorderPort: 18081,
    /*
     * 安装包仓库（v1.1.6）：默认 D:\ApkPackages（没有 D 盘时退到下载目录）。
     * 对象字段都给一份新副本 —— getSettings() 会把 merged 直接交给调用方，
     * 共享同一个引用的话，界面改筛选条件会顺手改掉「默认值」本身。
     */
    packageRootDir: defaultPackageRoot(),
    packageDirNames: { ...DEFAULT_PACKAGE_DIR_NAMES },
    packageStructure: 'version-first',
    packageAutoOrganize: true,
    packageFilters: { ...DEFAULT_PACKAGE_FILTERS },
    // 手动标签默认空表（每次都给一份新对象）
    packageOverrides: {},
    autoMirrorOnConnect: false,
    // 白名单默认空数组（每次都给一份新实例）
    mirroredSerials: [],
    // 透明玻璃主题的两个参数（v1.1.12），只在 theme='glass' 时生效。
    // ⚠️ 必须与上面 DEFAULTS 的取值一致（20 是「透出真桌面」的那一档）
    glassOpacity: 20,
    glassRoughness: 45,
    // 玻璃主题底图（v1.1.14）：与 DEFAULTS 保持一致 —— 默认壁纸模式、淡蓝色系
    glassBackdrop: 'wallpaper',
    glassTint: 'blue',
    // 崩溃自动 AI 分析（v1.1.14）：与 DEFAULTS 一致，默认关
    crashAutoAnalyze: false,
    // Logcat 后台抓取 / 更新检测间隔（v1.1.15）：与 DEFAULTS 保持一致
    logcatKeepBackground: true,
    updateCheckIntervalMin: 10,
  };
}

/** 允许被显式清空的字符串字段（其余空串一律视为「没设置」，不覆盖默认值） */
const CLEARABLE_KEYS = new Set(['updateBaseUrl', 'lastCheckAt']);

export function getSettings(): AppSettings {
  if (cached) return cached;

  const file = configPath();
  let stored: Partial<AppSettings> = {};
  try {
    if (existsSync(file)) {
      stored = JSON.parse(readFileSync(file, 'utf8'));
    }
  } catch {
    stored = {};
  }

  // 先铺默认目录，再合并已存配置；
  // 但空字符串视为「未设置」，不允许覆盖默认目录，否则会出现 dir='' 导致 mkdir 失败。
  // 例外见 CLEARABLE_KEYS —— 更新源地址本来就允许为空（= 未配置）。
  const merged: AppSettings = { ...defaultDirs() };
  for (const [k, v] of Object.entries(stored) as [string, string][]) {
    if (typeof v === 'string' && v.trim() === '' && !CLEARABLE_KEYS.has(k)) continue;
    (merged as unknown as Record<string, unknown>)[k] = v;
  }

  cached = merged;
  return cached;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...patch };
  cached = merged;
  writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
