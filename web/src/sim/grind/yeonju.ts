// Grinding simulator: the 연주 escape plan (GrindParams.yjEscape). 연주 (ch2 stage 0 block 8, campaign
// battle 16): our party starts at the north-west, 조운 joins at (29,7), and the field is full of
// hunters that outpace everyone but 유비 on the eastern terrain (type 11 costs cavalry 2). Holding to
// the turn limit was not found at the levels the party arrives with (perfect-information beams held
// to turn ~25 at best), so Sukwon approved, for this battle only, the early escape: 유비 on (3,19)
// ends the battle as a win, around turn 15-17. Every other battle keeps the full-turn rule.
//
// The plan (found with scratch scripts, 21/21 over seeds 0-6 from three campaign carries):
//   1. turns 1-8: 유비 walks fixed waypoints east then south around the hunters (WAYPOINTS, each with
//      an escort mode); the others follow, fight what threatens him and farm what lies on their way;
//   2. from turn 9: each player phase picks 유비's cell, his action and the escort mode by rollouts:
//      every option is played on the live battle (from a save) with the enemy's reply and one more
//      turn, under a few RNG seeds of the search's own (never the game's coming draws), and scored by
//      the escape progress, 유비's troops, the party alive and the enemies near him.
// Escorts are greedy per unit: the best (cell, action) of damage / kill / confusion / heal / item
// value less the steps lost on the way to the aim cell (no idling: a hit on the way is always taken).

import type { BattleScene } from '../../native/battle/scene';
import type { GrindPolicy } from './policy';
import { floodMove, rangeCells, unitsInRange } from '../../engine/battle/hex';
import { attackPower, castableTactics, defencePower, maxHp, movePoints, physicalDamage, tacticSkill, tryCure } from '../../engine/battle/rules';
import { AiMode, CLASS_MOVE_TYPE, CLASS_RANGE, DIRS, NONE, PLAYER_SLOTS, Status, TACTIC_MP, TACTIC_POWER, UnitFlag, moveCost, resistsTactics, type Unit } from '../../engine/battle/types';
import { S } from '../../native/battle/strings';
import { mixSeed, restoreScene, saveScene } from './search';

/** 연주: chapter 2 stage 0 block 8. */
export function isYeonjuAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 2 && stage === 0 && block === 8;
}

/** 유비's cell per turn (1..8) and the escort mode: east along row 5, then south around the hunters. */
export const YJ_WAYPOINTS: readonly (readonly [number, number, number])[] = [
  [14, 5, 1], [18, 5, 0], [22, 5, 1], [25, 6, 0], [24, 9, 0], [23, 12, 0], [20, 13, 1], [20, 15, 1],
];
/** The escape cell. */
export const YJ_GOAL: readonly [number, number] = [3, 19];
/** The southern group (저수 and the units with him) that blocks the corridor to the goal. */
const SOUTH = new Set([50, 294, 259, 311, 256, 336]);

/** Escort modes: how far ahead of 유비 the others aim, the pull to the aim and the threat weights. */
const EM = [
  { ahead: 4, follow: 30, threatW: 200, confW: 1, hunterHit: 0, aimSouth: 0 },
  { ahead: 0, follow: 60, threatW: 400, confW: 2, hunterHit: 0, aimSouth: 0 },
  { ahead: 4, follow: 30, threatW: 300, confW: 1, hunterHit: 1, aimSouth: 1 },
];

interface Choice { lx: number; ly: number; la: number; em: number }

export interface YeonjuOptions {
  /** RNG samples per option. */
  samples: number;
  /** Turns per rollout (1: our phase and the enemy's reply; 2: one more turn with the first option). */
  depth: number;
}

type Pos = [number, number];
interface Best { v: number; x: number; y: number; k: 'wait' | 'atk' | 'tac' | 'item'; t?: Unit; tac?: number; id?: number }

export class YeonjuEscape {
  log: ((s: string) => void) | null = null;
  constructor(
    readonly sc: BattleScene,
    readonly policy: GrindPolicy,
    readonly o: YeonjuOptions,
  ) {}

  install(): void {
    (this.sc as unknown as Record<string, unknown>).playerPhase = () => this.playerPhase();
  }

  get b() { return this.sc.b; }
  get W() { return this.b.width; }
  get H() { return this.b.height; }
  get turn() { return this.b.info.turn + 1; }
  private alive(u: Unit) { return u.status === Status.Field && u.officer !== 0xffff; }
  private ours(): Unit[] { return this.sc.units.slice(0, PLAYER_SLOTS).filter((u) => this.alive(u)); }
  private ctrl(): Unit[] { return this.ours().filter((u) => u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted)); }
  private foes(): Unit[] { return this.sc.units.slice(PLAYER_SLOTS).filter((u) => this.alive(u)); }
  private off(u: Unit) { return this.b.officerOf(u); }
  private hp(u: Unit) { return this.off(u).hp; }
  private maxHp(u: Unit) { return maxHp(this.off(u)); }
  private ter(x: number, y: number) { return this.b.s.terrain[y * this.W + x]; }
  private leader(): Unit | null {
    const s = this.b.slotOfOfficer(0);
    if (s === NONE) return null;
    const u = this.sc.units[s];
    return this.alive(u) ? u : null;
  }
  private mv(u: Unit) { return movePoints(this.off(u), this.b.s.items); }
  private reach(u: Unit): Pos[] {
    if (u.flags & UnitFlag.Moved) return [[u.x, u.y]];
    const grid = new Uint8Array(this.W * this.H);
    floodMove(this.b.s, u, [u.x, u.y], grid, { flags: 0, maxCost: this.mv(u) });
    const out: Pos[] = [[u.x, u.y]];
    for (let c = 0; c < grid.length; c++) {
      if (grid[c] === NONE) continue;
      const x = c % this.W, y = Math.trunc(c / this.W);
      if ((x !== u.x || y !== u.y) && this.b.s.unitAt[c] === NONE) out.push([x, y]);
    }
    return out;
  }
  private targetsFrom(u: Unit, x: number, y: number): Unit[] {
    const r = CLASS_RANGE[this.off(u).cls];
    if (r === NONE) return [];
    return unitsInRange(this.b.s, u, r, x, y, false).map((s) => this.sc.units[s]);
  }
  private dmgAt(a: Unit, t: Unit, tx: number, ty: number, hp = 99999): number {
    const oa = this.off(a), ot = this.off(t), items = this.b.s.items;
    return physicalDamage({ attack: attackPower(oa, a.morale, items), defence: defencePower(ot, t.morale, items), attackerClass: oa.cls, defenderClass: ot.cls, defenderTerrain: this.ter(tx, ty), defenderHp: hp, counter: false });
  }
  private dmg(a: Unit, t: Unit) { return this.dmgAt(a, t, t.x, t.y, this.hp(t)); }
  private tactics(u: Unit): number[] { return castableTactics(this.off(u), u.mp, this.b.learn); }
  private tacticTargets(u: Unit, t: number, x: number, y: number): Unit[] {
    return unitsInRange(this.b.s, u, TACTIC_POWER[t] | 0x80, x, y, t >= 21).map((s) => this.sc.units[s]);
  }
  /** Chance that 거짓정보 (15) from cu confuses tu. */
  private confP(cu: Unit, tu: Unit): number {
    const pc = tacticSkill(this.off(cu));
    let pt = Math.trunc(tacticSkill(this.off(tu)) / 2);
    if (resistsTactics(this.off(tu).cls)) pt += pt;
    return Math.max(0, (pc - 1 - pt) / pc);
  }

  // ---- actions (as the player's commands: move, then attack / tactic / item / wait)

  private place(u: Unit, x: number, y: number) {
    if (x !== u.x || y !== u.y) {
      this.b.place(u.slot, null, x, y);
      u.flags |= UnitFlag.Moved;
    }
  }
  private async done(u: Unit) {
    u.flags |= UnitFlag.Acted;
    if (this.b.info.result === 0 && u.status === Status.Field) await this.sc.unitEvents(u.slot);
  }
  private async attack(u: Unit, x: number, y: number, t: Unit) {
    this.place(u, x, y);
    this.log?.(`T${this.turn} ${u.officer}@${x},${y} atk ${t.officer}(${this.hp(t)})`);
    await this.sc.doAttack(u.slot, t.slot);
    await this.done(u);
  }
  private async cast(u: Unit, x: number, y: number, tac: number, t: Unit) {
    this.place(u, x, y);
    this.log?.(`T${this.turn} ${u.officer}@${x},${y} tac${tac} -> ${t.officer}`);
    await this.sc.castFlow(u.slot, tac, false, t.slot);
    await this.done(u);
  }
  private async item(u: Unit, x: number, y: number, id: number, t: Unit) {
    this.place(u, x, y);
    this.log?.(`T${this.turn} ${u.officer}@${x},${y} item${id} -> ${t.officer}`);
    await this.sc.useItem(u.slot, id, this.b.stateOfficer(u).dyn.items.indexOf(id), t.slot);
    await this.done(u);
  }
  private async wait(u: Unit, x: number, y: number) {
    this.place(u, x, y);
    await this.done(u);
  }

  // ---- maps

  /** Walking distance (terrain only) to `goal` for move type mt. */
  private distMap(goal: readonly [number, number], mt: number): Uint16Array {
    const W = this.W, H = this.H;
    const d = new Uint16Array(W * H).fill(65535);
    const g = goal[1] * W + goal[0];
    d[g] = 0;
    const buckets: number[][] = [[g]];
    for (let cost = 0; cost < buckets.length; cost++) {
      for (const i of buckets[cost] ?? []) {
        if (d[i] !== cost) continue;
        const x = i % W, y = Math.trunc(i / W);
        const mc = moveCost(mt, this.ter(x, y));
        if (mc === 255) continue;
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (moveCost(mt, this.ter(nx, ny)) === 255) continue;
          const ni = ny * W + nx, nd = cost + mc;
          if (nd < d[ni]) {
            d[ni] = nd;
            (buckets[nd] ??= []).push(ni);
          }
        }
      }
    }
    return d;
  }
  /** Per enemy (not confused), the cells it can attack next phase with the current layout. */
  private enemyHits(): Map<number, Set<number>> {
    const out = new Map<number, Set<number>>();
    const grid = new Uint8Array(this.W * this.H);
    for (const e of this.foes()) {
      if (e.flags & UnitFlag.Confused) continue;
      const o = this.off(e);
      const r = CLASS_RANGE[o.cls];
      if (r === NONE || e.mode === AiMode.MoveNoAttack) continue;
      const s = new Set<number>();
      if (e.mode === AiMode.Hold) {
        for (const [cx, cy] of rangeCells(this.b.s, e.x, e.y, r)) s.add(cy * this.W + cx);
        out.set(e.slot, s);
        continue;
      }
      floodMove(this.b.s, e, [e.x, e.y], grid, { flags: 0, maxCost: movePoints(o, this.b.s.items) });
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === NONE) continue;
        if (this.b.s.unitAt[i] !== NONE && i !== e.y * this.W + e.x) continue;
        for (const [cx, cy] of rangeCells(this.b.s, i % this.W, Math.trunc(i / this.W), r)) s.add(cy * this.W + cx);
      }
      out.set(e.slot, s);
    }
    return out;
  }

  // ---- one player phase

  async playerPhase() {
    const sc = this.sc, b = this.b;
    if (b.info.turn === 0) this.log?.(`연주 escape: waypoints for ${YJ_WAYPOINTS.length} turns, then rollouts (${this.o.samples} samples, depth ${this.o.depth}) to ${YJ_GOAL}`);
    if (!this.ctrl().length) return;
    if (b.info.turn === 0) await sc.victoryWindow(true);
    await sc.say(S.playerPhase);
    for (const u of sc.units) tryCure(b.rng, u, u.officer === 0xffff ? 0 : b.officerOf(u).lead);
    // the search's rerolls (총퇴각 at the first phase, as GrindPolicy does; refused in formation battles)
    if (this.policy.retreatNow && !b.formation) {
      b.info.result = 1;
      return;
    }
    this.policy.stats.turns = b.info.turn + 1;
    const t0 = b.info.turn;
    const L = this.leader();
    if (!L) return;
    if (t0 < YJ_WAYPOINTS.length) {
      const [x, y, em] = YJ_WAYPOINTS[t0];
      const D = this.distMap([x, y], 0);
      let bc = this.reach(L)[0];
      for (const cl of this.reach(L)) if (D[cl[1] * this.W + cl[0]] < D[bc[1] * this.W + bc[0]]) bc = cl;
      await this.doChoice({ lx: bc[0], ly: bc[1], la: 0, em });
      return;
    }
    const save = saveScene(sc, [this.policy]);
    const log = this.log;
    this.log = null;
    const opts = this.leaderOptions(6, 3, true);
    const vals: number[] = [];
    try {
      for (const ch of opts) {
        let v = 0;
        for (let s = 0; s < this.o.samples; s++) {
          restoreScene(sc, save);
          b.rng.seed = mixSeed(t0 * 977 + s * 131 + 7, 4242);
          await this.doChoice(ch);
          await this.finishTurn();
          for (let d = 1; d < this.o.depth && b.info.result === 0; d++) {
            if (!this.leader()) break;
            const next = this.leaderOptions(1, 0, false)[0];
            await this.prelude();
            await this.doChoice({ ...next, em: ch.em });
            await this.finishTurn();
          }
          v += this.score();
        }
        vals.push(v / this.o.samples);
      }
    } finally {
      restoreScene(sc, save);
      this.log = log;
    }
    let bi = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] > vals[bi]) bi = i;
    this.log?.(`T${this.turn} pick ${JSON.stringify(opts[bi])} ${vals[bi].toFixed(0)}`);
    await this.doChoice(opts[bi]);
  }

  /** The rollout's player-phase prelude (the message and the confusion cures). */
  private async prelude() {
    const b = this.b;
    await this.sc.say(S.playerPhase);
    for (const u of this.sc.units) tryCure(b.rng, u, u.officer === 0xffff ? 0 : b.officerOf(u).lead);
  }

  /** The rest of a rollout turn: the enemy's phases, the next turn's start (as BattleScene.battle/turn). */
  private async finishTurn() {
    const sc = this.sc, b = this.b;
    if (b.info.result === 0) await (sc as unknown as { computerPhases(): Promise<void> }).computerPhases();
    if (b.info.result !== 0) return;
    b.info.turn++;
    if (b.info.turn >= b.info.turnLimit) {
      b.info.result = 3;
      return;
    }
    b.stepWeather();
    await sc.eventLoop({ type: 'turn', turn: b.info.turn + 1 });
    if (b.info.result !== 0) return;
    for (let i = 0; i < sc.units.length; i++) {
      sc.units[i].flags &= ~(UnitFlag.Moved | UnitFlag.Acted);
      if (i < PLAYER_SLOTS) sc.regen(i);
    }
    await sc.eventLoop(null);
  }

  private score(): number {
    const b = this.b;
    if (b.info.result === 2) return 1e7;
    const L = this.leader();
    if (!L || b.info.result === 3) return -1e9 + b.info.turn * 1e6;
    const D = this.distMap(YJ_GOAL, 0);
    let v = -Math.min(90, D[L.y * this.W + L.x]) * 60;
    v += (this.hp(L) / this.maxHp(L)) * 1500;
    for (const u of this.ours()) if (u.officer !== 0) v += 150 + this.hp(u) * 0.2;
    const DL = this.distMap([L.x, L.y], 0);
    for (const e of this.foes()) {
      const d = DL[e.y * this.W + e.x];
      if (d <= 6) v -= ((60 * (7 - d)) / 3) * (e.flags & UnitFlag.Confused ? 0.3 : 1);
    }
    return v;
  }

  /** 유비's options: the cells nearest the goal and the safest, each with every escort mode and his actions. */
  private leaderOptions(nLead: number, nSafe: number, lacts: boolean): Choice[] {
    const L = this.leader()!;
    const D = this.distMap(YJ_GOAL, 0);
    const hits = this.enemyHits();
    const cells = this.reach(L).map(([x, y]) => {
      const i = y * this.W + x;
      let dang = 0;
      for (const [s, cs] of hits) if (cs.has(i)) dang += this.dmgAt(this.sc.units[s], L, x, y);
      return { x, y, d: D[i], dang, s: -D[i] * 100 - dang * 0.5 };
    });
    cells.sort((p, q) => q.s - p.s);
    const pick = cells.slice(0, nLead);
    for (const s of [...cells].sort((p, q) => p.dang - q.dang || p.d - q.d).slice(0, nSafe)) if (!pick.includes(s)) pick.push(s);
    const out: Choice[] = [];
    const hasConf = this.tactics(L).includes(15);
    const confItem = this.off(L).items.some((id) => id >= 0x2b && id <= 0x2d);
    for (const cl of pick)
      for (let em = 0; em < EM.length; em++) {
        out.push({ lx: cl.x, ly: cl.y, la: 0, em });
        if (!lacts) continue;
        if (this.targetsFrom(L, cl.x, cl.y).length) out.push({ lx: cl.x, ly: cl.y, la: 1, em });
        else if (hasConf && this.tacticTargets(L, 15, cl.x, cl.y).length) out.push({ lx: cl.x, ly: cl.y, la: 2, em });
        if (this.hp(L) < this.maxHp(L) * 0.55) out.push({ lx: cl.x, ly: cl.y, la: 3, em });
        if (confItem && this.tacticTargets(L, 15, cl.x, cl.y).length) out.push({ lx: cl.x, ly: cl.y, la: 4, em });
      }
    return out;
  }

  private async doChoice(ch: Choice) {
    await this.promote();
    await this.leaderAct(ch);
    if (this.b.info.result) return;
    await this.escorts(ch.em);
  }

  /** Promotion items are used where no enemy can hit the unit next phase (any cell on turns 1-2). */
  private async promote() {
    for (const u of this.ctrl()) {
      if (u.flags & UnitFlag.Acted) continue;
      const o = this.off(u);
      for (const id of o.items) {
        if (id < 0x13 || id > 0x1a) continue;
        const k = id - 0x13;
        if (o.cls !== [0, 1, 3, 4, 6, 7, 9, 10][k] || o.level < [15, 30, 15, 30, 15, 30, 15, 30][k]) continue;
        let hit = false;
        for (const [, cs] of this.enemyHits()) if (cs.has(u.y * this.W + u.x)) hit = true;
        if (hit && this.turn > 2) continue;
        await this.item(u, u.x, u.y, id, u);
        break;
      }
    }
  }

  private async leaderAct(ch: Choice) {
    const L = this.leader();
    if (!L || L.flags & UnitFlag.Acted) return;
    const cells = this.reach(L);
    const [x, y] = cells.find(([cx, cy]) => cx === ch.lx && cy === ch.ly) ?? cells[0];
    if (ch.la === 1) {
      let bt: Unit | null = null, bd = -1;
      for (const t of this.targetsFrom(L, x, y)) {
        const d = this.dmg(L, t) + (t.officer === 92 ? 1000 : 0);
        if (d > bd) { bd = d; bt = t; }
      }
      if (bt) return this.attack(L, x, y, bt);
    } else if (ch.la === 2 && this.tactics(L).includes(15)) {
      let bt: Unit | null = null, bp = 0;
      for (const t of this.tacticTargets(L, 15, x, y)) {
        if (t.flags & UnitFlag.Confused) continue;
        const p = this.confP(L, t);
        if (p > bp) { bp = p; bt = t; }
      }
      if (bt) return this.cast(L, x, y, 15, bt);
    } else if (ch.la === 4) {
      const ci = this.off(L).items.find((id) => id >= 0x2b && id <= 0x2d);
      let bt: Unit | null = null;
      for (const t of this.tacticTargets(L, 15, x, y)) if (!(t.flags & UnitFlag.Confused)) bt = t;
      if (ci !== undefined && bt) return this.item(L, x, y, ci, bt);
    } else if (ch.la === 3) {
      const it = this.off(L).items.find((id) => id === 30 || id === 31 || id === 32 || (id >= 52 && id <= 54));
      if (it !== undefined) return this.item(L, x, y, it, L);
    }
    return this.wait(L, x, y);
  }

  /** Steps from 유비 along the way to the goal. */
  private ahead(L: Unit, D: Uint16Array, n: number): Pos {
    let x = L.x, y = L.y;
    for (let k = 0; k < n; k++) {
      let bx = x, by = y, bd = D[y * this.W + x];
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
        const d = D[ny * this.W + nx];
        if (d < bd) { bd = d; bx = nx; by = ny; }
      }
      x = bx; y = by;
    }
    return [x, y];
  }

  private async escorts(em: number) {
    const p = EM[em];
    const L = this.leader();
    if (!L) return;
    const W = this.W;
    const D = this.distMap(YJ_GOAL, 0);
    let aim = this.ahead(L, D, p.ahead);
    const south = this.foes().filter((e) => SOUTH.has(e.officer));
    if (p.aimSouth && south.length) {
      const man = (e: Unit) => Math.abs(e.x - L.x) + Math.abs(e.y - L.y);
      const s = south.reduce((q, r) => (man(q) <= man(r) ? q : r));
      aim = [s.x, s.y];
    }
    const hits0 = this.enemyHits();
    // enemies that can hit 유비's surroundings (within 4 steps) next phase
    const threatL = new Set<number>();
    for (const [s, cells] of hits0)
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const x = L.x + dx, y = L.y + dy;
          if (x >= 0 && y >= 0 && x < W && y < this.H && Math.abs(dx) + Math.abs(dy) <= 4 && cells.has(y * W + x)) threatL.add(s);
        }
    const esc = this.ctrl().filter((u) => u.officer !== 0).sort((q, r) => this.mv(r) - this.mv(q) || q.slot - r.slot);
    for (const u of esc) {
      if (u.flags & UnitFlag.Acted || this.b.info.result) continue;
      const mt = CLASS_MOVE_TYPE[this.off(u).cls];
      const tacs = this.tactics(u);
      const healT = tacs.filter((t) => t >= 24 && t <= 26);
      const confT = tacs.filter((t) => t === 15);
      const dl = this.distMap(healT.length ? [L.x, L.y] : aim, mt);
      const pick: { best: Best | null } = { best: null };
      const consider = (v: number, o: Omit<Best, 'v'>) => {
        if (!pick.best || v > pick.best.v) pick.best = { v, ...o };
      };
      const cells = this.reach(u);
      let minD = 9999;
      for (const [x, y] of cells) minD = Math.min(minD, dl[y * W + x]);
      const items = this.off(u).items;
      const hi = items.find((id) => id >= 0x1e && id <= 0x20);
      const ci = items.find((id) => id >= 0x2b && id <= 0x2d);
      for (const [x, y] of cells) {
        const i = y * W + x;
        const extra = dl[i] - minD;
        const base = -Math.min(60, dl[i]) * p.follow;
        consider(base, { x, y, k: 'wait' });
        for (const t of this.targetsFrom(u, x, y)) {
          // hunters off the way are left alone unless they threaten 유비; the south group always
          if (!SOUTH.has(t.officer) && !threatL.has(t.slot) && extra > p.hunterHit) continue;
          const dm = this.dmg(u, t);
          consider(base + dm + (dm >= this.hp(t) ? 400 : 0) + (threatL.has(t.slot) ? p.threatW : 0), { x, y, k: 'atk', t });
        }
        for (const tac of confT)
          for (const t of this.tacticTargets(u, tac, x, y)) {
            if (t.flags & UnitFlag.Confused) continue;
            consider(base + p.confW * this.confP(u, t) * (threatL.has(t.slot) ? 600 : 100), { x, y, k: 'tac', tac, t });
          }
        for (const tac of healT)
          for (const v of this.tacticTargets(u, tac, x, y)) {
            const miss = this.maxHp(v) - this.hp(v);
            if (miss < 300) continue;
            consider(base + Math.min(miss, (TACTIC_POWER[tac] + 1) * 650) * (v.officer === 0 ? 2 : 1) - TACTIC_MP[tac] * 15, { x, y, k: 'tac', tac, t: v });
          }
        if (hi !== undefined) {
          const amt = (hi - 0x1e + 1) * 600;
          for (const v of this.tacticTargets(u, 24, x, y)) {
            const miss = this.maxHp(v) - this.hp(v);
            if (miss >= amt * 0.7) consider(base + Math.min(miss, amt) * 0.8 * (v.officer === 0 ? 2 : 1), { x, y, k: 'item', id: hi, t: v });
          }
        }
        if (ci !== undefined)
          for (const t of this.tacticTargets(u, 15, x, y)) {
            if (t.flags & UnitFlag.Confused) continue;
            consider(base + (threatL.has(t.slot) ? 700 : 0) + (t.officer === 92 ? 200 : 0), { x, y, k: 'item', id: ci, t });
          }
      }
      const bb = pick.best;
      if (!bb) continue;
      if (bb.k === 'atk') await this.attack(u, bb.x, bb.y, bb.t!);
      else if (bb.k === 'tac') await this.cast(u, bb.x, bb.y, bb.tac!, bb.t!);
      else if (bb.k === 'item') await this.item(u, bb.x, bb.y, bb.id!, bb.t!);
      else await this.wait(u, bb.x, bb.y);
    }
  }
}
