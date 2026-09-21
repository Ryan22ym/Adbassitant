# -*- coding: utf-8 -*-
"""顺序跑六段生产包验收（版本/产物目录自动取自 package.json / ADB_OUT_DIR），逐段落盘到 docs/。

注意：**绝对不要** `taskkill /F /IM electron.exe` —— 本机同时跑着 WorkBuddy 自己
（也是 Electron），按映像名杀会把自己的宿主一起干掉。收尾只清路径在项目根之下的进程。
"""
import ctypes
import os
import re
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\yangming\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
PY = r'C:\Users\yangming\.workbuddy\binaries\python\versions\3.13.12\python.exe'
VER = __import__("json").load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))["version"]
OUT = os.environ.get('ADB_OUT_DIR') or ('out-v1.0.%s' % __import__('json').load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))['version'].split('.')[-1])

STAGES = [
    (1, 'scripts/e2e-packaged.cjs',          'Stage 1 启动与骨架'),
    (2, 'scripts/e2e-packaged-features.cjs', 'Stage 2 核心功能（真机）'),
    # Stage 3（scripts/e2e-packaged-portable.cjs）已停用：
    # v1.0.24 起打包只出 NSIS 安装版，不再产出便携包，故该段不再纳入流水线。
    (4, 'scripts/e2e-installed.cjs',         'Stage 4 NSIS 安装版'),
    (5, 'scripts/e2e-mirror-installed.cjs',  'Stage 5 安装版投屏'),
    (6, 'scripts/e2e-mirror-icon.cjs',       'Stage 6 投屏窗口图标'),
]

K32 = ctypes.WinDLL('kernel32', use_last_error=True)


def _pid_exe(pid):
    """拿 PID 的可执行文件全路径（拿不到返回空串）。"""
    h = K32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(32768)
        size = ctypes.c_uint(32768)
        if K32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return ''
    finally:
        K32.CloseHandle(h)


def reap_project_electron():
    """只结束「exe 路径在项目根之下」的 electron.exe（产物/安装版测试留下的）。"""
    r = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'],
                       capture_output=True, text=True, encoding='gbk', errors='replace')
    killed = []
    for line in (r.stdout or '').splitlines():
        if not line.startswith('"'):
            continue
        try:
            pid = int(line.split('","')[1])
        except (IndexError, ValueError):
            continue
        exe = _pid_exe(pid)
        if exe and exe.lower().startswith(ROOT.lower()):
            h = K32.OpenProcess(0x0001, False, pid)   # PROCESS_TERMINATE
            if h:
                ok = K32.TerminateProcess(h, 1)
                K32.CloseHandle(h)
                killed.append((pid, bool(ok)))
    return killed


def main():
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env['ADB_OUT_DIR'] = OUT
    env['PYTHON'] = PY

    summary = []
    for n, script, title in STAGES:
        path = os.path.join(ROOT, script)
        if not os.path.isfile(path):
            print('[skip] %s 不存在（记为 missing）' % script, flush=True)
            summary.append((n, title, 'missing', 0, 0))
            continue
        t0 = time.time()
        try:
            r = subprocess.run([NODE, path], cwd=ROOT, env=env, capture_output=True,
                               text=True, encoding='utf-8', errors='replace', timeout=900)
            out = (r.stdout or '') + (r.stderr or '')
            rc = r.returncode
        except subprocess.TimeoutExpired as e:
            out = '超时：%s' % e
            rc = -1
        dst = os.path.join(ROOT, 'docs', 'test-%s-stage%d.txt' % (VER, n) % n)
        with open(dst, 'w', encoding='utf-8') as fh:
            fh.write('=== %s ===\nrc=%s  用时 %.1fs\n\n%s' % (title, rc, time.time() - t0, out))
        m = re.search(r'(\d+)\s*(?:通过|passed)\D{0,12}?(\d+)\s*(?:失败|failed)', out)
        p, f = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
        summary.append((n, title, rc, p, f))
        print('[stage %d] rc=%s  通过 %d / 失败 %d  (%.1fs) -> %s'
              % (n, rc, p, f, time.time() - t0, os.path.basename(dst)), flush=True)
        k = reap_project_electron()
        if k:
            print('        收尾清理项目内 electron：%s' % k, flush=True)

    print('\n========= 汇总 =========', flush=True)
    tp = tf = 0
    for n, title, rc, p, f in summary:
        tp += p
        tf += f
        print('Stage %d  %-26s rc=%-6s %2d 通过 / %d 失败' % (n, title, rc, p, f), flush=True)
    print('合计：%d 通过 / %d 失败' % (tp, tf), flush=True)


if __name__ == '__main__':
    main()
