import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '@/store/app';
import type { UpdateCheckResult } from '@shared/types';

/**
 * 非设置页的自动更新检测（v1.1.15）。
 *
 * 背景：更新检测以前是**一次性**的 —— App.tsx 启动 8 秒后静默跑一次，之后再没有人查。
 * 于是「早上打开程序，中午才发版」这种情况永远收不到提醒，必须手动去设置页点。
 *
 * 这里做成一条轻量的轮询：
 *   · **复用**现有链路（window.adbApi.checkUpdate → 主进程 services/update.ts 的
 *     checkOnlineUpdate），不另写一套探测逻辑；
 *   · 启动后延迟 8 秒查第一次（别和启动时的设备扫描/环境自检抢带宽），
 *     之后按 updateCheckIntervalMin 轮询（默认 10 分钟，可配置，≤0 = 只查启动那一次）；
 *   · 结果只落到 store：侧栏左下角的「检测到新版本」卡片 + 设置项上的 New 标记。
 *     是否弹 toast 由卡片本身决定，这里不打扰。
 *
 * 🔴 三条不变量：
 *   ① **只有「查成功了且确实没有新版」才允许清掉已有提示**。网络抖动 / 更新源临时
 *      不可用（configured=false / ok=false）时必须保留上一次的结论 —— 否则卡片会
 *      因为一次失败而自己消失，用户永远等不到它。
 *   ② 在设置页时**不轮询**：那边的 UpdatePanel 挂载就会查一次，两边同时发没意义。
 *   ③ 主进程侧另有 5 分钟结果缓存（CHECK_TTL_MS），间隔调到 5 分钟以下也不会真的
 *      打更新源，只是白跑一次 IPC。
 */
const STARTUP_DELAY = 8000;
/** 间隔下限 / 上限（分钟）：1 分钟以内等于持续请求，24 小时以上没有意义 */
const MIN_MINUTES = 1;
const MAX_MINUTES = 24 * 60;

function intervalMs(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const m = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.floor(minutes)));
  return m * 60_000;
}

export function useUpdateWatcher() {
  const settingsReady = useApp((s) => s.settings !== null);
  const autoCheck = useApp((s) => s.settings?.autoCheckUpdate ?? true);
  const baseUrl = useApp((s) => s.settings?.updateBaseUrl ?? '');
  const everyMinutes = useApp((s) => s.settings?.updateCheckIntervalMin ?? 10);
  const pathname = useLocation().pathname;

  /*
   * 同一次会话里每个版本只在**首次发现**时弹一次 toast。
   * 用 ref 而不是 state：它不参与渲染，改它不该引起重渲染。
   */
  const announced = useRef<Set<string>>(new Set());

  /* 设置页有自己的检查入口，别两边一起打 —— 见上面不变量 ② */
  const suppressed = pathname === '/settings';

  useEffect(() => {
    if (!settingsReady) return;
    // 没开自动检查、或者压根没配更新源（服务器未就绪）：什么都不做
    if (!autoCheck) return;
    if (!String(baseUrl || '').trim()) return;
    if (suppressed) return;

    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const run = async () => {
      if (!alive) return;
      try {
        const r = await window.adbApi.checkUpdate(false);
        if (!alive) return;
        const res = (r?.data ?? null) as UpdateCheckResult | null;
        if (!res) return;

        const st = useApp.getState();
        if (res.ok && res.hasUpdate && res.latest?.version) {
          st.setUpdateAvailable(true);
          st.setUpdateInfo({
            version: res.latest.version,
            critical: res.latest.critical,
            /*
             * 这次响应里没带说明时，只有**同一个版本**才沿用上一份 —— 卡片此时正
             * 摊开给用户看，不该因为一次空响应突然把正文抹成空白。
             * 版本号变了就必须跟着换，绝不能把老版本的说明挂在新区号下面。
             */
            notes:
              res.latest.notes ??
              (st.updateInfo?.version === res.latest.version ? st.updateInfo.notes : undefined),
          });
          /*
           * 只有「本次会话第一次看到这个版本」才提示一次。
           * 不加这道闸的话，10 分钟一次的轮询会让同一条 toast 反复出现。
           */
          if (!announced.current.has(res.latest.version)) {
            announced.current.add(res.latest.version);
            st.toast('info', `发现新版本 v${res.latest.version}`, '点左下角提示可直接前往更新');
          }
          return;
        }
        /*
         * 🔴 只有「查成功了且确实没有新版」才清提示（不变量 ①）。
         * !configured / !ok 一律当作「这次没查到」，保留上一次的结论。
         */
        if (res.ok && !res.hasUpdate) {
          st.setUpdateAvailable(false);
          st.setUpdateInfo(null);
        }
      } catch {
        /* 静默：自动检测失败不打扰用户，理由由设置页那条手动路径负责展示 */
      }
    };

    /*
     * 首次延迟 8 秒（与 v1.0.22 的行为一致），之后按配置的间隔轮询。
     * 用「先 setTimeout 再 setInterval」而不是直接 setInterval(delay)：
     * 后者会让第一次也要等满一个间隔。
     */
    const first = setTimeout(() => {
      void run();
      const ms = intervalMs(everyMinutes);
      if (ms > 0) timer = setInterval(() => void run(), ms);
    }, STARTUP_DELAY);

    return () => {
      alive = false;
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, [settingsReady, autoCheck, baseUrl, everyMinutes, suppressed]);
}
