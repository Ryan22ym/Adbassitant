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


def _snapshot(paths):
    st = {}
    for p in paths:
        try:
            st[p] = os.path.getsize(p)
        except OSError:
            st[p] = -1
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
        start = before.get(p, -1)
        # start<0：启动前不存在；size<start：期间被脚本清空重建（很多脚本开头会
        # `fs.writeFileSync(LOG,'')`）——两种都从 0 读，否则会读到 EOF 之后什么都拿不到。
        if start < 0 or size < start:
            start = 0
        if size <= start:
            continue
        with open(p, 'r', encoding='utf-8', errors='replace') as fh:
            fh.seek(start)
            chunks.append('----- %s -----\n%s' % (_rel(p), fh.read()))
    return '\n'.join(chunks)


def _matches(paths, before, patterns):
    """新增内容是否命中任一完成标记。"""
    text = _collect(paths, before)
    return any(re.search(p, text) for p in patterns)


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('script', help='要运行的 Electron 脚本（相对项目根或绝对路径）')
    ap.add_argument('script_args', nargs='*', help='透传给脚本的参数')
    ap.add_argument('--watch', action='append', default=[],
                    help='日志文件（可重复）：脚本会往这里写结果')
    ap.add_argument('--until', action='append', default=[],
                    help='完成标记正则（可重复）：新增内容命中才算完成')
    ap.add_argument('--settle', type=float, default=1.5, help='判定完成后补等的秒数，默认 1.5')
    ap.add_argument('--timeout', type=float, default=240.0, help='兜底超时秒数，默认 240')
    ap.add_argument('--user-data', default=None, help='自定义 user-data-dir')
    ap.add_argument('--out', default=None, help='子进程 stdout/stderr 落盘路径')
    ap.add_argument('--raw', action='store_true', help='不做 PASS/FAIL 判定')
    args = ap.parse_args()

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

    cmd = [ELECTRON, '--user-data-dir=' + ud, script] + list(args.script_args)
    print('[run-electron] %s' % ' '.join('"%s"' % c if ' ' in c else c for c in cmd))
    print('[run-electron] out -> %s' % out_path)

    t0 = time.time()
    with open(out_path, 'wb') as fh:
        proc = subprocess.Popen(cmd, cwd=ROOT, env=env,
                                stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT)

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
            if not fired and watches:
                now = _snapshot(watches)
                # 注意用 `!=` 而不是 `>`：脚本常在一开始清空自己的日志，
                # 此时体积会**变小**，用 `>` 判断会永远等不到"变化"（白等到超时强杀）。
                if any(now[p] != before.get(p, -1) for p in watches):
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
