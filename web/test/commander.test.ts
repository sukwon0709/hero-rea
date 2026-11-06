import { describe, expect, it } from 'vitest';
import {
  decide,
  DEFAULT_STRATEGY,
  describeStrategy,
  orderFile,
  parseState,
  resolveStrategy,
  sanitizeStrategy,
  STATE_SIZE,
} from '../src/commander';
import { maxHp } from '../src/engine/battle/rules';

// A synthetic AISTATE.BIN: sequence byte, then DGROUP:0000..fff0.
function dump(units: { slot: number; officer: number; x: number; y: number; troops: number; morale?: number }[], mask: number) {
  const file = new Uint8Array(STATE_SIZE);
  file[0] = 5;
  const ds = file.subarray(1);
  ds[0xe194] = 20; // width
  ds[0xe195] = 20; // height
  ds[0xe196] = 3; // map
  ds[0xe198] = 1; // turn
  ds[0x3ad5] = mask & 0xff;
  ds[0x3ad6] = mask >> 8;
  for (const u of units) {
    const r = 0xe2a2 + u.slot * 14;
    ds[r] = u.officer;
    ds[r + 3] = u.x;
    ds[r + 4] = u.y;
    ds[r + 5] = 0xff;
    ds[r + 9] = 2;
    ds[r + 0xb] = 1;
    ds[r + 0xc] = u.morale ?? 100;
    const o = 0x7a94 + u.officer * 0x2c;
    ds.set(NAMES[u.officer] ?? [0xc0, 0xaf, 0xba, 0xf1], o + 6); // 유비 unless named below
    ds[o + 0x1e] = u.troops & 0xff;
    ds[o + 0x1f] = u.troops >> 8;
    ds[o + 0x20] = 0; // class 0
    ds[o + 0x21] = 1; // level 1
  }
  return file;
}

// EUC-KR names for officers 1..3 (유비, 관우, 장비)
const NAMES: Record<number, number[]> = {
  1: [0xc0, 0xaf, 0xba, 0xf1],
  2: [0xb0, 0xfc, 0xbf, 0xec],
  3: [0xc0, 0xe5, 0xba, 0xf1],
};

const full = maxHp({ cls: 0, level: 1 } as Parameters<typeof maxHp>[0]);

describe('commander AI', () => {
  it('reads the units the mask gives it', () => {
    const s = parseState(
      dump(
        [
          { slot: 0, officer: 1, x: 2, y: 2, troops: full },
          { slot: 1, officer: 2, x: 3, y: 2, troops: full }, // ally, not in the mask
          { slot: 15, officer: 3, x: 9, y: 2, troops: full },
        ],
        0b1,
      ),
    )!;
    expect(s.seq).toBe(5);
    expect(s.turn).toBe(1);
    expect(s.ours.map((u) => u.slot)).toEqual([0]);
    expect(s.ours[0].name).toBe('유비');
    expect(s.enemies.map((u) => u.slot)).toEqual([15]);
    expect(parseState(new Uint8Array(10))).toBeNull();
  });

  it('focuses the enemy commander and sends weak units to a village', () => {
    const terrain = new Uint8Array(400);
    terrain[2 * 20 + 0] = 8; // village at (0,2)
    const s = parseState(
      dump(
        [
          { slot: 1, officer: 1, x: 4, y: 2, troops: full },
          { slot: 2, officer: 2, x: 4, y: 3, troops: Math.floor(full / 4) },
          { slot: 15, officer: 3, x: 9, y: 2, troops: full },
          { slot: 16, officer: 4, x: 6, y: 6, troops: 10 },
        ],
        0b110,
      ),
    )!;
    const orders = decide(s, terrain);
    const by = new Map(orders.map((o) => [o.slot, o]));
    expect(by.get(1)).toMatchObject({ mode: 0, target: 15 });
    expect(by.get(2)).toMatchObject({ mode: 4, target: 0xff, tx: 0, ty: 2 });

    const file = orderFile(s, orders);
    expect(file[0]).toBe(5);
    expect(file.length).toBe(1 + 15 * 14);
    expect(file[1 + 1 * 14 + 0xb]).toBe(0);
    expect(file[1 + 1 * 14 + 5]).toBe(15);
    expect(file[1 + 2 * 14 + 0xb]).toBe(4);
    expect(file[1 + 2 * 14 + 6]).toBe(0);
  });

  it('chases the weakest nearby enemy when the commander is far', () => {
    const s = parseState(
      dump(
        [
          { slot: 0, officer: 1, x: 2, y: 2, troops: full },
          { slot: 15, officer: 3, x: 19, y: 19, troops: full },
          { slot: 16, officer: 4, x: 5, y: 2, troops: full },
          { slot: 17, officer: 5, x: 3, y: 5, troops: 20 },
        ],
        0b1,
      ),
    )!;
    expect(decide(s, null)).toMatchObject([{ slot: 0, mode: 0, target: 17 }]);
  });
});

describe('commander strategy', () => {
  it('cleans untrusted settings', () => {
    expect(sanitizeStrategy(null)).toEqual(DEFAULT_STRATEGY);
    const st = sanitizeStrategy({
      summary: ' 돌격 ',
      focus: 'everyone',
      chaseRange: 99,
      retreatAt: -1,
      leaderRetreatAt: 0.5,
      units: [{ name: '관우', role: 'charge', retreatAt: -1 }, { name: '', role: 'hold' }, { name: '장비', role: 'fly', retreatAt: 2 }],
    });
    expect(st).toEqual({
      summary: '돌격',
      focus: 'commander',
      chaseRange: 40,
      retreatAt: 0,
      leaderRetreatAt: 0.5,
      units: [
        { name: '관우', role: 'charge', retreatAt: null },
        { name: '장비', role: 'free', retreatAt: 1 },
      ],
      rules: [],
      ignored: [],
    });
  });

  it('cleans situation rules', () => {
    const st = sanitizeStrategy({
      rules: [
        { note: '적 대장 약하면 돌격', when: [{ kind: 'enemyCommanderBelow', value: 0.5, name: '' }, { kind: 'bogus' }], focus: 'keep', chaseRange: -1, retreatAt: 0, leaderRetreatAt: -1, allRole: 'charge', units: [] },
        { note: '조건 없음', when: [], allRole: 'hold' },
      ],
      ignored: ['책략 사용', 3, ''],
    });
    expect(st.rules).toEqual([
      { note: '적 대장 약하면 돌격', when: [{ kind: 'enemyCommanderBelow', value: 0.5, name: '' }], focus: null, chaseRange: null, retreatAt: 0, leaderRetreatAt: null, allRole: 'charge', units: [] },
    ]);
    expect(st.ignored).toEqual(['책략 사용']);
  });

  it('gives officers their roles', () => {
    const s = parseState(
      dump(
        [
          { slot: 0, officer: 1, x: 2, y: 2, troops: Math.floor(full / 2) },
          { slot: 1, officer: 2, x: 2, y: 8, troops: full },
          { slot: 2, officer: 3, x: 3, y: 3, troops: Math.floor(full / 5) },
          { slot: 15, officer: 4, x: 19, y: 19, troops: full },
        ],
        0b111,
      ),
    )!;
    s.leader = 0;
    const st = sanitizeStrategy({
      focus: 'nearest',
      retreatAt: 0.4,
      leaderRetreatAt: 0,
      units: [
        { name: '관우', role: 'guard', retreatAt: -1 },
        { name: '장비', role: 'charge', retreatAt: 0 },
      ],
    });
    const by = new Map(decide(s, null, st).map((o) => [o.slot, o]));
    expect(by.get(0)).toMatchObject({ mode: 1 }); // 유비 never retreats here; no focus -> nearest
    expect(by.get(1)).toMatchObject({ mode: 0, target: 0xff, tx: 2, ty: 2 }); // 관우 goes to 유비
    expect(by.get(2)).toMatchObject({ mode: 0, target: 15 }); // 장비 charges the commander although weak
  });

  it('changes the settings while a rule holds', () => {
    const units = (cmdTroops: number) =>
      parseState(
        dump(
          [
            { slot: 0, officer: 1, x: 2, y: 2, troops: full },
            { slot: 1, officer: 2, x: 2, y: 3, troops: Math.floor(full / 5) },
            { slot: 15, officer: 3, x: 19, y: 19, troops: cmdTroops },
            { slot: 16, officer: 4, x: 4, y: 2, troops: full },
          ],
          0b11,
        ),
      )!;
    const st = sanitizeStrategy({
      focus: 'nearest',
      rules: [
        {
          note: '적 대장이 약하면 총공격',
          when: [{ kind: 'enemyCommanderBelow', value: 0.5 }, { kind: 'turnAtLeast', value: 2 }],
          allRole: 'charge',
          retreatAt: 0,
          units: [{ name: '유비', role: 'hold', retreatAt: -1 }],
        },
      ],
    });
    // Commander healthy: no rule; 관우 is weak and retreats, 유비 attacks the nearest enemy.
    const calm = units(full);
    expect(resolveStrategy(calm, st).active).toEqual([]);
    const a = new Map(decide(calm, null, st).map((o) => [o.slot, o]));
    expect(a.get(0)).toMatchObject({ mode: 1 });
    expect(a.get(1)).toMatchObject({ mode: 2 });
    // Commander below half on turn 2 (dump sets turn index 1): 관우 charges it, 유비 holds.
    const weak = units(Math.floor(full / 3));
    expect(resolveStrategy(weak, st).active.map((r) => r.note)).toEqual(['적 대장이 약하면 총공격']);
    const b = new Map(decide(weak, null, st).map((o) => [o.slot, o]));
    expect(b.get(1)).toMatchObject({ mode: 0, target: 15 });
    expect(b.get(0)).toMatchObject({ mode: 3 });
    // The turn condition fails on turn 1.
    const early = sanitizeStrategy({ ...st, rules: [{ ...st.rules[0], when: [{ kind: 'turnAtLeast', value: 3 }] }] });
    expect(resolveStrategy(weak, early).active).toEqual([]);
  });

  it('describes the strategy in Korean', () => {
    const lines = describeStrategy(
      sanitizeStrategy({
        units: [{ name: '관우', role: 'charge', retreatAt: 0 }],
        rules: [{ note: '', when: [{ kind: 'unitGone', name: '관우' }], allRole: 'keep', focus: 'keep', units: [{ name: '장비', role: 'guard', retreatAt: -1 }] }],
        ignored: ['책략은 쓸 수 없음'],
      }),
    );
    expect(lines).toContain('  관우: 돌격, 후퇴 안 함');
    expect(lines).toContain('  1. 관우 퇴각 → 장비: 유비 호위');
    expect(lines).toContain('  - 책략은 쓸 수 없음');
  });
});
