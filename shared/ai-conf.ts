/**
 * AI 模块配置（Conf/ai.json）的**唯一契约**：类型、出厂默认值、逐项合并逻辑。
 *
 * 为什么放在 shared/：
 *   主进程要读文件 + 发请求（electron/services/ai.ts），渲染层的 AI 页面要按同一份
 *   结构展示与编辑（src/pages/AiPage.tsx）。两边各写一份必然漂移 ——
 *   与 shared/ui-conf.ts、shared/packages.ts 同一个理由。
 *
 * 🔴 三条不变量（改动前先读）：
 *  1. **默认值只在这里写一份**。Conf/ai.json 是「用户覆盖层」，不是第二份真相。
 *  2. **一切外部输入都要能容错**。文件由用户手改，可能缺项、拼错、写坏 JSON、
 *     把 apiKey 留在里面又误删引号。规范化结果永远是「尽量保留用户意图 + 其余回落默认」，
 *     绝不抛错、绝不产生 undefined。
 *  3. **apiKey 是敏感字段**：出厂的 ai.json 里一律留空，只作为「往哪填」的占位。
 *
 * ⚠️ 与 settings.json 的分工：
 *   settings.json = 界面里改的运行时偏好（主题、目录、自启、崩溃自动分析开关…）；
 *   Conf/ai.json  = 手改文件配置的**模型接入信息与提示词**。
 *   两者不重叠，互不覆盖。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 协议形态。
 *
 *   openai    —— OpenAI Chat Completions 形状（`POST {baseUrl}/chat/completions`，
 *                `Authorization: Bearer <key>`）。国内绝大多数厂商（DeepSeek /
 *                通义 / 智谱 / Kimi / 豆包 / 硅基流动…）以及 OpenAI 自己、
 *                Ollama、vLLM 全都是这一套，所以它是**默认**。
 *   anthropic —— Anthropic Messages 形状（`POST {baseUrl}/v1/messages`，
 *                `x-api-key` + `anthropic-version`）。
 *
 * 只做这两种：再加一套协议只是多一条分支，而这两条已经覆盖了所有主流服务。
 */
export type AiProviderType = 'openai' | 'anthropic';

/** 一家大模型的接入配置 */
export interface AiProvider {
  /** 稳定标识（对话历史、activeProvider 都引用它）；留空会被自动补成 name */
  id: string;
  /** 界面上显示的名字 */
  name: string;
  type: AiProviderType;
  /** 接口根地址，**不要**带 /chat/completions 这一段（见上面的拼法） */
  baseUrl: string;
  /** API Key。出厂为空字符串，由用户自己填 */
  apiKey: string;
  /** 模型名，如 deepseek-chat / qwen-plus / gpt-4o-mini */
  model: string;
  /** 采样温度，0~2；缺省 0.3（分析类任务要稳，不要放飞） */
  temperature?: number;
  /** 单次回复的 token 上限；缺省 4096 */
  maxTokens?: number;
}

/** Conf/ai.json 的完整形态 */
export interface AiConfig {
  /** 当前使用的提供商 id；找不到时回落到 providers[0] */
  activeProvider: string;
  providers: AiProvider[];
  /** 日常对话的系统提示词（可留空） */
  systemPrompt: string;
  /**
   * 崩溃分析提示词。支持占位符（主进程替换，缺哪个补哪个）：
   *   {{device}}   设备名称（机型 + 序列号）
   *   {{package}}  崩溃的应用包名
   *   {{time}}     崩溃发生时间
   *   {{ops}}      崩溃前的操作记录（工具侧运行日志）
   *   {{log}}      最近 N 分钟的日志内容
   * ⚠️ 一个占位符都不写也能跑：主进程会把日志与操作记录**追加**在提示词后面，
   *    保证「用户改花了提示词」也不会把日志丢掉。
   */
  crashPrompt: string;
  /** 崩溃分析产物的根目录（缺省 D:\adbcrash，无 D 盘时退到下载目录） */
  crashDir: string;
  /** 交给 AI 的日志取多少分钟（缺省 10，与需求一致） */
  crashLogMinutes: number;
}

/* ------------------------------------------------------------------ */
/* 出厂默认值                                                          */
/* ------------------------------------------------------------------ */

/**
 * 常用厂商的**空白模板**。
 *
 * 全部留空 apiKey、且默认只把 DeepSeek 放在首位 —— 用户改一行 key 就能跑，
 * 不用自己去查 baseUrl 该怎么写（这是最容易写错的一项）。
 * 多给几家是为了「换一家不用重新查文档」，不是让用户全配。
 */
export const AI_PROVIDER_PRESETS: AiProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    // deepseek-chat 已从官方 /v1/models 下线（当前只有 deepseek-flash / deepseek-v4-pro）
    model: 'deepseek-flash',
    temperature: 0.3,
    maxTokens: 4096,
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen-plus',
    temperature: 0.3,
    maxTokens: 4096,
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    model: 'moonshot-v1-8k',
    temperature: 0.3,
    maxTokens: 4096,
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-plus',
    temperature: 0.3,
    maxTokens: 4096,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 4096,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.3,
    maxTokens: 4096,
  },
];

/** 日常对话的出厂系统提示词 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是「ADB 桌面助手」内置的 AI 助手，服务于一名 Android 应用开发/测试工程师。' +
  '回答要求：简洁、直接、结论先行；涉及命令或代码时给出可直接复制的片段；' +
  '不确定的地方明确说明，不要编造。';

/**
 * 崩溃分析的出厂提示词。
 *
 * 写法上有意把「输出结构」钉死成四段 —— 报告模板要往固定的小节里塞内容，
 * 结构不稳的话生成出来的报告会忽长忽短、忽分点忽成段，读起来很碎。
 * 占位符含义见 AiConfig.crashPrompt。
 */
export const DEFAULT_CRASH_PROMPT = [
  '你是资深的 Android 稳定性分析工程师。下面是一次应用闪退（崩溃）的现场资料，请分析崩溃原因。',
  '',
  '【设备】{{device}}',
  '【崩溃应用】{{package}}',
  '【崩溃时间】{{time}}',
  '',
  '【崩溃前的操作记录（工具侧日志，按时间顺序）】',
  '{{ops}}',
  '',
  '【崩溃前后的设备日志（最近 {{minutes}} 分钟）】',
  '{{log}}',
  '',
  '请按下面的结构回答，不要输出其它前言或总结：',
  '一、崩溃原因：一句话点明根本原因。',
  '二、关键日志：引用最相关的 2~5 行原始日志，并逐行说明它意味着什么。',
  '三、复现路径：结合操作记录，推断出可复现的最短步骤；推断不出就写「无法从现有日志确定」。',
  '四、修复建议：给出可执行的排查/修改方向，按优先级排列。',
].join('\n');

/** 崩溃产物根的默认值（与 logcat 导出根 D:\adblogs 同一个产品约定） */
export const DEFAULT_CRASH_DIR = 'D:\\adbcrash';

/** 默认取最近多少分钟的日志交给 AI */
export const DEFAULT_CRASH_LOG_MINUTES = 10;

/** 出厂完整配置 */
export const DEFAULT_AI_CONFIG: AiConfig = {
  activeProvider: 'deepseek',
  providers: AI_PROVIDER_PRESETS,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  crashPrompt: DEFAULT_CRASH_PROMPT,
  crashDir: DEFAULT_CRASH_DIR,
  crashLogMinutes: DEFAULT_CRASH_LOG_MINUTES,
};

/* ------------------------------------------------------------------ */
/* 规范化                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** 规范化一家提供商；name 与 baseUrl 都空的一律丢弃（那是没填完的残项） */
function normalizeProvider(raw: unknown): AiProvider | null {
  if (!isPlainObject(raw)) return null;

  const baseUrl = str(raw.baseUrl).trim();
  const name = str(raw.name).trim();
  if (!baseUrl && !name) return null;

  const type: AiProviderType = raw.type === 'anthropic' ? 'anthropic' : 'openai';
  const id = str(raw.id).trim() || name || baseUrl;

  const temperature = num(raw.temperature, 0.3);
  const maxTokens = Math.round(num(raw.maxTokens, 4096));

  return {
    id,
    name: name || id,
    type,
    baseUrl: baseUrl.replace(/\/+$/, ''), // 尾斜杠一律去掉，拼 URL 时不再判断
    apiKey: str(raw.apiKey),
    model: str(raw.model).trim(),
    // 温度夹到 [0,2]：写错成 30 会让接口直接报错，不如就地纠正
    temperature: Math.min(2, Math.max(0, temperature)),
    maxTokens: Math.min(200000, Math.max(1, maxTokens || 4096)),
  };
}

/**
 * 把「用户手改过的 JSON」规范成一份可用配置。
 *
 * - providers 里被删空 / 全部非法时**回落出厂模板**（而不是空数组）——
 *   空数组会让 AI 页面直接没法用，而用户大概率只是改错了缩进。
 * - activeProvider 指向一个不存在的 id 时回落到第一家。
 */
export function normalizeAiConfig(raw: unknown): AiConfig {
  if (!isPlainObject(raw)) return cloneDefaultAiConfig();

  const providers: AiProvider[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.providers)) {
    for (const item of raw.providers) {
      const p = normalizeProvider(item);
      if (!p) continue;
      // id 撞车会让「选中的是哪家」失去意义，重名就把后面那家换个 id
      if (seen.has(p.id)) p.id = `${p.id}-${providers.length + 1}`;
      seen.add(p.id);
      providers.push(p);
    }
  }
  if (providers.length === 0) providers.push(...cloneProviders(AI_PROVIDER_PRESETS));

  const activeRaw = str(raw.activeProvider).trim();
  const activeProvider = providers.some((p) => p.id === activeRaw) ? activeRaw : providers[0].id;

  const minutes = Math.round(num(raw.crashLogMinutes, DEFAULT_CRASH_LOG_MINUTES));

  return {
    activeProvider,
    providers,
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : DEFAULT_SYSTEM_PROMPT,
    crashPrompt: typeof raw.crashPrompt === 'string' && raw.crashPrompt.trim()
      ? raw.crashPrompt
      : DEFAULT_CRASH_PROMPT,
    crashDir: str(raw.crashDir).trim() || DEFAULT_CRASH_DIR,
    crashLogMinutes: Math.min(180, Math.max(1, minutes || DEFAULT_CRASH_LOG_MINUTES)),
  };
}

function cloneProviders(list: AiProvider[]): AiProvider[] {
  return list.map((p) => ({ ...p }));
}

/** 深拷贝出厂默认 —— 调用方可能把它交给会改动的代码，不能共享引用 */
export function cloneDefaultAiConfig(): AiConfig {
  return {
    ...DEFAULT_AI_CONFIG,
    providers: cloneProviders(AI_PROVIDER_PRESETS),
  };
}

/** 取当前生效的提供商（activeProvider 找不到时返回第一家，兜底不返回 undefined） */
export function activeProviderOf(cfg: AiConfig): AiProvider {
  return cfg.providers.find((p) => p.id === cfg.activeProvider) ?? cfg.providers[0];
}

/**
 * 一份配置是否「配好了」—— 也就是能不能真的发请求。
 * 只用它做界面提示与崩溃分析的短路判断，不参与任何校验逻辑。
 */
export function isAiUsable(cfg: AiConfig): boolean {
  const p = activeProviderOf(cfg);
  return !!p && !!p.baseUrl.trim() && !!p.apiKey.trim() && !!p.model.trim();
}
