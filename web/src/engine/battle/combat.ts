// Resolving attacks, tactics and departures: 1cb6:e91a / ec82 (combat), b2d6 (tactics), 8504
// (unit leaves). Display, messages and script events are left to the caller; the random draws
// are made in the original order (see docs/BATTLE.md, "Combat sequence").

import { Field, enemyAdjacent, neighbour, sideOf, terrainAt, unitAt, unitsInRange } from './hex';
import {
  ItemLookup,
  Rng,
  attackPower,
  combatExp,
  counterattacks,
  defencePower,
  gainExp,
  healAmounts,
  healKind,
  maxHp,
  moraleDrop,
  moraleLoss,
  mustLeave,
  physicalDamage,
  setMorale,
  tacticDamage,
  tacticSucceeds,
  tacticTerrainOk,
} from './rules';
import {
  AiMode,
  CLASS_ATTACK_TYPE,
  NONE,
  Officer,
  RAIN,
  Status,
  TACTIC_MP,
  TACTIC_POWER,
  UNIT_SLOTS,
  UnitFlag,
  WEATHER_TYPE,
} from './types';

export interface CombatState extends Field {
  rng: Rng;
  items: ItemLookup;
  weather: number;
  /** Close-up battle scenes enabled (DS:0x7a84 & 0xf0): archers then fire two volleys. */
  closeup: boolean;
  /** Officer ids (record +0) for the level-up exemption of generic officers. */
  officerIds?: number[];
}

export interface HitResult {
  attacker: number;
  defender: number;
  damage: number;
  moraleLoss: number;
  exp: number;
  counter: HitResult | null;
  left: number[]; // slots that must leave the field (call unitLeaves for each)
}

function officerOf(s: CombatState, slot: number): Officer {
  return s.officers[s.units[slot].officer];
}

function exp(s: CombatState, slot: number, gained: number): void {
  const u = s.units[slot];
  const o = s.officers[u.officer];
  const id = s.officerIds ? s.officerIds[u.officer] : u.officer;
  gainExp(o, id, o.exp + gained);
}

/**
 * One attack (1cb6:e91a -> df14, e26c, e2f4, e3c6, e42e, ec82).
 * kind 1 = physical (param = attack type, 7 = counterattack), 2 = tactic (param = element<<4 | power),
 * 3 = bomb item (same param, no caster bonus, cannot miss).
 */
export function fight(s: CombatState, a: number, d: number, kind: 1 | 2 | 3, param: number): HitResult {
  const A = s.units[a];
  const D = s.units[d];
  const oa = officerOf(s, a);
  const od = officerOf(s, d);
  const hp = od.hp;
  const morale = D.morale;
  const terrain = terrainAt(s, D.x, D.y);
  // e91a: the archer volley animation draws 4 x rand(16) per arrow before any damage roll.
  if (kind === 1 && param !== 7 && oa.cls >= 3 && oa.cls <= 5) {
    for (let v = s.closeup ? 2 : 1; v > 0; v--) for (let k = 0; k < 4; k++) s.rng.rand(16);
  }
  let damage: number;
  if (kind === 1) {
    damage = physicalDamage({
      attack: attackPower(oa, A.morale, s.items),
      defence: defencePower(od, D.morale, s.items),
      attackerClass: oa.cls,
      defenderClass: od.cls,
      defenderTerrain: terrain,
      defenderHp: hp,
      counter: param === 7,
    });
  } else {
    damage = tacticDamage(s.rng, {
      kind,
      element: param >> 4,
      power: param & 0xf,
      caster: oa,
      target: od,
      targetTerrain: terrain,
      weather: s.weather,
      targetHp: hp,
    });
  }
  const loss = moraleLoss(kind, damage, hp, od.level, morale);
  const gained = combatExp(sideOf(a), oa.level, od.level, damage === hp, d);
  if (!(A.flags & UnitFlag.Visible)) A.flags |= UnitFlag.Visible; // e3c6: the ambush is sprung
  let counter = counterattacks(s.rng, kind, od, param, damage, hp);
  // ec82
  od.hp = Math.min(hp - damage, maxHp(od));
  if (damage !== hp) setMorale(s.rng, D, od.lead, morale - loss);
  exp(s, a, gained);
  if (od.hp === 0 || D.flags & UnitFlag.Confused) counter = false;
  const res: HitResult = { attacker: a, defender: d, damage, moraleLoss: loss, exp: gained, counter: null, left: [] };
  if (counter && param !== 7) {
    res.counter = fight(s, d, a, 1, 7);
    res.left.push(...res.counter.left);
  } else if (mustLeave(od, D)) res.left.push(d);
  return res;
}

/** Physical attack of unit `a` on `d` with its class attack type (1cb6:cd4a / d862). */
export function attack(s: CombatState, a: number, d: number): HitResult {
  const r = fight(s, a, d, 1, CLASS_ATTACK_TYPE[officerOf(s, a).cls]);
  s.units[a].flags |= UnitFlag.Acted;
  return r;
}

/**
 * Unit leaves the field (1cb6:8504): status 4, square freed, mode-0 units chasing it switch to
 * "attack nearest". The caller then runs the defeat/retreat script events (0cf5:86b8, 842a,
 * 8494, 85e0); without a handler, 유비 (officer 0) leaving loses the battle.
 */
export function unitLeaves(s: Field, slot: number): void {
  const u = s.units[slot];
  if (u.status !== Status.Field) return;
  s.unitAt[u.y * s.width + u.x] = NONE;
  u.status = Status.Retreated;
  for (let i = 0; i < UNIT_SLOTS; i++) {
    const o = s.units[i];
    if (o.target === slot && o.mode === AiMode.MoveTo) {
      o.target = NONE;
      o.mode = AiMode.AttackNearest;
    }
  }
}

export interface CastResult {
  ok: boolean; // false: nothing happened, no MP spent, unit has not acted
  hits: HitResult[];
  confused: number[];
  healed: { slot: number; hp: number; morale: number }[];
  left: number[];
}

/**
 * Casts tactic t on `target` (1cb6:b2d6). For area heals (30..35) `target` is ignored. The caller
 * has already chosen the target the way 1cb6:657e does (the AI uses DS:0xe51c).
 */
export function castTactic(s: CombatState, caster: number, t: number, target: number): CastResult {
  const res: CastResult = { ok: false, hits: [], confused: [], healed: [], left: [] };
  const cu = s.units[caster];
  const oc = officerOf(s, caster);
  if (TACTIC_MP[t] > cu.mp) return res;
  const p = TACTIC_POWER[t];
  const leave = (slot: number) => {
    if (mustLeave(officerOf(s, slot), s.units[slot])) res.left.push(slot);
  };
  if (t <= 14) {
    const e = Math.trunc(t / 5);
    if (e === 0 && WEATHER_TYPE[s.weather] === RAIN) return res;
    if (target === NONE) return res;
    const tu = s.units[target];
    if (!tacticTerrainOk(e, terrainAt(s, tu.x, tu.y))) return res;
    const param = (e << 4) | p;
    const h = fight(s, caster, target, 2, param);
    res.hits.push(h);
    res.left.push(...h.left);
    if (t % 5 >= 3) {
      for (let d = 0; d < 4; d++) {
        const n = neighbour(s, tu.x, tu.y, d);
        if (!n || !tacticTerrainOk(e, terrainAt(s, n[0], n[1]))) continue;
        const v = unitAt(s, n[0], n[1]);
        if (v === NONE || sideOf(v) === sideOf(caster)) continue;
        const h2 = fight(s, caster, v, 2, param);
        res.hits.push(h2);
        res.left.push(...h2.left);
      }
    }
    res.ok = true;
  } else if (t <= 17) {
    if (target === NONE) return res;
    const tryConfuse = (slot: number) => {
      if (tacticSucceeds(s.rng, oc, officerOf(s, slot), 2)) {
        s.units[slot].flags |= UnitFlag.Confused;
        res.confused.push(slot);
        leave(slot);
      }
    };
    tryConfuse(target);
    if (t === 17) {
      const tu = s.units[target];
      for (let d = 0; d < 4; d++) {
        const n = neighbour(s, tu.x, tu.y, d);
        if (!n) continue;
        const v = unitAt(s, n[0], n[1]);
        if (v !== NONE && sideOf(v) !== sideOf(caster)) tryConfuse(v);
      }
    }
    res.ok = true;
  } else if (t <= 20) {
    if (target === NONE) return res;
    res.ok = true;
    const tu = s.units[target];
    const ot = officerOf(s, target);
    if (tacticSucceeds(s.rng, oc, ot, 4)) {
      const drop = moraleDrop(oc, ot, p, tu.morale);
      setMorale(s.rng, tu, ot.lead, tu.morale - drop);
      leave(target);
    }
  } else if (t <= 29) {
    if (target === NONE) return res;
    const kind = healKind(t);
    const tu = s.units[target];
    const ot = officerOf(s, target);
    if (!healUseful(kind, ot, tu.morale, (tu.flags & UnitFlag.Confused) !== 0)) return res;
    applyHeal(s, target, p, kind, oc, res);
    res.ok = true;
  } else if (t <= 35) {
    const sub = (t - 30) % 3;
    const kind = healKind(t);
    const list = unitsInRange(s, cu, sub | 0x80, cu.x, cu.y, true);
    if (list.length === 0) return res;
    for (const v of list) applyHeal(s, v, sub, kind, oc, res);
    res.ok = true;
  }
  if (res.ok) {
    if (t >= 15) {
      const bonus = t >= 21 && t <= 29 && (oc.cls === 12 || oc.cls === 18) ? 12 : 8;
      exp(s, caster, bonus);
    }
    cu.mp -= TACTIC_MP[t];
    cu.flags |= UnitFlag.Acted;
  }
  return res;
}

/** Whether a heal of `kind` would do anything (1cb6:a200). */
export function healUseful(kind: number, o: Officer, morale: number, confused: boolean): boolean {
  const full = maxHp(o) === o.hp;
  if (kind === 1 && full) return false;
  if (kind === 2 && morale === 100 && !confused) return false;
  if (kind === 3 && full && morale === 100 && !confused) return false;
  return true;
}

function applyHeal(s: CombatState, slot: number, power: number, kind: number, caster: Officer | null, res: CastResult) {
  const u = s.units[slot];
  if (u.status !== Status.Field) return;
  const o = officerOf(s, slot);
  const h = healAmounts(s.rng, power, kind, caster, o, u.morale);
  if (kind & 1) o.hp = Math.min(o.hp + h.hp, maxHp(o));
  if (kind & 2) setMorale(s.rng, u, o.lead, u.morale + h.morale);
  res.healed.push({ slot, hp: h.hp, morale: h.morale });
}

/** True if the unit may not move into its ZOC-blocked neighbours — exposed for the player UI. */
export function inEnemyZoc(s: Field, slot: number): boolean {
  const u = s.units[slot];
  return enemyAdjacent(s, sideOf(slot), u.x, u.y);
}
