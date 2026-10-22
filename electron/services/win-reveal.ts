/*
 * 投屏窗口「藏到首帧、再放出来」（Windows）。
 *
 * 🔴 为什么需要它（2026-10-22 小杨反馈「投屏成功时会黑屏一会」）：
 *
 *   scrcpy 的窗口在视频流就绪前就已经建好了，屏幕上会先出现一个**黑底的窗口**
 *   （有时只剩一条白边 / 一块未绘制的客户区），要等 1~2 秒首帧解码完成才有画面。
 *   实测（scrcpy 3.1，真机 + 模拟器）：
 *     · 建窗 ~1.4s，窗口尺寸是占位的 274x303
 *     · 首帧日志 `INFO: Texture: WxH` 在 ~1.9s
 *     · 期间窗口要么已经可见（黑），要么在首帧后才 show —— 两种都遇到过
 *   所以「点投屏 → 黑窗闪一下 → 才有画面」是 scrcpy 的固有节奏，不是我们的 bug 之外
 *   还能回避的，只能由我们接管可见性。
 *
 * 做法（实测两平台都验证过）：
 *   ① spawn scrcpy 时带 `windowsHide: true`（= STARTUPINFO 的
 *      STARTF_USESHOWWINDOW + SW_HIDE）。SDL/Scrcpy 自己的首次 ShowWindow 会被
 *      系统**吞掉**，于是窗口全程不可见 —— 屏幕上干干净净，没有黑窗。
 *      ⚠️ 这正是 adb.ts 里那条「绝对不要加 windowsHide」警告的另一面：
 *         单用 windowsHide 会让窗口永远不出现；必须配合本模块主动 show。
 *   ② 监听子进程日志里的 `Texture:`（首帧解码完成）。
 *   ③ 用 PowerShell 内联 C# 找到该 PID 的窗口，ShowWindow(SW_SHOW) 并
 *      SetForegroundWindow 带出来 —— 放出来的那一刻画面已经在窗口里了。
 *   ④ 兜底：首帧迟迟不来（设备卡住 / 日志措辞变了）也要在 4s 后放出来，
 *      否则用户会以为投屏根本没启动（宁可看到黑窗，也不能什么都看不到）。
 *
 * ⚠️ 实现方式沿用 win-corners.ts 的选择：PowerShell 内联 C# 调 user32，
 *    不引入 koffi / ffi-napi（要跟随 Electron ABI 编译，只为两个 API 不值得）。
 *    代价是 PowerShell 冷启动 150~300ms —— 只在「放出来」的一刻起一次，
 *    用户看到的是窗口晚 0.3s 出现，无感。
 *
 * 🔴 只按 **PID** 找窗口，不按标题匹配：
 *    标题里有中文（`ADB助手 - <serial>`），走命令行传给 PowerShell 有编码风险，
 *    而 scrcpy 进程的顶层窗口只有一个，PID 就够唯一了（多个时取面积最大的）。
 */

import { execFile } from 'child_process';
import { log } from './adb';

export interface RevealResult {
  ok: boolean;
  /** ok=false 时为什么没放出来（写进运行日志） */
  reason?: string;
}

/**
 * 生成「找窗口 → 显示并激活」的 PowerShell 脚本。
 *
 * @param pid      scrcpy 子进程 pid
 * @param waitMs   最多轮询多久等窗口出现（窗口可能比日志晚几十毫秒）
 */
function psScript(pid: number, waitMs: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Rw {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr val);

  /*
   * 🔴 只调 ShowWindow 在「windowsHide 启动」的进程上不够可靠：
   *    实测 Electron 主进程 spawn 出来的 scrcpy，ShowWindow(SW_SHOW) 之后
   *    IsWindowVisible 仍是 false（STARTUPINFO 的首选项会把可见性改回去）。
   *    所以补两条更硬的路径：SWP_SHOWWINDOW，以及直接置 WS_VISIBLE 样式位。
   */
  const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004;
  const uint SWP_SHOWWINDOW = 0x0040, SWP_FRAMECHANGED = 0x0020;
  const int GWL_STYLE = -16;
  const long WS_VISIBLE = 0x10000000L;

  public static bool Force(IntPtr h) {
    ShowWindow(h, 5); // SW_SHOW
    if (IsWindowVisible(h)) return true;
    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW);
    if (IsWindowVisible(h)) return true;
    long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
    SetWindowLongPtr(h, GWL_STYLE, new IntPtr(style | WS_VISIBLE));
    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    return IsWindowVisible(h);
  }

  /* 该进程面积最大的带标题顶层窗口（scrcpy 只有一个，取最大是为了排除杂项） */
  public static IntPtr Best(uint pid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = -1;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RC r; GetWindowRect(h, out r);
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
$deadline = (Get-Date).AddMilliseconds(${waitMs})
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $h = [Rw]::Best(${pid})
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 40
}
if ($h -eq [IntPtr]::Zero) { 'notfound'; exit 0 }
if ([Rw]::Force($h)) {
  [void][Rw]::SetForegroundWindow($h)
  'shown'
} else {
  'hidden'
}
`;
}

/**
 * 把 scrcpy 那个被 STARTUPINFO 藏起来的窗口显示出来。
 *
 * 🔴 幂等性由调用方保证（mirror.ts 用 `revealed` 标记），这里不做去重。
 */
export function revealWindow(pid: number, waitMs = 1200): Promise<RevealResult> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: true });
  if (!pid) return Promise.resolve({ ok: false, reason: 'no-pid' });

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript(pid, waitMs),
      ],
      // windowsHide 只影响 powershell.exe 自己的控制台窗口，与被它操作的 scrcpy 窗口无关
      { windowsHide: true, timeout: waitMs + 4000 },
      (err, stdout) => {
        const out = (stdout || '').trim();
        if (err) {
          log('warn', '投屏', `投屏窗口显示失败：${err.message}`);
          resolve({ ok: false, reason: err.message });
          return;
        }
        if (out === 'shown') {
          resolve({ ok: true });
          return;
        }
        /*
         * notfound：窗口还没建出来（或进程已经退出）。
         * hidden：ShowWindow 调用了但系统仍判不可见 —— 极少见，留给上层重试。
         */
        resolve({ ok: false, reason: out || 'empty' });
      },
    );
  });
}
