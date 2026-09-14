"""扫描 node_modules，找出被镜像安装截断的包（空 lib 目录 / 缺少入口引用的文件）"""
import os, json, sys, re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'node_modules')


def check_pkg(pkg_dir):
    """返回可疑问题列表"""
    issues = []
    pj = os.path.join(pkg_dir, 'package.json')
    if not os.path.exists(pj):
        return issues
    try:
        meta = json.load(open(pj, encoding='utf-8'))
    except Exception:
        return [('package.json 无法解析', '')]

    # 1) 关键目录为空
    for sub in ('lib', 'out', 'dist'):
        d = os.path.join(pkg_dir, sub)
        if os.path.isdir(d) and not os.listdir(d):
            issues.append((f'{sub}/ 为空目录', ''))

    # 2) main 字段指向的文件缺失
    main = meta.get('main')
    if isinstance(main, str):
        cand = os.path.join(pkg_dir, main)
        if not os.path.exists(cand) and not os.path.exists(cand + '.js'):
            issues.append((f'main 缺失: {main}', ''))

    # 3) 入口 js 中相对 require 的目标缺失
    entry = None
    for cand in (main, 'index.js'):
        if isinstance(cand, str):
            p = os.path.join(pkg_dir, cand)
            if os.path.isfile(p):
                entry = p
                break
    if entry:
        try:
            src = open(entry, encoding='utf-8', errors='replace').read()
        except Exception:
            return issues
        for m in re.finditer(r"require\(['\"](\.[^'\"]+)['\"]\)", src):
            rel = m.group(1)
            target = os.path.normpath(os.path.join(os.path.dirname(entry), rel))
            if not (os.path.exists(target) or os.path.exists(target + '.js')
                    or os.path.exists(os.path.join(target, 'index.js'))):
                issues.append((f'入口引用缺失: {rel}', ''))
    return issues


def main():
    broken = []
    for name in sorted(os.listdir(ROOT)):
        if name.startswith('.'):
            continue
        pkg = os.path.join(ROOT, name)
        if not os.path.isdir(pkg):
            continue
        issues = check_pkg(pkg)
        if issues:
            broken.append((name, issues))
            print(f'[BROKEN] {name}')
            for msg, _ in issues:
                print(f'         - {msg}')
        # 处理 @scope/xxx
        if name.startswith('@'):
            for sub in sorted(os.listdir(pkg)):
                sp = os.path.join(pkg, sub)
                if not os.path.isdir(sp):
                    continue
                sissues = check_pkg(sp)
                if sissues:
                    broken.append((f'{name}/{sub}', sissues))
                    print(f'[BROKEN] {name}/{sub}')
                    for msg, _ in sissues:
                        print(f'         - {msg}')
    print()
    print(f'共发现 {len(broken)} 个可疑包')
    # 输出可直接用于重装的包名
    print('REINSTALL:', ' '.join(n for n, _ in broken))


if __name__ == '__main__':
    main()
