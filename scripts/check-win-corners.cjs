/**
 * 验证 win-corners 在**方角模式**（2026-10-14 起，小杨决定不要圆角）下的行为：
 * 玻璃主题同步后窗口**不得**带有任何 region。
 *
 * 为什么还留着这个脚本：
 *   ① 它是「PS 内联 C# 调 user32」这条链路的探针（Add-Type / execFile 异步），
 *      恢复圆角时这条链路必须仍然是通的；
 *   ② 方角模式下它守着一条不变量：**任何同步调用都不该把窗口裁缺一块**。
 *
 * 🔴 本脚本内一律用 **execFile 异步**，不用 execFileSync/spawnSync：
 *    后者在 Electron 主进程里偶发 `spawnSync powershell.exe EBUSY`，
 *    会让「验证脚本自身」失败，从而把结论带偏。
 *
 * 判定方式：GetWindowRgn 拿回区域类型 ——
 *   0=ERROR（**窗口没有区域时也回 0**，这是 Win32 的语义，别当成失败）
 *   1=NULLREGION / 2=SIMPLEREGION / 3=COMPLEXREGION。
 *   方角模式判据：glass=true 同步后 == 0，glass=false 同步后 == 0。
 *   （历史：2026-10-13 圆角模式时判据是 after ∈ {2,3}。）
 *
 * 用法：
 *   python scripts/run-electron.py scripts/check-win-corners.cjs \
 *     --watch ui-shots/_cwc.log --until "CWC DONE" --timeout 160
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, screen } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(OUT, '_cwc.log');
function log(s) {
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

/** 跑一段 PowerShell，回传 stdout（promise） */
function ps(code) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', code],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) resolve('ERR:' + err.message + ' | ' + String(stderr).slice(0, 200));
        else resolve(String(stdout).trim());
      },
    );
  });
}

/** 读窗口区域类型 */
function regionType(hwnd) {
  return ps(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class W2 {
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
}
"@
$h=[IntPtr]::new([int64]${hwnd})
$r=[W2]::CreateRectRgn(0,0,1,1)
[W2]::GetWindowRgn($h,$r)
`);
}

app.whenReady().then(async () => {
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();
  const WC = require('../dist-electron/electron/services/win-corners.js');

  const win = new BrowserWindow({
    width: 900,
    height: 620,
    show: true,
    frame: false,
    backgroundColor: '#101319',
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await wait(3500);

  const buf = win.getNativeWindowHandle();
  const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
  log('  hwnd=' + hwnd + ' scale=' + screen.getPrimaryDisplay().scaleFactor);

  const before = await regionType(hwnd);
  log('  REGION before = ' + before + '   (0 = 没有区域，方角模式这就是目标)');

  WC.resetGlassCornerCache();
  WC.syncGlassCorners(win, true);
  await wait(3000);
  const after = await regionType(hwnd);
  log('  REGION after  = ' + after + '   (方角模式: 0 = 没设区域，OK；2/3 = 被裁了，NO)');

  WC.resetGlassCornerCache();
  WC.syncGlassCorners(win, false);
  await wait(3000);
  const cleared = await regionType(hwnd);
  log('  REGION cancel = ' + cleared + '   (0 = 同样没有区域)');

  /*
   * ⚠️ PowerShell 的 stdout 一律是**字符串**，必须显式转数字再比 ——
   *    `'0' === 0` 恒为 false，会让「数据全对」的场景误判成 FAIL。
   */
  const nAfter = Number(after);
  const nCleared = Number(cleared);
  const ok = nAfter === 0 && nCleared === 0;
  log(ok ? 'CWC PASS 方角模式：窗口未设任何区域' : 'CWC FAIL 方角模式下窗口被设置了区域');
  log('CWC DONE');
  app.exit(0);
});
