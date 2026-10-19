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

  it('lure plan: on at 거록 and 계교 without the search (and with srLure), off with lure 0 or under the search by default; the script traps (유비 / any unit into an area wakes a group) are read from the records', async () => {
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
      const o = await runGrindBattle(files, snap!, { ...defaultParams(), rerolls: 0, search: 0 }, null, (l) => lines.push(l));
      expect(lines.some((l) => l.startsWith(`${label} lure:`))).toBe(true);
      expect(o.turns).toBeLessThanOrEqual(o.turnLimit);
      const off: string[] = [];
      await runGrindBattle(files, snap!, { ...defaultParams(), rerolls: 0, search: 0, lure: 0 }, null, (l) => off.push(l));
      expect(off.some((l) => l.includes(' lure:'))).toBe(false);
      // under the search (the default) the plan only with srLure; srK 1 keeps the run short
      const s0: string[] = [];
      await runGrindBattle(files, snap!, { ...defaultParams(), rerolls: 0, srK: 1, srDepth: 1 }, null, (l) => s0.push(l));
      expect(s0.some((l) => l.includes(' lure:'))).toBe(false);
      const s1: string[] = [];
      await runGrindBattle(files, snap!, { ...defaultParams(), rerolls: 0, srK: 1, srDepth: 1, srLure: 1 }, null, (l) => s1.push(l));
      expect(s1.some((l) => l.startsWith(`${label} lure:`))).toBe(true);
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

describe('grind: combat exp params', () => {
  it('mending is on by default (also for plans made before it), the troop price and counters off, all learnable within bounds', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(d.cbPrice).toBe(0);
    expect(d.cbMend).toBeGreaterThan(0);
    expect(d.cbCap).toBeLessThan(1);
    expect(d.cbCounter).toBe(0);
    const old = { ...d } as Record<string, number>;
    for (const k of ['cbPrice', 'cbHeal', 'cbCounter', 'cbReach', 'cbBase', 'cbCap', 'cbMend']) delete old[k];
    const p = old as unknown as typeof d;
    for (const k of ['cbPrice', 'cbHeal', 'cbCounter', 'cbReach', 'cbBase', 'cbCap', 'cbMend'] as const) {
      expect(paramOr(p, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 5 })[k]).toBe(s.max);
    }
  });
});

describe.skipIf(!hasGame)('grind: combat exp in the sandbox', () => {
  it('a plan without the combat keys plays as the defaults; 사수관 is won with mending off and the troop price on too', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const d = defaultParams();
    const old = { ...d } as Record<string, number>;
    for (const k of ['cbPrice', 'cbHeal', 'cbCounter', 'cbReach', 'cbBase', 'cbCap', 'cbMend']) delete old[k];
    const strip = (o: { ms: number }) => ({ ...o, ms: 0, params: null });
    const a = await runGrindBattle(files, snap, d);
    const b = await runGrindBattle(files, snap, old as unknown as typeof d);
    expect(strip(b)).toEqual(strip(a));
    const off = await runGrindBattle(files, snap, { ...d, cbPrice: 0.6, cbMend: 0 });
    expect(a.won).toBe(true);
    expect(off.won).toBe(true);
  }, 300_000);
});

describe('grind: wake phase params', () => {
  it('the wake phase is on by default (also for plans made before it) and learnable within bounds', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(d.wake).toBeGreaterThan(0.5);
    expect(d.wakeRatio).toBeGreaterThan(1);
    const old = { ...d } as Record<string, number>;
    delete old.wake;
    delete old.wakeRatio;
    const p = old as unknown as typeof d;
    for (const k of ['wake', 'wakeRatio'] as const) {
      expect(paramOr(p, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 5 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 5 })[k]).toBe(s.min);
    }
  });
});

describe.skipIf(!hasGame)('grind: wake phase in the sandbox', () => {
  it('a plan without the wake keys plays as the defaults; 사수관 is won with the wake phase off too', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const d = defaultParams();
    const old = { ...d } as Record<string, number>;
    delete old.wake;
    delete old.wakeRatio;
    const strip = (o: { ms: number }) => ({ ...o, ms: 0, params: null });
    const a = await runGrindBattle(files, snap, d);
    const b = await runGrindBattle(files, snap, old as unknown as typeof d);
    expect(strip(b)).toEqual(strip(a));
    const off = await runGrindBattle(files, snap, { ...d, wake: 0 });
    expect(a.won).toBe(true);
    expect(off.won).toBe(true);
    expect(off.wakeTurns ?? 0).toBe(0);
  }, 300_000);
});

describe('grind: look-ahead search params', () => {
  it('the search keys are learnable within bounds and plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['search', 'srK', 'srSamples', 'srDepth', 'srHp', 'srLeader', 'srFoe', 'srGap', 'srMargin', 'srProg', 'srVerify', 'srLure'] as const;
    // on by default (it beat the greedy policy on the bench), looking a turn past the enemy's reply
    expect(d.search).toBeGreaterThan(0.5);
    expect(d.srDepth).toBe(2);
    expect(d.srLure).toBeLessThan(0.5);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    const p = old as unknown as typeof d;
    for (const k of keys) {
      expect(paramOr(p, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
    // appended after the wake keys: learned plans store the CEM mean by index
    const idx = (k: string) => PARAM_SPECS.findIndex((x) => x.key === k);
    for (const k of keys) expect(idx(k)).toBeGreaterThan(idx('wakeRatio'));
  });
});

describe('grind: fish pen params', () => {
  it('the pen keys are learnable within bounds, appended at the end, and plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['pen', 'penRatio', 'penHarm', 'penPrice', 'penCell', 'penCounter'] as const;
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    const p = old as unknown as typeof d;
    for (const k of keys) {
      expect(paramOr(p, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
    // learned plans store the CEM mean by index: the pen keys were appended after idleFinish (and
    // only later keys, the shop's sell, idleAp / scrollEarn, the escort exit's escIdle / escWin, the band farm and the gate, follow them)
    const idx = (k: string) => PARAM_SPECS.findIndex((x) => x.key === k);
    expect(PARAM_SPECS.slice(idx('pen'), idx('pen') + keys.length).map((s) => s.key)).toEqual([...keys]);
    expect(idx('pen')).toBeGreaterThan(idx('idleFinish'));
    expect(PARAM_SPECS.slice(idx('sell')).map((s) => s.key)).toEqual(['sell', 'idleAp', 'scrollEarn', 'escIdle', 'escWin', 'bandFarm', 'bfRatio', 'bfSpare', 'bfCell', 'bfPen', 'bfEnd', 'gate', 'gateLate', 'farmReach', 'wakeAvoid', 'wakeKill', 'wakeReroll', 'capture', 'capSlack', 'capLast', 'capLoot', 'fireRing', 'sleeper', 'bandEnd', 'castIdle', 'finNeed', 'finPath', 'gainPick', 'ambush', 'ambTurns', 'duelKeep', 'finCharge', 'duelOut', 'duelReach', 'ambWake', 'ypPlan', 'farmHold', 'holdWalk', 'wakeShut', 'yyPlan', 'yyGate', 'door', 'doorTurns', 'yePick', 'ye3Plan']);
  });
  it('escort exit (escIdle, escWin): appended last; plans without them take the defaults', async () => {
    const { defaultParams, paramOr } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(d.escIdle).toBe(4);
    expect(d.escWin).toBe(3);
    const old = { ...d } as Record<string, number>;
    delete old.escIdle;
    delete old.escWin;
    expect(paramOr(old as unknown as typeof d, 'escIdle')).toBe(4);
    expect(paramOr(old as unknown as typeof d, 'escWin')).toBe(3);
  });
  it('idleAp and scrollEarn: appended last, off by default, so older plans play as before', async () => {
    const { defaultParams, paramOr } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    for (const k of ['idleAp', 'scrollEarn'] as const) {
      expect(d[k]).toBe(0);
      const old = { ...d } as Record<string, number>;
      delete old[k];
      expect(paramOr(old as unknown as typeof d, k)).toBe(0);
    }
  });
});

describe('grind: band farm params', () => {
  it('the band farm keys are appended last, learnable within bounds, and plans made before them read the defaults (on)', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['bandFarm', 'bfRatio', 'bfSpare', 'bfCell', 'bfPen', 'bfEnd'] as const;
    // the gate keys, farmReach, the waker keys, the capture keys, fireRing, sleeper and the 가맹관 keys come after them
    expect(PARAM_SPECS.slice(-keys.length - 34, -34).map((s) => s.key)).toEqual([...keys]);
    expect(d.bandFarm).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    for (const k of keys) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
  });
});

describe('grind: gate params', () => {
  it('gate and gateLate are appended last (before farmReach, the waker keys, the capture keys, fireRing, sleeper and the 가맹관 keys), on (open once no enemy is near) by default, learnable within bounds', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['gate', 'gateLate'] as const;
    expect(PARAM_SPECS.slice(-keys.length - 32, -32).map((s) => s.key)).toEqual([...keys]);
    expect(d.gate).toBeGreaterThan(0.5);
    expect(d.gateLate).toBe(0);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    for (const k of keys) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
  });
});

describe('grind: farm reach param', () => {
  it('farmReach is appended last (before the waker keys, the capture keys, fireRing, sleeper and the 가맹관 keys), off by default, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 32].key).toBe('farmReach');
    expect(d.farmReach).toBeLessThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.farmReach;
    expect(paramOr(old as unknown as typeof d, 'farmReach')).toBe(d.farmReach);
    const s = PARAM_SPECS.find((x) => x.key === 'farmReach')!;
    expect(clampParams({ ...d, farmReach: s.max + 500 }).farmReach).toBe(s.max);
    expect(clampParams({ ...d, farmReach: s.min - 500 }).farmReach).toBe(s.min);
  });
});

describe('grind: waker params', () => {
  it('wakeAvoid, wakeKill and wakeReroll are appended last (before the capture keys, fireRing, sleeper and the 가맹관 keys), on by default, learnable within bounds; plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['wakeAvoid', 'wakeKill', 'wakeReroll'] as const;
    expect(PARAM_SPECS.slice(-keys.length - 28, -28).map((s) => s.key)).toEqual([...keys]);
    expect(d.wakeAvoid).toBeGreaterThan(0.5);
    expect(d.wakeKill).toBeGreaterThan(0);
    expect(d.wakeReroll).toBeGreaterThan(0);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    for (const k of keys) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
  });
});

describe.skipIf(!hasGame)('grind: wakers read from the script', () => {
  it('무릉 (chapter 3 stage 0 block 9): next to 양안 (224) or 오조 (232), or either falling, wakes the army; 거록 and 신도 have none', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number) => ({ block, victory: { enabled: false, officer: 0 }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(3).stages[0], script(9));
    const by = new Map(k.wakers.map((w) => [w.officer, w.wakes]));
    expect([...by.keys()].sort((x, y) => x - y)).toEqual([224, 232]);
    for (const off of [274, 292, 293, 256, 310, 311]) {
      expect(by.get(224)).toContain(off);
      expect(by.get(232)).toContain(off);
    }
    expect(by.get(224)).toContain(232);
    expect(by.get(232)).toContain(224);
    expect(analyseBattle(a.chapter(1).stages[0], script(13)).wakers).toEqual([]);
    expect(analyseBattle(a.chapter(1).stages[0], script(6)).wakers).toEqual([]);
  });
});

describe.skipIf(!hasGame)('grind: doors read from the script', () => {
  it('허창2 (chapter 4 stage 1 block 7): one of ours at (13,10), before the inner gate, opens it and moves on to the group where 사마의 falls; the drawbridge of 하비 (behind the persuasions) is a gate, no door', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle, scriptDoors } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number, victory: number) => ({ block, victory: { enabled: true, officer: victory }, defeat: { enabled: true, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(4).stages[1], script(7, 213));
    expect(k.doors).toEqual([{ group: 4, record: 6, actor: 0x400, x0: 13, y0: 10, x1: 13, y1: 10 }]);
    // (not an ambush either: its LEAVE_GROUP changes the map)
    expect(k.ambushes.some((z) => z.record === 6)).toBe(false);
    expect(scriptDoors(a.chapter(1).stages[3], 4)).toEqual([]);
  });
});

describe('grind: door params', () => {
  it('door (on) and doorTurns are appended last, learnable within bounds; plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS.slice(-4, -2).map((s) => s.key)).toEqual(['door', 'doorTurns']);
    expect(d.door).toBeGreaterThan(0.5);
    expect(d.doorTurns).toBe(16);
    const old = { ...d } as Record<string, number>;
    delete old.door;
    delete old.doorTurns;
    for (const k of ['door', 'doorTurns'] as const) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const sp = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: sp.max + 500 })[k]).toBe(sp.max);
      expect(clampParams({ ...d, [k]: sp.min - 500 })[k]).toBe(sp.min);
    }
  });
});

describe('grind: capture params', () => {
  it('capture, capSlack, capLast and capLoot are appended last (before fireRing, sleeper and the 가맹관 keys), on by default, learnable within bounds; plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['capture', 'capSlack', 'capLast', 'capLoot'] as const;
    expect(PARAM_SPECS.slice(-keys.length - 24, -24).map((s) => s.key)).toEqual([...keys]);
    expect(d.capture).toBeGreaterThan(0.5);
    expect(d.capLoot).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    for (const k of keys) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
  });
});

describe.skipIf(!hasGame)('grind: captures read from the script', () => {
  it('공안 (chapter 3 stage 1 block 5): the four forts win only together, before the turn-15 wave, outside the middle trap; 무릉 and 거록 have none', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number, victory = 0, on = false) => ({ block, victory: { enabled: on, officer: victory }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(3).stages[1], script(5, 142, true));
    expect(k.captures).not.toBeNull();
    const c = k.captures!;
    expect(c.group).toBe(3);
    expect(c.cells.map((x) => [x.x0, x.y0, x.flag]).sort((p, q) => p[2] - q[2])).toEqual([[25, 1, 34], [37, 2, 35], [17, 21, 36], [37, 21, 37]]);
    expect(c.cells.every((x) => x.actor === 0x400)).toBe(true);
    expect(c.by).toBe(15);
    expect(c.traps).toEqual([{ x0: 21, y0: 8, x1: 39, y1: 17 }]);
    // one fort alone is no win cell
    expect(k.winCells.some((w) => c.cells.some((x) => x.x0 === w.x0 && x.y0 === w.y0))).toBe(false);
    expect(analyseBattle(a.chapter(3).stages[0], script(9)).captures).toBeNull();
    expect(analyseBattle(a.chapter(1).stages[0], script(13)).captures).toBeNull();
  });
});

describe('grind: fire ring param', () => {
  it('fireRing is appended last (before sleeper and the 가맹관 keys), on by default, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 24].key).toBe('fireRing');
    expect(d.fireRing).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.fireRing;
    expect(paramOr(old as unknown as typeof d, 'fireRing')).toBe(d.fireRing);
    const s = PARAM_SPECS.find((x) => x.key === 'fireRing')!;
    expect(clampParams({ ...d, fireRing: s.max + 500 }).fireRing).toBe(s.max);
    expect(clampParams({ ...d, fireRing: s.min - 500 }).fireRing).toBe(s.min);
  });
});

describe('grind: sleeper param', () => {
  it('sleeper is appended last (before the 가맹관 keys), on by default, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 23].key).toBe('sleeper');
    expect(d.sleeper).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.sleeper;
    expect(paramOr(old as unknown as typeof d, 'sleeper')).toBe(d.sleeper);
    const s = PARAM_SPECS.find((x) => x.key === 'sleeper')!;
    expect(clampParams({ ...d, sleeper: s.max + 500 }).sleeper).toBe(s.max);
    expect(clampParams({ ...d, sleeper: s.min - 500 }).sleeper).toBe(s.min);
  });
});

describe.skipIf(!hasGame)('grind: sleepers read from the script', () => {
  it('부 2nd (chapter 3 stage 2 block 10): one of ours on the eastern path (20..28 x 6..10) before turn 8 sends the wave to stand around the castle; 부 1st and 무릉 have none', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number, victory = 0, on = false) => ({ block, victory: { enabled: on, officer: victory }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(3).stages[2], script(10, 193, true));
    expect(k.sleepers.length).toBe(1);
    const z = k.sleepers[0];
    expect([z.record, z.x0, z.y0, z.x1, z.y1, z.until]).toEqual([9, 20, 6, 28, 10, 8]);
    expect([...z.calms].sort((p, q) => p - q)).toEqual([197, 198, 199, 253, 254, 274, 340]);
    expect(analyseBattle(a.chapter(3).stages[2], script(6, 193, true)).sleepers).toEqual([]);
    expect(analyseBattle(a.chapter(3).stages[0], script(9)).sleepers).toEqual([]);
  });
});

describe('grind: 가맹관 params', () => {
  it('bandEnd, castIdle, finNeed, finPath, gainPick, ambush, ambTurns, duelKeep, finCharge and duelOut are appended last, on by default, learnable within bounds; plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['bandEnd', 'castIdle', 'finNeed', 'finPath', 'gainPick', 'ambush', 'ambTurns', 'duelKeep', 'finCharge', 'duelOut'] as const;
    const at = PARAM_SPECS.findIndex((s) => s.key === 'bandEnd');
    expect(PARAM_SPECS.slice(at, at + keys.length).map((s) => s.key)).toEqual([...keys]);
    for (const k of ['bandEnd', 'gainPick', 'ambush', 'finCharge', 'duelOut'] as const) expect(d[k]).toBeGreaterThan(0.5);
    for (const k of ['castIdle', 'finNeed', 'finPath', 'ambTurns', 'duelKeep'] as const) expect(d[k]).toBeGreaterThan(0);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    for (const k of keys) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
  });
});

describe('grind: 정군산 / 양평관 params', () => {
  it('duelReach and ambWake (on) are appended last, learnable within bounds; plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['duelReach', 'ambWake'] as const;
    expect(PARAM_SPECS.slice(-keys.length - 10, -10).map((s) => s.key)).toEqual([...keys]);
    expect(d.duelReach).toBeGreaterThan(0.5);
    expect(d.ambWake).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    for (const k of keys) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
  });
  it('ypPlan (on) is appended last (before farmHold and holdWalk); the plan is for 양평관 only and holds the finish until its last phase', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const Y = await import('../src/sim/grind/yangpyeong');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 10].key).toBe('ypPlan');
    expect(d.ypPlan).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.ypPlan;
    expect(paramOr(old as unknown as typeof d, 'ypPlan')).toBe(d.ypPlan);
    expect(clampParams({ ...d, ypPlan: 9 }).ypPlan).toBe(1);
    expect(Y.isYangpyeongAt(3, 3, 14)).toBe(true);
    expect(Y.isYangpyeongAt(3, 2, 14)).toBe(false);
    const st = Y.ypInit();
    expect(st.phase).toBe('form');
    expect(Y.ypHoldFinish(st)).toBe(true);
    expect(Y.ypBan(st, 36, 16, null)!.cells[13 * 36 + 15]).toBe(1);
    expect(Y.ypBan(st, 36, 16, null)!.cells[13 * 36 + 16]).toBe(0);
    expect(Y.ypBan({ phase: 'cross', since: 20 }, 36, 16, null)).toBeNull();
    expect(Y.ypHoldFinish({ phase: 'finish', since: 30 })).toBe(false);
  });
});

describe('grind: farm before the end / walk to a holding enemy params', () => {
  it('farmHold and holdWalk (on) are appended last, learnable within bounds; plans made before them read the defaults', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const keys = ['farmHold', 'holdWalk'] as const;
    expect(PARAM_SPECS.slice(-keys.length - 7, -7).map((s) => s.key)).toEqual([...keys]);
    for (const k of keys) expect(d[k]).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    for (const k of keys) delete old[k];
    for (const k of keys) {
      expect(paramOr(old as unknown as typeof d, k)).toBe(d[k]);
      const s = PARAM_SPECS.find((x) => x.key === k)!;
      expect(clampParams({ ...d, [k]: s.max + 500 })[k]).toBe(s.max);
      expect(clampParams({ ...d, [k]: s.min - 500 })[k]).toBe(s.min);
    }
  });
});

describe('grind: shut wakers param', () => {
  it('wakeShut (on) is appended after holdWalk, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 7].key).toBe('wakeShut');
    expect(d.wakeShut).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.wakeShut;
    expect(paramOr(old as unknown as typeof d, 'wakeShut')).toBe(d.wakeShut);
    expect(clampParams({ ...d, wakeShut: 9 }).wakeShut).toBe(1);
    expect(clampParams({ ...d, wakeShut: -9 }).wakeShut).toBe(0);
  });
});

describe('grind: 양양 plan param', () => {
  it('yyPlan (on) is appended (before yyGate), learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 6].key).toBe('yyPlan');
    expect(d.yyPlan).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.yyPlan;
    expect(paramOr(old as unknown as typeof d, 'yyPlan')).toBe(d.yyPlan);
    expect(clampParams({ ...d, yyPlan: 9 }).yyPlan).toBe(1);
    expect(clampParams({ ...d, yyPlan: -9 }).yyPlan).toBe(0);
  });
  it('the wood holds the horsemen off: who is in it stays in it, the leader keeps off its edge; nothing banned outside the hold', async () => {
    const { yyBanned, yyInit, yyAnchor } = await import('../src/sim/grind/xiangyang');
    const st = yyInit();
    const wood = (x: number, y: number) => y >= 20 && x >= 17;
    const edge = (x: number, y: number) => wood(x, y) && (x === 17 || y === 20);
    expect(yyBanned(st, wood, edge, [18, 21], false, 16, 21)).toBe(false);
    expect(yyAnchor(st, 1)).toEqual([16, 22]);
    st.phase = 'hold';
    expect(yyBanned(st, wood, edge, [18, 21], false, 16, 21)).toBe(true);
    expect(yyBanned(st, wood, edge, [18, 21], false, 17, 21)).toBe(false);
    expect(yyBanned(st, wood, edge, [19, 22], true, 19, 20)).toBe(true);
    expect(yyBanned(st, wood, edge, [19, 22], true, 19, 21)).toBe(false);
    st.phase = 'finish';
    expect(yyAnchor(st, 0)).toBeNull();
    expect(yyBanned(st, wood, edge, [18, 21], true, 16, 21)).toBe(false);
  });
  it('yyGate (on) is appended after yyPlan, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 5].key).toBe('yyGate');
    expect(d.yyGate).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.yyGate;
    expect(paramOr(old as unknown as typeof d, 'yyGate')).toBe(d.yyGate);
    expect(clampParams({ ...d, yyGate: 9 }).yyGate).toBe(1);
    expect(clampParams({ ...d, yyGate: -9 }).yyGate).toBe(0);
  });
  it('the gate plan: no anchor in the siege until the gate is clear, then the mouth; in the hold who is behind the gate stays there; the finish walks round 모개', async () => {
    const { yyBanned, yyInit, yyAnchor, yyPocket, yyBan, YY } = await import('../src/sim/grind/xiangyang');
    const st = yyInit(true);
    const no = () => false;
    expect(st.phase).toBe('siege');
    expect(yyAnchor(st, 0)).toBeNull();
    st.open = true;
    expect(yyAnchor(st, 0)).toEqual(YY.mouth);
    expect(yyBanned(st, no, no, [10, 15], false, 10, 17)).toBe(false);
    st.phase = 'mouth';
    expect(yyPocket(10, 15) && yyPocket(12, 13) && !yyPocket(10, 16) && !yyPocket(11, 12) && !yyPocket(8, 13)).toBe(true);
    expect(yyBanned(st, no, no, [10, 15], false, 10, 16)).toBe(true);
    expect(yyBanned(st, no, no, [10, 15], false, 11, 13)).toBe(false);
    expect(yyBanned(st, no, no, [10, 18], false, 10, 17)).toBe(false);
    expect(yyBan(st, [], 24, 24, null)).toBeNull();
    st.phase = 'finish';
    expect(yyAnchor(st, 0)).toBeNull();
    const moge = { slot: 20, status: 2, officer: 168, x: 14, y: 9 } as unknown as Parameters<typeof yyBan>[1][number];
    const ban = yyBan(st, [moge], 24, 24, null)!;
    expect(ban.cells[8 * 24 + 14]).toBe(1);
    expect(ban.cells[9 * 24 + 13]).toBe(1);
    expect(ban.cells[7 * 24 + 14]).toBe(0);
    expect(yyBan(st, [], 24, 24, null)).toBeNull();
  });
});

describe.skipIf(!hasGame)('grind: timed ends carried on into the next block', () => {
  it('강릉 (chapter 3 stage 0 block 2): the turn-8 wave goes on in block 3, whose turn-16 event (주유 out of food) wins: endsAt 16; 진교\'s fall before it ends the battle (protected)', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const a = new DevAssets(loadFiles());
    const script = (block: number, victory = 0, on = false) => ({ block, victory: { enabled: on, officer: victory }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(3).stages[0], script(2, 142, true));
    expect(k.endsAt).toBe(16);
    expect(k.deadline).toBeNull();
    expect(k.protect.has(171)).toBe(true);
    expect(k.turns.map((e) => e.turn)).toEqual([8]);
    // block 3 itself: the same end, read directly
    expect(analyseBattle(a.chapter(3).stages[0], script(3, 142, true)).endsAt).toBe(16);
  });
});

describe.skipIf(!hasGame)('grind: wake ambushes read from the script', () => {
  it('양평관 (chapter 3 stage 3 block 14): one of ours in 20..25 x 6..15 turns 장합, 조창, 방덕 and six more on us (r4, once: flag 145); r5 by 조조\'s camp turns seven', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number, victory = 0, on = false) => ({ block, victory: { enabled: on, officer: victory }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(3).stages[3], script(14, 8, true));
    expect(k.ambushes.map((z) => [z.record, z.wake, z.x0, z.y0, z.x1, z.y1, z.clear])).toEqual([
      [4, true, 20, 6, 25, 15, [145]],
      [5, true, 3, 6, 8, 11, [146]],
    ]);
    expect([...k.ambushes[0].officers].sort((p, q) => p - q)).toEqual([102, 211, 215, 259, 260, 279, 280, 281, 293]);
    // 정군산's duel partner 하후연 walks to us; 가맹관2's 하후덕 holds by his castle
    expect(analyseBattle(a.chapter(3).stages[3], script(6, 17, true)).winAdj).toEqual([{ actor: 169, other: 17, group: 3 }]);
  });
});

describe.skipIf(!hasGame)('grind: an ambush whose record moves the script on', () => {
  it('양양 (chapter 4 stage 0 block 5): one of ours inside the walls (4..14 x 7..12) brings 만총, 우금 and five horsemen in (r6, then LEAVE_GROUP)', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number, victory = 0, on = false) => ({ block, victory: { enabled: on, officer: victory }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(4).stages[0], script(5, 18, true));
    expect(k.ambushes.map((z) => [z.record, z.actor, z.x0, z.y0, z.x1, z.y1, !!z.wake, !!z.leaves])).toEqual([[6, 0x400, 4, 7, 14, 12, false, true]]);
    expect([83, 170, 294, 295, 296, 297, 298].every((o) => k.ambushes[0].officers.includes(o))).toBe(true);
  });
});

describe.skipIf(!hasGame)('grind: ambushes and duel actors read from the script', () => {
  it('가맹관1 (chapter 3 stage 2 block 14): one of ours in 14..17 x 1..17 brings 마초 and five more in; the sortie takes 장비 there, 엄안 at 가맹관2 and 황충 at 정군산', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const { gainActors } = await import('../src/sim/grind/battle');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number, victory = 0, on = false) => ({ block, victory: { enabled: on, officer: victory }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(3).stages[2], script(14, 204, true));
    expect(k.ambushes.length).toBe(1);
    const z = k.ambushes[0];
    expect([z.record, z.actor, z.x0, z.y0, z.x1, z.y1]).toEqual([5, 0x400, 14, 1, 17, 17]);
    expect(z.clear).toEqual([170]);
    expect([...z.officers].sort((p, q) => p - q)).toEqual([189, 203, 294, 295, 296, 297]);
    // the turn events and the treasure cell are no ambushes; 부 2nd's sleeper area (its wave comes in to stand still) is none either
    expect(analyseBattle(a.chapter(3).stages[2], script(10, 193, true)).ambushes).toEqual([]);
    expect(analyseBattle(a.chapter(3).stages[0], script(9)).ambushes).toEqual([]);
    expect(gainActors(a.chapter(3).stages[2], 14)).toEqual([2]);
    expect(gainActors(a.chapter(3).stages[3], 4)).toEqual([202]);
    expect(gainActors(a.chapter(3).stages[3], 6)).toEqual([169]);
  });
  it('pickFormation takes the duel actors right after 유비', async () => {
    const { pickFormation } = await import('../src/sim/grind/policy');
    const officers = Array.from({ length: 12 }, (_, i) => ({ dyn: { level: 50 - i, flags: 0x80, cls: 0 } }));
    const state = { officers } as unknown as Parameters<typeof pickFormation>[0];
    // three free records, nothing strong: the lowest levels fill up, the actor (9) goes out first
    expect(pickFormation(state, [0], 3, 0, false, 0, undefined, [9])).toEqual([9, 11, 10]);
    expect(pickFormation(state, [0], 3, 0)).toEqual([11, 10, 9]);
  });
});

describe.skipIf(!hasGame)('grind: deaths read from the script', () => {
  it('부 1st (chapter 3 stage 2 block 6): 방통 falling is his death (UNIT_FORCE #132, 14), no gain and no enemy to spare; the turn-8 supply raid ends the battle', async () => {
    const { DevAssets } = await import('../src/native/battle/dev/context');
    const { analyseBattle } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const a = new DevAssets(files);
    const script = (block: number, victory = 0, on = false) => ({ block, victory: { enabled: on, officer: victory }, defeat: { enabled: false, officer: 0 } }) as unknown as Parameters<typeof analyseBattle>[1];
    const k = analyseBattle(a.chapter(3).stages[2], script(6, 193, true));
    expect(k.deaths).toEqual([{ officer: 132, record: 3 }]);
    expect(k.protect.has(132)).toBe(false);
    expect(k.gains.some((g) => g.record === 3)).toBe(false);
    // r4: turn 8, LEAVE_GROUP into the group whose auto record is BATTLE_END
    expect(k.endsAt).toBe(8);
    // 부 2nd (block 10) and 무릉 have no death records
    expect(analyseBattle(a.chapter(3).stages[2], script(10, 193, true)).deaths).toEqual([]);
    expect(analyseBattle(a.chapter(3).stages[0], script(9)).deaths).toEqual([]);
  });
});

describe.skipIf(!hasGame)('grind: look-ahead search in the sandbox', () => {
  it('rollouts leave no trace (one candidate plays as the greedy policy), and the search wins 사수관', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const d = defaultParams();
    const strip = (o: { ms: number }) => ({ ...o, ms: 0, params: null, search: null });
    const off = await runGrindBattle(files, snap, { ...d, search: 0 });
    // every phase is saved, played out (our phase, the enemy's reply, one more turn) and restored
    const one = await runGrindBattle(files, snap, { ...d, search: 1, srK: 1, srDepth: 2 });
    expect(one.search!.phases).toBeGreaterThan(0);
    expect(one.search!.rollouts).toBeGreaterThan(0);
    expect(strip(one)).toEqual(strip(off));
    const on = await runGrindBattle(files, snap, { ...d, search: 1 });
    expect(on.won).toBe(true);
    expect(on.search!.phases).toBeGreaterThan(0);
    expect(on.turns).toBeLessThanOrEqual(on.turnLimit);
  }, 300_000);
});

describe.skipIf(!hasGame)('grind: 총퇴각 retry', () => {
  it('a retried battle starts with every unit on its own cell again (the unit map is not left stale)', async () => {
    const { scenarioSnapshot } = await import('../src/sim/grind/devsnap');
    const { runGrindBattle, sceneHooks } = await import('../src/sim/grind/battle');
    const { defaultParams } = await import('../src/sim/grind/policy');
    const files = loadFiles();
    const snap = await scenarioSnapshot(files, 0, 0, 12345);
    const starts: string[] = [];
    const hook = (scene: { units: { officer: number; x: number; y: number; status: number }[] }) => {
      starts.push(scene.units.filter((u) => u.officer !== 0xffff && u.status === 2).map((u) => `${u.officer}@${u.x},${u.y}`).join(' '));
    };
    sceneHooks.push(hook as never);
    try {
      await runGrindBattle(files, snap, { ...defaultParams(), rerolls: 3, search: 0 });
    } finally {
      sceneHooks.splice(sceneHooks.indexOf(hook as never), 1);
    }
    // the first try and the three retries (8422 found every record's cell taken on every second one)
    expect(starts.length).toBe(4);
    expect(new Set(starts).size).toBe(1);
  }, 300_000);
});
