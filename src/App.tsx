import { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Sidebar, Header, ToastHost, DevicePicker } from './components/layout';
import DragInstallHost from './components/DragInstallHost';
import { useApp } from './store/app';
import { IPC } from '@shared/types';
import type { UpdateResult, AabSigningInfo } from '@shared/types';

import DevicePage from './pages/DevicePage';
import MirrorPage from './pages/MirrorPage';
import ToolsPage from './pages/ToolsPage';
import AppsPage from './pages/AppsPage';
import LogcatPage from './pages/LogcatPage';
import WeakNetworkPage from './pages/WeakNetworkPage';
import CommandPage from './pages/CommandPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';

const PAGE_META: Record<string, { title: string; desc: string }> = {
  '/': { title: '设备', desc: '查看设备状态与详细信息' },
  '/mirror': { title: '投屏', desc: '通过 scrcpy 实时投屏并控制设备' },
  '/tools': { title: '常用工具', desc: '截图、录屏、分辨率、应用安装与文件传输' },
  '/apps': { title: '应用管理', desc: '浏览应用列表，卸载、停止、清数据与提取 APK' },
  '/logcat': { title: '实时 Logcat', desc: '流式抓取设备日志，过滤与一键保存' },
  '/weaknet': { title: '弱网模拟', desc: '模拟带宽、延迟、抖动、丢包等真实网络状况' },
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
      /*
       * 更新握手必须尽早发出：更新助手正靠「健康标记」判断新版是不是真的起来了
       * （主进程活着但白屏也算失败），等超时就会自动回滚。
       * 所以这里只发起、不await，等其它初始化跑完再收结果。
       */
      const handshake = window.adbApi.updateHandshake();

      const res = await window.adbApi.getSettings();
      if (alive && res.ok && res.data) {
        setSettings(res.data);
      } else {
        applyTheme('light');
      }

      /*
       * 把主进程持久化的 AAB 签名配置同步进 store —— 必须在启动时做，不能只靠签名面板。
       *
       * 安装链路读的就是 store 里这份（src/lib/install.ts: `options.signing ?? st.installSigning`），
       * 而 store 的初始值是写死的 { mode: 'bundled-debug' }。以前只有「打开安装页 + 选中 AAB」
       * 才会挂载 SigningPanel 去同步后端配置，于是「把包拖到窗口直接装」这条高频路径
       * 永远拿初始值去装 —— 后端的正式签名根本没机会生效。
       * 表现就是：装完 AAB 后应用能跑，但三方登录（按「包名+签名」校验）当场报
       * Invalid key hash，而用户完全看不出是安装器换了签名。
       */
      const signRes = await window.adbApi.aabSigning();
      if (alive && signRes?.ok && signRes.data) {
        const cfg = (signRes.data as AabSigningInfo).config;
        useApp.getState().setInstallSigning({
          mode: cfg.mode,
          keystorePath: cfg.keystorePath,
          storePass: cfg.storePass,
          keyPass: cfg.keyPass,
          keyAlias: cfg.keyAlias,
        });
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

      // 收更新结果：成功 / 失败已回滚 / 上次没走完
      const up = await handshake;
      if (alive && up?.ok && up.data) {
        const r = up.data as UpdateResult;
        const st = useApp.getState();
        if (r.ok) {
          st.toast('success', `已更新到 v${r.to ?? '新版本'}`, '文件已替换完成，本次为更新后的首次启动');
        } else if (r.rolledBack) {
          st.toast('error', '更新失败，已自动回滚', r.error ?? '');
        } else {
          st.toast('warn', '更新未完成', r.error ?? '');
        }
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
              <Route path="/apps" element={<AppsPage />} />
              <Route path="/logcat" element={<LogcatPage />} />
              <Route path="/weaknet" element={<WeakNetworkPage />} />
              <Route path="/command" element={<CommandPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </div>
        </div>
      </div>
      {/* 整窗拖放安装 + 安装进度弹窗（拖放区无法做在 scrcpy 的原生投屏窗口上） */}
      <DragInstallHost />
      <ToastHost />
    </div>
  );
}
