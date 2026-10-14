// Battle snapshots without a whole playthrough: a new game (or a shipped save) whose script is run
// to the n-th battle record of a chapter (battle dev harness, setup.ts). Used by the grind test
// and quick experiments; the whole-game run captures its snapshots from the real game instead.

import { buildContext, DevAssets } from '../../native/battle/dev/context';
import { listBattles, prepareBattle } from '../../native/battle/dev/setup';
import type { Ui } from '../../native/context';
import { headlessScreen, ScriptedInput } from '../../native/battle/dev/headless';
import type { BattleSnapshot } from './sandbox';
import { battleName } from './battle';

const noUi = {
  message: async () => {},
  confirm: async () => true,
  menu: async () => 0,
  caption: async () => {},
  setTitle: () => {},
  fadeOut: async () => {},
  fadeIn: async () => {},
  frame: async () => {},
  wait: async () => {},
} as Ui;

export async function scenarioSnapshot(files: Map<string, Uint8Array>, chapter: number, n: number, seed: number, slot = -1): Promise<BattleSnapshot> {
  const a = new DevAssets(files);
  const { ctx, host } = buildContext(a, slot, { screen: headlessScreen(), input: new ScriptedInput().asInput(), ui: noUi });
  host.headless = true;
  const entry = listBattles(a.chapter(chapter))[n];
  if (!entry) throw new Error(`no battle ${n} in chapter ${chapter}`);
  const map = await prepareBattle(ctx.vm, entry);
  return {
    index: 0,
    chapter,
    stage: entry.stage,
    block: ctx.vm.state.block,
    map,
    name: battleName(files, map),
    state: structuredClone(ctx.state),
    script: structuredClone(ctx.vm.state),
    rngSeed: seed >>> 0,
    formation: undefined,
    formationInfo: null,
  };
}
