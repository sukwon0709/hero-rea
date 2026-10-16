// Grinding simulator: the 회남 strike plan (GrindParams.hnStrike). The battle (ch1 stage 2 block 12):
// 9 of ours at the north-east, 12 원술 units waiting (AI mode 3: they act only on a unit they can
// reach) across a river whose one crossing is the bridge at column 18, and at turn 6 a wave of 10
// (진궁 Lv18, 장요 Lv17, ...) entering at (9..14, 0..2), next to our start, attacking the nearest.
// Win: every enemy gone, or 유비 on (0,2) (+50 for all). Holding the north-east against the wave
// (the hnPlan) loses at the levels the party arrives with (Lv12..14). This plan:
//   1. stands next to the wave's entry cells by the turn before it (hnStageX/Y), so the turn-6
//      player phase strikes first (a 폭탄 only under the policy's emergency rule: one per battle,
//      on a unit that can nearly finish 유비; Sukwon: no bomb abuse, levels decide it);
//   2. then peels the waiting southern units with a bait: a sturdy unit stands where only the
//      target (and at most hnExtra others) can reach it, the rest gather just outside the other
//      waiting units' reach and kill whatever came (one or two a turn, the bridge in between);
//   3. walks 유비 to (0,2) only when the turns left just cover his way and too many are left.
// Micro is greedy: per unit the (cell, action) with the best damage / kill / heal / item value less
// the danger of the cell (the leader's worst case, every enemy in reach hitting it).

import type { BattleScene } from '../../native/battle/scene';
import { BOMBS_PER_BATTLE, type GrindPolicy } from './policy';
import { floodMove, rangeCells, terrainAt, unitsInRange, moveTypeOf } from '../../engine/battle/hex';
import { attackPower, defencePower, maxHp, movePoints, physicalDamage, castableTactics, tacticSkill, tacticTerrainOk, tryCure, healKind } from '../../engine/battle/rules';
import { healUseful } from '../../engine/battle/combat';
import {
  AiMode,
  CLASS_ATTACK_TYPE,
  CLASS_RANGE,
  CONFUSE_ITEM_RANGE,
  NONE,
  PLAYER_SLOTS,
  RAIN,
  Status,
  TACTIC_MP,
  TACTIC_POWER,
  TERRAIN_FOREST,
  UnitFlag,
  WEATHER_TYPE,
  moveCost,
  resistsTactics,
  terrainDefence,
  type Unit,
} from '../../engine/battle/types';
import { S } from '../../native/battle/strings';

export interface StrikeOptions {
  /** Where to stand the turn before the wave. */
  stage: [number, number];
  /** Waiting units a bait cell may wake besides its target. */
  maxExtra?: number;
  /** Risk weight of our units (not the leader) while the wave is up. */
  waveRisk?: number;
  /** Spare turns for 유비's walk to the exit cell. */
  margin?: number;
  /** Pull weight toward the anchor while waiting / while peeling. */
  pull?: number;
  pull2?: number;
  /** Fixed escape turn (else computed from the walk length). */
  goAt?: number;
  /** Escape once at most this many foes remain. */
  fightTo?: number;
  /** Engaged foes tolerated before peeling another bait. */
  maxEngaged?: number;
  /** Fallback peel focus. */
  peelAt?: [number, number];
  /** Units chase the wave instead of holding the stage. */
  chase?: boolean;
  /** 유비's own hold cell while the wave is up. */
  leaderHold?: [number, number];
}

export interface UnitOrder {
  anchor?: [number, number] | null;
  /** pull per path step to the anchor */
  pull?: number;
  /** may enter wake zones of these sleeping enemies (slots); others are banned */
  wakeOk?: (enemySlot: number) => boolean;
  /** risk multiplier */
  risk?: number;
  /** cells this unit must not stand on */
  ban?: (x: number, y: number) => boolean;
  /** extra positional value */
  bonus?: (x: number, y: number) => number;
  /** do not act (move only) */
  noAct?: boolean;
}

export class HuainanStrike {
  log: ((s: string) => void) | null = null;
  threat: Map<number, Uint8Array> = new Map(); // enemy slot -> cells it can hit (phys or tactic)
  wake: Map<number, Uint8Array> = new Map(); // sleeping enemy -> cells that wake it
  dist = new Map<string, Int16Array>();
  constructor(
    readonly sc: BattleScene,
    readonly policy: GrindPolicy,
    readonly o: StrikeOptions,
  ) {
    for (const e of policy.know.turns) if (e.turn !== null && e.reinforce.length >= 4) for (const off of e.reinforce) this.wave.add(off);
  }
  /** Officers of the big turn wave (the turn-6 여포 army at 회남). */
  readonly wave = new Set<number>();
  waveDead: number | null = null;
  /** Replaces the scene's player phase (after GrindPolicy.install, which keeps its event hooks). */
  install(): void {
    (this.sc as unknown as Record<string, unknown>).playerPhase = () => this.playerPhase();
  }
  get b() { return this.sc.b; }
  get units() { return this.sc.units; }
  of(u: Unit) { return this.b.officerOf(u); }
  enemies() { return this.units.filter((e) => e.slot >= PLAYER_SLOTS && e.status === Status.Field && e.officer !== 0xffff); }
  ours() { return this.units.filter((e) => e.slot < PLAYER_SLOTS && e.status === Status.Field && e.officer !== 0xffff); }
  leader() { const s = this.b.slotOfOfficer(0); return s === NONE ? null : this.units[s]; }
  sleeping(e: Unit) { return e.mode === AiMode.Wait || e.mode === AiMode.Hold; }

  /** walking distance from cell c (move type mt), ignoring units */
  pathDist(c: [number, number], mt: number, x: number, y: number): number {
    const key = `${c[0]},${c[1]},${mt}`;
    let d = this.dist.get(key);
    const b = this.b, W = b.width, H = b.height;
    if (!d) {
      d = new Int16Array(W * H).fill(9999);
      const q: number[] = [c[1] * W + c[0]];
      d[q[0]] = 0;
      // dijkstra-ish with small costs: use bucket relax loop
      let changed = true;
      while (changed) {
        changed = false;
        for (let k = 0; k < W * H; k++) {
          if (d[k] === 9999) continue;
          const kx = k % W, ky = (k - kx) / W;
          for (const [nx, ny] of [[kx, ky - 1], [kx + 1, ky], [kx, ky + 1], [kx - 1, ky]]) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const n = ny * W + nx;
            const mc = moveCost(mt, b.s.terrain[k]); // cost to leave k toward n = cost of n in game; use n's cost
            const cn = moveCost(mt, b.s.terrain[n]);
            if (cn === 0xff || (mc === 0xff && k !== q[0])) continue;
            if (d[k] + cn < d[n]) { d[n] = d[k] + cn; changed = true; }
          }
        }
      }
      this.dist.set(key, d);
    }
    return d[y * W + x];
  }

  reachable(u: Unit): [number, number][] {
    const b = this.b;
    const grid = b.s.grid;
    if (u.flags & UnitFlag.Moved) return [[u.x, u.y]];
    floodMove(b.s, u, [u.x, u.y], grid, { flags: 0, maxCost: movePoints(this.of(u), b.s.items) });
    const out: [number, number][] = [[u.x, u.y]];
    for (let c = 0; c < grid.length; c++) {
      if (grid[c] === NONE) continue;
      const x = c % b.width, y = Math.trunc(c / b.width);
      if ((x !== u.x || y !== u.y) && b.s.unitAt[c] === NONE) out.push([x, y]);
    }
    return out;
  }

  /** cells enemy e could attack this enemy phase (physical + damage tactics), from its reach */
  enemyHit(e: Unit): Uint8Array {
    const b = this.b, W = b.width;
    const out = new Uint8Array(W * b.height);
    const oe = this.of(e);
    const mp = e.mode === AiMode.Hold ? 0 : movePoints(oe, b.s.items);
    const grid = new Uint8Array(W * b.height);
    floodMove(b.s, e, [e.x, e.y], grid, { flags: 0, maxCost: mp });
    const rng = CLASS_RANGE[oe.cls];
    const rain = WEATHER_TYPE[b.info.weather] === RAIN;
    const tacs = castableTactics(oe, e.mp, b.learn).filter((t) => t <= 14 && !(rain && t < 5));
    const ta = tacs.length ? Math.max(...tacs.map((t) => TACTIC_POWER[t])) | 0x80 : NONE;
    for (let c = 0; c < grid.length; c++) {
      if (grid[c] === NONE) continue;
      if (b.s.unitAt[c] !== NONE && b.s.unitAt[c] !== e.slot) continue;
      const x = c % W, y = (c - x) / W;
      if (rng !== NONE) for (const [cx, cy] of rangeCells(b.s, x, y, rng)) out[cy * W + cx] = 1;
      if (ta !== NONE) for (const [cx, cy] of rangeCells(b.s, x, y, ta)) out[cy * W + cx] |= 2;
    }
    return out;
  }

  buildThreat() {
    this.threat.clear();
    for (const e of this.enemies()) {
      if (e.flags & UnitFlag.Confused || e.mode === AiMode.MoveNoAttack) continue;
      this.threat.set(e.slot, this.enemyHit(e));
    }
  }

  hitOn(E: Unit, u: Unit, x: number, y: number): number {
    const b = this.b, oe = this.of(E), o = this.of(u);
    return physicalDamage({ attack: attackPower(oe, E.morale, b.s.items), defence: defencePower(o, u.morale, b.s.items), attackerClass: oe.cls, defenderClass: o.cls, defenderTerrain: terrainAt(b.s, x, y), defenderHp: 0xffff, counter: false });
  }
  tacDmg(c: { level: number; intel: number }, t: { level: number; intel: number; cls: number }, element: number, power: number, terr: number): number {
    const u16 = (v: number) => v & 0xffff;
    let dmg = u16((Math.trunc(u16(c.level * c.intel) / 50) + c.intel) * 2 - Math.trunc(u16(t.level * t.intel) / 50) - t.intel + (power * 4 + element + 2) * 100);
    if (resistsTactics(t.cls)) dmg = Math.trunc(dmg / 2);
    if ((element === 0 && terr === TERRAIN_FOREST) || (element === 1 && WEATHER_TYPE[this.b.info.weather] === RAIN)) dmg += Math.trunc(dmg / 4);
    return dmg;
  }
  tacOn(E: Unit, u: Unit, x: number, y: number): number {
    const b = this.b, oe = this.of(E), o = this.of(u);
    const terr = terrainAt(b.s, x, y);
    const rain = WEATHER_TYPE[b.info.weather] === RAIN;
    let best = 0;
    for (const t of castableTactics(oe, E.mp, b.learn)) {
      if (t > 14 || (rain && t < 5)) continue;
      const el = Math.trunc(t / 5);
      if (!tacticTerrainOk(el, terr)) continue;
      const pc = tacticSkill(oe);
      let pt = tacticSkill(o) >> 2;
      if (resistsTactics(o.cls)) pt <<= 1;
      const hit = pc > 0 ? Math.max(0, pc - 1 - pt) / pc : 0;
      best = Math.max(best, this.tacDmg(oe, o, el, TACTIC_POWER[t], terr) * hit);
    }
    return best;
  }
  /** damage u would take at (x,y): worst = all reaching enemies hit it */
  danger(u: Unit, x: number, y: number): { worst: number; n: number } {
    const k = y * this.b.width + x;
    let worst = 0, n = 0;
    for (const [s, m] of this.threat) {
      if (!m[k]) continue;
      const E = this.units[s];
      if (E.status !== Status.Field) continue;
      if (this.sleeping(E) && !this.wouldWake(E, k)) continue;
      const d = Math.max(m[k] & 1 ? this.hitOn(E, u, x, y) : 0, m[k] & 2 ? this.tacOn(E, u, x, y) : 0);
      worst += d;
      n++;
    }
    return { worst, n };
  }
  wouldWake(E: Unit, k: number): boolean {
    // a waiting unit acts when it finds a foe within its move: it will if (x,y) is in its hit map
    const m = this.threat.get(E.slot);
    return !!m && !!m[k];
  }
  foeThreat(E: Unit): number {
    let best = 0;
    const m = this.threat.get(E.slot);
    if (!m) return 0;
    for (const u of this.ours()) {
      const k = u.y * this.b.width + u.x;
      if (!m[k]) continue;
      const d = Math.max(this.hitOn(E, u, u.x, u.y), this.tacOn(E, u, u.x, u.y));
      best = Math.max(best, d * (u.officer === 0 ? 2 : 1));
    }
    return best;
  }

  stats = { kills: 0, bombs: 0, conf: 0 };

  waveLeft(): Unit[] {
    return this.units.filter((u) => u.slot >= PLAYER_SLOTS && this.wave.has(u.officer) && (u.status === Status.Field || u.status === Status.Reserve));
  }
  /** The plan: stage next to the wave's entry by its turn, strike first, then peel the rest. */
  orders(turn: number): (u: Unit) => UnitOrder {
    const wl = this.waveLeft();
    const waveTurn = Math.min(...this.policy.know.turns.filter((e) => e.turn !== null && e.reinforce.length >= 4).map((e) => e.turn as number), 99);
    if (turn < waveTurn) return () => ({ anchor: this.o.stage, pull: 6, wakeOk: () => false });
    const phase = wl.length > 0 ? 'wave' : 'south';
    return southPlan(this, turn, phase, centroid(wl) ?? this.o.stage, this.o);
  }


  async playerPhase() {
    const sc = this.sc, b = this.b;
    if (b.info.turn === 0) this.log?.(`회남 strike: stage ${this.o.stage} before the wave of ${this.wave.size}`);
    const any = sc.units.slice(0, PLAYER_SLOTS).some((u) => u.status === Status.Field && u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted));
    if (!any) return;
    if (b.info.turn === 0) await sc.victoryWindow(true);
    await sc.say(S.playerPhase);
    for (const u of sc.units) tryCure(b.rng, u, u.officer === 0xffff ? 0 : b.officerOf(u).lead);
    this.policy.stats.turns = b.info.turn + 1;
    const orders = this.orders(b.info.turn + 1);
    const done = new Set<number>();
    for (let g = 0; g < 30 && b.info.result === 0; g++) {
      const cand = sc.units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && u.mode === AiMode.Player && !(u.flags & (UnitFlag.Acted | UnitFlag.Confused)) && !done.has(u.slot));
      if (!cand.length) break;
      // pick the unit with the best action now (killers first), the leader last unless it can kill
      let best: { a: Act; u: Unit } | null = null;
      for (const u of cand) {
        const at = u.y * b.width + u.x;
        b.s.unitAt[at] = NONE;
        this.buildThreat();
        b.s.unitAt[at] = u.slot;
        const a = this.bestAction(u, orders(u));
        const pri = a.value + (a.kill ? 1000 : 0) - (u.officer === 0 ? 500 : 0);
        if (!best || pri > best.a.value + (best.a.kill ? 1000 : 0) - (best.u.officer === 0 ? 500 : 0)) best = { a, u };
      }
      if (!best) break;
      done.add(best.u.slot);
      // recompute threat for the chosen unit exactly
      await this.execute(best.u, best.a);
      if (b.info.result) return;
      await sc.victoryCheck();
    }
  }

  bestAction(u: Unit, ord: UnitOrder): Act {
    const b = this.b, sc = this.sc, o = this.of(u);
    const slot = u.slot, home: [number, number] = [u.x, u.y];
    const hp = Math.max(1, o.hp), max = maxHp(o);
    const isL = u.officer === 0;
    const mt = moveTypeOf(b.s, u);
    let best: Act = { x: u.x, y: u.y, kind: 'wait', target: NONE, tactic: NONE, value: -1e9, kill: false };
    const tactics = castableTactics(o, u.mp, b.learn).filter((t) => !(t < 5 && WEATHER_TYPE[b.info.weather] === RAIN));
    const held = u.officer < 0x100 ? b.stateOfficer(u).dyn.items.map((id, index) => ({ id, index })).filter((e) => e.id !== 0xff) : [];
    const sleepers = this.enemies().filter((e) => this.sleeping(e));
    const risk = ord.risk ?? 1;
    for (const [x, y] of this.reachable(u)) {
      if (ord.ban?.(x, y)) continue;
      b.place(slot, null, x, y);
      const k = y * b.width + x;
      let base = 0;
      // wake bans
      let wakeBad = false;
      for (const e of sleepers) if (this.threat.get(e.slot)?.[k] && !(ord.wakeOk?.(e.slot) ?? true)) wakeBad = true;
      if (wakeBad) base -= 500;
      const d = this.danger(u, x, y);
      const r = d.worst / hp;
      if (isL) base -= risk * (r > 0.85 ? 5000 * (r - 0.85) + 300 : 0) + risk * 60 * r * r;
      else base -= risk * (r > 1 ? 120 + 40 * (r - 1) : 0) + risk * 40 * r * r;
      base += Math.min(30, terrainDefence(terrainAt(b.s, x, y))) * 0.3;
      if (ord.anchor) base -= (ord.pull ?? 4) * Math.max(0, this.pathDist(ord.anchor, mt, x, y) - 0);
      if (ord.bonus) base += ord.bonus(x, y);
      const t = terrainAt(b.s, x, y);
      if (hp < max * 0.5 && (t === 8 || t === 13 || t === 14)) base += 15;
      if (base > best.value) best = { x, y, kind: 'wait', target: NONE, tactic: NONE, value: base, kill: false };
      if (ord.noAct) continue;
      // physical
      const range = CLASS_RANGE[o.cls];
      if (range !== NONE)
        for (const dd of unitsInRange(b.s, u, range, x, y, false)) {
          const D = this.units[dd];
          if (!(D.flags & UnitFlag.Visible)) continue;
          const od = this.of(D);
          const dmg = physicalDamage({ attack: attackPower(o, u.morale, b.s.items), defence: defencePower(od, D.morale, b.s.items), attackerClass: o.cls, defenderClass: od.cls, defenderTerrain: terrainAt(b.s, D.x, D.y), defenderHp: od.hp, counter: false });
          const kill = dmg >= od.hp;
          const th = this.foeThreat(D);
          let v = base + (100 * dmg) / maxHp(od) + (kill ? 60 + th / 8 : 0) + 25 * (1 - od.hp / maxHp(od));
          if (this.sleeping(D) && !(ord.wakeOk?.(D.slot) ?? true)) v -= 300;
          if (!kill && CLASS_ATTACK_TYPE[od.cls] === 0) {
            const at = CLASS_ATTACK_TYPE[o.cls];
            if (at === 0 || at === 2 || at === 5) {
              const cd = physicalDamage({ attack: attackPower(od, D.morale, b.s.items), defence: defencePower(o, u.morale, b.s.items), attackerClass: od.cls, defenderClass: o.cls, defenderTerrain: t, defenderHp: 0xffff, counter: true });
              v -= (od.force / 150) * (cd / hp) * (isL ? 200 : 60);
            }
          }
          if (kill && this.threat.get(dd)?.[k]) v += risk * 40 * ((d.worst / hp) ** 2 - (Math.max(0, d.worst - this.hitOn(D, u, x, y)) / hp) ** 2) * (isL ? 3 : 1);
          if (v > best.value) best = { x, y, kind: 'attack', target: dd, tactic: NONE, value: v, kill };
        }
      // tactics
      for (const tc of tactics) {
        const p = TACTIC_POWER[tc];
        if (tc <= 14) {
          const el = Math.trunc(tc / 5);
          for (const dd of unitsInRange(b.s, u, p | 0x80, x, y, false)) {
            const D = this.units[dd];
            if (!(D.flags & UnitFlag.Visible) || !tacticTerrainOk(el, terrainAt(b.s, D.x, D.y))) continue;
            const od = this.of(D);
            const pc = tacticSkill(o);
            let pt = tacticSkill(od) >> 2;
            if (resistsTactics(od.cls)) pt <<= 1;
            const hit = pc > 0 ? Math.max(0, pc - 1 - pt) / pc : 0;
            let dmg = Math.min(od.hp, this.tacDmg(o, od, el, p, terrainAt(b.s, D.x, D.y)));
            let tot = (hit * 100 * dmg) / maxHp(od) + (dmg >= od.hp ? hit * (60 + this.foeThreat(D) / 8) : 0);
            if (tc % 5 >= 3) tot *= 1.3;
            let v = base + tot - TACTIC_MP[tc] * 0.5;
            if (this.sleeping(D) && !(ord.wakeOk?.(D.slot) ?? true)) v -= 300;
            if (v > best.value) best = { x, y, kind: 'tactic', target: dd, tactic: tc, value: v, kill: dmg >= od.hp && hit > 0.9 };
            void dmg;
          }
        } else if (tc <= 17) {
          for (const dd of unitsInRange(b.s, u, p | 0x80, x, y, false)) {
            const D = this.units[dd];
            if (!(D.flags & UnitFlag.Visible) || D.flags & UnitFlag.Confused) continue;
            const od = this.of(D);
            const pc = tacticSkill(o);
            let pt = Math.trunc(tacticSkill(od) / 2);
            if (resistsTactics(od.cls)) pt *= 2;
            const ps = pc > 0 ? Math.max(0, pc - 1 - pt) / pc : 0;
            const stay = 1 - Math.min(1, (od.lead + D.morale) / 300);
            let v = base + ps * stay * this.foeThreat(D) / 6 - TACTIC_MP[tc] * 0.5;
            if (this.sleeping(D)) v -= 50;
            if (v > best.value) best = { x, y, kind: 'tactic', target: dd, tactic: tc, value: v, kill: false };
          }
        } else if (tc >= 21 && tc <= 29) {
          const kind = healKind(tc);
          for (const dd of unitsInRange(b.s, u, p | 0x80, x, y, true)) {
            const T = this.units[dd], ot = this.of(T);
            if (!healUseful(kind, ot, T.morale, (T.flags & UnitFlag.Confused) !== 0)) continue;
            let v = base - TACTIC_MP[tc] * 0.3;
            if (kind & 1) v += (Math.min((p + 1) * 600, maxHp(ot) - ot.hp) / maxHp(ot)) * (T.officer === 0 ? 160 : 80) * (ot.hp < maxHp(ot) * 0.8 ? 1 : 0.2);
            if (kind & 2) v += (T.flags & UnitFlag.Confused ? 40 : 0) + (T.morale < 50 ? (60 - T.morale) * 0.5 : 0);
            if (v > best.value) best = { x, y, kind: 'tactic', target: dd, tactic: tc, value: v, kill: false };
          }
        }
      }
      // items
      for (const it of held) {
        const id = it.id;
        if (id >= 0x13 && id <= 0x1a) {
          const kk = id - 0x13;
          if (o.cls === [0, 1, 3, 4, 6, 7, 9, 10][kk] && o.level >= [15, 30, 15, 30, 15, 30, 15, 30][kk]) {
            const v = base + 200;
            if (v > best.value) best = { x, y, kind: 'item', target: NONE, tactic: NONE, value: v, kill: false, item: it };
          }
        } else if (id === 0x21 || (id >= 0x2b && id <= 0x2d)) {
          const bomb = id === 0x21;
          for (const dd of unitsInRange(b.s, u, bomb ? 0x81 : CONFUSE_ITEM_RANGE[id - 0x2b] | 0x80, x, y, false)) {
            const D = this.units[dd];
            if (!(D.flags & UnitFlag.Visible) || (!bomb && D.flags & UnitFlag.Confused)) continue;
            // 폭탄: the emergency rule of the policy (one per battle, only on an enemy that can nearly
            // finish 유비 this phase); the strike is not built on them
            if (bomb && (this.policy.bombsUsed >= BOMBS_PER_BATTLE || !this.policy.threatensLeader(dd, 0.8))) continue;
            const od = this.of(D);
            const th = this.foeThreat(D);
            let v: number;
            if (bomb) {
              const kill = od.hp <= 1350;
              v = base + (kill ? 70 + th / 8 : (100 * 1350) / maxHp(od) * 0.6) - 50;
              if (this.sleeping(D) && !(ord.wakeOk?.(D.slot) ?? true)) v -= 300;
              if (v > best.value) best = { x, y, kind: 'item', target: dd, tactic: NONE, value: v, kill, item: it };
            } else {
              const stay = 1 - Math.min(1, (od.lead + D.morale) / 300);
              v = base + stay * th / 6 - 6;
              if (this.sleeping(D)) v -= 50;
              if (v > best.value) best = { x, y, kind: 'item', target: dd, tactic: NONE, value: v, kill: false, item: it };
            }
          }
        } else if ((id >= 0x1e && id <= 0x20) || (id >= 0x34 && id <= 0x36)) {
          const power = id >= 0x34 ? id - 0x34 : id % 3;
          for (const dd of unitsInRange(b.s, u, power | 0x80, x, y, true)) {
            const T = this.units[dd], ot = this.of(T);
            if (ot.hp >= maxHp(ot) * (T.officer === 0 ? 0.7 : 0.5)) continue;
            const v = base + (Math.min((power + 1) * 600, maxHp(ot) - ot.hp) / maxHp(ot)) * (T.officer === 0 ? 160 : 70) - 10;
            if (v > best.value) best = { x, y, kind: 'item', target: dd, tactic: NONE, value: v, kill: false, item: it };
          }
        }
      }
    }
    b.place(slot, null, home[0], home[1]);
    void sc;
    return best;
  }

  async execute(u: Unit, a: Act) {
    const sc = this.sc, b = this.b;
    const o = this.of(u);
    const before = o.level * 100 + o.exp;
    const st = this.policy.stats;
    const per = st.byOfficer.get(u.officer) ?? { hits: 0, kills: 0, tactics: 0, heals: 0 };
    st.byOfficer.set(u.officer, per);
    if (a.x !== u.x || a.y !== u.y) {
      b.place(u.slot, null, a.x, a.y);
      u.flags |= UnitFlag.Moved;
    }
    this.log?.(`T${b.info.turn + 1} ${b.stateOfficer(u).name}@${a.x},${a.y} ${a.kind}${a.tactic !== NONE ? ' t' + a.tactic : ''}${a.item ? ' i' + a.item.id.toString(16) : ''}${a.target !== NONE ? ' ->' + b.stateOfficer(this.units[a.target]).name + '(' + this.of(this.units[a.target]).hp + ')' : ''} hp=${this.of(u).hp} v=${a.value.toFixed(0)}`);
    if (a.kind === 'attack') {
      await sc.doAttack(u.slot, a.target);
      if (this.units[a.target].status !== Status.Field) this.stats.kills++;
    } else if (a.kind === 'tactic') await sc.castFlow(u.slot, a.tactic, false, a.target);
    else if (a.kind === 'item' && a.item) {
      const ok = await sc.useItem(u.slot, a.item.id, a.item.index, a.target);
      if (ok && a.item.id === 0x21) {
        this.stats.bombs++;
        this.policy.bombsUsed++;
      }
      if (ok && a.item.id >= 0x2b && a.item.id <= 0x2d) this.stats.conf++;
    }
    u.flags |= UnitFlag.Acted;
    const gained = Math.max(0, o.level * 100 + o.exp - before);
    if (a.kind === 'attack') {
      st.actions.attack++;
      if (a.kill) st.actions.kill++;
      if (a.kill) per.kills += gained;
      else per.hits += gained;
    } else if (a.kind === 'tactic') {
      st.tactics.set(a.tactic, (st.tactics.get(a.tactic) ?? 0) + 1);
      if (a.tactic >= 21) {
        st.actions.heal++;
        per.heals += gained;
      } else {
        st.actions.tactic++;
        per.tactics += gained;
      }
    } else if (a.kind === 'item') st.actions.item = (st.actions.item ?? 0) + 1;
    else st.actions.wait++;
    if (b.info.result === 0 && u.status === Status.Field) await sc.unitEvents(u.slot);
  }
}

export interface Act {
  x: number;
  y: number;
  kind: 'wait' | 'attack' | 'tactic' | 'item';
  target: number;
  tactic: number;
  value: number;
  kill: boolean;
  item?: { id: number; index: number };
}

function centroid(us: Unit[]): [number, number] | null {
  const f = us.filter((u) => u.status === Status.Field);
  if (!f.length) return null;
  return [Math.round(f.reduce((a, u) => a + u.x, 0) / f.length), Math.round(f.reduce((a, u) => a + u.y, 0) / f.length)];
}

function southPlan(h: HuainanStrike, turn: number, phase: string, hold: [number, number], o: StrikeOptions): (u: Unit) => UnitOrder {
  if (phase !== 'wave' && h.waveDead === null) h.waveDead = turn;
  if (phase === 'wave') {
    const wc = centroid(h.waveLeft());
    return (u) => ({ anchor: u.officer === 0 ? (o.leaderHold ?? hold) : wc && o.chase ? wc : hold, pull: u.officer === 0 ? 3 : o.pull ?? 1.5, wakeOk: () => false, risk: u.officer === 0 ? 1 : o.waveRisk ?? 1 });
  }
  // south phase: escape when possible
  return southPhase(h, turn, o);
}

/** after the wave: peel the waiting units one at a time with a bait, then (late) walk 유비 to (0,2) */
function southPhase(h: HuainanStrike, turn: number, o: StrikeOptions): (u: Unit) => UnitOrder {
  const L = h.leader()!;
  const b = h.b, W = b.width;
  const left = 30 - turn + 1;
  const need = Math.ceil(h.pathDist([0, 2], 0, L.x, L.y) / 4);
  const enemies = h.enemies();
  const go = o.goAt !== undefined ? turn >= o.goAt : need + (o.margin ?? 2) >= left && enemies.length > (o.fightTo ?? 3);
  if (go) {
    return (u) => {
      if (u.officer === 0) return { anchor: [0, 2], pull: 30, wakeOk: () => true, risk: 0.7 };
      return { anchor: escortCell(h, u, L), pull: 3, wakeOk: () => true };
    };
  }
  const ours = h.ours();
  const zones = new Map<number, Uint8Array>();
  for (const e of enemies) zones.set(e.slot, h.enemyHit(e));
  const inZone = (e: Unit) => ours.some((u) => zones.get(e.slot)![u.y * W + u.x]);
  const engaged = new Set(enemies.filter((e) => !h.sleeping(e) || inZone(e)).map((e) => e.slot));
  const cx = Math.round(ours.reduce((a, u) => a + u.x, 0) / ours.length), cy = Math.round(ours.reduce((a, u) => a + u.y, 0) / ours.length);
  let bait: { slot: number; cell: [number, number]; target: number } | null = null;
  if (engaged.size <= (o.maxEngaged ?? 0)) {
    const sleepers = enemies.filter((e) => !engaged.has(e.slot)).sort((a, z) => h.pathDist([cx, cy], 0, a.x, a.y) - h.pathDist([cx, cy], 0, z.x, z.y));
    for (const T of sleepers.slice(0, 3)) {
      const zt = zones.get(T.slot)!;
      // candidate bait units: sturdy first, not the leader
      const cands = ours.filter((u) => u.officer !== 0).sort((a, z) => h.of(z).hp * 1 - h.of(a).hp * 1);
      for (const u of cands) {
        let bestCell: [number, number] | null = null, bd = 1e9;
        for (const [x, y] of h.reachable(u)) {
          const k = y * W + x;
          if (!zt[k]) continue;
          const extra = enemies.filter((e) => e.slot !== T.slot && !engaged.has(e.slot) && zones.get(e.slot)![k]).length;
          if (extra > (o.maxExtra ?? 1)) continue;
          const d = h.pathDist([cx, cy], 0, x, y) + extra * 30 + (h.danger(u, x, y).worst > h.of(u).hp * 0.7 ? 50 : 0);
          if (d < bd) [bd, bestCell] = [d, [x, y]];
        }
        if (bestCell && h.of(u).hp > maxHpOf(h, u) * 0.6) { bait = { slot: u.slot, cell: bestCell, target: T.slot }; break; }
      }
      if (bait) break;
    }
  }
  if (bait) h.log?.(`T${turn} bait ${b.stateOfficer(h.units[bait.slot]).name} at ${bait.cell} for ${b.stateOfficer(h.units[bait.target]).name}@${h.units[bait.target].x},${h.units[bait.target].y}`);
  const baitWakes = new Set<number>();
  if (bait) for (const e of enemies) if (zones.get(e.slot)![bait.cell[1] * W + bait.cell[0]]) baitWakes.add(e.slot);
  const ok = (s: number) => engaged.has(s) || baitWakes.has(s);
  // where to gather: near the bait, or near the engaged enemies, or the bridge
  const focus: [number, number] = bait ? bait.cell : engaged.size ? (() => { const es = enemies.filter((e) => engaged.has(e.slot)); return [Math.round(es.reduce((a, e) => a + e.x, 0) / es.length), Math.round(es.reduce((a, e) => a + e.y, 0) / es.length)] as [number, number]; })() : (o.peelAt ?? [18, 13]);
  return (u) => {
    if (bait && u.slot === bait.slot) return { anchor: bait.cell, pull: 40, wakeOk: ok, noAct: false };
    if (u.officer === 0) return { anchor: focus, pull: 1, wakeOk: ok, risk: 1 };
    return { anchor: focus, pull: o.pull2 ?? 2, wakeOk: ok };
  };
}

function maxHpOf(h: HuainanStrike, u: Unit): number {
  const o = h.of(u);
  return maxHp(o);
}

function escortCell(h: HuainanStrike, u: Unit, L: Unit): [number, number] {
  // ahead of 유비 along his path: the gap cells row 14 once he is past
  if (L.y <= 13 && L.x <= 10) {
    const plugs: [number, number][] = [[8, 14], [9, 14], [10, 14], [3, 14], [2, 14]];
    return plugs[u.slot % plugs.length];
  }
  return [L.x, L.y];
}

