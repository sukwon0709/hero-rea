import { describe, expect, it } from 'vitest';
import { decide, orderFile, parseState, STATE_SIZE } from '../src/commander';
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
    ds.set([0xc0, 0xaf, 0xba, 0xf1], o + 6); // 유비
    ds[o + 0x1e] = u.troops & 0xff;
    ds[o + 0x1f] = u.troops >> 8;
    ds[o + 0x20] = 0; // class 0
    ds[o + 0x21] = 1; // level 1
  }
  return file;
}

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
