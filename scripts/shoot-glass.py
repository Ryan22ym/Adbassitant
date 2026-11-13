#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
玻璃主题效果预览：一键出图。

跑 scripts/glass-preview.cjs，由 run-electron.py 用 PrintWindow 抓窗口合成像素。
输出 ui-shots/glass-<view>-<op>-<rough>.png

用法：
  python scripts/shoot-glass.py --views home,settings --op 18 --rough 45
"""
import sys, os, re, subprocess, argparse, tempfile

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
RUNNER = os.path.join(ROOT, 'scripts', 'run-electron.py')
SCRIPT = os.path.join(ROOT, 'scripts', 'glass-preview.cjs')
OUT = os.path.join(ROOT, 'ui-shots')
RUNDIR = os.path.join(ROOT, 'e2e-tmp')
os.makedirs(RUNDIR, exist_ok=True)


def shoot(view, op, rough, want):
    log = os.path.join(RUNDIR, '_gp-%s.log' % view)
    pidfile = os.path.join(RUNDIR, '_gp-%s.pid' % view)
    png = os.path.join(OUT, 'glass-%s-%s-%s.png' % (view, op, rough))
    for p in (log, pidfile, png):
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:
                pass

    cmd = [
        PY, RUNNER, SCRIPT,
        '--watch', log,
        '--until', 'GP READY',
        '--timeout', '150',
        '--grab', '%s:%s' % (pidfile, png),
        '--grab-delay', '2.0',
        '--settle', '6',
        '--grab-size', want,
        '--',
        '--op=%s' % op, '--rough=%s' % rough, '--view=%s' % view,
        '--log=%s' % log, '--pidfile=%s' % pidfile,
    ]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace',
                       env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    out = (r.stdout or '') + (r.stderr or '')
    for line in out.splitlines():
        if 'GRAB' in line or 'GP READY' in line or 'FAIL' in line:
            print('   ', line.strip())
    if os.path.exists(png):
        print('    -> %s (%d bytes)' % (os.path.relpath(png, ROOT), os.path.getsize(png)))
        return png
    return None


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--views', default='home,settings')
    ap.add_argument('--op', default='18')
    ap.add_argument('--rough', default='45')
    # 玻璃窗尺寸：1180x820 是 glass-preview.cjs 里的期望值
    ap.add_argument('--size', default='1185x825')
    a = ap.parse_args()
    WANT = a.size.strip().lower()

    got = []
    for v in a.views.split(','):
        v = v.strip()
        print('[shoot-glass] view=%s op=%s rough=%s' % (v, a.op, a.rough))
        p = shoot(v, a.op, a.rough, WANT)
        if p:
            got.append(p)
    print('\n[shoot-glass] 完成 %d/%d' % (len(got), len(a.views.split(','))))
    for g in got:
        print(' ', g)
