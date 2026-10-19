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
// 업3: 조조 (L77, 부동) at (19,1) wins it, behind 사마사, 사마의 and 사마소 (부동) on the castle's one
// opening (18..20,3); the duels of 장비 / 허저, 관우 / 장요, 조운 / 이전 and 마초 / 악진 give exp. The start
// (y 20..23) is walled in (rows 18..19) and split by a wall at x 18..20: list places 4, 7, 9, 10 stand
// east with 유비 and 제갈량, the others west. MAP_EFFECT fires spread every two turns from turn 4: the
// west gate (3,18..19) and the cells north of it burn at turn 8, and at turn 34 (25,5..6) and (30,5)
// burn, after which no walk reaches the castle (r7..r20; a unit standing on a cell keeps it from
// burning). The east way: the east gate (34..35,18..19), held by four 부동 (가후, a 궁병대, two 기병대;
// one of the two in front has to fall), north to the corridor (31,10..11), whose one way out is
// 허저's cell (31,9) (장비's duel takes him off), then round by (34,8) and west along rows 5..6:
// 59 steps from 유비. The general finish started at turn 39 (finish 9 + its walk estimate) with the
// castle long shut, and its pull was capped at 40 steps anyway: the party stood at the start for 50
// turns, 0/15 on time, at any level (+10: 0/4).
// The race (GrindParams.ye3Plan): the finish sets out at turn 1, everyone pulled to 조조 the whole
// way, 유비 too; 업1's sortie puts 장비 and the highest levels of 업2's west pocket on 업3's east places
// (업2 sees the same pockets). The west side goes out by the west gate as far as the fires let it.
// The sortie: the strongest go out (L-ordered, as for a door), 업3's duel actors first, and the three
// strongest close-combat officers on 업2's middle-pocket places.

import type { GameState } from '../../engine/state';
import { CLASS_RANGE } from '../../engine/battle/types';

/** 업1: chapter 4 stage 2 block 2 (its sortie fights 업2 and 업3 too). */
export function isYeFirstAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 4 && stage === 2 && block === 2;
}

/** 업3: chapter 4 stage 2 block 4. */
export function isYeLastAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 4 && stage === 2 && block === YE_LAST_BLOCK;
}

/** 업3's block (its duel actors go out from 업1). */
export const YE_LAST_BLOCK = 4;

/** Places in the sortie list (after the two fixed, 유비 and 제갈량) that 업2 puts in 유비's pocket: list places 6, 9, 12. */
export const YE_MIDDLE = [4, 7, 10];

/** Close-combat officers for the court (no bows, no 군악대, no healers). */
function courtFit(cls: number): boolean {
  return CLASS_RANGE[cls] < 2 && cls !== 12 && cls !== 18;
}

/** Places that 업2 puts in its west pocket (list places 2, 4, 7, 10, 13). */
export const YE_WEST = [0, 2, 5, 8, 11];

/** Places of 업2's west pocket that 업3 puts east of its start's wall with 유비 (list places 4, 7, 10; 9 is a middle one). */
export const YE3_EAST = [2, 5, 8];

/** 장비: his duel with 허저 (r3) takes 허저 off (31,9), the one cell out of 업3's east corridor. */
export const YE3_KEY = 2;

/**
 * Reorders the picks so the three strongest close-combat officers stand on 업2's middle-pocket places;
 * with `race` (GrindParams.ye3Plan) 업2's west-pocket officers are reordered among their places too
 * (업2 sees the same pockets): 장비 and then the highest levels on the places 업3 puts east with 유비.
 */
export function yeOrder(state: GameState, picks: number[], race = false): number[] {
  const lv = (i: number) => state.officers[i].dyn.level;
  const places = YE_MIDDLE.filter((k) => k < picks.length);
  const court = picks.filter((i) => courtFit(state.officers[i].dyn.cls)).sort((a, b) => lv(b) - lv(a) || a - b).slice(0, places.length);
  const rest = picks.filter((i) => !court.includes(i));
  const out: number[] = [];
  for (let k = 0; k < picks.length; k++) {
    const m = places.indexOf(k);
    out.push(m >= 0 && m < court.length ? court[m] : rest.shift()!);
  }
  if (race) {
    const west = YE_WEST.filter((k) => k < out.length);
    const east = YE3_EAST.filter((k) => k < out.length);
    const offs = west.map((k) => out[k]).sort((a, b) => Number(b === YE3_KEY) - Number(a === YE3_KEY) || lv(b) - lv(a) || a - b);
    const order = [...east, ...west.filter((k) => !east.includes(k))];
    order.forEach((k, j) => (out[k] = offs[j]));
  }
  return out;
}
