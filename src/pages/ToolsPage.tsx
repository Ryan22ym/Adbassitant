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
import { useApp, useCurrentDevice, type InstallSigningOverride } from '@/store/app';
import { call } from '@/lib/ipc';
import { collectApks, installApkFiles, kindOf } from '@/lib/install';
import { formatBytes, fileName } from '@/lib/format';
import { deviceLabel } from '@/components/layout';
import type {
  ScreenResolution,
  AppInfo,
  InstallMode,
  InstallKind,
  AabEnv,
  AabSigningInfo,
  SigningMode,
} from '@shared/types';

type Tab = 'screenshot' | 'record' | 'resolution' | 'monkey' | 'apk' | 'file';

/** 三种安装方式的说明（界面提示 + 让用户明白数据会不会被清） */
const MODE_HINT: Record<InstallMode, string> = {
  overwrite: '保留应用数据，直接覆盖升级；与原包签名不一致时会失败。',
  clean: '先卸载旧版本（数据一起清掉）再全新安装，适合覆盖装不上或想从干净状态开始。',
  fresh: '不做覆盖：设备上已有该应用时直接报错，不会动到旧数据。',
};

/** AAB / APKS 的提示略有不同：它们走 bundletool，签名与已装版本不一致时只能清洁安装 */
const AAB_MODE_HINT: Record<InstallMode, string> = {
  overwrite: '保留应用数据，直接覆盖升级。拆包时用的签名必须与设备上已装版本一致，否则会失败。',
  clean: '先卸载旧版本（数据一起清掉）再安装。签名换了、覆盖装不上时用这个。',
  fresh: '不做覆盖：设备上已有该应用时直接报错，不会动到旧数据。',
};

const APKS_MODE_HINT: Record<InstallMode, string> = {
  overwrite: '保留应用数据，直接覆盖升级。产物里的签名必须与设备上已装版本一致，否则会失败。',
  clean: '先卸载旧版本（数据一起清掉）再安装。覆盖装不上时用这个。',
  fresh: '不做覆盖：设备上已有该应用时直接报错，不会动到旧数据。',
};

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
              ['apk', '安装安装包'],
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
/* 安装安装包（APK / AAB）                                              */
/* ================================================================== */

function ApkPanel() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);
  const install = useApp((s) => s.install);
  const pendingInstall = useApp((s) => s.pendingInstall);
  const installing = install?.phase === 'installing';
  /** 「占用中」= 正在装 或 正等用户选定目标设备；两者都不允许再开新任务 */
  const busy = installing || pendingInstall !== null;

  const [apkPath, setApkPath] = useState('');
  const [apkSize, setApkSize] = useState<number | undefined>(undefined);
  /** 安装方式放 store：整窗拖放与页面按钮/拖放区共用同一个值 */
  const mode = useApp((s) => s.installMode);
  const setMode = useApp((s) => s.setInstallMode);
  /** 拆包签名也放 store（SigningPanel 里改），拆包/安装共用同一份 */
  const installSigning = useApp((s) => s.installSigning);
  const [grantAll, setGrantAll] = useState(false);
  const [over, setOver] = useState(false);
  /** 上一次安装结果，弹窗自动关闭后仍留在页面上供回看 */
  const [lastResult, setLastResult] = useState('');

  /** 当前选中的包类型（按扩展名），决定文案、安装方式和是否需要 AAB 环境 */
  const kind: InstallKind = kindOf(apkPath) ?? 'apk';
  const isAab = kind === 'aab';
  const isApks = kind === 'apks';
  /** AAB 与 APKS 都要 bundletool（拆包 / install-apks），环境要求一样 */
  const needsBundleTool = isAab || isApks;

  /** 「另存 .apks」进行中 —— 与安装互斥，避免同时跑两个 bundletool */
  const [converting, setConverting] = useState(false);
  const [convertMsg, setConvertMsg] = useState('');

  /**
   * AAB 环境（Java 11+ 与 bundletool）。
   * 选中的是 APK 时不必探测 —— 探测要跑 java -version，是个真实进程开销。
   */
  const [aabEnv, setAabEnv] = useState<AabEnv | null>(null);
  const aabReady = aabEnv?.ready ?? false;
  const aabReason = aabEnv?.reason;

  const refreshAabEnv = async (force = false) => {
    try {
      const r = await call<AabEnv>(() => window.adbApi.aabEnv(force), { silent: true });
      setAabEnv(r ?? null);
    } catch {
      setAabEnv(null);
    }
  };

  useEffect(() => {
    if (needsBundleTool) void refreshAabEnv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBundleTool]);

  useEffect(() => {
    if (!install || install.phase === 'installing') return;
    setLastResult(
      install.phase === 'success'
        ? `安装成功：${install.fileName}\n` +
            (install.device ? `目标设备：${install.device}\n` : '') +
            (install.message ?? '')
        : `安装失败：${install.message ?? ''}`,
    );
  }, [install]);

  const pick = async () => {
    if (busy) return;
    const files = await call<string[]>(
      () =>
        window.adbApi.pickFiles(false, [
          { name: 'Android 安装包', extensions: ['apk', 'aab', 'apks'] },
          { name: 'APK 安装包', extensions: ['apk'] },
          { name: 'AAB 应用束', extensions: ['aab'] },
          { name: 'APKS 拆包产物', extensions: ['apks'] },
        ]),
      { silent: true },
    );
    if (files?.[0]) {
      setApkPath(files[0]);
      setApkSize(undefined);
      setConvertMsg('');
    }
  };

  const installSelected = () => {
    if (busy) {
      return toast(
        'warn',
        installing ? '正在安装中，请稍候' : '请先选择安装到哪台设备',
      );
    }
    if (!apkPath) return toast('warn', '请先选择安装包文件');
    if (needsBundleTool && !aabReady) {
      return toast('warn', isApks ? 'APKS 安装环境未就绪' : 'AAB 安装环境未就绪', aabReason);
    }
    void installApkFiles(
      [{ path: apkPath, name: fileName(apkPath), size: apkSize, kind }],
      { mode, grantAll },
    );
  };

  /**
   * 仅拆包：按当前设备的配置把 AAB 拆成 .apks 并另存。
   *
   * 这是「拆包与安装分开」的那一半：产物落成磁盘上的一个文件后，
   * 之后想装几次、装到哪台（同型号）设备，都不用再跑一遍拆包。
   * 拆包不改设备状态，所以这里不占用安装流程（但两者不能同时跑）。
   */
  const convertAndSave = async () => {
    if (!apkPath || busy || converting) return;
    if (!current) return toast('warn', '请先选择设备', '拆包要按目标设备的配置挑 split');
    if (!aabReady) return toast('warn', 'AAB 拆包环境未就绪', aabReason);

    setConverting(true);
    setConvertMsg('正在按设备配置拆包…');
    try {
      const r = await call<{ apksPath: string; fromCache: boolean } | null>(
        () =>
          window.adbApi.saveApks(
            current.serial,
            apkPath,
            undefined,
            installSigning as unknown as Record<string, unknown>,
          ),
        { silent: true },
      );
      // null = 用户在保存框里点了取消，不是错误
      if (!r) {
        setConvertMsg('');
      } else {
        setConvertMsg(
          `${r.fromCache ? '复用了已有拆包产物' : '拆包完成'}，已导出到：\n${r.apksPath}`,
        );
        toast('success', '拆包产物已导出', r.apksPath);
      }
    } catch (e) {
      const msg = (e as Error).message || '拆包失败';
      setConvertMsg(`拆包失败：${msg}`);
      toast('error', '拆包失败', msg);
    } finally {
      setConverting(false);
    }
  };

  /**
   * 拖入的安装包直接开装（与「拖动安装」语义一致），
   * 页面上的「安装方式 / 自动授权」开关同样作用于拖放。
   */
  const handleDroppedFiles = async (files: File[]) => {
    if (busy) {
      toast(
        'warn',
        installing ? '正在安装中，请稍候' : '请先选择安装到哪台设备',
        '同一时间只允许一个安装任务',
      );
      return;
    }
    if (files.length === 0) return;

    const { apks, skipped } = collectApks(files);
    if (apks.length === 0) {
      toast(
        'warn',
        '请拖入 .apk、.aab 或 .apks 文件',
        skipped > 0 ? `已忽略 ${skipped} 个非安装包文件` : undefined,
      );
      return;
    }
    if (skipped > 0) toast('info', `已忽略 ${skipped} 个非安装包文件`);

    setApkPath(apks[0].path);
    setApkSize(apks[0].size);
    setLastResult('');
    await installApkFiles(apks, { mode, grantAll });
  };

  return (
    <Card
      title="安装安装包"
      subtitle="支持 APK、AAB 与 APKS；选择或直接拖入，安装过程会显示进度"
    >
      <div className="col">
        {needsBundleTool && <AabEnvNotice />}

        <Field label="安装包文件" hint="APK / AAB / APKS，拖进来即开始安装">
          <div
            data-dropzone="apk"
            className={`apk-drop ${over ? 'over' : ''} ${busy ? 'is-busy' : ''}`}
            onClick={pick}
            onDragOver={(e) => {
              // 占用中不 preventDefault → 光标显示禁止，drop 事件也不会触发
              if (busy) return;
              e.preventDefault();
              e.stopPropagation();
              if (!over) setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(false);
              void handleDroppedFiles(Array.from(e.dataTransfer?.files ?? []));
            }}
          >
            <p className="apk-drop-title">
              {installing
                ? isAab
                  ? '正在安装 AAB…'
                  : isApks
                    ? '正在安装 APKS…'
                    : '正在安装…'
                : pendingInstall
                  ? '请先选择安装到哪台设备'
                  : '把 APK / AAB / APKS 拖到这里，或点击选择文件'}
            </p>
            <p className="apk-drop-hint">
              {busy ? '完成当前任务后才能开始下一个' : '松手即开始安装，并弹出进度'}
            </p>

            {apkPath && (
              <div className="apk-drop-file">
                <span className={`install-kind-chip ${isAab ? 'aab' : isApks ? 'apks' : 'apk'}`}>
                  {isAab ? 'AAB' : isApks ? 'APKS' : 'APK'}
                </span>
                <span className="apk-drop-file-name" title={apkPath}>
                  {fileName(apkPath)}
                </span>
                {apkSize ? (
                  <span className="apk-drop-file-size">{formatBytes(apkSize)}</span>
                ) : null}
              </div>
            )}
          </div>
        </Field>

        <div className="row">
          <Button variant="default" size="sm" onClick={pick} disabled={busy}>
            浏览…
          </Button>
          {/*
            仅拆包：AAB → .apks，产物另存到磁盘。
            这是「拆包与安装分开」的入口 —— 同一份包要反复装时才值得先导出。
          */}
          {isAab && (
            <Button
              variant="default"
              size="sm"
              data-convert-apks="1"
              onClick={() => void convertAndSave()}
              loading={converting}
              disabled={busy || converting || !current || !aabReady}
            >
              仅拆包并另存为 .apks
            </Button>
          )}
          {apkPath && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || converting}
              onClick={() => {
                setApkPath('');
                setApkSize(undefined);
                setConvertMsg('');
              }}
            >
              清除
            </Button>
          )}
        </div>

        {convertMsg && (
          <pre className="output-block" data-convert-result="1" style={{ maxHeight: 120 }}>
            {convertMsg}
          </pre>
        )}

        <Field label="安装方式" hint={isAab ? AAB_MODE_HINT[mode] : isApks ? APKS_MODE_HINT[mode] : MODE_HINT[mode]}>
          {/* data-install-mode 供验收脚本定位（页面里可能还有别的 Segmented） */}
          <div data-install-mode={mode}>
            <Segmented<InstallMode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'overwrite', label: '覆盖安装' },
                { value: 'clean', label: '清洁安装' },
                { value: 'fresh', label: '全新安装' },
              ]}
            />
          </div>
        </Field>

        <div className="row row-wrap" style={{ gap: 20 }}>
          <Switch
            checked={grantAll}
            onChange={setGrantAll}
            label="自动授予全部权限（-g，Android 6+）"
            disabled={busy}
          />
        </div>

        {mode === 'clean' && (
          <Notice tone="warn">
            清洁安装会先卸载设备上的旧版本，<b>应用数据（登录状态、本地缓存）会一并清除</b>，
            且需要从安装包里读出包名。
          </Notice>
        )}

        {isAab && <SigningPanel busy={busy || converting} />}

        {isAab && mode === 'overwrite' && (
          <Notice tone="accent">
            AAB 里的模块是未签名的，<b>必须由本程序重新签名后才能安装</b>。
            签名会决定应用的 key hash —— 换签名后 Facebook / 微信 / Google 登录、
            推送、地图 key 都会失配，<b>想保持三方能力请改用该应用自己的正式签名</b>。
          </Notice>
        )}

        {isApks && (
          <Notice tone="accent">
            这是<b>已经拆好的产物</b>（bundletool build-apks 的输出），安装时不会再拆包，
            所以装得比 AAB 快。但它<b>是按特定设备（ABI / 屏幕 / SDK）挑好 split 的</b> ——
            本工具拆出来的会直接匹配，从别处拿来的若无对应来源记录，装后无法按包名复核。
          </Notice>
        )}

        <div className="row">
          <Button
            variant="primary"
            onClick={installSelected}
            loading={installing}
            disabled={!current || !apkPath || busy || converting || (needsBundleTool && !aabReady)}
          >
            开始安装
          </Button>
          {installing && <span className="text-dim">正在安装中，请勿重复操作…</span>}
          {converting && <span className="text-dim">正在拆包，请勿重复操作…</span>}
          {pendingInstall && <span className="text-dim">请先在上方弹窗里选择装到哪台设备…</span>}
        </div>

        {/*
          目标设备必须写出来。多台设备在线时，装错机器光看「安装成功」是发现不了的，
          所以这一行是常驻信息；真正开装前还会再问一次（见下方提示）。
        */}
        <div className="apk-target">
          {current ? (
            <>
              将安装到：<b>{deviceLabel(current)}</b>
              <span className="apk-target-serial"> · {current.serial}</span>
            </>
          ) : (
            <span className="text-dim">未选择设备</span>
          )}
        </div>

        {lastResult && (
          <div className="output-block" style={{ maxHeight: 180 }}>
            {lastResult}
          </div>
        )}

        <Notice tone="accent">
          <b>拆包与安装是两件事</b>：AAB 要按目标设备的配置先拆成 .apks 才能装。
          同一份 AAB 要反复装（换机器、反复重装）时，可以先点
          <b>「仅拆包并另存为 .apks」</b>导出一次产物，之后直接拖这个 .apks 进来装，
          省掉每次几十秒的拆包。产物留在本机的缓存里，同一个 AAB + 同一颗设备第二次起自动复用。
          <br />
          安装完成后会按包名在设备上复核一遍 —— <b>只有设备上确实查到了这个包才会显示成功</b>，
          避免「界面说成功了、手机上却没有」。但只要有多台设备同时在线，
          <b>开装前一定会先问你装到哪台</b>：装到别的设备上时，装后复核同样会通过
          （包确实装上了，只是不在你要的那台上），所以这一步不能省。
          提示：把安装包拖到本程序窗口任意位置也能安装，同样会弹出进度并防止重复安装；
          拖到投屏窗口则由 scrcpy 直接安装（仅支持 APK，无本程序弹窗）。其他文件请拖到投屏窗口，
          会自动存入 Download 目录。
        </Notice>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* AAB 环境提示                                                        */
/* ------------------------------------------------------------------ */

/**
 * AAB 安装依赖两样外部工具：Java 11+ 与 bundletool。
 * 都缺的时候直接告诉用户怎么补，而不是等他点了安装之后再报错。
 */
function AabEnvNotice() {
  const toast = useApp((s) => s.toast);
  const [env, setEnv] = useState<AabEnv | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ percent: number; received: number } | null>(null);

  const load = async (force = false) => {
    try {
      const r = await call<AabEnv>(() => window.adbApi.aabEnv(force), { silent: true });
      setEnv(r ?? null);
    } catch {
      /* 探测失败不打扰用户 */
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /* 下载进度由主进程推过来 */
  useEffect(() => {
    const off = window.adbApi.on('push:aabDownload', (p: any) => {
      if (p && typeof p.percent === 'number') setProgress(p);
    });
    return off;
  }, []);

  const download = async () => {
    setBusy(true);
    setProgress({ percent: 0, received: 0 });
    try {
      await call(() => window.adbApi.downloadBundletool(), { silent: true });
      toast('success', 'bundletool 已下载完成');
      await load(true);
    } catch (e) {
      toast('error', '下载失败', (e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  if (!env) return <Notice tone="accent">正在检测 AAB 安装环境…</Notice>;

  if (env.ready) {
    return (
      <div data-aab-env="ready">
        <Notice tone="success">
          <b>AAB 安装环境已就绪</b>：{env.javaDesc}，bundletool {env.bundletoolVersion}。
          AAB 会先按目标设备的配置拆包，再以 install-multiple 安装（同一台设备第二次起复用缓存）；
          想只拆包不安装，可用下方的「仅拆包并另存为 .apks」。
        </Notice>
      </div>
    );
  }

  return (
    <div data-aab-env="incomplete">
      <Notice tone="warn">
        <b>AAB 安装环境不完整</b>
        <div style={{ marginTop: 6 }}>{env.reason}</div>
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          {!env.bundletoolReady && (
            <Button variant="primary" size="sm" onClick={download} loading={busy}>
              下载 bundletool（约 31 MB）
            </Button>
          )}
          {env.bundletoolReady && (
            <span className="text-dim">
              bundletool 已就位：<span className="mono">{env.bundletoolPath}</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.adbApi.openBundletoolDir()}
            title="在资源管理器中打开，可手动放入 bundletool 或 JRE"
          >
            打开工具目录
          </Button>
          <Button variant="ghost" size="sm" onClick={() => load(true)}>
            重新检测
          </Button>
        </div>
        {progress && (
          <div className="aab-dl">
            <div className="aab-dl-bar">
              <i style={{ width: `${progress.percent}%` }} />
            </div>
            <span className="text-dim">
              {progress.percent}%（{(progress.received / 1024 / 1024).toFixed(1)} MB）
            </span>
          </div>
        )}
        {!env.javaOk && (
          <div className="text-dim" style={{ marginTop: 8 }}>
            需要 Java 11 及以上。装好 JDK/JRE 后点「重新检测」；
            也可以把便携版 JRE 解压到程序的 <span className="mono">bin\jre</span> 目录（免安装 Java）。
          </div>
        )}
      </Notice>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AAB 签名                                                            */
/* ------------------------------------------------------------------ */

/**
 * AAB 拆包签名选择 + key hash 展示。
 *
 * 为什么要做成界面可改：签名决定应用的 key hash，而 Facebook / 微信 /
 * Google 登录、推送全都按「包名 + 签名」校验。默认的调试密钥库只适合
 * 「反正是本地随便测一下」的场景；一旦要验证三方登录，就必须换成
 * 这个应用自己的正式签名。之前这一点是写死的，装了 AAB 的人会撞上
 * 「Invalid key hash」而完全不知道是安装器改了签名。
 */
function SigningPanel({ busy }: { busy: boolean }) {
  const toast = useApp((s) => s.toast);
  const signing = useApp((s) => s.installSigning);
  const setSigning = useApp((s) => s.setInstallSigning);

  const [info, setInfo] = useState<AabSigningInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [showHash, setShowHash] = useState(false);
  /** 自定义签名时的表单（与 store 里的值同步回写） */
  const [ksPath, setKsPath] = useState('');
  const [storePass, setStorePass] = useState('');
  const [keyPass, setKeyPass] = useState('');
  const [alias, setAlias] = useState('');

  /* 第一次进入时把主进程持久化的配置读回来 */
  useEffect(() => {
    void (async () => {
      try {
        const r = await call<AabSigningInfo>(() => window.adbApi.aabSigning(), { silent: true });
        if (!r) return;
        setInfo(r);
        setSigning({
          mode: r.config.mode,
          keystorePath: r.config.keystorePath,
          storePass: r.config.storePass,
          keyPass: r.config.keyPass,
          keyAlias: r.config.keyAlias,
        });
        setKsPath(r.config.keystorePath ?? '');
        setStorePass(r.config.storePass ?? '');
        setKeyPass(r.config.keyPass ?? '');
        setAlias(r.config.keyAlias ?? '');
      } catch {
        /* 探测失败不打扰 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 把表单写回主进程并刷新展示 */
  const apply = async (patch: Partial<InstallSigningOverride>, tip?: string) => {
    setProbing(true);
    try {
      const r = await call<AabSigningInfo>(
        () =>
          window.adbApi.setAabSigning({
            mode: patch.mode ?? signing.mode,
            keystorePath: patch.keystorePath ?? ksPath,
            storePass: patch.storePass ?? storePass,
            keyPass: patch.keyPass ?? keyPass,
            keyAlias: patch.keyAlias ?? alias,
          } as Record<string, unknown>),
        { silent: true },
      );
      setInfo(r ?? null);
      if (r) {
        setSigning({
          mode: r.config.mode,
          keystorePath: r.config.keystorePath,
          storePass: r.config.storePass,
          keyPass: r.config.keyPass,
          keyAlias: r.config.keyAlias,
        });
      }
      if (r?.ok) toast('success', tip ?? '签名已生效', r.desc);
      else if (r?.reason) toast('warn', '签名配置未生效', r.reason);
    } catch (e) {
      toast('error', '设置签名失败', (e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const pickKeystore = async () => {
    try {
      const p = await call<string | null>(() => window.adbApi.pickKeystore(), { silent: true });
      if (!p) return;
      setKsPath(p);
      toast('info', '已选择密钥库', p);
    } catch (e) {
      toast('error', '选择密钥库失败', (e as Error).message);
    }
  };

  const hash = info?.keyHash;

  return (
    <Field
      label="拆包签名"
      hint="AAB 的模块是未签名的，必须重新签。签名决定应用 key hash —— 三方登录/推送靠它校验。"
    >
      <div data-aab-signing={signing.mode} className="aab-signing">
        <Segmented<SigningMode>
          value={signing.mode}
          onChange={(m) => {
            if (m === signing.mode) return;
            if (m === 'custom') {
              // 切到自定义：先把表单值带过去，用户填完密码再点「应用」
              setSigning({ ...signing, mode: 'custom', keystorePath: ksPath });
            } else {
              void apply({ mode: m });
            }
          }}
          options={[
            { value: 'bundled-debug', label: '随包调试密钥' },
            { value: 'custom', label: '我的密钥库' },
            { value: 'none', label: '不签名' },
          ]}
        />

        {signing.mode === 'bundled-debug' && (
          <div className="text-dim" style={{ marginTop: 8 }}>
            用程序自带的 <span className="mono">debug.keystore</span> 签名，开箱即用。
            <b>但签名是调试 key，应用原来的 key hash 会被替换</b> ——
            想验证三方登录请改用「我的密钥库」。
          </div>
        )}

        {signing.mode === 'custom' && (
          <div className="col" style={{ marginTop: 10, gap: 8 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Field label="密钥库文件">
                  <Input
                    value={ksPath}
                    onChange={(e) => setKsPath(e.target.value)}
                    placeholder="例如 D:\\keys\\myapp.jks（.jks / .keystore / .p12）"
                  />
                </Field>
              </div>
              <Button variant="default" size="sm" onClick={pickKeystore} disabled={busy}>
                浏览…
              </Button>
            </div>

            <div className="row row-wrap" style={{ gap: 8 }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <Field label="密钥库密码">
                  <Input value={storePass} onChange={(e) => setStorePass(e.target.value)} type="password" placeholder="storepass" />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <Field label="私钥密码" hint="留空则与密钥库密码相同">
                  <Input value={keyPass} onChange={(e) => setKeyPass(e.target.value)} type="password" placeholder="keypass（可留空）" />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <Field label="别名" hint="留空则自动取库里唯一那个">
                  <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="例如 release" />
                </Field>
              </div>
            </div>

            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                size="sm"
                loading={probing}
                disabled={busy || !ksPath || !storePass}
                onClick={() => void apply({ mode: 'custom' })}
              >
                应用并测试
              </Button>
              {info?.aliases?.length ? (
                <span className="text-dim">
                  库内别名：<span className="mono">{info.aliases.join('、')}</span>
                </span>
              ) : null}
            </div>

            {info && info.config.mode === 'custom' && !info.ok && info.reason && (
              <Notice tone="warn">{info.reason}</Notice>
            )}
          </div>
        )}

        {signing.mode === 'none' && (
          <Notice tone="warn">
            不给 bundletool 任何签名参数。找不到默认调试密钥库时它会只打一行 WARNING，
            然后产出<b>未签名 APK</b>，设备会拒绝安装 —— 仅用于排查问题。
          </Notice>
        )}

        {/* 当前生效的签名状态 */}
        {info && (
          <div style={{ marginTop: 8 }}>
            {info.ok ? (
              <span className="text-dim">当前签名：{info.desc}</span>
            ) : (
              <span className="text-dim">签名不可用：{info.reason}</span>
            )}
          </div>
        )}

        {/*
          key hash 是用户去三方后台登记时要复制的东西。
          默认折叠 —— 平时用不上，需要时展开一次就够。
        */}
        {hash && (
          <div style={{ marginTop: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="ghost" size="sm" onClick={() => setShowHash((v) => !v)}>
                {showHash ? '收起 key hash' : '查看 key hash'}
              </Button>
              {showHash && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const txt = [
                      `Facebook：${hash.facebook}`,
                      `微信/QQ：${hash.wechat}`,
                      `SHA1：${hash.sha1}`,
                      `SHA256：${hash.sha256}`,
                    ].join('\n');
                    void navigator.clipboard?.writeText(txt);
                    toast('success', 'key hash 已复制');
                  }}
                >
                  复制全部
                </Button>
              )}
            </div>
            {showHash && (
              <div className="aab-hash">
                <div>
                  <span className="aab-hash-k">Facebook</span>
                  <span className="mono aab-hash-v">{hash.facebook || '（未读到）'}</span>
                </div>
                <div>
                  <span className="aab-hash-k">微信/QQ</span>
                  <span className="mono aab-hash-v">{hash.wechat || '（需要 JDK 才能算）'}</span>
                </div>
                <div>
                  <span className="aab-hash-k">SHA1</span>
                  <span className="mono aab-hash-v">{hash.sha1 || '（未读到）'}</span>
                </div>
                <div>
                  <span className="aab-hash-k">SHA256</span>
                  <span className="mono aab-hash-v">{hash.sha256 || '（未读到）'}</span>
                </div>
                <div className="text-dim" style={{ marginTop: 6 }}>
                  拿 Facebook 那行去 <span className="mono">开发者后台 → 设置 → 基本 → 密钥散列</span> 登记，
                  即可解决「Invalid key hash」。改签名后这行会变，别忘了重新登记。
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Field>
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
