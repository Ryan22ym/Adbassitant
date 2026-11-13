/*
 * 投屏窗口的 Win32 代理（v1.1.22）。
 *
 * 需求背景（小杨 2026-11-04）：投屏窗口右侧要挂一条功能栏，栏里第一件事是
 * 「pin」—— 钉住之后投屏窗口压在所有窗口之上、位置与大小都锁死，再点一次解除。
 *
 * 🔴🔴 为什么必须有这个模块：scrcpy 是**独立进程的独立窗口**，它的位置/大小/
 *    Z 序、以及窗口样式（能不能拉伸）全部只在 Win32 这一层，Electron 的
 *    BrowserWindow API 完全碰不到别人的窗口。功能栏要贴着它走、pin 要锁它，
 *    就只能自己调 user32。
 *
 * 实现方式沿用 win-reveal.ts / wake-window.ts 的路子：PowerShell 内联 C#
 * （不引 koffi / ffi-napi，那些要跟着 Electron ABI 重编译）。
 *
 * 进程模型：**常驻一个 PowerShell**，跟随投屏起停。
 *   · 它每 30ms 读一次目标窗口的矩形，值变了就往 stdout 写一行（Node 直接
 *     `readline` 收，比落盘轮询快得多 —— 功能栏跟手全靠这条链路）；
 *   · Node 要它做事（pin / unpin / 摆到指定矩形）就写一个**命令文件**，
 *     它每轮比对文件内容，变了就执行、执行完回一行 ACK。
 *     命令走文件不走 stdin：PowerShell `-File` 宿主下 `[Console]::In` 会被
 *     宿主自己吃掉，行为不稳；而命令频率极低（点按钮才有），丢一点延迟无所谓。
 *
 * 🔴 三条实测坑（改之前先看）：
 *   ① **DPI**：PowerShell 默认 DPI-unaware，GetWindowRect 拿到的是被系统
 *      虚拟化过的坐标（1/scaleFactor 再取整），和 Electron 的 DIP 混着算必然错位；
 *      而 SetWindowPos 喂进去的坐标也会再被缩放一次。必须先 SetProcessDPIAware()，
 *      之后全程**物理像素**，由 Node 侧按 display.scaleFactor 换算成 DIP。
 *   ② **只读窗口样式、绝不写**：`GetWindowLongW` 读 GWL_EXSTYLE 判断「本来是不是
 *      置顶」。**不要**去抠 WS_THICKFRAME 之类的样式位（32 位常量用 ...LongW 读是对的，
 *      但写样式会重算非客户区 → 标题栏变矮，见 DoPin 里的长注释）。
 *   ③ 脚本要写成 **UTF-8 带 BOM 的临时 .ps1 再 `-File` 执行**（理由同 wake-window.ts：
 *      开发机路径含中文，走 -Command 会按 ANSI 解码成乱码）。
 *
 * 生命周期：跟随投屏。开始投屏时装、停止/进程退出就拆；另有看门狗盯着
 * Electron 主进程 pid，主进程被强杀时代理自己退，不留孤儿进程。
 */

import { ChildProcess, spawn } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { log } from './adb';

export interface MirrorWinRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MirrorWinState {
  /** 目标窗口句柄；0 = 还没找到（窗口没建出来 / 已经销毁） */
  hwnd: number;
  visible: boolean;
  minimized: boolean;
  /** 代理自己记的 pin 状态（置顶 + 锁矩形） */
  pinned: boolean;
  /** 物理像素（SetProcessDPIAware 之后 GetWindowRect 的真实值） */
  rect: MirrorWinRect;
}

type StateListener = (s: MirrorWinState) => void;

const listeners = new Set<StateListener>();

let current: {
  child: ChildProcess;
  targetPid: number;
  scriptPath: string;
  cmdPath: string;
  seq: number;
} | null = null;

let lastState: MirrorWinState | null = null;

/** PowerShell 单引号字符串里只需要把 ' 双写 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function psScript(opts: { targetPid: number; ownerPid: number; cmdPath: string }): string {
  const csharp = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class MirrorWinAgent
{
    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOPMOST  = 0x00000008L;
    const int SW_RESTORE = 9;
    /* 旋转后「先跟随再上锁」的跟随期（ms）—— 见 Settling() */
    const int SETTLE_MS = 500;
    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020, SWP_SHOWWINDOW = 0x0040;

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowLongW(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static IntPtr _target = IntPtr.Zero;
    static uint _pid;
    static string _cmdPath;
    static string _cmdSeen = "";
    static bool _pinned;
    static RECT _lockRect;
    static RECT _origRect;
    /* pin 那一刻窗口是横屏还是竖屏 —— 解除 pin 时用来判断「中间转过方向没有」 */
    static bool _pinLandscape;
    static bool _origTopmost;
    /* 旋转后 scrcpy 会连改几次窗口尺寸，这段「跟随后再锁」见 Enforce */
    static bool _settling;
    static int _settleUntil;
    static int _settleStable;
    static RECT _settlePrev;
    static int _lastL = int.MinValue, _lastT, _lastR, _lastB;
    static int _lastVis = -1, _lastMin = -1, _lastPin = -1, _lastHwnd = -1;
    static int _badTicks;

    static StreamWriter _out;

    public static int Run(int targetPid, int ownerPid, string cmdPath)
    {
        _pid = (uint)targetPid;
        _cmdPath = cmdPath;
        try { SetProcessDPIAware(); } catch { }
        _out = new StreamWriter(Console.OpenStandardOutput());
        _out.AutoFlush = true;

        WatchOwner(ownerPid);

        while (true)
        {
            try
            {
                if (_target == IntPtr.Zero || !IsWindow(_target)) _target = FindTarget();
                else if (Degenerate(_target) && (++_badTicks % 10) == 0) _target = FindTarget();
                Poll();
                ConsumeCommand();
            }
            catch (Exception e) { Note("loop " + e.Message); }
            Thread.Sleep(30);
        }
    }

    static void Poll()
    {
        if (_target == IntPtr.Zero)
        {
            Emit();
            return;
        }
        if (_pinned) Enforce();
        Emit();
    }

    /* pin 期间把窗口按回锁定矩形；旋转（宽高比类别变了）视为合法变化，接受并重新锁定 */
    static void Enforce()
    {
        if (!IsWindow(_target)) return;
        if (IsIconic(_target) || !IsWindowVisible(_target)) return;
        /*
         * 双击标题栏 / 拖到屏幕顶端会被系统最大化。DoPin 已经不抠 WS_MAXIMIZEBOX
         * 了（抠样式会把标题栏变矮，见 DoPin 注释），所以这条要自己兜住：
         * 先撤掉最大化，再让下面的矩形比对把窗口按回锁定处。
         */
        if (IsZoomed(_target)) ShowWindow(_target, SW_RESTORE);
        RECT r; if (!GetWindowRect(_target, out r)) return;
        int w = r.R - r.L, h = r.B - r.T;

        /*
         * 🔴 置顶必须每轮自检，不能只在点 pin 那一下设一次。
         *    scrcpy 是 SDL 窗口，SDL 每次改窗口位置/尺寸都会调 SetWindowPos 并按
         *    它自己的 SDL_WINDOW_ALWAYS_ON_TOP 传 **HWND_NOTOPMOST** —— 我们刚设的
         *    WS_EX_TOPMOST 会被它顺手抹掉。触发场景很常见：旋转、画面尺寸变化、
         *    scrcpy 自己的窗口适配。症状是「钉着钉着就不在最上层了」。
         */
        if ((GetWindowLongW(_target, GWL_EXSTYLE) & (int)WS_EX_TOPMOST) == 0)
            SetWindowPos(_target, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

        bool wasLandscape = (_lockRect.R - _lockRect.L) >= (_lockRect.B - _lockRect.T);
        bool isLandscape = w >= h;
        if (wasLandscape != isLandscape)
        {
            /* 设备转了方向：scrcpy 自己缩放了窗口，保持左上角、接受新尺寸 */
            _settling = true;
            _settleUntil = unchecked(Environment.TickCount + SETTLE_MS);
            _settleStable = 0;
            _settlePrev = r;
            _lockRect = r;
            return;
        }
        if (Settling(r)) return;
        if (r.L != _lockRect.L || r.T != _lockRect.T || r.R != _lockRect.R || r.B != _lockRect.B)
        {
            SetWindowPos(_target, new IntPtr(-1), _lockRect.L, _lockRect.T,
                _lockRect.R - _lockRect.L, _lockRect.B - _lockRect.T,
                SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }

    /*
     * 旋转后要「先跟随、后锁定」。
     * 🔴 以前是「一发现横竖屏变了就把当前矩形锁死」，实测会把窗口冻在**过渡尺寸**上
     *    （竖屏 338×767 → 横屏 738×367，中间会经过 335×188 这种半成品），
     *    结果旋转完 pin 住的是一个很小的小窗。现在给 SETTLE_MS 的跟随期，
     *    再加上「尺寸连续 3 轮不变」才真正上锁。
     */
    static bool Settling(RECT r)
    {
        /* 用布尔位而不是拿 _settleUntil 跟 TickCount 硬比：TickCount 是 int，
           开机超过 ~24.9 天会变负数，那样「初始值 0」会被误判成「正在跟随」。 */
        if (!_settling) return false;
        if (unchecked(Environment.TickCount - _settleUntil) < 0)
        {
            _lockRect = r; _settlePrev = r; _settleStable = 0;
            return true;
        }
        if (SameRect(_settlePrev, r)) _settleStable++;
        else { _settlePrev = r; _settleStable = 0; }
        _lockRect = r;
        if (_settleStable >= 3) _settling = false;
        return true;
    }

    static bool SameRect(RECT a, RECT b)
    {
        return a.L == b.L && a.T == b.T && a.R == b.R && a.B == b.B;
    }

    static void ConsumeCommand()
    {
        string text;
        try { text = File.ReadAllText(_cmdPath).Trim(); }
        catch { return; }
        if (text.Length == 0 || text == _cmdSeen) return;

        /* 命令体后面带一行 "#序号"（保证同一条命令连发两次内容也不同），
           所以按任意空白切、丢掉空项 */
        string[] p = text.Split(new char[] { ' ', '\\n', '\\r', '\\t' }, StringSplitOptions.RemoveEmptyEntries);
        if (p.Length == 0) return;
        string verb = p[0];
        bool ok = true;
        try
        {
            if (verb == "NOOP")
            {
                /* 预置/占位命令，什么都不做 */
            }
            else if (verb == "PIN" && p.Length >= 5)
            {
                DoPin(Int(p[1]), Int(p[2]), Int(p[3]), Int(p[4]));
            }
            else if (verb == "PINHERE")
            {
                /* 就地钉住：用窗口**此刻**的矩形，绝不按外面传来的坐标挪一下 */
                RECT cur;
                if (GetWindowRect(_target, out cur))
                    DoPin(cur.L, cur.T, cur.R - cur.L, cur.B - cur.T);
                else ok = false;
            }
            else if (verb == "UNPIN")
            {
                DoUnpin();
            }
            else if (verb == "RECT" && p.Length >= 5)
            {
                DoRect(Int(p[1]), Int(p[2]), Int(p[3]), Int(p[4]));
            }
            else if (verb == "LOCK" && p.Length >= 5)
            {
                _lockRect.L = Int(p[1]); _lockRect.T = Int(p[2]);
                _lockRect.R = Int(p[1]) + Int(p[3]); _lockRect.B = Int(p[2]) + Int(p[4]);
            }
            else if (verb == "QUERY")
            {
                /* 只是把当前状态立刻吐一次 */
            }
            else
            {
                ok = false;
            }
        }
        catch (Exception e) { ok = false; Note("cmd " + verb + " " + e.Message); }

        if (ok) _cmdSeen = text;
        Ack(verb, ok);
        Emit();
    }

    static int Int(string s) { return int.Parse(s); }

    static void DoPin(int x, int y, int w, int h)
    {
        if (!_pinned)
        {
            GetWindowRect(_target, out _origRect);
            /* 记住「本来是不是置顶」：投屏参数里就有 --always-on-top，解除 pin 时
               不能把它一起撤掉，否则用户原本开着的置顶被我们弄没了 */
            _origTopmost = (GetWindowLongW(_target, GWL_EXSTYLE) & (int)WS_EX_TOPMOST) != 0;
            _pinLandscape = w >= h;
        }
        /*
         * 🔴🔴 这里**绝对不许改窗口样式**（早期版本把 WS_THICKFRAME /
         *    WS_MAXIMIZEBOX 抠掉，用来「禁止拉伸」）。WS_THICKFRAME 是参与
         *    非客户区尺寸计算的：抠掉之后 SM_CXSIZEFRAME 归零，**标题栏立刻变矮**
         *    （125% 缩放下约 13px），而 SetWindowPos 给的是同一个外框矩形 →
         *    客户区凭空长大 ~13px，scrcpy/SDL 收到 WM_SIZE 再缩放一次画面。
         *    表现出来就是：点 pin 的瞬间顶栏窄一下、整个窗口抖一下（小杨 2026-11-05 报的）。
         *    锁大小改成纯靠 Enforce() 每 30ms 把矩形按回去，不动样式就没有这一帧。
         */
        SetWindowPos(_target, new IntPtr(-1), x, y, w, h,
            SWP_NOACTIVATE | SWP_SHOWWINDOW);
        _lockRect.L = x; _lockRect.T = y; _lockRect.R = x + w; _lockRect.B = y + h;
        _pinned = true;
    }

    static void DoUnpin()
    {
        if (!_pinned) return;
        RECT r;
        if (!GetWindowRect(_target, out r))
        {
            r = _origRect;
        }
        bool nowLandscape = (r.R - r.L) >= (r.B - r.T);
        _pinned = false;
        if (_pinLandscape == nowLandscape)
        {
            /* 没转过方向：照旧还原 pin 之前的矩形（通常和当前矩形一模一样，等于不动） */
            SetWindowPos(_target, new IntPtr(_origTopmost ? -1 : -2), _origRect.L, _origRect.T,
                _origRect.R - _origRect.L, _origRect.B - _origRect.T,
                SWP_NOACTIVATE | SWP_SHOWWINDOW);
            return;
        }
        /*
         * 🔴 中间转过方向（竖屏 pin → 转横屏 → 解除）：_origRect 是**竖屏那一刻**
         *    的矩形，照它还原就是把用户刚转好的横屏界面硬塞回一个竖屏窗口
         *    （小杨 2026-11-05 报的「解除 pin 后界面错误地回到竖屏」）。
         *    方向变了就只撤置顶，位置尺寸一概不碰 —— 保持用户当前看到的画面。
         *    ⚠️ 这个 C# 是塞在 JS 模板字符串里的：注释里不许出现反引号，否则
         *       模板当场闭合（TS1005 报在第 290 行附近，看起来像别处的语法错）。
         */
        SetWindowPos(_target, new IntPtr(_origTopmost ? -1 : -2), 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static void DoRect(int x, int y, int w, int h)
    {
        SetWindowPos(_target, IntPtr.Zero, x, y, w, h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        if (_pinned)
        {
            _lockRect.L = x; _lockRect.T = y; _lockRect.R = x + w; _lockRect.B = y + h;
        }
    }

    static void Emit()
    {
        int hwnd = _target == IntPtr.Zero ? 0 : _target.ToInt32();
        int vis = 0, min = 0;
        RECT r; r.L = r.T = r.R = r.B = 0;
        if (_target != IntPtr.Zero && IsWindow(_target))
        {
            vis = IsWindowVisible(_target) ? 1 : 0;
            min = IsIconic(_target) ? 1 : 0;
            GetWindowRect(_target, out r);
        }
        int pin = _pinned ? 1 : 0;
        if (hwnd == _lastHwnd && vis == _lastVis && min == _lastMin && pin == _lastPin
            && r.L == _lastL && r.T == _lastT && r.R == _lastR && r.B == _lastB)
        {
            return;
        }
        _lastHwnd = hwnd; _lastVis = vis; _lastMin = min; _lastPin = pin;
        _lastL = r.L; _lastT = r.T; _lastR = r.R; _lastB = r.B;
        _out.WriteLine("S|" + hwnd + "|" + vis + "|" + min + "|" + pin + "|"
            + r.L + "|" + r.T + "|" + r.R + "|" + r.B);
    }

    static void Ack(string verb, bool ok)
    {
        _out.WriteLine((ok ? "A|" : "X|") + verb);
    }

    static IntPtr FindTarget()
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = -1;
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != _pid) return true;
            if (GetWindowTextLength(h) == 0) return true;
            RECT r; GetWindowRect(h, out r);
            long a = (long)(r.R - r.L) * (r.B - r.T);
            /* 🔴 scrcpy 进程里除了视频窗口还有 0x0 的辅助窗口（SDL 的隐藏窗口之类），
               它们同样有标题。只按「面积最大」挑的话，视频窗口还没定尺寸时就会
               挑中一个 0x0 的，之后 IsWindow 恒为真、再也不会重新挑 ——
               表现为功能栏永远不出现、pin 永远失效。所以把「太小」的直接排除。 */
            if (a < 80 * 80) return true;
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    /** 目标窗口尺寸退化（0x0 / 极小）—— 说明当初挑错了窗口，得重挑 */
    static bool Degenerate(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return true;
        return (r.R - r.L) < 80 || (r.B - r.T) < 80;
    }

    /** 主进程被强杀时代理自己退，否则会留一个孤儿进程一直读窗口 */
    static void WatchOwner(int ownerPid)
    {
        if (ownerPid <= 0) return;
        Thread t = new Thread(delegate ()
        {
            while (true)
            {
                Thread.Sleep(1500);
                try { System.Diagnostics.Process.GetProcessById(ownerPid); }
                catch { Environment.Exit(0); }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    static void Note(string s)
    {
        try { File.AppendAllText(_cmdPath + ".log", DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\\r\\n"); }
        catch { }
    }
}
`;

  return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
${csharp}
'@
[MirrorWinAgent]::Run(${opts.targetPid}, ${opts.ownerPid}, ${psQuote(opts.cmdPath)})
`;
}

/** 把一行状态解析成 MirrorWinState；解析不了返回 null */
function parseState(line: string): MirrorWinState | null {
  // S|hwnd|vis|min|pin|L|T|R|B
  const p = line.split('|');
  if (p.length < 9 || p[0] !== 'S') return null;
  const n = p.slice(1).map((v) => parseInt(v, 10));
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [, vis, min, pin, L, T, R, B] = n;
  return {
    hwnd: n[0],
    visible: !!vis,
    minimized: !!min,
    pinned: !!pin,
    rect: { x: L, y: T, width: Math.max(0, R - L), height: Math.max(0, B - T) },
  };
}

export function onMirrorWinState(cb: StateListener): () => void {
  listeners.add(cb);
  if (lastState) cb(lastState);
  return () => listeners.delete(cb);
}

export function getMirrorWinState(): MirrorWinState | null {
  return lastState;
}

/** 代理是否已经起来（没起来时 pin/rect 命令一律当失败处理，别静默） */
export function isMirrorWinReady(): boolean {
  return !!current;
}

/**
 * 给某个 scrcpy 进程（pid）装代理。
 * 幂等：已经在盯同一个 pid 就什么都不做。
 */
export function startMirrorWin(pid: number): void {
  if (process.platform !== 'win32') return;
  if (!pid) return;
  if (current?.targetPid === pid) return;

  stopMirrorWin();

  const stamp = `${process.pid}-${pid}`;
  const scriptPath = join(tmpdir(), `adb-assistant-mirror-win-${stamp}.ps1`);
  const cmdPath = join(tmpdir(), `adb-assistant-mirror-win-${stamp}.cmd`);

  try {
    // 🔴 必须带 BOM：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 读，
    //    内联的临时目录路径若含中文用户名会被解成乱码。
    writeFileSync(
      scriptPath,
      '\uFEFF' +
        psScript({ targetPid: pid, ownerPid: process.pid, cmdPath }),
      'utf8',
    );
    // 预置一个空命令文件：代理要读 mtime / 内容，文件不存在会一直 catch
    writeFileSync(cmdPath, 'NOOP', 'utf8');
  } catch (e) {
    log('warn', '投屏', `功能栏代理脚本写入失败：${(e as Error).message}`);
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
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: false },
    );
  } catch (e) {
    log('warn', '投屏', `功能栏代理启动失败：${(e as Error).message}`);
    return;
  }

  const handle = { child, targetPid: pid, scriptPath, cmdPath, seq: 0 };
  current = handle;

  // 按行收状态；scrcpy 的 stdout 关掉了，这里只有我们自己的协议行
  let buf = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    buf += d;
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf('\n');
      if (!line) continue;
      if (line.startsWith('X|')) {
        log('warn', '投屏', `功能栏代理未识别的命令：${line.slice(2)}`);
        continue;
      }
      const s = parseState(line);
      if (!s) continue;
      lastState = s;
      for (const cb of listeners) {
        try {
          cb(s);
        } catch {
          /* 监听方自己出错不该影响代理读取 */
        }
      }
    }
  });

  child.on('error', (err) => {
    log('warn', '投屏', `功能栏代理不可用：${err.message}`);
    if (current === handle) current = null;
  });

  child.on('close', (code) => {
    if (current === handle) current = null;
    lastState = null;
    if (code !== 0 && code !== null) {
      log('warn', '投屏', `功能栏代理已退出（exit ${code}）`);
    }
  });
}

export function stopMirrorWin(): void {
  const h = current;
  if (!h) return;
  current = null;
  lastState = null;
  try {
    h.child.kill();
  } catch {
    /* ignore */
  }
  // 临时文件用完即弃（内容含本次 pid）；刚 kill 时可能还占着，800ms 后补一刀
  for (const p of [h.scriptPath, h.cmdPath]) {
    if (!tryUnlink(p)) {
      const t = setTimeout(() => tryUnlink(p), 800);
      t.unref?.();
    }
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

/** 写一条命令给代理（内容带序号，保证「同一条命令连发两次」也会被认成新命令） */
function send(verb: string, args: number[] = []): boolean {
  const h = current;
  if (!h) return false;
  h.seq += 1;
  const body = [verb, ...args.map((v) => Math.round(v))].join(' ');
  try {
    writeFileSync(h.cmdPath, `${body}\n#${h.seq}`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function pinMirrorWin(rect: MirrorWinRect): boolean {
  return send('PIN', [rect.x, rect.y, rect.width, rect.height]);
}

/**
 * 就地钉住：用窗口**此刻**的矩形（不按 Node 那边缓存的坐标挪）。
 * 用户点 pin 就该一动不动 —— 缓存的 lastRect 可能落后一帧（30ms 上报），
 * 拿它去 SetWindowPos 就等于把窗口往回拽一下，看起来就是「点 pin 抖一下」。
 */
export function pinMirrorWinHere(): boolean {
  return send('PINHERE');
}

export function unpinMirrorWin(): boolean {
  return send('UNPIN');
}

export function moveMirrorWin(rect: MirrorWinRect): boolean {
  return send('RECT', [rect.x, rect.y, rect.width, rect.height]);
}

export function lockMirrorWin(rect: MirrorWinRect): boolean {
  return send('LOCK', [rect.x, rect.y, rect.width, rect.height]);
}

/** 让代理立刻吐一次状态（窗口刚建好、还没到下一个 tick 时用） */
export function queryMirrorWin(): void {
  send('QUERY');
}

/** 调试用：看看命令文件还在不在（回归脚本会读） */
export function mirrorWinCmdPath(): string | null {
  if (!current) return null;
  try {
    readFileSync(current.cmdPath);
    return current.cmdPath;
  } catch {
    return null;
  }
}
