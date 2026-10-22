import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Card, Button, Badge, Empty, Segmented, Input, Field, Select, Notice } from '@/components/ui';
import { useApp, useCurrentDevice } from '@/store/app';
import { usePanelOpen } from '@/lib/ui-conf';
import { call } from '@/lib/ipc';
import type {
  LogcatFilter,
  LogcatHistory,
  LogcatLevel,
  LogcatLine,
  LogcatStatus,
} from '@shared/types';

/**
 * 实时 Logcat。
 *
 * v1.1.15 的三处改动，都是围绕「日志一多、页面一切就变糊」这个问题：
 *
 * ① **虚拟滚动**（只画视口那几十行）
 *    以前是把最多 4000 行全部渲染成 DOM —— 每行 6 个 span，等于 2 万多个节点，
 *    主进程每 120ms 推一批就要整棵树 reconcile 一次，设备刷屏时界面直接卡死。
 *    现在按固定行高（ROW_H）算「当前该显示哪一段」，DOM 节点数与日志总量脱钩。
 *
 * ② **切页回来能接上**（logcat:history 回放）
 *    本页是路由组件，切到别的模块就卸载、lines 跟着销毁，而主进程那条 adb logcat
 *    还在跑 —— 回来一片空白，看着像抓取自己停了。现在挂载时把主进程环形缓冲里的
 *    最近 N 行取回来铺上，再接着收推送。
 *
 * ③ **后台保持抓取**开关（设置持久化，默认开）
 *    勾着：离开页面不停会话（配合 ② 就是「在别的页面操作设备 → 回来接着看」）；
 *    不勾：离开页面就停掉，省 CPU 与 USB 带宽。
 */

/** 界面保留的最大行数（主进程回放缓冲同量级，见 services/logcat.ts 的 MAX_RECENT） */
const MAX_LINES = 4000;
/** 固定行高（px）。虚拟滚动靠它换算位置，改这里必须同步改 .logcat-line 的 height */
const ROW_H = 22;
/** 视口上下各多渲染几行，滚动时不会露白 */
const OVERSCAN = 10;

/**
 * 离开页面后延迟多久真正停掉会话。
 *
 * 🔴 不是随手加的：React 的 StrictMode 会「挂载 → 立刻卸载 → 再挂载」，
 *    同步就会跑一次 cleanup。若在 cleanup 里直接 stopLogcat()，开发模式下
 *    一切页面回来就把后台抓取杀了。延迟一小会儿，第二次挂载能把这个待停任务取消掉。
 */
let pendingStop: ReturnType<typeof setTimeout> | null = null;

const LEVELS: { value: LogcatLevel; label: string }[] = [
  { value: 'V', label: 'V' },
  { value: 'D', label: 'D' },
  { value: 'I', label: 'I' },
  { value: 'W', label: 'W' },
  { value: 'E', label: 'E' },
  { value: 'F', label: 'F' },
];

const LEVEL_CN: Record<string, string> = {
  V: 'Verbose',
  D: 'Debug',
  I: 'Info',
  W: 'Warn',
  E: 'Error',
  F: 'Fatal',
};

const BUFFERS = ['main', 'system', 'crash', 'events'];

interface ProcEntry {
  pid: number;
  name: string;
}

/** 只留最近 MAX_LINES 行（环形语义，与主进程一致） */
function trimLines(list: LogcatLine[]): LogcatLine[] {
  return list.length > MAX_LINES ? list.slice(list.length - MAX_LINES) : list;
}

export default function LogcatPage() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  /* 后台保持抓取（v1.1.15）：持久化在 settings.json */
  const keepBackground = useApp((s) => s.settings?.logcatKeepBackground ?? true);
  const setSettings = useApp((s) => s.setSettings);

  /* 运行状态 */
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<LogcatStatus | null>(null);

  /* 过滤条件 */
  const [minLevel, setMinLevel] = useState<LogcatLevel>('V');
  const [tagFilter, setTagFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [buffers, setBuffers] = useState<string[]>(['main', 'system', 'crash']);
  const [procFilter, setProcFilter] = useState('');
  const [procs, setProcs] = useState<ProcEntry[]>([]);
  const [loadingProcs, setLoadingProcs] = useState(false);

  /* 视图 */
  const [lines, setLines] = useState<LogcatLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  /*
   * 界面配置（Conf/panels.json 的 logcat.*）：
   *   stream —— 日志主体默认展开还是收起；
   *   filter —— 过滤面板默认展不展开。
   * 配置是启动后异步到位的，所以过滤面板这里要跟一次（useState 初值只取一次）。
   */
  const streamOpen = usePanelOpen('logcat', 'stream');
  const filterConfOpen = usePanelOpen('logcat', 'filter');
  const [showFilter, setShowFilter] = useState(filterConfOpen);
  useEffect(() => {
    setShowFilter(filterConfOpen);
  }, [filterConfOpen]);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  /* 暂停期间累计的行，恢复时一次性合并 */
  const heldRef = useRef<LogcatLine[]>([]);
  /* 上次生效的设备序列号，用来区分「首次挂载」与「真的切设备」 */
  const prevSerialRef = useRef<string | undefined>(undefined);
  /*
   * 回放是否已经铺好（v1.1.15）。
   * 挂载那一刻推送可能已经先到了 —— 那几批必须**先攒着**，等历史行铺完再按 seq
   * 去重合并，否则「先收到的新行」会被随后的「历史行」覆盖掉，或者重复出现。
   */
  const historyReadyRef = useRef(false);
  const earlyRef = useRef<LogcatLine[]>([]);
  /* 离页停抓要用最新值，不能靠闭包（cleanup 里读不到更新后的 props） */
  const keepRef = useRef(keepBackground);
  keepRef.current = keepBackground;

  /* ---------- 推送订阅 ---------- */
  useEffect(() => {
    const offLines = window.adbApi.on('push:logcatLines', (batch: LogcatLine[]) => {
      if (!Array.isArray(batch) || batch.length === 0) return;

      // 历史还没铺好：先攒着（上限按 MAX_LINES 兜住，别让极端刷屏把内存吃掉）
      if (!historyReadyRef.current) {
        earlyRef.current = trimLines(earlyRef.current.concat(batch));
        return;
      }

      if (pausedRef.current) {
        heldRef.current = trimLines(heldRef.current.concat(batch));
        return;
      }
      setLines((prev) => trimLines(prev.concat(batch)));
    });

    const offStatus = window.adbApi.on('push:logcatStatus', (s: LogcatStatus) => {
      setStatus(s);
      setRunning(!!s.running);
    });

    return () => {
      offLines();
      offStatus();
    };
  }, []);

  /* ---------- 回放：把切页期间抓到的行铺回来（v1.1.15） ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const h = await call<LogcatHistory>(() => window.adbApi.logcatHistory(MAX_LINES), {
        silent: true,
      });
      if (cancelled) return;

      const base = h?.lines ?? [];
      const lastSeq = base.length ? base[base.length - 1].seq : 0;
      // 只补「历史里没有的」新行（seq 单调递增，比按 raw 去重可靠）
      const extra = earlyRef.current.filter((l) => l.seq > lastSeq);
      earlyRef.current = [];
      historyReadyRef.current = true;

      if (base.length || extra.length) {
        setLines(trimLines(base.concat(extra)));
      }
      if (h?.status) {
        setStatus(h.status);
        setRunning(!!h.status.running);
      } else {
        /*
         * 回放拿不到（IPC 出错 / 老版本主进程）：退回到「只读一次状态」。
         * 少了这一步，页面会显示「已停止」而主进程其实还在推 —— 比没有回放更误导。
         */
        const st = await call<LogcatStatus>(() => window.adbApi.logcatStatus(), { silent: true });
        if (!cancelled && st) {
          setStatus(st);
          setRunning(!!st.running);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- 离开页面：按配置决定要不要停掉后台抓取 ---------- */
  useEffect(() => {
    // 回到本页就把待停任务取消掉（StrictMode 的立即重挂载 / 用户快速来回切）
    if (pendingStop) {
      clearTimeout(pendingStop);
      pendingStop = null;
    }
    return () => {
      if (keepRef.current) return;
      if (pendingStop) clearTimeout(pendingStop);
      pendingStop = setTimeout(() => {
        pendingStop = null;
        void window.adbApi.stopLogcat();
      }, 150);
    };
  }, []);

  /* ---------- 恢复时把暂存行并回去 ---------- */
  useEffect(() => {
    if (!paused && heldRef.current.length > 0) {
      const held = heldRef.current;
      heldRef.current = [];
      setLines((prev) => trimLines(prev.concat(held)));
    }
  }, [paused]);

  /* ---------- 虚拟滚动：视口高度 ---------- */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(420);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const sync = () => setViewH(el.clientHeight || 420);
    sync();
    // 窗口缩放 / 卡片展开收起都会改高度，用 ResizeObserver 跟着走
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- 自动滚动 ---------- */
  useEffect(() => {
    const el = viewRef.current;
    if (autoScroll && el) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [lines.length, autoScroll]);

  const buildFilter = useCallback((): Partial<LogcatFilter> => ({
    minLevel,
    tags: tagFilter.trim() || undefined,
    keyword: keyword.trim() || undefined,
    buffers,
    process: procFilter || undefined,
  }), [minLevel, tagFilter, keyword, buffers, procFilter]);

  const start = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setBusy(true);
    setLines([]);
    heldRef.current = [];
    earlyRef.current = [];
    historyReadyRef.current = true;
    try {
      const s = await call<LogcatStatus>(
        () => window.adbApi.startLogcat(current.serial, buildFilter()),
        { silent: true },
      );
      setStatus(s);
      setRunning(!!s?.running);
      toast('success', '已开始抓取 Logcat');
    } catch (e) {
      toast('error', '启动失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await call(() => window.adbApi.stopLogcat(), { silent: true });
      setRunning(false);
      toast('info', '已停止抓取');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setLines([]);
    heldRef.current = [];
    await call(() => window.adbApi.clearLogcat(), { silent: true });
  };

  const save = async () => {
    if (lines.length === 0) return toast('warn', '当前没有内容可保存');
    setSaving(true);
    try {
      const meta: Record<string, string> = {
        '设备': current ? `${current.brand || ''} ${current.model || ''} (${current.serial})` : '未知',
        '级别': `>=${minLevel} (${LEVEL_CN[minLevel]})`,
        '缓冲区': buffers.join(', '),
      };
      if (tagFilter.trim()) meta['TAG 过滤'] = tagFilter.trim();
      if (keyword.trim()) meta['关键字'] = keyword.trim();
      if (procFilter) meta['进程'] = procFilter;

      const r = await call<{ path: string; bytes: number; lines: number } | null>(
        () => window.adbApi.saveLogcat(meta),
        { silent: true },
      );
      if (r) {
        toast('success', `已保存 ${r.lines} 行`, r.path);
        window.adbApi.reveal(r.path);
      }
    } catch (e) {
      toast('error', '保存失败', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const loadProcs = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setLoadingProcs(true);
    try {
      const r = await call<ProcEntry[]>(() => window.adbApi.logcatProcesses(current.serial), {
        silent: true,
      });
      setProcs(r || []);
      toast('success', `已读取 ${r?.length || 0} 个进程`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setLoadingProcs(false);
    }
  };

  /* 设备切换时重置 */
  useEffect(() => {
    const serial = current?.serial;
    const prev = prevSerialRef.current;
    prevSerialRef.current = serial;

    setProcs([]);
    setProcFilter('');

    // 首次挂载（prev 未初始化）或设备没变时，不动抓取会话与界面日志。
    // 挂载时不动作很重要：离开页面再回来会重新挂载，此时主进程的抓取仍在跑，
    // 不能因为「重新挂载」就把后台的抓取停掉。
    if (prev === undefined || serial === prev) return;

    /*
     * 设备真的切走了：主进程里那个抓取会话还绑在旧设备上，会继续往这里推
     * 旧设备的行，而「保存为文件」导出的也是旧设备会话的 buffer —— 这就是
     * 用户看到的「切了设备导出还是旧设备日志」。必须先停掉旧会话再清空界面。
     *
     * 先停后清：stopLogcat 会把最后一波 pending 行 flush 过来，等它返回再清，
     * 才不会让那最后一波又把界面填回旧设备的内容。
     */
    let cancelled = false;
    (async () => {
      await call(() => window.adbApi.stopLogcat(), { silent: true });
      if (cancelled) return;
      setLines([]);
      heldRef.current = [];
      setRunning(false);
      setStatus(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.serial]);

  /* 前端二次过滤（关键字/TAG 变动时立即生效，不必重启抓取） */
  const visible = useMemo(() => {
    let list = lines;
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter((l) => l.raw.toLowerCase().includes(kw));
    }
    const tags = tagFilter.trim();
    if (tags) {
      const pats = tags.split(',').map((x) => x.trim()).filter(Boolean);
      list = list.filter((l) => pats.some((p) => wildOk(p, l.tag || '')));
    }
    if (procFilter) {
      list = list.filter((l) => l.raw.toLowerCase().includes(procFilter.toLowerCase()));
    }
    return list;
  }, [lines, keyword, tagFilter, procFilter]);

  /*
   * 只算「该画哪一段」（v1.1.15）。DOM 节点数由此固定在
   * (视口高度 / 行高) + 2×OVERSCAN，跟日志总量没有关系 ——
   * 这就是以前「日志一多就卡死」的根治点。
   */
  const winStart = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const winEnd = Math.min(
    visible.length,
    Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN,
  );
  const winRows = useMemo(
    () => visible.slice(winStart, Math.max(winStart, winEnd)),
    [visible, winStart, winEnd],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of lines) {
      const k = l.level || '?';
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }, [lines]);

  const toggleBuffer = (b: string) => {
    setBuffers((prev) => {
      if (prev.includes(b)) {
        const next = prev.filter((x) => x !== b);
        return next.length ? next : prev;
      }
      return [...prev, b];
    });
  };

  /** 后台保持抓取：写 store + 落盘（settings.json） */
  const toggleKeep = (v: boolean) => {
    const st = useApp.getState();
    if (st.settings) setSettings({ ...st.settings, logcatKeepBackground: v });
    void window.adbApi.setSettings({ logcatKeepBackground: v });
  };

  return (
    <>
      <Card
        collapsible
        defaultOpen={streamOpen}
        padding={false}
        title="实时 Logcat"
        subtitle="流式抓取设备日志，支持级别 / TAG / 关键字 / 进程过滤，可一键保存"
        extra={
          <>
            {running ? (
              <Badge tone="success" dot>
                抓取中 {status?.lines ?? 0} 行
              </Badge>
            ) : (
              <Badge tone="default">已停止</Badge>
            )}
            <Button size="sm" variant="ghost" onClick={() => setShowFilter((v) => !v)}>
              {showFilter ? '收起过滤' : '过滤设置'}
            </Button>
          </>
        }
      >
        <div className="log-toolbar">
          <Segmented
            size="sm"
            value={minLevel}
            onChange={setMinLevel}
            options={LEVELS.map((l) => ({
              value: l.value,
              label: `${l.label}${counts[l.value] ? ` ${counts[l.value]}` : ''}`,
            }))}
          />
          <Input
            placeholder="关键字（逗号分隔）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ maxWidth: 200, height: 28 }}
          />
          <Input
            placeholder="TAG 过滤，支持 *"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            style={{ maxWidth: 180, height: 28 }}
          />
          {/*
            两个勾选项挤在右侧：自动滚动（看日志时最常用）在前，
            后台保持抓取紧随其后。后者是 v1.1.15 新增的持久化偏好，
            勾上之后切到别的模块，抓取不会中断，回来还能接着看。
          */}
          <div className="log-toolbar-toggles">
            <label className="auto-scroll" title="新日志到达时自动滚到底部">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              自动滚动
            </label>
            <label
              className="auto-scroll"
              title="勾选后切到别的模块仍继续抓取；取消勾选则离开本页即停止"
              data-logcat-keep="1"
            >
              <input
                type="checkbox"
                checked={keepBackground}
                onChange={(e) => toggleKeep(e.target.checked)}
              />
              后台保持抓取
            </label>
          </div>
        </div>

        {showFilter && (
          <div className="logcat-filter fade-in">
            <div className="grid-3">
              <Field label="缓冲区">
                <div className="row row-wrap" style={{ gap: 8 }}>
                  {BUFFERS.map((b) => (
                    <button
                      key={b}
                      className={`chip ${buffers.includes(b) ? 'on' : ''}`}
                      onClick={() => toggleBuffer(b)}
                      disabled={running}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="进程过滤" hint="子串匹配">
                <div className="row">
                  <Select
                    value={procFilter}
                    onChange={(e) => setProcFilter(e.target.value)}
                    options={[
                      { value: '', label: procs.length ? '不限进程' : '点右侧读取进程' },
                      ...procs.map((p) => ({ value: p.name, label: `${p.name} (${p.pid})` })),
                    ]}
                  />
                  <Button
                    variant="default"
                    onClick={loadProcs}
                    loading={loadingProcs}
                    disabled={!current}
                    style={{ flex: 'none' }}
                  >
                    读取
                  </Button>
                </div>
              </Field>

              <Field label="快捷过滤">
                <div className="row row-wrap" style={{ gap: 6 }}>
                  <button className="chip" onClick={() => setMinLevel('E')}>
                    只看错误
                  </button>
                  <button
                    className="chip"
                    onClick={() => {
                      setKeyword('crash,FATAL,ANR,Exception');
                      setMinLevel('V');
                    }}
                  >
                    闪退/ANR
                  </button>
                  <button
                    className="chip"
                    onClick={() => {
                      setTagFilter('ActivityManager');
                      setMinLevel('I');
                    }}
                  >
                    Activity 启动
                  </button>
                  <button
                    className="chip"
                    onClick={() => {
                      setTagFilter('');
                      setKeyword('');
                      setProcFilter('');
                      setMinLevel('V');
                    }}
                  >
                    重置
                  </button>
                </div>
              </Field>
            </div>

            <Notice tone="accent">
              抓取过程中修改级别 / TAG / 关键字会自动生效，不需要重新开始。
              缓冲区变更需要重启抓取。建议先用「main + system + crash」覆盖常见排障场景。
            </Notice>
          </div>
        )}

        <div
          className="log-view logcat-view"
          ref={viewRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {visible.length === 0 ? (
            <Empty
              title={running ? '等待日志输出…' : '还没有日志'}
              desc={
                running
                  ? '设备有日志产生时会实时出现在这里'
                  : '点击右上角「开始抓取」，可实时查看设备运行日志'
              }
            />
          ) : (
            /*
             * 虚拟滚动的两层：
             *   .log-spacer 撑出完整高度（滚动条长度才对）；
             *   .log-window 用 translateY 把自己挪到「这一段」应该在的位置。
             * 🔴 必须是 transform 而不是 padding-top：padding 会在每帧触发重排，
             *    滚动时肉眼可见地发涩。
             */
            <div className="log-spacer" style={{ height: visible.length * ROW_H }}>
              <div className="log-window" style={{ transform: `translateY(${winStart * ROW_H}px)` }}>
                {winRows.map((l) => (
                  <LogcatRow key={l.seq} line={l} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="logcat-foot">
          <Button
            variant={running ? 'default' : 'primary'}
            onClick={running ? stop : start}
            loading={busy}
            disabled={!current}
          >
            {running ? '停止抓取' : '开始抓取'}
          </Button>

          <Button variant="default" onClick={() => setPaused((v) => !v)} disabled={!running}>
            {paused ? '恢复刷新' : '暂停刷新'}
          </Button>

          <Button variant="ghost" onClick={clear} disabled={lines.length === 0}>
            清空
          </Button>

          <Button variant="primary" onClick={save} loading={saving} disabled={lines.length === 0}>
            保存为文件
          </Button>

          <div className="spacer" />
          <span className="text-dim">
            {visible.length === lines.length
              ? `${lines.length} 行`
              : `${visible.length} / ${lines.length} 行`}
            {paused && ' · 已暂停'}
          </span>
        </div>
      </Card>
    </>
  );
}

function LogcatRow({ line }: { line: LogcatLine }) {
  /*
   * 行高固定（ROW_H），超长内容靠 ellipsis 截断 + title 悬浮看全文。
   * 虚拟滚动要求每行等高，所以这里不能像以前那样自动换行 —— 换行了位置就算不准。
   */
  if (line.rawOnly || !line.level) {
    return (
      <div className="log-line logcat-line lv-info" title={line.raw}>
        <span className="log-msg">{line.raw}</span>
      </div>
    );
  }

  return (
    <div className={`log-line logcat-line lv-${levelTone(line.level)}`} title={line.raw}>
      <span className="log-time">{line.time}</span>
      <span className="logcat-pid">{line.pid}</span>
      <span className={`logcat-level lvl-${line.level}`}>{line.level}</span>
      <span className="logcat-tag" title={line.tag}>
        {line.tag}
      </span>
      <span className="log-msg">{line.message}</span>
    </div>
  );
}

function levelTone(l: LogcatLevel): string {
  switch (l) {
    case 'W':
      return 'warn';
    case 'E':
    case 'F':
      return 'error';
    case 'I':
      return 'success';
    case 'D':
      return 'command';
    default:
      return 'info';
  }
}

function wildOk(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.toLowerCase().includes(pattern.toLowerCase());
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
}
