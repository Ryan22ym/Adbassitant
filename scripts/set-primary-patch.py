#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 latest.json 的 `packages.asar` 换成某个「基线变体」（v1.0.31 起）。

为什么需要这个开关
------------------
`baseRuntimeHash` 是**严格相等**校验（`update-core.validateManifest`），一份小包只服务
一种运行库基线。而**已经装在用户机器上的 ≤v1.0.30 客户端只读 `packages.asar` 这一个槽位**，
不认 `variants`（那是 v1.0.31 才加的）。所以对老客户端来说：

    一个版本只能照顾一种基线 —— 照顾了 ≤v1.0.28 那批，1.0.29/1.0.30 那批就装不了，反之亦然。

要两边都救，只能**分两轮**：先让一波升上来（升上来的机器立刻变成 v1.0.31，之后只会看到
「已是最新」，不再受这一轮切换影响），再翻到另一波。这个脚本就是「翻」那一下 ——
只改 `latest.json`，不用重新打包、不用重传 zip，**只需重传 latest.json 一个文件**。

用法
----
  # 看现在指着谁、还有哪些基线可选
  python scripts/set-primary-patch.py --out out-v1.0.31 --list

  # 翻到「基准以 de427368 开头」的那一份（= 照顾还在 1.0.27 / 1.0.28 的机器）
  python scripts/set-primary-patch.py --out out-v1.0.31 --base de427368

  # 翻回主小包（= 照顾紧跟上一版的机器）
  python scripts/set-primary-patch.py --out out-v1.0.31 --primary

翻完记得：**只重传 latest.json**（顺序铁律照旧：latest.json 永远最后传）。
"""
import argparse
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def die(msg, code=3):
    print('[set-primary-patch] 失败：%s' % msg, file=sys.stderr)
    sys.exit(code)


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser(description='切换 latest.json 的 packages.asar 指向哪一份基线变体')
    ap.add_argument('--out', required=True, help='产物目录，如 out-v1.0.31')
    ap.add_argument('--base', help='按 baseRuntimeHash 前缀选（前 8~16 位即可）')
    ap.add_argument('--primary', action='store_true', help='切回主小包（变体列表里的第一份）')
    ap.add_argument('--list', action='store_true', help='只列出可选基线，不写盘')
    ap.add_argument('--dry-run', action='store_true', help='只打印将要做的改动，不写盘')
    args = ap.parse_args()

    upd = os.path.join(ROOT, args.out, 'update')
    latest_path = os.path.join(upd, 'latest.json')
    if not os.path.isfile(latest_path):
        die('找不到 %s（先跑 make-manifest.py）' % latest_path)
    with open(latest_path, 'r', encoding='utf-8') as f:
        doc = json.load(f)

    latest = doc.get('latest') or {}
    packs = latest.get('packages') or {}
    cur = packs.get('asar')
    if not cur or not cur.get('url'):
        die('packages.asar 缺失或没有 url')

    # 候选 = 主小包 + variants（按 url 去重，保持顺序）
    cands = []
    seen = set()
    for ref in [cur] + list(latest.get('variants') or []):
        u = str((ref or {}).get('url') or '')
        if not u or u in seen:
            continue
        seen.add(u)
        cands.append(ref)

    def line(ref, mark=''):
        return '  %s %-11s base=%s  %8.1f KB  %s' % (
            mark,
            '主小包' if ref is cur else '变体',
            (str(ref.get('baseRuntimeHash') or '(未声明)')[:12] + '…'),
            (ref.get('size') or 0) / 1024,
            ref.get('url'),
        )

    if args.list or (not args.base and not args.primary):
        print('当前 packages.asar 指向：%s' % cur.get('url'))
        print('可选基线（★ = 当前指向）：')
        for ref in cands:
            print(line(ref, '★' if ref is cur else ' '))
        if not args.list and not args.base and not args.primary:
            print()
            print('用 --base <前缀> 或 --primary 切换。')
        return 0

    target = None
    if args.primary:
        # variants[0] 就是主小包对应的那份；不在 variants 里就保持原样
        v = latest.get('variants') or []
        target = v[0] if v else cur
        if target is cur:
            print('已经是「主小包」基线的状态，无需改动。')
            return 0
    else:
        pre = str(args.base).strip().lower()
        hit = [r for r in cands if str(r.get('baseRuntimeHash') or '').lower().startswith(pre)]
        if not hit:
            die('没有 baseRuntimeHash 以 %s 开头的变体。用 --list 看可选项。' % pre)
        target = hit[0]

    # 落地前核一遍文件与摘要（清单最怕手改出错）
    p = os.path.join(upd, os.path.basename(str(target.get('url'))))
    if not os.path.isfile(p):
        die('目标包不存在：%s' % p)
    if target.get('size') != os.path.getsize(p):
        die('目标包 size 与清单不符（清单 %s / 实际 %s）' % (target.get('size'), os.path.getsize(p)))
    real = sha256_file(p)
    if str(target.get('sha256') or '').lower() != real:
        die('目标包 sha256 与清单不符（清单 %s / 实际 %s）' % (str(target.get('sha256'))[:16], real[:16]))

    new_ref = {
        'url': target['url'],
        'size': target['size'],
        'sha256': target['sha256'],
    }
    if target.get('baseRuntimeHash'):
        new_ref['baseRuntimeHash'] = target['baseRuntimeHash']

    print('要把 packages.asar 换成：')
    print(line(new_ref))
    print('原：')
    print(line(cur))
    if args.base and args.base.strip().lower() == str(cur.get('baseRuntimeHash') or '').lower()[:len(args.base.strip())]:
        print('（其实已经是这一份，不改动）')
        return 0
    if args.dry_run:
        print('--dry-run：没有写盘。')
        return 0

    packs['asar'] = new_ref
    latest['packages'] = packs
    doc['latest'] = latest
    text = json.dumps(doc, ensure_ascii=False, indent=2) + '\n'
    with open(latest_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)

    print('已写 %s' % latest_path)
    print('🔴 只重传 latest.json 即可（顺序铁律不变：包先传完，latest.json 最后传）')
    print('   传完跑：python scripts/make-manifest.py --out %s --check' % args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
