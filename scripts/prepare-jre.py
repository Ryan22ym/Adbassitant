"""准备「随包 JRE」：把便携版 Java 运行时放进 bin/jre/，让没装 Java 的新用户
装完就能用 AAB 安装（bundletool 是 Java 程序）。

用法：
  python scripts/prepare-jre.py                 # 缺则下载并展开
  python scripts/prepare-jre.py --force         # 已有也重下一遍
  python scripts/prepare-jre.py --zip <路径>    # 用本地已下载的 zip（离线/CI 缓存）
  python scripts/prepare-jre.py --check         # 只检查是否就绪，不下载（退出码即结论）

为什么需要它
-----------------------------------------------------------------
AAB 安装链路的三个部件里，bundletool jar 与 debug.keystore 已经随包
（bin/bundletool/），adb 也随包（bin/adb.exe），唯独 **Java 运行时**原先
要求用户自己装 —— 而「装完就能用」是这个工具的基本盘。本脚本把
Eclipse Temurin JRE（OpenJDK，GPLv2 + Classpath Exception，允许随产品
再分发）拉下来放进 bin/jre/，electron-builder 的 extraResources
（from: bin）会自动把它一起打进安装包。

落点必须是 bin/jre/bin/java.exe
-----------------------------------------------------------------
electron/services/java.ts 按「先随包、再 JAVA_HOME、再 PATH、最后扫常见
安装位置」的顺序找 java，随包那一档认的就是 bin/jre/bin/java 与
bin/jre/<某个子目录>/bin/java。所以这里解压时**剥掉 zip 的顶层目录**
（Temurin 的包顶层是 jdk-17.x.y-jre/），保证 java.exe 正好落在
bin/jre/bin/java.exe —— 少剥或多剥一层，探测就会静默落空、退回找系统 Java。

zip 缓存放项目根的 .jre-cache/（不是 bin/ 下）
-----------------------------------------------------------------
bin/ 整个目录会被 extraResources（bin/**/*）收进安装包。若把 40 MB 的
zip 缓存在 bin/ 里，安装包会平白胖一圈。所以缓存在 bin/ 之外。

体积
-----------------------------------------------------------------
解压后约 125 MB（NSIS 压缩后安装包大约 +45 MB）。这是「自带环境」的
必要代价；不想要就删掉 bin/jre/，程序会退回「要求用户自装 Java + 给出提示」。
"""
import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JRE_DIR = os.path.join(ROOT, 'bin', 'jre')
CACHE_DIR = os.path.join(ROOT, '.jre-cache')

# Eclipse Temurin（Adoptium）JRE —— 允许随产品再分发。
# /latest/<major>/ga/... 会自动 302 到当前最新的 GA 构建。
JRE_MAJOR = '17'
JRE_URL = (
    f'https://api.adoptium.net/v3/binary/latest/{JRE_MAJOR}/ga/'
    'windows/x64/jre/hotspot/normal/eclipse'
)
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ADBAssistant-build/1.0'
MIN_MAJOR = 11  # bundletool 1.18 需要 Java 11+


def java_exe() -> str:
    return os.path.join(JRE_DIR, 'bin', 'java.exe')


def probe_java() -> tuple:
    """跑一次 java -version，返回 (ok, 版本描述, 大版本号)。"""
    exe = java_exe()
    if not os.path.isfile(exe):
        return False, 'bin/jre/bin/java.exe 不存在', None
    try:
        r = subprocess.run([exe, '-version'], capture_output=True, timeout=30)
    except Exception as e:  # noqa: BLE001
        return False, f'无法运行：{e}', None

    # java 历来把版本打到 stderr（少数构建打 stdout），两边都看
    text = (r.stderr or b'').decode('utf-8', 'replace') + \
           (r.stdout or b'').decode('utf-8', 'replace')
    if r.returncode != 0 and 'version' not in text.lower():
        return False, f'java -version 退出码 {r.returncode}', None

    import re
    m = re.search(r'version\s+"([^"]+)"', text)
    raw = m.group(1) if m else ''
    major = None
    if raw:
        parts = re.split(r'[._]', raw)
        try:
            major = int(parts[1]) if parts[0] == '1' else int(parts[0])
        except (IndexError, ValueError):
            major = None
    desc = text.strip().splitlines()[0] if text.strip() else '（无输出）'
    return True, desc, major


def dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def download(dest: str) -> str:
    """下载 JRE zip 到 dest（先 .part 再改名，断网不留半截文件）。"""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + '.part'

    # 清代理：本机 HTTPS_PROXY 常指向未启动的本地端口，会让下载直接失败
    for k in ('HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'):
        os.environ.pop(k, None)

    req = urllib.request.Request(JRE_URL, headers={'User-Agent': UA})
    print(f'[jre] 正在下载：{JRE_URL}')
    with urllib.request.urlopen(req, timeout=300) as r:
        total = int(r.headers.get('content-length') or 0)
        got = 0
        with open(part, 'wb') as f:
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    pct = got * 100 // total
                    sys.stdout.write(f'\r[jre] {pct}% ({got / 1048576:.1f}/{total / 1048576:.1f} MB)')
                    sys.stdout.flush()
    if total:
        sys.stdout.write('\n')

    size = os.path.getsize(part)
    with open(part, 'rb') as f:
        magic = f.read(2)
    if size < 1024 * 1024 or magic != b'PK':
        os.remove(part)
        raise RuntimeError(f'下载内容不是有效的 zip（{size} 字节）')

    if os.path.exists(dest):
        os.remove(dest)
    os.replace(part, dest)
    print(f'[jre] 已下载 {dest}（{size / 1048576:.1f} MB）')
    return dest


def extract(zip_path: str) -> None:
    """解压到 bin/jre/，剥掉 zip 的顶层目录。"""
    if os.path.isdir(JRE_DIR):
        shutil.rmtree(JRE_DIR)
    os.makedirs(JRE_DIR, exist_ok=True)

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        tops = {n.split('/')[0] for n in names if n.strip('/')}
        if len(tops) != 1:
            raise RuntimeError(f'zip 顶层目录不是唯一一个：{tops}')
        top = next(iter(tops)) + '/'
        print(f'[jre] 解压（剥离顶层 {top}）-> bin/jre')

        count = 0
        for info in z.infolist():
            name = info.filename
            if not name.startswith(top):
                continue
            rel = name[len(top):]
            if not rel:
                continue
            out = os.path.join(JRE_DIR, rel.replace('/', os.sep))
            if name.endswith('/'):
                os.makedirs(out, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(info) as s, open(out, 'wb') as f:
                shutil.copyfileobj(s, f)
            count += 1
    print(f'[jre] 展开 {count} 个文件')


def find_local_zip() -> str:
    """默认缓存 zip 的路径（存在则返回）。"""
    for name in sorted(os.listdir(CACHE_DIR)) if os.path.isdir(CACHE_DIR) else []:
        if name.lower().endswith('.zip'):
            return os.path.join(CACHE_DIR, name)
    return ''


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='已有也重新下载展开')
    ap.add_argument('--zip', dest='zip_path', help='用本地 zip，不联网下载')
    ap.add_argument('--check', action='store_true', help='只检查，不下载；退出码即结论')
    args = ap.parse_args()

    ok, desc, major = probe_java()
    if ok and major is not None and major >= MIN_MAJOR and not args.force:
        size = dir_size(JRE_DIR)
        print(f'[jre] 已就绪：{desc}')
        print(f'[jre] 位置：{JRE_DIR}（{size / 1048576:.1f} MB）')
        return 0

    if args.check:
        if ok:
            print(f'x Java 版本过低：{desc}（需要 {MIN_MAJOR}+）')
        else:
            print(f'x 随包 JRE 不可用：{desc}')
        return 1

    zip_path = args.zip_path or ''
    if zip_path:
        if not os.path.isfile(zip_path):
            print(f'x 指定的 zip 不存在：{zip_path}')
            return 1
    else:
        zip_path = find_local_zip()
        if zip_path and not args.force:
            print(f'[jre] 复用已缓存的 zip：{zip_path}')
        else:
            os.makedirs(CACHE_DIR, exist_ok=True)
            zip_path = download(os.path.join(CACHE_DIR, f'temurin{JRE_MAJOR}-jre-win-x64.zip'))

    try:
        extract(zip_path)
    except Exception as e:  # noqa: BLE001
        print(f'x 解压失败：{e}')
        return 1

    ok, desc, major = probe_java()
    if not ok:
        print(f'x 解压后仍无法运行 java：{desc}')
        return 1
    if major is not None and major < MIN_MAJOR:
        print(f'x 版本过低（{major} < {MIN_MAJOR}）')
        return 1

    size = dir_size(JRE_DIR)
    print(f'[jre] 完成：{desc}')
    print(f'[jre] 位置：{JRE_DIR}（{size / 1048576:.1f} MB）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
