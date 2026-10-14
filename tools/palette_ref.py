"""Ground truth for web/src/formats/palette.ts: runs GRPDRV.EXE's palette functions under tools/dosemu.py.

Sets the 16 palette entries to FROM (GRPDRV int 18h AH=15h), then fades to TO (AH=16h) with STEPS steps and
records the 16 DAC entries (6-bit R,G,B) after every step. Prints JSON {"steps": [[[r,g,b]*16]*steps]}.
FROM/TO are 96 hex digits: 16 x [B,R,G] nibbles, the layout of MAIN.EXE's palette table (DS:1050).

usage: python3 -I tools/palette_ref.py GAME_DIR FROM TO STEPS
"""
import json, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dosemu import Machine

SEG = 0x1000   # GRPDRV image (MZ header 0x200 bytes stripped)
BUF = 0x3000


def main():
    game_dir, frm, to, steps = sys.argv[1], bytes.fromhex(sys.argv[2]), bytes.fromhex(sys.argv[3]), int(sys.argv[4])
    exe = open(os.path.join(game_dir, 'GRPDRV.EXE'), 'rb').read()
    hdr = struct.unpack('<H', exe[8:10])[0] * 16
    m = Machine()
    m.load(SEG, exe[hdr:])
    m.set_vector(0x18, SEG, 0x2163)
    m.load(BUF, frm)
    m.call_int(0x18, {'ax': 0x1500, 'cx': 16, 'ds': BUF, 'si': 0, 'es': BUF, 'bx': 0})
    frames = []
    orig = m.vga.out

    def out(port, val, size):
        orig(port, val, size)
        if port == 0x3c9 and m.vga.dac_idx == 16 and m.vga.dac_sub == 0:
            frames.append([list(c) for c in m.vga.dac[:16]])
    m.vga.out = out
    m.load(BUF, to)
    m.call_int(0x18, {'ax': 0x1600, 'cx': (steps << 8) | 16, 'dx': 1, 'es': BUF, 'bx': 0})
    print(json.dumps({'steps': frames}))


if __name__ == '__main__':
    main()
