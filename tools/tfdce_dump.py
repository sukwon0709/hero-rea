"""Ground truth for the TypeScript TF-DCE decoder (web/src/formats/tfdce.ts).

Runs the original TFDED.COM (int 62h, via tools/tfdce_ref.py) on every TF-DCE image of the game
and writes, for each image and each `flags` value (0 and 1), SHA-256 hashes of
  * the decoded rectangle as 4-bit indices (one byte per pixel), and
  * the whole of VGA planes 0..3 (4 x 64 KiB) after decoding,
to OUT_DIR/tfdce_ref.json. With --png also writes OUT_DIR/png/<file>_<index>.png (flags 1).
Never write the output into the repository.

usage: python3 -I tools/tfdce_dump.py GAME_DIR OUT_DIR [--png]
"""
import hashlib, json, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tfdce_ref import tfded_machine, decode
import ls11

# (file, kind, entry indices or None = all). FACEDAT/PACKGRP are {u32 offset, u16 size} tables.
# These are the only TF-DCE images of the game: MAIN.EXE decodes TF-DCE only via 0cf5:52D4, called
# for faces (0cf5:51B2) and PACKGRP pictures (0cf5:520E); a scan of every file/LS11 entry finds no others.
SOURCES = [
    ('FACEDAT.R3', 'otab', None),
    ('PACKGRP.R3', 'otab', None),
]


def split_otab(d):
    ents = []
    p = 0
    while p + 6 <= len(d):
        off, sz = struct.unpack('<IH', d[p:p + 6])
        if (not ents and off != 0) or (ents and off != ents[-1][0] + ents[-1][1]):
            break
        ents.append((off, sz))
        p += 6
    return [d[p + o:p + o + s] for o, s in ents]


def blobs(game_dir):
    for fn, kind, idxs in SOURCES:
        d = open(os.path.join(game_dir, fn), 'rb').read()
        parts = split_otab(d) if kind == 'otab' else ls11.unpack(d)
        for i in (idxs if idxs is not None else range(len(parts))):
            yield fn, i, parts[i]


def run(game_dir, blob, flags):
    m = tfded_machine(game_dir)
    w, h = decode(m, blob, 0, 0, flags, 0)
    px = bytes(m.vga.pixels(0, 40, w, h))
    planes = b''.join(bytes(p) for p in m.vga.planes)
    return w, h, px, planes


def main():
    game_dir, out_dir = sys.argv[1], sys.argv[2]
    png = '--png' in sys.argv
    os.makedirs(out_dir, exist_ok=True)
    res = {}
    for fn, i, blob in blobs(game_dir):
        key = f'{fn}#{i}'
        ent = {}
        for flags in (0, 1):
            w, h, px, planes = run(game_dir, blob, flags)
            ent[f'flags{flags}'] = {'rect': hashlib.sha256(px).hexdigest(), 'vram': hashlib.sha256(planes).hexdigest()}
            if png and flags == 1:
                from PIL import Image
                im = Image.frombytes('P', (w, h), px)
                im.putpalette([v * 17 for c in range(16) for v in ((c >> 1 & 1) * 15, (c >> 2 & 1) * 15, (c & 1) * 15)] + [0] * 720)
                os.makedirs(os.path.join(out_dir, 'png'), exist_ok=True)
                im.save(os.path.join(out_dir, 'png', f'{fn}_{i}.png'))
        ent['w'], ent['h'] = w, h
        res[key] = ent
        print(key, w, h, flush=True)
    json.dump(res, open(os.path.join(out_dir, 'tfdce_ref.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
