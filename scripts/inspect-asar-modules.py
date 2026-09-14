"""列出 asar 内 node_modules 明细，判断依赖是否被异常裁剪。"""
import json
import os
import struct
import sys


def read_asar(path):
    with open(path, 'rb') as f:
        raw = f.read(16)
        _a, _b, _c, json_len = struct.unpack('<4I', raw)
        header = f.read(json_len).decode('utf-8', errors='replace')
    return json.loads(header)


def walk(node, prefix=''):
    out = []
    for name, meta in node.get('files', {}).items():
        full = prefix + name
        if 'files' in meta:
            out.extend(walk(meta, full + '/'))
        else:
            out.append((full, meta.get('size', 0)))
    return out


path = sys.argv[1] if len(sys.argv) > 1 else r'D:\WorkSpace\手机助手\adb-assistant-v0.9\dist-release\win-unpacked\resources\app.asar'
tree = read_asar(path)
files = walk(tree)

pkgs = {}
for name, size in files:
    if not name.startswith('node_modules/'):
        continue
    rest = name[len('node_modules/'):]
    parts = rest.split('/')
    if parts[0].startswith('@') and len(parts) > 1:
        key = parts[0] + '/' + parts[1]
        sub = '/'.join(parts[2:])
    else:
        key = parts[0]
        sub = '/'.join(parts[1:])
    pkgs.setdefault(key, []).append((sub, size))

print(f'node_modules 包数: {len(pkgs)}')
print()
for k in sorted(pkgs):
    items = pkgs[k]
    total = sum(s for _n, s in items)
    print(f'  {k:<40} {len(items):>3} 文件 {total / 1024:>9.1f} KB')
    for sub, s in sorted(items)[:6]:
        print(f'        {sub:<46} {s:>9}')
    if len(items) > 6:
        print(f'        ... 其余 {len(items) - 6} 个')
