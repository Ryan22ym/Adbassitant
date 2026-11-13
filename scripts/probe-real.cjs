/**
 * 读真实运行中安装版的窗口矩形 + region 状态（不建窗、不改任何东西）。
 * 用法: python scripts/run-electron.py scripts/probe-real.cjs --hwnd <十进制句柄> \
 *   --watch ui-shots/_pr.log --until "PR DONE" --timeout 60
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_pr.log');
function log(s) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }

const hwndArg = process.argv.find((a) => /^\d{4,}$/.test(a)) || process.argv
  .map((a) => a.match(/^--hwnd[=\s]?(\d+)$/))
  .find(Boolean);
const HWND = String(hwndArg || '').replace(/\D/g, '');

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
  if (!HWND) {
    log('PR FAIL 没拿到 hwnd');
    log('PR DONE');
    app.exit(1);
    return;
  }
  const out = await ps(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WA {
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RB b);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RB b);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RB b);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RB { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
}
"@
$h=[IntPtr]::new([int64]${HWND})
$r=[WA]::CreateRectRgn(0,0,1,1)
$t=[WA]::GetWindowRgn($h,$r)
$rb=New-Object WA+RB; [void][WA]::GetRgnBox($r,[ref]$rb)
$wr=New-Object WA+RB; [void][WA]::GetWindowRect($h,[ref]$wr)
$cr=New-Object WA+RB; [void][WA]::GetClientRect($h,[ref]$cr)
$pt=New-Object WA+PT; $pt.X=0; $pt.Y=0; [void][WA]::ClientToScreen($h,[ref]$pt)
$dpi=[WA]::GetDpiForWindow($h)
Write-Output ('type={0} rgnBox={1},{2}-{3},{4} winRect={5},{6}-{7},{8} client={9}x{10} clientOrigin={11},{12} dpi={13}' -f $t,$rb.Left,$rb.Top,$rb.Right,$rb.Bottom,$wr.Left,$wr.Top,$wr.Right,$wr.Bottom,($cr.Right-$cr.Left),($cr.Bottom-$cr.Top),$pt.X,$pt.Y,$dpi)
`);
  log('PR ' + out);
  log('PR DONE');
  app.exit(0);
});
