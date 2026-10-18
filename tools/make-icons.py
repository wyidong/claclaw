#!/usr/bin/env python3
"""生成 claclaw 主屏幕图标：「钓鱼编程」。
白底，图形全部是绿色渐变：细 C（逆时针转 27°）+ 开口里歪斜的 { / }（斜度沿用最初版的三道斜杠）；
钓竿绕过 C，鱼线挂住 }；左下光标；最底层一朵很浅的绿色 Claude 风格花瓣，其他图形压在它上面。
设计稿和其他方案见 tools/icon-concepts.py（方案 5）。
用法：python3 tools/make-icons.py   （输出到 public/icons/）
改了图标记得把 index.html / login.html / manifest.webmanifest 里图标网址的 ?v= 加一，否则手机会一直用缓存的旧图。"""
import math, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'icons')
S = 2048  # 先画大图再缩小，等于抗锯齿
TOP, BOTTOM = (0x2B, 0xC2, 0x77), (0x0E, 0x86, 0x4B)


def green():
    """上浅下深的绿色渐变（图形的颜色）"""
    g = Image.linear_gradient('L').resize((S, S))
    return Image.composite(Image.new('RGB', (S, S), BOTTOM), Image.new('RGB', (S, S), TOP), g)


def dot(d, x, y, r, c): d.ellipse([x - r, y - r, x + r, y + r], fill=c)


def path(d, pts, w, c):
    """圆头圆角的曲线：沿路径密集盖圆点，没有接缝毛刺"""
    step = max(1.0, w / 8)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(n + 1):
            dot(d, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, w / 2, c)


def sparkle(d, cx, cy, R, c, n=10, rot=-90):
    """放射状花瓣（Claude 花瓣标志的风格，不是原图）：中心细、往外变宽、圆头，长短相间"""
    for i in range(n):
        ang = math.radians(rot + i * 360 / n)
        L = R * (1.0 if i % 2 == 0 else 0.8)
        wt, wb = R * 0.13, R * 0.03
        ca, sa = math.cos(ang), math.sin(ang)
        tip = L - wt
        poly = [(0, wb), (tip, wt), (tip, -wt), (0, -wb)]
        d.polygon([(cx + x * ca - y * sa, cy + x * sa + y * ca) for x, y in poly], fill=c)
        dot(d, cx + tip * ca, cy + tip * sa, wt, c)
    dot(d, cx, cy, R * 0.16, c)


def brace_pts(cx, cy, H, right=False, n=24):
    """竖直花括号的中心线（{ 尖朝左；right=True 镜像成 }）"""
    r1, r2 = H * 0.20, H * 0.13
    top, sg = cy - H / 2, (-1 if right else 1)

    def arc(ccx, ccy, r, a0, a1):
        return [(ccx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
                 ccy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]
    upper = arc(cx + r1, top + r1, r1, 270, 180) + arc(cx - r2, cy - r2, r2, 0, 90)
    pts = upper + [(px, 2 * cy - py) for px, py in reversed(upper)]
    return [(cx + (px - cx) * sg, py) for px, py in pts]


def shear(pts, cy, s):
    """往右上歪：越往上越往右（s = 水平偏移 / 竖直距离）"""
    return [(x + (cy - y) * s, y) for x, y in pts]


SHIFT = (-0.06, 0.09)   # C、{ / }、钓竿、鱼线整体往左下挪，靠近光标（光标和花瓣不动）
GAP = 0.018             # 上层图形外面挖掉的一圈（露出底色），压在花瓣上时还分得清层次


def content():
    """返回两张遮罩（L 模式，255 = 图形）：花瓣（最底层）、上层（往左下挪的主体 + 光标）"""
    FG = 255
    petal = Image.new('L', (S, S)); sparkle(ImageDraw.Draw(petal), S * 0.345, S * 0.66, S * 0.22, FG)
    body = Image.new('L', (S, S)); d = ImageDraw.Draw(body)
    # C：最初版缩到 0.70，粗细不超过钓竿最粗处；逆时针转 27°（PIL 角度顺时针为正，所以减）
    k = 0.70
    cx, cy = S * 0.56, S * 0.45
    ROD_W = S * 0.044
    r, w = S * 0.27 * k, ROD_W
    R = r + w / 2
    a0, a1 = 52 - 27, 308 - 27
    d.arc([cx - R, cy - R, cx + R, cy + R], start=a0, end=a1, fill=FG, width=int(w))
    for a in (a0, a1):
        dot(d, cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)), w / 2, FG)
    # { / }：位置、倾斜量沿用最初版三道斜杠（tilt 固定，两边短杠斜得更多）；花括号加高到和中间一样
    cw, tilt = S * 0.052 * k, S * 0.045 * k
    marks = []
    for i, (dx, ln) in enumerate(((0.03, 0.17), (0.135, 0.23), (0.24, 0.17))):
        mx, h = cx + S * (dx * k + 0.015), S * ln * k / 2
        if i == 1:
            pts = [(mx - tilt, cy + h), (mx + tilt, cy - h)]
            path(d, pts, cw, FG)
        else:
            mx += S * (-0.03 if i == 0 else 0.03)
            pts = shear(brace_pts(mx, cy, S * 0.23 * k, right=(i == 2)), cy, tilt / h)
            path(d, pts, cw * 0.8, FG)
        marks.append(pts)
    # 钓竿：二次贝塞尔，绕过 C 的左上方，根粗梢细
    P0, P1, P2 = (S * 0.23, S * 0.64), (S * 0.16, S * 0.05), (S * 0.84, S * 0.06)
    N = 700
    for i in range(N + 1):
        t = i / N
        x = (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * P1[0] + t * t * P2[0]
        y = (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * P1[1] + t * t * P2[1]
        dot(d, x, y, ROD_W / 2 - S * 0.014 * t, FG)
    # 鱼线：竿梢 → } 的顶端
    hx, hy = min(marks[2], key=lambda p: p[1])
    d.line([P2, (hx, hy - cw * 0.3)], fill=FG, width=int(S * 0.009))
    moved = Image.new('L', (S, S)); moved.paste(body, (round(S * SHIFT[0]), round(S * SHIFT[1])))
    # 左下角光标（不动）
    ImageDraw.Draw(moved).rectangle([S * 0.12, S * 0.84, S * 0.27, S * 0.875], fill=FG)
    return petal, moved


PETAL_TINT = (0xC4, 0xEB, 0xD4)   # 花瓣用很浅的绿垫在最底层，不挖边；改成 None 则和其他图形同色、上层挖白边分层


def compose(petal, top, scale=1.0, tint=PETAL_TINT):
    """白底 + 绿色渐变图形；scale<1 时图形整体缩进中心，给 maskable 图标留安全区"""
    def fit(m):
        if scale == 1.0: return m
        n = round(S * scale)
        out = Image.new('L', (S, S)); out.paste(m.resize((n, n), Image.LANCZOS), ((S - n) // 2, (S - n) // 2))
        return out
    petal, top = fit(petal), fit(top)
    img = Image.new('RGB', (S, S), (255, 255, 255))
    if tint is None:
        gap = top.filter(ImageFilter.MaxFilter(int(S * GAP * scale) * 2 + 1))
        return Image.composite(green(), img, ImageChops.lighter(ImageChops.subtract(petal, gap), top))
    img = Image.composite(Image.new('RGB', (S, S), tint), img, petal)
    return Image.composite(green(), img, top)


os.makedirs(OUT, exist_ok=True)
petal, top = content()
full, safe = compose(petal, top), compose(petal, top, 0.8)
for name, img, size in (('apple-touch-icon.png', full, 180), ('icon-192.png', full, 192),
                        ('icon-512.png', full, 512), ('icon-maskable-512.png', safe, 512)):
    img.convert('RGB').resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)
    print('wrote', name)
