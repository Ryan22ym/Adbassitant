import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/store/app';
import { call, tryCall } from '@/lib/ipc';
import { IPC } from '@shared/types';
import type {
  ClickerStatus,
  CommandResult,
  CrashReportMeta,
  DeviceInfo,
  FavoriteApp,
  LogcatLine,
  WeakNetParams,
  WeakNetStatus,
} from '@shared/types';
import { SIDEBAR_LABELS } from '@shared/ui-conf';

/**
 * 浮动小窗里的「专属紧凑排版」（v1.1.27）。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么不是把整页塞进小窗
 * ────────────────────────────────────────────────────────────────
 * 试过的路：直接渲染 <ToolsPage/> 之类，靠 CSS 压缩。三个问题都是硬伤：
 *   1. 页面的 useEffect 会**再跑一遍** —— 实时 Logcat 页卸载时调 stopLogcat，
 *      小窗一关就把主页面正在跑的抓取停掉了；
 *   2. 整页是为「宽内容区」设计的（三栏、表格、工具条），压到 400px 宽会挤成一团，
 *      不是「自适应」，是「等比缩小」；
 *   3. 小窗的定位是**顺手的仪表盘**，不是第二份完整界面。
 *
 * 所以这里给每个页面写一份专属的紧凑视图：只留「一眼要看的信息 + 一两个主操作」，
 * 需要完整能力时给一个「打开完整页面」的按钮跳过去。
 *
 * 🔴 这些视图**不拥有任何设备侧进程**：只读状态、只做幂等动作
 *    （扫描 / 截图 / 停止 / 执行一条 adb 命令），绝不 startLogcat / startMirror ——
 *    否则关掉小窗会打断主页面正在做的事。
 */

/* ------------------------------------------------------------------ */
/* 小号组件                                                            */
/* ------------------------------------------------------------------ */

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'ok' | 'warn' | 'dim';
}) {
  return (
    <div className="mv-row">
      <span className="mv-label">{label}</span>
      <span className={`mv-value${tone ? ` mv-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function Btn({
  children,
  onClick,
  tone,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: 'primary' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`mv-btn${tone ? ` mv-btn-${tone}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="mv-hint">{children}</div>;
}

function Block({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mv-block">
      <div className="mv-block-head">
        <span className="mv-block-title">{title}</span>
        {extra}
      </div>
      <div className="mv-block-body">{children}</div>
    </section>
  );
}

/** 「跳到完整页面」—— 只导航，**不关闭小窗**（窗口由用户自己关） */
function useFullPage() {
  const nav = useNavigate();
  return (path: string) => {
    /*
     * v1.1.28：小窗已经是独立窗口，它的 router 是空的（没有主界面的路由表）。
     * 在小窗里点「打开完整页面」必须让**主窗口**去导航，自己不能改 hash ——
     * 那只会把这扇小窗变成第二份主界面。
     */
    if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-win') === 'mini-win') {
      void window.adbApi.miniWinGoMain(path);
      return;
    }
    nav(path);
  };
}

function currentDeviceLabel(d?: DeviceInfo): string {
  if (!d) return '未连接';
  return [d.brand, d.model].filter(Boolean).join(' ') || d.serial;
}

/* ------------------------------------------------------------------ */
/* 1. 设备                                                             */
/* ------------------------------------------------------------------ */

function DeviceView() {
  const devices = useApp((s) => s.devices);
  const currentSerial = useApp((s) => s.currentSerial);
  const setDevices = useApp((s) => s.setDevices);
  const setCurrentSerial = useApp((s) => s.setCurrentSerial);
  const toast = useApp((s) => s.toast);
  const goPage = useFullPage();
  const [busy, setBusy] = useState(false);

  const online = devices.filter((d) => d.state === 'device');

  const scan = async () => {
    setBusy(true);
    const r = await tryCall<DeviceInfo[]>(() => window.adbApi.listDevices());
    setBusy(false);
    if (r) {
      setDevices(r);
      toast('success', `扫描完成，${r.filter((d) => d.state === 'device').length} 台在线`);
    } else toast('error', '扫描失败');
  };

  const restartAdb = async () => {
    setBusy(true);
    await tryCall(() => window.adbApi.adbKill());
    const r = await tryCall(() => window.adbApi.adbStart());
    setBusy(false);
    if (r) {
      toast('success', 'adb 服务已重启');
      void scan();
    } else toast('error', 'adb 重启失败');
  };

  return (
    <>
      <Block title="在线设备">
        {online.length === 0 ? (
          <Hint>没有在线设备。检查数据线，或点下面的「重新扫描」。</Hint>
        ) : (
          online.map((d) => (
            <button
              type="button"
              key={d.serial}
              className={`mv-dev${d.serial === currentSerial ? ' active' : ''}`}
              onClick={() => setCurrentSerial(d.serial)}
              title={d.serial}
            >
              <span className="mv-dev-name">{currentDeviceLabel(d)}</span>
              <span className="mv-dev-sub">
                Android {d.androidVersion || '?'} · {d.connection === 'tcp' ? '无线' : 'USB'}
              </span>
            </button>
          ))
        )}
      </Block>
      <div className="mv-actions">
        <Btn onClick={scan} disabled={busy}>
          重新扫描
        </Btn>
        <Btn onClick={restartAdb} disabled={busy}>
          重启 adb
        </Btn>
        <Btn tone="primary" onClick={() => goPage('/')}>
          完整页面
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 2. 投屏                                                             */
/* ------------------------------------------------------------------ */

function MirrorView() {
  const mirror = useApp((s) => s.mirror);
  const toast = useApp((s) => s.toast);
  const goPage = useFullPage();
  const [busy, setBusy] = useState(false);

  const stop = async () => {
    setBusy(true);
    const r = await tryCall(() => window.adbApi.stopMirror());
    setBusy(false);
    if (r !== null) toast('success', '投屏已停止');
  };

  return (
    <>
      <Block title="投屏状态">
        <Row
          label="状态"
          value={mirror.running ? '投屏中' : '未投屏'}
          tone={mirror.running ? 'ok' : 'dim'}
        />
        <Row label="设备" value={mirror.serial || '—'} />
        <Row label="分辨率" value={mirror.options?.maxSize ? `${mirror.options.maxSize}px` : '默认'} />
        <Row label="码率" value={mirror.options?.bitRateMbps ? `${mirror.options.bitRateMbps} Mbps` : '默认'} />
        <Row label="帧率" value={mirror.options?.maxFps ? `${mirror.options.maxFps} fps` : '默认'} />
      </Block>
      <div className="mv-actions">
        {mirror.running && (
          <Btn tone="danger" onClick={stop} disabled={busy}>
            停止投屏
          </Btn>
        )}
        <Btn tone="primary" onClick={() => goPage('/mirror')}>
          打开投屏页
        </Btn>
      </div>
      <Hint>启动投屏要选编码参数，放在投屏页里做。</Hint>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 常用工具                                                         */
/* ------------------------------------------------------------------ */

function ToolsView() {
  const currentSerial = useApp((s) => s.currentSerial);
  const toast = useApp((s) => s.toast);
  const goPage = useFullPage();
  const [busy, setBusy] = useState(false);

  const shot = async () => {
    setBusy(true);
    try {
      const r = await call<{ localPath: string }>(
        () => window.adbApi.captureScreenshot(currentSerial),
        { silent: true },
      );
      toast('success', '截图已保存', r?.localPath);
    } catch (e) {
      toast('error', '截图失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Block title="快捷操作">
        <div className="mv-grid">
          <Btn onClick={shot} disabled={busy || !currentSerial}>
            截 图
          </Btn>
          <Btn onClick={() => goPage('/tools')}>录 屏</Btn>
          <Btn onClick={() => goPage('/tools')}>安装 APK</Btn>
          <Btn onClick={() => goPage('/tools')}>传文件</Btn>
        </div>
      </Block>
      <Hint>录屏 / 安装 / 传输有参数要选，点进去做。</Hint>
      <div className="mv-actions">
        <Btn tone="primary" onClick={() => goPage('/tools')}>
          打开常用工具
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 4. 工具箱（时间戳）                                                  */
/* ------------------------------------------------------------------ */

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function ToolboxView() {
  const toast = useApp((s) => s.toast);
  const goPage = useFullPage();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const sec = Math.floor(now / 1000);
  const d = new Date(now);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const copy = async (text: string, label: string) => {
    const ok = await tryCall(() => window.adbApi.clipboardWrite(text));
    if (ok !== null) toast('success', `已复制${label}`, text);
  };

  return (
    <>
      <Block title="当前时间" extra={<span className="mv-dim">每秒刷新</span>}>
        <Row label="秒" value={String(sec)} />
        <Row label="毫秒" value={String(now)} />
        <Row label="本地" value={stamp} />
      </Block>
      <div className="mv-actions">
        <Btn onClick={() => copy(String(sec), '秒级时间戳')}>复制秒</Btn>
        <Btn onClick={() => copy(String(now), '毫秒时间戳')}>复制毫秒</Btn>
        <Btn tone="primary" onClick={() => goPage('/toolbox')}>
          打开工具箱
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 5. 应用管理（收藏应用）                                              */
/* ------------------------------------------------------------------ */

function AppsView() {
  const currentSerial = useApp((s) => s.currentSerial);
  const toast = useApp((s) => s.toast);
  const goPage = useFullPage();
  const [favs, setFavs] = useState<FavoriteApp[] | null>(null);

  useEffect(() => {
    void tryCall<FavoriteApp[]>(() => window.adbApi.favoriteApps()).then((r) => setFavs(r || []));
  }, []);

  const launch = async (pkg: string) => {
    const r = await tryCall(() => window.adbApi.launchApp(currentSerial, pkg));
    if (r !== null) toast('success', '已启动', pkg);
  };

  return (
    <>
      <Block title="收藏应用" extra={favs ? <span className="mv-dim">{favs.length}</span> : null}>
        {favs === null ? (
          <Hint>读取中…</Hint>
        ) : favs.length === 0 ? (
          <Hint>还没有收藏。在应用管理页把常用的应用收藏起来，这里就能一键启动。</Hint>
        ) : (
          <div className="mv-list">
            {favs.map((f) => (
              <button
                type="button"
                key={f.packageName}
                className="mv-list-item"
                onClick={() => launch(f.packageName)}
                title={`启动 ${f.packageName}`}
              >
                <span className="mv-list-name">{f.label || f.packageName}</span>
                <span className="mv-list-sub">{f.packageName}</span>
              </button>
            ))}
          </div>
        )}
      </Block>
      <div className="mv-actions">
        <Btn tone="primary" onClick={() => goPage('/apps')}>
          打开应用管理
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 6. 实时 Logcat（只读尾巴，不启动抓取）                                */
/* ------------------------------------------------------------------ */

const MINI_LOG_MAX = 120;

function LogcatView() {
  const goPage = useFullPage();
  const currentSerial = useApp((s) => s.currentSerial);
  const toast = useApp((s) => s.toast);
  const [running, setRunning] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<LogcatLine[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void tryCall<{ running: boolean }>(() => window.adbApi.logcatStatus()).then((s) =>
      setRunning(!!s?.running),
    );
    void tryCall<LogcatLine[]>(() => window.adbApi.logcatHistory(MINI_LOG_MAX)).then((h) => {
      if (h) setLines(h.slice(-MINI_LOG_MAX));
    });
    const offLines = window.adbApi.on(IPC.PUSH_LOGCAT_LINES, (batch: LogcatLine[]) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      setLines((prev) => {
        const next = [...prev, ...batch];
        return next.length > MINI_LOG_MAX ? next.slice(next.length - MINI_LOG_MAX) : next;
      });
    });
    /* 抓取状态（v1.1.28）：主窗口里点了开始 / 停止，小窗的按钮要跟着变 */
    const offStatus = window.adbApi.on(IPC.PUSH_LOGCAT_STATUS, (s: { running?: boolean }) =>
      setRunning(!!s?.running),
    );
    return () => {
      offLines();
      offStatus();
    };
  }, []);

  /*
   * 开始 / 停止抓取（v1.1.28）。
   *
   * 🔴 走的仍是主进程那一条 logcat 流，小窗只是另一个「遥控器」——
   *    它不会再起一个 adb logcat 进程。所以在这里点开始，主窗口的
   *    Logcat 页也会立刻进入抓取态（两处订阅同一个 PUSH_LOGCAT_STATUS）。
   */
  const toggle = async () => {
    setBusy(true);
    if (running) {
      const r = await tryCall(() => window.adbApi.stopLogcat());
      setBusy(false);
      if (r !== null) {
        setRunning(false);
        toast('success', '已停止抓取');
      }
      return;
    }
    if (!currentSerial) {
      setBusy(false);
      toast('error', '请先选择设备');
      return;
    }
    const r = await tryCall(() => window.adbApi.startLogcat(currentSerial));
    setBusy(false);
    if (r !== null) {
      setRunning(true);
      toast('success', '开始抓取');
    } else {
      toast('error', '启动失败');
    }
  };

  /* 只有贴在底部时才自动滚（用户往上翻的时候不要抢） */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <>
      <div className="mv-toolbar">
        <span className={`mv-dot${running ? ' on' : ''}`} />
        <span className="mv-dim">{running ? '正在抓取' : '未在抓取'}</span>
        <span className="spacer" />
        <span className="mv-dim">{lines.length} 行</span>
      </div>
      <div className="mv-log" ref={boxRef} data-mini-log="1">
        {lines.length === 0 ? (
          <Hint>没有日志。点下面的「开始抓取」，或去完整 Logcat 页操作。</Hint>
        ) : (
          lines.map((l) => (
            <div key={l.seq} className={`mv-log-line lv-${(l.level || 'I').toLowerCase()}`}>
              {l.raw}
            </div>
          ))
        )}
      </div>
      <div className="mv-actions">
        <Btn tone={running ? 'danger' : 'primary'} onClick={toggle} disabled={busy}>
          {running ? '停止抓取' : '开始抓取'}
        </Btn>
        <Btn onClick={() => goPage('/logcat')}>完整页面</Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 7. 弱网模拟（v1.1.28：小窗内直接调参，不再只是「看一眼」）           */
/* ------------------------------------------------------------------ */

/**
 * 弱网参数的小窗版本。
 *
 * v1.1.27 只显示状态 + 一个「恢复正常」，改参数必须跳去弱网页 ——
 * 用户在设备页调试时最常做的事恰好是「临时加 300ms 延迟试一下」，
 * 跳页会打断手上的操作。所以这里给最常用的三项（延迟 / 丢包 / 带宽）+ 时长，
 * 一个「应用参数」按钮直接 start（主进程会先停掉旧的那次，幂等）。
 *
 * 上行默认跟着下行走：clumsy 那类工具的典型用法是「双向都难受」，
 * 只卡下行会让请求发得出去、响应回不来，手感反而不像弱网。
 */
function WeakNetView() {
  const toast = useApp((s) => s.toast);
  const currentSerial = useApp((s) => s.currentSerial);
  const goPage = useFullPage();
  const [st, setSt] = useState<WeakNetStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ delay: 300, loss: 1, bw: 0, sec: 60 });

  useEffect(() => {
    void tryCall<WeakNetStatus>(() => window.adbApi.weaknetStatus()).then((s) => {
      setSt(s || null);
      /*
       * 第一次读到「正在生效」时把表单对齐到真实参数 ——
       * 否则小窗显示的是一组和实际生效值无关的数字，用户会以为改的就是它。
       * 只对齐一次（st 从 null 变有值时），之后用户的输入不会被推送覆盖。
       */
      if (s?.running && s.params) {
        setForm({
          delay: s.params.down?.delayMs ?? 0,
          loss: s.params.down?.lossPercent ?? 0,
          bw: s.params.down?.bandwidthMbps ?? 0,
          sec: s.params.durationSec ?? 0,
        });
      }
    });
    const off = window.adbApi.on(IPC.PUSH_WEAKNET_STATUS, (s: WeakNetStatus) => setSt(s));
    return () => off();
  }, []);

  const apply = async () => {
    if (!currentSerial) {
      toast('error', '请先选择设备');
      return;
    }
    setBusy(true);
    const params: WeakNetParams = {
      up: { delayMs: form.delay, lossPercent: form.loss },
      down: {
        delayMs: form.delay,
        lossPercent: form.loss,
        bandwidthMbps: form.bw > 0 ? form.bw : undefined,
      },
      durationSec: form.sec,
      engine: 'vpn',
    };
    const r = await tryCall<WeakNetStatus>(() => window.adbApi.weaknetStart(currentSerial, params));
    setBusy(false);
    if (r) {
      setSt(r);
      toast('success', '弱网参数已应用', `${form.delay}ms / ${form.loss}%`);
    } else {
      toast('error', '应用失败', '看运行日志里的原因');
    }
  };

  const restore = async () => {
    setBusy(true);
    const r = await tryCall<WeakNetStatus>(() => window.adbApi.weaknetStop());
    setBusy(false);
    if (r) {
      setSt(r);
      toast('success', '已恢复正常网络');
    }
  };

  const p = st?.params;
  return (
    <>
      <Block title="当前整形">
        <Row label="状态" value={st?.running ? '生效中' : '未生效'} tone={st?.running ? 'ok' : 'dim'} />
        <Row label="方式" value={st?.mode ? st.mode.toUpperCase() : '—'} />
        <Row label="下行" value={p ? `${p.down.delayMs ?? 0}ms / ${p.down.lossPercent ?? 0}%` : '—'} />
        <Row label="上行" value={p ? `${p.up.delayMs ?? 0}ms / ${p.up.lossPercent ?? 0}%` : '—'} />
        <Row
          label="剩余"
          value={st?.remainSec && st.remainSec > 0 ? `${st.remainSec}s` : st?.running ? '不限时' : '—'}
        />
      </Block>

      <Block title="快速调参">
        <div className="mv-form">
          <label className="mv-field">
            <span>延迟</span>
            <input
              type="number"
              min={0}
              step={50}
              value={form.delay}
              onChange={(e) => setForm((f) => ({ ...f, delay: Number(e.target.value) || 0 }))}
            />
            <em>ms</em>
          </label>
          <label className="mv-field">
            <span>丢包</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={form.loss}
              onChange={(e) => setForm((f) => ({ ...f, loss: Number(e.target.value) || 0 }))}
            />
            <em>%</em>
          </label>
          <label className="mv-field">
            <span>带宽</span>
            <input
              type="number"
              min={0}
              step={1}
              value={form.bw}
              onChange={(e) => setForm((f) => ({ ...f, bw: Number(e.target.value) || 0 }))}
            />
            <em>Mbps</em>
          </label>
          <label className="mv-field">
            <span>时长</span>
            <input
              type="number"
              min={0}
              step={10}
              value={form.sec}
              onChange={(e) => setForm((f) => ({ ...f, sec: Number(e.target.value) || 0 }))}
            />
            <em>秒</em>
          </label>
        </div>
      </Block>

      <div className="mv-actions">
        <Btn tone="primary" onClick={apply} disabled={busy || !currentSerial}>
          应用参数
        </Btn>
        <Btn tone="danger" onClick={restore} disabled={busy || !st?.running}>
          恢复正常
        </Btn>
        <Btn onClick={() => goPage('/weaknet')}>完整页面</Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 8. 自动连点器                                                       */
/* ------------------------------------------------------------------ */

function ClickerView() {
  const toast = useApp((s) => s.toast);
  const goPage = useFullPage();
  const [st, setSt] = useState<ClickerStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void tryCall<ClickerStatus>(() => window.adbApi.clickerStatus()).then((s) => setSt(s || null));
    const off = window.adbApi.on(IPC.PUSH_CLICKER_PROGRESS, () => {
      void tryCall<ClickerStatus>(() => window.adbApi.clickerStatus()).then((s) => setSt(s || null));
    });
    return () => off();
  }, []);

  const stop = async () => {
    setBusy(true);
    const r = await tryCall(() => window.adbApi.clickerStop());
    setBusy(false);
    if (r !== null) toast('success', '已停止回放');
  };

  const pct =
    st && st.total > 0 ? Math.min(100, Math.round((st.index / st.total) * 100)) : 0;

  return (
    <>
      <Block title="回放状态">
        <Row label="状态" value={st?.running ? '回放中' : '空闲'} tone={st?.running ? 'ok' : 'dim'} />
        <Row label="轮次" value={st?.round ? `第 ${st.round} 轮` : '—'} />
        <Row label="进度" value={st?.running ? `${st.index + 1}/${st.total}` : '—'} />
        {!!st?.note && <Row label="最近" value={st.note} tone="dim" />}
        {!!st?.error && <Row label="错误" value={st.error} tone="warn" />}
        {st?.running && (
          <div className="mv-progress" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
      </Block>
      <div className="mv-actions">
        <Btn tone="danger" onClick={stop} disabled={busy || !st?.running}>
          停止回放
        </Btn>
        <Btn tone="primary" onClick={() => goPage('/clicker')}>
          打开连点器
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 9. 命令终端                                                         */
/* ------------------------------------------------------------------ */

function CommandView() {
  const currentSerial = useApp((s) => s.currentSerial);
  const goPage = useFullPage();
  const [cmd, setCmd] = useState('shell getprop ro.product.model');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<CommandResult[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  const run = async () => {
    const text = cmd.trim();
    if (!text || busy) return;
    setBusy(true);
    const r = await tryCall<CommandResult>(() => window.adbApi.runAdb(currentSerial, text));
    setBusy(false);
    setOut((prev) => [
      ...prev.slice(-9),
      r || {
        ok: false,
        code: -1,
        stdout: '',
        stderr: '执行失败',
        commandLine: text,
        duration: 0,
      },
    ]);
  };

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [out.length]);

  return (
    <>
      <div className="mv-cmd-input">
        <input
          value={cmd}
          spellCheck={false}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          placeholder="adb 命令（不含 adb 前缀）"
          aria-label="adb 命令"
        />
        <Btn tone="primary" onClick={run} disabled={busy || !cmd.trim()}>
          执行
        </Btn>
      </div>
      <div className="mv-cmd-out" ref={boxRef} data-mini-cmd="1">
        {out.length === 0 ? (
          <Hint>回车执行。只记最近 10 条结果。</Hint>
        ) : (
          out.map((o, i) => (
            <div key={i} className="mv-cmd-item">
              <div className="mv-cmd-code">exit {o.code ?? "—"}</div>
              <pre>{[o.stdout, o.stderr].filter(Boolean).join('\n') || '(无输出)'}</pre>
            </div>
          ))
        )}
      </div>
      <div className="mv-actions">
        <Btn tone="primary" onClick={() => goPage('/command')}>
          打开命令终端
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 10. AI 助手                                                         */
/* ------------------------------------------------------------------ */

function AiView() {
  const reports = useApp((s) => s.crashReports);
  const unread = useApp((s) => s.crashUnread);
  const goPage = useFullPage();

  const recent = reports.slice(0, 4);
  return (
    <>
      <Block
        title="崩溃分析报告"
        extra={<span className={`mv-badge${unread > 0 ? ' on' : ''}`}>{unread} 未读</span>}
      >
        {recent.length === 0 ? (
          <Hint>还没有报告。开启「检测崩溃自动分析」后，应用闪退会自动生成一份。</Hint>
        ) : (
          <div className="mv-list">
            {recent.map((r: CrashReportMeta) => (
              <div key={r.id} className={`mv-list-item${r.read ? '' : ' unread'}`}>
                <span className="mv-list-name">{r.summary || r.packageName || '崩溃报告'}</span>
                <span className="mv-list-sub">{r.packageName || ''}</span>
              </div>
            ))}
          </div>
        )}
      </Block>
      <div className="mv-actions">
        <Btn tone="primary" onClick={() => goPage('/ai')}>
          打开 AI 助手
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 11. 设置（常用项）                                                   */
/* ------------------------------------------------------------------ */

function SettingsView() {
  const settings = useApp((s) => s.settings);
  const theme = useApp((s) => s.theme);
  const applyTheme = useApp((s) => s.applyTheme);
  const setSettings = useApp((s) => s.setSettings);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const setCollapsed = useApp((s) => s.setSidebarCollapsed);
  const goPage = useFullPage();

  /** 与 layout.tsx 的 Header.toggleTheme 同一套写法：先改 DOM/状态，再落盘 */
  const pick = (next: 'light' | 'dark') => {
    applyTheme(next);
    if (settings) {
      setSettings({ ...settings, theme: next });
      void window.adbApi.setSettings({ theme: next });
    }
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    void window.adbApi.setSettings({ sidebarCollapsed: next });
  };

  return (
    <>
      <Block title="快捷设置">
        <Row
          label="深浅模式"
          value={
            <span className="mv-inline">
              <Btn onClick={() => pick('light')} disabled={theme === 'light'}>
                浅色
              </Btn>
              <Btn onClick={() => pick('dark')} disabled={theme === 'dark'}>
                深色
              </Btn>
            </span>
          }
        />
        <Row
          label="功能栏"
          value={
            <Btn onClick={toggleCollapsed}>{collapsed ? '展开' : '收起'}</Btn>
          }
        />
        <Row label="版本" value={`v${__APP_VERSION__}`} tone="dim" />
      </Block>
      <Hint>主题色、目录、更新、AI 配置这些在完整设置页里。</Hint>
      <div className="mv-actions">
        <Btn tone="primary" onClick={() => goPage('/settings')}>
          打开完整设置
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

const VIEWS: Record<string, () => React.ReactElement> = {
  device: DeviceView,
  mirror: MirrorView,
  tools: ToolsView,
  toolbox: ToolboxView,
  apps: AppsView,
  logcat: LogcatView,
  weaknet: WeakNetView,
  clicker: ClickerView,
  command: CommandView,
  ai: AiView,
  settings: SettingsView,
};

/** 小窗标题：与左侧导航同一份中文名（SIDEBAR_LABELS 是唯一真相） */
export function miniTitle(id: string): string {
  return SIDEBAR_LABELS[id] || id;
}

export function MiniView({ id }: { id: string }) {
  const View = VIEWS[id];
  if (!View) return <Hint>没有为「{id}」准备小窗视图。</Hint>;
  return <View />;
}
