import React from 'react';
import { NavLink } from 'react-router-dom';
import { useApp } from '@/store/app';
import { Badge } from './ui';
import { Icon } from './icons';
import './layout.css';

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
  // 在线更新：静默自检到有新版本就在「设置」上挂个点（不弹窗）
  const updateAvailable = useApp((s) => s.updateAvailable);

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
            {item.to === '/settings' && updateAvailable && (
              <span className="nav-dot" title="有新版本可以更新" />
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
