// Grinding simulator: the 양평관 plan (GrindParams.ypPlan). 양평관 (ch3 stage 3 block 14, campaign
// battle 37): our 14 start in the east (x 31..35), 조조 (the victory officer, L58) holds his camp in
// the north-west (2,3) and the river between has one crossing, the bridge at (15,13). 27 enemies
// (avg L49) wait where they stand (AI mode 3) behind two wake ambushes:
//   r4: any of ours in (20..25, 6..15), the one way west, sends 장합, 조창, 방덕 and six more (four
//       of them cavalry) at us, and nine others walk to fixed cells by the bridge's west end;
//   r5: any of ours in (3..8, 6..11), the way into the camp, sends 허저, 사마의 and five more.
// The general policy sprang r4 on the open plain and lost half the party to it, then crossed the
// bridge a few units at a time into the nine guards and ran out of time (0/8; +10 levels: 0/9).
// The plan keeps the general policy's micro and look-ahead search, and gives it per phase an
// anchor (the formation's centre, per move type), banned cells and the ambush timing:
//   form    r4 waits until the party stands in the forest west of the start (x 25..29: enemy
//           cavalry cannot enter it; our cavalry waits east of it); no flat-rate casts (MP is kept
//           for the fights: the healers had none left when r4 came);
//   r4      a foot unit steps into x 25 and r4 is fought in the forest;
//   bridge  once our bank is clear, the party gathers east of the bridge (20,13) and shoots across
//           the river: the guards come over one at a time (they wake on a foe in reach); the
//           bridge and the west bank stay banned, so nobody crosses into them alone;
//   cross   the bridgehead clear (or stalled), the party crosses and forms up at the west end
//           (12,13), farming the guards left; r5 stays banned (GrindParams.ambush) until the party
//           stands formed and in shape there;
//   hold5   r5 sprung, the party goes back over the bridge (18,13) and the sturdiest unit in shape
//           plugs its east end (16,13), the one cell the wave crosses by: one melee unit at a time
//           reaches it (from the bridge), the rest of the party hits what stands on the bridge;
//   finish  the wave spent, the general policy's finish takes 조조 last.
// Each phase has a latest turn, so the plan always leaves the camp its turns (the march from the
// bridge to 조조 and the last kills take ~12 turns: a later finish ran out of turns with 9 alive).
// Measured (8 seeds): the GA carries J-c31515 / J-c30310c (L32..49) lose either way (0/8 off and
// on: r4 and the bridge go well, r5's wave of L53..58 officers wipes the party); +10 levels win 2/8.
// Lure plan (GrindParams.ypLure, on by default): in the cross phase the three guards waiting by r5's
// area (L54..55, outside the camp: they woke with r5 and joined its wave) are lured out first: the
// party stands at (10,11), where they reach it with nobody stepping into r5's area, and kills them as
// they come. Then r5 (by turn 34 at the latest), its scout pulled in whatever the danger (it held two
// steps short for up to fourteen turns), and the wave is fought on the west bank, the finish right
// after (no hold5). The old order (r5 at turn 25 with the three still there, back over the bridge,
// the wave held on it) lost on time: the wave's front stood on the bridge, out of reach of all but
// three of ours and healed every turn by the wave's healer, for ten turns (gen-433 carries, L35..54,
// 16 seeds each: 6/32 won; with the lure 16/32).

import type { Unit } from '../../engine/battle/types';
import { CLASS_MOVE_TYPE, PLAYER_SLOTS, Status, AiMode } from '../../engine/battle/types';
import type { BattleKnowledge } from './policy';

/** 양평관: chapter 3 stage 3 block 14. */
export function isYangpyeongAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 3 && stage === 3 && block === 14;
}

export type YpPhase = 'form' | 'r4' | 'bridge' | 'cross' | 'hold5' | 'finish';

/** The plan's state (plain data: the search's saves copy the policy's fields). */
export interface YpState {
  phase: YpPhase;
  /** turn the phase began */
  since: number;
  /** turn the party first stood formed in this phase */
  formedAt?: number;
  /** the lure plan (GrindParams.ypLure) */
  lurePlan?: boolean;
  /** lure plan, cross phase: the west bank's guards outside the camp still stand (the party lures them out) */
  lure?: boolean;
}

/** Cells and turns of the plan. */
export const YP = {
  /** r4 is fought around this forest cell (non-cavalry) ... */
  forest: [28, 12] as [number, number],
  /** ... and our cavalry waits east of it */
  forestCav: [31, 12] as [number, number],
  /** east of the bridge: the party shoots across from here */
  bridge: [20, 13] as [number, number],
  /** the west end: formed here before r5 */
  west: [12, 13] as [number, number],
  /** lure plan: the guards waiting by r5's area reach the party here (outside the area) */
  lure: [10, 11] as [number, number],
  /** in the forest east of the bridge: r5's wave is fought here (its cavalry stops at the edge) */
  hold: [18, 13] as [number, number],
  /** the bridge's east end: plugged by the sturdiest while r5's wave comes */
  plug: [16, 13] as [number, number],
  /** the wake ambushes' records */
  r4: 4,
  r5: 5,
  /** latest turns: r4 sprung, the crossing begun, r5 sprung, the finish */
  r4By: 6,
  crossBy: 24,
  r5By: 25,
  finishBy: 32,
  /** lure plan: r5 sprung by then whatever stands */
  r5ByLure: 34,
};

/** The west bank and the bridge (x <= 15): banned until the crossing. */
export function ypWestBank(x: number, _y: number): boolean {
  return x <= 15;
}

export function ypInit(lurePlan = false): YpState {
  return lurePlan ? { phase: 'form', since: 1, lurePlan } : { phase: 'form', since: 1 };
}

export interface YpCtx {
  turn: number;
  units: Unit[];
  know: BattleKnowledge;
  /** the ambush's flag is set (it fired) */
  fired(record: number): boolean;
  controllable(u: Unit): boolean;
  /** officer's class */
  cls(u: Unit): number;
  hpShare(u: Unit): number;
  /** phases in a row without a fight */
  fightIdle: number;
  log?: ((s: string) => void) | null;
}

function ours(c: YpCtx): Unit[] {
  return c.units.slice(0, PLAYER_SLOTS).filter((u) => c.controllable(u));
}
function foes(c: YpCtx): Unit[] {
  return c.units.slice(PLAYER_SLOTS).filter((e) => e.status === Status.Field && e.officer !== 0xffff);
}
const awake = (e: Unit) => e.mode !== AiMode.Wait && e.mode !== AiMode.Hold;
const man = (a: [number, number], x: number, y: number) => Math.abs(a[0] - x) + Math.abs(a[1] - y);

/** Share of our units within r steps (manhattan) of their anchor. */
function formed(st: YpState, c: YpCtx, r: number): number {
  const us = ours(c);
  if (!us.length) return 0;
  let n = 0;
  for (const u of us) {
    const a = ypAnchor(st, u, CLASS_MOVE_TYPE[c.cls(u)]);
    if (!a || man(a, u.x, u.y) <= r) n++;
  }
  return n / us.length;
}

/** The west bank's guards outside the camp (not r5's, not the victory officer): 서황 by r5's area joined the wave at the bridge. */
function westGuards(c: YpCtx): Unit[] {
  const r5 = c.know.ambushes.find((z) => z.record === YP.r5)?.officers ?? [];
  return foes(c).filter((e) => ypWestBank(e.x, e.y) && (e.y >= 7 || e.x >= 8) && !r5.includes(e.officer) && e.officer !== c.know.victory);
}

/** Average troops share of our controllable units. */
function fitShare(c: YpCtx): number {
  const us = ours(c);
  return us.length ? us.reduce((a, u) => a + c.hpShare(u), 0) / us.length : 0;
}

/** Moves the plan on (each player phase, before the ambush and finish decisions). */
export function ypUpdate(st: YpState, c: YpCtx): void {
  const set = (p: YpPhase, why: string) => {
    c.log?.(`yp: ${st.phase} -> ${p} at turn ${c.turn} (${why})`);
    st.phase = p;
    st.since = c.turn;
    st.formedAt = undefined;
  };
  for (let guard = 0; guard < 6; guard++) {
    const fs = foes(c);
    const east = fs.filter((e) => !ypWestBank(e.x, e.y));
    if (st.phase === 'form') {
      if (c.fired(YP.r4)) set('r4', 'r4 sprung');
      else return;
    } else if (st.phase === 'r4') {
      // our bank clear of enemies (the west bank's guards wait across the river)
      if (!east.length) set('bridge', 'our bank clear');
      else if (c.turn >= YP.crossBy - 2) set('bridge', 'late');
      else return;
    } else if (st.phase === 'bridge') {
      // the bridgehead (the west bank's cells next to the bridge) clear, or nothing more comes over
      const head = fs.filter((e) => ypWestBank(e.x, e.y) && e.x >= 10 && e.y >= 10);
      const ready = formed(st, c, 4) >= 0.7;
      if (ready && st.formedAt === undefined) st.formedAt = c.turn;
      if (!head.length && !east.length && ready) set('cross', 'bridgehead clear');
      else if (c.turn >= YP.crossBy) set('cross', 'late');
      else return;
    } else if (st.phase === 'cross') {
      // (lure plan: r5's wave is fought on the west bank, no going back over the bridge)
      if (st.lurePlan) st.lure = westGuards(c).length > 0;
      if (c.fired(YP.r5)) set(st.lurePlan ? 'finish' : 'hold5', 'r5 sprung');
      else return;
    } else if (st.phase === 'hold5') {
      // the wave spent: nothing awake left but what holds by 조조
      if (fs.filter((e) => awake(e) && e.officer !== c.know.victory).length <= 1) set('finish', 'r5 spent');
      else if (c.turn >= YP.finishBy) set('finish', 'late');
      else return;
    } else return;
  }
}

/** The plan's banned cells now (the bridge and the west bank until the crossing). */
export function ypBan(st: YpState, W: number, H: number, memo: { sig: string; cells: Uint8Array } | null): { sig: string; cells: Uint8Array } | null {
  if (st.phase !== 'form' && st.phase !== 'r4' && st.phase !== 'bridge') return null;
  const sig = 'yp-west';
  if (memo?.sig === sig) return memo;
  const cells = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ypWestBank(x, y)) cells[y * W + x] = 1;
  return { sig, cells };
}

/** The formation's centre for a unit of move type mt (null: none, the general policy walks). */
export function ypAnchor(st: YpState, _u: Unit, mt: number): [number, number] | null {
  switch (st.phase) {
    case 'form':
    case 'r4':
      return mt === 1 ? YP.forestCav : YP.forest;
    case 'bridge':
      return YP.bridge;
    case 'cross':
      return st.lure ? YP.lure : YP.west;
    case 'hold5':
      return YP.hold;
    default:
      return null;
  }
}

/** Pull per step to the anchor (beyond the formation's two steps). */
export function ypPull(st: YpState): number {
  return st.phase === 'hold5' ? 8 : 4;
}

/**
 * Whether to spring the open wake ambush `record` now: r4 once the party stands formed in the
 * forest (or at r4By), r5 once it stands formed at the bridge's west end in shape (or at r5By).
 */
export function ypSpring(st: YpState, c: YpCtx, record: number): boolean {
  if (record === YP.r4) {
    if (st.phase !== 'form') return true;
    return c.turn >= YP.r4By || (c.turn >= 2 && formed(st, c, 3) >= 0.7);
  }
  if (record === YP.r5) {
    if (st.phase !== 'cross') return false;
    // lure plan: the guards by r5's area lured out and killed first (they joined the wave), then r5
    if (st.lurePlan) return c.turn >= YP.r5ByLure || (!westGuards(c).length && !foes(c).some(awake) && fitShare(c) >= 0.6 && formed(st, c, 4) >= 0.6);
    if (c.turn >= YP.r5By) return true;
    // (the west bank's guards outside the camp first: 서황 by r5's area joined the wave at the bridge)
    return c.turn - st.since >= 1 && fitShare(c) >= 0.7 && !westGuards(c).length && !foes(c).some(awake) && formed(st, c, 4) >= 0.6;
  }
  return false;
}

/** No finish before the camp's turn (the finish would walk the party over the bridge one by one). */
export function ypHoldFinish(st: YpState): boolean {
  return st.phase !== 'finish';
}
