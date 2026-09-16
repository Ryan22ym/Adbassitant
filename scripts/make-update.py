#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成增量更新小包（out-vX/update/）。

为什么需要：
  全量安装包 84 MB，而本项目自己的代码（dist + dist-electron + package.json 打成 app.asar）
  只有 541 KB，压缩后约 156 KB。小更新走 app.asar 替换，体积是全量的 1/540。

产出（out-vX/update/）：
  ADB桌面助手-vX-patch.zip              安装版小包：manifest.json + app.asar (+ bin 差量)
  ADB桌面助手-vX-portable-patch.zip     便携版整包：manifest.json + portable/app.exe
  runtime-vX.json                       本版运行库指纹，供「下一版」做差分基准
  *.sha256                              包自身摘要（为第二阶段「服务器下载」预留）

runtimeHash 的定义必须与 electron/services/update.ts 完全一致：
  对 resources/bin/** 逐文件取 "{相对路径}|{字节数}|{sha256}"，按相对路径排序后以 \n 连接，
  再取 sha256。缺目录时为空串的 sha256。两边任一改动都必须同步改另一边。

用法：
  python scripts/make-update.py --out out-v1.0.7
  python scripts/make-update.py --out out-v1.0.7 --prev-dir out-v1.0.6
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = 1


def read_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def resolve_electron_version(pkg):
    """取「真正被打包进程序」的 Electron 版本。

    坑：package.json 里 devDependencies.electron 是区间（如 ^33.3.1），npm 会解析到
    33.4.11 这种更高版本；Electron 运行时版本变了，只换 app.asar 是不安全的。
    应用侧比对的是 process.versions.electron（= 实际运行时），所以这里也必须给实际值，
    否则小包会被自己人判成「运行时发生变化」而拒收。
    优先级：node_modules/electron/dist/version > node_modules/electron/package.json > 声明区间。
    """
    dist_ver = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'version')
    if os.path.isfile(dist_ver):
        with open(dist_ver, 'r', encoding='utf-8', errors='replace') as f:
            v = f.read().strip()
        if v:
            return v
    pj = os.path.join(ROOT, 'node_modules', 'electron', 'package.json')
    if os.path.isfile(pj):
        v = str(read_json(pj).get('version') or '').strip()
        if v:
            return v
    return str((pkg.get('devDependencies') or {}).get('electron', '')).lstrip('^~=v ')


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def walk_files(root):
    """返回 {相对路径(用 /): 绝对路径}，跳过空目录"""
    out = {}
    if not os.path.isdir(root):
        return out
    for dp, dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, root).replace(os.sep, '/')
            out[rel] = p
    return out


def runtime_fingerprint(bin_dir):
    """与 update.ts computeRuntimeHash 一一对应"""
    files = walk_files(bin_dir)
    lines = []
    shas = {}
    for rel in sorted(files):
        p = files[rel]
        s = sha256_file(p)
        shas[rel] = s
        lines.append('%s|%d|%s' % (rel, os.path.getsize(p), s))
    payload = '\n'.join(lines)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest(), shas


def ver_key(v):
    parts = []
    for x in str(v).split('.'):
        try:
            parts.append(int(re.sub(r'\D', '', x) or 0))
        except Exception:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:4])


def find_prev(out_dir, version, explicit=None):
    """找上一版的 runtime-vX.json（版本号 < 当前的最大那个）"""
    root = os.path.dirname(os.path.abspath(out_dir))
    if explicit:
        cands = [explicit]
    else:
        cands = [os.path.join(root, d) for d in os.listdir(root) if d.startswith('out-v')]
    best = None
    for d in cands:
        upd = os.path.join(d, 'update')
        if not os.path.isdir(upd):
            continue
        for f in os.listdir(upd):
            m = re.match(r'^runtime-(.+)\.json$', f)
            if not m:
                continue
            v = m.group(1).lstrip('v')
            if ver_key(v) >= ver_key(version):
                continue
            if best is None or ver_key(v) > ver_key(best[0]):
                best = (v, os.path.join(upd, f))
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='打包输出目录，如 out-v1.0.7')
    ap.add_argument('--prev-dir', help='指定上一版输出目录（默认自动探测版本号更小的最新一版）')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)
    if not os.path.isdir(out_dir):
        sys.exit('输出目录不存在：%s' % out_dir)

    pkg = read_json(os.path.join(ROOT, 'package.json'))
    version = pkg['version']
    ebc = read_json(os.path.join(ROOT, 'electron-builder.json'))
    product = ebc.get('productName') or 'ADB桌面助手'
    app_id = ebc.get('appId') or ''
    electron_version = resolve_electron_version(pkg)

    resources = os.path.join(out_dir, 'win-unpacked', 'resources')
    asar = os.path.join(resources, 'app.asar')
    bin_dir = os.path.join(resources, 'bin')
    if not os.path.exists(asar):
        sys.exit('找不到 %s，请先完成打包' % asar)

    upd_dir = os.path.join(out_dir, 'update')
    os.makedirs(upd_dir, exist_ok=True)

    built_at = time.strftime('%Y-%m-%dT%H:%M:%S')
    r_hash, r_files = runtime_fingerprint(bin_dir)
    asar_size = os.path.getsize(asar)
    asar_sha = sha256_file(asar)

    # 需要 .exe 的 FileVersion 与 manifest.version 一致（应用侧会读 PE 校验）
    runtime_json = {
        'schema': SCHEMA,
        'version': version,
        'productName': product,
        'appId': app_id,
        'electronVersion': electron_version,
        'builtAt': built_at,
        'runtimeHash': r_hash,
        'binFiles': r_files,
        'asar': {'size': asar_size, 'sha256': asar_sha},
    }
    rt_path = os.path.join(upd_dir, 'runtime-v%s.json' % version)
    with open(rt_path, 'w', encoding='utf-8') as f:
        json.dump(runtime_json, f, ensure_ascii=False, indent=2)

    prev = find_prev(out_dir, version, args.prev_dir)
    prev_hash = None
    prev_bins = {}
    if prev:
        pdata = read_json(prev[1])
        prev_hash = pdata.get('runtimeHash')
        prev_bins = pdata.get('binFiles') or {}

    # ---- bin 差量：只带「新增或内容变化」的文件 ----
    changed_bins = [rel for rel, s in sorted(r_files.items()) if prev_bins.get(rel) != s]
    removed_bins = [rel for rel in sorted(prev_bins) if rel not in r_files]

    if prev and prev_hash:
        base_hash = prev_hash
    elif not changed_bins:
        base_hash = r_hash  # 没有历史基准、且 bin 无变化 → 基准就等于自己
    else:
        base_hash = ''  # 有 bin 变化但不知道基准 → 让应用侧拒绝

    def build_zip(zip_path, kind, entries):
        """entries: [(zip 内路径, 绝对路径, 是否压缩)]"""
        files_meta = []
        for name, src, _c in entries:
            files_meta.append({
                'path': name,
                'size': os.path.getsize(src),
                'sha256': sha256_file(src),
            })
        manifest = {
            'schema': SCHEMA,
            'productName': product,
            'appId': app_id,
            'version': version,
            'builtAt': built_at,
            'electronVersion': electron_version,
            'baseRuntimeHash': base_hash if kind == 'asar' else '',
            'resultRuntimeHash': r_hash if kind == 'asar' else '',
            'kind': kind,
            'files': files_meta,
        }
        if os.path.exists(zip_path):
            os.remove(zip_path)
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            for name, src, compress in entries:
                zi = zipfile.ZipInfo(name, date_time=time.localtime(time.time())[:6])
                zi.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
                zi.external_attr = 0o644 << 16
                with open(src, 'rb') as f:
                    z.writestr(zi, f.read())
        digest = sha256_file(zip_path)
        with open(zip_path + '.sha256', 'w', encoding='utf-8') as f:
            f.write('%s  %s\n' % (digest, os.path.basename(zip_path)))
        return manifest, os.path.getsize(zip_path), digest

    # ---- 安装版小包 ----
    entries = [('app.asar', asar, True)]
    for rel in changed_bins:
        entries.append(('bin/' + rel, os.path.join(bin_dir, rel.replace('/', os.sep)), True))
    asar_zip = os.path.join(upd_dir, '%s-v%s-patch.zip' % (product, version))
    m_asar, z_asar_size, z_asar_sha = build_zip(asar_zip, 'asar', entries)

    # ---- 便携版整包 ----
    portable_zip = None
    portable_exe = None
    for f in sorted(os.listdir(out_dir)):
        if f.endswith('.exe') and 'portable' in f.lower():
            portable_exe = os.path.join(out_dir, f)
            break
    if portable_exe:
        portable_zip = os.path.join(upd_dir, '%s-v%s-portable-patch.zip' % (product, version))
        _m, p_size, p_sha = build_zip(portable_zip, 'portable', [('portable/app.exe', portable_exe, False)])
    else:
        p_size = p_sha = 0

    if not args.quiet:
        print('=' * 68)
        print('增量更新包 - v%s' % version)
        print('=' * 68)
        print('运行库指纹 runtimeHash : %s' % r_hash[:16] + '…')
        print('差分基准 baseRuntimeHash: %s' % ((base_hash[:16] + '…') if base_hash else '(未知，本包会要求完整安装包)'))
        if prev:
            print('上一版基准            : v%s (%s)' % (prev[0], os.path.basename(prev[1])))
        else:
            print('上一版基准            : 未找到（首次生成）')
        print('bin 差量              : %d 个文件%s' % (
            len(changed_bins), (' → ' + ', '.join(changed_bins[:6])) if changed_bins else ''))
        if removed_bins:
            print('bin 删除（不支持，需发完整包）: %s' % ', '.join(removed_bins))
        print('-' * 68)
        print('app.asar              : %8.1f KB (sha256 %s…)' % (asar_size / 1024, asar_sha[:12]))
        print('安装版小包            : %8.1f KB  %s' % (z_asar_size / 1024, os.path.basename(asar_zip)))
        if portable_zip:
            print('便携版整包            : %8.1f MB  %s' % (p_size / 1048576, os.path.basename(portable_zip)))
        full = None
        for f in sorted(os.listdir(out_dir)):
            if f.endswith('.exe') and 'portable' not in f.lower():
                full = os.path.getsize(os.path.join(out_dir, f))
        if full:
            print('全量安装包            : %8.1f MB  （小包体积是它的 1/%.0f）' % (full / 1048576, full / max(z_asar_size, 1)))
        print('产物目录              : %s' % upd_dir)
        print('=' * 68)

    return 0


if __name__ == '__main__':
    sys.exit(main())
