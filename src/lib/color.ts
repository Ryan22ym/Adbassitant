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
