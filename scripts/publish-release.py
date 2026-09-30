#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 out-vX 的 NSIS 安装包发布到 GitHub Release（仓库 Release 页）。

用法：
    python scripts/publish-release.py                    # 版本取 package.json，产物找 out-v<version>
    python scripts/publish-release.py --out out-v1.1.0
    python scripts/publish-release.py --dry-run          # 只打印计划，不碰网络
    python scripts/publish-release.py --notes-file x.md  # 覆盖 Release 正文
    python scripts/publish-release.py --with-full        # 额外传一份跨版本完整更新包

Release 正文默认从 `src/pages/SettingsPage.tsx` 的 `VERSION_NOTES[<版本>]` 抠出来，
再转成 Markdown —— 与应用内「检查更新」显示的是同一份文案，不会两处走样。

踩过的坑（都写在代码里了）：
  * 资产名必须是 ASCII。GitHub 会把 `ADB桌面助手-v1.1.0-x64.exe` 净化成
    `ADB.-v1.1.0-x64.exe`（非 ASCII 字符全部替换成 `.`），所以这里主动用
    `ADB-Assistant-v<版本>-x64.exe`。改名走 `PATCH /releases/assets/{id}`。
  * 更新 Release 只能用 `PATCH /releases/{id}`；用 `releases/tags/{tag}` 会 404。
  * 凭据取自 Windows 凭据管理器（`git credential fill`，wincred），需要 repo scope。
  * 必须清掉 HTTPS_PROXY/HTTP_PROXY —— 本机代理会让请求读到缓存的旧响应。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = 'Ryan22ym'
REPO = 'Adbassitant'
GIT = r'C:\Program Files\Git\cmd\git.exe'
PROXY_KEYS = ('HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy',
              'ALL_PROXY', 'all_proxy')


def info(msg):
    print('  ' + msg, flush=True)


def die(msg):
    print('\n[FAIL] ' + msg, flush=True)
    sys.exit(1)


def clean_env():
    env = dict(os.environ)
    for k in PROXY_KEYS:
        env.pop(k, None)
    return env


# ---------------------------------------------------------------- 版本与产物

def read_version():
    p = os.path.join(ROOT, 'package.json')
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)['version']


def find_installer(out_dir, version):
    """在 out-vX 里找 NSIS 安装包；名字带中文，所以按「.exe 且含版本号」找。"""
    if not os.path.isdir(out_dir):
        die('产物目录不存在：%s' % out_dir)
    cands = [f for f in os.listdir(out_dir)
             if f.lower().endswith('.exe') and version in f]
    if not cands:
        die('%s 里找不到含版本号 %s 的 .exe' % (out_dir, version))
    if len(cands) > 1:
        info('⚠️ 找到多个安装包，取第一个：%s' % cands)
    p = os.path.join(out_dir, cands[0])
    return p, os.path.getsize(p)


# ---------------------------------------------------------------- 文案

def load_make_manifest():
    """复用 make-manifest.py 的 extract_notes（含多行拼接修正）。"""
    path = os.path.join(ROOT, 'scripts', 'make-manifest.py')
    if not os.path.isfile(path):
        return None
    import importlib.util
    spec = importlib.util.spec_from_file_location('make_manifest', path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        return None
    return mod


def notes_to_markdown(notes):
    """`新增：\\n· a\\n· b\\n修复：\\n· c` → `## 新增\\n- a\\n- b\\n\\n## 修复\\n- c`"""
    out = []
    for raw in notes.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('·') or line.startswith('•'):
            out.append('- ' + line.lstrip('·•').strip())
        elif line.startswith('- '):
            out.append(line)
        elif re.match(r'^[^：:]{1,8}[：:]$', line):
            if out:
                out.append('')
            out.append('## ' + line.rstrip('：:'))
        else:
            out.append(line)
    return '\n'.join(out).strip()


def build_body(version, notes_md):
    tail = (
        '---\n\n'
        '**安装**：Windows 10/11 x64，双击安装包覆盖安装即可'
        '（已装旧版无需卸载，配置与记录保留）。\n\n'
        '**已有旧版可直接在应用内更新**：设置 → 检查更新。'
        '本版同时提供跨版本小包，可从相近的旧版本用小包升上来。\n'
    )
    return (notes_md + '\n\n' + tail) if notes_md else tail


# ---------------------------------------------------------------- GitHub API

def get_token():
    p = subprocess.run(
        [GIT, '-c', 'credential.helper=wincred', 'credential', 'fill'],
        input='protocol=https\nhost=github.com\n\n',
        capture_output=True, text=True, env=clean_env(),
    )
    for line in p.stdout.splitlines():
        if line.startswith('password='):
            return line[len('password='):].strip()
    die('未能从凭据管理器取到 GitHub token（需要 repo scope）\n'
        + p.stdout + p.stderr)


def api(url, token, payload=None, method=None, timeout=120):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Authorization', 'Bearer ' + token)
    r.add_header('Accept', 'application/vnd.github+json')
    r.add_header('User-Agent', 'adb-assistant-release')
    if data:
        r.add_header('Content-Type', 'application/json; charset=utf-8')
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8')
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def upload_asset(upload_url, token, local_path, asset_name):
    size = os.path.getsize(local_path)
    url = (upload_url.split('{')[0]
           + '?name=' + urllib.parse.quote(asset_name, safe=''))
    info('上传 %s (%.1f MB) …' % (asset_name, size / 1048576.0))
    with open(local_path, 'rb') as fh:
        r = urllib.request.Request(url, data=fh, method='POST')
        r.add_header('Authorization', 'Bearer ' + token)
        r.add_header('Content-Type', 'application/octet-stream')
        r.add_header('Content-Length', str(size))   # 有它才不会退化成 chunked
        r.add_header('User-Agent', 'adb-assistant-release')
        try:
            with urllib.request.urlopen(r, timeout=3600) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            die('上传失败 %s\n%s' % (e.code, e.read().decode('utf-8', 'replace')))


def main():
    ap = argparse.ArgumentParser(description='发布安装包到 GitHub Release')
    ap.add_argument('--out', help='产物目录（默认 out-v<版本>）')
    ap.add_argument('--tag', help='tag 名（默认 v<版本>）')
    ap.add_argument('--notes-file', help='Release 正文（默认从 VERSION_NOTES 抠）')
    ap.add_argument('--with-full', action='store_true',
                    help='额外上传 update/ 下的跨版本完整包（改名为 ASCII）')
    ap.add_argument('--dry-run', action='store_true', help='只打印计划，不调 API')
    args = ap.parse_args()

    urllib.request.install_opener(
        urllib.request.build_opener(urllib.request.ProxyHandler({})))

    version = read_version()
    tag = args.tag or ('v' + version)
    out_dir = args.out or os.path.join(ROOT, 'out-v' + version)

    print('\n=== GitHub Release 发布 v%s ===' % version)
    exe, exe_size = find_installer(out_dir, version)
    asset_name = 'ADB-Assistant-v%s-x64.exe' % version
    info('版本   : %s' % version)
    info('tag    : %s' % tag)
    info('产物   : %s' % os.path.relpath(exe, ROOT))
    info('大小   : %d bytes (%.1f MB)' % (exe_size, exe_size / 1048576.0))
    info('资产名 : %s' % asset_name)

    extras = []
    if args.with_full:
        for f in os.listdir(os.path.join(out_dir, 'update')):
            if f.endswith('-full.zip'):
                extras.append((os.path.join(out_dir, 'update', f),
                               'ADB-Assistant-v%s-full.zip' % version))
        if not extras:
            info('⚠️ --with-full 但 update/ 下没有 -full.zip，跳过')

    if args.notes_file:
        with open(args.notes_file, 'r', encoding='utf-8') as f:
            notes_md = f.read().strip()
        info('正文   : %s（外部文件）' % args.notes_file)
    else:
        mod = load_make_manifest()
        if mod is None or not hasattr(mod, 'extract_notes'):
            die('拿不到 make-manifest.py 的 extract_notes，请用 --notes-file 指定正文')
        try:
            raw = mod.extract_notes(version)
        except SystemExit:
            die('VERSION_NOTES 里没有 %s 的条目 —— 发版前先在 SettingsPage.tsx 补一条'
                % version)
        notes_md = notes_to_markdown(raw)
        info('正文   : 由 VERSION_NOTES[%s] 生成（%d 字）' % (version, len(notes_md)))

    body = build_body(version, notes_md)
    if args.dry_run:
        print('\n--- Release 正文预览 ---\n' + body + '\n----------------------')
        info('[dry-run] 到此为止，未调用 GitHub API')
        return

    token = get_token()
    info('凭据   : ok')

    st, repo = api('https://api.github.com/repos/%s/%s' % (OWNER, REPO), token)
    if st != 200:
        die('读仓库失败 %s: %s' % (st, repo))
    info('仓库   : %s/%s (%s)' % (OWNER, REPO, repo.get('visibility')))

    base = 'https://api.github.com/repos/%s/%s/releases' % (OWNER, REPO)
    st, rel = api(base + '/tags/' + tag, token)
    if st == 200 and isinstance(rel, dict) and rel.get('id'):
        rid = rel['id']
        info('Release: 已存在，复用 id=%s' % rid)
        st, _ = api('https://api.github.com/repos/%s/%s/releases/%s' % (OWNER, REPO, rid),
                    token, {'body': body}, method='PATCH')
        if st != 200:
            die('更新正文失败 %s' % st)
    else:
        st, rel = api(base, token, {
            'tag_name': tag,
            'target_commitish': repo.get('default_branch') or 'main',
            'name': 'ADB 桌面助手 v%s' % version,
            'body': body,
            'draft': False,
            'prerelease': False,
        }, method='POST')
        if st not in (200, 201):
            die('创建 Release 失败 %s\n%s' % (st, rel))
        rid = rel['id']
        info('Release: 已创建 id=%s' % rid)

    # 同名资产先清掉，避免重复
    st, assets = api(base + '/%s/assets' % rid, token)
    if st == 200 and isinstance(assets, list):
        for a in assets:
            if a['name'] == asset_name:
                api('https://api.github.com/repos/%s/%s/releases/assets/%s'
                    % (OWNER, REPO, a['id']), token, method='DELETE')
                info('(清掉同名旧资产 %s)' % a['id'])

    up = upload_asset(rel.get('upload_url') or
                      'https://uploads.github.com/repos/%s/%s/releases/%s/assets'
                      % (OWNER, REPO, rid), token, exe, asset_name)
    info('已上传 : %s (%s bytes, %s)' % (up['name'], up['size'], up['state']))

    for path, name in extras:
        up2 = upload_asset('https://uploads.github.com/repos/%s/%s/releases/%s/assets'
                           % (OWNER, REPO, rid), token, path, name)
        info('已上传 : %s (%s bytes)' % (up2['name'], up2['size']))

    # 复核：本地尺寸 vs 线上资产尺寸
    st, r3 = api(base + '/tags/' + tag, token)
    print('\n--- 复核 ---')
    ok = False
    for a in r3.get('assets', []):
        info('%-38s %10d bytes  %s' % (a['name'], a['size'], a['state']))
        if a['name'] == asset_name and a['size'] == exe_size:
            ok = True
    info('页面   : %s' % r3.get('html_url'))
    if not ok:
        die('线上资产尺寸与本地不一致，请检查')
    info('尺寸校验: 本地 == 线上 ✓')
    print('\n[DONE] 已发布到 GitHub Release\n', flush=True)


if __name__ == '__main__':
    main()
