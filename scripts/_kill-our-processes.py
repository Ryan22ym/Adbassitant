# -*- coding: utf-8 -*-
"""清理本项目残留进程：ADB桌面助手.exe（含 portable 临时解压实例）+ resources\\bin\\scrcpy.exe。

⚠️ 为什么不能按映像名无差别杀：
  - `electron.exe` —— 本机跑着 WorkBuddy 自己（也是 Electron），按名杀会干掉宿主
  - `scrcpy.exe`  —— 用户机器上可能同时装着 QtScrcpy，进程名一模一样，
                     必须用完整路径里的 `\\resources\\bin\\` 段精确匹配
ADB桌面助手.exe 是本项目专属，可以按名杀。
"""
import ctypes
import os
import subprocess

K32 = ctypes.WinDLL('kernel32', use_last_error=True)


def pid_info():
    """[(pid, exe), ...]"""
    r = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'],
                       capture_output=True, text=True, encoding='gbk', errors='replace')
    out = []
    for line in (r.stdout or '').splitlines():
        if not line.startswith('"'):
            continue
        parts = line.split('","')
        try:
            pid, name = int(parts[1]), parts[0].strip('"')
        except (IndexError, ValueError):
            continue
        out.append((pid, name, exe_path(pid)))
    return out


def exe_path(pid):
    h = K32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(32768)
        n = ctypes.c_uint(32768)
        return buf.value if K32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)) else ''
    finally:
        K32.CloseHandle(h)


def force_kill(pid):
    """taskkill 会说「没有此任务的实例在运行」，直接走内核 API 才行。"""
    h = K32.OpenProcess(0x0001, False, pid)   # PROCESS_TERMINATE
    if not h:
        return False
    try:
        return bool(K32.TerminateProcess(h, 1))
    finally:
        K32.CloseHandle(h)


def target(info):
    pid, name, exe = info
    low_name, low_exe = name.lower(), (exe or '').lower()
    if low_name == 'adb桌面助手.exe':
        return '本项目应用'
    if low_name == 'scrcpy.exe' and '\\resources\\bin\\' in low_exe:
        return '本项目 scrcpy'
    return None


def main():
    procs = pid_info()
    hits = [(i, target(i)) for i in procs]
    hits = [(i, t) for i, t in hits if t]
    if not hits:
        print('无本项目残留进程')
        return
    for (pid, name, exe), why in hits:
        ok = force_kill(pid)
        print('%-6s pid=%-6d %-20s %s' % ('ok' if ok else 'FAIL', pid, name, exe[:90]))
    print()
    rest = [(i, target(i)) for i in pid_info()]
    rest = [(i, t) for i, t in rest if t]
    print('清理后仍残留：%s' % ([i[0] for i, _ in rest] or '无'))


if __name__ == '__main__':
    main()
