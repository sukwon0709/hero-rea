"""Reference OPL register stream: runs the original SBOPL2.COM (int 66h music driver) under tools/dosemu.py.

The driver is set up the way its installer leaves it (0:129B → 0:11B9/0:115A), the timer
interrupt handler (0:0225) is invoked once per emulated PIT tick (1193182/4096 Hz), and every
write to the OPL ports 0x388/0x389 (and 0x220-0x22F, which this driver never touches) is
recorded together with the tick number.

usage:
  sbopl2_ref.py GAME_DIR music FILE.R3 ENTRY TICKS [loop]   -> JSON list [[tick, reg, val], ...]
  sbopl2_ref.py GAME_DIR sfx N TICKS                          (SFX bank inside MAIN.EXE)
  sbopl2_ref.py GAME_DIR script FILE.R3 ENTRY TICKS '[[tick, ah, al], ...]'  (int 66h calls before a tick)
  sbopl2_ref.py GAME_DIR batch TICKS MUSIC.R3:0 ... sfx:1 ...  -> JSON {job: writes}
The first record block (tick -1) is the driver's reset sequence.
"""
import json, os, struct, sys
sys.path.insert(0, os.path.dirname(__file__))
from dosemu import Machine

DRV = 0x1000     # PSP segment of the driver
MUS = 0x2000     # music bank segment (offset 0)
SFX = 0x3000     # SFX bank segment
SFX_MAIN_LIN = 0x30210  # MAIN.EXE image segment 0x3021 (bank at 3021:0004, see MAIN 0CF5:5EE0)


class OplMachine(Machine):
    def __init__(self):
        super().__init__()
        self.writes = []
        self.tick = -1
        self._idx = 0

    def _out(self, uc, port, size, value, data):
        if port in (0x388, 0x220, 0x222, 0x228):
            self._idx = value & 0xff
        elif port in (0x389, 0x221, 0x223, 0x229):
            self.writes.append((self.tick, self._idx, value & 0xff))
        elif 0x3c0 <= port <= 0x3df:
            super()._out(uc, port, size, value, data)

    def _in(self, uc, port, size, data):
        return 0

    def call_int(self, n, regs=None, **kw):
        # one stub per vector: Unicorn keeps stale translations of a rewritten stub
        addr = 0xFE000 + n * 4
        self.mu.mem_write(addr, bytes([0xcd, n, 0xcb]))
        self.call_far(0xF000, addr - 0xF0000, regs, **kw)


def read_entry(path, idx):
    d = open(path, 'rb').read()
    n = struct.unpack_from('<H', d, 0)[0]
    off, sz = struct.unpack_from('<IH', d, 2 + 6 * idx)
    base = 2 + 6 * n
    return d[base + off: base + off + sz]


def sfx_bank(game_dir):
    sys.path.insert(0, os.path.dirname(__file__))
    from mz import MZ
    img = MZ(os.path.join(game_dir, 'MAIN.EXE')).image
    return bytes(img[SFX_MAIN_LIN: SFX_MAIN_LIN + 0x10000])


class Driver:
    def __init__(self, game_dir):
        m = self.m = OplMachine()
        com = open(os.path.join(game_dir, 'SBOPL2.COM'), 'rb').read()
        m.load(DRV, b'\0' * 0x100 + com)
        mem = m.mu
        base = DRV * 16
        mem.mem_write(0xFFF10, b'\xcf')                       # iret: the "old" int 8 handler
        mem.mem_write(base + 0x114, struct.pack('<HH', 0xFF10, 0xF000))
        mem.mem_write(base + 0x128, b'\x01')                  # installed flag (0:11B9)
        m.set_vector(0x66, DRV, 0x108)
        m.set_vector(0x08, DRV, 0x225)
        # near-call stub for the OPL reset routine 0:115A
        mem.mem_write(base + 0x1400, b'\xe8' + struct.pack('<h', 0x115A - 0x1403) + b'\xcb')
        m.call_far(DRV, 0x1400, {'ds': DRV, 'es': DRV})

    def api(self, ah, al=0, dl=0, ds=0, dx=None):
        regs = {'ax': (ah << 8) | al, 'dx': dl if dx is None else dx, 'ds': ds, 'bx': 0}
        self.m.call_int(0x66, regs)
        return self.m.reg('ax')

    def irq(self, n):
        for _ in range(n):
            self.m.tick += 1
            self.m.call_int(0x08)


def run_music(game_dir, fname, entry, ticks, loop=1):
    d = Driver(game_dir)
    d.m.load(MUS, read_entry(os.path.join(game_dir, fname), entry))
    d.api(0x00, ds=MUS, dx=0)       # register bank (MAIN 0:B52A)
    d.api(0x01, al=1)               # play song 1 (MAIN 0CF5:5F8E)
    d.api(0x04, al=loop)            # repeat flag (MAIN 0CF5:5F2E)
    d.irq(ticks)
    return d.m.writes


def run_sfx(game_dir, n, ticks):
    d = Driver(game_dir)
    d.m.load(SFX, sfx_bank(game_dir))
    d.api(0x10, ds=SFX, dx=4)       # register SFX bank (MAIN 0CF5:5E90)
    d.api(0x11, al=n)               # play SFX n (1-based, MAIN 0CF5:619A)
    d.irq(ticks)
    return d.m.writes


def run_script(game_dir, fname, entry, ticks, events):
    """Music bank FILE[ENTRY] and the MAIN SFX bank registered, then int 66h calls
    events = [[tick, ah, al], ...] issued just before timer tick `tick`."""
    d = Driver(game_dir)
    d.m.load(MUS, read_entry(os.path.join(game_dir, fname), entry))
    d.m.load(SFX, sfx_bank(game_dir))
    d.api(0x00, ds=MUS, dx=0)
    d.api(0x10, ds=SFX, dx=4)
    ev = sorted(events)
    i = 0
    for t in range(ticks):
        while i < len(ev) and ev[i][0] <= t:
            d.m.tick = t - 1
            d.api(ev[i][1], al=ev[i][2])
            i += 1
        d.m.tick = t - 1
        d.irq(1)
    return d.m.writes


if __name__ == '__main__':
    gd, kind = sys.argv[1], sys.argv[2]
    if kind == 'batch':
        # batch TICKS FILE:ENTRY ... | sfx:N ...  -> {"FILE:ENTRY": writes, ...}
        ticks = int(sys.argv[3])
        res = {}
        for job in sys.argv[4:]:
            f, n = job.split(':')
            res[job] = run_sfx(gd, int(n), ticks) if f == 'sfx' else run_music(gd, f, int(n), ticks)
        json.dump(res, sys.stdout, separators=(',', ':'))
        sys.exit(0)
    if kind == 'script':
        # script FILE ENTRY TICKS '[[tick,ah,al],...]'
        w = run_script(gd, sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), json.loads(sys.argv[6]))
        json.dump(w, sys.stdout, separators=(',', ':'))
        sys.exit(0)
    if kind == 'music':
        w = run_music(gd, sys.argv[3], int(sys.argv[4]), int(sys.argv[5]),
                      int(sys.argv[6]) if len(sys.argv) > 6 else 1)
    else:
        w = run_sfx(gd, int(sys.argv[3]), int(sys.argv[4]))
    json.dump(w, sys.stdout, separators=(',', ':'))
