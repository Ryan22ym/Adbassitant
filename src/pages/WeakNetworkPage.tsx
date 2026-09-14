import { useState, useEffect, useMemo } from 'react';
import {
  Card,
  Button,
  Badge,
  Field,
  Input,
  Select,
  Switch,
  Notice,
  Empty,
  Segmented,
  Spinner,
} from '@/components/ui';
import { useApp, useCurrentDevice } from '@/store/app';
import { call } from '@/lib/ipc';
import type {
  WeakNetDirectionParams,
  WeakNetParams,
  WeakNetPreset,
  WeakNetStatus,
} from '@shared/types';

/* ------------------------------------------------------------------ */
/* 默认参数                                                            */
/* ------------------------------------------------------------------ */

const EMPTY_DIR: WeakNetDirectionParams = {
  bandwidthMbps: 0,
  delayMs: 0,
  jitterMs: 0,
  lossPercent: 0,
  corruptPercent: 0,
  reorderPercent: 0,
  duplicatePercent: 0,
};

const DEFAULT_PARAMS: WeakNetParams = {
  up: { ...EMPTY_DIR },
  down: { ...EMPTY_DIR },
  durationSec: 60,
  blockNetwork: false,
};

interface ProbeResult {
  rooted: boolean;
  hasTc: boolean;
  hasIfb: boolean;
  iface: string;
  ifaces: string[];
  sdk?: number;
  note: string;
}

export default function WeakNetworkPage() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);

  const [params, setParams] = useState<WeakNetParams>(DEFAULT_PARAMS);
  const [presets, setPresets] = useState<WeakNetPreset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [status, setStatus] = useState<WeakNetStatus>({ running: false, remainSec: 0, mode: 'none' });
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remain, setRemain] = useState(0);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [dirTab, setDirTab] = useState<'up' | 'down'>('up');

  /* ---------- 推送订阅 ---------- */
  useEffect(() => {
    const off = window.adbApi.on('push:weaknetStatus', (s: WeakNetStatus) => setStatus(s));
    return off;
  }, []);

  /* ---------- 初始化：状态 + 预设 ---------- */
  useEffect(() => {
    (async () => {
      const [st, ps] = await Promise.all([
        call<WeakNetStatus>(() => window.adbApi.weaknetStatus(), { silent: true }),
        call<WeakNetPreset[]>(() => window.adbApi.weaknetPresets(), { silent: true }),
      ]);
      if (st) setStatus(st);
      if (ps) setPresets(ps);
    })();
  }, []);

  /* ---------- 倒计时 ---------- */
  useEffect(() => {
    if (!status.running || status.remainSec < 0) {
      setRemain(status.remainSec);
      return;
    }
    setRemain(status.remainSec);
    const id = window.setInterval(() => {
      setRemain((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [status.running, status.remainSec, status.startedAt]);

  /* ---------- 换设备时探测能力 ---------- */
  useEffect(() => {
    setProbe(null);
    if (current?.serial) void probeDevice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.serial]);

  const probeDevice = async () => {
    if (!current) return;
    setProbing(true);
    try {
      const r = await call<ProbeResult>(() => window.adbApi.weaknetProbe(current.serial), {
        silent: true,
      });
      setProbe(r);
    } catch (e) {
      toast('error', '设备探测失败', (e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  /* ---------- 参数修改 ---------- */
  const setDir = (dir: 'up' | 'down', patch: Partial<WeakNetDirectionParams>) => {
    setParams((p) => ({ ...p, [dir]: { ...p[dir], ...patch } }));
  };

  const setTop = (patch: Partial<WeakNetParams>) => setParams((p) => ({ ...p, ...patch }));

  const num = (v: string): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  /* ---------- 启动 / 停止 ---------- */
  const start = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setBusy(true);
    try {
      const st = await call<WeakNetStatus>(
        () => window.adbApi.weaknetStart(current.serial, params),
        { silent: true },
      );
      setStatus(st);
      if (st?.mode === 'tc') toast('success', '弱网已生效（tc/netem）');
      else if (st?.mode === 'svc') toast('success', '已切换为断网模式');
      else toast('warn', '未生效', st?.note);
    } catch (e) {
      toast('error', '启动失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const st = await call<WeakNetStatus>(() => window.adbApi.weaknetStop(), { silent: true });
      setStatus(st);
      toast('success', '已恢复网络');
    } catch (e) {
      toast('error', '恢复失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 预设 ---------- */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (p) {
      // 深拷贝，避免直接改到预设对象
      setParams(JSON.parse(JSON.stringify(p.params)));
      toast('info', `已载入预设「${p.name}」`);
    }
  };

  const doSavePreset = async () => {
    const name = saveName.trim();
    if (!name) return toast('warn', '请输入预设名称');
    setSavingPreset(true);
    try {
      const list = await call<WeakNetPreset[]>(
        () => window.adbApi.weaknetSavePreset(name, params),
        { silent: true },
      );
      setPresets(list || []);
      setShowSave(false);
      setSaveName('');
      toast('success', `预设「${name}」已保存`);
    } catch (e) {
      toast('error', '保存失败', (e as Error).message);
    } finally {
      setSavingPreset(false);
    }
  };

  const doDeletePreset = async () => {
    const p = presets.find((x) => x.id === presetId);
    if (!p || p.builtin) return;
    if (!confirm(`删除预设「${p.name}」？`)) return;
    try {
      const list = await call<WeakNetPreset[]>(
        () => window.adbApi.weaknetDeletePreset(p.id),
        { silent: true },
      );
      setPresets(list || []);
      setPresetId('');
      toast('success', '预设已删除');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const currentPreset = useMemo(
    () => presets.find((x) => x.id === presetId),
    [presets, presetId],
  );

  const dir = dirTab === 'up' ? params.up : params.down;

  /* 是否有任何有效参数 */
  const hasShaping = useMemo(() => {
    const anyDir = (d: WeakNetDirectionParams) =>
      Object.values(d).some((v) => typeof v === 'number' && v > 0);
    return anyDir(params.up) || anyDir(params.down) || !!params.blockNetwork;
  }, [params]);

  return (
    <>
      {!current && (
        <Notice tone="warn">
          当前没有可用设备，请先在「设备」页面连接手机并授权 USB 调试。
        </Notice>
      )}

      {/* -------- 运行状态条 -------- */}
      {status.running && (
        <Card className="wn-running">
          <div className="wn-running-inner">
            <div className="wn-running-left">
              <span className="wn-pulse" />
              <div>
                <strong>
                  {status.mode === 'svc' ? '断网模式生效中' : '弱网模拟生效中'}
                </strong>
                <p className="text-dim">
                  {status.mode === 'tc'
                    ? `tc/netem · 网卡 ${status.iface}`
                    : 'svc 开关模式'}
                  {status.params?.durationSec
                    ? ` · 剩余 ${remain > 0 ? remain : 0} 秒`
                    : ' · 不限时'}
                </p>
              </div>
            </div>
            <Button variant="danger" onClick={stop} loading={busy}>
              立即恢复
            </Button>
          </div>
        </Card>
      )}

      <div className="wn-layout">
        {/* ---------------- 左：参数配置 ---------------- */}
        <div className="wn-col">
          <Card
            title="弱网参数"
            subtitle="对标 clumsy：分别控制上行（设备发出）与下行（设备接收）"
            extra={
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="ghost" onClick={() => setParams(DEFAULT_PARAMS)}>
                  重置
                </Button>
                <Button size="sm" variant="default" onClick={() => setShowSave((v) => !v)}>
                  保存预设
                </Button>
              </div>
            }
          >
            <div className="col">
              {showSave && (
                <div className="wn-save-bar fade-in">
                  <Input
                    placeholder="预设名称，如「地铁刷视频」"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doSavePreset()}
                  />
                  <Button variant="primary" onClick={doSavePreset} loading={savingPreset}>
                    保存
                  </Button>
                  <Button variant="ghost" onClick={() => setShowSave(false)}>
                    取消
                  </Button>
                </div>
              )}

              <Segmented
                value={dirTab}
                onChange={setDirTab}
                options={[
                  { value: 'up', label: '↑ 上行（设备发出）' },
                  { value: 'down', label: '↓ 下行（设备接收）' },
                ]}
              />

              <div className="wn-grid">
                <Field label="带宽限制" hint="Mbps，0 = 不限">
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={dir.bandwidthMbps ?? 0}
                    onChange={(e) => setDir(dirTab, { bandwidthMbps: num(e.target.value) })}
                  />
                </Field>

                <Field label="延迟" hint="ms">
                  <Input
                    type="number"
                    min={0}
                    step={10}
                    value={dir.delayMs ?? 0}
                    onChange={(e) => setDir(dirTab, { delayMs: num(e.target.value) })}
                  />
                </Field>

                <Field label="抖动延迟" hint="ms，与延迟配合">
                  <Input
                    type="number"
                    min={0}
                    step={5}
                    value={dir.jitterMs ?? 0}
                    onChange={(e) => setDir(dirTab, { jitterMs: num(e.target.value) })}
                  />
                </Field>

                <Field label="丢包率" hint="%">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={dir.lossPercent ?? 0}
                    onChange={(e) => setDir(dirTab, { lossPercent: num(e.target.value) })}
                  />
                </Field>

                <Field label="错报率" hint="%，包内容损坏">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={dir.corruptPercent ?? 0}
                    onChange={(e) => setDir(dirTab, { corruptPercent: num(e.target.value) })}
                  />
                </Field>

                <Field label="乱序率" hint="%">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={dir.reorderPercent ?? 0}
                    onChange={(e) => setDir(dirTab, { reorderPercent: num(e.target.value) })}
                  />
                </Field>

                <Field label="重复包" hint="%">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={dir.duplicatePercent ?? 0}
                    onChange={(e) => setDir(dirTab, { duplicatePercent: num(e.target.value) })}
                  />
                </Field>
              </div>

              {/* 快捷预设档位 */}
              <div className="row row-wrap" style={{ gap: 8 }}>
                <span className="field-label" style={{ minWidth: 'auto' }}>
                  快捷：
                </span>
                <button
                  className="chip"
                  onClick={() => setDir(dirTab, { bandwidthMbps: 0.25, delayMs: 500, jitterMs: 100, lossPercent: 2 })}
                >
                  2G
                </button>
                <button
                  className="chip"
                  onClick={() => setDir(dirTab, { bandwidthMbps: 1, delayMs: 200, jitterMs: 40, lossPercent: 1 })}
                >
                  3G
                </button>
                <button
                  className="chip"
                  onClick={() => setDir(dirTab, { bandwidthMbps: 4, delayMs: 80, jitterMs: 30, lossPercent: 0.5 })}
                >
                  4G 抖动
                </button>
                <button
                  className="chip"
                  onClick={() => setDir(dirTab, { ...EMPTY_DIR, lossPercent: 10, delayMs: 120 })}
                >
                  高丢包
                </button>
                <button className="chip" onClick={() => setDir(dirTab, { ...EMPTY_DIR })}>
                  清空本向
                </button>
              </div>

              <div className="dir-summary">
                <span className="text-dim">上行</span>
                <Summary dir={params.up} />
                <span className="text-dim" style={{ marginLeft: 12 }}>
                  下行
                </span>
                <Summary dir={params.down} />
              </div>
            </div>
          </Card>

          <Card title="生效范围与时长">
            <div className="col">
              <div className="grid-2">
                <Field label="持续时长" hint="秒，0 = 直到手动停止">
                  <Input
                    type="number"
                    min={0}
                    step={10}
                    value={params.durationSec}
                    onChange={(e) => setTop({ durationSec: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                  />
                </Field>

                <Field label="网络接口" hint={probe ? `自动探测：${probe.iface}` : '自动探测'}>
                  <Select
                    value={params.iface || ''}
                    onChange={(e) => setTop({ iface: e.target.value || undefined })}
                    options={[
                      { value: '', label: probe ? `自动（${probe.iface}）` : '自动' },
                      ...(probe?.ifaces || []).map((i) => ({ value: i, label: i })),
                    ]}
                  />
                </Field>
              </div>

              <div className="row row-wrap" style={{ gap: 20 }}>
                <Switch
                  checked={!!params.blockNetwork}
                  onChange={(v) => setTop({ blockNetwork: v })}
                  label="整体断网（关闭 WiFi 与移动数据）"
                />
              </div>

              {params.durationSec > 0 && (
                <div className="row row-wrap" style={{ gap: 6 }}>
                  <span className="text-dim">快捷时长：</span>
                  {[30, 60, 120, 300, 600].map((s) => (
                    <button key={s} className="chip" onClick={() => setTop({ durationSec: s })}>
                      {s >= 60 ? `${s / 60} 分钟` : `${s} 秒`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ---------------- 右：预设与设备能力 ---------------- */}
        <div className="wn-col wn-col-side">
          <Card
            title="参数预设"
            subtitle="保存当前参数，随时一键复用"
            extra={
              <Badge tone="default">{presets.length} 个</Badge>
            }
          >
            <div className="col">
              {presets.length === 0 ? (
                <Empty title="暂无预设" desc="配置好参数后点击「保存预设」" />
              ) : (
                <div className="wn-preset-list">
                  {presets.map((p) => (
                    <div
                      key={p.id}
                      className={`wn-preset ${presetId === p.id ? 'active' : ''}`}
                      onClick={() => applyPreset(p.id)}
                    >
                      <div className="wn-preset-main">
                        <span className="wn-preset-name">
                          {p.name}
                          {p.builtin && <Badge tone="accent">内置</Badge>}
                        </span>
                        <span className="wn-preset-desc">
                          <Summary dir={p.params.up} />
                          {p.params.blockNetwork && ' · 断网'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {currentPreset && !currentPreset.builtin && (
                <Button variant="ghost" size="sm" onClick={doDeletePreset}>
                  删除「{currentPreset.name}」
                </Button>
              )}
            </div>
          </Card>

          <Card
            title="设备能力"
            subtitle="弱网模拟依赖设备 Root 权限与内核支持"
            extra={
              <Button size="sm" variant="ghost" onClick={probeDevice} loading={probing} disabled={!current}>
                重新探测
              </Button>
            }
          >
            {!probe ? (
              <div className="apps-loading">
                <Spinner size={16} />
                <span>{probing ? '正在探测设备能力…' : '等待探测'}</span>
              </div>
            ) : (
              <div className="col">
                <div className="env-list">
                  <CapRow name="Root 权限" ok={probe.rooted} on="已获取" off="未获取" />
                  <CapRow name="tc 命令" ok={probe.hasTc} on="可用" off="缺失" />
                  <CapRow name="ifb 模块" ok={probe.hasIfb} on="已加载" off="不可用" />
                </div>

                <div className="divider" />

                <div className="kv">
                  <span className="kv-key">生效网卡</span>
                  <span className="kv-value mono">{probe.iface}</span>
                </div>

                <Notice tone={probe.rooted && probe.hasTc ? 'accent' : 'warn'}>
                  {probe.note}
                </Notice>
              </div>
            )}
          </Card>

          <Card title="说明">
            <div className="col" style={{ gap: 8 }}>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                <strong>上行</strong>指设备发出的流量（上传、请求），
                <strong>下行</strong>指设备收到的流量（下载、响应）。
                两者可独立设置，模拟真实网络的不对称特性。
              </p>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                精细参数基于 Linux <span className="mono">tc + netem</span> 实现，
                <strong>需要设备已 Root</strong>；未 Root 时仅支持「整体断网」。
              </p>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                设置持续时长后到点会自动恢复。应用异常退出时也会在下次启动时清理残留规则。
              </p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 小组件                                                              */
/* ------------------------------------------------------------------ */

function Summary({ dir }: { dir: WeakNetDirectionParams }) {
  const parts: string[] = [];
  if (dir.bandwidthMbps) parts.push(`${dir.bandwidthMbps}Mbps`);
  if (dir.delayMs) parts.push(`${dir.delayMs}ms${dir.jitterMs ? `±${dir.jitterMs}` : ''}`);
  if (dir.lossPercent) parts.push(`丢包${dir.lossPercent}%`);
  if (dir.corruptPercent) parts.push(`错包${dir.corruptPercent}%`);
  if (dir.reorderPercent) parts.push(`乱序${dir.reorderPercent}%`);
  if (dir.duplicatePercent) parts.push(`重复${dir.duplicatePercent}%`);
  return <span className="wn-summary mono">{parts.length ? parts.join(' · ') : '无限制'}</span>;
}

function CapRow({ name, ok, on, off }: { name: string; ok: boolean; on: string; off: string }) {
  return (
    <div className="env-row">
      <span className={`env-dot ${ok ? 'ok' : 'bad'}`} />
      <span className="env-name">{name}</span>
      <span className="env-ver text-dim">{ok ? on : off}</span>
    </div>
  );
}
