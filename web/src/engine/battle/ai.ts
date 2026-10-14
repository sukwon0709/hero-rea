// Computer-controlled units (enemy phase, and player units left on automatic).
// A literal port of 1cb6:ce50 and its helpers — see docs/BATTLE.md, "AI", for the pseudocode
// with addresses. Evaluation draws random numbers (tactic/heal estimates, confusion probes), so
// the draw order here matters for staying in step with the original.

import {
  BFS_EVALUATE,
  BFS_FIND_FOE,
  BFS_REACH,
  Field,
  Pos,
  floodMove,
  pickTarget,
  sideOf,
  terrainAt,
  unitAt,
  unitsInRange,
  walkPath,
  rebuildUnitMap,
} from './hex';
import { CastResult, CombatState, HitResult, attack, castTactic } from './combat';
import {
  ItemLookup,
  Rng,
  attackPower,
  castableTactics,
  classGroup,
  defencePower,
  maxHp,
  movePoints,
  tacticSucceeds,
  tacticTerrainOk,
} from './rules';
import {
  AiMode,
  CLASS_RANGE,
  NONE,
  PLAYER_SLOTS,
  RAIN,
  Status,
  TACTIC_POWER,
  terrainDefence,
  TERRAIN_FOREST,
  UNIT_SLOTS,
  Unit,
  UnitFlag,
  WEATHER_TYPE,
} from './types';

/** The AI's scratch variables (DS:0xe51c..0xe525) and work maps. */
export interface AiScratch {
  target: number; // e51c chosen target (attack or tactic)
  dest: Pos | null; // e51e chosen destination, null = 0xff
  tactic: number; // e520 chosen tactic or 0xff
  tacticPick: number; // e521 best tactic of the last d0fa call
  physPick: number; // e522 best physical target of the last c58e call (stale between calls!)
  tacticTarget: number; // e523 target of e521
  score: number; // e524 best cell value so far
}

export interface AiState extends Field {
  rng: Rng;
  items: ItemLookup;
  learn: Uint8Array; // loadLearnTable()
  weather: number; // battle state +4
  grid: Uint8Array; // map seg +0x18bc
  foeMap: Uint8Array; // map seg 0x6780 +0
  influence: Uint8Array; // map seg 0x6780 +0xf00
  castable: number[]; // 30b9:0064
  ai: AiScratch;
}

export function createAiState(f: Field, rng: Rng, items: ItemLookup, learn: Uint8Array, weather: number): AiState {
  const n = f.width * f.height;
  return {
    ...f,
    rng,
    items,
    learn,
    weather,
    grid: new Uint8Array(n).fill(NONE),
    foeMap: new Uint8Array(n).fill(NONE),
    influence: new Uint8Array(n),
    castable: [],
    ai: { target: NONE, dest: null, tactic: NONE, tacticPick: NONE, physPick: NONE, tacticTarget: NONE, score: 0 },
  };
}

const tdiv = (a: number, b: number) => Math.trunc(a / b);
const u16 = (v: number) => v & 0xffff;

function off(s: AiState, u: Unit) {
  return s.officers[u.officer];
}

function same(a: Pos | null, x: number, y: number): boolean {
  return a !== null && a[0] === x && a[1] === y;
}

/** Recovery terrain test (1cb6:bcf4). */
export function onRecoveryTerrain(s: Field, x: number, y: number): boolean {
  const t = terrainAt(s, x, y);
  return t === 8 || t === 13 || t === 14;
}

/** "Weak" unit: troops <= 2*(max/5) or morale < 40 (1cb6:c280). */
export function isWeak(s: Field, u: Unit): boolean {
  const o = s.officers[u.officer];
  if (!o) return false;
  return tdiv(maxHp(o), 5) * 2 >= o.hp || u.morale < 40;
}

/** Per-unit AI setup (1cb6:c2be): enemy reach map, influence map, scratch reset. */
export function aiPrepare(s: AiState, u: Unit): void {
  const rt = CLASS_RANGE[off(s, u).cls];
  s.foeMap.fill(NONE);
  for (let i = 0; i < UNIT_SLOTS; i++) {
    const e = s.units[i];
    if (sideOf(e.slot) === sideOf(u.slot) || e.status !== Status.Field) continue;
    unitsInRange(s, e, rt, e.x, e.y, false, s.foeMap); // marks the cells from which u reaches e
  }
  s.influence.fill(0);
  if (isWeak(s, u)) {
    for (let y = 0; y < s.height; y++)
      for (let x = 0; x < s.width; x++)
        if (onRecoveryTerrain(s, x, y)) s.influence[y * s.width + x] = (s.influence[y * s.width + x] + 50) & 0xff;
  }
  s.ai.score = 0;
  s.ai.target = NONE;
  s.ai.dest = null;
  s.ai.tactic = NONE;
}

/** Influence flood (1cb6:c4f2): add `v` to an empty passable cell still at 0, recurse with v-20. */
export function spreadInfluence(s: AiState, v: number, x: number, y: number): void {
  if (v <= 0) return;
  const i = y * s.width + x;
  if (terrainDefence(s.terrain[i]) !== 0xff && s.influence[i] === 0 && s.unitAt[i] === NONE)
    s.influence[i] = (s.influence[i] + v) & 0xff;
  for (let d = 0; d < 4; d++) {
    const nx = x + [0, 1, 0, -1][d];
    const ny = y + [-1, 0, 1, 0][d];
    if (nx >= 0 && ny >= 0 && nx < s.width && ny < s.height) spreadInfluence(s, v - 20, nx, ny);
  }
}

/** Physical attack score of `u` against slot `t` (1cb6:c616), u16 arithmetic. */
export function attackScore(s: AiState, u: Unit, t: number): number {
  if (t === NONE) return 0;
  const tu = s.units[t];
  if (sideOf(tu.slot) === sideOf(u.slot)) return 0;
  const ou = off(s, u);
  const ot = off(s, tu);
  const atk = attackPower(ou, u.morale, s.items);
  let def = defencePower(ot, tu.morale, s.items);
  const ga = classGroup(ou.cls);
  const gt = classGroup(ot.cls);
  if ((ga === 0 && gt === 1) || (ga === 1 && gt === 2) || (ga === 2 && gt === 0)) def = u16(def - (def >> 2));
  if ((gt === 0 && ga === 1) || (gt === 1 && ga === 2) || (gt === 2 && ga === 0)) def = u16(def + (def >> 2));
  let dmg = 1;
  if (def >> 1 < atk) dmg = tdiv((atk - (def >> 1)) * (100 - terrainDefence(terrainAt(s, tu.x, tu.y))), 100);
  let bonus = tdiv(ou.hp, 6);
  if (u.target === t) bonus += 30;
  return u16(bonus + dmg);
}

/** Best physical target from (x,y) (1cb6:c58e). Sets ai.physPick; returns the byte score. */
export function bestAttack(s: AiState, u: Unit, x: number, y: number): number {
  const rt = CLASS_RANGE[off(s, u).cls];
  let best = 0;
  s.ai.physPick = NONE;
  const list = unitsInRange(s, u, rt, x, y, false);
  for (const t of list) {
    let v = (attackScore(s, u, t) >> 4) & 0xff;
    if (v === 0) v = 1;
    if (v > best) {
      best = v;
      s.ai.physPick = t;
    }
  }
  return best;
}

/** Heal estimate (1cb6:d528); p = (power << 4) | kind (1 troops, 2 morale, 3 both). */
export function healScore(s: AiState, target: Unit, casterSlot: number, p: number): number {
  const ot = off(s, target);
  const oc = off(s, s.units[casterSlot]);
  const pw = p >> 4;
  if (target.status !== Status.Field) return 0;
  let hp = 0;
  let m = 0;
  if (p & 1) {
    hp = (pw + 1) * 600 + tdiv(u16(oc.intel * oc.level), 20);
    hp += s.rng.rand(tdiv(u16(hp), 10));
    hp = Math.min(hp, maxHp(ot) - ot.hp);
    if (tdiv(maxHp(ot), 10) > hp) hp = 0;
    if (hp !== 0) hp += (2 - pw) * 50;
  }
  if (p & 2) {
    m = (pw + 3) * 10 + tdiv(oc.level, 10);
    m += s.rng.rand(tdiv(u16(m), 10));
    m = Math.min(m, 100 - target.morale);
    if (m < 10) m = 0;
    if (m !== 0) m += (2 - pw) * 5;
    if (target.morale < 40) m *= 20;
  }
  return u16(m + hp);
}

/** Estimated value of tactic t on slot `ts` (1cb6:d2c4). */
export function tacticScore(s: AiState, u: Unit, t: number, ts: number): number {
  const oc = off(s, u);
  const tu = s.units[ts];
  const ot = off(s, tu);
  const terr = terrainAt(s, tu.x, tu.y);
  const p = TACTIC_POWER[t];
  const rain = WEATHER_TYPE[s.weather] === RAIN;
  if (t <= 14) {
    const e = tdiv(t, 5);
    if (e === 0 && rain) return 0;
    if (!tacticTerrainOk(e, terr)) return 0;
    const pc = oc.intel + tdiv(u16(oc.level * oc.intel), 50);
    const pt = tdiv(u16(ot.level * ot.intel), 50);
    let v = u16(u16(((p + 1) * 4 + e) * 50 + pc) * 2 - pt - ot.intel);
    if ((e === 0 && terr === TERRAIN_FOREST) || (e === 1 && rain)) v = u16(v + (v >> 2));
    return u16(v + s.rng.rand(tdiv(v, 50)));
  }
  if (t <= 17) {
    if (tu.flags & UnitFlag.Confused) return 0;
    const v = tacticSucceeds(s.rng, oc, ot, 0x82) ? 300 : 0;
    return u16(v + s.rng.rand(300));
  }
  if (t <= 20) {
    let v = u16(tdiv(oc.level, 10) + (p + 2) * 10 - tdiv(ot.level, 10));
    v = Math.min(v, tu.morale);
    return u16((s.rng.rand(10) + 1) * v);
  }
  if (t <= 29) {
    const kind = t >= 27 ? 3 : t >= 24 ? 1 : 2;
    const full = maxHp(ot) === ot.hp;
    if (kind === 1 && full) return 0;
    if (kind === 2 && tu.morale === 100) return 0;
    if (kind === 3 && full && tu.morale === 100) return 0;
    return healScore(s, tu, u.slot, (p << 4) | kind);
  }
  return 0;
}

/** Best tactic from (x,y) (1cb6:d0fa). Sets ai.tacticPick/tacticTarget; returns the byte score. */
export function bestTactic(s: AiState, u: Unit, x: number, y: number): number {
  let best = 0;
  s.ai.tacticTarget = NONE;
  s.ai.tacticPick = NONE;
  for (const t of s.castable) {
    const p = TACTIC_POWER[t];
    if (p === 3) {
      const kind = t > 0x20 ? 1 : 2;
      const sub = (t - 30) % 3;
      let sum = 0;
      for (const a of unitsInRange(s, u, sub | 0x80, x, y, true)) sum = u16(sum + healScore(s, s.units[a], u.slot, (sub << 4) | kind));
      const v = Math.min(Math.max(sum - 100, 0) >> 4, 255);
      if (v > best) {
        best = v;
        s.ai.tacticTarget = NONE;
        s.ai.tacticPick = t;
      }
    } else {
      for (const ts of unitsInRange(s, u, p | 0x80, x, y, t >= 0x15)) {
        let v = Math.min(tacticScore(s, u, t, ts) >> 4, 255);
        if (v !== 0 && ts === u.target) v += 30;
        if (v > best) {
          best = v;
          s.ai.tacticTarget = ts;
          s.ai.tacticPick = t;
        }
      }
    }
  }
  return best;
}

/** Cell evaluation (1cb6:d6f8), called by the flood fill for every reachable cell. */
export function evaluateCell(s: AiState, u: Unit, x: number, y: number): void {
  const i = y * s.width + x;
  const own = x === u.x && y === u.y;
  if (s.unitAt[i] !== NONE && !own) return;
  let phys = 0;
  let tac = 0;
  if (!(u.flags & UnitFlag.Scripted)) {
    if (u.mode !== AiMode.MoveNoAttack) {
      if (s.foeMap[i] !== NONE || own) phys = bestAttack(s, u, x, y);
      tac = bestTactic(s, u, x, y);
      s.influence[i] = (s.influence[i] + Math.max(phys, tac)) & 0xff;
    }
    s.influence[i] += Math.min(tdiv(terrainDefence(s.terrain[i]), 5), 255 - s.influence[i]);
    if (own) s.influence[i] += Math.min(1, 255 - s.influence[i]);
  }
  if (s.influence[i] > s.ai.score) {
    if (tac > phys) {
      s.ai.tactic = s.ai.tacticPick;
      s.ai.target = s.ai.tacticTarget;
    } else {
      s.ai.tactic = NONE;
      s.ai.target = s.ai.physPick;
    }
    s.ai.score = s.influence[i];
    s.ai.dest = [x, y];
  }
}

/** 1cb6:c9bc called with flag 4: evaluate every cell reachable from the unit's position. */
export function evaluateReachable(s: AiState, u: Unit, maxCost: number): void {
  floodMove(s, u, [u.x, u.y], s.grid, {
    flags: BFS_EVALUATE,
    maxCost,
    onEvaluateStart: () => {
      s.ai.score = 0;
      s.ai.target = NONE;
      s.ai.dest = null;
      s.ai.tactic = NONE;
      s.castable = castableTactics(off(s, u), u.mp, s.learn);
    },
    evaluate: (x, y) => evaluateCell(s, u, x, y),
  });
}

function findFoe(s: AiState, u: Unit, maxCost: number): number {
  return floodMove(s, u, [u.x, u.y], s.grid, { flags: BFS_FIND_FOE, maxCost, foeMap: s.foeMap });
}

/** Walks toward `goal` as far as `mp` allows and marks the stopping cell (1cb6:c772 mode 1). */
function approach(s: AiState, u: Unit, mp: number, goal: Pos): void {
  const r = walkPath(s, u, s.grid, [u.x, u.y], goal, mp);
  if (!r.reached) spreadInfluence(s, unitAt(s, r.stop[0], r.stop[1]) !== NONE ? 50 : 30, r.stop[0], r.stop[1]);
}

/** "Attack nearest" planning (1cb6:dc00). */
export function planAttackNearest(s: AiState, u: Unit, mp: number): void {
  if (findFoe(s, u, mp) !== NONE) {
    evaluateReachable(s, u, mp);
    return;
  }
  const e = findFoe(s, u, 0xff);
  if (e === NONE) {
    s.ai.dest = [u.x, u.y];
    return;
  }
  const eu = s.units[e];
  if (floodMove(s, u, [eu.x, eu.y], s.grid, { flags: BFS_REACH, maxCost: 0xff, target: [u.x, u.y] }) !== NONE) {
    approach(s, u, mp, [eu.x, eu.y]);
    evaluateReachable(s, u, mp);
  }
}

export interface Plan {
  /** Route from the unit's square to ai.dest (directions 0..3); empty when it stays. */
  route: number[];
  dest: Pos | null;
  /** Attack/tactic target chosen during evaluation (cd4a re-checks it after moving). */
  target: number;
  tactic: number;
}

/**
 * Decides what unit `u` does this phase (the planning part of 1cb6:ce50). Updates the unit's
 * target/mode where the original does. Returns null when the unit does nothing.
 */
export function planUnit(s: AiState, u: Unit): Plan | null {
  const scripted = (u.flags & UnitFlag.Scripted) !== 0;
  const mp = scripted ? 100 : movePoints(off(s, u), s.items);
  if (u.target !== NONE && s.units[u.target].status !== Status.Field) {
    u.target = NONE;
    u.mode = AiMode.AttackNearest;
  }
  if (u.status !== Status.Field || u.flags & UnitFlag.Acted) return null;
  if (u.flags & UnitFlag.Confused) return null;
  aiPrepare(s, u);
  // (The "follow the commander" branch at 1cb6:cef5 needs DS:0xe525 bit 0, which is only ever cleared: dead code.)
  switch (u.mode) {
    case AiMode.MoveTo:
    case AiMode.MoveNoAttack: {
      const goal: Pos = u.target !== NONE ? [s.units[u.target].x, s.units[u.target].y] : [u.tx, u.ty];
      if (scripted) {
        if (floodMove(s, u, [u.x, u.y], s.grid, { flags: BFS_REACH, maxCost: 0xff, target: goal }) !== NONE) s.ai.dest = goal;
        else {
          s.ai.dest = [u.x, u.y];
          u.tx = u.x;
          u.ty = u.y;
        }
        break;
      }
      const foe = findFoe(s, u, mp);
      if (u.target !== NONE && u.target === foe) {
        spreadInfluence(s, 50, goal[0], goal[1]);
        evaluateReachable(s, u, mp);
        break;
      }
      spreadInfluence(s, 30, goal[0], goal[1]);
      if (floodMove(s, u, goal, s.grid, { flags: BFS_REACH, maxCost: 0xff, target: [u.x, u.y] }) !== NONE) {
        approach(s, u, mp, goal);
        evaluateReachable(s, u, mp);
      } else planAttackNearest(s, u, mp);
      break;
    }
    case AiMode.AttackNearest:
      planAttackNearest(s, u, mp);
      break;
    case AiMode.Hold:
      evaluateReachable(s, u, 0); // evaluates only its own square
      s.ai.dest = [u.x, u.y];
      break;
    case AiMode.Wait:
      if (findFoe(s, u, mp) !== NONE) evaluateReachable(s, u, mp);
      else s.ai.dest = [u.x, u.y];
      break;
    default:
      break;
  }
  let route: number[] = [];
  const dest = s.ai.dest;
  if (dest && !same(dest, u.x, u.y)) route = walkPath(s, u, s.grid, dest, [u.x, u.y], 0xff).route;
  return { route, dest, target: s.ai.target, tactic: s.ai.tactic };
}

/** Moves the unit to plan.dest (1cb6:c3f4) and applies the arrival rule of 1cb6:8a6e. */
export function applyMove(s: AiState, u: Unit, plan: Plan): void {
  if (plan.dest && u.status === Status.Field && !same(plan.dest, u.x, u.y) && plan.route.length > 0) {
    s.unitAt[u.y * s.width + u.x] = NONE;
    u.x = plan.dest[0];
    u.y = plan.dest[1];
    s.unitAt[u.y * s.width + u.x] = u.slot;
    u.flags |= UnitFlag.Moved;
  }
  if (u.target === NONE && u.x === u.tx && u.y === u.ty && (u.mode === AiMode.MoveTo || u.mode === AiMode.MoveNoAttack))
    u.mode = AiMode.Wait;
}

/**
 * Target of the AI's physical attack after moving (1cb6:cd4a): the previous choice if still in
 * range, else the last enemy listed; 0xff = no attack.
 */
export function attackTargetAfterMove(s: AiState, u: Unit): number {
  if (u.flags & UnitFlag.Scripted || u.mode === AiMode.MoveNoAttack || u.flags & UnitFlag.Acted) return NONE;
  const list = unitsInRange(s, u, CLASS_RANGE[off(s, u).cls], u.x, u.y, false, s.foeMap);
  return pickTarget(list, s.ai.target);
}

/**
 * Action order for one side (1cb6:3e12): units on village/fortress/barracks first, then weak
 * units, then the rest, each group in slot order. Returns slots in acting order.
 */
export function actionOrder(s: Field, playerSide: boolean): number[] {
  const lo = playerSide ? 0 : PLAYER_SLOTS;
  const hi = playerSide ? PLAYER_SLOTS : UNIT_SLOTS;
  const out: number[] = [];
  const taken = new Set<number>();
  const pass = (pred: (u: Unit) => boolean) => {
    for (let i = lo; i < hi; i++) {
      const u = s.units[i];
      if (!taken.has(i) && pred(u)) {
        taken.add(i);
        out.push(i);
      }
    }
  };
  pass((u) => u.x < s.width && u.y < s.height && onRecoveryTerrain(s, u.x, u.y));
  pass((u) => isWeak(s, u));
  pass(() => true);
  out.forEach((slot, k) => (s.units[slot].order = k));
  return out;
}

export { rebuildUnitMap };

/**
 * One computer-controlled unit's whole action (1cb6:ce50): plan, move, then attack (cd4a) or cast
 * (b2d6). Script events after the action (1cb6:8ad2) and the victory check (4abc) are the caller's.
 */
export function aiTakeTurn(s: AiState & CombatState, u: Unit): { plan: Plan; hit: HitResult | null; cast: CastResult | null } | null {
  const plan = planUnit(s, u);
  if (!plan) return null;
  applyMove(s, u, plan);
  let hit: HitResult | null = null;
  let cast: CastResult | null = null;
  if (!(u.flags & UnitFlag.Scripted) && u.mode !== AiMode.MoveNoAttack) {
    if (s.ai.tactic === NONE) {
      const t = attackTargetAfterMove(s, u);
      if (t !== NONE) hit = attack(s, u.slot, t);
    } else cast = castTactic(s, u.slot, s.ai.tactic, s.ai.target);
  }
  return { plan, hit, cast };
}
