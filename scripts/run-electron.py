#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""受控运行 Electron 测试脚本（避开父 shell 被挂住 + 不等无效超时）。

为什么需要它
------------------------------------------------------------
`electron.exe scripts/xxx.cjs` 在本机有下面这个坑：

  * 测试脚本内部调 `app.exit(code)` 后，**主进程句柄不释放**，
    进程一直挂在进程表里（`taskkill` 报「没有此任务的实例在运行」）；
  * 父 shell（Git Bash / cmd）会一直等 stdout 管道 EOF，
    于是表现为「脚本早就把结果写进日志了，但命令卡死不动」；
  * 中途 Ctrl-C / 杀 shell 又会留下 `electron.exe` 僵尸进程，
    它们占着默认 userData 目录，让**后续**的 Electron 脚本启动即卡。

这里做四件事：

  1. 子进程 stdout/stderr **重定向到文件**，不继承父 shell 的管道 —— 父进程能干净退出；
  2. 默认给**独立 `--user-data-dir`**（临时目录），避免与僵尸进程抢 profile；
  3. 清掉 `ELECTRON_RUN_AS_NODE`（宿主会注入，不清 Electron 会退化成纯 Node）；
  4. `--watch <文件>`：脚本干活的标志是**它的日志文件有了变化**。
     配合 `--until <正则>` 可以等到日志里出现「完成标记」再收工；
     一旦命中就**主动结束子进程**，不再傻等超时；
     同时把新增的日志打印出来，并据此判定 PASS / FAIL。
     注意判据是「体积变化」而非「体积变大」：不少脚本开头会
     `fs.writeFileSync(LOG, '')` 清空日志，只判变大就永远等不到，白等到超时（返回 124）。

用法
------------------------------------------------------------
    python scripts/run-electron.py scripts/check-nav.cjs \\
        --watch ui-shots/_navcheck.log --until "渲染层无错误|=== ERRORS ==="
    python scripts/run-electron.py scripts/e2e-v1-device.cjs \\
        --watch ui-shots/_device.log --until "\\d+/\\d+ 通过"

要给**脚本自己**传开关（如 `--installed`），直接写在后面即可，
本工具只认自己声明过的开关，其余原样透传：

    python scripts/run-electron.py scripts/check-aab-ui.cjs \\
        --watch ui-shots/_aab-ui.log --until "AAB UI CHECK DONE" -- --installed

（`--` 可省，写上更清楚。⚠️ 早期版本给脚本参数用了 `nargs=REMAINDER`，
那会把 `--watch`/`--until`/`--timeout` 一起吞掉，导致「干等到 240s 超时强杀、
而日志其实早就写完了」——现已改用 `parse_known_args`，不再有这个问题。）

参数
------------------------------------------------------------
    --watch FILE     可重复。监视这些文件在本次启动后的新写入。
    --until REGEX    可重复。新增内容命中任一正则才算完成（不给则「有新写入」即完成）。
    --settle SEC     判定完成后，再等几秒让脚本把尾巴写完（默认 1.5）。
    --timeout SEC    兜底超时（默认 240），超时强杀并返回 124。
    --user-data DIR  自定义 user-data-dir。
    --out FILE       子进程 stdout/stderr 落盘路径。
    --raw            不做 PASS/FAIL 判定，只看子进程退出码。

退出码
------------------------------------------------------------
    0 / 1   依据 --watch 文件里新增内容是否含 FAIL / FATAL / ERROR
    124     超时强杀
    2       找不到 electron
    3       脚本不存在
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

BAD = re.compile(r'\b(FAIL|FATAL|ERROR|ERRORS)\b')

# 🔴 本机控制台（PowerShell / cmd，代码页 936）打印不了 emoji 和部分中文，
#    print() 会抛 UnicodeEncodeError —— 表现是「断言全 PASS、退出码却是 1」，
#    而且异常信息还被埋在输出里，非常容易误判成功能失败。这里强制 UTF-8 兜底。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def _snapshot(paths):
    """文件指纹 = (体积, mtime)。

    ⚠️ 只记体积会漏掉「被重写成同样长度」——见 _collect 的注释。
    """
    st = {}
    for p in paths:
        try:
            s = os.stat(p)
            st[p] = (s.st_size, s.st_mtime)
        except OSError:
            st[p] = None
    return st


def _rel(path):
    """相对项目根的展示名。跨盘符（C: vs D:）时 relpath 会抛 ValueError，退化为绝对路径。"""
    try:
        return os.path.relpath(path, ROOT)
    except ValueError:
        return path


def _collect(paths, before):
    """取 --watch 文件在启动后新增的内容。"""
    chunks = []
    for p in paths:
        try:
            size = os.path.getsize(p)
        except OSError:
            continue
        b = before.get(p)
        start = b[0] if b else -1
        # start<0：启动前不存在；size<=start：期间被清空重建（很多脚本开头会
        # `fs.writeFileSync(LOG,'')`）。
        # 🔴 判据必须是 `<=` 而不是 `<`：两次运行的日志**长度完全相同**时，
        #    用 `<` 会被判成「日志没有新内容」，于是一个 35/35 全 PASS 的运行
        #    返回 1（实测踩过，白查了半天）。
        if start < 0 or size <= start:
            start = 0
        if size <= 0:
            continue
        with open(p, 'r', encoding='utf-8', errors='replace') as fh:
            fh.seek(start)
            chunks.append('----- %s -----\n%s' % (_rel(p), fh.read()))
    return '\n'.join(chunks)


def _matches(paths, before, patterns):
    """新增内容是否命中任一完成标记。"""
    text = _collect(paths, before)
    return any(re.search(p, text) for p in patterns)


# ---------------------------------------------------------------------
# PrintWindow 抓窗口（给 --grab 用）
# ---------------------------------------------------------------------
def _grab_window(pid: int, out_png: str, want_w: int = 0, want_h: int = 0) -> str:
    """
    用 PrintWindow(PW_RENDERFULLCONTENT) 抓「该 pid 的顶层可见窗口」的合成像素。

    🔴 为什么不是 BitBlt / desktopCapturer：
        BitBlt 抓的是**屏幕**，被遮挡/后台就抓不到，也拿不到 Acrylic 的合成结果；
        desktopCapturer 依赖 DXGI Desktop Duplication，本机它会间歇性失效
        （`DxgiDuplicatorController failed to capture desktop`），
        返回一张过期空白帧 —— 表现为「截出来是纯色」，极易误判成功能坏了。
        PrintWindow + PW_RENDERFULLCONTENT 走窗口自己的 WM_PRINT，
        能拿到 DWM 合成后的内容（含系统 Acrylic 模糊），且不受遮挡/复制失效影响。
    """
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    # --- 枚举该 pid 的顶层窗口 ---
    # 🔴 选窗口的判据不能是「面积最大」：预览脚本里还有一张**铺满屏幕的假壁纸**
    #    底层窗口，它面积最大，会被选中 —— 抓出来是一张未模糊的原图，
    #    看起来像「玻璃完全没生效」。
    #     判据改成：优先取**尺寸最接近用户给的期望值**的那个；
    #     没给期望值就取「面积最小但 > 200x200」的那个（玻璃窗总比满屏壁纸小）。
    class RECT(ctypes.Structure):
        _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long),
                    ('right', ctypes.c_long), ('bottom', ctypes.c_long)]

    cands = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        wpid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value != pid:
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        r = RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w > 200 and h > 200:
            cands.append({'hwnd': hwnd, 'w': w, 'h': h,
                          'x': r.left, 'y': r.top, 'area': w * h})
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    if not cands:
        return 'GRAB FAIL: 没找到 pid=%d 的可见窗口' % pid

    if want_w and want_h:
        # 取尺寸最接近期望的（窗口边框会让实际值差几个像素，所以比「最接近」而非「相等」）
        cands.sort(key=lambda c: abs(c['w'] - want_w) + abs(c['h'] - want_h))
    else:
        cands.sort(key=lambda c: c['area'])   # 取最小的那个大窗口 = 玻璃窗
    best = cands[0]
    hwnd, rw, rh = best['hwnd'], best['w'], best['h']
    wx, wy = best['x'], best['y']
    PW_RENDERFULLCONTENT = 0x00000002

    # ---------------------------------------------------------------
    # 🔴 抓图方式必须用 BitBlt 抓「屏幕对应区域」，不能用 PrintWindow。
    #
    # 实测（2026-10-13）：
    #   · PrintWindow(PW_RENDERFULLCONTENT) 对**透明窗口**返回**全黑** ——
    #     它走的是窗口自己的 WM_PRINT，而透明窗口没有可绘制的背景像素，
    #     系统 Acrylic 的模糊结果也不在这条路径上。
    #   · BitBlt 从屏幕 DC 取像素，拿到的是 **DWM 合成后的最终画面**，
    #     包含 Acrylic 模糊 + 桌面透出 —— 这才是肉眼看到的东西。
    #
    # 前提：抓的瞬间窗口必须在最前且未被遮挡（预览脚本里它就在最上层）。
    # 取舍：BitBlt 需要窗口可见；PrintWindow 不需要但抓不到玻璃。玻璃主题只能 BitBlt。
    # ---------------------------------------------------------------
    SRCCOPY = 0x00CC0020
    hdc = user32.GetDC(0)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, rw, rh)
    gdi32.SelectObject(mdc, bmp)
    ok = gdi32.BitBlt(mdc, 0, 0, rw, rh, hdc, wx, wy, SRCCOPY)

    class BMIH(ctypes.Structure):
        _fields_ = [('biSize', wintypes.DWORD), ('biWidth', ctypes.c_long),
                    ('biHeight', ctypes.c_long), ('biPlanes', wintypes.WORD),
                    ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                    ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', ctypes.c_long),
                    ('biYPelsPerMeter', ctypes.c_long), ('biClrUsed', wintypes.DWORD),
                    ('biClrImportant', wintypes.DWORD)]

    bi = BMIH()
    bi.biSize = ctypes.sizeof(BMIH)
    bi.biWidth = rw
    bi.biHeight = -rh          # 负数 = top-down，省得后面翻行
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0       # BI_RGB

    buf = ctypes.create_string_buffer(rw * rh * 4)
    got = gdi32.GetDIBits(mdc, bmp, 0, rh, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(0, hdc)

    if not got:
        return 'GRAB FAIL: GetDIBits 返回 0'

    # BGRA -> RGBA（PIL 需要 RGBA；不引入 numpy，纯字节重排）
    raw = bytearray(buf.raw)
    raw[0::4], raw[2::4] = raw[2::4], raw[0::4]   # 交换 B/R
    raw[3::4] = b'\xff' * (rw * rh)               # alpha 全不透明

    try:
        from PIL import Image
        img = Image.frombytes('RGBA', (rw, rh), bytes(raw))
        img.convert('RGB').save(out_png)
    except ImportError:
        # 没 Pillow 就落 BMP（自己写头，Windows 下所有看图器都能开）
        import struct
        hdr = b'BM' + struct.pack('<IHHI', 14 + 40 + len(raw), 0, 0, 54)
        info = struct.pack('<IiiHHIIiiII', 40, rw, rh, 1, 32, 0, len(raw), 0, 0, 0, 0)
        # BMP 是 bottom-up，得翻行
        rows = [raw[y * rw * 4:(y + 1) * rw * 4] for y in range(rh)][::-1]
        open(out_png, 'wb').write(hdr + info + b''.join(rows))

    return 'GRAB OK hwnd=%d pid=%d %dx%d at(%d,%d) bitblt=%s -> %s' % (
        hwnd, pid, rw, rh, wx, wy, ok, out_png)


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('script', help='要运行的 Electron 脚本（相对项目根或绝对路径）')
    ap.add_argument('--watch', action='append', default=[],
                    help='日志文件（可重复）：脚本会往这里写结果')
    ap.add_argument('--until', action='append', default=[],
                    help='完成标记正则（可重复）：新增内容命中才算完成')
    ap.add_argument('--settle', type=float, default=1.5, help='判定完成后补等的秒数，默认 1.5')
    ap.add_argument('--timeout', type=float, default=240.0, help='兜底超时秒数，默认 240')
    ap.add_argument('--user-data', default=None, help='自定义 user-data-dir')
    ap.add_argument('--out', default=None, help='子进程 stdout/stderr 落盘路径')
    ap.add_argument('--raw', action='store_true', help='不做 PASS/FAIL 判定')
    # ---------------------------------------------------------------
    # --grab：在执行 Electron 脚本期间，由**本进程**去抓那个窗口。
    #
    # 🔴 为什么不由 Electron 脚本自己抓：
    #    在 Electron 主进程里 spawn 第二个 python 会 EBUSY（本机实测），
    #    而 desktopCapturer 又会因 DXGI 失效拿到空白帧。
    #    本进程是「旁观者」，PID 拿到手就能用 PrintWindow 抓窗口自身合成像素，
    #    不受 DXGI 影响，也不需要往目标进程里塞代码。
    # 取值：`<pid文件>:<输出图片>` —— 脚本退出前把 pid 写进 pid 文件。
    # ---------------------------------------------------------------
    ap.add_argument('--grab', default=None,
                    help='抓窗口：--grab=<pid文件>:<输出png>（脚本需先写出自己的 pid）')
    ap.add_argument('--grab-size', default=None,
                    help='期望的窗口尺寸 WxH（用来在多个窗口里挑玻璃窗，避免抓到满屏壁纸）')
    ap.add_argument('--grab-delay', type=float, default=1.0,
                    help='读到 pid 后再等几秒让窗口稳定，默认 1.0')

    # ★ 这里**绝对不要**给脚本参数声明 `nargs=argparse.REMAINDER`。
    #   REMAINDER 会把命令里它之后的**一切**都收走，包括本工具自己的
    #   --watch / --until / --timeout —— 于是习惯写法
    #       run-electron.py script.cjs --watch X --until Y --timeout 900
    #   一个开关都传不进来，表现为：
    #       「不监视日志 → 干等到默认 240s 超时强杀（exit 124）」，
    #   而脚本其实早就把结果写进日志了 —— 极像功能失败，实为参数没生效。
    #   正确做法是 parse_known_args：认识的留下，不认识的当作脚本自己的参数，
    #   于是下面两种写法都能工作：
    #       run-electron.py script.cjs --watch X --until Y --timeout 900
    #       run-electron.py script.cjs --watch X -- --installed
    args, unknown = ap.parse_known_args()

    # 不认识的、以及 `--` 之后的东西，都透传给脚本（去掉裸 `--`）
    script_args = list(unknown)
    if script_args and script_args[0] == '--':
        script_args = script_args[1:]

    script = args.script
    if not os.path.isabs(script):
        script = os.path.join(ROOT, script)
    if not os.path.isfile(script):
        sys.stderr.write('[run-electron] 脚本不存在: %s\n' % script)
        return 3
    if not os.path.isfile(ELECTRON):
        sys.stderr.write('[run-electron] 找不到 electron: %s\n' % ELECTRON)
        return 2

    out_path = args.out or os.path.join(tempfile.gettempdir(), '_run-electron.log')
    ud = args.user_data or os.path.join(tempfile.gettempdir(), '_electron-ud-%d' % os.getpid())
    watches = [w if os.path.isabs(w) else os.path.join(ROOT, w) for w in args.watch]
    before = _snapshot(watches)
    until_res = list(args.until)

    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)  # 宿主注入，不清 Electron 会退化成纯 Node

    cmd = [ELECTRON, '--user-data-dir=' + ud, script] + script_args
    print('[run-electron] %s' % ' '.join('"%s"' % c if ' ' in c else c for c in cmd))
    print('[run-electron] out -> %s' % out_path)

    t0 = time.time()
    with open(out_path, 'wb') as fh:
        proc = subprocess.Popen(cmd, cwd=ROOT, env=env,
                                stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT)

        # --grab 的解析：<pid文件>:<输出图>
        grab_pidfile = grab_out = None
        if args.grab:
            if ':' not in args.grab:
                print('[run-electron] --grab 格式应为 <pid文件>:<输出图>')
                proc.kill(); _reap(proc)
                return 2
            grab_pidfile, grab_out = args.grab.split(':', 1)
            if not os.path.isabs(grab_pidfile):
                grab_pidfile = os.path.join(ROOT, grab_pidfile)
        grabbed = False

        fired = False
        fire_at = 0.0
        while True:
            rc = proc.poll()
            if rc is not None:
                print('[run-electron] 子进程自行退出，码 = %d' % rc)
                break
            if time.time() - t0 > args.timeout:
                proc.kill()
                _reap(proc)
                print('[run-electron] 兜底超时 %.0fs，已强杀 (pid=%d)' % (args.timeout, proc.pid))
                return 124
            # 窗口一出现就立刻抓 —— 必须在子进程还活着的时候
            if grab_pidfile and not grabbed and os.path.isfile(grab_pidfile):
                try:
                    gp = int(open(grab_pidfile).read().strip())
                except Exception:
                    gp = 0
                if gp:
                    time.sleep(args.grab_delay)
                    gw = gh = 0
                    if args.grab_size and 'x' in args.grab_size:
                        try:
                            gw, gh = (int(v) for v in args.grab_size.lower().split('x'))
                        except Exception:
                            gw = gh = 0
                    print('[run-electron] %s' % _grab_window(gp, grab_out, gw, gh))
                    grabbed = True
                    # 🔴 抓完立刻延长「完成后的等待」，否则 --until 的 settle(默认1.5s)
                    #    可能在抓图之前就把子进程杀了 —— 表现为 GRAB 一行都没有，
                    #    看起来像抓图功能坏了。
                    if fired:
                        fire_at = time.time()
            if not fired and watches:
                now = _snapshot(watches)
                # 指纹是 (体积, mtime) 整体比较 —— 脚本常在一开始清空自己的日志，
                # 此时体积会**变小**，用 `>` 判断会永远等不到"变化"（白等到超时强杀）；
                # 而「重写成同样长度」又会让纯体积比较失效，所以必须带上 mtime。
                if any(now.get(p) != before.get(p) for p in watches):
                    if not until_res or _matches(watches, before, until_res):
                        fired = True
                        fire_at = time.time()
            if fired and time.time() - fire_at >= args.settle:
                # 脚本已完成（日志里出现了完成标记），但进程不会自己走 —— 主动收尾
                proc.kill()
                _reap(proc)
                print('[run-electron] 检测到日志完成标记，已结束子进程 (pid=%d, 用时 %.1fs)'
                      % (proc.pid, time.time() - t0))
                break
            time.sleep(0.3)

    text = _collect(watches, before)
    if text:
        print(text.rstrip())
    if args.raw or not watches:
        return 0 if proc.returncode == 0 else 1
    if not text:
        print('[run-electron] 日志没有新内容 —— 脚本可能没跑起来，判为失败')
        return 1
    bad = BAD.search(text)
    if bad:
        print('[run-electron] 判定为失败（命中 %s）' % bad.group(1))
        return 1
    print('[run-electron] 判定为通过')
    return 0


def _reap(proc):
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


if __name__ == '__main__':
    sys.exit(main())
