"""解析 app.asar 头部，列出打包进去的文件清单。

asar 格式：
  [0:4]   uint32 = 4            (pickle 头长度字段)
  [4:8]   uint32 = headerSize   (size pickle 的字节数)
  [8:12]  uint32 = headerSize   (重复)
  [12:16] uint32 = jsonStrLen   (头部 JSON 长度)
  [16:16+jsonStrLen] UTF-8 JSON
之后是文件数据区。
"""
import json
import os
import struct
import sys


def read_asar(path):
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        raw = f.read(16)
        _a, _b, _c, json_len = struct.unpack('<4I', raw)
        header = f.read(json_len).decode('utf-8', errors='replace')
    return json.loads(header), size


def walk(node, prefix=''):
    out = []
    for name, meta in node.get('files', {}).items():
        full = prefix + name
        if 'files' in meta:
            out.extend(walk(meta, full + '/'))
        else:
            out.append((full, meta.get('size', 0), meta.get('offset', '')))
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else r'D:\WorkSpace\手机助手\adb-assistant-v0.9\dist-release\win-unpacked\resources\app.asar'
    tree, size = read_asar(path)
    files = walk(tree)
    print(f'asar: {path}')
    print(f'大小: {size / 1024 / 1024:.2f} MB')
    print(f'文件总数: {len(files)}')
    print()

    groups = {}
    for name, fsize, _off in files:
        top = name.split('/')[0]
        groups.setdefault(top, []).append((name, fsize))

    for top in sorted(groups):
        items = groups[top]
        total = sum(s for _n, s in items)
        print(f'[ {top}/ ]  {len(items)} 个文件, {total / 1024:.1f} KB')
        if top in ('dist', 'dist-electron'):
            for n, s in sorted(items):
                print(f'    {n:<50} {s:>10}')
        print()


if __name__ == '__main__':
    main()
