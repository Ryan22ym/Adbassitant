/*
 * 投屏窗口「双击亮屏」（Windows）。
 *
 * 🔴 要解决的问题（2026-10-26 小杨提出）：
 *   手机熄屏后 scrcpy 窗口就是一块全黑的板子，鼠标点它没有任何反应 —— 因为
 *   熄屏状态下 Android 会把注入的 touch 事件直接丢掉，而 scrcpy 3.x 又没提供
 *   「唤醒设备」的快捷键（只有 `--stay-awake`，那是连接期间一直亮着）。
 *   结果用户只能伸手去按手机电源键，投屏就失去了一半意义。
 *
 * 做法：给 scrcpy 那个**外部进程窗口**装一个全局低级鼠标钩子。
 *   ① SetWindowsHookEx(WH_MOUSE_LL) 监听左键按下（只监听、不拦截）；
 *   ② 判定「这一次点击真的落在 scrcpy 窗口上」（WindowFromPoint 的根窗口 == 目标窗口，
 *      避免窗口被别的窗口遮挡时"看起来在矩形内"的误判）；
 *   ③ 同一位置（±8px）在 450ms 内点两下 → 认为双击；
 *   ④ `adb shell input keyevent 224`（KEYCODE_WAKEUP）。
 *
 * 🔴 为什么是 224 而不是 26（POWER）：
 *   26 是 toggle —— 屏幕亮着的时候一发就熄灭，误触代价极高。
 *   224 是幂等的："灭屏 → 点亮；亮屏 → 什么都不做"，所以可以无条件发，
 *   不需要先查 `dumpsys power` 判断状态（那要多花 100~300ms 且每点一次都要查）。
 *
 * ⚠️ 为什么不用 koffi / ffi-napi 直接调 user32：沿用 win-reveal.ts / win-corners.ts
 *    的选择 —— 那类库要跟随 Electron ABI 重编译，为了一个钩子不值得。
 *    这里把逻辑全写在 Add-Type 编译的 C# 里（钩子回调是原生速度），PowerShell
 *    只当宿主。常驻约 30~50MB 内存，和它省下的手工操作比很划算。
 *
 * 🔴 三个必须踩对的坑（都是实测出来的，改代码前先看）：
 *   ① **DPI**：125% 缩放下 PowerShell 默认 DPI-unaware，钩子拿到的 pt 是物理像素，
 *      而 GetWindowRect / WindowFromPoint 按虚拟化坐标算 —— 判定会全部落空
 *      （表现为"钩子正常收到点击，但永远不触发"）。必须先 SetProcessDPIAware()。
 *   ② **委托生命周期**：HookProc 委托必须存静态字段，否则被 GC 回收后
 *      系统回调打到野指针上，PowerShell 直接崩。
 *   ③ **编码**：脚本要写成 UTF-8 **带 BOM** 的临时 .ps1 再 `-File` 执行，
 *      不能把脚本内容塞进 `-Command`：开发机 bin 目录是 `D:\WorkSpace\手机助手\...`
 *      这种含中文的路径，走命令行会按 ANSI 代码页解码成乱码，adb 直接找不到。
 *
 * 生命周期：跟随投屏。startMirror 起来就装、停投屏/进程退出就拆；
 * 另有一根看门狗线程盯着 Electron 主进程 pid，主进程被强杀时钩子自己退出，
 * 不会留下一个孤儿进程在后台吃鼠标事件。
 */

import { ChildProcess, spawn } from 'child_process';
import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { adbPath, log } from './adb';

/** 钩子就绪的标志行（C# 里 Note() 写进日志文件，这里靠它判断装没装上） */
const READY_MARK = 'ready';

let current: { child: ChildProcess; targetPid: number; scriptPath: string } | null = null;

/** PowerShell 单引号字符串里只需要把 ' 双写 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 生成完整的 .ps1 内容：C# 钩子 + 内联参数。
 *
 * 参数一律内联而不是走命令行 —— 见文件头「编码」那条坑。
 * 日志用 `HookLog` 环境变量式的变量直接内联路径，C# 侧只负责 AppenText。
 */
function psScript(opts: {
  targetPid: number;
  ownerPid: number;
  adb: string;
  serial: string;
  logPath: string;
  dblMs: number;
  tolPx: number;
}): string {
  const csharp = `
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class AdbWakeDblClick
{
    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x0201;
    const uint GA_ROOT = 2;
    const int KEYCODE_WAKEUP = 224;

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT
    {
        public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int L; public int T; public int R; public int B; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public POINT pt; public uint lPrivate;
    }

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr mod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int nCode, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint lo, uint hi);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

    // 静态持有：委托被 GC 回收 = 系统回调打到野指针 = 进程崩
    static HookProc _hookProc;
    static IntPtr _hook = IntPtr.Zero;
    static IntPtr _target = IntPtr.Zero;
    static uint _targetPid;
    static string _adb, _serial, _logPath;
    static int _dblMs = 450, _tolPx = 8;
    static int _lastTick, _lastX, _lastY;
    static int _busy;

    public static int Run(int targetPid, int ownerPid, string adb, string serial,
                          string logPath, int dblMs, int tolPx)
    {
        _targetPid = (uint)targetPid;
        _adb = adb; _serial = serial; _logPath = logPath;
        if (dblMs > 0) _dblMs = dblMs;
        if (tolPx > 0) _tolPx = tolPx;

        try { SetProcessDPIAware(); } catch { }

        WatchOwner(ownerPid);

        _hookProc = Hook;
        _hook = SetWindowsHookEx(WH_MOUSE_LL, _hookProc, GetModuleHandle(null), 0);
        if (_hook == IntPtr.Zero)
        {
            Note("hook-fail err=" + Marshal.GetLastWin32Error());
            return 2;
        }

        _target = FindTarget();
        Note("ready target=" + targetPid + " hwnd=" + _target);

        MSG m; int r;
        while ((r = GetMessage(out m, IntPtr.Zero, 0, 0)) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
        UnhookWindowsHookEx(_hook);
        return 0;
    }

    /** 主进程被强杀时钩子要自己退，否则会留下孤儿进程一直吃鼠标事件 */
    static void WatchOwner(int ownerPid)
    {
        if (ownerPid <= 0) return;
        Thread t = new Thread(delegate ()
        {
            while (true)
            {
                Thread.Sleep(1500);
                try { Process.GetProcessById(ownerPid); }
                catch { Environment.Exit(0); }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    static IntPtr Hook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == 0 && wParam == (IntPtr)WM_LBUTTONDOWN)
        {
            try { OnDown(lParam); } catch { }
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    static void OnDown(IntPtr lParam)
    {
        MSLLHOOKSTRUCT hs = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));

        if (_target == IntPtr.Zero || !IsWindow(_target)) _target = FindTarget();
        if (_target == IntPtr.Zero) return;
        if (IsIconic(_target) || !IsWindowVisible(_target)) return;

        IntPtr under = WindowFromPoint(hs.pt);
        if (under == IntPtr.Zero) { _lastTick = 0; return; }
        if (GetAncestor(under, GA_ROOT) != _target) { _lastTick = 0; return; }

        int now = Environment.TickCount;
        bool dbl = (now - _lastTick) <= _dblMs
                   && Math.Abs(hs.pt.X - _lastX) <= _tolPx
                   && Math.Abs(hs.pt.Y - _lastY) <= _tolPx;

        _lastTick = now; _lastX = hs.pt.X; _lastY = hs.pt.Y;

        if (dbl)
        {
            _lastTick = 0;   // 三连击只算一次
            Wake();
        }
    }

    static void Wake()
    {
        if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(_adb,
                    "-s \\"" + _serial + "\\" shell input keyevent " + KEYCODE_WAKEUP);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string err = p.StandardError.ReadToEnd();
                    p.WaitForExit(5000);
                    if (p.ExitCode != 0) Note("wake exit=" + p.ExitCode + " " + err.Trim());
                    else Note("wake ok");
                }
            }
            catch (Exception e) { Note("wake fail " + e.Message); }
            finally { Interlocked.Exchange(ref _busy, 0); }
        });
    }

    /** 该 pid 面积最大的带标题顶层窗口（scrcpy 只有一个，取最大排除杂项） */
    static IntPtr FindTarget()
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = -1;
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != _targetPid) return true;
            if (GetWindowTextLength(h) == 0) return true;
            RECT r; GetWindowRect(h, out r);
            long a = (long)(r.R - r.L) * (r.B - r.T);
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    static void Note(string s)
    {
        try { File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\\r\\n"); }
        catch { }
    }
}
`;

  return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
${csharp}
'@
[AdbWakeDblClick]::Run(${opts.targetPid}, ${opts.ownerPid}, ${psQuote(opts.adb)}, ${psQuote(
    opts.serial,
  )}, ${psQuote(opts.logPath)}, ${opts.dblMs}, ${opts.tolPx})
`;
}

export interface WakeWatchState {
  running: boolean;
  targetPid?: number;
}

export function getWakeWatchState(): WakeWatchState {
  if (!current) return { running: false };
  return { running: true, targetPid: current.targetPid };
}

/**
 * 给某个 scrcpy 窗口装上「双击亮屏」。
 *
 * 幂等：已在监听同一个 pid 就什么都不做；换了 pid 会先拆旧的。
 * 失败（钩子装不上 / PowerShell 起不来）只记日志，绝不让投屏失败。
 */
export function startWakeWatch(targetPid: number, serial: string): void {
  if (process.platform !== 'win32') return;
  if (!targetPid) return;
  if (current?.targetPid === targetPid) return;

  stopWakeWatch();

  // 日志与脚本都放临时目录：日志给"没生效"时排查用
  const stamp = `${process.pid}-${targetPid}`;
  const logPath = join(tmpdir(), `adb-assistant-wake-${stamp}.log`);
  const scriptPath = join(tmpdir(), `adb-assistant-wake-${stamp}.ps1`);

  try {
    // 🔴 必须带 BOM：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 读，
    //    内联的 adb 路径若含中文会被解成乱码（开发机路径就有）。
    writeFileSync(scriptPath, '\uFEFF' + psScript({
      targetPid,
      ownerPid: process.pid,
      adb: adbPath(),
      serial,
      logPath,
      dblMs: 450,
      tolPx: 8,
    }), 'utf8');
  } catch (e) {
    log('warn', '投屏', `双击亮屏脚本写入失败：${(e as Error).message}`);
    return;
  }

  let child: ChildProcess;
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
      ],
      { windowsHide: true, stdio: 'ignore', detached: false },
    );
  } catch (e) {
    log('warn', '投屏', `双击亮屏启动失败：${(e as Error).message}`);
    return;
  }

  const handle = { child, targetPid, scriptPath };
  current = handle;

  child.on('error', (err) => {
    log('warn', '投屏', `双击亮屏不可用：${err.message}`);
    if (current === handle) current = null;
  });

  child.on('close', (code) => {
    if (current === handle) current = null;
    // 非 0 退出说明钩子没装上（比如安全软件拦了 SetWindowsHookEx）
    if (code !== 0 && code !== null) {
      log('warn', '投屏', `双击亮屏已退出（exit ${code}）`);
    }
  });
}

export function stopWakeWatch(): void {
  const h = current;
  if (!h) return;
  current = null;
  try {
    h.child.kill();
  } catch {
    /* ignore */
  }
  // 临时 .ps1 是用完即弃的（内容含本次的 pid / serial），顺手清掉；
  // 同名 .log 保留 —— 用户报「双击没反应」时要靠它排障。
  // 刚 kill 的那一瞬间文件可能还被 powershell 占着，删不掉就 800ms 后补一刀。
  if (!tryUnlink(h.scriptPath)) {
    const t = setTimeout(() => tryUnlink(h.scriptPath), 800);
    // 别为了删个临时文件把进程退出拖住
    t.unref?.();
  }
}

function tryUnlink(p: string): boolean {
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
