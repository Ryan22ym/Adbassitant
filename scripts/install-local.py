"""
把 out-<版本>/ 里的 NSIS 安装包静默装到本机，并做安装后核对。

    python scripts/install-local.py                # 版本取自 package.json
    python scripts/install-local.py --version 1.0.5 --out out-v1.0.5

为什么要单独一个脚本（而不是手敲命令）
---------------------------------------------------------------
NSIS 静默安装有几个必须同时满足的硬性条件，少一个就会「装完了还是旧版本」：
  1. bat 与安装包都必须放**纯 ASCII 路径**（%TEMP%），项目目录含中文，
     中文路径下的 bat 会按 GBK 解析导致命令行错乱；
  2. 安装包先复制到 %TEMP%，路径短且无中文；
  3. 用 `cmd /c <bat>` 调用，且 `/D=` 必须是**最后一个参数、路径不加引号**；
  4. `/D=` 写错的典型症状就是 exe 的 FileVersion 装完还是旧值。

核对项（只看「装完了」是不够的）：
  - exe 的 FileVersion 变为目标版本；
  - `resources/bin/*` 与打包产物逐文件 md5 一致（排除「装上去的是旧文件」）；
  - `resources/app.asar` 里不再残留上一个版本的版本号字符串。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__)) + os.sep + '..'
ROOT = os.path.abspath(ROOT)
TEMP = os.environ['TEMP']
TARGET = os.path.join(os.environ['LOCALAPPDATA'], 'Programs', 'ADBAssistant')
INSTALLED_EXE = os.path.join(TARGET, 'ADB桌面助手.exe')


def read_pkg_version():
    with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
        return json.load(f)['version']


def file_version(path):
    """用 PowerShell 读 PE 的 FileVersion（写文件再读，绕开 stdout 被吞的问题）"""
    if not os.path.exists(path):
        return '(不存在)'
    out = os.path.join(TEMP, '_adbassistant_ver.txt')
    ps = (
        "$v=(Get-Item -LiteralPath '%s').VersionInfo; "
        "$v.FileVersion + '|' + $v.ProductVersion | Set-Content -LiteralPath '%s' -Encoding UTF8"
        % (path, out)
    )
    subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps],
                   capture_output=True)
    try:
        return open(out, encoding='utf-8-sig').read().strip()
    except OSError as e:
        return 'ERR ' + str(e)


def md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', default=None, help='默认取 package.json 的 version')
    ap.add_argument('--out', default=None, help='产物目录，默认 out-v<version>')
    args = ap.parse_args()

    version = args.version or read_pkg_version()
    out_dir = os.path.join(ROOT, args.out or ('out-v%s' % version))
    setup_src = os.path.join(out_dir, 'ADB桌面助手-v%s-x64.exe' % version)
    unpacked_bin = os.path.join(out_dir, 'win-unpacked', 'resources', 'bin')

    print('目标版本 :', version)
    print('产物目录 :', out_dir)
    if not os.path.exists(setup_src):
        print('找不到安装包：', setup_src)
        return 2

    print('安装前   :', file_version(INSTALLED_EXE))

    setup = os.path.join(TEMP, 'adba-setup-v%s.exe' % version.replace('.', ''))
    bat = os.path.join(TEMP, 'adba-install-v%s.bat' % version.replace('.', ''))
    shutil.copy2(setup_src, setup)

    # bat 必须是纯 ASCII 内容；/D= 放最后且不加引号（用字符串拼接，别用 % 格式化，
    # 否则 "%SETUP%" 里的 %S 会被 Python 当成格式化占位符）
    with open(bat, 'w', encoding='ascii', newline='\r\n') as f:
        f.write('@echo off\n')
        f.write('setlocal\n')
        f.write('set "SETUP=' + setup + '"\n')
        f.write('set "TARGET=' + TARGET + '"\n')
        f.write('"%SETUP%" /S /D=' + TARGET + '\n')
        f.write('echo [install] rc=%ERRORLEVEL%\n')
        f.write('if exist "%TARGET%\\resources\\app.asar" (echo [install] ASAR-OK) '
                'else (echo [install] ASAR-MISSING)\n')
        f.write('endlocal\n')

    r = subprocess.run(['cmd', '/c', bat], capture_output=True)
    print('--- 安装输出 ---')
    print(((r.stdout or b'') + (r.stderr or b'')).decode('gbk', 'replace').strip())

    after = file_version(INSTALLED_EXE)
    print('安装后   :', after)
    ok = after.startswith(version)

    # resources/bin 逐文件 md5
    #
    # 注意：bin/ 里既有文件也有子目录（如 bundletool/ 装着 jar 与调试密钥库），
    # 所以必须递归比对 —— 早期版本只 listdir 一层，遇到目录会直接 PermissionError。
    dst_bin = os.path.join(TARGET, 'resources', 'bin')
    if os.path.isdir(unpacked_bin) and os.path.isdir(dst_bin):
        pairs = []
        for root, _dirs, files in os.walk(unpacked_bin):
            for f in files:
                sp = os.path.join(root, f)
                rel = os.path.relpath(sp, unpacked_bin)
                pairs.append((rel, sp, os.path.join(dst_bin, rel)))
        bad = []
        for rel, sp, dp in sorted(pairs):
            if not os.path.exists(dp):
                bad.append((rel, 'MISSING'))
            elif md5(sp) != md5(dp):
                bad.append((rel, 'DIFF'))
        print('bin 比对 :', '%d 个文件，全一致' % len(pairs) if not bad else bad)
        ok = ok and not bad

    # asar 里不能残留旧版本号
    # asar 里版本痕迹的核对。
    #
    # 注意：本项目「关于」页的 VERSION_NOTES 是**按版本号做 key 的历史文案表**，
    # 所以 asar 里出现旧版本号字符串是正常的（那是历史说明的 key），
    # 不能像一次性项目那样断言「旧版本号 0 命中」。
    # 真正要确认的是：① 当前版本号进了包 ② VERSION_NOTES 里有当前版本这一条
    # （发版忘了补文案时，这里会直接暴露）。
    asar = os.path.join(TARGET, 'resources', 'app.asar')
    if os.path.exists(asar):
        b = open(asar, 'rb').read()
        cur = b.count(version.encode())
        notes_hit = b.count(('"' + version + '":').encode()) + b.count(("'" + version + "':").encode())
        parts = [int(x) for x in version.split('.')]
        prev = '%d.%d.%d' % (parts[0], parts[1], max(0, parts[-1] - 1))
        print('asar     : 当前版本号命中 %d 次；VERSION_NOTES 含本版本 %s'
              % (cur, 'YES' if notes_hit else 'NO（发版忘了补版本说明？）'))
        print('           上一版本 %s 命中 %d 次（历史说明的 key，属正常）'
              % (prev, b.count(prev.encode())))
        for key in (b'install-mask', b'drop-veil', b'install-chip',
                    b'install-kind-chip', b'aab:install', b'install-kind-chip aab'):
            print('           %s: %d' % (key.decode(), b.count(key)))
        ok = ok and cur > 0 and notes_hit > 0
        # AAB 功能痕迹：新增的关键字符串必须真的进包了
        for key in (b'aab:install', b'install-kind-chip'):
            if b.count(key) == 0:
                print('           ⚠ 缺少 AAB 痕迹：%s' % key.decode())
                ok = False

    print()
    print('结果     :', 'OK' if ok else '失败')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
