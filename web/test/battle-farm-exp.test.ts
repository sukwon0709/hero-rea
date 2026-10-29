// The exp rules the grinding sim's farm phase relies on (1cb6:b2d6 tactics, e2f4 hit exp, 7cc8
// band): no game files needed, a tiny hand-made field.
import { describe, expect, it } from 'vitest';
import { castTactic, type CombatState } from '../src/engine/battle/combat';
import { Rng, maxHp, regenerate } from '../src/engine/battle/rules';
import { NONE, Status, UNIT_SLOTS, newUnit, type Officer } from '../src/engine/battle/types';

const officer = (cls: number, level: number, intel = 60): Officer => ({ lead: 60, force: 60, intel, hp: 0, cls, level, exp: 0, items: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] });

/** A 6x1 strip: our caster (slot 0) at x=0, our ally (slot 1) at x=1, an enemy (slot 15) at x=2. */
function field(casterCls: number, seed = 1): CombatState {
  const W = 6;
  const officers = [officer(casterCls, 10), officer(6, 10), officer(0, 30, 200)];
  for (const o of officers) o.hp = maxHp(o);
  const units = Array.from({ length: UNIT_SLOTS }, (_, i) => newUnit(i));
  const place = (slot: number, off: number, x: number) => {
    Object.assign(units[slot], { officer: off, x, y: 0, status: Status.Field, mp: 40 });
  };
  place(0, 0, 0);
  place(1, 1, 1);
  place(15, 2, 2);
  const unitAt = new Uint8Array(W).fill(NONE);
  unitAt[0] = 0;
  unitAt[1] = 1;
  unitAt[2] = 15;
  return { width: W, height: 1, terrain: new Uint8Array(W), unitAt, units, officers, rng: new Rng(seed), items: () => undefined, weather: 2, closeup: false };
}

const exp = (s: CombatState) => s.officers[0].level * 100 + s.officers[0].exp;

describe('flat-rate tactic exp (1cb6:b2d6)', () => {
  it('a heal on a full-troop ally is refused: no MP spent, no exp', () => {
    const s = field(18);
    const before = exp(s);
    const r = castTactic(s, 0, 24, 1);
    expect(r.ok).toBe(false);
    expect(s.units[0].mp).toBe(40);
    expect(exp(s)).toBe(before);
  });

  it('a heal on a hurt ally pays 12 to classes 12/18, 8 to others, whatever the level gap', () => {
    for (const [cls, gain] of [[18, 12], [12, 12], [6, 8]] as const) {
      const s = field(cls);
      s.officers[1].hp -= 300;
      s.units[1].morale = 50;
      const before = exp(s);
      const t = cls === 18 ? 24 : 21; // 소보급 (troops) / 격려 (morale)
      expect(castTactic(s, 0, t, 1).ok).toBe(true);
      expect(exp(s) - before).toBe(gain);
    }
  });

  it('a morale tactic on a far stronger enemy pays 8 whether it lands or not', () => {
    let landed = 0, missed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = field(6, seed);
      const m = s.units[15].morale;
      const before = exp(s);
      expect(castTactic(s, 0, 18, 15).ok).toBe(true);
      expect(exp(s) - before).toBe(8);
      if (s.units[15].morale < m) landed++;
      else missed++;
    }
    expect(missed).toBeGreaterThan(0);
    expect(landed + missed).toBe(40);
  });
});

describe('군악대 MP (1cb6:7cc8)', () => {
  it('a band unit gives level/10+1 MP to each neighbour; other classes give none', () => {
    const band = officer(12, 15);
    band.hp = maxHp(band);
    expect(regenerate(new Rng(1), band, 100, true, 0, band.level).bandMp).toBe(2);
    expect(regenerate(new Rng(1), band, 100, true, 0).bandMp).toBe(0);
  });
});
