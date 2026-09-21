#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 App 启动图标的 PNG 回退资源。

为什么需要：`mipmap-anydpi-v26/ic_launcher.xml` 只在 Android 8+ 生效，
更老的系统（minSdk=21）会去找 `mipmap-*dpi/ic_launcher.png`，
找不到就是**安装后图标空白/崩溃**（ActivityNotFound 之类的怪问题）。

本脚本不引 Pillow（本机 PyPI 不通），直接手写最简 PNG 编码器：
  PNG = 8 字节签名 + IHDR + IDAT(zlib deflate) + IEND
zlib 是 Python 标准库自带的，够用。
"""

import os
import struct
import zlib

# 图标尺寸 → 密度目录映射（Android 标准）
DENSITIES = [
    ("mdpi", 48),
    ("hdpi", 72),
    ("xhdpi", 96),
    ("xxhdpi", 144),
    ("xxxhdpi", 192),
]

# 配色（与前台矢量保持一致）
BG = (0x16, 0x18, 0x1D)
BAR = (0x5D, 0xCA, 0xA5)
BAR2 = (0x7F, 0x77, 0xDD)
SLASH = (0xF0, 0x99, 0x7B)


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, size: int, pixels):
    """pixels: 二维列表，每项 (r,g,b,a)"""
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        for x in range(size):
            r, g, b, a = pixels[y][x]
            raw += bytes((r, g, b, a))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    body = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(body)


def render(size: int):
    """画一个把「信号条 + 斜杠」放在圆角方形背景上的图标"""
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    radius = size * 0.22          # 圆角半径
    cx, cy = size / 2.0, size / 2.0

    def in_round_rect(x, y):
        # 四角圆弧判定
        for sx, sy in ((radius, radius), (size - radius, radius),
                       (radius, size - radius), (size - radius, size - radius)):
            if (x < radius or x > size - radius) and (y < radius or y > size - radius):
                # 在角落区域，检查是否落在对角圆心之外
                ox = radius if x < radius else size - radius
                oy = radius if y < radius else size - radius
                if (x - ox) ** 2 + (y - oy) ** 2 > radius ** 2:
                    return False
        return True

    for y in range(size):
        for x in range(size):
            if in_round_rect(x + 0.5, y + 0.5):
                px[y][x] = (*BG, 255)

    def fill_rect(x0f, y0f, x1f, y1f, color):
        x0, x1 = int(x0f * size), int(x1f * size)
        y0, y1 = int(y0f * size), int(y1f * size)
        for yy in range(max(0, y0), min(size, y1)):
            for xx in range(max(0, x0), min(size, x1)):
                if px[yy][xx][3] > 0:
                    px[yy][xx] = (*color, 255)

    # 四根信号条（相对坐标，与矢量一致）
    fill_rect(0.278, 0.611, 0.352, 0.778, BAR)
    fill_rect(0.389, 0.519, 0.463, 0.778, BAR)
    fill_rect(0.500, 0.426, 0.574, 0.778, BAR)
    fill_rect(0.611, 0.556, 0.685, 0.778, BAR2)

    # 斜杠：用点到线段距离画一条粗线
    ax, ay = 0.259 * size, 0.690 * size
    bx, by = 0.741 * size, 0.273 * size
    thick = max(1.4, size * 0.032)
    dx, dy = bx - ax, by - ay
    lensq = dx * dx + dy * dy
    for y in range(size):
        for x in range(size):
            if px[y][x][3] == 0:
                continue
            t = ((x - ax) * dx + (y - ay) * dy) / lensq
            t = max(0.0, min(1.0, t))
            px0, py0 = ax + t * dx, ay + t * dy
            if (x - px0) ** 2 + (y - py0) ** 2 <= (thick / 2) ** 2:
                px[y][x] = (*SLASH, 255)

    return px


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.join(here, "app", "src", "main", "res")

    for dens, size in DENSITIES:
        d = os.path.join(root, f"mipmap-{dens}")
        os.makedirs(d, exist_ok=True)
        out = os.path.join(d, "ic_launcher.png")
        write_png(out, size, render(size))
        print(f"OK {out} ({size}x{size})")

    # roundIcon 也指同一个文件即可（adaptive 会自动裁形）
    print("done")


if __name__ == "__main__":
    main()
