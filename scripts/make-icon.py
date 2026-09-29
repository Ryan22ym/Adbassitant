#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从一张 1024×1024 的源图生成应用图标产物（可重复执行）。

产物：
  build/icon.png   1024×1024  —— 图标源图（也是 Linux / 通用分支用的那份）
  build/icon.ico   多尺寸     —— electron-builder 打 exe / 安装程序 / 卸载程序用
  bin/icon.png     1024×1024  —— 随包的图标文件（scrcpy portable icon 同目录那份）

为什么要脚本而不是手工切图：
  图标一改就得同时更新三个文件，而且 ico 必须含 16/32/48/256 多个尺寸
  （少了小尺寸，任务栏和资源管理器里会被系统糊成马赛克）。
  手工做一次就会忘一次。

用法：
  python scripts/make-icon.py <源图.png> [--keep-corner]
  --keep-corner  不做右下角「水印残影」修补（源图本身干净时用）
"""
import argparse
import os
import sys

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CANVAS = 1024
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def clean_corner(img):
    """
    抹掉源图右下角那块淡淡的模型水印残影。

    区域是纯渐变背景（手机图形居中，碰不到这个角），所以直接拿「大半径高斯模糊版」
    盖上去就等价于重建背景 —— 比手工取色补丁干净，也不会留下矩形边界。
    用带羽化的矩形蒙版只覆盖右下角，避免动到中间的图形。
    """
    blurred = img.filter(ImageFilter.GaussianBlur(90))

    w, h = img.size
    x0, y0 = int(w * 0.78), int(h * 0.86)
    feather = 60

    mask = Image.new('L', (w, h), 0)
    px = mask.load()
    for y in range(y0, h):
        for x in range(x0, w):
            # 到左边 / 上边的距离，越小越「靠里」，用来做羽化过渡
            fx = min(1.0, (x - x0) / feather)
            fy = min(1.0, (y - y0) / feather)
            px[x, y] = int(255 * min(fx, fy))

    out = img.copy()
    out.paste(blurred, (0, 0), mask)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--keep-corner', action='store_true')
    args = ap.parse_args()

    src = args.src
    if not os.path.isabs(src):
        src = os.path.join(ROOT, src)
    if not os.path.exists(src):
        print('x 源图不存在: %s' % src)
        return 1

    img = Image.open(src).convert('RGBA')
    if img.size != (CANVAS, CANVAS):
        img = img.resize((CANVAS, CANVAS), Image.LANCZOS)

    if not args.keep_corner:
        img = clean_corner(img)

    png_path = os.path.join(ROOT, 'build', 'icon.png')
    ico_path = os.path.join(ROOT, 'build', 'icon.ico')
    bin_path = os.path.join(ROOT, 'bin', 'icon.png')

    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    img.save(png_path, 'PNG')

    # ICO 必须从最大尺寸往里收：小尺寸由 Pillow 逐级重采样，比只手写 256 清楚得多
    img.save(ico_path, 'ICO', sizes=[(s, s) for s in ICO_SIZES])

    os.makedirs(os.path.dirname(bin_path), exist_ok=True)
    img.save(bin_path, 'PNG')

    # 复核：ico 里到底塞了几个尺寸，别只看文件生成成功
    with Image.open(ico_path) as ico:
        got = sorted(ico.info.get('sizes', set()))
    print('OK  build/icon.png  %d bytes' % os.path.getsize(png_path))
    print('OK  bin/icon.png    %d bytes' % os.path.getsize(bin_path))
    print('OK  build/icon.ico  %d bytes  sizes=%s'
          % (os.path.getsize(ico_path), [s[0] for s in got]))

    want = set(ICO_SIZES)
    have = set(s[0] for s in got)
    if not want.issubset(have):
        print('x ico 缺少尺寸: %s' % sorted(want - have))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
