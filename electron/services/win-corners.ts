/*
 * 无边框窗口的「真圆角」（Windows）。
 *
 * 🔴 为什么需要它（2026-10-13，小杨反馈「四周圆角没处理干净」）：
 *    Electron 的 `roundedCorners: true` **只在 macOS 生效**（官方文档标注
 *    macOS only），Windows 上无边框窗口（frame:false）就是**方角**。
 *    Win11 有 DWM 圆角（DWMWA_WINDOW_CORNER_PREFERENCE），但本机是 Win10，
 *    那条路走不通。
 *
 *    于是「透明玻璃」主题下会发生这样的事：
 *      · 页面里 .app-shell 有 border-radius:12px，圆角**外**那 12px 露出的是
 *        .glass-backdrop（铺满视口的桌面截图）；
 *      · 而截图是按物理分辨率抓的、用 cover 铺的，**不会与真实桌面严丝合缝**；
 *      · ⇒ 四个角上各自露出一小块「桌面截图的边缘」，和周围的真桌面不连续，
 *        看起来就是「圆角没处理干净」（一条不吻合的色边）。
 *
 *    ⇒ 唯一正确的做法：**把窗口本身裁成圆角**（Win32 SetWindowRgn +
 *      CreateRoundRectRgn）。裁掉之后圆角外是真的桌面窗口区域之外，
 *      不再有任何「截图边缘」露出来。
 *
 * ⚠️ 实现方式：PowerShell 内联 C# 调 user32.dll。
 *    不引入 koffi / ffi-napi 这类原生依赖（要编译、要跟随 Electron ABI，
 *    而且会把安装包撑大）—— 本项目只需要「设一次区域」这一个动作。
 *
 * 🔴 三个必须处理的边界（否则圆角会变成 bug）：
 *    ① **最大化时必须清掉 region**：否则最大化后四个角仍被裁成圆的，
 *       会露出桌面，看起来像窗口「缺了四个角」。
 *    ② **还原/退出最大化后要重设**：与 ① 成对。
 *    ③ **非玻璃主题不设**：普通主题是 titleBarStyle:'hidden' 的有边框窗口，
 *       Windows 自己会画圆角（Win11）/方角（Win10），我们不该插手。
 */

import { execFile } from 'child_process';
import { screen } from 'electron';
import type { BrowserWindow } from 'electron';

/**
 * 目标圆角半径（CSS px）。
 *
 * 🔴 2026-10-14 小杨决定：**玻璃主题不用圆角，保持方角**。
 *    此前四轮修复（客户区基准 / ×scaleFactor / key 带尺寸 / 串行队列 /
 *    CreatePolygonRgn 真圆采样）已把圆角做到像素级干净，但实际观感
 *    仍不被接受 → 半径置 0，本模块退化为「确保没有 region」。
 *    想恢复圆角：把这个值改回 12 即可，其余机器（事件接线、队列、
 *    key 去重、PS 脚本）全部原样可用。
 */
export const GLASS_CORNER_RADIUS = 0;

/**
 * 上次设置过的「半径 + 是否最大化」，用来跳过无意义的重复调用
 * （PowerShell 进程启动约 100ms，窗口 resize 时不能每次都起一个）。
 */
let lastKey = '';

/**
 * 🔴🔴 region 设置的**串行队列**状态（2026-10-13 第三次反馈「边界一直卡在这里」的根因）。
 *
 *   现象：窗口拉宽后，玻璃区域的右边界**死死停在旧宽度**，窗口右侧一条被裁掉、
 *         露出后面的桌面，看着就是「边界卡住不动」。
 *
 *   根因：`applyRegion` 用 `execFile` **异步**起 PowerShell（冷启动 100~300ms），
 *         而拖边框时 `resize` 每秒能触发几十次 —— 于是同时有几十个 powershell.exe
 *         在跑，**完成顺序是乱的**。最后一个真正调用 `SetWindowRgn` 的
 *         很可能是一个**中间尺寸**。
 *         更糟的是每次调用都把 `lastKey` 更新成了**最新**尺寸，
 *         于是「尺寸没变」的去重逻辑认为已经设过了 ⇒ **永远不会再补设一次**
 *         ⇒ region 就永久停在那个错误的中间尺寸上。
 *
 *   修法：严格串行 + 只保留最新一次请求。
 *     · `running` 为真时不立即起进程，把参数**覆盖式**存进 `queued`；
 *     · 当前这次跑完后，若 `queued` 非空，用**最新**参数再跑一次；
 *     · 这样无论 resize 触发多少次，最终落地的永远是**最后那个尺寸**。
 */
let running = false;
let queued: { win: BrowserWindow; radiusPx: number; scale: number } | null = null;

/**
 * 生成一段 PowerShell：把 HWND 对应的窗口区域设成圆角矩形（或清空）。
 *
 * @param hwnd   窗口句柄（十进制字符串）
 * @param radius **物理像素**半径（已乘缩放比）；<=0 表示清除区域。
 * @param scale  显示器缩放比（如 1.25）。**必须传** —— 见下面 🔴🔴 的说明。
 *
 * 🔴🔴 为什么用 `CreatePolygonRgn` 而不是 `CreateRoundRectRgn`
 *      （2026-10-13 第四次反馈「四周圆角切割不干净」的根因）：
 *
 *   实测逐像素遮罩对比（本机 dpi=120，半径 15 物理 px）：
 *     · `CreateRoundRectRgn` 的 GDI 光栅化是**有缺陷**的：
 *       角的右侧边比理想圆**多切掉最多 5px**（一个明显的凹口），
 *       且左右/上下**不对称**（下边贴合圆、右边过切）。
 *       在锐利壁纸前，这个凹口 + 1-bit 阶梯 = 肉眼可见的「没切干净」。
 *       两个不同窗口打出来的遮罩逐像素一致 ⇒ 是 GDI 的确定性行为，不是时序问题。
 *     · `CreatePolygonRgn(..., WINDING)` 是**扫描线填充**：每一行按多边形
 *       边界的精确交点决定覆盖，天然上下/左右对称、贴合真圆到亚像素。
 *       实测：弧上每行相对「像素中心理想圆」偏差 ≤0.5px，凹口消失。
 *       剩下的 1px 阶梯是 1-bit region 的固有限制（Win10 没有 DWM 圆角，
 *       无法抗锯齿），但规则、对称的阶梯在 100% 观看距离下已经看不出毛糙。
 *
 *   做法：按真圆方程采样四段四分之一圆弧（每象限 n = max(12, r + r/2) 个点，
 *   半径 15 → 24 点/象限），连成完整圆角矩形轮廓，一次 CreatePolygonRgn。
 *   所有数学都在 C# 里完成，PS 只传 hwnd/半径/缩放比三个数。
 *
 * 🔴🔴 region 必须画在**客户区**（= 页面渲染区 = `.app-shell`）的角上，
 *      不能画在**整个窗口**的角上。两个坑叠在一起，2026-10-13 各踩过一次：
 *
 *   坑①（单位）：`SetWindowRgn` 只认**物理像素**，而 PowerShell（非 DPI-aware）
 *      里 `GetWindowRect` 返回的是**逻辑像素**。实测本机 dpi=120（×1.25）：
 *        · PowerShell 非 DPI-aware 的 GetWindowRect  = 960x640（逻辑）
 *        · Python 设 per-monitor aware 后             = 1200x800（物理）
 *      直接拿 960 去设 ⇒ 只在 960 物理内可见 ⇒ 右下各缺一大块 ⇒ 下边两角是直角。
 *      ⇒ 宽高、半径都要乘 scale。
 *
 *   坑②（基准）：`GetWindowRect` 含**不可见的调整边框**（Win10 无边框窗口仍有
 *      `SM_CXSIZEFRAME + SM_CXPADDEDBORDER`，本机每边 8 逻辑）。
 *      页面（`.app-shell`）只铺满**客户区**，比窗口矩形小一圈。
 *      若 region 按整窗矩形画圆角，圆弧会比 CSS 圆角**向外偏 8 逻辑**，
 *      圆弧外侧就露出一条 `.glass-backdrop`（观感 = 圆角"没处理干净"）。
 *      ⇒ 改用 `GetClientRect` 拿客户区尺寸，用 `ClientToScreen` 把它换算到
 *        窗口坐标，region 就**精确落在客户区上**，与 CSS 的 border-radius 重合。
 *
 *   ⚠️ 不要试图在 PS 里调 SetProcessDpiAwareness 来省掉乘法：坐标系语义会
 *      跟着变，反而更难推理；显式乘一个已知的 scale 最直观。
 */
function psScript(hwnd: string, radius: number, scale: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
  [DllImport("gdi32.dll")]
  public static extern IntPtr CreatePolygonRgn(POINT[] pts, int count, int fillMode);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }

  public static int Apply(IntPtr h, int radiusDevice, double scale) {
    if (radiusDevice <= 0) { return SetWindowRgn(h, IntPtr.Zero, true); }
    RECT wr; GetWindowRect(h, out wr);
    RECT cr; GetClientRect(h, out cr);
    // 客户区左上角在屏幕上的位置（客户区坐标原点恒为 0,0）
    POINT pt = new POINT(0, 0); ClientToScreen(h, ref pt);
    // 客户区左上角相对窗口左上角的偏移（物理像素）
    int ox = (int)Math.Round((pt.X - wr.Left) * scale);
    int oy = (int)Math.Round((pt.Y - wr.Top) * scale);
    int cw = (int)Math.Round((cr.Right - cr.Left) * scale);
    int ch = (int)Math.Round((cr.Bottom - cr.Top) * scale);
    if (cw <= 0 || ch <= 0) return 0;
    int r = Math.Min(radiusDevice, Math.Min(cw, ch) / 2);
    // 每象限采样点数：半径 15 -> 24 点，贴合真圆到亚像素
    int n = Math.Max(12, r + r / 2);
    var pts = new List<POINT>();
    // 四个圆心（真圆，半径 r），顺时针：TR -> BR -> BL -> TL
    int[,] c = {
      { ox + cw - r, oy + r }, { ox + cw - r, oy + ch - r },
      { ox + r, oy + ch - r }, { ox + r, oy + r },
    };
    for (int q = 0; q < 4; q++) {
      double a0 = -Math.PI / 2 + q * Math.PI / 2; // 从正上方开始，每象限 90 度
      for (int i = 0; i <= n; i++) {
        double a = a0 + (Math.PI / 2) * i / n;
        int x = (int)Math.Round(c[q, 0] + r * Math.Cos(a));
        int y = (int)Math.Round(c[q, 1] + r * Math.Sin(a));
        if (pts.Count == 0 || pts[pts.Count - 1].X != x || pts[pts.Count - 1].Y != y)
          pts.Add(new POINT(x, y));
      }
    }
    IntPtr rgn = CreatePolygonRgn(pts.ToArray(), pts.Count, 2 /* WINDING */);
    return SetWindowRgn(h, rgn, true);
  }
}
"@
$h = [IntPtr]::new([int64]${hwnd})
[void][W]::Apply($h, ${radius}, ${scale})
`;
}

/**
 * 队列里还压着请求 → 用**最新**参数接着跑一次。
 */
function flushQueue(): void {
  if (!queued) return;
  const q = queued;
  queued = null;
  runRegion(q.win, q.radiusPx, q.scale);
}

/**
 * 真正起 PowerShell 的那一步（只管发出去，串行推进由 flushQueue 负责）。
 *
 * 🔴 用 `execFile` 而不是 shell：参数里不能有引号转义问题，
 *    cwd 用系统临时目录，避免用户目录下的 PS 配置影响执行。
 */
function runRegion(win: BrowserWindow, radiusPx: number, scale: number): void {
  running = true;

  let hwnd: string;
  try {
    // getNativeWindowHandle 返回的是打包好的 HWND buffer；
    // 64 位下是 8 字节小端，32 位下 4 字节。
    const buf = win.getNativeWindowHandle();
    hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
  } catch {
    running = false;
    flushQueue();
    return; // 拿不到句柄就静默放弃（最多是四角方一点，不该影响功能）
  }

  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      psScript(hwnd, radiusPx, scale),
    ],
    { windowsHide: true, timeout: 4000 },
    (err) => {
      /*
       * 🔴 失败必须把 `lastKey` 清掉，否则「尺寸没变就跳过」的去重逻辑
       *    会认为已经设过了 —— 而实际上一轮根本没生效，且之后不会再有
       *    同 key 的事件来触发 ⇒ 圆角/裁剪永久停在错误状态（用户看到「边界卡住」）。
       */
      if (err) lastKey = '';
      running = false;
      flushQueue();
    },
  );
}

/**
 * 给窗口套上（或清除）圆角区域 —— 入口：负责去重 + 入队。
 *
 * 🔴🔴 这里**必须串行**。曾经并发起几十个 powershell.exe，乱序完成导致
 *    最后落地的是一个中间尺寸的 region，而 `lastKey` 已是最新尺寸
 *    ⇒ 永不重设 ⇒「边界一直卡在这里」（详见 `running` / `queued` 的注释）。
 */
function applyRegion(win: BrowserWindow, radiusPx: number, scale: number, key: string): void {
  if (key === lastKey) return;
  lastKey = key;

  if (running) {
    // 🔴 覆盖式写入：只保留**最新**尺寸，中间请求直接丢弃
    queued = { win, radiusPx, scale };
    return;
  }
  runRegion(win, radiusPx, scale);
}

/**
 * 按当前窗口状态同步「圆角区域」：**方角模式（默认）下只做一件事 —— 确保没有 region**。
 *
 * 🔴 2026-10-14 起玻璃主题保持方角（小杨决定）：`GLASS_CORNER_RADIUS = 0`，
 *    任何调用最终都落到「清除区域」。想恢复圆角只需把该常量改回 12，
 *    本函数会重新走「设区域 + 跟随 resize/maximize」的完整逻辑。
 *
 * 调用点：建窗后、主题切换时、最大化/还原/退出全屏时、resize 结束时。
 */
export function syncGlassCorners(win: BrowserWindow | null, glass: boolean): void {
  if (!win || win.isDestroyed()) return;
  const maxed = win.isMaximized() || win.isFullScreen();

  /*
   * scale 只在**圆角模式**下有用（半径与窗口尺寸都要乘它换成物理像素，
   * 见 psScript() 里的坑①）。方角模式下用不到，但留着无害 —— 恢复圆角
   * 只改 GLASS_CORNER_RADIUS 一个常量，不用回来补这段。
   */
  let scale = 1;
  try {
    scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  } catch {
    scale = 1;
  }

  if (!glass || maxed) {
    applyRegion(win, 0, scale, `none/${win.id}/${maxed}`);
    return;
  }

  /*
   * 半径 0 = 方角（2026-10-14 小杨决定，见 GLASS_CORNER_RADIUS 注释）。
   * 此时统一走「清除区域」分支：窗口保持完整矩形，圆角由 CSS 那边
   * 同样置 0 兜底（.app-shell 的 border-radius 也一起去掉，
   * 否则方窗口里圆内容会在角上露出 .glass-backdrop 的截图边缘）。
   */
  const radiusPx =
    GLASS_CORNER_RADIUS > 0 ? Math.max(1, Math.round(GLASS_CORNER_RADIUS * scale)) : 0;

  if (radiusPx <= 0) {
    applyRegion(win, 0, scale, `square/${win.id}/${maxed}`);
    return;
  }

  /*
   * 🔴🔴 key 必须带「窗口尺寸」—— 这是 2026-10-13 小杨第二次反馈
   *    「下边两个角还是没处理」的**真正根因**：
   *
   *      原实现 key = `r15/${id}`，只按「半径 + 窗口 id」去重。
   *      用户把窗口**拉大**后：
   *        resize 事件触发 → syncGlassCorners() → applyRegion(..., 'r15/1')
   *        → lastKey === 'r15/1' 命中 ⇒ **直接 return，什么都没做**！
   *      于是 region 还是**拉大之前那个小尺寸**，窗口新长出来的右/下部分
   *      完全没被裁 ⇒ 上边两角是圆的、**下边两角是直角**。
   *
   *      把尺寸写进 key，尺寸一变就一定重设；尺寸没变才跳过
   *      （省掉一次 ~100ms 的 PowerShell 启动）。
   */
  let sizeKey = '';
  try {
    const b = win.getBounds();
    sizeKey = `${b.width}x${b.height}`;
  } catch {
    sizeKey = '?';
  }
  applyRegion(win, radiusPx, scale, `r${radiusPx}/${win.id}/${sizeKey}`);
}

/** 主题切换 / 重建窗口时重置缓存（避免沿用上一个窗口的 key 而跳过设置） */
export function resetGlassCornerCache(): void {
  lastKey = '';
  // 🔴 旧窗口可能还有一轮 region 在飞；重建后它回来会把新窗口的 key 污染掉。
  //    丢弃排队项即可（正在跑的那次跑完自然 flushQueue 时发现队列空就结束）。
  queued = null;
}
