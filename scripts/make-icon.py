#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从一张 1024×1024 的源图生成应用图标产物（可重复执行）。

产物：
  build/icon.png              1024×1024  —— 图标源图（也是 Linux / 通用分支用的那份）
  build/icon.ico              多尺寸     —— electron-builder 打 exe / 安装程序 / 卸载程序用
  bin/icon.png                1024×1024  —— 随包的图标文件（scrcpy portable icon 同目录那份）
  electron/assets/app-icon.png  256×256   —— **运行期窗口/任务栏图标**，见下
  electron/assets/app-icon.ico  多尺寸     —— **桌面/开始菜单/任务栏固定项的图标**，见下
  src/assets/app-icon.png       128×128   —— 侧栏 brand-mark 内嵌图（不进 asar，直接进 bundle）

为什么要脚本而不是手工切图：
  图标一改就得同时更新这些文件，而且 ico 必须含 16/32/48/256 多个尺寸
  （少了小尺寸，任务栏和资源管理器里会被系统糊成马赛克）。
  手工做一次就会忘一次。

为什么窗口图标要单独放一份进 electron/assets（而不是只靠 exe 内嵌资源）：
  exe 的图标是**构建时烧进去**的，而在线更新只替换 app.asar 与 resources/bin，
  从不替换 exe —— 所以老版本在线更新之后，exe 里的图标还是旧的。
  把图标作为普通文件放进 asar，运行期用 nativeImage 读它当窗口图标，
  就能让「窗口 + 任务栏」的图标随在线更新一起变新（详见 electron/services/shortcuts.ts）。

为什么要把圆角之外的底色打透明（punch_background）：
  源图是「带底色的圆角方块」贴图 —— 图形四角是接近白的底色，且 alpha 是**不透明**的。
  直接拿去当 ico / 窗口图标，Windows 只会按方形边界渲染：
  任务栏、桌面快捷方式、开始菜单里就成了「四角白色的小方块」。
  （侧栏 brand 那条 img 也一样，只是它压在浅色侧栏上看不出来。）
  所以这里必须把圆角之外那圈底色清掉，让四角真的透明。

用法：
  python scripts/make-icon.py <源图.png> [--keep-corner] [--keep-bg]
  --keep-corner  不做右下角「水印残影」修补（源图本身干净时用）
  --keep-bg      不做圆角之外的底色透明化（源图本身就是透明背景时用）
"""
import argparse
import os
import sys

from PIL import Image, ImageChops, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CANVAS = 1024
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# 底色判定：又亮又灰（低饱和）的像素算「圆角外的那片底」。
# 阈值给得宽一点：底色是**渐变**的，越往右下越偏青绿，卡太死会出现
# 「一部分清了、一部分没清」的花脸（2026-09-30 实测：diff 卡 38 时右半边整片没清）。
BG_MIN_CHANNEL = 168  # 最小通道亮度下限
BG_MAX_DIFF = 72      # 通道最大差值（饱和度）上限
BG_MIN_MAX = 195      # 最大通道亮度下限（把深色图形挡在外面）


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


def punch_background(img):
    """
    把圆角之外的底色打透明（四角变透明，见文件头说明）。

    做法：从四条边的「底色像素」出发做四连通洪水填充，只清掉**与图像边缘连通**的那一片。
    为什么不是简单地把所有浅色像素变透明：图形内部那块白色屏幕（手机图标）也是浅色，
    直接按颜色筛会把屏幕一起挖空。而它被蓝色描边围着、与边缘不连通 —— 洪水填充天然避开。

    清完之后给 alpha 做一次很小的模糊：抗锯齿边缘原本是「底色与图形的混色」，
    硬切会留下锯齿，0.8px 羽化后在小尺寸（16/32px）下不会有毛边。
    """
    w, h = img.size
    px = img.load()

    def is_bg(x, y):
        r, g, b, a = px[x, y]
        if a < 8:
            return True
        mx, mn = max(r, g, b), min(r, g, b)
        return mn > BG_MIN_CHANNEL and (mx - mn) < BG_MAX_DIFF and mx > BG_MIN_MAX

    seen = bytearray(w * h)
    stack = []

    def push(x, y):
        i = y * w + x
        if not seen[i] and is_bg(x, y):
            seen[i] = 1
            stack.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while stack:
        x, y = stack.pop()
        if x > 0:
            push(x - 1, y)
        if x < w - 1:
            push(x + 1, y)
        if y > 0:
            push(x, y - 1)
        if y < h - 1:
            push(x, y + 1)

    clear = Image.new('L', (w, h), 255)
    cp = clear.load()
    cleared = 0
    for y in range(h):
        row = y * w
        for x in range(w):
            if seen[row + x]:
                cp[x, y] = 0
                cleared += 1

    # 一个像素都没清掉 → 要么源图本来就没有底色，要么阈值不适用，别硬改
    if cleared == 0:
        return img, 0

    clear = clear.filter(ImageFilter.GaussianBlur(0.8))
    out = img.copy()
    out.putalpha(ImageChops.multiply(img.getchannel('A'), clear))
    return out, cleared


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--keep-corner', action='store_true')
    ap.add_argument('--keep-bg', action='store_true')
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

    bg_cleared = 0
    if not args.keep_bg:
        img, bg_cleared = punch_background(img)

    png_path = os.path.join(ROOT, 'build', 'icon.png')
    ico_path = os.path.join(ROOT, 'build', 'icon.ico')
    bin_path = os.path.join(ROOT, 'bin', 'icon.png')

    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    img.save(png_path, 'PNG')

    # ICO 必须从最大尺寸往里收：小尺寸由 Pillow 逐级重采样，比只手写 256 清楚得多
    img.save(ico_path, 'ICO', sizes=[(s, s) for s in ICO_SIZES])

    os.makedirs(os.path.dirname(bin_path), exist_ok=True)
    img.save(bin_path, 'PNG')

    # 运行期窗口/任务栏图标 + 快捷方式图标：随 app.asar 走在线更新，见文件头说明
    as_dir = os.path.join(ROOT, 'electron', 'assets')
    os.makedirs(as_dir, exist_ok=True)
    win_png = os.path.join(as_dir, 'app-icon.png')
    win_ico = os.path.join(as_dir, 'app-icon.ico')
    img.resize((256, 256), Image.LANCZOS).save(win_png, 'PNG')
    img.save(win_ico, 'ICO', sizes=[(s, s) for s in ICO_SIZES])

    # 渲染层内嵌图：侧栏那一小块只用到 30px，别把 1MB 的 1024 图打进 bundle
    brand_dir = os.path.join(ROOT, 'src', 'assets')
    os.makedirs(brand_dir, exist_ok=True)
    brand_png = os.path.join(brand_dir, 'app-icon.png')
    img.resize((128, 128), Image.LANCZOS).save(brand_png, 'PNG')

    # 复核：ico 里到底塞了几个尺寸，别只看文件生成成功
    with Image.open(ico_path) as ico:
        got = sorted(ico.info.get('sizes', set()))

    # 复核：四角必须真的透明 —— 「任务栏里四角白方块」就是这么漏出去的
    corners = [(0, 0), (CANVAS - 1, 0), (0, CANVAS - 1), (CANVAS - 1, CANVAS - 1)]
    opaque = [p for p in corners if img.getpixel(p)[3] > 16]

    print('OK  build/icon.png            %d bytes' % os.path.getsize(png_path))
    print('OK  bin/icon.png              %d bytes' % os.path.getsize(bin_path))
    print('OK  build/icon.ico            %d bytes  sizes=%s'
          % (os.path.getsize(ico_path), [s[0] for s in got]))
    print('OK  electron/assets/app-icon.png  %d bytes' % os.path.getsize(win_png))
    print('OK  electron/assets/app-icon.ico  %d bytes  sizes=%s'
          % (os.path.getsize(win_ico), ICO_SIZES))
    print('OK  src/assets/app-icon.png   %d bytes' % os.path.getsize(brand_png))
    print('OK  圆角外底色               清掉 %d 像素（%.1f%%）'
          % (bg_cleared, bg_cleared * 100.0 / (CANVAS * CANVAS)))

    if opaque:
        print('x 四角仍不透明: %s' % opaque)
        return 1

    want = set(ICO_SIZES)
    have = set(s[0] for s in got)
    if not want.issubset(have):
        print('x ico 缺少尺寸: %s' % sorted(want - have))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
