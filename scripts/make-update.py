#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成增量更新小包（out-vX/update/）。

为什么需要：
  全量安装包 84 MB，而本项目自己的代码（dist + dist-electron + package.json 打成 app.asar）
  只有 541 KB，压缩后约 156 KB。小更新走 app.asar 替换，体积是全量的 1/540。

产出（out-vX/update/）：
  ADB桌面助手-vX-patch.zip              安装版小包：manifest.json + app.asar (+ bin 差量)
  ADB桌面助手-vX-patch-from-vY.zip      （--also-from）针对更老基线的小包，一个基线一份
  ADB桌面助手-vX-full.zip               （--full）完整资源包：全部 bin + app.asar，跨任意旧版本可升
  variants.json                         给 make-manifest.py 读：把上面这些写进 latest.json 的 variants/packages.full
  runtime-vX.json                       本版运行库指纹，供「下一版」做差分基准
  *.sha256                              包自身摘要（为第二阶段「服务器下载」预留）

「跨版本更新」为什么需要后两者（v1.0.31）：
  baseRuntimeHash 是**严格相等**校验，一份小包只服务一种运行库基线。用户要是漏了几版没更，
  基对不上 → 直接被拒。所以发版侧要能（a）为若干个老基线各出一份小包（variants），
  （b）备一份不依赖基线的完整资源包（full）给「跨度太大」的情况兜底。
  客户端挑包顺序见 electron/services/update-core.ts 的 pickPackage()。

  ⚠️ v1.0.24 起不再产出便携版整包（ADB桌面助手-vX-portable-patch.zip）：
     打包只出 NSIS 安装包，更新也只发安装版小包。

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
    """找上一版的 runtime-vX.json。

    取「版本号小于当前、且版本号最大」的那一份。**同一版本号有多个产物目录时**
    （重复打包、或中途换过产物目录名，本机实测同时存在 out-v1.0.29 / 29b / 29c / 29d），
    **取目录 mtime 最新的** —— 那才是真正发出去的那一版。

    🔴 为什么这条要命：`baseRuntimeHash` 会写进补丁清单，应用前助手会拿它跟用户机器上
    `resources/bin` 的真实指纹比对，不一致就**直接拒收**。基准一旦挑到早期的废产物，
    补丁对**所有真实用户**都会失效（表现为「点了更新、重启一趟、版本没变」，或干脆报
    运行库不匹配），而打包日志一切正常、毫无提示。旧实现用 `ver_key(v) > ver_key(best)`
    严格大于，同版本号时保留的是 `os.listdir` 先返回的那个，顺序不可控 —— 就是这么中的招。
    """
    root = os.path.dirname(os.path.abspath(out_dir))
    if explicit:
        cands = [explicit]
    else:
        cands = [os.path.join(root, d) for d in os.listdir(root) if d.startswith('out-v')]
    best = None  # (ver_key, dir_mtime, version, runtime_json_path)
    seen = {}
    for d in cands:
        upd = os.path.join(d, 'update')
        if not os.path.isdir(upd):
            continue
        try:
            d_mtime = os.path.getmtime(d)
        except OSError:
            d_mtime = 0.0
        for f in os.listdir(upd):
            m = re.match(r'^runtime-(.+)\.json$', f)
            if not m:
                continue
            v = m.group(1).lstrip('v')
            if ver_key(v) >= ver_key(version):
                continue
            seen.setdefault(v, [])
            if d not in seen[v]:
                seen[v].append(d)
            key = (ver_key(v), d_mtime)
            if best is None or key > best[0]:
                best = (key, v, os.path.join(upd, f))
    if best is None:
        return None
    dup = [v for v, ds in seen.items() if len(ds) > 1]
    if dup:
        print('⚠️  存在同版本号的多个产物目录（%s），已按目录修改时间取最新的一份做差分基准。'
              % ', '.join(sorted(dup)))
        print('    本次采用：%s' % best[2])
        print('    若不符合预期，请用 --prev-dir 显式指定正确的那一份。')
    return (best[1], best[2])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='打包输出目录，如 out-v1.0.7')
    ap.add_argument('--prev-dir', help='指定上一版输出目录（默认自动探测版本号更小的最新一版）')
    ap.add_argument('--also-from', action='append', metavar='OUT_DIR',
                    help='额外为某个更老的版本基线出一份小包（可重复）。'
                         '用于「落后好几个版本」的用户也能走小包，见 latest.json 的 variants')
    ap.add_argument('--full', action='store_true',
                    help='额外产出完整资源包（带全部 bin，跨任意旧版本可升）—— 跨版本兜底，'
                         '打包体积约 30 MB，建议在有 bin 变化或里程牌版本时带上')
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

    def build_zip(zip_path, kind, entries, base=None, full=False):
        """entries: [(zip 内路径, 绝对路径, 是否压缩)]

        base=None 时按老规则（kind=='asar' 用 base_hash）；显式传字符串则原样写进清单。
        full=True 写 `"full": true` —— 表示这是「完整资源包」，
        应用侧会跳过 baseRuntimeHash 校验（跨版本升级的实现方式，见 update-core.validateManifest）。
        """
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
            'baseRuntimeHash': (base_hash if base is None else base) if kind == 'asar' else '',
            'resultRuntimeHash': r_hash if kind == 'asar' else '',
            'kind': kind,
        }
        if full:
            manifest['full'] = True
        manifest['files'] = files_meta
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

    def bin_entries(base_bins):
        """相对某组基线文件（{rel: sha256}）的 bin 差量；base_bins=None = 全量"""
        rels = sorted(r_files) if base_bins is None \
            else [rel for rel, s in sorted(r_files.items()) if base_bins.get(rel) != s]
        return [('bin/' + rel, os.path.join(bin_dir, rel.replace('/', os.sep)), True) for rel in rels]

    # ---- 安装版小包（主变体：基准 = 紧邻的上一版）----
    entries = [('app.asar', asar, True)] + bin_entries(prev_bins)
    asar_zip = os.path.join(upd_dir, '%s-v%s-patch.zip' % (product, version))
    m_asar, z_asar_size, z_asar_sha = build_zip(asar_zip, 'asar', entries)

    # ---- 多基线变体（--also-from）：给落后好几个版本的用户也备一份小包 ----
    #
    # 为什么需要：`baseRuntimeHash` 是**严格相等**校验，一份小包只服务一种运行库基线。
    # 只出「紧邻上一版」的补丁时，落后两三版的用户必然被拒 —— 只能改走完整资源包（大）。
    # 这里允许对若干个更老的基线各出一份补丁，清单里用 `variants` 全部列出，
    # 客户端按本机指纹挑最合适的一份（见 update-core.pickPackage）。
    variants = []
    if base_hash:
        variants.append({
            'file': os.path.basename(asar_zip),
            'fromVersion': prev[0] if prev else '',
            'baseRuntimeHash': base_hash,
        })
    extra_variants = []
    for extra in (args.also_from or []):
        ed = os.path.abspath(extra)
        rt = None
        upd2 = os.path.join(ed, 'update')
        if os.path.isdir(upd2):
            for f in sorted(os.listdir(upd2)):
                if f.startswith('runtime-v') and f.endswith('.json'):
                    rt = os.path.join(upd2, f)
        if not rt:
            print('⚠️  --also-from 里找不到 runtime-v*.json，跳过：%s' % ed)
            continue
        pdata = read_json(rt)
        b_hash = pdata.get('runtimeHash') or ''
        b_bins = pdata.get('binFiles') or {}
        b_ver = str(pdata.get('version') or os.path.basename(ed))
        if not b_hash:
            print('⚠️  --also-from 的基准指纹为空，跳过：%s' % ed)
            continue
        if b_hash == r_hash:
            print('⚠️  --also-from 的运行库与本版相同，跳过（主变体已覆盖）：%s' % ed)
            continue
        if any(v['baseRuntimeHash'] == b_hash for v in variants + extra_variants):
            continue
        vname = '%s-v%s-patch-from-v%s.zip' % (product, version, b_ver)
        vzip = os.path.join(upd_dir, vname)
        ventries = [('app.asar', asar, True)] + bin_entries(b_bins)
        _m, _s, _h = build_zip(vzip, 'asar', ventries, base=b_hash)
        extra_variants.append({'file': vname, 'fromVersion': b_ver, 'baseRuntimeHash': b_hash})
        if not args.quiet:
            print('附加变体              : %s ← v%s（bin 差量 %d 个文件，%.1f KB）'
                  % (vname, b_ver, len(ventries) - 1, _s / 1024))
    variants += extra_variants

    # ---- 完整资源包（--full）：带全部 bin，跨任意旧版本都能升 ----
    full_zip = None
    if args.full:
        full_zip = os.path.join(upd_dir, '%s-v%s-full.zip' % (product, version))
        full_entries = [('app.asar', asar, True)] + bin_entries(None)
        build_zip(full_zip, 'asar', full_entries, base='', full=True)

    # variants.json：给 make-manifest.py 读，把变体写进 latest.json
    vj = {
        'schema': 1,
        'version': version,
        'patches': variants,
        'full': {'file': os.path.basename(full_zip)} if full_zip else None,
    }
    with open(os.path.join(upd_dir, 'variants.json'), 'w', encoding='utf-8') as f:
        json.dump(vj, f, ensure_ascii=False, indent=2)

    # ---- 便携版整包：已停用（v1.0.24 起只发 NSIS 安装版）----
    # 历史说明：便携版是「替换 exe 本体」的整包更新，体积约 105 MB。
    # 现在打包只出 NSIS 安装包，更新也只发安装版小包，故不再生成 portable 整包。
    # 若将来要临时恢复：electron-builder.json 的 win.target 加回 "portable"，
    # 再把这段恢复（build_zip(portable_zip, 'portable', [('portable/app.exe', portable_exe, False)])）。
    portable_zip = None
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
        if len(variants) > 1:
            print('小包变体共            : %d 份（%s）'
                  % (len(variants), '、'.join('v' + (v['fromVersion'] or '?') for v in variants)))
        if full_zip:
            print('完整资源包            : %8.1f MB  %s（跨版本兜底，任意旧版本可升）'
                  % (os.path.getsize(full_zip) / 1048576, os.path.basename(full_zip)))
        else:
            print('完整资源包            : 未产出（加 --full）—— 落后多个版本的用户只能下载完整安装包')
        # 全量包体积：NSIS 安装包（不再产出便携包）
        full = None
        for f in sorted(os.listdir(out_dir)):
            if f.endswith('.exe') and 'portable' not in f.lower():
                full = os.path.getsize(os.path.join(out_dir, f))
        if full:
            print('%s            : %8.1f MB  （小包体积是它的 1/%.0f）' % (
                '全量安装包', full / 1048576, full / max(z_asar_size, 1)))
        print('产物目录              : %s' % upd_dir)
        print('=' * 68)

    return 0


if __name__ == '__main__':
    sys.exit(main())
