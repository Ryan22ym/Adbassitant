/**
 * 界面配置（Conf/ 目录）的**唯一契约**：类型、可选 id 清单、出厂默认值、逐项合并逻辑。
 *
 * 为什么放在 shared/：
 *   主进程要读文件 + 合并（electron/services/ui-conf.ts），渲染层要用同一份默认值与
 *   同一套 id 清单（src/lib/ui-conf.ts）。两边各写一份必然漂移 ——
 *   与 shared/packages.ts、shared/mirror-defaults.ts 同一个理由。
 *
 * 🔴 三条不变量（改动前先读）：
 *  1. **默认值只在这里写一份**。Conf/*.json 是「用户覆盖层」，不是第二份真相；
 *     合并策略是「以这里为底，用文件里的合法项覆盖」。
 *  2. **一切外部输入都要能容错**。Conf 文件由用户手改，可能缺项、拼错、写坏 JSON。
 *     规范化的结果是「尽量保留用户意图 + 其余回落默认」，绝不抛错、绝不产生 undefined。
 *  3. **id 清单是白名单**。order 数组里的未知 id 会被丢掉，未知的分组 / 块名会被忽略 ——
 *     拼错一个字不会让界面崩，只是那一项不生效。
 *
 * ⚠️ 与 settings.json 的分工（别搞混）：
 *   settings.json = 用户在界面里改的**运行时**偏好（主题、目录、自启…），主进程可写；
 *   Conf/*.json   = 用户手改文件调整的**界面骨架**（顺序、显隐、默认展开），启动时只读。
 *   两者不重叠，互不覆盖。
 */

/* ------------------------------------------------------------------ */
/* id 清单（白名单）                                                    */
/* ------------------------------------------------------------------ */

/** 左侧功能栏的条目 id。改这里要同步 src/components/layout.tsx 的 NAV_DEFS */
export const SIDEBAR_IDS = [
  'device',
  'mirror',
  'tools',
  'apps',
  'logcat',
  'weaknet',
  'clicker',
  'command',
  /* v1.1.14：AI 助手（对话 + 崩溃分析报告），排在「设置」之前 */
  'ai',
  'settings',
] as const;

/** 「常用工具」页的标签 id。改这里要同步 src/pages/ToolsPage.tsx 的 TAB_DEFS */
export const TOOL_TAB_IDS = [
  'screenshot',
  'record',
  'resolution',
  'monkey',
  'apk',
  'file',
  'logcat',
] as const;

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** Conf/layout.json —— 顺序与形态 */
export interface LayoutConf {
  /** 该文件是否生效；false = 整份走默认（等于「恢复出厂布局」） */
  enabled: boolean;
  sidebar: {
    /**
     * 左侧功能栏顺序。
     * 只写关心的几项即可：列出的按给定顺序排前面，没列出的按默认顺序接在后面。
     */
    order: string[];
    /** 首次启动时是否收起（只在没有用户手动记录、或 rememberCollapsed=false 时用） */
    defaultCollapsed: boolean;
    /**
     * 是否记住用户手动切换的收起状态。
     * false = 每次启动都回到 defaultCollapsed（忽略用户上次的切换）。
     */
    rememberCollapsed: boolean;
  };
  toolTabs: {
    /** 「常用工具」页标签顺序，规则同 sidebar.order */
    order: string[];
  };
}

/** Conf/panels.json —— 各页面功能块的默认展开 / 收起 */
export interface PanelsConf {
  /** 该文件是否生效；false = 全部按默认展开状态 */
  enabled: boolean;
  /** 页面 id → 功能块 id → 默认是否展开 */
  panels: Record<string, Record<string, boolean>>;
}

/** Conf/features.json —— 功能入口显隐总开关 */
export interface FeaturesConf {
  /** 该文件是否生效；false = 全部入口都显示 */
  enabled: boolean;
  /** 分组 id → 条目 id → 是否显示 */
  features: Record<string, Record<string, boolean>>;
}

/** 三份文件合并后的完整界面配置（主进程经 IPC 下发的就是它） */
export interface UiConf {
  layout: LayoutConf;
  panels: PanelsConf;
  features: FeaturesConf;
}

/* ------------------------------------------------------------------ */
/* 出厂默认值                                                          */
/* ------------------------------------------------------------------ */

/**
 * 出厂默认布局。
 *
 * sidebar.order 的顺序 = 功能使用频率从高到低；与 v1.1.11 的写死顺序逐字一致，
 * 所以「Conf 目录被删掉」时界面和以前完全一样。
 */
export const DEFAULT_LAYOUT: LayoutConf = {
  enabled: true,
  sidebar: {
    order: [...SIDEBAR_IDS],
    defaultCollapsed: false,
    rememberCollapsed: true,
  },
  toolTabs: {
    order: [...TOOL_TAB_IDS],
  },
};

/**
 * 出厂默认展开状态。
 *
 * 取舍原则：**进来就要用的块展开，看完一次就不用再看的块收起**。
 * 例如设置页的「环境自检」只有出问题时才要展开，而「外观」是常改的。
 */
export const DEFAULT_PANELS: PanelsConf = {
  enabled: true,
  panels: {
    /* 设备页 */
    device: { list: true, detail: true, wireless: true },
    /* 投屏页：快捷键是查表用的，日常不用摊开 */
    mirror: { status: true, quality: true, hotkeys: false },
    /* 常用工具页（每个标签一块） */
    tools: {
      screenshot: true,
      record: true,
      resolution: true,
      monkey: false,
      apk: true,
      file: true,
      logcat: true,
    },
    /* 应用管理页 */
    apps: { list: true, detail: true },
    /* 实时 Logcat 页 */
    logcat: { stream: true, filter: true },
    /* 弱网模拟页：原理说明与预设都是「需要时才看」 */
    weaknet: { params: true, scope: true, presets: false, device: true, howto: false },
    /* 自动连点器页 */
    clicker: { steps: true, preview: true, params: true, library: true },
    /* 命令终端页 */
    command: { input: true, common: true, output: true },
    /* 运行日志页 */
    logs: { stream: true },
    /* AI 助手页（v1.1.14）：对话窗口与崩溃分析报告两块 */
    ai: { chat: true, reports: true },
    /* 安装包管理（应用管理页内的模块） */
    packages: { workdir: true, rules: false, filter: true, list: true },
    /* 设置页：与 SettingsPage 里原本写死的 defaultOpen 保持一致 */
    settings: {
      appearance: true,
      about: true,
      dirs: false,
      update: true,
      logs: false,
      env: false,
      autoMirror: true,
      /* 记录窗口大小（v1.1.16）：低频设置，默认收起 */
      window: false,
    },
  },
};

/**
 * 出厂默认入口开关 —— 全开。
 *
 * 默认全开是有意的：关掉入口属于「用户自己的取舍」，不该由出厂设置替用户做决定。
 */
export const DEFAULT_FEATURES: FeaturesConf = {
  enabled: true,
  features: {
    /* 左侧导航项 */
    nav: {
      device: true,
      mirror: true,
      tools: true,
      apps: true,
      logcat: true,
      weaknet: true,
      clicker: true,
      command: true,
      ai: true,
      settings: true,
    },
    /* 「常用工具」页的各个标签 */
    tools: {
      screenshot: true,
      record: true,
      resolution: true,
      monkey: true,
      apk: true,
      file: true,
      logcat: true,
    },
    /* 设备页里的整块入口 */
    device: { wireless: true, quickActions: true },
    /* 自动连点器页的「手机端录制」标签（采集端 App + 录屏授权那一整套） */
    clicker: { record: true },
    /* 设置页里的整块入口 */
    settings: { autoMirror: true, update: true, envCheck: true },
  },
};

/** 出厂默认的完整配置（渲染层把它当 store 初值，避免首屏空白） */
export const DEFAULT_UI_CONF: UiConf = {
  layout: DEFAULT_LAYOUT,
  panels: DEFAULT_PANELS,
  features: DEFAULT_FEATURES,
};

/* ------------------------------------------------------------------ */
/* 规范化（把「用户手改过的 JSON」变成一份可用的配置）                    */
/* ------------------------------------------------------------------ */

/** 深拷贝默认值 —— 调用方可能把它交给会改动的代码，不能共享引用 */
export function cloneDefaultUiConf(): UiConf {
  return {
    layout: {
      enabled: true,
      sidebar: { ...DEFAULT_LAYOUT.sidebar, order: [...DEFAULT_LAYOUT.sidebar.order] },
      toolTabs: { order: [...DEFAULT_LAYOUT.toolTabs.order] },
    },
    panels: { enabled: true, panels: cloneMatrix(DEFAULT_PANELS.panels) },
    features: { enabled: true, features: cloneMatrix(DEFAULT_FEATURES.features) },
  };
}

function cloneMatrix(src: Record<string, Record<string, boolean>>): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const [k, v] of Object.entries(src)) out[k] = { ...v };
  return out;
}

/** 判断一个已解析的 JSON 是否是个可用对象（null / 数组 / 字符串都不算） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * 把用户给的 order 数组过滤成「合法、去重」的顺序表。
 * 返回 null 表示「这份输入不可用」（非数组），调用方该整体回落默认顺序。
 */
function sanitizeOrder(incoming: unknown, allowed: readonly string[]): string[] | null {
  if (!Array.isArray(incoming)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of incoming) {
    if (typeof v !== 'string' || seen.has(v)) continue;
    if (!allowed.includes(v)) continue; // 未知 id 直接丢掉，不因为一个拼错就整体失效
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * 合并顺序：用户列出的在前，未列出的按默认顺序补在后面。
 *
 * 这样用户只想把「投屏」挪到第一位时，只写 `["mirror"]` 就够了，不必把 9 项抄全；
 * 将来程序新增了导航项，老 Conf 也不会把新项挤掉。
 */
function mergeOrder(
  base: readonly string[],
  incoming: unknown,
  allowed: readonly string[],
): string[] {
  const given = sanitizeOrder(incoming, allowed);
  if (given === null) return [...base];
  const seen = new Set(given);
  return [...given, ...base.filter((id) => !seen.has(id))];
}

/**
 * 合并「两级布尔表」（页面→块 / 分组→条目）。
 *
 * 未知的分组与块名一律忽略：用户 Conf 里写的是一个将来才有的块时，当前版本不该报错；
 * 反过来，代码新增了块而用户 Conf 还是旧的，那一项自然保留默认值。
 */
function mergeBoolMatrix(
  base: Record<string, Record<string, boolean>>,
  incoming: unknown,
): Record<string, Record<string, boolean>> {
  const out = cloneMatrix(base);
  if (!isPlainObject(incoming)) return out;
  for (const [group, blocks] of Object.entries(incoming)) {
    const target = out[group];
    if (!target || !isPlainObject(blocks)) continue;
    for (const [key, val] of Object.entries(blocks)) {
      if (typeof val !== 'boolean') continue;
      if (!(key in target)) continue;
      target[key] = val;
    }
  }
  return out;
}

/**
 * 规范化 layout.json。
 *
 * `_enabled: false` 或文件内容不可用时整份回落默认 —— 这是留给用户的「一键恢复布局」开关。
 */
export function normalizeLayout(raw: unknown): LayoutConf {
  const fallback = cloneDefaultUiConf().layout;
  if (!isPlainObject(raw)) return fallback;
  if (raw._enabled === false) return fallback;

  const sidebar = isPlainObject(raw.sidebar) ? raw.sidebar : {};
  const toolTabs = isPlainObject(raw.toolTabs) ? raw.toolTabs : {};

  return {
    enabled: true,
    sidebar: {
      order: mergeOrder(fallback.sidebar.order, sidebar.order, SIDEBAR_IDS),
      defaultCollapsed: asBool(sidebar.defaultCollapsed, fallback.sidebar.defaultCollapsed),
      rememberCollapsed: asBool(sidebar.rememberCollapsed, fallback.sidebar.rememberCollapsed),
    },
    toolTabs: {
      order: mergeOrder(fallback.toolTabs.order, toolTabs.order, TOOL_TAB_IDS),
    },
  };
}

/** 规范化 panels.json */
export function normalizePanels(raw: unknown): PanelsConf {
  const fallback = cloneDefaultUiConf().panels;
  if (!isPlainObject(raw)) return fallback;
  if (raw._enabled === false) return fallback;
  return {
    enabled: true,
    panels: mergeBoolMatrix(fallback.panels, raw.panels),
  };
}

/** 规范化 features.json */
export function normalizeFeatures(raw: unknown): FeaturesConf {
  const fallback = cloneDefaultUiConf().features;
  if (!isPlainObject(raw)) return fallback;
  if (raw._enabled === false) return fallback;
  return {
    enabled: true,
    features: mergeBoolMatrix(fallback.features, raw.features),
  };
}

/** 三份文件 → 一份配置。任何一份缺失 / 损坏都只影响它自己。 */
export function normalizeUiConf(raws: {
  layout?: unknown;
  panels?: unknown;
  features?: unknown;
}): UiConf {
  return {
    layout: normalizeLayout(raws.layout),
    panels: normalizePanels(raws.panels),
    features: normalizeFeatures(raws.features),
  };
}

/* ------------------------------------------------------------------ */
/* 读取辅助（渲染层用，语义比直接下标取更清楚）                          */
/* ------------------------------------------------------------------ */

/** 某个功能块默认是否展开（未配置时按默认值 true） */
export function panelOpenOf(conf: UiConf, page: string, block: string): boolean {
  return conf.panels.panels[page]?.[block] ?? true;
}

/** 某个入口是否显示（未配置时按默认值 true） */
export function featureOnOf(conf: UiConf, group: string, key: string): boolean {
  return conf.features.features[group]?.[key] ?? true;
}
