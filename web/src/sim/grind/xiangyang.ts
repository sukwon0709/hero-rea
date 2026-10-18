// Grinding simulator: the 양양 plan (GrindParams.yyPlan). 양양 (ch4 stage 0 block 5, campaign
// battle 39): 조인 (the victory officer, L55) holds the north-east of a walled town (18,4); our
// eight and 육손's five (allies under the computer) start south of the wall, whose one gate is a
// corridor two cells wide (x 10..11, y 14..16). 21 enemies (L46..55) hold the town and its gate;
// 조인's pocket (18..20 x 3..6) opens only through (17,6), where one of them holds.
// r6, any unit of ours inside the walls (4..14, 7..12), brings 만총 (L51), 우금 (L50) and five
// horsemen in on the plain east of our start (17..23, 17..19), and 관우 in disguise at (1,16) when
// he got away at 맥 (flag 58), who walks on 조인 without attacking (SET_AI 5: 무공격이동) and wins
// the battle with a duel next to him; he finds no way while the gate's and the pocket's holders
// stand, so the duel comes only after the town is mostly taken. The allies storm the gate and
// walk into the area sooner or later.
// The wave comes in with AI mode 0 (이동) after slot 0, 유비: it walks wherever he is, and the
// horsemen, where they cannot reach him, fall on whoever is nearest.
// The general policy did not know r6 for an ambush (its record moves on with LEAVE_GROUP) and was
// caught on the open plain by the horsemen when an ally sprang it (T5..T13): 0/8, 유비 down.
// The plan keeps the general policy's micro and look-ahead search, and gives it per phase an
// anchor, banned cells and the ambush timing: the party walks into the wood south of the
// horsemen's entry (16..23 x 20..23: cavalry cannot enter it) and our scout may spring r6 from
// woodSpring on (the allies, left alone at the gate, die or spring it before); in the hold who is
// in the wood stays in it and 유비 keeps off its edge, so the horsemen reach only the edge cells;
// the finish waits until the wave is spent (or holdBy), then takes 조인.

import type { Unit } from '../../engine/battle/types';
import { PLAYER_SLOTS, Status } from '../../engine/battle/types';
import type { BattleKnowledge } from './policy';

/** 양양: chapter 4 stage 0 block 5. */
export function isXiangyangAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 4 && stage === 0 && block === 5;
}

export type YyPhase = 'form' | 'hold' | 'finish';

/** The plan's state (plain data: the search's saves copy the policy's fields). */
export interface YyState {
  phase: YyPhase;
  /** turn the phase began */
  since: number;
}

/** Cells and turns of the plan. */
export const YY = {
  /** the wood's middle, and our cavalry by its west edge */
  wood: [20, 22] as [number, number],
  woodCav: [16, 22] as [number, number],
  /** the ambush's record */
  r6: 6,
  /** earliest turn our scout springs r6 */
  woodSpring: 3,
  /** latest turn of the hold: the finish sets out */
  holdBy: 26,
};

export function yyInit(): YyState {
  return { phase: 'form', since: 1 };
}

export interface YyCtx {
  turn: number;
  units: Unit[];
  know: BattleKnowledge;
  /** officers of the ambush on the field (it fired when above 0) */
  waveLeft(record: number): number;
  controllable(u: Unit): boolean;
  log?: ((s: string) => void) | null;
}

/** Moves the plan on (each player phase, before the ambush and finish decisions). */
export function yyUpdate(st: YyState, c: YyCtx): void {
  const set = (p: YyPhase, why: string) => {
    c.log?.(`yy: ${st.phase} -> ${p} at turn ${c.turn} (${why})`);
    st.phase = p;
    st.since = c.turn;
  };
  for (let guard = 0; guard < 3; guard++) {
    if (st.phase === 'form') {
      if (c.waveLeft(YY.r6) > 0) set('hold', 'r6 sprung');
      else if (c.turn > YY.holdBy) set('finish', 'late');
      else return;
    } else if (st.phase === 'hold') {
      if (c.waveLeft(YY.r6) <= 1) set('finish', 'wave spent');
      else if (c.turn >= YY.holdBy) set('finish', 'late');
      else return;
    } else return;
  }
}

/** Whether our scout springs r6 now (the allies may spring it before). */
export function yySpring(st: YyState, c: YyCtx, record: number): boolean {
  if (record !== YY.r6 || st.phase !== 'form') return false;
  const allies = c.units.slice(0, PLAYER_SLOTS).some((u) => u.status === Status.Field && u.officer < 0x400 && !c.controllable(u));
  return c.turn >= YY.woodSpring || !allies;
}

/** The plan's anchor for a unit of move type mt (null: none, the general policy walks). */
export function yyAnchor(st: YyState, mt: number): [number, number] | null {
  if (st.phase === 'finish') return null;
  return mt === 1 ? YY.woodCav : YY.wood;
}

/** Pull per step to the anchor (beyond the formation's two steps). */
export function yyPull(st: YyState): number {
  return st.phase === 'hold' ? 8 : 4;
}

/**
 * Cells a unit may not step on now (hold): who stands in the wood stays in it, and the leader
 * keeps off its edge (a wood cell next to open ground a horseman can stand on).
 */
export function yyBanned(st: YyState, wood: (x: number, y: number) => boolean, edge: (x: number, y: number) => boolean, from: [number, number], guarded: boolean, x: number, y: number): boolean {
  if (st.phase !== 'hold') return false;
  if (wood(from[0], from[1]) && !wood(x, y)) return true;
  return guarded && wood(x, y) && edge(x, y) && !edge(from[0], from[1]) && wood(from[0], from[1]);
}

/** No finish before the wave is spent (the finish would walk the party off with the horsemen behind). */
export function yyHoldFinish(st: YyState): boolean {
  return st.phase !== 'finish';
}
