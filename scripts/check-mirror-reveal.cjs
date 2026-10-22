/**
 * 真机/模拟器回归：投屏窗口「藏到首帧再放出来」（v1.1.15，2026-10-22）。
 *
 * 起因：小杨反馈「投屏成功时，会黑屏一会」。
 *   scrcpy 在收到第一帧视频之前就把窗口建好了（实测建窗 ~1.4s、首帧 ~1.9s），
 *   那 0.5~1s 里屏幕上是个黑底窗口。
 *
 * 修法（见 electron/services/win-reveal.ts 文件头）：
 *   spawn 时 windowsHide → 系统吞掉 scrcpy 的首次 ShowWindow，屏幕上不出黑窗；
 *   等它日志打出 `Texture:`（首帧解码完成）再由我们 ShowWindow 带出来。
 *
 * 🔴 这条回归守的是**不能更糟**：
 *   窗口被藏起来后，只有我们能放出来。reveal 链路一旦断掉，现象会从
 *   「黑一会」变成「投屏在跑但永远看不到窗口」—— 比原 bug 严重得多。
 *
 * 判据：
 *   ① 启动后窗口先是不可见（藏住了，没有黑窗先冒出来）
 *   ② 首帧之后窗口变为可见（放出来了）
 *   ③ 运行日志里必须是「首帧就绪」触发的，不是 4s 超时兜底
 *
 * 需要一台在线设备；没有就跳过（返回 0），不阻塞流水线。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-mirror-reveal.cjs \
 *     --watch ui-shots/_mirror-reveal.log --until "MIRROR REVEAL CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_mirror-reveal.log');
const ADB = path.join(ROOT, 'bin', 'adb.exe');

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-mirror-reveal-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

/**
 * 用一段常驻 PowerShell 采样窗口可见性，返回 `[时间ms:可见]` 数组。
 *
 * 为什么要做成一次常驻采样而不是 Node 每 200ms 查一次：
 *   PowerShell 冷启动 150~300ms，逐次调用会把时间精度毁掉，而且 8 秒里要起几十个进程。
 */
function sampleVisibility(pid, durationMs) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Vw {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RC r);
  public static string Probe(uint pid) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RC r; GetWindowRect(h, out r);
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return "none";
    return IsWindowVisible(best) ? "1" : "0";
  }
  /* 返回窗口矩形的 "x,y,w,h"（PS 里用 System.Drawing 截这块屏算亮度） */
  public static string Rect(uint pid) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RC r; GetWindowRect(h, out r);
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return "";
    RC rr; GetWindowRect(best, out rr);
    return "" + rr.L + "," + rr.T + "," + (rr.R - rr.L) + "," + (rr.B - rr.T);
  }
}
"@
Add-Type -AssemblyName System.Drawing
$sw = [Diagnostics.Stopwatch]::StartNew()
$rows = @()
$luma = -1
$lumaAt = -1
while ($sw.ElapsedMilliseconds -lt ${durationMs}) {
  $v = [Vw]::Probe(${pid})
  $rows += "$($sw.ElapsedMilliseconds):$v"
  # 第一次看到可见的那一轮，立刻抓窗口区域算平均亮度（判断"放出来时有画面"还是"黑窗"）
  if ($v -eq "1" -and $luma -lt 0) {
    try {
      $p = ([Vw]::Rect(${pid})) -split ','
      if ($p.Count -eq 4) {
        $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3]
        if ($w -gt 50 -and $h -gt 50) {
          $bmp = New-Object System.Drawing.Bitmap($w, $h)
          $g = [System.Drawing.Graphics]::FromImage($bmp)
          $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
          $sum = 0.0; $n = 0
          $stepY = [Math]::Max(1, [int]($h / 12)); $stepX = [Math]::Max(1, [int]($w / 12))
          for ($yy = [int]($h / 10); $yy -lt [int]($h * 9 / 10); $yy += $stepY) {
            for ($xx = [int]($w / 10); $xx -lt [int]($w * 9 / 10); $xx += $stepX) {
              $c = $bmp.GetPixel($xx, $yy)
              $sum += ($c.R * 0.299 + $c.G * 0.587 + $c.B * 0.114); $n++
            }
          }
          $g.Dispose(); $bmp.Dispose()
          if ($n -gt 0) { $luma = [Math]::Round($sum / $n, 1); $lumaAt = $sw.ElapsedMilliseconds }
        }
      }
    } catch { }
  }
  Start-Sleep -Milliseconds 120
}
"$($rows -join ',')|luma=$luma@$lumaAt"
`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: durationMs + 15000 },
      (err, stdout) => {
        if (err) {
          resolve({ rows: [], luma: -1, lumaAt: -1 });
          return;
        }
        const txt = String(stdout).trim();
        const bar = txt.lastIndexOf('|luma=');
        const rowsPart = bar >= 0 ? txt.slice(0, bar) : txt;
        const m = bar >= 0 ? /luma=(-?[\d.]+)@(-?\d+)/.exec(txt.slice(bar)) : null;
        resolve({
          rows: rowsPart.split(',').filter(Boolean),
          luma: m ? Number(m[1]) : -1,
          lumaAt: m ? Number(m[2]) : -1,
        });
      },
    );
  });
}

/**
 * 诊断用：列出该 pid 的所有顶层窗口（标题/可见性/尺寸/Style 位）。
 * 只在「窗口始终不可见」时调用，用来区分「选错窗口」和「ShowWindow 无效」。
 */
function listWindows(pid) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Lw {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RC r);
  public static string Dump(uint pid) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      RC r; GetWindowRect(h, out r);
      list.Add(string.Format("hwnd={0} vis={1} {2}x{3} style=0x{4:X} ex=0x{5:X} title=[{6}]",
        h, IsWindowVisible(h), r.R - r.L, r.B - r.T,
        GetWindowLongPtr(h, -16).ToInt64(), GetWindowLongPtr(h, -20).ToInt64(), sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return list.Count == 0 ? "(none)" : string.Join(" | ", list);
  }
}
"@
[Lw]::Dump(${pid})
`;
  try {
    return execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 }).toString().trim();
  } catch (e) {
    return 'dump-failed: ' + String(e && e.message);
  }
}

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');

  const rows = [];
  const ok = (cond, name, detail) => {
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  };

  // 取一台在线设备（优先真机：serial 不含 emulator-）
  let serial = '';
  try {
    const out = execFileSync(ADB, ['devices'], { timeout: 8000 }).toString();
    const list = out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => /\tdevice$/.test(l))
      .map((l) => l.split(/\t/)[0]);
    serial = list.find((s) => !s.startsWith('emulator-')) || list[0] || '';
  } catch {
    serial = '';
  }
  if (!serial) {
    log('没有在线设备，跳过');
    log('MIRROR REVEAL CHECK DONE');
    app.exit(0);
    return;
  }
  log('serial =', serial);

  const { startMirror, stopMirror, getMirrorStatus } = require('../dist-electron/electron/services/mirror.js');
  const { MIRROR_DEFAULTS } = require('../dist-electron/shared/mirror-defaults.js');

  /*
   * 把服务的日志广播接进来。
   * 🔴 不读 <userData>/logs 文件：log() 只是把事件推给 sink，落盘要 ipc.ts 注册
   *    sink 之后才发生 —— 这个自检脚本没起 ipc，文件永远是空的（上一版就是这么
   *    假 FAIL 的：判据读了个不存在的目录）。
   */
  const sinkLines = [];
  require('../dist-electron/electron/services/adb.js').setLogSink((e) => {
    sinkLines.push(`[${e.level}] [${e.source}] ${e.message}`);
    log(`[${e.level}] [${e.source}] ${e.message}`);
  });

  const started = await startMirror({ serial, ...MIRROR_DEFAULTS });
  const pid = started.pid;
  log('投屏 pid =', pid);

  // 采样 6s：覆盖「建窗(≈1.4s) → 首帧(≈2s) → reveal」
  const { rows: samples, luma, lumaAt } = await sampleVisibility(pid, 6000);

  // 解析成 [ms, visible] 序列
  const seq = samples
    .map((s) => {
      const [t, v] = s.split(':');
      return [Number(t), v];
    })
    .filter(([t]) => Number.isFinite(t));

  const firstVisible = seq.find(([, v]) => v === '1');
  const sawHidden = seq.some(([, v]) => v === '0');
  const everVisible = !!firstVisible;

  log('可见性时间线（截断）:', JSON.stringify(seq.filter((_, i) => i % 4 === 0)));

  ok(sawHidden, '① 启动初期窗口不可见（黑窗没有先冒出来）');
  ok(everVisible, '② 首帧之后窗口被放出来了', firstVisible ? `${firstVisible[0]}ms` : '始终不可见');
  ok(!!firstVisible && firstVisible[0] >= 1200, '③ 显示发生在建窗之后（不是启动瞬间闪现）',
    firstVisible ? `${firstVisible[0]}ms` : '-');

  /*
   * ⑥ 这才是小杨最初的诉求：窗口出现的那一瞬间屏幕上已经是画面，而不是黑底。
   *    判据用「可见那一刻窗口区域的平均亮度」：黑屏 ≈ 0~10，正常画面几十以上。
   *    阈值取 15 而不是更高 —— 深色主题的界面也可能偏暗，我们要抓的是纯黑。
   */
  log('首次可见时窗口平均亮度 =', luma, '@', lumaAt, 'ms');
  ok(luma > 15, '⑥ 放出来时已不是黑屏（窗口区域有画面）', luma < 0 ? '没能取到像素' : `luma=${luma}`);

  // ③ 的强化：必须是「首帧就绪」触发的，而不是 4s 超时兜底。
  //    判据用上面接进来的 sink 文本（服务日志的全部内容都在这里）。
  const logText = sinkLines.join('\n');
  const byTexture = /投屏窗口已显示（首帧就绪）/.test(logText);
  const byTimeout = /投屏窗口已显示（等待首帧超时）/.test(logText);
  ok(byTexture, '④ 由首帧日志触发显示', byTexture ? '' : '日志里没有「首帧就绪」');
  ok(!byTimeout, '⑤ 没有落到 4s 超时兜底');

  // 附属信息：窗口始终不可见时，多半是 reveal 本身没成功 —— 再手动探一次看原因
  if (!everVisible) {
    const { revealWindow } = require('../dist-electron/electron/services/win-reveal.js');
    const r = await revealWindow(pid, 1500);
    log('手动补一次 reveal =', JSON.stringify(r));
    log('该 pid 的顶层窗口清单：', JSON.stringify(listWindows(pid)));
  }
  log('6s 后投屏状态 =', JSON.stringify(getMirrorStatus()).slice(0, 200));

  await stopMirror();

  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log(`\n合计 ${rows.length} 项，失败 ${fail} 项`);
  log('MIRROR REVEAL CHECK DONE');
  app.exit(fail === 0 ? 0 : 1);
});
