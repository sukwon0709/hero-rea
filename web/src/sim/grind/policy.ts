// Grinding simulator, part 2: the player policy. It replaces the battle scene's player phase
// (1cb6:44de: victory window on turn 1, the tryCure pass over every slot, then one command per
// unit followed by the unit's events 8ad2 and the victory check 4abc) with commands chosen by a
// scoring rule, executed through the scene's own routines (doAttack = cd4a/e91a, castFlow = b2d6),
// so the RNG draws are exactly the ones the same commands make in the game. The policy itself
// never draws from the game's RNG (its estimates are exact damage formulas and bounds).
//
// Grinding phase: every controllable unit, neediest officer (lowest level) first, picks the
// (destination, action) pair with the best value:
//   value = w(officer) * expected exp - enemy troops burnt - MP spent - danger at the destination
// with w = 0 for officers at 99 (they gain nothing, 0cf5:6f64) and 1 + need*(99-level)/98 otherwise.
// Kills are allowed only while more than `keep` enemies remain and never on protected enemies
// (the victory officer, officers whose defeat ends the battle). Exp facts used (docs/BATTLE.md):
// a hit gives 4 (target lower) .. 16 (target 5+ levels higher), also when it misses; a kill
// 32/48/64/(dL+2); confusion and morale tactics give +8 whenever cast, success or not; single
// heals give +8 (+12 for 군악대/수송대) when the target is not already full (a200), so healers walk
// towards hurt allies; area heals are castable whenever an ally (or the caster) is in the area.
// Finish phase (the last `finish` turns, the leader hurt, too many losses, or nobody deployed can
// gain exp): the units head for the battle's winning condition (their goal cell / the victory
// officer / the nearest enemy) by the same deterministic scoring, and kill freely.
// Fallback (`native`, per battle): the game's own AI plays our side, for battles the policy loses.

import type { BattleScene } from '../../native/battle/scene';
import type { GameState } from '../../engine/state';
import type { ScriptState } from '../../engine/script';
import type { Stage } from '../../formats/scenario';
import { recordCommands } from '../../native/battle/dev/setup';
import { scriptGains, recordIndexOf, turnEvents, cellOf, type ScriptGain, type TurnEvent } from './events';
import { S } from '../../native/battle/strings';
import { floodMove, rangeCells, terrainAt, unitAt, unitsInRange, sideOf, moveTypeOf } from '../../engine/battle/hex';
import {
  attackPower,
  castableTactics,
  combatExp,
  defencePower,
  maxHp,
  maxMp,
  moraleDrop,
  movePoints,
  physicalDamage,
  tacticSkill,
  tacticTerrainOk,
  tryCure,
  healKind,
} from '../../engine/battle/rules';
import { healUseful } from '../../engine/battle/combat';
import {
  AiMode,
  CLASS_ATTACK_TYPE,
  CLASS_COUNT,
  CLASS_RANGE,
  NONE,
  PLAYER_SLOTS,
  RAIN,
  Status,
  TACTIC_MP,
  TACTIC_POWER,
  TERRAIN_FOREST,
  TERRAIN_VILLAGE,
  TERRAIN_FORTRESS,
  TERRAIN_BARRACKS,
  terrainDefence,
  UNIT_SLOTS,
  UnitFlag,
  WEATHER_TYPE,
  resistsTactics,
  moveCost,
  type Unit,
} from '../../engine/battle/types';

// ---------------------------------------------------------------- parameters

export interface GrindParams {
  /** Weight of an officer's distance to 99 in the value of its exp. */
  need: number;
  /** Enemies kept alive: kills only while more than this many enemies are on the field. */
  keep: number;
  /** Turns reserved at the end for winning. */
  finish: number;
  /** Multiplier on the exp of tactics (MP is spent once per battle). */
  tactic: number;
  /** Multiplier on the exp of control tactics (견제: confusion 15..17, morale 18..20): they stall the enemy and keep it alive. */
  control: number;
  /** Multiplier on heal exp. */
  heal: number;
  /** Multiplier on kill exp (a kill removes a source of later hits). */
  kill: number;
  /** Cost of burning enemy troops (per 10% of the target's maximum). */
  conserve: number;
  /** Cost per MP point. */
  mp: number;
  /** Weight of the danger at the destination. */
  risk: number;
  /** Troops fraction under which a unit looks for a healing cell. */
  retreat: number;
  /** Pull towards the nearest enemy when nothing better is possible. */
  approach: number;
  /** Formation: slots kept for the strongest officers (the rest go to the lowest levels). */
  strong: number;
  /** Share of the leader's troops the worst case (every enemy in reach hits it) may reach. */
  guard: number;
  /** Pull of the other units towards the leader (stay within 3 cells): the fight stays where the leader can join it and is covered. */
  escort: number;
  /** Weight of the battle scripts' gains (events.ts): victory bonus cells, duels, persuasions, level-ups. */
  event: number;
  /** Feeding the leader: others soften enemies the leader can finish safely, and leave those kills to it. */
  feed: number;
  /** Leader safety beyond the worst case: cost per enemy that can reach the leader's cell. */
  safe: number;
  /** 군악대 (class 12): at each turn start every unit next to it gets MP += its level/10+1 (1cb6:7cc8). Pull of tactic users towards it (and of it towards them); also fields the band officers. */
  band: number;
  /** The leader fights like the others: pull per cell towards the nearest enemy (the don't-die check stays). */
  lead: number;
  /** Above 0.5: hold a position near the start and let the enemy come in waves (하비); push out once they are broken. */
  hold: number;
  /** Terrain: stand on high-defence cells where enemies can reach, heal on villages/fortresses when hurt. */
  terrain: number;
  /**
   * Brace for the waves (Sukwon: survive them while grinding, never rush the enemy leader): this
   * many turns (+1) before a turn event brings 4+ enemy units, form up on defensible ground around
   * 유비 (terrain, chokepoint, away from where the wave enters) and let them come, until the wave
   * is thinned; at most 0.5 = off (learned: 하비 was won by finishing before its wave).
   */
  brace: number;
  /**
   * 총퇴각 at the first player phase this many times before playing (not learned globally, chosen
   * per battle): each retreat restarts the battle with the RNG moved on, as it does for a player.
   */
  rerolls?: number;
  /**
   * Fallback plan (per battle, not learned): after the rerolls, hand every player unit to the
   * game's own computer AI (the port's autoPlay: 최단 적공격, 유비 대기) instead of grinding.
   * Used for battles the grinding policy cannot win; exp is whatever the AI's fighting earns.
   */
  native?: boolean;
}

/** The learned parameters (rerolls and native are chosen per battle). */
export type ParamKey = Exclude<keyof GrindParams, 'rerolls' | 'native'>;

export interface ParamSpec {
  key: ParamKey;
  min: number;
  max: number;
  def: number;
  int?: boolean;
}

export const PARAM_SPECS: ParamSpec[] = [
  { key: 'need', min: 0, max: 4, def: 1.5 },
  { key: 'keep', min: 1, max: 8, def: 2, int: true },
  { key: 'finish', min: 2, max: 16, def: 3, int: true },
  { key: 'tactic', min: 0.2, max: 2.5, def: 1 },
  { key: 'control', min: 0.2, max: 3, def: 1 },
  { key: 'heal', min: 0.2, max: 2.5, def: 1 },
  { key: 'kill', min: 0, max: 2, def: 0.6 },
  { key: 'conserve', min: 0, max: 3, def: 0.8 },
  { key: 'mp', min: 0, max: 1.5, def: 0.2 },
  { key: 'risk', min: 0, max: 4, def: 1.2 },
  { key: 'retreat', min: 0, max: 0.7, def: 0.35 },
  { key: 'approach', min: 0, max: 3, def: 0.3 },
  { key: 'strong', min: 0, max: 8, def: 3, int: true },
  { key: 'guard', min: 0.3, max: 1.3, def: 1 },
  { key: 'escort', min: 0, max: 3, def: 0.6 },
  { key: 'event', min: 0, max: 3, def: 1 },
  { key: 'feed', min: 0, max: 3, def: 0 },
  { key: 'safe', min: 0, max: 3, def: 0 },
  { key: 'band', min: 0, max: 3, def: 1 },
  { key: 'lead', min: 0, max: 4, def: 1.5 },
  { key: 'hold', min: 0, max: 1, def: 0 },
  { key: 'terrain', min: 0, max: 3, def: 1 },
  { key: 'brace', min: 0, max: 3, def: 0.6 },
];

export function defaultParams(): GrindParams {
  const p = {} as GrindParams;
  for (const s of PARAM_SPECS) p[s.key] = s.def;
  return p;
}

export function clampParams(p: GrindParams): GrindParams {
  const o = { ...p };
  for (const s of PARAM_SPECS) {
    let v = Math.min(s.max, Math.max(s.min, o[s.key]));
    if (s.int) v = Math.round(v);
    o[s.key] = v;
  }
  return o;
}

// ---------------------------------------------------------------- battle analysis

export interface BattleKnowledge {
  victory: number | null;
  /** Enemy officers whose defeat ends the battle (never killed while grinding). */
  protect: Set<number>;
  /** Officers whose loss loses the battle (유비, the defeat officer). */
  guarded: Set<number>;
  /** Cells (y*width+x per officer, 0x400 = any) whose arrival event wins the battle. */
  winCells: { officer: number; x0: number; y0: number; x1: number; y1: number; group?: number }[];
  /** Adjacency events (trigger 4) that end the battle: `actor` acting next to `other`. */
  winAdj: { actor: number; other: number; group?: number }[];
  /** A turn event ends the game at this turn (deadline before the limit). */
  deadline: number | null;
  /** A turn event wins the battle at this turn (survive until then: 소패). */
  endsAt: number | null;
  /** Treasure cells: arrival events (trigger 6) that give an item (ADD_ITEM) and do not end the battle. */
  treasure: { officer: number; x: number; y: number }[];
  /** The block's gains (bonus exp, duels, persuasions, levels), with the stage for matching the records the VM runs. */
  gains: ScriptGain[];
  /** Turn events and defeat events that lose the battle (events.ts). */
  turns: TurnEvent[];
  /** Turn of a big enemy wave (5+ units, turn 6 or later): the grinding finishes before it. */
  soft: number | null;
  /**
   * Steps before the winning group (서주 2nd): one-shot groups whose event moves the script on,
   * in order (defeat officer X, then 유비 into an area). Only the current group's records can fire,
   * so the win cells and the victory of later groups wait for these.
   */
  steps: { group: number; trigger: number; officer: number; x0: number; y0: number; x1: number; y1: number }[];
  stage?: Stage;
  block?: number;
}

function winning(stage: Stage, code: number, victory: number | null, block?: number, group?: number): boolean {
  const cmds = recordCommands(stage, code);
  // LEAVE_GROUP into a group whose auto record ends the battle in a win (태산: persuading 이명 moves
  // the block to group 4, whose first record is the victory)
  if (block !== undefined && group !== undefined && cmds.some((c) => c.name === 'LEAVE_GROUP') && !cmds.some((c) => c.name === 'GAME_OVER' || c.name === 'BATTLE_END')) {
    const next = stage.blocks[block].records.find((r) => r.group === group + 1 && r.trigger === 0);
    if (next) {
      const nc = recordCommands(stage, next.code);
      const i = nc.findIndex((c) => c.name === 'BATTLE_END');
      if (i >= 0 && nc[i + 1]?.name !== 'GAME_OVER') return true;
    }
  }
  // the victory officer taken off the field (a duel: REMOVE) wins through its defeat event
  if (victory !== null && cmds.some((c) => c.name === 'REMOVE' && (c as unknown as { officer: number }).officer === victory)) return true;
  const i = cmds.findIndex((c) => c.name === 'BATTLE_END');
  if (i < 0) return cmds.some((c) => c.name === 'MAP');
  return cmds[i + 1]?.name !== 'GAME_OVER';
}

/** Reads the current block's records: what wins, what loses, what to keep alive. */
export function analyseBattle(stage: Stage, script: ScriptState): BattleKnowledge {
  const k: BattleKnowledge = { victory: null, protect: new Set(), guarded: new Set([0]), winCells: [], winAdj: [], deadline: null, endsAt: null, treasure: [], gains: scriptGains(stage, script.block), turns: turnEvents(stage, script.block), soft: null, steps: [], stage, block: script.block };
  if (script.victory.enabled) {
    k.victory = script.victory.officer;
    k.protect.add(script.victory.officer);
  }
  if (script.defeat.enabled) k.guarded.add(script.defeat.officer);
  for (const r of stage.blocks[script.block]?.records ?? []) {
    const cmds = recordCommands(stage, r.code);
    if (r.trigger === 12 && winning(stage, r.code, k.victory, script.block, r.group)) k.protect.add(r.p1);
    if ((r.trigger === 6 || r.trigger === 11) && winning(stage, r.code, k.victory, script.block, r.group) && !cmds.some((c) => c.name === 'GAME_OVER')) {
      const [x0, y0] = cellOf(r.p2);
      const [x1, y1] = r.trigger === 6 ? [x0, y0] : cellOf(r.p3);
      k.winCells.push({ officer: r.p1, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), group: r.group });
    }
    if (r.trigger === 4 && winning(stage, r.code, k.victory, script.block, r.group)) k.winAdj.push({ actor: r.p1, other: r.p2, group: r.group });
    if (r.trigger === 6 && cmds.some((c) => c.name === 'ADD_ITEM') && !cmds.some((c) => c.name === 'BATTLE_END' || c.name === 'GAME_OVER'))
      k.treasure.push({ officer: r.p1, x: cellOf(r.p2)[0], y: cellOf(r.p2)[1] });
    if (r.trigger === 9 && r.p1 > 0 && cmds.some((c) => c.name === 'GAME_OVER')) k.deadline = Math.min(k.deadline ?? 999, r.p1);
    else if (r.trigger === 9 && r.p1 > 0 && cmds.some((c) => c.name === 'BATTLE_END') && winning(stage, r.code, k.victory, script.block, r.group)) k.endsAt = Math.min(k.endsAt ?? 999, r.p1);
  }
  // steps: non-resident groups (done when their one event ends) of a single defeat / arrival event
  // that neither ends nor loses the battle, before the group holding the winning records
  const recs = stage.blocks[script.block]?.records ?? [];
  const winGroups = new Set([...k.winCells.map((c) => c.group), ...k.winAdj.map((a) => a.group)]);
  const lastWin = Math.max(-1, ...[...winGroups].filter((g): g is number => g !== undefined));
  const groups = [...new Set(recs.map((r) => r.group))].sort((a, b) => a - b);
  for (const g of groups) {
    if (g >= lastWin) break;
    const rs = recs.filter((r) => r.group === g);
    if (rs[0].resident || rs.length !== 1) continue;
    const r = rs[0];
    if (r.trigger !== 12 && r.trigger !== 6 && r.trigger !== 11) continue;
    const cmds = recordCommands(stage, r.code);
    if (cmds.some((c) => c.name === 'BATTLE_END' || c.name === 'GAME_OVER')) continue;
    const [x0, y0] = cellOf(r.p2);
    const [x1, y1] = r.trigger === 11 ? cellOf(r.p3) : [x0, y0];
    k.steps.push({ group: g, trigger: r.trigger, officer: r.p1, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  }
  return k;
}

// ---------------------------------------------------------------- formation

/**
 * Picks for a FORMATION: the officers already placed by the setup, 유비, then `strong` of the
 * highest-level officers (to keep battles winnable), then the lowest levels below 99.
 */
export function pickFormation(state: GameState, fixed: number[], free: number, strong: number, band = false): number[] {
  const faction = state.officers[0].dyn.flags & 0x1f;
  const pool = state.officers
    .map((o, i) => ({ i, lv: o.dyn.level, ok: (o.dyn.flags & 0x80) !== 0 && (o.dyn.flags & 0x1f) === faction && i < 0x100 }))
    .filter((o) => o.ok && !fixed.includes(o.i));
  const picks: number[] = [];
  const take = (i: number) => {
    if (picks.length < free && !picks.includes(i)) picks.push(i);
  };
  if (!fixed.includes(0) && pool.some((o) => o.i === 0)) take(0);
  // 군악대 officers: their neighbours regain MP every turn (heals and support tactics keep flowing)
  if (band) for (const o of pool) if (state.officers[o.i].dyn.cls === 12) take(o.i);
  const byHigh = [...pool].sort((a, b) => b.lv - a.lv || a.i - b.i);
  for (const o of byHigh.slice(0, strong)) take(o.i);
  const byLow = [...pool].sort((a, b) => (a.lv >= 99 ? 1 : 0) - (b.lv >= 99 ? 1 : 0) || a.lv - b.lv || a.i - b.i);
  for (const o of byLow) take(o.i);
  return picks;
}

// ---------------------------------------------------------------- statistics

export interface GrindStats {
  turns: number;
  finishTurn: number | null;
  /** Why the finish began: deadline, done (nobody needy), idle, leader, losses. */
  finishReason?: string;
  actions: { attack: number; kill: number; tactic: number; heal: number; wait: number; item?: number; promoted?: number };
  /** Officer -> exp gained per kind. */
  byOfficer: Map<number, { hits: number; kills: number; tactics: number; heals: number }>;
  /** Enemy officers alive when the finish began (the ones kept for grinding). */
  kept: number[];
  /** Tactics cast (tactic id -> count). */
  tactics: Map<number, number>;
  /** Records of the block's gains that ran (events.ts ScriptGain.record). */
  gainsFired?: number[];
  /** The victory bonus set when the battle ended (given to every unit on the field on a win). */
  bonus?: number;
}

interface Action {
  slot: number;
  x: number;
  y: number;
  kind: 'attack' | 'tactic' | 'wait' | 'item';
  target: number;
  tactic: number;
  /** kind 'item': the item id and its slot in the officer's 8 item slots. */
  item?: { id: number; index: number };
  value: number;
  exp: number;
  lethal: boolean;
  danger?: number;
}

// ---------------------------------------------------------------- the policy

/** Promotion items 0x13..0x1a (ab86): from class PROMOTE_FROM[k] at level >= PROMOTE_LEVEL[k] -> class+1. */
export const PROMOTE_FROM = [0, 1, 3, 4, 6, 7, 9, 10];
export const PROMOTE_LEVEL = [15, 30, 15, 30, 15, 30, 15, 30];

export class GrindPolicy {
  readonly stats: GrindStats = {
    turns: 0,
    finishTurn: null,
    actions: { attack: 0, kill: 0, tactic: 0, heal: 0, wait: 0 },
    byOfficer: new Map(),
    kept: [],
    tactics: new Map(),
    gainsFired: [],
    bonus: 0,
  };
  private finishing = false;
  private idleTurns = 0;
  private threat: number[][] = [];
  /** Trace sink (one line per command). */
  log: ((line: string) => void) | null = null;

  constructor(
    readonly scene: BattleScene,
    readonly p: GrindParams,
    readonly know: BattleKnowledge,
  ) {
    // a goal cell no unit can stand on never fires (거록: the gate cell (10,0) is impassable
    // terrain, so the battle is won by defeating the victory officer instead)
    const f = scene.b.s;
    if (process.env.GRIND_TRACE_HITS)
      for (const c of know.winCells) {
        const t = c.x0 < f.width && c.y0 < f.height ? terrainAt(f, c.x0, c.y0) : -1;
        console.error(`win cell ${c.x0},${c.y0} officer ${c.officer} terrain ${t} costs ${[0, 1, 2, 3].map((mt) => moveCost(mt, t)).join('/')} size ${f.width}x${f.height}`);
      }
    if (process.env.GRIND_TRACE_HITS)
      for (const u of scene.units) if (u.status !== Status.Empty) console.error(`unit ${u.slot} officer ${u.officer} at ${u.x},${u.y} status ${u.status} mode ${u.mode} flags ${u.flags}`);
    know.winCells = know.winCells.filter((c) => {
      for (let y = c.y0; y <= c.y1; y++)
        for (let x = c.x0; x <= c.x1; x++) {
          if (x >= f.width || y >= f.height) continue;
          const t = terrainAt(f, x, y);
          for (let mt = 0; mt < 4; mt++) if (moveCost(mt, t) !== 0xff) return true;
        }
      return false;
    });
    // sides of the turn events' officers: a defeat event that loses names one of ours to keep alive
    // (or an enemy never to kill); a big enemy wave late in the battle is a soft deadline
    for (const e of know.turns) {
      if (e.officer !== null && e.gameOver) {
        const s = scene.b.slotOfOfficer(e.officer);
        if (s !== NONE && s < PLAYER_SLOTS) know.guarded.add(e.officer);
        else if (s !== NONE) know.protect.add(e.officer);
      }
      if (e.turn !== null && e.turn >= 6) {
        const foes = e.reinforce.filter((o) => {
          const s = scene.b.slotOfOfficer(o);
          return s !== NONE && s >= PLAYER_SLOTS;
        }).length;
        if (foes >= 5) know.soft = Math.min(know.soft ?? 999, e.turn);
      }
    }
  }

  private looted = new Set<number>();
  /** Retreat (총퇴각, result 1) at the first player phase instead of playing. */
  retreatNow = false;

  /** Replaces the scene's player phase. Call from BattleExtras.afterSetup. */
  install(): void {
    const sc = this.scene as unknown as Record<string, unknown>;
    sc.playerPhase = () => this.playerPhase();
    if (process.env.GRIND_TRACE_HITS) {
      const real = this.scene as unknown as { doAttack: (a: number, d: number) => Promise<void>; castFlow: (s: number, t: number, p: boolean, tg?: number) => Promise<boolean> };
      const atk = real.doAttack.bind(this.scene), cast = real.castFlow.bind(this.scene);
      const L = () => this.b.slotOfOfficer(0);
      real.doAttack = async (a, d) => {
        const before = d === L() ? this.b.officerOf(this.scene.units[d]).hp : -1;
        const pred = d === L() ? this.hitOn(this.scene.units[a], this.scene.units[d], this.scene.units[d].x, this.scene.units[d].y) : 0;
        await atk(a, d);
        if (before >= 0) this.log?.(`  hit on leader by ${this.scene.units[a].officer} cls ${this.b.officerOf(this.scene.units[a]).cls} from ${this.scene.units[a].x},${this.scene.units[a].y}: ${before - this.b.officerOf(this.scene.units[d]).hp} (pred ${pred})`);
      };
      real.castFlow = async (sl, t, p, tg) => {
        const before = tg === L() ? this.b.officerOf(this.scene.units[tg]).hp : -1;
        const r = await cast(sl, t, p, tg);
        if (before >= 0) this.log?.(`  tactic ${t} on leader by ${this.scene.units[sl].officer}: ${before - this.b.officerOf(this.scene.units[tg!]).hp}`);
        return r;
      };
    }
    // which records the VM runs (for the gains fired): the 10 bytes it copies into ScriptState.record
    const ctx = this.scene.ctx;
    const run = ctx.runEvent.bind(ctx);
    ctx.runEvent = async (t) => {
      const r = await run(t);
      if (r !== 'none' && this.know.stage && this.know.block !== undefined) {
        const i = recordIndexOf(this.know.stage, this.know.block, ctx.vm.state.record);
        if (i !== null && this.know.gains.some((g) => g.record === i) && !this.fired.has(i)) {
          this.fired.add(i);
          this.stats.gainsFired!.push(i);
          this.log?.(`gain: record ${i} fired`);
        }
      }
      this.stats.bonus = this.b.info.bonus;
      return r;
    };
  }

  private fired = new Set<number>();

  /** What a gain not yet had is worth now (0 when fired, automatic, or a way to win: the finish takes those). */
  private gainValue(g: ScriptGain): number {
    if (this.fired.has(g.record) || g.automatic || g.ends) return 0;
    const b = this.b;
    let v = 0;
    if (g.bonus > b.info.bonus) {
      let ws = 0;
      for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) if (u.status === Status.Field) ws += this.weight(u.slot);
      v += (g.bonus - b.info.bonus) * ws * 0.5;
    }
    for (const l of g.levels) {
      const s = b.slotOfOfficer(l.officer);
      const w = s !== NONE && s < PLAYER_SLOTS ? this.weight(s) : 1;
      v += l.value * 100 * w;
    }
    v += g.recruits.length * 150;
    if (g.needsFlags.length) v *= 0.5;
    return v * this.p.event;
  }

  /** Gains a unit standing at (x, y) after its action would fire (adjacency, cell, area). */
  private gainAt(u: Unit, x: number, y: number): number {
    if (!this.p.event) return 0;
    const b = this.b;
    let v = 0;
    for (const g of this.know.gains) {
      if (g.actor !== u.officer && !(g.actor === 0x400 && u.slot < PLAYER_SLOTS)) continue;
      if (g.trigger === 4 && g.other !== null) {
        const s = b.slotOfOfficer(g.other);
        if (s === NONE || this.scene.units[s].status !== Status.Field) continue;
        const o = this.scene.units[s];
        if (Math.abs(o.x - x) + Math.abs(o.y - y) !== 1) continue;
      } else if ((g.trigger === 6 || g.trigger === 11) && g.cell) {
        if (x < g.cell.x0 || x > g.cell.x1 || y < g.cell.y0 || y > g.cell.y1) continue;
      } else continue;
      v += this.gainValue(g);
    }
    return v;
  }

  /** Where a unit's best open gain is (for the pull towards it), with its value. */
  private gainGoal(u: Unit): { at: [number, number]; value: number } | null {
    if (!this.p.event) return null;
    const b = this.b;
    let best: { at: [number, number]; value: number } | null = null;
    for (const g of this.know.gains) {
      if (g.actor !== u.officer && !(g.actor === 0x400 && u.slot < PLAYER_SLOTS && g.trigger !== 4)) continue;
      const v = this.gainValue(g);
      if (v <= 0) continue;
      let at: [number, number] | null = null;
      if (g.trigger === 4 && g.other !== null) {
        const s = b.slotOfOfficer(g.other);
        if (s !== NONE && this.scene.units[s].status === Status.Field) at = [this.scene.units[s].x, this.scene.units[s].y];
      } else if ((g.trigger === 6 || g.trigger === 11) && g.cell) at = [(g.cell.x0 + g.cell.x1) >> 1, (g.cell.y0 + g.cell.y1) >> 1];
      if (at && (!best || v > best.value)) best = { at, value: v };
    }
    return best;
  }

  /**
   * 군악대 (1cb6:7cc8): at the next turn start every unit next to a class-12 unit (either side) gets
   * MP += that unit's level/10 + 1, up to its maximum. Worth about 1.3 exp per MP to a tactic user
   * (a support tactic gives +8 for 4..10 MP). A band unit values the tactic users next to it.
   */
  private bandValue(u: Unit, x: number, y: number, w: number): number {
    const b = this.b;
    const o = b.officerOf(u);
    const learned = (oo: typeof o) => b.learn.some((lv, i) => i % CLASS_COUNT === oo.cls && lv <= oo.level);
    let v = 0;
    for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
      if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
      const s = unitAt(b.s, nx, ny);
      if (s === NONE || s === u.slot) continue;
      const N = this.scene.units[s];
      if (N.status !== Status.Field || N.officer === 0xffff) continue;
      const on = b.officerOf(N);
      if (on.cls === 12 && learned(o)) v += Math.min(Math.trunc(on.level / 10) + 1, Math.max(0, maxMp(o) - u.mp)) * 1.3 * w;
      if (o.cls === 12 && s < PLAYER_SLOTS && learned(on)) v += Math.min(Math.trunc(o.level / 10) + 1, Math.max(0, maxMp(on) - N.mp)) * 1.3 * this.weight(s);
    }
    return v * this.p.band;
  }

  /** Mean level of the enemy units on the field. */
  private enemyLevel(): number {
    let n = 0, s = 0;
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const e = this.scene.units[i];
      if (e.status !== Status.Field || e.officer === 0xffff) continue;
      s += this.b.officerOf(e).level;
      n++;
    }
    return n ? s / n : 1;
  }

  /** A defeat event (trigger 12) of this enemy gives something. */
  private killGain(officer: number): number {
    let v = 0;
    for (const g of this.know.gains) if (g.trigger === 12 && g.actor === officer && !this.know.protect.has(officer)) v += this.gainValue(g);
    return v;
  }

  /** Enemy slot -> the damage the leader can do to it this phase from a cell within its guard. */
  private leaderKills = new Map<number, number>();
  private leaderActed = false;
  private leaderSeen: { hp: number; dw: number } | null = null;

  private buildLeaderKills() {
    this.leaderKills.clear();
    this.leaderActed = false;
    if (!this.p.feed || this.finishing) return;
    const b = this.b;
    const ls = b.slotOfOfficer(0);
    if (ls === NONE || ls >= PLAYER_SLOTS) return;
    const L = this.scene.units[ls];
    if (!this.controllable(L) || L.flags & UnitFlag.Acted) return;
    const o = b.officerOf(L);
    const range = CLASS_RANGE[o.cls];
    if (range === NONE) return;
    const home: [number, number] = [L.x, L.y];
    const at = L.y * b.width + L.x;
    b.s.unitAt[at] = NONE;
    this.buildThreat();
    b.s.unitAt[at] = ls;
    for (const [x, y] of this.reachable(L)) {
      b.place(ls, null, x, y);
      const d = this.danger(L, x, y);
      if (d.worst > o.hp * this.p.guard) continue;
      for (const e of unitsInRange(b.s, L, range, x, y, false)) {
        const E = this.scene.units[e];
        if (!(E.flags & UnitFlag.Visible) || this.know.protect.has(E.officer)) continue;
        const oe = b.officerOf(E);
        const dmg = physicalDamage({
          attack: attackPower(o, L.morale, b.s.items),
          defence: defencePower(oe, E.morale, b.s.items),
          attackerClass: o.cls,
          defenderClass: oe.cls,
          defenderTerrain: terrainAt(b.s, E.x, E.y),
          defenderHp: oe.hp,
          counter: false,
        });
        this.leaderKills.set(e, Math.max(this.leaderKills.get(e) ?? 0, dmg));
      }
    }
    b.place(ls, null, home[0], home[1]);
  }

  private get b() {
    return this.scene.b;
  }

  private weight(slot: number): number {
    const u = this.scene.units[slot];
    if (u.officer >= 0x100) return 0;
    const o = this.b.officerOf(u);
    if (o.level >= 99) return 0;
    return 1 + (this.p.need * (99 - o.level)) / 98;
  }

  private controllable(u: Unit): boolean {
    return u.status === Status.Field && u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted);
  }

  private enemiesOnField(): number {
    let n = 0;
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) if (this.scene.units[i].status === Status.Field) n++;
    return n;
  }

  private oursOnField(): number {
    let n = 0;
    for (let i = 0; i < PLAYER_SLOTS; i++) if (this.scene.units[i].status === Status.Field) n++;
    return n;
  }

  private killOk(target: number): boolean {
    const off = this.scene.units[target].officer;
    if (this.finishing) return this.charge() || !this.know.protect.has(off);
    if (this.know.protect.has(off)) return false;
    // regrouping: kill what comes (the leader still spared)
    if (this.regroupUntil >= this.b.info.turn + 1) return true;
    // bracing against a wave: thin it while it outnumbers us (the grinding resumes on what is left)
    if (this.bracing() && this.enemiesOnField() > this.oursOnField()) return true;
    return this.enemiesOnField() - 1 >= this.p.keep;
  }

  private deadline(): number {
    const lim = this.b.info.turnLimit;
    // the soft deadline (finish before a big wave: 하비 finished from turn 2) is gone: the waves are
    // braced for and survived while grinding (Sukwon), know.soft stays for the report
    return Math.min(lim, this.know.deadline ?? 999, this.know.endsAt ?? 999);
  }

  // ---- hold plan: form up near the start, let the enemy come, push out once the waves are broken

  private anchor: [number, number] | null = null;
  private quietTurns = 0;
  private holdBroken = false;
  private holding(): boolean {
    return (this.p.hold > 0.5 && !this.holdBroken) || this.bracing();
  }
  /** The cell the formation gathers around: the brace anchor while bracing, else the hold anchor. */
  private anchorNow(): [number, number] | null {
    return this.bracing() ? this.braceAnchor : this.anchor;
  }

  // ---- brace: a wave is coming (or units are falling): form up on defensible ground around 유비

  private waves: { turn: number; n: number; at: [number, number][] }[] | null = null;
  private braceUntil = 0;
  private braceAnchor: [number, number] | null = null;
  private regroupUntil = 0;
  private bracing(): boolean {
    const t = this.b.info.turn + 1;
    return this.braceAnchor !== null && ((this.p.brace > 0.5 && this.braceUntil >= t) || this.regroupUntil >= t);
  }
  private updateBrace() {
    if (!(this.p.brace > 0.5) || this.finishing) return;
    const b = this.b;
    const turn = b.info.turn + 1;
    const units = this.scene.units;
    if (this.waves === null) {
      this.waves = [];
      for (const e of this.know.turns) {
        if (e.turn === null || e.turn < 2) continue;
        const at: [number, number][] = [];
        for (const off of e.reinforce) {
          const i = b.slotOfOfficer(off);
          if (i === NONE || i < PLAYER_SLOTS) continue;
          const rec = this.scene.ctx.vm.state.units.find((d) => d.officer === off);
          if (rec && rec.x < b.width && rec.y < b.height) at.push([rec.x, rec.y]);
        }
        if (at.length >= 4) this.waves.push({ turn: e.turn, n: at.length, at });
      }
      if (this.waves.length) this.log?.(`brace: waves ${this.waves.map((w) => `T${w.turn}x${w.n}`).join(' ')}`);
    }
    // the latest the bracing may hold: the finish needs its turns at the end
    const cap = Math.min(b.info.turnLimit, this.know.deadline ?? 999) - this.p.finish - 4 - this.stepsLeft() * 12;
    const ahead = Math.round(0.5 + this.p.brace);
    let until = this.braceUntil;
    for (const w of this.waves) if (turn >= w.turn - ahead && turn <= w.turn) until = Math.max(until, w.turn + 2);
    const mine = units.slice(0, PLAYER_SLOTS).filter((u) => u.officer < 0x100 && u.status !== Status.Empty && u.status !== Status.Reserve);
    const ours = mine.filter((u) => u.status === Status.Field).length;
    const theirs = this.enemiesOnField();
    // a wave still heavy: keep the formation while they outnumber us and are close
    const waveOn = this.waves.some((w) => turn >= w.turn && turn <= w.turn + 6);
    if (waveOn && until === turn && this.braceAnchor && theirs >= ours * 1.5) {
      const [ax, ay] = this.braceAnchor;
      if (units.slice(PLAYER_SLOTS).some((e) => e.status === Status.Field && Math.abs(e.x - ax) + Math.abs(e.y - ay) <= 7)) until = turn + 1;
    }
    until = Math.min(until, cap);
    const was = this.bracing();
    this.braceUntil = until;
    if (until >= turn && (!was || !this.braceAnchor)) {
      this.braceAnchor = this.pickBraceAnchor();
      if (this.braceAnchor) this.log?.(`brace: T${turn}..T${until} at ${this.braceAnchor[0]},${this.braceAnchor[1]}`);
    }
  }
  /**
   * Where to brace: a cell 유비 reaches in about two turns whose surroundings are defensive terrain,
   * narrow (fewer open sides: chokepoints, map edges, rivers) and away from the enemy and the wave's
   * entry cells; healing terrain nearby counts too.
   */
  private pickBraceAnchor(): [number, number] | null {
    const b = this.b;
    const W = b.width, H = b.height;
    const ls = b.slotOfOfficer(0);
    const L = ls !== NONE ? this.scene.units[ls] : null;
    if (!L || L.status !== Status.Field) return null;
    const mt = moveTypeOf(b.s, L);
    const mp = movePoints(b.officerOf(L), b.s.items);
    const pass = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && moveCost(mt, b.s.terrain[y * W + x]) !== 0xff;
    const foes: [number, number][] = [];
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) if (e.status === Status.Field && e.officer !== 0xffff) foes.push([e.x, e.y]);
    const turn = b.info.turn + 1;
    for (const w of this.waves ?? []) if (w.turn >= turn) foes.push(...w.at);
    let best: [number, number] | null = null, bv = -1e9;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!pass(x, y)) continue;
        const d = this.pathDist([L.x, L.y], mt, x, y);
        if (d > mp * 2 + 2) continue;
        let open = 0, def = 0, cells = 0, heal = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const r = Math.abs(dx) + Math.abs(dy);
            if (r > 2 || !pass(x + dx, y + dy)) continue;
            const t = b.s.terrain[(y + dy) * W + x + dx];
            open++;
            if (r <= 1) {
              cells++;
              def += Math.min(30, terrainDefence(t));
            }
            if (t === TERRAIN_VILLAGE || t === TERRAIN_FORTRESS || t === TERRAIN_BARRACKS) heal++;
          }
        let near = 99;
        for (const [fx, fy] of foes) near = Math.min(near, Math.abs(fx - x) + Math.abs(fy - y));
        if (near <= 2) continue;
        const v = (def / Math.max(1, cells)) / 5 * this.p.terrain - 0.25 * open + heal * 1.5 + 0.5 * Math.min(near, 12) - 0.4 * Math.max(0, d - mp);
        if (v > bv) [bv, best] = [v, [x, y]];
      }
    return best;
  }
  private updateHold() {
    if (this.p.hold <= 0.5 || this.holdBroken) return;
    const b = this.b;
    const mine = this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && this.controllable(u));
    if (!this.anchor) {
      if (!mine.length) return;
      // the middle of our formation, snapped to a cell our units can stand on
      const cx = Math.round(mine.reduce((a, u) => a + u.x, 0) / mine.length), cy = Math.round(mine.reduce((a, u) => a + u.y, 0) / mine.length);
      let best: [number, number] = [mine[0].x, mine[0].y], bd = 1e9;
      for (let y = 0; y < b.height; y++)
        for (let x = 0; x < b.width; x++) {
          const t = terrainAt(b.s, x, y);
          if ([0, 1, 2, 3].every((mt) => moveCost(mt, t) === 0xff)) continue;
          const d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d < bd) [bd, best] = [d, [x, y]];
        }
      this.anchor = best;
    }
    const turn = b.info.turn + 1;
    const near = this.scene.units.slice(PLAYER_SLOTS).some((e) => e.status === Status.Field && Math.abs(e.x - this.anchor![0]) + Math.abs(e.y - this.anchor![1]) <= 7);
    this.quietTurns = near ? 0 : this.quietTurns + 1;
    // broken: the wave turn is past and nobody came near for 2 turns; or time is short for the push
    const waveDone = turn > (this.know.soft ?? 0) + 1;
    if ((waveDone && this.quietTurns >= 2) || turn >= b.info.turnLimit - 10) {
      this.holdBroken = true;
      this.log?.(`hold: pushing out at turn ${turn}`);
    }
  }

  // ---- player phase (1cb6:44de without the input loop)

  private async playerPhase() {
    const sc = this.scene;
    const b = this.b;
    this.stats.turns = b.info.turn + 1;
    // 총퇴각 is refused in formation-flag battles: no reroll there
    if (this.retreatNow && b.formation) this.retreatNow = false;
    if (this.p.native && !this.retreatNow) {
      // the computer plays our units from here on (computerPhases pass 0); units that join later
      // are handed over at the next player phase, before anything is drawn
      // the guarded officers (유비, the defeat officer) stay with the policy: the game's AI would
      // park 유비 in 대기 and walk it into the first enemy that comes in reach (거록, every try)
      for (let i = 0; i < PLAYER_SLOTS; i++) {
        const u = sc.units[i];
        if (u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted) && !this.know.guarded.has(u.officer)) u.mode = AiMode.AttackNearest;
      }
      if (!this.finishing) {
        this.finishing = true;
        this.stats.finishTurn = b.info.turn + 1;
        this.stats.finishReason = 'native';
      }
    }
    const any = sc.units.slice(0, PLAYER_SLOTS).some((u) => this.controllable(u));
    if (!any) return;
    if (b.info.turn === 0) await sc.victoryWindow(true);
    await sc.say(S.playerPhase);
    for (const u of sc.units) tryCure(b.rng, u, u.officer === 0xffff ? 0 : b.officerOf(u).lead);
    if (this.retreatNow && !b.formation) {
      // 기능 menu -> 총퇴각 -> yes (1cb6:44de battle menu item 1): the scene restarts the battle
      b.info.result = 1;
      return;
    }
    if (this.log && this.leaderSeen) {
      const ls = b.slotOfOfficer(0);
      const L = ls !== NONE ? sc.units[ls] : null;
      if (L && L.status === Status.Field) {
        const hp = b.officerOf(L).hp;
        if (hp < this.leaderSeen.hp) this.log(`  leader took ${this.leaderSeen.hp - hp} over the enemy phase (predicted worst ${Math.round(this.leaderSeen.dw)}) at ${L.x},${L.y}`);
      }
    }
    if (process.env.GRIND_TRACE_HITS) {
      const ls = b.slotOfOfficer(0);
      if (ls !== NONE) {
        const L = sc.units[ls];
        this.log?.(`  enemies near leader: ${sc.units.slice(PLAYER_SLOTS).filter((e) => e.status === Status.Field && Math.abs(e.x - L.x) + Math.abs(e.y - L.y) <= 99).map((e) => `${e.officer}@${e.x},${e.y} m${e.mode} L${this.b.officerOf(e).level} c${this.b.officerOf(e).cls} hp${this.b.officerOf(e).hp}`).join(' ')}`);
      }
    }
    this.updateHold();
    this.updateBrace();
    this.decideFinish();
    this.buildThreat();
    this.buildLeaderKills();
    // the leader moves last: the enemies' reach is then computed with the others where they ended up
    // (a unit that moves away after the leader opens a path: 거록, a reinforcement reached 유비 through it)
    const feedLast = this.p.feed > 0 && !this.finishing;
    let gained = 0;
    const done = new Set<number>();
    for (let guard = 0; guard < PLAYER_SLOTS * 2 && b.info.result === 0; guard++) {
      const order = sc.units
        .slice(0, PLAYER_SLOTS)
        .filter((u) => this.controllable(u) && !(u.flags & (UnitFlag.Acted | UnitFlag.Confused)) && !done.has(u.slot))
        .sort((x, y) => (feedLast ? (x.officer === 0 ? 1 : 0) - (y.officer === 0 ? 1 : 0) : 0) || this.weight(y.slot) - this.weight(x.slot) || x.slot - y.slot);
      const u = order[0];
      if (!u) break;
      done.add(u.slot);
      // the enemies' reach as it is now (earlier units moved or fell), with this unit lifted off
      // its cell: the cell it leaves no longer blocks them
      const at = u.y * b.width + u.x;
      b.s.unitAt[at] = NONE;
      this.buildThreat();
      b.s.unitAt[at] = u.slot;
      const act = this.bestAction(u);
      if (u.officer === 0) {
        this.leaderActed = true;
        this.leaderSeen = { hp: b.officerOf(u).hp, dw: act.danger ?? 0 };
      }
      gained += await this.execute(act);
      if (b.info.result) return;
      await sc.victoryCheck();
    }
    if (!this.finishing) {
      if (gained === 0 && b.info.turn >= 2) this.idleTurns++;
      else this.idleTurns = 0;
    }
  }

  private decideFinish() {
    if (this.finishing) return;
    const b = this.b;
    const left = this.deadline() - b.info.turn; // turns left including this one
    // each pending step (defeat X, march into an area) needs about 12 turns of the finish
    const stepTurns = this.stepsLeft() * 12;
    const deadlineHit = left <= this.p.finish + stepTurns;
    // bracing / regrouping: no early end (Sukwon: no emergency rush; the deadline still finishes the battle)
    if (this.bracing() && !deadlineHit) return;
    if (this.holding() && b.info.turnLimit - b.info.turn > this.p.finish) return;
    const needy = this.scene.units.slice(0, PLAYER_SLOTS).some((u) => u.status === Status.Field && this.weight(u.slot) > 0);
    // going badly (the leader hurt, a third of the units gone)
    // our own officers only: allied armies under the computer (거록: 공손월's men) fall without it meaning much
    const mine = this.scene.units
      .slice(0, PLAYER_SLOTS)
      .filter((u) => u.officer < 0x100 && u.status !== Status.Empty && u.status !== Status.Reserve && ((this.scene.ctx.state.officers[u.officer]?.dyn.flags ?? 1) & 0x1f) === 0);
    const gone = mine.filter((u) => u.status !== Status.Field).length;
    const leaderHurt = mine.some((u) => this.know.guarded.has(u.officer) && u.status === Status.Field && b.officerOf(u).hp * 100 < maxHp(b.officerOf(u)) * (this.p.lead ? 35 : 60));
    const losses = gone * 3 >= mine.length;
    // a survival battle (a turn event wins it before any loss by time): never charge, keep grinding
    // safely until the event; the danger costs already pull a hurt leader back
    const survive = this.know.endsAt !== null && this.know.endsAt <= Math.min(b.info.turnLimit, this.know.deadline ?? 999);
    if (survive) return;
    // before the last third, going badly means defend and regroup (Sukwon: no fast win by the
    // 총대장 alone, no emergency means): pull back around 유비 on good terrain, heal, kill what
    // comes; never head for the enemy leader or the escape cell (연주: the defensive plan charged
    // 곽도 at turn 7 from here)
    if ((leaderHurt || losses) && !deadlineHit && !this.lateThird()) {
      const turn = b.info.turn + 1;
      if (this.regroupUntil < turn) {
        this.braceAnchor = this.pickBraceAnchor();
        this.log?.(`regroup: ${leaderHurt ? 'leader hurt' : 'losses'} at turn ${turn}${this.braceAnchor ? ` around ${this.braceAnchor[0]},${this.braceAnchor[1]}` : ''}`);
      }
      this.regroupUntil = turn + 1;
      return;
    }
    if (deadlineHit || !needy || this.idleTurns >= 8 || leaderHurt || losses) {
      this.finishing = true;
      this.stats.finishTurn = b.info.turn + 1;
      this.stats.finishReason = deadlineHit ? 'deadline' : !needy ? 'done' : this.idleTurns >= 8 ? 'idle' : leaderHurt ? 'leader' : 'losses';
      this.log?.(`finish: ${this.stats.finishReason} at turn ${b.info.turn + 1} (deadline ${this.deadline()})`);
      this.stats.kept = this.scene.units.slice(PLAYER_SLOTS).filter((u) => u.status === Status.Field).map((u) => u.officer);
    }
  }

  /** The last third of the battle (turn limit, or a losing turn event before it). */
  private lateThird(): boolean {
    const lim = Math.min(this.b.info.turnLimit, this.know.deadline ?? 999);
    return (this.b.info.turn + 1) * 3 >= lim * 2;
  }

  /**
   * The finish may go for the enemy leader / the escape cell / a battle-ending event only in the
   * last third, once few enemies remain (a rout), or when the script's pending steps need the time
   * (서주 2nd); otherwise the finish routs: nearest enemies, the leader spared (Sukwon).
   */
  private charge(): boolean {
    if (!this.finishing) return false;
    if (this.lateThird() || this.enemiesOnField() <= 3) return true;
    const stepTurns = this.stepsLeft() * 12;
    return stepTurns > 0 && this.deadline() - this.b.info.turn <= this.p.finish + stepTurns;
  }


  // ---- threat map: which enemies can attack each cell next phase

  private buildThreat() {
    const b = this.b;
    const n = b.width * b.height;
    this.enemyTactics.clear();
    this.targetCount.clear();
    const rain = WEATHER_TYPE[b.info.weather] === RAIN;
    const parts: { i: number; r: { threat: number[]; tthreat: number[]; loose: number[] } }[] = [];
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const e = this.scene.units[i];
      if (e.status !== Status.Field || e.flags & UnitFlag.Confused || e.mode === AiMode.MoveNoAttack) continue;
      const oe = b.officerOf(e);
      const range = CLASS_RANGE[oe.cls];
      // damage tactics the AI could cast (d0fa/d2c4 consider every castable one)
      const tacs = castableTactics(oe, e.mp, b.learn).filter((t) => t <= 14 && !(rain && t < 5));
      this.enemyTactics.set(i, tacs);
      if (range === NONE && !tacs.length) continue;
      const mp = e.mode === AiMode.Hold ? 0 : movePoints(oe, b.s.items);
      const area = tacs.length ? Math.max(...tacs.map((t) => TACTIC_POWER[t])) | 0x80 : NONE;
      parts.push({ i, r: this.enemyReach(e, oe.cls, mp, range, area) });
    }
    // reinforcements a turn event brings in this turn or the next (거록: five units at turn 3, one
    // of them cast a 421 fire on 유비 who stood where nothing threatened him): they enter at their
    // deployment records and act in that enemy phase
    this.incoming.clear();
    const cur = b.info.turn + 1;
    for (const ev of this.know.turns) {
      if (ev.turn === null || (ev.turn !== cur && ev.turn !== cur + 1)) continue;
      for (const off of ev.reinforce) {
        const i = b.slotOfOfficer(off);
        if (i === NONE || i < PLAYER_SLOTS || this.scene.units[i].status !== Status.Reserve) continue;
        const rec = this.scene.ctx.vm.state.units.find((d) => d.officer === off);
        if (!rec || rec.x >= b.width || rec.y >= b.height) continue;
        const R = this.scene.units[i];
        const e = Object.assign(Object.create(Object.getPrototypeOf(R)) as Unit, R, { x: rec.x, y: rec.y, status: Status.Field });
        const oe = b.officerOf(e);
        const range = CLASS_RANGE[oe.cls];
        const tacs = castableTactics(oe, e.mp, b.learn).filter((t) => t <= 14 && !(rain && t < 5));
        this.enemyTactics.set(i, tacs);
        if (range === NONE && !tacs.length) continue;
        const mp = e.mode === AiMode.Hold ? 0 : movePoints(oe, b.s.items);
        const area = tacs.length ? Math.max(...tacs.map((t) => TACTIC_POWER[t])) | 0x80 : NONE;
        this.incoming.add(i);
        parts.push({ i, r: this.enemyReach(e, oe.cls, mp, range, area) });
      }
    }
    parts.sort((a, z) => a.i - z.i);
    // nothing changed since the last build (same enemies, same cached reaches): keep the maps
    const last = this.lastParts;
    if (last && last.length === parts.length && last.every((q, j) => q.i === parts[j].i && q.r === parts[j].r) && this.threat.length === n) return;
    this.lastParts = parts;
    this.threat = Array.from({ length: n }, () => []);
    this.tthreat = Array.from({ length: n }, () => []);
    this.loose = Array.from({ length: n }, () => []);
    for (const { i, r } of parts) {
      for (const k of r.threat) this.threat[k].push(i);
      for (const k of r.tthreat) this.tthreat[k].push(i);
      for (const k of r.loose) this.loose[k].push(i);
    }
  }
  private lastParts: { i: number; r: { threat: number[]; tthreat: number[]; loose: number[] } }[] | null = null;
  /** Reserve enemy slots counted as threats (they arrive by a turn event before the next enemy phase ends). */
  private incoming = new Set<number>();

  /**
   * One enemy's reach (cells it can attack / hit with a tactic / attack ignoring zones of control and
   * our other units), cached: the floods only see the units within mp+1 cells of it, so the result
   * is reused while none of those moved (most of our phase: one unit moves at a time).
   */
  private reachCache = new Map<number, { key: string; threat: number[]; tthreat: number[]; loose: number[] }>();
  private enemyReach(e: Unit, cls: number, mp: number, range: number, area: number): { threat: number[]; tthreat: number[]; loose: number[] } {
    const b = this.b;
    const W = b.width, H = b.height;
    const R = mp + 1;
    const ls = b.slotOfOfficer(0);
    const leaderAt = ls !== NONE && ls < PLAYER_SLOTS && this.scene.units[ls].status === Status.Field ? this.scene.units[ls].y * W + this.scene.units[ls].x : -1;
    // two independent 32-bit hashes of the occupied cells around it
    let h1 = 0x811c9dc5, h2 = 0x9747b28c;
    for (let y = Math.max(0, e.y - R); y <= Math.min(H - 1, e.y + R); y++)
      for (let x = Math.max(0, e.x - R); x <= Math.min(W - 1, e.x + R); x++) {
        const c = y * W + x;
        const v = b.s.unitAt[c];
        if (v === NONE) continue;
        const m = (c << 8) | v;
        h1 = Math.imul(h1 ^ m, 0x01000193);
        h2 = Math.imul(h2 ^ m, 0x5bd1e995) ^ (h2 >>> 13);
      }
    const key = `${e.x},${e.y},${mp},${range},${area},${cls},${e.flags & UnitFlag.Scripted},${leaderAt},${h1},${h2}`;
    const hit = this.reachCache.get(e.slot);
    if (hit && hit.key === key) return hit;
    const n = W * H;
    const grid = new Uint8Array(n);
    floodMove(b.s, e, [e.x, e.y], grid, { flags: 0, maxCost: mp });
    grid[e.y * W + e.x] = 0;
    const seen = new Uint8Array(n);
    const tseen = new Uint8Array(n);
    const threat: number[] = [], tthreat: number[] = [], loose: number[] = [];
    for (let c = 0; c < n; c++) {
      if (grid[c] === NONE) continue;
      const cx = c % W, cy = Math.trunc(c / W);
      if (range !== NONE)
        for (const [x, y] of rangeCells(b.s, cx, cy, range, false)) {
          const k = y * W + x;
          if (!seen[k]) {
            seen[k] = 1;
            threat.push(k);
          }
        }
      if (area !== NONE)
        for (const [x, y] of rangeCells(b.s, cx, cy, area, false)) {
          const k = y * W + x;
          if (!tseen[k]) {
            tseen[k] = 1;
            tthreat.push(k);
          }
        }
    }
    // the same reach without zones of control (our units die or move during the phase and
    // open the way: 소패, a cavalry unit through two fallen units): the leader's worst case
    // ... and through our own units too: the leader moves first, and the units that move after
    // it can open the way (거록: a reinforcement reached 유비 through a cell 관우 left)
    if (range !== NONE) {
      const lifted: number[] = [];
      for (let p = 0; p < PLAYER_SLOTS; p++) {
        const pu = this.scene.units[p];
        if (pu.status !== Status.Field || pu.officer === 0) continue;
        const k = pu.y * W + pu.x;
        if (b.s.unitAt[k] === p) {
          b.s.unitAt[k] = NONE;
          lifted.push(p);
        }
      }
      floodMove(b.s, e, [e.x, e.y], grid, { flags: 1, maxCost: mp });
      for (const p of lifted) b.s.unitAt[this.scene.units[p].y * W + this.scene.units[p].x] = p;
      grid[e.y * W + e.x] = 0;
      const lseen = new Uint8Array(n);
      for (let c = 0; c < n; c++) {
        if (grid[c] === NONE) continue;
        for (const [x, y] of rangeCells(b.s, c % W, Math.trunc(c / W), range, false)) {
          const k = y * W + x;
          if (!lseen[k]) {
            lseen[k] = 1;
            loose.push(k);
          }
        }
      }
    }
    const out = { key, threat, tthreat, loose };
    this.reachCache.set(e.slot, out);
    return out;
  }
  private loose: number[][] = [];
  private tthreat: number[][] = [];
  private enemyTactics = new Map<number, number[]>();

  /** Expected damage of enemy E's best damage tactic on u standing at (x, y). */
  private tacticOn(E: Unit, u: Unit, x: number, y: number): number {
    const b = this.b;
    const oe = b.officerOf(E);
    const o = b.officerOf(u);
    const terrain = terrainAt(b.s, x, y);
    let best = 0;
    for (const t of this.enemyTactics.get(E.slot) ?? []) {
      const e = Math.trunc(t / 5);
      if (!tacticTerrainOk(e, terrain)) continue;
      const [lo, hi] = this.tacticDamageRange(oe, o, e, TACTIC_POWER[t], terrain);
      const pc = tacticSkill(oe);
      let pt = tacticSkill(o) >> 2;
      if (resistsTactics(o.cls)) pt <<= 1;
      const hit = pc > 0 ? Math.max(0, pc - 1 - pt) / pc : 0;
      best = Math.max(best, ((lo + hi) / 2) * hit);
    }
    return best;
  }

  /** Our units each enemy can reach this phase (its attention is shared between them). */
  private targetsOf(e: number): number {
    let n = this.targetCount.get(e);
    if (n === undefined) {
      n = 0;
      const b = this.b;
      for (let i = 0; i < PLAYER_SLOTS; i++) {
        const u = this.scene.units[i];
        if (u.status === Status.Field && (this.threat[u.y * b.width + u.x] ?? []).includes(e)) n++;
      }
      this.targetCount.set(e, n);
    }
    return n;
  }
  private targetCount = new Map<number, number>();

  /**
   * Danger at (x, y) for u: `worst` = every enemy that can reach the cell hits u (used for the
   * leader), `expected` = each enemy's damage shared between the units it can reach.
   */
  private danger(u: Unit, x: number, y: number): { worst: number; expected: number; n?: number } {
    const b = this.b;
    let worst = 0, expected = 0, n = 0;
    const k = y * b.width + x;
    const here = this.threat[u.y * b.width + u.x] ?? [];
    const phys = this.threat[k] ?? [];
    const tac = this.tthreat[k] ?? [];
    const guarded = this.know.guarded.has(u.officer);
    const loose = guarded ? (this.loose[k] ?? []) : [];
    for (const e of new Set([...phys, ...tac, ...loose])) {
      const E = this.scene.units[e];
      if (!phys.includes(e) && !tac.includes(e)) {
        // reachable only through our lines: counts for the worst case alone
        if ((E.status === Status.Field || this.incoming.has(e)) && E.officer !== 0xffff) {
          worst += this.hitOn(E, u, x, y);
          n++;
        }
        continue;
      }
      // the map is built at the start of the phase: units removed since then no longer threaten
      if ((E.status !== Status.Field && !this.incoming.has(e)) || E.officer === 0xffff) continue;
      const d = Math.max(phys.includes(e) ? this.hitOn(E, u, x, y) : 0, tac.includes(e) ? this.tacticOn(E, u, x, y) : 0);
      worst += d;
      if (d > 0) n++;
      expected += d / Math.max(1, this.targetsOf(e) + (here.includes(e) ? 0 : 1));
    }
    return { worst, expected, n };
  }

  // ---- grinding phase: the best (cell, action) for one unit

  private reachable(u: Unit): [number, number][] {
    const b = this.b;
    const o = b.officerOf(u);
    const grid = b.s.grid;
    if (u.flags & UnitFlag.Moved) return [[u.x, u.y]];
    floodMove(b.s, u, [u.x, u.y], grid, { flags: 0, maxCost: movePoints(o, b.s.items) });
    const out: [number, number][] = [[u.x, u.y]];
    for (let c = 0; c < grid.length; c++) {
      if (grid[c] === NONE) continue;
      const x = c % b.width, y = Math.trunc(c / b.width);
      if ((x !== u.x || y !== u.y) && b.s.unitAt[c] === NONE) out.push([x, y]);
    }
    return out;
  }

  /** Steps from (x, y) to `goal` over cells this move type can enter (terrain only; cached). */
  private distMaps = new Map<string, Uint16Array>();
  private pathDist(goal: [number, number], mt: number, x: number, y: number): number {
    const b = this.b;
    const W = b.width, H = b.height;
    const key = `${goal[0]},${goal[1]},${mt}`;
    let m = this.distMaps.get(key);
    if (!m) {
      m = new Uint16Array(W * H).fill(0xffff);
      const q: number[] = [goal[1] * W + goal[0]];
      m[q[0]] = 0;
      for (let h = 0; h < q.length; h++) {
        const c = q[h], cx = c % W, cy = (c - cx) / W;
        for (const [nx, ny] of [[cx, cy - 1], [cx + 1, cy], [cx, cy + 1], [cx - 1, cy]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (m[k] !== 0xffff || moveCost(mt, b.s.terrain[k]) === 0xff) continue;
          m[k] = m[c] + 1;
          q.push(k);
        }
      }
      this.distMaps.set(key, m);
    }
    const d = m[y * W + x];
    return d === 0xffff ? Math.abs(goal[0] - x) + Math.abs(goal[1] - y) + 20 : d;
  }

  /**
   * Terrain worth of a cell (verified tables: TERRAIN_DEFENCE cuts physical damage taken by that
   * percent, defender side only — 1cb6:df14 has no attacker-terrain term; villages and fortresses
   * restore troops and morale at the turn start, barracks troops): a defensive cell counts where
   * enemies can reach it, a healing cell counts by the troops missing.
   */
  private terrainValue(u: Unit, x: number, y: number, hp: number, max: number): number {
    const b = this.b;
    const t = terrainAt(b.s, x, y);
    const k = y * b.width + x;
    const def = terrainDefence(t);
    const exposed = (this.threat[k]?.length ?? 0) + (this.tthreat[k]?.length ?? 0) > 0;
    let v = def < 100 ? (def / 10) * (exposed ? 1 : 0.2) : 0;
    if (t === TERRAIN_VILLAGE || t === TERRAIN_FORTRESS || t === TERRAIN_BARRACKS) v += (1 - hp / Math.max(1, max)) * 8;
    return v * this.p.terrain * (this.know.guarded.has(u.officer) ? 1.5 : 1);
  }

  /** Group number of the script's current group (only its records can fire). */
  private activeGroup(): number {
    const st = this.scene.ctx.vm.state;
    if (st.block !== this.know.block) return -1;
    return this.know.stage?.blocks[st.block]?.records[st.group]?.group ?? -1;
  }

  /** The step the script waits for now (서주 2nd: defeat 89, then 유비 into the south area), or null. */
  private step(): BattleKnowledge['steps'][number] | null {
    if (!this.know.steps.length) return null;
    const g = this.activeGroup();
    return this.know.steps.find((s) => s.group === g) ?? null;
  }

  /** Win cells that can fire now: a pending arrival step stands in for them. */
  private wcells(): BattleKnowledge['winCells'] {
    const st = this.step();
    if (!st) return this.know.winCells;
    return st.trigger === 12 ? [] : [{ officer: st.officer, x0: st.x0, y0: st.y0, x1: st.x1, y1: st.y1 }];
  }

  private wadj(): BattleKnowledge['winAdj'] {
    return this.step() ? [] : this.know.winAdj;
  }

  /** The officer whose defeat moves the battle on now: a pending defeat step, else the victory officer. */
  private victoryNow(): number | null {
    const st = this.step();
    if (st) return st.trigger === 12 ? st.officer : null;
    return this.know.victory;
  }

  /** Steps still to do (each needs time in the finish). */
  private stepsLeft(): number {
    if (!this.know.steps.length) return 0;
    const g = this.activeGroup();
    return this.know.steps.filter((s) => s.group >= g).length;
  }

  private winCell(u: Unit, x: number, y: number): boolean {
    for (const w of this.wcells())
      if ((w.officer === u.officer || w.officer === 0x400) && x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1) return true;
    return false;
  }

  /** Where a unit heads in the finish: its winning cell, else the victory officer, else null (nearest enemy). */
  private goalFor(u: Unit): [number, number] | null {
    const w = this.wcells().find((c) => c.officer === u.officer || c.officer === 0x400);
    if (w) return [(w.x0 + w.x1) >> 1, (w.y0 + w.y1) >> 1];
    const adj = this.wadj().find((a) => a.actor === u.officer || a.actor === 0x400);
    const target = adj ? adj.other : this.victoryNow();
    if (target !== null && target !== undefined) {
      const s = this.b.slotOfOfficer(target);
      if (s !== NONE && this.scene.units[s].status === Status.Field) return [this.scene.units[s].x, this.scene.units[s].y];
    }
    return null;
  }

  /** An adjacency event that ends the battle fires when this unit acts next to its partner. */
  private winAdjacent(u: Unit, x: number, y: number): boolean {
    for (const a of this.wadj()) {
      if (a.actor !== u.officer && !(a.actor === 0x400 && u.slot < PLAYER_SLOTS)) continue;
      const s = this.b.slotOfOfficer(a.other);
      if (s === NONE || this.scene.units[s].status !== Status.Field) continue;
      const o = this.scene.units[s];
      if (Math.abs(o.x - x) + Math.abs(o.y - y) === 1) return true;
    }
    return false;
  }

  private bestAction(u: Unit): Action {
    const b = this.b;
    const fin = this.finishing;
    const slot = u.slot;
    const o = b.officerOf(u);
    // the leader's levels keep every later battle winnable: its exp counts double
    const w = this.weight(slot) * (this.know.guarded.has(u.officer) ? 2 : 1);
    const hp = Math.max(1, o.hp);
    const max = maxHp(o);
    const guarded = this.know.guarded.has(u.officer);
    const home: [number, number] = [u.x, u.y];
    const turnsLeft = Math.max(1, this.deadline() - b.info.turn);
    // what the unit is still worth in this battle: its exp to come (losing it ends that)
    const future = 10 + w * Math.min(turnsLeft, 10) * 4;
    // the leader heads only for a winning cell of its own (거록: 유비 reaching the gate wins)
    // ... unless the walk there is a long way round (하비: (0,2) lies past a river, the only way runs
    // through the enemy's lines; the old win by defeating everyone is the safer one)
    const own = this.wcells().find((c) => {
      if (c.officer !== u.officer) return false;
      if (!guarded) return true;
      const cx = (c.x0 + c.x1) >> 1, cy = (c.y0 + c.y1) >> 1;
      return this.pathDist([cx, cy], moveTypeOf(b.s, u), u.x, u.y) <= (Math.abs(cx - u.x) + Math.abs(cy - u.y)) * 1.5 + 6;
    });
    // ... or an enemy it wins by acting next to (태산: 유비 persuading 이명)
    const ownAdj = this.wadj().find((a) => a.actor === u.officer);
    const adjAt = ownAdj ? (() => { const s2 = b.slotOfOfficer(ownAdj.other); return s2 !== NONE && this.scene.units[s2].status === Status.Field ? ([this.scene.units[s2].x, this.scene.units[s2].y] as [number, number]) : null; })() : null;
    const chg = this.charge();
    const goal = !fin || !chg ? null : guarded ? (own ? ([(own.x0 + own.x1) >> 1, (own.y0 + own.y1) >> 1] as [number, number]) : adjAt) : this.goalFor(u);
    const vNow = this.victoryNow();
    const vslot = vNow !== null ? b.slotOfOfficer(vNow) : NONE;
    let best: Action = { slot, x: u.x, y: u.y, kind: 'wait', target: NONE, tactic: NONE, value: -1e9, exp: 0, lethal: false };
    const enemies = this.scene.units.filter((e) => e.slot >= PLAYER_SLOTS && e.status === Status.Field);
    const tactics = castableTactics(o, u.mp, b.learn).filter((t) => !(t < 5 && WEATHER_TYPE[b.info.weather] === RAIN));
    const held = u.officer < 0x100 ? b.stateOfficer(u).dyn.items.map((id, index) => ({ id, index })).filter((e) => e.id !== 0xff) : [];
    // danger is the sum over every enemy that can reach the cell (an overestimate: they also have
    // other targets), so the cost rises smoothly from half the troops to one and a half times them
    // expected damage drives the cost for everyone; the leader (유비 / the defeat officer) losing
    // loses the battle, so for it the worst case counts
    // level-aware: a leader weaker than the enemies around keeps a wider margin (worst case at most
    // half its troops at half their level), the full `guard` once it has caught up
    const guardEff = guarded ? this.p.guard * Math.min(1, Math.max(0.5, o.level / Math.max(1, this.enemyLevel()))) : this.p.guard;
    const deathCost = (d: { worst: number; expected: number; n?: number }, p: number) => {
      const r = d.expected / hp;
      const lethal = Math.min(1.5, Math.max(0, r - 0.6));
      let c = this.p.risk * (future * (fin ? 0.3 : 1) * lethal + (w + 0.5) * 4 * Math.min(r, 1) ** 2);
      if (guarded) {
        const rw = d.worst / hp;
        c += 10000 * Math.min(1, Math.max(0, rw - guardEff) * 3) + 100 * Math.min(rw, 1.5) ** 2 + this.p.safe * 60 * (d.n ?? 0);
      }
      return p * c;
    };
    const lslot = b.slotOfOfficer(0);
    const leaderPos: [number, number] | null = lslot !== NONE && lslot !== slot && this.scene.units[lslot].status === Status.Field ? [this.scene.units[lslot].x, this.scene.units[lslot].y] : null;
    // a healer with MP walks towards the most hurt ally, so heals (useless on full troops) stay possible
    let healGoal: [number, number] | null = null;
    if (!fin && tactics.some((t) => t >= 21 && t <= 35)) {
      let worst = 0.85;
      // 격려/응원/고무 (21..23, 30..32) restore morale: a unit below 100 morale is a target too
      const moraleHeals = tactics.some((t) => (t >= 21 && t <= 23) || (t >= 27 && t <= 29) || (t >= 30 && t <= 32));
      for (const a of this.scene.units.slice(0, PLAYER_SLOTS)) {
        if (a.slot === slot || a.status !== Status.Field) continue;
        const oa = b.officerOf(a);
        const f = Math.min(oa.hp / Math.max(1, maxHp(oa)), moraleHeals ? a.morale / 100 + 0.1 : 9);
        if (f < worst) {
          worst = f;
          healGoal = [a.x, a.y];
        }
      }
    }
    const plus = (d: { worst: number; expected: number; n?: number }, extra: number) => ({ worst: d.worst + extra, expected: d.expected + extra, n: d.n });
    // the best script gain open to this unit (duel partner, persuasion target, bonus cell): walk to it
    const gg = !fin ? this.gainGoal(u) : null;
    const feeding = !fin && !guarded && !this.leaderActed && this.leaderKills.size > 0;
    for (const [x, y] of this.reachable(u)) {
      if (!chg && (this.winCell(u, x, y) || this.winAdjacent(u, x, y))) continue;
      // stand on the cell for the evaluation (range shapes read the unit map)
      b.place(slot, null, x, y);
      const dang = this.danger(u, x, y);
      let base = -deathCost(dang, 1);
      const t = terrainAt(b.s, x, y);
      if (hp < max * this.p.retreat && (t === 8 || t === 13 || t === 14)) base += 6;
      // stand next to allies: fewer sides open to the enemy
      let mates = 0;
      for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
        if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
        const v = unitAt(b.s, nx, ny);
        if (v !== NONE && v !== slot && sideOf(v)) mates++;
      }
      base += mates * (guarded ? 1.5 : 0.5);
      // let a weakened enemy get away to heal (village, its own healers, regeneration) and come back
      // for more hits and tactics: do not stand next to it while grinding
      if (!fin)
        for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
          if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
          const v = unitAt(b.s, nx, ny);
          if (v === NONE || v < PLAYER_SLOTS) continue;
          const E = this.scene.units[v];
          if (E.status !== Status.Field || E.officer === 0xffff) continue;
          const oe = b.officerOf(E);
          if (oe.hp * 10 < maxHp(oe) * 3) base -= this.p.conserve * 4;
        }
      let dist = 99;
      // walking distance over passable terrain (a manhattan pull leaves units stuck behind walls
      // and rivers: 서주 2nd, three units waited 20 turns in the corner north of 차주)
      if (goal) dist = this.pathDist(goal, moveTypeOf(b.s, u), x, y);
      else for (const e of enemies) dist = Math.min(dist, Math.abs(e.x - x) + Math.abs(e.y - y));
      // nothing gained for 2+ turns (the enemy sits and waits): march on it instead of idling
      const anc = !fin && this.holding() ? this.anchorNow() : null;
      if (anc) {
        // stay in formation around the anchor: the enemy comes to us; 유비 at its middle
        const da = this.bracing() ? this.pathDist(anc, moveTypeOf(b.s, u), x, y) : Math.abs(anc[0] - x) + Math.abs(anc[1] - y);
        base -= 4 * Math.max(0, da - (guarded ? 1 : 2));
        // bracing: tight around 유비 (the enemy finds no gap to reach him)
        if (this.bracing() && !guarded && leaderPos) base -= 1.5 * Math.max(0, Math.abs(leaderPos[0] - x) + Math.abs(leaderPos[1] - y) - 2);
      } else {
        base -= (fin && goal ? 3 : this.idleTurns >= 2 ? Math.max(1.5, this.p.approach * 0.3) : this.p.approach * 0.3) * Math.min(dist, 40);
        // the leader levels like the others: it walks up to the fight instead of waiting at the back
        if (!fin && guarded && this.p.lead && !goal) base -= this.p.lead * Math.max(0, dist - 1);
      }
      if (!fin && !guarded && leaderPos) base -= this.p.escort * Math.max(0, Math.abs(leaderPos[0] - x) + Math.abs(leaderPos[1] - y) - 3);
      if (healGoal) base -= this.p.heal * 0.4 * Math.max(0, Math.abs(healGoal[0] - x) + Math.abs(healGoal[1] - y) - 1);
      if (this.p.band) base += this.bandValue(u, x, y, w);
      if (this.p.terrain) base += this.terrainValue(u, x, y, hp, max);
      if (gg) base -= Math.min(3, gg.value / 100) * Math.max(0, Math.abs(gg.at[0] - x) + Math.abs(gg.at[1] - y) - 1);
      base += this.gainAt(u, x, y) * (fin ? 0.5 : 1);
      if (chg && this.winAdjacent(u, x, y)) base += 400;
      // a treasure cell not yet stepped on this battle (its event gives an item once)
      if (!fin && this.know.treasure.some((t) => t.x === x && t.y === y && (t.officer === u.officer || t.officer === 0x400) && !this.looted.has(y * b.width + x))) base += 40;
      if (base > best.value) best = { slot, x, y, kind: 'wait', target: NONE, tactic: NONE, value: base, exp: 0, lethal: false, danger: dang.worst };
      // physical attacks
      const range = CLASS_RANGE[o.cls];
      if (range !== NONE)
        for (const d of unitsInRange(b.s, u, range, x, y, false)) {
          const D = this.scene.units[d];
          if (!(D.flags & UnitFlag.Visible)) continue;
          const od = b.officerOf(D);
          const dmg = physicalDamage({
            attack: attackPower(o, u.morale, b.s.items),
            defence: defencePower(od, D.morale, b.s.items),
            attackerClass: o.cls,
            defenderClass: od.cls,
            defenderTerrain: terrainAt(b.s, D.x, D.y),
            defenderHp: od.hp,
            counter: false,
          });
          const lethal = dmg >= od.hp;
          // the leader may always take a kill (except a protected enemy): a kill is its safest exp
          // (the target cannot hit back) and a low-level leader is the usual reason battles are lost
          const kg = lethal ? this.killGain(D.officer) : 0;
          if (lethal && !kg && !this.killOk(d) && !(guarded && !this.know.protect.has(D.officer))) continue;
          const hit = combatExp(true, o.level, od.level, false, d);
          const all = combatExp(true, o.level, od.level, lethal, d);
          let v = base;
          if (fin) v += w * all + (chg && d === vslot ? 500 : 0) + (lethal ? 60 : 0) + (dmg * 30) / Math.max(1, maxHp(od)) - (guarded && !lethal && d !== vslot ? 40 : 0);
          else v += w * (hit + (all - hit) * this.p.kill) - (this.p.conserve * ((lethal ? od.hp : dmg) * 10)) / Math.max(1, maxHp(od));
          v += kg;
          // leave the leader a safe finishing blow: soften what it can kill from a guarded cell, and do not take it
          if (feeding && this.leaderKills.has(d)) {
            if (lethal) v -= this.p.feed * 30;
            else if (od.hp - dmg <= (this.leaderKills.get(d) ?? 0)) v += this.p.feed * 40;
          }
          // a dead target does not hit back: its threat leaves this cell
          if (lethal && (this.threat[y * b.width + x] ?? []).includes(d)) {
            const h = this.hitOn(D, u, x, y);
            v += deathCost(dang, 1) - deathCost({ worst: Math.max(0, dang.worst - h), expected: Math.max(0, dang.expected - h / Math.max(1, this.targetsOf(d))) }, 1);
          }
          // counterattack (1cb6:e42e): attack types 0/2/5 against a type-0 class
          const at = CLASS_ATTACK_TYPE[o.cls];
          if (!lethal && CLASS_ATTACK_TYPE[od.cls] === 0 && (at === 0 || at === 2 || at === 5)) {
            const cd = physicalDamage({
              attack: attackPower(od, D.morale, b.s.items),
              defence: defencePower(o, u.morale, b.s.items),
              attackerClass: od.cls,
              defenderClass: o.cls,
              defenderTerrain: t,
              defenderHp: 0xffff,
              counter: true,
            });
            const pc = Math.min(1, od.force / 150);
            v -= deathCost(plus(dang, cd), pc) - deathCost(dang, pc);
          }
          if (v > best.value) best = { slot, x, y, kind: 'attack', target: d, tactic: NONE, value: v, exp: all, lethal };
        }
      // tactics
      for (const tc of tactics) {
        const a = this.tacticValue(u, tc, x, y, w);
        if (!a) continue;
        let v = base + a.value - this.p.mp * TACTIC_MP[tc];
        if (chg && a.target === vslot && tc <= 14) v += 300;
        if (v > best.value) best = { slot, x, y, kind: 'tactic', target: a.target, tactic: tc, value: v, exp: a.exp, lethal: a.lethal };
      }
      // items (ab86): promotions, troop heals, bombs
      for (const it of held) {
        const a = this.itemValue(u, it.id, x, y, w, guarded);
        if (!a) continue;
        let v = base + a.value;
        if (chg && a.target === vslot) v += 300;
        if (v > best.value) best = { slot, x, y, kind: 'item', target: a.target, tactic: NONE, item: it, value: v, exp: a.exp, lethal: a.lethal };
      }
    }
    b.place(slot, null, home[0], home[1]);
    return best;
  }

  /**
   * Value of using item `id` from (x, y) (1cb6:ab86): a promotion as soon as it is allowed (class
   * and level), a troop heal on a badly hurt ally (the leader first), a bomb like a hit. Items give
   * no exp of their own (a bomb hit does, through e91a).
   */
  private itemValue(u: Unit, id: number, x: number, y: number, w: number, guarded: boolean): { value: number; target: number; exp: number; lethal: boolean } | null {
    const b = this.b;
    const o = b.officerOf(u);
    void guarded;
    if (id >= 0x13 && id <= 0x1a) {
      const k = id - 0x13;
      if (o.cls !== PROMOTE_FROM[k] || o.level < PROMOTE_LEVEL[k]) return null;
      return { value: 600, target: NONE, exp: 0, lethal: false };
    }
    if ((id >= 0x1e && id <= 0x20) || (id >= 0x34 && id <= 0x36)) {
      const power = id >= 0x34 ? id - 0x34 : id % 3;
      let best: { value: number; target: number; exp: number; lethal: boolean } | null = null;
      for (const s of unitsInRange(b.s, u, power | 0x80, x, y, true)) {
        const T = this.scene.units[s];
        const ot = b.officerOf(T);
        const f = ot.hp / Math.max(1, maxHp(ot));
        const lead = this.know.guarded.has(T.officer);
        if (f >= (lead ? 0.75 : 0.45)) continue;
        const v = (1 - f) * (lead ? 400 : 60) - 8;
        if (!best || v > best.value) best = { value: v, target: s, exp: 0, lethal: false };
      }
      return best;
    }
    if (id >= 0x22 && id <= 0x2a) {
      const element = 2 - Math.trunc((id - 0x22) / 3);
      const power = (id - 0x22) % 3;
      if (element === 0 && WEATHER_TYPE[b.info.weather] === RAIN) return null;
      let best: { value: number; target: number; exp: number; lethal: boolean } | null = null;
      for (const d of unitsInRange(b.s, u, power | 0x80, x, y, false)) {
        const D = this.scene.units[d];
        if (!(D.flags & UnitFlag.Visible) || !tacticTerrainOk(element, terrainAt(b.s, D.x, D.y))) continue;
        const od = b.officerOf(D);
        const [lo] = this.tacticDamageRange({ level: o.level, intel: o.intel }, { level: od.level, intel: od.intel, cls: od.cls }, element, power, terrainAt(b.s, D.x, D.y));
        const lethal = lo >= od.hp;
        if (lethal && !this.killOk(d)) continue;
        const ex = combatExp(true, o.level, od.level, lethal, d);
        const v = (this.finishing ? ex + (lo * 30) / Math.max(1, maxHp(od)) : w * ex - (this.p.conserve * Math.min(lo, od.hp) * 10) / Math.max(1, maxHp(od))) - 6;
        if (!best || v > best.value) best = { value: v, target: d, exp: ex, lethal };
      }
      return best;
    }
    return null;
  }

  /** Physical damage enemy E would do to u standing at (x, y). */
  private hitOn(E: Unit, u: Unit, x: number, y: number): number {
    const b = this.b;
    const oe = b.officerOf(E);
    const o = b.officerOf(u);
    return physicalDamage({
      attack: attackPower(oe, E.morale, b.s.items),
      defence: defencePower(o, u.morale, b.s.items),
      attackerClass: oe.cls,
      defenderClass: o.cls,
      defenderTerrain: terrainAt(b.s, x, y),
      defenderHp: 0xffff,
      counter: false,
    });
  }

  /** Damage bounds of a tactic hit (1cb6:df14 kind 2 without the rolls). */
  private tacticDamageRange(c: { level: number; intel: number }, t: { level: number; intel: number; cls: number }, element: number, power: number, terr: number): [number, number] {
    const b = this.b;
    const u16 = (v: number) => v & 0xffff;
    let dmg = u16((Math.trunc(u16(c.level * c.intel) / 50) + c.intel) * 2 - Math.trunc(u16(t.level * t.intel) / 50) - t.intel + (power * 4 + element + 2) * 100);
    if (resistsTactics(t.cls)) dmg = Math.trunc(dmg / 2);
    if ((element === 0 && terr === TERRAIN_FOREST) || (element === 1 && WEATHER_TYPE[b.info.weather] === RAIN)) dmg += Math.trunc(dmg / 4);
    const extra = Math.trunc((dmg & 0xffff) / 50);
    return [dmg, dmg + Math.max(0, extra - 1)];
  }

  private tacticValue(u: Unit, tc: number, x: number, y: number, w: number): { value: number; target: number; exp: number; lethal: boolean } | null {
    const b = this.b;
    const o = b.officerOf(u);
    const p = TACTIC_POWER[tc];
    if (tc <= 14) {
      const e = Math.trunc(tc / 5);
      let best: { value: number; target: number; exp: number; lethal: boolean } | null = null;
      for (const d of unitsInRange(b.s, u, p | 0x80, x, y, false)) {
        const D = this.scene.units[d];
        if (!(D.flags & UnitFlag.Visible) || !tacticTerrainOk(e, terrainAt(b.s, D.x, D.y))) continue;
        const hits = [d];
        if (tc % 5 >= 3)
          for (const [nx, ny] of [[D.x, D.y - 1], [D.x + 1, D.y], [D.x, D.y + 1], [D.x - 1, D.y]]) {
            if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height || !tacticTerrainOk(e, terrainAt(b.s, nx, ny))) continue;
            const v = unitAt(b.s, nx, ny);
            if (v !== NONE && !sideOf(v)) hits.push(v);
          }
        let exp = 0, burn = 0, ok = true, lethal = false;
        let left = this.enemiesOnField();
        for (const h of hits) {
          const H = this.scene.units[h];
          const oh = b.officerOf(H);
          const [lo, hi] = this.tacticDamageRange(o, oh, e, p, terrainAt(b.s, H.x, H.y));
          if (hi >= oh.hp) {
            if (this.finishing || (!this.know.protect.has(H.officer) && left - 1 >= this.p.keep)) {
              left--;
              lethal = true;
              if (lo >= oh.hp) exp += combatExp(true, o.level, oh.level, true, h) - combatExp(true, o.level, oh.level, false, h);
            } else ok = false;
          }
          exp += combatExp(true, o.level, oh.level, false, h);
          burn += (Math.min(oh.hp, (lo + hi) / 2) * 10) / Math.max(1, maxHp(oh));
        }
        if (!ok) continue;
        const value = w * exp * this.p.tactic - this.p.conserve * burn;
        if (!best || value > best.value) best = { value, target: d, exp, lethal };
      }
      return best;
    }
    if (tc <= 20) {
      for (const d of unitsInRange(b.s, u, p | 0x80, x, y, false)) {
        const D = this.scene.units[d];
        if (!(D.flags & UnitFlag.Visible)) continue;
        const od = b.officerOf(D);
        const affected = [d];
        if (tc === 17)
          for (const [nx, ny] of [[D.x, D.y - 1], [D.x + 1, D.y], [D.x, D.y + 1], [D.x - 1, D.y]]) {
            if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
            const v = unitAt(b.s, nx, ny);
            if (v !== NONE && !sideOf(v)) affected.push(v);
          }
        // a confused unit at morale 0 leaves the field (1cb6:a0d0): that is a defeat without kill exp
        const leaves = (s: number, drop: number) => {
          const U = this.scene.units[s];
          return U.morale - drop <= 0 && (tc <= 17 || (U.flags & UnitFlag.Confused) !== 0 || U.morale - drop < 30);
        };
        let bad = false;
        for (const s of affected) {
          const drop = tc >= 18 ? moraleDrop(o, b.officerOf(this.scene.units[s]), p, this.scene.units[s].morale) : 0;
          if (leaves(s, drop) && !this.killOk(s)) bad = true;
        }
        if (bad) continue;
        void od;
        return { value: w * 8 * this.p.control, target: d, exp: 8, lethal: false };
      }
      return null;
    }
    const bonus = tc <= 29 && (o.cls === 12 || o.cls === 18) ? 12 : 8;
    if (tc <= 29) {
      const kind = healKind(tc);
      let pick = NONE, worst = 2;
      for (const s of unitsInRange(b.s, u, p | 0x80, x, y, true)) {
        const T = this.scene.units[s];
        const ot = b.officerOf(T);
        if (!healUseful(kind, ot, T.morale, (T.flags & UnitFlag.Confused) !== 0)) continue;
        const f = ot.hp / Math.max(1, maxHp(ot)) + T.morale / 1000;
        if (f < worst) {
          worst = f;
          pick = s;
        }
      }
      if (pick === NONE) return null;
      // the leader first: its troops are the battle
      const lead = this.know.guarded.has(this.scene.units[pick].officer) ? this.p.safe * 30 * Math.max(0, 1 - worst) : 0;
      return { value: w * bonus * this.p.heal + lead, target: pick, exp: bonus, lethal: false };
    }
    const list = unitsInRange(b.s, u, ((tc - 30) % 3) | 0x80, x, y, true);
    if (!list.length) return null;
    return { value: w * 8 * this.p.heal, target: NONE, exp: 8, lethal: false };
  }

  // ---- execution (1cb6:a474 for the player: move d972, then the command, then 8ad2)

  private async execute(a: Action): Promise<number> {
    const sc = this.scene;
    const b = this.b;
    const u = sc.units[a.slot];
    const officer = u.officer;
    const o = b.officerOf(u);
    const before = o.level * 100 + o.exp;
    if (a.x !== u.x || a.y !== u.y) {
      b.place(a.slot, null, a.x, a.y);
      u.flags |= UnitFlag.Moved;
    }
    if (this.know.treasure.some((t) => t.x === a.x && t.y === a.y)) this.looted.add(a.y * b.width + a.x);
    const st = this.stats.byOfficer.get(officer) ?? { hits: 0, kills: 0, tactics: 0, heals: 0 };
    this.stats.byOfficer.set(officer, st);
    let kind = a.kind;
    this.log?.(`T${b.info.turn + 1}${this.finishing ? 'F' : ''} ${o.level}:${officer}@${u.x},${u.y} ${a.kind} ${a.tactic === NONE ? '' : 't' + a.tactic} ${a.target === NONE ? '' : '->' + sc.units[a.target].officer + '(' + b.officerOf(sc.units[a.target]).hp + ')'} v=${a.value.toFixed(1)} hp=${o.hp} dw=${a.danger ?? ''}`);
    if (a.kind === 'attack') {
      const t = sc.units[a.target];
      const alive = () => t.status === Status.Field;
      await sc.doAttack(a.slot, a.target);
      if (!alive()) this.stats.actions.kill++;
      this.stats.actions.attack++;
    } else if (a.kind === 'item' && a.item) {
      const promo = a.item.id >= 0x13 && a.item.id <= 0x1a;
      const ok = await sc.useItem(a.slot, a.item.id, a.item.index, a.target);
      if (!ok) kind = 'wait';
      else {
        this.stats.actions.item = (this.stats.actions.item ?? 0) + 1;
        if (promo) this.stats.actions.promoted = (this.stats.actions.promoted ?? 0) + 1;
      }
    } else if (a.kind === 'tactic') {
      const ok = await sc.castFlow(a.slot, a.tactic, false, a.target);
      if (!ok) kind = 'wait';
      else {
        this.stats.tactics.set(a.tactic, (this.stats.tactics.get(a.tactic) ?? 0) + 1);
        if (a.tactic >= 21) this.stats.actions.heal++;
        else this.stats.actions.tactic++;
      }
    }
    if (kind === 'wait') this.stats.actions.wait++;
    u.flags |= UnitFlag.Acted;
    const gained = o.level * 100 + o.exp - before;
    if (a.kind === 'attack' || a.kind === 'item') {
      if (a.lethal) st.kills += Math.max(0, gained);
      else st.hits += Math.max(0, gained);
    } else if (kind === 'tactic') {
      if (a.tactic >= 21) st.heals += Math.max(0, gained);
      else st.tactics += Math.max(0, gained);
    }
    if (b.info.result === 0 && u.status === Status.Field) await sc.unitEvents(a.slot);
    return Math.max(0, gained);
  }
}

/** The player units' officers of a scene that gain exp (named, below 99). */
export function needyCount(scene: BattleScene): number {
  return scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < 0x100 && scene.b.officerOf(u).level < 99).length;
}

export { tacticSkill };
