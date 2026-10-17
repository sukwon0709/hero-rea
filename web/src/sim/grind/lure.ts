// Grinding simulator: lure plans for 거록 (battle 3) and 계교 (battle 4) (GrindParams.lure).
// Both battles hold their enemies' main force in waiting groups (AI mode 3: a unit acts only on a
// foe it can reach this turn) and put a +50-for-everyone arrival cell behind them (거록 (0,10),
// 계교 (27,1)); the victory officer (장합, 원소) sits in a group and ends the battle when he falls.
// Charging in wakes a whole group at once; killing only the leader ends the battle early (Sukwon:
// not allowed). The plan, with the 회남 plan's greedy micro (HuainanStrike.bestAction):
//   1. hold near the start (luHold) while the mobile enemies and the turn waves come, killing what
//      reaches us, out of every waiting unit's wake reach;
//   2. peel the waiting units with a bait: a sturdy unit stands where only the target (and at most
//      luExtra others) can reach it, the rest gather just outside the other units' reach and kill
//      whatever came; the victory officer is never a target while anything else is left;
//   3. walks 유비 to the +50 cell only when his way is clear of every live enemy's reach and the
//      turns left just cover the walk (luMargin spare turns); otherwise, with the turns running
//      out, the victory officer is the last kill (a late finish after farming, as Sukwon allows).
// Script traps are kept out of: 계교's area trigger (any of ours in (10..15, 17..23) sends 원소's
// army over) is treated as waking every unit it moves while those still wait at home.

import { HuainanStrike, type StrikeOptions, type UnitOrder } from './huainan';
import type { BattleScene } from '../../native/battle/scene';
import type { GrindPolicy } from './policy';
import type { Stage } from '../../formats/scenario';
import { recordCommands } from '../../native/battle/dev/setup';
import { cellOf } from './events';
import { moveTypeOf, terrainAt } from '../../engine/battle/hex';
import { maxHp, movePoints } from '../../engine/battle/rules';
import { Status, type Unit } from '../../engine/battle/types';

export interface LureOptions extends StrikeOptions {
  label: string;
  /** Where to gather while awake enemies are about. */
  hold: [number, number];
  /** +50 arrival cell for 유비 (null: none). */
  bonus: [number, number] | null;
  /** Areas whose entry by any of ours wakes (moves) the listed enemy officers. */
  traps?: { x0: number; y0: number; x1: number; y1: number; officers: number[]; who: number }[];
  /** Turns kept for the final leader kill when the walk is blocked. */
  killTurns?: number;
  /** Turns the hold lasts at least (the early waves come to us). */
  holdTurns?: number;
  /** Awake enemies further than this (path steps) from the party do not count as engaged. */
  nearR?: number;
  /** 유비 heads for the fight (else he stays at the party's centre). */
  leaderFollows?: boolean;
  /** The walk's worst case (hits at his stops) must stay under this share of 유비's troops. */
  walkSafe?: number;
  /** 유비's troop share needed for the walk. */
  walkHp?: number;
  /** Where 유비 waits for the last walk (walkThrough). */
  walkStage?: [number, number];
  /** The last walk may pass waiting units when it takes at most walkMax turns. */
  walkThrough?: boolean;
  walkMax?: number;
  /** Risk weight of 유비 while peeling. */
  leaderRisk?: number;
  /** The general policy plays on once the opening is over (nothing awake). */
  policyEnd?: boolean;
  /** The general policy plays the opening (until no enemy is awake). */
  policyOpen?: boolean;
  /** Turns in a row with nothing to peel before the victory officer is finished. */
  stallTurns?: number;
  /** Bait cell value per step away from the other waiting units. */
  sepW?: number;
  /** Troop share a bait needs. */
  baitHp?: number;
  /** Bait cell cost per extra unit it wakes. */
  extraCost?: number;
  /** Hold area radius (path steps from the hold cell). */
  holdR?: number;
  /** Risk weight of our units. */
  risk?: number;
  /** Troop share under which an officer rests on a healing cell when nothing is awake. */
  restAt?: number;
  /** Troop share under which an officer keeps out of reach. */
  woundAt?: number;
}

export class LurePlan extends HuainanStrike {
  readonly lo: LureOptions;
  walked = false;
  /** turns in a row with nothing engaged and no bait to send */
  stall = 0;
  trapFired = new Set<number>();
  constructor(sc: BattleScene, policy: GrindPolicy, o: LureOptions) {
    super(sc, policy, o);
    this.lo = o;
    this.wave.clear();
  }
  private prev: (() => Promise<void>) | null = null;
  phase1Done = false;
  install(): void {
    this.prev = (this.sc as unknown as { playerPhase: () => Promise<void> }).playerPhase;
    super.install();
  }
  async playerPhase(): Promise<void> {
    // the opening fight (mobile enemies, the first waves) by the general policy when policyOpen
    if (this.lo.policyOpen && !this.phase1Done && this.prev) {
      const turn = this.b.info.turn + 1;
      const awake = this.enemies().some((e) => !this.sleeping(e));
      const waveSoon = this.policy.know.turns.some((e) => e.turn !== null && e.turn >= turn && e.turn <= turn + 1 && e.reinforce.length > 0);
      if (turn <= (this.lo.holdTurns ?? 0) || awake || waveSoon) return this.prev();
      this.phase1Done = true;
      this.log?.(`T${turn} opening over: lure plan takes over`);
    }
    // policyEnd: the opening is the plan's; once nothing is awake (and from turn policyEndAt), the
    // general policy plays the rest (rest, trap charge, finish)
    if (this.lo.policyEnd && this.prev) {
      const turn = this.b.info.turn + 1;
      if (!this.handed && turn > (this.lo.holdTurns ?? 0) && !this.enemies().some((e) => !this.sleeping(e))) {
        this.handed = true;
        this.log?.(`T${turn} opening over: the general policy takes over`);
      }
      if (this.handed) return this.prev();
    }
    return super.playerPhase();
  }
  handed = false;
  label(): string {
    return `${this.lo.label} lure: hold ${this.lo.hold}, bonus ${this.lo.bonus ?? '-'}`;
  }
  protect(e: Unit): boolean {
    return this.policy.know.protect.has(e.officer);
  }
  /** cells of 유비's cheapest walk to `c` (terrain only) */
  walkPath(L: Unit, c: [number, number], from: [number, number] = [L.x, L.y]): [number, number][] {
    const mt = moveTypeOf(this.b.s, L), W = this.b.width, H = this.b.height;
    const out: [number, number][] = [];
    let [x, y] = from;
    for (let i = 0; i < 80 && (x !== c[0] || y !== c[1]); i++) {
      let best: [number, number] | null = null, bd = this.pathDist(c, mt, x, y);
      for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const d = this.pathDist(c, mt, nx, ny);
        if (d < bd) [bd, best] = [d, [nx, ny]];
      }
      if (!best) break;
      [x, y] = best;
      out.push(best);
    }
    return out;
  }
  /** worst case of 유비's walk from `from`: every enemy reaching one of his stop cells hits him there */
  walkRisk(L: Unit, from: [number, number], enemies: Unit[], zones: Map<number, Uint8Array>): number {
    const W = this.b.width, mp = Math.max(1, movePoints(this.of(L), this.b.s.items));
    const path = this.walkPath(L, this.lo.bonus!, from);
    const stops = path.filter((_, i) => (i + 1) % mp === 0 && i + 1 < path.length);
    let worst = 0;
    for (const e of enemies) {
      const n = stops.filter(([x, y]) => zones.get(e.slot)![y * W + x]).length;
      if (n) worst += n * Math.max(this.hitOn(e, L, stops[0][0], stops[0][1]), this.tacOn(e, L, stops[0][0], stops[0][1]));
    }
    return worst;
  }
  /** enemy slots whose reach covers some cell of the walk */
  walkBlockers(L: Unit, zones: Map<number, Uint8Array>): Unit[] {
    const path = this.walkPath(L, this.lo.bonus!);
    const W = this.b.width;
    return this.enemies().filter((e) => path.some(([x, y]) => zones.get(e.slot)![y * W + x]));
  }
  /** a trap is armed until one of the units it moves is seen awake (its record runs once) */
  trapArmed(t: NonNullable<LureOptions['traps']>[number]): boolean {
    const k = (this.lo.traps ?? []).indexOf(t);
    if (this.trapFired.has(k)) return false;
    const us = this.units.filter((e) => e.slot >= 15 && e.status === Status.Field && t.officers.includes(e.officer));
    if (us.some((e) => !this.sleeping(e))) {
      this.log?.(`trap ${k} (${t.x0},${t.y0})-(${t.x1},${t.y1}) seen fired: ${us.filter((e) => !this.sleeping(e)).map((e) => this.b.stateOfficer(e).name + '@' + e.x + ',' + e.y + ' m' + e.mode).join(' ')}`);
      this.trapFired.add(k);
      return false;
    }
    return us.length > 0;
  }
  /** (x,y) inside an armed trap that `u` fires */
  inTrap(u: Unit, x: number, y: number): boolean {
    for (const t of this.lo.traps ?? []) if ((t.who === 0x400 || t.who === u.officer) && x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1 && this.trapArmed(t)) return true;
    return false;
  }

  orders(turn: number): (u: Unit) => UnitOrder {
    const ord = this.plan(turn);
    // the wounded keep out of reach (a lost officer is lost exp)
    return (u) => {
      const r = ord(u);
      const o = this.of(u);
      if (u.officer !== 0 && o.hp < maxHp(o) * (this.lo.woundAt ?? 0.4)) return { ...r, risk: (r.risk ?? 1) * 2.5 };
      return r;
    };
  }

  plan(turn: number): (u: Unit) => UnitOrder {
    const o = this.lo;
    const b = this.b, W = b.width;
    const L = this.leader()!;
    const limit = b.info.turnLimit || 30;
    const left = limit - turn + 1;
    const enemies = this.enemies();
    const others = enemies.filter((e) => !this.protect(e));
    const zones = new Map<number, Uint8Array>();
    for (const e of enemies) zones.set(e.slot, this.enemyHit(e));
    const ours = this.ours();
    const banFor = (u: Unit) => (x: number, y: number) => this.inTrap(u, x, y);
    // the victory officer is not hit while anything else is left
    const avoid = (s: number) => others.length > 0 && this.protect(this.units[s]);
    // the walk to the +50 cell: 유비's way clear of every live enemy's reach and of armed traps
    // (the victory officer alone may be woken when 유비 is healthy: he cannot stop a short walk)
    if (o.bonus && L) {
      const mp = Math.max(1, movePoints(this.of(L), b.s.items));
      const need = Math.ceil(this.pathDist(o.bonus, moveTypeOf(b.s, L), L.x, L.y) / mp);
      let clear = this.walked;
      if (!clear && need + (o.margin ?? 1) >= left && need <= left) {
        const path = this.walkPath(L, o.bonus);
        const healthy = this.of(L).hp >= maxHp(this.of(L)) * (o.walkHp ?? 0.45);
        // walkThrough: a short last walk may pass waiting units (and their trap): they wake too late
        let through = !!o.walkThrough && healthy && need <= (o.walkMax ?? 3);
        if (through) {
          const worst = this.walkRisk(L, [L.x, L.y], enemies, zones);
          if (worst >= this.of(L).hp * (o.walkSafe ?? 0.9)) {
            if (turn % 2 === 0) this.log?.(`T${turn} walk too dangerous: worst ${worst} vs ${this.of(L).hp}`);
            through = false;
          }
        }
        const blockers = enemies.filter((e) => path.some(([x, y]) => zones.get(e.slot)![y * W + x]) && !(this.protect(e) && healthy && others.length === 0) && !(through && this.sleeping(e)));
        const trapped = !through && (o.traps ?? []).some((t) => (t.who === 0 || t.who === 0x400) && this.trapArmed(t) && path.some(([x, y]) => x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) && this.units.some((e) => e.slot >= 15 && e.status === Status.Field && t.officers.includes(e.officer) && !(this.protect(e) && healthy && others.length === 0)));
        clear = blockers.length === 0 && !trapped;
        if (!clear && turn % 3 === 0) this.log?.(`T${turn} walk blocked: ${blockers.map((e) => b.stateOfficer(e).name).join(',')}${trapped ? ' +trap' : ''}`);
      }
      if (clear) {
        if (!this.walked) this.log?.(`T${turn} walk: 유비 to ${o.bonus}, ${need} turns, ${left} left`);
        this.walked = true;
        // 유비 goes all the way (the arrival ends the battle), the others screen him
        // (whoever charges him, the victory officer too, is fair game now: the battle ends either way)
        return (u) => (u.officer === 0 ? { anchor: o.bonus!, pull: 200, wakeOk: () => true, risk: 0.05 } : { anchor: [L.x, L.y], pull: 4, wakeOk: () => true, risk: 0.4 });
      }
    }
    const inZone = (e: Unit) => ours.some((u) => zones.get(e.slot)![u.y * W + u.x]);
    const cx = Math.round(ours.reduce((a, u) => a + u.x, 0) / ours.length), cy = Math.round(ours.reduce((a, u) => a + u.y, 0) / ours.length);
    // awake enemies far off (a wounded one fled to heal) do not hold up the next bait
    const near = (e: Unit) => this.pathDist([cx, cy], 0, e.x, e.y) <= (o.nearR ?? 12);
    const engaged = new Set(enemies.filter((e) => (!this.sleeping(e) && near(e)) || inZone(e)).map((e) => e.slot));
    // the walk is planned when 유비, from walkStage, would live through it
    const walkPlanned = !!(o.bonus && o.walkThrough && o.walkStage && this.of(L).hp >= maxHp(this.of(L)) * (o.walkHp ?? 0.45) && this.walkRisk(L, o.walkStage, enemies, zones) < this.of(L).hp * (o.walkSafe ?? 0.9));
    // walkThrough: the last turns stage 유비 at walkStage (out of reach and traps) for the walk
    // (staging needs the turns left to cover the walk from the stage: else the finish)
    const stageNeed = o.walkStage && L ? Math.ceil(this.pathDist(o.bonus ?? o.walkStage, moveTypeOf(b.s, L), o.walkStage[0], o.walkStage[1]) / Math.max(1, movePoints(this.of(L), b.s.items))) : 99;
    const awakeOthers = others.some((e) => !this.sleeping(e));
    if (walkPlanned && !awakeOthers && !this.walked && left <= (o.walkMax ?? 3) + (o.margin ?? 1) + 3 && left >= stageNeed) {
      const st = o.walkStage;
      if (turn % 2 === 0) this.log?.(`T${turn} staging 유비 at ${st} for the walk`);
      return (u) => (u.officer === 0 ? { anchor: st, pull: 10, wakeOk: () => false, risk: 1.5, avoid, ban: banFor(u) } : { anchor: st, pull: 3, wakeOk: (sl) => engaged.has(sl), risk: o.risk ?? 1, avoid, ban: banFor(u) });
    }
    // the finish: turns running out and no clear walk; the victory officer is the last kill, baited
    // out if he still waits (others he wakes on the way are fought too)
    const prot = enemies.filter((e) => this.protect(e));
    // (or nothing left to peel for stallTurns turns: the safe exp is taken, the rest waits on him)
    const finishing = prot.length > 0 && !(walkPlanned && !awakeOthers && left >= stageNeed) && (left <= (o.killTurns ?? 6) + Math.ceil(Math.min(...prot.map((p) => this.pathDist([p.x, p.y], 0, L.x, L.y))) / 6) || this.stall >= (o.stallTurns ?? 99));
    if (finishing) {
      const P = prot[0];
      if (turn % 3 === 0) this.log?.(`T${turn} finish: ${b.stateOfficer(P).name}, ${left} left`);
      let bait = null as { slot: number; cell: [number, number]; target: number } | null;
      for (let ex = 0; ex <= 3 && !bait && this.sleeping(P); ex++) bait = this.pickBait([P], ours, enemies, zones, engaged, cx, cy, ex, true);
      if (bait) this.log?.(`T${turn} finish bait ${b.stateOfficer(this.units[bait.slot]).name} at ${bait.cell}`);
      if (bait) {
        const wakes = new Set(enemies.filter((e) => zones.get(e.slot)![bait.cell[1] * W + bait.cell[0]]).map((e) => e.slot));
        const okF = (sl: number) => engaged.has(sl) || wakes.has(sl);
        const bc = bait.cell, bs = bait.slot;
        return (u) => (u.slot === bs ? { anchor: bc, pull: 40, wakeOk: okF, risk: 0.3 } : { anchor: bc, pull: u.officer === 0 ? 1 : 3, wakeOk: okF, risk: u.officer === 0 ? 1 : 0.5 });
      }
      return (u) => ({ anchor: [P.x, P.y], pull: u.officer === 0 ? 3 : 25, wakeOk: () => true, risk: u.officer === 0 ? 0.8 : 0.15 });
    }
    // turn waves coming within two turns count as engaged: hold
    const waveSoon = this.policy.know.turns.some((e) => e.turn !== null && e.turn >= turn && e.turn <= turn + 1 && e.reinforce.length > 0);
    if (turn <= (o.holdTurns ?? 0) || waveSoon) {
      // nobody leaves the hold area (holdR steps of the hold cell): the waves come to us
      const R = o.holdR ?? 4;
      return (u) => {
        const c = u.officer === 0 ? (o.leaderHold ?? o.hold) : o.hold, mt = moveTypeOf(b.s, u);
        return { anchor: c, pull: u.officer === 0 ? 3 : (o.pull ?? 1.5), wakeOk: () => false, avoid, risk: o.risk ?? 1, ban: (x, y) => this.inTrap(u, x, y) || this.pathDist(c, mt, x, y) > R };
      };
    }
    let bait = null as { slot: number; cell: [number, number]; target: number } | null;
    // the lured: waiting units that acted (they stay where they struck, still waiting) keep being
    // baited out, a cell further from the rest each turn, until they fall; truly awake enemies
    // near are fought first
    const awakeNear = enemies.filter((e) => engaged.has(e.slot) && !this.sleeping(e));
    const lured = others.filter((e) => engaged.has(e.slot) && this.sleeping(e));
    if (awakeNear.length <= (o.maxEngaged ?? 0) && others.length) {
      if (lured.length) bait = this.pickBait(lured, ours, enemies, zones, engaged, cx, cy, 0, false);
      if (!bait && lured.length <= (o.maxEngaged ?? 0)) {
        const sleepers = others.filter((e) => !engaged.has(e.slot) && this.sleeping(e));
        // one at a time if any cell allows it, else with up to maxExtra more
        for (let ex = 0; ex <= (o.maxExtra ?? 1) && !bait; ex++) bait = this.pickBait(sleepers, ours, enemies, zones, engaged, cx, cy, ex, false);
      }
    }
    if (!bait && engaged.size === 0) this.stall++;
    else this.stall = 0;
    if (bait) this.log?.(`T${turn} bait ${b.stateOfficer(this.units[bait.slot]).name} at ${bait.cell} for ${b.stateOfficer(this.units[bait.target]).name}@${this.units[bait.target].x},${this.units[bait.target].y}`);
    const baitWakes = new Set<number>();
    if (bait) for (const e of enemies) if (zones.get(e.slot)![bait.cell[1] * W + bait.cell[0]]) baitWakes.add(e.slot);
    const ok = (s: number) => engaged.has(s) || baitWakes.has(s);
    let focus: [number, number];
    if (bait) focus = bait.cell;
    else if (engaged.size) {
      const es = enemies.filter((e) => engaged.has(e.slot));
      focus = [Math.round(es.reduce((a, e) => a + e.x, 0) / es.length), Math.round(es.reduce((a, e) => a + e.y, 0) / es.length)];
    } else focus = o.peelAt ?? o.hold;
    // nothing awake near: the wounded rest on a village / fortress out of every waiting unit's reach
    const rest = engaged.size === 0 ? this.restCells(enemies, zones) : [];
    return (u) => {
      if (bait && u.slot === bait.slot) return { anchor: bait.cell, pull: 40, wakeOk: ok, avoid, ban: banFor(u) };
      const ou = this.of(u);
      if (rest.length && ou.hp < maxHp(ou) * (u.officer === 0 ? 0.7 : (o.restAt ?? 0.5))) {
        const mt = moveTypeOf(b.s, u);
        const c = rest.reduce((p, q) => (this.pathDist(q, mt, u.x, u.y) < this.pathDist(p, mt, u.x, u.y) ? q : p));
        return { anchor: c, pull: 4, wakeOk: ok, avoid, risk: 2, ban: banFor(u) };
      }
      // 유비 behind the party, cautious (he takes kills that come to him)
      if (u.officer === 0) return { anchor: o.leaderFollows ? focus : [cx, cy], pull: o.leaderFollows ? 1 : 1.5, wakeOk: ok, risk: o.leaderRisk ?? 2, avoid, ban: banFor(u) };
      return { anchor: focus, pull: o.pull2 ?? 2, wakeOk: ok, avoid, risk: o.risk ?? 1, ban: banFor(u) };
    };
  }

  /** healing cells (village, fortress, barracks) no waiting enemy reaches */
  restCells(enemies: Unit[], zones: Map<number, Uint8Array>): [number, number][] {
    const b = this.b, W = b.width, out: [number, number][] = [];
    for (let k = 0; k < W * b.height; k++) {
      const x = k % W, y = (k - x) / W;
      const t = terrainAt(b.s, x, y);
      if (t !== 8 && t !== 13 && t !== 14) continue;
      if (enemies.some((e) => zones.get(e.slot)![k])) continue;
      if (this.lo.bonus && x === this.lo.bonus[0] && y === this.lo.bonus[1]) continue;
      out.push([x, y]);
    }
    return out;
  }

  /**
   * A bait for one of `targets`: a cell in the target's reach that wakes at most `extra` other
   * waiting units (never the victory officer unless `prot`), for a sturdy unit (not 유비); the
   * cheapest by the bait's walk, the party's walk and the extra units woken.
   */
  pickBait(targets: Unit[], ours: Unit[], enemies: Unit[], zones: Map<number, Uint8Array>, engaged: Set<number>, cx: number, cy: number, extra: number, prot: boolean): { slot: number; cell: [number, number]; target: number } | null {
    const o = this.lo, b = this.b, W = b.width;
    const sorted = [...targets].sort((a, z) => this.pathDist([cx, cy], 0, a.x, a.y) - this.pathDist([cx, cy], 0, z.x, z.y));
    const cands = ours.filter((u) => u.officer !== 0 && this.of(u).hp > maxHp(this.of(u)) * (o.baitHp ?? 0.6)).sort((a, z) => this.of(z).hp - this.of(a).hp);
    let bait = null as { slot: number; cell: [number, number]; target: number } | null;
    let bd = 1e9;
    for (const T of sorted.slice(0, 4)) {
      const zt = zones.get(T.slot)!;
      for (const u of cands.slice(0, 3)) {
        const mt = moveTypeOf(b.s, u);
        for (let k = 0; k < zt.length; k++) {
          if (!zt[k]) continue;
          const x = k % W, y = (k - x) / W;
          if ((b.s.unitAt[k] !== 0xff && b.s.unitAt[k] !== u.slot) || this.inTrap(u, x, y)) continue;
          const wakes = enemies.filter((e) => e.slot !== T.slot && !engaged.has(e.slot) && zones.get(e.slot)![k]);
          if (!prot && wakes.some((e) => this.protect(e))) continue;
          if (wakes.length > extra) continue;
          const pd = this.pathDist([u.x, u.y], mt, x, y);
          if (pd >= 9999) continue;
          // the bait's walk, and the party's (it fights there)
          // and away from the other waiting units (the target follows out of their reach)
          let sep = 99;
          for (const e of enemies) if (e.slot !== T.slot && this.sleeping(e) && !wakes.includes(e)) sep = Math.min(sep, Math.abs(e.x - x) + Math.abs(e.y - y));
          const d = pd + 0.7 * this.pathDist([cx, cy], 0, x, y) + wakes.length * (o.extraCost ?? 6) - (o.sepW ?? 2) * Math.min(sep, 10) + (this.danger(u, x, y).worst > this.of(u).hp * 0.7 ? 50 : 0);
          if (d < bd) {
            bd = d;
            bait = { slot: u.slot, cell: [x, y], target: T.slot };
          }
        }
      }
      if (bait) break;
    }
    return bait;
  }

  /** cells within two turns' walk (bait cells further than one move are walked to over turns) */
  reachableFar(u: Unit): [number, number][] {
    const b = this.b, mt = moveTypeOf(b.s, u), W = b.width, H = b.height;
    const mp = movePoints(this.of(u), b.s.items);
    const out: [number, number][] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = this.pathDist([u.x, u.y], mt, x, y);
      if (d <= mp * 2 && (b.s.unitAt[y * W + x] === 0xff || (x === u.x && y === u.y))) out.push([x, y]);
    }
    return out;
  }
}

/**
 * Area triggers (11) that set waiting enemies moving (SET_AI to anything but order 0, 대기; order
 * 3 sends them at an officer, 유비 at 거록 and 계교, order 4 to a cell): entering one wakes every
 * unit it names. `who`: the officer whose entry fires it (0x400: any of ours).
 */
export function scriptTraps(stage: Stage, block: number): NonNullable<LureOptions['traps']> {
  const out: NonNullable<LureOptions['traps']> = [];
  for (const r of stage.blocks[block]?.records ?? []) {
    if (r.trigger !== 11) continue;
    const cmds = recordCommands(stage, r.code) as unknown as { name: string; officer?: number; algo?: number }[];
    const officers = cmds.filter((c) => c.name === 'SET_AI' && c.algo !== 0 && c.officer !== undefined).map((c) => c.officer!);
    if (!officers.length) continue;
    const [x0, y0] = cellOf(r.p2), [x1, y1] = cellOf(r.p3);
    out.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), officers: [...new Set(officers)], who: r.p1 });
  }
  return out;
}

/**
 * Which battle's lure options apply (null: none). 거록 (ch1 stage 0 block 13): hold the north-west
 * pocket (3,2) while the 적병 wave (turn 3) and the mobile units come, then peel 장합's group from
 * the east; the last walk to (0,10) may pass the group (the 유비 trap at (4..10, 8..13) sends it at
 * him) from (12,9) when he would live through it. 계교 (block 15): hold the west (3,14), 유비 back
 * at (0,11), for 10 turns (allies trip the area trap that brings 원소's army to (13..16, 21..23)),
 * then peel it.
 */
export function lureOptionsFor(chapter: number, stage: number, block: number | undefined): Omit<LureOptions, 'stage'> | null {
  const common = { risk: 1.5, sepW: 2, baitHp: 0.6, extraCost: 6, holdR: 4 };
  if (chapter === 1 && stage === 0 && block === 13)
    return { ...common, label: '거록', hold: [3, 2], holdTurns: 3, bonus: [0, 10], peelAt: [12, 10], leaderFollows: true, leaderRisk: 1, walkThrough: true, walkStage: [12, 9], walkMax: 3, walkSafe: 0.9 };
  if (chapter === 1 && stage === 0 && block === 15)
    return { ...common, label: '계교', hold: [3, 14], leaderHold: [0, 11], holdTurns: 10, bonus: [27, 1], leaderRisk: 2 };
  return null;
}

