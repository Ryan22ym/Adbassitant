import { useState } from 'react';
import { Card, Button, Field, Input, Select, Switch, Notice, Badge, Segmented } from '@/components/ui';
import { useApp, useCurrentDevice } from '@/store/app';
import { call } from '@/lib/ipc';
import { formatDuration } from '@/lib/format';

const PRESETS = [
  { label: '流畅（1080 / 4Mbps / 30fps）', maxSize: 1080, bitRate: 4, fps: 30 },
  { label: '均衡（1440 / 8Mbps / 60fps）', maxSize: 1440, bitRate: 8, fps: 60 },
  { label: '高清（1920 / 16Mbps / 60fps）', maxSize: 1920, bitRate: 16, fps: 60 },
  { label: '超清（2560 / 24Mbps / 60fps）', maxSize: 2560, bitRate: 24, fps: 60 },
];

export default function MirrorPage() {
  const mirror = useApp((s) => s.mirror);
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);

  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState('1');
  const [custom, setCustom] = useState(false);
  const [maxSize, setMaxSize] = useState(1440);
  const [bitRate, setBitRate] = useState(8);
  const [fps, setFps] = useState(60);
  const [noAudio, setNoAudio] = useState(true);
  const [stayAwake, setStayAwake] = useState(true);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [keyboard, setKeyboard] = useState<'sdk' | 'uhid' | 'disabled'>('sdk');

  const applyPreset = (idx: string) => {
    setPreset(idx);
    const p = PRESETS[parseInt(idx, 10)];
    if (p) {
      setMaxSize(p.maxSize);
      setBitRate(p.bitRate);
      setFps(p.fps);
    }
  };

  const start = async () => {
    if (!current) {
      toast('warn', '请先连接设备');
      return;
    }
    setBusy(true);
    try {
      await call(
        () =>
          window.adbApi.startMirror({
            serial: current.serial,
            maxSize,
            bitRateMbps: bitRate,
            maxFps: fps,
            noAudio,
            stayAwake,
            alwaysOnTop,
            keyboard,
          }),
        { successMessage: '投屏窗口已启动' },
      );
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await call(() => window.adbApi.stopMirror(), { successMessage: '投屏已停止' });
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* 状态卡 */}
      <Card
        title="投屏状态"
        extra={
          mirror.running ? (
            <Badge tone="success" dot>
              运行中
            </Badge>
          ) : (
            <Badge tone="default">未启动</Badge>
          )
        }
      >
        {mirror.running ? (
          <div className="col">
            <div className="kv-list">
              <Item k="设备" v={mirror.serial} />
              <Item k="进程 PID" v={mirror.pid} />
              <Item
                k="运行时长"
                v={mirror.startedAt ? formatDuration(Date.now() - mirror.startedAt) : '—'}
              />
              <Item
                k="当前参数"
                v={
                  mirror.options
                    ? `${mirror.options.maxSize}px · ${mirror.options.bitRateMbps}Mbps · ${mirror.options.maxFps}fps`
                    : '—'
                }
              />
            </div>
            <div className="row">
              <Button variant="danger" onClick={stop} loading={busy}>
                停止投屏
              </Button>
              <span className="text-dim">
                投屏画面在独立窗口中显示，关闭该窗口即结束投屏。
              </span>
            </div>
          </div>
        ) : (
          <div className="col">
            <p className="text-dim">
              点击下方「启动投屏」后，将弹出一个独立的投屏窗口。窗口内可用鼠标操作手机、
              用键盘输入文字，支持 Ctrl+C / Ctrl+V 双向剪贴板同步。
            </p>
            <div className="row">
              <Button variant="primary" onClick={start} loading={busy} disabled={!current}>
                启动投屏
              </Button>
              {!current && <span className="text-dim">请先连接设备</span>}
            </div>
          </div>
        )}
      </Card>

      {/* 参数配置 */}
      <Card title="画质与行为" subtitle="启动前可调整，重启投屏后生效">
        <div className="col">
          <Field label="画质预设">
            <Select
              value={preset}
              onChange={(e) => {
                applyPreset(e.target.value);
                setCustom(false);
              }}
              options={PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
              disabled={mirror.running}
            />
          </Field>

          <div className="grid-3">
            <Field label="最大边长" hint="px">
              <Input
                type="number"
                value={maxSize}
                min={480}
                max={4096}
                step={120}
                disabled={mirror.running}
                onChange={(e) => {
                  setMaxSize(parseInt(e.target.value, 10) || 0);
                  setCustom(true);
                }}
              />
            </Field>
            <Field label="码率" hint="Mbps">
              <Input
                type="number"
                value={bitRate}
                min={1}
                max={50}
                disabled={mirror.running}
                onChange={(e) => {
                  setBitRate(parseInt(e.target.value, 10) || 0);
                  setCustom(true);
                }}
              />
            </Field>
            <Field label="最大帧率" hint="fps">
              <Input
                type="number"
                value={fps}
                min={15}
                max={144}
                disabled={mirror.running}
                onChange={(e) => {
                  setFps(parseInt(e.target.value, 10) || 0);
                  setCustom(true);
                }}
              />
            </Field>
          </div>

          <div className="divider" />

          <div className="grid-2">
            <Field label="键盘模式" hint="sdk 模式支持中文输入法直接输入">
              <Segmented
                value={keyboard}
                onChange={setKeyboard}
                options={[
                  { value: 'sdk', label: '标准 SDK' },
                  { value: 'uhid', label: 'UHID 虚拟' },
                  { value: 'disabled', label: '禁用' },
                ]}
              />
            </Field>
            <div className="col" style={{ gap: 10, justifyContent: 'center' }}>
              <Switch checked={noAudio} onChange={setNoAudio} label="关闭音频（推荐，更流畅）" />
              <Switch checked={stayAwake} onChange={setStayAwake} label="投屏期间保持设备唤醒" />
              <Switch checked={alwaysOnTop} onChange={setAlwaysOnTop} label="投屏窗口置顶" />
            </div>
          </div>

          {custom && (
            <Notice tone="accent">
              已手动调整参数。数值越大画质越好，但对带宽和性能要求更高；
              设备端解码压力过大时可能出现卡顿，建议从「均衡」预设开始。
            </Notice>
          )}
        </div>
      </Card>

      {/* 快捷键说明 */}
      <Card title="快捷键">
        <div className="shortcut-grid">
          <SC keys="Ctrl + H" desc="返回 / Home" />
          <SC keys="Ctrl + B" desc="返回键" />
          <SC keys="Ctrl + S" desc="多任务切换" />
          <SC keys="Ctrl + P" desc="电源键（熄屏）" />
          <SC keys="Ctrl + O" desc="打开屏幕" />
          <SC keys="Ctrl + W" desc="关闭投屏窗口" />
          <SC keys="Ctrl + C / V" desc="双向剪贴板同步" />
          <SC keys="拖放文件" desc="APK 自动安装，其他文件存入 Download" />
        </div>
      </Card>
    </>
  );
}

function Item({ k, v }: { k: string; v?: string | number }) {
  return (
    <div className="kv">
      <span className="kv-key">{k}</span>
      <span className="kv-value">{v ?? '—'}</span>
    </div>
  );
}

function SC({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="shortcut">
      <kbd>{keys}</kbd>
      <span>{desc}</span>
    </div>
  );
}
