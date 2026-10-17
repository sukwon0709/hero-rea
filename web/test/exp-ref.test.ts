// Experience and level-ups end to end against MAIN.EXE: tools/exp_ref.py runs the original
// level-up (0cf5:6f64), a whole attack exchange (1cb6:e91a: damage, morale, hit/kill exp, the
// counterattack and its exp, level-ups), status/heal tactics (1cb6:b2d6, the +8/+12 bonus) and the
// victory bonus (1cb6:4a30) under Unicorn, and every result is compared with the TypeScript port.
// Skips without HERO_GAME_DIR or without python3 + unicorn.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_DIR, hasGame } from './gamedir';
import { castTactic, fight, unitLeaves, type CombatState } from '../src/engine/battle/combat';
import { Rng, gainExp } from '../src/engine/battle/rules';
import { NONE, Status, type ItemInfo, type Officer, type Unit } from '../src/engine/battle/types';

const TOOLS = join(__dirname, '..', '..', 'tools');

function runRef(count: number, seed: number): any[] | null {
  if (!hasGame) return null;
  const r = spawnSync('python3', ['-I', join(TOOLS, 'exp_ref.py'), GAME_DIR, String(count), String(seed)], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout);
}

const cases = runRef(Number(process.env.EXP_REF_CASES ?? 600), Number(process.env.EXP_REF_SEED ?? 11));

type RefOfficer = { id?: number; lead: number; force: number; intel: number; hp: number; cls: number; level: number; exp: number; items: number[] };
const officer = (o: RefOfficer): Officer => ({ lead: o.lead, force: o.force, intel: o.intel, hp: o.hp, cls: o.cls, level: o.level, exp: o.exp, items: [...o.items] });

function state(F: any, seed: number): CombatState {
  const W = F.w;
  const s: CombatState = {
    width: W,
    height: F.h,
    terrain: Uint8Array.from(F.terrain),
    unitAt: new Uint8Array(W * F.h).fill(NONE),
    units: F.units.map((u: Unit) => ({ ...u })),
    officers: F.officers.map(officer),
    officerIds: F.officers.map((o: RefOfficer, i: number) => o.id ?? i),
    rng: new Rng(seed),
    items: (id: number) => (F.items as ItemInfo[])[id],
    weather: F.weather,
    closeup: !F.closeupOff,
  };
  for (const u of s.units) if (u.status === Status.Field) s.unitAt[u.y * W + u.x] = u.slot;
  return s;
}

const pick = (o: Officer) => ({ hp: o.hp, cls: o.cls, level: o.level, exp: o.exp });
const unitView = (u: Unit) => ({ status: u.status, flags: u.flags, morale: u.morale, mp: u.mp });

describe.skipIf(!cases)('experience and level-ups vs MAIN.EXE', () => {
  const all = cases ?? [];

  it('level-up 0cf5:6f64: 100 per level, several at once, no clamp, generic and Lv99 exempt', () => {
    const list = all.filter((c) => c.type === 'level');
    expect(list.length).toBeGreaterThan(20);
    for (const c of list) {
      const o = officer(c.officer);
      gainExp(o, c.officer.id, c.total);
      expect(pick(o), JSON.stringify(c)).toEqual(c.after);
    }
  });

  it('attack exchange 1cb6:e91a (attacks, damage tactics, scroll items): hit/kill exp, counterattack exp, level-ups', () => {
    const list = all.filter((c) => c.type === 'fight');
    expect(list.length).toBeGreaterThan(50);
    let counters = 0;
    let kills = 0;
    let levelUps = 0;
    for (const c of list) {
      const s = state(c.field, c.seed);
      const res = fight(s, c.sa, c.sd, c.kind, c.param);
      for (const slot of res.left) unitLeaves(s, slot);
      if (res.counter) counters++;
      if (res.damage === c.field.officers[1].hp) kills++;
      if (s.officers[0].level !== c.field.officers[0].level) levelUps++;
      const msg = JSON.stringify({ ...c, field: undefined, in: c.field.officers });
      expect(pick(s.officers[0]), msg).toEqual(c.oa);
      expect(pick(s.officers[1]), msg).toEqual(c.od);
      expect(unitView(s.units[c.sa]), msg).toEqual(c.ua);
      expect(unitView(s.units[c.sd]), msg).toEqual(c.ud);
      expect(s.rng.seed, msg).toBe(c.after);
    }
    // the generated cases do exercise the interesting paths
    expect(counters).toBeGreaterThan(0);
    expect(kills).toBeGreaterThan(5);
    expect(levelUps).toBeGreaterThan(5);
  });

  it('status and heal tactics 1cb6:b2d6: +8 / +12 exp, failed rolls, refused heals', () => {
    const list = all.filter((c) => c.type === 'cast');
    expect(list.length).toBeGreaterThan(50);
    for (const c of list) {
      const s = state(c.field, c.seed);
      const res = castTactic(s, c.sc, c.t, c.st);
      for (const slot of res.left) unitLeaves(s, slot);
      const msg = JSON.stringify({ ...c, field: undefined, in: c.field.officers, mp: c.field.units[c.sc].mp });
      expect(s.officers.map(pick), msg).toEqual(c.officers);
      expect([c.sc, c.st, c.s3].map((k) => unitView(s.units[k])), msg).toEqual(c.units);
      expect(s.rng.seed, msg).toBe(c.after);
    }
  });

  it('victory bonus 1cb6:4a30: every player unit on the field, only on a win', () => {
    const list = all.filter((c) => c.type === 'bonus');
    expect(list.length).toBeGreaterThan(20);
    for (const c of list) {
      const s = state(c.field, 0);
      for (const [slot, st] of Object.entries(c.status)) s.units[Number(slot)].status = st as number;
      // as BattleScene.finish (native/battle/scene.ts)
      if (c.result === 2) {
        if (c.bonus !== 0)
          for (let i = 0; i < 15; i++) {
            const u = s.units[i];
            if (u.status !== Status.Field) continue;
            const o = s.officers[u.officer];
            gainExp(o, s.officerIds![u.officer], o.exp + c.bonus);
          }
        for (const u of s.units) if (u.status === Status.Field) u.status = Status.Reserve;
      }
      expect(s.officers.map(pick), JSON.stringify(c)).toEqual(c.officers);
      for (const [slot, st] of Object.entries(c.statusAfter)) expect(s.units[Number(slot)].status).toBe(st);
    }
  });
});
