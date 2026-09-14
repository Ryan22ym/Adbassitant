import { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Sidebar, Header, ToastHost, DevicePicker } from './components/layout';
import { useApp } from './store/app';
import { IPC } from '@shared/types';

import DevicePage from './pages/DevicePage';
import MirrorPage from './pages/MirrorPage';
import ToolsPage from './pages/ToolsPage';
import CommandPage from './pages/CommandPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';

const PAGE_META: Record<string, { title: string; desc: string }> = {
  '/': { title: '设备', desc: '查看设备状态与详细信息' },
  '/mirror': { title: '投屏', desc: '通过 scrcpy 实时投屏并控制设备' },
  '/tools': { title: '常用工具', desc: '截图、录屏、分辨率、应用安装与文件传输' },
  '/command': { title: '命令终端', desc: '直接执行任意 adb 命令' },
  '/logs': { title: '运行日志', desc: '实时查看操作记录并一键导出' },
  '/settings': { title: '设置', desc: '外观、默认目录与环境自检' },
};

export default function App() {
  const location = useLocation();
  const setDevices = useApp((s) => s.setDevices);
  const appendLog = useApp((s) => s.appendLog);
  const setMirror = useApp((s) => s.setMirror);
  const setSettings = useApp((s) => s.setSettings);
  const applyTheme = useApp((s) => s.applyTheme);
  const setLogs = useApp((s) => s.setLogs);

  /* 初始化：读取设置、订阅推送（仅执行一次） */
  useEffect(() => {
    let alive = true;

    (async () => {
      const res = await window.adbApi.getSettings();
      if (alive && res.ok && res.data) {
        setSettings(res.data);
      } else {
        applyTheme('light');
      }

      const logRes = await window.adbApi.getAllLogs();
      if (alive && logRes.ok && logRes.data) {
        setLogs(logRes.data);
      }

      const mirrorRes = await window.adbApi.mirrorStatus();
      if (alive && mirrorRes.ok && mirrorRes.data) {
        setMirror(mirrorRes.data);
      }

      // 首屏主动扫一次设备
      const devRes = await window.adbApi.listDevices();
      if (alive && devRes.ok && devRes.data) {
        useApp.getState().setDevices(devRes.data);
      }
    })();

    /* 订阅主进程推送 */
    const offLog = window.adbApi.on(IPC.PUSH_LOG, (e) => useApp.getState().appendLog(e));
    const offDevice = window.adbApi.on(IPC.PUSH_DEVICE_CHANGED, (d) =>
      useApp.getState().setDevices(d),
    );
    const offMirror = window.adbApi.on(IPC.PUSH_MIRROR_STATUS, (s) => useApp.getState().setMirror(s));
    const offRecord = window.adbApi.on(IPC.PUSH_RECORD_STATUS, (r) => {
      const st = useApp.getState();
      if (r.status === 'done') {
        st.toast('success', '录屏已完成', r.outputPath);
        st.setRecord(null);
      } else if (r.status === 'error') {
        st.toast('error', '录屏出错');
        st.setRecord(null);
      } else {
        st.setRecord(r);
      }
    });

    return () => {
      alive = false;
      offLog();
      offDevice();
      offMirror();
      offRecord();
    };
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meta = PAGE_META[location.pathname] || PAGE_META['/'];

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <Header
          title={meta.title}
          desc={meta.desc}
          actions={location.pathname !== '/' ? <DevicePicker compact /> : undefined}
        />
        <div className="page">
          <div className="page-inner">
            <Routes>
              <Route path="/" element={<DevicePage />} />
              <Route path="/mirror" element={<MirrorPage />} />
              <Route path="/tools" element={<ToolsPage />} />
              <Route path="/command" element={<CommandPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </div>
        </div>
      </div>
      <ToastHost />
    </div>
  );
}
