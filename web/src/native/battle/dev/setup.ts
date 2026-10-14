// Dev harness support: finds the battles of a chapter in the scenario data and brings the script
// context to the moment the battle map is entered (BATTLE_SETUP / BATTLE_UNITS done, VM suspended
// right after the MAP 0x3nnn command), without a field engine. Not used by the game itself.

import type { Chapter, Command, Stage } from '../../../formats/scenario';
import type { ScriptVM } from '../../../engine/script';

export interface BattleEntry {
  chapter: number;
  stage: number;
  block: number;
  record: number;
  /** HEXZMAP map number (MAP operand & 0xfff). */
  map: number;
  /** Record that holds the BATTLE_SETUP used by this battle, if found before it. */
  setup: { block: number; record: number } | null;
}

/** Thrown by the harness host when the script switches to a battle map. */
export class BattleStart extends Error {
  constructor(readonly map: number) {
    super(`battle map ${map}`);
  }
}

const TERMINATORS = new Set(['END', 'GOTO_BLOCK', 'LEAVE_GROUP', 'NEXT_CHAPTER', 'GAME_OVER', 'ENDING']);

/** The commands of a record's code in order, up to its first terminator. */
export function recordCommands(stage: Stage, code: number, limit = 400): Command[] {
  const out: Command[] = [];
  let pc = code;
  for (let i = 0; i < limit; i++) {
    const c = stage.commands.get(pc);
    if (!c) break;
    out.push(c);
    if (TERMINATORS.has(c.name)) break;
    pc += c.size;
  }
  return out;
}

/** Every record of the chapter whose code enters a battle map (MAP with kind 3). */
export function listBattles(ch: Chapter): BattleEntry[] {
  const out: BattleEntry[] = [];
  ch.stages.forEach((stage, si) => {
    let lastSetup: { block: number; record: number } | null = null;
    stage.blocks.forEach((block, bi) => {
      block.records.forEach((r, ri) => {
        const cmds = recordCommands(stage, r.code);
        if (cmds.some((c) => c.name === 'BATTLE_SETUP')) lastSetup = { block: bi, record: ri };
        for (const c of cmds) {
          if (c.name === 'MAP' && c.map >> 12 === 3) out.push({ chapter: ch.index, stage: si, block: bi, record: ri, map: c.map & 0xfff, setup: lastSetup });
        }
      });
    });
  });
  return out;
}

function groupStartOf(stage: Stage, block: number, record: number): number {
  const b = stage.blocks[block];
  let start = 0;
  for (const g of b.groupStarts) if (g <= record) start = g;
  return start;
}

/** Runs one record's code to its end (or to a battle map). Returns the map if one was entered. */
async function runRecord(vm: ScriptVM, block: number, record: number): Promise<number | null> {
  const s = vm.state;
  const stage = vm.chapter.stages[s.stage];
  s.block = block;
  s.group = groupStartOf(stage, block, record);
  s.pc = stage.blocks[block].records[record].code;
  s.status = 1;
  try {
    await vm.run();
  } catch (e) {
    if (e instanceof BattleStart) {
      s.status = 1; // resume after the MAP command on the next dispatch
      return e.map;
    }
    throw e;
  }
  return null;
}

/**
 * Brings the VM to the start of `entry`'s battle: runs the BATTLE_SETUP record (if separate) and
 * the record with the MAP command. The host must throw BattleStart from setMap for kind 3 maps.
 */
export async function prepareBattle(vm: ScriptVM, entry: BattleEntry): Promise<number> {
  const s = vm.state;
  s.chapter = entry.chapter;
  s.stage = entry.stage;
  if (entry.setup && (entry.setup.block !== entry.block || entry.setup.record !== entry.record)) {
    const m = await runRecord(vm, entry.setup.block, entry.setup.record);
    if (m !== null) return m;
  }
  s.stage = entry.stage;
  const m = await runRecord(vm, entry.block, entry.record);
  if (m === null) throw new Error('battle record did not enter a battle map');
  return m;
}
