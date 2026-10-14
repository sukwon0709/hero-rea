"""Reference runner for the battle rules: executes MAIN.EXE's own battle routines under
tools/dosemu.py (Unicorn) on generated inputs and prints the results as JSON.

usage: python3 -I tools/battle_ref.py GAME_DIR [count] [seed]

The vitest suite web/test/battle-ref.test.ts runs this and compares every case with the
TypeScript port in web/src/engine/battle/. Inputs are synthetic (random officers, maps and
units); nothing from the game files is printed except the computed numbers.

Routines exercised (image addresses, as in docs/BATTLE.md): 0cf5:48c4 rand, 0cf5:6aee/6c1c attack/defence,
0cf5:73b8 max troops, 1cb6:9184 max MP, 1cb6:7c1e move points, 1cb6:df14 damage,
1cb6:e26c morale loss, 1cb6:e2f4 experience, 1cb6:a2aa tactic success, 1cb6:c018 range shapes,
1cb6:c9bc movement fill, 1cb6:c4f2 influence, 1cb6:c2be+c9bc(flag 4) AI cell evaluation,
1cb6:dc00 attack-nearest planning.
"""
import json, os, random, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dosemu import Machine  # noqa: E402
from mz import MZ  # noqa: E402

LOAD = 0x0100           # image segment 0 is loaded here
DG = LOAD + 0x313A      # DGROUP
SEG_MAP = 0x5000        # handle DS:0x677a (terrain +0xf00, units +0x12c0, grid +0x18bc, path +0x1c7c)
SEG_ATT = 0x6000        # handle DS:0x6780 (foe map +0, influence +0xf00)
SEG_STR = 0x7000        # handle DS:0x678c (string scratch)
SEG_SPR = 0x8000        # handle DS:0x6774
SP = 0xFEC0             # stack inside DGROUP (SS = DS in the large model)

UNITS, OFFICERS, ITEMS, STATE, COMBAT = 0xE2A2, 0x7A94, 0xD09A, 0xE196, 0xE52E


def G(addr):
    """Image seg:off (as in docs/) -> loaded seg:off."""
    s, o = (int(x, 16) for x in addr.split(':'))
    return s + LOAD, o


class Main:
    def __init__(self, game_dir):
        mz = MZ(os.path.join(game_dir, 'MAIN.EXE'))
        img = bytearray(mz.image)
        for off, seg in mz.relocs:
            p = seg * 16 + off
            struct.pack_into('<H', img, p, (struct.unpack_from('<H', img, p)[0] + LOAD) & 0xffff)
        self.m = Machine()
        self.m.load(LOAD, img)
        self.base = bytes(self.m.mu.mem_read(DG * 16, 0x10000))
        self.reset()

    def reset(self):
        mu = self.m.mu
        mu.mem_write(DG * 16, self.base)
        for seg in (SEG_MAP, SEG_ATT, SEG_STR, SEG_SPR):
            mu.mem_write(seg * 16, b'\0' * 0x10000)
        for h, seg in ((0x677a, SEG_MAP), (0x6780, SEG_ATT), (0x678c, SEG_STR), (0x6774, SEG_SPR)):
            self.w16(h, seg)

    # DGROUP access
    def w8(self, off, v): self.m.mu.mem_write(DG * 16 + off, bytes([v & 0xff]))
    def w16(self, off, v): self.m.mu.mem_write(DG * 16 + off, struct.pack('<H', v & 0xffff))
    def w32(self, off, v): self.m.mu.mem_write(DG * 16 + off, struct.pack('<I', v & 0xffffffff))
    def r8(self, off): return self.m.mu.mem_read(DG * 16 + off, 1)[0]
    def r16(self, off): return struct.unpack('<H', self.m.mu.mem_read(DG * 16 + off, 2))[0]
    def r32(self, off): return struct.unpack('<I', self.m.mu.mem_read(DG * 16 + off, 4))[0]
    def seg_write(self, seg, off, data): self.m.mu.mem_write(seg * 16 + off, bytes(data))
    def seg_read(self, seg, off, n): return bytes(self.m.mu.mem_read(seg * 16 + off, n))

    def call(self, addr, args=(), regs=None):
        """Far call; args are listed as [bp+6], [bp+8], ... (Pascal: last pushed first)."""
        s, o = G(addr)
        r = {'ds': DG, 'es': DG}
        r.update(regs or {})
        self.m.call_far(s, o, r, stack_seg=DG, sp=SP, push_words=list(args))
        return self.m.reg('ax'), self.m.reg('dx')

    @property
    def seed(self): return self.r32(0xCC8)
    @seed.setter
    def seed(self, v): self.w32(0xCC8, v)

    def officer(self, idx, o):
        p = OFFICERS + idx * 0x2C
        self.w16(p, o.get('id', idx))
        self.w8(p + 0x18, o['lead']); self.w8(p + 0x19, o['force']); self.w8(p + 0x1a, o['intel'])
        self.w16(p + 0x1e, o['hp']); self.w8(p + 0x20, o['cls']); self.w8(p + 0x21, o['level'])
        self.w8(p + 0x22, o.get('exp', 0))
        for i, it in enumerate(o['items']): self.w8(p + 0x23 + i, it)
        return p

    def item(self, idx, value, typ):
        p = ITEMS + idx * 17
        self.w8(p + 0xf, value); self.w8(p + 0x10, typ)

    def unit(self, slot, u):
        p = UNITS + slot * 14
        self.w16(p, u['officer']); self.w8(p + 2, slot)
        for k, off in (('x', 3), ('y', 4), ('target', 5), ('tx', 6), ('ty', 7), ('order', 8), ('status', 9),
                       ('flags', 10), ('mode', 11), ('morale', 12), ('mp', 13)):
            self.w8(p + off, u[k])
        return p


def rnd_officer(R, items=True):
    return {'lead': R.randint(0, 100), 'force': R.randint(0, 100), 'intel': R.randint(0, 100),
            'hp': R.randint(0, 2000), 'cls': R.randrange(19), 'level': R.randint(1, 99), 'exp': R.randint(0, 99),
            'items': [R.choice([0xff, 0xff, R.randrange(64)]) for _ in range(8)] if items else [0xff] * 8}


def gen_items(R):
    return [{'value': R.randint(0, 40), 'type': R.choice([0, 0, 4, 5, 5, 1, 2])} for _ in range(64)]


def put_items(M, items):
    for i, it in enumerate(items): M.item(i, it['value'], it['type'])


def case_rng(M, R):
    seed = R.getrandbits(32)
    ns = [R.choice([0, 1, 5, 6, 11, 16, 100, 150, 300, R.randrange(1, 0x8000)]) for _ in range(12)]
    M.seed = seed
    out = [M.call('0cf5:48c4', regs={'ax': n})[0] for n in ns]
    return {'type': 'rng', 'seed': seed, 'ns': ns, 'out': out, 'after': M.seed}


def case_power(M, R):
    items = gen_items(R); put_items(M, items)
    o = rnd_officer(R)
    p = M.officer(3, o)
    morale = R.randint(0, 100)
    atk = M.call('0cf5:6aee', [p, morale]); dfn = M.call('0cf5:6c1c', [p, morale])
    hp = M.call('0cf5:73b8', [p])[0]
    u = M.unit(0, {'officer': 3, 'x': 0, 'y': 0, 'target': 0xff, 'tx': 0, 'ty': 0, 'order': 0, 'status': 2,
                   'flags': 0x20, 'mode': 1, 'morale': morale, 'mp': 0})
    mp = M.call('1cb6:9184', [u])[0]
    mv = M.call('1cb6:7c1e', [u])[0] & 0xff
    return {'type': 'power', 'items': items, 'officer': o, 'morale': morale,
            'atk': atk[0] | (atk[1] << 16), 'def': dfn[0] | (dfn[1] << 16), 'maxhp': hp, 'maxmp': mp, 'move': mv}


def setup_combat(M, R, kind, param):
    oa, od = rnd_officer(R, False), rnd_officer(R, False)
    pa, pd = M.officer(1, oa), M.officer(2, od)
    sa, sd = R.randrange(45), R.randrange(45)
    while sd == sa: sd = R.randrange(45)
    ua = M.unit(sa, {'officer': 1, 'x': 0, 'y': 0, 'target': 0xff, 'tx': 0, 'ty': 0, 'order': 0, 'status': 2,
                     'flags': 0x20, 'mode': 1, 'morale': 50, 'mp': 0})
    ud = M.unit(sd, {'officer': 2, 'x': 1, 'y': 0, 'target': 0xff, 'tx': 0, 'ty': 0, 'order': 0, 'status': 2,
                     'flags': 0x20, 'mode': 1, 'morale': R.randint(0, 100), 'mp': 0})
    c = {'attack': R.randint(1, 1500), 'defence': R.randint(1, 1500), 'terrain': R.choice([0, 1, 2, 4, 6, 7, 8, 11, 13, 14, 15, 16]),
         'hpd': R.randint(0, 3000), 'morale': R.randint(0, 100), 'weather': R.randrange(6)}
    ia = R.randrange(2)   # index of the attacker in the pair arrays
    idd = 1 - ia
    M.w16(COMBAT + 2 * ia, ua); M.w16(COMBAT + 2 * idd, ud)
    M.w16(COMBAT + 4 + 2 * ia, pa); M.w16(COMBAT + 4 + 2 * idd, pd)
    M.w8(COMBAT + 8, ia); M.w8(COMBAT + 9, idd)
    M.w8(COMBAT + 0xa, kind); M.w8(COMBAT + 0xb, param); M.w8(COMBAT + 0xc, c['terrain'])
    M.w16(COMBAT + 0xf + 2 * idd, c['hpd']); M.w16(COMBAT + 0xf + 2 * ia, 100)
    M.w16(COMBAT + 0x13 + 2 * idd, c['morale'])
    M.w16(COMBAT + 0x17 + 2 * ia, c['attack']); M.w16(COMBAT + 0x17 + 2 * idd, c['defence'])
    M.w16(COMBAT + 0x1b + 2 * ia, oa['cls']); M.w16(COMBAT + 0x1b + 2 * idd, od['cls'])
    for k in (0x1f, 0x21, 0x23, 0x25, 0x27): M.w16(COMBAT + k, 0)
    M.w8(STATE + 4, c['weather'])
    return oa, od, sa, sd, c


def case_combat(M, R):
    kind = R.choice([1, 1, 2, 3])
    param = R.choice([0, 1, 2, 5, 7, 0xff]) if kind == 1 else (R.randrange(3) << 4) | R.randrange(3)
    oa, od, sa, sd, c = setup_combat(M, R, kind, param)
    seed = R.getrandbits(32); M.seed = seed
    M.call('1cb6:df14', [COMBAT])
    dmg = M.r16(COMBAT + 0x1f)
    after_dmg = M.seed
    M.call('1cb6:e26c', [COMBAT]); loss = M.r16(COMBAT + 0x23)
    M.call('1cb6:e2f4', [COMBAT]); e1, e2 = M.r16(COMBAT + 0x25), M.r16(COMBAT + 0x27)
    return {'type': 'combat', 'kind': kind, 'param': param, 'oa': oa, 'od': od, 'sa': sa, 'sd': sd, **c,
            'seed': seed, 'dmg': dmg, 'afterDmg': after_dmg, 'loss': loss, 'exp': e1 + e2}


def case_success(M, R):
    oa, od = rnd_officer(R, False), rnd_officer(R, False)
    M.officer(1, oa); M.officer(2, od)
    sa, sd = 3, 20
    for s, i in ((sa, 1), (sd, 2)):
        M.unit(s, {'officer': i, 'x': 0, 'y': 0, 'target': 0xff, 'tx': 0, 'ty': 0, 'order': 0, 'status': 2,
                   'flags': 0x20, 'mode': 1, 'morale': 50, 'mp': 0})
    div = R.choice([0x82, 0x84, 0x82, 0x81])   # bit 7 set = no message
    seed = R.getrandbits(32); M.seed = seed
    ok = M.call('1cb6:a2aa', regs={'ax': sa, 'dx': sd, 'bx': div})[0]
    return {'type': 'success', 'oa': oa, 'od': od, 'div': div, 'seed': seed, 'ok': ok, 'after': M.seed}


# ---- map scenarios ----

def gen_field(R):
    W, H = R.randint(8, 20), R.randint(8, 16)
    terr_pool = [0] * 10 + [1] * 4 + [2] * 2 + [3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 255]
    terrain = [R.choice(terr_pool) for _ in range(W * H)]
    officers, units = [], []
    used = set()
    for slot in range(45):
        if R.random() < 0.35 and len(used) < W * H - 1:
            while True:
                x, y = R.randrange(W), R.randrange(H)
                if (x, y) not in used: break
            used.add((x, y))
            o = rnd_officer(R)
            o['hp'] = R.randint(1, 1500)
            officers.append(o)
            flags = 0x20 if R.random() < 0.9 else 0
            if R.random() < 0.1: flags |= 0x02
            units.append({'officer': len(officers) - 1, 'slot': slot, 'x': x, 'y': y,
                          'target': 0xff, 'tx': R.randrange(W), 'ty': R.randrange(H), 'order': 0, 'status': 2,
                          'flags': flags, 'mode': R.choice([0, 1, 1, 2, 3, 4]), 'morale': R.randint(0, 100),
                          'mp': R.randint(0, 80)})
        else:
            units.append({'officer': 0, 'slot': slot, 'x': 0, 'y': 0, 'target': 0xff, 'tx': 0, 'ty': 0, 'order': 0,
                          'status': 0, 'flags': 0x20, 'mode': 7, 'morale': 100, 'mp': 0})
    placed = [u['slot'] for u in units if u['status'] == 2]
    for u in units:
        if u['status'] == 2 and placed and R.random() < 0.3:
            u['target'] = R.choice(placed)
    return {'w': W, 'h': H, 'terrain': terrain, 'officers': officers, 'units': units,
            'items': gen_items(R), 'weather': R.randrange(6)}


def load_field(M, F):
    M.reset()
    W, H = F['w'], F['h']
    M.w8(0xE194, W); M.w8(0xE195, H); M.w8(STATE + 4, F['weather'])
    M.seg_write(SEG_MAP, 0xF00, F['terrain'])
    umap = [0xff] * (W * H)
    for i, o in enumerate(F['officers']): M.officer(i, o)
    put_items(M, F['items'])
    for u in F['units']:
        M.unit(u['slot'], u)
        if u['status'] == 2: umap[u['y'] * W + u['x']] = u['slot']
    M.seg_write(SEG_MAP, 0x12C0, umap)
    M.w8(0xE51C, 0xff)


def snapshot(M, F):
    W, H = F['w'], F['h']
    n = W * H
    return {'grid': list(M.seg_read(SEG_MAP, 0x18BC, n)), 'foe': list(M.seg_read(SEG_ATT, 0, n)),
            'infl': list(M.seg_read(SEG_ATT, 0xF00, n)),
            'ai': [M.r8(0xE51C), M.r8(0xE51E), M.r8(0xE51F), M.r8(0xE520), M.r8(0xE521), M.r8(0xE522),
                   M.r8(0xE523), M.r8(0xE524)],
            'after': M.seed}


def case_field(M, R):
    F = gen_field(R)
    live = [u for u in F['units'] if u['status'] == 2 and F['officers'][u['officer']]['cls'] != 17]
    if not live: return None
    u = R.choice(live)
    load_field(M, F)
    up = UNITS + u['slot'] * 14
    res = {'type': 'field', 'field': F, 'slot': u['slot']}
    # range shapes from the unit's square, marking on
    rt = R.choice([0, 1, 2, 3, 4, 0x80, 0x81, 0x82])
    M.seg_write(SEG_MAP, 0x18BC, [0xff] * (F['w'] * F['h']))
    M.seg_write(SEG_ATT, 0, [0xff] * (F['w'] * F['h']))
    allies = R.randrange(2)
    M.w8(0xE51C, 0xff)
    r = M.call('1cb6:c018', [up, allies, rt, up + 3])[0] & 0xff
    lst = []
    p = 0
    while True:
        b = M.m.mu.mem_read((0x30b9 + LOAD) * 16 + p, 1)[0]
        if b == 0xff: break
        lst.append(b); p += 1
    res['range'] = {'rt': rt, 'allies': allies, 'ret': r, 'list': lst,
                    'mark': list(M.seg_read(SEG_MAP, 0x18BC, F['w'] * F['h']))}
    # plain movement fill (player move: flags 0)
    mp = R.randint(0, 9)
    M.call('1cb6:c9bc', [up, 0xff, 0xff, 0, mp, up + 3])
    res['move'] = {'mp': mp, 'grid': list(M.seg_read(SEG_MAP, 0x18BC, F['w'] * F['h']))}
    # AI: prepare + evaluate reachable cells
    seed = R.getrandbits(32)
    M.seed = seed
    ai0 = snapshot(M, F)['ai']
    M.call('1cb6:c2be', [up, 0xff])
    emp = R.randint(1, 8)
    M.call('1cb6:c9bc', [up, 0xff, 0xff, 4, emp, up + 3])
    res['eval'] = {'seed': seed, 'mp': emp, 'ai0': ai0, **snapshot(M, F)}
    # AI: attack-nearest planning
    load_field(M, F)
    seed2 = R.getrandbits(32)
    M.seed = seed2
    ai0 = snapshot(M, F)['ai']
    M.call('1cb6:c2be', [up, 0xff])
    M.call('1cb6:dc00', [up, emp])
    res['nearest'] = {'seed': seed2, 'mp': emp, 'ai0': ai0, **snapshot(M, F)}
    # influence spreading from a random square
    load_field(M, F)
    M.seg_write(SEG_ATT, 0xF00, [0] * (F['w'] * F['h']))
    sx, sy, v = R.randrange(F['w']), R.randrange(F['h']), R.choice([30, 50, 70])
    M.seg_write(DG, 0xFF00, [sx, sy])
    M.call('1cb6:c4f2', regs={'ax': v, 'bx': 0xFF00})
    res['spread'] = {'x': sx, 'y': sy, 'v': v, 'infl': list(M.seg_read(SEG_ATT, 0xF00, F['w'] * F['h']))}
    return res


def main():
    game = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    R = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 1)
    M = Main(game)
    cases = []
    gens = [case_rng, case_power, case_combat, case_combat, case_success, case_field, case_field]
    i = 0
    while len(cases) < count:
        g = gens[i % len(gens)]
        i += 1
        M.reset()
        c = g(M, R)
        if c is not None: cases.append(c)
    json.dump(cases, sys.stdout)


if __name__ == '__main__':
    main()
