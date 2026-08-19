#!/usr/bin/env python3
"""
Pure-stdlib (zlib+struct only) PNG generator for sprite-sheet placeholders.

Produces a "missing texture" checkerboard (magenta/black) with thin cyan
grid lines drawn at every cell boundary, so an artist opening the file in
an image editor can immediately see the required cell grid and frame count.
This is NOT an attempt to draw the character — it is an explicit
"asset missing" indicator, matching standard game-dev convention.
"""
import struct
import zlib
import sys
import os

def write_png(path, width, height, cell_w, cell_h, checker=8):
    row_bytes = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None) for this scanline
        for x in range(width):
            on_grid = (x % cell_w == 0) or (y % cell_h == 0) or (x % cell_w == cell_w - 1) or (y % cell_h == cell_h - 1)
            if on_grid:
                r, g, b, a = 0, 230, 230, 255  # cyan grid line
            else:
                tile = ((x // checker) + (y // checker)) % 2
                if tile == 0:
                    r, g, b, a = 255, 0, 255, 255  # magenta
                else:
                    r, g, b, a = 20, 20, 20, 255   # near-black
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    print(f"wrote {path} ({width}x{height}, cell {cell_w}x{cell_h})")


if __name__ == '__main__':
    # SPRITE MANIFEST — must stay in sync with sprites.js SPRITE_MANIFEST
    base = sys.argv[1] if len(sys.argv) > 1 else 'assets/sprites'

    HERO_COLS = 20  # Idle2 + Walk4 + Run6 + Attack6 + Damage2
    HERO_ROWS = 4   # Down, Left, Right, Up
    ALLY_COLS = 12  # Idle2 + Walk4 + Attack4 + Damage2
    ALLY_ROWS = 4
    ENEMY_COLS = 16  # Idle2 + Walk4 + Attack4 + Damage2 + Death4

    hero_files = ['hero_darkknight', 'hero_whitemage', 'hero_thief', 'hero_bard', 'hero_heavyknight']
    ally_files = ['ally_mage', 'ally_archer', 'ally_warrior']
    enemy_small = ['enemy_slime', 'enemy_goblin', 'enemy_mushroom']
    enemy_mid = ['enemy_plant', 'enemy_spider']
    enemy_boss = ['enemy_dragon', 'enemy_treeent']

    for name in hero_files:
        write_png(f'{base}/hero/{name}.png', 48 * HERO_COLS, 48 * HERO_ROWS, 48, 48)
    for name in ally_files:
        write_png(f'{base}/ally/{name}.png', 48 * ALLY_COLS, 48 * ALLY_ROWS, 48, 48)
    for name in enemy_small:
        write_png(f'{base}/enemy/{name}.png', 48 * ENEMY_COLS, 48, 48, 48)
    for name in enemy_mid:
        write_png(f'{base}/enemy/{name}.png', 64 * ENEMY_COLS, 64, 64, 64)
    for name in enemy_boss:
        write_png(f'{base}/enemy/{name}.png', 96 * ENEMY_COLS, 96, 96, 96)
