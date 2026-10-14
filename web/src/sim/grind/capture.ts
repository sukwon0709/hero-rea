// Grinding simulator, part 4: the story skeleton. A headless playthrough of the real game (the dev
// harness web/src/native/dev/playthrough.ts, battles force-won so it is fast) records a snapshot
// at the start of every battle (GameState, script context, RNG seed, sortie list, the FORMATION
// that preceded it) and the officers' level/exp after it. The campaign simulator replays the
// battles from these snapshots and carries levels from battle to battle (campaign.ts).
// The same hooks drive the real grinding run (realrun.ts), where each battle is planned in the
// sandbox and then played in the real game.

import { Playthrough, type PlaythroughOptions } from '../../native/dev/playthrough';
import type { RunBattle } from '../../native/context';
import type { Game } from '../../native/game';
import { battleNameLines } from '../../engine/battle/map';
import type { BattleSnapshot, FormationInfo } from './sandbox';

const dec = new TextDecoder('euc-kr');

export interface Hooks {
  /** Called at every battle start with the snapshot; may return a replacement runner. */
  onBattle?: (snap: BattleSnapshot, p: Playthrough, real: RunBattle) => Promise<'won' | 'lost' | 'ended'>;
  /** Replaces the FORMATION picks (returns the officers for the free records). */
  onFormation?: (info: FormationInfo, game: Game) => number[] | null;
}

/** Installs the snapshot / formation hooks on a playthrough. Returns the captured snapshots. */
export function hookPlaythrough(p: Playthrough, hooks: Hooks = {}): BattleSnapshot[] {
  const g = p.game;
  const gx = g as unknown as Record<string, unknown>;
  const snaps: BattleSnapshot[] = [];
  let pending: FormationInfo | null = null;
  // FORMATION (op 23): note which records were free picks, optionally choose them ourselves
  const host = g.vm.host as unknown as { formation?: (s: unknown) => Promise<void> };
  const formation = host.formation?.bind(host);
  host.formation = async (st: unknown) => {
    const units = g.script.units;
    const info: FormationInfo = { records: [], fixed: [], hexFormation: (g.script.hexFlag & 1) !== 0 };
    units.slice(0, 0x2d).forEach((u, i) => {
      if (u.officer === 0xffff || u.flags & 1) return;
      if (u.officer >= 0x400) info.records.push(i);
      else if ((g.state.officers[u.officer]?.dyn.flags ?? 1) & 0x1f) return;
      else info.fixed.push(u.officer);
    });
    pending = info;
    const picks = hooks.onFormation?.(info, g);
    if (picks) {
      if (info.hexFormation) g.formation = [...info.fixed, ...picks];
      else info.records.forEach((r, k) => (units[r].officer = picks[k] ?? 0xffff));
      return;
    }
    await formation?.(st);
  };
  const prev = gx.battleModule as Promise<{ runBattle: RunBattle }>;
  gx.battleModule = Promise.resolve({
    runBattle: async (ctx: Parameters<RunBattle>[0], map: number) => {
      const real = (await prev).runBattle;
      const names = battleNameLines(g.assets.file('HEXZMAP.R3'));
      const snap: BattleSnapshot = {
        index: snaps.length,
        chapter: g.script.chapter,
        stage: g.script.stage,
        block: g.script.block,
        map,
        name: dec.decode(names[map] ?? new Uint8Array(0)).trim(),
        state: structuredClone(g.state),
        script: structuredClone(g.vm.state),
        rngSeed: g.rng.seed,
        formation: g.formation ? [...g.formation] : undefined,
        formationInfo: pending,
      };
      pending = null;
      snaps.push(snap);
      const r = hooks.onBattle ? await hooks.onBattle(snap, p, real) : await real(ctx, map);
      snap.after = g.state.officers.map((o) => ({ level: o.dyn.level, exp: o.dyn.exp }));
      return r;
    },
  });
  return snaps;
}

/**
 * Plays to the ending (restarting with a CHOOSE answer avoided after a story game over, as
 * playToEnd does) with the hooks installed on every run. Returns the last run and its snapshots.
 */
export async function playHooked(
  files: Map<string, Uint8Array>,
  opts: PlaythroughOptions,
  hooks: Hooks = {},
  maxRuns = 10,
): Promise<{ p: Playthrough; snaps: BattleSnapshot[] }> {
  const avoid = new Set(opts.avoidChoices ?? []);
  const menu = (c: string) => c.slice(0, c.lastIndexOf('='));
  let last: { len: number; menu: string; depth: number; avoided: string } | null = null;
  for (let run = 1; ; run++) {
    const p = new Playthrough(files, { ...opts, avoidChoices: avoid });
    const snaps = hookPlaythrough(p, hooks);
    const r = await p.run();
    const ch = p.choices;
    if (r !== 'gameOver' || !ch.length || run >= maxRuns) return { p, snaps };
    const lb = p.battles[p.battles.length - 1];
    if (lb?.outcome === 'lost' && p.game.script.chapter === lb.chapter && p.game.script.stage === lb.stage && p.game.script.block === lb.block) return { p, snaps };
    let depth = 1;
    if (last && last.len === ch.length && last.menu === menu(ch[ch.length - 1])) {
      depth = last.depth + 1;
      avoid.delete(last.avoided);
    }
    const blame: string | undefined = ch[ch.length - depth];
    if (!blame) return { p, snaps };
    opts.log?.(`RESTART: game over; avoiding CHOOSE ${blame} (run ${run + 1})`);
    avoid.add(blame);
    last = { len: ch.length, menu: menu(ch[ch.length - 1]), depth, avoided: blame };
  }
}

/** Baseline capture: force-won battles, snapshots only. */
export async function captureStory(files: Map<string, Uint8Array>, seed = 12345, log?: (l: string) => void) {
  const t0 = performance.now();
  const { p, snaps } = await playHooked(files, { seed, forceAll: true, log });
  return { result: p.result, snaps, ms: performance.now() - t0, issues: p.issues, battles: p.battles };
}
