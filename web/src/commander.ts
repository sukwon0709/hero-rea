// Classic mode: the custom battle AI ("지휘형" commander) for 자동전투.
//
// The patched MAIN.EXE (autobattle.ts, asm/aiblob.asm) writes AISTATE.BIN at the start of every
// player-side computer pass while 자동전투 is on: one sequence byte, then DGROUP:0000..fff0. This
// module reads the battle from that dump and gives orders to the player's units. The orders are
// the unit fields the game's own AI already follows (docs/BATTLE.md "AI"): mode (+0xb), target
// slot (+5) and target cell (+6,+7). The game then moves and attacks with its usual rules, so the
// orders say where to go and whom to chase, not how to fight.
//
// Strategy:
// - Weak units (troops at or below 40% of the maximum, morale below 40, or 유비 at 60%) go to the
//   nearest free village, fortress or barracks (they recover there) without attacking, and hold
//   once they are on one.
// - The others pick one enemy together: the enemy commander when it is close enough, else the
//   enemy that is weakest for its distance. Units within reach chase it; the rest attack the
//   nearest enemy as usual.
//
// That is DEFAULT_STRATEGY. A Strategy changes the thresholds and the focus rule and gives single
// officers a role (charge, guard 유비, hold); the page can make one from a prompt (strategyprompt.ts).

import { maxHp } from './engine/battle/rules';
import { NONE, PLAYER_SLOTS, TERRAIN_BARRACKS, TERRAIN_FORTRESS, TERRAIN_VILLAGE, UNIT_SLOTS } from './engine/battle/types';
import { cstr } from './formats/tables';

export const STATE_FILE = 'AISTATE.BIN';
export const ORDER_FILE = 'AIORDER.BIN';
/** First byte of AIORDER.BIN when the custom AI is off: the game does not stop to wait. */
export const ORDERS_OFF = 0xff;

const UNITS = 0xe2a2;
const UNIT_SIZE = 14;
const OFFICERS = 0x7a94;
const OFFICER_SIZE = 0x2c;
const BATTLE = 0xe196;
const MASK = 0x3ad5; // player units that were player-controlled when 자동전투 started (autobattle.ts)
const ON_FIELD = 2;

const MODE_MOVE = 0;
const MODE_ATTACK = 1;
const MODE_HOLD = 2;
const MODE_WAIT = 3; // stay, attack only what is in reach
const MODE_MOVE_ONLY = 4;

const RECOVERY = new Set([TERRAIN_VILLAGE, TERRAIN_FORTRESS, TERRAIN_BARRACKS]);
/** Cells within which a unit chases the focus target instead of its nearest enemy. */
const CHASE_RANGE = 8;
/** Cells within which the enemy commander becomes the focus. */
const COMMANDER_RANGE = 12;
const ENEMY_COMMANDER = PLAYER_SLOTS; // slot 15

export interface BattleUnit {
  slot: number;
  officer: number;
  name: string;
  x: number;
  y: number;
  target: number;
  tx: number;
  ty: number;
  mode: number;
  morale: number;
  troops: number;
  maxTroops: number;
}

export interface BattleState {
  seq: number;
  map: number;
  turn: number;
  width: number;
  height: number;
  /** Player units on the field that 자동전투 controls. */
  ours: BattleUnit[];
  enemies: BattleUnit[];
  /** Every unit on the field, by slot. */
  bySlot: Map<number, BattleUnit>;
  /** The 15 player unit records as dumped (DS:0xe2a2, 14 bytes each). */
  playerRecords: Uint8Array;
  /** Slot of 유비 (DS:0), NONE when unknown. */
  leader: number;
}

/** Size of AISTATE.BIN: the sequence byte and DGROUP:0000..fff0. */
export const STATE_SIZE = 1 + 0xfff0;

export function parseState(file: Uint8Array): BattleState | null {
  if (file.length !== STATE_SIZE) return null;
  const ds = file.subarray(1);
  const u16 = (o: number) => ds[o] | (ds[o + 1] << 8);
  const mask = u16(MASK);
  const ours: BattleUnit[] = [];
  const enemies: BattleUnit[] = [];
  const bySlot = new Map<number, BattleUnit>();
  for (let slot = 0; slot < UNIT_SLOTS; slot++) {
    const r = UNITS + slot * UNIT_SIZE;
    if (ds[r + 9] !== ON_FIELD) continue;
    const officer = u16(r);
    const o = OFFICERS + officer * OFFICER_SIZE;
    if (o + OFFICER_SIZE > ds.length) continue;
    const cls = ds[o + 0x20];
    const level = ds[o + 0x21];
    const u: BattleUnit = {
      slot,
      officer,
      name: cstr(ds.subarray(o + 6, o + 12)),
      x: ds[r + 3],
      y: ds[r + 4],
      target: ds[r + 5],
      tx: ds[r + 6],
      ty: ds[r + 7],
      mode: ds[r + 0xb],
      morale: ds[r + 0xc],
      troops: u16(o + 0x1e),
      maxTroops: cls < 19 && level > 0 ? maxHp({ cls, level } as Parameters<typeof maxHp>[0]) : 0,
    };
    bySlot.set(slot, u);
    if (slot >= PLAYER_SLOTS) enemies.push(u);
    else if (mask & (1 << slot)) ours.push(u);
  }
  return {
    seq: file[0],
    map: ds[BATTLE],
    turn: ds[BATTLE + 2],
    width: ds[0xe194],
    height: ds[0xe195],
    ours,
    enemies,
    bySlot,
    playerRecords: ds.slice(UNITS, UNITS + PLAYER_SLOTS * UNIT_SIZE),
    leader: ds[0] < PLAYER_SLOTS ? ds[0] : NONE,
  };
}

export interface Order {
  slot: number;
  mode: number;
  target: number;
  tx: number;
  ty: number;
  /** Korean, for the page's log. */
  text: string;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const ratio = (u: BattleUnit) => (u.maxTroops ? u.troops / u.maxTroops : 1);

/** What a unit does when it is not retreating. */
export type Role = 'free' | 'charge' | 'guard' | 'hold';
export const ROLES: Role[] = ['free', 'charge', 'guard', 'hold'];
/** Which enemy the units attack together. */
export type FocusRule = 'commander' | 'weakest' | 'nearest';
export const FOCUS_RULES: FocusRule[] = ['commander', 'weakest', 'nearest'];

export interface UnitRule {
  /** Officer name as the game shows it (유비, 관우, ...). */
  name: string;
  role: Role;
  /** Troop fraction at which this unit retreats; null = the strategy's value. 0 = never. */
  retreatAt: number | null;
}

/**
 * The commander's settings. The page can fill them from a player's prompt (strategyprompt.ts);
 * DEFAULT_STRATEGY is the behaviour described at the top of this file.
 */
export interface Strategy {
  /** Korean one-line description, shown in the page. */
  summary: string;
  focus: FocusRule;
  /** Cells within which units chase the focus target (role free). */
  chaseRange: number;
  /** Troop fraction at or below which a unit retreats to recover; 0 = never. */
  retreatAt: number;
  /** The same for 유비. */
  leaderRetreatAt: number;
  units: UnitRule[];
}

export const DEFAULT_STRATEGY: Strategy = {
  summary: '기본 전략: 적 대장이나 약한 적을 집중 공격하고, 약해진 부대는 회복 지형으로 후퇴',
  focus: 'commander',
  chaseRange: CHASE_RANGE,
  retreatAt: 0.4,
  leaderRetreatAt: 0.6,
  units: [],
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

/** A Strategy from untrusted JSON (the model's answer, localStorage): unknown values fall back to the default. */
export function sanitizeStrategy(raw: unknown): Strategy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_STRATEGY;
  const units = Array.isArray(o.units) ? o.units : [];
  return {
    summary: typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim().slice(0, 200) : d.summary,
    focus: FOCUS_RULES.includes(o.focus as FocusRule) ? (o.focus as FocusRule) : d.focus,
    chaseRange: Math.round(clamp(o.chaseRange, 0, 40, d.chaseRange)),
    retreatAt: clamp(o.retreatAt, 0, 1, d.retreatAt),
    leaderRetreatAt: clamp(o.leaderRetreatAt, 0, 1, d.leaderRetreatAt),
    units: units
      .map((u) => (u && typeof u === 'object' ? (u as Record<string, unknown>) : {}))
      .filter((u) => typeof u.name === 'string' && u.name.trim() !== '')
      .slice(0, 30)
      .map((u) => ({
        name: (u.name as string).trim(),
        role: ROLES.includes(u.role as Role) ? (u.role as Role) : 'free',
        retreatAt: typeof u.retreatAt === 'number' && u.retreatAt >= 0 ? clamp(u.retreatAt, 0, 1, 0) : null,
      })),
  };
}

function ruleOf(st: Strategy, u: BattleUnit): UnitRule | undefined {
  return st.units.find((r) => r.name === u.name);
}

function isWeak(u: BattleUnit, s: BattleState, st: Strategy): boolean {
  const rule = ruleOf(st, u);
  const at = rule?.retreatAt ?? (u.slot === s.leader ? st.leaderRetreatAt : st.retreatAt);
  if (at <= 0) return false;
  return ratio(u) <= at || u.morale < 40;
}

/**
 * Orders for the player's units. `terrain` is the battle map's terrain (width*height, row-major),
 * or null when it is not known (then weak units only hold).
 */
export function decide(s: BattleState, terrain: Uint8Array | null, st: Strategy = DEFAULT_STRATEGY): Order[] {
  const orders: Order[] = [];
  if (!s.enemies.length) return orders;
  const occupied = new Set([...s.bySlot.values()].map((u) => u.y * s.width + u.x));
  const claimed = new Set<number>();

  const fighters: BattleUnit[] = [];
  for (const u of s.ours) {
    if (!isWeak(u, s, st)) {
      fighters.push(u);
      continue;
    }
    const here = u.y * s.width + u.x;
    if (terrain && RECOVERY.has(terrain[here])) {
      claimed.add(here);
      orders.push({ slot: u.slot, mode: MODE_HOLD, target: NONE, tx: u.x, ty: u.y, text: `${u.name}: 회복 지형에서 대기` });
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    if (terrain) {
      for (let i = 0; i < terrain.length; i++) {
        if (!RECOVERY.has(terrain[i]) || occupied.has(i) || claimed.has(i)) continue;
        const cell = { x: i % s.width, y: Math.floor(i / s.width) };
        // Avoid cells next to the enemy: each cell closer than 4 to an enemy counts as 3 more.
        const threat = Math.max(0, 4 - Math.min(...s.enemies.map((e) => dist(e, cell))));
        const d = dist(u, cell) + 3 * threat;
        if (d < bestD) [best, bestD] = [i, d];
      }
    }
    if (best >= 0) {
      claimed.add(best);
      const tx = best % s.width;
      const ty = Math.floor(best / s.width);
      orders.push({ slot: u.slot, mode: MODE_MOVE_ONLY, target: NONE, tx, ty, text: `${u.name}: 후퇴해서 (${tx},${ty}) 회복` });
    } else {
      orders.push({ slot: u.slot, mode: MODE_HOLD, target: NONE, tx: u.x, ty: u.y, text: `${u.name}: 약해서 제자리 대기` });
    }
  }
  if (!fighters.length) return orders;

  const cx = fighters.reduce((a, u) => a + u.x, 0) / fighters.length;
  const cy = fighters.reduce((a, u) => a + u.y, 0) / fighters.length;
  const centre = { x: cx, y: cy };
  const commander = s.enemies.find((e) => e.slot === ENEMY_COMMANDER);
  const weakest = () => {
    const score = (e: BattleUnit) => dist(centre, e) + 10 * ratio(e);
    return s.enemies.reduce((a, e) => (score(e) < score(a) ? e : a));
  };
  let focus: BattleUnit | null = null;
  if (st.focus === 'commander') {
    focus = commander && Math.min(...fighters.map((u) => dist(u, commander))) <= COMMANDER_RANGE ? commander : weakest();
  } else if (st.focus === 'weakest') focus = weakest();
  const leader = s.bySlot.get(s.leader);

  const attackNearest = (u: BattleUnit) =>
    orders.push({ slot: u.slot, mode: MODE_ATTACK, target: NONE, tx: u.tx, ty: u.ty, text: `${u.name}: 가까운 적 공격` });
  const chase = (u: BattleUnit, f: BattleUnit) =>
    orders.push({ slot: u.slot, mode: MODE_MOVE, target: f.slot, tx: f.x, ty: f.y, text: `${u.name}: ${f.name} 집중 공격` });

  for (const u of fighters) {
    const role = ruleOf(st, u)?.role ?? 'free';
    if (role === 'hold') {
      orders.push({ slot: u.slot, mode: MODE_WAIT, target: NONE, tx: u.x, ty: u.y, text: `${u.name}: 제자리 방어` });
    } else if (role === 'guard' && leader && leader !== u) {
      if (dist(u, leader) > 2) {
        orders.push({ slot: u.slot, mode: MODE_MOVE, target: NONE, tx: leader.x, ty: leader.y, text: `${u.name}: ${leader.name} 곁으로 이동` });
      } else {
        orders.push({ slot: u.slot, mode: MODE_WAIT, target: NONE, tx: u.x, ty: u.y, text: `${u.name}: ${leader.name} 호위` });
      }
    } else if (role === 'charge') {
      // Without a focus rule, the enemy commander, else the nearest enemy.
      const f = focus ?? commander ?? s.enemies.reduce((a, e) => (dist(u, e) < dist(u, a) ? e : a));
      chase(u, f);
    } else if (focus && dist(u, focus) <= st.chaseRange) {
      chase(u, focus);
    } else {
      attackNearest(u);
    }
  }
  return orders;
}

/** AIORDER.BIN answering `s`: the sequence byte, then the player unit records with the orders applied. */
export function orderFile(s: BattleState, orders: Order[]): Uint8Array {
  const out = new Uint8Array(1 + s.playerRecords.length);
  out[0] = s.seq;
  out.set(s.playerRecords, 1);
  for (const o of orders) {
    const r = 1 + o.slot * UNIT_SIZE;
    out[r + 5] = o.target;
    out[r + 6] = o.tx;
    out[r + 7] = o.ty;
    out[r + 0xb] = o.mode;
  }
  return out;
}
