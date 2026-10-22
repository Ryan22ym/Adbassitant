"""安装版验收：窗口大小记录 + 重启恢复（v1.1.16）。

为什么必须单独跑一遍（脚本级回归 check-window-state 盖不住）：
  check-window-state 验的是 services/window-state.ts 的**单元行为** + 设置页 UI，
  它自己建的窗口是普通 frame 窗口、也不经过 main.ts 的 createWindow。
  而「拖窗口 → 关程序 → 再打开 → 尺寸还在」这条链路依赖：
    · createWindow 把记录展开进 BrowserWindow 构造参数（不是建完再 setBounds）
    · 真实 exe 的 titleBarStyle:'hidden' 形态下 getNormalBounds 的行为
    · settings.json 在 userData 里、不被安装/更新覆盖
  任何一环错了，单元测试全绿、用户依然看到「每次都弹回默认大小」。

做法（全程真实 exe，不注入、不打桩）：
  1. 启动安装版 → 读窗口物理尺寸，按 DPI 换算成 DIP
  2. SetWindowPos 把它摆到 1100×700 @ (150,120)（等效于用户拖窗口）
  3. 等 1.5s（debounce 400ms）→ 读 userData/settings.json 的 windowBounds
  4. WM_CLOSE 正常退出（走 close 事件 → 抢存一次）
  5. 再启动 → 读窗口 DIP 尺寸与位置：应≈ 1100×700 @ (150,120)
  6. 收尾：关掉进程

跑法：
  python scripts/_verify-winstate-installed.py
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

TARGET = os.path.join(os.environ['LOCALAPPDATA'], 'Programs', 'ADBAssistant', 'ADB桌面助手.exe')
USERDATA = os.path.join(os.environ['APPDATA'], 'adb-assistant')
SETTINGS = os.path.join(USERDATA, 'settings.json')
TITLE = 'ADB 桌面助手'

# 目标尺寸（DIP）—— 与出厂 1280×860 明显不同，一眼能看出是"恢复的"还是"默认的"
WANT_W, WANT_H, WANT_X, WANT_Y = 1100, 700, 150, 120

# 尺寸判据的容差（DIP）。为什么不是 1~2（2026-10-22 真机实测）：
#   Electron 的 getNormalBounds() 比 Win32 GetWindowRect() **大一圈**（实测 +6 ~ +7 DIP），
#   因为前者算上了 DWM 给无边框窗口的不可见 resize 边框 / 阴影，后者只给可见矩形。
#   于是从 Win32 视角看：拖到 1100 → Electron 记成 1106 → 重启 setBounds(1106) → Win32 1108。
#
#   这不是 bug，也不该"修"：记录与恢复用的是**同一套 Electron 坐标系**，
#   用户拖出来的就是 Electron 认的那个尺寸，恢复也按它开（位置分毫不差）。
#   硬要对齐 Win32 视角，就得反过来记录 contentBounds 再猜边框厚度，
#   换显示器 / 缩放档位全错。8px 无人能感知，不值得。
#
#   真正的红线是**不漂移**（第 3 次启动那一组）：记录值一旦被边框误差写歪，
#   每次启动窗口就长一点 —— 那才是用户能察觉、且查不出原因的问题。
SIZE_TOL = 8
DRIFT_TOL = 2

u32 = ctypes.windll.user32
u32.SetProcessDPIAware()

ROWS = []


def ok(cond, name, detail=''):
    ROWS.append(f"{'PASS' if cond else 'FAIL'}  {name}{'   ' + str(detail) if detail else ''}")
    print(ROWS[-1])


def scale_factor():
    """系统 DPI / 96 —— 本机 1.25，GetWindowRect 给的是物理像素"""
    hdc = u32.GetDC(0)
    dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX
    u32.ReleaseDC(0, hdc)
    return dpi / 96.0


SCALE = scale_factor()


def find_window(timeout=30.0):
    """轮询找标题含「ADB 桌面助手」的可见顶层窗口"""
    t0 = time.time()

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(hwnd, _l):
        if not u32.IsWindowVisible(hwnd):
            return True
        n = u32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u32.GetWindowTextW(hwnd, buf, n + 1)
        if TITLE in buf.value:
            found.append(hwnd)
            return False
        return True

    while time.time() - t0 < timeout:
        found = []
        u32.EnumWindows(cb, 0)
        if found:
            return found[0]
        time.sleep(0.3)
    return None


def rect_of(hwnd):
    r = wt.RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    # 物理像素 → DIP
    return (
        round((r.right - r.left) / SCALE),
        round((r.bottom - r.top) / SCALE),
        round(r.left / SCALE),
        round(r.top / SCALE),
    )


def move(hwnd, x, y, w, h):
    SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010
    u32.SetWindowPos(hwnd, 0, int(x * SCALE), int(y * SCALE), int(w * SCALE), int(h * SCALE),
                     SWP_NOZORDER | SWP_NOACTIVATE)


def launch():
    env = dict(os.environ)
    # 🔴 从 WorkBuddy shell 启 exe 必须清掉这个：宿主会把它设成 1，
    #    exe 会退化成 node 模式（打印 bad option 或静默退出）
    env.pop('ELECTRON_RUN_AS_NODE', None)
    p = subprocess.Popen([TARGET], cwd=os.path.dirname(TARGET), env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    hwnd = find_window()
    return p, hwnd


def close(p, hwnd):
    WM_CLOSE = 0x0010
    if hwnd:
        u32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    time.sleep(1.0)


def read_bounds():
    try:
        with open(SETTINGS, encoding='utf-8') as f:
            return json.load(f).get('windowBounds')
    except Exception:
        return None


def main():
    print(f'scale = {SCALE}')
    print(f'exe   = {TARGET}')
    ok(os.path.exists(TARGET), '安装版存在', TARGET)

    # 确保没有残留进程（单实例锁会让第二个实例直接退出）
    subprocess.run(['taskkill', '/F', '/IM', 'ADB桌面助手.exe'], capture_output=True)
    time.sleep(1.0)

    # ---------------- 第一次启动 ----------------
    print('\n--- 第 1 次启动 ---')
    p, hwnd = launch()
    ok(bool(hwnd), '窗口出现', hwnd)
    if not hwnd:
        finish()

    before = rect_of(hwnd)
    print(f'启动尺寸 {before[0]}×{before[1]} @ {before[2]},{before[3]}（DIP）')

    move(hwnd, WANT_X, WANT_Y, WANT_W, WANT_H)
    time.sleep(1.6)  # debounce 400ms + 写盘
    after = rect_of(hwnd)
    ok(abs(after[0] - WANT_W) <= 2 and abs(after[1] - WANT_H) <= 2,
       f'窗口已摆到 {WANT_W}×{WANT_H}', f'{after[0]}×{after[1]}')

    saved = read_bounds()
    print(f'settings.json windowBounds = {saved}')
    ok(bool(saved), '落盘：settings.json 里有 windowBounds')
    if saved:
        ok(abs(saved['width'] - WANT_W) <= SIZE_TOL and abs(saved['height'] - WANT_H) <= SIZE_TOL,
           f'落盘尺寸 ≈ 拖动后的窗口（±{SIZE_TOL}px，Electron/Win32 坐标系差）',
           f"{saved['width']}×{saved['height']}")
        ok(abs(saved['x'] - WANT_X) <= 4 and abs(saved['y'] - WANT_Y) <= 4,
           '落盘位置一致', f"x={saved['x']} y={saved['y']}")
        ok(saved.get('maximized') is False, '未最大化状态一起记下')

    close(p, hwnd)

    # ---------------- 第二次启动 ----------------
    print('\n--- 第 2 次启动（验证恢复） ---')
    p2, hwnd2 = launch()
    ok(bool(hwnd2), '窗口再次出现', hwnd2)
    if not hwnd2:
        finish()
    time.sleep(1.2)  # ready-to-show 之后稳定一下（最大化/还原都已落定）
    again = rect_of(hwnd2)
    print(f'重启后尺寸 {again[0]}×{again[1]} @ {again[2]},{again[3]}（DIP）')

    ok(abs(again[0] - WANT_W) <= SIZE_TOL + 2 and abs(again[1] - WANT_H) <= SIZE_TOL + 2,
       '🔴 重启后尺寸 ≈ 上次拖的大小（不是 1280×860）', f'{again[0]}×{again[1]}')
    ok(abs(again[2] - WANT_X) <= 4 and abs(again[3] - WANT_Y) <= 4,
       '🔴 重启后位置 = 上次的位置（分毫不差）', f'{again[2]},{again[3]}')
    # 与出厂尺寸的区分度：证明它真的用了记录，而不是碰巧落在容差里
    ok(abs(again[0] - 1280) > 50 and abs(again[1] - 860) > 50,
       '确实不同于出厂 1280×860（用的是记录值）', f'{again[0]}×{again[1]}')

    close(p2, hwnd2)

    # ---------------- 第三次启动（验证不漂移） ----------------
    # 🔴 这一步是本次实测发现的真 bug 的回归项：窗口管理器读回会带边框误差，
    #    如果记录被这个误差写歪，每次启动窗口就长一点。连开两次必须一模一样。
    print('\n--- 第 3 次启动（验证不漂移） ---')
    saved3 = read_bounds()
    p3, hwnd3 = launch()
    ok(bool(hwnd3), '窗口第三次出现', hwnd3)
    if not hwnd3:
        finish()
    time.sleep(1.2)
    third = rect_of(hwnd3)
    print(f'第三次尺寸 {third[0]}×{third[1]} @ {third[2]},{third[3]}（DIP）')
    ok(
        abs(third[0] - again[0]) <= 1 and abs(third[1] - again[1]) <= 1,
        '🔴 连开两次尺寸不变（记录不被边框误差带跑、不会越开越长）',
        f'{again[0]}×{again[1]} → {third[0]}×{third[1]}',
    )
    ok(
        saved3 == saved,
        '记录值全程一字未变（锚在用户设定的那个数上）',
        f'{saved} / {saved3}',
    )

    close(p3, hwnd3)
    finish()


def finish():
    print('\n=== 安装版窗口大小验收 ===')
    for r in ROWS:
        print(r)
    print('WINSTATE INSTALLED DONE')
    sys.exit(0 if not any(r.startswith('FAIL') for r in ROWS) else 1)


if __name__ == '__main__':
    main()
