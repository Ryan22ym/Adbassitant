#!/usr/bin/env python3
"""调试：定位「我们的」scrcpy.exe 进程（完整路径精确匹配，排除 QtScrcpy）。

背景：`taskkill /IM scrcpy.exe` 和 PowerShell 的 `-like '*scrcpy.exe'`
都会误伤用户的 QtScrcpy.exe（同 image name）。必须用完整路径结尾匹配。

用法:
  python find-scrcpy-pid.py               # 打印 pid（无则 exit 1）
  python find-scrcpy-pid.py --json        # 打印 JSON 详情
  python find-scrcpy-pid.py --all         # 打印全部 scrcpy 相关进程（含 QtScrcpy）
"""
import json
import subprocess
import sys

SUFFIX = r"\resources\bin\scrcpy.exe"

_PS = (
    "Get-CimInstance Win32_Process"
    " | Where-Object { $_.ExecutablePath -ne $null }"
    " | Select-Object ProcessId,Name,ExecutablePath,CommandLine"
    " | ConvertTo-Json -Compress -Depth 3"
)


def list_procs():
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS],
            capture_output=True,
            text=True,
            timeout=30,
            encoding="utf-8",
            errors="replace",
        )
    except Exception as e:  # noqa: BLE001
        print(f"PowerShell 调用失败: {e}", file=sys.stderr)
        return []
    out = (r.stdout or "").strip()
    if not out:
        if r.stderr:
            print(r.stderr.strip()[:300], file=sys.stderr)
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        print(f"JSON 解析失败: {e}: {out[:200]}", file=sys.stderr)
        return []
    return data if isinstance(data, list) else [data]


def main():
    procs = list_procs()
    if "--all" in sys.argv:
        for p in procs:
            ep = (p.get("ExecutablePath") or "")
            if "scrcpy" in ep.lower():
                print(json.dumps(p, ensure_ascii=False))
        return 0

    targets = [p for p in procs if (p.get("ExecutablePath") or "").lower().endswith(SUFFIX)]
    if "--json" in sys.argv:
        print(json.dumps(targets, ensure_ascii=False))
        return 0
    for p in targets:
        print(p.get("ProcessId"))
    return 0 if targets else 1


if __name__ == "__main__":
    sys.exit(main())
