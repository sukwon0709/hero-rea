"""Reference runner for the computer phases: executes MAIN.EXE's own 1cb6:3f32 (both computer
passes: regeneration and cure for the enemy side, the action order 3e12, and every unit's whole
action ce50 = plan, move c3f4, arrival 8a6e, attack cd4a/e91a or tactic b2d6, departures 8504)
under tools/dosemu.py (Unicorn) on generated battle fields, and prints the results as JSON.

usage: python3 -I tools/ai_ref.py GAME_DIR [count] [seed]

web/test/ai-ref.test.ts replays every case through the TypeScript port and compares the units,
officers, unit map and the RNG seed afterwards. Screen, sound, message and script-event routines
are stubbed (tools/exp_ref.py), plus the move/face animations and the post-action events
(8ad2, 4abc). Inputs are synthetic; nothing from the game files is printed except computed numbers.
"""
import json, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from battle_ref import G, SEG_MAP, UNITS, STATE, rnd_officer, gen_items, put_items  # noqa: E402
import exp_ref  # noqa: E402

exp_ref.STUBS.update({
    '1cb6:8e82': 4,   # unit panel / blink before acting
    '1cb6:91ca': 4,   # one step of the move animation (c3f4 updates the position itself)
    '1cb6:8d74': 4,   # facing flag + sprite mirroring (flag 0x10 is not compared)
    '1cb6:8ad2': 2,   # the acting unit's script events
    '1cb6:4abc': 2,   # victory check / "all enemies gone" events
    '1cb6:5e0e': 4,   # unit list redraw
    '1cb6:9b4c': 2,   # unit detail panel
})


def gen_phase(R):
    W, H = R.randint(8, 18), R.randint(8, 14)
    pool = [0] * 12 + [1] * 4 + [2] * 2 + [3, 4, 5, 6, 7, 7, 8, 8, 9, 10, 11, 12, 13, 14, 14, 15, 16, 17]
    terrain = [R.choice(pool) for _ in range(W * H)]
    officers, units = [], []
    used = set()
    dens = R.choice([0.15, 0.25, 0.35])
    for slot in range(45):
        blank = {'officer': 0xffff, 'slot': slot, 'x': 0xff, 'y': 0xff, 'target': 0xff, 'tx': 0xff, 'ty': 0xff,
                 'order': 0, 'status': 0, 'flags': 0x20, 'mode': 0, 'morale': 100, 'mp': 0}
        if R.random() >= dens or len(used) >= W * H - 1:
            units.append(blank)
            continue
        while True:
            x, y = R.randrange(W), R.randrange(H)
            if (x, y) not in used: break
        o = rnd_officer(R)
        o['level'] = R.randint(1, 40)
        o['cls'] = R.randrange(19)
        if o['cls'] == 17: o['cls'] = 16
        o['hp'] = R.randint(1, 2500)
        oi = len(officers)
        o['id'] = oi
        officers.append(o)
        status = 2 if R.random() < 0.9 else R.choice([1, 4])
        if status == 2: used.add((x, y))
        flags = 0x20 if R.random() < 0.9 else 0
        if R.random() < 0.08: flags |= 0x02
        if R.random() < 0.05: flags |= 0x04
        if slot < 15:
            mode = 7 if R.random() < 0.7 else R.choice([0, 1, 1, 2, 3, 4])
        else:
            mode = R.choice([0, 0, 1, 1, 1, 2, 3, 4])
        units.append({'officer': oi, 'slot': slot, 'x': x, 'y': y, 'target': 0xff, 'tx': R.randrange(W),
                      'ty': R.randrange(H), 'order': 0, 'status': status, 'flags': flags, 'mode': mode,
                      'morale': R.choice([R.randint(0, 100), 100, R.randint(20, 45)]), 'mp': R.randint(0, 60)})
    placed = [u['slot'] for u in units if u['officer'] != 0xffff]
    for u in units:
        if u['officer'] != 0xffff and u['mode'] in (0, 4) and placed and R.random() < 0.6:
            other = [s for s in placed if (s < 15) != (u['slot'] < 15)]
            if other: u['target'] = R.choice(other)
    return {'w': W, 'h': H, 'terrain': terrain, 'officers': officers, 'units': units,
            'items': gen_items(R), 'weather': R.randrange(6)}


def load(M, F, R):
    M.reset()
    W, H = F['w'], F['h']
    M.w8(0xE194, W); M.w8(0xE195, H); M.w8(STATE + 4, F['weather']); M.w8(STATE + 1, 0)
    M.w8(0x3A3C, 0)
    M.seg_write(SEG_MAP, 0xF00, F['terrain'])
    umap = [0xff] * (W * H)
    for i, o in enumerate(F['officers']): M.officer(i, o)
    put_items(M, F['items'])
    for u in F['units']:
        M.unit(u['slot'], u)
        if u['status'] == 2: umap[u['y'] * W + u['x']] = u['slot']
    M.seg_write(SEG_MAP, 0x12C0, umap)
    M.w8(0xE51C, 0xff)
    closeup = R.randrange(2)
    M.w8(0x7A84, 0x10 if closeup else 0)
    F['closeupOff'] = closeup


def read_units(M):
    out = []
    for s in range(45):
        p = UNITS + s * 14
        out.append({'x': M.r8(p + 3), 'y': M.r8(p + 4), 'target': M.r8(p + 5), 'tx': M.r8(p + 6), 'ty': M.r8(p + 7),
                    'status': M.r8(p + 9), 'flags': M.r8(p + 10), 'mode': M.r8(p + 11), 'morale': M.r8(p + 12),
                    'mp': M.r8(p + 13)})
    return out


def case_phase(M, R):
    F = gen_phase(R)
    if not any(u['officer'] != 0xffff and u['slot'] >= 15 for u in F['units']): return None
    load(M, F, R)
    seed = R.getrandbits(32); M.seed = seed
    M.call('1cb6:3f32', [STATE])
    W, H = F['w'], F['h']
    return {'type': 'phase', 'field': F, 'seed': seed, 'after': M.seed, 'result': M.r8(STATE + 1),
            'units': read_units(M), 'officers': [M.read_officer(i) for i in range(len(F['officers']))],
            'umap': list(M.seg_read(SEG_MAP, 0x12C0, W * H))}


def main():
    game = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    R = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 1)
    M = exp_ref.ExpMain(game)
    out = []
    while len(out) < count:
        M.reset()
        c = case_phase(M, R)
        if c is not None: out.append(c)
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
