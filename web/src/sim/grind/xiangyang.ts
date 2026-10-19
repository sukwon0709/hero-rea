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
// The wood plan ran out of time every try: r6's area stayed banned after its wave was down.
// The gate plan (GrindParams.yyGate, over the wood plan) breaks the gate from the south (its four
// holders do not move; the town's walkers come out to us one or two at a time), gathers the party
// on the gate and the street behind it (outside r6's area), springs r6 there and holds while the
// wave (no archers) comes up the two-wide gate, then sets out for 조인 at once, round 모개's corner
// by the west street. The disguised 관우 comes in at (6,17) on the wave's way and falls to it, so
// the battle is won on 조인 himself. The strongest go out (pickFormation with strong = free).

import type { Unit } from '../../engine/battle/types';
import { AiMode, PLAYER_SLOTS, Status } from '../../engine/battle/types';
import type { BattleKnowledge } from './policy';

/** 양양: chapter 4 stage 0 block 5. */
export function isXiangyangAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 4 && stage === 0 && block === 5;
}

export type YyPhase = 'form' | 'hold' | 'finish' | 'siege' | 'mouth';

/** The plan's state (plain data: the search's saves copy the policy's fields). */
export interface YyState {
  phase: YyPhase;
  /** turn the phase began */
  since: number;
  /** the gate plan (yyGate) instead of the wood plan */
  gate?: boolean;
  /** gate plan: the gate and the cells behind it are clear of enemies (the party gathers there) */
  open?: boolean;
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
  /** gate plan: the mouth behind the gate the party holds while the wave comes up the gate */
  mouth: [11, 13] as [number, number],
  /** gate plan: latest turn the scout springs r6, and latest turn of the hold at the mouth */
  springBy: 16,
  strikeBy: 25,
  /**
   * gate plan, the finish: holders walked round, not through (모개 at (14,9) and the archer at
   * (15,8) by the one-cell way north at (14,8): the finish stood against 모개, who mends every
   * turn, for 15 turns; the west street is clear by then and leads round to (16,6))
   */
  walkRound: [
    [14, 9],
    [15, 8],
  ] as [number, number][],
};

/**
 * Gate plan: the cells the party holds once r6 is sprung, the gate (x 10..11, y 14..15, its
 * southern row y 16 left to the wave) and the street behind it (x 9..12, y 13..14),
 * all outside r6's area (4..14 x 7..12). The wave has no archers: a unit on the gate is reached
 * from one cell only (the one south of it), and the town's holders do not move.
 */
export function yyPocket(x: number, y: number): boolean {
  if (y === 13) return x >= 9 && x <= 12;
  if (y === 14) return x >= 9 && x <= 12;
  if (y === 15) return x === 10 || x === 11;
  return false;
}
/** The gate's corridor and the street behind it (an enemy there: the gate is not ours yet). */
function gateCell(x: number, y: number): boolean {
  return yyPocket(x, y) || (y === 16 && (x === 10 || x === 11));
}

export function yyInit(gate = false): YyState {
  return gate ? { phase: 'siege', since: 1, gate: true, open: false } : { phase: 'form', since: 1 };
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
  if (st.gate) {
    st.open = gateOpen(c);
    for (let guard = 0; guard < 3; guard++) {
      if (st.phase === 'siege') {
        if (c.waveLeft(YY.r6) > 0) set('mouth', 'r6 sprung');
        else if (c.turn > YY.strikeBy) set('finish', 'late');
        else return;
      } else if (st.phase === 'mouth') {
        if (c.waveLeft(YY.r6) <= 1) set('finish', 'wave spent');
        else if (c.turn >= YY.strikeBy) set('finish', 'late');
        else return;
      } else return;
    }
    return;
  }
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

/** Gate plan: no enemy on the gate or the street behind it, and none on the move near the mouth. */
function gateOpen(c: YyCtx): boolean {
  const [mx, my] = YY.mouth;
  for (const e of c.units.slice(PLAYER_SLOTS)) {
    if (e.status !== Status.Field || e.officer === 0xffff) continue;
    if (gateCell(e.x, e.y)) return false;
    if ((e.mode === AiMode.MoveTo || e.mode === AiMode.AttackNearest) && Math.abs(e.x - mx) + Math.abs(e.y - my) <= 8) return false;
  }
  return true;
}

/** Whether our scout springs r6 now (the allies may spring it before). */
export function yySpring(st: YyState, c: YyCtx, record: number): boolean {
  if (st.gate) {
    if (record !== YY.r6 || st.phase !== 'siege') return false;
    if (c.turn >= YY.springBy) return true;
    if (!st.open) return false;
    // the party gathered behind the gate (all but one of ours on the street or the gate)
    const mine = c.units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && c.controllable(u));
    const inside = mine.filter((u) => yyPocket(u.x, u.y)).length;
    return mine.length > 0 && inside >= Math.min(6, mine.length - 1);
  }
  if (record !== YY.r6 || st.phase !== 'form') return false;
  const allies = c.units.slice(0, PLAYER_SLOTS).some((u) => u.status === Status.Field && u.officer < 0x400 && !c.controllable(u));
  return c.turn >= YY.woodSpring || !allies;
}

/** The plan's anchor for a unit of move type mt (null: none, the general policy walks). */
export function yyAnchor(st: YyState, mt: number): [number, number] | null {
  if (st.phase === 'finish') return null;
  if (st.gate) return st.phase === 'mouth' || st.open ? YY.mouth : null;
  return mt === 1 ? YY.woodCav : YY.wood;
}

/** Pull per step to the anchor (beyond the formation's two steps). */
export function yyPull(st: YyState): number {
  return st.phase === 'hold' || st.phase === 'mouth' ? 8 : 4;
}

/**
 * Cells a unit may not step on now (hold): who stands in the wood stays in it, and the leader
 * keeps off its edge (a wood cell next to open ground a horseman can stand on).
 */
export function yyBanned(st: YyState, wood: (x: number, y: number) => boolean, edge: (x: number, y: number) => boolean, from: [number, number], guarded: boolean, x: number, y: number): boolean {
  // gate plan, the wave coming up the gate: who stands behind it or on it stays there
  if (st.phase === 'mouth') return yyPocket(from[0], from[1]) && !yyPocket(x, y);
  if (st.phase !== 'hold') return false;
  if (wood(from[0], from[1]) && !wood(x, y)) return true;
  return guarded && wood(x, y) && edge(x, y) && !edge(from[0], from[1]) && wood(from[0], from[1]);
}

/** Gate plan, the finish: the cells next to the walked-round holders still standing (no walk enters them). */
export function yyBan(st: YyState, units: Unit[], W: number, H: number, memo: { sig: string; cells: Uint8Array } | null): { sig: string; cells: Uint8Array } | null {
  if (!st.gate || st.phase !== 'finish') return null;
  const held = YY.walkRound.filter(([x, y]) => units.some((e) => e.slot >= PLAYER_SLOTS && e.status === Status.Field && e.officer !== 0xffff && e.x === x && e.y === y));
  if (!held.length) return null;
  const sig = `yy-${held.map((c) => c.join(',')).join(';')}`;
  if (memo?.sig === sig) return memo;
  const cells = new Uint8Array(W * H);
  for (const [x, y] of held)
    for (const [nx, ny] of [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ])
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) cells[ny * W + nx] = 1;
  return { sig, cells };
}

/** No finish before the wave is spent (the finish would walk the party off with the horsemen behind). */
export function yyHoldFinish(st: YyState): boolean {
  return st.phase !== 'finish';
}
