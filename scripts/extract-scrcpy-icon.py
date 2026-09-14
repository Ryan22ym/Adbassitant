# -*- coding: utf-8 -*-
"""从 scrcpy.exe 中提取图标资源，生成 .ico 文件。

用途：投屏窗口需要显示 scrcpy 原生图标，与应用图标区分开。
思路：解析 PE 资源节，取出 RT_GROUP_ICON + RT_ICON，按 ICO 容器格式重新组装。
用法：python extract-scrcpy-icon.py [scrcpy.exe 路径] [输出 .ico 路径]
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def rva_to_off(secs, rva):
    for _name, va, vsz, ra, rsz in secs:
        if va <= rva < va + max(vsz, rsz):
            return ra + (rva - va)
    return None


def parse_pe(data):
    pe = struct.unpack_from('<I', data, 0x3C)[0]
    assert data[pe:pe + 4] == b'PE\x00\x00', '不是有效的 PE 文件'
    nsec = struct.unpack_from('<H', data, pe + 6)[0]
    opt = pe + 24
    magic = struct.unpack_from('<H', data, opt)[0]
    pe32plus = magic == 0x20B
    nrva_off = opt + (108 if pe32plus else 92)
    nrv = struct.unpack_from('<I', data, nrva_off)[0]
    dd = nrva_off + 4
    rsrc_rva, _rsrc_size = struct.unpack_from('<II', data, dd + 2 * 8)

    sec_off = opt + struct.unpack_from('<H', data, pe + 20)[0]
    secs = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = data[o:o + 8].rstrip(b'\x00').decode('latin1')
        vsz, va, rsz, ra = struct.unpack_from('<IIII', data, o + 8)
        secs.append((name, va, vsz, ra, rsz))
    return secs, rsrc_rva


def collect_icons(data):
    """返回 {rt_icon_id: bytes} 与 group 信息列表"""
    secs, rsrc_rva = parse_pe(data)
    base = rva_to_off(secs, rsrc_rva)
    if base is None:
        raise SystemExit('未找到资源节')

    icons = {}      # id -> raw image bytes
    groups = {}     # group id -> 资源目录项列表

    def walk(off, depth, path):
        if depth > 3:
            return
        nnamed, nid = struct.unpack_from('<HH', data, off + 12)
        for i in range(nnamed + nid):
            e = off + 16 + i * 8
            ident, offv = struct.unpack_from('<II', data, e)
            if offv & 0x80000000:
                # 子目录：目标偏移相对资源节起始
                walk(base + (offv & 0x7FFFFFFF), depth + 1, path + (ident,))
            else:
                # 叶子：数据项，存的是 RVA（相对镜像基址）
                rva, size = struct.unpack_from('<II', data, base + offv)
                fo = rva_to_off(secs, rva)
                raw = data[fo:fo + size]
                if depth >= 1 and path and path[0] == 3 and len(path) >= 2:   # RT_ICON
                    icons[path[-1]] = raw
                elif depth >= 1 and path and path[0] == 14 and len(path) >= 2:  # RT_GROUP_ICON
                    groups[path[-1]] = raw

    walk(base, 0, ())
    out = []
    for _gid, raw in groups.items():
        _r, _t, count = struct.unpack_from('<HHH', raw, 0)
        for i in range(count):
            o = 6 + i * 14
            w, h, colors, _res, planes, bpp, size, iid = struct.unpack_from('<BBBBHHIH', raw, o)
            img = icons.get(iid)
            if img is None:
                continue
            out.append({
                'w': w or 256, 'h': h or 256, 'colors': colors,
                'planes': planes, 'bpp': bpp, 'size': len(img), 'data': img,
            })
        break
    return out


def build_ico(entries, out_path):
    """把若干图标数据组装成 ICO 文件"""
    entries = sorted(entries, key=lambda x: -x['w'])
    header = struct.pack('<HHH', 0, 1, len(entries))
    dir_size = 6 + 16 * len(entries)
    offset = dir_size
    dirs = b''
    blobs = b''
    for e in entries:
        dirs += struct.pack(
            '<BBBBHHII',
            0 if e['w'] >= 256 else e['w'],
            0 if e['h'] >= 256 else e['h'],
            e['colors'], 0, e['planes'] or 1, e['bpp'] or 32,
            len(e['data']), offset,
        )
        blobs += e['data']
        offset += len(e['data'])
    with open(out_path, 'wb') as f:
        f.write(header + dirs + blobs)
    return len(entries)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'bin', 'scrcpy.exe')
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'build', 'scrcpy.ico')
    data = open(src, 'rb').read()
    entries = collect_icons(data)
    if not entries:
        raise SystemExit('scrcpy.exe 中未找到图标资源')
    n = build_ico(entries, dst)
    print(f'已生成 {dst}（{n} 个尺寸: {sorted(e["w"] for e in entries)}）')


if __name__ == '__main__':
    main()
