// Grinding simulator, part 3: one battle from a snapshot with a parameter set, and the per-battle
// search over parameter variants (the plan that is kept is the best winning variant).

import type { GameState } from '../../engine/state';
import type { ScriptState } from '../../engine/script';
import { NONE as NONE_SLOT, PLAYER_SLOTS, Status } from '../../engine/battle/types';
import { battleNameLines } from '../../engine/battle/map';
import type { BattleScene } from '../../native/battle/scene';
import { shopVisit, type Purchase } from './shop';
import { assetsFor, buildSandbox, type BattleSnapshot } from './sandbox';
import { GrindPolicy, analyseBattle, clampParams, pickFormation, type GrindParams, type GrindStats } from './policy';

export interface OfficerGain {
  officer: number;
  name: string;
  levelBefore: number;
  levelAfter: number;
  expGained: number;
  hits: number;
  kills: number;
  tactics: number;
  heals: number;
}

export interface BattleOutcome {
  won: boolean;
  /** Why a lost try was lost (report text). */
  loss?: string;
  result: number;
  turns: number;
  turnLimit: number;
  finishTurn: number | null;
  params: GrindParams;
  gains: OfficerGain[];
  /** Total exp gained by deployed officers below 99, weighted by need (the search objective). */
  score: number;
  expTotal: number;
  kept: string[];
  deployed: number[];
  actions: GrindStats['actions'];
  tactics: Record<string, number>;
  /** The sortie list a won battle leaves for a chained formation battle (runBattle in scene.ts). */
  formationOut: number[] | undefined;
  /** Officer level/exp/class/items after the battle (all officers). */
  officersAfter: OfficerCarry[];
  moneyAfter: number;
  /** What was bought at the merchants before the battle. */
  purchases: Purchase[];
  rngAfter: number;
  ms: number;
}

export interface OfficerCarry {
  level: number;
  exp: number;
  /** Class (promotions change it); absent = the snapshot's. */
  cls?: number;
  /** The 8 item slots; absent = the snapshot's. */
  items?: number[];
}

export interface CarryState {
  /** Officer level/exp (and class/items) to start the battle with (index = officer), null = take the snapshot's. */
  officers: OfficerCarry[] | null;
  /** Gold to start with; absent = the snapshot's. */
  money?: number;
  /** The sortie list left by the previous battle (formation-flag battles without their own FORMATION). */
  formation: number[] | undefined;
}

const dec = new TextDecoder('euc-kr');

/** Applies carried levels and the formation picks to a cloned state. */
export function prepareState(snap: BattleSnapshot, carry: CarryState | null, params: GrindParams, bought?: Purchase[], shopping = true) {
  return (state: GameState, script: ScriptState, extras: { formation: number[] | undefined }) => {
    if (carry?.officers)
      carry.officers.forEach((c, i) => {
        const d = state.officers[i]?.dyn;
        if (d) {
          d.level = c.level;
          d.exp = c.exp;
          if (c.cls !== undefined) d.cls = c.cls;
          if (c.items) d.items = [...c.items];
        }
      });
    if (carry?.money !== undefined) state.progress.money = carry.money;
    // the merchants passed since the previous battle
    if (shopping) for (const list of snap.shops ?? []) bought?.push(...shopVisit(state, list));
    const fi = snap.formationInfo;
    if (fi) {
      const free = fi.records.length;
      const picks = pickFormation(state, fi.fixed, free, params.strong);
      if (fi.hexFormation) extras.formation = [...fi.fixed, ...picks];
      else
        fi.records.forEach((r, k) => {
          script.units[r].officer = picks[k] ?? 0xffff;
        });
    } else if (script.hexFlag & 1 && carry?.formation) extras.formation = [...carry.formation];
  };
}

/** Plays one battle from `snap` with `params`. */
export async function runGrindBattle(
  files: Map<string, Uint8Array>,
  snap: BattleSnapshot,
  params: GrindParams,
  carry: CarryState | null = null,
  trace?: (line: string) => void,
): Promise<BattleOutcome> {
  const t0 = performance.now();
  const p = { ...params };
  let policy: GrindPolicy | null = null;
  let before: { level: number; exp: number }[] = [];
  let scene0: BattleScene | null = null;
  let rerolls = p.rerolls ?? 0;
  const purchases: Purchase[] = [];
  const run = buildSandbox(
    files,
    snap,
    (scene) => {
      scene0 = scene;
      const stage = scene.ctx.vm.stage;
      policy = new GrindPolicy(scene, p, analyseBattle(stage, scene.ctx.vm.state));
      policy.install();
      if (rerolls > 0) {
        rerolls--;
        policy.retreatNow = true;
      }
      if (trace) policy.log = trace;
      before = scene.ctx.state.officers.map((o) => ({ level: o.dyn.level, exp: o.dyn.exp }));
    },
    prepareState(snap, carry, p, purchases),
  );
  const { scene, ctx } = run;
  // a battle that never ends (should not happen: the turn limit ends every battle) is cut off
  const result = await scene.run();
  const pol = policy as GrindPolicy | null;
  const stats = pol?.stats;
  const dep = scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < 0x100).map((u) => u.officer);
  const gains: OfficerGain[] = [];
  let score = 0, expTotal = 0;
  for (const off of dep) {
    const o = ctx.state.officers[off];
    const b0 = before[off] ?? { level: o.dyn.level, exp: o.dyn.exp };
    const g = o.dyn.level * 100 + o.dyn.exp - (b0.level * 100 + b0.exp);
    const st = stats?.byOfficer.get(off) ?? { hits: 0, kills: 0, tactics: 0, heals: 0 };
    gains.push({ officer: off, name: o.name, levelBefore: b0.level, levelAfter: o.dyn.level, expGained: g, ...st });
    expTotal += g;
    // need-weighted: exp below level 99 counts, more for officers further away
    score += g * (1 + (99 - Math.min(99, b0.level)) / 99);
  }
  const won = result === 2;
  // why a try was lost (for the report): the leader / defeat officer gone, the time limit, a
  // scripted game over (a turn deadline), or the whole side gone
  let loss: string | undefined;
  if (!won) {
    const sv = ctx.vm.state;
    const leaders = [0, ...(sv.defeat.enabled ? [sv.defeat.officer] : [])];
    const fallen = leaders.find((off) => {
      const sl = scene.b.slotOfOfficer(off);
      return sl !== NONE_SLOT && scene.units[sl].status !== Status.Field;
    });
    if (fallen !== undefined) loss = `${ctx.state.officers[fallen]?.name ?? fallen} 퇴각`;
    else if (scene.b.info.turn >= scene.b.info.turnLimit) loss = '제한 턴 초과';
    else if (ctx.state.status & 0x20) loss = '이벤트 패배(기한 등)';
    else if (scene.units.slice(0, PLAYER_SLOTS).every((u) => u.status !== Status.Field)) loss = '아군 전멸';
    else loss = `결과 ${result}`;
    if (stats?.finishReason && stats.finishReason !== 'deadline') loss += ` · 마무리 계기 ${stats.finishReason}`;
    if (p.native) loss += ' (게임 AI)';
  }
  const names = battleNameLines(assetsFor(files).file('HEXZMAP.R3'));
  void names;
  const formationOut = won ? scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < 0x400).map((u) => u.officer) : undefined;
  void scene0;
  return {
    won,
    loss,
    result,
    turns: stats?.turns ?? scene.b.info.turn,
    turnLimit: scene.b.info.turnLimit,
    finishTurn: stats?.finishTurn ?? null,
    params: p,
    gains,
    score: won ? score : -1,
    expTotal,
    kept: (stats?.kept ?? []).map((k) => ctx.state.officers[k]?.name ?? String(k)),
    deployed: dep,
    actions: stats?.actions ?? { attack: 0, kill: 0, tactic: 0, heal: 0, wait: 0 },
    tactics: Object.fromEntries([...(stats?.tactics ?? new Map()).entries()].map(([t, n]) => [String(t), n])),
    formationOut,
    officersAfter: ctx.state.officers.map((o) => ({ level: o.dyn.level, exp: o.dyn.exp, cls: o.dyn.cls, items: [...o.dyn.items] })),
    moneyAfter: ctx.state.progress.money,
    purchases,
    rngAfter: run.rng.seed,
    ms: performance.now() - t0,
  };
}

/** runGrindBattle, with an engine/policy exception counted as a lost try (logged) instead of ending the search. */
export async function safeGrindBattle(files: Map<string, Uint8Array>, snap: BattleSnapshot, params: GrindParams, carry: CarryState | null): Promise<BattleOutcome> {
  try {
    return await runGrindBattle(files, snap, params, carry);
  } catch (e) {
    console.error(`grind: battle ${snap.index} ${snap.name} threw: ${(e as Error).stack ?? e}`);
    return {
      won: false, result: -1, turns: 0, turnLimit: 0, finishTurn: null, params, gains: [], score: -1, expTotal: 0, kept: [], deployed: [],
      actions: { attack: 0, kill: 0, tactic: 0, heal: 0, wait: 0 }, tactics: {}, formationOut: undefined, officersAfter: [], moneyAfter: 0, purchases: [], rngAfter: 0, ms: 0,
    };
  }
}

export function battleName(files: Map<string, Uint8Array>, map: number): string {
  const names = battleNameLines(assetsFor(files).file('HEXZMAP.R3'));
  return dec.decode(names[map] ?? new Uint8Array(0)).trim();
}

/** A small deterministic PRNG for the search (never the game's RNG). */
export class SearchRng {
  constructor(public s: number) {
    this.s = s >>> 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x100000000;
  }
  normal(): number {
    const u = Math.max(1e-9, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

export interface BattleSearch {
  best: BattleOutcome;
  tried: { params: GrindParams; won: boolean; score: number; turns: number; loss?: string }[];
}

/** A fighting preset for battles the team can barely win: kill, focus fire, avoid losses. */
export function aggressive(base: GrindParams): GrindParams {
  return { ...base, keep: 1, conserve: 0, kill: 1.5, risk: Math.max(2, base.risk), approach: 0.6, finish: Math.max(base.finish, 10) };
}

/**
 * Searches plans for one battle: the base parameters, the elite plan kept for this battle, the
 * fighting preset, then mutations around the best plan so far (keep / finish / weights) and
 * rerolls (총퇴각 at turn 1, which moves the RNG on). Keeps the best win (need-weighted exp). If
 * nothing wins within `variants` tries, up to `rescue` more tries alternate between the game's own
 * AI playing our side (native) and the fighting preset, each with further rerolls.
 */
export async function searchBattle(
  files: Map<string, Uint8Array>,
  snap: BattleSnapshot,
  base: GrindParams,
  carry: CarryState | null,
  variants: number,
  rng: SearchRng,
  elite?: GrindParams,
  rescue = 6,
  hint?: GrindParams,
): Promise<BattleSearch> {
  const tried: BattleSearch['tried'] = [];
  let best: BattleOutcome | null = null;
  const consider = (o: BattleOutcome) => {
    tried.push({ params: o.params, won: o.won, score: o.score, turns: o.turns, loss: o.loss });
    if (!best || (o.won && !best.won) || (o.won === best.won && o.score > best.score)) best = o;
  };
  const queue: GrindParams[] = [{ ...base, rerolls: 0 }];
  if (elite) queue.push({ ...elite });
  if (hint) queue.push({ ...hint });
  if (variants > 1) queue.push({ ...aggressive(base), rerolls: 0 });
  const mutate = (src: GrindParams): GrindParams => {
    const m: GrindParams = { ...src };
    m.keep = src.keep + Math.round(rng.normal() * 1.5);
    m.finish = src.finish + Math.round(rng.normal() * 3);
    m.conserve = src.conserve * Math.exp(rng.normal() * 0.4);
    m.risk = src.risk * Math.exp(rng.normal() * 0.4);
    m.tactic = src.tactic * Math.exp(rng.normal() * 0.3);
    m.kill = src.kill * Math.exp(rng.normal() * 0.4);
    const out = clampParams(m);
    out.rerolls = rng.next() < 0.5 ? src.rerolls ?? 0 : Math.floor(rng.next() * 8);
    return out;
  };
  if (variants <= 1 && elite) queue.splice(0, queue.length, { ...elite });
  for (let i = 0; i < Math.max(variants, queue.length); i++) {
    const c = i < queue.length ? queue[i] : mutate((best as BattleOutcome | null)?.won ? (best as unknown as BattleOutcome).params : queue[Math.floor(rng.next() * queue.length)]);
    consider(await safeGrindBattle(files, snap, c, carry));
  }
  for (let r = 1; r <= rescue && !(best as BattleOutcome | null)?.won; r++) {
    // alternately: the game's own AI plays our side (native), and the fighting preset
    const a = aggressive(base);
    const c: GrindParams = r % 2 ? { ...base, native: true, rerolls: (r - 1) / 2 } : { ...a, finish: r % 4 === 2 ? 99 : a.finish, rerolls: r + 7 };
    consider(await safeGrindBattle(files, snap, c, carry));
  }
  return { best: best as unknown as BattleOutcome, tried };
}
