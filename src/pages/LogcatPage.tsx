import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Card, Button, Badge, Empty, Segmented, Input, Field, Select, Notice, Switch } from '@/components/ui';
import { useApp, useCurrentDevice } from '@/store/app';
import { call } from '@/lib/ipc';
import type { LogcatFilter, LogcatLevel, LogcatLine, LogcatStatus } from '@shared/types';

const MAX_LINES = 4000;

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

export default function LogcatPage() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);

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
  const [showFilter, setShowFilter] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  /* 暂停期间累计的行，恢复时一次性合并 */
  const heldRef = useRef<LogcatLine[]>([]);

  /* ---------- 推送订阅 ---------- */
  useEffect(() => {
    const offLines = window.adbApi.on('push:logcatLines', (batch: LogcatLine[]) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      if (pausedRef.current) {
        heldRef.current.push(...batch);
        if (heldRef.current.length > MAX_LINES) {
          heldRef.current.splice(0, heldRef.current.length - MAX_LINES);
        }
        return;
      }
      setLines((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
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

  /* ---------- 恢复时把暂存行并回去 ---------- */
  useEffect(() => {
    if (!paused && heldRef.current.length > 0) {
      const held = heldRef.current;
      heldRef.current = [];
      setLines((prev) => {
        const next = prev.concat(held);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }
  }, [paused]);

  /* ---------- 自动滚动 ---------- */
  useEffect(() => {
    if (autoScroll && viewRef.current) {
      viewRef.current.scrollTop = viewRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  /* ---------- 挂载时读取一次运行状态（页面切换后回来不丢） ---------- */
  useEffect(() => {
    (async () => {
      const s = await call<LogcatStatus>(() => window.adbApi.logcatStatus(), { silent: true });
      if (s) {
        setStatus(s);
        setRunning(!!s.running);
      }
    })();
  }, []);

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
    setProcs([]);
    setProcFilter('');
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

  const notRootHint = false;

  return (
    <>
      <Card
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
          <label className="auto-scroll">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            自动滚动
          </label>
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

        <div className="log-view logcat-view" ref={viewRef}>
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
            visible.map((l) => <LogcatRow key={l.seq} line={l} />)
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
  if (line.rawOnly || !line.level) {
    return (
      <div className="log-line lv-info">
        <span className="log-msg">{line.raw}</span>
      </div>
    );
  }

  return (
    <div className={`log-line lv-${levelTone(line.level)}`}>
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
