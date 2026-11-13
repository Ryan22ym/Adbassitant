/**
 * 圆角现状探针（2026-10-13，小杨反馈「四周圆角切割不干净」）。
 *
 * 做的事：
 *   ① 从**已安装 asar** 起真实窗口（玻璃主题、真实代码路径）；
 *   ② 调 asar 里的 win-corners 设上圆角区域；
 *   ③ 把自己提到最前，用 desktopCapturer 抓**整屏**（能看到窗口剪影 vs 真桌面）；
 *   ④ 打印 region 信息（type / rgnBox / client / dpi）供判读。
 *
 * 产物：ui-shots/probe-corners-full.png（整屏）、ui-shots/_probe.log
 *
 * 用法：
 *   python scripts/run-electron.py scripts/probe-corners.cjs \
 *     --watch ui-shots/_probe.log --until "PROBE DONE" --timeout 120
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, desktopCapturer, screen } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(OUT, '_probe.log');
function log(s) { fs.appendFileSync(LOG, s + '\n'); console.log(s); }

const ASAR = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs', 'ADBAssistant', 'resources', 'app.asar',
);

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

function regionInfo(hwnd) {
  return ps(`
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
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RB { public int Left,Top,Right,Bottom; }
}
"@
$h=[IntPtr]::new([int64]${hwnd})
$r=[WA]::CreateRectRgn(0,0,1,1)
$t=[WA]::GetWindowRgn($h,$r)
$rb=New-Object WA+RB
[void][WA]::GetRgnBox($r,[ref]$rb)
$wr=New-Object WA+RB
[void][WA]::GetWindowRect($h,[ref]$wr)
$cr=New-Object WA+RB
[void][WA]::GetClientRect($h,[ref]$cr)
$dpi=[WA]::GetDpiForWindow($h)
Write-Output ('type={0} rgnBox={1}x{2} winRect={3}x{4} client={5}x{6} dpi={7}' -f $t,($rb.Right-$rb.Left),($rb.Bottom-$rb.Top),($wr.Right-$wr.Left),($wr.Bottom-$wr.Top),($cr.Right-$cr.Left),($cr.Bottom-$cr.Top),$dpi)
`);
}

function seedSettings() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try { if (fs.existsSync(file)) cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...cur, theme: 'glass', glassOpacity: 20, glassRoughness: 45 }, null, 2));
}

app.whenReady().then(async () => {
  if (!fs.existsSync(ASAR)) {
    log('PROBE FAIL 找不到 asar: ' + ASAR);
    log('PROBE DONE');
    app.exit(1);
    return;
  }
  seedSettings();

  const { registerIpc } = require(path.join(ASAR, 'dist-electron', 'electron', 'ipc.js'));
  registerIpc();

  const win = new BrowserWindow({
    /* 放在干净的壁纸区（避开顶部的浏览器窗口），保证四角外都是桌面 */
    width: 1000,
    height: 720,
    x: 700,
    y: 300,
    show: true,
    frame: false,
    backgroundColor: '#101319',
    webPreferences: {
      preload: path.join(ASAR, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(ASAR, 'dist', 'index.html'));
  await wait(4500);

  const hwndBuf = win.getNativeWindowHandle();
  const hwnd = hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0).toString() : String(hwndBuf.readUInt32LE(0));
  log('  hwnd=' + hwnd + ' bounds=' + JSON.stringify(win.getBounds()));

  const WC = require(path.join(ASAR, 'dist-electron', 'electron', 'services', 'win-corners.js'));
  WC.resetGlassCornerCache();
  WC.syncGlassCorners(win, true);
  await wait(3000);
  log('  region: ' + (await regionInfo(hwnd)));

  /* 提到最前再抓整屏（自己抓自己，能看到窗口剪影 vs 真桌面） */
  await ps(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$h=[IntPtr]::new([int64]${hwnd})
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
        const f = path.join(OUT, 'probe-corners-full.png');
        fs.writeFileSync(f, shot.toPNG());
        log('PROBE OK probe-corners-full.png bytes=' + fs.statSync(f).size);
        break;
      }
    } catch (e) { log('  shot retry ' + i + ' ' + e.message); }
    await wait(700);
  }
  log('PROBE DONE');
  app.exit(0);
});
