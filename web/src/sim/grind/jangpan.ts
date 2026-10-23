// Grinding simulator: the 장판파 2nd plan (GrindParams.jpPlan). 장판파 (ch2 stage 3 block 7) is two
// battles on one script block: the 1st (campaign battle 23, groups 0..3, 70 turns) walks the three
// 민중 to (32,22), the 2nd (battle 24, groups 4..7, BATTLE_SETUP r8, 99 turns) to (0,10). Each is won
// by 조조 falling, every enemy gone, or a 민중 (ours, moved by the computer: SET_AI 6, 무공격이동)
// arriving on its cell (r13..r15: +50 for everyone, LEAVE_GROUP to the ending); 유비 falling loses.
// The 2nd: our 12 start at (24..27, 13..20), east of the river (x 22..23, bridges (23,15..16) and
// (22,21..22)); the 민중 walk over the bridge, south round the mountain block (x 7..22, y 2..19) and up
// the west edge, and arrive at turn 12. The 28 enemies (L28..42) start on the east bank's north edge
// (y 0..3) under deployment orders: eight walk at 유비 (order 3, slot 0: 조인, 장요, 악진, 장합, three
// 기병대 and a 궁병대), nine at the 민중, six take the nearest, and 조조, 이전, 하후걸, 문빙 wait until
// r12 (any of ours in (17..19, 17..22), on the 민중's way) sends 조조 at 유비 and two more at the 민중.
// Twenty of them ride (move type 1: no wood). The general policy finished from turn 1 (the
// walk to 조조 past 27 enemies is longer than the 99 turns) or followed the party north to the fight
// at the bridge, and the hunters reached 유비 there or on the 민중's way west: 유비 fell at turns 6..12
// in 8 of 18 tries from two of the chain's carries (L28..29; 10/18 won).
// The plan: nobody finishes while a 민중 is on its way (its arrival wins long before any finish);
// the party walks into the south-east wood (x 29..35, y 13..23, no horseman enters it), 유비 to its
// far corner (35,23) and off the wood's edge, the others close round him; who stands in the wood stays
// in it. The 민중 end the battle on their own (the game's AI walks them; holding the exit cell for
// more turns (updatePark) still applies). When the hunters catch the 민중 (they turn on the nearest
// of ours once 유비 is out of reach) the plan ends and the general policy waits for 조조 to come to
// the wood and finishes on him. From the same carries: 13/19 won, 유비 never fell (the losses are
// time-ups), about three times the exp; five levels up, 16/18 (14/18 without).

import type { Unit } from '../../engine/battle/types';
import { AiMode, PLAYER_SLOTS, Status } from '../../engine/battle/types';

/** 장판파: chapter 2 stage 3 block 7 (both battles; the 2nd is told by the 민중's goal, JP.exit). */
export function isJangpanAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 2 && stage === 3 && block === 7;
}

/** Cells of the plan (map 26). */
export const JP = {
  /** the 2nd battle's arrival cell (r13..r15) */
  exit: [0, 10] as [number, number],
  /** 유비's cell: the far corner of the south-east wood (two neighbours, both wood) */
  corner: [35, 23] as [number, number],
  /** the others gather round this cell (wood) */
  wood: [33, 21] as [number, number],
  /** our horsemen (no wood) wait by its west edge */
  woodCav: [28, 21] as [number, number],
};

export interface JpState {
  /**
   * 'hold': a 민중 walks to the exit; 'off': none left walking (their hunters caught them), the
   * general policy (its finish on 조조). Keeping the wood past the 민중 lost more (the horsemen never
   * come into it: time-up), so the plan ends with them.
   */
  phase: 'hold' | 'off';
  since: number;
}

export function jpInit(turn: number): JpState {
  return { phase: 'hold', since: turn };
}

/** A unit of ours under the computer walking to the exit (a 민중 on its way). */
export function jpEscort(units: Unit[], controllable: (u: Unit) => boolean): boolean {
  return units.slice(0, PLAYER_SLOTS).some((u) => u.status === Status.Field && u.officer !== 0xffff && !controllable(u) && (u.mode === AiMode.MoveNoAttack || u.mode === AiMode.MoveTo) && u.tx === JP.exit[0] && u.ty === JP.exit[1]);
}

/** Moves the plan on: off once no 민중 is on its way. */
export function jpUpdate(st: JpState, turn: number, escort: boolean, log?: ((s: string) => void) | null): void {
  if (st.phase === 'hold' && !escort) {
    log?.(`jp: hold -> off at turn ${turn} (no 민중 on the way)`);
    st.phase = 'off';
    st.since = turn;
  }
}

/** The plan's anchor for a unit (null: none). */
export function jpAnchor(st: JpState, mt: number, guarded: boolean): [number, number] | null {
  if (st.phase === 'off') return null;
  if (guarded) return JP.corner;
  return mt === 1 ? JP.woodCav : JP.wood;
}

/** Pull per step to the anchor (beyond the formation's steps). */
export const JP_PULL = 8;

/**
 * Cells a unit may not step on now: who stands in the wood stays in it, and the leader keeps off
 * its edge (a wood cell next to open ground a horseman can stand on) once inside.
 */
export function jpBanned(st: JpState, wood: (x: number, y: number) => boolean, edge: (x: number, y: number) => boolean, from: [number, number], guarded: boolean, x: number, y: number): boolean {
  if (st.phase === 'off') return false;
  if (wood(from[0], from[1]) && !wood(x, y)) return true;
  return guarded && wood(x, y) && edge(x, y) && wood(from[0], from[1]) && !edge(from[0], from[1]);
}

/** No finish while the plan steers (a 민중 on its way wins first). */
export function jpHoldFinish(st: JpState): boolean {
  return st.phase !== 'off';
}
