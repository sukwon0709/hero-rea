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

describe('grind shop: selling (Game.shopSell, ((price*3)>>2)*10, story items 1910)', () => {
  const story = (s: GameState, id: number, type: number, power: number) => Object.assign(s.items[id], { price: 0xff, type, power });
  it('sell 1: class-change books and unused equipment go first, and the gold buys the scrolls', () => {
    const s = fakeState([10, 3], 0);
    story(s, 0x12, 1, 0);
    story(s, 0x0c, 0, 12);
    story(s, 0x0f, 0, 10);
    s.officers[0].dyn.items[0] = 0x12; // 검술지침서: 1910
    s.officers[1].dyn.items[0] = 0x0f; // the weaker weapon of two: 1910
    s.officers[1].dyn.items[1] = 0x0c; // the best weapon stays
    const sold: { officer: number; item: number; price: number }[] = [];
    const got = shopVisit(s, [0x28], { scrolls: 2, sell: 1, sold });
    expect(sold.map((x) => [x.officer, x.item, x.price])).toEqual([[0, 0x12, 1910], [1, 0x0f, 1910]]);
    expect(s.officers[1].dyn.items.includes(0x0c)).toBe(true);
    expect(got.length).toBe(4);
    expect(s.progress.money).toBe(3820 - 4 * 50);
  });

  it('sell 2 trades strong scrolls for cheap ones, sell 3 fills every free slot but one; never past 10000', () => {
    const s = fakeState([10], 0);
    s.officers[0].dyn.items[0] = 0x2a; // 업화서 (price 25 here): 180
    shopVisit(s, [0x28], { scrolls: 2, sell: 1 });
    expect(s.officers[0].dyn.items[0]).toBe(0x2a); // kept at 1
    const t = fakeState([10], 0);
    t.officers[0].dyn.items[0] = 0x2a;
    shopVisit(t, [0x28], { scrolls: 2, sell: 2 });
    expect(t.officers[0].dyn.items.filter((v) => v === 0x28).length).toBe(1); // 180 gold: one, 100 kept
    const u = fakeState([10], 2000);
    shopVisit(u, [0x28], { scrolls: 2, sell: 3 });
    expect(u.officers[0].dyn.items.filter((v) => v === 0x28).length).toBe(7);
    const v = fakeState([10], 9000);
    story(v, 0x12, 1, 0);
    v.officers[0].dyn.items[0] = 0x12;
    shopVisit(v, [], { scrolls: 2, sell: 1 });
    expect(v.officers[0].dyn.items[0]).toBe(0x12);
    expect(v.progress.money).toBe(9000);
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
    expect(keys).toEqual(['hnPlan', 'hnX', 'hnY', 'hnPeel', 'hnWave', 'hnReach', 'hnBack', 'hnRest', 'hnFront', 'hnFocus', 'hnWeak', 'hnStrike', 'hnStageX', 'hnStageY', 'hnExtra', 'hnWaveRisk', 'hnDmg', 'hnPush']);
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

describe('grind: 폭탄 / confusion items, the strike plan defaults, battle treasures', () => {
  it('buys one 폭탄 (500 gold, an emergency tool) before the heals, then the cheapest confusion item, 200 gold kept', () => {
    const s = fakeState([14, 18, 14], 1700);
    (s.items[0x21] as { price: number }).price = 50; // 폭탄 500
    (s.items[0x2b] as { price: number }).price = 5; // 농무서 50
    (s.items[0x2c] as { price: number }).price = 10;
    (s.items[0x1e] as { price: number }).price = 5; // 콩 50
    const got = shopVisit(s, [0x1e, 0x21, 0x2b, 0x2c], { bombItems: 2, confuseItems: 2, scrolls: 0 });
    // bombItems is capped at 1 (Sukwon: no bomb abuse)
    expect(got.slice(0, 3).map((p) => [p.officer, p.item])).toEqual([[0, 0x21], [0, 0x2b], [1, 0x2b]]);
    // 1700 - 500 - 100 = 1100 left for the heals
    expect(got.slice(3).every((p) => p.item === 0x1e)).toBe(true);
    // a party already holding them buys no more
    const again = shopVisit(s, [0x21, 0x2b], { bombItems: 2, confuseItems: 2 });
    expect(again).toEqual([]);
    // healKeep: the single heals leave that much
    const h = fakeState([14, 18], 400);
    (h.items[0x1e] as { price: number }).price = 5;
    expect(shopVisit(h, [0x1e], { healKeep: 300, scrolls: 0 }).length).toBe(2);
    expect(h.progress.money).toBe(300);
    // nothing below 200 gold
    const t = fakeState([14], 650);
    (t.items[0x21] as { price: number }).price = 50;
    expect(shopVisit(t, [0x21], { bombItems: 4 }).length).toBe(0);
  });

  it('paramOr: plans made before a key get its default (strike on at 12,4)', async () => {
    const { defaultParams, clampParams, paramOr } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const old = clampParams(Object.fromEntries(Object.entries(d).filter(([k]) => !['bomb', 'confuse', 'bombBuy', 'confuseBuy', 'hnStrike', 'healKeep', 'hnStageX', 'hnStageY', 'hnExtra', 'hnWaveRisk'].includes(k))) as unknown as typeof d);
    expect(Number.isNaN(old.hnStrike)).toBe(true);
    expect(paramOr(old, 'hnStrike')).toBeGreaterThan(0.5);
    expect([paramOr(old, 'hnStageX'), paramOr(old, 'hnStageY')]).toEqual([12, 4]);
    expect(paramOr(old, 'bombBuy')).toBe(1);
    expect(paramOr({ ...d, bombBuy: 0 }, 'bombBuy')).toBe(0);
    expect(paramOr(old, 'healKeep')).toBe(0);
  });

  it('confusion item reach (1cb6:add9): 농무서 and 호우서 the adjacent cells only, 기상서 range 1', async () => {
    const { CONFUSE_ITEM_RANGE } = await import('../src/engine/battle/types');
    expect(CONFUSE_ITEM_RANGE).toEqual([0, 1, 0]);
  });

  it('ADD_ITEM in the sandbox (battle treasures) lands in the first free slot of the first roster officer', async () => {
    const { sandboxHost } = await import('../src/sim/grind/sandbox');
    const s = fakeState([14, 18], 0);
    s.officers[0].dyn.items.fill(0x1e);
    const host = sandboxHost(s, () => 1);
    await host.addItem?.(0x2a);
    expect(s.officers[1].dyn.items[0]).toBe(0x2a);
    expect(s.officers[0].dyn.items.includes(0x2a)).toBe(false);
  });
});

describe('grind: 폭탄 are an emergency tool; the battle-start line', () => {
  it('one 폭탄 per battle, at most one bought (old plans with bombBuy 4 are clamped)', async () => {
    const { BOMBS_PER_BATTLE, defaultParams, clampParams } = await import('../src/sim/grind/policy');
    expect(BOMBS_PER_BATTLE).toBe(1);
    expect(clampParams({ ...defaultParams(), bombBuy: 4 }).bombBuy).toBe(1);
  });

  it('enemy levels are the deployment records\' level bytes (BATTLE_UNITS +0xa), not the officers\' stored levels', async () => {
    const { enemyLevel, enemyLevels } = await import('../src/sim/grind/campaign');
    const officers = Array.from({ length: 4 }, () => ({ dyn: { level: 1 } }));
    const snap = {
      state: { officers },
      script: {
        units: [
          { officer: 1, flags: 1, b: 12 },
          { officer: 2, flags: 1, b: 18 },
          { officer: 0, flags: 0 }, // ours
          { officer: 0xffff, flags: 1, b: 99 }, // empty record
          { officer: 3, flags: 3 }, // a reserve with no level byte: the stored level
        ],
      },
    } as unknown as Parameters<typeof enemyLevel>[0];
    expect(enemyLevels(snap)).toEqual([12, 18, 1]);
    expect(enemyLevel(snap)).toBeCloseTo(31 / 3);
  });

  it('startLine: gold, 폭탄, top-9 level against the enemy', async () => {
    const { startLine } = await import('../src/sim/grind/battle');
    expect(startLine({ gold: 150, bombs: 1, top9: 12.6, sortie: 12.55, enemyAvg: 12.4, enemyMax: 18, enemies: 22 })).toBe('gold 150 폭탄 1 Lv 12.6 (sortie 12.6) vs enemy 12.4 (max 18, 22 units)');
    expect(startLine(undefined)).toBe('');
  });
});

describe('grind shop: gold kept for promotions (promoLead)', () => {
  it('keeps the promotion item price for a member within promoLead levels; spends it without the option', () => {
    const make = () => {
      const s = fakeState([10, 13], 400);
      (s.items[0x13] as { price: number }).price = 30;
      return s;
    };
    const kept = make();
    shopVisit(kept, [0x28], { scrolls: 4, promoLead: 3 });
    expect(kept.progress.money).toBeGreaterThanOrEqual(300);
    const spent = make();
    shopVisit(spent, [0x28], { scrolls: 4 });
    expect(spent.progress.money).toBeLessThan(300);
  });
});
