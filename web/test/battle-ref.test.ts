// Compares the TypeScript battle rules with MAIN.EXE's own routines, executed by
// tools/battle_ref.py under Unicorn on generated inputs. Skips without the game files or
// without python3 + unicorn.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_DIR, gameFile, hasGame } from './gamedir';
import { Field, floodMove, pickTarget, unitsInRange } from '../src/engine/battle/hex';
import {
  Rng,
  attackPower,
  combatExp,
  defencePower,
  maxHp,
  maxMp,
  moraleLoss,
  movePoints,
  physicalDamage,
  tacticDamage,
  tacticSucceeds,
} from '../src/engine/battle/rules';
import { aiPrepare, createAiState, evaluateReachable, planAttackNearest, spreadInfluence } from '../src/engine/battle/ai';
import { ItemInfo, NONE, Officer, Unit, loadLearnTable } from '../src/engine/battle/types';

const TOOLS = join(__dirname, '..', '..', 'tools');

function runRef(count: number, seed: number): any[] | null {
  if (!hasGame) return null;
  const r = spawnSync('python3', ['-I', join(TOOLS, 'battle_ref.py'), GAME_DIR, String(count), String(seed)], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout);
}

const cases = runRef(Number(process.env.BATTLE_REF_CASES ?? 140), Number(process.env.BATTLE_REF_SEED ?? 7));

type RefOfficer = { lead: number; force: number; intel: number; hp: number; cls: number; level: number; exp: number; items: number[] };
const officer = (o: RefOfficer): Officer => ({ ...o, items: [...o.items] });
const itemLookup = (items: ItemInfo[]) => (id: number) => items[id];

function buildField(F: any): Field {
  const W = F.w;
  const f: Field = {
    width: W,
    height: F.h,
    terrain: Uint8Array.from(F.terrain),
    unitAt: new Uint8Array(W * F.h).fill(NONE),
    units: F.units.map((u: Unit) => ({ ...u })),
    officers: F.officers.map(officer),
  };
  for (const u of f.units) if (u.status === 2) f.unitAt[u.y * W + u.x] = u.slot;
  return f;
}

function aiCheck(F: any, slot: number, ref: any, run: 'eval' | 'nearest', learn: Uint8Array) {
  const f = buildField(F);
  const s = createAiState(f, new Rng(ref.seed), itemLookup(F.items), learn, F.weather);
  const [t, d0, , tac, tp, pp, tt, sc] = ref.ai0;
  Object.assign(s.ai, { target: t, dest: d0 === 0xff ? null : s.ai.dest, tactic: tac, tacticPick: tp, physPick: pp, tacticTarget: tt, score: sc });
  const u = s.units[slot];
  aiPrepare(s, u);
  if (run === 'eval') evaluateReachable(s, u, ref.mp);
  else planAttackNearest(s, u, ref.mp);
  expect(Array.from(s.foeMap)).toEqual(ref.foe);
  if (process.env.BATTLE_DEBUG && Array.from(s.influence).join() !== ref.infl.join()) {
    for (let i = 0; i < ref.infl.length; i++)
      if (s.influence[i] !== ref.infl[i])
        console.log('cell', i % F.w, Math.floor(i / F.w), 'terrain', F.terrain[i], 'ts', s.influence[i], 'ref', ref.infl[i], 'unit', s.unitAt[i], 'mode', u.mode, 'pos', u.x, u.y);
  }
  expect(Array.from(s.influence)).toEqual(ref.infl);
  expect(Array.from(s.grid)).toEqual(ref.grid);
  const [e51c, e51e, e51f, e520, e521, e522, e523, e524] = ref.ai;
  expect(s.ai.target).toBe(e51c);
  expect(s.ai.dest === null ? 0xff : s.ai.dest[0]).toBe(e51e);
  if (s.ai.dest) expect(s.ai.dest[1]).toBe(e51f);
  expect(s.ai.tactic).toBe(e520);
  expect(s.ai.tacticPick).toBe(e521);
  expect(s.ai.physPick).toBe(e522);
  expect(s.ai.tacticTarget).toBe(e523);
  expect(s.ai.score).toBe(e524);
  expect(s.rng.seed).toBe(ref.after);
}

describe.skipIf(!cases)('battle rules vs MAIN.EXE', () => {
  const all = cases ?? [];
  const learn = hasGame ? loadLearnTable(gameFile('MAIN.EXE')) : new Uint8Array(0);

  it('rand (0cf5:4884/48c4)', () => {
    for (const c of all.filter((c) => c.type === 'rng')) {
      const r = new Rng(c.seed);
      expect(c.ns.map((n: number) => r.rand(n))).toEqual(c.out);
      expect(r.seed).toBe(c.after);
    }
  });

  it('attack/defence/max troops/max MP/move points', () => {
    for (const c of all.filter((c) => c.type === 'power')) {
      const o = officer(c.officer);
      const items = itemLookup(c.items);
      expect(attackPower(o, c.morale, items)).toBe(c.atk & 0xffff);
      expect(defencePower(o, c.morale, items)).toBe(c.def & 0xffff);
      expect(maxHp(o)).toBe(c.maxhp);
      expect(maxMp(o)).toBe(c.maxmp);
      expect(movePoints(o, items)).toBe(c.move);
    }
  });

  it('damage, morale loss, experience (1cb6:df14/e26c/e2f4)', () => {
    for (const c of all.filter((c) => c.type === 'combat')) {
      const oa = officer(c.oa);
      const od = officer(c.od);
      const rng = new Rng(c.seed);
      let dmg: number;
      if (c.kind === 1) {
        dmg = physicalDamage({
          attack: c.attack,
          defence: c.defence,
          attackerClass: oa.cls,
          defenderClass: od.cls,
          defenderTerrain: c.terrain,
          defenderHp: c.hpd,
          counter: c.param === 7,
        });
      } else {
        dmg = tacticDamage(rng, {
          kind: c.kind,
          element: c.param >> 4,
          power: c.param & 15,
          caster: oa,
          target: od,
          targetTerrain: c.terrain,
          weather: c.weather,
          targetHp: c.hpd,
        });
      }
      expect(dmg, JSON.stringify(c)).toBe(c.dmg);
      expect(rng.seed).toBe(c.afterDmg);
      expect(moraleLoss(c.kind, c.dmg, c.hpd, od.level, c.morale)).toBe(c.loss);
      expect(combatExp(c.sa < 15, oa.level, od.level, c.dmg === c.hpd, c.sd)).toBe(c.exp);
    }
  });

  it('tactic success roll (1cb6:a2aa)', () => {
    for (const c of all.filter((c) => c.type === 'success')) {
      const rng = new Rng(c.seed);
      expect(tacticSucceeds(rng, officer(c.oa), officer(c.od), c.div) ? 1 : 0).toBe(c.ok);
      expect(rng.seed).toBe(c.after);
    }
  });

  const fields = all.filter((c) => c.type === 'field');

  it('range shapes and targets (1cb6:c018)', () => {
    for (const c of fields) {
      const f = buildField(c.field);
      const u = f.units[c.slot];
      const mark = new Uint8Array(f.width * f.height).fill(NONE);
      const list = unitsInRange(f, u, c.range.rt, u.x, u.y, c.range.allies === 1, mark);
      expect(list).toEqual(c.range.list);
      expect(pickTarget(list, NONE)).toBe(c.range.ret);
      expect(Array.from(mark)).toEqual(c.range.mark);
    }
  });

  it('movement flood fill (1cb6:c9bc)', () => {
    for (const c of fields) {
      const f = buildField(c.field);
      const u = f.units[c.slot];
      const grid = new Uint8Array(f.width * f.height);
      floodMove(f, u, [u.x, u.y], grid, { flags: 0, maxCost: c.move.mp });
      expect(Array.from(grid)).toEqual(c.move.grid);
    }
  });

  it('influence spreading (1cb6:c4f2)', () => {
    for (const c of fields) {
      const f = buildField(c.field);
      const s = createAiState(f, new Rng(0), itemLookup(c.field.items), learn, c.field.weather);
      spreadInfluence(s, c.spread.v, c.spread.x, c.spread.y);
      expect(Array.from(s.influence)).toEqual(c.spread.infl);
    }
  });

  it('AI cell evaluation (1cb6:c2be + c9bc flag 4 + d6f8)', () => {
    for (const c of fields) aiCheck(c.field, c.slot, c.eval, 'eval', learn);
  });

  it('AI attack-nearest planning (1cb6:dc00)', () => {
    for (const c of fields) aiCheck(c.field, c.slot, c.nearest, 'nearest', learn);
  });
});
