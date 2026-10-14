import { describe, expect, it } from 'vitest';
import { gameFile, hasGame } from './gamedir';
import {
  AXES,
  CLASS_ATTACK,
  CLASS_ATTACK_TYPE,
  CLASS_DEFENCE,
  CLASS_HP_BASE,
  CLASS_HP_GROWTH,
  CLASS_MOVE,
  CLASS_MOVE_TYPE,
  CLASS_RANGE,
  DIAGONALS,
  DIRS,
  MOVE_COST,
  NONE,
  ORDER_TO_MODE,
  TACTIC_MP,
  TACTIC_POWER,
  TACTIC_TERRAIN,
  TERRAIN_DEFENCE,
  WEATHER_TYPE,
  loadLearnTable,
  newUnit,
  readDgroup,
} from '../src/engine/battle/types';
import { Field, floodMove, rangeCells, walkPath } from '../src/engine/battle/hex';
import { Rng, maxHp, nextWeather, physicalDamage } from '../src/engine/battle/rules';
import { CLOSEUP_BACK, CLOSEUP_FRONT, battleNameLines, loadBattleMaps, secondChipSet } from '../src/engine/battle/map';

const s8 = (v: number) => (v << 24) >> 24;

describe('battle rules (no game files)', () => {
  it('RNG matches the MS C LCG', () => {
    const r = new Rng(1);
    // seed = 1*0x41C64E6D + 0x3039 = 0x41C67EA6 -> 0x41C6 & 0x7fff
    expect(r.next()).toBe(0x41c6);
    expect(r.rand(0)).toBe(0);
  });

  it('range shapes have the expected sizes', () => {
    const f = { width: 20, height: 20 } as Field;
    const n = (rt: number) => rangeCells(f, 10, 10, rt).length;
    expect([0, 1, 2, 3, 4].map(n)).toEqual([4, 8, 8, 16, 24]);
    expect([0x80, 0x81, 0x82].map(n)).toEqual([8, 12, 20]);
    expect(rangeCells(f, 0, 0, 1).length).toBe(3);
  });

  it('weather wraps 0<->5', () => {
    const r = new Rng(123);
    for (let i = 0; i < 100; i++) {
      const w = nextWeather(r, 3);
      expect([2, 3, 4]).toContain(w);
    }
  });

  it('physical damage: triangle, terrain, minimum 1', () => {
    const base = { attack: 500, defence: 400, attackerClass: 0, defenderClass: 0, defenderTerrain: 0, defenderHp: 9999, counter: false };
    expect(physicalDamage(base)).toBe(300);
    expect(physicalDamage({ ...base, defenderClass: 3 })).toBe(500 - 150); // foot vs archers: def -25%
    expect(physicalDamage({ ...base, defenderClass: 6 })).toBe(500 - 250); // foot vs horse: def +25%
    expect(physicalDamage({ ...base, defenderTerrain: 2 })).toBe(210);
    expect(physicalDamage({ ...base, counter: true })).toBe(150);
    expect(physicalDamage({ ...base, attack: 10 })).toBe(1);
    expect(physicalDamage({ ...base, defenderHp: 7 })).toBe(7);
  });

  it('max troops', () => {
    expect(maxHp({ lead: 0, force: 0, intel: 0, hp: 0, cls: 0, level: 1, exp: 0, items: [] })).toBe(500);
    expect(maxHp({ lead: 0, force: 0, intel: 0, hp: 0, cls: 9, level: 11, exp: 0, items: [] })).toBe(1200);
  });

  it('flood fill skips cells set below the next level (c9bc quirk)', () => {
    // A 5x1 strip: plain, village (cost 2), plain, plain, plain, unit on x=0.
    const W = 5;
    const f: Field = {
      width: W,
      height: 1,
      terrain: Uint8Array.from([0, 8, 0, 0, 0]),
      unitAt: new Uint8Array(W).fill(NONE),
      units: [newUnit(0)],
      officers: [{ lead: 0, force: 0, intel: 0, hp: 1, cls: 0, level: 1, exp: 0, items: [] }],
    };
    f.units[0].officer = 0;
    f.units[0].status = 2;
    f.unitAt[0] = 0;
    const g = new Uint8Array(W);
    floodMove(f, f.units[0], [0, 0], g, { flags: 0, maxCost: 4 });
    expect(Array.from(g)).toEqual([0, 2, 3, 4, NONE]);
    const p = walkPath(f, f.units[0], g, [3, 0], [0, 0], 0xff);
    expect(p.reached).toBe(true);
    expect(p.route).toEqual([1, 1, 1]);
  });
});

describe.skipIf(!hasGame)('battle tables vs MAIN.EXE', () => {
  const exe = hasGame ? gameFile('MAIN.EXE') : new Uint8Array(0);
  const bytes = (off: number, n: number) => Array.from(readDgroup(exe, off, n));
  it('terrain tables', () => {
    expect(bytes(0x405e, 20)).toEqual(TERRAIN_DEFENCE);
    expect(bytes(0x400e, 80)).toEqual(MOVE_COST.flat());
    expect(bytes(0x47bc, 12)).toEqual(TACTIC_TERRAIN.flat());
  });
  it('class tables', () => {
    expect(bytes(0x3f8e, 19)).toEqual(CLASS_MOVE);
    expect(bytes(0x3fd2, 19)).toEqual(CLASS_ATTACK_TYPE);
    expect(bytes(0x3fe6, 19)).toEqual(CLASS_RANGE);
    expect(bytes(0x3ffa, 19)).toEqual(CLASS_MOVE_TYPE);
    expect(bytes(0x1338, 19)).toEqual(CLASS_HP_BASE);
    expect(bytes(0x134c, 19)).toEqual(CLASS_HP_GROWTH);
    expect(bytes(0xffe, 19)).toEqual(CLASS_ATTACK);
    expect(bytes(0x1012, 19)).toEqual(CLASS_DEFENCE);
  });
  it('tactic, weather, order and direction tables', () => {
    expect(bytes(0x44c8, 36)).toEqual(TACTIC_POWER);
    expect(bytes(0x44ec, 36)).toEqual(TACTIC_MP);
    expect(bytes(0x3b7c, 6)).toEqual(WEATHER_TYPE);
    expect(bytes(0x4fe6, 14).filter((_, i) => i % 2 === 0)).toEqual(ORDER_TO_MODE);
    const vec = (off: number) => {
      const b = bytes(off, 16);
      return [0, 1, 2, 3].map((i) => [s8(b[i * 4]), s8(b[i * 4 + 2])]);
    };
    expect(vec(0x4d1c)).toEqual(DIRS);
    expect(vec(0x4cfc)).toEqual(DIAGONALS);
    expect(vec(0x4d0c)).toEqual(AXES);
    expect(bytes(0x4e42, 20)).toEqual(CLOSEUP_BACK);
    expect(bytes(0x4e56, 20)).toEqual(CLOSEUP_FRONT);
    expect(loadLearnTable(exe).length).toBe(36 * 19);
  });
  it('second chip set list (DS:0x3dcc)', () => {
    const b = bytes(0x3dcc, 38);
    const maps = b.filter((_, i) => i % 2 === 0);
    for (let m = 0; m < 58; m++) expect(secondChipSet(m)).toBe(maps.includes(m) ? 2 : 1);
  });
});

describe.skipIf(!hasGame)('battle maps', () => {
  it('parses all HEXZMAP maps', () => {
    const d = gameFile('HEXZMAP.R3');
    const maps = loadBattleMaps(d);
    expect(maps.length).toBe(58);
    expect([maps[0].width, maps[0].height]).toEqual([28, 16]);
    for (const m of maps) {
      expect(m.chips.length).toBe(4 * m.width * m.height);
      expect(m.terrain.every((t) => t < 20 || t === 255)).toBe(true); // map 32 has one 255 cell
    }
    expect(battleNameLines(d).length).toBeGreaterThanOrEqual(58);
  });
});
