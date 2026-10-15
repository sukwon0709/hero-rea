// Grinding simulator, part 6: learning across generations. A cross-entropy search over the policy
// parameters (policy.ts PARAM_SPECS, normalised to 0..1): every generation samples candidates
// around the current mean, plays a whole campaign with each (campaign.ts), and moves the mean and
// spread towards the best third. The best campaign's per-battle plans are kept as elites and
// seeded into the next generations' per-battle searches (mutated there). The state is plain JSON,
// saved after every generation, so a run can be resumed.

import { PARAM_SPECS, clampParams, defaultParams, type GrindParams } from './policy';
import { SearchRng } from './battle';
import type { CampaignResult } from './campaign';

export interface CandidateResult {
  params: GrindParams;
  objective: number;
  n99: number;
  top15: number;
  wins: number;
  forced: number;
  ms: number;
  battlesRun: number;
  /** Battles won in story order before the run stopped. */
  cleared?: number;
  /** Where the run stopped (null = it reached the end). */
  frontier?: { index: number; name: string } | null;
}

export interface GenerationRecord {
  gen: number;
  ms: number;
  candidates: CandidateResult[];
  best: number;
  mean: number;
  bestN99: number;
  meanParams: GrindParams;
  stdParams: Record<string, number>;
  /** Per-battle plans that changed in the best campaign this generation. */
  eliteChanges?: { battle: number; name: string; from: GrindParams | null; to: GrindParams | null }[];
  /** Battles whose plan is settled (curriculum): they run their kept plan only. */
  frozen?: number[];
  /** This generation started over from battle 1 (no frozen plans): the frontier had stayed stuck. */
  fresh?: boolean;
  /** Candidates sampled this generation (adaptive population). */
  pop?: number;
  /** Where this generation's best run stopped (null = it reached the end), and how many battles it cleared. */
  frontier?: { index: number; name: string } | null;
  cleared?: number;
}

export interface EvolveState {
  version: 1;
  gen: number;
  seed: number;
  mean: number[];
  std: number[];
  history: GenerationRecord[];
  best: { params: GrindParams; result: CandidateResult; campaign: CampaignResult } | null;
  elites: Record<number, GrindParams>;
  /** Generations each battle's elite plan has kept winning unchanged in the best campaign. */
  eliteAge?: Record<number, number>;
  /** The parameters the learning started from (defaults + hints.json defaults). */
  start?: GrindParams;
}

/** Curriculum: battles in story order whose plan has stayed the best for 2+ generations, up to the first unsettled one. */
export function frozenBattles(st: EvolveState): Set<number> {
  const out = new Set<number>();
  const age = st.eliteAge ?? {};
  for (let k = 0; ; k++) {
    if (!st.elites[k] || (age[k] ?? 0) < 2) break;
    out.add(k);
  }
  return out;
}

/** Adaptive population: wide while the search is spread out, narrower as it converges. */
export function populationSize(st: EvolveState, maxPop: number, minPop = 4): number {
  const spread = st.std.reduce((a, b) => a + b, 0) / st.std.length; // 0.25 at the start
  return Math.max(minPop, Math.min(maxPop, Math.round((maxPop * spread) / 0.25)));
}

export function newEvolveState(seed = 1, start?: Partial<GrindParams>): EvolveState {
  const d = { ...defaultParams(), ...(start ?? {}) };
  return {
    version: 1,
    gen: 0,
    seed,
    mean: PARAM_SPECS.map((s) => (d[s.key] - s.min) / (s.max - s.min)),
    std: PARAM_SPECS.map(() => 0.25),
    history: [],
    best: null,
    elites: {},
    start: clampParams(d),
  };
}

export function toParams(x: number[]): GrindParams {
  const p = {} as GrindParams;
  PARAM_SPECS.forEach((s, i) => (p[s.key] = s.min + Math.min(1, Math.max(0, x[i])) * (s.max - s.min)));
  return clampParams(p);
}

export function toVector(p: GrindParams): number[] {
  return PARAM_SPECS.map((s) => (p[s.key] - s.min) / (s.max - s.min));
}

/** Candidates of the next generation: the best so far, then samples around the mean. */
export function sampleGeneration(st: EvolveState, pop: number): GrindParams[] {
  const rng = new SearchRng(st.seed * 7919 + st.gen * 104729 + 1);
  const out: GrindParams[] = [];
  if (st.best) out.push(st.best.params);
  else out.push(toParams(st.mean));
  while (out.length < pop) out.push(toParams(st.mean.map((m, i) => m + st.std[i] * rng.normal())));
  return out;
}

/** CEM update from one generation's results; returns the record that was appended. */
export function updateGeneration(
  st: EvolveState,
  results: { cand: CandidateResult; campaign: CampaignResult }[],
  ms: number,
): GenerationRecord {
  const sorted = [...results].sort((a, b) => b.cand.objective - a.cand.objective);
  const nElite = Math.max(2, Math.ceil(sorted.length / 3));
  const elite = sorted.slice(0, nElite).map((r) => toVector(r.cand.params));
  const k = PARAM_SPECS.length;
  for (let i = 0; i < k; i++) {
    const m = elite.reduce((s, v) => s + v[i], 0) / elite.length;
    const sd = Math.sqrt(elite.reduce((s, v) => s + (v[i] - m) ** 2, 0) / elite.length);
    st.mean[i] = 0.7 * m + 0.3 * st.mean[i];
    st.std[i] = Math.max(0.04, 0.7 * sd + 0.3 * st.std[i]);
  }
  const top = sorted[0];
  const changes: NonNullable<GenerationRecord['eliteChanges']> = [];
  if (!st.best || top.cand.objective > st.best.result.objective) {
    st.best = { params: top.cand.params, result: top.cand, campaign: top.campaign };
    // per-battle elites: the plan each battle used in the best campaign
    const old = st.elites;
    const age = st.eliteAge ?? {};
    st.elites = {};
    const newAge: Record<number, number> = {};
    for (const b of top.campaign.battles) {
      if (!b.won) continue;
      st.elites[b.index] = b.params;
      const same = old[b.index] && JSON.stringify(old[b.index]) === JSON.stringify(b.params);
      newAge[b.index] = same ? (age[b.index] ?? 0) + 1 : 0;
      if (!same) changes.push({ battle: b.index, name: b.name, from: old[b.index] ?? null, to: b.params });
    }
    for (const k of Object.keys(old)) if (!st.elites[Number(k)]) changes.push({ battle: Number(k), name: top.campaign.battles[Number(k)]?.name ?? k, from: old[Number(k)], to: null });
    st.eliteAge = newAge;
  } else {
    // the kept plans held: they age (towards the curriculum freeze)
    const age = st.eliteAge ?? {};
    for (const k of Object.keys(st.elites)) age[Number(k)] = (age[Number(k)] ?? 0) + 1;
    st.eliteAge = age;
  }
  const rec: GenerationRecord = {
    gen: st.gen,
    ms,
    candidates: results.map((r) => r.cand),
    best: top.cand.objective,
    mean: results.reduce((s, r) => s + r.cand.objective, 0) / results.length,
    bestN99: top.cand.n99,
    meanParams: toParams(st.mean),
    stdParams: Object.fromEntries(PARAM_SPECS.map((s, i) => [s.key, st.std[i] * (s.max - s.min)])),
    eliteChanges: changes,
    frozen: [...frozenBattles(st)],
    pop: results.length,
    frontier: top.campaign.frontier ?? null,
    cleared: top.campaign.cleared,
  };
  st.history.push(rec);
  st.gen++;
  return rec;
}

/** Per parameter: correlation with the objective over every candidate ever evaluated. */
export function paramCorrelations(st: EvolveState): Record<string, { corr: number; top: number; bottom: number }> {
  const all = st.history.flatMap((h) => h.candidates);
  const out: Record<string, { corr: number; top: number; bottom: number }> = {};
  if (all.length < 3) return out;
  const ys = all.map((c) => c.objective);
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sorted = [...all].sort((a, b) => b.objective - a.objective);
  const q = Math.max(1, Math.floor(sorted.length / 4));
  for (const s of PARAM_SPECS) {
    const xs = all.map((c) => c.params[s.key]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    let sxy = 0, sxx = 0, syy = 0;
    xs.forEach((x, i) => {
      sxy += (x - mx) * (ys[i] - my);
      sxx += (x - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    });
    const avg = (l: typeof all) => l.reduce((a, c) => a + c.params[s.key], 0) / l.length;
    out[s.key] = { corr: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0, top: avg(sorted.slice(0, q)), bottom: avg(sorted.slice(-q)) };
  }
  return out;
}
