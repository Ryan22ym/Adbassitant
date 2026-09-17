# -*- coding: utf-8 -*-
"""一体化验证：起安装版真身 → 拿 CDP 地址 → 在 Electron 主进程里跑垫片测试。

拆开跑会被进程清理误伤（run-electron.py 起测试前会清本项目进程），所以放一个脚本里。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(os.environ['LOCALAPPDATA'], 'Programs', 'ADBAssistant', 'ADB桌面助手.exe')
PORT = 9351
URLFILE = os.path.join(ROOT, 'ui-shots', '_cdpurl.txt')


def main():
    # 1) 清掉旧进程
    subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', '_kill-our-processes.py'), '--installed'],
                   cwd=ROOT, capture_output=True)

    env = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
    child = subprocess.Popen([EXE, '--remote-debugging-port=%d' % PORT], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             cwd=os.environ['TEMP'], creationflags=0x00000008)
    print('[orch] 已启动安装版 pid=%d' % child.pid)

    ws_url = None
    for i in range(40):
        time.sleep(1)
        if child.poll() is not None:
            print('[orch] 安装版已退出，码 =', child.returncode)
            return 1
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/list' % PORT, timeout=2) as r:
                targets = json.loads(r.read().decode('utf-8'))
            pages = [t for t in targets if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
            if pages:
                ws_url = pages[0]['webSocketDebuggerUrl']
                print('[orch] CDP 就绪（%ds）: %s' % (i + 1, ws_url))
                break
        except Exception:
            pass
    if not ws_url:
        print('[orch] 等不到 CDP 端点')
        return 1

    os.makedirs(os.path.dirname(URLFILE), exist_ok=True)
    with open(URLFILE, 'w', encoding='utf-8') as f:
        f.write(ws_url + '\n')

    # 2) 在 Electron 主进程里跑垫片测试（复现 --installed 的执行环境）
    electron = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    logfile = os.path.join(ROOT, 'ui-shots', '_wsshim.log')
    with open(logfile, 'wb') as lf:
        rc = subprocess.run(
            [electron, '--user-data-dir=' + os.path.join(os.environ.get('TEMP', '.'), '_shimtest-ud'),
             os.path.join(ROOT, 'scripts', '_ws-shim-test.cjs')],
            cwd=ROOT, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=120,
        ).returncode
    print('[orch] 垫片测试退出码 =', rc)

    # 3) 收尾：关掉安装版
    try:
        child.terminate()
    except Exception:
        pass

    text = open(logfile, 'rb').read().decode('utf-8', 'replace')
    print(text)
    return rc


if __name__ == '__main__':
    sys.exit(main())
