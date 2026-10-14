// Battle formulas of MAIN.EXE, reproduced with the original integer arithmetic and the same
// order of random-number draws (see docs/BATTLE.md, "Rules"). Every function names the
// routine it mirrors.

import {
  CLASS_ATTACK,
  CLASS_DEFENCE,
  CLASS_HP_BASE,
  CLASS_HP_GROWTH,
  CLASS_MOVE,
  CLASS_ATTACK_TYPE,
  ItemInfo,
  Officer,
  RAIN,
  TACTIC_COUNT,
  TACTIC_MP,
  TACTIC_POWER,
  TACTIC_TERRAIN,
  terrainDefence,
  TERRAIN_FOREST,
  WEATHER_TYPE,
  CLASS_COUNT,
  resistsTactics,
} from './types';

export type ItemLookup = (id: number) => ItemInfo | undefined;

const u16 = (v: number) => v & 0xffff;
const tdiv = (a: number, b: number) => Math.trunc(a / b);

// ---- random numbers (0cf5:4884, 0cf5:48c4) ----

/** The C runtime LCG: seed = seed*0x41C64E6D + 0x3039, result (seed >> 16) & 0x7fff. Seed is DS:0xcc8. */
export class Rng {
  seed: number;
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }
  next(): number {
    this.seed = (Math.imul(this.seed, 0x41c64e6d) + 0x3039) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }
  /** rand(n) = next() % n, and 0 without drawing when n == 0 (0cf5:48c4 tests n first). */
  rand(n: number): number {
    n &= 0xffff;
    if (n === 0) return 0;
    return this.next() % n;
  }
}

// ---- officer-derived values ----

/** Maximum troops (0cf5:73b8): (10*base + growth*(level-1)) * 10. */
export function maxHp(o: Officer): number {
  return u16((10 * CLASS_HP_BASE[o.cls] + CLASS_HP_GROWTH[o.cls] * (o.level - 1)) * 10);
}

/**
 * Maximum tactic points (1cb6:9184): intel*(level+10)*5/200, set to 255 only when above 256 —
 * exactly 256 is returned as is and becomes 0 when stored in the u8 MP field (1cb6:a07a).
 */
export function maxMp(o: Officer): number {
  const v = tdiv(u16(o.intel * u16((o.level + 10) * 5)), 200);
  return v > 0x100 ? 0xff : v;
}

function bestItem(o: Officer, items: ItemLookup, type: number): number {
  let best = 0;
  for (const id of o.items) {
    if (id === 0xff) continue;
    const it = items(id);
    if (it && it.type === type && it.value > best) best = it.value;
  }
  return best;
}

function power(stat: number, base: number, morale: number, level: number, bonus: number): number {
  let a = tdiv(4000, 140 - stat);
  a = tdiv((a + 2 * base + morale) * (level + 10), 10);
  a += tdiv(bonus * a, 100);
  return u16(Math.max(a, 1));
}

/** Attack strength (0cf5:6aee, called through 1cb6:7c90 with the unit's morale). */
export function attackPower(o: Officer, morale: number, items: ItemLookup): number {
  return power(o.force, CLASS_ATTACK[o.cls], morale, o.level, bestItem(o, items, 0));
}

/** Defence strength (0cf5:6c1c via 1cb6:7cac): same shape with lead, class defence and armour. */
export function defencePower(o: Officer, morale: number, items: ItemLookup): number {
  return power(o.lead, CLASS_DEFENCE[o.cls], morale, o.level, bestItem(o, items, 5));
}

/** Movement points (1cb6:7c1e): class move + the best type-4 item value. Script units use 100. */
export function movePoints(o: Officer, items: ItemLookup): number {
  return (CLASS_MOVE[o.cls] + bestItem(o, items, 4)) & 0xff;
}

/** Class group for the attack triangle: class/3 (0 foot, 1 archers, 2 horse, 3.. none). */
export function classGroup(cls: number): number {
  return Math.trunc(cls / 3);
}

function beats(a: number, b: number): boolean {
  return (a === 0 && b === 1) || (a === 1 && b === 2) || (a === 2 && b === 0);
}

// ---- damage (1cb6:df14) ----

export interface PhysicalHit {
  attack: number; // attacker attackPower
  defence: number; // defender defencePower
  attackerClass: number;
  defenderClass: number;
  defenderTerrain: number;
  defenderHp: number;
  counter: boolean; // attack type 7 (counterattack): half damage
}

/** Physical damage, kind 1 (1cb6:df14). Never random. */
export function physicalDamage(h: PhysicalHit): number {
  const ga = classGroup(h.attackerClass);
  const gd = classGroup(h.defenderClass);
  let def = h.defence;
  if (beats(ga, gd)) def -= tdiv(def, 4);
  if (beats(gd, ga)) def += tdiv(def, 4);
  const half = tdiv(def, 2);
  let dmg = h.attack > half ? h.attack - half : 0;
  dmg = tdiv(dmg * (100 - terrainDefence(h.defenderTerrain)), 100);
  if (h.counter) dmg = tdiv(dmg, 2);
  if (dmg <= 0) dmg = 1;
  return Math.min(dmg, h.defenderHp);
}

/** Tactic strength term used by 1cb6:df14 / a2aa: intel + level*intel/100 (byte multiply). */
export function tacticSkill(o: Officer): number {
  return o.intel + tdiv(u16(o.level * o.intel), 100);
}

export interface TacticHit {
  kind: 2 | 3; // 2 = cast by an officer (can fail, caster bonus), 3 = bomb item
  element: number; // 0 fire, 1 water, 2 rock
  power: number; // TACTIC_POWER (0..2)
  caster: Officer;
  target: Officer;
  targetTerrain: number;
  weather: number; // battle state +4
  targetHp: number;
}

/**
 * Tactic damage (1cb6:df14, kinds 2 and 3). Draws rand(skill) first, then rand(dmg/50).
 * The u16 wrap of a negative base is reproduced.
 */
export function tacticDamage(rng: Rng, h: TacticHit): number {
  const c = h.caster;
  const t = h.target;
  const pc = tacticSkill(c);
  let pt = tacticSkill(t) >> 2;
  const base = (h.power * 4 + h.element + 2) * 100;
  const bonus = h.kind === 2 ? (tdiv(u16(c.level * c.intel), 50) + c.intel) * 2 : 0;
  let dmg = u16(bonus - tdiv(u16(t.level * t.intel), 50) - t.intel + base);
  const roll = rng.rand(pc) & 0xff;
  if (resistsTactics(t.cls)) {
    pt <<= 1;
    dmg = tdiv(dmg, 2);
  }
  if ((h.element === 0 && h.targetTerrain === TERRAIN_FOREST) || (h.element === 1 && WEATHER_TYPE[h.weather] === RAIN))
    dmg += tdiv(dmg, 4);
  dmg += rng.rand(tdiv(dmg & 0xffff, 50)); // only the low word is divided
  if (h.kind === 2 && roll <= pt) return 0;
  return Math.min(dmg, h.targetHp);
}

/** Morale lost by the defender (1cb6:e26c). Killed: all of it. */
export function moraleLoss(kind: number, dmg: number, defenderHp: number, defenderLevel: number, morale: number): number {
  if (dmg === defenderHp) return morale;
  let loss = 0;
  if (kind === 1) loss = tdiv(tdiv(dmg, defenderLevel + 5), 3);
  else if (kind === 2 || kind === 3) loss = tdiv(dmg, 100);
  if (loss === 0 && dmg !== 0) loss = 1;
  return Math.min(loss, morale);
}

/**
 * Experience for a hit (1cb6:e2f4); only player-side attackers earn it. Returns hit + kill
 * experience. `defenderSlot` 15 is the enemy commander.
 */
export function combatExp(attackerPlayer: boolean, attackerLevel: number, defenderLevel: number, killed: boolean, defenderSlot: number): number {
  if (!attackerPlayer) return 0;
  let e = defenderLevel < attackerLevel ? 4 : (defenderLevel - attackerLevel + 3) * 2;
  if (e >= 16) e = 16;
  let k = 0;
  if (killed) {
    if (defenderSlot === 15) k = 48;
    else if (defenderLevel > attackerLevel) k = 32;
    else k = tdiv(64, attackerLevel - defenderLevel + 2);
  }
  return e + k;
}

/**
 * Counterattack decision (1cb6:e42e). Only physical hits on a class whose attack type is 0
 * (bandits, martial artists) roll rand(150) < force; the counter is dropped if the incoming
 * attack type is not 0, 2 or 5, or the defender died.
 */
export function counterattacks(rng: Rng, kind: number, defender: Officer, attackType: number, dmg: number, defenderHp: number): boolean {
  let c = false;
  if (kind === 1 && CLASS_ATTACK_TYPE[defender.cls] === 0) {
    const r = rng.rand(150);
    c = defender.force > r;
  }
  if (attackType !== 0 && attackType !== 2 && attackType !== 5) c = false;
  if (dmg === defenderHp) c = false;
  return c;
}

/**
 * Tactic success roll (1cb6:a2aa, AL=caster DL=target BL=divisor). The divisor is the whole BL
 * byte, so the AI's quiet probe with BL=0x82 divides by 130, not 2.
 */
export function tacticSucceeds(rng: Rng, caster: Officer, target: Officer, divisor: number): boolean {
  const pc = tacticSkill(caster);
  let pt = tdiv(tacticSkill(target), divisor & 0xff);
  const r = rng.rand(pc);
  if (resistsTactics(target.cls)) pt += pt;
  return r > pt;
}

/**
 * True if element `e` may target terrain `t` (1cb6:a392). The 0xff filler entries are compared
 * too, so water and rock tactics accept the stray terrain 255 cell of map 32.
 */
export function tacticTerrainOk(element: number, terrain: number): boolean {
  return TACTIC_TERRAIN[element].includes(terrain);
}

/** Tactics a unit can cast now: learned at or below its level and affordable (1cb6:c9bc with flag 4). */
export function castableTactics(o: Officer, mp: number, learn: Uint8Array): number[] {
  const out: number[] = [];
  for (let t = 0; t < TACTIC_COUNT; t++) {
    if (learn[t * CLASS_COUNT + o.cls] <= o.level && TACTIC_MP[t] <= mp) out.push(t);
  }
  return out;
}

/** Tactics announced when an officer reaches `level` (0cf5:6f64). */
export function tacticsLearnedAt(cls: number, level: number, learn: Uint8Array): number[] {
  const out: number[] = [];
  for (let t = 0; t < 30; t++) if (learn[t * CLASS_COUNT + cls] === level) out.push(t);
  return out;
}

/** Heal kind of tactic t (21..35): 1 troops, 2 morale, 3 both (1cb6:b2d6 / baf6). */
export function healKind(t: number): number {
  if (t >= 30) return t > 32 ? 1 : 2;
  return t >= 27 ? 3 : t >= 24 ? 1 : 2;
}

export interface HealResult {
  hp: number; // troops added
  morale: number; // morale added
}

/**
 * Heal amounts (1cb6:b8c0): troops (power+1)*600 [+ level*intel/20 with a caster] + rand(x/10),
 * capped at the missing troops; morale (power+3)*10 [+ level/10] + rand(x/10), capped at 100-morale.
 * `caster` is null for items. Troops are drawn first.
 */
export function healAmounts(
  rng: Rng,
  power: number,
  kind: number,
  caster: Officer | null,
  target: Officer,
  targetMorale: number,
): HealResult {
  const res = { hp: 0, morale: 0 };
  if (kind & 1) {
    let h = (power + 1) * 600;
    if (caster) h += tdiv(u16(caster.level * caster.intel), 20);
    h += rng.rand(tdiv(u16(h), 10));
    res.hp = Math.max(0, Math.min(h, maxHp(target) - target.hp));
  }
  if (kind & 2) {
    let m = (power + 3) * 10;
    if (caster) m += tdiv(caster.level, 10);
    m += rng.rand(tdiv(m, 10));
    res.morale = Math.min(100 - targetMorale, m & 0xff);
  }
  return res;
}

/** Morale drop of tactics 18..20 on success (1cb6:b2d6): level/10 + (power+2)*10 - targetLevel/10, capped. */
export function moraleDrop(caster: Officer, target: Officer, power: number, targetMorale: number): number {
  const v = u16(tdiv(caster.level, 10) + (power + 2) * 10 - tdiv(target.level, 10));
  return Math.min(v, targetMorale);
}

// ---- morale and confusion (1cb6:898c, 8130) ----

export interface MoraleUnit {
  morale: number;
  flags: number;
  status: number;
}

/**
 * Sets morale like 1cb6:898c: clamps to 0..100; on a drop to below 30 (a negative request does
 * not count, the compare is unsigned) rand(5) < 3 confuses; a rise (or a set to 100 that does not
 * lower it) tries to cure confusion with rand(100) < (lead+morale)/3 — only if confused and on
 * the field. Returns 'confused', 'cured' or null.
 */
export function setMorale(rng: Rng, u: MoraleUnit, lead: number, value: number): 'confused' | 'cured' | null {
  const old = u.morale;
  u.morale = value < 0 ? 0 : value > 100 ? 100 : value;
  if (old > value) {
    if (value >= 0 && value < 30 && rng.rand(5) < 3) {
      u.flags |= 0x02;
      return 'confused';
    }
    return null;
  }
  if (old < value || value === 100) return tryCure(rng, u, lead) ? 'cured' : null;
  return null;
}

/** Confusion recovery roll (1cb6:8130). */
export function tryCure(rng: Rng, u: MoraleUnit, lead: number): boolean {
  const chance = tdiv(lead + u.morale, 3);
  if (!(u.flags & 0x02) || u.status !== 2) return false;
  if (rng.rand(100) < chance) {
    u.flags &= ~0x02;
    return true;
  }
  return false;
}

/** A unit leaves the field when it has no troops, or is confused with no morale (1cb6:a0d0). */
export function mustLeave(o: Officer, u: MoraleUnit): boolean {
  return o.hp === 0 || ((u.flags & 0x02) !== 0 && u.morale === 0);
}

// ---- start-of-turn recovery (1cb6:7cc8) ----

export interface RegenResult {
  hp: number; // new troops
  morale: number | null; // requested morale (feed to setMorale), null if unchanged
  bandMp: number; // MP a 군악대 gives each neighbour (0 for other classes)
}

/**
 * Start-of-turn recovery (1cb6:7cc8). The two draws, rand(11) then rand(5), happen for every
 * unit passed in, even ones not on the field. Village/fortress (8, 13) heal troops and morale,
 * barracks (14) troops; items 0x38 troops, 0x37 morale, 8 both.
 */
export function regenerate(rng: Rng, o: Officer, morale: number, onField: boolean, terrain: number, cls12Level?: number): RegenResult {
  let heal = (rng.rand(11) + 15) * 10;
  let gain = tdiv(o.lead, 10) + rng.rand(5) + 1;
  const res: RegenResult = { hp: o.hp, morale: null, bandMp: 0 };
  if (!onField) return res;
  const max = maxHp(o);
  if (max > heal + o.hp && heal + o.hp + 10 > max) heal = max - o.hp;
  if (morale + gain < 100 && morale + gain + 10 > 100) gain = 100 - morale;
  let what = terrain === 8 || terrain === 13 ? 3 : terrain === 14 ? 1 : 0;
  for (const id of o.items) {
    if (id === 0x37) what |= 2;
    else if (id === 0x38) what |= 1;
    else if (id === 8) what |= 3;
  }
  if (what & 1) res.hp = Math.min(o.hp + heal, max);
  if (what & 2) res.morale = morale + gain;
  if (cls12Level !== undefined) res.bandMp = tdiv(cls12Level, 10) + 1;
  return res;
}

/**
 * Weather step at the start of each turn (1cb6:4cac): move one step toward rand(6); a result of
 * 0 is stored as 5 and a result of 5 as 0.
 */
export function nextWeather(rng: Rng, w: number): number {
  const r = rng.rand(6);
  if (w > r) w--;
  else if (w < r) w++;
  return w === 0 ? 5 : w === 5 ? 0 : w;
}

/**
 * Level-up (0cf5:6f64) given the new experience total (old exp + gain). Generic officers
 * ((id & 0xf1ff) in 0x100..0x15f) and officers at level 99+ keep everything. The level setter
 * (0cf5:7580) does not clamp, so several levels at once can pass 99.
 */
export function gainExp(o: Officer, id: number, total: number): { levels: number } {
  const k = id & 0xf1ff;
  if ((k >= 0x100 && k <= 0x15f) || o.level >= 99) return { levels: 0 };
  let levels = 0;
  if (total >= 100) {
    levels = tdiv(total, 100);
    total -= levels * 100;
    o.level = (o.level + levels) & 0xff;
  }
  o.exp = total & 0xff;
  return { levels };
}
