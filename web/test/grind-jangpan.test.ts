// 장판파 2nd plan (jangpan.ts, GrindParams.jpPlan): while a 민중 walks to the exit, 유비 holds the
// south-east wood's far corner and the others close round him; the plan's parameter is appended last.
import { describe, expect, it } from 'vitest';

describe('grind: 장판파 2nd plan (jpPlan)', () => {
  it('jpPlan is appended last, on by default, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 4].key).toBe('jpPlan');
    expect(d.jpPlan).toBeGreaterThan(0.5);
    const old = { ...d } as Record<string, number>;
    delete old.jpPlan;
    expect(paramOr(old as unknown as typeof d, 'jpPlan')).toBe(d.jpPlan);
    expect(clampParams({ ...d, jpPlan: 9 }).jpPlan).toBe(1);
    expect(clampParams({ ...d, jpPlan: -1 }).jpPlan).toBe(0);
  });

  it('the plan is on for a 민중 walking to (0,10) only; anchors by move type; wood holders stay in it; off with the 민중', async () => {
    const { JP, isJangpanAt, jpEscort, jpInit, jpUpdate, jpAnchor, jpBanned, jpHoldFinish } = await import('../src/sim/grind/jangpan');
    expect(isJangpanAt(2, 3, 7)).toBe(true);
    expect(isJangpanAt(2, 3, 6)).toBe(false);
    // slots 0..14 ours: 0 유비, 1 an officer, 12 a 민중 (computer, 무공격이동 to its cell)
    const unit = (slot: number, o: Partial<{ officer: number; status: number; mode: number; tx: number; ty: number }>) => ({ slot, officer: 0xffff, status: 0, mode: 7, tx: 0, ty: 0, x: 0, y: 0, ...o });
    const units = Array.from({ length: 15 }, (_, i) => unit(i, {}));
    units[0] = unit(0, { officer: 0, status: 2 });
    units[1] = unit(1, { officer: 125, status: 2 });
    units[12] = unit(12, { officer: 344, status: 2, mode: 4, tx: 32, ty: 22 });
    const ours = (u: { slot: number }) => u.slot < 12;
    // the 1st battle's goal (32,22): no plan
    expect(jpEscort(units as never, ours as never)).toBe(false);
    units[12].tx = JP.exit[0];
    units[12].ty = JP.exit[1];
    expect(jpEscort(units as never, ours as never)).toBe(true);
    // a controllable unit walking there is not a 민중
    expect(jpEscort(units as never, (() => true) as never)).toBe(false);
    const st = jpInit(1);
    expect(jpAnchor(st, 0, true)).toEqual(JP.corner);
    expect(jpAnchor(st, 0, false)).toEqual(JP.wood);
    expect(jpAnchor(st, 1, false)).toEqual(JP.woodCav);
    expect(jpHoldFinish(st)).toBe(true);
    // in the wood: stay in it; 유비 keeps off its edge
    const wood = (x: number) => x >= 5;
    const edge = (x: number) => x === 5;
    expect(jpBanned(st, wood as never, edge as never, [6, 0], false, 4, 0)).toBe(true);
    expect(jpBanned(st, wood as never, edge as never, [3, 0], false, 4, 0)).toBe(false);
    expect(jpBanned(st, wood as never, edge as never, [6, 0], false, 5, 0)).toBe(false);
    expect(jpBanned(st, wood as never, edge as never, [6, 0], true, 5, 0)).toBe(true);
    expect(jpBanned(st, wood as never, edge as never, [6, 0], true, 7, 0)).toBe(false);
    jpUpdate(st, 5, true);
    expect(st.phase).toBe('hold');
    jpUpdate(st, 12, false);
    expect(st.phase).toBe('off');
    expect(jpAnchor(st, 0, true)).toBeNull();
    expect(jpBanned(st, wood as never, edge as never, [6, 0], false, 4, 0)).toBe(false);
    expect(jpHoldFinish(st)).toBe(false);
  });
});

describe('grind: per-battle plan switches (plansOn)', () => {
  it('switches every per-battle plan on (at least its default) and leaves the rest alone', async () => {
    const { defaultParams, plansOn, PLAN_SWITCHES, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    for (const k of PLAN_SWITCHES) expect(PARAM_SPECS.find((s) => s.key === k)!.def).toBeGreaterThan(0.5);
    // 무릉: the evolve's wakeShut drifted to 0.46 (off); a switch learnt higher stays as it is
    const p = { ...d, wakeShut: 0.46, ypPlan: 0.97, yyGate: 0.1, kill: 1.7 };
    const o = plansOn(p);
    expect(o.wakeShut).toBe(d.wakeShut);
    expect(o.yyGate).toBe(d.yyGate);
    expect(o.ypPlan).toBe(0.97);
    expect(o.kill).toBe(1.7);
    expect(p.wakeShut).toBe(0.46);
    // 남양: the wakers (and the walk round them to 262 / 263) act only with wakeAvoid on
    expect(PLAN_SWITCHES).toContain('wakeAvoid');
    expect(plansOn({ ...d, wakeAvoid: 0.45 }).wakeAvoid).toBe(d.wakeAvoid);
    // a plan made before a switch existed reads its default
    const old = { ...d } as Record<string, number>;
    delete old.jpPlan;
    expect(plansOn(old as unknown as typeof d).jpPlan).toBe(d.jpPlan);
  });
});

describe('grind: rescue sortie (rescueSortie)', () => {
  it('fields the strongest and the duel actors, and leaves the rest alone', async () => {
    const { defaultParams, rescueSortie, PARAM_SPECS, pickFormation } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    const spec = (k: string) => PARAM_SPECS.find((s) => s.key === k)!;
    const p = { ...d, strong: 0, gainPick: 0.44, kill: 1.7 };
    const o = rescueSortie(p);
    expect(o.strong).toBe(spec('strong').max);
    expect(o.gainPick).toBeGreaterThan(0.5);
    expect(o.kill).toBe(1.7);
    expect(p.strong).toBe(0);
    // the strongest go out: with 6 free slots and strong at its max, the two lowest stay home
    const off = (level: number) => ({ dyn: { level, flags: 0x80 } });
    const state = { officers: [off(24), off(15), off(19), off(17), off(18), off(16), off(18), off(13), off(19)] } as never;
    expect(pickFormation(state, [0], 6, p.strong).sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(pickFormation(state, [0], 6, o.strong).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 8]);
  });
});
