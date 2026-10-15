// runCampaign's backtracking (src/sim/grind/campaign.ts) with a scripted battle search: a backtrack
// that does not get back past the furthest chain of wins must not leave the run worse than that chain.
import { describe, expect, it, vi } from 'vitest';

const script: boolean[] = [];
// farm test: each win adds one level to what the battle started with
const grow = { on: false };
vi.mock('../src/sim/grind/battle', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/sim/grind/battle')>();
  return {
    ...real,
    searchBattle: vi.fn(async (_files: unknown, snap: { index: number }, base: { tag?: number }, carry: { officers: { level: number }[] | null } | null) => {
      const won = script.shift() ?? false;
      const best = {
        won, result: won ? 2 : 3, turns: 20, turnLimit: 30, finishTurn: null, params: { ...base, tag: snap.index }, gains: [], score: won ? 100 : -1, expTotal: won ? 100 : 0,
        kept: [], deployed: [0], actions: { attack: 0, kill: 0, tactic: 0, heal: 0, wait: 0 }, tactics: {}, formationOut: undefined,
        officersAfter: [{ level: grow.on ? (carry?.officers?.[0]?.level ?? 1) + 1 : 2 + snap.index, exp: 0 }], moneyAfter: 0, purchases: [], rngAfter: 0, ms: 0,
      };
      return { best, tried: [{ params: best.params, won, score: best.score, turns: 20 }] };
    }),
  };
});

const snap = (index: number) => ({
  index, name: `b${index}`, chapter: 0, map: 0,
  state: { officers: [{ name: '유비', dyn: { level: 1, exp: 0, cls: 0, items: [], flags: 0x80 } }], progress: { money: 0 } },
  script: {},
});

describe('runCampaign backtracking', () => {
  it('restores the furthest chain when a backtrack falls short of it', async () => {
    const { runCampaign } = await import('../src/sim/grind/campaign');
    const { defaultParams } = await import('../src/sim/grind/policy');
    // [0] [1] [2] won, [3] lost -> back to [2], which now loses -> stop at [2] (2 cleared)
    script.push(true, true, true, false, false);
    const snaps = [0, 1, 2, 3, 4].map(snap) as never;
    const r = await runCampaign(new Map(), snaps, defaultParams(), { variants: 1, seed: 1, backtrack: 1, rescue: 0 });
    expect(r.cleared).toBe(3);
    expect(r.frontier?.index).toBe(3);
    expect(r.battles.map((b) => b.won)).toEqual([true, true, true]);
    expect(r.carryOut?.officers[0].level).toBe(4); // the carry after [2]'s win in the chain
  });

  it('keeps a backtrack that gets further', async () => {
    const { runCampaign } = await import('../src/sim/grind/campaign');
    const { defaultParams } = await import('../src/sim/grind/policy');
    script.length = 0;
    // [0] [1] won, [2] lost -> back to [1]: won, [2] won, [3] lost (no backtrack left)
    script.push(true, true, false, true, true, false);
    const snaps = [0, 1, 2, 3, 4].map(snap) as never;
    const r = await runCampaign(new Map(), snaps, defaultParams(), { variants: 1, seed: 1, backtrack: 1, rescue: 0 });
    expect(r.cleared).toBe(3);
    expect(r.frontier?.index).toBe(3);
  });
});

describe('runCampaign sim-only farming (GrindParams.farmRuns)', () => {
  it('replays a won battle before the wall from the levels it left, until farmLv or farmRuns', async () => {
    const { runCampaign } = await import('../src/sim/grind/campaign');
    const { defaultParams } = await import('../src/sim/grind/policy');
    script.length = 0;
    grow.on = true;
    try {
      // [0] won (no farming: more than 3 before the wall), [1] [2] [3] won with replays, [4] the wall lost
      const p = { ...defaultParams(), farmRuns: 2, farmLv: 99 };
      script.push(true, true, true, true, true, true, true, true, true, true, false);
      const snaps = [0, 1, 2, 3, 4].map(snap) as never;
      const r = await runCampaign(new Map(), snaps, p, { variants: 1, seed: 1, rescue: 0, extra: { battle: 4, variants: 1, rescue: 0 } });
      expect(r.battles.map((b) => b.replays ?? 0)).toEqual([0, 2, 2, 2, 0]);
      // 1 + 1 ([0]) + 3 x (1 + 2): every replay kept its level
      expect(r.carryOut?.officers[0].level).toBe(11);
      expect(r.battles[1].replayExp).toBe(200);
      // the target stops the replays: [0] Lv2, [1] Lv3 -> 4 -> 5 (two replays), then Lv5 meets farmLv 5
      script.length = 0;
      script.push(true, true, true, true, true, true, true, false);
      const r2 = await runCampaign(new Map(), snaps, { ...p, farmLv: 5 }, { variants: 1, seed: 1, rescue: 0, extra: { battle: 4, variants: 1, rescue: 0 } });
      expect(r2.battles.map((b) => b.replays ?? 0)).toEqual([0, 2, 0, 0, 0]);
      // older plans (no farmRuns): off
      script.length = 0;
      script.push(true, true, true, true, false);
      const old = { ...p } as Record<string, unknown>;
      delete old.farmRuns;
      delete old.farmLv;
      const r3 = await runCampaign(new Map(), snaps, old as never, { variants: 1, seed: 1, rescue: 0, extra: { battle: 4, variants: 1, rescue: 0 } });
      expect(r3.battles.map((b) => b.replays ?? 0)).toEqual([0, 0, 0, 0, 0]);
    } finally {
      grow.on = false;
    }
  });
});
