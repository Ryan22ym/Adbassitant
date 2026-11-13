import { useEffect, useState } from 'react';
import { IPC } from '@shared/types';
import type { MirrorBarState } from '@shared/types';

/**
 * 投屏窗口右侧的悬浮功能栏（v1.1.22）。
 *
 * 🔴 它跑在**独立的小窗口**里（electron/services/mirror-bar.ts 建的那个），
 *    不是主窗口的一段 —— scrcpy 是别的进程的窗口，HTML 画不进去，
 *    只能开个透明小窗贴在它右边。
 *
 * 所以这个组件绝不能带主界面的外壳（侧栏 / 标题栏 / toast），
 * 根节点只有一枚竖排的按钮组，背景全透明（见 styles/mirror-bar.css）。
 *
 * 只做一件事：pin / 解除 pin。位置、置顶、锁尺寸全在主进程（Win32）里办。
 */
export default function MirrorBar() {
  const [state, setState] = useState<MirrorBarState | null>(null);
  const [busy, setBusy] = useState(false);

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

  if (!state?.enabled || !ready) return null;

  return (
    <div className="mbar" data-pinned={pinned ? '1' : '0'}>
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
