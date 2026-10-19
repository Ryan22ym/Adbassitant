/**
 * 原子流程：找 ADB 窗口 → 读矩形/region → 提前台 → 抓整屏 → 存图。
 * 全部在同一 Electron 进程内完成，避免「截图和读矩形之间窗口又动了」的竞态。
 *
 * 用法: python scripts/run-electron.py scripts/probe-shot.cjs \
 *   --watch ui-shots/_psh.log --until "PSH DONE" --timeout 90
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, desktopCapturer, screen } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_psh.log');
function log(s) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

app.whenReady().then(async () => {
  /* 1. 找窗口（Get-Process 的 MainWindowHandle 是实时查询，不用枚举） */
  const found = await ps(`
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*ADB*' -and $_.MainWindowHandle -ne 0 } |
  Sort-Object -Property StartTime -Descending | Select-Object -First 1
if ($p) { Write-Output "$($p.Id) $($p.MainWindowHandle)" } else { Write-Output 'NONE' }
`);
  log('PSH found: ' + found);
  const parts = found.split(/\s+/);
  if (parts.length < 2 || parts[0] === 'NONE') { log('PSH DONE'); app.exit(1); return; }
  const hwnd = parts[1];

  /* 2. 读矩形 + region + dpi（与抓屏同一进程、同一时刻附近） */
  const info = await ps(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WA {
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RB b);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RB b);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RB { public int Left,Top,Right,Bottom; }
}
"@
$h=[IntPtr]::new([int64]${hwnd})
$r=[WA]::CreateRectRgn(0,0,1,1)
$t=[WA]::GetWindowRgn($h,$r)
$rb=New-Object WA+RB; [void][WA]::GetRgnBox($r,[ref]$rb)
$wr=New-Object WA+RB; [void][WA]::GetWindowRect($h,[ref]$wr)
$dpi=[WA]::GetDpiForWindow($h)
Write-Output ('rgnType={0} rgn={1},{2}-{3},{4} winRect={5},{6}-{7},{8} dpi={9}' -f $t,$rb.Left,$rb.Top,$rb.Right,$rb.Bottom,$wr.Left,$wr.Top,$wr.Right,$wr.Bottom,$dpi)
`);
  log('PSH ' + info);

  /* 3. 提前台 */
  await ps(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FG2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$h=[IntPtr]::new([int64]${hwnd})
[void][FG2]::ShowWindow($h, 9)
[void][FG2]::SetForegroundWindow($h)
`);
  await wait(1200);

  /* 4. 抓整屏 */
  const d = screen.getPrimaryDisplay();
  const w = Math.round(d.size.width * d.scaleFactor);
  const h = Math.round(d.size.height * d.scaleFactor);
  for (let i = 0; i < 5; i++) {
    try {
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      const shot = srcs[0] && srcs[0].thumbnail;
      if (shot && !shot.isEmpty()) {
        const f = path.join(OUT, 'probe-shot.png');
        fs.writeFileSync(f, shot.toPNG());
        log('PSH OK probe-shot.png bytes=' + fs.statSync(f).size);
        break;
      }
    } catch (e) { log('  shot retry ' + i + ' ' + e.message); }
    await wait(700);
  }
  log('PSH DONE');
  app.exit(0);
});
