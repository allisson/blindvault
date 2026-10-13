#!/usr/bin/env python3
"""Draws the app icons into apps/web/public (D190): a dark rounded square with a white keyhole.

Deterministic, standard library only. Run from the repository root after changing the drawing:
    python3 apps/web/build/icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public'
BACKGROUND = (0x18, 0x18, 0x1B)  # zinc-900
FOREGROUND = (0xFF, 0xFF, 0xFF)
RADIUS = 0.22  # corner radius of the "any" icon, as a fraction of its side
SAMPLES = 4  # per axis, for antialiasing

# The keyhole, in a unit square: a circle over a trapezoid widening downwards.
CIRCLE = (0.5, 0.42, 0.12)
TRAPEZOID = (0.47, 0.73, 0.05, 0.10)  # top y, bottom y, top half-width, bottom half-width


def in_rounded_square(x, y):
    r = RADIUS
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_keyhole(x, y):
    cx, cy, r = CIRCLE
    if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
        return True
    top, bottom, top_half, bottom_half = TRAPEZOID
    if top <= y <= bottom:
        half = top_half + (bottom_half - top_half) * (y - top) / (bottom - top)
        return abs(x - 0.5) <= half
    return False


def draw(size, maskable):
    """RGBA rows. A maskable icon fills the square and keeps the glyph in its 80% safe zone."""
    scale = 0.8 if maskable else 1.0
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            shape = glyph = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px + (sx + 0.5) / SAMPLES) / size
                    y = (py + (sy + 0.5) / SAMPLES) / size
                    if maskable or in_rounded_square(x, y):
                        shape += 1
                        if in_keyhole(0.5 + (x - 0.5) / scale, 0.5 + (y - 0.5) / scale):
                            glyph += 1
            n = SAMPLES * SAMPLES
            if shape == 0:
                row += bytes(4)
                continue
            t = glyph / shape
            rgb = [round(b + (f - b) * t) for b, f in zip(BACKGROUND, FOREGROUND)]
            row += bytes(rgb + [round(255 * shape / n)])
        rows.append(bytes(row))
    return b''.join(rows)


def png(size, pixels):
    def chunk(kind, data):
        return (
            struct.pack('>I', len(data))
            + kind
            + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', header)
        + chunk(b'IDAT', zlib.compress(pixels, 9))
        + chunk(b'IEND', b'')
    )


def svg():
    cx, cy, r = CIRCLE
    top, bottom, top_half, bottom_half = TRAPEZOID
    s = 512

    def n(v):
        return f'{v * s:g}'

    points = ' '.join(
        f'{n(x)},{n(y)}'
        for x, y in [
            (0.5 - top_half, top),
            (0.5 + top_half, top),
            (0.5 + bottom_half, bottom),
            (0.5 - bottom_half, bottom),
        ]
    )
    fill = '#%02x%02x%02x' % BACKGROUND
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">'
        f'<rect width="{s}" height="{s}" rx="{n(RADIUS)}" fill="{fill}"/>'
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="#fff"/>'
        f'<polygon points="{points}" fill="#fff"/>'
        '</svg>\n'
    )


def main():
    OUT.mkdir(exist_ok=True)
    for name, size, maskable in [
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('icon-maskable-512.png', 512, True),
        ('apple-touch-icon.png', 180, True),
    ]:
        (OUT / name).write_bytes(png(size, draw(size, maskable)))
    (OUT / 'icon.svg').write_text(svg())


if __name__ == '__main__':
    main()
