#!/usr/bin/env python3
"""实证：启动 scrcpy 后，读它进程环境块里的 SCRCPY_ICON_PATH。

这是「图标区分」最硬的证据 —— 不依赖 UI、不依赖时序：
  如果环境块里有 SCRCPY_ICON_PATH 且指向 scrcpy-icon.png，
  那么 scrcpy 一定用那个图标（scrcpy 源码：env 优先于 portable icon.png）。

读环境块用 NtQueryInformationProcess + ReadProcessMemory，
Python 侧走 ctypes 实现，不需要额外的 psutil 依赖。

用法:
  python verify-scrcpy-env.py                  # 自动挑第一个在线设备
  python verify-scrcpy-env.py <serial>
  python verify-scrcpy-env.py --read-env <pid> # 只读已有进程的环境块（供 e2e 调用）
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time

INSTALL_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "ADBAssistant")
SCRCPY = os.path.join(INSTALL_DIR, "resources", "bin", "scrcpy.exe")
BIN = os.path.dirname(SCRCPY)
ADB = os.path.join(BIN, "adb.exe")

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
ProcessBasicInformation = 0
STATUS_INFO_LENGTH_MISMATCH = -1073741820  # 0xC0000004

ntdll = ctypes.WinDLL("ntdll")
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class UNICODE_STRING(ctypes.Structure):
    _fields_ = [
        ("Length", wt.USHORT),
        ("MaximumLength", wt.USHORT),
        ("Buffer", ctypes.c_void_p),
    ]


class PROCESS_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Reserved1", ctypes.c_void_p),
        ("PebBaseAddress", ctypes.c_void_p),
        ("Reserved2", ctypes.c_void_p * 2),
        ("UniqueProcessId", ctypes.c_void_p),
        ("Reserved3", ctypes.c_void_p),
    ]


def _read(handle, addr, size):
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_size_t(0)
    ok = kernel32.ReadProcessMemory(
        wt.HANDLE(handle), ctypes.c_void_p(addr), buf, ctypes.c_size_t(size), ctypes.byref(n)
    )
    if not ok:
        return None
    return buf.raw[: n.value]


def read_env(pid):
    """返回目标进程环境块的 dict（不区分大小写）。失败返回 None。"""
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return None
    try:
        pbi = PROCESS_BASIC_INFORMATION()
        ret = ctypes.c_ulong(0)
        st = ntdll.NtQueryInformationProcess(
            wt.HANDLE(h),
            ProcessBasicInformation,
            ctypes.byref(pbi),
            ctypes.sizeof(pbi),
            ctypes.byref(ret),
        )
        if st != 0:
            return None

        # PEB.ProcessParameters @ offset 0x20 (x64)
        pp_ptr_raw = _read(h, pbi.PebBaseAddress + 0x20, 8)
        if not pp_ptr_raw:
            return None
        pp_ptr = int.from_bytes(pp_ptr_raw, "little")

        # RTL_USER_PROCESS_PARAMETERS.Environment @ offset 0x80 (x64)
        env_ptr_raw = _read(h, pp_ptr + 0x80, 8)
        if not env_ptr_raw:
            return None
        env_ptr = int.from_bytes(env_ptr_raw, "little")
        if not env_ptr:
            return None

        # 环境块大小未知，先读一大块
        blob = _read(h, env_ptr, 128 * 1024)
        if not blob:
            return None
        text = blob.decode("utf-16-le", errors="ignore")
        out = {}
        for item in text.split("\x00"):
            if "=" in item:
                k, _, v = item.partition("=")
                if k:
                    out[k.upper()] = v
        return out
    finally:
        kernel32.CloseHandle(wt.HANDLE(h))


def adb(*args):
    return subprocess.run(
        [ADB, *args], capture_output=True, text=True, timeout=30,
        encoding="utf-8", errors="replace",
    ).stdout.strip()


def pick_serial(prefer=None):
    if prefer:
        return prefer
    out = adb("devices")
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            return parts[0]
    return None


def main():
    # 子命令：只读某个 pid 的环境块并打印 SCRCPY_ICON_PATH（供 e2e 脚本调用）
    if len(sys.argv) >= 2 and sys.argv[1] == "--read-env":
        if len(sys.argv) < 3:
            print("用法: verify-scrcpy-env.py --read-env <pid>", file=sys.stderr)
            return 2
        got = read_env(int(sys.argv[2]))
        if got is None:
            return 1
        val = got.get("SCRCPY_ICON_PATH")
        if val:
            print(f"SCRCPY_ICON_PATH={val}")
            return 0
        return 1

    serial = sys.argv[1] if len(sys.argv) > 1 else pick_serial()
    print(f"=== 验证 scrcpy 环境块 SCRCPY_ICON_PATH ===")
    print(f"scrcpy : {SCRCPY}")
    print(f"设备   : {serial}")
    lock = os.path.join(BIN, "scrcpy-server")
    if not os.path.exists(SCRCPY):
        print("✗ 找不到安装版 scrcpy.exe")
        return 2
    if not serial:
        print("✗ 无在线设备")
        return 2

    icon = os.path.join(BIN, "scrcpy-icon.png")
    env = dict(os.environ)
    env["ADB"] = ADB
    if os.path.exists(icon):
        env["SCRCPY_ICON_PATH"] = icon
        print(f"注入   : SCRCPY_ICON_PATH={icon}")
    else:
        print("⚠ bin/scrcpy-icon.png 不存在，未注入")

    p = subprocess.Popen(
        [SCRCPY, "--no-audio", "--window-title=ENVPROBE", "-s", serial],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=os.path.dirname(BIN),
    )
    print(f"启动   : pid={p.pid}")
    time.sleep(4)

    got = read_env(p.pid)
    ok = False
    if got is None:
        print("✗ 读环境块失败（权限不足或进程已退出）")
    else:
        val = got.get("SCRCPY_ICON_PATH")
        if val:
            print(f"✓ 环境块 SCRCPY_ICON_PATH = {val}")
            ok = os.path.normcase(val) == os.path.normcase(icon)
            print(f"  与期望一致: {ok}")
        else:
            print("✗ 环境块里没有 SCRCPY_ICON_PATH")
            print(f"  含 SCRCPY* 的键: {[k for k in got if 'SCRCPY' in k]}")
        print(f"  ADB={got.get('ADB')}")

    try:
        p.terminate()
        p.wait(timeout=8)
    except Exception:  # noqa: BLE001
        try:
            p.kill()
        except Exception:  # noqa: BLE001
            pass
    print("\n结果:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
