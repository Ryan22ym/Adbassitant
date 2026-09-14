"""启动本地 HTTP 静态服务，供 electron-builder 作为二进制 mirror 使用。

背景：
  app-builder.exe（Go 实现）只支持 http/https 下载，不支持 file:// 协议。
  因此本地 mirror 必须通过一个 HTTP 服务暴露出来。

用法：
  python scripts/mirror-server.py           # 前台运行，Ctrl+C 停止
  python scripts/mirror-server.py --bg      # 后台运行（供其他脚本调用）

服务根目录：<项目>/eb-mirror
默认端口：8731（可用 --port 覆盖）
"""
import argparse
import functools
import http.server
import os
import socketserver
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR = os.path.join(ROOT, 'eb-mirror')
DEFAULT_PORT = 8731


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f'[mirror] {self.address_string()} {fmt % args}\n')

    def end_headers(self):
        # 允许 Range，app-builder 可能分段下载
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()


class ReuseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve(port, block=True):
    handler = functools.partial(QuietHandler, directory=MIRROR)
    httpd = ReuseServer(('127.0.0.1', port), handler)
    if block:
        print(f'[mirror] serving {MIRROR}')
        print(f'[mirror] http://127.0.0.1:{port}/')
        httpd.serve_forever()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=DEFAULT_PORT)
    ap.add_argument('--bg', action='store_true', help='后台线程运行后立即返回')
    args = ap.parse_args()

    if not os.path.isdir(MIRROR):
        sys.exit(f'mirror 目录不存在：{MIRROR}\n先运行 python scripts/prepare-eb-mirror.py')

    if args.bg:
        t = threading.Thread(target=serve, args=(args.port, True), daemon=True)
        t.start()
        print(f'[mirror] 后台服务已启动 http://127.0.0.1:{args.port}/')
        return
    try:
        serve(args.port, True)
    except KeyboardInterrupt:
        print('\n[mirror] 已停止')


if __name__ == '__main__':
    main()
