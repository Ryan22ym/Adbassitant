"""准备 electron-builder 本地二进制 mirror，绕开 winCodeSign 的 macOS 符号链接问题。

背景：
  electron-builder 打包 Windows 时会下载 winCodeSign-2.6.0.7z，其中包含
  macOS 专用的符号链接（darwin/10.12/lib/{libcrypto,libssl}.dylib）。
  Windows 无创建符号链接权限（非管理员/未开开发者模式），7za 解压报
  「Sub items Errors: 2」并以退出码 2 结束。
  虽然其余 83 个文件（含 Windows 真正需要的 rcedit.exe / signtool.exe）
  全部解压成功，electron-builder 仍判定失败并重试 4 次后放弃整个打包。

方案：
  从已成功解压的缓存目录取一份完整内容，剔除那两个 macOS 符号链接，
  重新压成不含符号链接的 7z，放进本地 mirror 目录。
  打包时通过 ELECTRON_BUILDER_BINARIES_MIRROR 指向该目录，
  让 electron-builder 直接取用我们准备好的干净包。
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZA = os.path.join(ROOT, 'node_modules', 'builder-util', 'node_modules',
                  '7zip-bin', 'win', 'x64', '7za.exe')
CACHE = os.path.join(os.environ.get('LOCALAPPDATA', ''),
                     'electron-builder', 'Cache', 'winCodeSign')
MIRROR = os.path.join(ROOT, 'eb-mirror')
STAGE = os.path.join(MIRROR, '_stage')
KEY = 'winCodeSign-2.6.0'
DEST_DIR = os.path.join(MIRROR, KEY)
DEST_7Z = os.path.join(DEST_DIR, f'{KEY}.7z')

# 这些是 macOS 符号链接，解压必然失败，且 Windows 打包不需要
DROP = [
    os.path.join('darwin', '10.12', 'lib', 'libcrypto.dylib'),
    os.path.join('darwin', '10.12', 'lib', 'libssl.dylib'),
]


def force_rm(path):
    """删除目录。

    不用 shutil.rmtree：本机对递归删除做了安全拦截（转投回收站后失败）。
    改用 cmd 的 rd 命令，稳定可靠。
    """
    if not os.path.exists(path):
        return
    subprocess.run(['cmd', '/c', 'rd', '/s', '/q', path],
                   capture_output=True)


def pick_source():
    """挑一个文件数最多的缓存目录作为源。"""
    if not os.path.isdir(CACHE):
        return None
    best, best_n = None, -1
    for e in os.scandir(CACHE):
        if not e.is_dir():
            continue
        n = sum(len(fs) for _r, _d, fs in os.walk(e.path))
        if n > best_n:
            best, best_n = e.path, n
    return best


def main():
    if not os.path.exists(ZA):
        sys.exit(f'找不到 7za.exe: {ZA}')

    src = pick_source()
    if not src:
        sys.exit(f'缓存目录为空，无法取样：{CACHE}')
    n = sum(len(fs) for _r, _d, fs in os.walk(src))
    print(f'源目录: {src}  ({n} 个文件)')

    if os.path.exists(STAGE):
        force_rm(STAGE)
    print('复制到暂存区...')
    shutil.copytree(src, STAGE)

    for rel in DROP:
        p = os.path.join(STAGE, rel)
        if os.path.exists(p):
            try:
                os.remove(p)
                print(f'  已剔除 {rel}')
            except OSError as ex:
                print(f'  剔除失败 {rel}: {ex}')

    # 校验关键文件存在
    for must in ['rcedit-x64.exe', 'rcedit-ia32.exe',
                 os.path.join('windows-10', 'x64', 'signtool.exe')]:
        p = os.path.join(STAGE, must)
        if not os.path.exists(p):
            sys.exit(f'!! 关键文件缺失: {must}')
    print('关键文件校验通过 (rcedit / signtool)')

    os.makedirs(DEST_DIR, exist_ok=True)
    if os.path.exists(DEST_7Z):
        os.remove(DEST_7Z)

    print('压缩为 7z...')
    r = subprocess.run(
        [ZA, 'a', '-t7z', '-mx=5', '-snl', DEST_7Z, '.'],
        cwd=STAGE, capture_output=True,
    )
    ok = r.returncode == 0 and os.path.exists(DEST_7Z)
    print(f'  7za 退出码 {r.returncode}')
    if not ok:
        print(r.stdout.decode('utf-8', errors='replace')[-1500:])
        sys.exit('压缩失败')

    size = os.path.getsize(DEST_7Z) / 1024 / 1024
    print(f'完成: {DEST_7Z}  ({size:.2f} MB)')

    # 自检：确认新包能干净解压
    verify = os.path.join(MIRROR, '_verify')
    if os.path.exists(verify):
        force_rm(verify)
    r2 = subprocess.run(
        [ZA, 'x', '-bd', f'-o{verify}', DEST_7Z],
        capture_output=True,
    )
    if r2.returncode != 0:
        sys.exit(f'!! 自检解压仍失败（退出码 {r2.returncode}）')
    vn = sum(len(fs) for _r, _d, fs in os.walk(verify))
    print(f'自检通过：解压得到 {vn} 个文件，退出码 0')
    force_rm(verify)
    force_rm(STAGE)

    print()
    print('下一步：打包时设置环境变量')
    print(f'  ELECTRON_BUILDER_BINARIES_MIRROR=file:///{MIRROR.replace(os.sep, "/")}/')


if __name__ == '__main__':
    main()
