import type { AccentId } from '@shared/types';

/*
 * 自定义主题色（v1.1.14）。
 *
 * 用户在设置页用色盘挑**一个**颜色，这里把它展开成整套界面要用的十几个变量，
 * 以内联自定义属性写到 <html> 上（内联优先级最高，压过 global.css 的所有变量块）。
 *
 * ------------------------------------------------------------------
 * 🔴 为什么是「派生」而不是让用户挑十几个颜色：
 *    内置的六套主题色，每一套都是十几条变量手写调和的（背景、边框、卡片、
 *    主色三档……）。要用户自己调这些是不现实的，所以只收一个色值，
 *    其余全部按色相 / 饱和度 / 明度**算**出来 —— 用户挑的其实是一个「色相」，
 *    明暗层次由这里保证。
 *
 * 🔴 明度为什么要钳制：
 *    用户可能挑一个接近纯白或纯黑的颜色。直接用的话，浅色主题下白底白字
 *    （按钮看不见），深色主题下黑底黑字。所以：
 *      · 浅色主题：主色的 L 钳到 34%~62%（保证在白底上够深、够醒目）
 *      · 深色主题：主色的 L 钳到 62%~78%（保证在深底上够亮）
 *    色相与「这个色到底偏红还是偏青」完全保留 —— 用户看到的还是自己挑的那个色。
 *
 * 🔴 底色怎么压：这套系数**不是拍脑袋**，是拿内置七套主题色反推出来的。
 *    以侧栏 --bg-sidebar 为例（HSL 里 l 都在 0.87 附近，只有色相和饱和度在动）：
 *      苍穹 主色 s=0.73 → 侧栏 s=0.79（×1.07）  远山 0.57 → 0.69（×1.21）
 *      雾青 0.36 → 0.48（×1.34）              墨玉 0.13 → 0.22（×1.79）
 *      淡粉 0.54 → 0.62（×1.15）              樱花 0.69 → 0.75（×1.08）
 *    也就是说「侧栏饱和度 ≈ 主色饱和度 × 1.0~1.8」，**不是**往灰里压到很低。
 *    第一版把侧栏压到 22% 封顶，结果用户挑一个很艳的品红，侧栏几乎还是灰的 ——
 *    看起来像「颜色没生效」。所以现在按 ×1.05 走（并封顶 0.85，
 *    避免挑到极高饱和的色时侧栏变成一块塑料板）。
 *
 *    深色那一套的系数明显更小（内置值反推：侧栏 ×0.5、卡片 ×0.37、边框 ×0.30）——
 *    深底上同样的饱和度会显得更艳，必须收着来。
 *    两张系数表都写在下面的分支里，改之前请先照上面对一遍内置主题。
 *
 * ⚠️ 新增 / 删除被覆盖的变量时，只改下面 CUSTOM_ACCENT_VARS 一处 ——
 *    applyCustomAccent / clearCustomAccent 都从它推导。
 */

/** 会被内联覆盖的变量清单（切回内置主题色时必须逐个删除，否则会残留） */
export const CUSTOM_ACCENT_VARS = [
  /* 主色三档 + 淡底 */
  '--accent',
  '--accent-hover',
  '--accent-soft',
  '--accent-border',
  /* 背景与卡片 */
  '--bg-app',
  '--bg-sidebar',
  '--bg-sidebar-hover',
  '--bg-sidebar-active',
  '--bg-surface',
  '--bg-surface-2',
  '--bg-hover',
  '--bg-active',
  '--bg-inset',
  /* 边框 */
  '--border',
  '--border-strong',
] as const;

export interface Hsl {
  /** 0~360 */
  h: number;
  /** 0~1 */
  s: number;
  /** 0~1 */
  l: number;
}

/** `#rrggbb` → HSL。非法输入返回 null（调用方据此放弃覆盖）。 */
export function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** HSL → `#rrggbb` */
export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let rgb: [number, number, number];
  if (hh < 60) rgb = [c, x, 0];
  else if (hh < 120) rgb = [x, c, 0];
  else if (hh < 180) rgb = [0, c, x];
  else if (hh < 240) rgb = [0, x, c];
  else if (hh < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (v: number) =>
    Math.round(clamp(v + m, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

/**
 * 从一个色值算出整套主题色变量。
 *
 * 返回的写法直接就是能塞进 style.setProperty 的 CSS 值（全部是 #rrggbb，
 * 不掺 alpha —— 带透明的底色会让「卡片叠在侧栏上」这类场景无法预测），
 * 唯一的例外是 accent-soft / accent-border 用了 rgba()：
 * 内置主题色的这两条也是半透明的淡底，保持一致。
 */
export function customAccentVars(hex: string, dark: boolean): Record<string, string> | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;

  const h = Math.round(hsl.h);
  /* 灰阶（用户挑了个正灰）没有色相可言，饱和度再怎么推也是灰，直接照原样用 */
  const srcS = hsl.s;

  /* ---- 主色：先钳明度，再保证最低饱和度，否则"挑了个很淡的色"按钮会看不见 ---- */
  const accentS = clamp(Math.max(srcS, 0.34), 0, 0.92);
  const accentL = dark ? clamp(hsl.l, 0.62, 0.78) : clamp(hsl.l, 0.34, 0.62);
  const accent = hslToHex(h, accentS, accentL);
  const accentHover = hslToHex(h, accentS, dark ? clamp(accentL + 0.09, 0, 0.9) : clamp(accentL - 0.09, 0.18, 1));

  /* ---- 底色的饱和度系数（两套，见文件头那张反推表） ---- */
  const sideS = dark ? clamp(srcS * 0.5, 0.03, 0.6) : clamp(srcS * 1.05, 0.03, 0.85);
  const appS = dark ? clamp(srcS * 0.48, 0.03, 0.55) : clamp(srcS * 0.9, 0.03, 0.9);
  const surfS = dark ? clamp(srcS * 0.37, 0.02, 0.45) : clamp(srcS * 0.75, 0.02, 0.85);
  const hoverS = dark ? clamp(srcS * 0.37, 0.02, 0.45) : clamp(srcS * 0.9, 0.02, 0.85);
  const brdS = dark ? clamp(srcS * 0.3, 0.02, 0.4) : clamp(srcS * 0.5, 0.02, 0.6);

  if (dark) {
    return {
      '--accent': accent,
      '--accent-hover': accentHover,
      '--accent-soft': `rgba(${rgbTriplet(accent)}, 0.22)`,
      '--accent-border': `rgba(${rgbTriplet(accent)}, 0.42)`,
      '--bg-app': hslToHex(h, appS, 0.12),
      '--bg-sidebar': hslToHex(h, sideS, 0.08),
      '--bg-sidebar-hover': hslToHex(h, sideS, 0.15),
      '--bg-sidebar-active': hslToHex(h, sideS, 0.19),
      '--bg-surface': hslToHex(h, surfS, 0.16),
      '--bg-surface-2': hslToHex(h, surfS, 0.19),
      '--bg-hover': hslToHex(h, hoverS, 0.22),
      '--bg-active': hslToHex(h, hoverS, 0.26),
      '--bg-inset': hslToHex(h, appS, 0.09),
      '--border': hslToHex(h, brdS, 0.2),
      '--border-strong': hslToHex(h, clamp(srcS * 0.33, 0.02, 0.45), 0.3),
    };
  }

  return {
    '--accent': accent,
    '--accent-hover': accentHover,
    '--accent-soft': `rgba(${rgbTriplet(accent)}, 0.12)`,
    '--accent-border': `rgba(${rgbTriplet(accent)}, 0.34)`,
    '--bg-app': hslToHex(h, appS, 0.975),
    '--bg-sidebar': hslToHex(h, sideS, 0.875),
    '--bg-sidebar-hover': hslToHex(h, sideS, 0.845),
    '--bg-sidebar-active': hslToHex(h, sideS, 0.81),
    '--bg-surface': '#ffffff',
    '--bg-surface-2': hslToHex(h, surfS, 0.99),
    '--bg-hover': hslToHex(h, hoverS, 0.945),
    '--bg-active': hslToHex(h, hoverS, 0.9),
    '--bg-inset': hslToHex(h, appS, 0.975),
    '--border': hslToHex(h, brdS, 0.94),
    '--border-strong': hslToHex(h, clamp(srcS * 0.6, 0.02, 0.7), 0.855),
  };
}

/** `#rrggbb` → `r, g, b`（拼 rgba() 用） */
function rgbTriplet(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return '0, 0, 0';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/**
 * 把自定义色写到 <html> 上（内联变量）。
 *
 * 传入非法色值时**只清不写** —— 宁可退回内置主题色，也不要留半套变量在上面
 * （那会得到「侧栏是新色、卡片还是旧色」这种半截界面）。
 */
export function applyCustomAccent(hex: string, dark: boolean): void {
  const vars = customAccentVars(hex, dark);
  if (!vars) {
    clearCustomAccent();
    return;
  }
  const el = document.documentElement;
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

/**
 * 清掉全部内联覆盖。
 *
 * 🔴 必须逐条 removeProperty，不能 `el.style.cssText = ''` ——
 *    cssText 会把 --glass-alpha / --glass-blur 那些**同时**写在 <html> 上的
 *    内联变量一起清掉，那样「从自定义色切回内置主题色」会顺手把玻璃的
 *    模糊程度重置掉。
 */
export function clearCustomAccent(): void {
  const el = document.documentElement;
  for (const k of CUSTOM_ACCENT_VARS) el.style.removeProperty(k);
}

/** 给界面用的「当前生效的是不是自定义色」判断（顺便挡住空值） */
export function isCustomAccent(accent: AccentId | string, hex: string): boolean {
  return accent === 'custom' && /^#[0-9a-fA-F]{6}$/.test((hex || '').trim());
}

/**
 * 当前主题是否**允许**自定义主题色生效。
 *
 * 🔴🔴 只有浅色 / 深色两档可以。原神与透明玻璃各自带**固定配色**
 *    （原神 = 米白纸 + 深靛蓝侧栏 + 淡金；玻璃 = 半透明白纱 + 壁纸），
 *    它们整套变量都写在 `:root[data-theme='…']` 上 —— 而自定义色是
 *    **内联在 <html> 上的变量，优先级永远更高**，只要还挂着，就会把这两套
 *    主题的 `--bg-sidebar / --bg-app / --bg-surface` 全数盖掉。
 *
 *    用户看到的症状（2026-10-22 反馈的截图）：选过自定义色之后切到「原神」，
 *    内容卡片已经是深靛蓝了，**左侧栏却还是自定义色那套淡色**——
 *    因为侧栏的 `background: var(--bg-sidebar)` 解析到的是内联值。
 *    玻璃主题同理（侧栏会从半透明变成一块实色板，壁纸穿透也没了）。
 *
 *    所以切到这两套主题时必须 **clearCustomAccent()**：色值本身留在 store 里，
 *    切回浅色 / 深色时原样恢复，用户的选择不会丢。
 */
export function customAccentApplies(theme: string): boolean {
  return theme === 'light' || theme === 'dark';
}
