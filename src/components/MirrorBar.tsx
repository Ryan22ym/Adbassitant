import { useEffect, useState } from 'react';
import { IPC } from '@shared/types';
import type { MirrorBarState } from '@shared/types';

/**
 * 投屏窗口右侧的悬浮功能栏（v1.1.22 / v1.1.28）。
 *
 * 🔴 它跑在**独立的小窗口**里（electron/services/mirror-bar.ts 建的那个），
 *    不是主窗口的一段 —— scrcpy 是别的进程的窗口，HTML 画不进去，
 *    只能开个透明小窗贴在它右边。
 *
 * 所以这个组件绝不能带主界面的外壳（侧栏 / 标题栏 / toast），
 * 根节点只有一列竖排的按钮，背景全透明（见 styles/mirror-bar.css）。
 *
 * 两个按钮，从上到下：
 *   ① 飞行模式（v1.1.28）：点一次开，再点一次关；开着时琥珀色点亮。
 *   ② pin：钉住 / 解除投屏窗口。位置、置顶、锁尺寸全在主进程（Win32）里办。
 */
export default function MirrorBar() {
  const [state, setState] = useState<MirrorBarState | null>(null);
  const [busy, setBusy] = useState(false);
  const [airplaneBusy, setAirplaneBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.adbApi.mirrorBarState().then((res) => {
      if (alive && res?.ok && res.data) setState(res.data as MirrorBarState);
    });
    const off = window.adbApi.on(IPC.PUSH_MIRROR_BAR, (s: MirrorBarState) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const pinned = !!state?.pinned;
  const ready = !!state?.running;
  const airplane = !!state?.airplane;
  /**
   * 无线连接的设备不给开飞行模式：会把 Wi-Fi 关掉，adb 立刻断，
   * 投屏跟着黑掉，而且再也没法从这个条子上点回来。
   * 主进程也会拦（见 mirror-bar.ts 的 isWirelessSerial），这里只管置灰。
   */
  const wireless = isWireless(state?.serial);

  const toggle = async () => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      const res = await window.adbApi.setMirrorPin(!pinned);
      if (res?.ok && res.data) setState(res.data as MirrorBarState);
    } catch {
      /* 这窗口里没有 toast，失败就让状态自己回来（主进程会推最新状态） */
    } finally {
      setBusy(false);
    }
  };

  const toggleAirplane = async () => {
    if (airplaneBusy || !ready || wireless) return;
    setAirplaneBusy(true);
    try {
      const res = await window.adbApi.setMirrorAirplane(!airplane);
      if (res?.ok && res.data) setState(res.data as MirrorBarState);
    } catch {
      /* 同上：状态以主进程推送为准，切失败就当没点 */
    } finally {
      setAirplaneBusy(false);
    }
  };

  if (!state?.enabled || !ready) return null;

  return (
    <div className="mbar" data-pinned={pinned ? '1' : '0'}>
      <button
        type="button"
        className="mbar-btn"
        onClick={toggleAirplane}
        disabled={airplaneBusy || wireless}
        aria-pressed={airplane}
        aria-label={airplane ? '关闭飞行模式' : '打开飞行模式'}
        title={
          wireless
            ? '无线连接的设备不支持开飞行模式（会断开投屏）'
            : airplane
              ? '关闭飞行模式'
              : '打开飞行模式'
        }
        data-mbar-plane={airplane ? '1' : '0'}
      >
        <PlaneIcon active={airplane} />
      </button>

      <button
        type="button"
        className="mbar-btn"
        onClick={toggle}
        disabled={busy}
        aria-pressed={pinned}
        aria-label={pinned ? '取消钉住投屏窗口' : '钉住投屏窗口'}
        title={pinned ? '取消 pin' : 'pin'}
        data-mbar-pin="1"
      >
        <PinIcon filled={pinned} />
      </button>
    </div>
  );
}

/** 跟主进程 isWirelessSerial 同一套判据：带冒号 / adb-tls / tcp 的都算网络连接 */
function isWireless(serial?: string | null): boolean {
  const v = (serial || '').trim();
  if (!v) return false;
  return v.includes(':') || v.includes('_adb-tls') || v.includes('._tcp');
}

/** 飞机：平时只画描边，开着时填实（跟 pin 的点亮逻辑一致） */
function PlaneIcon({ active }: { active: boolean }) {
  return (
    <svg
      className="mbar-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={active ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 2.2c-.83 0-1.5.67-1.5 1.5v5.1l-8.5 5.1v2l8.5-2.7v4.7l-2.2 1.6v1.6l3.7-.9 3.7.9v-1.6l-2.2-1.6v-4.7l8.5 2.7v-2l-8.5-5.1V3.7c0-.83-.67-1.5-1.5-1.5Z" />
    </svg>
  );
}

/** 图钉：未钉住画描边，钉住后填充并倾斜 45°（图钉插进去的样子） */
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className="mbar-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={filled ? { transform: 'rotate(45deg)' } : undefined}
    >
      <path
        d="M9 3h6l-.8 5.2 3.6 3.4v1.6H6.2v-1.6l3.6-3.4L9 3Z"
        fill={filled ? 'currentColor' : 'none'}
      />
      <path d="M12 13.2V21" />
    </svg>
  );
}
