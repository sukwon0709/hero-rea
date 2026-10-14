"""Ground truth for web/src/formats/npk.ts: runs OPEN.EXE's NPK016 decoder (image offset 0x06E4) under
tools/dosemu.py.

Reads a JSON list of hex strings (whole NPK016 entries) from stdin and prints a JSON list of hex strings:
the decoder's output buffer, 4 * ceil(((width + 3) / 4) / 2) bytes per row times height. The output must fit
in one 64 KiB segment (the decoder does not advance segments), so 640x400 pictures cannot be checked here.

usage: echo '["4e504b...", ...]' | python3 -I tools/npk_ref.py GAME_DIR
"""
import json, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dosemu import Machine

CODE = 0x1000  # OPEN.EXE image; 06E4..0863 uses no relocated segments (it patches its own cs: immediates)
SRC = 0x3000
DST = 0x5000
RING = 0x7000  # ring buffer 0x640 bytes (OPEN.EXE passes ss:bp-0x75A)


def run(m, data):
    w, h = struct.unpack_from('<HH', data, 12)
    wpr = (w + 3) >> 2
    size = 4 * ((wpr + 1) >> 1) * h
    if len(data) > 0x10000 or size > 0x10000:
        return None
    m.load(SRC, data)
    m.load(DST, b'\0' * size)
    m.load(RING, b'\0' * 0x800)
    # 06E4(far src, far dst, far ring): cdecl, first argument at bp+6
    m.call_far(CODE, 0x06E4, {'ds': SRC}, push_words=(0, SRC, 0, DST, 0, RING))
    return bytes(m.mu.mem_read(DST * 16, size)).hex()


def main():
    exe = open(os.path.join(sys.argv[1], 'OPEN.EXE'), 'rb').read()
    hdr = struct.unpack('<H', exe[8:10])[0] * 16
    m = Machine()
    m.load(CODE, exe[hdr:hdr + 0x10000])
    print(json.dumps([run(m, bytes.fromhex(x)) for x in json.load(sys.stdin)]))


if __name__ == '__main__':
    main()
