#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""「更新助手能不能启动、能不能活过宿主退出」检查 —— 阶段二驱动。

用法：
    python scripts/check-helper-launch.py

阶段一（scripts/check-helper-launch.cjs，真 Electron）：
    调生产代码的 spawnHelperForCheck()，等助手落第一行日志，然后 app.exit(0)。
阶段二（本文件，宿主已死）：
    断言助手在宿主死掉之后仍然把活干完了 —— 这是「没被 KILL_ON_JOB_CLOSE 连坐」的硬证据。
    因为助手的 job.pid 就是宿主，它必须先看到宿主消失才会往下走，
    所以 result.json 存在的时刻必然晚于宿主退出。

退出码：0 全过 / 1 有失败。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, 'ui-shots', '_helper-launch.log')
STATE_FILE = os.path.join(ROOT, 'ui-shots', '_helper-launch-state.json')
STDOUT = os.path.join(ROOT, 'ui-shots', '_helper-launch.stdout.log')

rows = []


def record(ok, name, detail=''):
    line = '%s  %s  ::  %s' % ('PASS' if ok else 'FAIL', name, detail)
    rows.append(line)
    with open(LOG, 'a', encoding='utf-8') as fh:
        fh.write(line + '\n')
    print(line)


def info(msg):
    with open(LOG, 'a', encoding='utf-8') as fh:
        fh.write('INFO  %s\n' % msg)
    print('INFO  %s' % msg)


def phase1() -> int:
    with open(LOG, 'w', encoding='utf-8') as fh:
        fh.write('')
    try:
        os.remove(STATE_FILE)
    except OSError:
        pass
    cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'run-electron.py'),
           'scripts/check-helper-launch.cjs', '--raw',
           '--timeout', '90', '--out', STDOUT]
    print('[check-helper-launch] 阶段一: %s' % ' '.join(cmd))
    return subprocess.call(cmd, cwd=ROOT)


def main() -> int:
    rc = phase1()
    if rc != 0:
        record(False, '阶段一进程正常退出（码 0）', '码=%d' % rc)

    if not os.path.isfile(STATE_FILE):
        record(False, '阶段一写出了 state（含暂存/状态目录路径）', '文件不存在')
        print('\n=== 更新助手启动检查 ===')
        for r in rows:
            print(r)
        print('HELPER LAUNCH CHECK DONE')
        return 1

    with open(STATE_FILE, encoding='utf-8') as fh:
        st = json.load(fh)
    job = st['JOB']

    # 阶段二：宿主已死，等助手把结果落下来
    result_path = job['resultPath']
    log_path = job['logPath']
    res = None
    deadline = time.time() + 45
    while time.time() < deadline:
        if os.path.isfile(result_path):
            try:
                with open(result_path, encoding='utf-8-sig') as fh:
                    res = json.load(fh)
                break
            except Exception:
                res = None
        time.sleep(0.5)

    helper_log = ''
    if os.path.isfile(log_path):
        with open(log_path, encoding='utf-8', errors='replace') as fh:
            helper_log = fh.read()
    info('helper.log:')
    for line in helper_log.split('\n'):
        if line.strip():
            info('  ' + line)

    record(bool(res), '助手在宿主退出后写出了 result.json（= 没被作业对象连坐）', str(res_path_ok(result_path)))
    record(bool(res and res.get('ok') is True), '助手判定本次为成功', str(res and {k: res.get(k) for k in ('ok', 'mode', 'from', 'to')}))
    record('helper exit' in helper_log, '助手走完了完整流程并自行退出', '')
    record('helper start mode=apply' in helper_log, '助手确实按 apply 模式启动', '')
    record('FAILED:' not in helper_log, '助手流程里没有异常分支', '')
    record(os.path.isfile(os.path.join(job['backupDir'], 'restore.json')), '助手写出了 restore.json（备份元信息）', '')

    # 清理
    import shutil
    for d in (st['STAGE'], st['STATE']):
        shutil.rmtree(d, ignore_errors=True)

    print('\n=== 更新助手启动检查 ===')
    for r in rows:
        print(r)
    fail = sum(1 for r in rows if r.startswith('FAIL'))
    print('%d 通过 / %d 失败' % (len(rows) - fail, fail))
    print('HELPER LAUNCH CHECK DONE')
    return 1 if fail else 0


def res_path_ok(p):
    return '存在' if os.path.isfile(p) else '缺失'


if __name__ == '__main__':
    sys.exit(main())
