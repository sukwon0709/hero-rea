"""Minimal MZ loader + capstone helpers for 16-bit real-mode analysis."""
import struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_16

class MZ:
    def __init__(self, path):
        d = open(path, 'rb').read()
        (self.sig, lastp, pages, nrel, hdr, self.minalloc, self.maxalloc, self.ss, self.sp,
         _, self.ip, self.cs, relo) = struct.unpack('<2sHHHHHHHHHHHH', d[:26])
        size = (pages - 1) * 512 + lastp if lastp else pages * 512
        self.hdr = hdr * 16
        self.image = bytearray(d[self.hdr:size])
        self.relocs = [struct.unpack('<HH', d[relo + 4*i: relo + 4*i + 4]) for i in range(nrel)]
        # linear offsets (within image) of relocated words
        self.reloc_set = set(seg * 16 + off for off, seg in self.relocs)
        self.md = Cs(CS_ARCH_X86, CS_MODE_16)
        self.md.detail = False
        self.md.skipdata = True

    def lin(self, seg, off):
        return seg * 16 + off

    def word(self, lin):
        return struct.unpack('<H', self.image[lin:lin+2])[0]

    def dis(self, seg, off, count=60, stop_ret=True):
        lin = seg * 16 + off
        code = bytes(self.image[lin: lin + count * 8])
        out = []
        for ins in self.md.disasm(code, off):
            l = seg * 16 + ins.address
            rel = any((l + k) in self.reloc_set for k in range(ins.size))
            out.append(f'{seg:04x}:{ins.address:04x}  {ins.bytes.hex():<14} {ins.mnemonic} {ins.op_str}' + ('   ;RELOC' if rel else ''))
            if len(out) >= count: break
            if stop_ret and ins.mnemonic in ('ret', 'retf', 'iret'): break
        return '\n'.join(out)

if __name__ == '__main__':
    m = MZ(sys.argv[1])
    seg, off = (int(x, 16) for x in sys.argv[2].split(':'))
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    print(m.dis(seg, off, n, stop_ret=len(sys.argv) <= 4))
