// Command line of the grinding simulator (run with vite-node from web/):
//
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts capture            story snapshots (force-won playthrough)
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts evolve --gens 5    learn: N generations (resumable)
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts real               whole game for real with the best plan
//   HERO_GAME_DIR=... npx vite-node src/sim/grind/cli.ts battle --index 3   one battle, traced
//
// Options: --out DIR (default $GRIND_OUT or /mnt/project-files/grind; $TMPDIR/hero-grind when that is down), --pop N (candidates per generation, 6),
// --variants N (plans tried per battle, 3), --workers N (parallel campaigns, 2), --limit N (first N
// battles only), --seed N, --reset (start the learning over).
// Output (outside the repository; it is generated from the player's game files): cache/captures.v8,
// state.json (learning state), progress.json + progress.html, results.json + guide.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serialize, deserialize } from 'node:v8';
import type { BattleSnapshot } from './sandbox';
import { captureStory } from './capture';
import { enemyLevel, runCampaign, topLevel, type CampaignResult } from './campaign';
import { runGrindBattle, safeGrindBattle, type CarryState } from './battle';
import { defaultParams, PARAM_SPECS, type GrindParams } from './policy';
import { dropRushPlans, frozenBattles, frozenOf, newEvolveState, populationSize, sampleGeneration, updateGeneration, updateRestart, type CandidateResult, type EvolveState } from './evolve';
import { realRun } from './realrun';
import { progressHtml, progressJson, progressMarkdown, guideMarkdown, resultsJson, tacticNames, itemNames, type Bench, type BenchRow, type HintAb, type LiveStatus } from './report';
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

// --out, else $GRIND_OUT, else the shared mount; when the mount is down (EIO, ENOENT, EACCES) and no
// --out was given, main() falls back to a local directory instead of crashing
const OUT_GIVEN = argv.includes('--out') || !!process.env.GRIND_OUT;
let OUT = sopt('out', process.env.GRIND_OUT || '/mnt/project-files/grind');
// local working directory (job / result files, the captures and state copies): OUT may be a network
// mount (rclone), where many small file writes failed with EIO and crashed a run
const WORK = sopt('work', join(tmpdir(), 'hero-grind-work'));
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
const localCap = () => join(WORK, 'captures.v8');
/** Captures: workers read the local copy; the main process refreshes it from OUT (falls back to it). */
function loadCaptures(): BattleSnapshot[] {
  let buf: Buffer | null = null;
  if (cmd !== 'worker')
    try {
      buf = readFileSync(capPath());
      mkdirSync(WORK, { recursive: true });
      writeFileSync(localCap(), buf);
    } catch (e) {
      if (!existsSync(localCap())) throw e;
      console.error(`captures: ${capPath()} unreadable (${(e as Error).message}); using the local copy`);
    }
  return deserialize(buf ?? readFileSync(existsSync(localCap()) ? localCap() : capPath())) as BattleSnapshot[];
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
  if (!flag('reset')) {
    // the newer of OUT/state.json and the local copy (a save to OUT may have failed)
    const cands = [statePath(), join(WORK, 'state.json')].flatMap((p) => {
      try {
        return [JSON.parse(readFileSync(p, 'utf8')) as EvolveState];
      } catch {
        return [];
      }
    });
    if (cands.length) {
      const st = cands.reduce((a, b) => (b.gen > a.gen ? b : a));
      // parameters added since the state was saved: their default as the mean, a wide spread
      PARAM_SPECS.forEach((sp, i) => {
        if (!Number.isFinite(st.mean[i])) st.mean[i] = (sp.def - sp.min) / (sp.max - sp.min);
        if (!Number.isFinite(st.std[i])) st.std[i] = 0.25;
      });
      return st;
    }
  }
  return newEvolveState(opt('seed', 1), hints);
}

/** Write then rename, so a reader never sees a half-written file. Retries on I/O errors and never throws (logs instead). */
function atomicWrite(path: string, data: string): boolean {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, data);
      renameSync(tmp, path);
      return true;
    } catch (e) {
      if (attempt === 4) {
        console.error(`write ${path} failed: ${(e as Error).message} (skipped; the run goes on)`);
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * attempt);
    }
  }
  return false;
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

let lastLiveWrite = 0;
function writeProgress(st: EvolveState, live?: LiveStatus, saveState = !live) {
  // live updates (during a generation) at most once a minute: few writes to a network mount
  if (live) {
    if (Date.now() - lastLiveWrite < 60_000) return;
    lastLiveWrite = Date.now();
  }
  if (saveState) {
    const js = JSON.stringify(st);
    try {
      mkdirSync(WORK, { recursive: true });
      writeFileSync(join(WORK, 'state.json'), js);
    } catch {
      /* local copy only */
    }
    atomicWrite(statePath(), js);
  }
  let ab: HintAb | undefined, benches: Bench[] = [], abs: HintAb[] = [];
  try {
    ab = loadAb();
    benches = readdirSync(OUT)
      .filter((f) => /^bench-.*\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Bench)
      .sort((a, b) => a.date.localeCompare(b.date));
    abs = loadAbs();
  } catch (e) {
    console.error(`progress: reading ${OUT} failed (${(e as Error).message}); writing without the A/B and bench data`);
  }
  const pj = progressJson(st, live, ab, benches, abs);
  atomicWrite(join(OUT, 'progress.json'), JSON.stringify(pj, null, 1));
  atomicWrite(join(OUT, 'progress.md'), progressMarkdown(pj));
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
  backtrack?: number;
  replan?: number;
  levelGate?: { battle: number; level: number; passes: number };
}

function campaignInChild(j: Job, onBattle?: (k: number) => void): Promise<CampaignResult> {
  return new Promise((resolve, reject) => {
    mkdirSync(WORK, { recursive: true });
    const job = join(WORK, `job-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(job, JSON.stringify(j));
    const child = spawn(process.execPath, [process.argv[1], new URL(import.meta.url).pathname, 'worker', '--job', job, '--out', OUT, '--work', WORK], {
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
      try {
        if (code === 0 && m) resolve(JSON.parse(readFileSync(m[1], 'utf8')) as CampaignResult);
        else reject(new Error(`worker exited ${code}`));
      } catch (e) {
        reject(e as Error);
      }
      for (const f of [job, `${job}.out`]) rmSync(f, { force: true });
    });
  });
}

async function main() {
  try {
    mkdirSync(join(OUT, 'cache'), { recursive: true });
  } catch (e) {
    if (OUT_GIVEN) throw e;
    const local = join(tmpdir(), 'hero-grind');
    console.error(`grind: ${OUT} is not writable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); using ${local} (pass --out to choose)`);
    OUT = local;
    mkdirSync(join(OUT, 'cache'), { recursive: true });
  }
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
    const res = await runCampaign(files, snaps, job.params, { variants: job.variants, seed: job.seed, limit: job.limit || undefined, elites: job.elites, frozen: new Set(job.frozen), hints: job.hints, rescue: job.rescue, extra: job.extra, backtrack: job.backtrack, replan: job.replan, levelGate: job.levelGate, log: (l) => process.stderr.write(`${l}\n`) });
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
    // --best: the carry the best evolve run arrived with at its frontier battle (state.json)
    let carry: CarryState | null = carries[snap.index] ?? null;
    if (flag('best') && existsSync(statePath())) {
      const st = JSON.parse(readFileSync(statePath(), 'utf8')) as EvolveState;
      const c = st.best?.campaign;
      if (c?.frontier?.index === snap.index && c.carryOut) carry = { officers: c.carryOut.officers, formation: c.carryOut.formation, money: c.carryOut.money };
      else console.log('no best-run carry for this battle; using the bench carry');
      if (st.best && !flag('nohints')) Object.assign(params, st.best.params, JSON.parse(sopt('set', '{}')));
    }
    const o = await runGrindBattle(files, snap, params, carry, flag('trace') ? (l) => console.log(l) : undefined);
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
    // plans of removed emergency variants are not kept (Sukwon: no emergency means)
    const dropped = dropRushPlans(st);
    if (dropped.length) console.log(`dropped plans of removed emergency variants: ${dropped.join('; ')}`);
    // rules 2: no charge at the enemy leader / escape cell before the last third (regroup instead);
    // a best run made under older rules is not the reference any more (its plans stay as seeds)
    const RULES = 2;
    if ((st.rules ?? 1) < RULES) {
      if (st.best) console.log(`rules ${RULES}: the best run (cleared ${st.best.campaign.cleared}) was played under older rules; dropped as the reference, its plans kept as seeds`);
      st.best = null;
      if (st.restart) st.restart.best = null;
      st.rules = RULES;
    }
    // Sukwon approved the last-turn escape: the exit plan's mean goes to its default (on) once, with
    // a wide spread again (it had settled near off while it was off by default); the best run stays
    if (!st.exitOn) {
      const i = PARAM_SPECS.findIndex((sp) => sp.key === 'exit');
      const sp = PARAM_SPECS[i];
      st.mean[i] = (sp.def - sp.min) / (sp.max - sp.min);
      st.std[i] = Math.max(st.std[i] ?? 0, 0.2);
      st.exitOn = 1;
      console.log('exit plan: on by default for arrival battles (CEM mean reset to on)');
    }
    const gens = opt('gens', 3), maxPop = opt('pop', 6), variants = opt('variants', 3), workers = opt('workers', 2), limit = opt('limit', 0), rescue = opt('retries', opt('rescue', 10));
    for (let g = 0; g < gens; g++) {
      const t0 = performance.now();
      const pop = populationSize(st, maxPop);
      const cands = sampleGeneration(st, pop);
      const frozen = [...frozenBattles(st)];
      // the battle where the best run so far stopped gets twice the variants and retries
      const fr = st.best?.campaign.frontier;
      // escalating while it stays stuck there: +1x per generation with the same frontier, up to 8x
      let stuck = 0;
      // (restart generations are skipped: their own frontier is wherever the restart got to)
      for (let h = st.history.length - 1; h >= 0 && fr; h--) {
        if (st.history[h].fresh) continue;
        if (st.history[h].frontier?.index !== fr.index) break;
        stuck++;
      }
      const mult = Math.min(8, 2 + stuck);
      // stuck for 3, 6, 9 ... generations (going back 1-2 battles was not enough): a full restart
      // from battle 1 begins, as a lineage of its own (st.restart) that runs for several
      // generations with its own plans and frontier, no frozen plans of the main line, twice the
      // variants (the search keeps the won plan with the most exp) and a level target at the wall
      // (Sukwon: start over and raise the levels much higher): top-9 average at least the wall's
      // enemy level and the stuck run's +3, +2 for every earlier restart at the same wall. The
      // main line waits meanwhile; the CEM learns from both.
      const startRestart = !st.restart && fr !== null && fr !== undefined && stuck >= 3 && stuck % 3 === 0 && !st.history[st.history.length - 1]?.fresh;
      if (startRestart) {
        const before = st.history.filter((h) => h.restart?.gen === 1 && h.restart.wall === fr!.index).length + st.history.filter((h) => h.fresh && !h.restart && h.wall === fr!.index).length;
        // the generic enemies' levels are set when the battle starts, so the stuck run's arrival
        // levels +3 are the floor of the target
        const arrived = st.best?.campaign.carryOut?.officers ? topLevel(snaps[fr!.index], st.best.campaign.carryOut.officers, 9) : 0;
        const level = Math.round(Math.max(enemyLevel(snaps[fr!.index]), arrived + 3)) + 2 * before;
        st.restart = { wall: fr!.index, wallName: fr!.name, level, startGen: st.gen, gens: 0, elites: {}, eliteAge: {}, best: null, stall: 0 };
        console.log(`gen ${st.gen}: frontier [${fr!.index}] ${fr!.name} stuck ${stuck} generations -> full restart lineage from battle 1 (no frozen plans), level target Lv${level} at the wall, ${variants * 2} variants per battle`);
      }
      const rs = st.restart;
      const fresh = !!rs;
      const levelGate: Job['levelGate'] = rs ? { battle: rs.wall, level: rs.level, passes: 4 } : undefined;
      const lineElites = rs ? rs.elites : st.elites;
      const lineFrozen = rs ? [...frozenOf(rs.elites, rs.eliteAge)] : frozen;
      const runVariants = rs ? variants * 2 : variants;
      // the line's own frontier gets the escalated variants and retries
      const rfr = rs ? rs.best?.frontier ?? null : fr ?? null;
      const rmult = rs ? Math.min(8, 2 + rs.stall) : mult;
      const extra = rfr ? { battle: rfr.index, variants: variants * Math.min(4, rmult), rescue: rescue * rmult } : undefined;
      if (rs) console.log(`gen ${st.gen}: restart lineage gen ${rs.gens + 1} (wall [${rs.wall}] ${rs.wallName}, target Lv${rs.level})${rfr ? `: its frontier [${rfr.index}] ${rfr.name}, ${extra!.variants} variants, ${extra!.rescue} retries there` : ''}`);
      else if (extra) console.log(`gen ${st.gen}: frontier [${fr!.index}] ${fr!.name}, stuck ${stuck} generations: ${extra.variants} variants, ${extra.rescue} retries there`);
      // common random numbers: every candidate of a generation is played with the same search seed
      const seed = st.seed * 1000 + st.gen * 37;
      const results: { cand: CandidateResult; campaign: CampaignResult }[] = [];
      const live: LiveStatus = { gen: st.gen, done: 0, total: cands.length, startedAt: Date.now(), candidates: [], battles: cands.map(() => 0), battleCount: limit || snaps.length };
      let lastLive = 0;
      // candidates finished before a stop are kept on local disk (gen-N.json) and not played again;
      // entries marked `injected` (a recovered run) join this generation's results as they are
      const pendingPath = join(WORK, `gen-${st.gen}.json`);
      type Pending = { i: number; params: GrindParams; campaign: CampaignResult; injected?: boolean };
      let pending: Pending[] = [];
      try {
        pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as Pending[];
      } catch {
        pending = [];
      }
      const doneIdx = new Set<number>();
      const take = (i: number, params: GrindParams, c: CampaignResult) => {
        results.push({
          cand: { params, objective: c.objective, n99: c.n99, top15: c.top15, wins: c.wins, forced: c.forced, ms: c.ms, battlesRun: c.battlesRun, cleared: c.cleared, frontier: c.frontier },
          campaign: c,
        });
        live.done++;
        live.candidates.push({ objective: c.objective, n99: c.n99, top15: c.top15, wins: c.wins, forced: c.forced, seconds: c.ms / 1000, cleared: c.cleared, frontier: c.frontier });
      };
      for (const pd of pending) {
        if (pd.injected || (pd.i < cands.length && JSON.stringify(pd.params) === JSON.stringify(cands[pd.i]))) {
          take(pd.i, pd.params, pd.campaign);
          if (!pd.injected) doneIdx.add(pd.i);
          console.log(`gen ${st.gen} cand ${pd.injected ? 'recovered' : pd.i}: kept from before the stop, cleared ${pd.campaign.cleared}`);
        }
      }
      if (pending.length) live.total += pending.filter((pd) => pd.injected).length;
      const savePending = (pd: Pending) => {
        pending.push(pd);
        try {
          mkdirSync(WORK, { recursive: true });
          writeFileSync(pendingPath, JSON.stringify(pending));
        } catch (e) {
          console.error(`saving ${pendingPath} failed: ${(e as Error).message}`);
        }
      };
      writeProgress(st, live);
      let next = 0;
      const one = async () => {
        while (next < cands.length) {
          const i = next++;
          if (doneIdx.has(i)) continue;
          const job: Job = { params: cands[i], variants: runVariants, seed, limit, elites: lineElites, frozen: lineFrozen, hints: hints.perBattle, rescue, extra, backtrack: opt('backtrack', 2), replan: opt('replan', 2), levelGate };
          // a worker that dies (I/O error, crash) is tried again, then the candidate is dropped
          let c: CampaignResult | null = null;
          for (let attempt = 1; attempt <= 2 && !c && workers > 1; attempt++)
            c = await campaignInChild(job, (k) => {
              live.battles[i] = k + 1;
              if (Date.now() - lastLive > 20000) {
                lastLive = Date.now();
                writeProgress(st, live);
              }
            }).catch((e: Error) => {
              console.log(`gen ${st.gen} cand ${i}: worker failed (${e.message})${attempt < 2 ? ', trying again' : ', dropped'}`);
              return null;
            });
          if (workers > 1 && !c) {
            live.done++;
            continue;
          }
          if (!c) c = await runCampaign(files, snaps, cands[i], { variants: runVariants, seed, limit: limit || undefined, elites: lineElites, frozen: new Set(lineFrozen), hints: hints.perBattle, rescue, extra, backtrack: opt('backtrack', 2), replan: opt('replan', 2), levelGate });
          take(i, cands[i], c);
          savePending({ i, params: cands[i], campaign: c });
          writeProgress(st, live);
          console.log(`gen ${st.gen} cand ${i}: cleared ${c.cleared}${c.frontier ? ` (stopped at [${c.frontier.index}] ${c.frontier.name})` : ' (reached the end)'} n99 ${c.n99} top15 ${c.top15} ${(c.ms / 1000).toFixed(0)} s (${c.battlesRun} battles)`);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, workers) }, one));
      const before = st.best ? { cleared: st.best.campaign.cleared, objective: st.best.result.objective } : null;
      if (!results.length) {
        console.log(`gen ${st.gen}: every worker failed; trying the generation again`);
        continue;
      }
      const rec = updateGeneration(st, results, performance.now() - t0);
      rmSync(pendingPath, { force: true });
      if (rs) {
        rec.fresh = true;
        rec.wall = rs.wall;
        const top9Of = (c: CampaignResult) => (c.carryOut?.officers ? topLevel(snaps[Math.min(snaps.length - 1, c.frontier?.index ?? snaps.length - 1)], c.carryOut.officers, 9) : 0);
        const better = updateRestart(rs, results, top9Of);
        const b = rs.best!;
        const ended = b.cleared > rs.wall ? 'passed the wall' : rs.stall >= 3 ? 'stalled 3 generations on its own frontier' : rs.gens >= 12 ? 'out of generations (12)' : undefined;
        rec.restart = { gen: rs.gens, wall: rs.wall, wallName: rs.wallName, level: rs.level, cleared: b.cleared, frontier: b.frontier, top9: Math.round(b.top9 * 10) / 10, ended };
        const kept = before && st.best && st.best.result.objective === before.objective;
        console.log(`gen ${rec.gen}: restart lineage gen ${rs.gens}: ${better ? 'improved' : `no better run (stall ${rs.stall})`}; its best: cleared ${b.cleared}${b.frontier ? ` (stopped at [${b.frontier.index}] ${b.frontier.name})` : ' (reached the end)'}, top-9 Lv${b.top9.toFixed(1)} (target Lv${rs.level} at [${rs.wall}] ${rs.wallName}); main line ${kept ? `kept (cleared ${before!.cleared})` : 'replaced by the restart'}`);
        if (ended) {
          console.log(`gen ${rec.gen}: restart lineage ends: ${ended}`);
          delete st.restart;
        }
      }
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
  if (cmd === 'speed') {
    // simulation speed: the same battles (bench carry, a few RNG seeds) back to back in one process
    const files = loadFiles();
    const snaps = loadCaptures();
    const fx = join(OUT, 'cache', 'bench-carry.v8');
    const carries = existsSync(fx) ? (deserialize(readFileSync(fx)) as Record<number, CarryState | null>) : {};
    const params: GrindParams = { ...defaultParams(), ...(loadHints(snaps).defaults ?? {}) };
    const list = sopt('battles', '0,3,6,8').split(',').map(Number);
    const seeds = opt('seeds', 3);
    let n = 0, turns = 0, sig = 0;
    const t0 = performance.now();
    for (const k of list)
      for (let s = 0; s < seeds; s++) {
        const o = await runGrindBattle(files, { ...snaps[k], rngSeed: (snaps[k].rngSeed + s * 7777) >>> 0 }, params, carries[k] ?? null);
        n++;
        turns += o.turns;
        sig = (sig * 31 + o.expTotal + o.turns * 1000 + (o.won ? 7 : 0)) >>> 0;
      }
    const sec = (performance.now() - t0) / 1000;
    // sig: a checksum of the outcomes (an optimisation must not change any battle)
    console.log(`speed: ${n} battles, ${turns} turns in ${sec.toFixed(1)} s = ${(n / sec).toFixed(2)} battles/s, ${(turns / sec).toFixed(1)} turns/s, sig ${sig}`);
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
