#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成「明日方舟」主题专用的应用内 logo：src/assets/logo-arknights.png

背景
  侧栏品牌标记一直是 src/assets/app-icon.png（蓝→绿渐变描边 + 浅色内屏 + 深蓝字形）。
  切到明日方舟主题（白面板 + 近黑侧栏 + 标志蓝 #49aefb）之后，
  那枚图标里的**绿色端点**和整屏的「黑白 + 纯蓝」对不上 ——
  所以给该主题单独配一枚 logo。**只用在应用界面里**，
  exe / 任务栏 / 快捷方式 / 安装包图标一律不变（那些走 scripts/make-icon.py）。

用户要求
  「风格适配、**形与轮廓不变**，颜色换成这个主题的颜色」（与原神那枚同一个要求）

做法（与原神脚本同构，只换目标色）
  逐像素做「材质分离 → 换色」，而不是照着原图重画一遍：
    彩色描边（高饱和）→ 蓝渐变（按原色相映射，保留原来的渐变方向）
    浅色内屏（高亮低饱和）→ 纯白（按原亮度映射，保留原来的明暗层次）
    深色字形（低亮度，即终端提示符 > 和光标 _）→ 近黑 #16181c
  alpha 原样保留。
  这样能保证几何**逐像素**与主图标一致 —— 圆角、顶部缺口、字形笔宽都不需要重新对位，
  重画则一定会有偏差。

配色取自 src/styles/theme-arknights.css（改主题配色时同步改下面这组常量）
用法
  python scripts/make-logo-arknights.py
"""
import colorsys
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'build', 'icon.png')          # 1024 源图（同 make-icon.py 的产物）
OUT = os.path.join(ROOT, 'src', 'assets', 'logo-arknights.png')
OUT_SIZE = 128

# ---- 目标配色（与 theme-arknights.css 同源）------------------------------
# 描边的深浅两端。
# ⚠️ 深端别压太黑：logo 在界面上只有 30px，深端一暗，整枚图标会缩成
#    「一块蓝糊」，蓝色在近黑侧栏上的辨识度全丢。所以深端仍保持在
#    可辨认的蓝（明度 ≈ 0.70），只比亮端暗一档。
BLUE_BRIGHT = (0x7C, 0xC8, 0xFF)  # #6ec1ff 系：描边亮端（原色相的「绿」端）
BLUE_DEEP = (0x16, 0x74, 0xB4)    # #1674b4 系：描边深端（原色相的「蓝」端）
# 两端之间的中点正好落在 #49aefb 附近 —— 也就是图1 蓝色订单卡那个标志蓝。
PAPER = (0xFF, 0xFF, 0xFF)        # --a-paper：内屏亮部（纯白，图3 面板）
PAPER_DIM = (0xEE, 0xF2, 0xF6)    # --a-paper-2 系：内屏暗部（冷浅灰）
INK = (0x16, 0x18, 0x1C)          # --a-ink：字形（近黑，图2 弹窗底）

# 原图描边的色相范围（实测：绿端 ~150°、蓝端 ~220°），用来定位渐变参数
HUE_LO = 150.0
HUE_HI = 220.0

DARK_V = 0.45     # 亮度低于此值 → 字形
RIM_SAT = 0.22    # 饱和度高于此值 → 描边


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def clamp01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def recolor(r, g, b):
    """单个像素换色（不含 alpha）。"""
    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)

    if v < DARK_V:
        return INK

    if s > RIM_SAT:
        # 描边：色相决定「蓝阶」。绿端(hue→HUE_LO) = 亮蓝，蓝端(hue→HUE_HI) = 深蓝，
        # 于是原来那条蓝→绿的斜向渐变，换成等价的亮蓝→深蓝渐变，方向一致。
        t = clamp01((h * 360.0 - HUE_LO) / (HUE_HI - HUE_LO))
        return lerp(BLUE_BRIGHT, BLUE_DEEP, t)

    # 内屏：用亮度在白的「亮-暗」之间插值，保留原图的明暗层次（不会压成一块死白）
    return lerp(PAPER, PAPER_DIM, clamp01((v - 0.72) / (0.98 - 0.72)))


def main():
    if not os.path.exists(SRC):
        print('x 源图不存在: %s（先跑 scripts/make-icon.py）' % SRC)
        return 1

    img = Image.open(SRC).convert('RGBA')
    px = img.load()
    w, h = img.size

    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            nr, ng, nb = recolor(r, g, b)
            px[x, y] = (nr, ng, nb, a)

    out = img.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.save(OUT, 'PNG')

    # 复核：四角必须仍是透明的（换色别把 alpha 弄丢），
    # 且内屏像素确实是白系（不是原来那种偏青的白），描边确实是蓝（B > R）。
    corners = [(0, 0), (OUT_SIZE - 1, 0), (0, OUT_SIZE - 1), (OUT_SIZE - 1, OUT_SIZE - 1)]
    op = out.load()
    opaque = [p for p in corners if op[p][3] > 16]

    print('OK  %s  %d bytes  %dx%d'
          % (os.path.relpath(OUT, ROOT), os.path.getsize(OUT), OUT_SIZE, OUT_SIZE))
    for p in [(64, 64), (40, 64), (20, 64), (64, 20), (33, 64)]:
        r, g, b, a = op[p]
        print('      px%-10s a=%3d  #%02x%02x%02x' % (str(p), a, r, g, b))

    if opaque:
        print('x 四角不透明: %s' % opaque)
        return 1

    # 左侧描边带中点（x 比例 0.256 / y 0.5）必须偏蓝
    r, g, b, a = op[(int(0.256 * OUT_SIZE), OUT_SIZE // 2)]
    if not (a > 200 and b > r + 20):
        print('x 描边不是蓝色系: #%02x%02x%02x a=%d' % (r, g, b, a))
        return 1
    print('OK  描边偏蓝 (B-R=%d)' % (b - r))
    return 0


if __name__ == '__main__':
    sys.exit(main())
