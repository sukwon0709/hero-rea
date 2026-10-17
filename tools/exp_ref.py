"""Reference runner for experience and level-ups: executes MAIN.EXE's own routines under
tools/dosemu.py (Unicorn) and prints the results as JSON.

usage: python3 -I tools/exp_ref.py GAME_DIR [count] [seed]

Cases (web/test/exp-ref.test.ts compares each with the TypeScript port):
  - 'level': 0cf5:6f64 (level-up) on a random officer and a random new total, generic ids included;
  - 'fight': a whole exchange through 1cb6:e91a (damage, morale, hit/kill exp, the defender's
    counterattack with its own exp, and the level-ups via 6f64), on two adjacent units;
  - 'cast': a status or heal tactic through 1cb6:b2d6 (the +8/+12 bonus, failed rolls, useless
    heals);
  - 'bonus': the victory bonus loop 1cb6:4a30.
Screen, sound and message routines are stubbed (a far return with the routine's own stack
adjustment), so only the game state is computed. Inputs are synthetic; nothing from the game files
is printed except the computed numbers.
"""
import json, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unicorn import UC_HOOK_CODE  # noqa: E402
from unicorn.x86_const import UC_X86_REG_AX, UC_X86_REG_BP, UC_X86_REG_SP, UC_X86_REG_SS, UC_X86_REG_CS, UC_X86_REG_IP  # noqa: E402
from battle_ref import Main, G, LOAD, SEG_MAP, UNITS, OFFICERS, STATE, COMBAT, rnd_officer, gen_items, put_items  # noqa: E402

# Display/sound/message routines: image address -> bytes popped by their far return.
STUBS = {
    '0cf5:3c5e': 0,   # message box (cdecl)
    '0cf5:6280': 4, '0cf5:631a': 2, '0cf5:46d4': 8, '0cf5:4374': 2,   # text buffers / names
    '0cf5:25ec': 0, '0cf5:25fe': 0,   # timer waits
    '1cb6:6418': 6,   # scroll to a cell
    '1cb6:dcc0': 4, '1cb6:e4a6': 2, '1cb6:edb8': 2, '1cb6:fa26': 2, '1cb6:fb2e': 2, '1cb6:fc3a': 2,
    '1cb6:fcba': 2, '1cb6:febc': 2,   # attack animations and close-ups
    '1cb6:75e0': 8, '1cb6:5c6c': 2, '1cb6:638a': 4, '1cb6:5bf6': 2, '1cb6:373c': 2, '1cb6:58f0': 2,
    '1cb6:7074': 2, '1cb6:8748': 2, '1cb6:6756': 2,   # redraws
    # script events run when a unit leaves (1cb6:8504 -> 85d4..864a): "no event"
    '0cf5:86b8': (4, 0), '0cf5:842a': (2, 0xffff), '0cf5:81fe': (2, 0xffff), '0cf5:8494': (2, 0xffff),
    '0cf5:85e0': (4, 0xffff),
    '1cb6:79fa': 0, '0cf5:600a': 4, '0cf5:c15a': 4,   # retreat portrait and lines, music
    '1cb6:8264': 2,   # reload a unit's sprite (confusion, class change)
    '1cb6:502a': 0,   # tactic animation (register arguments, no random draws)
}


class ExpMain(Main):
    def __init__(self, game_dir):
        super().__init__(game_dir)
        self.stub_at = {}
        for a, n in STUBS.items():
            s, o = G(a)
            self.stub_at[s * 16 + o] = n
            self.m.mu.hook_add(UC_HOOK_CODE, self._stub, None, s * 16 + o, s * 16 + o)
        self.m.int_handlers[0x21] = self._dos
        self.m.int_handlers[0x66] = lambda m: None   # sound driver (effects)

    def _dos(self, m):
        """No DOS here: a routine that reaches int 21h needs a stub. Report the far-call chain."""
        uc = m.mu
        cs, ip, bp, ss = (uc.reg_read(r) for r in (UC_X86_REG_CS, UC_X86_REG_IP, UC_X86_REG_BP, UC_X86_REG_SS))
        chain = ['%04x:%04x' % (cs - LOAD, ip)]
        for _ in range(16):
            raw = bytes(uc.mem_read(ss * 16 + bp, 6))
            nbp, rip, rcs = raw[0] | raw[1] << 8, raw[2] | raw[3] << 8, raw[4] | raw[5] << 8
            chain.append('%04x:%04x' % ((rcs - LOAD) & 0xffff, rip))
            if nbp == 0 or nbp == bp: break
            bp = nbp
        raise RuntimeError('int 21h ax=%#x via %s' % (uc.reg_read(UC_X86_REG_AX), ' <- '.join(chain)))

    def _stub(self, uc, addr, size, data):
        n = self.stub_at.get(addr)
        if n is None:
            return
        if isinstance(n, tuple):
            n, ax = n
            uc.reg_write(UC_X86_REG_AX, ax)
        ss, sp = uc.reg_read(UC_X86_REG_SS), uc.reg_read(UC_X86_REG_SP)
        raw = bytes(uc.mem_read(ss * 16 + sp, 4))
        ip, cs = raw[0] | raw[1] << 8, raw[2] | raw[3] << 8
        uc.reg_write(UC_X86_REG_SP, (sp + 4 + n) & 0xffff)
        uc.reg_write(UC_X86_REG_CS, cs)
        uc.reg_write(UC_X86_REG_IP, ip)

    def read_officer(self, idx):
        p = OFFICERS + idx * 0x2C
        return {'hp': self.r16(p + 0x1e), 'cls': self.r8(p + 0x20), 'level': self.r8(p + 0x21), 'exp': self.r8(p + 0x22)}

    def read_unit(self, slot):
        p = UNITS + slot * 14
        return {'status': self.r8(p + 9), 'flags': self.r8(p + 10), 'morale': self.r8(p + 12), 'mp': self.r8(p + 13)}


GENERIC_IDS = [0x100, 0x120, 0x15f, 0x2140, 0x0e10]


def officer_id(R, idx):
    r = R.random()
    if r < 0.15:
        return R.choice(GENERIC_IDS)
    return idx


def case_level(M, R):
    o = rnd_officer(R, False)
    o['level'] = R.choice([1, 5, 12, 20, 50, 97, 98, 99, 100, R.randint(1, 120)])
    o['id'] = officer_id(R, 3)
    total = R.choice([0, 50, 99, 100, 101, 199, 200, 350, 999, R.randint(0, 2000)])
    p = M.officer(3, o)
    M.call('0cf5:6f64', [p, total])
    return {'type': 'level', 'officer': o, 'total': total, 'after': M.read_officer(3)}


def blank_unit(slot):
    return {'officer': 0, 'slot': slot, 'x': 0, 'y': 0, 'target': 0xff, 'tx': 0, 'ty': 0, 'order': 0,
            'status': 0, 'flags': 0x20, 'mode': 7, 'morale': 100, 'mp': 0}


def small_field(M, R, officers, placed):
    """placed: list of (slot, officer index, x, y, morale, mp, flags)."""
    W, H = 6, 5
    terrain = [R.choice([0, 0, 0, 1, 2, 4, 6, 7, 8, 11, 13, 14]) for _ in range(W * H)]
    weather = R.randrange(6)
    items = gen_items(R)
    units = [blank_unit(s) for s in range(45)]
    for slot, oi, x, y, morale, mp, flags in placed:
        units[slot] = {'officer': oi, 'slot': slot, 'x': x, 'y': y, 'target': 0xff, 'tx': x, 'ty': y, 'order': 0,
                       'status': 2, 'flags': flags, 'mode': 1, 'morale': morale, 'mp': mp}
    M.reset()
    M.w8(0xE194, W); M.w8(0xE195, H); M.w8(STATE + 4, weather)
    M.seg_write(SEG_MAP, 0xF00, terrain)
    umap = [0xff] * (W * H)
    for i, o in enumerate(officers): M.officer(i, o)
    put_items(M, items)
    for u in units:
        M.unit(u['slot'], u)
        if u['status'] == 2: umap[u['y'] * W + u['x']] = u['slot']
    M.seg_write(SEG_MAP, 0x12C0, umap)
    closeup = R.randrange(2)
    M.w8(0x7A84, 0x10 if closeup else 0)  # 4e42(0x7a80) = [0x7a84]; & 0xf0: close-ups off
    return {'w': W, 'h': H, 'terrain': terrain, 'weather': weather, 'items': items, 'units': units,
            'officers': officers, 'closeupOff': closeup}


def fight_officers(R):
    oa, od = rnd_officer(R, False), rnd_officer(R, False)
    for o in (oa, od):
        o['level'] = R.randint(1, 40) if R.random() < 0.8 else R.randint(1, 99)
        o['hp'] = R.randint(1, 2500)
        o['cls'] = R.randrange(19)
        if o['cls'] == 17: o['cls'] = 16
    oa['id'] = officer_id(R, 0)
    od['id'] = officer_id(R, 1)
    # sometimes a weak defender, so kills (and kill exp) happen
    if R.random() < 0.35: od['hp'] = R.randint(1, 120)
    return oa, od


def case_fight(M, R):
    oa, od = fight_officers(R)
    sa = R.randrange(45)
    sd = R.randrange(45)
    while sd == sa: sd = R.randrange(45)
    if R.random() < 0.7:  # mostly a player unit against an enemy, either way round
        sa, sd = (R.randrange(15), R.randrange(15, 45)) if R.random() < 0.6 else (R.randrange(15, 45), R.randrange(15))
    ma, md = R.randint(20, 100), R.randint(1, 100)
    F = small_field(M, R, [oa, od], [(sa, 0, 2, 2, ma, 0, 0x20), (sd, 1, 3, 2, md, 0, 0x20)])
    seed = R.getrandbits(32); M.seed = seed
    # e91a(combat, param, kind, defender slot, attacker slot): kind 1 physical (param = attack type),
    # 2 damage tactic and 3 scroll item (param = element << 4 | power)
    kind = R.choice([1, 1, 1, 2, 3])
    param = R.choice([0, 1, 2, 5, 3]) if kind == 1 else (R.randrange(3) << 4) | R.randrange(3)
    M.call('1cb6:e91a', [COMBAT, param, kind, sd, sa])
    return {'type': 'fight', 'field': F, 'sa': sa, 'sd': sd, 'kind': kind, 'param': param, 'seed': seed, 'after': M.seed,
            'oa': M.read_officer(0), 'od': M.read_officer(1), 'ua': M.read_unit(sa), 'ud': M.read_unit(sd)}


def case_cast(M, R):
    """A tactic by a computer-controlled caster (target from DS:0xe51c, no prompts) via b2d6."""
    oc, ot, o3 = rnd_officer(R, False), rnd_officer(R, False), rnd_officer(R, False)
    for o in (oc, ot, o3):
        o['level'] = R.randint(1, 50)
        o['hp'] = R.randint(1, 2500)
        o['cls'] = R.randrange(19)
        if o['cls'] == 17: o['cls'] = 16
    if R.random() < 0.3: oc['cls'] = R.choice([12, 18])
    oc['id'] = officer_id(R, 0)
    t = R.choice(list(range(15, 36)) + [R.randrange(15)])
    sc = R.randrange(15) if R.random() < 0.6 else R.randrange(15, 45)
    ally = 21 <= t <= 35
    pool = [s for s in (range(15) if sc < 15 else range(15, 45)) if s != sc] if ally else list(range(15, 45) if sc < 15 else range(15))
    st = R.choice(pool)
    pool = [s for s in pool if s != st]
    s3 = R.choice(pool)
    mp = R.choice([0, 5, 10, 20, 40, 255])
    morale = R.choice([20, 50, 80, 100])
    flags = 0x20 | (0x40 if R.random() < 0.2 else 0)
    F = small_field(M, R, [oc, ot, o3], [(sc, 0, 2, 2, 80, mp, 0x20), (st, 1, 3, 2, morale, 0, flags),
                                          (s3, 2, 2, 3, R.choice([30, 100]), 0, 0x20)])
    M.w8(0xE51C, st)
    seed = R.getrandbits(32); M.seed = seed
    M.call('1cb6:b2d6', [UNITS + sc * 14, t])
    return {'type': 'cast', 'field': F, 'sc': sc, 'st': st, 's3': s3, 't': t, 'seed': seed, 'after': M.seed,
            'officers': [M.read_officer(i) for i in range(3)], 'units': [M.read_unit(s) for s in (sc, st, s3)]}


def case_bonus(M, R):
    """Victory bonus (1cb6:4a30): result byte state+1, bonus byte state+0x24."""
    officers, placed = [], []
    for slot in R.sample(range(45), 10):
        o = rnd_officer(R, False)
        o['level'] = R.choice([1, 9, 50, 98, 99, R.randint(1, 99)])
        o['id'] = officer_id(R, len(officers))
        placed.append((slot, len(officers), len(officers) % 6, len(officers) // 6, 100, 0, 0x20))
        officers.append(o)
    F = small_field(M, R, officers, placed)
    status = {}
    for slot, *_ in placed:
        st = R.choice([2, 2, 2, 1, 4])
        status[slot] = st
        M.w8(UNITS + slot * 14 + 9, st)
    result = R.choice([2, 2, 3, 0])
    bonus = R.choice([0, 30, 50, 100, 150, 255])
    M.w8(STATE + 1, result); M.w8(STATE + 0x24, bonus)
    M.call('1cb6:4a30', [STATE])
    return {'type': 'bonus', 'field': F, 'status': status, 'result': result, 'bonus': bonus,
            'officers': [M.read_officer(i) for i in range(len(officers))],
            'statusAfter': {s: M.read_unit(s)['status'] for s in status}}


def main():
    game = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    R = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 1)
    M = ExpMain(game)
    gens = [case_level, case_fight, case_fight, case_cast, case_cast, case_bonus]
    out = []
    i = 0
    while len(out) < count:
        g = gens[i % len(gens)]
        i += 1
        M.reset()
        out.append(g(M, R))
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
