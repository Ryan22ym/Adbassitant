"""把 out-<版本>/ 里的产物部署到本机，并做安装后核对。

    python scripts/install-local.py                        # 版本取自 package.json
    python scripts/install-local.py --version 1.0.5 --out out-v1.0.5
    python scripts/install-local.py --no-kill              # 不自动结束在跑的进程

两种产物，两条路（自动选，谁在就用谁）：
  1. 有 NSIS 安装包（ADB桌面助手-vX-x64.exe）→ 静默安装（老路子）
  2. 只有 win-unpacked/ → **免安装绿色部署**：整个目录搬到
     %LOCALAPPDATA%\\Programs\\ADBAssistant
     （打包配置改成只出便携包之后，日常走的就是这条）

为什么要一个脚本（而不是手敲命令）
---------------------------------------------------------------
NSIS 静默安装有几个必须同时满足的硬性条件，少一个就会「装完了还是旧版本」：
  1. bat 与安装包都必须放**纯 ASCII 路径**（%TEMP%），项目目录含中文，
     中文路径下的 bat 会按 GBK 解析导致命令行错乱；
  2. 安装包先复制到 %TEMP%，路径短且无中文；
  3. 用 `cmd /c <bat>` 调用，且 `/D=` 必须是**最后一个参数、路径不加引号**；
  4. `/D=` 写错的典型症状就是 exe 的 FileVersion 装完还是旧值。

绿色部署的额外两个硬条件：
  1. 目标目录被运行中的应用占用 → 复制必失败，所以脚本自己先把进程结束掉；
  2. 不能直接往目标目录里覆盖：中途失败会留下半新半旧的目录，
     而且「旧文件没被删掉」正是旧版本残留的常见来源 →
     先整份复制到同级 .tmp，再把旧目录挪走、.tmp 改名顶上。

Conf/ 的保护（2026-11-05 加，2026-11-13 修正路径）
---------------------------------------------------------------
🔴🔴 NSIS 覆盖安装会**把 exe 同级的 `Conf` 整个删掉**（连 ai.json 里的 apiKey）——
这是 electron-builder 的 NSIS 模板行为，不是我们的 bug，但代价是用户重装后
API Key、侧栏开关、面板布局全部丢失，之前每次都要人肉从 `_conf-backup-*` 捞回来。
现在脚本自己兜：**装前备份到项目根 `_conf-backup-<时间戳>/`，装完立刻盖回去，再核对
ai.json 里至少有一家 provider 的 apiKey 非空**。备份只保留最近 10 份。
另有一层兜底：旧路径 `%APPDATA%\\adb-assistant\\Conf` 若还留着 apiKey，自动补进现用那份。

核对项（只看「装完了」是不够的）：
  - exe 的 FileVersion 变为目标版本；
  - `resources/bin/*` 与打包产物逐文件 md5 一致（排除「装上去的是旧文件」）；
  - `resources/app.asar` 里不再残留上一个版本的版本号字符串；
  - Conf 里的配置（尤其 apiKey）装完还在。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__)) + os.sep + '..'
ROOT = os.path.abspath(ROOT)
TEMP = os.environ['TEMP']
TARGET = os.path.join(os.environ['LOCALAPPDATA'], 'Programs', 'ADBAssistant')
INSTALLED_EXE = os.path.join(TARGET, 'ADB桌面助手.exe')
PROC_NAME = 'ADB桌面助手.exe'
USERDATA = os.path.join(os.environ['APPDATA'], 'adb-assistant')
# 🔴 生效的是 **exe 同级** Conf/（electron/services/ui-conf.ts::userConfDir →
#    dirname(app.getPath('exe'))/Conf，便携版再看 PORTABLE_EXECUTABLE_DIR）。
#    这里曾经写成 USERDATA/Conf（也就是 %APPDATA%\adb-assistant\Conf），于是
#    「装前备份 → 装后盖回」全程都在操作一个**程序根本不读**的目录：
#    真配置被 NSIS 连带删掉后由出厂模板重新铺一份，apiKey 静默丢失，
#    而脚本还打印「apiKey 在」—— 因为校验的也是那份没人读的文件。
#    2026-11-13 的 v1.1.25 安装就是这么丢的 key（已从旧目录合并救回）。
CONF_DIR = os.path.join(TARGET, 'Conf')
# 旧路径，只读：用于把历史遗留的 apiKey 迁回来（不删，留给用户自己清理）
LEGACY_CONF_DIR = os.path.join(USERDATA, 'Conf')
CONF_BACKUP_KEEP = 10


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


def app_pids():
    """当前在跑的 ADB桌面助手.exe 的 pid 列表"""
    r = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'], capture_output=True)
    txt = (r.stdout or b'').decode('gbk', 'replace')
    out = []
    for line in txt.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].strip('"').lower() == PROC_NAME.lower():
            try:
                out.append(int(parts[1]))
            except ValueError:
                pass
    return out


def kill_app():
    """先温和（WM_CLOSE）后强制结束，返回 (关闭数, 残留数)

    不结束就一定装不上：Windows 不允许覆盖正在运行的 exe / 被占用的 app.asar，
    症状就是「装完还是旧版本」。
    """
    before = app_pids()
    if not before:
        return 0, 0
    for p in before:
        subprocess.run(['taskkill', '/PID', str(p)], capture_output=True)
    for _ in range(20):
        time.sleep(0.5)
        if not app_pids():
            return len(before), 0
    left = app_pids()
    for p in left:
        subprocess.run(['taskkill', '/F', '/PID', str(p)], capture_output=True)
    time.sleep(1.0)
    return len(before), len(app_pids())


def try_rename(src, dst, tries=10, gap=0.8):
    """同一父目录内改名，失败重试。

    Windows 上「刚复制完的一大坨目录」立刻改名会间歇性 `ERROR_ACCESS_DENIED`
    （→ Python 的 PermissionError(13)）：Defender 实时扫描 / 索引器还开着里面的
    dll、exe，目录就不是独占状态。实测第一次必然失败，隔一两秒重试就过了。
    """
    last = None
    for _ in range(tries):
        try:
            os.rename(src, dst)
            return True
        except OSError as e:
            last = e
            time.sleep(gap)
    raise last if last is not None else OSError('rename 失败')


def deploy_green(src_dir, dst_dir):
    """整份替换式部署：复制到 .tmp → 旧目录挪成 .old → .tmp 顶上 → 删 .old

    **每一步都要能回滚。**真踩过这个坑：`rename(.tmp, dst)` 被 Defender 挡了一下，
    而当时旧目录已经改名成 `.old` 了、代码又没有回滚 —— 结果应用直接「消失」
    （目录还在，但名字不对，快捷方式全失效）。所以下面 except 里必须把 `.old` 改回去。

    不往目标目录里逐个覆盖的原因：中途失败会留下半新半旧的目录，
    而「旧文件没被删掉」正是「版本号对、代码是旧的」那种最脏状态的来源。
    """
    parent = os.path.dirname(dst_dir)
    os.makedirs(parent, exist_ok=True)
    tmp = dst_dir + '.tmp'
    old = dst_dir + '.old'
    for d in (tmp, old):
        if os.path.exists(d):
            shutil.rmtree(d, ignore_errors=True)

    try:
        shutil.copytree(src_dir, tmp)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)  # 复制失败就别留残骸
        raise

    moved_old = False
    if os.path.exists(dst_dir):
        try_rename(dst_dir, old)
        moved_old = True

    try:
        try_rename(tmp, dst_dir)
    except OSError:
        # 回滚：保证「至少还有一个能跑的应用」还在原位置
        if moved_old and not os.path.exists(dst_dir):
            try:
                try_rename(old, dst_dir)
            except OSError:
                pass
        raise

    if moved_old:
        # 旧目录删不掉不影响结果（可能仍被句柄占着）—— 留个 .old 让用户自己清
        for _ in range(3):
            try:
                shutil.rmtree(old)
                break
            except OSError:
                time.sleep(1.0)


def prune_conf_backups(keep=CONF_BACKUP_KEEP):
    """只留最近 keep 份 `_conf-backup-*`（按目录名里的时间戳排，同名分钟级冲突看 mtime）

    不清理的话每次安装都多一份，几十份之后光目录列表就不好看了。
    """
    try:
        names = [d for d in os.listdir(ROOT) if d.startswith('_conf-backup-')]
    except OSError:
        return
    dirs = [os.path.join(ROOT, d) for d in names
            if os.path.isdir(os.path.join(ROOT, d))]
    dirs.sort(key=lambda p: (os.path.basename(p), os.path.getmtime(p)), reverse=True)
    for d in dirs[keep:]:
        shutil.rmtree(d, ignore_errors=True)


def backup_conf():
    """装前把 userData/Conf 整份复制到 `<项目根>/_conf-backup-<时间戳>/`

    返回备份目录；安装前本来就没有 Conf（全新装）则返回 None。
    """
    if not os.path.isdir(CONF_DIR):
        return None
    stamp = time.strftime('%Y%m%d-%H%M')
    dst = os.path.join(ROOT, '_conf-backup-' + stamp)
    n = 1
    while os.path.exists(dst):
        n += 1
        dst = os.path.join(ROOT, '_conf-backup-%s-%d' % (stamp, n))
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(CONF_DIR):
        src = os.path.join(CONF_DIR, f)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dst, f))
    prune_conf_backups()
    return dst


def restore_conf(backup):
    """把备份盖回 userData/Conf，返回实际恢复的文件数

    只复制备份里有的文件，**不删** userData 里多出来的（那些是本次装完新增的默认文件，
    删掉反而会让界面读不到）。目录不在就新建 —— NSIS 装完 Conf 是整目录消失的。
    """
    if not backup or not os.path.isdir(backup):
        return 0
    os.makedirs(CONF_DIR, exist_ok=True)
    n = 0
    for f in os.listdir(backup):
        src = os.path.join(backup, f)
        if os.path.isfile(src):
            try:
                shutil.copy2(src, os.path.join(CONF_DIR, f))
                n += 1
            except OSError as e:
                print('           恢复 %s 失败：%r' % (f, e))
    return n


def migrate_legacy_conf():
    """把旧路径（%APPDATA%\\adb-assistant\\Conf）里的 apiKey 补进现用 Conf。

    为什么要这一步：路径改成 exe 同级之前，所有用户的 ai.json 都躺在旧目录里；
    改成 exe 同级之后，NSIS 覆盖安装会把现用 Conf 删掉、由出厂模板重铺一份，
    apiKey 就变成空的（AI 页报未配置）。这里只补**空字段**，不动用户新写的值。

    返回 [(provider, key 长度)]，没补到就是空列表。
    """
    new_ai = os.path.join(CONF_DIR, 'ai.json')
    old_ai = os.path.join(LEGACY_CONF_DIR, 'ai.json')
    if not (os.path.exists(new_ai) and os.path.exists(old_ai)):
        return []
    try:
        with open(new_ai, encoding='utf-8') as f:
            cur = json.load(f)
        with open(old_ai, encoding='utf-8') as f:
            old = json.load(f)
    except (OSError, ValueError):
        return []

    old_provs = old.get('providers') or []
    filled = []
    for p in cur.get('providers') or []:
        if (p.get('apiKey') or '').strip():
            continue
        src = next((o for o in old_provs if o.get('id') == p.get('id')), None)
        if not src:
            continue
        k = (src.get('apiKey') or '').strip()
        if not k:
            continue
        p['apiKey'] = k
        filled.append((p.get('id') or '?', len(k)))
    if not filled:
        return []
    try:
        with open(new_ai, 'w', encoding='utf-8') as f:
            json.dump(cur, f, ensure_ascii=False, indent=2)
            f.write('\n')
    except OSError:
        return []
    return filled


def conf_state():
    """一句话描述 Conf 里最要紧的东西还在不在（apiKey / 侧栏开关）

    只做报告，不改判 ok：全新安装本来就没有 apiKey，不能因此判失败。
    """
    if not os.path.isdir(CONF_DIR):
        return 'Conf 目录不存在'
    ai = os.path.join(CONF_DIR, 'ai.json')
    if not os.path.exists(ai):
        return 'ai.json 缺失'
    try:
        with open(ai, encoding='utf-8') as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        return 'ai.json 读不了：%r' % (e,)
    provs = cfg.get('providers') or []
    active = cfg.get('activeProvider')
    keyed = [(p.get('id') or p.get('name') or '?', len(p.get('apiKey') or ''))
             for p in provs if (p.get('apiKey') or '').strip()]
    files = len([f for f in os.listdir(CONF_DIR) if os.path.isfile(os.path.join(CONF_DIR, f))])
    if not keyed:
        return '%d 个文件，但**没有任何 provider 填了 apiKey**（AI 页会报未配置）' % files
    desc = '、'.join('%s(%d 位)' % kv for kv in keyed)
    return '%d 个文件，apiKey 在：%s；activeProvider=%s' % (files, desc, active)



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', default=None, help='默认取 package.json 的 version')
    ap.add_argument('--out', default=None, help='产物目录，默认 out-v<version>')
    ap.add_argument('--no-kill', action='store_true', help='不自动结束正在运行的应用')
    args = ap.parse_args()

    version = args.version or read_pkg_version()
    out_dir = os.path.join(ROOT, args.out or ('out-v%s' % version))
    setup_src = os.path.join(out_dir, 'ADB桌面助手-v%s-x64.exe' % version)
    unpacked_dir = os.path.join(out_dir, 'win-unpacked')
    unpacked_bin = os.path.join(unpacked_dir, 'resources', 'bin')

    print('目标版本 :', version)
    print('产物目录 :', out_dir)

    has_nsis = os.path.exists(setup_src)
    has_green = os.path.isfile(os.path.join(unpacked_dir, PROC_NAME))
    if not has_nsis and not has_green:
        print('产物里没有可部署的东西：既没 %s，也没 %s'
              % (os.path.basename(setup_src), os.path.join(args.out or '', 'win-unpacked', PROC_NAME)))
        return 2
    print('部署方式 :', 'NSIS 静默安装' if has_nsis
          else '免安装绿色部署（win-unpacked → %s）' % TARGET)

    print('安装前   :', file_version(INSTALLED_EXE))

    if not args.no_kill:
        killed, rest = kill_app()
        if killed:
            print('结束进程 : %d 个%s' % (killed, '，仍有残留 %d 个！' % rest if rest else '，已全部退出'))
        else:
            print('结束进程 : 无在跑的进程')
        if rest:
            print('进程没关干净，覆盖部署一定失败，请先手动关掉：', app_pids())
            return 3

    # 进程退干净之后再备份：应用退出时可能还在写 Conf，早备份会漏掉最后一次改动
    conf_backup = backup_conf()
    print('Conf 备份:', os.path.basename(conf_backup) if conf_backup
          else '（安装前没有 Conf，跳过）')

    if has_nsis:
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
    else:
        print('--- 绿色部署 ---')
        t0 = time.time()
        try:
            deploy_green(unpacked_dir, TARGET)
        except Exception as e:  # noqa: BLE001
            print('部署失败：%r' % (e,))
            print('已尝试回滚：原位置应当仍有一个可用的应用（没有的话，把 %s 下的'
                  ' .old 手工改回 ADBAssistant）。' % os.path.dirname(TARGET))
            print('提示：若报「拒绝访问」，先确认应用已退出，再重跑一次即可'
                  '（改名会重试，但极端情况下仍需重来）。')
            return 4
        print('已部署   : %s（%.1f 秒）' % (TARGET, time.time() - t0))
        print('说明     : 免安装部署不含卸载器；桌面/开始菜单快捷方式若已指向本目录则继续有效')

    after = file_version(INSTALLED_EXE)
    print('安装后   :', after)
    ok = after.startswith(version)

    # Conf 盖回去 —— NSIS 覆盖安装会把整个 Conf 目录删掉，apiKey 就在里面
    if conf_backup:
        restored = restore_conf(conf_backup)
        print('Conf 恢复: %d 个文件 ← %s' % (restored, os.path.basename(conf_backup)))
        if restored == 0:
            ok = False
    migrated = migrate_legacy_conf()
    if migrated:
        print('Conf 迁移: 从旧路径补回 apiKey %s'
              % '、'.join('%s(%d 位)' % kv for kv in migrated))
    print('Conf 校验:', conf_state())

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
