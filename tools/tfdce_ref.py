"""Reference TF-DCE decoder: runs the original TFDED.COM (int 62h) under tools/dosemu.py.

usage: tfdce_ref.py GAME_DIR FILE.R3 index out.png
"""
import struct, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from dosemu import Machine

PSP = 0x1000
PARAM = 0x2000
DATA = 0x3000


def tfded_machine(game_dir):
    m = Machine()
    com = open(os.path.join(game_dir, 'TFDED.COM'), 'rb').read()
    m.load(PSP, b'\0' * 0x100 + com)
    m.set_vector(0x62, PSP, 0x104)
    return m


def decode(m, blob, x=0, y=0, flags=0, func=0):
    """Decodes a TF-DCE blob onto the emulated VGA. Returns (width_px, height)."""
    m.load(DATA, blob)
    m.load(PARAM, struct.pack('<6H', x, y, DATA, 0, flags, func))
    m.call_int(0x62, {'ax': 0, 'bx': PARAM})
    skip = blob[0] - 1
    w = blob[1 + skip] * 8
    h = blob[2 + skip] | (blob[3 + skip] << 8)
    return w, h


def entries(data):
    ents = []
    p = 0
    while True:
        off, sz = struct.unpack('<IH', data[p:p + 6])
        if ents and off != ents[-1][0] + ents[-1][1]:
            break
        ents.append((off, sz))
        p += 6
    return p, ents


def default_palette():
    # placeholder EGA palette until the game's palettes are decoded
    return [(0,0,0),(0,0,170),(0,170,0),(0,170,170),(170,0,0),(170,0,170),(170,85,0),(170,170,170),
            (85,85,85),(85,85,255),(85,255,85),(85,255,255),(255,85,85),(255,85,255),(255,255,85),(255,255,255)]


if __name__ == '__main__':
    from PIL import Image
    gd, fn, idx, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    d = open(os.path.join(gd, fn), 'rb').read()
    base, ents = entries(d)
    off, sz = ents[idx]
    blob = d[base + off: base + off + sz]
    m = tfded_machine(gd)
    w, h = decode(m, blob)
    px = m.vga.pixels(0, 40, w, h)
    pal = default_palette()
    im = Image.new('RGB', (w, h))
    im.putdata([pal[c] for c in px])
    im.save(out)
    print(fn, idx, w, h)
