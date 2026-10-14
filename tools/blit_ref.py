"""Ground truth for web/src/formats/sprites.ts and font.ts: runs MAIN.EXE's own blitters under tools/dosemu.py.

Reads a JSON list of cases from stdin and prints a JSON list of results (hex strings of 4-bit pixels,
one byte per pixel, of the rectangle x, y, w, h below the 0xC80 VRAM base). Each case:
  {"fn": name, "data": hex, "x": px, "y": row, "w": px, "h": rows, "arg": n, "fill": colour}
fn (all in MAIN.EXE segment 0000, called with the C arguments the game uses):
  cell   0000:6296(x, y, far data)                 16x16 plane-major cell, opaque
  i4     0000:5BEE(x/8, y+40, w/8, h, arg, far data) byte-interleaved 4 planes, mode arg (0..4)
  i3     0000:8494(x/8, y+40, w/8, h, arg, far data) byte-interleaved 3 planes, mode arg (0..4)
  tile   0000:7E4A(x, y, arg, far data)            16x16 byte-interleaved tile, quadrant mask arg
  bits   0000:628E(x/8, y, w/8, h, arg, near data)  1-bit bitmap, arg = mode << 8 | colour
  bits2  0000:6976(x/8, y, w/8, h, arg, near data)  1-bit bitmap, arg = bg << 8 | fg
  dilate 0000:84A4(far data, far out, arg)          outline dilation of a 16-row bitmap, arg = bytes per
                                                    row; the result is the 16*arg output bytes instead
The screen is filled with colour `fill` (default 0) first.

usage: echo '[...]' | python3 -I tools/blit_ref.py GAME_DIR
"""
import json, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dosemu import Machine

CODE = 0x1000  # MAIN.EXE image segment 0000 (no relocations are needed by these functions)
DATA = 0x8000
FNS = {'cell': 0x6296, 'i4': 0x5BEE, 'i3': 0x8494, 'tile': 0x7E4A, 'bits': 0x628E, 'bits2': 0x6976}


def run(m, case):
    data = bytes.fromhex(case['data'])
    x, y, w, h, arg = case['x'], case['y'], case['w'], case['h'], case.get('arg', 0)
    fill = case.get('fill', 0)
    for p in range(4):
        m.vga.planes[p][:] = (b'\xff' if (fill >> p) & 1 else b'\0') * 65536
    m.load(DATA, data)
    fn = case['fn']
    if fn == 'dilate':
        m.call_far(CODE, 0x84A4, {'ds': DATA}, push_words=(0, DATA, 0x100, DATA, arg))
        return bytes(m.mu.mem_read(DATA * 16 + 0x100, 16 * arg)).hex()
    if fn == 'cell':
        args = (x, y, 0, DATA)
    elif fn in ('i4', 'i3'):
        args = (x >> 3, y + 40, w >> 3, h, arg, 0, DATA)
    elif fn == 'tile':
        args = (x, y, arg, 0, DATA)
    else:
        args = (x >> 3, y, w >> 3, h, arg, 0)
    m.call_far(CODE, FNS[fn], {'ds': DATA}, push_words=args)
    return bytes(m.vga.pixels(x, y, w, h, base=0xC80)).hex()


def main():
    game_dir = sys.argv[1]
    exe = open(os.path.join(game_dir, 'MAIN.EXE'), 'rb').read()
    hdr = struct.unpack('<H', exe[8:10])[0] * 16
    m = Machine()
    m.load(CODE, exe[hdr:hdr + 0x10000])
    print(json.dumps([run(m, c) for c in json.load(sys.stdin)]))


if __name__ == '__main__':
    main()
