// Grinding simulator (src/sim/grind): one battle (사수관, the first battle of a new game) played in
// the headless sandbox by the grinding policy. Needs HERO_GAME_DIR. The sandbox runs the real battle
// scene with the real RNG, so the same snapshot + seed + parameters must give the same outcome.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_DIR, hasGame } from './gamedir';

function loadFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const f of readdirSync(GAME_DIR)) files.set(f.toUpperCase(), new Uint8Array(readFileSync(join(GAME_DIR, f))));
  return files;
}

describe.skipIf(!hasGame)('grind: one battle in the sandbox', () => {
  it('first battle is deterministic for a seed and the policy gains exp', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const a = await runGrindBattle(files, snap, defaultParams());
    const b = await runGrindBattle(files, snap, defaultParams());
    const strip = (o: typeof a) => ({ ...o, ms: 0 });
    expect(strip(b)).toEqual(strip(a));
    expect(a.deployed.length).toBeGreaterThan(0);
    expect(a.turns).toBeLessThanOrEqual(a.turnLimit);
    expect([1, 2, 3]).toContain(a.result);
    if (a.won) {
      expect(a.expTotal).toBeGreaterThan(0);
      for (const g of a.gains) expect(g.levelAfter).toBeLessThanOrEqual(99);
    }
    // a different seed is a different battle (the RNG is really used)
    const c = await runGrindBattle(files, { ...snap, rngSeed: 777 }, defaultParams());
    expect(c.rngAfter).not.toBe(a.rngAfter);
  }, 300_000);
});
