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

  it('farm phase: on by default, uses the turns up to the finish it needs and still wins; off without it', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams, paramOr } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const p = defaultParams();
    expect(paramOr(p, 'farm')).toBeGreaterThan(0.5);
    // plans made before the farm phase have no key: on
    const old = { ...p } as Partial<typeof p>;
    delete old.farm;
    expect(paramOr(old as typeof p, 'farm')).toBeGreaterThan(0.5);
    const on = await runGrindBattle(files, snap, p);
    const off = await runGrindBattle(files, snap, { ...p, farm: 0 });
    expect(off.finishReason).not.toBe('farm');
    if (on.finishReason === 'farm') {
      expect(on.won).toBe(true);
      expect(on.finishTurn!).toBeGreaterThanOrEqual(off.finishTurn ?? 0);
    }
  }, 300_000);

  it('reads the script gains of 사수관: the 관우-화웅 duel (+1 level)', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const o = await runGrindBattle(files, snap, defaultParams());
    const duel = o.script?.gains.find((g) => g.kind === 'duel');
    expect(duel).toBeDefined();
    expect(duel!.gives).toContain('Lv+1');
  }, 300_000);

  it('회남 plan: on at 회남 with the defaults (holds north-east, 유비 never walks out on a hopeless way), off without the keys', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    let snap = null;
    for (let n = 0; n < 20 && !snap; n++) {
      const s = await scenarioSnapshot(files, 1, n, 4242);
      if (s.stage === 2 && s.block === 12) snap = s;
    }
    expect(snap).not.toBeNull();
    const lines: string[] = [];
    const o = await runGrindBattle(files, snap!, { ...defaultParams(), hnStrike: 0 }, null, (l) => lines.push(l));
    expect(lines.some((l) => l.startsWith('회남 plan: hold near 21,8'))).toBe(true);
    expect(lines.some((l) => l.startsWith('회남 strike'))).toBe(false);
    // the escape starts only on a clear way, never as a last-turns walk through the enemy
    for (const l of lines.filter((x) => x.startsWith('finish: escape'))) expect(l).toMatch(/finish: escape at turn \d+/);
    expect(o.turns).toBeLessThanOrEqual(o.turnLimit);
    const off = Object.fromEntries(Object.entries(defaultParams()).filter(([k]) => !k.startsWith('hn'))) as ReturnType<typeof defaultParams>;
    const lines2: string[] = [];
    await runGrindBattle(files, snap!, off, null, (l) => lines2.push(l));
    expect(lines2.some((l) => l.startsWith('회남 plan'))).toBe(false);
  }, 600_000);

  it('회남 strike plan: on by default (also for plans made before it), stands at the stage cell by the wave turn', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    let snap = null;
    for (let n = 0; n < 20 && !snap; n++) {
      const s = await scenarioSnapshot(files, 1, n, 4242);
      if (s.stage === 2 && s.block === 12) snap = s;
    }
    const lines: string[] = [];
    const o = await runGrindBattle(files, snap!, defaultParams(), null, (l) => lines.push(l));
    expect(lines.some((l) => l.startsWith('회남 strike: stage 12,4 before the wave of 10'))).toBe(true);
    expect(o.turns).toBeLessThanOrEqual(o.turnLimit);
    const old = Object.fromEntries(Object.entries(defaultParams()).filter(([k]) => !k.startsWith('hnS'))) as ReturnType<typeof defaultParams>;
    const lines2: string[] = [];
    await runGrindBattle(files, snap!, old, null, (l) => lines2.push(l));
    expect(lines2.some((l) => l.startsWith('회남 strike'))).toBe(true);
  }, 600_000);


  it('회남 plan stays off elsewhere (사수관 plays the same with and without the keys)', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const off = Object.fromEntries(Object.entries(defaultParams()).filter(([k]) => !k.startsWith('hn'))) as ReturnType<typeof defaultParams>;
    const a = await runGrindBattle(files, snap, defaultParams());
    const b = await runGrindBattle(files, snap, off);
    // (the outcome echoes the parameters: compare the play)
    expect({ ...b, ms: 0, params: null }).toEqual({ ...a, ms: 0, params: null });
  }, 300_000);

  it('회남 has no commander victory: 기령 (69) falling ends nothing; the wins are the wipe-out and 유비 at (0,2)', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const { recordCommands } = await import('../src/native/battle/dev/setup');
    const files = loadFiles();
    let snap = null;
    for (let n = 0; n < 20 && !snap; n++) {
      const s = await scenarioSnapshot(files, 1, n, 1);
      if (s.stage === 2 && s.block === 12) snap = s;
    }
    expect(snap).not.toBeNull();
    const stage = new DevAssets(files).chapter(1).stages[2];
    const k = analyseBattle(stage, snap!.script);
    expect(snap!.script.victory.enabled).toBe(false);
    expect(k.victory).toBeNull();
    const recs = stage.blocks[12].records;
    // no defeat event (trigger 12) for 기령 or anyone; the wipe-out record (trigger 7) ends the battle
    expect(recs.some((r) => r.trigger === 12)).toBe(false);
    expect(recs.some((r) => r.trigger === 7 && recordCommands(stage, r.code).some((c) => c.name === 'BATTLE_END'))).toBe(true);
    expect(k.winCells.some((w) => w.officer === 0 && w.x0 === 0 && w.y0 === 2)).toBe(true);
  }, 300_000);
  it('arrivals and duels that win through LEAVE_GROUP: 신도 (1,3) +50 is a win cell, 호로관 장비-여포 and 팽성 유비-조하 end the battle', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const { scriptGains } = await import('../src/sim/grind/events');
    const files = loadFiles();
    const find = async (ch: number, stage: number, block: number) => {
      for (let n = 0; n < 20; n++) {
        const s = await scenarioSnapshot(files, ch, n, 1);
        if (s.stage === stage && s.block === block) return s;
      }
      return null;
    };
    // 신도: 유비 at (1,3) sets the +50 bonus and leaves the block's last group; the next block starts with BATTLE_END
    const sd = await find(1, 0, 6);
    expect(sd).not.toBeNull();
    const st = new DevAssets(files).chapter(1).stages[0];
    const k = analyseBattle(st, sd!.script);
    expect(k.winCells.some((w) => w.officer === 0 && w.x0 === 1 && w.y0 === 3)).toBe(true);
    const bonus = scriptGains(st, 6).find((g) => g.kind === 'bonus');
    expect(bonus?.bonus).toBe(50);
    expect(bonus?.ends).toBe(true);
    // 호로관: the duel removes the victory officer 여포 (4) and moves to the victory group
    const hl = await find(0, 0, 7);
    expect(hl).not.toBeNull();
    const kh = analyseBattle(new DevAssets(files).chapter(0).stages[0], hl!.script);
    expect(kh.winAdj.some((a) => a.actor === 2 && a.other === 4)).toBe(true);
    // 팽성: persuading 조하 (223) leaves for the group whose first record is the victory
    const pc = await find(1, 2, 4);
    expect(pc).not.toBeNull();
    const kp = analyseBattle(new DevAssets(files).chapter(1).stages[2], pc!.script);
    expect(kp.winAdj.some((a) => a.actor === 0 && a.other === 223)).toBe(true);
  }, 300_000);

  it('lure plan: on by default at 거록 and 계교, off with lure 0; the script traps (유비 / any unit into an area wakes a group) are read from the records', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const { scriptTraps } = await import('../src/sim/grind/lure');
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const files = loadFiles();
    const st = new DevAssets(files).chapter(1).stages[0];
    // 거록: 유비 into (4..10, 8..13) sends 장합 (102) and his group at him
    const tj = scriptTraps(st, 13);
    expect(tj.some((t) => t.who === 0 && t.x0 === 4 && t.y0 === 8 && t.x1 === 10 && t.y1 === 13 && t.officers.includes(102))).toBe(true);
    // 계교: any of ours into (10..15, 17..23) brings 원소's (9) army; 유비 into (23..29, 6..9) sends it at him
    const tg = scriptTraps(st, 15);
    expect(tg.some((t) => t.who === 0x400 && t.x0 === 10 && t.y0 === 17 && t.x1 === 15 && t.y1 === 23 && t.officers.includes(9))).toBe(true);
    expect(tg.some((t) => t.who === 0 && t.x0 === 23 && t.y0 === 6 && t.officers.includes(9))).toBe(true);
    for (const [block, label] of [[13, '거록'], [15, '계교']] as const) {
      let snap = null;
      for (let n = 0; n < 20 && !snap; n++) {
        const s = await scenarioSnapshot(files, 1, n, 4242);
        if (s.stage === 0 && s.block === block) snap = s;
      }
      expect(snap).not.toBeNull();
      const lines: string[] = [];
      const o = await runGrindBattle(files, snap!, { ...defaultParams(), rerolls: 0 }, null, (l) => lines.push(l));
      expect(lines.some((l) => l.startsWith(`${label} lure:`))).toBe(true);
      expect(o.turns).toBeLessThanOrEqual(o.turnLimit);
      const off: string[] = [];
      await runGrindBattle(files, snap!, { ...defaultParams(), rerolls: 0, lure: 0 }, null, (l) => off.push(l));
      expect(off.some((l) => l.includes(' lure:'))).toBe(false);
    }
  }, 600_000);

  it('lure plan stays off elsewhere (사수관 plays the same with and without its keys)', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const off = Object.fromEntries(Object.entries(defaultParams()).filter(([k]) => !k.startsWith('lu'))) as ReturnType<typeof defaultParams>;
    const a = await runGrindBattle(files, snap, defaultParams());
    const b = await runGrindBattle(files, snap, off);
    expect({ ...b, ms: 0, params: null }).toEqual({ ...a, ms: 0, params: null });
  }, 300_000);
});
