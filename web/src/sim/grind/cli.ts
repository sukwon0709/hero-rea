// Command line of the grinding simulator (run with vite-node from web/):
//
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts capture            story snapshots (force-won playthrough)
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts evolve --gens 5    learn: N generations (resumable)
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts real               whole game for real with the best plan
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts battle --index 3   one battle, traced
//
// Options: --out DIR (default /mnt/project-files/grind), --pop N (candidates per generation, 6),
// --variants N (plans tried per battle, 3), --workers N (parallel campaigns, 2), --limit N (first N
// battles only), --seed N, --reset (start the learning over).
// Output (outside the repository; it is generated from the player's game files): cache/captures.v8,
// state.json (learning state), progress.json + progress.html, results.json + guide.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serialize, deserialize } from 'node:v8';
import type { BattleSnapshot } from './sandbox';
import { captureStory } from './capture';
import { runCampaign, type CampaignResult } from './campaign';
import { runGrindBattle, safeGrindBattle, type CarryState } from './battle';
import { defaultParams, type GrindParams } from './policy';
import { frozenBattles, newEvolveState, populationSize, sampleGeneration, updateGeneration, type CandidateResult, type EvolveState } from './evolve';
import { realRun } from './realrun';
import { progressHtml, progressJson, guideMarkdown, resultsJson, tacticNames, itemNames, type Bench, type BenchRow, type HintAb, type LiveStatus } from './report';
import { dsTable, S } from '../../native/battle/strings';
import { parseBakData } from '../../formats/tables';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const opt = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};
const sopt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name: string) => argv.includes(`--${name}`);

const OUT = sopt('out', '/mnt/project-files/grind');
const GAME = process.env.HERO_GAME_DIR ?? '';

function loadFiles(): Map<string, Uint8Array> {
  if (!GAME || !existsSync(join(GAME, 'MAIN.EXE'))) throw new Error('set HERO_GAME_DIR to the game folder');
  const files = new Map<string, Uint8Array>();
  for (const f of readdirSync(GAME)) files.set(f.toUpperCase(), new Uint8Array(readFileSync(join(GAME, f))));
  const main = files.get('MAIN.EXE')!;
  const dec = new TextDecoder('euc-kr');
  for (let t = 0; t < 36; t++) tacticNames.set(t, dec.decode(dsTable(main, S.tactics, t, true)).trim());
  for (const it of parseBakData(files.get('BAKDATA.R3')!).items) itemNames.set(it.index, it.name);
  return files;
}

const capPath = () => join(OUT, 'cache', 'captures.v8');
function loadCaptures(): BattleSnapshot[] {
  return deserialize(readFileSync(capPath())) as BattleSnapshot[];
}

const statePath = () => join(OUT, 'state.json');
/**
 * hints.json (optional, edited by hand): { "defaults": { ...GrindParams }, "battles": { "<index or battle name>": { ...GrindParams, "rerolls": n } } }.
 * defaults set the starting point of the learning; battle entries are tried first in that battle's search.
 */
interface Hints {
  defaults?: Partial<GrindParams>;
  battles?: Record<string, Partial<GrindParams>>;
}
function loadHints(snaps: BattleSnapshot[] | null): { defaults?: Partial<GrindParams>; perBattle: Record<number, Partial<GrindParams>> } {
  const path = join(OUT, 'hints.json');
  if (!existsSync(path)) return { perBattle: {} };
  const h = JSON.parse(readFileSync(path, 'utf8')) as Hints;
  const perBattle: Record<number, Partial<GrindParams>> = {};
  for (const [key, v] of Object.entries(h.battles ?? {})) {
    if (/^\d+$/.test(key)) perBattle[Number(key)] = v;
    else for (const s of snaps ?? []) if (s.name === key) perBattle[s.index] = v;
  }
  return { defaults: h.defaults, perBattle };
}

function loadState(hints?: Partial<GrindParams>): EvolveState {
  if (!flag('reset') && existsSync(statePath())) return JSON.parse(readFileSync(statePath(), 'utf8')) as EvolveState;
  return newEvolveState(opt('seed', 1), hints);
}

/** Write then rename, so a reader never sees a half-written file. */
function atomicWrite(path: string, data: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function loadAb(): HintAb | undefined {
  const p = join(OUT, 'hint-ab.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as HintAb) : undefined;
}
/** The other A/Bs (hint-ab-<label>.json), oldest first. */
function loadAbs(): HintAb[] {
  return readdirSync(OUT)
    .filter((f) => /^hint-ab-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8')) as HintAb)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function writeProgress(st: EvolveState, live?: LiveStatus, saveState = !live) {
  if (saveState) atomicWrite(statePath(), JSON.stringify(st));
  const ab = loadAb();
  const benches = readdirSync(OUT)
    .filter((f) => /^bench-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Bench)
    .sort((a, b) => a.date.localeCompare(b.date));
  const abs = loadAbs();
  atomicWrite(join(OUT, 'progress.json'), JSON.stringify(progressJson(st, live, ab, benches, abs), null, 1));
  atomicWrite(join(OUT, 'progress.html'), progressHtml(st, live, ab, benches, abs));
}

/** Summary of one campaign for the hint A/B comparison. */
function abSide(params: GrindParams, c: CampaignResult): HintAb['with'] {
  let heals = 0, healExp = 0, tactics = 0, exp = 0;
  for (const b of c.battles) {
    heals += b.actions.heal;
    tactics += b.actions.tactic;
    exp += b.expTotal;
    for (const g of b.gains) healExp += g.heals;
  }
  let gainsFired = 0, gainsOpen = 0, bonuses = 0, control = 0;
  for (const b of c.battles) {
    for (const [t, n] of Object.entries(b.tactics)) if (Number(t) >= 15 && Number(t) <= 20) control += n;
    if (!b.won || !b.script) continue;
    for (const g of b.script.gains) if (!g.automatic) (gainsOpen++, g.fired && gainsFired++);
    if (b.script.bonus) bonuses++;
  }
  const liuBei = c.roster.find((r) => r.officer === 0)?.level;
  return { params, n99: c.n99, top15: c.top15, wins: c.wins, forced: c.forced, heals, tactics, healExp, exp, seconds: Math.round(c.ms / 1000), roster: c.roster.slice(0, 15).map((r) => ({ name: r.name, level: r.level })), gainsFired, gainsOpen, bonuses, liuBei, control };
}

/** One campaign in a child process (parallel candidates); falls back to in-process for workers=1. */
interface Job {
  params: GrindParams;
  variants: number;
  seed: number;
  limit: number;
  elites: Record<number, GrindParams>;
  frozen: number[];
  hints: Record<number, Partial<GrindParams>>;
  rescue: number;
  extra?: { battle: number; variants: number; rescue: number };
}

function campaignInChild(j: Job, onBattle?: (k: number) => void): Promise<CampaignResult> {
  return new Promise((resolve, reject) => {
    const job = join(OUT, 'cache', `job-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(job, JSON.stringify(j));
    const child = spawn(process.execPath, [process.argv[1], new URL(import.meta.url).pathname, 'worker', '--job', job, '--out', OUT], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d: Buffer) => {
      process.stderr.write(d);
      for (const m of String(d).matchAll(/^\s*\[(\d+)\]/gm)) onBattle?.(Number(m[1]));
    });
    child.on('close', (code) => {
      const m = buf.match(/@@RESULT@@(.*)$/m);
      if (code === 0 && m) resolve(JSON.parse(readFileSync(m[1], 'utf8')) as CampaignResult);
      else reject(new Error(`worker exited ${code}`));
    });
  });
}

async function main() {
  mkdirSync(join(OUT, 'cache'), { recursive: true });
  if (cmd === 'capture') {
    const files = loadFiles();
    const r = await captureStory(files, opt('seed', 12345), (l) => {
      if (/RESTART|ISSUE/.test(l)) console.log(l);
    });
    writeFileSync(capPath(), serialize(r.snaps));
    console.log(`capture: ${r.result}, ${r.snaps.length} battles, ${(r.ms / 1000).toFixed(1)} s, issues ${r.issues.length}`);
    for (const s of r.snaps) console.log(`${s.index} ch${s.chapter} st${s.stage} bl${s.block} map ${s.map} ${s.name} limit ${s.script.battleB}${s.formationInfo ? ' formation' : ''}`);
    return;
  }
  if (cmd === 'worker') {
    const job = JSON.parse(readFileSync(sopt('job', ''), 'utf8')) as Job;
    const files = loadFiles();
    const snaps = loadCaptures();
    const res = await runCampaign(files, snaps, job.params, { variants: job.variants, seed: job.seed, limit: job.limit || undefined, elites: job.elites, frozen: new Set(job.frozen), hints: job.hints, rescue: job.rescue, extra: job.extra, log: (l) => process.stderr.write(`${l}\n`) });
    const outFile = sopt('job', '') + '.out';
    writeFileSync(outFile, JSON.stringify(res));
    console.log(`@@RESULT@@${outFile}`);
    return;
  }
  if (cmd === 'battle') {
    const files = loadFiles();
    const snaps = loadCaptures();
    const snap = snaps[opt('index', 0)];
    // hint defaults, and the bench's reference carry for that battle when there is one (realistic levels)
    const fx = join(OUT, 'cache', 'bench-carry.v8');
    const carries = existsSync(fx) ? (deserialize(readFileSync(fx)) as Record<number, CarryState | null>) : {};
    const params: GrindParams = { ...defaultParams(), ...(flag('nohints') ? {} : loadHints(snaps).defaults ?? {}), finish: opt('finish', defaultParams().finish), ...(JSON.parse(sopt('set', '{}')) as Partial<GrindParams>) };
    const o = await runGrindBattle(files, snap, params, carries[snap.index] ?? null, flag('trace') ? (l) => console.log(l) : undefined);
    if (o.script) console.log(JSON.stringify(o.script));
    console.log(JSON.stringify({ name: snap.name, won: o.won, turns: o.turns, limit: o.turnLimit, finish: o.finishTurn, exp: o.expTotal, ms: Math.round(o.ms), actions: o.actions, kept: o.kept }));
    for (const g of o.gains) console.log(`  ${g.name} ${g.levelBefore} -> ${g.levelAfter} (+${g.expGained}: hits ${g.hits} kills ${g.kills} tactics ${g.tactics} heals ${g.heals})`);
    return;
  }
  if (cmd === 'evolve') {
    const files = loadFiles();
    const snaps = loadCaptures();
    const hints = loadHints(snaps);
    const st = loadState(hints.defaults);
    const gens = opt('gens', 3), maxPop = opt('pop', 6), variants = opt('variants', 3), workers = opt('workers', 2), limit = opt('limit', 0), rescue = opt('retries', opt('rescue', 10));
    for (let g = 0; g < gens; g++) {
      const t0 = performance.now();
      const pop = populationSize(st, maxPop);
      const cands = sampleGeneration(st, pop);
      const frozen = [...frozenBattles(st)];
      // the battle where the best run so far stopped gets twice the variants and retries
      const fr = st.best?.campaign.frontier;
      const extra = fr ? { battle: fr.index, variants: variants * 2, rescue: rescue * 2 } : undefined;
      // common random numbers: every candidate of a generation is played with the same search seed
      const seed = st.seed * 1000 + st.gen * 37;
      const results: { cand: CandidateResult; campaign: CampaignResult }[] = [];
      const live: LiveStatus = { gen: st.gen, done: 0, total: cands.length, startedAt: Date.now(), candidates: [], battles: cands.map(() => 0), battleCount: limit || snaps.length };
      let lastLive = 0;
      writeProgress(st, live);
      let next = 0;
      const one = async () => {
        while (next < cands.length) {
          const i = next++;
          const job: Job = { params: cands[i], variants, seed, limit, elites: st.elites, frozen, hints: hints.perBattle, rescue, extra };
          const c = workers > 1
            ? await campaignInChild(job, (k) => {
                live.battles[i] = k + 1;
                if (Date.now() - lastLive > 20000) {
                  lastLive = Date.now();
                  writeProgress(st, live);
                }
              })
            : await runCampaign(files, snaps, cands[i], { variants, seed, limit: limit || undefined, elites: st.elites, frozen: new Set(frozen), hints: hints.perBattle, rescue, extra });
          results.push({
            cand: { params: cands[i], objective: c.objective, n99: c.n99, top15: c.top15, wins: c.wins, forced: c.forced, ms: c.ms, battlesRun: c.battlesRun, cleared: c.cleared, frontier: c.frontier },
            campaign: c,
          });
          live.done++;
          live.candidates.push({ objective: c.objective, n99: c.n99, top15: c.top15, wins: c.wins, forced: c.forced, seconds: c.ms / 1000, cleared: c.cleared, frontier: c.frontier });
          writeProgress(st, live);
          console.log(`gen ${st.gen} cand ${i}: cleared ${c.cleared}${c.frontier ? ` (stopped at [${c.frontier.index}] ${c.frontier.name})` : ' (reached the end)'} n99 ${c.n99} top15 ${c.top15} ${(c.ms / 1000).toFixed(0)} s (${c.battlesRun} battles)`);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, workers) }, one));
      const rec = updateGeneration(st, results, performance.now() - t0);
      console.log(`gen ${rec.gen}: best ${rec.best} (n99 ${rec.bestN99}) mean ${rec.mean.toFixed(0)} in ${(rec.ms / 1000).toFixed(0)} s`);
      writeProgress(st);
    }
    return;
  }
  if (cmd === 'ab') {
    // the human hint's effect: one campaign from the plain defaults, one from defaults + hints.json
    // defaults, same search seed and budget, run side by side in two workers
    const snaps = loadCaptures();
    const hints = loadHints(snaps);
    // --label NAME --base JSON: a further A/B (hint-ab-NAME.json) whose "without" side is the defaults + JSON
    const label = sopt('label', '');
    const base = label ? (JSON.parse(sopt('base', '{}')) as Partial<GrindParams>) : {};
    const without: GrindParams = { ...defaultParams(), ...base };
    const withHint: GrindParams = { ...defaultParams(), ...(hints.defaults ?? {}), ...(JSON.parse(sopt('with', '{}')) as Partial<GrindParams>) };
    const variants = opt('variants', 3), seed = opt('seed', 1) * 1000, limit = opt('limit', 0);
    const job = (params: GrindParams): Job => ({ params, variants, seed, limit, elites: {}, frozen: [], hints: {}, rescue: opt('retries', opt('rescue', 10)) });
    const [a, b] = await Promise.all([campaignInChild(job(without)), campaignInChild(job(withHint))]);
    const ab: HintAb = { hint: hints.defaults ?? {}, without: abSide(without, a), with: abSide(withHint, b), date: new Date().toISOString() };
    if (label) Object.assign(ab, { label, base, title: sopt('title', label) });
    atomicWrite(join(OUT, label ? `hint-ab-${label}.json` : 'hint-ab.json'), JSON.stringify(ab, null, 1));
    console.log(JSON.stringify({ without: { ...ab.without, roster: undefined }, with: { ...ab.with, roster: undefined } }));
    if (existsSync(statePath())) writeProgress(loadState(), undefined, false);
    return;
  }
  if (cmd === 'bench') {
    // bot wins per battle from fixed starting levels (the carry of one reference campaign), over
    // several RNG seeds, for the grinding policy and for the game's own AI; written to
    // bench-<label>.json and shown in progress.html (before / after a policy change)
    const files = loadFiles();
    const snaps = loadCaptures();
    const list = sopt('battles', '3,6,8,9,11').split(',').map(Number);
    const seeds = opt('seeds', 6);
    const hints = loadHints(snaps);
    const params: GrindParams = { ...defaultParams(), ...(hints.defaults ?? {}) };
    const fx = join(OUT, 'cache', 'bench-carry.v8');
    let carries: Record<number, CarryState | null>;
    if (existsSync(fx)) carries = deserialize(readFileSync(fx)) as Record<number, CarryState | null>;
    else {
      carries = {};
      await runCampaign(files, snaps, params, { variants: 3, seed: 1, limit: Math.max(...list) + 1, rescue: 3, stopOnLoss: false, log: (l) => console.log(l), onCarry: (k, c) => (carries[k] = c ? structuredClone(c) : null) });
      writeFileSync(fx, serialize(carries));
    }
    // --boost N: every officer of our side starts N levels higher (how far from winnable are we?)
    const boost = opt('boost', 0);
    if (boost)
      for (const k of list) {
        const c = carries[k];
        const offs = c?.officers ?? snaps[k].state.officers.map((o) => ({ level: o.dyn.level, exp: o.dyn.exp }));
        carries[k] = {
          officers: offs.map((o, i) => ((snaps[k].state.officers[i]?.dyn.flags ?? 1) & 0x1f) === 0 && i < 0x100 ? { level: Math.min(99, o.level + boost), exp: o.exp } : o),
          formation: c?.formation,
        };
      }
    const rows: BenchRow[] = [];
    for (const k of list) {
      for (const native of [false, true]) {
        const row: BenchRow = { index: k, name: snaps[k].name, mode: native ? 'ai' : 'policy', wins: 0, tries: 0, reasons: {}, exp: 0 };
        for (let s = 0; s < seeds; s++) {
          const snap = { ...snaps[k], rngSeed: (snaps[k].rngSeed + s * 7777) >>> 0 };
          const o = await safeGrindBattle(files, snap, { ...params, native }, carries[k] ?? null);
          row.tries++;
          if (o.won) {
            row.wins++;
            row.exp += o.expTotal;
          } else row.reasons[o.loss ?? '?'] = (row.reasons[o.loss ?? '?'] ?? 0) + 1;
        }
        rows.push(row);
        console.log(`${k} ${row.name} ${row.mode}: ${row.wins}/${row.tries} ${JSON.stringify(row.reasons)}`);
      }
    }
    const label = sopt('label', 'now');
    atomicWrite(join(OUT, `bench-${label}.json`), JSON.stringify({ label, date: new Date().toISOString(), seeds, params, rows }, null, 1));
    if (existsSync(statePath())) writeProgress(loadState(), undefined, false);
    return;
  }
  if (cmd === 'real') {
    const files = loadFiles();
    const st = loadState();
    const params = st.best?.params ?? { ...defaultParams(), ...(loadHints(null).defaults ?? {}) };
    const r = await realRun(files, params, { variants: opt('variants', 3), elites: st.elites, rescue: opt('retries', opt('rescue', 10)), log: (l) => console.log(l) });
    atomicWrite(join(OUT, 'results.json'), JSON.stringify(resultsJson(r, st), null, 1));
    atomicWrite(join(OUT, 'guide.md'), guideMarkdown(r, st));
    console.log(`real run: ${r.result}, n99 ${r.n99}, top15 ${r.top15}, ${(r.ms / 1000).toFixed(0)} s, ${r.sandboxBattles} sandbox battles`);
    return;
  }
  console.log('commands: capture | evolve [--gens N --pop N --variants N --workers N] | real | battle --index N [--trace]');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
