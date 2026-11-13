/**
 * 在**正在运行的真实窗口**上试验「多边形圆角区域」新算法（不落盘、不改应用）。
 *
 * 背景：CreateRoundRectRgn 的 GDI 光栅化有缺陷 —— BR 角右侧比理想圆多切
 * 最多 5px（凹口）、左右不对称。改为 CreatePolygonRgn(WINDING) 按真圆
 * 方程采样圆弧，扫描线填充对称且亚像素精确。
 *
 * 步骤：对指定 hwnd 设新 region → 提前台 → 抓整屏 → probe-poly-full.png
 *
 * 用法: python scripts/run-electron.py scripts/probe-poly.cjs <hwnd> [radius] \
 *   --watch ui-shots/_pp.log --until "PP DONE" --timeout 90
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, desktopCapturer, screen } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_pp.log');
function log(s) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const numArgs = process.argv.filter((a) => /^\d+$/.test(a));
const HWND = numArgs[0] || '';
const RADIUS = numArgs[1] || '15';

function ps(code) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', code],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? 'ERR:' + err.message : String(stdout).trim()),
    );
  });
}

/** 新算法：真圆采样的多边形圆角区域（全部数学在 C# 里，PS 只传参） */
const POLY_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WR {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
  [DllImport("gdi32.dll")]
  public static extern IntPtr CreatePolygonRgn(POINT[] pts, int count, int fillMode);
  [DllImport("gdi32.dll")]
  public static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y){X=x;Y=y;} }

  public static string Apply(IntPtr h, int radiusDevice, double scale) {
    if (radiusDevice <= 0) { SetWindowRgn(h, IntPtr.Zero, true); return "cleared"; }
    RECT wr; GetWindowRect(h, out wr);
    RECT cr; GetClientRect(h, out cr);
    POINT pt = new POINT(0, 0); ClientToScreen(h, ref pt);
    int ox = (int)Math.Round((pt.X - wr.Left) * scale);
    int oy = (int)Math.Round((pt.Y - wr.Top) * scale);
    int cw = (int)Math.Round((cr.Right - cr.Left) * scale);
    int ch = (int)Math.Round((cr.Bottom - cr.Top) * scale);
    if (cw <= 0 || ch <= 0) return "empty-client";
    int r = Math.Min(radiusDevice, Math.Min(cw, ch) / 2);
    // 每象限采样点数：半径 15 -> 24 点，足够亚像素精确
    int n = Math.Max(12, r + r / 2);
    var pts = new List<POINT>();
    // 四个圆心（真圆，半径 r），顺时针：TR -> BR -> BL -> TL
    int[,] c = { { ox + cw - r, oy + r }, { ox + cw - r, oy + ch - r }, { ox + r, oy + ch - r }, { ox + r, oy + r } };
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
    int ok = SetWindowRgn(h, rgn, true);
    return string.Format("applied pts={0} r={1} box={2}x{3}+{4}+{5} set={6}", pts.Count, r, cw, ch, ox, oy, ok);
  }
}
"@
$h = [IntPtr]::new([int64]__HWND__)
[WR]::Apply($h, __RAD__, __SCALE__)
`;

app.whenReady().then(async () => {
  if (!HWND) { log('PP FAIL 缺 hwnd'); log('PP DONE'); app.exit(1); return; }

  /* scale 从窗口 DPI 推（120 -> 1.25）；真实窗口是 DPI-aware 的 Electron 主窗 */
  const dpiOut = await ps(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WD { [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h); }
"@
[WD]::GetDpiForWindow([IntPtr]::new([int64]${HWND}))
`);
  const dpi = parseInt(dpiOut, 10) || 96;
  const scale = dpi / 96;
  log('  dpi=' + dpi + ' scale=' + scale);

  const code = POLY_PS.replace('__HWND__', HWND).replace('__RAD__', RADIUS).replace('__SCALE__', String(scale));
  log('  apply -> ' + (await ps(code)));
  await wait(800);

  /* 提前台 */
  await ps(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$h=[IntPtr]::new([int64]${HWND})
[void][FG]::ShowWindow($h, 9)
[void][FG]::SetForegroundWindow($h)
Write-Output 'FRONT OK'
`).then((r) => log('  ' + r));
  await wait(1000);

  const d = screen.getPrimaryDisplay();
  const w = Math.round(d.size.width * d.scaleFactor);
  const h = Math.round(d.size.height * d.scaleFactor);
  for (let i = 0; i < 5; i++) {
    try {
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      const shot = srcs[0] && srcs[0].thumbnail;
      if (shot && !shot.isEmpty()) {
        const f = path.join(OUT, 'probe-poly-full.png');
        fs.writeFileSync(f, shot.toPNG());
        log('PP OK probe-poly-full.png bytes=' + fs.statSync(f).size);
        break;
      }
    } catch (e) { log('  shot retry ' + i + ' ' + e.message); }
    await wait(700);
  }
  log('PP DONE');
  app.exit(0);
});
