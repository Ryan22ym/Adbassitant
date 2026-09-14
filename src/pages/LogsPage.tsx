import { useState, useRef, useEffect, useMemo } from 'react';
import { Card, Button, Badge, Empty, Segmented, Input } from '@/components/ui';
import { useApp } from '@/store/app';
import { call } from '@/lib/ipc';
import { formatTime } from '@/lib/format';
import type { LogEntry, LogLevel } from '@shared/types';

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: '信息',
  success: '成功',
  warn: '警告',
  error: '错误',
  command: '命令',
};

export default function LogsPage() {
  const logs = useApp((s) => s.logs);
  const clearLogs = useApp((s) => s.clearLogs);
  const toast = useApp((s) => s.toast);

  const [filter, setFilter] = useState<'all' | LogLevel>('all');
  const [keyword, setKeyword] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [exporting, setExporting] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    let list = logs;
    if (filter !== 'all') list = list.filter((l) => l.level === filter);
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase();
      list = list.filter(
        (l) =>
          l.message.toLowerCase().includes(k) ||
          l.source.toLowerCase().includes(k) ||
          (l.detail || '').toLowerCase().includes(k),
      );
    }
    return list;
  }, [logs, filter, keyword]);

  /* 自动滚动到底部 */
  useEffect(() => {
    if (autoScroll && viewRef.current) {
      viewRef.current.scrollTop = viewRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: logs.length };
    for (const l of logs) c[l.level] = (c[l.level] || 0) + 1;
    return c;
  }, [logs]);

  const doExport = async () => {
    if (logs.length === 0) {
      toast('warn', '当前没有日志可导出');
      return;
    }
    setExporting(true);
    try {
      const r = await call<{ path: string; bytes: number; lines: number } | null>(
        () => window.adbApi.exportLogs(),
        { silent: true },
      );
      if (r) {
        toast('success', '日志已导出', r.path);
        window.adbApi.reveal(r.path);
      }
    } catch (e) {
      toast('error', '导出失败', (e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const doClear = async () => {
    clearLogs();
    await window.adbApi.clearLogs();
    toast('info', '日志已清空');
  };

  return (
    <Card
      title="运行日志"
      subtitle="实时记录所有 adb 命令与操作结果，可一键导出为文本文件"
      extra={
        <>
          <Badge tone="default">{filtered.length} / {logs.length} 条</Badge>
          <Button size="sm" variant="primary" onClick={doExport} loading={exporting}>
            导出日志
          </Button>
          <Button size="sm" variant="ghost" onClick={doClear} disabled={logs.length === 0}>
            清空
          </Button>
        </>
      }
      padding={false}
    >
      <div className="log-toolbar">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `全部 ${counts.all || 0}` },
            { value: 'command', label: `命令 ${counts.command || 0}` },
            { value: 'success', label: `成功 ${counts.success || 0}` },
            { value: 'warn', label: `警告 ${counts.warn || 0}` },
            { value: 'error', label: `错误 ${counts.error || 0}` },
          ]}
        />
        <Input
          placeholder="搜索关键字…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ maxWidth: 220, height: 28 }}
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

      <div className="log-view" ref={viewRef}>
        {filtered.length === 0 ? (
          <Empty
            title={logs.length === 0 ? '暂无日志' : '没有匹配的记录'}
            desc={
              logs.length === 0
                ? '执行任意操作后，这里会实时显示命令与结果'
                : '试试调整筛选条件或清空搜索关键字'
            }
          />
        ) : (
          filtered.map((l) => <LogLine key={l.id} entry={l} />)
        )}
      </div>
    </Card>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!entry.detail;

  return (
    <>
      <div
        className={`log-line lv-${entry.level} ${hasDetail ? 'clickable' : ''}`}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <span className="log-time">{formatTime(entry.time, true)}</span>
        <span className={`log-level-badge lvb-${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
        <span className="log-source">{entry.source}</span>
        <span className="log-msg">{entry.message}</span>
        {hasDetail && <span className="log-toggle">{open ? '收起' : '详情'}</span>}
      </div>
      {open && hasDetail && <div className="log-detail">{entry.detail}</div>}
    </>
  );
}
