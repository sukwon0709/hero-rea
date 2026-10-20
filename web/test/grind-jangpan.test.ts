// 장판파 2nd plan (jangpan.ts, GrindParams.jpPlan): while a 민중 walks to the exit, 유비 holds the
// south-east wood's far corner and the others close round him; the plan's parameter is appended last.
import { describe, expect, it } from 'vitest';

describe('grind: 장판파 2nd plan (jpPlan)', () => {
  it('jpPlan is appended last, on by default, learnable within bounds; plans made before it read the default', async () => {
    const { defaultParams, paramOr, clampParams, PARAM_SPECS } = await import('../src/sim/grind/policy');
    const d = defaultParams();
    expect(PARAM_SPECS[PARAM_SPECS.length - 1].key).toBe('jpPlan');
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
