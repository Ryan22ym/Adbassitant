/**
 * 抓一张主屏截图，用来肉眼验收「真实安装版 + 真实桌面」下的玻璃观感
 * （2026-10-13，三项修复的最终验收）。
 *
 * 为什么用 desktopCapturer 抓**整屏**而不是 capturePage：
 *   只有整屏截图才能同时看到「窗口」和「窗口外的真实桌面」——
 *   圆角是否真的裁掉、窗口外是不是真桌面，只有这条路能验。
 *
 * ⚠️ 本机 desktopCapturer 偶发
 *    `DxgiDuplicatorController failed to capture desktop`（返回空帧），
 *    所以下面重试 5 次。
 *
 * 用法：
 *   python scripts/run-electron.py scripts/shot-screen.cjs \
 *     --watch ui-shots/_ss.log --until "SS DONE" --timeout 150
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, desktopCapturer, screen } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_ss.log');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function log(s) {
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const NAME = arg('out', 'screen.png');
/** `--front=1` 先把标题含 ADB 的窗口提到最前（否则应用可能被浏览器盖住，截图就是空的） */
const FRONT = arg('front', '1') === '1';

/**
 * 把「ADB 桌面助手」主窗口提到最前。
 *
 * 🔴 为什么必须：应用是被 launch-installed.cjs 以 detached 方式拉起的，
 *    不会自动获得前台。实测：不提前的话整屏截图里只有浏览器，看不到玻璃窗口。
 * ⚠️ 这里用 execFile 调 PowerShell（Add-Type 在 Electron 子进程里可用；
 *    在那之外的沙箱里会被安全策略拦掉）。
 */
function bringFront() {
  return new Promise((resolve) => {
    const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x,int y,int cx,int cy,uint f);
}
"@
$p = Get-Process | Where-Object {
  ($_.MainWindowTitle -like '*ADB*') -or
  ($_.MainWindowHandle -ne 0 -and $_.Path -like '*ADBAssistant*')
} | Sort-Object -Property MainWindowHandle -Descending | Select-Object -First 1
if ($p) {
  $h = $p.MainWindowHandle
  [void][FG]::ShowWindow($h, 9)
  [void][FG]::SetWindowPos($h, [IntPtr]::new(-1), 0,0,0,0, 0x0040)
  [void][FG]::SetForegroundWindow($h)
  Write-Output "BROUGHT $($p.Id)"
} else {
  Write-Output "NOTFOUND"
}
`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 12000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? 'ERR:' + err.message : String(stdout).trim()),
    );
  });
}

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const w = Math.round(d.size.width * d.scaleFactor);
  const h = Math.round(d.size.height * d.scaleFactor);

  if (FRONT) {
    log('  front -> ' + (await bringFront()));
    await wait(1200);
  }

  for (let i = 0; i < 5; i++) {
    try {
      const srcs = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: w, height: h },
      });
      const shot = srcs[0]?.thumbnail;
      if (shot && !shot.isEmpty()) {
        const file = path.join(OUT, NAME);
        fs.writeFileSync(file, shot.toPNG());
        log(`SS OK ${NAME} bytes=${fs.statSync(file).size} size=${w}x${h} displays=${srcs.length}`);
        log('SS DONE');
        app.exit(0);
        return;
      }
    } catch (e) {
      log('  retry ' + i + ' err ' + e.message);
    }
    await wait(700);
  }
  log('SS FAIL 连续 5 次抓到空帧');
  log('SS DONE');
  app.exit(1);
});
