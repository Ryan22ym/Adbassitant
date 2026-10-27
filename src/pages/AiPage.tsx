import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Notice,
  Segmented,
  Select,
  Textarea,
} from '@/components/ui';
import { Icon } from '@/components/icons';
import { useApp } from '@/store/app';
import { usePanelOpen } from '@/lib/ui-conf';
import { call, tryCall } from '@/lib/ipc';
import { fileName, formatTime } from '@/lib/format';
import { activeProviderOf, isAiUsable } from '@shared/ai-conf';
import type { AiConfig, AiProvider } from '@shared/ai-conf';
import {
  detectDocParts,
  extOfFormat,
  formatsOf,
  mdToHtml,
  partToText,
  readMdTable,
} from '@shared/ai-export';
import type { AiDocFormat, AiDocPart } from '@shared/ai-export';
import { IPC } from '@shared/types';
import type {
  AiAdbStep,
  AiAgentStepEvent,
  AiAttachment,
  AiChatMessage,
  AiChatResult,
  AiExportRequest,
  AiExportResult,
  AiSession,
  AiSessionMeta,
  AiTestResult,
  CrashReportFull,
  CrashReportMeta,
} from '@shared/types';

/*
 * AI 助手（v1.1.14 起）
 * ============================================================
 * 两块东西合在一个页面里：
 *   对话    —— 文字 + 图片 / 文件 / 链接三种附件，走配置里的模型
 *   崩溃报告 —— 「检测崩溃自动 AI 分析日志」开关产出的报告，带红点与一键定位
 *
 * 🔴 v1.1.15 新增「AI 自己执行 adb 指令」：
 *    对话不再是一问一答 —— 主进程把「模型给的 adb 命令」跑掉、把输出回传给模型，
 *    循环到模型不再要命令为止。这个页面只负责三件事：
 *      ① 开关（允不允许它碰设备）；
 *      ② 实时进度（push:aiAgentStep 推一条画一条，不然用户只能干等）；
 *      ③ 停止（多轮跑起来可能几十秒，必须能叫停）。
 *
 * 三条约定：
 *
 * ① **图片以 file:// 预览**，和「常用工具 → 截图」里的缩略图同一套写法。
 *    主进程只在真正发请求时才把图片读成 base64，界面预览不走 IPC ——
 *    否则每加一张图都要来回搬几 MB 的 data URL，加几张就卡一下。
 *
 * ② **API Key 只存在于主进程的配置里**。这个页面拿到的 cfg 是从主进程读回来的
 *    展示副本，改完立刻通过 setAiConfig 写回文件；不往 localStorage 里塞任何东西。
 *
 * ③ **报告正文按需取**。列表只拿 meta（一份报告可能几万字），点开才 crashReport(id)，
 *    并且顺手把 unread 消掉 —— 红点的唯一依据就是这份未读数。
 */

let msgSeq = 0;
function uid(): string {
  msgSeq += 1;
  return `m${Date.now().toString(36)}-${msgSeq.toString(36)}`;
}

/**
 * 把一段文本放进剪贴板（v1.1.17）。
 *
 * 三级链，从最可靠的往下退：
 *   ① **主进程 clipboard** —— 不要求窗口焦点，自绘窗口里唯一稳的一条路；
 *   ② `navigator.clipboard.writeText()` —— 需要安全上下文 + 文档有焦点；
 *   ③ `execCommand('copy')` —— 最后的兜底。
 *
 * 🔴 把 ① 放最前面是有实测依据的：窗口被投屏窗口（scrcpy 原生窗口）抢走焦点时，
 *    ② 不会报错，而是**静默失败**（Promise resolve、剪贴板仍是空的）——
 *    界面显示「已复制」，粘出来什么都没有。只有 ① 没有这个前提。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const done = await window.adbApi.clipboardWrite(text);
    if (done) return true;
  } catch {
    /* IPC 不可用（理论上不会）→ 往下退 */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 图片扩展名（拖放 / 粘贴时用来判断该不该按「图片附件」处理） */
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

export default function AiPage() {
  /*
   * 默认停在哪一页：有未读报告（侧栏红点亮着）→ 直接进「崩溃报告」，
   * 否则听 Conf/panels.json 的 ai.chat（true = 对话，false = 报告）。
   * 红点的意义就是「点进来能看见东西」，进来还停在对话页等于白点一次。
   *
   * 🔴🔴 这个决定**只能做一次**，用 tabDecided 锁住。踩过的坑：
   *    最初写成 `tab ?? (crashUnread > 0 ? 'reports' : chatDefault ? 'chat' : 'reports')`，
   *    看起来没问题，但那是**每次渲染都算**的表达式 —— 而报告一旦被看到就会被
   *    标记已读、crashUnread 归零，于是页面当场自己跳回「对话」。
   *    偏偏这条路径就是最常用的那条（侧栏红点点进来），必现。
   *
   * 🔴 也不能在 useState 初值里算：界面配置与报告索引都是启动后**异步**取回来的，
   *    初值那一刻读到的永远是「0 份报告 + 出厂配置」，用户在 panels.json 里改的
   *    ai.chat 就白改了（其它页面踩过同样的坑）。所以等 crashReady 再决定。
   */
  const crashUnread = useApp((s) => s.crashUnread);
  const crashReady = useApp((s) => s.crashReady);
  const chatDefault = usePanelOpen('ai', 'chat');
  const [tab, setTab] = useState<'chat' | 'reports' | null>(null);
  const tabDecided = useRef(false);

  useEffect(() => {
    if (tabDecided.current || !crashReady) return;
    tabDecided.current = true;
    setTab(crashUnread > 0 ? 'reports' : chatDefault ? 'chat' : 'reports');
  }, [crashReady, crashUnread, chatDefault]);

  const effTab: 'chat' | 'reports' = tab ?? 'chat';
  const [cfg, setCfg] = useState<AiConfig | null>(null);

  const reloadCfg = useCallback(async (force = false) => {
    const c = await tryCall<AiConfig>(() => window.adbApi.aiConfig(force));
    if (c) setCfg(c);
    return c;
  }, []);

  useEffect(() => {
    void reloadCfg();
  }, [reloadCfg]);

  const usable = !!cfg && isAiUsable(cfg);
  const active = cfg ? activeProviderOf(cfg) : null;

  return (
    <div className="ai-page">
      <ConfigCard cfg={cfg} reload={reloadCfg} />

      <div className="ai-head">
        <Segmented
          value={effTab}
          onChange={setTab}
          options={[
            { value: 'chat', label: '对话' },
            { value: 'reports', label: crashUnread > 0 ? `崩溃报告 · ${crashUnread}` : '崩溃报告' },
          ]}
        />
        <div className="ai-head-side">
          {active ? (
            <Badge tone={usable ? 'success' : 'warn'} dot>
              {active.name} · {active.model || '未填模型'}
            </Badge>
          ) : (
            <Badge tone="warn">未读到配置</Badge>
          )}
        </div>
      </div>

      {!usable && (
        <Notice tone="warn">
          <strong>还没有可用的模型。</strong>
          展开上面的「模型接入」填一个 API Key 并保存，或直接改 <code>Conf/ai.json</code>。
        </Notice>
      )}

      {effTab === 'chat' ? <ChatPane cfg={cfg} usable={usable} /> : <ReportsPane />}
    </div>
  );
}

/* ================================================================== */
/* 模型接入（Conf/ai.json）                                            */
/* ================================================================== */

function ConfigCard({
  cfg,
  reload,
}: {
  cfg: AiConfig | null;
  reload: (force?: boolean) => Promise<AiConfig | null>;
}) {
  const toast = useApp((s) => s.toast);
  const [draft, setDraft] = useState<AiConfig | null>(cfg);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const [cfgDir, setCfgDir] = useState('');
  const [showKey, setShowKey] = useState(false);

  // 主进程重读配置后（保存 / 手动重读）把草稿对齐
  useEffect(() => setDraft(cfg), [cfg]);

  useEffect(() => {
    void tryCall<string>(() => window.adbApi.aiConfigDir()).then((d) => {
      if (d) setCfgDir(d);
    });
  }, []);

  const prov: AiProvider | null = useMemo(() => {
    if (!draft) return null;
    return draft.providers.find((p) => p.id === draft.activeProvider) || draft.providers[0] || null;
  }, [draft]);

  const patchProv = (patch: Partial<AiProvider>) => {
    setDraft((d) =>
      d && prov ? { ...d, providers: d.providers.map((p) => (p.id === prov.id ? { ...p, ...patch } : p)) } : d,
    );
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await call<AiConfig>(
        () =>
          window.adbApi.setAiConfig({
            activeProvider: draft.activeProvider,
            providers: draft.providers,
            systemPrompt: draft.systemPrompt,
            crashPrompt: draft.crashPrompt,
            crashDir: draft.crashDir,
            crashLogMinutes: draft.crashLogMinutes,
            exportDir: draft.exportDir,
          }),
        { silent: true },
      );
      if (next) setDraft(next);
      await reload(true);
      toast('success', 'AI 配置已保存', '写入 Conf/ai.json（用户目录）');
    } catch (e) {
      toast('error', '保存失败', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const doTest = async () => {
    if (!prov) return;
    setTesting(true);
    setTest(null);
    try {
      const r = await call<AiTestResult>(() => window.adbApi.aiTest(prov.id), { silent: true });
      setTest(r || { ok: false, reason: '没有返回结果' });
    } catch (e) {
      setTest({ ok: false, reason: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      collapsible
      defaultOpen={!cfg || !isAiUsable(cfg)}
      title="模型接入"
      subtitle="配置保存在 Conf/ai.json（首次启动时自动生成），可在这里改，也可以直接编辑文件"
      collapsedSubtitle={
        prov ? `${prov.name} · ${prov.model || '未填模型'}${prov.apiKey ? '' : '（缺 API Key）'}` : '未读到配置'
      }
      extra={
        <>
          <Button size="sm" variant="ghost" onClick={() => void reload(true)}>
            重新读取
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void window.adbApi.openPath(cfgDir || '')} disabled={!cfgDir}>
            打开配置文件目录
          </Button>
          <Button size="sm" variant="primary" onClick={save} loading={saving} disabled={!draft}>
            保存
          </Button>
        </>
      }
    >
      {!draft ? (
        <Empty title="正在读取配置…" desc="若一直停在这里，检查一下 Conf/ai.json 是否可读" />
      ) : (
        <div className="ai-cfg">
          <div className="ai-cfg-row">
            <Field label="提供商">
              <Select
                value={draft.activeProvider}
                onChange={(e) => setDraft({ ...draft, activeProvider: e.target.value })}
                options={draft.providers.map((p) => ({ value: p.id, label: p.name }))}
              />
            </Field>
            <Field label="协议">
              <Select
                value={prov?.type || 'openai'}
                onChange={(e) => patchProv({ type: e.target.value as AiProvider['type'] })}
                options={[
                  { value: 'openai', label: 'OpenAI 兼容（多数国产模型）' },
                  { value: 'anthropic', label: 'Anthropic Messages' },
                ]}
              />
            </Field>
            <Field label="模型名">
              <Input
                value={prov?.model || ''}
                placeholder="deepseek-chat"
                onChange={(e) => patchProv({ model: e.target.value })}
              />
            </Field>
          </div>

          <div className="ai-cfg-row">
            <Field label="接口地址" hint="写到 /v1 为止，不要带 /chat/completions">
              <Input
                value={prov?.baseUrl || ''}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => patchProv({ baseUrl: e.target.value })}
              />
            </Field>
            <Field label="API Key" hint="只存在本机，不会随对话发出">
              <Input
                type={showKey ? 'text' : 'password'}
                value={prov?.apiKey || ''}
                placeholder="sk-…"
                onChange={(e) => patchProv({ apiKey: e.target.value })}
                suffix={
                  <button type="button" className="ai-key-toggle" onClick={() => setShowKey((v) => !v)}>
                    {showKey ? '隐藏' : '显示'}
                  </button>
                }
              />
            </Field>
          </div>

          <div className="ai-cfg-row">
            <Field label="温度" hint="分析类任务建议 0.2 ~ 0.4">
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={String(prov?.temperature ?? 0.3)}
                onChange={(e) => patchProv({ temperature: Number(e.target.value) })}
              />
            </Field>
            <Field label="回复上限（token）">
              <Input
                type="number"
                min={256}
                step={256}
                value={String(prov?.maxTokens ?? 4096)}
                onChange={(e) => patchProv({ maxTokens: Number(e.target.value) })}
              />
            </Field>
            <div className="ai-cfg-actions">
              <Button size="sm" onClick={doTest} loading={testing} disabled={!prov}>
                测试连接
              </Button>
            </div>
          </div>

          {test && (
            <Notice tone={test.ok ? 'success' : 'danger'} onClose={() => setTest(null)}>
              {test.ok ? (
                <>
                  连接正常（{test.model || prov?.model}，{test.durationMs}ms）：{test.reply}
                </>
              ) : (
                <>连接失败：{test.reason}</>
              )}
            </Notice>
          )}

          <details className="ai-cfg-more">
            <summary>提示词、崩溃分析与导出目录</summary>
            <div className="ai-cfg-col">
              <Field label="日常对话系统提示词">
                <Textarea
                  rows={3}
                  value={draft.systemPrompt}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                />
              </Field>
              <Field
                label="崩溃分析提示词"
                hint="{{device}} {{package}} {{time}} {{ops}} {{log}} {{minutes}}"
              >
                <Textarea
                  rows={8}
                  value={draft.crashPrompt}
                  onChange={(e) => setDraft({ ...draft, crashPrompt: e.target.value })}
                />
              </Field>
              <div className="ai-cfg-row">
                <Field label="崩溃产物目录">
                  <Input
                    value={draft.crashDir}
                    onChange={(e) => setDraft({ ...draft, crashDir: e.target.value })}
                    suffix={
                      <button
                        type="button"
                        className="ai-key-toggle"
                        onClick={() =>
                          void tryCall<string>(() => window.adbApi.pickDir()).then((d) => {
                            if (d) setDraft({ ...draft, crashDir: d });
                          })
                        }
                      >
                        选择
                      </button>
                    }
                  />
                </Field>
                <Field label="日志取多少分钟">
                  <Input
                    type="number"
                    min={1}
                    max={120}
                    value={String(draft.crashLogMinutes)}
                    onChange={(e) => setDraft({ ...draft, crashLogMinutes: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <Field
                label="AI 文档导出目录"
                hint="对话框里点「保存」默认存到这里；每次导出也可以临时改或另存为"
              >
                <Input
                  value={draft.exportDir}
                  placeholder="D:\adbdocs"
                  onChange={(e) => setDraft({ ...draft, exportDir: e.target.value })}
                  suffix={
                    <button
                      type="button"
                      className="ai-key-toggle"
                      onClick={() =>
                        void tryCall<string>(() => window.adbApi.pickDir()).then((d) => {
                          if (d) setDraft({ ...draft, exportDir: d });
                        })
                      }
                    >
                      选择
                    </button>
                  }
                />
              </Field>
            </div>
          </details>
        </div>
      )}
    </Card>
  );
}

/* ================================================================== */
/* 对话                                                                */
/* ================================================================== */

/* 上次停在哪一段对话。
 *
 * 路由切走再切回来时 ChatPane 会整个卸载重建，sessionId 归零 →
 * 用户看到的是空白新对话，得自己到左边列表里翻回刚才那段。
 * 把 id 记在 localStorage 就够了：纯界面偏好，不值得进 settings.json。
 */
const LAST_SESSION_KEY = 'adb.ai.lastSession';

function readLastSession(): string | undefined {
  try {
    return localStorage.getItem(LAST_SESSION_KEY) || undefined;
  } catch {
    return undefined; // 存储被禁（隐私模式 / 配额满）就当没记住过
  }
}

function rememberSession(id: string | undefined) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    /* 同上：记不住不影响这一轮对话 */
  }
}

/* 「允许 AI 执行 adb 指令」开关（v1.1.15）。
 *
 * 默认开 —— 这是这个功能的全部意义，默认关等于没做。
 * 放 localStorage：纯界面偏好，跟 settings.json 里的主题/目录不是一类东西。
 */
const ALLOW_ADB_KEY = 'adb.ai.allowAdb';

function readAllowAdb(): boolean {
  try {
    return localStorage.getItem(ALLOW_ADB_KEY) !== '0';
  } catch {
    return true;
  }
}

/* ================================================================== */
/* 自动执行过的 adb 指令                                               */
/* ================================================================== */

/**
 * 一组命令的执行记录。
 *
 * 输出默认折叠（成功的一次 dumpsys 就有几千字，全摊开屏幕上什么别的都看不见），
 * 但**失败的命令默认展开** —— 出问题时用户第一眼看的就是这里。
 *
 * 用 useState 而不是 <details open>：open 属性是受控的，用户手动展开后
 * 只要组件重渲染一次（新消息进来就会），就会被 React 掰回初始状态。
 */
function StepList({ steps }: { steps: AiAdbStep[] }) {
  return (
    <div className="ai-steps">
      {steps.map((s, i) => (
        <StepRow key={s.id || `${i}`} step={s} index={i} />
      ))}
    </div>
  );
}

function StepRow({ step: s, index }: { step: AiAdbStep; index: number }) {
  const [open, setOpen] = useState(() => !s.ok && !s.blocked);
  const tone = s.blocked ? 'blocked' : s.ok ? 'ok' : 'bad';
  const label = s.blocked ? '已拦截' : s.ok ? '成功' : `退出码 ${s.code}`;
  return (
    <div className={`ai-step ${tone}`}>
      <div className="ai-step-head">
        <span className="ai-step-idx">{index + 1}</span>
        <code className="ai-step-cmd" title={s.command}>
          {s.command}
        </code>
        <span className="ai-step-badge">{label}</span>
        {!s.blocked && <span className="ai-step-ms">{s.durationMs}ms</span>}
      </div>
      {s.reason && <div className="ai-step-reason">{s.reason}</div>}
      {s.blocked ? (
        <div className="ai-step-why">{s.blocked}</div>
      ) : (
        <div className="ai-step-out">
          <button type="button" className="ai-step-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? '▾' : '▸'} 输出{s.truncated ? '（已截断）' : ''}
          </button>
          {open && <pre>{s.output}</pre>}
        </div>
      )}
    </div>
  );
}

function ChatPane({ cfg, usable }: { cfg: AiConfig | null; usable: boolean }) {
  const [sessions, setSessions] = useState<AiSessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [atts, setAtts] = useState<AiAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [allowAdb, setAllowAdb] = useState(readAllowAdb);
  const [liveSteps, setLiveSteps] = useState<AiAdbStep[]>([]);
  const [stopping, setStopping] = useState(false);
  /** 正在准备导出的那条助手消息（null = 对话框关着） */
  const [exportMsg, setExportMsg] = useState<AiChatMessage | null>(null);
  /** 有文件拖到输入区上方（只影响这块的描边与提示，不影响整窗拖放安装） */
  const [dragOn, setDragOn] = useState(false);
  /** dragenter/dragleave 会在子元素间反复触发，用计数器判断是否真的离开 */
  const dragDepth = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  /* 本次请求的标识：既用来认领推送，也用来发「停止」。
   * 用 ref 而不是 state 是必须的 —— 推送回调在 effect 里只注册一次，
   * 它读不到后续渲染产生的 state 快照。 */
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(ALLOW_ADB_KEY, allowAdb ? '1' : '0');
    } catch {
      /* 存不住就每次默认开，不影响功能 */
    }
  }, [allowAdb]);

  /* 执行进度：主进程每跑完一条命令推一条过来。
   * 只认自己这次 runId —— 理论上同一时刻只有一个请求在跑，
   * 但用户手快点了两次「停止→发送」时，上一条的迟到推送不该串到新气泡里。 */
  useEffect(() => {
    const off = window.adbApi.on(IPC.PUSH_AI_AGENT_STEP, (ev: AiAgentStepEvent) => {
      if (!runIdRef.current || ev.runId !== runIdRef.current) return;
      setLiveSteps((s) => [...s, ev.step]);
    });
    return off;
  }, []);

  const refreshSessions = useCallback(async () => {
    const list = await tryCall<AiSessionMeta[]>(() => window.adbApi.aiSessions());
    if (list) setSessions(list);
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  /*
   * 挂载时把上次停的那段对话接回来。
   *
   * ⚠️ 用 ref 只跑一次：StrictMode 下 effect 会执行两遍，会重复读会话文件；
   *    而且用户点了「新建对话」之后，任何后续刷新都不该把旧会话拉回来 ——
   *    那时 localStorage 已经被清掉，这里也就自然什么都不做。
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const last = readLastSession();
    if (!last) return;
    void (async () => {
      const s = await tryCall<AiSession>(() => window.adbApi.aiSession(last));
      if (!s) {
        // 会话被删了 / 历史被清了 → 悄悄退回新对话，别留个高亮的空壳
        rememberSession(undefined);
        return;
      }
      setSessionId(s.id);
      setMessages(s.messages || []);
    })();
  }, []);

  /* 新消息 / 发送中 都要把视图钉到底部（实时执行时更要跟住，命令是一条条冒出来的） */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, liveSteps]);

  const reset = () => {
    setSessionId(undefined);
    // 新对话 = 不再记得上一段，否则切走再回来又跳回去
    rememberSession(undefined);
    setMessages([]);
    setInput('');
    setAtts([]);
  };

  const openSession = async (id: string) => {
    const s = await tryCall<AiSession>(() => window.adbApi.aiSession(id));
    if (!s) return;
    setSessionId(s.id);
    rememberSession(s.id);
    setMessages(s.messages || []);
    setInput('');
    setAtts([]);
  };

  const removeSession = async (id: string) => {
    const list = await tryCall<AiSessionMeta[]>(() => window.adbApi.aiSessionDelete(id));
    if (list) setSessions(list);
    if (id === sessionId) reset();
  };

  const clearSessions = async () => {
    const list = await tryCall<AiSessionMeta[]>(() => window.adbApi.aiSessionClear());
    if (list) setSessions(list);
    reset();
  };

  /* ---------------- 附件 ---------------- */

  const addImages = async () => {
    const paths = await tryCall<string[]>(() =>
      window.adbApi.pickFiles(true, [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      ]),
    );
    if (!paths?.length) return;
    setAtts((a) => [...a, ...paths.map((p) => ({ kind: 'image' as const, path: p, name: fileName(p) }))]);
  };

  const addFiles = async () => {
    const paths = await tryCall<string[]>(() => window.adbApi.pickFiles(true));
    if (!paths?.length) return;
    setAtts((a) => [...a, ...paths.map((p) => ({ kind: 'file' as const, path: p, name: fileName(p) }))]);
  };

  /**
   * 把「拖进来 / 粘贴进来」的 File 对象变成附件（v1.1.17）。
   *
   * 两种来源的差别只在拿不拿得到路径：
   *   · 从资源管理器拖 / 复制文件 —— `webUtils.getPathForFile()` 有值，直接用；
   *   · 剪贴板里的截图、网页里拖出来的图、压缩包内直接拖出来的虚拟文件 ——
   *     没有路径，但**图片本身有字节**，于是存成临时文件换一个路径（主进程做）。
   *     非图片又没路径的一律跳过（二进制内容既没法给模型看，也没法落盘取名）。
   *
   * 🔴 图片按扩展名 / MIME 双判：从某些软件拖出来的文件 MIME 是空字符串，
   *    `file.type` 靠不住；而剪贴板截图常常有 MIME 却没有文件名后缀。
   */
  const attachFromFiles = async (files: File[], from: 'paste' | 'drop') => {
    if (!files.length) return;
    const added: AiAttachment[] = [];
    let skipped = 0;
    for (const f of files) {
      const path =
        (typeof window.adbApi.getPathForFile === 'function'
          ? window.adbApi.getPathForFile(f)
          : '') ||
        (f as File & { path?: string }).path ||
        '';
      if (path) {
        const isImg = IMG_EXT_RE.test(path) || /^image\//.test(f.type);
        added.push({ kind: isImg ? 'image' : 'file', path, name: f.name || fileName(path) });
        continue;
      }
      if (/^image\//.test(f.type)) {
        const saved = await tryCall<string>(async () => {
          const buf = new Uint8Array(await f.arrayBuffer());
          return window.adbApi.aiPasteImage(buf, f.type);
        });
        if (saved) added.push({ kind: 'image', path: saved, name: fileName(saved) });
        else skipped += 1;
        continue;
      }
      skipped += 1;
    }
    if (added.length) setAtts((a) => [...a, ...added]);
    if (skipped > 0) {
      useApp
        .getState()
        .toast(
          'warn',
          `已忽略 ${skipped} 个文件`,
          from === 'paste' ? '剪贴板里只有文本/无法读取的内容' : '拿不到这些文件的本地路径（试试先存到磁盘再拖进来）',
        );
    }
  };

  /**
   * Ctrl+V 粘贴（v1.1.17）。
   *
   * 只在拿到**文件/图片**时才接管；纯文本一律放行走默认粘贴 ——
   * 输入框最主要的功能还是打字，绝不能因为这段逻辑把文字粘贴弄坏。
   * 接管时必须 preventDefault，否则从资源管理器复制的文件会以「路径文本」的形式
   * 插进输入框，同时附件里多一份，变成用户看不懂的重复。
   */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files: File[] = [];
    for (const it of Array.from(dt.items || [])) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    if (files.length === 0 && dt.files?.length) files.push(...Array.from(dt.files));
    if (files.length === 0) return;
    e.preventDefault();
    void attachFromFiles(files, 'paste');
  };

  /** 拖放（v1.1.17）：只在这个输入区生效，页面其它地方的整窗拖放安装不受影响 */
  const hasFilesIn = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFilesIn(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOn(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFilesIn(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFilesIn(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOn(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFilesIn(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOn(false);
    void attachFromFiles(Array.from(e.dataTransfer?.files || []), 'drop');
  };

  const addLink = () => {
    const url = linkDraft.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setAtts((a) => [...a, { kind: 'link', url: `https://${url}`, name: url }]);
    } else {
      setAtts((a) => [...a, { kind: 'link', url, name: url }]);
    }
    setLinkDraft('');
    setLinkOpen(false);
  };

  const dropAtt = (i: number) => setAtts((a) => a.filter((_, idx) => idx !== i));

  /* ---------------- 发送 ---------------- */

  const doSend = async () => {
    if (sending) return;
    const text = input.trim();
    if (!text && atts.length === 0) return;
    if (!usable) {
      useApp.getState().toast('warn', '还没有可用的模型', '先在「模型接入」里填好 API Key');
      return;
    }

    const userMsg: AiChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      attachments: atts.length ? atts : undefined,
      time: Date.now(),
    };
    const history = [...messages, userMsg];
    const runId = uid();
    runIdRef.current = runId;
    setMessages(history);
    setLiveSteps([]);
    setInput('');
    setAtts([]);
    setSending(true);
    setStopping(false);
    try {
      const r = await call<AiChatResult>(
        () => window.adbApi.aiChat({ sessionId, messages: history, runId, allowAdb }),
        { silent: true },
      );
      setSessionId(r.sessionId);
      rememberSession(r.sessionId);
      setMessages([
        ...history,
        {
          id: uid(),
          role: 'assistant',
          content: r.content,
          model: r.model,
          time: Date.now(),
          steps: r.steps && r.steps.length ? r.steps : undefined,
        },
      ]);
      if (r.stopped) {
        useApp
          .getState()
          .toast('info', '已停止', `本次执行了 ${r.steps?.length ?? 0} 条 adb 指令，AI 没有给出结论`);
      }
      void refreshSessions();
    } catch (e) {
      setMessages([
        ...history,
        { id: uid(), role: 'assistant', content: (e as Error).message, time: Date.now(), error: true },
      ]);
    } finally {
      /* 收尾必须一起做：runIdRef 不清空的话，上一次迟到的推送会串进下一次对话 */
      setSending(false);
      setStopping(false);
      setLiveSteps([]);
      runIdRef.current = null;
    }
  };

  /* 停止：只是给主进程打个标记，那边在「下一条命令之前」才会真正收手 ——
   * 所以点完不会立刻结束，按钮会转成「正在停止…」。 */
  const doStop = async () => {
    const id = runIdRef.current;
    if (!id) return;
    setStopping(true);
    await tryCall(() => window.adbApi.aiCancel(id));
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void doSend();
    }
  };

  return (
    <div className="ai-layout">
      <aside className="ai-side">
        <div className="ai-side-head">
          <Button size="sm" variant="primary" block onClick={reset}>
            新建对话
          </Button>
        </div>
        <div className="ai-sessions">
          {sessions.length === 0 ? (
            <p className="ai-side-empty">还没有历史对话</p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`ai-session ${s.id === sessionId ? 'on' : ''}`}
                onClick={() => void openSession(s.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void openSession(s.id);
                }}
              >
                <div className="ai-session-main">
                  <span className="ai-session-title">{s.title || '未命名对话'}</span>
                  <span className="ai-session-sub">
                    {formatTime(s.updatedAt)} · {s.count} 条
                  </span>
                </div>
                <button
                  type="button"
                  className="ai-session-del"
                  title="删除这段对话"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeSession(s.id);
                  }}
                >
                  {Icon.trash}
                </button>
              </div>
            ))
          )}
        </div>
        {sessions.length > 0 && (
          <div className="ai-side-foot">
            <Button size="sm" variant="ghost" block onClick={() => void clearSessions()}>
              清空全部对话
            </Button>
          </div>
        )}
      </aside>

      <section className="ai-chat">
        <div className="ai-msgs" ref={listRef}>
          {messages.length === 0 && !sending ? (
            <Empty
              icon={Icon.ai}
              title="问点什么吧"
              desc={
                usable
                  ? `当前使用 ${activeProviderOf(cfg!).name}。可以贴一段日志、丢一张崩溃截图，也可以直接让它查手机（例如「看看当前前台是什么应用」）—— 它会自己执行 adb 指令。`
                  : '先在「模型接入」里配好 API Key'
              }
            />
          ) : (
            <>
              {messages.map((m) => (
                <ChatBubble key={m.id} msg={m} onExport={setExportMsg} />
              ))}
              {sending && liveSteps.length > 0 && (
                <div className="ai-bubble assistant live">
                  <StepList steps={liveSteps} />
                </div>
              )}
              {sending && (
                <div className="ai-bubble assistant pending">
                  <span className="spinner" />
                  {liveSteps.length > 0
                    ? `已执行 ${liveSteps.length} 条 adb 指令，AI 正在判断下一步…`
                    : '正在思考…'}
                </div>
              )}
            </>
          )}
        </div>

        {/*
          输入区同时是拖放区（v1.1.17）。
          🔴 `data-dropzone` 是 DragInstallHost 认的标记：窗级 dragenter/dragover
            看到事件落在带这个属性的元素里就不再显示「松开即可安装」那层遮罩、
            也不会把文件当安装包 —— 这样「只有 AI 页支持拖文件」这件事不需要改
            全局拖放逻辑，其它页面行为一个字都没动。
        */}
        <div
          className={`ai-composer ${dragOn ? 'drag-on' : ''}`}
          data-dropzone="ai-input"
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {dragOn && (
            <div className="ai-drop-hint">
              <i>{Icon.paperclip}</i>
              <span>松开鼠标，把文件添加到这段对话</span>
            </div>
          )}

          {atts.length > 0 && (
            <div className="ai-atts">
              {atts.map((a, i) => (
                <span key={`${a.kind}-${i}`} className={`ai-att att-${a.kind}`}>
                  {a.kind === 'image' && a.path ? (
                    <img className="ai-att-thumb" src={`file://${a.path.replace(/\\/g, '/')}`} alt="" />
                  ) : (
                    <i className="ai-att-icon">
                      {a.kind === 'image' ? Icon.image : a.kind === 'link' ? Icon.link : Icon.paperclip}
                    </i>
                  )}
                  <span className="ai-att-name" title={a.path || a.url || a.name}>
                    {a.name}
                  </span>
                  <button type="button" className="ai-att-x" title="移除" onClick={() => dropAtt(i)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {linkOpen && (
            <div className="ai-link-row">
              <Input
                autoFocus
                placeholder="粘贴网页地址，发送时会把正文抓下来一起交给模型"
                value={linkDraft}
                onChange={(e) => setLinkDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLink();
                  }
                }}
              />
              <Button size="sm" onClick={addLink}>
                添加
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLinkOpen(false)}>
                取消
              </Button>
            </div>
          )}

          <Textarea
            className="ai-input"
            rows={3}
            placeholder="输入内容…（Ctrl + Enter 发送，Enter 换行；可直接粘贴截图、拖入文件）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />

          <div className="ai-composer-bar">
            <Button size="sm" variant="ghost" icon={Icon.image} onClick={() => void addImages()}>
              图片
            </Button>
            <Button size="sm" variant="ghost" icon={Icon.paperclip} onClick={() => void addFiles()}>
              文件
            </Button>
            <Button size="sm" variant="ghost" icon={Icon.link} onClick={() => setLinkOpen((v) => !v)}>
              链接
            </Button>
            {/* 允不允许 AI 自己动手。默认开 —— 这个功能的意义就在于它能把命令跑掉 */}
            <button
              type="button"
              className={`ai-adb-toggle ${allowAdb ? 'on' : ''}`}
              data-allow-adb={allowAdb ? '1' : '0'}
              title={
                allowAdb
                  ? 'AI 可以自己执行 adb 指令来查设备；破坏性操作会被拦截'
                  : '已关闭：AI 只回答问题，不动设备'
              }
              onClick={() => setAllowAdb((v) => !v)}
            >
              {Icon.terminal}
              <span>执行 adb 指令</span>
            </button>
            <span className="ai-spacer" />
            {sending ? (
              <Button size="sm" variant="ghost" icon={Icon.close} loading={stopping} onClick={() => void doStop()}>
                {stopping ? '正在停止…' : '停止'}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={Icon.send}
                onClick={() => void doSend()}
                disabled={!input.trim() && atts.length === 0}
              >
                发送
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* 导出对话框挂在最外层：它用的是 position:fixed 遮罩，放在两栏网格里会变成网格项 */}
      {exportMsg && <ExportDialog msg={exportMsg} onClose={() => setExportMsg(null)} />}
    </div>
  );
}

const ATT_LABEL: Record<AiAttachment['kind'], string> = {
  image: '图片',
  file: '文件',
  link: '链接',
};

function ChatBubble({
  msg,
  onExport,
}: {
  msg: AiChatMessage;
  onExport?: (m: AiChatMessage) => void;
}) {
  const isUser = msg.role === 'user';
  /*
   * 「已复制」只用本地状态就够了，不走 toast：
   * 复制是高频、低风险动作，弹 toast 反而要等它自己消失；
   * 按钮文字就地变一下，1.6 秒后自己变回来最省事。
   */
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const doCopy = async () => {
    const ok = await copyToClipboard(msg.content);
    setCopyState(ok ? 'ok' : 'fail');
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1600);
  };

  const canExport = !isUser && !msg.error && !!msg.content.trim();

  return (
    <div className={`ai-bubble ${isUser ? 'user' : 'assistant'} ${msg.error ? 'err' : ''}`}>
      {isUser && msg.attachments && msg.attachments.length > 0 && (
        <div className="ai-bubble-atts">
          {msg.attachments.map((a, i) => (
            <span key={`${a.kind}-${i}`} className="ai-bubble-att">
              <i>{a.kind === 'image' ? Icon.image : a.kind === 'link' ? Icon.link : Icon.paperclip}</i>
              {ATT_LABEL[a.kind]}：{a.name}
            </span>
          ))}
        </div>
      )}
      {isUser ? (
        msg.content && <div className="ai-bubble-text">{msg.content}</div>
      ) : (
        <>
          {/* 命令记录在正文上方：它是「模型为了回答去查了什么」，读的时候先看过程再看结论 */}
          {msg.steps && msg.steps.length > 0 && <StepList steps={msg.steps} />}
          <MdView text={msg.content} />
        </>
      )}
      <div className="ai-bubble-foot">
        <span>{formatTime(msg.time)}</span>
        {msg.model && <span>· {msg.model}</span>}
        {!isUser && (
          <span className="ai-bubble-acts">
            {!!msg.content.trim() && (
              <button
                type="button"
                className={`ai-bubble-act ${copyState === 'ok' ? 'ok' : copyState === 'fail' ? 'fail' : ''}`}
                data-act="copy"
                title="复制这条回复的全部内容"
                onClick={() => void doCopy()}
              >
                {Icon.copy}
                <span>{copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制'}</span>
              </button>
            )}
            {canExport && (
              <button
                type="button"
                className="ai-bubble-act"
                data-act="export"
                title="导出成 Markdown / Word / PDF 等文件"
                onClick={() => onExport?.(msg)}
              >
                {Icon.download}
                <span>导出</span>
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/* 导出为文件（v1.1.17）                                               */
/* ================================================================== */

/**
 * 「把这条回复存成文件」对话框。
 *
 * 三件事要在一屏里说清楚：
 *   ① **导出什么** —— 一条回复里可能既有整篇文档，又有代码块和表格，
 *      各自该存成什么文件并不一样（见 `detectDocParts`）；
 *   ② **存成什么格式** —— 选项跟着内容块走：整篇文档可 md/docx/pdf/html/txt，
 *      代码块只给「原样」和 txt，表格只给 csv 和 txt；
 *   ③ **存到哪** —— 默认目录来自 `Conf/ai.json` 的 `exportDir`（可在这里临时改），
 *      另外给一个「另存为…」把选择权完全交给系统对话框。
 *
 * 🔴 转换分工：正文的格式转换全在渲染层（`shared/ai-export.ts`，纯字符串），
 *    docx / pdf 交给主进程（写 ZIP、起隐藏窗口打印）。所以这里传过去的
 *    `text` 已经是目标格式的正文，主进程不需要懂 Markdown。
 */
function ExportDialog({ msg, onClose }: { msg: AiChatMessage; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const parts = useMemo(() => detectDocParts(msg.content), [msg.content]);
  const [partId, setPartId] = useState(parts[0]?.id || '');
  const part: AiDocPart | null = parts.find((p) => p.id === partId) || parts[0] || null;
  const opts = part ? formatsOf(part) : [];
  const [format, setFormat] = useState<AiDocFormat>(part?.format || 'md');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<AiExportResult | null>(null);

  /* 默认目录从主进程取（那边已经处理了「机器上没有 D 盘」的回落） */
  useEffect(() => {
    void tryCall<string>(() => window.adbApi.aiExportDir()).then((d) => {
      if (d) setDir(d);
    });
  }, []);

  /* 换内容块 → 格式回到它自己的默认值。不这么做的话，从「整篇(pdf)」切到
     只有 csv/txt 的表格块时，下拉会停在一个不存在的选项上。 */
  useEffect(() => {
    const p = parts.find((x) => x.id === partId);
    if (p) setFormat(p.format);
  }, [partId, parts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ext = part ? extOfFormat(part, format) : '';
  const fileName = part ? `${part.baseName}${ext}` : '';
  const hint = opts.find((o) => o.value === format)?.hint || '';

  const buildReq = (): AiExportRequest => {
    const p = part!;
    const needHtml = format === 'html' || format === 'pdf';
    return {
      format,
      fileName: p.baseName,
      title: p.baseName,
      // md / txt / csv / 代码 / html 走 text；docx 与 pdf 另外要 markdown / html
      text: partToText(p, format),
      html: needHtml ? mdToHtml(p.content, p.baseName) : undefined,
      markdown: p.content,
      dir: dir.trim() || undefined,
      ext: p.ext,
    };
  };

  const save = async (asNew: boolean) => {
    if (!part || busy) return;
    setBusy(true);
    try {
      const base = buildReq();
      let targetPath: string | undefined;
      if (asNew) {
        const picked = await tryCall<string | null>(() => window.adbApi.aiExportPick(base));
        if (!picked) {
          setBusy(false);
          return; // 用户取消了「另存为」，什么都不做
        }
        targetPath = picked;
      }
      const r = await call<AiExportResult>(
        () => window.adbApi.aiExportSave({ ...base, targetPath }),
        { silent: true },
      );
      setSaved(r);
      toast(
        'success',
        '已导出',
        `${r.path}${r.renamed ? '（同名文件已存在，自动加了序号）' : ''}`,
      );
    } catch (e) {
      toast('error', '导出失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickDir = async () => {
    const d = await tryCall<string>(() => window.adbApi.pickDir());
    if (d) setDir(d);
  };

  return (
    <div className="ai-export-mask" role="dialog" aria-modal="true" aria-label="导出为文件">
      <div className="ai-export-card fade-in" data-export-dialog="1">
        <div className="ai-export-head">
          <strong>导出为文件</strong>
          <button type="button" className="ai-export-x" title="关闭" onClick={onClose}>
            {Icon.close}
          </button>
        </div>

        {!part ? (
          <p className="ai-export-empty">这条回复里没有可导出的内容</p>
        ) : (
          <>
            <Field label="导出内容" hint={`${part.chars.toLocaleString('zh-CN')} 字符`}>
              <Select
                value={part.id}
                onChange={(e) => setPartId(e.target.value)}
                options={parts.map((p) => ({ value: p.id, label: p.title }))}
              />
            </Field>

            <Field label="文件格式" hint={hint}>
              <Select
                value={format}
                onChange={(e) => setFormat(e.target.value as AiDocFormat)}
                options={opts.map((o) => ({ value: o.value, label: o.label }))}
              />
            </Field>

            <Field label="保存目录">
              <Input
                value={dir}
                placeholder="选择或输入一个目录"
                onChange={(e) => setDir(e.target.value)}
                suffix={
                  <button type="button" className="ai-key-toggle" onClick={() => void pickDir()}>
                    更改
                  </button>
                }
              />
            </Field>

            <p className="ai-export-name">
              文件名：<code>{fileName}</code>
              {!saved && <span className="ai-export-tip">同名文件已存在时会自动加序号，不会覆盖</span>}
            </p>

            {saved && (
              <Notice tone="success" onClose={() => setSaved(null)}>
                <div className="ai-export-saved">
                  <span className="ai-export-path" title={saved.path}>
                    {saved.path}
                  </span>
                  <span className="ai-export-saved-acts">
                    <button type="button" onClick={() => void window.adbApi.openPath(saved.path)}>
                      打开文件
                    </button>
                    <button type="button" onClick={() => void window.adbApi.reveal(saved.path)}>
                      打开文件夹
                    </button>
                  </span>
                </div>
              </Notice>
            )}

            <div className="ai-export-actions">
              <Button size="sm" variant="primary" loading={busy} onClick={() => void save(false)}>
                保存
              </Button>
              <Button size="sm" loading={busy} onClick={() => void save(true)}>
                另存为…
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                关闭
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/* 崩溃报告                                                            */
/* ================================================================== */

function ReportsPane() {
  const toast = useApp((s) => s.toast);
  const reports = useApp((s) => s.crashReports);
  const status = useApp((s) => s.crashStatus);
  const setCrashReports = useApp((s) => s.setCrashReports);
  const markCrashRead = useApp((s) => s.markCrashRead);

  const [openId, setOpenId] = useState<string | null>(null);
  const [full, setFull] = useState<CrashReportFull | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const refresh = useCallback(async () => {
    const list = await tryCall<CrashReportMeta[]>(() => window.adbApi.crashReports());
    if (list) setCrashReports(list);
  }, [setCrashReports]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * 推送里来了新报告（store 已经插到最前）时，如果用户正停在这一页，
   * 自动把它选中 —— 否则他只看到列表多了一条，还得再点一下。
   *
   * ⚠️ 用 `cur ?? ...` 而不是每次强制切到最新：用户正在读旧报告时，
   *    新报告一来就把视图拽走是很讨厌的。新那份留在列表顶部，他自己点。
   */
  useEffect(() => {
    if (reports.length === 0) return;
    setOpenId((cur) => cur ?? reports[0].id);
  }, [reports]);

  /*
   * 「正在看的那份」自动算已读 —— 红点表示「有报告你没看过」，
   * 既然全文已经摊在屏幕上了，就没什么可提醒的了。
   *
   * 🔴 只在这里消未读，别在 pick() 里也写一份：两处都写的话，
   *    「自动选中」这条路径（刷新后停在这一页）会漏掉，红点赖着不走。
   *    这里也不会自激 —— markCrashRead 把 read 改成 true 之后本 effect 再跑
   *    就不满足 `!m.read`，直接返回。
   */
  useEffect(() => {
    if (!openId) return;
    const m = reports.find((r) => r.id === openId);
    if (!m || m.read) return;
    markCrashRead(m.id);
    void window.adbApi.crashReportMarkRead(m.id, true);
  }, [openId, reports, markCrashRead]);

  useEffect(() => {
    if (!openId) {
      setFull(null);
      return;
    }
    let alive = true;
    setLoadingFull(true);
    void tryCall<CrashReportFull>(() => window.adbApi.crashReport(openId)).then((f) => {
      if (!alive) return;
      setFull(f);
      setLoadingFull(false);
    });
    return () => {
      alive = false;
    };
  }, [openId]);

  /* 点左侧列表 = 只是切换选中；「标记已读」由上面那个 effect 统一负责 */
  const pick = (m: CrashReportMeta) => setOpenId(m.id);

  const revealDir = (dir: string) => {
    void call(() => window.adbApi.revealCrashReport(dir, false), { silent: true }).catch((e) =>
      toast('error', '打开文件夹失败', (e as Error).message),
    );
  };

  const revealFile = (path: string) => {
    void call(() => window.adbApi.revealCrashReport(path, true), { silent: true }).catch((e) =>
      toast('error', '定位文件失败', (e as Error).message),
    );
  };

  const removeReport = async (m: CrashReportMeta) => {
    const list = await tryCall<CrashReportMeta[]>(() => window.adbApi.crashReportDelete(m.id));
    if (list) setCrashReports(list);
    if (openId === m.id) {
      setOpenId(null);
      setFull(null);
    }
    toast('info', '已从列表移除', '磁盘上的报告与日志文件没有被删除');
  };

  const analyzeNow = async () => {
    setAnalyzing(true);
    try {
      const meta = await call<CrashReportMeta>(() => window.adbApi.crashAnalyze(), { silent: true });
      await refresh();
      if (meta) {
        setOpenId(meta.id);
        toast('success', '分析完成', meta.summary);
      }
    } catch (e) {
      toast('error', '分析失败', (e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const watching = !!status?.watching;

  return (
    <div className="ai-reports">
      <div className={`ai-status ${watching ? 'on' : ''}`} data-crash-status={watching ? 'watching' : 'idle'}>
        <span className="ai-status-dot" />
        <div className="ai-status-text">
          <strong>{watching ? '正在监听闪退' : '未在监听'}</strong>
          <span>
            {watching
              ? `${status?.deviceLabel || status?.serial || ''}${
                  status?.foreground ? ` · 前台 ${status.foreground}` : ''
                }`
              : status?.note || '打开「检测崩溃自动AI分析日志」开关并开始投屏后自动生效'}
          </span>
        </div>
        <Badge tone="default">已生成 {status?.reportCount ?? reports.length}</Badge>
        <Button size="sm" onClick={() => void analyzeNow()} loading={analyzing}>
          立即分析当前应用
        </Button>
      </div>

      <div className="ai-layout">
        <aside className="ai-side">
          <div className="ai-side-head">
            <Button size="sm" variant="ghost" block onClick={() => void refresh()}>
              刷新列表
            </Button>
          </div>
          <div className="ai-sessions">
            {reports.length === 0 ? (
              <p className="ai-side-empty">还没有报告</p>
            ) : (
              reports.map((m) => (
                <div
                  key={m.id}
                  className={`ai-report-item ${m.id === openId ? 'on' : ''}`}
                  onClick={() => pick(m)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') pick(m);
                  }}
                >
                  <div className="ai-report-top">
                    {!m.read && <span className="ai-unread-dot" data-report-unread="1" />}
                    <span className="ai-report-pkg">{m.packageName || '未知应用'}</span>
                    <span className="ai-report-time">{formatTime(m.at)}</span>
                  </div>
                  <div className="ai-report-sum">{m.summary || '（无摘要）'}</div>
                  <div className="ai-report-dev">{m.deviceLabel}</div>
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="ai-report-detail">
          {!full ? (
            <Empty
              icon={Icon.report}
              title={loadingFull ? '正在读取报告…' : reports.length ? '选一份报告' : '暂无崩溃报告'}
              desc={
                reports.length
                  ? '左侧点开一份报告，这里显示全文'
                  : '开启「检测崩溃自动AI分析日志」后，投屏中前台应用闪退时会自动生成报告'
              }
            />
          ) : (
            <>
              <div className="ai-report-actions">
                <Button size="sm" variant="ghost" icon={Icon.pin} onClick={() => revealDir(full.meta.dir)}>
                  定位报告文件夹
                </Button>
                <Button size="sm" variant="ghost" onClick={() => revealFile(full.meta.reportPath)}>
                  定位报告文件
                </Button>
                {full.meta.logPath && (
                  <Button size="sm" variant="ghost" onClick={() => revealFile(full.meta.logPath)}>
                    定位日志文件
                  </Button>
                )}
                <span className="ai-spacer" />
                {full.meta.error && <Badge tone="danger">AI 分析未完成</Badge>}
                <Button size="sm" variant="ghost" icon={Icon.trash} onClick={() => void removeReport(full.meta)}>
                  移除
                </Button>
              </div>

              <div className="ai-report-meta">
                <div>
                  <span>崩溃发生时间</span>
                  <strong>{new Date(full.meta.at).toLocaleString('zh-CN')}</strong>
                </div>
                <div>
                  <span>设备名称</span>
                  <strong>{full.meta.deviceLabel}</strong>
                </div>
                <div>
                  <span>崩溃应用</span>
                  <strong>{full.meta.packageName || '未知'}</strong>
                </div>
                <div>
                  <span>分析模型</span>
                  <strong>{full.meta.model || '未调用'}</strong>
                </div>
                <div className="wide">
                  <span>产物目录</span>
                  <strong className="mono">{full.meta.dir}</strong>
                </div>
              </div>

              <div className="ai-report-body">
                {full.content === null ? (
                  <Notice tone="danger">
                    报告文件已不存在（可能被手动删除或在别处移动过）。索引仍保留，可点「移除」清掉它。
                  </Notice>
                ) : (
                  <MdView text={full.content} />
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ================================================================== */
/* 极简 Markdown 渲染                                                  */
/* ================================================================== */

/*
 * 只用得着报告与分析回复里出现的那几种语法（标题 / 列表 / 围栏代码 / 引用 / 分隔线 / 粗体 / 行内码）。
 * 不引第三方 Markdown 库：一是体积，二是**绝不**用 dangerouslySetInnerHTML ——
 * 报告里有一整段是设备日志原文，注入 HTML 就等于把日志当代码执行。
 */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={`${keyBase}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<code key={`${keyBase}-c${i++}`}>{tok.slice(1, -1)}</code>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type MdBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote' | 'hr' | 'pre'; text: string }
  | { type: 'table'; text: string; head: string[]; rows: string[][] };

export function MdView({ text }: { text: string }) {
  const blocks = useMemo<MdBlock[]>(() => {
    const lines = String(text || '')
      .replace(/^\ufeff/, '')
      .split(/\r?\n/);
    const out: MdBlock[] = [];
    let fence: string[] | null = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (/^\s*```/.test(raw)) {
        if (fence) {
          out.push({ type: 'pre', text: fence.join('\n') });
          fence = null;
        } else {
          fence = [];
        }
        continue;
      }
      if (fence) {
        fence.push(raw);
        continue;
      }
      /*
       * 表格：AI 回答里到处都是「字段 → 值」两列表（崩溃分析尤其多）。
       * 不认它的话，屏幕上就是一排原始竖线，和旁边能导出 csv 的能力完全对不上。
       * 判定与拆列复用 shared/ai-export 的 readMdTable —— 和导出走同一份实现。
       */
      const tbl = readMdTable(lines, i);
      if (tbl) {
        out.push({ type: 'table', text: '', head: tbl.head, rows: tbl.rows });
        i = tbl.next - 1;
        continue;
      }
      const l = raw.replace(/\s+$/, '');
      if (!l.trim()) {
        out.push({ type: 'p', text: '' });
        continue;
      }
      if (/^###\s+/.test(l)) out.push({ type: 'h3', text: l.replace(/^###\s+/, '') });
      else if (/^##\s+/.test(l)) out.push({ type: 'h2', text: l.replace(/^##\s+/, '') });
      else if (/^#\s+/.test(l)) out.push({ type: 'h1', text: l.replace(/^#\s+/, '') });
      else if (/^-{3,}$/.test(l.trim())) out.push({ type: 'hr', text: '' });
      else if (/^>\s?/.test(l)) out.push({ type: 'quote', text: l.replace(/^>\s?/, '') });
      else if (/^[-*]\s+/.test(l)) out.push({ type: 'li', text: l.replace(/^[-*]\s+/, '') });
      else out.push({ type: 'p', text: l });
    }
    if (fence) out.push({ type: 'pre', text: fence.join('\n') });
    return out;
  }, [text]);

  return (
    <div className="ai-md">
      {blocks.map((b, i) => {
        const k = `blk${i}`;
        switch (b.type) {
          case 'hr':
            return <hr key={k} />;
          case 'pre':
            return <pre key={k}>{b.text}</pre>;
          case 'table':
            return (
              <div className="ai-md-table-wrap" key={k}>
                <table className="ai-md-table">
                  <thead>
                    <tr>
                      {b.head.map((c, ci) => (
                        <th key={`h${ci}`}>{renderInline(c, `${k}-h${ci}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={`r${ri}`}>
                        {b.head.map((_, ci) => (
                          <td key={`c${ci}`}>{renderInline(r[ci] ?? '', `${k}-${ri}-${ci}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'h1':
            return <h2 key={k}>{renderInline(b.text, k)}</h2>;
          case 'h2':
            return <h3 key={k}>{renderInline(b.text, k)}</h3>;
          case 'h3':
            return <h4 key={k}>{renderInline(b.text, k)}</h4>;
          case 'li':
            return (
              <div className="ai-md-li" key={k}>
                <span>•</span>
                <span>{renderInline(b.text, k)}</span>
              </div>
            );
          case 'quote':
            return <blockquote key={k}>{renderInline(b.text, k)}</blockquote>;
          default:
            /* 空行不产出元素，避免报告里每隔几行就多一段空白 */
            return b.text ? <p key={k}>{renderInline(b.text, k)}</p> : null;
        }
      })}
    </div>
  );
}
