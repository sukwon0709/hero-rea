"""Decoder for Koei's LS11 archive/compression format (used by the *.R3 files)."""
import struct, sys

class BitReader:
    def __init__(self, data, pos=0):
        self.d = data; self.pos = pos; self.bit = 0
    def get(self):
        b = (self.d[self.pos] >> (7 - self.bit)) & 1
        self.bit += 1
        if self.bit == 8:
            self.bit = 0; self.pos += 1
        return b
    def code(self):
        # unary-prefixed variable-length integer
        n = 0; a = 0
        while True:
            b = self.get(); a = (a << 1) | b; n += 1
            if not b: break
        c = 0
        for _ in range(n):
            c = (c << 1) | self.get()
        return a + c

def decompress(dic, data, outsize):
    br = BitReader(data)
    out = bytearray()
    while len(out) < outsize:
        c = br.code()
        if c < 256:
            out.append(dic[c])
        else:
            off = c - 256
            ln = br.code() + 3
            start = len(out) - off
            for i in range(ln):
                out.append(out[start + i])
    return bytes(out[:outsize])

def is_ls11(data):
    return data[:4].lower() == b'ls11'

def entries(data):
    # 'LS11' stores the table big-endian, 'Ls11' (DOS/V graphics packs) little-endian
    e = '>' if data[:4] == b'LS11' else '<'
    dic = data[0x10:0x110]
    p = 0x110
    res = []
    while True:
        (csize,) = struct.unpack(e + 'I', data[p:p+4])
        if csize == 0: break
        usize, off = struct.unpack(e + 'II', data[p+4:p+12])
        res.append((csize, usize, off)); p += 12
    return dic, res

def unpack(data):
    dic, ents = entries(data)
    out = []
    for csize, usize, off in ents:
        chunk = data[off:off+csize]
        out.append(chunk if csize == usize else decompress(dic, chunk, usize))
    return out

if __name__ == '__main__':
    for fn in sys.argv[1:]:
        d = open(fn, 'rb').read()
        if not is_ls11(d): print(fn, 'not LS11'); continue
        parts = unpack(d)
        print(fn, len(parts), [len(p) for p in parts][:20])
