// The computer phases end to end against MAIN.EXE: tools/ai_ref.py runs the original 1cb6:3f32
// (enemy regeneration and cure, the action order 3e12, and every computer unit's whole action ce50:
// plan, move, arrival, attack or tactic, counterattack, departures) under Unicorn on generated
// fields, and the same phase is replayed here the way BattleScene.computerPhases plays it
// (native/battle/scene.ts) with the engine's planUnit/applyMove/attackTargetAfterMove/castTactic.
// Units, officers, the unit map, the result byte and the RNG seed must match.
// Skips without HERO_GAME_DIR or without python3 + unicorn.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_DIR, gameFile, hasGame } from './gamedir';
import { attack, castTactic, unitLeaves } from '../src/engine/battle/combat';
import { actionOrder, applyMove, attackTargetAfterMove, createAiState, planUnit, type AiState } from '../src/engine/battle/ai';
import { neighbour, terrainAt, unitAt } from '../src/engine/battle/hex';
import { Rng, maxMp, mustLeave, regenerate, setMorale, tryCure } from '../src/engine/battle/rules';
import { AiMode, NONE, PLAYER_SLOTS, Status, UNIT_SLOTS, UnitFlag, loadLearnTable, type ItemInfo, type Officer, type Unit } from '../src/engine/battle/types';
import type { CombatState } from '../src/engine/battle/combat';

const TOOLS = join(__dirname, '..', '..', 'tools');

function runRef(count: number, seed: number): any[] | null {
  if (!hasGame) return null;
  const r = spawnSync('python3', ['-I', join(TOOLS, 'ai_ref.py'), GAME_DIR, String(count), String(seed)], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout);
}

const cases = runRef(Number(process.env.AI_REF_CASES ?? 150), Number(process.env.AI_REF_SEED ?? 3));

type RefOfficer = { id: number; lead: number; force: number; intel: number; hp: number; cls: number; level: number; exp: number; items: number[] };
const CLASS_BAND = 12;

type S = AiState & CombatState & { result: number };

function build(F: any, seed: number, learn: Uint8Array): S {
  const W = F.w;
  const f = {
    width: W,
    height: F.h,
    terrain: Uint8Array.from(F.terrain),
    unitAt: new Uint8Array(W * F.h).fill(NONE),
    units: F.units.map((u: Unit) => ({ ...u })),
    officers: F.officers.map((o: RefOfficer): Officer => ({ lead: o.lead, force: o.force, intel: o.intel, hp: o.hp, cls: o.cls, level: o.level, exp: o.exp, items: [...o.items] })),
  };
  for (const u of f.units) if (u.status === Status.Field) f.unitAt[u.y * W + u.x] = u.slot;
  const items = (id: number) => (F.items as ItemInfo[])[id];
  const s = createAiState(f, new Rng(seed), items, learn, F.weather) as S;
  s.closeup = !F.closeupOff;
  s.officerIds = F.officers.map((o: RefOfficer) => o.id);
  s.result = 0;
  return s;
}

// BattleScene.regen (1cb6:7cc8)
function regen(s: S, slot: number) {
  const u = s.units[slot];
  if (u.officer === 0xffff) {
    s.rng.rand(11);
    s.rng.rand(5);
    return;
  }
  const o = s.officers[u.officer];
  const onField = u.status === Status.Field;
  const terrain = onField ? terrainAt(s, u.x, u.y) : 0;
  const r = regenerate(s.rng, o, u.morale, onField, terrain, onField && o.cls === CLASS_BAND ? o.level : undefined);
  if (!onField) return;
  o.hp = r.hp;
  if (r.morale !== null) setMorale(s.rng, u, o.lead, r.morale);
  if (r.bandMp)
    for (let d = 0; d < 4; d++) {
      const n = neighbour(s, u.x, u.y, d);
      if (!n) continue;
      const v = unitAt(s, n[0], n[1]);
      if (v === NONE) continue;
      const vu = s.units[v];
      vu.mp = Math.min(vu.mp + r.bandMp, maxMp(s.officers[vu.officer])) & 0xff;
    }
}

// BattleScene.leaveAll / leave without script events: 유비 (officer 0) leaving loses the battle
function leaveAll(s: S, slots: number[]) {
  for (const k of [...new Set(slots)]) {
    const u = s.units[k];
    if (u.status !== Status.Field || !mustLeave(s.officers[u.officer], u)) continue;
    unitLeaves(s, k);
    if (u.flags & UnitFlag.Scripted) continue;
    if (u.officer === 0) s.result = 3;
  }
}

// BattleScene.computerPhases + aiUnit (1cb6:3f32, ce50)
function computerPhases(s: S) {
  for (let pass = 0; pass < 2 && s.result === 0; pass++) {
    const player = pass === 0;
    if (!player)
      for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
        regen(s, i);
        const u = s.units[i];
        tryCure(s.rng, u, u.officer === 0xffff ? 0 : s.officers[u.officer].lead);
      }
    const order = actionOrder(s, player);
    for (const slot of order) {
      if (s.result) return;
      const u = s.units[slot];
      if (u.mode === AiMode.Player) continue;
      const plan = planUnit(s, u);
      if (!plan) continue;
      applyMove(s, u, plan);
      if (u.flags & UnitFlag.Scripted || u.mode === AiMode.MoveNoAttack || u.flags & UnitFlag.Confused) continue;
      if (s.ai.tactic === NONE) {
        const t = attackTargetAfterMove(s, u);
        if (t !== NONE) leaveAll(s, attack(s, slot, t).left);
      } else {
        const res = castTactic(s, slot, s.ai.tactic, s.ai.target);
        if (res.ok) leaveAll(s, res.left);
      }
    }
  }
}

const learn = hasGame ? loadLearnTable(gameFile('MAIN.EXE')) : new Uint8Array(0);
// flag 0x10 (facing) is drawn state (8d74 is stubbed)
const FLAG_MASK = ~UnitFlag.Facing & 0xff;
const unitView = (u: any) => ({ x: u.x, y: u.y, target: u.target, tx: u.tx, ty: u.ty, status: u.status, flags: u.flags & FLAG_MASK, mode: u.mode, morale: u.morale, mp: u.mp });

describe.skipIf(!cases)('computer phases vs MAIN.EXE (1cb6:3f32)', () => {
  it('regeneration, action order, plan, move, attack/tactic and departures match', () => {
    const all = cases ?? [];
    expect(all.length).toBeGreaterThan(20);
    let moved = 0;
    let hits = 0;
    for (const [n, c] of all.entries()) {
      const s = build(c.field, c.seed, learn);
      computerPhases(s);
      const msg = `case ${n}`;
      for (let i = 0; i < UNIT_SLOTS; i++) {
        if (c.field.units[i].officer === 0xffff) continue;
        expect(unitView(s.units[i]), `${msg} slot ${i}`).toEqual(unitView(c.units[i]));
        if (s.units[i].x !== c.field.units[i].x || s.units[i].y !== c.field.units[i].y) moved++;
      }
      s.officers.forEach((o, i) => {
        expect({ hp: o.hp, cls: o.cls, level: o.level, exp: o.exp }, `${msg} officer ${i}`).toEqual(c.officers[i]);
        if (o.hp !== c.field.officers[i].hp) hits++;
      });
      expect(Array.from(s.unitAt), msg).toEqual(c.umap);
      expect(s.result, msg).toBe(c.result);
      expect(s.rng.seed, msg).toBe(c.after);
    }
    expect(moved).toBeGreaterThan(50);
    expect(hits).toBeGreaterThan(50);
  });
});
