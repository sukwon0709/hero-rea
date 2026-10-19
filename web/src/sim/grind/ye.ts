// Grinding simulator: the 업 sortie (GrindParams.yePick). 업1, 업2 and 업3 (ch4 stage 2 blocks 2..4,
// campaign battles 45..47) are fought by one sortie: 업1's FORMATION picks it, and 업2 and 업3 (hex
// flag, no FORMATION of their own) put the same list on their records in its order.
// 업2: 사마의 (the victory officer, L67, 부동) holds (14,5) in the north of the burning city; turn 28
// is a game over (r11, "업성이 불에 타 무너졌다"). r2's fires (MAP_EFFECT) cut the start into three
// pockets: list places 6, 9 and 12 stand with 유비 and 제갈량 in the middle one, whose only way out is
// the inner court (x 10..18, y 11..14: 악진 and 이전 wait in it) and its north gate (13..14,11),
// held by 장요 and a 보병대 (부동) with archers behind; places 2, 4, 7, 10, 13 go to the west pocket,
// 3, 5, 8, 11, 14 to the east one, each with a long way round past holders on its lane. The court
// and the gate are the short way to 사마의: from the chain's farming sortie (L41..48, the court's
// three L41..43) the court held to the time limit (0/8; +10 levels 2/8), with 마대, 마초 and 관우 in it
// 유비 was through the gate at turn 18 (+10 levels 5/8).
// 업3: 조조 wins it; the duels of 장비 / 허저, 관우 / 장요, 조운 / 이전 and 마초 / 악진 give exp.
// The sortie: the strongest go out (L-ordered, as for a door), 업3's duel actors first, and the three
// strongest close-combat officers on 업2's middle-pocket places.

import type { GameState } from '../../engine/state';
import { CLASS_RANGE } from '../../engine/battle/types';

/** 업1: chapter 4 stage 2 block 2 (its sortie fights 업2 and 업3 too). */
export function isYeFirstAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 4 && stage === 2 && block === 2;
}

/** 업3's block (its duel actors go out from 업1). */
export const YE_LAST_BLOCK = 4;

/** Places in the sortie list (after the two fixed, 유비 and 제갈량) that 업2 puts in 유비's pocket: list places 6, 9, 12. */
export const YE_MIDDLE = [4, 7, 10];

/** Close-combat officers for the court (no bows, no 군악대, no healers). */
function courtFit(cls: number): boolean {
  return CLASS_RANGE[cls] < 2 && cls !== 12 && cls !== 18;
}

/** Reorders the picks so the three strongest close-combat officers stand on 업2's middle-pocket places. */
export function yeOrder(state: GameState, picks: number[]): number[] {
  const lv = (i: number) => state.officers[i].dyn.level;
  const places = YE_MIDDLE.filter((k) => k < picks.length);
  const court = picks.filter((i) => courtFit(state.officers[i].dyn.cls)).sort((a, b) => lv(b) - lv(a) || a - b).slice(0, places.length);
  const rest = picks.filter((i) => !court.includes(i));
  const out: number[] = [];
  for (let k = 0; k < picks.length; k++) {
    const m = places.indexOf(k);
    out.push(m >= 0 && m < court.length ? court[m] : rest.shift()!);
  }
  return out;
}
