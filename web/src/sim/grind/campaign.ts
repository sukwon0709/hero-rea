// Grinding simulator, part 5: a whole campaign in the sandbox. The battles captured from the story
// (capture.ts) are replayed in order; each battle is searched (searchBattle) and the best winning
// plan is kept; the officers' level/exp are carried to the next battle together with what the
// story did to them in between (baseline delta: ADD_STAT, new officers, enemy deployments).

import type { BattleSnapshot } from './sandbox';
import { searchBattle, SearchRng, startLine, type BattleOutcome, type BattleSearch, type CarryState, type OfficerCarry } from './battle';
import { PARAM_SPECS, clampParams, type GrindParams } from './policy';

function clampHint(p: GrindParams): GrindParams {
  const c = clampParams(p);
  c.rerolls = p.rerolls;
  return c;
}

export interface CampaignBattle {
  index: number;
  chapter: number;
  name: string;
  map: number;
  won: boolean;
  forced: boolean;
  turns: number;
  turnLimit: number;
  finishTurn: number | null;
  finishReason?: string;
  params: GrindParams;
  kept: string[];
  actions: BattleOutcome['actions'];
  tactics: Record<string, number>;
  gains: BattleOutcome['gains'];
  expTotal: number;
  variantsTried: number;
  variantsWon: number;
  ms: number;
  /** For a battle nothing won: how many tries ended for each reason. */
  lossReasons?: Record<string, number>;
  /** For a battle nothing won: the exp of the best losing try (the longest held, then the most exp; not carried on). */
  lostExp?: number;
  /** Bought at the merchants before this battle. */
  purchases?: { officer: number; item: number; price: number }[];
  /** Attempts until the win (1 = first try); the retries a player would make. */
  attempts?: number;
  /** Script gains (bonus exp, duels, persuasions) and early endings of the played try. */
  script?: BattleOutcome['script'];
  /** The start of the played try: gold, 폭탄, top-9 level against the enemy level. */
  start?: BattleOutcome['start'];
}

export interface CampaignResult {
  /** Levels and sortie list after the last battle run (to continue or debug from there). */
  carryOut?: { officers: OfficerCarry[]; formation: number[] | undefined; money?: number };
  battles: CampaignBattle[];
  /** Final level per officer of the player's roster (named officers of 유비's faction). */
  roster: { officer: number; name: string; level: number; exp: number; reached99At: number | null }[];
  n99: number;
  /** Sum of the 15 highest levels (the sortie size). */
  top15: number;
  objective: number;
  wins: number;
  forced: number;
  ms: number;
  battlesRun: number;
  /** Battles won in story order before the run stopped (all of them when it reached the end). */
  cleared: number;
  /** The battle the run could not win after every retry: the run stopped there (null = reached the end). */
  frontier: { index: number; name: string } | null;
}

/**
 * The state for battle `snap` given the previous battle's sandbox result and the story in between:
 * levels as the sandbox left them plus what the story added (ADD_STAT, capped at 99); class as the
 * sandbox left it unless the story changed it; items as the sandbox left them (used, bought) with
 * the story's gains and losses since the previous battle applied; gold likewise.
 */
export function carryFor(prev: BattleSnapshot, snap: BattleSnapshot, lastOfficers: OfficerCarry[], formation: number[] | undefined, lastMoney?: number): CarryState {
  const officers = snap.state.officers.map((so, i): OfficerCarry => {
    const bs = so.dyn.level * 100 + so.dyn.exp;
    const pa = prev.after?.[i];
    const be = pa ? pa.level * 100 + pa.exp : bs;
    const last = lastOfficers[i];
    const g = last ? last.level * 100 + last.exp : bs;
    let t = g + (bs - be);
    const gl = last?.level ?? so.dyn.level;
    if (bs !== be && Math.trunc(t / 100) > 99 && gl <= 99) t = 9900 + (t % 100); // ADD_STAT caps at 99
    const out: OfficerCarry = { level: Math.trunc(t / 100), exp: t % 100 };
    // class: the story's change wins, else the sandbox's (promotions)
    if (last?.cls !== undefined) out.cls = pa?.cls !== undefined && pa.cls !== so.dyn.cls ? so.dyn.cls : last.cls;
    if (last?.items && pa?.items) {
      const items = [...last.items];
      const before = pa.items.filter((v) => v !== 0xff);
      const now = so.dyn.items.filter((v) => v !== 0xff);
      // the story's losses, then its gains (multiset differences of the baseline)
      const lost = [...before];
      for (const v of now) {
        const k = lost.indexOf(v);
        if (k >= 0) lost.splice(k, 1);
      }
      const gained = [...now];
      for (const v of before) {
        const k = gained.indexOf(v);
        if (k >= 0) gained.splice(k, 1);
      }
      for (const v of lost) {
        const k = items.indexOf(v);
        if (k >= 0) items[k] = 0xff;
      }
      for (const v of gained) {
        const k = items.indexOf(0xff);
        if (k >= 0) items[k] = v;
      }
      out.items = items;
    }
    return out;
  });
  const money =
    lastMoney !== undefined && prev.moneyAfter !== undefined ? Math.max(0, Math.min(10000, lastMoney + (snap.state.progress.money - prev.moneyAfter))) : undefined;
  return { officers, formation, money };
}

/** Progress first: a run that gets further always scores higher; the level objective breaks ties. */
export const CLEARED_WEIGHT = 10_000_000;

/**
 * A run stopped by a lost battle: a small bonus for how long its best try held there (x10 per
 * turn) and the exp it made (/25), so the learning gets a pull towards holding the wall (회남: the
 * plan that holds to turn 30 against the one that falls at turn 13). At most a few hundred: worth a
 * few levels of the top 15, never a battle cleared.
 */
export function frontierBonus(b: { won: boolean; turns: number; lostExp?: number } | undefined): number {
  if (!b || b.won) return 0;
  return b.turns * 10 + Math.round((b.lostExp ?? 0) / 25);
}
export function progressObjective(cleared: number, n99: number, top15: number, levelsGained = 0): number {
  return cleared * CLEARED_WEIGHT + objectiveOf(n99, top15, levelsGained);
}

export function objectiveOf(n99: number, top15: number, levelsGained = 0): number {
  // Lv99 count first; then the top-15 level sum (x10) plus every level gained by anyone (the
  // top 15 is dominated by officers who join at preset levels, so gains alone give a finer signal)
  // top 15 x50 (Sukwon: prefer the run that clears with more levels, never a rushed clear): at most
  // 74,250, still below one Lv99 officer
  return n99 * 100000 + top15 * 50 + levelsGained;
}

export interface CampaignOptions {
  variants: number;
  seed: number;
  elites?: Record<number, GrindParams>;
  /** Curriculum: battles whose plan is settled run only that plan (searched again if it stops winning). */
  frozen?: Set<number>;
  /** Hints (hints.json): per-battle starting plans tried first. */
  hints?: Record<number, Partial<GrindParams>>;
  /** Only the first n battles (quick runs). */
  limit?: number;
  log?: (line: string) => void;
  /** Extra tries for a battle nothing won (fighting / defensive / hold plans with rerolls; no rushes). */
  rescue?: number;
  /**
   * A battle nothing wins after every retry ends the run there (the player would be stuck), instead
   * of forcing a win and going on. Default true.
   */
  stopOnLoss?: boolean;
  /**
   * When the run is about to stop at a battle, go back up to this many battles (one at a time) and
   * search them again with three times the variants (the search keeps the won plan with the most
   * exp), then replay forward: more levels on arrival. Those battles still count as cleared.
   */
  backtrack?: number;
  /** on a loss, go back this many battles at once, 2 more each further loss (backtrack = how many times) */
  backJump?: number;
  /** More effort where earlier runs stopped: this battle gets these variants/retries. */
  extra?: { battle: number; variants: number; rescue: number };
  /** Re-plan tries for frozen battles (their elite plan kept as the fallback); 0 = replay only. */
  replan?: number;
  /**
   * A full restart's level target (Sukwon: when a wall looks unwinnable, start over and raise the
   * levels much higher): on reaching `battle` with the top-9 average level below `level`, go back
   * one battle further each time (up to `passes`) and grind it again with three times the variants
   * (the search keeps the won plan with the most exp), then replay forward.
   */
  levelGate?: { battle: number; level: number; passes: number };
  /** Called with the carry each battle starts from (bench fixtures). */
  onCarry?: (k: number, carry: CarryState | null) => void;
}

/** Average level of the `n` highest-level members of our faction (levels as carried). */
export function topLevel(snap: BattleSnapshot, officers: OfficerCarry[], n: number): number {
  const faction = snap.state.officers[0].dyn.flags & 0x1f;
  const lv = snap.state.officers
    .map((so, i) => ({ so, i }))
    .filter(({ so, i }) => i < 0x100 && (so.dyn.flags & 0x80) !== 0 && (so.dyn.flags & 0x1f) === faction)
    .map(({ i }) => Math.min(99, officers[i]?.level ?? 1))
    .sort((a, b) => b - a)
    .slice(0, n);
  return lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
}

/**
 * Average level of the enemy units a battle starts with or brings in (its deployment records). An
 * enemy's level is its record's level byte (BATTLE_UNITS +0xa, set by 1cb6:81c4 -> 0cf5:7580 at the
 * battle setup: a literal of the script, the same whatever our levels), not the officer's stored level.
 */
export function enemyLevel(snap: BattleSnapshot): number {
  const lv = enemyLevels(snap);
  return lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
}

/** The enemy records' levels (see enemyLevel). */
export function enemyLevels(snap: BattleSnapshot): number[] {
  const lv: number[] = [];
  for (const u of (snap.script as unknown as { units?: { officer: number; flags: number; b?: number }[] }).units ?? [])
    if (u.officer !== 0xffff && u.flags & 1 && u.officer < snap.state.officers.length) lv.push(u.b ?? snap.state.officers[u.officer].dyn.level);
  return lv;
}

export async function runCampaign(
  files: Map<string, Uint8Array>,
  snaps: BattleSnapshot[],
  params: GrindParams,
  o: CampaignOptions,
): Promise<CampaignResult> {
  const t0 = performance.now();
  // plans of removed emergency variants (the game's AI from turn 1, the finish-from-turn-1 rush)
  // are never replayed or seeded (Sukwon: no emergency means)
  const finMax = PARAM_SPECS.find((sp) => sp.key === 'finish')!.max;
  o = { ...o, elites: Object.fromEntries(Object.entries(o.elites ?? {}).filter(([, p]) => !p.native && p.finish <= finMax)) };
  const rng = new SearchRng(o.seed);
  const out: CampaignBattle[] = [];
  let carry: CarryState | null = null;
  let battlesRun = 0;
  const reached = new Map<number, number>();
  const list = o.limit ? snaps.slice(0, o.limit) : snaps;
  let lastOfficers: OfficerCarry[] = list[0].state.officers.map((x) => ({ level: x.dyn.level, exp: x.dyn.exp, cls: x.dyn.cls, items: [...x.dyn.items] }));
  let lastMoney: number | undefined = list[0].state.progress.money;
  let frontier: CampaignResult['frontier'] = null;
  let lastAt = list.length - 1;
  // state before each battle, for going back (backtrack)
  const before: { lastOfficers: OfficerCarry[]; lastMoney: number | undefined; carry: CarryState | null }[] = [];
  const regrind = new Set<number>();
  let backLeft = o.backtrack ?? 0;
  let backFrom = -1;
  // frozen battles whose old plan was replaced by a re-plan, and those not to re-plan again
  const replanned: number[] = [];
  const noReplan = new Set<number>();
  let gatePasses = 0;
  // the furthest chain of wins so far (the plans that won each battle, the carry after the last):
  // a backtrack or an undone re-plan that does not get past it again ends the run with this chain
  // (gen 110: 하비 won with 1/12 tries, 16 battles cleared, then [16] 연주 lost, the undo of [7]'s
  // re-plan lost 하비 again and the run was scored as stopped at 11)
  let furthest: { out: CampaignBattle[]; lastOfficers: OfficerCarry[]; lastMoney: number | undefined; carry: CarryState | null; reached: Map<number, number> } | null = null;
  for (let k = 0; k < list.length; k++) {
    const snap = list[k];
    // the level target at the wall: below it, go back and grind (one battle further each pass)
    const gate = o.levelGate;
    if (gate && k === gate.battle && gatePasses < gate.passes && k - 1 - gatePasses >= 0) {
      const avg = topLevel(snap, lastOfficers, 9);
      if (avg < gate.level) {
        const j = k - 1 - gatePasses;
        gatePasses++;
        o.log?.(`  [${k}] ${snap.name}: top-9 average Lv${avg.toFixed(1)} below the target Lv${gate.level}; going back to [${j}] ${list[j].name} to grind more exp (pass ${gatePasses}/${gate.passes}, battles ${j}..${k - 1} searched again for the most exp)`);
        // every battle from there to the wall is searched again (3x variants, the most-exp win kept):
        // replaying the later ones with their old plans gave the levels back (flat at Lv12 before 하비)
        for (let i = j; i < k; i++) regrind.add(i);
        ({ lastOfficers, lastMoney, carry } = before[j]);
        out.length = j;
        for (const [off, at] of [...reached]) if (at >= j) reached.delete(off);
        k = j - 1;
        continue;
      }
      if (gatePasses) o.log?.(`  [${k}] ${snap.name}: top-9 average Lv${avg.toFixed(1)} meets the target Lv${gate.level}`);
      gatePasses = gate.passes;
    }
    before[k] = { lastOfficers, lastMoney, carry };
    // carry: last sandbox result + what the story changed since the previous baseline battle
    if (k > 0) carry = carryFor(list[k - 1], snap, lastOfficers, (carry as CarryState | null)?.formation, lastMoney);
    o.onCarry?.(k, carry as CarryState | null);
    const hint = o.hints?.[k] ? clampHint({ ...params, ...o.hints[k] }) : undefined;
    const again = regrind.has(k);
    let s: BattleSearch | null = !again && o.frozen?.has(k) && o.elites?.[k] ? await searchBattle(files, snap, o.elites[k], carry, 1, rng, undefined, 0) : null;
    // a frozen battle is re-planned too (stall longer, feed 유비): the new plan replaces the old one
    // only when it also wins, scores higher (exp, 유비 weighted up), gives the team at least 95% of the exp and
    // uses no fewer turns (a stronger carry for the battles after it); the old plan is the fallback
    if (s?.best.won && (o.replan ?? 0) > 0 && !noReplan.has(k)) {
      const r = await searchBattle(files, snap, params, carry, o.replan!, rng, undefined, 0, hint);
      battlesRun += r.tried.length;
      if (r.best.won && r.best.score > s.best.score && r.best.expTotal * 100 >= s.best.expTotal * 95 && r.best.turns >= Math.min(s.best.turns, r.best.turnLimit - 3)) {
        o.log?.(`  [${k}] ${snap.name}: re-planned, score ${Math.round(s.best.score)} -> ${Math.round(r.best.score)}, turns ${s.best.turns} -> ${r.best.turns}`);
        s = { best: r.best, tried: [...s.tried, ...r.tried] };
        replanned.push(k);
      } else {
        if (process.env.GRIND_TRACE_REPLAN) o.log?.(`  [${k}] ${snap.name}: re-plan kept old (old score ${Math.round(s.best.score)} exp ${s.best.expTotal} turns ${s.best.turns}; new ${r.best.won ? `score ${Math.round(r.best.score)} exp ${r.best.expTotal} turns ${r.best.turns}` : `lost: ${r.tried.map((t) => t.loss).join(' / ')}`})`);
        s = { best: s.best, tried: [...s.tried, ...r.tried] };
      }
    }
    const ex = o.extra && (o.extra.battle === k || (backFrom >= 0 && k === backFrom)) ? o.extra : null;
    // battles the best run already cleared (before its frontier) get its escalated retries too: a
    // policy change can make an old elite plan lose there, and retries only cost when it loses
    const exRescue = ex ? ex.rescue : o.extra && k < o.extra.battle ? o.extra.rescue : 0;
    if (!s || !s.best.won) s = await searchBattle(files, snap, params, carry, again ? o.variants * 3 : ex ? Math.max(ex.variants, o.variants) : o.variants, rng, o.elites?.[k] ?? hint, Math.max(exRescue, o.rescue ?? 6), hint && o.elites?.[k] ? hint : undefined);
    battlesRun += s.tried.length;
    const b: BattleOutcome = s.best;
    // about to stop after a re-plan changed the carry: undo the latest re-plan (that battle replays
    // its old plan, which got this far before) and go on from there
    if (!b.won && o.stopOnLoss !== false && replanned.length) {
      const j = replanned.pop()!;
      noReplan.add(j);
      o.log?.(`  [${k}] ${snap.name}: lost; undoing the re-plan of [${j}] ${list[j].name} (back to its old plan)`);
      ({ lastOfficers, lastMoney, carry } = before[j]);
      out.length = j;
      for (const [off, at] of [...reached]) if (at >= j) reached.delete(off);
      for (const g of [...regrind]) if (g >= j) regrind.delete(g);
      backLeft = o.backtrack ?? 0;
      backFrom = -1;
      k = j - 1;
      continue;
    }
    // about to stop: go back one more battle and grind it harder (then replay forward)
    // backJump: go back several battles at once and search every one of them again for the most exp
    // (Sukwon: going back one battle barely changes the levels; go back 4-5 battles or to the start)
    // each further loss goes back 2 more battles from the wall (5, 7, 9, ... back; Sukwon)
    if (!b.won && o.stopOnLoss !== false && o.backJump && backLeft > 0 && k > 0) {
      backFrom = backFrom < 0 ? k : backFrom;
      const jumps = (o.backtrack ?? 0) - backLeft;
      const j = Math.max(0, backFrom - o.backJump - 2 * jumps);
      backLeft = j === 0 ? 0 : backLeft - 1;
      o.log?.(`  [${k}] ${snap.name}: lost; going back to [${j}] ${list[j].name} (battles ${j}..${k - 1} searched again for the most exp)`);
      for (let i = j; i < k; i++) regrind.add(i);
      ({ lastOfficers, lastMoney, carry } = before[j]);
      out.length = j;
      for (const [off, at] of [...reached]) if (at >= j) reached.delete(off);
      k = j - 1;
      continue;
    }
    if (!b.won && o.stopOnLoss !== false && !o.backJump && backLeft > 0 && k - (o.backtrack! - backLeft) - 1 >= 0) {
      const j = k - (o.backtrack! - backLeft) - 1;
      backLeft--;
      backFrom = backFrom < 0 ? k : backFrom;
      o.log?.(`  [${k}] ${snap.name}: lost; going back to [${j}] ${list[j].name} to grind more exp`);
      regrind.add(j);
      ({ lastOfficers, lastMoney, carry } = before[j]);
      out.length = j;
      for (const [off, at] of [...reached]) if (at >= j) reached.delete(off);
      k = j - 1;
      continue;
    }
    const stop = !b.won && o.stopOnLoss !== false;
    const forced = !b.won && !stop;
    if (b.won) {
      lastOfficers = b.officersAfter;
      lastMoney = b.moneyAfter;
      carry = { officers: carry?.officers ?? null, formation: b.formationOut };
    } else {
      // the run would have to retry: keep the levels it started with (no exp), story goes on
      lastOfficers = carry?.officers ?? snap.state.officers.map((x) => ({ level: x.dyn.level, exp: x.dyn.exp, cls: x.dyn.cls, items: [...x.dyn.items] }));
      lastMoney = carry?.money ?? snap.state.progress.money;
      carry = { officers: carry?.officers ?? null, formation: carry?.formation };
    }
    for (const g of b.gains) if (b.won && g.levelAfter >= 99 && !reached.has(g.officer)) reached.set(g.officer, k);
    out.push({
      index: k,
      chapter: snap.chapter,
      name: snap.name,
      map: snap.map,
      won: b.won,
      forced,
      turns: b.turns,
      turnLimit: b.turnLimit,
      finishTurn: b.finishTurn,
      finishReason: b.finishReason,
      params: b.params,
      kept: b.kept,
      actions: b.actions,
      tactics: b.tactics,
      gains: b.won ? b.gains : [],
      expTotal: b.won ? b.expTotal : 0,
      variantsTried: s.tried.length,
      variantsWon: s.tried.filter((t) => t.won).length,
      ms: b.ms,
      purchases: b.purchases,
      attempts: s.tried.findIndex((t) => t.won) + 1 || s.tried.length,
      script: b.script,
      start: b.start,
      lostExp: !b.won ? b.expTotal : undefined,
      lossReasons: !b.won ? s.tried.reduce<Record<string, number>>((m, t) => ((m[t.loss ?? '?'] = (m[t.loss ?? '?'] ?? 0) + 1), m), {}) : undefined,
    });
    o.log?.(`  [${k}] ch${snap.chapter} ${snap.name}: ${b.won ? 'won' : stop ? 'STOP' : 'FORCED'} turns ${b.turns}/${b.turnLimit} exp ${b.expTotal} (${s.tried.filter((t) => t.won).length}/${s.tried.length} won) | ${startLine(b.start)}`);
    const wonNow = out.filter((x) => x.won).length;
    if (b.won && wonNow > (furthest ? furthest.out.filter((x) => x.won).length : 0))
      furthest = { out: [...out], lastOfficers, lastMoney, carry: carry as CarryState | null, reached: new Map(reached) };
    if (stop && furthest && furthest.out.filter((x) => x.won).length > wonNow) {
      // the backtrack did not get back past the furthest chain: that chain is the result
      const f: NonNullable<typeof furthest> = furthest;
      const at = f.out.length;
      o.log?.(`  [${k}] ${snap.name}: stopped short of the furthest chain; restoring it (${f.out.filter((x) => x.won).length} cleared, stopped at [${at}] ${list[at]?.name ?? 'end'})`);
      out.length = 0;
      out.push(...f.out);
      ({ lastOfficers, lastMoney, carry } = f);
      reached.clear();
      for (const [off, at2] of f.reached) reached.set(off, at2);
      if (at < list.length) {
        frontier = { index: at, name: list[at].name };
        lastAt = at;
      } else lastAt = list.length - 1;
      break;
    }
    if (stop) {
      frontier = { index: k, name: snap.name };
      lastAt = k;
      break;
    }
  }
  // final roster: the last snapshot's faction members, with the carried levels
  const last = list[lastAt];
  const faction = last.state.officers[0].dyn.flags & 0x1f;
  const roster = last.state.officers
    .map((so, i) => ({ so, i }))
    .filter(({ so, i }) => i < 0x100 && (so.dyn.flags & 0x80) !== 0 && (so.dyn.flags & 0x1f) === faction)
    .map(({ so, i }) => ({ officer: i, name: so.name, level: lastOfficers[i].level, exp: lastOfficers[i].exp, reached99At: reached.get(i) ?? null }))
    .sort((a, b) => b.level - a.level || a.officer - b.officer);
  const n99 = roster.filter((r) => r.level >= 99).length;
  const top15 = roster.slice(0, 15).reduce((s, r) => s + Math.min(99, r.level), 0);
  return {
    carryOut: { officers: lastOfficers, formation: (carry as CarryState | null)?.formation, money: lastMoney },
    battles: out,
    roster,
    n99,
    top15,
    // the team's exp (/25) and 유비's level (x50) count too (Sukwon: raise him with the team; more exp beats a rushed clear)
    objective: progressObjective(out.filter((b) => b.won).length, n99, top15, Math.round(out.reduce((a, b) => a + b.expTotal, 0) / 25) + 50 * (lastOfficers[0]?.level ?? 0)) + frontierBonus(out[out.length - 1]),
    cleared: out.filter((b) => b.won).length,
    frontier,
    wins: out.filter((b) => b.won).length,
    forced: out.filter((b) => b.forced).length,
    ms: performance.now() - t0,
    battlesRun,
  };
}
