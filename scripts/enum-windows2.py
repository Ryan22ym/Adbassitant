# -*- coding: utf-8 -*-
"""枚举窗口（按进程可执行文件路径精确过滤），输出 JSON。

区别于旧版 enum-windows.py：
  - 按「完整路径结尾」匹配，不会把 QtScrcpy.exe 误当成我们的 scrcpy.exe
  - 回调签名用 ctypes.c_int + c_void_p，避免 64 位下 BOOL/HWND 宽度不一致

用法:
  python enum-windows2.py                    # 默认匹配 我们的 scrcpy.exe
  python enum-windows2.py --exe QtScrcpy.exe
  ENUM_ALL=1 python enum-windows2.py         # 含不可见窗口
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys

u32 = ctypes.WinDLL('user32', use_last_error=True)
k32 = ctypes.WinDLL('kernel32', use_last_error=True)
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def proc_path(pid):
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(512)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return ''
    finally:
        k32.CloseHandle(h)


def main():
    # 解析参数
    exe_suffix = '\\resources\\bin\\scrcpy.exe'
    if '--exe' in sys.argv:
        exe_suffix = '\\' + sys.argv[sys.argv.index('--exe') + 1].lower()
    only_visible = os.environ.get('ENUM_ALL') != '1'

    out = []

    # 回调：返回 int，参数用 c_void_p（避免 64 位 HWND 截断）
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)

    def cb(hwnd, lparam):
        visible = bool(u32.IsWindowVisible(hwnd))
        if only_visible and not visible:
            return 1
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        path = proc_path(pid.value)
        if not path.lower().endswith(exe_suffix):
            return 1

        title = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(hwnd, title, 512)
        cls = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(hwnd, cls, 256)
        rect = wt.RECT()
        u32.GetWindowRect(hwnd, ctypes.byref(rect))

        out.append({
            'pid': pid.value,
            'hwnd': hex(hwnd),
            'exe': os.path.basename(path),
            'title': title.value,
            'class': cls.value,
            'rect': [rect.left, rect.top, rect.right, rect.bottom],
            'visible': visible,
            'enabled': bool(u32.IsWindowEnabled(hwnd)),
        })
        return 1

    u32.EnumWindows(WNDENUMPROC(cb), None)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
