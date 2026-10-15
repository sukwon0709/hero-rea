// Grinding simulator, the merchant (src/sim/grind/shop.ts): the 병법서 option (GrindParams.scrolls).
// A hand-built state, no game files: item prices are the item record's price byte (x10 in gold).
import { describe, expect, it } from 'vitest';
import type { GameState } from '../src/engine/state';
import { shopVisit } from '../src/sim/grind/shop';

const PRICES: Record<number, number> = { 0x22: 10, 0x23: 20, 0x24: 40, 0x25: 8, 0x26: 16, 0x27: 30, 0x28: 5, 0x29: 12, 0x2a: 25 };

function fakeState(levels: number[], money: number): GameState {
  const items = Array.from({ length: 0x40 }, (_, i) => ({ index: i, price: PRICES[i] ?? 0xff }));
  const officers = Array.from({ length: 4 }, (_, i) => ({
    intelligence: 50 + i,
    dyn: { level: levels[i] ?? 1, flags: i < levels.length ? 0x80 : 0, cls: 0, items: new Array(8).fill(0xff) as number[] },
  }));
  return { items, officers, progress: { money } } as unknown as GameState;
}

describe('grind shop: cheap scrolls for everyone', () => {
  it('fills every officer below Lv99 up to N of the cheapest scroll, lowest level first', () => {
    const s = fakeState([30, 5, 99, 12], 10_000);
    const got = shopVisit(s, [0x22, 0x25, 0x28, 0x2a], { scrolls: 2 });
    // 유비 (officer 0) and the others below 99: 2 x 초열서 (0x28, 50 gold) each; the Lv99 one none
    expect(got.map((p) => p.officer)).toEqual([1, 1, 3, 3, 0, 0]);
    expect(got.every((p) => p.item === 0x28 && p.price === 50)).toBe(true);
    expect(s.officers[2].dyn.items.includes(0x28)).toBe(false);
    expect(s.progress.money).toBe(10_000 - 6 * 50);
  });

  it('keeps 100 gold and falls back to the next cheapest scroll the shop has', () => {
    const s = fakeState([10, 3], 100 + 80 * 3 + 10);
    const got = shopVisit(s, [0x22, 0x25], { scrolls: 2 });
    expect(got.map((p) => [p.officer, p.item])).toEqual([[1, 0x25], [1, 0x25], [0, 0x25]]);
    expect(s.progress.money).toBeGreaterThanOrEqual(100);
  });

  it('buys the troop heals first, the scrolls with what is left', () => {
    const s = fakeState([10, 3], 400);
    (s.items[0x1e] as { price: number }).price = 5; // 콩 50 gold
    const got = shopVisit(s, [0x1e, 0x28], { scrolls: 2 });
    // 400: 유비 2 x 콩 and officer 1 one (150), then 초열서 for officer 1 (lower level) x2 and 유비 x1
    // (150), 100 kept
    expect(got.map((p) => [p.officer, p.item])).toEqual([[0, 0x1e], [0, 0x1e], [1, 0x1e], [1, 0x28], [1, 0x28], [0, 0x28]]);
    expect(s.progress.money).toBe(100);
  });

  it('without the option buys the old one-strongest-bomb-each above the reserve', () => {
    const s = fakeState([10, 3], 2000);
    const got = shopVisit(s, [0x22, 0x28, 0x2a], {});
    // 2000 -> 1750 -> 1500: one strongest scroll (0x2a, 250 gold) for each of the two, never below 1500
    expect(got.map((p) => p.item)).toEqual([0x2a, 0x2a]);
    expect(s.progress.money).toBe(1500);
    const t = fakeState([10, 3], 2000);
    expect(shopVisit(t, [0x22, 0x28, 0x2a], { scrolls: Number.NaN })).toEqual(got);
  });
});

describe('grind params: the namu.wiki techniques', () => {
  it('new plans get the defaults, old plans (keys absent) keep the old behaviour as NaN', async () => {
    const { defaultParams, clampParams } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(d.scrolls).toBe(2);
    expect(d.bonusExit).toBeGreaterThan(0.5);
    expect(d.spareBand).toBeLessThan(0.5);
    const old = clampParams({ ...d, scrolls: undefined, bonusExit: undefined, spareBand: undefined } as unknown as typeof d);
    expect(Number.isNaN(old.scrolls) && Number.isNaN(old.bonusExit) && Number.isNaN(old.spareBand)).toBe(true);
  });
});

describe('grind params: the 회남 plan', () => {
  it('on by default for new plans, off (NaN) for plans made before it; only 회남 (ch1 stage 2 block 12) takes it', async () => {
    const { defaultParams, clampParams, isHuainan, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(d.hnPlan).toBeGreaterThan(0.5);
    expect([d.hnX, d.hnY]).toEqual([21, 8]);
    const keys = PARAM_SPECS.map((s) => s.key).filter((k) => k.startsWith('hn'));
    expect(keys).toEqual(['hnPlan', 'hnX', 'hnY', 'hnPeel', 'hnWave', 'hnReach', 'hnBack', 'hnRest', 'hnFront', 'hnFocus', 'hnWeak', 'hnMaxLv']);
    const old = clampParams(Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('hn'))) as unknown as typeof d);
    for (const k of keys) expect(Number.isNaN(old[k])).toBe(true);
    // NaN never turns the plan on
    expect(old.hnPlan > 0.5).toBe(false);
    const st = (chapter: number, index: number) => ({ chapter, index }) as never;
    expect(isHuainan({ stage: st(1, 2), block: 12 })).toBe(true);
    expect(isHuainan({ stage: st(1, 2), block: 5 })).toBe(false);
    expect(isHuainan({ stage: st(1, 3), block: 12 })).toBe(false);
    expect(isHuainan({ stage: st(2, 2), block: 12 })).toBe(false);
    expect(isHuainan({ block: 12 })).toBe(false);
  });
});

describe('grind: the best losing try and the frontier bonus', () => {
  it('losses rank by turns held, then exp; a win beats any loss', async () => {
    const { betterTry } = await import('../src/sim/grind/battle');
    const loss = (turns: number, expTotal: number) => ({ won: false, score: -1, turns, expTotal });
    expect(betterTry(loss(30, 500), loss(13, 900))).toBe(true);
    expect(betterTry(loss(13, 900), loss(30, 500))).toBe(false);
    expect(betterTry(loss(30, 600), loss(30, 500))).toBe(true);
    expect(betterTry(loss(30, 500), loss(30, 500))).toBe(false);
    expect(betterTry({ won: true, score: 1, turns: 5, expTotal: 1 }, loss(30, 5000))).toBe(true);
    expect(betterTry({ won: true, score: 9, turns: 5, expTotal: 1 }, { won: true, score: 3, turns: 30, expTotal: 900 })).toBe(true);
  });
  it('a stopped run gets a few hundred for holding the wall, never a cleared battle', async () => {
    const { frontierBonus, CLEARED_WEIGHT } = await import('../src/sim/grind/campaign');
    expect(frontierBonus(undefined)).toBe(0);
    expect(frontierBonus({ won: true, turns: 30 })).toBe(0);
    expect(frontierBonus({ won: false, turns: 30, lostExp: 1000 })).toBe(340);
    expect(frontierBonus({ won: false, turns: 30, lostExp: 1000 })).toBeGreaterThan(frontierBonus({ won: false, turns: 13, lostExp: 300 }));
    expect(frontierBonus({ won: false, turns: 50, lostExp: 5000 })).toBeLessThan(CLEARED_WEIGHT / 1000);
  });
});

describe('grind: 회남 plan only for a weaker party (hnMaxLv)', () => {
  it('top-9 average of our faction below hnMaxLv; absent: always', async () => {
    const { hnWeakParty, defaultParams } = await import('../src/sim/grind/policy');
    const mk = (levels: number[]) => ({ officers: Array.from({ length: 0x100 }, (_, i) => ({ dyn: { level: levels[i] ?? 1, flags: i < levels.length ? 0x81 : 0 } })) }) as never;
    const p = { ...defaultParams(), hnMaxLv: 19 };
    expect(hnWeakParty(mk([15, 15, 15, 15, 15, 15, 15, 15, 15, 30]), p)).toBe(true); // (30 + 8 x 15) / 9 = 16.7
    expect(hnWeakParty(mk([20, 20, 20, 20, 20, 20, 20, 20, 20, 5]), p)).toBe(false);
    const old = { ...p } as Record<string, unknown>;
    delete old.hnMaxLv;
    expect(hnWeakParty(mk([40, 40, 40]), old as never)).toBe(true);
  });
});

describe('grind: loss reasons', () => {
  it('the time limit comes first (the field is cleared when it runs out, 유비 included)', async () => {
    const { lossLabel } = await import('../src/sim/grind/battle');
    expect(lossLabel({ fallen: '유비', timeUp: true, scripted: false, wiped: true, result: 3 })).toBe('제한 턴 초과');
    expect(lossLabel({ fallen: '유비', timeUp: false, scripted: false, wiped: false, result: 3 })).toBe('유비 퇴각');
    expect(lossLabel({ fallen: null, timeUp: false, scripted: true, wiped: false, result: 3 })).toBe('이벤트 패배(기한 등)');
    expect(lossLabel({ fallen: null, timeUp: false, scripted: false, wiped: true, result: 3 })).toBe('아군 전멸');
  });
});

describe('grind: the 회남 sortie', () => {
  it('swaps the weak archers out for close-combat units, keeping each kept officer on its record', async () => {
    const { huainanPicks } = await import('../src/sim/grind/policy');
    // officer -> [level, class]: 0 유비, 1 L9 c6 (close), 57 L9 c0, 58 L8 c3 archer, 81 L13 c0 (left out), 82 L8 c3 archer
    const spec: Record<number, [number, number]> = { 0: [12, 0], 1: [9, 6], 2: [14, 6], 57: [9, 0], 58: [8, 3], 63: [14, 18], 64: [13, 12], 81: [13, 0], 82: [8, 3], 220: [14, 14] };
    const officers = Array.from({ length: 0x100 }, (_, i) => ({ dyn: { level: spec[i]?.[0] ?? 1, cls: spec[i]?.[1] ?? 0, flags: spec[i] ? 0x80 | 1 : 0 } }));
    const state = { officers } as unknown as import('../src/engine/state').GameState;
    const picks = [2, 63, 220, 58, 1, 57, 82, 64];
    const out = huainanPicks(state, [0], 8, picks, true, 0);
    expect(out).toHaveLength(8);
    expect(out).toContain(81);
    expect(out.filter((i) => i === 58 || i === 82)).toHaveLength(1);
    // the others stay on their records
    for (const [k, i] of picks.entries()) if (i !== 58 && i !== 82) expect(out[k]).toBe(i);
    // the band is kept whatever its level
    expect(out).toContain(64);
  });
});

describe('grind battle names', () => {
  it('story names for the battles whose map name differs (회남, 하비, 서주공방전)', async () => {
    const { storyName, applyStoryNames } = await import('../src/sim/grind/names');
    expect(storyName(1, 2, 12, '하비')).toBe('회남');
    expect(storyName(1, 3, 4, '신도1')).toBe('하비');
    expect(storyName(1, 4, 15, '서주')).toBe('서주공방전');
    expect(storyName(1, 1, 5, '서주')).toBe('서주');
    const s = applyStoryNames([{ chapter: 1, stage: 2, block: 12, name: '하비' }]);
    expect(s[0].name).toBe('회남');
  });
});
