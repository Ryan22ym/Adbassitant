import { useEffect, useState } from 'react';
import { useApp } from '@/store/app';
import { Icon } from '@/components/icons';
import { NAV_ICONS, ToastHost } from '@/components/layout';
import { MiniView, miniTitle } from './MiniViews';
import { IPC } from '@shared/types';
import type { CrashReportMeta, DeviceInfo, SharedUiState } from '@shared/types';
import './mini.css';
import './mini-win.css';

/**
 * 浮动小窗的**独立窗口根组件**（v1.1.28）。
 *
 * ────────────────────────────────────────────────────────────────
 * 它和主界面的关系
 * ────────────────────────────────────────────────────────────────
 * 这是一个**独立的渲染进程**（BrowserWindow 由 electron/services/mini-win.ts 建），
 * 有自己的 zustand store。所以它必须自己完成一次轻量 bootstrap：
 *   · 设置（主题 / 主题色）→ 小窗跟着主窗口换色
 *   · 当前设备 → 截图 / 安装 / 命令都要打到同一台机器上
 *   · 设备列表 / 崩溃报告 → 几个视图直接读 store
 *
 * 业务状态（投屏 / 弱网 / 连点器 / logcat）**不在这里初始化**：
 * 它们的真相在主进程，各视图自己按需拉取 + 订阅推送，天然与主窗口一致。
 *
 * 🔴 不要调 `applyTheme`：那个 action 会顺手调 `setGlass` 通知主进程重建窗口，
 *    而玻璃形态是主窗口的事 —— 小窗跟着变会把主窗口拆了重建。
 *    这里只写 <html> 的 data-* 属性。
 * 🔴 玻璃主题在小窗里降级成深色：玻璃的观感依赖主窗口抓来的桌面底图
 *    （.glass-backdrop），小窗没有那张图，硬套只会得到一块灰玻璃。
 */

export default function MiniWinApp({ id }: { id: string }) {
  /*
   * 置顶状态**自己管**，不读主窗口那份 store。
   *
   * 🔴 这是两个渲染进程：小窗里的 useMiniWindows.wins 永远是空的
   *    （那是主窗口侧的镜像），照着它渲染会让 pin 按钮永远显示「未置顶」、
   *    点下去还会被 `togglePin` 的「找不到这扇窗」早退吞掉 —— 表现就是按钮没反应。
   *    这里改成：初始化时从主进程列表里认领自己那一项，之后本地翻转。
   */
  const [pinned, setPinned] = useState(false);
  const setSettings = useApp((s) => s.setSettings);
  /** 首帧先按浅色画，设置回来再切 —— 与主窗口的做法一致 */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void window.adbApi.miniWinList().then(
      (list) => {
        if (!Array.isArray(list)) return;
        const self = list.find((w) => w.id === id);
        if (self) setPinned(!!self.pinned);
      },
      () => {
        /* 拿不到就按未置顶画，不影响使用 */
      },
    );
  }, [id]);

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    void window.adbApi.miniWinPin(id, next);
  };

  useEffect(() => {
    let alive = true;

    (async () => {
      /*
       * 🔴 整段必须容错：任何一次 IPC 失败（主进程还在起、handler 没注册上）
       *    都不能让 setReady 被跳过 —— 那会让 .miniwin-body 一直 opacity:0，
       *    表现就是「小窗开了，但里面是空的」，而且看不出是加载慢还是坏了。
       *    拿不到设置就按默认浅色画，能用的部分照常可用。
       */
      try {
        const [settingsRes, shared] = await Promise.all([
          window.adbApi.getSettings(),
          window.adbApi.uiSharedGet() as Promise<SharedUiState | null>,
        ]);
        if (!alive) return;

        if (settingsRes?.ok && settingsRes.data) {
          setSettings(settingsRes.data);
          /*
           * 玻璃主题降级：不写 data-theme='glass'，改用深色。
           * 其余主题（原神 / 明日方舟）是纯 CSS，小窗可以直接用。
           */
          if (settingsRes.data.theme === 'glass') {
            document.documentElement.setAttribute('data-theme', 'dark');
          }
        }
        if (shared && typeof shared.currentSerial === 'string') {
          // 直接写 state：调 setCurrentSerial 会再上报一次（虽然主进程有等值闸门）
          useApp.setState({ currentSerial: shared.currentSerial });
        }
      } catch {
        /* 设置拿不到就按默认画 */
      } finally {
        if (alive) setReady(true);
      }

      /* 设备列表：与主窗口同一份真相（主进程推送） */
      try {
        const devRes = await window.adbApi.listDevices();
        if (alive && devRes?.ok && devRes.data) {
          useApp.getState().setDevices(devRes.data as DeviceInfo[]);
        }
        /* 崩溃报告：AI 视图要显示未读数 */
        const repRes = await window.adbApi.crashReports();
        if (alive && repRes?.ok && repRes.data) {
          useApp.getState().setCrashReports(repRes.data as CrashReportMeta[]);
        }
      } catch {
        /* 拉不到就等推送 */
      }
    })();

    const offDevice = window.adbApi.on(IPC.PUSH_DEVICE_CHANGED, (d: DeviceInfo[]) =>
      useApp.getState().setDevices(d),
    );
    /* 主窗口换了设备 / 主题 → 小窗跟着换 */
    const offShared = window.adbApi.on(IPC.PUSH_UI_SHARED, (s: SharedUiState) => {
      if (!s) return;
      if (typeof s.currentSerial === 'string') {
        useApp.setState({ currentSerial: s.currentSerial });
      }
      if (s.theme) {
        document.documentElement.setAttribute('data-theme', s.theme === 'glass' ? 'dark' : s.theme);
      }
      if (s.accent) document.documentElement.setAttribute('data-accent', s.accent);
    });
    const offCrash = window.adbApi.on(IPC.PUSH_AI_CRASH_REPORT, (r: CrashReportMeta) =>
      useApp.getState().pushCrashReport(r),
    );

    return () => {
      alive = false;
      offDevice();
      offShared();
      offCrash();
    };
  }, [setSettings]);

  /* Esc 关窗：无边框窗口没有系统关闭按钮，键盘是最快的退出方式 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 输入框里按 Esc 只清焦点，不关窗（命令终端要能反悔）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      void window.adbApi.miniWinClose(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  const title = miniTitle(id);

  return (
    <div className="miniwin" data-mini-ready={ready ? '1' : '0'}>
      {/*
        标题栏：整条可拖动（-webkit-app-region: drag 见 mini-win.css）。
        🔴 按钮必须 no-drag，否则点下去会被当成拖窗，按钮永远点不动。
      */}
      <header className="miniwin-head" data-mini-head="1">
        <span className="miniwin-icon" aria-hidden="true">
          {NAV_ICONS[id] ?? null}
        </span>
        <span className="miniwin-title">{title}</span>
        <span className="spacer" />
        <button
          type="button"
          className={`miniwin-btn${pinned ? ' on' : ''}`}
          data-mini-pin="1"
          title={pinned ? '取消置顶' : '置顶（压在所有窗口之上）'}
          aria-pressed={pinned}
          onClick={() => togglePin()}
        >
          {Icon.pin}
        </button>
        <button
          type="button"
          className="miniwin-btn close"
          data-mini-close="1"
          title="关闭（Esc）"
          aria-label="关闭"
          onClick={() => void window.adbApi.miniWinClose(id)}
        >
          {Icon.close}
        </button>
      </header>

      <div className="miniwin-body">
        <MiniView id={id} />
      </div>

      {/* 视图里 toast() 的落点：没有它，小窗里点按钮会「静悄悄」 */}
      <ToastHost />
    </div>
  );
}
