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
import { S } from '../../native/battle/strings';
import { floodMove, rangeCells, terrainAt, unitAt, unitsInRange, sideOf } from '../../engine/battle/hex';
import {
  attackPower,
  castableTactics,
  combatExp,
  defencePower,
  maxHp,
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
  CLASS_RANGE,
  NONE,
  PLAYER_SLOTS,
  RAIN,
  Status,
  TACTIC_MP,
  TACTIC_POWER,
  TERRAIN_FOREST,
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
  { key: 'finish', min: 2, max: 16, def: 7, int: true },
  { key: 'tactic', min: 0.2, max: 2.5, def: 1 },
  { key: 'heal', min: 0.2, max: 2.5, def: 1 },
  { key: 'kill', min: 0, max: 2, def: 0.6 },
  { key: 'conserve', min: 0, max: 3, def: 0.8 },
  { key: 'mp', min: 0, max: 1.5, def: 0.2 },
  { key: 'risk', min: 0, max: 4, def: 1.2 },
  { key: 'retreat', min: 0, max: 0.7, def: 0.35 },
  { key: 'approach', min: 0, max: 3, def: 0.3 },
  { key: 'strong', min: 0, max: 8, def: 3, int: true },
  { key: 'guard', min: 0.3, max: 1.3, def: 0.8 },
  { key: 'escort', min: 0, max: 3, def: 0.6 },
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
  winCells: { officer: number; x0: number; y0: number; x1: number; y1: number }[];
  /** Adjacency events (trigger 4) that end the battle: `actor` acting next to `other`. */
  winAdj: { actor: number; other: number }[];
  /** A turn event ends the game at this turn (deadline before the limit). */
  deadline: number | null;
  /** A turn event wins the battle at this turn (survive until then: 소패). */
  endsAt: number | null;
}

function winning(stage: Stage, code: number, victory: number | null): boolean {
  const cmds = recordCommands(stage, code);
  // the victory officer taken off the field (a duel: REMOVE) wins through its defeat event
  if (victory !== null && cmds.some((c) => c.name === 'REMOVE' && (c as unknown as { officer: number }).officer === victory)) return true;
  const i = cmds.findIndex((c) => c.name === 'BATTLE_END');
  if (i < 0) return cmds.some((c) => c.name === 'MAP');
  return cmds[i + 1]?.name !== 'GAME_OVER';
}

/** Reads the current block's records: what wins, what loses, what to keep alive. */
export function analyseBattle(stage: Stage, script: ScriptState): BattleKnowledge {
  const k: BattleKnowledge = { victory: null, protect: new Set(), guarded: new Set([0]), winCells: [], winAdj: [], deadline: null, endsAt: null };
  if (script.victory.enabled) {
    k.victory = script.victory.officer;
    k.protect.add(script.victory.officer);
  }
  if (script.defeat.enabled) k.guarded.add(script.defeat.officer);
  for (const r of stage.blocks[script.block]?.records ?? []) {
    const cmds = recordCommands(stage, r.code);
    if (r.trigger === 12 && winning(stage, r.code, k.victory)) k.protect.add(r.p1);
    if ((r.trigger === 6 || r.trigger === 11) && winning(stage, r.code, k.victory) && !cmds.some((c) => c.name === 'GAME_OVER')) {
      const x0 = r.p2 & 0xff, y0 = r.p2 >> 8;
      const [x1, y1] = r.trigger === 6 ? [x0, y0] : [r.p3 & 0xff, r.p3 >> 8];
      k.winCells.push({ officer: r.p1, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
    }
    if (r.trigger === 4 && winning(stage, r.code, k.victory)) k.winAdj.push({ actor: r.p1, other: r.p2 });
    if (r.trigger === 9 && r.p1 > 0 && cmds.some((c) => c.name === 'GAME_OVER')) k.deadline = Math.min(k.deadline ?? 999, r.p1);
    else if (r.trigger === 9 && r.p1 > 0 && cmds.some((c) => c.name === 'BATTLE_END') && winning(stage, r.code, k.victory)) k.endsAt = Math.min(k.endsAt ?? 999, r.p1);
  }
  return k;
}

// ---------------------------------------------------------------- formation

/**
 * Picks for a FORMATION: the officers already placed by the setup, 유비, then `strong` of the
 * highest-level officers (to keep battles winnable), then the lowest levels below 99.
 */
export function pickFormation(state: GameState, fixed: number[], free: number, strong: number): number[] {
  const faction = state.officers[0].dyn.flags & 0x1f;
  const pool = state.officers
    .map((o, i) => ({ i, lv: o.dyn.level, ok: (o.dyn.flags & 0x80) !== 0 && (o.dyn.flags & 0x1f) === faction && i < 0x100 }))
    .filter((o) => o.ok && !fixed.includes(o.i));
  const picks: number[] = [];
  const take = (i: number) => {
    if (picks.length < free && !picks.includes(i)) picks.push(i);
  };
  if (!fixed.includes(0) && pool.some((o) => o.i === 0)) take(0);
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
  actions: { attack: number; kill: number; tactic: number; heal: number; wait: number };
  /** Officer -> exp gained per kind. */
  byOfficer: Map<number, { hits: number; kills: number; tactics: number; heals: number }>;
  /** Enemy officers alive when the finish began (the ones kept for grinding). */
  kept: number[];
  /** Tactics cast (tactic id -> count). */
  tactics: Map<number, number>;
}

interface Action {
  slot: number;
  x: number;
  y: number;
  kind: 'attack' | 'tactic' | 'wait';
  target: number;
  tactic: number;
  value: number;
  exp: number;
  lethal: boolean;
  danger?: number;
}

// ---------------------------------------------------------------- the policy

export class GrindPolicy {
  readonly stats: GrindStats = {
    turns: 0,
    finishTurn: null,
    actions: { attack: 0, kill: 0, tactic: 0, heal: 0, wait: 0 },
    byOfficer: new Map(),
    kept: [],
    tactics: new Map(),
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
    know.winCells = know.winCells.filter((c) => {
      for (let y = c.y0; y <= c.y1; y++)
        for (let x = c.x0; x <= c.x1; x++) {
          if (x >= f.width || y >= f.height) continue;
          const t = terrainAt(f, x, y);
          for (let mt = 0; mt < 4; mt++) if (moveCost(mt, t) !== 0xff) return true;
        }
      return false;
    });
  }

  /** Retreat (총퇴각, result 1) at the first player phase instead of playing. */
  retreatNow = false;

  /** Replaces the scene's player phase. Call from BattleExtras.afterSetup. */
  install(): void {
    const sc = this.scene as unknown as Record<string, unknown>;
    sc.playerPhase = () => this.playerPhase();
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

  private killOk(target: number): boolean {
    if (this.finishing) return true;
    const off = this.scene.units[target].officer;
    if (this.know.protect.has(off)) return false;
    return this.enemiesOnField() - 1 >= this.p.keep;
  }

  private deadline(): number {
    const lim = this.b.info.turnLimit;
    return Math.min(lim, this.know.deadline ?? 999, this.know.endsAt ?? 999);
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
      for (let i = 0; i < PLAYER_SLOTS; i++) {
        const u = sc.units[i];
        if (u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted)) u.mode = this.know.guarded.has(u.officer) ? AiMode.Wait : AiMode.AttackNearest;
      }
      return;
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
    this.decideFinish();
    this.buildThreat();
    let gained = 0;
    const done = new Set<number>();
    for (let guard = 0; guard < PLAYER_SLOTS * 2 && b.info.result === 0; guard++) {
      const order = sc.units
        .slice(0, PLAYER_SLOTS)
        .filter((u) => this.controllable(u) && !(u.flags & (UnitFlag.Acted | UnitFlag.Confused)) && !done.has(u.slot))
        .sort((x, y) => this.weight(y.slot) - this.weight(x.slot) || x.slot - y.slot);
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
    const needy = this.scene.units.slice(0, PLAYER_SLOTS).some((u) => u.status === Status.Field && this.weight(u.slot) > 0);
    // going badly (the leader hurt, a third of the units gone): stop grinding and win now
    // our own officers only: allied armies under the computer (거록: 공손월's men) fall without it meaning much
    const mine = this.scene.units
      .slice(0, PLAYER_SLOTS)
      .filter((u) => u.officer < 0x100 && u.status !== Status.Empty && u.status !== Status.Reserve && ((this.scene.ctx.state.officers[u.officer]?.dyn.flags ?? 1) & 0x1f) === 0);
    const gone = mine.filter((u) => u.status !== Status.Field).length;
    const leaderHurt = mine.some((u) => this.know.guarded.has(u.officer) && u.status === Status.Field && b.officerOf(u).hp * 10 < maxHp(b.officerOf(u)) * 6);
    // a survival battle (a turn event wins it before any loss by time): never charge, keep grinding
    // safely until the event; the danger costs already pull a hurt leader back
    const survive = this.know.endsAt !== null && this.know.endsAt <= Math.min(b.info.turnLimit, this.know.deadline ?? 999);
    if (survive) return;
    if (left <= this.p.finish || !needy || this.idleTurns >= 8 || leaderHurt || gone * 3 >= mine.length) {
      this.finishing = true;
      this.stats.finishTurn = b.info.turn + 1;
      this.stats.finishReason = left <= this.p.finish ? 'deadline' : !needy ? 'done' : this.idleTurns >= 8 ? 'idle' : leaderHurt ? 'leader' : 'losses';
      this.log?.(`finish: ${this.stats.finishReason} at turn ${b.info.turn + 1} (deadline ${this.deadline()})`);
      this.stats.kept = this.scene.units.slice(PLAYER_SLOTS).filter((u) => u.status === Status.Field).map((u) => u.officer);
    }
  }

  // ---- threat map: which enemies can attack each cell next phase

  private buildThreat() {
    const b = this.b;
    const n = b.width * b.height;
    this.threat = Array.from({ length: n }, () => []);
    this.tthreat = Array.from({ length: n }, () => []);
    this.loose = Array.from({ length: n }, () => []);
    this.enemyTactics.clear();
    this.targetCount.clear();
    const grid = new Uint8Array(n);
    const rain = WEATHER_TYPE[b.info.weather] === RAIN;
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
      grid.fill(NONE);
      floodMove(b.s, e, [e.x, e.y], grid, { flags: 0, maxCost: mp });
      grid[e.y * b.width + e.x] = 0;
      const seen = new Uint8Array(n);
      const tseen = new Uint8Array(n);
      const area = tacs.length ? Math.max(...tacs.map((t) => TACTIC_POWER[t])) | 0x80 : NONE;
      for (let c = 0; c < n; c++) {
        if (grid[c] === NONE) continue;
        const cx = c % b.width, cy = Math.trunc(c / b.width);
        if (range !== NONE)
          for (const [x, y] of rangeCells(b.s, cx, cy, range, false)) {
            const k = y * b.width + x;
            if (!seen[k]) {
              seen[k] = 1;
              this.threat[k].push(i);
            }
          }
        if (area !== NONE)
          for (const [x, y] of rangeCells(b.s, cx, cy, area, false)) {
            const k = y * b.width + x;
            if (!tseen[k]) {
              tseen[k] = 1;
              this.tthreat[k].push(i);
            }
          }
      }
      // the same reach without zones of control (our units die or move during the phase and
      // open the way: 소패, a cavalry unit through two fallen units): the leader's worst case
      if (range === NONE) continue;
      floodMove(b.s, e, [e.x, e.y], grid, { flags: 1, maxCost: mp });
      grid[e.y * b.width + e.x] = 0;
      const lseen = new Uint8Array(n);
      for (let c = 0; c < n; c++) {
        if (grid[c] === NONE) continue;
        for (const [x, y] of rangeCells(b.s, c % b.width, Math.trunc(c / b.width), range, false)) {
          const k = y * b.width + x;
          if (!lseen[k]) {
            lseen[k] = 1;
            this.loose[k].push(i);
          }
        }
      }
    }
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
  private danger(u: Unit, x: number, y: number): { worst: number; expected: number } {
    const b = this.b;
    let worst = 0, expected = 0;
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
        if (E.status === Status.Field && E.officer !== 0xffff) worst += this.hitOn(E, u, x, y);
        continue;
      }
      // the map is built at the start of the phase: units removed since then no longer threaten
      if (E.status !== Status.Field || E.officer === 0xffff) continue;
      const d = Math.max(phys.includes(e) ? this.hitOn(E, u, x, y) : 0, tac.includes(e) ? this.tacticOn(E, u, x, y) : 0);
      worst += d;
      expected += d / Math.max(1, this.targetsOf(e) + (here.includes(e) ? 0 : 1));
    }
    return { worst, expected };
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

  private winCell(u: Unit, x: number, y: number): boolean {
    for (const w of this.know.winCells)
      if ((w.officer === u.officer || w.officer === 0x400) && x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1) return true;
    return false;
  }

  /** Where a unit heads in the finish: its winning cell, else the victory officer, else null (nearest enemy). */
  private goalFor(u: Unit): [number, number] | null {
    const w = this.know.winCells.find((c) => c.officer === u.officer || c.officer === 0x400);
    if (w) return [(w.x0 + w.x1) >> 1, (w.y0 + w.y1) >> 1];
    const adj = this.know.winAdj.find((a) => a.actor === u.officer || a.actor === 0x400);
    const target = adj ? adj.other : this.know.victory;
    if (target !== null && target !== undefined) {
      const s = this.b.slotOfOfficer(target);
      if (s !== NONE && this.scene.units[s].status === Status.Field) return [this.scene.units[s].x, this.scene.units[s].y];
    }
    return null;
  }

  /** An adjacency event that ends the battle fires when this unit acts next to its partner. */
  private winAdjacent(u: Unit, x: number, y: number): boolean {
    for (const a of this.know.winAdj) {
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
    const own = this.know.winCells.find((c) => c.officer === u.officer);
    const goal = !fin ? null : guarded ? (own ? ([(own.x0 + own.x1) >> 1, (own.y0 + own.y1) >> 1] as [number, number]) : null) : this.goalFor(u);
    const vslot = this.know.victory !== null ? b.slotOfOfficer(this.know.victory) : NONE;
    let best: Action = { slot, x: u.x, y: u.y, kind: 'wait', target: NONE, tactic: NONE, value: -1e9, exp: 0, lethal: false };
    const enemies = this.scene.units.filter((e) => e.slot >= PLAYER_SLOTS && e.status === Status.Field);
    const tactics = castableTactics(o, u.mp, b.learn).filter((t) => !(t < 5 && WEATHER_TYPE[b.info.weather] === RAIN));
    // danger is the sum over every enemy that can reach the cell (an overestimate: they also have
    // other targets), so the cost rises smoothly from half the troops to one and a half times them
    // expected damage drives the cost for everyone; the leader (유비 / the defeat officer) losing
    // loses the battle, so for it the worst case counts
    const deathCost = (d: { worst: number; expected: number }, p: number) => {
      const r = d.expected / hp;
      const lethal = Math.min(1.5, Math.max(0, r - 0.6));
      let c = this.p.risk * (future * (fin ? 0.3 : 1) * lethal + (w + 0.5) * 4 * Math.min(r, 1) ** 2);
      if (guarded) {
        const rw = d.worst / hp;
        c += 10000 * Math.min(1, Math.max(0, rw - this.p.guard) * 3) + 100 * Math.min(rw, 1.5) ** 2;
      }
      return p * c;
    };
    const lslot = b.slotOfOfficer(0);
    const leaderPos: [number, number] | null = lslot !== NONE && lslot !== slot && this.scene.units[lslot].status === Status.Field ? [this.scene.units[lslot].x, this.scene.units[lslot].y] : null;
    // a healer with MP walks towards the most hurt ally, so heals (useless on full troops) stay possible
    let healGoal: [number, number] | null = null;
    if (!fin && tactics.some((t) => t >= 21 && t <= 35)) {
      let worst = 0.85;
      for (const a of this.scene.units.slice(0, PLAYER_SLOTS)) {
        if (a.slot === slot || a.status !== Status.Field) continue;
        const oa = b.officerOf(a);
        const f = oa.hp / Math.max(1, maxHp(oa));
        if (f < worst) {
          worst = f;
          healGoal = [a.x, a.y];
        }
      }
    }
    const plus = (d: { worst: number; expected: number }, extra: number) => ({ worst: d.worst + extra, expected: d.expected + extra });
    for (const [x, y] of this.reachable(u)) {
      if (!fin && (this.winCell(u, x, y) || this.winAdjacent(u, x, y))) continue;
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
      let dist = 99;
      if (goal) dist = Math.abs(goal[0] - x) + Math.abs(goal[1] - y);
      else for (const e of enemies) dist = Math.min(dist, Math.abs(e.x - x) + Math.abs(e.y - y));
      // nothing gained for 2+ turns (the enemy sits and waits): march on it instead of idling
      base -= (fin && goal ? 3 : this.idleTurns >= 2 ? Math.max(1.5, this.p.approach * 0.3) : this.p.approach * 0.3) * Math.min(dist, 40);
      if (!fin && !guarded && leaderPos) base -= this.p.escort * Math.max(0, Math.abs(leaderPos[0] - x) + Math.abs(leaderPos[1] - y) - 3);
      if (healGoal) base -= this.p.heal * 0.4 * Math.max(0, Math.abs(healGoal[0] - x) + Math.abs(healGoal[1] - y) - 1);
      if (fin && this.winAdjacent(u, x, y)) base += 400;
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
          if (lethal && !this.killOk(d) && !(guarded && !this.know.protect.has(D.officer))) continue;
          const hit = combatExp(true, o.level, od.level, false, d);
          const all = combatExp(true, o.level, od.level, lethal, d);
          let v = base;
          if (fin) v += w * all + (d === vslot ? 500 : 0) + (lethal ? 60 : 0) + (dmg * 30) / Math.max(1, maxHp(od)) - (guarded && !lethal && d !== vslot ? 40 : 0);
          else v += w * (hit + (all - hit) * this.p.kill) - (this.p.conserve * ((lethal ? od.hp : dmg) * 10)) / Math.max(1, maxHp(od));
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
        if (fin && a.target === vslot && tc <= 14) v += 300;
        if (v > best.value) best = { slot, x, y, kind: 'tactic', target: a.target, tactic: tc, value: v, exp: a.exp, lethal: a.lethal };
      }
    }
    b.place(slot, null, home[0], home[1]);
    return best;
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
        return { value: w * 8 * this.p.tactic, target: d, exp: 8, lethal: false };
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
      return { value: w * bonus * this.p.heal, target: pick, exp: bonus, lethal: false };
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
    if (a.kind === 'attack') {
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
