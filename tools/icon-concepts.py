#!/usr/bin/env python3
"""claclaw 新图标草案（钓鱼 + 编程 + Claude）。只是方案图，不替换正式图标。
用法：python3 tools/icon-concepts.py   （输出 public/icons/concept-*.png 和一张对比图）"""
import math, os
from PIL import Image, ImageDraw, ImageFont, ImageChops, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'icons')
S = 2048
GREEN_T, GREEN_B = (0x2B, 0xC2, 0x77), (0x0E, 0x86, 0x4B)
CLAY = (0xD9, 0x77, 0x57)        # Claude 陶土橙
CLAY_D = (0xB8, 0x5A, 0x3B)
CREAM = (0xF5, 0xF0, 0xE6)
INK = (0x1F, 0x1E, 0x1D)
NAVY_T, NAVY_B = (0x22, 0x2B, 0x33), (0x12, 0x17, 0x1C)
WHITE = (255, 255, 255)
CN_RED = (0xDE, 0x29, 0x10)   # 国旗红
MONO = '/System/Library/Fonts/Menlo.ttc'


def bg(top, bottom):
    g = Image.linear_gradient('L').resize((S, S))
    a = Image.new('RGB', (S, S), top)
    b = Image.new('RGB', (S, S), bottom)
    return Image.composite(b, a, g)


def dot(d, x, y, r, c): d.ellipse([x - r, y - r, x + r, y + r], fill=c)


def path(d, pts, w, c):
    """圆头圆角的折线/曲线：沿路径密集盖圆点，没有接缝毛刺"""
    step = max(1.0, w / 8)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(n + 1):
            dot(d, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, w / 2, c)


def arc_pts(cx, cy, r, a0, a1, n=80):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def sparkle(d, cx, cy, R, c, n=10, rot=-90):
    """放射状花瓣（Claude 花瓣标志的风格，不是原图）"""
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


def text_center(d, xy, s, size, c, font=MONO, index=1):
    f = ImageFont.truetype(font, size, index=index)
    b = d.textbbox((0, 0), s, font=f)
    d.text((xy[0] - (b[0] + b[2]) / 2, xy[1] - (b[1] + b[3]) / 2), s, font=f, fill=c)


# ---------- 方案 1：钩子 C（沿用现在的绿底白 C，开口处的花瓣挂在鱼钩上当鱼饵）----------
def c1():
    img = bg(GREEN_T, GREEN_B); d = ImageDraw.Draw(img)
    cx, cy, r, w = S * 0.38, S * 0.53, S * 0.25, S * 0.11
    R = r + w / 2
    d.arc([cx - R, cy - R, cx + R, cy + R], start=58, end=302, fill=WHITE, width=int(w))
    for a in (58, 302): dot(d, cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)), w / 2, WHITE)
    # 鱼线从顶上垂下来，钩住 Claude 花瓣
    hx, hr = S * 0.76, S * 0.08
    d.line([(hx, 0), (hx, S * 0.36)], fill=WHITE, width=int(S * 0.02))
    pts = [(hx, S * 0.36), (hx, S * 0.50)] + arc_pts(hx - hr, S * 0.50, hr, 0, 180)[1:]
    pts.append((pts[-1][0], pts[-1][1] - S * 0.05))
    path(d, pts, S * 0.042, WHITE)
    path(d, [pts[-1], (pts[-1][0] + S * 0.04, pts[-1][1] + S * 0.04)], S * 0.034, WHITE)
    sparkle(d, hx - hr, S * 0.66, S * 0.12, CREAM)
    return img


# ---------- 方案 2：><> 代码鱼（深色终端底，ASCII 小鱼游向挂着 Claude 花瓣的鱼钩）----------
def c2():
    img = bg(NAVY_T, NAVY_B); d = ImageDraw.Draw(img)
    # 鱼线 + 钩 + 花瓣饵
    hx, hr = S * 0.80, S * 0.07
    d.line([(hx, 0), (hx, S * 0.34)], fill=CREAM, width=int(S * 0.016))
    pts = [(hx, S * 0.34), (hx, S * 0.48)] + arc_pts(hx - hr, S * 0.48, hr, 0, 180)[1:]
    pts.append((pts[-1][0], pts[-1][1] - S * 0.045))
    path(d, pts, S * 0.036, CREAM)
    path(d, [pts[-1], (pts[-1][0] + S * 0.034, pts[-1][1] + S * 0.034)], S * 0.028, CREAM)
    sparkle(d, hx - hr, S * 0.62, S * 0.10, CLAY)
    # ASCII 鱼 ><>，等宽粗体，陶土橙
    f = ImageFont.truetype(MONO, int(S * 0.34), index=1)
    adv = S * 0.15
    x0, y0 = S * 0.12, S * 0.66
    for i, ch in enumerate('><>'):
        b = d.textbbox((0, 0), ch, font=f)
        d.text((x0 + i * adv - b[0], y0 - (b[1] + b[3]) / 2), ch, font=f, fill=CLAY)
    # 小气泡 + 光标
    for x, y, r in ((0.60, 0.58, 0.02), (0.64, 0.52, 0.014), (0.67, 0.47, 0.009)):
        d.ellipse([S * (x - r), S * (y - r), S * (x + r), S * (y + r)], outline=CREAM, width=int(S * 0.006))
    d.rectangle([S * 0.14, S * 0.84, S * 0.27, S * 0.87], fill=CREAM)
    return img


# ---------- 方案 3：终端浮漂（陶土橙底，水面上的浮漂，浮漂身上是 >_，顶上是花瓣）----------
def c3():
    img = bg((0xE3, 0x85, 0x63), CLAY_D); d = ImageDraw.Draw(img)
    cx, cy = S * 0.5, S * 0.56
    # 水波纹
    for i, (rx, ry) in enumerate(((0.40, 0.075), (0.31, 0.055), (0.22, 0.037))):
        d.arc([cx - S * rx, S * 0.70 - S * ry, cx + S * rx, S * 0.70 + S * ry], 0, 180, fill=CREAM, width=int(S * 0.016))
    # 浮漂：上半奶白、下半墨黑的椭圆（下半部分被水面挡住一点）
    bw, bh = S * 0.36, S * 0.42
    body = Image.new('L', (S, S)); ImageDraw.Draw(body).ellipse([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], fill=255)
    top = Image.new('L', (S, S)); ImageDraw.Draw(top).rectangle([0, 0, S, cy - S * 0.01], fill=255)
    water = Image.new('L', (S, S)); ImageDraw.Draw(water).rectangle([0, 0, S, S * 0.70], fill=255)
    img.paste(CREAM, (0, 0), ImageChops.multiply(ImageChops.multiply(body, top), water))
    low = ImageChops.multiply(ImageChops.multiply(body, ImageChops.invert(top)), water)
    img.paste(INK, (0, 0), low)
    d = ImageDraw.Draw(img)
    text_center(d, (cx, cy + S * 0.075), '>_', int(S * 0.13), CREAM)
    # 顶上的天线 + 花瓣
    d.line([(cx, cy - bh / 2 + S * 0.01), (cx, S * 0.22)], fill=INK, width=int(S * 0.022))
    sparkle(d, cx, S * 0.17, S * 0.10, CREAM)
    return img


# ---------- 方案 4：Claude 钓起 C{}（绿底；左下角的 Claude 花瓣握着钓竿，钓起白色的 C{}）----------
def c4():
    img = bg(GREEN_T, GREEN_B); d = ImageDraw.Draw(img)
    # 左下角 Claude 花瓣（红）
    sx, sy, sr = S * 0.21, S * 0.79, S * 0.15
    # 钓竿：从花瓣右上方出发，先陡后缓，梢头在右上；白色，根粗梢细
    x0, y0, x1, y1 = S * 0.25, S * 0.70, S * 0.54, S * 0.12
    rod = [(x0 + (x1 - x0) * t, y0 - (y0 - y1) * (1 - (1 - t) ** 3.0)) for t in [i / 600 for i in range(601)]]
    for i, (x, y) in enumerate(rod):
        dot(d, x, y, S * (0.024 - 0.015 * i / 600), WHITE)
    sparkle(d, sx, sy, sr, CLAY)
    tip = rod[-1]
    # 钓起的 C{}：C 用和现在图标一样的圆弧画法，比花括号大；第一个花括号压在 C 的开口上
    gy = S * 0.53
    cx, r, w = S * 0.52, S * 0.13, S * 0.058
    R = r + w / 2
    d.arc([cx - R, gy - R, cx + R, gy + R], start=50, end=310, fill=WHITE, width=int(w))
    for a in (50, 310): dot(d, cx + r * math.cos(math.radians(a)), gy + r * math.sin(math.radians(a)), w / 2, WHITE)
    # 花括号先画进遮罩；外面挖掉一圈露出渐变底色，压在 C 上的地方也分得清轮廓
    f = ImageFont.truetype(MONO, int(S * 0.26), index=1)
    m = Image.new('L', (S, S)); md = ImageDraw.Draw(m)
    for ch, x in (('{', cx + r * 0.80), ('}', cx + r * 0.80 + S * 0.17)):
        b = md.textbbox((0, 0), ch, font=f)
        md.text((x - (b[0] + b[2]) / 2, gy - (b[1] + b[3]) / 2), ch, font=f, fill=255, stroke_width=int(S * 0.010), stroke_fill=255)
    gap = m.filter(ImageFilter.MaxFilter(int(S * 0.022) | 1))
    img.paste(bg(GREEN_T, GREEN_B), (0, 0), gap)
    img.paste(WHITE, (0, 0), m)
    d = ImageDraw.Draw(img)
    # 鱼线：从竿梢垂到 C 的顶上
    d.line([tip, (cx, gy - r - w * 0.3)], fill=WHITE, width=int(S * 0.009))
    return img


# ---------- 方案 5：最初版（C + 三道斜杠）的斜杠换成 { / }，加上钓竿和 Claude 花瓣 ----------
def brace_pts(cx, cy, H, right=False, n=24):
    """竖直的花括号中心线（{ 朝左尖；right=True 时镜像成 }）"""
    r1, r2 = H * 0.20, H * 0.13
    top, sg = cy - H / 2, (-1 if right else 1)
    def arc(ccx, ccy, r, a0, a1):
        return [(ccx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), ccy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]
    x = cx
    upper = arc(x + r1, top + r1, r1, 270, 180) + arc(x - r2, cy - r2, r2, 0, 90)
    lower = [(px, 2 * cy - py) for px, py in reversed(upper)]
    pts = upper + lower
    return [(cx + (px - cx) * sg, py) for px, py in pts]


def shear(pts, cx, cy, s):
    """往右上歪：越往上越往右（s = 水平偏移 / 竖直距离）"""
    return [(x + (cy - y) * s, y) for x, y in pts]


def c5():
    img = bg(GREEN_T, GREEN_B); d = ImageDraw.Draw(img)
    # 红色 Claude 花瓣放在最底层：位置、大小参照 2 号的 ><>（左偏下、横跨大半个图标），白色元素压在它上面
    sparkle(d, S * 0.345, S * 0.66, S * 0.22, CN_RED)
    k = 0.70                                   # 相对最初版的缩放
    cx, cy = S * 0.56, S * 0.45
    ROD_W = S * 0.044                          # 钓竿最粗处（根部）的粗细；C 不能比它粗
    r, w = S * 0.27 * k, ROD_W
    R = r + w / 2
    # C 逆时针转 27°（PIL 的角度是顺时针为正，所以减 27）
    a0, a1 = 52 - 27, 308 - 27
    d.arc([cx - R, cy - R, cx + R, cy + R], start=a0, end=a1, fill=WHITE, width=int(w))
    for a in (a0, a1): dot(d, cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)), w / 2, WHITE)
    # 三笔：位置、长度、倾斜量都沿用最初版（倾斜量 tilt 固定，短的那两笔就斜得更厉害）
    cw, tilt = S * 0.052 * k, S * 0.045 * k
    marks = []
    for i, (dx, ln) in enumerate(((0.03, 0.17), (0.135, 0.23), (0.24, 0.17))):
        mx, h = cx + S * (dx * k + 0.015), S * ln * k / 2
        if i == 1:
            pts = [(mx - tilt, cy + h), (mx + tilt, cy - h)]
            path(d, pts, cw, WHITE)
        else:
            # 斜度 = 原来这道杠的 tilt / h；花括号要有弯，高度放到和中间那笔一样，笔画细一点，并往两边让开
            slope = tilt / h
            H = S * 0.23 * k
            mx += S * (-0.03 if i == 0 else 0.03)
            pts = shear(brace_pts(mx, cy, H, right=(i == 2)), mx, cy, slope)
            path(d, pts, cw * 0.8, WHITE)
        marks.append(pts)
    # 左下角红色 Claude 花瓣；钓竿从它那里伸出，绕过 C 的左上方，梢头在右上
    P0, P1, P2 = (S * 0.23, S * 0.64), (S * 0.16, S * 0.05), (S * 0.84, S * 0.06)
    N = 700
    for i in range(N + 1):
        t = i / N
        x = (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * P1[0] + t * t * P2[0]
        y = (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * P1[1] + t * t * P2[1]
        dot(d, x, y, ROD_W / 2 - S * 0.014 * t, WHITE)
    # 左下角光标（同 2 号的位置），白色
    d.rectangle([S * 0.12, S * 0.84, S * 0.27, S * 0.875], fill=WHITE)
    # 鱼线从竿梢垂下，挂住 } 的顶端
    hx, hy = min(marks[2], key=lambda p: p[1])
    d.line([(P2[0], P2[1]), (hx, hy - cw * 0.3)], fill=WHITE, width=int(S * 0.009))
    return img


def rounded(img, size):
    """预览用：缩小 + iOS 风格圆角"""
    im = img.resize((size, size), Image.LANCZOS)
    m = Image.new('L', (size * 4, size * 4)); ImageDraw.Draw(m).rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=size * 4 * 0.225, fill=255)
    out = Image.new('RGBA', (size, size)); out.paste(im, (0, 0), m.resize((size, size), Image.LANCZOS))
    return out


os.makedirs(OUT, exist_ok=True)
names = (('1', '钩子 C', c1), ('2', '><> 代码鱼', c2), ('3', '终端浮漂', c3), ('4', 'Claude 钓起 C{}', c4), ('5', '最初版 + { / }', c5))
imgs = []
for k, label, fn in names:
    im = fn()
    imgs.append(im)
    rounded(im, 360).save(os.path.join(OUT, f'concept-{k}.png'), optimize=True)
    print('wrote concept-' + k, label)
# 对比图：上排大图，下排手机主屏实际大小（60px）
big, small, pad = 300, 60, 40
W = len(names) * (big + pad) + pad
sheet = Image.new('RGB', (W, 300 + 60 + 3 * pad + 50), (0xF2, 0xF2, 0xF2))
font = ImageFont.truetype('/System/Library/Fonts/PingFang.ttc', 28) if os.path.exists('/System/Library/Fonts/PingFang.ttc') else ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc', 28)
sd = ImageDraw.Draw(sheet)
for i, (im, (k, label, _)) in enumerate(zip(imgs, names)):
    x = pad + i * (big + pad)
    r = rounded(im, big); sheet.paste(r, (x, pad), r)
    s = rounded(im, small); sheet.paste(s, (x + (big - small) // 2, pad * 2 + big), s)
    sd.text((x + big / 2, pad * 2.5 + big + small), f'{k}. {label}', font=font, fill=(0x33, 0x33, 0x33), anchor='mt')
sheet.save(os.path.join(OUT, 'concept-sheet.png'), optimize=True)
print('wrote concept-sheet')
