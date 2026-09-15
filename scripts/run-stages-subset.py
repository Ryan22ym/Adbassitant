# -*- coding: utf-8 -*-
"""跑 v1.0.3 的指定分段验收（逐段清残留进程，避免 CDP 连错实例）。"""
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\yangming\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
PY = r'C:\Users\yangming\.workbuddy\binaries\python\versions\3.13.12\python.exe'
OUT = os.environ.get('ADB_OUT_DIR', 'out-v1.0.3')
VER = os.environ.get('APP_VER', '1.0.3')

STAGES = [
    (1, 'scripts/e2e-packaged.cjs', 'Stage 1 启动与骨架'),
    (2, 'scripts/e2e-packaged-features.cjs', 'Stage 2 核心功能（真机）'),
    (3, 'scripts/e2e-packaged-portable.cjs', 'Stage 3 portable 便携版'),
    (4, 'scripts/e2e-installed.cjs', 'Stage 4 NSIS 安装版'),
    (5, 'scripts/e2e-mirror-installed.cjs', 'Stage 5 安装版投屏'),
    (6, 'scripts/e2e-mirror-icon.cjs', 'Stage 6 投屏窗口图标'),
]

# 只跑命令行里点名的段：python scripts/run-stages-subset.py 1 4 5 6
want = [int(x) for x in sys.argv[1:] if x.isdigit()]
if want:
    STAGES = [s for s in STAGES if s[0] in want]

env = dict(os.environ)
env.pop('ELECTRON_RUN_AS_NODE', None)
env['ADB_OUT_DIR'] = OUT
env['PYTHON'] = PY

kill_src = open(os.path.join(ROOT, 'scripts', '_kill-our-processes.py'), encoding='utf-8').read()
kill_ns = {}
exec(kill_src, kill_ns)


def clean():
    try:
        kill_ns['main']()
    except Exception as exc:  # noqa: BLE001
        print('  [warn] 清理残留进程失败:', exc)


summary = []
for n, script, title in STAGES:
    path = os.path.join(ROOT, script)
    if not os.path.isfile(path):
        print('[skip] %s 不存在' % script)
        summary.append((n, title, 'missing', 0, 0))
        continue
    print('>>> Stage %d 前先清残留进程' % n)
    clean()
    t0 = time.time()
    try:
        r = subprocess.run([NODE, path], cwd=ROOT, env=env, capture_output=True,
                           text=True, encoding='utf-8', errors='replace', timeout=900)
        out = (r.stdout or '') + (r.stderr or '')
        rc = r.returncode
    except subprocess.TimeoutExpired as exc:
        out = '超时：%s' % exc
        rc = -1
    dst = os.path.join(ROOT, 'docs', 'test-v%s-stage%d.txt' % (VER, n))
    with open(dst, 'w', encoding='utf-8') as fh:
        fh.write('=== %s ===\nrc=%s  用时 %.1fs\n\n%s' % (title, rc, time.time() - t0, out))
    # 各段输出格式不统一，都要认：
    #   "=== 结果：12/12 通过 ===" / "===== 12/12 通过 =====" / "12 通过 / 0 失败"
    m_slash = re.search(r'(\d+)\s*/\s*(\d+)\s*(?:通过|passed)', out)
    m_pair = re.search(r'(\d+)\s*(?:通过|passed)\D{0,12}?(\d+)\s*(?:失败|failed)', out)
    if m_slash:
        p = int(m_slash.group(1))
        f = max(0, int(m_slash.group(2)) - p)   # 左=通过 右=总数
    elif m_pair:
        p, f = int(m_pair.group(1)), int(m_pair.group(2))
    else:
        p = f = 0
    summary.append((n, title, rc, p, f))
    print('[stage %d] rc=%s  通过 %d / 失败 %d  (%.1fs) -> %s'
          % (n, rc, p, f, time.time() - t0, os.path.basename(dst)))

clean()
print('\n========= 汇总 =========')
tp = tf = 0
for n, title, rc, p, f in summary:
    tp += p
    tf += f
    print('Stage %d  %-26s rc=%-5s %2d 通过 / %d 失败' % (n, title, rc, p, f))
print('合计：%d 通过 / %d 失败' % (tp, tf))
