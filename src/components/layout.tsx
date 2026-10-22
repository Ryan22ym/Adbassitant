import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useApp } from '@/store/app';
import { useUiConf } from '@/lib/ui-conf';
import { featureOnOf } from '@shared/ui-conf';
import { Badge, Button } from './ui';
import { Icon } from './icons';
import brandIcon from '@/assets/app-icon.png';
/*
 * 「原神」主题专用的品牌标记（同形换色，见 scripts/make-logo-genshin.py）。
 * 只在应用界面里按主题切换，exe / 任务栏 / 快捷方式仍用 app-icon.png。
 */
import brandIconGenshin from '@/assets/logo-genshin.png';
import './layout.css';

/* ------------------------------------------------------------------ */
/* 侧边导航                                                            */
/* ------------------------------------------------------------------ */

/**
 * 侧栏功能的**定义表**（id → 去哪、叫什么、什么图标）。
 *
 * 这里只放「这个功能是什么」；**顺序与显隐都不在这里**，而是由 Conf/layout.json
 * 的 `sidebar.order`（顺序）和 Conf/features.json 的 `nav.*`（显隐）决定 ——
 * 以前顺序是写死的数组，用户想调就得改代码重编。
 *
 * ⚠️ id 清单是白名单（shared/ui-conf.ts 的 SIDEBAR_IDS），三处必须同名：
 *    这里、SIDEBAR_IDS、以及 Conf/README.md 的对照表。
 */
type NavDef = { to: string; label: string; icon: React.ReactNode; exact?: boolean };

const NAV_DEFS: Record<string, NavDef> = {
  device: { to: '/', label: '设备', icon: Icon.device, exact: true },
  mirror: { to: '/mirror', label: '投屏', icon: Icon.mirror },
  tools: { to: '/tools', label: '常用工具', icon: Icon.tools },
  apps: { to: '/apps', label: '应用管理', icon: Icon.apps },
  logcat: { to: '/logcat', label: '实时 Logcat', icon: Icon.logcat },
  weaknet: { to: '/weaknet', label: '弱网模拟', icon: Icon.weaknet },
  clicker: { to: '/clicker', label: '自动连点器', icon: Icon.clicker },
  command: { to: '/command', label: '命令终端', icon: Icon.terminal },
  /* AI 助手（v1.1.14）：对话 + 崩溃分析报告。排在「设置」之前 */
  ai: { to: '/ai', label: 'AI 助手', icon: Icon.ai },
  settings: { to: '/settings', label: '设置', icon: Icon.settings },
};

export function Sidebar() {
  const devices = useApp((s) => s.devices);
  const onlineCount = devices.filter((d) => d.state === 'device').length;
  // 在线更新：静默自检到有新版本就在「设置」上挂个点（不弹窗）
  const updateAvailable = useApp((s) => s.updateAvailable);
  /*
   * 崩溃分析报告未读数（v1.1.14）：> 0 就在「AI 助手」上亮一枚红点。
   * 这是「有事等你处理」的唯一信号 —— 分析是后台自动跑的，
   * 不亮红点用户根本不知道出过崩溃。
   */
  const crashUnread = useApp((s) => s.crashUnread);
  // 左侧功能栏收起状态（收起后只显示图标，见 layout.css 的 .sidebar.collapsed）
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useApp((s) => s.setSidebarCollapsed);
  // 当前主题：原神主题要用配套的那枚 logo（冷色图标压在暖调侧栏上很突兀）
  const theme = useApp((s) => s.theme);
  const brandMark = theme === 'genshin' ? brandIconGenshin : brandIcon;

  /*
   * 导航项 = 定义表 ∩ Conf。
   * 顺序取 layout.sidebar.order（主进程已把非法 id 滤掉、缺失项补在后面），
   * 再用 features.nav 把关掉的入口摘掉。
   */
  const conf = useUiConf();
  const navItems = conf.layout.sidebar.order
    .map((id) => ({ id, def: NAV_DEFS[id] }))
    .filter((x): x is { id: string; def: NavDef } => !!x.def)
    .filter((x) => featureOnOf(conf, 'nav', x.id));

  /*
   * 收起 / 展开左侧功能栏。
   *
   * 先改内存状态让界面立刻响应，再异步写回主进程做持久化 ——
   * 不 await、也不因写入失败回滚：写不进去（磁盘只读等）最多是下次启动弹回展开，
   * 不该让按钮点了没反应。
   *
   * `rememberCollapsed: false` 时不写盘：用户要的就是「每次启动都回到配置里的形态」，
   * 写了反而会把下次启动的状态带歪。
   */
  const rememberCollapsed = conf.layout.sidebar.rememberCollapsed;
  const toggleCollapsed = () => {
    const next = !collapsed;
    setSidebarCollapsed(next);
    if (rememberCollapsed) window.adbApi.setSettings({ sidebarCollapsed: next });
  };

  const statusText = onlineCount > 0 ? `${onlineCount} 台设备在线` : '未连接设备';

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        {/*
          品牌标记：默认用应用图标（src/assets/app-icon.png，由 scripts/make-icon.py 生成，
          与 exe / 任务栏 / 快捷方式用的那份同源）—— 以前这里是个写死的字母 A，
          换图标时永远漏掉它。
          「原神」主题下换成配套的同形换色版（brandMark，见上面 theme 那段）：
          图标本身是冷色的，压在暖调侧栏上会突兀，但**形状一个字都不改**。
        */}
        <img className="brand-mark" src={brandMark} alt="ADB 助手" draggable={false} />
        <div className="brand-text">
          <strong>ADB 助手</strong>
          <span>v{__APP_VERSION__}</span>
        </div>
      </div>

      {/*
        收起 / 展开开关。
        单独占一行（而不是塞进品牌行或底栏）是有意的：这一行在两种状态下高度完全一致，
        切换时除了宽度以外没有任何东西跳动；品牌区高度也才能继续和右侧顶栏对齐。
      */}
      <div className="sidebar-toggle-row">
        <button
          className="sidebar-toggle"
          onClick={toggleCollapsed}
          title={collapsed ? '展开功能栏' : '收起功能栏'}
          aria-label={collapsed ? '展开功能栏' : '收起功能栏'}
        >
          {collapsed ? Icon.chevronRight : Icon.chevronLeft}
        </button>
      </div>

      <nav className="sidebar-nav">
        {navItems.map(({ def: item }) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            /* 收起后文字标签不显示，用原生 tooltip 把功能名补回来 */
            title={collapsed ? item.label : undefined}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.to === '/' && onlineCount > 0 && (
              <span className="nav-count">{onlineCount}</span>
            )}
            {item.to === '/settings' && updateAvailable && (
              /* 只说「是版本更新」这一件事：一枚红字 New（收起态塞不下，那行隐藏） */
              <span className="nav-new" title="有新版本可以更新">
                New
              </span>
            )}
            {item.to === '/ai' && crashUnread > 0 && (
              /* 崩溃报告未读：一枚纯红点（收起态由 CSS 挪到图标右上角） */
              <span
                className="nav-dot"
                title={`有 ${crashUnread} 份崩溃分析报告待查看`}
                data-crash-dot="1"
              />
            )}
          </NavLink>
        ))}
      </nav>

      {/*
        左下角「检测到新版本」小卡片（v1.1.15）。
        挂在 nav 与 footer 之间：nav 是 flex:1，卡片天然被压到最下面，
        紧贴上面那条「N 台设备在线」，正是用户在截图里圈出来的位置。
        ❗ 收起态不显示 —— 56px 宽塞不下两行字和两个按钮；
           收起时仍由「设置」上那枚 New 承担提示（见上面的 nav-new）。
      */}
      <UpdateTip />

      {/* 收起后只剩一个居中的在线状态圆点（文字由 title 补上） */}
      <div className="sidebar-foot" title={statusText}>
        <span className={`status-dot ${onlineCount > 0 ? 'online' : ''}`} />
        <span className="foot-text">{statusText}</span>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 左下角更新提示卡片                                                  */
/* ------------------------------------------------------------------ */

/**
 * 把更新说明拆成条目（v1.1.15）。
 *
 * 为什么非要拆：更新源里的 notes 是发版脚本塞进去的一句话 —— 线上 v1.1.14 那条
 * 是 **500 多字的整段**，中文不带空格、没有换行。原样铺进 187px 宽的卡片就是一坨
 * 文字墙，滚 6 行也只能看到开头两三个短语。
 *
 * 规则：
 *   · 源里本来就分好行（我们自己的 VERSION_NOTES 就是逐条写的）→ 尊重原结构；
 *   · 只有一整段时才断句：中文/英文句末标点算一处，标点**跟在前一句末尾**；
 *   · 不动内容，不做二次「·」前缀 —— 是否加符号交给渲染端判断。
 */
function splitNotes(raw: string): string[] {
  const text = (raw || '').trim();
  if (!text) return [];
  const byLine = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;
  // 一整段：按句末标点断句，最后一句可能没有标点，用 $ 兜住
  const parts = text.match(/[^。；！？!?;]+[。；！？!?;]+|[^。；！？!?;]+$/g);
  return (parts || [text]).map((s) => s.trim()).filter(Boolean);
}

/** 条目自带项目符号的就不要再补一个，否则会变成「· · xxx」 */
const BULLET_RE = /^[·•\-*—]\s*/;

/**
 * 「检测到新版本」小弹窗（v1.1.15）。
 *
 * 两种操作，语义刻意不同：
 *   · 取消 —— 浅色空白按钮，只是把这张卡片收起来（按版本记，换新版本还会再来）。
 *     它**不会**关掉自动检查：用户说的是「这次别烦我」，不是「以后别查了」。
 *   · 更新 —— 主题色实心按钮，跳到设置页并把更新卡片摊开、直接开始下载。
 *     交接通过 store 的 updateIntent 完成，不是路由 state：
 *     设置页可能已经在挂载状态（本来就停在设置页），路由 state 不会触发任何东西。
 *
 * 🔴 判据是 store 的 updateInfo 而不是 updateAvailable：卡片要显示版本号，
 *    没有版本号说明这条结论不完整（比如手动检查刚失败），宁可不显示。
 */
function UpdateTip() {
  const updateAvailable = useApp((s) => s.updateAvailable);
  const updateInfo = useApp((s) => s.updateInfo);
  const dismissed = useApp((s) => s.updateTipDismissed);
  const dismiss = useApp((s) => s.dismissUpdateTip);
  const setIntent = useApp((s) => s.setUpdateIntent);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const navigate = useNavigate();

  if (collapsed || !updateAvailable || !updateInfo) return null;
  // 这个版本已经被「取消」过了，别再冒出来（换版本会重新出现）
  if (dismissed === updateInfo.version) return null;

  /*
   * 更新说明拆成条目后逐条排；长说明给固定高度 + 内部滚动 —— 不截断成省略号：
   * 「更新了什么」正是用户决定点不点「更新」的唯一依据，看不到就等于没有。
   * 全文同时挂在 title 上，鼠标停一下能看完整版本。
   */
  const notes = (updateInfo.notes || '').trim();
  const items = splitNotes(notes);

  return (
    <div className="update-tip fade-in" data-update-tip={updateInfo.version}>
      <div className="update-tip-head">
        <span className="update-tip-title">检测到新版本</span>
        <span className="update-tip-ver">v{updateInfo.version}</span>
      </div>
      {items.length ? (
        <div className="update-tip-body">
          <div className="update-tip-label">
            更新内容
            {updateInfo.critical && <span className="update-tip-badge">重要</span>}
          </div>
          <div
            className="update-tip-notes"
            data-update-tip-notes={items.length}
            title={notes}
          >
            {items.map((text, i) => (
              <div className="update-tip-item" key={i}>
                {BULLET_RE.test(text) ? text : `· ${text}`}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="update-tip-desc">
          {updateInfo.critical ? '这是一次重要更新，建议尽快升级' : '可在设置页一键下载并安装'}
        </div>
      )}
      <div className="update-tip-actions">
        {/* 浅色空白按钮 */}
        <Button
          size="sm"
          variant="default"
          data-update-tip-cancel="1"
          onClick={() => dismiss(updateInfo.version)}
        >
          取消
        </Button>
        {/* 主题色实心按钮 */}
        <Button
          size="sm"
          variant="primary"
          data-update-tip-go="1"
          onClick={() => {
            setIntent('download');
            navigate('/settings');
          }}
        >
          更新
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 顶栏                                                                */
/* ------------------------------------------------------------------ */

interface HeaderProps {
  title: string;
  desc?: string;
  actions?: React.ReactNode;
}

export function Header({ title, desc, actions }: HeaderProps) {
  const theme = useApp((s) => s.theme);
  const applyTheme = useApp((s) => s.applyTheme);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);

  const toggleTheme = () => {
    const next: 'light' | 'dark' = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    if (settings) {
      const updated = { ...settings, theme: next };
      setSettings(updated);
      window.adbApi.setSettings({ theme: next });
    }
  };

  return (
    <header className="header">
      <div className="header-left">
        <h1 className="header-title">{title}</h1>
        {desc && <p className="header-desc">{desc}</p>}
      </div>
      <div className="header-right">
        {actions}
        <button
          className="icon-btn"
          onClick={toggleTheme}
          title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
        >
          {theme === 'light' ? Icon.moon : Icon.sun}
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* 设备选择器                                                          */
/* ------------------------------------------------------------------ */

export function DevicePicker({ compact }: { compact?: boolean }) {
  const devices = useApp((s) => s.devices);
  const currentSerial = useApp((s) => s.currentSerial);
  const setCurrentSerial = useApp((s) => s.setCurrentSerial);
  const setScanning = useApp((s) => s.setScanning);
  const scanning = useApp((s) => s.scanning);

  const online = devices.filter((d) => d.state === 'device');
  const current = online.find((d) => d.serial === currentSerial);

  const refresh = async () => {
    setScanning(true);
    try {
      const res = await window.adbApi.listDevices();
      if (res.ok && res.data) useApp.getState().setDevices(res.data);
    } finally {
      setScanning(false);
    }
  };

  if (online.length === 0) {
    return (
      <div className="device-picker empty-state">
        <Badge tone="warn" dot>
          无设备
        </Badge>
        <button className="icon-btn sm" onClick={refresh} title="重新扫描">
          {scanning ? <span className="spinner" /> : Icon.refresh}
        </button>
      </div>
    );
  }

  return (
    <div className="device-picker">
      <select
        className="device-select"
        value={currentSerial || ''}
        onChange={(e) => setCurrentSerial(e.target.value)}
      >
        {online.map((d) => (
          <option key={d.serial} value={d.serial}>
            {deviceLabel(d)}
          </option>
        ))}
      </select>
      <button className="icon-btn sm" onClick={refresh} title="重新扫描">
        {scanning ? <span className="spinner" /> : Icon.refresh}
      </button>
      {!compact && current && (
        <Badge tone="success" dot>
          在线
        </Badge>
      )}
    </div>
  );
}

export function deviceLabel(d: {
  model?: string;
  brand?: string;
  androidVersion?: string;
  serial: string;
}): string {
  const name = [d.brand, d.model].filter(Boolean).join(' ') || d.serial;
  const ver = d.androidVersion ? ` · Android ${d.androidVersion}` : '';
  return `${name}${ver}`;
}

/* ------------------------------------------------------------------ */
/* Toast 容器                                                          */
/* ------------------------------------------------------------------ */

export function ToastHost() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone} fade-in`} onClick={() => dismiss(t.id)}>
          <div className="toast-msg">{t.message}</div>
          {t.detail && <div className="toast-detail mono">{t.detail}</div>}
        </div>
      ))}
    </div>
  );
}
