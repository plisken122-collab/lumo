"""Erzeugt alle Logo-Dateien als PNG. Gleiche Geometrie wie die SVGs."""
import math
from PIL import Image, ImageDraw, ImageChops

INDIGO = (56, 76, 158)
GRUEN  = (30, 111, 88)
TINTE  = (32, 34, 43)
S = 5  # Ueberabtastung

# ----------------------------- Bildmarke -----------------------------
def mark(size=512, bg=None, mono=None):
    k, W = size / 160.0, size * S
    def s(v): return v * k * S

    shape = Image.new("L", (W, W), 0)
    d = ImageDraw.Draw(shape)
    d.rounded_rectangle([s(20), s(26), s(140), s(114)], radius=s(26), fill=255)
    d.polygon([(s(42), s(108)), (s(74), s(108)), (s(34), s(146))], fill=255)

    def half(side):
        m = Image.new("L", (W, W), 0)
        dd = ImageDraw.Draw(m)
        g = s(3)
        if side == "l":
            dd.polygon([(0, 0), (s(118) - g, 0), (s(58) - g, W), (0, W)], fill=255)
        else:
            dd.polygon([(s(118) + g, 0), (W, 0), (W, W), (s(58) + g, W)], fill=255)
        return m

    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    if bg:
        ImageDraw.Draw(img).rectangle([0, 0, W, W], fill=bg)
    if mono:
        # Auch einfarbig bleibt die Naht sichtbar, sonst geht die Marke verloren
        both = ImageChops.lighter(ImageChops.darker(shape, half("l")),
                                  ImageChops.darker(shape, half("r")))
        img.paste(Image.new("RGBA", (W, W), mono + (255,)), (0, 0), both)
    else:
        for side, col in (("l", INDIGO), ("r", GRUEN)):
            m = ImageChops.darker(shape, half(side))
            img.paste(Image.new("RGBA", (W, W), col + (255,)), (0, 0), m)
    return img.resize((size, size), Image.LANCZOS)

# ----------------------------- Wortmarke -----------------------------
WORD_W, WORD_H = 392, 150

def _arc(cx, cy, r, a0, a1, n=180):
    return [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
            for a in [a0 + (a1 - a0) * i / n for i in range(n + 1)]]

STROKES = [
    [(22, 18), (22, 120)],
    [(60, 60), (60, 90)] + _arc(90, 90, 30, 180, 0) + [(120, 90)],
    [(120, 60), (120, 120)],
    [(158, 120), (158, 88)] + _arc(186, 88, 28, 180, 360) + [(214, 120)],
    _arc(242, 88, 28, 180, 360) + [(270, 120)],
    _arc(330, 90, 30, 0, 360) + [(360, 90)],
]

def wordmark(height=150, color=TINTE):
    k = height / WORD_H
    w = int(WORD_W * k)
    img = Image.new("RGBA", (w * S, height * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = 8 * k * S  # halbe Strichstaerke
    for pts in STROKES:
        q = [(x * k * S, y * k * S) for (x, y) in pts]
        # Dicht gesetzte Kreise statt Linienzug: keine Nahtstellen an den Boegen
        dense = []
        for i in range(len(q) - 1):
            (x0, y0), (x1, y1) = q[i], q[i + 1]
            steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / (r / 3)))
            for t in range(steps + 1):
                dense.append((x0 + (x1 - x0) * t / steps, y0 + (y1 - y0) * t / steps))
        for (x, y) in dense:
            d.ellipse([x - r, y - r, x + r, y + r], fill=color)
    return img.resize((w, height), Image.LANCZOS)

# ---------------------------- Kombination ----------------------------
def horizontal(height=200, color=TINTE, bg=None):
    m = mark(int(height * 0.82))
    wm = wordmark(int(height * 0.46), color)
    gap = int(height * 0.16)
    W = m.width + gap + wm.width
    img = Image.new("RGBA", (W, height), bg or (0, 0, 0, 0))
    my = (height - m.height) // 2
    img.alpha_composite(m, (0, my))
    # Auf die Mitte des Blasenkoerpers ausrichten, nicht auf den Schwanz
    body_mid = my + int(m.height * 0.4375)
    img.alpha_composite(wm, (m.width + gap, body_mid - wm.height // 2))
    return img

if __name__ == "__main__":
    horizontal(200).save("/tmp/logo-h.png")
    mark(512).save("/tmp/mark.png")
    print("ok")
