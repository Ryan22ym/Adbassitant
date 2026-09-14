"""读取 Windows PE 文件的 VS_VERSIONINFO 资源，提取关键版本字段。

用途：验证 electron-builder 是否成功改写了 exe 的版本资源。
electron.exe 依靠自身 PE 版本资源中的 ProductName / FileDescription /
OriginalFilename 等字段判断"我是 electron 运行时"还是"我是打包后的应用"。
若这些字段仍是 electron 原值（或为空），exe 会退回 node 模式。
"""
import struct
import sys


def read_pe(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:2] != b'MZ':
        raise SystemExit('不是 PE 文件')
    pe_off = struct.unpack_from('<I', data, 0x3C)[0]
    if data[pe_off:pe_off + 4] != b'PE\x00\x00':
        raise SystemExit('PE 签名错误')
    machine, nsec, _, _, _, opt_size, _ = struct.unpack_from('<HHIIIHH', data, pe_off + 4)
    opt_off = pe_off + 24
    magic = struct.unpack_from('<H', data, opt_off)[0]
    is_plus = magic == 0x20B
    # 数据目录起始偏移：PE32=96, PE32+=112
    dd_off = opt_off + (112 if is_plus else 96)
    # 资源目录是第 3 个（index 2）
    rsrc_rva, rsrc_size = struct.unpack_from('<II', data, dd_off + 2 * 8)
    # 节表
    sec_off = opt_off + opt_size
    sections = []
    for i in range(nsec):
        base = sec_off + i * 40
        name = data[base:base + 8].rstrip(b'\x00').decode('latin1')
        vsize, vaddr, rsize, raddr = struct.unpack_from('<IIII', data, base + 8)
        sections.append((name, vaddr, vsize, raddr, rsize))
    return data, rsrc_rva, rsrc_size, sections


def rva_to_off(sections, rva):
    for _n, vaddr, vsize, raddr, rsize in sections:
        if vaddr <= rva < vaddr + max(vsize, rsize):
            return raddr + (rva - vaddr)
    return None


def find_version_strings(data, base, size):
    """在资源块里粗扫 UTF-16LE 字符串，不做完整树解析。"""
    blob = data[base:base + size]
    out = {}
    # 常见键名
    keys = ['FileDescription', 'ProductName', 'CompanyName', 'FileVersion',
            'ProductVersion', 'OriginalFilename', 'InternalName', 'LegalCopyright',
            'Assembly Version', 'SpecialBuild']
    for k in keys:
        kb = (k + '\x00').encode('utf-16-le')
        idx = blob.find(kb)
        if idx < 0:
            continue
        # 键后是 Value（UTF-16 字符串），跳过填充
        p = idx + len(kb)
        # 对齐到 4 字节
        while p < len(blob) and blob[p] == 0:
            p += 1
        # 读取到下一个 0x0000
        end = p
        while end + 1 < len(blob) and not (blob[end] == 0 and blob[end + 1] == 0):
            end += 2
        try:
            val = blob[p:end].decode('utf-16-le', errors='replace')
        except Exception:
            val = ''
        out[k] = val
    return out


def main():
    path = sys.argv[1]
    data, rsrc_rva, rsrc_size, sections = read_pe(path)
    print(f'文件: {path}')
    print(f'大小: {len(data) / 1024 / 1024:.2f} MB')
    print(f'资源目录 RVA=0x{rsrc_rva:x} size={rsrc_size}')
    if not rsrc_rva:
        print('!! 无资源目录')
        return
    off = rva_to_off(sections, rsrc_rva)
    print(f'资源文件偏移: 0x{off:x}' if off is not None else '资源偏移解析失败')
    if off is None:
        return
    vals = find_version_strings(data, off, rsrc_size)
    print('\n--- 版本资源字符串 ---')
    if not vals:
        print('  (未找到任何版本字符串)')
    for k, v in vals.items():
        print(f'  {k:<20} = {v!r}')


if __name__ == '__main__':
    main()
