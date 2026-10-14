// Grinding simulator, part 5: a whole campaign in the sandbox. The battles captured from the story
// (capture.ts) are replayed in order; each battle is searched (searchBattle) and the best winning
// plan is kept; the officers' level/exp are carried to the next battle together with what the
// story did to them in between (baseline delta: ADD_STAT, new officers, enemy deployments).

import type { BattleSnapshot } from './sandbox';
import { searchBattle, SearchRng, type BattleOutcome, type BattleSearch, type CarryState } from './battle';
import { clampParams, type GrindParams } from './policy';

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
}

export interface CampaignResult {
  /** Levels and sortie list after the last battle run (to continue or debug from there). */
  carryOut?: { officers: { level: number; exp: number }[]; formation: number[] | undefined };
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
}

/** Levels for battle `snap` given the previous battle's sandbox result and the story in between. */
export function carryFor(prev: BattleSnapshot, snap: BattleSnapshot, lastOfficers: { level: number; exp: number }[], formation: number[] | undefined): CarryState {
  const officers = snap.state.officers.map((so, i) => {
    const bs = so.dyn.level * 100 + so.dyn.exp;
    const be = prev.after ? prev.after[i].level * 100 + prev.after[i].exp : bs;
    const g = lastOfficers[i] ? lastOfficers[i].level * 100 + lastOfficers[i].exp : bs;
    let t = g + (bs - be);
    const gl = lastOfficers[i]?.level ?? so.dyn.level;
    if (bs !== be && Math.trunc(t / 100) > 99 && gl <= 99) t = 9900 + (t % 100); // ADD_STAT caps at 99
    return { level: Math.trunc(t / 100), exp: t % 100 };
  });
  return { officers, formation };
}

export function objectiveOf(n99: number, top15: number, levelsGained = 0): number {
  // Lv99 count first; then the top-15 level sum (x10) plus every level gained by anyone (the
  // top 15 is dominated by officers who join at preset levels, so gains alone give a finer signal)
  return n99 * 100000 + top15 * 10 + levelsGained;
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
  /** Extra tries for a battle nothing won (native AI / fighting preset with rerolls). */
  rescue?: number;
  /** Called with the carry each battle starts from (bench fixtures). */
  onCarry?: (k: number, carry: CarryState | null) => void;
}

export async function runCampaign(
  files: Map<string, Uint8Array>,
  snaps: BattleSnapshot[],
  params: GrindParams,
  o: CampaignOptions,
): Promise<CampaignResult> {
  const t0 = performance.now();
  const rng = new SearchRng(o.seed);
  const out: CampaignBattle[] = [];
  let carry: CarryState | null = null;
  let battlesRun = 0;
  const reached = new Map<number, number>();
  const list = o.limit ? snaps.slice(0, o.limit) : snaps;
  let lastOfficers: { level: number; exp: number }[] = list[0].state.officers.map((x) => ({ level: x.dyn.level, exp: x.dyn.exp }));
  for (let k = 0; k < list.length; k++) {
    const snap = list[k];
    // carry: last sandbox result + what the story changed since the previous baseline battle
    if (k > 0) carry = carryFor(list[k - 1], snap, lastOfficers, (carry as CarryState | null)?.formation);
    o.onCarry?.(k, carry as CarryState | null);
    const hint = o.hints?.[k] ? clampHint({ ...params, ...o.hints[k] }) : undefined;
    let s: BattleSearch | null = o.frozen?.has(k) && o.elites?.[k] ? await searchBattle(files, snap, o.elites[k], carry, 1, rng, undefined, 0) : null;
    if (!s || !s.best.won) s = await searchBattle(files, snap, params, carry, o.variants, rng, o.elites?.[k] ?? hint, o.rescue ?? 6, hint && o.elites?.[k] ? hint : undefined);
    battlesRun += s.tried.length;
    const b: BattleOutcome = s.best;
    const forced = !b.won;
    if (b.won) {
      lastOfficers = b.officersAfter;
      carry = { officers: carry?.officers ?? null, formation: b.formationOut };
    } else {
      // the run would have to retry: keep the levels it started with (no exp), story goes on
      lastOfficers = carry?.officers ?? snap.state.officers.map((x) => ({ level: x.dyn.level, exp: x.dyn.exp }));
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
      params: b.params,
      kept: b.kept,
      actions: b.actions,
      tactics: b.tactics,
      gains: b.won ? b.gains : [],
      expTotal: b.won ? b.expTotal : 0,
      variantsTried: s.tried.length,
      variantsWon: s.tried.filter((t) => t.won).length,
      ms: b.ms,
      lossReasons: forced ? s.tried.reduce<Record<string, number>>((m, t) => ((m[t.loss ?? '?'] = (m[t.loss ?? '?'] ?? 0) + 1), m), {}) : undefined,
    });
    o.log?.(`  [${k}] ch${snap.chapter} ${snap.name}: ${b.won ? 'won' : 'FORCED'} turns ${b.turns}/${b.turnLimit} exp ${b.expTotal} (${s.tried.filter((t) => t.won).length}/${s.tried.length} won)`);
  }
  // final roster: the last snapshot's faction members, with the carried levels
  const last = list[list.length - 1];
  const faction = last.state.officers[0].dyn.flags & 0x1f;
  const roster = last.state.officers
    .map((so, i) => ({ so, i }))
    .filter(({ so, i }) => i < 0x100 && (so.dyn.flags & 0x80) !== 0 && (so.dyn.flags & 0x1f) === faction)
    .map(({ so, i }) => ({ officer: i, name: so.name, level: lastOfficers[i].level, exp: lastOfficers[i].exp, reached99At: reached.get(i) ?? null }))
    .sort((a, b) => b.level - a.level || a.officer - b.officer);
  const n99 = roster.filter((r) => r.level >= 99).length;
  const top15 = roster.slice(0, 15).reduce((s, r) => s + Math.min(99, r.level), 0);
  return {
    carryOut: { officers: lastOfficers, formation: (carry as CarryState | null)?.formation },
    battles: out,
    roster,
    n99,
    top15,
    objective: objectiveOf(n99, top15, Math.round(out.reduce((a, b) => a + b.expTotal, 0) / 100)),
    wins: out.filter((b) => b.won).length,
    forced: out.filter((b) => b.forced).length,
    ms: performance.now() - t0,
    battlesRun,
  };
}
