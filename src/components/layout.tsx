import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useNavigate } from 'react-router-dom';
import { useApp } from '@/store/app';
import { useUiConf } from '@/lib/ui-conf';
import {
  applyUserOrder,
  featureOnOf,
  SIDEBAR_IDS,
  SIDEBAR_LABELS,
} from '@shared/ui-conf';
import { useMiniWindows } from '@/lib/mini-window';
import { Badge, Button } from './ui';
import { Icon } from './icons';
import brandIcon from '@/assets/app-icon.png';
/*
 * 主题专用品牌标记（同形换色，见 scripts/make-logo-*.py）。
 * 只在应用界面里按主题切换，exe / 任务栏 / 快捷方式仍用 app-icon.png。
 *
 * 🔴 加新主题时这里要同步：THEME_BRAND 里加一条映射 + 生成对应 png。
 *    漏了这一处不会报错，表现是「主题切过去了，左上角还是那枚冷色原图标」——
 *    在主色和侧栏都换掉之后，那块图标是整屏唯一的异色，特别扎眼。
 */
import brandIconGenshin from '@/assets/logo-genshin.png';
import brandIconArknights from '@/assets/logo-arknights.png';
import './layout.css';

/** 主题 → 配套品牌标记。表里没有的主题用主图标（浅色 / 深色 / 透明玻璃） */
const THEME_BRAND: Record<string, string> = {
  genshin: brandIconGenshin,
  arknights: brandIconArknights,
};

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
 *    中文名统一取 SIDEBAR_LABELS（Conf/README.md 的对照表也按那一份写）。
 */
type NavDef = { to: string; label: string; icon: React.ReactNode; exact?: boolean };

const NAV_DEFS: Record<string, NavDef> = {
  device: { to: '/', label: SIDEBAR_LABELS.device, icon: Icon.device, exact: true },
  mirror: { to: '/mirror', label: SIDEBAR_LABELS.mirror, icon: Icon.mirror },
  tools: { to: '/tools', label: SIDEBAR_LABELS.tools, icon: Icon.tools },
  toolbox: { to: '/toolbox', label: SIDEBAR_LABELS.toolbox, icon: Icon.toolbox },
  apps: { to: '/apps', label: SIDEBAR_LABELS.apps, icon: Icon.apps },
  logcat: { to: '/logcat', label: SIDEBAR_LABELS.logcat, icon: Icon.logcat },
  weaknet: { to: '/weaknet', label: SIDEBAR_LABELS.weaknet, icon: Icon.weaknet },
  clicker: { to: '/clicker', label: SIDEBAR_LABELS.clicker, icon: Icon.clicker },
  command: { to: '/command', label: SIDEBAR_LABELS.command, icon: Icon.terminal },
  /* AI 助手（v1.1.14）：对话 + 崩溃分析报告。排在「设置」之前 */
  ai: { to: '/ai', label: SIDEBAR_LABELS.ai, icon: Icon.ai },
  settings: { to: '/settings', label: SIDEBAR_LABELS.settings, icon: Icon.settings },
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
  // 当前主题：自带配色的主题要用配套的那枚 logo（冷色图标压在暖调/近黑侧栏上很突兀）
  const theme = useApp((s) => s.theme);
  const brandMark = THEME_BRAND[theme] ?? brandIcon;

  /*
   * 导航项 = 定义表 ∩ Conf ∩ features。
   *
   * 顺序有**两层**（v1.1.27 起）：
   *   底稿 = Conf/layout.json 的 sidebar.order（没拖过的项按它排）；
   *   覆盖 = settings.json 的 navOrder（用户在侧栏里拖出来的结果）。
   * 只有「导航增强」生效时才吃覆盖值 —— 功能关掉后侧栏立刻回到配置文件顺序，
   * 但 navOrder 不删，重新打开功能立刻恢复上次拖的形态。
   */
  const conf = useUiConf();
  const navAdvanced = useApp((s) => s.navAdvanced.effective);
  const settings = useApp((s) => s.settings);
  const savedOrder = navAdvanced ? settings?.navOrder ?? [] : [];
  const order = applyUserOrder(conf.layout.sidebar.order, savedOrder, SIDEBAR_IDS);
  const navItems = order
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

      {/*
        导航本体交给 NavList：它要管拖拽（v1.1.27）、小窗入口和右键菜单，
        继续堆在这个组件里会让 Sidebar 变成一个什么都做的巨型函数。
      */}
      <NavList
        items={navItems}
        allIds={order}
        collapsed={collapsed}
        onlineCount={onlineCount}
        updateAvailable={updateAvailable}
        crashUnread={crashUnread}
        enhanced={navAdvanced}
      />

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
/* 导航列表（拖拽排序 / 浮动小窗入口 / 右键菜单，v1.1.27）              */
/* ------------------------------------------------------------------ */

/** 导航 id → 图标。小窗标题栏等处复用；唯一真相仍是 NAV_DEFS */
export const NAV_ICONS: Record<string, React.ReactNode> = Object.fromEntries(
  Object.entries(NAV_DEFS).map(([id, d]) => [id, d.icon]),
);

interface NavListProps {
  items: { id: string; def: NavDef }[];
  /** 完整顺序（含被 features 关掉的项）—— 落库时要保住它们的相对位置 */
  allIds: string[];
  collapsed: boolean;
  onlineCount: number;
  updateAvailable: boolean;
  crashUnread: number;
  enhanced: boolean;
}

/**
 * 左侧导航列表。
 *
 * 🔴 拖拽用的是**指针事件 + 位移补偿**，不是 HTML5 draggable：
 *    draggable 的落点反馈由浏览器画（一张半透明快照），既跟不上主题色，
 *    也没有「邻居让位」的过渡；而且它在 Electron 里会和文件拖放（整窗安装）打架。
 *
 * 视觉上的做法（三件事配合才顺）：
 *   1. 被拖的那格 `translateY(跟随指针)`，关掉 transition —— 必须跟手，不能有延迟；
 *   2. 其余格子按「让位方向」`translateY(±step)`，**带 0.18s 过渡** —— 让位是动画；
 *   3. 松手时先换顺序、**同一帧内清掉所有 transform**（.settling 关掉过渡），
 *      于是「换完的位置」和「拖动中的位置」逐像素重合，看不出跳变。
 *
 * 键盘：Alt+↑/↓ 移动当前格 —— 拖拽不能是唯一手段（无障碍要求，也给精确调整留路）。
 */
function NavList({
  items,
  allIds,
  collapsed,
  onlineCount,
  updateAvailable,
  crashUnread,
  enhanced,
}: NavListProps) {
  const openMini = useMiniWindows((s) => s.open);
  /** 已开小窗的页面 id（v1.1.28：给侧栏打标记 + 右键菜单切换文案） */
  const miniWins = useMiniWindows((s) => s.wins);
  const closeMini = useMiniWindows((s) => s.close);
  const listRef = useRef<HTMLElement>(null);

  /**
   * 拖动中的临时形态（松手即清空，真实顺序落在 settings.navOrder 里）。
   *
   * 两个区共用一个状态：
   *   outside=false → 在功能栏里，按 over 让位排序；
   *   outside=true  → 指针已越过功能栏右边缘，**不再排序**，改成「松手开小窗」。
   */
  const [drag, setDrag] = useState<{
    id: string;
    from: number;
    over: number;
    dy: number;
    step: number;
    outside: boolean;
    /** 拖影位置（跟随指针），只在 outside 时有意义 */
    x: number;
    y: number;
  } | null>(null);
  /** 提交顺序的那两帧里关掉过渡，避免「布局已换 + transform 还在动画」的错位 */
  const [settling, setSettling] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const dragRef = useRef<{
    id: string;
    from: number;
    over: number;
    startX: number;
    startY: number;
    step: number;
    centers: number[];
    top: number;
    bottom: number;
    pointerId: number;
    moved: boolean;
    /** 功能栏右边缘（视口坐标）：越过它就切到「开小窗」模式 */
    barRight: number;
  } | null>(null);
  /** 拖完那一下会跟一次 click（会触发导航），吃掉它 */
  const suppressClick = useRef(false);

  /** 落库：先改 store 让界面定格，再异步写盘（失败也不回滚，最多下次启动弹回） */
  const commit = useCallback(
    (nextVisible: string[]) => {
      const st = useApp.getState();
      const s = st.settings;
      const hidden = allIds.filter((id) => !nextVisible.includes(id));
      const next = [...nextVisible, ...hidden];
      setSettling(true);
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => setSettling(false)),
      );
      if (!s) return;
      st.setSettings({ ...s, navOrder: next });
      void window.adbApi.setSettings({ navOrder: next });
    },
    [allIds],
  );

  /** Alt+↑/↓ 把某一格上移/下移一位 */
  const moveBy = (id: string, delta: number) => {
    const ids = items.map((x) => x.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next);
  };

  /** 指针是否已经离开左侧功能栏（右侧留 6px 缓冲，贴边时不要在两种模式间跳） */
  function isOutside(ev: PointerEvent, barRight: number): boolean {
    return ev.clientX > barRight + 6;
  }

  function onPointerMove(ev: PointerEvent) {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.pointerId) return;
    const dx = ev.clientX - d.startX;
    const dy = ev.clientY - d.startY;
    if (!d.moved) {
      // 5px 阈值（两轴取大者）：轻点（导航）和拖动必须分得开，否则点一下就把顺序改了
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 5) return;
      d.moved = true;
    }

    /*
     * 拖出去 = 准备开小窗。
     * 这一支要**立刻停止排序**（over 归位、dy 归零），否则用户看着一格在列表里
     * 让位、松手却弹出窗口，两套反馈互相打脸。列表里那一格改成「被拎走」的半透明态。
     */
    if (isOutside(ev, d.barRight)) {
      setDrag({
        id: d.id,
        from: d.from,
        over: d.from,
        dy: 0,
        step: d.step,
        outside: true,
        x: ev.clientX,
        y: ev.clientY,
      });
      return;
    }

    // 落点 = 中心离指针最近的那一格
    let over = d.from;
    let best = Number.POSITIVE_INFINITY;
    d.centers.forEach((c, i) => {
      const dist = Math.abs(c - ev.clientY);
      if (dist < best) {
        best = dist;
        over = i;
      }
    });
    d.over = over;
    // 拖动位移限制在列表内：拖出侧栏外面时格子不该跟着飞到页面上
    const base = d.centers[d.from];
    const clamped = Math.min(Math.max(dy, d.top - base), d.bottom - base);
    setDrag({
      id: d.id,
      from: d.from,
      over,
      dy: clamped,
      step: d.step,
      outside: false,
      x: ev.clientX,
      y: ev.clientY,
    });
  }

  function onPointerUp(ev: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    dragRef.current = null;

    if (d.moved && ev.pointerId === d.pointerId) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);

      /*
       * 拖到功能栏外面松手 = 把这个页面开成浮动小窗，落在**松手的位置**。
       * 顺序一点不改 —— 这是与「在栏内拖动 = 排序」唯一的分界。
       */
      if (isOutside(ev, d.barRight)) {
        openMini(d.id);
        setDrag(null);
        return;
      }

      if (d.over !== d.from) {
        const ids = items.map((x) => x.id);
        const next = [...ids];
        const [moved] = next.splice(d.from, 1);
        next.splice(d.over, 0, moved);
        setDrag(null);
        commit(next);
        return;
      }
    }
    setDrag(null);
  }

  const onPointerDown = (e: React.PointerEvent, id: string, index: number) => {
    if (!enhanced || e.button !== 0) return;
    // 小窗按钮自己处理点击
    if ((e.target as HTMLElement).closest('[data-mini-open]')) return;
    const root = listRef.current;
    if (!root) return;
    const slots = Array.from(root.querySelectorAll<HTMLElement>('[data-nav-item]'));
    if (slots.length < 2) return;
    const rects = slots.map((n) => n.getBoundingClientRect());
    const centers = rects.map((r) => r.top + r.height / 2);
    /*
     * 功能栏右边缘：判「拖出去」就看它。
     * 用 .sidebar 而不是 .sidebar-nav —— 后者被滚动容器裁过，右边还差一截内边距，
     * 拿它做边界会让「刚出列表但还在栏里」被误判成拖出去。
     */
    const bar = root.closest('.sidebar') as HTMLElement | null;
    const barRight = (bar ?? root).getBoundingClientRect().right;
    dragRef.current = {
      id,
      from: index,
      over: index,
      startX: e.clientX,
      startY: e.clientY,
      step: rects.length > 1 ? rects[1].top - rects[0].top : rects[0].height + 2,
      centers,
      top: rects[0].top,
      bottom: rects[rects.length - 1].bottom,
      pointerId: e.pointerId,
      moved: false,
      barRight,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  /* 右键菜单：点空白处 / Esc 关掉 */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  /* 功能被关掉（重启后）时清掉残留的拖动/菜单形态 */
  useEffect(() => {
    if (!enhanced) {
      setDrag(null);
      setMenu(null);
    }
  }, [enhanced]);

  return (
    <>
      <nav
        ref={listRef}
        className={`sidebar-nav${drag ? ' is-dragging' : ''}${settling ? ' settling' : ''}`}
        data-nav-enhanced={enhanced ? '1' : '0'}
      >
        {items.map(({ id, def: item }, i) => {
          const dragged = drag?.id === id;
          /** 已经被拖到功能栏外面：列表里这一格留在原地淡下去，跟着指针走的是 .nav-tear 拖影 */
          const tearing = dragged && !!drag?.outside;
          let shift = 0;
          if (drag && !dragged && !drag.outside) {
            if (drag.from < drag.over && i > drag.from && i <= drag.over) shift = -drag.step;
            else if (drag.from > drag.over && i >= drag.over && i < drag.from) shift = drag.step;
          }
          return (
            <div
              key={id}
              className={`nav-slot${dragged ? ' dragging' : ''}${tearing ? ' tearing' : ''}${
                shift ? ' shifting' : ''
              }`}
              data-nav-item={id}
              style={
                tearing
                  ? undefined
                  : dragged
                    ? { transform: `translateY(${drag!.dy}px)` }
                    : shift
                      ? { transform: `translateY(${shift}px)` }
                      : undefined
              }
              onPointerDown={enhanced ? (e) => onPointerDown(e, id, i) : undefined}
              onClickCapture={(e) => {
                if (suppressClick.current) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onContextMenu={
                enhanced
                  ? (e) => {
                      e.preventDefault();
                      setMenu({ id, x: e.clientX, y: e.clientY });
                    }
                  : undefined
              }
            >
              <NavLink
                to={item.to}
                end={item.exact}
                /* 收起后文字标签不显示，用原生 tooltip 把功能名补回来 */
                title={collapsed ? item.label : undefined}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                draggable={false}
                onKeyDown={
                  enhanced
                    ? (e) => {
                        if (!e.altKey) return;
                        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                        e.preventDefault();
                        moveBy(id, e.key === 'ArrowUp' ? -1 : 1);
                      }
                    : undefined
                }
              >
                {/*
                  放大版同款图标，只当底图（v1.1.17 明日方舟主题）：
                  同一枚 svg 再渲染一次，CSS 放到 62px、灰化、压到 9% 不透明度，
                  由外层 span 裁掉下半截，露出「上半个放大图标」当每一格的刻印。
                  🔴 不用伪元素是因为图标是 React 节点、伪元素拿不到；
                     不用 background-image 引 png 是因为要跟着图标集同步改。
                  ⚠️ 除 arknights 外的主题靠 CSS display:none 关掉，DOM 常驻不影响它们。
                */}
                <span className="nav-ghost" aria-hidden="true">
                  {item.icon}
                </span>
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
                {/*
                  已在浮动小窗中打开（v1.1.28）。
                  🔴 必须有这个标记：小窗是独立窗口，用户把它拖到副屏或别的窗口后面之后，
                     侧栏是**唯一**能确认「它还开着」的地方，也是右键关掉它的入口。
                */}
                {miniWins.some((w) => w.id === id) && (
                  <span className="nav-mini-flag" title="已在浮动小窗中打开" data-mini-flag={id} />
                )}
              </NavLink>

            </div>
          );
        })}
      </nav>

      {menu && (
        <div
          className="nav-menu"
          style={{ left: menu.x, top: menu.y }}
          data-nav-menu={menu.id}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="nav-menu-item"
            data-mini-menu-open={menu.id}
            onClick={() => {
              if (miniWins.some((w) => w.id === menu.id)) closeMini(menu.id);
              else openMini(menu.id);
              setMenu(null);
            }}
          >
            {Icon.popOut}
            <span>
              {miniWins.some((w) => w.id === menu.id) ? '关闭浮动小窗' : '在浮动小窗中打开'}
            </span>
          </button>
          <div className="nav-menu-hint">
            拖到功能栏外面松手可以开成小窗；在栏内拖动则是调整顺序（Alt+↑/↓ 也行）
          </div>
        </div>
      )}

      {/*
        拖出去的「拖影」。
        🔴 必须 portal 到 body：它要跟着指针跑到内容区，而 .sidebar-nav 是
           overflow:auto 的滚动容器，画在里面会被裁成一条。
        它同时是唯一的「松手会发生什么」提示 —— 拖影出现 = 松手就开小窗。
      */}
      {drag?.outside &&
        createPortal(
          <div
            className="nav-tear"
            style={{ left: drag.x, top: drag.y }}
            data-nav-tear={drag.id}
            aria-hidden="true"
          >
            <span className="nav-tear-icon">{NAV_DEFS[drag.id]?.icon}</span>
            <span className="nav-tear-label">{NAV_DEFS[drag.id]?.label}</span>
            <span className="nav-tear-hint">松手开小窗</span>
          </div>,
          document.body,
        )}
    </>
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
/** 编号条目（`1.` / `2、`）同样不再补点 —— VERSION_NOTES 现在按 1./2./3. 逐条写 */
const NUMBERED_RE = /^\d+\s*[.、)）]/;
/** 分块标题行：`【实时 Logcat】` —— 现行文案已不分块，这里只作旧说明的兼容 */
const SECTION_RE = /^【.+】$/;

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
            {items.map((text, i) => {
              // 分块标题独占一行、加粗；普通条目没自带符号才补「· 」
              if (SECTION_RE.test(text)) {
                return (
                  <div className="update-tip-item update-tip-section" key={i}>
                    {text}
                  </div>
                );
              }
              const hasMark = BULLET_RE.test(text) || NUMBERED_RE.test(text);
              return (
                <div className="update-tip-item" key={i}>
                  {hasMark ? text : `· ${text}`}
                </div>
              );
            })}
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
