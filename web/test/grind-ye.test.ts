// 업 battles: MAP_EFFECT fires (2cb4:0420; 업2's r2 cuts the start into three pockets) and the 업 sortie
// (ye.ts, GrindParams.yePick). The fire test reads MAIN.EXE from HERO_GAME_DIR and skips without it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_DIR, hasGame } from './gamedir';

describe.skipIf(!hasGame)('battle: MAP_EFFECT fires (2cb4:0420)', () => {
  it('kind 0/1 turn a free cell into terrain DS:0x4ff4[kind] (18 / 19, impassable) and list it; a unit on the cell stops it; kind 2 puts the listed terrain back', async () => {
    const { BattleHost } = await import('../src/native/battle/host');
    const { moveCost, NONE } = await import('../src/engine/battle/types');
    const W = 4, H = 3;
    const b = { width: W, height: H, s: { unitAt: new Uint8Array(W * H).fill(NONE) }, map: { terrain: new Uint8Array(W * H).fill(6) }, effectLog: [] as { x: number; y: number; terrain: number }[] };
    b.s.unitAt[1 * W + 2] = 3;
    const main = new Uint8Array(readFileSync(join(GAME_DIR, 'MAIN.EXE')));
    const host = new BattleHost({ b, ctx: { assets: { main } } } as never) as unknown as { mapEffect(x: number, y: number, k: number): void };
    host.mapEffect(1, 1, 0);
    host.mapEffect(0, 2, 1);
    host.mapEffect(2, 1, 0);
    host.mapEffect(9, 9, 0);
    expect(b.map.terrain[1 * W + 1]).toBe(18);
    expect(b.map.terrain[2 * W + 0]).toBe(19);
    expect(b.map.terrain[1 * W + 2]).toBe(6);
    for (const mt of [0, 1, 2, 3]) expect(moveCost(mt, 18)).toBe(0xff);
    expect(b.effectLog).toEqual([
      { x: 1, y: 1, terrain: 6 },
      { x: 0, y: 2, terrain: 6 },
    ]);
    host.mapEffect(1, 1, 2);
    expect(b.map.terrain[1 * W + 1]).toBe(6);
    expect(b.effectLog).toEqual([{ x: 0, y: 2, terrain: 6 }]);
  });
});

describe('grind: 업 sortie (yePick)', () => {
  it('yePick is appended last, on by default, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 1].key).toBe('yePick');
    expect(d.yePick).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.yePick;
    expect(paramOr(old as unknown as typeof d, 'yePick')).toBe(d.yePick);
    expect(clampParams({ ...d, yePick: 9 }).yePick).toBe(1);
    expect(clampParams({ ...d, yePick: -9 }).yePick).toBe(0);
  });

  it('the strongest close-combat officers take the places 업2 puts in 유비 pocket; the rest keep their order', async () => {
    const { yeOrder, YE_MIDDLE, isYeFirstAt } = await import('../src/sim/grind/ye');
    // officer: [level, class]; 12 군악대, 5 archer, 18 healer, 2 / 7 / 8 close combat
    const spec: Record<number, [number, number]> = { 30: [48, 12], 58: [61, 5], 1: [57, 7], 189: [58, 8], 203: [61, 8], 187: [51, 2], 63: [43, 18], 2: [43, 8], 37: [50, 2], 33: [49, 2], 113: [49, 2], 38: [48, 5], 53: [41, 7] };
    const state = { officers: Array.from({ length: 256 }, (_, i) => ({ dyn: { level: spec[i]?.[0] ?? 1, cls: spec[i]?.[1] ?? 0 } })) } as never;
    expect(YE_MIDDLE).toEqual([4, 7, 10]);
    const picks = [30, 58, 1, 189, 203, 187, 63, 2, 37, 33, 113, 38, 53];
    const out = yeOrder(state, picks);
    expect([out[4], out[7], out[10]]).toEqual([203, 189, 1]);
    expect(out.filter((_, k) => !YE_MIDDLE.includes(k))).toEqual([30, 58, 187, 63, 2, 37, 33, 113, 38, 53]);
    // a short list keeps every pick
    const short = yeOrder(state, [30, 58, 1, 189, 203, 187, 63, 2]);
    expect([short[4], short[7]]).toEqual([203, 189]);
    expect(new Set(short)).toEqual(new Set([30, 58, 1, 189, 203, 187, 63, 2]));
    expect(isYeFirstAt(4, 2, 2)).toBe(true);
    expect(isYeFirstAt(4, 2, 3)).toBe(false);
  });
});
