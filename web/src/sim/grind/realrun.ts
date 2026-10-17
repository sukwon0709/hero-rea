// Grinding simulator, part 7: the whole game played for real with the grinding policy. The
// headless playthrough (web/src/native/dev/playthrough.ts) plays the story; at every FORMATION the
// neediest officers are fielded; at every battle the battle is first searched in the sandbox from
// a snapshot of the real state (searchBattle), then the best plan is played in the real game with
// the same policy and parameters. Predicted and actual results are both recorded.

import { PLAYER_SLOTS, AiMode, loadLearnTable } from '../../engine/battle/types';
import { factionOf } from '../../native/battle/model';
import type { BattleScene } from '../../native/battle/scene';
import { playHooked } from './capture';
import { branchChoice, storyPicks, type BranchChoice } from './branches';
import { shopVisit, type Purchase } from './shop';
import { assetsFor, makeHeadless } from './sandbox';
import { searchBattle, SearchRng, type BattleOutcome } from './battle';
import { scriptNotes } from './battle';
import { GrindPolicy, analyseBattle, pickFormation, type GrindParams } from './policy';
import type { CampaignBattle } from './campaign';

export interface RealBattle extends CampaignBattle {
  predicted: { won: boolean; turns: number; expTotal: number };
  matched: boolean;
  outcome: string;
}

export interface RealRunResult {
  result: string | null;
  battles: RealBattle[];
  roster: { officer: number; name: string; level: number; exp: number; reached99At: number | null }[];
  n99: number;
  top15: number;
  ms: number;
  sandboxBattles: number;
  issues: string[];
}

export async function realRun(
  files: Map<string, Uint8Array>,
  params: GrindParams,
  opts: { variants: number; seed?: number; elites?: Record<number, GrindParams>; log?: (l: string) => void; rescue?: number; branches?: BranchChoice },
): Promise<RealRunResult> {
  const t0 = performance.now();
  const rng = new SearchRng(opts.seed ?? 99);
  const battles: RealBattle[] = [];
  const reached = new Map<number, number>();
  let sandboxBattles = 0;
  const bought: Purchase[] = [];
  const { p } = await playHooked(
    files,
    // the same story branches as the captures the plans were learned on
    { seed: opts.seed ?? 12345, botAttempts: 3, storyPicks: storyPicks(opts.branches ?? branchChoice()) },
    {
      onFormation: (info, g) => pickFormation(g.state, info.fixed, info.records.length, params.strong, params.band > 0, params.healers, loadLearnTable(assetsFor(files).main)),
      // the merchant: buy in the real game (Game.shopBuy's rules); the sandbox then starts from it
      onShop: (g, items) => {
        const got = shopVisit(g.state, items, { areaHeals: params.area > 0.5, scrolls: params.scrolls });
        bought.push(...got);
        if (got.length) opts.log?.(`shop: ${got.map((x) => `${g.state.officers[x.officer].name}<-${g.state.items[x.item]?.name}`).join(' ')} (gold ${g.state.progress.money})`);
      },
      onBattle: async (snap, pt, real) => {
        const g = pt.game;
        const gx = g as unknown as Record<string, unknown>;
        // the real game already bought at its merchants: the sandbox must not buy again
        const search = await searchBattle(files, { ...snap, shops: [] }, params, null, opts.variants, rng, opts.elites?.[snap.index], opts.rescue ?? 10);
        const purchases = bought.splice(0);
        sandboxBattles += search.tried.length;
        const plan: BattleOutcome = search.best;
        const before = g.state.officers.map((o) => o.dyn.level * 100 + o.dyn.exp);
        const origAfter = gx.afterSetup;
        let policy: GrindPolicy | null = null;
        let scene: BattleScene | null = null;
        let rerolls = plan.params.rerolls ?? 0;
        if (plan.won) {
          gx.afterSetup = (sc: BattleScene) => {
            scene = sc;
            for (let i = 0; i < PLAYER_SLOTS; i++) {
              const u = sc.units[i];
              if (u.officer !== 0xffff && u.mode === AiMode.AttackNearest && factionOf(g.state.officers[u.officer]) === 0) u.mode = AiMode.Player;
            }
            makeHeadless(sc);
            policy = new GrindPolicy(sc, plan.params, analyseBattle(g.vm.stage, g.vm.state));
            policy.install();
            if (rerolls > 0) {
              rerolls--;
              policy.retreatNow = true;
            }
          };
        }
        let r: 'won' | 'lost' | 'ended';
        try {
          r = await real(g, snap.map);
        } finally {
          gx.afterSetup = origAfter;
        }
        let fellBack = false;
        if (plan.won && r === 'lost') {
          // the sandbox said win but the real game lost (a mismatch, reported): put the game back to
          // the battle start and let the harness play it (its bot, then its labelled force win), so
          // the story goes on
          opts.log?.(`[${snap.index}] ${snap.name}: planned win LOST in the real game; replaying with the harness bot`);
          Object.assign(g.state, structuredClone(snap.state));
          Object.assign(g.vm.state, structuredClone(snap.script));
          g.rng.seed = snap.rngSeed;
          g.formation = snap.formation ? [...snap.formation] : g.formation;
          policy = null;
          scene = null;
          fellBack = true;
          r = await real(g, snap.map);
        }
        const rec = pt.battles[pt.battles.length - 1];
        const pol = policy as GrindPolicy | null;
        const sc = scene as BattleScene | null;
        const gains = (sc ? sc.units.slice(0, PLAYER_SLOTS).filter((u) => u.officer < 0x100) : []).map((u) => {
          const o = g.state.officers[u.officer];
          const st = pol?.stats.byOfficer.get(u.officer) ?? { hits: 0, kills: 0, tactics: 0, heals: 0 };
          return {
            officer: u.officer,
            name: o.name,
            levelBefore: Math.trunc(before[u.officer] / 100),
            levelAfter: o.dyn.level,
            expGained: o.dyn.level * 100 + o.dyn.exp - before[u.officer],
            ...st,
          };
        });
        const expTotal = gains.reduce((s, x) => s + x.expGained, 0);
        for (const x of gains) if (x.levelAfter >= 99 && !reached.has(x.officer)) reached.set(x.officer, snap.index);
        const turns = pol?.stats.turns ?? rec?.turns ?? 0;
        const won = r === 'won' && !!pol;
        const b: RealBattle = {
          index: snap.index,
          chapter: snap.chapter,
          name: snap.name,
          map: snap.map,
          won,
          forced: !pol || rec?.outcome === 'forced',
          turns,
          turnLimit: plan.turnLimit,
          finishTurn: pol?.stats.finishTurn ?? null,
          params: plan.params,
          kept: (pol?.stats.kept ?? []).map((k) => g.state.officers[k]?.name ?? String(k)),
          actions: pol?.stats.actions ?? plan.actions,
          tactics: Object.fromEntries([...(pol?.stats.tactics ?? new Map()).entries()].map(([t, n]) => [String(t), n])),
          gains,
          expTotal,
          variantsTried: search.tried.length,
          variantsWon: search.tried.filter((t) => t.won).length,
          ms: plan.ms,
          predicted: { won: plan.won, turns: plan.turns, expTotal: plan.expTotal },
          matched: plan.won && won && plan.turns === turns && plan.expTotal === expTotal,
          purchases,
          script: pol ? scriptNotes(pol, g.state, won, plan.turnLimit) : plan.script,
          outcome: fellBack ? `planned win lost; harness ${rec?.outcome ?? r}` : (rec?.outcome ?? r),
        };
        battles.push(b);
        opts.log?.(
          `[${snap.index}] ch${snap.chapter} ${snap.name}: ${b.outcome} turns ${turns}/${plan.turnLimit} exp ${expTotal} (predicted ${plan.won ? 'win' : 'no win'} ${plan.turns} turns exp ${plan.expTotal}${b.matched ? ', exact' : ''}) ` +
            gains.map((x) => `${x.name}${x.levelBefore}->${x.levelAfter}`).join(' '),
        );
        return r;
      },
    },
  );
  const g = p.game;
  const faction = g.state.officers[0].dyn.flags & 0x1f;
  const roster = g.state.officers
    .map((so, i) => ({ so, i }))
    .filter(({ so, i }) => i < 0x100 && (so.dyn.flags & 0x80) !== 0 && (so.dyn.flags & 0x1f) === faction)
    .map(({ so, i }) => ({ officer: i, name: so.name, level: so.dyn.level, exp: so.dyn.exp, reached99At: reached.get(i) ?? null }))
    .sort((a, b) => b.level - a.level || a.officer - b.officer);
  return {
    result: p.result,
    battles,
    roster,
    n99: roster.filter((r) => r.level >= 99).length,
    top15: roster.slice(0, 15).reduce((s, r) => s + Math.min(99, r.level), 0),
    ms: performance.now() - t0,
    sandboxBattles,
    issues: p.issues,
  };
}
