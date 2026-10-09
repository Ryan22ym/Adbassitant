/**
 * 颜色工具。
 *
 * 存在的唯一理由：主进程的 setTitleBarOverlay 只认 `#rrggbb`
 * （校验见 electron/ipc.ts：/^#[0-9a-fA-F]{6}$/），而渲染层从
 * getComputedStyle 拿到的颜色未必是这种写法：
 *   - CSS 里用 color-mix() 算出来的背景，序列化成 `color(srgb 0.94 0.94 0.95)`，
 *     分量还是 0~1 的浮点；
 *   - 走 rgb()/rgba() 的则是 `rgb(240, 241, 244)`。
 * 直接把这些字符串回传会被主进程判为「无效的标题栏颜色」。
 *
 * ⚠️ 之所以要从元素上读 backgroundColor、而不是读 `--bg-titlebar` 变量：
 * 自定义属性拿到的是**没求值的** `color-mix(in srgb, #e6e8ec 45%, #f8f9fa)`，
 * 连解析都无从谈起。元素的计算样式才是浏览器算完的最终色。
 */
export function toHexColor(input: string): string {
  const s = (input || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s.slice(1).split('').map((c) => c + c).join('').toLowerCase();
  }

  // color(srgb r g b) —— color-mix() 的计算值长这样，分量是 0~1 浮点
  const cm = s.match(/^color\(\s*srgb\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)/i);
  if (cm) {
    const to2 = (v: string) => {
      const n = Math.round(Math.min(1, Math.max(0, parseFloat(v))) * 255);
      return n.toString(16).padStart(2, '0');
    };
    return '#' + to2(cm[1]) + to2(cm[2]) + to2(cm[3]);
  }

  // rgb(r, g, b) / rgba(r, g, b, a)
  const rm = s.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i);
  if (rm) {
    return (
      '#' +
      [rm[1], rm[2], rm[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('')
    );
  }

  // 认不出来就原样交回去，由主进程的校验去报错（别在这里静默给个错色）
  return s;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 按「盖上一层半透明色」的效果算出叠加后的颜色，返回 `#rrggbb`。
 *
 * 用在标题栏右上角的系统按钮区：那块是 titleBarOverlay 由主进程画的，
 * **在渲染内容之外**，页面上的遮罩（.install-mask 等）盖不到它 ——
 * 弹窗变暗时它会保持原色，看着像贴了块高亮补丁。
 * 既然盖不住，就反过来自己算出「被盖住之后应该是什么色」再回传，
 * 让它看起来和周围是一起变暗的。
 *
 * 参数 `over` / `alpha` 从遮罩元素的实际计算样式里读（见 App.tsx），
 * 不在这里写死一份 —— 免得改了 CSS 的遮罩色两边不同步。
 */
export function dimOver(base: string, over: string, alpha: number): string {
  const b = hexToRgb(base);
  const o = hexToRgb(over);
  if (!b || !o) return base;
  const a = Math.min(1, Math.max(0, alpha));
  const mix = (x: number, y: number) => Math.round(x * (1 - a) + y * a);
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(mix(b[0], o[0]))}${h(mix(b[1], o[1]))}${h(mix(b[2], o[2]))}`;
}
