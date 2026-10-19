import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { randomUUID } from 'crypto';
import { log } from './adb';
import { resolveUiConfDir } from './ui-conf';
import {
  activeProviderOf,
  cloneDefaultAiConfig,
  normalizeAiConfig,
  type AiConfig,
  type AiProvider,
} from '../../shared/ai-conf';
import type {
  AiAttachment,
  AiChatMessage,
  AiChatRequest,
  AiChatResult,
  AiSession,
  AiSessionMeta,
  AiTestResult,
} from '../../shared/types';

/**
 * AI 对话（v1.1.14）
 * ============================================================
 * 职责分三块：
 *   1. 配置：读/写 `Conf/ai.json`（出厂模板随包分发，用户改的那份在 exe 同级 Conf/）；
 *   2. 会话：持久化到 `<userData>/ai-chats.json`；
 *   3. 请求：把「消息 + 附件」翻译成 OpenAI / Anthropic 两种线上协议并发出。
 *
 * 🔴 为什么请求必须走主进程：
 *   渲染层在 Chromium 里发跨域请求会被 CORS 拦（这些模型接口不给浏览器加
 *   Access-Control-Allow-Origin），而且 apiKey 不该出现在页面上下文里。
 *   主进程是 Node 环境，两件事都不存在。
 *
 * 🔴 为什么附件要在这里解析：
 *   渲染层拿不到本机绝对路径（contextIsolation + sandbox），图片要读成 base64、
 *   网页要代抓，都只能主进程做。
 */

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/**
 * 配置文件路径。
 *
 * ⚠️ 刻意复用 ui-conf 的那套目录（开发期读仓库 `Conf/`、打包后读 exe 同级 `Conf/`）——
 *    用户已经知道「Conf 文件夹 = 手改配置的地方」，把 ai.json 放进去就不用再教一遍。
 *    首次启动的复制由 ui-conf.ts 的 seedUserConf 统一做（ai.json 已在它的清单里）。
 */
function aiConfigPath(): string {
  return join(resolveUiConfDir(), 'ai.json');
}

let cachedConfig: AiConfig | null = null;

/**
 * 读配置（带缓存）。
 *
 * 与 ui-conf 不同，这里**允许强制重读**：提示词和 key 是用户随时会改的东西，
 * 「改完必须重启程序」对 AI 这种高频调参的场景太苛刻了。
 * 界面上有「重新读取配置」，崩溃分析每次开跑前也会 force 读一次。
 */
export function getAiConfig(force = false): AiConfig {
  if (cachedConfig && !force) return cachedConfig;
  const file = aiConfigPath();
  let raw: unknown;
  try {
    raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  } catch (e) {
    log('warn', 'AI', `ai.json 解析失败，按出厂默认处理：${(e as Error).message}`);
    raw = undefined;
  }
  cachedConfig = normalizeAiConfig(raw);
  return cachedConfig;
}

/**
 * 局部改写配置并落盘。
 *
 * 🔴 写回时**保留文件里的未知键**（`_说明` / `_用法` 这类注释键，以及用户自己加的字段）——
 *    直接写 normalize 后的对象会把模板里的说明整段抹掉，用户下次打开文件就懵了。
 */
export function saveAiConfig(patch: Partial<AiConfig>): AiConfig {
  const file = aiConfigPath();
  let disk: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        disk = parsed as Record<string, unknown>;
      }
    }
  } catch {
    /* 文件坏了就整份重写，反正下面会用内存里的规范化结果兜住 */
  }

  const merged = normalizeAiConfig({ ...disk, ...patch });
  const next: Record<string, unknown> = { ...disk, ...serializeAiConfig(merged) };
  try {
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    throw new Error(`写入 ai.json 失败：${(e as Error).message}`);
  }
  cachedConfig = merged;
  return merged;
}

/** 只把「已知的配置项」序列化出去，别把 normalize 出来的内部字段也写进文件 */
function serializeAiConfig(cfg: AiConfig): Record<string, unknown> {
  return {
    activeProvider: cfg.activeProvider,
    providers: cfg.providers,
    systemPrompt: cfg.systemPrompt,
    crashPrompt: cfg.crashPrompt,
    crashDir: cfg.crashDir,
    crashLogMinutes: cfg.crashLogMinutes,
  };
}

/** AI 配置目录（设置页 / AI 页面「打开配置文件夹」用） */
export function aiConfigDir(): string {
  return resolveUiConfDir();
}

/** 出厂 ai.json 的内容（首次创建 + 「恢复默认」用） */
export function defaultAiConfigFile(): string {
  const cfg = cloneDefaultAiConfig();
  return JSON.stringify(cfg, null, 2);
}

/** 取当前生效的提供商；没配好时抛一句人话 */
export function requireProvider(providerId?: string): AiProvider {
  const cfg = getAiConfig(true);
  const p = providerId ? cfg.providers.find((x) => x.id === providerId) : activeProviderOf(cfg);
  if (!p) throw new Error('没有可用的模型配置，请检查 Conf/ai.json 的 providers');
  if (!p.baseUrl.trim()) throw new Error(`「${p.name}」没填接口地址（baseUrl），请在 Conf/ai.json 里补上`);
  if (!p.apiKey.trim()) throw new Error(`「${p.name}」没填 API Key，请在 Conf/ai.json 里补上`);
  if (!p.model.trim()) throw new Error(`「${p.name}」没填模型名（model），请在 Conf/ai.json 里补上`);
  return p;
}

/* ------------------------------------------------------------------ */
/* 会话持久化                                                          */
/* ------------------------------------------------------------------ */

/** 最多留几个会话 / 每个会话最多几条消息（防文件无限膨胀） */
const MAX_SESSIONS = 60;
const MAX_MESSAGES = 200;

function chatStorePath(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'ai-chats.json');
}

let sessions: AiSession[] | null = null;

function loadSessions(): AiSession[] {
  if (sessions) return sessions;
  try {
    const raw = JSON.parse(readFileSync(chatStorePath(), 'utf8'));
    sessions = Array.isArray(raw) ? (raw as AiSession[]) : [];
  } catch {
    sessions = [];
  }
  return sessions;
}

function persistSessions(): void {
  try {
    writeFileSync(chatStorePath(), JSON.stringify(loadSessions(), null, 2), 'utf8');
  } catch (e) {
    log('warn', 'AI', `会话保存失败：${(e as Error).message}`);
  }
}

export function listSessions(): AiSessionMeta[] {
  return loadSessions()
    .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, count: s.messages.length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): AiSession | null {
  return loadSessions().find((s) => s.id === id) ?? null;
}

export function deleteSession(id: string): AiSessionMeta[] {
  sessions = loadSessions().filter((s) => s.id !== id);
  persistSessions();
  return listSessions();
}

export function clearSessions(): AiSessionMeta[] {
  sessions = [];
  persistSessions();
  return [];
}

/** 标题取第一条用户消息的前 20 字 */
function titleOf(messages: AiChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  const t = (first?.content || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > 20 ? `${t.slice(0, 20)}…` : t;
}

/** 把一批消息写进会话（不存在则新建），返回会话 id */
function upsertSession(sessionId: string | undefined, messages: AiChatMessage[]): string {
  const all = loadSessions();
  let s = sessionId ? all.find((x) => x.id === sessionId) : undefined;
  if (!s) {
    s = {
      id: sessionId || randomUUID(),
      title: titleOf(messages),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    all.push(s);
  }
  s.messages = messages.slice(-MAX_MESSAGES);
  s.title = s.title === '新对话' ? titleOf(messages) : s.title;
  s.updatedAt = Date.now();
  // 超量时丢最旧的会话（用户想留的可以自己改标题，这条只是兜底）
  if (all.length > MAX_SESSIONS) {
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    all.length = MAX_SESSIONS;
  }
  persistSessions();
  return s.id;
}

/** 把「这次问答」追加进已有会话的末尾（主进程侧权威写入） */
export function appendToSession(
  sessionId: string | undefined,
  messages: AiChatMessage[],
): string {
  return upsertSession(sessionId, messages);
}

/* ------------------------------------------------------------------ */
/* 附件解析                                                            */
/* ------------------------------------------------------------------ */

/** 一个附件被翻成「能塞进请求」的样子 */
interface ResolvedAttachment {
  /** 文本形态的内容（文件正文 / 网页正文 / 二进制说明） */
  text?: string;
  /** 图片：data URL（base64） */
  dataUrl?: string;
  /** 图片的 mime，anthropic 要单独给 */
  mediaType?: string;
  /** 界面预览用的 data URL */
  previewUrl?: string;
  /** 给模型看的一行说明 */
  note: string;
}

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 当成文本读的扩展名（其余一律只报文件名，不读内容） */
const TEXT_EXT = new Set([
  '.txt', '.log', '.json', '.xml', '.html', '.htm', '.md', '.csv', '.tsv', '.yml', '.yaml',
  '.ini', '.conf', '.properties', '.java', '.kt', '.js', '.ts', '.tsx', '.jsx', '.py', '.c',
  '.cpp', '.h', '.cs', '.go', '.rs', '.sh', '.bat', '.ps1', '.sql', '.gradle', '.pro',
]);

/** 单个文本附件最多塞多少字符（防止把上下文一次撑爆） */
const MAX_TEXT_CHARS = 30000;
/** 图片最大字节数（超过就不发了，走文字说明） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function resolveAttachment(att: AiAttachment): Promise<ResolvedAttachment> {
  if (att.kind === 'link') {
    const url = (att.url || '').trim();
    if (!url) return { note: '［链接：空地址，已忽略］' };
    try {
      const text = await fetchUrlText(url);
      return {
        text: text.slice(0, MAX_TEXT_CHARS),
        note: `［网页］${att.name || url}`,
      };
    } catch (e) {
      return { note: `［网页抓取失败］${url}：${(e as Error).message}` };
    }
  }

  const p = (att.path || '').trim();
  if (!p || !existsSync(p)) return { note: `［附件丢失］${att.name || p}` };
  const ext = extname(p).toLowerCase();

  if (att.kind === 'image' || IMAGE_EXT[ext]) {
    try {
      const buf = readFileSync(p);
      if (buf.length > MAX_IMAGE_BYTES) {
        return { note: `［图片过大，未发送］${att.name}（${(buf.length / 1048576).toFixed(1)} MB）` };
      }
      const mime = IMAGE_EXT[ext] || 'image/png';
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      return { dataUrl, mediaType: mime, previewUrl: dataUrl, note: `［图片］${att.name}` };
    } catch (e) {
      return { note: `［图片读取失败］${att.name}：${(e as Error).message}` };
    }
  }

  // 文本类：白名单扩展名之外，若体积小且不像二进制也尝试当文本读
  try {
    const buf = readFileSync(p);
    const looksBinary = buf.subarray(0, 4096).includes(0);
    const isText = TEXT_EXT.has(ext) || (buf.length < 512 * 1024 && !looksBinary);
    if (!isText) {
      return { note: `［二进制文件，未读取内容］${att.name}（${buf.length} 字节）` };
    }
    const content = buf.toString('utf8').slice(0, MAX_TEXT_CHARS);
    return { text: content, note: `［文件］${att.name}` };
  } catch (e) {
    return { note: `［文件读取失败］${att.name}：${(e as Error).message}` };
  }
}

/** 抓一个网页并剥成纯文本（去脚本 / 样式 / 标签，压空白） */
async function fetchUrlText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, { method: 'GET' }, 20000);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 请求组装                                                            */
/* ------------------------------------------------------------------ */

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string; mediaType: string };

interface BuiltMessage {
  role: 'user' | 'assistant';
  parts: Part[];
}

/**
 * 把会话历史翻成请求消息。
 *
 * 🔴 只有**最后一条用户消息**的附件会被真正解析（图片转 base64、文件读正文）：
 *    否则每多聊一轮就把之前所有图重发一遍，token 费用会随轮数线性上涨。
 *    更早的附件降级成一行文字说明 —— 模型仍然知道「当时聊过一张图 / 一个文件」。
 */
async function buildMessages(
  history: AiChatMessage[],
): Promise<{ built: BuiltMessage[]; previews: Record<string, string> }> {
  const previews: Record<string, string> = {};
  const lastUserIdx = (() => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'user') return i;
    return -1;
  })();

  const built: BuiltMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const parts: Part[] = [];

    if (m.content.trim()) parts.push({ kind: 'text', text: m.content });

    const atts = m.attachments || [];
    if (atts.length) {
      if (i === lastUserIdx) {
        const resolved: string[] = [];
        for (const att of atts) {
          const r = await resolveAttachment(att);
          if (r.dataUrl) {
            parts.push({ kind: 'image', dataUrl: r.dataUrl, mediaType: r.mediaType || 'image/png' });
            if (r.previewUrl) previews[`${m.id}:${att.name}`] = r.previewUrl;
          }
          if (r.text) {
            resolved.push(`${r.note}\n===== 内容开始 =====\n${r.text}\n===== 内容结束 =====`);
          } else if (!r.dataUrl) {
            resolved.push(r.note);
          } else {
            resolved.push(r.note);
          }
        }
        if (resolved.length) parts.push({ kind: 'text', text: resolved.join('\n\n') });
      } else {
        // 旧附件：只留一行说明，不重发内容
        const notes = atts.map((a) => `［${a.kind === 'image' ? '图片' : a.kind === 'link' ? '网页' : '文件'}］${a.name}`);
        parts.push({ kind: 'text', text: notes.join(' ') });
      }
    }

    if (parts.length === 0) parts.push({ kind: 'text', text: '(空)' });
    built.push({ role: m.role, parts });
  }

  return { built, previews };
}

/** 统一的 fetch：带超时 + 把网络层异常翻成人话 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/abort/i.test(msg)) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`网络请求失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 非 2xx 时把服务端返回的错误正文摘出来（各家都是 JSON，直接给人看更有用） */
async function httpError(res: Response): Promise<Error> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 600);
  } catch {
    /* ignore */
  }
  return new Error(`接口返回 ${res.status} ${res.statusText}${body ? `：${body}` : ''}`);
}

interface RawReply {
  content: string;
  model: string;
  usage?: { prompt: number; completion: number; total: number };
}

/** 调一次模型（OpenAI 兼容 / Anthropic 两条分支） */
async function callProvider(
  provider: AiProvider,
  built: BuiltMessage[],
  systemPrompt: string,
  timeoutMs = 120000,
): Promise<RawReply> {
  if (provider.type === 'anthropic') {
    const body = {
      model: provider.model,
      max_tokens: provider.maxTokens ?? 4096,
      temperature: provider.temperature ?? 0.3,
      ...(systemPrompt.trim() ? { system: systemPrompt } : {}),
      messages: built.map((m) => ({
        role: m.role,
        content: m.parts.map((p) =>
          p.kind === 'text'
            ? { type: 'text', text: p.text }
            : {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: p.mediaType,
                  // anthropic 要的是裸 base64，不带 data: 前缀
                  data: p.dataUrl.replace(/^data:[^;]+;base64,/, ''),
                },
              },
        ),
      })),
    };

    const res = await fetchWithTimeout(
      `${provider.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (!res.ok) throw await httpError(res);
    const data: any = await res.json();
    const content = Array.isArray(data?.content)
      ? data.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
      : '';
    return {
      content,
      model: data?.model || provider.model,
      usage: data?.usage
        ? {
            prompt: data.usage.input_tokens ?? 0,
            completion: data.usage.output_tokens ?? 0,
            total: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }

  // OpenAI 兼容（默认分支）
  const messages: any[] = [];
  if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
  for (const m of built) {
    const hasImage = m.parts.some((p) => p.kind === 'image');
    if (!hasImage) {
      messages.push({ role: m.role, content: m.parts.map((p) => (p as any).text).join('\n') });
      continue;
    }
    messages.push({
      role: m.role,
      content: m.parts.map((p) =>
        p.kind === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image_url', image_url: { url: p.dataUrl } },
      ),
    });
  }

  const body = {
    model: provider.model,
    messages,
    temperature: provider.temperature ?? 0.3,
    max_tokens: provider.maxTokens ?? 4096,
    stream: false,
  };

  const res = await fetchWithTimeout(
    `${provider.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res.ok) throw await httpError(res);
  const data: any = await res.json();
  const msg = data?.choices?.[0]?.message;
  let content = typeof msg?.content === 'string' ? msg.content : '';
  // 部分厂商（推理模型）把正文放在 reasoning_content，content 为空
  if (!content && typeof msg?.reasoning_content === 'string') content = msg.reasoning_content;
  return {
    content,
    model: data?.model || provider.model,
    usage: data?.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 对外：对话 / 自检                                                    */
/* ------------------------------------------------------------------ */

export async function aiChat(req: AiChatRequest): Promise<AiChatResult> {
  const provider = requireProvider(req.providerId);
  const history = (req.messages || []).filter((m) => m && m.role && typeof m.content === 'string');
  if (history.length === 0) throw new Error('没有可发送的消息');

  const cfg = getAiConfig(true);
  const started = Date.now();
  const { built } = await buildMessages(history);

  const reply = await callProvider(provider, built, cfg.systemPrompt);
  const content = (reply.content || '').trim() || '（模型返回了空内容）';

  const assistant: AiChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content,
    model: reply.model,
    time: Date.now(),
  };
  const sessionId = appendToSession(req.sessionId, [...history, assistant]);

  log('success', 'AI', `对话完成（${provider.name} · ${reply.model}，${Date.now() - started}ms）`);
  return {
    sessionId,
    content,
    model: reply.model,
    durationMs: Date.now() - started,
    usage: reply.usage,
  };
}

export async function aiTest(providerId?: string): Promise<AiTestResult> {
  try {
    const provider = requireProvider(providerId);
    const started = Date.now();
    const reply = await callProvider(
      provider,
      [{ role: 'user', parts: [{ kind: 'text', text: '请只回复两个字：在的' }] }],
      '',
      30000,
    );
    return {
      ok: true,
      model: reply.model,
      durationMs: Date.now() - started,
      reply: (reply.content || '').trim().slice(0, 200),
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * 供崩溃分析复用的「一次问完」入口：不给会话历史，直接拿回复。
 * 与 aiChat 分开是因为崩溃分析是**无人值守**的，不该把它的提示词灌进用户的对话列表。
 */
export async function askOnce(
  providerId: string | undefined,
  prompt: string,
  timeoutMs = 180000,
): Promise<{ content: string; model: string }> {
  const provider = requireProvider(providerId);
  const reply = await callProvider(
    provider,
    [{ role: 'user', parts: [{ kind: 'text', text: prompt }] }],
    '',
    timeoutMs,
  );
  return { content: (reply.content || '').trim(), model: reply.model };
}

/** 供崩溃分析复用：把图片 / 文本附件变成内联内容（当前只用到文本） */
export async function resolveAttachmentsForPrompt(atts: AiAttachment[]): Promise<string> {
  const out: string[] = [];
  for (const a of atts) {
    const r = await resolveAttachment(a);
    if (r.text) out.push(`${r.note}\n${r.text}`);
    else out.push(r.note);
  }
  return out.join('\n\n');
}

/** 文件名工具（崩溃分析里给报告命名用） */
export function safeFileName(raw: string): string {
  return basename(raw).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'file';
}
