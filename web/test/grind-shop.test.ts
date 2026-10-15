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
