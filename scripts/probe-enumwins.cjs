/**
 * 枚举屏幕上所有可见窗口（pid/标题/类名/矩形）。
 * 用法: python scripts/run-electron.py scripts/probe-enumwins.cjs \
 *   --watch ui-shots/_pw.log --until "PW DONE" --timeout 60
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_pw.log');
function log(s) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }

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
  const out = await ps(`
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public delegate bool EnumProc(IntPtr h, IntPtr p);
public static class WE {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RECT b);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Hits = new List<string>();
  public static bool Cb(IntPtr h, IntPtr p) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (IsWindowVisible(h)) {
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(512); GetClassName(h, c, 512);
      RECT r; GetWindowRect(h, out r);
      var rgn = CreateRectRgn(0,0,1,1);
      int rt = GetWindowRgn(h, rgn);
      RECT rb; GetRgnBox(rgn, out rb);
      Hits.Add(string.Format("pid={0} hwnd={1} cls=[{2}] title=[{3}] rect={4},{5}-{6},{7} rgnType={8} rgn={9},{10}-{11},{12}", pid, h.ToInt64(), c, t, r.Left, r.Top, r.Right, r.Bottom, rt, rb.Left, rb.Top, rb.Right, rb.Bottom));
    }
    return true;
  }
}
"@
$cb = [EnumProc]::new([WE], 'Cb')
[void][WE]::EnumWindows($cb, [IntPtr]::Zero)
([WE]::Hits | Where-Object { $_.Contains('ADB') -or $_.Contains('adb') }) -join "\`n"
`);
  log('PW ' + (out || '(无匹配窗口)'));
  log('PW DONE');
  app.exit(0);
});
