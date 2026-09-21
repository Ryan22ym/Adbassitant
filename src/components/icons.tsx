import type { ReactNode } from 'react';
import type { QuickActionKind } from '@shared/types';

/**
 * 图标集（内联 SVG，无外部依赖）
 * ============================================================
 * 全应用唯一图标源。新增图标**必须**遵守以下规格，否则会与现有界面不搭：
 *   - 画布 24×24，`viewBox="0 0 24 24"`
 *   - 纯描边：`fill="none"` + `stroke="currentColor"`（不写死颜色）
 *   - 线宽 `strokeWidth="1.8"`（与侧边导航一致），端点/拐角一律 round
 *   - **不在 svg 上写 width/height** —— 尺寸由外层 CSS 决定
 *     （`.nav-icon svg` / `.icon-btn svg` / `.qa-icon svg` …）
 *   - 线宽用 1.8 是为了在 13–17px 的实际显示尺寸下仍然清晰；
 *     若某个图标线条过密，宁可**减笔画**，不要加大线宽
 *
 * 语义约定：颜色由外层 CSS 的 `color` 决定，所以 hover / danger / 选中态
 * 全部自动跟色，图标本身不需要任何状态。
 */

/* ------------------------------------------------------------------ */
/* 通用图标（导航、顶栏、通用按钮）                                     */
/* ------------------------------------------------------------------ */

export const Icon = {
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

  /* 通用小图标：按钮里用，尺寸比上面这套再小一档 */
  bolt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M13.4 2.8L5.6 12.6h5.1l-1.1 8.6 7.9-9.8h-5.1z" strokeLinejoin="round" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" strokeLinecap="round" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4" strokeLinecap="round" />
    </svg>
  ),
  up: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 14.5l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 9.5l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/* 设备快捷动作图标                                                     */
/* ------------------------------------------------------------------ */

/**
 * 12 种内置动作的图形。设计意图（都刻意避开了会引发误读的图形）：
 *
 * | kind         | 图形         | 为什么是它                                   |
 * |--------------|--------------|----------------------------------------------|
 * | clearData    | 橡皮擦       | 「擦除数据」；**故意不用垃圾桶** —— 会被当成卸载 |
 * | homeReturn   | 房子 + 上行箭头 | 回桌面后重新唤起（热启动，房子内部向上）      |
 * | restart      | 单向循环箭头 | 冷启动；与导航 refresh 同族但只有一个箭头      |
 * | restartFresh | 循环箭头 + 斜杠 | 在 restart 上加「清除」标记（清数据后冷启动） |
 * | forceStop    | 圆 + 竖线    | 标准 stop 符号，与「清数据」的红调提示配合    |
 * | launch       | 播放三角     | 启动应用                                     |
 * | screenshot   | 相机         | ——                                           |
 * | home         | 纯房子       | 与 homeReturn 一眼区分（没有内部箭头）        |
 * | back         | 返回键       | Android 返回键（左箭头 + 横线）              |
 * | wake / sleep | 太阳 / 月亮   | 复用导航图标，保持同一套视觉                  |
 * | shell        | 终端窗口     | 复用导航图标                                  |
 */
export const ActionIcon: Record<QuickActionKind, ReactNode> = {
  clearData: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M16.2 4.4l3.4 3.4a1.8 1.8 0 010 2.6l-8.4 8.4H8.3l-3.4-3.4a1.8 1.8 0 010-2.6l8.6-8.4a1.8 1.8 0 012.7 0z"
        strokeLinejoin="round"
      />
      <path d="M4.6 20.6h14.8" strokeLinecap="round" />
    </svg>
  ),
  homeReturn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4.2 10.3L12 3.6l7.8 6.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.2 10.7v8.5a1.2 1.2 0 001.2 1.2h9.2a1.2 1.2 0 001.2-1.2v-8.5" strokeLinecap="round" />
      <path d="M12 17.2v-5.4M9.8 14L12 11.8l2.2 2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  restart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M19.6 8.4A8 8 0 104 12.6" strokeLinecap="round" />
      <path d="M20 4v4.6h-4.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  restartFresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M19.6 8.4A8 8 0 104 12.6" strokeLinecap="round" />
      <path d="M20 4v4.6h-4.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.7 14.3l4.6-4.6" strokeLinecap="round" />
    </svg>
  ),
  forceStop: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 8.4v7.2" strokeLinecap="round" />
    </svg>
  ),
  launch: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7.8 4.9l10.8 7.1-10.8 7.1z" strokeLinejoin="round" />
    </svg>
  ),
  screenshot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M3.2 8.6h3.1l1.5-2.4h8.4l1.5 2.4h3.1a1.6 1.6 0 011.6 1.6v7.6a1.6 1.6 0 01-1.6 1.6H3.2a1.6 1.6 0 01-1.6-1.6v-7.6a1.6 1.6 0 011.6-1.6z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.6" r="3.1" />
    </svg>
  ),
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3.6 10.4L12 3.2l8.4 7.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10.8v8.4a1.2 1.2 0 001.2 1.2h9.6a1.2 1.2 0 001.2-1.2v-8.4" strokeLinecap="round" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5.2 12h13.2" strokeLinecap="round" />
      <path d="M11 5.6L4.6 12l6.4 6.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  wake: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" strokeLinecap="round" />
    </svg>
  ),
  sleep: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" strokeLinejoin="round" />
    </svg>
  ),
  shell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M7 9.5l3 2.5-3 2.5M13 15h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};
