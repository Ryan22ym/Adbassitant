import { useState, useEffect, useRef } from 'react';
import {
  Card,
  Button,
  Field,
  Input,
  Select,
  Switch,
  Notice,
  Badge,
  Segmented,
  Empty,
  Spinner,
} from '@/components/ui';
import { useApp, useCurrentDevice } from '@/store/app';
import { call } from '@/lib/ipc';
import { formatBytes, fileName } from '@/lib/format';
import type { ScreenResolution, AppInfo } from '@shared/types';

type Tab = 'screenshot' | 'record' | 'resolution' | 'monkey' | 'apk' | 'file';

export default function ToolsPage() {
  const [tab, setTab] = useState<Tab>('screenshot');
  const current = useCurrentDevice();

  return (
    <>
      {!current && (
        <Notice tone="warn">
          当前没有可用设备，请先在「设备」页面连接手机并授权 USB 调试。
        </Notice>
      )}

      <Card padding={false}>
        <div className="tabs">
          {(
            [
              ['screenshot', '截图'],
              ['record', '录屏'],
              ['resolution', '分辨率'],
              ['monkey', 'Monkey 测试'],
              ['apk', '安装 APK'],
              ['file', '文件传输'],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              className={`tab ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {tab === 'screenshot' && <ScreenshotPanel />}
      {tab === 'record' && <RecordPanel />}
      {tab === 'resolution' && <ResolutionPanel />}
      {tab === 'monkey' && <MonkeyPanel />}
      {tab === 'apk' && <ApkPanel />}
      {tab === 'file' && <FilePanel />}
    </>
  );
}

/* ================================================================== */
/* 截图                                                                */
/* ================================================================== */

interface ShotResult {
  localPath: string;
  size: number;
  duration: number;
}

function ScreenshotPanel() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ShotResult[]>([]);

  const capture = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setBusy(true);
    try {
      const r = await call<ShotResult>(() => window.adbApi.captureScreenshot(current.serial), {
        successMessage: '截图已保存',
      });
      setHistory((h) => [r, ...h].slice(0, 12));
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="屏幕截图"
      subtitle="直接从设备读取画面，自动保存为 PNG"
      extra={
        <Button variant="primary" onClick={capture} loading={busy} disabled={!current}>
          立即截图
        </Button>
      }
    >
      {history.length === 0 ? (
        <Empty title="还没有截图" desc="点击右上角「立即截图」，保存后这里会显示预览" />
      ) : (
        <div className="shot-grid">
          {history.map((s) => (
            <div key={s.localPath} className="shot-card fade-in">
              <div className="shot-thumb">
                <img src={`file://${s.localPath.replace(/\\/g, '/')}`} alt="截图预览" />
              </div>
              <div className="shot-meta">
                <span className="shot-name" title={s.localPath}>
                  {fileName(s.localPath)}
                </span>
                <span className="text-dim">
                  {formatBytes(s.size)} · {s.duration}ms
                </span>
              </div>
              <div className="shot-actions">
                <Button size="sm" variant="ghost" onClick={() => window.adbApi.reveal(s.localPath)}>
                  打开文件夹
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ================================================================== */
/* 录屏                                                                */
/* ================================================================== */

function RecordPanel() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const record = useApp((s) => s.record);
  const setRecord = useApp((s) => s.setRecord);

  const [duration, setDuration] = useState(30);
  const [bitRate, setBitRate] = useState(8);
  const [sizePx, setSizePx] = useState<number | ''>('');
  const [audio, setAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef<number | null>(null);

  /* 状态变化时刷新已用时 */
  useEffect(() => {
    if (record) {
      const id = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - record.startedAt) / 1000));
      }, 500);
      tickRef.current = id;
      return () => window.clearInterval(id);
    }
    setElapsed(0);
    return undefined;
  }, [record]);

  const start = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setBusy(true);
    try {
      const r = await call<any>(
        () =>
          window.adbApi.startRecord(
            current.serial,
            duration,
            bitRate,
            typeof sizePx === 'number' ? sizePx : undefined,
            audio,
          ),
        { successMessage: `开始录屏，最长 ${duration} 秒` },
      );
      setRecord({
        id: r.id,
        serial: r.serial,
        outputPath: r.outputPath,
        startedAt: r.startedAt,
        duration: r.duration,
        devicePath: '',
        status: 'recording',
      });
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!record) return;
    setBusy(true);
    try {
      await call(() => window.adbApi.stopRecord(record.id), {
        successMessage: '录制已结束，视频已保存',
      });
      setRecord(null);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="屏幕录制"
      subtitle="在设备端录制，结束后自动拉取到电脑"
      extra={record ? <Badge tone="danger" dot>录制中</Badge> : undefined}
    >
      <div className="col">
        {record ? (
          <div className="col">
            <Notice tone="danger">
              <strong>正在录制中</strong>：已录制 {elapsed} 秒 / 最长 {record.duration} 秒。
              到达时长上限会自动停止并保存，也可点击下方按钮提前结束。
            </Notice>
            <div className="record-out">
              <span className="text-dim">输出文件</span>
              <span className="mono">{record.outputPath}</span>
            </div>
            <div className="row">
              <Button variant="danger" onClick={stop} loading={busy}>
                停止并保存
              </Button>
            </div>
          </div>
        ) : (
          <div className="col">
            <div className="grid-3">
              <Field label="录制时长" hint="秒">
                <Input
                  type="number"
                  min={5}
                  max={180}
                  value={duration}
                  onChange={(e) => setDuration(parseInt(e.target.value, 10) || 30)}
                />
              </Field>
              <Field label="码率" hint="Mbps">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={bitRate}
                  onChange={(e) => setBitRate(parseInt(e.target.value, 10) || 8)}
                />
              </Field>
              <Field label="分辨率缩放" hint="留空=原始">
                <Input
                  type="number"
                  placeholder="原始"
                  min={240}
                  max={2160}
                  value={sizePx}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSizePx(v === '' ? '' : parseInt(v, 10) || '');
                  }}
                />
              </Field>
            </div>

            <Switch
              checked={audio}
              onChange={setAudio}
              label="录制音频（部分设备 Android 10+ 支持，可能失败）"
            />

            <div className="row">
              <Button variant="primary" onClick={start} loading={busy} disabled={!current}>
                开始录屏
              </Button>
              <span className="text-dim">
                单次最长 180 秒（系统 screenrecord 限制）。录制期间可继续使用其他功能。
              </span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ================================================================== */
/* 分辨率                                                              */
/* ================================================================== */

const RES_PRESETS = [
  { label: '1080 × 2400（FHD+）', size: '1080x2400', dpi: 420 },
  { label: '1080 × 1920（FHD）', size: '1080x1920', dpi: 420 },
  { label: '720 × 1280（HD）', size: '720x1280', dpi: 320 },
  { label: '540 × 960（省电）', size: '540x960', dpi: 240 },
  { label: '480 × 800（极简）', size: '480x800', dpi: 200 },
];

function ResolutionPanel() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const [info, setInfo] = useState<ScreenResolution | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [preset, setPreset] = useState('0');
  const [customSize, setCustomSize] = useState('');
  const [customDpi, setCustomDpi] = useState('');

  const load = async () => {
    if (!current) return;
    setLoading(true);
    try {
      const r = await call<ScreenResolution>(() => window.adbApi.getResolution(current.serial), {
        silent: true,
      });
      setInfo(r);
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [current?.serial]);

  const apply = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setBusy(true);
    try {
      let size: string | undefined;
      let dpi: number | undefined;

      if (mode === 'preset') {
        const p = RES_PRESETS[parseInt(preset, 10)];
        size = p?.size;
        dpi = p?.dpi;
      } else {
        size = customSize.trim() || undefined;
        const d = parseInt(customDpi.trim(), 10);
        dpi = Number.isFinite(d) ? d : undefined;
      }

      if (!size && !dpi) throw new Error('请选择预设或填写自定义值');

      await call(() => window.adbApi.setSize(current.serial, size, dpi), {
        successMessage: '分辨率已修改',
      });
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await call(() => window.adbApi.resetSize(current.serial), {
        successMessage: '已恢复默认分辨率',
      });
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="分辨率与 DPI"
      subtitle="通过 wm size / wm density 修改，可随时恢复默认"
      extra={
        <Button size="sm" variant="ghost" onClick={load} loading={loading}>
          刷新
        </Button>
      }
    >
      <div className="col">
        <div className="res-current">
          <div className="res-item">
            <span className="res-label">物理分辨率</span>
            <strong className="res-value">{info?.physical || (loading ? '读取中…' : '—')}</strong>
          </div>
          <div className="res-item">
            <span className="res-label">当前分辨率</span>
            <strong className="res-value accent">
              {info?.current || (loading ? '读取中…' : '—')}
              {info?.override && <Badge tone="accent">已修改</Badge>}
            </strong>
          </div>
          <div className="res-item">
            <span className="res-label">当前密度</span>
            <strong className="res-value">
              {info?.densityOverride ?? info?.density ?? (loading ? '读取中…' : '—')}
              {(info?.densityOverride || info?.density) && ' dpi'}
              {info?.densityOverride && <Badge tone="accent">已修改</Badge>}
            </strong>
          </div>
        </div>

        <div className="divider" />

        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'preset', label: '常用预设' },
            { value: 'custom', label: '自定义' },
          ]}
        />

        {mode === 'preset' ? (
          <Field label="选择预设" hint="同时修改分辨率与密度">
            <Select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              options={RES_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
            />
          </Field>
        ) : (
          <div className="grid-2">
            <Field label="分辨率" hint="格式：宽x高">
              <Input
                placeholder="1080x2340"
                value={customSize}
                onChange={(e) => setCustomSize(e.target.value)}
              />
            </Field>
            <Field label="密度" hint="dpi">
              <Input
                type="number"
                placeholder="420"
                value={customDpi}
                onChange={(e) => setCustomDpi(e.target.value)}
              />
            </Field>
          </div>
        )}

        <div className="row">
          <Button variant="primary" onClick={apply} loading={busy} disabled={!current}>
            应用修改
          </Button>
          <Button variant="ghost" onClick={reset} disabled={!current || busy}>
            恢复默认
          </Button>
        </div>

        <Notice tone="accent">
          修改分辨率常用于测试应用在不同屏幕下的适配，或降低分辨率提升投屏流畅度。
          部分应用会在启动时读取分辨率，修改后建议重启应用。
        </Notice>
      </div>
    </Card>
  );
}

/* ================================================================== */
/* Monkey                                                              */
/* ================================================================== */

function MonkeyPanel() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [pkg, setPkg] = useState('');
  const [events, setEvents] = useState(1000);
  const [throttle, setThrottle] = useState(100);
  const [seed, setSeed] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const outRef = useRef<HTMLDivElement>(null);

  /* 订阅 monkey 输出 */
  useEffect(() => {
    const off = window.adbApi.on('push:monkeyOutput', (payload: any) => {
      if (payload.type === 'line') {
        setOutput((o) => [...o.slice(-600), payload.line]);
      } else if (payload.type === 'exit') {
        setRunning(false);
        setOutput((o) => [...o, `——— 测试结束（exit ${payload.code}）———`]);
      } else if (payload.type === 'start') {
        setRunning(true);
      }
    });
    return off;
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  const loadApps = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setLoadingApps(true);
    try {
      const r = await call<AppInfo[]>(() => window.adbApi.listApps(current.serial, false), {
        silent: true,
      });
      setApps(r || []);
      if (!pkg && r?.length) setPkg(r[0].packageName);
      toast('success', `已读取 ${r?.length || 0} 个第三方应用`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setLoadingApps(false);
    }
  };

  useEffect(() => {
    setApps([]);
    setPkg('');
  }, [current?.serial]);

  const start = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setOutput([]);
    setRunning(true);
    try {
      await call(
        () =>
          window.adbApi.runMonkey(
            current.serial,
            pkg || undefined,
            events,
            throttle,
            seed.trim() ? parseInt(seed, 10) : undefined,
          ),
        { silent: true },
      );
    } catch (e) {
      setRunning(false);
      toast('error', (e as Error).message);
    }
  };

  const stop = async () => {
    try {
      await call(() => window.adbApi.stopMonkey(), { successMessage: '已停止 Monkey 测试' });
      setRunning(false);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <Card
      title="Monkey 稳定性测试"
      subtitle="向应用发送伪随机事件流，用于发现崩溃与 ANR"
      extra={running ? <Badge tone="warn" dot>运行中</Badge> : undefined}
    >
      <div className="col">
        <div className="grid-2">
          <Field label="目标应用" hint="留空 = 全部应用">
            <div className="row">
              <Select
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                options={[
                  { value: '', label: apps.length ? '全部应用（不限包名）' : '请先读取应用列表' },
                  ...apps.map((a) => ({ value: a.packageName, label: a.packageName })),
                ]}
                disabled={running}
              />
              <Button
                variant="default"
                onClick={loadApps}
                loading={loadingApps}
                disabled={!current || running}
                style={{ flex: 'none' }}
              >
                读取应用
              </Button>
            </div>
          </Field>

          <div className="grid-3">
            <Field label="事件数">
              <Input
                type="number"
                min={10}
                max={1000000}
                step={100}
                value={events}
                disabled={running}
                onChange={(e) => setEvents(parseInt(e.target.value, 10) || 1000)}
              />
            </Field>
            <Field label="节流" hint="ms">
              <Input
                type="number"
                min={0}
                max={2000}
                step={10}
                value={throttle}
                disabled={running}
                onChange={(e) => setThrottle(parseInt(e.target.value, 10) || 0)}
              />
            </Field>
            <Field label="Seed" hint="留空随机">
              <Input
                placeholder="随机"
                value={seed}
                disabled={running}
                onChange={(e) => setSeed(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="row">
          <Button variant="primary" onClick={start} disabled={!current || running}>
            开始测试
          </Button>
          <Button variant="danger" onClick={stop} disabled={!running}>
            停止
          </Button>
          {running && <Spinner />}
        </div>

        <Notice tone="accent">
          节流值越小事件发送越快、压力越大；设为 0 可进行极限压力测试。
          已自动启用 --ignore-crashes 与 --ignore-timeouts，单个应用崩溃不会中断测试。
        </Notice>

        {output.length > 0 && (
          <div className="output-block" ref={outRef} style={{ maxHeight: 300 }}>
            {output.join('\n')}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ================================================================== */
/* 安装 APK                                                            */
/* ================================================================== */

function ApkPanel() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const [apkPath, setApkPath] = useState('');
  const [reinstall, setReinstall] = useState(true);
  const [grantAll, setGrantAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const pick = async () => {
    const files = await call<string[]>(
      () =>
        window.adbApi.pickFiles(false, [{ name: 'Android 安装包', extensions: ['apk'] }]),
      { silent: true },
    );
    if (files?.[0]) {
      setApkPath(files[0]);
      setResult('');
    }
  };

  const install = async () => {
    if (!current) return toast('warn', '请先连接设备');
    if (!apkPath) return toast('warn', '请先选择 APK 文件');
    setBusy(true);
    setResult('');
    try {
      const r = await call<string>(() => window.adbApi.installApk(current.serial, apkPath, reinstall, grantAll), {
        silent: true,
      });
      setResult(r || 'Success');
      toast('success', '安装成功');
    } catch (e) {
      const msg = (e as Error).message;
      setResult(`失败：${msg}`);
      toast('error', '安装失败', msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="安装 APK" subtitle="从电脑选择安装包并推送到设备安装">
      <div className="col">
        <Field label="APK 文件">
          <div className="row">
            <Input
              readOnly
              value={apkPath}
              placeholder="尚未选择文件"
              onClick={pick}
              style={{ cursor: 'pointer' }}
            />
            <Button variant="default" onClick={pick} style={{ flex: 'none' }}>
              浏览…
            </Button>
          </div>
        </Field>

        <div className="row row-wrap" style={{ gap: 20 }}>
          <Switch checked={reinstall} onChange={setReinstall} label="覆盖安装（-r，保留数据）" />
          <Switch
            checked={grantAll}
            onChange={setGrantAll}
            label="自动授予全部权限（-g，Android 6+）"
          />
        </div>

        <div className="row">
          <Button
            variant="primary"
            onClick={install}
            loading={busy}
            disabled={!current || !apkPath}
          >
            开始安装
          </Button>
        </div>

        {result && (
          <div className="output-block" style={{ maxHeight: 180 }}>
            {result}
          </div>
        )}

        <Notice tone="accent">
          提示：也可以把 APK 文件直接拖到投屏窗口中，实现快速安装。
        </Notice>
      </div>
    </Card>
  );
}

/* ================================================================== */
/* 文件传输                                                            */
/* ================================================================== */

function FilePanel() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const [mode, setMode] = useState<'push' | 'pull'>('push');

  /* push */
  const [localPaths, setLocalPaths] = useState<string[]>([]);
  const [remoteDir, setRemoteDir] = useState('/sdcard/Download');
  const [pushBusy, setPushBusy] = useState(false);

  /* pull */
  const [remotePaths, setRemotePaths] = useState('');
  const [localDir, setLocalDir] = useState('');
  const [pullBusy, setPullBusy] = useState(false);

  const [result, setResult] = useState('');

  const pickFiles = async () => {
    const files = await call<string[]>(() => window.adbApi.pickFiles(true), { silent: true });
    if (files?.length) {
      setLocalPaths((p) => Array.from(new Set([...p, ...files])));
      setResult('');
    }
  };

  const pickDir = async () => {
    const dir = await call<string | null>(() => window.adbApi.pickDir(), { silent: true });
    if (dir) setLocalDir(dir);
  };

  const doPush = async () => {
    if (!current) return toast('warn', '请先连接设备');
    if (localPaths.length === 0) return toast('warn', '请先选择要推送的文件');
    setPushBusy(true);
    setResult('');
    try {
      const r = await call<any>(() => window.adbApi.pushFiles(current.serial, localPaths, remoteDir), {
        silent: true,
      });
      setResult(r.message);
      toast('success', r.message);
      setLocalPaths([]);
    } catch (e) {
      const msg = (e as Error).message;
      setResult(`失败：${msg}`);
      toast('error', '推送失败', msg);
    } finally {
      setPushBusy(false);
    }
  };

  const doPull = async () => {
    if (!current) return toast('warn', '请先连接设备');
    const paths = remotePaths
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0) return toast('warn', '请输入设备上的文件路径');
    if (!localDir) return toast('warn', '请选择保存目录');

    setPullBusy(true);
    setResult('');
    try {
      const r = await call<any>(() => window.adbApi.pullFiles(current.serial, paths, localDir), {
        silent: true,
      });
      setResult(r.message);
      toast('success', r.message);
    } catch (e) {
      const msg = (e as Error).message;
      setResult(`失败：${msg}`);
      toast('error', '拉取失败', msg);
    } finally {
      setPullBusy(false);
    }
  };

  return (
    <Card
      title="文件传输"
      subtitle="在电脑与设备之间双向传输文件"
      extra={
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'push', label: '推送到设备' },
            { value: 'pull', label: '从设备拉取' },
          ]}
        />
      }
    >
      {mode === 'push' ? (
        <div className="col">
          <Field label="本地文件" hint={`已选 ${localPaths.length} 个`}>
            <div className="row">
              <Button variant="default" onClick={pickFiles}>
                选择文件…
              </Button>
              {localPaths.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setLocalPaths([])}>
                  清空
                </Button>
              )}
            </div>
          </Field>

          {localPaths.length > 0 && (
            <div className="file-list">
              {localPaths.map((p) => (
                <div key={p} className="file-item">
                  <span className="file-name" title={p}>
                    {fileName(p)}
                  </span>
                  <button
                    className="file-remove"
                    onClick={() => setLocalPaths((l) => l.filter((x) => x !== p))}
                    title="移除"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <Field label="设备目标目录">
            <Input
              value={remoteDir}
              onChange={(e) => setRemoteDir(e.target.value)}
              placeholder="/sdcard/Download"
            />
          </Field>

          <div className="row">
            <Button
              variant="primary"
              onClick={doPush}
              loading={pushBusy}
              disabled={!current || localPaths.length === 0}
            >
              推送到设备
            </Button>
          </div>

          <Notice tone="accent">
            目标目录不存在时会自动创建。大文件传输可能耗时较长，期间请保持设备连接。
          </Notice>
        </div>
      ) : (
        <div className="col">
          <Field label="设备上的文件路径" hint="每行一个，支持目录">
            <textarea
              className="textarea mono"
              rows={4}
              spellCheck={false}
              placeholder={'/sdcard/DCIM/Camera/IMG_0001.jpg\n/sdcard/Download/'}
              value={remotePaths}
              onChange={(e) => setRemotePaths(e.target.value)}
            />
          </Field>

          <Field label="保存到电脑">
            <div className="row">
              <Input readOnly value={localDir} placeholder="尚未选择目录" onClick={pickDir} style={{ cursor: 'pointer' }} />
              <Button variant="default" onClick={pickDir} style={{ flex: 'none' }}>
                浏览…
              </Button>
            </div>
          </Field>

          <div className="row">
            <Button
              variant="primary"
              onClick={doPull}
              loading={pullBusy}
              disabled={!current || !remotePaths.trim() || !localDir}
            >
              拉取到电脑
            </Button>
          </div>
        </div>
      )}

      {result && (
        <div className="output-block" style={{ marginTop: 14, maxHeight: 160 }}>
          {result}
        </div>
      )}
    </Card>
  );
}
