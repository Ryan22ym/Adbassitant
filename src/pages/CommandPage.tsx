import { useState, useRef, useEffect } from 'react';
import { Card, Button, Input, Notice, Badge, Empty } from '@/components/ui';
import { useApp, useCurrentDevice } from '@/store/app';
import { call } from '@/lib/ipc';
import type { CommandResult } from '@shared/types';

/** 常用命令快捷入口 */
const QUICK_COMMANDS: { label: string; cmd: string; desc: string }[] = [
  { label: '查看设备', cmd: 'devices -l', desc: '列出所有已连接设备' },
  { label: '设备信息', cmd: 'shell getprop ro.product.model', desc: '读取设备型号' },
  { label: '系统版本', cmd: 'shell getprop ro.build.version.release', desc: '读取 Android 版本' },
  { label: '当前 Activity', cmd: 'shell dumpsys window | grep mCurrentFocus', desc: '查看前台应用' },
  { label: '已安装包（三方）', cmd: 'shell pm list packages -3', desc: '列出第三方应用' },
  { label: '电池信息', cmd: 'shell dumpsys battery', desc: '电量、温度、充电状态' },
  { label: '内存信息', cmd: 'shell cat /proc/meminfo', desc: '查看内存占用' },
  { label: '安装 APK', cmd: 'install -r /sdcard/Download/app.apk', desc: '覆盖安装设备上的 APK' },
  { label: '卸载应用', cmd: 'uninstall com.example.app', desc: '卸载指定应用' },
  { label: '重启设备', cmd: 'reboot', desc: '重启 Android 设备' },
  { label: '关机', cmd: 'shell reboot -p', desc: '关闭设备电源' },
  { label: '屏幕常亮', cmd: 'shell svc power stayon true', desc: '禁止自动熄屏' },
  { label: '亮屏', cmd: 'shell input keyevent 26', desc: '切换屏幕电源键' },
  { label: '解锁滑动', cmd: 'shell input swipe 540 1800 540 600', desc: '模拟上滑解锁' },
  { label: 'ADB 版本', cmd: 'version', desc: '查看 adb 版本号' },
  { label: '重启到 Recovery', cmd: 'reboot recovery', desc: '进入恢复模式' },
];

interface HistoryItem {
  id: string;
  command: string;
  result: CommandResult;
}

export default function CommandPage() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const outRef = useRef<HTMLDivElement>(null);

  const run = async (raw?: string) => {
    const command = (raw ?? cmd).trim();
    if (!command) return;
    setBusy(true);
    try {
      const r = await call<CommandResult>(() => window.adbApi.runAdb(current?.serial, command), {
        silent: true,
      });
      setHistory((h) => [{ id: Math.random().toString(36).slice(2), command, result: r }, ...h].slice(0, 30));
      setCmd('');
      setHistoryIndex(-1);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* 上下箭头浏览历史 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      if (history[next]) {
        setHistoryIndex(next);
        setCmd(history[next].command);
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = historyIndex - 1;
      if (next < 0) {
        setHistoryIndex(-1);
        setCmd('');
      } else if (history[next]) {
        setHistoryIndex(next);
        setCmd(history[next].command);
      }
    }
  };

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = 0;
  }, [history.length]);

  return (
    <>
      <Card
        title="命令输入"
        subtitle={
          current
            ? `命令将自动附加 -s ${current.serial}（如已自带 -s/-d/-e 则不追加）`
            : '未选择设备，命令将不带 -s 参数执行'
        }
        extra={current ? <Badge tone="accent">{current.serial}</Badge> : undefined}
      >
        <div className="col">
          <div className="row">
            <span className="prompt-prefix mono">adb</span>
            <Input
              className="mono"
              placeholder="shell dumpsys battery"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <Button variant="primary" onClick={() => run()} loading={busy} style={{ flex: 'none' }}>
              执行
            </Button>
          </div>
          <p className="text-dim">
            可直接输入 adb 子命令（不必带 adb 前缀）。↑ / ↓ 可翻阅历史命令，
            Enter 执行。
          </p>
        </div>
      </Card>

      <Card title="常用命令" subtitle="点击直接执行">
        <div className="quick-grid">
          {QUICK_COMMANDS.map((q) => (
            <button
              key={q.cmd}
              className="quick-item"
              onClick={() => run(q.cmd)}
              disabled={busy}
              title={q.cmd}
            >
              <span className="quick-label">{q.label}</span>
              <span className="quick-desc">{q.desc}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card
        title="执行结果"
        extra={
          history.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setHistory([])}>
              清空
            </Button>
          ) : undefined
        }
      >
        {history.length === 0 ? (
          <Empty title="还没有执行记录" desc="在上方输入命令或点击常用命令快捷按钮" />
        ) : (
          <div className="col" ref={outRef}>
            {history.map((h) => (
              <div key={h.id} className="result-item fade-in">
                <div className="result-head">
                  <span className="result-cmd mono">
                    <span className="prompt-prefix">adb</span> {h.command}
                  </span>
                  <div className="row" style={{ gap: 6, flex: 'none' }}>
                    <Badge tone={h.result.ok ? 'success' : 'danger'}>
                      {h.result.ok ? '成功' : `失败 ${h.result.code ?? ''}`}
                    </Badge>
                    <Badge tone="default">{h.result.duration}ms</Badge>
                  </div>
                </div>
                {(h.result.stdout || h.result.stderr) && (
                  <div className="output-block">
                    {h.result.stdout}
                    {h.result.stderr && (
                      <span className="stderr-text">{'\n' + h.result.stderr}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Notice tone="accent">
        提示：带空格或中文的参数请用英文双引号包裹，例如{' '}
        <span className="mono">shell input text "hello world"</span>。
      </Notice>
    </>
  );
}
