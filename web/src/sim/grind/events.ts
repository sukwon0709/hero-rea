// Grinding simulator, part 10: the battle scripts' gains. Every record of a battle's event block
// whose code gives something the grind cares about:
//   - a victory bonus (DATA 4 w: battle state +0x24 = w, 2cb4:0b72). At 4a30, when the battle is
//     won, every player unit on the field gets w exp, 유비 included (he is always deployed). The
//     value is set, not added: one bonus per battle;
//   - levels (ADD_STAT o b: officer level += b, capped at 99): duels (DUEL, ops 33..35, then the
//     acting officer +1 and the enemy REMOVEd), persuasions (유비 next to an enemy: UNIT_FORCE to our
//     side and 유비 +1), and the like;
//   - recruits (UNIT_FORCE / SET_FORCE to force 0).
// The trigger says what has to happen: 4 = officer p1 (0x400: any of ours) acts next to p2 (8ad2),
// 6 = p1 stands on (x, y) = p2, 11 = p1 inside the rectangle p2..p3, 12 = officer p1 defeated,
// 7 = every enemy defeated, 9 = turn p1 (automatic). Setup records (trigger 0/1) are story: they
// happen whatever the player does and are listed as such.

import type { Stage } from '../../formats/scenario';
import { recordCommands } from '../../native/battle/dev/setup';
import { ScriptVM } from '../../engine/script';

/**
 * Byte order of the cells in trigger 6/11 records, as the engine's matcher reads them (probed, so
 * the planner follows the engine: the original stores x in the high byte, the engine read x from
 * the low byte until that was fixed).
 */
let cellXHigh: boolean | null = null;
export function eventCellXHigh(): boolean {
  if (cellXHigh === null) {
    const m = (ScriptVM.prototype as unknown as { matches(r: unknown, t: unknown): boolean }).matches;
    try {
      cellXHigh = !m.call({}, { trigger: 6, p1: 0, p2: (2 << 8) | 1 }, { type: 'unitAt', officer: 0, x: 1, y: 2 });
    } catch {
      cellXHigh = true;
    }
  }
  return cellXHigh;
}
/** A trigger 6/11 cell parameter as [x, y]. */
export function cellOf(p: number): [number, number] {
  return eventCellXHigh() ? [p >> 8, p & 0xff] : [p & 0xff, p >> 8];
}

export type GainKind = 'bonus' | 'duel' | 'persuade' | 'level' | 'recruit';

export interface ScriptGain {
  /** Record index in the block (matches the 10 bytes the VM copies when it runs it). */
  record: number;
  trigger: number;
  kind: GainKind;
  /** Trigger 4: the acting officer (0x400 = any player unit); 6/11: who must stand there; 12: the officer to defeat. */
  actor: number;
  /** Trigger 4: the enemy to stand next to. */
  other: number | null;
  /** Trigger 6/11: the cells. */
  cell: { x0: number; y0: number; x1: number; y1: number } | null;
  turn: number | null;
  /** Victory bonus exp (DATA 4). */
  bonus: number;
  /** ADD_STAT: officer -> levels. */
  levels: { officer: number; value: number }[];
  /** Officers that join our side. */
  recruits: number[];
  /** The record also ends the battle (BATTLE_END): it is a way to win. */
  ends: boolean;
  /** The gain sits behind an IF that needs flags set by other events (e.g. all four cells visited). */
  needsFlags: number[];
  /** Story: fires by itself (setup, turn events). */
  automatic: boolean;
}

/** Record bytes as the VM copies them (ScriptState.record). */
export function recordBytes(stage: Stage, block: number, index: number): Uint8Array {
  const off = stage.blocks[block].offset + index * 10;
  return stage.data.subarray(off, off + 10);
}

/** Which record of the block the VM ran, from the 10 bytes it copied (null if none matches). */
export function recordIndexOf(stage: Stage, block: number, bytes: Uint8Array): number | null {
  const recs = stage.blocks[block]?.records ?? [];
  for (const r of recs) {
    const b = recordBytes(stage, block, r.index);
    let same = true;
    for (let i = 0; i < 10 && same; i++) same = b[i] === bytes[i];
    if (same) return r.index;
  }
  return null;
}

export function scriptGains(stage: Stage, block: number): ScriptGain[] {
  const out: ScriptGain[] = [];
  for (const r of stage.blocks[block]?.records ?? []) {
    const cmds = recordCommands(stage, r.code);
    let bonus = 0;
    const levels: { officer: number; value: number }[] = [];
    const recruits: number[] = [];
    let duel = false;
    let needsFlags: number[] = [];
    let gated = false;
    let ends = false;
    for (const c of cmds) {
      const a = c as unknown as Record<string, number> & { set?: number[] };
      if (c.name === 'IF' && a.set && a.set.length) {
        gated = true;
        needsFlags = [...a.set];
      }
      if (c.name === 'DATA' && a.kind === 4) bonus = a.value;
      else if (c.name === 'ADD_STAT') levels.push({ officer: a.officer, value: a.value });
      else if ((c.name === 'UNIT_FORCE' || c.name === 'SET_FORCE') && a.force === 0 && a.officer !== 0) recruits.push(a.officer);
      else if (c.name === 'DUEL') duel = true;
      else if (c.name === 'BATTLE_END') ends = true;
    }
    if (!bonus && !levels.length && !recruits.length) continue;
    // a battle-start record that only levels up officers for the story
    const automatic = r.trigger === 0 || r.trigger === 1 || r.trigger === 9 || r.trigger === 8;
    const kind: GainKind = bonus && !levels.length && !recruits.length ? 'bonus' : duel ? 'duel' : r.trigger === 4 && recruits.length ? 'persuade' : levels.length ? 'level' : recruits.length ? 'recruit' : 'bonus';
    let cell: ScriptGain['cell'] = null;
    const [ax, ay] = cellOf(r.p2), [bx, by] = cellOf(r.p3);
    if (r.trigger === 6) cell = { x0: ax, y0: ay, x1: ax, y1: ay };
    if (r.trigger === 11) cell = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    out.push({
      record: r.index,
      trigger: r.trigger,
      kind,
      actor: r.p1,
      other: r.trigger === 4 ? r.p2 : null,
      cell,
      turn: r.trigger === 9 ? r.p1 : null,
      bonus,
      levels,
      recruits,
      ends,
      needsFlags: gated ? needsFlags : [],
      automatic,
    });
  }
  return out;
}

/** Korean one-line description of what triggers a gain and what it gives (names from `name`). */
export function describeGain(g: ScriptGain, name: (o: number) => string): { when: string; gives: string } {
  const who = (o: number) => (o === 0x400 ? '아군 누구든' : name(o));
  let when: string;
  switch (g.trigger) {
    case 4:
      when = `${who(g.actor)}이(가) ${name(g.other ?? 0)} 옆에서 행동`;
      break;
    case 6:
      when = `${who(g.actor)}이(가) (${g.cell!.x0},${g.cell!.y0}) 도착`;
      break;
    case 11:
      when = `${who(g.actor)}이(가) (${g.cell!.x0},${g.cell!.y0})~(${g.cell!.x1},${g.cell!.y1}) 진입`;
      break;
    case 12:
      when = `${name(g.actor)} 격파`;
      break;
    case 7:
      when = '적 전멸';
      break;
    case 9:
      when = `${g.turn}턴 (자동)`;
      break;
    default:
      when = '전투 시작 (자동)';
  }
  if (g.needsFlags.length) when += ' + 다른 조건 모두 달성';
  if (g.ends) when += ' → 승리';
  const parts: string[] = [];
  if (g.kind === 'duel') parts.push('일기토');
  if (g.kind === 'persuade') parts.push('설득');
  if (g.bonus) parts.push(`전원 경험치 +${g.bonus}`);
  for (const l of g.levels) parts.push(`${name(l.officer)} Lv+${l.value}`);
  for (const r of g.recruits) parts.push(`${name(r)} 합류`);
  return { when, gives: parts.join(', ') };
}

/** What a battle's turn events (trigger 9) and defeat events (trigger 12 + GAME_OVER) do: the ways a battle ends or turns before the limit. */
export interface TurnEvent {
  record: number;
  /** 1-based turn (trigger 9), or null for a defeat event. */
  turn: number | null;
  /** Trigger 12: whose defeat it is. */
  officer: number | null;
  gameOver: boolean;
  win: boolean;
  /** Units brought onto the field (side resolved by the policy at run time). */
  reinforce: number[];
  /** Officers taken off the field. */
  removes: number[];
}

export function turnEvents(stage: Stage, block: number): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (const r of stage.blocks[block]?.records ?? []) {
    if (r.trigger !== 9 && r.trigger !== 12) continue;
    const cmds = recordCommands(stage, r.code);
    const i = cmds.findIndex((c) => c.name === 'BATTLE_END');
    const gameOver = cmds.some((c) => c.name === 'GAME_OVER');
    const e: TurnEvent = {
      record: r.index,
      turn: r.trigger === 9 ? r.p1 : null,
      officer: r.trigger === 12 ? r.p1 : null,
      gameOver,
      win: i >= 0 && !gameOver,
      reinforce: cmds.filter((c) => c.name === 'REINFORCE').map((c) => (c as unknown as { officer: number }).officer),
      removes: cmds.filter((c) => c.name === 'REMOVE').map((c) => (c as unknown as { officer: number }).officer),
    };
    if (r.trigger === 12 && !gameOver) continue;
    if (e.gameOver || e.win || e.reinforce.length || e.removes.length) out.push(e);
  }
  return out;
}
