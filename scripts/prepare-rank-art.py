"""
把剪贴板里的段位原图处理成可直接用的素材：
  1. 从四边 flood fill 抠掉背景（原图背景有黑、深灰、白三种，不抠在浅色卡片上没法看）
  2. 按 alpha 裁掉四周空白
  3. 等比缩到统一高度

输出：src/assets/rank/<name>.png

用法：
  D:/WorkSpace/手机助手/venv-img/Scripts/python.exe scripts/prepare-rank-art.py

只依赖 Pillow（venv-img 里没有 numpy，别再引进来）。
"""
import os
import sys
from collections import deque

from PIL import Image, ImageFilter

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(os.environ['USERPROFILE'], '.workbuddy', 'clipboard-images')
OUT = os.path.join(ROOT, 'src', 'assets', 'rank')

# 剪贴板文件名 -> 目标名 -> 处理模式
#
# plain = 只有暗/亮纯色背景，四边泛洪抠掉即可
# halo  = 背景里还有一团和徽章同色的紫光晕（钻石那张），泛洪抠不掉，
#         需要再按「离实心区的距离」把光晕淡出，见 cut_background_halo
MAPPING = [
    ('clipboard-2026-11-13T04-19-55-307Z-f3f1e2d8.png', 'bronze', 'plain'),
    ('clipboard-2026-11-13T04-19-55-309Z-b08fb00f.png', 'silver', 'plain'),
    ('clipboard-2026-11-13T04-19-55-311Z-e64082ff.png', 'gold', 'plain'),
    ('clipboard-2026-11-13T04-19-55-314Z-d65cf85d.png', 'platinum', 'plain'),
    ('clipboard-2026-11-13T05-26-01-871Z-8536fcb7.png', 'diamond', 'halo'),
    ('clipboard-2026-11-13T04-19-55-317Z-6307be37.png', 'master', 'plain'),
    ('clipboard-2026-11-13T04-19-55-318Z-941e77e3.png', 'king', 'plain'),
]

TARGET_H = 360


def cut_background(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()

    edge = []
    for x in range(w):
        edge.append(px[x, 0])
        edge.append(px[x, h - 1])
    for y in range(h):
        edge.append(px[0, y])
        edge.append(px[w - 1, y])

    n = len(edge)
    bg = tuple(sorted(p[i] for p in edge)[n // 2] for i in range(3))
    bg_lum = sum(bg) / 3.0

    if bg_lum < 100:
        # 暗背景（黑/深灰截图）：判据改成「无彩度 + 足够暗」。
        # 🔴 不能只比 RGB 距离 —— 黄金图外圈是 45 灰、内层是纯黑菱形，中位数落在 20，
        #    单一阈值要么留一圈灰边，要么一路渗进深蓝旗帜。
        limit = bg_lum + 46

        def near(c):
            return max(c) - min(c) <= 14 and (c[0] + c[1] + c[2]) / 3.0 < limit
    else:
        # 浅背景（网页白底）：正常色距，容差压小一点，免得吃掉银白翅膀
        def near(c):
            return abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2]) < 45

    # 只删与边框连通的候选像素，避免把徽章内部的暗部/亮部一起挖空
    visited = bytearray(w * h)
    dq = deque()

    def push(x, y):
        i = y * w + x
        if not visited[i] and near(px[x, y]):
            visited[i] = 1
            dq.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not visited[i] and near(px[nx, ny]):
                    visited[i] = 1
                    dq.append((nx, ny))

    out = im.convert('RGBA')
    op = out.load()
    for y in range(h):
        base = y * w
        row = visited[base:base + w]
        for x in range(w):
            if row[x]:
                op[x, y] = (0, 0, 0, 0)

    # 原图边缘有压缩噪点，会留下 4~10% 的半透明脏边 —— 极淡的一律归零，
    # 剩下的保留一点羽化，缩放后不至于像剪刀剪的
    ap = out.getchannel('A').point(lambda v: 0 if v < 48 else v)
    out.putalpha(ap)

    drop_specks(out)

    # 再腐蚀一遍 alpha：菱形尖角最后会剩一根 1~2px 宽的斜线，位置贴边、与主体相连，
    # 按连通块和投影都切不掉。开运算（先腐蚀再膨胀）能把这种细于 2px 的东西抹掉，
    # 主体轮廓只损失 1px，缩到 150px 显示后看不出来。
    mask = out.getchannel('A')
    mask = mask.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    out.putalpha(mask)

    box = out.getchannel('A').getbbox()
    if box:
        out = out.crop(box)

    out = trim_side_flakes(out)
    return out, bg, bg_lum


def cut_background_halo(path):
    """
    钻石那张专用：背景是纯黑 + 一团紫色光晕，且光晕的颜色和徽章底部横幅几乎一致
    （都是 #3E0B8C 附近），任何色判据要么留下光晕、要么把横幅一起吃掉。

    改按「形状」处理：
      1. 放宽到「够暗 + 彩度有限」从四边泛洪 —— 光晕最外圈的暗紫一并删掉
      2. 剩下的光晕用「离实心区的距离」做 alpha 衰减 —— 光晕是软的，离开主体就淡出，
         而徽章内部哪怕是一片纯色，也紧贴着实心区，不会被削
    """
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()

    visited = bytearray(w * h)
    dq = deque()

    def near(c):
        return sum(c) / 3.0 < 58 and max(c) - min(c) <= 48

    def push(x, y):
        i = y * w + x
        if not visited[i] and near(px[x, y]):
            visited[i] = 1
            dq.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not visited[i] and near(px[nx, ny]):
                    visited[i] = 1
                    dq.append((nx, ny))

    out = im.convert('RGBA')
    op = out.load()
    for y in range(h):
        base = y * w
        for x in range(w):
            if visited[base + x]:
                op[x, y] = (0, 0, 0, 0)

    fade_halo(out)
    drop_tiny(out, 80)

    box = out.getchannel('A').getbbox()
    if box:
        out = out.crop(box)

    out = trim_side_flakes(out)
    return out, (0, 0, 0), 0


def fade_halo(img, near=11, far=30):
    """按到最近不透明像素的距离给 alpha 打折：近的保留，远的淡出。"""
    w, h = img.size
    px = img.load()

    dist = bytearray(w * h)
    dq = deque()
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if px[x, y][3] == 0:
                dist[i] = 255
            else:
                dq.append(i)

    while dq:
        i = dq.popleft()
        d = dist[i]
        if d >= far:
            continue
        x, y = i % w, i // w
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if dist[j] > d + 1:
                    dist[j] = d + 1
                    dq.append(j)

    for y in range(h):
        for x in range(w):
            d = dist[y * w + x]
            if d >= far:
                px[x, y] = (0, 0, 0, 0)
            elif d > near:
                c = px[x, y]
                px[x, y] = (c[0], c[1], c[2], int(c[3] * (far - d) / (far - near)))

    # 距离是按曼哈顿算的，衰减后是一圈台阶；把 alpha 轻微糊一下就没有锯齿轮廓了
    alpha = img.getchannel('A').filter(ImageFilter.GaussianBlur(0.9))
    img.putalpha(alpha.point(lambda v: 0 if v < 26 else v))


def drop_tiny(img, min_area):
    """删掉面积小于阈值的孤立碎块（光晕边上零星的暗红火苗）。"""
    w, h = img.size
    px = img.load()
    seen = bytearray(w * h)

    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if seen[i] or px[sx, sy][3] == 0:
                continue
            seen[i] = 1
            dq = deque([(sx, sy)])
            blob = [(sx, sy)]
            while dq:
                x, y = dq.popleft()
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and px[nx, ny][3] > 0:
                            seen[j] = 1
                            dq.append((nx, ny))
                            blob.append((nx, ny))
            if len(blob) < min_area:
                for x, y in blob:
                    px[x, y] = (0, 0, 0, 0)


def trim_side_flakes(img):
    """
    削掉左右两边挂着的装饰尖角。

    原图最外圈有一道菱形装饰框，抠背景时它颜色够深没被删，最后在徽章左右各留一块
    几十像素宽的碎片。碎片是**局部**的（只占中间一小段高度），徽章的翅膀/旗帜是**贯穿**
    整个高度的 —— 所以按列统计「有内容的纵向跨度」，从两边往中间跳跨度不足 20% 的列。
    比按列投影（碎片和主体之间只有几个抗锯齿像素的细线，切不开）稳。
    """
    w, h = img.size
    alpha = img.getchannel('A').load()
    min_span = h * 0.2

    def span(x):
        top = bot = -1
        for y in range(h):
            if alpha[x, y] > 40:
                if top < 0:
                    top = y
                bot = y
        return 0 if top < 0 else bot - top + 1

    spans = [span(x) for x in range(w)]

    left = 0
    while left < w and spans[left] < min_span:
        left += 1
    right = w - 1
    while right > left and spans[right] < min_span:
        right -= 1
    if right <= left:
        return img

    return img.crop((left, 0, right + 1, h))


def drop_specks(img):
    """
    删掉抠图后残留的孤立小碎块。

    原图背景里有一圈菱形装饰边框，它是深色描边、不满足「无彩度」判据，抠背景时被剩了下来，
    在界面里就是徽章左右两侧飘着的几个黑三角。判据用「面积小 + 颜色暗」：
    顶部的金色星星同样小，但亮度高，不会被误伤。
    """
    w, h = img.size
    px = img.load()
    seen = bytearray(w * h)

    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if seen[i] or px[sx, sy][3] == 0:
                continue
            seen[i] = 1
            dq = deque([(sx, sy)])
            blob = [(sx, sy)]
            while dq:
                x, y = dq.popleft()
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and px[nx, ny][3] > 0:
                            seen[j] = 1
                            dq.append((nx, ny))
                            blob.append((nx, ny))
            xs = [x for x, _ in blob]
            skinny = len(blob) < w * h * 0.06
            # 挂在最左/最右 12% 内的独立块：原图菱形装饰框的尖角。颜色偏亮（金/银），
            # 用亮度判据清不掉，只能靠位置
            if skinny and (max(xs) < w * 0.12 or min(xs) > w * 0.88):
                for x, y in blob:
                    px[x, y] = (0, 0, 0, 0)
                continue
            if len(blob) < 2500:
                lum = (
                    sum((px[x, y][0] + px[x, y][1] + px[x, y][2]) / 3.0 for x, y in blob) / len(blob)
                )
                if lum < 150:
                    for x, y in blob:
                        px[x, y] = (0, 0, 0, 0)


def main():
    os.makedirs(OUT, exist_ok=True)
    for src_name, out_name, mode in MAPPING:
        src = os.path.join(SRC, src_name)
        if not os.path.exists(src):
            print('MISS', src_name)
            continue
        if mode == 'halo':
            img, bg, bg_lum = cut_background_halo(src)
        else:
            img, bg, bg_lum = cut_background(src)
        w, h = img.size
        scale = TARGET_H / h
        img = img.resize((max(1, round(w * scale)), TARGET_H), Image.LANCZOS)
        dst = os.path.join(OUT, out_name + '.png')
        img.save(dst, optimize=True)
        print(
            '%-9s bg=%s lum=%.0f -> %dx%d  %d KB'
            % (out_name, bg, bg_lum, img.size[0], img.size[1], os.path.getsize(dst) // 1024)
        )


if __name__ == '__main__':
    main()
