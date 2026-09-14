"""执行 npm 命令（绕过坏掉的 bash shim）。

用法： python scripts/run-npm.py <npm 参数...>
输出实时写入 e2e-tmp/npm-build.log，并打印到 stdout。
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(ROOT, 'e2e-tmp')
os.makedirs(LOG_DIR, exist_ok=True)
LOG = os.path.join(LOG_DIR, 'npm-build.log')


def main():
    args = sys.argv[1:] or ['run', 'dist']
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'

    env = dict(os.environ)
    # 关键：避免 Electron 以 Node 模式运行
    env.pop('ELECTRON_RUN_AS_NODE', None)

    print(f'$ npm {" ".join(args)}')
    print(f'  cwd = {ROOT}')
    print(f'  log = {LOG}')
    print('-' * 60)

    t0 = time.time()
    with open(LOG, 'wb') as lf:
        p = subprocess.run(
            [npm] + args,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            shell=False,
        )
        lf.write(p.stdout)

    dur = time.time() - t0
    text = p.stdout.decode('utf-8', errors='replace')
    print(text)
    print('-' * 60)
    print(f'exit={p.returncode}  耗时 {dur:.1f}s')
    sys.exit(p.returncode)


if __name__ == '__main__':
    main()
