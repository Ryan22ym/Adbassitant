import { useEffect, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Sidebar, Header, ToastHost, DevicePicker } from './components/layout';
import DragInstallHost from './components/DragInstallHost';
import { useApp } from './store/app';
import { toHexColor, dimOver } from './lib/color';
import { IPC } from '@shared/types';
import type { UpdateResult, UpdateCheckResult, AabSigningInfo } from '@shared/types';
import type { UiConf } from '@shared/ui-conf';

import DevicePage from './pages/DevicePage';
import MirrorPage from './pages/MirrorPage';
import ToolsPage from './pages/ToolsPage';
import AppsPage from './pages/AppsPage';
import LogcatPage from './pages/LogcatPage';
import WeakNetworkPage from './pages/WeakNetworkPage';
import AutoClickerPage from './pages/AutoClickerPage';
import CommandPage from './pages/CommandPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';

const PAGE_META: Record<string, { title: string; desc: string }> = {
  '/': { title: '设备', desc: '查看设备状态与详细信息' },
  '/mirror': { title: '投屏', desc: '通过 scrcpy 实时投屏并控制设备' },
  '/tools': { title: '常用工具', desc: '截图、录屏、分辨率、应用安装与文件传输' },
  '/apps': { title: '应用管理', desc: '已装应用的管理，以及本地安装包按版本自动归类' },
  '/logcat': { title: '实时 Logcat', desc: '流式抓取设备日志，过滤与一键保存' },
  '/weaknet': { title: '弱网模拟', desc: '模拟带宽、延迟、抖动、丢包等真实网络状况' },
  // 连点器页的顶栏描述去掉了（用户反馈这句是废话）：标题「自动连点器」已经说清楚了
  '/clicker': { title: '自动连点器', desc: '' },
  '/command': { title: '命令终端', desc: '直接执行任意 adb 命令' },
  '/logs': { title: '运行日志', desc: '实时查看操作记录并一键导出' },
  '/settings': { title: '设置', desc: '外观、默认目录与环境自检' },
};

/**
 * 页面上的全屏遮罩（有视觉色彩的那些）。
 *
 * 白名单而不是「所有 fixed 全屏层」：.qa-mask（纯透明点击拦截）和 .qa-menu（局部菜单）
 * 也是 fixed，但它们不是遮罩，不该让标题栏跟着变暗。
 */
const SCRIM_SEL = '.install-mask, .qa-dialog-mask';

/**
 * 读当前页面上全屏遮罩的实际底色与透明度（没有则返回 null）。
 *
 * 只认白名单里的两种遮罩（安装弹窗 / 快捷动作配置弹层）—— 不用「找出所有
 * fixed 全屏层」那种通用写法：菜单、下拉这类局部浮层也是 fixed，
 * 但它们不是遮罩，不该让标题栏跟着变暗。
 */
function readScrim(): { color: string; alpha: number } | null {
  const els = document.querySelectorAll(SCRIM_SEL);
  for (const el of Array.from(els)) {
    const bg = getComputedStyle(el).backgroundColor;
    const parts = bg
      .replace(/^rgba?\(|\)$/gi, '')
      .split(/[,\s/]+/)
      .filter(Boolean);
    if (parts.length < 3) continue;
    const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if (!(alpha > 0)) continue;
    const color = toHexColor(`rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`);
    if (!/^#[0-9a-f]{6}$/.test(color)) continue;
    return { color, alpha };
  }
  return null;
}

export default function App() {
  const location = useLocation();
  const setDevices = useApp((s) => s.setDevices);
  const appendLog = useApp((s) => s.appendLog);
  const setMirror = useApp((s) => s.setMirror);
  const setSettings = useApp((s) => s.setSettings);
  const setUiConf = useApp((s) => s.setUiConf);
  const applyTheme = useApp((s) => s.applyTheme);
  const setLogs = useApp((s) => s.setLogs);
  // 标题栏配色要跟着这两个走（见下面同步给主进程的 effect）
  const theme = useApp((s) => s.theme);
  const accent = useApp((s) => s.accent);
  // 当前页面上有没有全屏遮罩（弹窗变暗时右上角系统按钮区要跟着一起压暗）
  const [scrimActive, setScrimActive] = useState(false);
  /*
   * 玻璃主题的「壁纸底图」（data URL）。
   * 由下面那个 effect 从主进程抓一张真实桌面塞进来（见注释）。
   * null = 还没抓到 / 抓失败 → CSS 退回纯色底。
   */
  const [glassWall, setGlassWall] = useState<string | null>(null);

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

      /*
       * 界面配置（Conf/*.json）先取。
       *
       * 侧栏顺序、工具页标签、各页功能块的默认展开收起都由它决定 ——
       * store 的初值是出厂默认，所以没改过配置的用户这里拿到的是同一份，界面不抖；
       * 改过配置的用户会看到一次「按出厂布局画完 → 切到自己的布局」，启动瞬间可以接受。
       */
      const confRes = await window.adbApi.getUiConf();
      if (alive && confRes?.ok && confRes.data) {
        setUiConf(confRes.data as UiConf);
      }

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

      /*
       * 在线更新静默自检（v1.0.22）。
       *
       * 三条约定：
       *  1. 延迟 8 秒再发 —— 别和启动时的设备扫描 / 环境自检抢带宽与 CPU；
       *  2. 必须真的配了更新源才发（服务器没就绪时 updateBaseUrl 为空，发了也是白跑）；
       *  3. 任何失败都**不打扰用户** —— 只在有新版时提示一次，其余情况静默（理由写进运行日志）。
       *     手动的「检查更新」在「关于」页，那条路才需要把失败原因摆出来。
       */
      const maybeAutoCheck = useApp.getState().settings;
      if (alive && maybeAutoCheck?.autoCheckUpdate && String(maybeAutoCheck.updateBaseUrl || '').trim()) {
        setTimeout(() => {
          if (!alive) return;
          void window.adbApi
            .checkUpdate(false)
            .then((r) => {
              const res2 = r?.data as UpdateCheckResult | undefined;
              if (alive && res2?.ok && res2.hasUpdate) {
                useApp.getState().setUpdateAvailable(true);
                useApp
                  .getState()
                  .toast(
                    'info',
                    `发现新版本 v${res2.latest?.version ?? ''}`,
                    '可在「设置 → 软件更新」里一键更新',
                  );
              }
            })
            .catch(() => {
              /* 静默自检失败不打扰 */
            });
        }, 8000);
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

  /*
   * 盯着页面上有没有全屏遮罩，供下面那个标题栏配色的 effect 用。
   *
   * 用 MutationObserver 而不是让每个遮罩组件自己上报：遮罩散在几个组件里
   * （.install-mask 两处、.qa-dialog-mask 一处），将来再加一个就得记得补一行，
   * 漏了又是一块「白补丁」。这里统一盯 body，且**只在进出变动里真的出现了遮罩元素时**
   * 才查一次 DOM —— logcat 那种高频刷 DOM 的页面不会被这段拖慢。
   */
  useEffect(() => {
    const sync = () => {
      const next = !!document.querySelector(SCRIM_SEL);
      setScrimActive((prev) => (prev === next ? prev : next));
    };
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)]) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          // 遮罩通常就是被插入/移除的那个元素；带一层 querySelector 兜底，
          // 免得将来有人把它包进别的容器里（Fragment 不产生节点，不影响）。
          if (el.matches(SCRIM_SEL) || (el.firstElementChild && el.querySelector(SCRIM_SEL))) {
            sync();
            return;
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => mo.disconnect();
  }, []);

  /*
   * 标题栏配色跟随主题。
   *
   * 窗口是 titleBarStyle:'hidden'（见 electron/main.ts）：顶部那条整宽色带由页面自己画
   * （.titlebar，底色 = --bg-titlebar，侧栏色与内容区色混出的第三档），
   * 但右上角那三个系统按钮所在区域只能由主进程设置，所以要把渲染色回传。
   *
   * 🔴 取的是 .titlebar 的 computed backgroundColor，**不是** --bg-titlebar 变量：
   * 那个变量是 color-mix() 表达式，getPropertyValue 拿到的是没求值的式子；
   * 而元素的 backgroundColor 是浏览器算完的色（可能长成 `color(srgb 0.9 …)`），
   * 还要再经 toHexColor 归一成 #rrggbb —— 主进程只认这一种写法。
   * 配色表的唯一来源仍然只有 src/styles/global.css。
   *
   * 🔴 符号色单独走 --titlebar-symbol，**不再直接用 --text-primary**：
   * --text-primary 是给内容区配的，标题栏底色与内容区**不一定同明暗** ——
   * 原神主题就是「米白内容区 + 深靛蓝标题栏」，拿内容区的深墨字去画窗口按钮
   * 等于隐形（用户反馈「右上角那几个看不清」就是这个）。
   * 该变量的默认值仍是 --text-primary，所以浅色/深色/各主题色行为不变。
   */
  useEffect(() => {
    const bar = document.querySelector('.titlebar') as HTMLElement | null;
    const cs = getComputedStyle(document.documentElement);
    const base = toHexColor(bar ? getComputedStyle(bar).backgroundColor : '');
    if (!/^#[0-9a-f]{6}$/.test(base)) return;
    /*
     * 两道兜底：新变量可能没定义（老版本 CSS），也可能定义成了不可解析的表达式。
     * 无论哪种都退回 --text-primary —— 拿不到合法 #rrggbb 就绝不往下传，
     * 主进程会整条 setTitleBarOverlay 抛错跳过，反而把按钮留在上一个主题的颜色上。
     */
    const fallback = cs.getPropertyValue('--text-primary').trim();
    let symbolBase = toHexColor(cs.getPropertyValue('--titlebar-symbol').trim() || fallback);
    if (!/^#[0-9a-f]{6}$/.test(symbolBase)) symbolBase = toHexColor(fallback);

    /*
     * 有全屏遮罩时，连右上角那块系统按钮区一起压暗。
     *
     * 它会「亮」是因为：titleBarOverlay 由主进程画在渲染内容之外，
     * 页面上的 .install-mask 之类盖不到它 —— 弹窗一出，整屏都暗了，只有右上角
     * 还是原色，像贴了块高亮补丁（用户反馈的正是这个）。
     * 盖不住就反过来算：按遮罩的实际色与透明度求出「被盖住后」的颜色再回传。
     * 🔴 遮罩色/透明度从遮罩元素的计算样式里现读（不在这里抄一份常量），
     *    免得以后改了 CSS 两边不同步。
     */
    const scrim = scrimActive ? readScrim() : null;
    const color = scrim ? dimOver(base, scrim.color, scrim.alpha) : base;
    const symbolColor =
      scrim && /^#[0-9a-f]{6}$/.test(symbolBase)
        ? dimOver(symbolBase, scrim.color, scrim.alpha)
        : symbolBase;

    void window.adbApi.setTitlebar({ color, symbolColor });
  }, [theme, accent, scrimActive]);

  /*
   * 透明玻璃主题：抓桌面壁纸 + 铺到页面最底层（v1.1.13，2026-10-13 修正）。
   *
   * 🔴🔴 为什么不再走系统 Acrylic（这一版改动的核心）：
   *    原方案指望 `backgroundMaterial:'acrylic'` 让真实桌面透上来并被系统磨砂。
   *    但 Electron 在 **Windows 10 上不渲染 Acrylic**（上游 issue #48440，内部用的是
   *    Win11 接口、没有 Win10 回落）；而一旦窗口 transparent:true，
   *    CSS 的 backdrop-filter 也会一起失效（页面背后是空的，没东西可采样）。
   *    ⇒ 两套模糊全死：壁纸原样清晰透出，模糊滑杆怎么拖都没反应。
   *
   *    现改为「模拟玻璃」：主进程抓一张**真实桌面**（IPC.WINDOW_GRAB_DESKTOP），
   *    铺成本页面最底层的 `.glass-backdrop`。于是：
   *      · 壁纸仍是用户自己的桌面（观感目标不变，不是编造的假图）；
   *      · backdrop-filter 背后有实底 ⇒ 模糊滑杆真正生效；
   *      · 不依赖系统私有接口，Win10 / Win11 表现一致。
   *
   * ⚠️ 时序：必须**先**把壁纸铺好、再让面板去糊它。这里用一个 state（glassWall）
   *    控制挂载，抓到就渲染、抓不到就退回纯色（不阻塞界面、也不白屏）。
   * 🔴 只抓一次：每次切主题都重抓会让切主题明显卡顿（截图本身要几百毫秒）。
   *    桌面换了怎么办？下次启动会重新抓 —— 这是可接受的代价。
   */
  useEffect(() => {
    // 主进程那边只负责窗口底色的明暗（Acrylic 已移除），幂等，随手同步即可
    void window.adbApi?.setGlass(theme === 'glass');
    if (theme !== 'glass') return;

    let cancelled = false;
    (async () => {
      try {
        /*
         * 🔴 返回值是 { ok, data, error } 信封（ipc.ts 的 wrap()），必须取 .data。
         *    漏了这层会导致把整个信封对象当 data URL 用 —— 表现为
         *    `url.slice is not a function`，且 .glass-backdrop 背景是 none（一片空）。
         */
        const res = await window.adbApi?.grabDesktop?.();
        const url = res && res.ok ? res.data : null;
        if (!cancelled && typeof url === 'string' && url) setGlassWall(url);
      } catch {
        /* 抓不到就保持 null，CSS 会退回纯色底，不影响使用 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [theme]);

  /*
   * 玻璃主题下窗口是无边框的，系统标题栏与它自带的最小化/最大化/关闭按钮
   * **全部消失** —— 右上角那三个 macOS 风格圆点由渲染层自绘（见下面的
   * .window-lights），点击后回调主进程执行真实动作。
   *
   * 只在玻璃主题渲染它们：普通主题仍用系统按钮，多画三个圆点是多余的。
   */
  const isGlass = theme === 'glass';

  return (
    <div className="app-shell">
      {/*
        玻璃主题的「壁纸层」—— 页面内最底的一张真实桌面截图（v1.1.13 修正）。

        🔴 它是整个玻璃效果的地基，位置和层级都不能动：
          · `position:fixed; inset:0` → 铺满视口，不受任何容器滚动影响；
          · `z-index:-1` → 压在 .app-shell 的所有内容之下，但它们仍能 backdrop-filter 到它；
          · 它**必须是页面内的真实 DOM 元素**，不能是 CSS background-image：
            backdrop-filter 只能采样「页面内、自己背后的像素」，CSS 背景图不算。

        ⚠️ 抓到之前（glassWall === null）不渲染它 —— 此时窗口底色是深色
           （见主进程 applyGlassWindow），不会闪白。
      */}
      {isGlass && glassWall && (
        <div
          className="glass-backdrop"
          style={{ backgroundImage: `url(${glassWall})` }}
          aria-hidden="true"
        />
      )}

      {/*
        自绘标题栏。窗口已经没有系统标题栏了，这一条既提供底色（跟着主题色走），
        也是拖窗口 / 双击最大化的地方（-webkit-app-region: drag 在 CSS 里）。
        整条同色、内部不放任何元素 —— 原来那两段（侧栏宽的一段 + 剩余一段）
        是为了让侧栏竖线通到窗口顶，现在不需要了，竖线留着反而像多出来的分割线。
      */}
      <div className="titlebar">
        {isGlass && (
          <div className="window-lights">
            <button
              type="button"
              className="window-light min"
              title="最小化"
              aria-label="最小化"
              onClick={() => void window.adbApi?.winMinimize()}
            />
            <button
              type="button"
              className="window-light max"
              title="最大化"
              aria-label="最大化"
              onClick={() => void window.adbApi?.winToggleMax()}
            />
            <button
              type="button"
              className="window-light close"
              title="关闭"
              aria-label="关闭"
              onClick={() => void window.adbApi?.winClose()}
            />
          </div>
        )}
      </div>

      <div className="app-body">
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
                <Route path="/clicker" element={<AutoClickerPage />} />
                <Route path="/command" element={<CommandPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </div>
          </div>
        </div>
      </div>
      {/* 整窗拖放安装 + 安装进度弹窗（拖放区无法做在 scrcpy 的原生投屏窗口上） */}
      <DragInstallHost />
      <ToastHost />
    </div>
  );
}
