"""一键打包：自动起本地 mirror HTTP 服务，绕过 winCodeSign 符号链接问题。

用法：
  python scripts/build.py            # 完整打包（build + electron-builder）
  python scripts/build.py --no-build # 跳过前端/主进程编译，只跑 electron-builder

为什么需要它：
  electron-builder 打包 Windows 时会下载 winCodeSign-2.6.0.7z（用于 rcedit 改写 exe 资源）。
  该 7z 内含 macOS 符号链接，Windows 非管理员环境无创建权限，7za 解压报错，
  导致整个打包中断（且 exe 资源不会被改写 → 产物会退化成裸 Node 模式，静默失效）。

  解法：用 scripts/prepare-eb-mirror.py 生成一份剔除符号链接的干净包，
  再通过本地 HTTP 服务暴露给 app-builder（它不支持 file:// 协议）。

  注意：winCodeSign 必须走 mirror；nsis 等其它二进制走的是同一 base URL，
  所以 prepare-eb-mirror.py 也会把它们一起镜像进来。
"""
import argparse
import functools
import http.server
import os
import socketserver
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR = os.path.join(ROOT, 'eb-mirror')
PORT = 8731
DEFAULT_OUT = 'build-output'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f'[mirror] {fmt % args}\n')

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()


class ReuseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_mirror():
    """在后台线程启动 mirror HTTP 服务，返回 (server, port)。"""
    handler = functools.partial(QuietHandler, directory=MIRROR)
    for port in range(PORT, PORT + 10):
        try:
            httpd = ReuseServer(('127.0.0.1', port), handler)
        except OSError:
            continue
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd, port
    raise RuntimeError('无法在 8731-8740 找到可用端口')


def probe(url, timeout=3):
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception as e:
        print(f'  probe 失败: {e}')
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-build', action='store_true', help='跳过编译，仅 electron-builder')
    ap.add_argument('--out', help='覆盖输出目录（用于绕开被锁定的旧目录）')
    args = ap.parse_args()

    if not os.path.isdir(MIRROR):
        sys.exit('mirror 目录不存在，请先运行：python scripts/prepare-eb-mirror.py')

    httpd, port = start_mirror()
    base = f'http://127.0.0.1:{port}/'
    print(f'[mirror] {base}  ->  {MIRROR}')

    # 探活
    test = base + 'winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
    ok = False
    for _ in range(10):
        time.sleep(0.3)
        if probe(test):
            ok = True
            break
    if not ok:
        sys.exit(f'mirror 服务不可达：{test}')
    print('[mirror] 探活通过')

    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    # 大小写两种都设：npm 会把 .npmrc 转成小写 npm_config_* 并覆盖大写变量
    for k in ('ELECTRON_BUILDER_BINARIES_MIRROR',
              'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR',
              'npm_config_electron_builder_binaries_mirror'):
        env[k] = base
    if args.out:
        print(f'[out] 输出目录覆盖为 {args.out}')
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    cmd = [npm, 'run', 'build'] if not args.no_build else None

    log = os.path.join(ROOT, 'e2e-tmp', 'build.log')
    os.makedirs(os.path.dirname(log), exist_ok=True)

    eb = [npm, 'exec', '--', 'electron-builder']
    if args.out:
        eb.append(f'--config.directories.output={args.out}')

    try:
        if cmd:
            print(f'$ {" ".join(cmd)}')
            r = subprocess.run(cmd, cwd=ROOT, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            print(r.stdout.decode('utf-8', errors='replace'))
            if r.returncode != 0:
                sys.exit(f'编译失败（退出码 {r.returncode}）')

        print(f'$ {" ".join(eb)}')
        r = subprocess.run(eb, cwd=ROOT, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        text = r.stdout.decode('utf-8', errors='replace')
        print(text)
        with open(log, 'wb') as f:
            f.write(r.stdout)
        print(f'完整日志：{log}')
        if r.returncode != 0:
            sys.exit(r.returncode)

        # 打包成功后顺手产出增量更新小包（失败不影响打包结果）
        out_dir = args.out or DEFAULT_OUT
        try:
            print()
            mk = subprocess.run(
                [sys.executable, os.path.join(ROOT, 'scripts', 'make-update.py'), '--out', out_dir],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            print(mk.stdout.decode('utf-8', errors='replace'))
            if mk.returncode != 0:
                print(f'[update] 小包生成失败（退出码 {mk.returncode}），不影响本次打包')
        except Exception as e:  # noqa: BLE001
            print(f'[update] 小包生成异常：{e}')

        # 再顺手生成发布清单 latest.json（同样失败不阻塞打包）。
        # 依赖 SettingsPage.tsx 的 VERSION_NOTES —— 忘了补条目会在这里被点名，
        # 总比上传之后才发现「客户端显示不出更新说明」好。
        try:
            print()
            mf = subprocess.run(
                [sys.executable, os.path.join(ROOT, 'scripts', 'make-manifest.py'), '--out', out_dir],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            print(mf.stdout.decode('utf-8', errors='replace'))
            if mf.returncode != 0:
                print(f'[manifest] 清单生成失败（退出码 {mf.returncode}），暂时不影响本次打包')
        except Exception as e:  # noqa: BLE001
            print(f'[manifest] 清单生成异常：{e}')

        sys.exit(0)
    finally:
        httpd.shutdown()
        print('[mirror] 服务已停止')


if __name__ == '__main__':
    main()
