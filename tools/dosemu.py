"""Tiny real-mode harness on top of Unicorn for running pieces of the original code.

Provides 1 MB of RAM, a VGA planar memory model at A000:0000 (write modes 0/1/2, map mask,
read map select, bit mask, set/reset, logical ops), port I/O hooks and an interrupt hook.
Used to produce ground-truth output (e.g. TF-DCE image decoding through TFDED.COM) that the
TypeScript ports are checked against.
"""
from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_INSN, UC_HOOK_INTR, UC_HOOK_CODE
from unicorn.x86_const import *
import struct


class VGA:
    def __init__(self):
        self.planes = [bytearray(65536) for _ in range(4)]
        self.latch = [0, 0, 0, 0]
        self.seq_idx = 0
        self.gc_idx = 0
        self.seq = [0] * 8
        self.seq[2] = 0x0f
        self.gc = [0] * 16
        self.gc[8] = 0xff
        self.dac_idx = 0
        self.dac_sub = 0
        self.dac = [[0, 0, 0] for _ in range(256)]

    def read(self, off):
        for p in range(4):
            self.latch[p] = self.planes[p][off]
        if self.gc[5] & 8:  # read mode 1: colour compare against gc[2], planes selected by gc[7]
            r = 0xff
            for p in range(4):
                if (self.gc[7] >> p) & 1:
                    cb = 0xff if (self.gc[2] >> p) & 1 else 0
                    r &= ~(self.latch[p] ^ cb) & 0xff
            return r
        return self.planes[self.gc[4] & 3][off]

    def write(self, off, val):
        mode = self.gc[5] & 3
        mask = self.seq[2]
        bm = self.gc[8]
        rot = self.gc[3] & 7
        fn = (self.gc[3] >> 3) & 3
        val = ((val >> rot) | (val << (8 - rot))) & 0xff
        for p in range(4):
            if not (mask >> p) & 1:
                continue
            l = self.latch[p]
            if mode == 1:
                self.planes[p][off] = l
                continue
            if mode == 0:
                v = (0xff if (self.gc[0] >> p) & 1 else 0) if (self.gc[1] >> p) & 1 else val
                b = bm
            elif mode == 2:
                v = 0xff if (val >> p) & 1 else 0
                b = bm
            else:  # mode 3
                v = 0xff if (self.gc[0] >> p) & 1 else 0
                b = bm & val
            if fn == 1: v &= l
            elif fn == 2: v |= l
            elif fn == 3: v ^= l
            self.planes[p][off] = (v & b) | (l & ~b & 0xff)

    def out(self, port, val, size):
        if size == 2:
            self.out(port, val & 0xff, 1)
            self.out(port + 1, val >> 8, 1)
            return
        if port == 0x3c4: self.seq_idx = val & 7
        elif port == 0x3c5: self.seq[self.seq_idx] = val
        elif port == 0x3ce: self.gc_idx = val & 15
        elif port == 0x3cf: self.gc[self.gc_idx] = val
        elif port == 0x3c8: self.dac_idx, self.dac_sub = val, 0
        elif port == 0x3c9:
            self.dac[self.dac_idx][self.dac_sub] = val & 63
            self.dac_sub += 1
            if self.dac_sub == 3:
                self.dac_sub = 0
                self.dac_idx = (self.dac_idx + 1) & 255

    def pixels(self, x0, y0, w, h, base=0, stride=80):
        """Returns w*h 4-bit pixel values of the rectangle (x0 multiple of 8)."""
        out = bytearray(w * h)
        for y in range(h):
            for x in range(w):
                off = base + (y0 + y) * stride + (x0 + x) // 8
                bit = 7 - ((x0 + x) & 7)
                c = 0
                for p in range(4):
                    c |= ((self.planes[p][off] >> bit) & 1) << p
                out[y * w + x] = c
        return out


class Machine:
    def __init__(self):
        self.mu = Uc(UC_ARCH_X86, UC_MODE_16)
        self.mu.mem_map(0, 0xA0000)
        self.vga = VGA()
        self.mu.mmio_map(0xA0000, 0x10000, self._vread, None, self._vwrite, None)
        self.mu.mem_map(0xB0000, 0x50000)
        self.mu.hook_add(UC_HOOK_INSN, self._in, None, 1, 0, UC_X86_INS_IN)
        self.mu.hook_add(UC_HOOK_INSN, self._out, None, 1, 0, UC_X86_INS_OUT)
        self.mu.hook_add(UC_HOOK_INTR, self._intr)
        self.int_handlers = {}  # vector -> python callable(machine) for HLE; else real IVT
        self.stop_addr = 0xFFFF0  # far-return trap address F000:FFF0 → linear 0xFFFF0
        self.mu.mem_write(self.stop_addr, b'\xf4')  # hlt

    # --- VGA plumbing
    def _vread(self, uc, off, size, data):
        v = 0
        for i in range(size):
            v |= self.vga.read(off + i) << (8 * i)
        return v

    def _vwrite(self, uc, off, size, value, data):
        for i in range(size):
            self.vga.write(off + i, (value >> (8 * i)) & 0xff)

    def _in(self, uc, port, size, data):
        if port == 0x3da:  # input status: toggle retrace bits
            self._retrace = getattr(self, '_retrace', 0) ^ 0x09
            return self._retrace
        if port == 0x3cf: return self.vga.gc[self.vga.gc_idx]
        if port == 0x3c5: return self.vga.seq[self.vga.seq_idx]
        return 0

    def _out(self, uc, port, size, value, data):
        self.vga.out(port, value, size)

    def _intr(self, uc, intno, data):
        if intno in self.int_handlers:
            self.int_handlers[intno](self)
            return
        # real-mode dispatch through the IVT
        ip, cs = struct.unpack('<HH', bytes(uc.mem_read(intno * 4, 4)))
        if cs == 0 and ip == 0:
            raise RuntimeError(f'unhandled int {intno:#x} ax={uc.reg_read(UC_X86_REG_AX):#x}')
        sp = uc.reg_read(UC_X86_REG_SP)
        ss = uc.reg_read(UC_X86_REG_SS)
        flags = uc.reg_read(UC_X86_REG_EFLAGS) & 0xffff
        ret_ip = uc.reg_read(UC_X86_REG_IP)
        ret_cs = uc.reg_read(UC_X86_REG_CS)
        sp = (sp - 6) & 0xffff
        uc.mem_write(ss * 16 + sp, struct.pack('<HHH', ret_ip, ret_cs, flags))
        uc.reg_write(UC_X86_REG_SP, sp)
        uc.reg_write(UC_X86_REG_CS, cs)
        uc.reg_write(UC_X86_REG_IP, ip)

    # --- helpers
    def load(self, seg, data):
        self.mu.mem_write(seg * 16, bytes(data))

    def set_vector(self, n, seg, off):
        self.mu.mem_write(n * 4, struct.pack('<HH', off, seg))

    def call_far(self, seg, off, regs=None, stack_seg=0x9000, sp=0xFFF0, push_words=(), limit=200_000_000):
        mu = self.mu
        sp -= 2 * len(push_words)
        for i, w in enumerate(push_words):
            mu.mem_write(stack_seg * 16 + sp + 2 * i, struct.pack('<H', w & 0xffff))
        sp -= 4
        mu.mem_write(stack_seg * 16 + sp, struct.pack('<HH', 0xFFF0, 0xF000))
        mu.reg_write(UC_X86_REG_SS, stack_seg)
        mu.reg_write(UC_X86_REG_SP, sp)
        for k, v in (regs or {}).items():
            mu.reg_write(getattr(__import__('unicorn.x86_const', fromlist=['x']), 'UC_X86_REG_' + k.upper()), v)
        mu.reg_write(UC_X86_REG_CS, seg)
        mu.emu_start(seg * 16 + off, self.stop_addr, count=limit)

    def call_int(self, n, regs=None, **kw):
        """Invokes interrupt n through a stub `int n; retf` placed at F000:FF00."""
        self.mu.mem_write(0xFFF00, bytes([0xcd, n, 0xcb]))
        self.call_far(0xF000, 0xFF00, regs, **kw)

    def reg(self, name):
        return self.mu.reg_read(getattr(__import__('unicorn.x86_const', fromlist=['x']), 'UC_X86_REG_' + name.upper()))
