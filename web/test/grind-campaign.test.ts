// runCampaign's backtracking (src/sim/grind/campaign.ts) with a scripted battle search: a backtrack
// that does not get back past the furthest chain of wins must not leave the run worse than that chain.
import { describe, expect, it, vi } from 'vitest';

const script: boolean[] = [];
vi.mock('../src/sim/grind/battle', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/sim/grind/battle')>();
  return {
    ...real,
    searchBattle: vi.fn(async (_files: unknown, snap: { index: number }, base: { tag?: number }) => {
      const won = script.shift() ?? false;
      const best = {
        won, result: won ? 2 : 3, turns: 20, turnLimit: 30, finishTurn: null, params: { ...base, tag: snap.index }, gains: [], score: won ? 100 : -1, expTotal: won ? 100 : 0,
        kept: [], deployed: [0], actions: { attack: 0, kill: 0, tactic: 0, heal: 0, wait: 0 }, tactics: {}, formationOut: undefined,
        officersAfter: [{ level: 2 + snap.index, exp: 0 }], moneyAfter: 0, purchases: [], rngAfter: 0, ms: 0,
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

describe('grind: code revision of kept candidates', () => {
  it('codeRevision changes when a source under sim/native/engine/formats changes, not for a test file or another folder', async () => {
    const { codeRevision } = await import('../src/sim/grind/revision');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const src = mkdtempSync(join(tmpdir(), 'rev-'));
    try {
      mkdirSync(join(src, 'sim', 'grind'), { recursive: true });
      mkdirSync(join(src, 'editor'), { recursive: true });
      writeFileSync(join(src, 'sim', 'grind', 'a.ts'), 'export const a = 1;\n');
      const r0 = codeRevision(src);
      expect(codeRevision(src)).toBe(r0);
      writeFileSync(join(src, 'sim', 'grind', 'a.test.ts'), 'x');
      writeFileSync(join(src, 'editor', 'e.ts'), 'x');
      expect(codeRevision(src)).toBe(r0);
      writeFileSync(join(src, 'sim', 'grind', 'a.ts'), 'export const a = 2;\n');
      expect(codeRevision(src)).not.toBe(r0);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
