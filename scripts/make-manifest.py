#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 out-vX/update/ 生成 latest.json（顺带算 size / sha256）。

为什么需要：
  上传到静态托管的那份 latest.json 里，最容易错的就是手工抄 size / sha256 ——
  抄错的后果是「所有客户端都下不了这一版」（第一道校验直接拒），而且只有发出去才发现。
  这个脚本把「算 hash、填字段、写文件」一次做完，并顺手做几项硬校验。

isn't 什么：
  不生成更新包（那是 scripts/make-update.py），不负责上传（静态托管自己传）。

产出（out-vX/update/latest.json）：
  schema / productName / appId / channel   —— 客户端硬校验的四件套，写死
  latest.version                           —— 必须 = 产物目录版本 = package.json 版本
  latest.notes                             —— 默认从 SettingsPage.tsx 的 VERSION_NOTES 抠，
                                              保证与设置页「软件更新」里显示的一模一样
  latest.critical                          —— --critical 才为 true
  latest.packages.asar.size / .sha256      —— 直接算，不手抄

v1.0.24 起打包只出 NSIS 安装包，所以 packages 只有 asar 一项。若产物目录里确实躺着
portable 整包（历史产物），会打一条警告 —— 那说明 make-update.py 被改回去了。

用法：
  python scripts/make-manifest.py                          # 版本取自 package.json
  python scripts/make-manifest.py --out out-v1.0.24
  python scripts/make-manifest.py --critical --notes "紧急修复 xxx"
  python scripts/make-manifest.py --check                  # 只校验现有清单没过期，不写盘
  python scripts/make-manifest.py --version 1.0.23 --out out-v1.0.23c --force   # 复算历史清单
"""
import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCHEMA = 1
PRODUCT_NAME = 'ADB桌面助手'
APP_ID = 'com.xiaoyang.adbassistant'
CHANNEL = 'stable'
PATCH_TMPL = '%s-v%s-patch.zip'
PORTABLE_TMPL = '%s-v%s-portable-patch.zip'
SETTINGS_PAGE = os.path.join('src', 'pages', 'SettingsPage.tsx')
VERSION_RE = re.compile(r'^out-v(\d+\.\d+\.\d+)')


def die(msg, code=3):
    print('[make-manifest] 失败：%s' % msg, file=sys.stderr)
    sys.exit(code)


def warn(msg):
    print('[make-manifest] ⚠️  %s' % msg)


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def read_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def read_ts_string(src, start):
    """从 src[start]（必须是单引号）读一个 TS 单引号字符串，返回 (内容, 结束后的下标)。

    不写正则的原因：更新说明里出现一个单引号，正则就截断了（而说明是中文文案，随时可能有）。
    这里按字符扫，处理 \\ 转义（\\n 会变成真正的换行，json.dump 再转回 \\n，行为正确）。
    """
    if src[start] != "'":
        raise ValueError('不是单引号开头')
    out = []
    i = start + 1
    mapping = {'n': '\n', 't': '\t', 'r': '\r', "'": "'", '"': '"', '\\': '\\', '`': '`'}
    while i < len(src):
        c = src[i]
        if c == '\\':
            nxt = src[i + 1] if i + 1 < len(src) else ''
            out.append(mapping.get(nxt, nxt))
            i += 2
            continue
        if c == "'":
            return ''.join(out), i + 1
        out.append(c)
        i += 1
    raise ValueError('字符串没有闭合')


def extract_notes(version):
    """从 SettingsPage.tsx 的 VERSION_NOTES 里抠出该版本的更新说明。"""
    path = os.path.join(ROOT, SETTINGS_PAGE)
    if not os.path.isfile(path):
        die('找不到 %s' % path)
    with open(path, 'r', encoding='utf-8') as f:
        src = f.read()

    anchor = src.find('VERSION_NOTES')
    if anchor < 0:
        die('%s 里找不到 VERSION_NOTES' % SETTINGS_PAGE)
    body = src[anchor:]

    key = "'%s':" % version
    i = body.find(key)
    if i < 0:
        die('VERSION_NOTES 里没有 %s 的条目 —— 发版前必须在 SettingsPage.tsx 补一条'
            '（install-local.py 也会硬校验这一项）' % version)

    j = i + len(key)
    while j < len(body) and body[j] in ' \t\r\n':
        j += 1
    if j >= len(body) or body[j] != "'":
        die('VERSION_NOTES 里 %s 的值不是单引号字符串' % version)
    try:
        notes, _ = read_ts_string(body, j)
    except ValueError as e:
        die('VERSION_NOTES 里 %s 的说明解析失败：%s' % (version, e))
    if not notes.strip():
        die('VERSION_NOTES 里 %s 的说明是空的' % version)
    return notes


def now_stamp():
    """本机时区的 ISO8601（带偏移），如 2026-09-21T12:05:32+08:00。"""
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def artifact(upd_dir, name):
    p = os.path.join(upd_dir, name)
    if not os.path.isfile(p):
        die('产物不存在：%s' % p)
    return {'url': name, 'size': os.path.getsize(p), 'sha256': sha256_file(p)}, p


def build_doc(out_dir, version, notes, critical, published_at, upd_dir):
    asar_ref, zip_path = artifact(upd_dir, PATCH_TMPL % (PRODUCT_NAME, version))
    packages = {'asar': asar_ref}

    portable_name = PORTABLE_TMPL % (PRODUCT_NAME, version)
    if os.path.isfile(os.path.join(upd_dir, portable_name)):
        warn('产物里还有便携版整包 %s —— v1.0.24 起不该再产出它，'
             '检查 scripts/make-update.py 是否被改回去了' % portable_name)
        # 老产物复算时仍然带上，保证历史清单能原样重建
        packages['portable'] = artifact(upd_dir, portable_name)[0]

    stamp = published_at or now_stamp()
    doc = {
        'schema': SCHEMA,
        'productName': PRODUCT_NAME,
        'appId': APP_ID,
        'channel': CHANNEL,
        'generatedAt': now_stamp(),
        'latest': {
            'version': version,
            'publishedAt': stamp,
            'notes': notes,
            'critical': bool(critical),
            'packages': packages,
        },
    }
    return doc, zip_path


def self_check(doc, text, zip_path):
    """按客户端的硬校验重读一遍 —— 生成的清单必须自己先认识。"""
    back = json.loads(text)  # 顺带证明「写出来的就是合法 JSON」
    for k, want in (('schema', SCHEMA), ('productName', PRODUCT_NAME),
                    ('appId', APP_ID), ('channel', CHANNEL)):
        if back.get(k) != want:
            die('自检失败：%s = %r，应为 %r' % (k, back.get(k), want))
    if not re.match(r'^\d+\.\d+\.\d+$', str(back['latest'].get('version', ''))):
        die('自检失败：version 不是合法版本号')
    ref = (back['latest'].get('packages') or {}).get('asar')
    if not ref or not ref.get('url'):
        die('自检失败：packages.asar 缺失（客户端会当作「这一版没有你这种形态的包」）')
    if ref['size'] != os.path.getsize(zip_path):
        die('自检失败：asar.size 与文件实际字节数不符')
    if ref['sha256'].lower() != sha256_file(zip_path):
        die('自检失败：asar.sha256 与文件实际摘要不符')
    if not str(back['latest'].get('notes') or '').strip():
        die('自检失败：notes 为空')


def do_check(out_dir, version, upd_dir):
    """--check：不写盘，只校验现有 latest.json 与产物是否还对得上（上线自检第一步）。"""
    manifest_path = os.path.join(upd_dir, 'latest.json')
    if not os.path.isfile(manifest_path):
        die('最新清单不存在：%s（先跑一次不带 --check 的生成）' % manifest_path)
    doc = read_json(manifest_path)
    problems = []

    if doc.get('schema') != SCHEMA or doc.get('productName') != PRODUCT_NAME \
            or doc.get('appId') != APP_ID or doc.get('channel') != CHANNEL:
        problems.append('身份四件套不对（客户端会直接拒绝）')
    got = str((doc.get('latest') or {}).get('version') or '')
    if got != version:
        problems.append('清单版本 %s ≠ 产物版本 %s' % (got, version))
    ref = ((doc.get('latest') or {}).get('packages') or {}).get('asar')
    if not ref:
        problems.append('packages.asar 缺失')
    else:
        p = os.path.join(upd_dir, os.path.basename(str(ref.get('url') or '')))
        if not os.path.isfile(p):
            problems.append('url 指向的文件不存在：%s' % ref.get('url'))
        else:
            if ref.get('size') != os.path.getsize(p):
                problems.append('size 不符：清单 %s / 实际 %s' % (ref.get('size'), os.path.getsize(p)))
            real = sha256_file(p)
            if str(ref.get('sha256') or '').lower() != real:
                problems.append('sha256 不符：清单 %s / 实际 %s'
                                % (str(ref.get('sha256'))[:16] + '…', real[:16] + '…'))
    if not str((doc.get('latest') or {}).get('notes') or '').strip():
        problems.append('notes 为空')

    if problems:
        print('[make-manifest] --check 不通过：')
        for p in problems:
            print('  ✗ %s' % p)
        sys.exit(1)

    print('[make-manifest] --check 通过：%s' % manifest_path)
    print('  version = %s   asar = %s bytes / sha256 %s…'
          % (got, ref.get('size'), str(ref.get('sha256'))[:16]))
    print('  可以上传（记得先传包，latest.json 最后传）')
    return 0


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:  # noqa: BLE001  （老 Python / 重定向场景）
        pass

    ap = argparse.ArgumentParser(description='生成 out-vX/update/latest.json')
    ap.add_argument('--out', help='产物目录，如 out-v1.0.24（默认按 package.json 版本推 out-v<版本>）')
    ap.add_argument('--version', help='清单版本（默认：产物目录名里的版本，否则 package.json）')
    ap.add_argument('--notes', help='更新说明（默认从 SettingsPage.tsx 的 VERSION_NOTES 抠）')
    ap.add_argument('--critical', action='store_true', help='标记为关键更新')
    ap.add_argument('--published-at', help='发布时间（默认当前时间，带本机时区偏移）')
    ap.add_argument('--force', action='store_true',
                    help='允许清单版本 ≠ package.json 版本（只用于复算历史产物）')
    ap.add_argument('--check', action='store_true', help='只校验现有清单与产物是否一致，不写盘')
    args = ap.parse_args()

    pkg_path = os.path.join(ROOT, 'package.json')
    if not os.path.isfile(pkg_path):
        die('找不到 package.json：%s' % pkg_path, 2)
    pkg_version = str(read_json(pkg_path).get('version') or '').strip()
    if not re.match(r'^\d+\.\d+\.\d+$', pkg_version):
        die('package.json 里的 version 不是合法版本号：%r' % pkg_version, 2)

    out_dir = args.out or ('out-v%s' % pkg_version)
    m = VERSION_RE.match(os.path.basename(out_dir.rstrip('/\\')))
    dir_version = m.group(1) if m else None
    version = args.version or dir_version or pkg_version

    upd_dir = os.path.join(ROOT, out_dir, 'update')
    if not os.path.isdir(upd_dir):
        die('产物目录不存在：%s（先跑 python scripts/build.py --out %s）' % (upd_dir, out_dir), 2)

    # 版本三方一致 —— 这是手工流程最容易埋雷的地方：
    # 拿旧产物的包、写新版本的清单，sha256 照样对得上，客户端也会照装，只是装上去还是旧代码。
    if not args.force:
        if dir_version and dir_version != version:
            die('清单版本 %s 与产物目录 %s 不符 —— 要复算历史清单请加 --force'
                % (version, dir_version))
        if pkg_version != version:
            die('清单版本 %s 与 package.json 的 %s 不符 —— 发版前先把 package.json 改了；'
                '复算历史清单请加 --force' % (version, pkg_version))

    if args.check:
        return do_check(out_dir, version, upd_dir)

    notes = args.notes if args.notes is not None else extract_notes(version)
    doc, zip_path = build_doc(out_dir, version, notes, args.critical, args.published_at, upd_dir)
    text = json.dumps(doc, ensure_ascii=False, indent=2) + '\n'
    self_check(doc, text, zip_path)

    manifest_path = os.path.join(upd_dir, 'latest.json')
    with open(manifest_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)

    print('已写 %s（版本 %s%s）' % (manifest_path, version, '，关键更新' if doc['latest']['critical'] else ''))
    for k, v in doc['latest']['packages'].items():
        print('  %-9s size=%-10s sha256=%s…  url=%s' % (k, v['size'], v['sha256'][:16], v['url']))
    print('  notes 长度 = %d 字' % len(notes))
    print('  下一步：先传包、latest.json 最后传；传完跑 python scripts/make-manifest.py --out %s --check'
          % out_dir)
    return 0


if __name__ == '__main__':
    sys.exit(main())
