import React from 'react';
import { NavLink } from 'react-router-dom';
import { useApp } from '@/store/app';
import { Badge } from './ui';
import './layout.css';

/* ------------------------------------------------------------------ */
/* 图标（内联 SVG，无外部依赖）                                        */
/* ------------------------------------------------------------------ */

const Icon = {
  device: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="6" y="2.5" width="12" height="19" rx="3" />
      <path d="M10.5 5.5h3" strokeLinecap="round" />
    </svg>
  ),
  mirror: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
      <path d="M8 20.5h8M12 17v3.5" strokeLinecap="round" />
    </svg>
  ),
  tools: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M14.7 6.3a4 4 0 105.4 5.4l-9.1 9.1a2.6 2.6 0 01-3.7-3.7l9.1-9.1z"
        strokeLinejoin="round"
      />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M7 9.5l3 2.5-3 2.5M13 15h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  log: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 3.5h9l5 5v12a1 1 0 01-1 1H5a1 1 0 01-1-1v-16a1 1 0 011-1z" strokeLinejoin="round" />
      <path d="M14 3.5v5h5M8 13h8M8 17h5" strokeLinecap="round" />
    </svg>
  ),
  apps: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8" />
    </svg>
  ),
  logcat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M6.5 9h2M6.5 12.5h6M6.5 16h3.5" strokeLinecap="round" />
      <path d="M16 9h1.5M16 12.5h1.5M16 16h1.5" strokeLinecap="round" />
    </svg>
  ),
  weaknet: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20v-4.5" strokeLinecap="round" />
      <path d="M8.5 12.5a5 5 0 017 0" strokeLinecap="round" />
      <path d="M5.5 9a9.5 9.5 0 0113 0" strokeLinecap="round" />
      <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" strokeLinecap="round" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" strokeLinecap="round" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" strokeLinejoin="round" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M20 11a8 8 0 00-14.3-4.5M4 13a8 8 0 0014.3 4.5" strokeLinecap="round" />
      <path d="M20 4v5h-5M4 20v-5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/* 侧边导航                                                            */
/* ------------------------------------------------------------------ */

const NAV = [
  { to: '/', label: '设备', icon: Icon.device, exact: true },
  { to: '/mirror', label: '投屏', icon: Icon.mirror },
  { to: '/tools', label: '常用工具', icon: Icon.tools },
  { to: '/apps', label: '应用管理', icon: Icon.apps },
  { to: '/logcat', label: '实时 Logcat', icon: Icon.logcat },
  { to: '/weaknet', label: '弱网模拟', icon: Icon.weaknet },
  { to: '/command', label: '命令终端', icon: Icon.terminal },
  { to: '/logs', label: '运行日志', icon: Icon.log },
  { to: '/settings', label: '设置', icon: Icon.settings },
];

export function Sidebar() {
  const devices = useApp((s) => s.devices);
  const onlineCount = devices.filter((d) => d.state === 'device').length;

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">A</div>
        <div className="brand-text">
          <strong>ADB 助手</strong>
          <span>v{__APP_VERSION__}</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.to === '/' && onlineCount > 0 && (
              <span className="nav-count">{onlineCount}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <span className={`status-dot ${onlineCount > 0 ? 'online' : ''}`} />
        <span>{onlineCount > 0 ? `${onlineCount} 台设备在线` : '未连接设备'}</span>
      </div>
    </aside>
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
