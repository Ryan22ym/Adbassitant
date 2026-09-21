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
import { formatBytes } from '@/lib/format';
import type {
  WeakNetDirectionParams,
  WeakNetEngine,
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
  engine: 'auto',
};

/**
 * 未配置任何参数时点「启动」直接套用的默认弱网档。
 *
 * 旧版在这里把启动按钮置灰并提示"请先设置参数"，用户看到的是一个灰色按钮，
 * 反馈是「不知道怎么实现 / 没找到启动键」—— 所以现在改为：
 * 有设备就可点，未配置时自动套用这个轻度弱网 profile，先让效果跑起来。
 */
const QUICK_PARAMS: WeakNetParams = {
  up: { ...EMPTY_DIR },
  down: { ...EMPTY_DIR, bandwidthMbps: 1, delayMs: 300, jitterMs: 80, lossPercent: 1 },
  durationSec: 60,
  blockNetwork: false,
  engine: 'auto',
};

interface ProbeResult {
  rooted: boolean;
  hasTc: boolean;
  hasIfb: boolean;
  iface: string;
  ifaces: string[];
  hasSvc: boolean;
  hasProxy: boolean;
  /** 能否用 adb 自动写系统全局代理（部分 ROM 会屏蔽） */
  canWriteSettings: boolean;
  /** 设备当前设置的全局 HTTP 代理；非空且未在运行时说明有残留 */
  httpProxy: string | null;
  sdk?: number;
  /* ---------- VPN（v2 首选方案） ---------- */
  /** 设备上是否已安装随包配套 App */
  hasVpnApp: boolean;
  /** 已装 App 的 versionCode */
  vpnAppVersion?: number | null;
  /** VPN 是否已授权；null = 未知（App 没装或通道没通） */
  vpnAuthorized: boolean | null;
  note: string;
}

/** VPN 配套 App 的安装/授权信息（「去授权 / 安装」按钮用） */
interface VpnAppInfo {
  installed: boolean;
  versionCode: number | null;
  authorized: boolean | null;
  vpnActive: boolean;
}

const MODE_TITLE: Record<string, string> = {
  vpn: '弱网模拟生效中（VPN 全量整形）',
  proxy: '弱网模拟生效中（本地代理）',
  tc: '弱网模拟生效中（tc/netem）',
  svc: '断网模式生效中',
  none: '未生效',
};

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

  /* ---------- 换设备 / 启动后重新探测 ---------- */
  useEffect(() => {
    setProbe(null);
    if (current?.serial) void probeDevice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.serial]);

  /* ---------- 设备上的 VPN 配套 App 状态 ---------- */
  const [vpnInfo, setVpnInfo] = useState<VpnAppInfo | null>(null);
  const [vpnBusy, setVpnBusy] = useState(false);

  useEffect(() => {
    if (!current?.serial) {
      setVpnInfo(null);
      return;
    }
    void refreshVpnInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.serial]);

  const refreshVpnInfo = async () => {
    if (!current) return;
    const r = await call<VpnAppInfo>(() => window.adbApi.weaknetVpnAppInfo(current.serial), {
      silent: true,
    });
    if (r) setVpnInfo(r);
  };

  /**
   * 一键授权：在设备上弹出系统 VPN 授权框。
   *
   * 这一步**必须用户手动点**，没有自动化余地 —— Android 要求 VpnService.prepare()
   * 由 Activity 唤起系统对话框。所以界面上只负责把框弹出来 + 告诉用户去哪点。
   */
  const authorizeVpn = async () => {
    setVpnBusy(true);
    try {
      const ok = await call<boolean>(() => window.adbApi.weaknetVpnAuthorize(current?.serial), {
        silent: true,
      });
      if (ok) {
        toast('info', '已弹出授权框', '请在手机屏幕上点「确定」——授权后即可直接用 VPN 模式');
        // 授权是异步的，轮询几次把结果收回来（用户点完确定界面就变绿）
        let tries = 0;
        const id = window.setInterval(async () => {
          tries += 1;
          await refreshVpnInfo();
          void probeDevice();
          if (tries >= 15) window.clearInterval(id);
        }, 2000);
      } else {
        toast(
          'warn',
          '没能弹出授权框',
          '设备上的配套 App 可能未启动，请先在手机上打开一次「弱网模拟」App 再试',
        );
      }
    } finally {
      setVpnBusy(false);
    }
  };

  /** 手动安装 / 更新设备上的配套 App（不传路径就用随包 APK） */
  const installVpnApp = async () => {
    setVpnBusy(true);
    try {
      const r = await call<{ ok: boolean; message: string }>(
        () => window.adbApi.weaknetVpnInstall(current?.serial),
        { silent: true },
      );
      if (r?.ok) {
        toast('success', '配套 App 已安装', '首次使用需要在手机上点一次「确定」授权 VPN');
        void refreshVpnInfo();
        void probeDevice();
      } else {
        toast('error', '安装失败', r?.message || '未知原因');
      }
    } finally {
      setVpnBusy(false);
    }
  };

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
    // 没配置任何参数不再拦住用户：直接套用默认弱网档启动，
    // 避免出现「整个页面找不到启动键」的困惑
    let p = params;
    if (!hasShaping) {
      p = { ...QUICK_PARAMS, engine: params.engine };
      setParams(p);
      toast(
        'info',
        '已套用默认弱网参数',
        '下行 1Mbps · 延迟 300ms±80ms · 丢包 1%，可在下方「参数配置」里调整',
      );
    }
    setBusy(true);
    try {
      const st = await call<WeakNetStatus>(
        () => window.adbApi.weaknetStart(current.serial, p),
        { silent: true },
      );
      setStatus(st);
      if (st?.mode === 'vpn') {
        toast('success', '弱网已生效', 'VPN 全量整形：设备所有 App 的流量都在 IP 层被接管');
      } else if (st?.mode === 'proxy') {
        if (st.proxy?.manual && !st.proxy?.active) {
          toast(
            'warn',
            '通道已就绪，还差一步',
            `请在设备「设置 → WLAN → 修改网络 → 高级 → 代理」填 ${st.proxy.manualAddress}，填好后自动生效`,
          );
        } else {
          toast('success', '弱网已生效', `设备流量已走本地代理 ${st.proxy?.host}:${st.proxy?.port}`);
        }
      } else if (st?.mode === 'tc') {
        toast('success', '弱网已生效', 'tc/netem 内核级模拟');
      } else if (st?.mode === 'svc') {
        toast('success', '已切换为断网模式', st?.note);
      } else if (st?.note && st.note.includes('授权')) {
        // VPN 特有的中间态：等用户在手机上点「确定」。
        // 这不是失败，我们的后台轮询会在授权后自动继续，所以语气要区别于报错。
        toast('warn', '需要在手机上点一次「确定」', st.note);
      } else {
        toast('warn', '未生效', st?.note);
      }
      // 启动后设备上的 http_proxy / VPN 状态都变了，重新探测一次保持一致
      void probeDevice();
      void refreshVpnInfo();
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
      void probeDevice();
    } catch (e) {
      toast('error', '恢复失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 清理残留代理 ---------- */
  const cleanupStale = async () => {
    setBusy(true);
    try {
      const r = await call<{ before: string | null; cleaned: boolean; left?: string | null }>(
        () => window.adbApi.weaknetCleanup(current?.serial),
        { silent: true },
      );
      if (r?.cleaned) toast('success', '已清理残留代理设置', r.before || '');
      else if (r?.left)
        toast(
          'warn',
          '本机 ROM 不允许 adb 清除代理设置',
          `请到「设置 → WLAN → 修改网络 → 高级 → 代理」把「${r.left}」改回「无」`,
        );
      else toast('info', '设备上没有残留的代理设置');
      void probeDevice();
    } catch (e) {
      toast('error', '清理失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 预设 ---------- */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (p) {
      const copy: WeakNetParams = JSON.parse(JSON.stringify(p.params));
      // 预设里不该带实现方式，沿用当前选择
      copy.engine = params.engine;
      setParams(copy);
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

  const engine = (params.engine || 'auto') as WeakNetEngine;
  const canTc = !!(probe?.rooted && probe?.hasTc);

  /**
   * 实际会走哪条路 —— 和主进程的选择逻辑保持一致，避免 UI 和实际不符。
   *
   * 注意这里的优先级与 weaknet.ts 里**必须逐条对应**：VPN → tc → 代理 → svc。
   * 两边不一致时用户会看到「说的和做的不一样」，比不显示更糟。
   */
  const effectiveMode: WeakNetEngine = useMemo(() => {
    if (params.blockNetwork) return 'svc';
    if (engine === 'vpn') return 'vpn';
    if (engine === 'proxy') return 'proxy';
    if (engine === 'svc') return 'svc';
    if (engine === 'tc') return canTc ? 'tc' : 'proxy';
    return 'vpn'; // auto：VPN 是首选
  }, [engine, canTc, params.blockNetwork]);

  const engineLabel = useMemo(() => {
    switch (effectiveMode) {
      case 'vpn':
        return 'VPN 全量整形（免 Root）';
      case 'proxy':
        return '本地代理（免 Root）';
      case 'tc':
        return 'tc/netem 内核级';
      case 'svc':
        return '整体断网';
      default:
        return '未选择';
    }
  }, [effectiveMode]);

  const summaryText = useMemo(() => {
    const parts: string[] = [];
    const d = (x: WeakNetDirectionParams) => {
      const seg: string[] = [];
      if (x.bandwidthMbps) seg.push(`${x.bandwidthMbps}Mbps`);
      if (x.delayMs) seg.push(`${x.delayMs}ms${x.jitterMs ? `±${x.jitterMs}` : ''}`);
      if (x.lossPercent) seg.push(`丢包${x.lossPercent}%`);
      return seg.join(' ');
    };
    const up = d(params.up);
    const down = d(params.down);
    if (up) parts.push(`上行 ${up}`);
    if (down) parts.push(`下行 ${down}`);
    if (params.blockNetwork) parts.push('整体断网');
    return parts.join(' · ') || '无限制';
  }, [params]);

  /** 残留代理：设备上配着代理但我们并没有在跑 */
  const staleProxy = !status.running && !!probe?.httpProxy;

  /** 当前设备未 Root 且 ROM 禁止 adb 写系统设置 —— 代理只能手动配 */
  const needManualProxy = !!probe && !probe.rooted && !probe.hasTc && !probe.canWriteSettings;

  /** 正在跑的手动向导模式：服务就绪但用户还没把代理填好 */
  const awaitingManual =
    status.running && status.mode === 'proxy' && !!status.proxy?.manual && !status.proxy?.active;

  const manualAddr = status.proxy?.manualAddress || '127.0.0.1:17890';

  return (
    <>
      {!current && (
        <Notice tone="warn">
          当前没有可用设备，请先在「设备」页面连接手机并授权 USB 调试。
        </Notice>
      )}

      {staleProxy && (
        <Notice tone="warn">
          检测到设备上残留的代理设置 <span className="mono">{probe?.httpProxy}</span> ——
          通常是上次未正常退出留下的，可能导致设备无法上网。
          <Button size="sm" variant="default" onClick={cleanupStale} loading={busy}>
            一键清理
          </Button>
        </Notice>
      )}

      {needManualProxy && !status.running && (
        <Notice tone="warn">
          本机 ROM（{probe?.sdk ? `Android SDK ${probe.sdk}` : '定制 Android'}）禁止 adb 写系统代理设置 ——
          自动代理不可用。启动后需要你在设备上手动填一次代理地址（界面会给出具体步骤），
          填好后会自动开始注入。
        </Notice>
      )}

      {/* ================= VPN 配套 App：装机 + 授权 ================= */}
      {/*
        这一块只在「可能用 VPN」且还没就绪时出现，避免界面变吵。
        为什么要把授权单独拎出来做卡片：Android 的 VPN 授权**无法绕过**，
        必须用户在手机的系统对话框里点「确定」。提前把这件事说清楚，
        用户第一次点开始时就不会被弹框吓到，也不会以为程序卡住了。
      */}
      {current && probe && !status.running && effectiveMode === 'vpn' && (
        <Card className="wn-vpn-card">
          <div className="wn-vpn-inner">
            <div className="wn-vpn-info">
              <div className="wn-vpn-head">
                <strong>弱网引擎：设备侧 VPN</strong>
                <Badge tone={probe.vpnAuthorized ? 'accent' : 'warn'}>
                  {!probe.hasVpnApp
                    ? '未安装'
                    : probe.vpnAuthorized
                      ? '已授权'
                      : '待授权'}
                </Badge>
              </div>
              <p className="text-dim wn-vpn-desc">
                {!probe.hasVpnApp
                  ? '在设备上安装一个配套 App（随工具一起发布，无需你自己编译），由它在 IP 层接管全部流量。' +
                    '相比旧的代理方案：覆盖所有 App（不只是走系统代理的）、不需要 Root、也不写系统设置、不留代理残留。'
                  : probe.vpnAuthorized
                    ? '已安装并授权，可以直接开始。全部 IPv4 流量会在设备侧被逐包整形，包括那些完全不走代理的 App。'
                    : '配套 App 已装好，还差一次系统授权 —— VPN 会看到全部流量，所以 Android 要求你亲自在手机上点「确定」，' +
                      '这步没法自动代劳。点下面的按钮会把它弹出来。'}
              </p>
            </div>
            <div className="wn-vpn-actions">
              {!probe.hasVpnApp ? (
                <Button variant="primary" onClick={installVpnApp} loading={vpnBusy}>
                  安装配套 App
                </Button>
              ) : !probe.vpnAuthorized ? (
                <Button variant="primary" onClick={authorizeVpn} loading={vpnBusy}>
                  去设备上授权
                </Button>
              ) : (
                <Button variant="default" onClick={refreshVpnInfo} loading={vpnBusy}>
                  重新检测
                </Button>
              )}
            </div>
          </div>
          {probe.hasVpnApp && probe.vpnAuthorized === false && (
            <ol className="wn-vpn-steps">
              <li>点上方「去设备上授权」—— 手机上会弹出系统对话框</li>
              <li>在手机上点「确定」（对话框会说明这是本工具创建的 VPN 连接）</li>
              <li>回到这里直接点「启动弱网模拟」即可，无需重复授权</li>
            </ol>
          )}
        </Card>
      )}

      {/* ================= 主操作区：启动入口 ================= */}
      <Card className={`wn-launch ${status.running ? 'running' : ''}`}>
        <div className="wn-launch-inner">
          <div className="wn-launch-info">
            <div className="wn-launch-title">
              {status.running && <span className="wn-pulse" />}
              <strong>
                {status.running
                  ? awaitingManual
                    ? '等待你在设备上设置代理'
                    : MODE_TITLE[status.mode] || '生效中'
                  : '弱网模拟'}
              </strong>
              <Badge
                tone={
                  status.running ? (awaitingManual ? 'warn' : 'accent') : 'default'
                }
              >
                {status.running && awaitingManual ? '通道已就绪 · 待设置' : engineLabel}
              </Badge>
            </div>
            <p className="text-dim wn-launch-desc">
              {status.running
                ? status.mode === 'vpn'
                  ? `设备侧 VPN 已在 IP 层接管全部流量 · 端口 ${status.vpn?.port ?? 18090} ·
                     ${status.params?.durationSec ? `剩余 ${remain > 0 ? remain : 0} 秒` : '不限时'}`
                  : status.mode === 'proxy' && status.proxy
                    ? awaitingManual
                      ? `代理服务与 USB 通道都已就绪，只差设备上的代理设置 —— 请填 ${manualAddr}`
                      : `设备 HTTP/HTTPS 流量 → ${status.proxy.host}:${status.proxy.port} → 电脑代理 ·
                         ${status.params?.durationSec ? `剩余 ${remain > 0 ? remain : 0} 秒` : '不限时'}`
                    : status.mode === 'tc'
                      ? `tc/netem · 网卡 ${status.iface} ·
                         ${status.params?.durationSec ? `剩余 ${remain > 0 ? remain : 0} 秒` : '不限时'}`
                      : `svc 开关模式 · ${status.params?.durationSec ? `剩余 ${remain > 0 ? remain : 0} 秒` : '不限时'}`
                : hasShaping
                  ? `当前参数：${summaryText}`
                  : '点「启动弱网模拟」会先套用默认弱网档（下行 1Mbps · 延迟 300ms），也可在下方自定义'}
            </p>
          </div>
          <div className="wn-launch-actions">
            {status.running ? (
              <Button variant="danger" size="lg" onClick={stop} loading={busy}>
                立即恢复网络
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                onClick={start}
                loading={busy}
                disabled={!current}
              >
                启动弱网模拟
              </Button>
            )}
          </div>
        </div>

        {/* ---------- 手动代理向导（ROM 禁止自动写设置时） ---------- */}
        {awaitingManual && (
          <div className="wn-manual fade-in">
            <div className="wn-manual-head">
              <strong>还差一步：在设备上设置代理</strong>
              <Badge tone="warn">每秒自动检测</Badge>
            </div>
            <ol className="wn-manual-steps">
              <li>
                设备上打开「设置 → WLAN（无线和网络）」→ 长按当前已连接的网络 → 「修改网络」
              </li>
              <li>展开「高级选项」→ 把「代理」从「无」改为「手动」</li>
              <li>
                主机名填 <span className="mono">{status.proxy?.host || '127.0.0.1'}</span>，
                端口填 <span className="mono">{status.proxy?.port}</span>
              </li>
              <li>保存。填好后本页会自动识别并开始注入，无需回到电脑操作</li>
            </ol>
            <div className="wn-manual-foot">
              <span className="text-dim">
                要填的完整地址：<span className="mono wn-manual-addr">{manualAddr}</span>
              </span>
              <span className="text-dim">
                设备当前代理：<span className="mono">{status.proxy?.current || '未设置'}</span>
              </span>
            </div>
            <p className="text-dim" style={{ fontSize: 12, lineHeight: 1.7 }}>
              注意：停止弱网后，本机 ROM 不允许我们通过 adb 自动清掉这个代理设置，
              请到同一处把「代理」改回「无」，否则设备会一直连不上网。
            </p>
          </div>
        )}

        {!status.running && (
          <div className="wn-engine-row">
            <span className="field-label" style={{ minWidth: 'auto' }}>
              实现方式
            </span>
            <Segmented
              size="sm"
              value={params.blockNetwork ? 'svc' : engine}
              onChange={(v) => {
                if (v === 'svc') setTop({ blockNetwork: true });
                else setTop({ blockNetwork: false, engine: v as WeakNetEngine });
              }}
              options={[
                { value: 'auto', label: '自动' },
                { value: 'vpn', label: 'VPN' },
                { value: 'proxy', label: '本地代理' },
                { value: 'tc', label: 'tc/netem' },
                { value: 'svc', label: '整体断网' },
              ]}
            />
            <span className="text-dim wn-engine-hint">
              {effectiveMode === 'vpn'
                ? probe?.hasVpnApp
                  ? probe.vpnAuthorized
                    ? '免 Root：设备侧 App 建 tun，IP 层全量整形，覆盖所有 App（含不走代理的）'
                    : '免 Root：配套 App 已装，只差一次系统授权（上面那张卡片可以触发）'
                  : '免 Root：开始时自动安装配套 App，首次需要在手机上点一次「确定」授权'
                : effectiveMode === 'proxy'
                  ? needManualProxy
                    ? '免 Root：通道自动建立，但需要你在设备 WLAN 里手动填一次代理地址'
                    : '免 Root：设备流量经 USB 通道打到电脑代理，只覆盖走系统代理的 App'
                  : effectiveMode === 'tc'
                    ? '当前设备已 Root 且支持 tc，保真度最高'
                    : '关闭设备全部网络，用于验证断网降级逻辑'}
            </span>
          </div>
        )}

        {/* ---------- 运行中：实时统计（代理 / VPN 两种模式共用同一组指标） ---------- */}
        {status.running && status.stats && (status.mode === 'vpn' || (status.mode === 'proxy' && status.proxy?.active)) && (
          <div className="wn-stats">
            <StatBox label="活跃连接" value={String(status.stats.active)} />
            <StatBox label="累计连接" value={String(status.stats.connections)} />
            <StatBox label="上行" value={formatBytes(status.stats.upBytes)} />
            <StatBox label="下行" value={formatBytes(status.stats.downBytes)} />
            <StatBox
              label="丢包命中"
              value={String(status.stats.upRetrans + status.stats.downRetrans)}
            />
            <StatBox
              label="乱序命中"
              value={String(status.stats.upReorder + status.stats.downReorder)}
            />
            <StatBox
              label="错报命中"
              value={String(status.stats.upCorrupt + status.stats.downCorrupt)}
            />
          </div>
        )}

        {/* ---------- 运行中：VPN 模式的说明条（含"怎么立刻恢复网络"） ---------- */}
        {status.running && status.mode === 'vpn' && (
          <div className="wn-vpn-live">
            <span className="text-dim">
              设备侧 App 正在 IP 层整形 · 端口 {status.vpn?.port ?? 18090}
              {status.vpn?.reachable === false && ' · ⚠ 控制通道失联，设备将在 15 秒后自动恢复网络'}
            </span>
            <span className="text-dim">
              恢复网络有双保险：点「立即恢复网络」，或直接在设备通知栏里关掉这个 VPN
            </span>
          </div>
        )}
      </Card>

      <div className="wn-layout">
        {/* ---------------- 左：参数配置 ---------------- */}
        <div className="wn-col">
          <Card
            title="弱网参数"
            subtitle="对标 clumsy：分别控制上行（设备发出）与下行（设备接收）"
            extra={
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="ghost" onClick={() => setParams({ ...DEFAULT_PARAMS, engine: params.engine })}>
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

                <Field
                  label="网络接口"
                  hint={effectiveMode === 'proxy' ? '代理模式不需要' : probe ? `自动探测：${probe.iface}` : '自动探测'}
                >
                  <Select
                    value={params.iface || ''}
                    onChange={(e) => setTop({ iface: e.target.value || undefined })}
                    disabled={effectiveMode === 'proxy'}
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
            extra={<Badge tone="default">{presets.length} 个</Badge>}
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
            subtitle="决定使用哪条弱网实现路径"
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
                  <CapRow name="本地代理（免 Root）" ok={probe.hasProxy} on="可用" off="不可用" />
                  <CapRow
                    name="adb 写系统设置"
                    ok={probe.canWriteSettings}
                    on="允许（可自动配代理）"
                    off="被 ROM 屏蔽（需手动配代理）"
                  />
                  <CapRow name="Root 权限" ok={probe.rooted} on="已获取" off="未获取" />
                  <CapRow name="tc 命令" ok={probe.hasTc} on="可用" off="缺失" />
                  <CapRow name="ifb 模块" ok={probe.hasIfb} on="已加载" off="不可用" />
                </div>

                <div className="divider" />

                <div className="kv">
                  <span className="kv-key">上线网卡</span>
                  <span className="kv-value mono">{probe.iface}</span>
                </div>

                <div className="kv">
                  <span className="kv-key">设备当前代理</span>
                  <span className="kv-value mono">{probe.httpProxy || '未设置'}</span>
                </div>

                <Notice tone={probe.hasProxy ? 'accent' : 'warn'}>{probe.note}</Notice>
              </div>
            )}
          </Card>

          <Card title="实现原理与限制">
            <div className="col" style={{ gap: 8 }}>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                <strong>上行</strong>指设备发出的流量（上传、请求），
                <strong>下行</strong>指设备收到的流量（下载、响应）。两者可独立设置，模拟真实网络的不对称特性。
              </p>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                <strong>本地代理（免 Root，推荐）</strong>：通过{' '}
                <span className="mono">adb reverse</span> 把设备流量经 USB 通道打到电脑上的代理，
                再由代理注入弱网参数。延迟、抖动、带宽为精确实现；
                丢包按「队头阻塞」等效、乱序按「附加抖动」等效、重复包按带宽占用折算 ——
                应用层无法像内核那样逐包操作，这是免 Root 的固有限制。
                <br />
                注意：代理**只改变数据的到达节奏，绝不改动字节内容与顺序**
                （TCP 交给应用层的就是有序字节流，真乱序等于篡改内容）——
                唯一例外是「错报」，那是故意篡改，用来验证客户端容错。
              </p>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                代理只覆盖<strong>遵循系统代理的应用</strong>（OkHttp / 浏览器等）。
                不走系统代理的流量（原生 socket、QUIC/UDP、部分游戏）不受影响，
                这类场景需要 <span className="mono">tc/netem</span>（需设备 Root）。
              </p>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                <strong>部分 ROM 会屏蔽 adb 写系统设置</strong>（ColorOS 等定制 Android 13 实测如此）。
                这时代理服务和 USB 通道照常建立，只是需要你到 WLAN 设置里手动填一次地址 ——
                页面会给出地址并每秒自动检测，填好即生效。
                <strong>停止后请把该代理改回「无」</strong>，因为这类 ROM 同样不允许我们自动清除。
              </p>
              <p className="text-dim" style={{ lineHeight: 1.7 }}>
                设置持续时长后到点会自动恢复；停止时也会移除设备上的代理设置。
                若程序异常退出，下次启动会按落盘的会话标记自动把设备恢复干净。
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

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="wn-stat">
      <span className="wn-stat-label">{label}</span>
      <strong className="wn-stat-value mono">{value}</strong>
    </div>
  );
}

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
