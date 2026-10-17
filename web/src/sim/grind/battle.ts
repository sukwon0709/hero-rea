// Grinding simulator, part 3: one battle from a snapshot with a parameter set, and the per-battle
// search over parameter variants (the plan that is kept is the best winning variant).

import type { GameState } from '../../engine/state';
import type { ScriptState } from '../../engine/script';
import { NONE as NONE_SLOT, PLAYER_SLOTS, Status, loadLearnTable } from '../../engine/battle/types';
import { battleNameLines } from '../../engine/battle/map';
import type { BattleScene } from '../../native/battle/scene';
import { shopVisit, type Purchase } from './shop';
import { assetsFor, buildSandbox, type BattleSnapshot } from './sandbox';
import { describeGain } from './events';
import { HuainanStrike } from './huainan';
import { LurePlan, lureOptionsFor, scriptTraps } from './lure';
import { mixSeed } from './search';
import { GrindPolicy, analyseBattle, clampParams, paramOr, isHuainan, isHuainanAt, huainanPicks, pickFormation, type GrindParams, type GrindStats } from './policy';

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
  /** Why the policy started finishing (deadline, done, idle, leader, losses, escape, ...). */
  finishReason?: string;
  /** Turns the wake phase held off an early finish (GrindParams.wake). */
  wakeTurns?: number;
  /** Look-ahead search counters (GrindParams.search): phases searched, rollouts, phases changed. */
  search?: { phases: number; rollouts: number; changed: number };
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
  /** The battle script's gains and early endings, and which gains the bot got. */
  script?: ScriptNotes;
  /** The battle start (after the merchants): gold, 폭탄 held, our levels against the enemy's. */
  start?: BattleStart;
}

/** What a battle starts with (after the shopping): the log and the report show it. */
export interface BattleStart {
  gold: number;
  /** 폭탄 (0x21) held by 유비's faction. */
  bombs: number;
  /** Average level of the 9 highest-level members of 유비's faction (deployed or not). */
  top9: number;
  /** Average level of the deployed officers. */
  sortie: number;
  /** Average and highest level of the enemy units set up at the start (reserves included). */
  enemyAvg: number;
  enemyMax: number;
  enemies: number;
}

/** BattleStart of a scene right after the battle setup. */
export function battleStart(scene: BattleScene): BattleStart {
  const st = scene.ctx.state;
  const faction = st.officers[0].dyn.flags & 0x1f;
  const ours = st.officers.filter((o, i) => i < 0x100 && (o.dyn.flags & 0x80) !== 0 && (o.dyn.flags & 0x1f) === faction);
  const top = ours.map((o) => Math.min(99, o.dyn.level)).sort((a, b) => b - a).slice(0, 9);
  const avg = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0);
  const sortie = scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < st.officers.length).map((u) => st.officers[u.officer].dyn.level);
  const enemy = scene.units.slice(PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < st.officers.length).map((u) => st.officers[u.officer].dyn.level);
  return {
    gold: st.progress.money,
    bombs: ours.reduce((n, o) => n + o.dyn.items.filter((v) => v === 0x21).length, 0),
    top9: avg(top),
    sortie: avg(sortie),
    enemyAvg: avg(enemy),
    enemyMax: enemy.length ? Math.max(...enemy) : 0,
    enemies: enemy.length,
  };
}

/** The log's short form: `gold 900 폭탄 1 Lv 12.3 (sortie 11.0) vs enemy 14.2 (max 18, 22 units)`. */
export function startLine(s: BattleStart | undefined): string {
  if (!s) return '';
  return `gold ${s.gold} 폭탄 ${s.bombs} Lv ${s.top9.toFixed(1)} (sortie ${s.sortie.toFixed(1)}) vs enemy ${s.enemyAvg.toFixed(1)} (max ${s.enemyMax}, ${s.enemies} units)`;
}

export interface ScriptNotes {
  gains: { record: number; kind: string; when: string; gives: string; fired: boolean; automatic: boolean }[];
  /** Victory bonus given to every unit on the field (0 if none or lost). */
  bonus: number;
  /** Korean notes: what ends or turns the battle before the turn limit. */
  early: string[];
}

/** What the policy knew and got from the battle script (for the report). */
export function scriptNotes(policy: GrindPolicy | null, state: GameState, won: boolean, turnLimit: number): ScriptNotes | undefined {
  if (!policy) return undefined;
  const k = policy.know;
  const name = (o: number) => state.officers[o]?.name ?? `#${o}`;
  const fired = new Set(policy.stats.gainsFired ?? []);
  const gains = k.gains.map((g) => ({ record: g.record, kind: g.kind, ...describeGain(g, name), fired: fired.has(g.record), automatic: g.automatic }));
  const early: string[] = [];
  if (k.deadline !== null && k.deadline < turnLimit) early.push(`${k.deadline}턴 이벤트로 패배(제한 ${turnLimit}턴보다 이름)`);
  if (k.endsAt !== null && k.endsAt < turnLimit) early.push(`${k.endsAt}턴에 이벤트로 승리 종료(버티기)`);
  for (const e of k.turns) {
    if (e.turn !== null && e.removes.some((o) => o < 0x100 && (state.officers[o]?.dyn.flags ?? 0) & 0x80 && ((state.officers[o].dyn.flags & 0x1f) === (state.officers[0].dyn.flags & 0x1f))))
      early.push(`${e.turn}턴에 아군 ${e.removes.map(name).join('·')} 이탈`);
    if (e.turn !== null && e.reinforce.length >= 5) early.push(`${e.turn}턴 증원 ${e.reinforce.length}부대${k.soft === e.turn ? ' → 그 전에 마무리' : ''}`);
    if (e.officer !== null && e.gameOver) early.push(`${name(e.officer)} 격파되면 패배`);
  }
  return { gains, bonus: won ? (policy.stats.bonus ?? 0) : 0, early };
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
export function prepareState(snap: BattleSnapshot, carry: CarryState | null, params: GrindParams, bought?: Purchase[], shopping = true, learn?: Uint8Array) {
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
    if (shopping) for (const list of snap.shops ?? []) bought?.push(...shopVisit(state, list, { areaHeals: params.area > 0.5, scrolls: params.scrolls, bombItems: paramOr(params, 'bombBuy'), confuseItems: paramOr(params, 'confuseBuy'), healKeep: paramOr(params, 'healKeep'), promoLead: paramOr(params, 'promoLead') }));
    const fi = snap.formationInfo;
    if (fi) {
      // a record that held a placeholder at FORMATION time but now holds an enemy (the setup's
      // BATTLE_UNITS wrote over it: 서주 2nd's 차주, 연주's record 8) is not a free pick; writing
      // over it removed that enemy, and with it the defeat event the battle needs
      const recs = fi.hexFormation ? fi.records : fi.records.filter((r) => !(script.units[r].flags & 1));
      const free = recs.length;
      // 회남 plan (with hnWeak): close-combat units and the strongest go out, weak archers stay behind
      const hn = params.hnPlan > 0.5 && Number.isFinite(params.hnWeak) && isHuainanAt(snap.chapter, snap.stage, snap.block);
      // officers the script places itself (a record of their own outside the free ones: 연주's 조운
      // joins at (29,7) by REINFORCE) are no picks: at FORMATION time the script had them in another
      // force (SET_FORCE #53, 14 ... FORMATION ... SET_FORCE #53, 0), so the player could not take them
      const own = script.units.flatMap((u, r) => (!recs.includes(r) && u.officer < 0x100 && !fi.fixed.includes(u.officer) ? [u.officer] : []));
      const picks = pickFormation(state, [...fi.fixed, ...own], free, params.strong, params.band > 0, params.healers, learn);
      if (hn) picks.splice(0, picks.length, ...huainanPicks(state, fi.fixed, free, picks, params.band > 0, params.healers, learn));
      if (fi.hexFormation) extras.formation = [...fi.fixed, ...picks];
      else
        recs.forEach((r, k) => {
          script.units[r].officer = picks[k] ?? 0xffff;
        });
    } else if (script.hexFlag & 1 && carry?.formation) extras.formation = [...carry.formation];
  };
}

/** Dev hooks run on each new battle scene after the policy is installed (scratch scripts: map dumps). */
export const sceneHooks: ((scene: BattleScene) => void)[] = [];

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
  let start: BattleStart | undefined;
  let rerolls = p.rerolls ?? 0;
  const purchases: Purchase[] = [];
  const run = buildSandbox(
    files,
    snap,
    (scene) => {
      scene0 = scene;
      start = battleStart(scene);
      const stage = scene.ctx.vm.stage;
      policy = new GrindPolicy(scene, p, analyseBattle(stage, scene.ctx.vm.state));
      policy.searchSeed = mixSeed(snap.index + 1, snap.rngSeed);
      policy.install();
      if (paramOr(p, 'hnStrike') > 0.5 && isHuainan(policy.know)) {
        const strike = new HuainanStrike(scene, policy, {
          stage: [paramOr(p, 'hnStageX'), paramOr(p, 'hnStageY')],
          maxExtra: paramOr(p, 'hnExtra'),
          waveRisk: paramOr(p, 'hnWaveRisk'),
        });
        strike.install();
        if (trace) strike.log = trace;
      }
      // (with the look-ahead search on, the lure plan only with srLure: the search won more at 거록 and 계교)
      const lureOn = paramOr(p, 'lure') > 0.5 && (paramOr(p, 'search') <= 0.5 || paramOr(p, 'srLure') > 0.5);
      const lo = lureOn && policy.know.stage ? lureOptionsFor(policy.know.stage.chapter, policy.know.stage.index, policy.know.block) : null;
      if (lo && policy.know.stage && policy.know.block !== undefined) {
        // the general risk weight scales the plan's (the search's mutations vary the play)
        const mul = Math.min(2, Math.max(0.5, p.risk / 1.2));
        const plan = new LurePlan(scene, policy, {
          ...lo,
          stage: lo.hold,
          risk: (lo.risk ?? 1) * mul,
          leaderRisk: (lo.leaderRisk ?? 2) * mul,
          holdTurns: Math.max(0, (lo.holdTurns ?? 0) + paramOr(p, 'luHold')),
          traps: scriptTraps(policy.know.stage, policy.know.block),
          maxExtra: paramOr(p, 'luExtra'),
          margin: paramOr(p, 'luMargin'),
          killTurns: paramOr(p, 'luKill'),
          maxEngaged: paramOr(p, 'luEngaged'),
        });
        plan.install();
        if (trace) plan.log = trace;
      }
      if (rerolls > 0) {
        rerolls--;
        policy.retreatNow = true;
      }
      if (trace) policy.log = trace;
      for (const h of sceneHooks) h(scene);
      before = scene.ctx.state.officers.map((o) => ({ level: o.dyn.level, exp: o.dyn.exp }));
    },
    prepareState(snap, carry, p, purchases, true, loadLearnTable(assetsFor(files).main)),
  );
  const { scene, ctx } = run;
  // a battle that never ends (should not happen: the turn limit ends every battle) is cut off
  const result = await scene.run();
  const pol = policy as GrindPolicy | null;
  const stats = pol?.stats;
  const dep = scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < 0x100).map((u) => u.officer);
  const gains: OfficerGain[] = [];
  let score = 0, expTotal = 0;
  // 유비 (officer 0) behind the others: his exp counts up to 5x (1 + half the level gap), so plans
  // that feed him win the search
  const others = dep.filter((off) => off !== 0).map((off) => before[off]?.level ?? ctx.state.officers[off].dyn.level);
  const avgOthers = others.length ? others.reduce((a, c) => a + c, 0) / others.length : 0;
  const liuMul = 1 + Math.max(0, Math.min(4, (avgOthers - (before[0]?.level ?? ctx.state.officers[0].dyn.level)) / 2));
  for (const off of dep) {
    const o = ctx.state.officers[off];
    const b0 = before[off] ?? { level: o.dyn.level, exp: o.dyn.exp };
    const g = o.dyn.level * 100 + o.dyn.exp - (b0.level * 100 + b0.exp);
    const st = stats?.byOfficer.get(off) ?? { hits: 0, kills: 0, tactics: 0, heals: 0 };
    gains.push({ officer: off, name: o.name, levelBefore: b0.level, levelAfter: o.dyn.level, expGained: g, ...st });
    expTotal += g;
    // need-weighted: exp below level 99 counts, more for officers further away
    score += g * (1 + (99 - Math.min(99, b0.level)) / 99) * (off === 0 ? liuMul : 1);
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
    loss = lossLabel({
      fallen: fallen !== undefined ? (ctx.state.officers[fallen]?.name ?? String(fallen)) : null,
      timeUp: scene.b.info.turn >= scene.b.info.turnLimit,
      scripted: (ctx.state.status & 0x20) !== 0,
      wiped: scene.units.slice(0, PLAYER_SLOTS).every((u) => u.status !== Status.Field),
      result,
    });
    if (stats?.finishReason && stats.finishReason !== 'deadline') loss += ` · 마무리 계기 ${stats.finishReason}`;
    if (p.native) loss += ' (게임 AI)';
  }
  const formationOut = won ? scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < 0x400).map((u) => u.officer) : undefined;
  void scene0;
  return {
    won,
    loss,
    result,
    turns: stats?.turns ?? scene.b.info.turn,
    turnLimit: scene.b.info.turnLimit,
    finishTurn: stats?.finishTurn ?? null,
    finishReason: stats?.finishReason,
    wakeTurns: stats?.wakeTurns,
    search: stats?.search,
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
    script: scriptNotes(policy, ctx.state, won, scene.b.info.turnLimit),
    start,
  };
}

/** runGrindBattle, with an engine/policy exception counted as a lost try (logged) instead of ending the search. */
// battles (by index) played without the look-ahead search, e.g. GRIND_NOSEARCH=0,1,5,7,10 for the
// easy ones the greedy policy already wins (the search is 10x slower per battle)
const noSearch = new Set((process.env.GRIND_NOSEARCH ?? '').split(',').filter((x) => x.trim() !== '').map(Number));

export async function safeGrindBattle(files: Map<string, Uint8Array>, snap: BattleSnapshot, params: GrindParams, carry: CarryState | null): Promise<BattleOutcome> {
  if (noSearch.has(snap.index)) params = { ...params, search: 0 };
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
 * Why a try was lost. The time limit first: when it runs out the field is cleared, so 유비's slot
 * is off the field then too (회남: 44 tries held to turn 30 were all reported as 유비 퇴각).
 */
export function lossLabel(f: { fallen: string | null; timeUp: boolean; scripted: boolean; wiped: boolean; result: number }): string {
  if (f.timeUp) return '제한 턴 초과';
  if (f.fallen !== null) return `${f.fallen} 퇴각`;
  if (f.scripted) return '이벤트 패배(기한 등)';
  if (f.wiped) return '아군 전멸';
  return `결과 ${f.result}`;
}

/**
 * A win beats a loss; wins by their need-weighted exp; losses (all scored -1) by the turns held,
 * then the exp made (the STOP line and the battle record show the best losing try, not the first).
 */
export function betterTry(o: Pick<BattleOutcome, 'won' | 'score' | 'turns' | 'expTotal'>, best: Pick<BattleOutcome, 'won' | 'score' | 'turns' | 'expTotal'>): boolean {
  if (o.won !== best.won) return o.won;
  if (o.won) return o.score > best.score;
  return o.turns > best.turns || (o.turns === best.turns && o.expTotal > best.expTotal);
}

/**
 * Searches plans for one battle: the base parameters, the elite plan kept for this battle, the
 * fighting preset, then mutations around the best plan so far (keep / finish / weights) and
 * rerolls (총퇴각 at turn 1, which moves the RNG on). Keeps the best win (need-weighted exp). If
 * nothing wins within `variants` tries, up to `rescue` more tries cycle through the fighting
 * preset, a defensive plan and the hold plan, each with further rerolls (no rushing plans).
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
    if (!best || betterTry(o, best)) best = o;
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
    // the lure plan's own keys (거록, 계교; no effect elsewhere), now and then the plan off
    if (rng.next() < 0.5) {
      out.luExtra = Math.max(0, Math.min(2, paramOr(src, 'luExtra') + Math.round(rng.normal())));
      out.luKill = Math.max(3, Math.min(10, paramOr(src, 'luKill') + Math.round(rng.normal() * 2)));
      out.luHold = Math.max(-3, Math.min(3, paramOr(src, 'luHold') + Math.round(rng.normal() * 1.5)));
      out.luMargin = Math.max(0, Math.min(4, paramOr(src, 'luMargin') + Math.round(rng.normal())));
    }
    if (rng.next() < 0.2) out.lure = paramOr(src, 'lure') > 0.5 ? 0.3 : 0.7;
    if (rng.next() < 0.1) out.srLure = paramOr(src, 'srLure') > 0.5 ? 0.3 : 0.7;
    // the troop price (combat exp per enemy troop): stronger or weaker, now and then off
    if (rng.next() < 0.4) out.cbPrice = Math.max(0, Math.min(1.5, (paramOr(src, 'cbPrice') || 0.6) * Math.exp(rng.normal() * 0.4)));
    if (rng.next() < 0.1) out.cbPrice = 0;
    return out;
  };
  if (variants <= 1 && elite) queue.splice(0, queue.length, { ...elite });
  for (let i = 0; i < Math.max(variants, queue.length); i++) {
    const c = i < queue.length ? queue[i] : mutate((best as BattleOutcome | null)?.won ? (best as unknown as BattleOutcome).params : queue[Math.floor(rng.next() * queue.length)]);
    consider(await safeGrindBattle(files, snap, c, carry));
    // GRIND_FIRST_WIN: stop at the first win, as a player retrying a lost battle would (no best-of-N pick)
    if (process.env.GRIND_FIRST_WIN && (best as BattleOutcome | null)?.won) break;
  }
  for (let r = 1; r <= rescue && !(best as BattleOutcome | null)?.won; r++) {
    // more tries that still play the battle out (Sukwon: no emergency means, walls are passed by
    // levels): the fighting preset (its usual finish, no finish-from-turn-1), a defensive plan
    // (hold together near 유비, kill whatever comes, finish at the end) and the hold plan (하비:
    // form up near the start, let the waves come, push out after), each with rerolls. The game's
    // own AI (native, charging from turn 1) and the finish-99 rush are gone.
    const a = aggressive(base);
    const k = (r - 1) % 3;
    const c: GrindParams =
      k === 0 ? { ...a, rerolls: r + 7 }
      : k === 1 ? clampParams({ ...base, approach: 0, escort: 2.5, keep: 1, kill: 2, conserve: 0, cbPrice: 0, finish: 2, risk: 2, guard: 0.7, lead: 0, rerolls: r + 3 })
      : clampParams({ ...base, hold: 1, brace: 0, approach: 0, escort: 2.5, lead: 0, kill: 2, conserve: 0, cbPrice: 0, keep: 1, guard: 1.2, heal: Math.max(base.heal, 2), finish: 4, rerolls: r + 11 });
    consider(await safeGrindBattle(files, snap, c, carry));
  }
  return { best: best as unknown as BattleOutcome, tried };
}
