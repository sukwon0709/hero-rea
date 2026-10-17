// Grinding simulator, part 2: the player policy. It replaces the battle scene's player phase
// (1cb6:44de: victory window on turn 1, the tryCure pass over every slot, then one command per
// unit followed by the unit's events 8ad2 and the victory check 4abc) with commands chosen by a
// scoring rule, executed through the scene's own routines (doAttack = cd4a/e91a, castFlow = b2d6),
// so the RNG draws are exactly the ones the same commands make in the game. The policy itself
// never draws from the game's RNG (its estimates are exact damage formulas and bounds).
//
// Grinding phase: every controllable unit, neediest officer (lowest level) first, picks the
// (destination, action) pair with the best value:
//   value = w(officer) * expected exp - enemy troops burnt - MP spent - danger at the destination
// with w = 0 for officers at 99 (they gain nothing, 0cf5:6f64) and 1 + need*(99-level)/98 otherwise.
// Kills are allowed only while more than `keep` enemies remain and never on protected enemies
// (the victory officer, officers whose defeat ends the battle). Exp facts used (docs/BATTLE.md):
// a hit gives 4 (target lower) .. 16 (target 5+ levels higher), also when it misses; a kill
// 32/48/64/(dL+2); confusion and morale tactics give +8 whenever cast, success or not; single
// heals give +8 (+12 for 군악대/수송대) when the target is not already full (a200), so healers walk
// towards hurt allies; area heals are castable whenever an ally (or the caster) is in the area.
// Finish phase (the last `finish` turns, the leader hurt, too many losses, or nobody deployed can
// gain exp): the units head for the battle's winning condition (their goal cell / the victory
// officer / the nearest enemy) by the same deterministic scoring, and kill freely.
// Fallback (`native`, per battle): the game's own AI plays our side, for battles the policy loses.

import type { BattleScene } from '../../native/battle/scene';
import type { GameState } from '../../engine/state';
import { getFlag, type ScriptState } from '../../engine/script';
import type { Stage } from '../../formats/scenario';
import { recordCommands } from '../../native/battle/dev/setup';
import { scriptGains, recordIndexOf, turnEvents, cellOf, leaveWins, type ScriptGain, type TurnEvent } from './events';
import { S } from '../../native/battle/strings';
import { floodMove, rangeCells, terrainAt, unitAt, unitsInRange, sideOf, moveTypeOf } from '../../engine/battle/hex';
import {
  attackPower,
  castableTactics,
  combatExp,
  defencePower,
  maxHp,
  maxMp,
  moraleDrop,
  moraleLoss,
  movePoints,
  physicalDamage,
  tacticSkill,
  tacticTerrainOk,
  tryCure,
  healKind,
} from '../../engine/battle/rules';
import { healUseful } from '../../engine/battle/combat';
import { saveScene, restoreScene, mixSeed, type SceneSave } from './search';
import { isYeonjuAt } from './yeonju';
import {
  AiMode,
  CLASS_ATTACK_TYPE,
  CLASS_COUNT,
  CLASS_RANGE,
  CONFUSE_ITEM_RANGE,
  NONE,
  PLAYER_SLOTS,
  RAIN,
  Status,
  TACTIC_MP,
  TACTIC_POWER,
  TERRAIN_FOREST,
  TERRAIN_VILLAGE,
  TERRAIN_FORTRESS,
  TERRAIN_BARRACKS,
  terrainDefence,
  UNIT_SLOTS,
  UnitFlag,
  WEATHER_TYPE,
  resistsTactics,
  moveCost,
  type Unit,
} from '../../engine/battle/types';

// ---------------------------------------------------------------- parameters

export interface GrindParams {
  /** Weight of an officer's distance to 99 in the value of its exp. */
  need: number;
  /** Enemies kept alive: kills only while more than this many enemies are on the field. */
  keep: number;
  /** Turns reserved at the end for winning. */
  finish: number;
  /** Multiplier on the exp of tactics (MP is spent once per battle). */
  tactic: number;
  /** Multiplier on the exp of control tactics (견제: confusion 15..17, morale 18..20): they stall the enemy and keep it alive. */
  control: number;
  /** Multiplier on heal exp. */
  heal: number;
  /** Multiplier on kill exp (a kill removes a source of later hits). */
  kill: number;
  /** Cost of burning enemy troops (per 10% of the target's maximum). */
  conserve: number;
  /** Cost per MP point. */
  mp: number;
  /** Weight of the danger at the destination. */
  risk: number;
  /** Troops fraction under which a unit looks for a healing cell. */
  retreat: number;
  /** Pull towards the nearest enemy when nothing better is possible. */
  approach: number;
  /** Formation: slots kept for the strongest officers (the rest go to the lowest levels). */
  strong: number;
  /** Formation: officers who know a heal tactic, fielded right after 유비 and the band (lowest level first). */
  healers: number;
  /** Above 0.5: the merchants' gold goes to area heal scrolls (0x2e..0x33) first. */
  area: number;
  /**
   * Above 0.5 (the default, also for plans made before it existed): in a battle won by 유비 reaching
   * a cell or by wiping out the enemy (no officer to defeat: 하비; not 거록 / 계교, where it lost),
   * with the enemy (waves counted) twice our number or more, form up on defensible ground near the
   * cell, grind there, and walk 유비 in when the turns left just cover his way (Sukwon approved the
   * last-turn escape).
   */
  exit: number;
  /** Exit plan: spare turns on top of 유비's turns to the cell when the escape starts. */
  exitMargin: number;
  /** Exit plan: how much the anchor prefers cells close to the exit cell (per step). */
  exitNear: number;
  /**
   * Merchants: this many of the cheapest 병법서 (초열서 first: fire works on the common terrain) for
   * each officer below Lv99, lowest levels first; a hit with one is the usual hit exp (+4 and up,
   * never misses, no counter) on a turn the officer has no MP. Absent (older plans): one strong
   * scroll for the six smartest, as before.
   */
  scrolls: number;
  /**
   * Above 0.5: where 유비 reaching a cell wins with a victory bonus for every unit (거록, 계교, 서주:
   * 전원 경험치 +50), the enemy leader is spared and 유비 walks in timed to arrive near the turn
   * limit (exitMargin spare turns). No longer read: the walk-in is always weighed, now that it waits
   * for an open way and is given up when it stalls (신도); kept so older plans still load.
   */
  bonusExit: number;
  /** Above 0.5: an enemy 군악대 is not killed while grinding (it gives our neighbours MP too, 7cc8). Absent: off. */
  spareBand: number;
  /**
   * 회남 (ch1 stage 2 block 12) stage plan, above 0.5 (the default there; absent in older plans:
   * off): hold a formation in the north-east around (hnX, hnY) against the turn-5 wave, then peel
   * the waiting southern units one at a time at the bridge (only the nearest one's reach entered),
   * then walk 유비 to (0,2) when the way is clear and the turns left just cover it.
   */
  hnPlan: number;
  /** 회남 plan: the hold anchor's column. */
  hnX: number;
  /** 회남 plan: the hold anchor's row. */
  hnY: number;
  /** 회남 plan: the turn the peeling starts at the latest (earlier once the wave is down to hnWave units). */
  hnPeel: number;
  /** 회남 plan: wave units left that count as the wave being dead. */
  hnWave: number;
  /** 회남 plan: cells kept between us and the reach of the waiting units other than the one being peeled. */
  hnReach: number;
  /** 회남 plan: steps the peel anchor stays back from the furthest cell outside the others' reach. */
  hnBack: number;
  /** 회남 plan: share of the troops the formation heals back to (pulled back) before the next peel. */
  hnRest: number;
  /** 회남 plan: cells the front line (not the healers / band) stands out from the anchor towards the chasing enemies. */
  hnFront: number;
  /** 회남 plan: focus fire, the pull towards hitting the most hurt enemy and finishing it. */
  hnFocus: number;
  /**
   * 회남 plan: units this many levels or more below our three strongest stay inside the formation
   * and keep out of reach (the sortie also takes the strongest officers there, not the lowest).
   */
  hnWeak: number;
  /**
   * 폭탄 (0x21, 1350..1650 troops, no exp): weight of throwing one at an enemy that can hit us this
   * phase (0 = never). Absent (older plans): 1.
   */
  bomb: number;
  /** Confusion items 농무서/기상서/호우서 (0x2b..0x2d, sure, no exp): weight like `bomb`. Absent: 1. */
  confuse: number;
  /** Merchants: 폭탄 (0x21, 500 gold, sold at 서주) held in the party, bought up to this many (at most 1: an emergency tool). Absent: 1. */
  bombBuy: number;
  /** Merchants: confusion items (0x2b..0x2d, from 50 gold, 농무서 at 북해) bought up to this many. Absent: 4. */
  confuseBuy: number;
  /**
   * 회남 strike plan (huainan.ts, over hnPlan): stand next to the turn-6 wave's entry, strike it
   * first with 폭탄, then peel the waiting south with baits. Absent: on.
   */
  hnStrike: number;
  /** Merchants: gold kept when buying the single troop heals and the cheap scrolls (saving for 서주's 폭탄). Absent: 0. */
  healKeep: number;
  /** Strike plan: the cell to stand at the turn before the wave. Absent: (12,4). */
  hnStageX: number;
  hnStageY: number;
  /** Strike plan: waiting units a bait cell may wake besides its target. Absent: 1. */
  hnExtra: number;
  /** Strike plan: risk weight of our non-leader units while the wave is up. Absent: 1. */
  hnWaveRisk: number;
  /**
   * Farm phase, above 0.5 (absent in older plans: on): once the battle is safe (유비 and the defeat
   * officer healthy, the enemies left weak next to us, no wave due), the early finishes (idle,
   * losses, done, the leader hurt) wait and the turns up to the last farmEnd + the turns the finish
   * needs go to flat-rate exp: confusion / morale / heal tactics (8, 12 for classes 12/18, paid
   * whatever the level gap, 1cb6:b2d6) on every turn, spending MP freely, and blows that do not kill
   * on the enemies kept alive (hit exp is paid on every hit, 1cb6:e2f4).
   */
  farm: number;
  /** Farm phase: turns kept spare on top of the estimated turns the finish needs (walking + killing). */
  farmEnd: number;
  /** Farm phase: the enemies' strength (level+5 times troops share, summed) at most this share of ours. */
  farmRatio: number;
  /** Farm phase: multiplier on the flat-rate tactics' value (confusion, morale, heals). */
  farmTac: number;
  /**
   * Wake phase, above 0.5 (absent: on): when every enemy left waits (대기 / 부동: 태산's groups far
   * in the west) and the turns left cover more than the finish needs, the early finishes (idle,
   * losses, the leader hurt) and the regroup wait: the hurt mend, the rest march on and wake the
   * groups one at a time, and the finish starts when its turns just remain (Sukwon: use the turns).
   */
  wake: number;
  /** Wake phase: the enemies' strength (level+5 times troops share, summed) at most this share of ours. */
  wakeRatio: number;
  /**
   * Lure plan (lure.ts) at 거록 and 계교, above 0.5 (absent: on): hold near the start while the
   * mobile enemies come, peel the waiting groups one or two at a time with a bait, keep the victory
   * officer for last, walk 유비 to the +50 cell when his way is clear and the turns just cover it.
   */
  lure: number;
  /** Lure plan: waiting units a bait cell may wake besides its target. Absent: 1. */
  luExtra: number;
  /** Lure plan: spare turns on top of 유비's walk to the +50 cell. Absent: 1. */
  luMargin: number;
  /** Lure plan: turns kept for the last kill of the victory officer when the walk is blocked. Absent: 6. */
  luKill: number;
  /** Lure plan: awake enemies tolerated before the next bait goes out. Absent: 0. */
  luEngaged: number;
  /** Lure plan: turns added to the battle's opening hold. Absent: 0. */
  luHold: number;
  /**
   * Combat exp per enemy troop (absent: on). Hit exp (4..16, 1cb6:e2f4) does not grow with the
   * damage, and the enemies' troops barely come back, so the troops are what a battle's hit exp is
   * spent from. Each enemy's troops get a price: the best exp per troop point any of our units near
   * it would earn on it (a weak, low-level attacker hitting a higher-level enemy: 16 exp for a small
   * hit). A hit costs that price times its damage, times this weight: big hits from officers who
   * out-level the target (4 exp) leave the enemy to the small hitters. 0 = off (the default:
   * measured over 4 carries x 6 seeds per battle it lost 신도 7 times in 24 and gained nothing
   * elsewhere; the battles are won by kills, which are what keep our units alive). Learnable: the
   * per-battle search tries it.
   */
  cbPrice: number;
  /** Combat exp: share of the damage not charged on an enemy standing on a village / fortress (it heals 150..250 a turn, 1cb6:7cc8), and the weight of keeping it alive. */
  cbHeal: number;
  /** Combat exp: pull of a counterattacking unit (classes 9..11, 14; 1cb6:e42e) towards cells where enemies will attack it (a counter pays hit exp). */
  cbCounter: number;
  /** Combat exp: cells beyond its move + range within which a unit of ours counts for an enemy's price. */
  cbReach: number;
  /** Combat exp: share of the price charged on blows that do not kill even while the enemy side is the stronger one (learned off: it lost 서주, 태산). */
  cbBase: number;
  /** Combat exp: the most of a blow's own exp value its troop cost may take (below 1, a blow is never worse than waiting: the price picks targets, it does not idle units). */
  cbCap: number;
  /** Troops share under which a unit walks to the nearest healing cell (village, fortress, barracks) to recover and fight on (0 = off). */
  cbMend: number;
  /** Combat exp: how far the price waits for our side to be the stronger one (1: only then; 0: always, the cap keeps it from idling units). */
  cbGate: number;
  /** Share of the leader's troops the worst case (every enemy in reach hits it) may reach. */
  guard: number;
  /** Pull of the other units towards the leader (stay within 3 cells): the fight stays where the leader can join it and is covered. */
  escort: number;
  /** Weight of the battle scripts' gains (events.ts): victory bonus cells, duels, persuasions, level-ups. */
  event: number;
  /** Feeding the leader: others soften enemies the leader can finish safely, and leave those kills to it. */
  feed: number;
  /** Leader safety beyond the worst case: cost per enemy that can reach the leader's cell. */
  safe: number;
  /** 군악대 (class 12): at each turn start every unit next to it gets MP += its level/10+1 (1cb6:7cc8). Pull of tactic users towards it (and of it towards them); also fields the band officers. */
  band: number;
  /** The leader fights like the others: pull per cell towards the nearest enemy (the don't-die check stays). */
  lead: number;
  /** Above 0.5: hold a position near the start and let the enemy come in waves (하비); push out once they are broken. */
  hold: number;
  /** Terrain: stand on high-defence cells where enemies can reach, heal on villages/fortresses when hurt. */
  terrain: number;
  /**
   * Brace for the waves (Sukwon: survive them while grinding, never rush the enemy leader): this
   * many turns (+1) before a turn event brings 4+ enemy units, form up on defensible ground around
   * 유비 (terrain, chokepoint, away from where the wave enters) and let them come, until the wave
   * is thinned; at most 0.5 = off (learned: 하비 was won by finishing before its wave).
   */
  brace: number;
  /** Above 0.5: units walk towards the nearest enemy by walking distance (a flood over passable terrain), not a straight line (팽성: 미방 waited 23 turns behind a river). */
  walk: number;
  /** Look-ahead search of the player phase (above 0.5: on) and its settings (searchPhase). */
  search: number;
  srK: number;
  srSamples: number;
  srDepth: number;
  srHp: number;
  srLeader: number;
  srFoe: number;
  srGap: number;
  srMargin: number;
  srProg: number;
  srVerify: number;
  srLure: number;
  /**
   * Hold the end, above 0.5 (absent: on): the blow that ends the battle (the victory officer's or
   * the last enemy's defeat, the ending duel / persuasion, the win cell) waits while the turns left
   * exceed what it needs (walking to it and the hits, finishEstimate) plus endSpare; the others are
   * routed as before and the ones kept go on paying hit / tactic exp (Sukwon: use every turn).
   * Released for the leader's safety (a guarded officer below half its troops) and in rescue plans.
   */
  endHold: number;
  /** Hold the end: turns kept spare on top of the turns the ending needs. */
  endSpare: number;
  /**
   * Let them mend, above 0.5 (absent: on): a weakened enemy we keep alive (the victory officer, a
   * duel / persuasion partner, the ones `keep` spares, the held last one) is drawn by its AI to a
   * village / fortress / barracks it can walk to (1cb6:c2be: +50 there when at 40% troops or morale
   * under 40); our units keep off those cells so it gets there, comes back with 150..250 troops a
   * turn (1cb6:7cc8) and pays hit exp again instead of sitting one blow from death.
   */
  nurse: number;
  /**
   * Milking (Sukwon's way): while our side has slack (the enemies left at most milkRatio of our
   * strength, no wave due), a weakened enemy that can still mend (on a village / fortress /
   * barracks, or one in its walk) is not killed: the kill throws away the hits it pays after
   * 150..250 troops a turn come back (1cb6:7cc8). Cost of such a kill in exp per unit weight (0 = off).
   */
  milk: number;
  /** Milking: the enemies' strength (level+5 times troops share, summed) at most this share of ours. */
  milkRatio: number;
  /**
   * Milking: with slack, a blow pays less the more a lower-level unit that can reach the same enemy
   * this phase would earn from it (hit exp (gap+3)*2 up to 16 for a lower attacker, 4 for a higher
   * one, 1cb6:e2f4): the troops go to the low levels first. Share of that difference charged, scaled
   * by the share of the enemy's troops the blow takes.
   */
  steer: number;
  /**
   * Battle mode: value of the enemy troops a blow or a damage tactic takes (100 per whole unit, a
   * kill +50), on top of the exp-based value (0: off, the battles are played for exp).
   */
  hnDmg: number;
  /**
   * 회남: once the wave is down to hnWave units, push over the bridge for the fort at once (above
   * 0.5), every unit fighting its way along (no waiting at the anchor for the way to clear)
   */
  hnPush: number;
  /** Shop: gold is kept for the promotion items of members within this many levels of their promotion level (-1: off). */
  promoLead: number;
  /**
   * 연주 escape plan (yeonju.ts), above 0.5: 유비 walks fixed waypoints, then rollouts pick his way to
   * the exit (3,19), reached around turn 15-17 (Sukwon approved the early escape there only).
   */
  yjEscape: number;
  /** 연주 escape plan: RNG samples per option of the rollouts. */
  yjSamples: number;
  /** The walk to an escape / bonus cell goes in a column, the unit nearest its goal first (above 0.5; else by need). */
  column: number;
  /** Troop heals go first to the ally the enemy can bring down this phase: weight of that rescue (0: off). */
  healRisk: number;
  /** Cost of a lone cell (no ally next to it) where two or more enemies could bring the unit down, as a share of its future (0: off). */
  lone: number;
  /** Damage tactics valued with their chance to land (1cb6:a2aa; a miss still pays the hit exp): above 0.5. */
  tacHit: number;
  /** Player phases in a row without exp before the finish starts ('idle'; was 8). */
  idleFinish: number;
  /**
   * Fish pen (가두리양식장), above 0.5: once the enemies left are weak next to us (penRatio), one
   * enemy officer is picked (most hit exp for our units, harmless enough: penHarm) and boxed in by
   * our units on its sides; it is never killed while the pen holds (nor driven off by morale: a
   * confused unit at 0 morale leaves, 1cb6:a0d0), its troops go to the blows with the best exp per
   * damage point first (penPrice), the others cast on it (control tactics pay +8 whatever happens,
   * 1cb6:b2d6; at 0 morale an unconfused unit takes 견제 forever: the "zombie") and take its attacks
   * (a counter pays hit exp, penCounter). It falls in the finish (the last turns).
   */
  pen: number;
  /** Pen: the other enemies' strength (level+5 times troops share, summed) at most this share of ours. */
  penRatio: number;
  /** Pen: the most a candidate's blow may take of our units' troops on average (share of the maximum). */
  penHarm: number;
  /** Pen: weight of the price of the pen's troops (the exp per damage point of the first blow they do not cover). */
  penPrice: number;
  /** Pen: value of standing on a side of the penned enemy (boxing it in). */
  penCell: number;
  /** Pen: weight of the counter exp a unit next to the penned enemy can expect from its attacks. */
  penCounter: number;
  /**
   * Merchants: selling (shop.ts, Game.shopSell: ((price*3)>>2)*10 gold, a story item 1910), before
   * the buys. 0 off; 1 the class-change books and the equipment its holder does not use; 2 also the
   * strong attack scrolls where cheap ones are sold; 3 also the cheap-scroll fill to every free slot
   * but one (the expert's bulk 초열서). Learnable; absent (older plans): the default, 1 (the bot
   * never reads a class-change book; measured at 회남, 8/10 -> 10/10 wins: the 3820 gold of
   * 유비's 검술/궁술지침서 buys the scrolls and the area / troop heals).
   */
  sell: number;
  /**
   * Idle walk: a unit that earned nothing on its last two commands (out of reach of every target)
   * walks to the nearest enemy at this weight per step (approach's is 0.3 x approach) instead of
   * waiting where it stands, still under the danger cost. 0 off.
   */
  idleAp: number;
  /**
   * Scroll throws (the cheap attack scrolls, 0x22..0x2a, with two or more held): a sure, counter-free
   * hit on an enemy at or above the thrower's level (8..16 exp) gets scrollEarn x (exp - 4) more,
   * no stock cost, and in the 회남 plan the troops-taken and focus terms a blow has (hnDmg,
   * hnFocus). 0: the old valuation. (On a weaker enemy a scroll pays 4 exp for troops the low
   * levels' blows earn more from: 북해 with 39 scrolls, throwing them all lost exp.)
   */
  scrollEarn: number;
  /**
   * Escort exit (장판파: the 백성, allies under the computer, walk to a cell whose arrival wins):
   * a unit of ours stands on that cell so the battle goes on while exp is to be had. It steps off
   * after this many player phases in a row without exp (Sukwon: use the turns for exp, but no
   * sitting around for nothing), in the finish, or when 유비 / the party is in danger.
   */
  escIdle: number;
  /** Escort exit: the cell is also freed once the turns left are at most this many. */
  escWin: number;
  /**
   * Band farm (군악대 MP), above 0.5: with casters of ours that know a flat-rate tactic (confusion /
   * morale 15..20, heals 21..35: +8, +12 for classes 12/18, cast or not, 1cb6:b2d6), the 군악대 on
   * the field (either side: at each turn start it gives its 4 neighbours level/10+1 MP, 1cb6:7cc8)
   * are the battle's renewable exp. The enemy bands are never killed nor driven off by morale
   * (bfSpare: from the start, else once safe); once safe (bfRatio) the casters spend their MP
   * freely, the ones short of MP stand next to a band (lowest levels first, bfCell), a kept enemy
   * band is the fish pen's pick (bfPen: boxed in, so it neither walks off nor dies), and the early
   * finishes wait until the turns left just cover the finish. 견제 goes to 0-morale unconfused
   * enemies first (they never leave: 898c rolls confusion on a drop only, a0d0 needs it).
   */
  bandFarm: number;
  /** Band farm: the other enemies' strength (level+5 times troops share, summed) at most this share of ours. */
  bfRatio: number;
  /** Band farm, above 0.5: the enemy bands are kept alive from the start (else only once safe). */
  bfSpare: number;
  /** Band farm: value per MP a caster short of MP gains standing next to a band (by its weight). */
  bfCell: number;
  /** Band farm: the fish pen's preference for a kept enemy band. */
  bfPen: number;
  /** Band farm: turns kept spare on top of the finish's estimate (finishEstimate) while it runs (the farm phase's farmNeed takes 1.5 times it plus farmEnd). */
  bfEnd: number;
  /**
   * Gates (BattleKnowledge.gates), above 0.5: once a gate's flags are set, its officer walks onto its
   * cell when no enemy is within 8 steps of us any more (gateLate 0), or once at most gateLate turns
   * are left (하비: the castle opens around turn 19 instead of turn 30, with its 13 units to farm;
   * before this the party stood idle from turn 17 to 31 in front of the raised bridge and 5 of 12
   * seeds ran out of time against 여포).
   */
  gate: number;
  /** Gates: walk to the gate once at most this many turns are left, enemies near or not (0: as soon as none is near). */
  gateLate: number;
  /**
   * 총퇴각 at the first player phase this many times before playing (not learned globally, chosen
   * per battle): each retreat restarts the battle with the RNG moved on, as it does for a player.
   */
  rerolls?: number;
  /**
   * Fallback plan (per battle, not learned): after the rerolls, hand every player unit to the
   * game's own computer AI (the port's autoPlay: 최단 적공격, 유비 대기) instead of grinding.
   * Used for battles the grinding policy cannot win; exp is whatever the AI's fighting earns.
   */
  native?: boolean;
}

/** The learned parameters (rerolls and native are chosen per battle). */
export type ParamKey = Exclude<keyof GrindParams, 'rerolls' | 'native'>;

export interface ParamSpec {
  key: ParamKey;
  min: number;
  max: number;
  def: number;
  int?: boolean;
}

export const PARAM_SPECS: ParamSpec[] = [
  { key: 'need', min: 0, max: 4, def: 1.5 },
  { key: 'keep', min: 1, max: 8, def: 2, int: true },
  { key: 'finish', min: 2, max: 16, def: 3, int: true },
  { key: 'tactic', min: 0.2, max: 2.5, def: 1 },
  { key: 'control', min: 0.2, max: 3, def: 1 },
  { key: 'heal', min: 0.2, max: 2.5, def: 1 },
  { key: 'kill', min: 0, max: 2, def: 0.6 },
  { key: 'conserve', min: 0, max: 3, def: 0.8 },
  { key: 'mp', min: 0, max: 1.5, def: 0.2 },
  { key: 'risk', min: 0, max: 4, def: 1.2 },
  { key: 'retreat', min: 0, max: 0.7, def: 0.35 },
  { key: 'approach', min: 0, max: 3, def: 0.3 },
  { key: 'strong', min: 0, max: 8, def: 3, int: true },
  { key: 'guard', min: 0.3, max: 1.3, def: 1 },
  { key: 'escort', min: 0, max: 3, def: 0.6 },
  { key: 'event', min: 0, max: 3, def: 1 },
  { key: 'feed', min: 0, max: 3, def: 0 },
  { key: 'safe', min: 0, max: 3, def: 0 },
  { key: 'band', min: 0, max: 3, def: 1 },
  { key: 'lead', min: 0, max: 4, def: 1.5 },
  { key: 'hold', min: 0, max: 1, def: 0 },
  { key: 'terrain', min: 0, max: 3, def: 1 },
  { key: 'brace', min: 0, max: 3, def: 0.6 },
  { key: 'walk', min: 0, max: 1, def: 0.4 },
  { key: 'healers', min: 0, max: 4, def: 0, int: true },
  { key: 'area', min: 0, max: 1, def: 0.4 },
  { key: 'exit', min: 0, max: 1, def: 0.6 },
  { key: 'exitMargin', min: 0, max: 3, def: 1, int: true },
  { key: 'exitNear', min: 0, max: 1, def: 0.15 },
  { key: 'scrolls', min: 0, max: 4, def: 2, int: true },
  { key: 'bonusExit', min: 0, max: 1, def: 0.6 },
  { key: 'spareBand', min: 0, max: 1, def: 0.4 },
  { key: 'hnPlan', min: 0, max: 1, def: 0.6 },
  { key: 'hnX', min: 15, max: 23, def: 21, int: true },
  { key: 'hnY', min: 3, max: 12, def: 8, int: true },
  { key: 'hnPeel', min: 8, max: 26, def: 18, int: true },
  { key: 'hnWave', min: 0, max: 5, def: 1, int: true },
  { key: 'hnReach', min: 0, max: 3, def: 1, int: true },
  { key: 'hnBack', min: 0, max: 3, def: 0, int: true },
  { key: 'hnRest', min: 0.4, max: 1, def: 0.75 },
  { key: 'hnFront', min: 0, max: 2, def: 1, int: true },
  { key: 'hnFocus', min: 0, max: 2, def: 1 },
  { key: 'hnWeak', min: 1, max: 8, def: 3, int: true },
  { key: 'bomb', min: 0, max: 3, def: 1 },
  { key: 'confuse', min: 0, max: 3, def: 1 },
  { key: 'bombBuy', min: 0, max: 1, def: 1, int: true },
  { key: 'confuseBuy', min: 0, max: 12, def: 4, int: true },
  { key: 'hnStrike', min: 0, max: 1, def: 0.6 },
  { key: 'healKeep', min: 0, max: 1500, def: 0, int: true },
  { key: 'hnStageX', min: 9, max: 16, def: 12, int: true },
  { key: 'hnStageY', min: 2, max: 7, def: 4, int: true },
  { key: 'hnExtra', min: 0, max: 3, def: 1, int: true },
  { key: 'hnWaveRisk', min: 0.2, max: 1.5, def: 1 },
  { key: 'farm', min: 0, max: 1, def: 0.6 },
  { key: 'farmEnd', min: 1, max: 6, def: 2, int: true },
  { key: 'farmRatio', min: 0.1, max: 1.5, def: 0.4 },
  { key: 'farmTac', min: 1, max: 4, def: 2 },
  { key: 'lure', min: 0, max: 1, def: 0.6 },
  { key: 'luExtra', min: 0, max: 2, def: 1, int: true },
  { key: 'luMargin', min: 0, max: 4, def: 1, int: true },
  { key: 'luKill', min: 3, max: 10, def: 6, int: true },
  { key: 'luEngaged', min: 0, max: 2, def: 0, int: true },
  { key: 'luHold', min: -3, max: 3, def: 0, int: true },
  { key: 'cbPrice', min: 0, max: 1.5, def: 0 },
  { key: 'cbHeal', min: 0, max: 1, def: 0.6 },
  { key: 'cbCounter', min: 0, max: 3, def: 0 },
  { key: 'cbReach', min: 0, max: 8, def: 3, int: true },
  { key: 'cbBase', min: 0, max: 1, def: 0 },
  { key: 'cbCap', min: 0, max: 2, def: 0.8 },
  { key: 'cbMend', min: 0, max: 0.8, def: 0.35 },
  { key: 'cbGate', min: 0, max: 1, def: 1 },
  // (appended: learned plans store the CEM mean by index)
  { key: 'wake', min: 0, max: 1, def: 0.6 },
  { key: 'wakeRatio', min: 0.4, max: 2.5, def: 1.4 },
  // look-ahead search of the player phase (searchPhase): candidates, RNG samples, depth (1 = our
  // phase and the enemy's reply, 2 = one more turn), weights of the troops kept, of the leader's
  // troops and of the enemy troops removed, and how far below the best an alternative action may be
  { key: 'search', min: 0, max: 1, def: 0.6 },
  { key: 'srK', min: 1, max: 24, def: 14, int: true },
  { key: 'srSamples', min: 1, max: 4, def: 2, int: true },
  { key: 'srDepth', min: 1, max: 2, def: 2, int: true },
  { key: 'srHp', min: 0, max: 3, def: 1 },
  { key: 'srLeader', min: 0, max: 3, def: 1 },
  { key: 'srFoe', min: 0, max: 3, def: 0.5 },
  { key: 'srGap', min: 0, max: 200, def: 40 },
  { key: 'srMargin', min: 0, max: 200, def: 30 },
  { key: 'srProg', min: 0, max: 3, def: 1 },
  { key: 'srVerify', min: 0, max: 6, def: 3, int: true },
  // the lure plan (거록, 계교) under the search: off by default (the search alone won more there)
  { key: 'srLure', min: 0, max: 1, def: 0 },
  // hold the battle-ending blow until the last turns (endHeld); off by default (cost wins under the evolve params)
  { key: 'endHold', min: 0, max: 1, def: 0.4 },
  { key: 'endSpare', min: 0, max: 4, def: 1, int: true },
  // keep the healing cells free for the weakened enemies kept alive (buildNurse); off by default
  { key: 'nurse', min: 0, max: 1, def: 0.4 },
  // milking: spare mendable enemies, give the blows to the low levels (buildNurse)
  { key: 'milk', min: 0, max: 3, def: 1 },
  { key: 'milkRatio', min: 0.2, max: 1.5, def: 0.6 },
  { key: 'steer', min: 0, max: 3, def: 1 },
  { key: 'hnDmg', min: 0, max: 3, def: 0 },
  { key: 'hnPush', min: 0, max: 1, def: 1 },
  // shop: keep the gold for the promotion items of members within promoLead levels of promoting (-1 off)
  { key: 'promoLead', min: -1, max: 12, def: -1, int: true },
  // 연주 (battle 16 only): the early escape plan (on by default) and its rollout samples
  { key: 'yjEscape', min: 0, max: 1, def: 0.6 },
  { key: 'yjSamples', min: 1, max: 4, def: 3, int: true },
  { key: 'column', min: 0, max: 1, def: 1 },
  { key: 'healRisk', min: 0, max: 3, def: 0 },
  { key: 'lone', min: 0, max: 2, def: 0 },
  { key: 'tacHit', min: 0, max: 1, def: 0 },
  { key: 'idleFinish', min: 3, max: 10, def: 8, int: true },
  // the fish pen (buildPen): box one enemy in, never finish it before the last turns
  { key: 'pen', min: 0, max: 1, def: 0.6 },
  { key: 'penRatio', min: 0.2, max: 1.5, def: 0.6 },
  { key: 'penHarm', min: 0.1, max: 0.8, def: 0.35 },
  { key: 'penPrice', min: 0, max: 2, def: 1 },
  { key: 'penCell', min: 0, max: 20, def: 6 },
  { key: 'penCounter', min: 0, max: 2, def: 0.5 },
  // merchants: sell the unused items (class-change books, spare equipment, strong scrolls) and bulk-buy 초열서
  { key: 'sell', min: 0, max: 3, def: 1, int: true },
  // exp per unit-turn: idle units walk to the nearest enemy; the cheap scrolls compete with waiting
  { key: 'idleAp', min: 0, max: 3, def: 0 },
  { key: 'scrollEarn', min: 0, max: 2, def: 0 },
  // escort exit (장판파): the cell the escorted allies walk to stays blocked until exp runs dry
  { key: 'escIdle', min: 2, max: 12, def: 4, int: true },
  { key: 'escWin', min: 1, max: 10, def: 3, int: true },
  // band farm: keep the 군악대 alive and cast on their MP every turn (buildBand)
  { key: 'bandFarm', min: 0, max: 1, def: 0.6 },
  { key: 'bfRatio', min: 0.2, max: 1.5, def: 0.6 },
  { key: 'bfSpare', min: 0, max: 1, def: 0.6 },
  { key: 'bfCell', min: 0, max: 8, def: 3 },
  { key: 'bfPen', min: 0, max: 200, def: 60 },
  { key: 'bfEnd', min: 0, max: 6, def: 2, int: true },
  // gates: walk onto a flag-gated map-changing cell (하비's drawbridge) once nothing is left nearby
  { key: 'gate', min: 0, max: 1, def: 0.6 },
  { key: 'gateLate', min: 0, max: 45, def: 0, int: true },
];

/** 폭탄 (0x21) a battle may use: one, for an emergency (saving the leader from a near-lethal hit). */
export const BOMBS_PER_BATTLE = 1;

/** A parameter's value, or its default when the plan predates it (absent / NaN). */
export function paramOr(p: GrindParams, k: ParamKey): number {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : PARAM_SPECS.find((sp) => sp.key === k)!.def;
}

/** 회남's trap strip: 유비 entering it turns every enemy on him (record 5). */
const HN_TRAP = [3, 10, 9, 13] as const;

/** 회남: chapter 1 stage 2 block 12 (the map table calls it 하비). */
export function isHuainan(k: Pick<BattleKnowledge, 'stage' | 'block'>): boolean {
  return !!k.stage && isHuainanAt(k.stage.chapter, k.stage.index, k.block);
}
export function isHuainanAt(chapter: number, stage: number, block: number | undefined): boolean {
  return chapter === 1 && stage === 2 && block === 12;
}

export function defaultParams(): GrindParams {
  const p = {} as GrindParams;
  for (const s of PARAM_SPECS) p[s.key] = s.def;
  return p;
}

export function clampParams(p: GrindParams): GrindParams {
  const o = { ...p };
  for (const s of PARAM_SPECS) {
    let v = Math.min(s.max, Math.max(s.min, o[s.key]));
    if (s.int) v = Math.round(v);
    o[s.key] = v;
  }
  return o;
}

// ---------------------------------------------------------------- battle analysis

export interface BattleKnowledge {
  victory: number | null;
  /** Enemy officers whose defeat ends the battle (never killed while grinding). */
  protect: Set<number>;
  /** Officers whose loss loses the battle (유비, the defeat officer). */
  guarded: Set<number>;
  /** Cells (y*width+x per officer, 0x400 = any) whose arrival event wins the battle. */
  winCells: { officer: number; x0: number; y0: number; x1: number; y1: number; group?: number }[];
  /** Adjacency events (trigger 4) that end the battle: `actor` acting next to `other`. */
  winAdj: { actor: number; other: number; group?: number }[];
  /** A turn event ends the game at this turn (deadline before the limit). */
  deadline: number | null;
  /** A turn event wins the battle at this turn (survive until then: 소패). */
  endsAt: number | null;
  /** Treasure cells: arrival events (trigger 6) that give an item (ADD_ITEM) and do not end the battle. */
  treasure: { officer: number; x: number; y: number }[];
  /** The block's gains (bonus exp, duels, persuasions, levels), with the stage for matching the records the VM runs. */
  gains: ScriptGain[];
  /** Turn events and defeat events that lose the battle (events.ts). */
  turns: TurnEvent[];
  /** Turn of a big enemy wave (5+ units, turn 6 or later): the grinding finishes before it. */
  soft: number | null;
  /**
   * Steps before the winning group (서주 2nd): one-shot groups whose event moves the script on,
   * in order (defeat officer X, then 유비 into an area). Only the current group's records can fire,
   * so the win cells and the victory of later groups wait for these.
   */
  steps: { group: number; trigger: number; officer: number; x0: number; y0: number; x1: number; y1: number }[];
  /**
   * Gates: arrival events (trigger 6 / 11) behind an IF on flags other events set, that change the
   * map (MAP_CHIP) and neither end nor lose the battle (하비 r8: after the three persuasions, 유비 at
   * the drawbridge (12,12) lowers it and 조조's army comes in; without it the bridge stays up until
   * the turn-30 event). The cells, the flags the IF needs, and the officers the event brings in.
   */
  gates: { record: number; actor: number; x0: number; y0: number; x1: number; y1: number; set: number[]; clear: number[]; reinforce: number[] }[];
  stage?: Stage;
  block?: number;
}

function winning(stage: Stage, code: number, victory: number | null, block?: number, group?: number): boolean {
  const cmds = recordCommands(stage, code);
  // LEAVE_GROUP into a group whose auto record ends the battle in a win (태산: persuading 이명 moves
  // the block to group 4, whose first record is the victory)
  if (block !== undefined && group !== undefined && cmds.some((c) => c.name === 'LEAVE_GROUP') && !cmds.some((c) => c.name === 'GAME_OVER' || c.name === 'BATTLE_END')) {
    if (leaveWins(stage, block, group)) return true;
  }
  // the victory officer taken off the field (a duel: REMOVE) wins through its defeat event
  if (victory !== null && cmds.some((c) => c.name === 'REMOVE' && (c as unknown as { officer: number }).officer === victory)) return true;
  const i = cmds.findIndex((c) => c.name === 'BATTLE_END');
  if (i < 0) return cmds.some((c) => c.name === 'MAP');
  return cmds[i + 1]?.name !== 'GAME_OVER';
}

/** Reads the current block's records: what wins, what loses, what to keep alive. */
export function analyseBattle(stage: Stage, script: ScriptState): BattleKnowledge {
  const k: BattleKnowledge = { victory: null, protect: new Set(), guarded: new Set([0]), winCells: [], winAdj: [], deadline: null, endsAt: null, treasure: [], gains: scriptGains(stage, script.block), turns: turnEvents(stage, script.block), soft: null, steps: [], gates: [], stage, block: script.block };
  if (script.victory.enabled) {
    k.victory = script.victory.officer;
    k.protect.add(script.victory.officer);
  }
  if (script.defeat.enabled) k.guarded.add(script.defeat.officer);
  for (const r of stage.blocks[script.block]?.records ?? []) {
    const cmds = recordCommands(stage, r.code);
    if (r.trigger === 12 && winning(stage, r.code, k.victory, script.block, r.group)) k.protect.add(r.p1);
    if ((r.trigger === 6 || r.trigger === 11) && winning(stage, r.code, k.victory, script.block, r.group) && !cmds.some((c) => c.name === 'GAME_OVER')) {
      const [x0, y0] = cellOf(r.p2);
      const [x1, y1] = r.trigger === 6 ? [x0, y0] : cellOf(r.p3);
      k.winCells.push({ officer: r.p1, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), group: r.group });
    }
    if (r.trigger === 4 && winning(stage, r.code, k.victory, script.block, r.group)) k.winAdj.push({ actor: r.p1, other: r.p2, group: r.group });
    if (r.trigger === 6 && cmds.some((c) => c.name === 'ADD_ITEM') && !cmds.some((c) => c.name === 'BATTLE_END' || c.name === 'GAME_OVER'))
      k.treasure.push({ officer: r.p1, x: cellOf(r.p2)[0], y: cellOf(r.p2)[1] });
    if ((r.trigger === 6 || r.trigger === 11) && cmds.some((c) => c.name === 'MAP_CHIP') && !cmds.some((c) => c.name === 'BATTLE_END' || c.name === 'GAME_OVER')) {
      const cond = cmds.find((c) => c.name === 'IF') as { set: number[]; clear: number[] } | undefined;
      if (cond && cond.set.length) {
        const [x0, y0] = cellOf(r.p2);
        const [x1, y1] = r.trigger === 6 ? [x0, y0] : cellOf(r.p3);
        const reinforce = cmds.filter((c) => c.name === 'REINFORCE').map((c) => (c as unknown as { officer: number }).officer);
        k.gates.push({ record: r.index, actor: r.p1, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), set: [...cond.set], clear: [...cond.clear], reinforce });
      }
    }
    if (r.trigger === 9 && r.p1 > 0 && cmds.some((c) => c.name === 'GAME_OVER')) k.deadline = Math.min(k.deadline ?? 999, r.p1);
    else if (r.trigger === 9 && r.p1 > 0 && cmds.some((c) => c.name === 'BATTLE_END') && winning(stage, r.code, k.victory, script.block, r.group)) k.endsAt = Math.min(k.endsAt ?? 999, r.p1);
  }
  // steps: non-resident groups (done when their one event ends) of a single defeat / arrival event
  // that neither ends nor loses the battle, before the group holding the winning records
  const recs = stage.blocks[script.block]?.records ?? [];
  const winGroups = new Set([...k.winCells.map((c) => c.group), ...k.winAdj.map((a) => a.group)]);
  const lastWin = Math.max(-1, ...[...winGroups].filter((g): g is number => g !== undefined));
  const groups = [...new Set(recs.map((r) => r.group))].sort((a, b) => a - b);
  for (const g of groups) {
    if (g >= lastWin) break;
    const rs = recs.filter((r) => r.group === g);
    if (rs[0].resident || rs.length !== 1) continue;
    const r = rs[0];
    if (r.trigger !== 12 && r.trigger !== 6 && r.trigger !== 11) continue;
    const cmds = recordCommands(stage, r.code);
    if (cmds.some((c) => c.name === 'BATTLE_END' || c.name === 'GAME_OVER')) continue;
    const [x0, y0] = cellOf(r.p2);
    const [x1, y1] = r.trigger === 11 ? cellOf(r.p3) : [x0, y0];
    k.steps.push({ group: g, trigger: r.trigger, officer: r.p1, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  }
  return k;
}

// ---------------------------------------------------------------- formation

/**
 * Picks for a FORMATION: the officers already placed by the setup, 유비, then `strong` of the
 * highest-level officers (to keep battles winnable), then the lowest levels below 99.
 */
export function pickFormation(state: GameState, fixed: number[], free: number, strong: number, band = false, healers = 0, learn?: Uint8Array): number[] {
  const faction = state.officers[0].dyn.flags & 0x1f;
  const pool = state.officers
    .map((o, i) => ({ i, lv: o.dyn.level, ok: (o.dyn.flags & 0x80) !== 0 && (o.dyn.flags & 0x1f) === faction && i < 0x100 }))
    .filter((o) => o.ok && !fixed.includes(o.i));
  const picks: number[] = [];
  const take = (i: number) => {
    if (picks.length < free && !picks.includes(i)) picks.push(i);
  };
  if (!fixed.includes(0) && pool.some((o) => o.i === 0)) take(0);
  // 군악대 officers: their neighbours regain MP every turn (heals and support tactics keep flowing)
  if (band) for (const o of pool) if (state.officers[o.i].dyn.cls === 12) take(o.i);
  // healers (heal / morale tactics 21..35 learned at their level): troops stay up, and every heal
  // is +8 exp for a unit that would otherwise wait
  if (healers > 0 && learn) {
    const heals = (i: number) => {
      const d = state.officers[i].dyn;
      for (let t = 21; t <= 35; t++) if (learn[t * CLASS_COUNT + d.cls] <= d.level) return true;
      return false;
    };
    const hs = pool.filter((o) => o.lv < 99 && heals(o.i)).sort((a, b) => a.lv - b.lv || a.i - b.i);
    for (const o of hs.slice(0, healers)) take(o.i);
  }
  const byHigh = [...pool].sort((a, b) => b.lv - a.lv || a.i - b.i);
  for (const o of byHigh.slice(0, strong)) take(o.i);
  const byLow = [...pool].sort((a, b) => (a.lv >= 99 ? 1 : 0) - (b.lv >= 99 ? 1 : 0) || a.lv - b.lv || a.i - b.i);
  for (const o of byLow) take(o.i);
  return picks;
}

/**
 * 회남 sortie (GrindParams.hnPlan with hnWeak): the usual picks, then the ones left out swapped in
 * for the weakest, keeping each kept officer on its record (the start cells matter). The order of
 * worth: the band and the healers as usual, then close-combat units by level (L8 infantry still
 * screen the formation: benching 경무 for a L13 archer held to turn 30 in 3 of 20 seeds instead of
 * 15), then the rest by level.
 */
export function huainanPicks(state: GameState, fixed: number[], free: number, picks: number[], band: boolean, healers: number, learn?: Uint8Array): number[] {
  const faction = state.officers[0].dyn.flags & 0x1f;
  const pool = state.officers
    .map((o, i) => ({ i, lv: o.dyn.level, melee: CLASS_RANGE[o.dyn.cls] === 0, ok: (o.dyn.flags & 0x80) !== 0 && (o.dyn.flags & 0x1f) === faction && i < 0x100 }))
    .filter((o) => o.ok && !fixed.includes(o.i));
  // the band and the healers as pickFormation takes them (it then fills up with the lowest levels)
  const keep = new Set<number>();
  if (pool.some((o) => o.i === 0)) keep.add(0);
  if (band) for (const o of pool) if (state.officers[o.i].dyn.cls === 12) keep.add(o.i);
  if (healers > 0 && learn) {
    const heals = (i: number) => {
      const d = state.officers[i].dyn;
      for (let t = 21; t <= 35; t++) if (learn[t * CLASS_COUNT + d.cls] <= d.level) return true;
      return false;
    };
    for (const o of pool.filter((o) => o.lv < 99 && heals(o.i)).sort((a, b) => a.lv - b.lv || a.i - b.i).slice(0, healers)) keep.add(o.i);
  }
  const rest = pool.filter((o) => !keep.has(o.i)).sort((a, b) => Number(b.melee) - Number(a.melee) || b.lv - a.lv || a.i - b.i);
  const want = new Set<number>([...keep]);
  for (const o of rest) if (want.size < free) want.add(o.i);
  const out = [...picks];
  const add = [...want].filter((i) => !out.includes(i));
  for (let k = 0; k < out.length && add.length; k++) if (!want.has(out[k])) out[k] = add.shift()!;
  return out;
}

// ---------------------------------------------------------------- statistics

export interface GrindStats {
  turns: number;
  finishTurn: number | null;
  /** Why the finish began: deadline, done (nobody needy), idle, leader, losses. */
  finishReason?: string;
  /** Turns played in the farm phase (GrindParams.farm). */
  farmTurns?: number;
  /** Turns the wake phase held off an early finish (every enemy left waiting, turns to spare). */
  wakeTurns?: number;
  /** Player phases the band farm ran (GrindParams.bandFarm), and the flat-rate casts (15..35) made in them. */
  bandTurns?: number;
  bandCasts?: number;
  actions: { attack: number; kill: number; tactic: number; heal: number; wait: number; item?: number; promoted?: number };
  /** Officer -> exp gained per kind. */
  byOfficer: Map<number, { hits: number; kills: number; tactics: number; heals: number }>;
  /** Enemy officers alive when the finish began (the ones kept for grinding). */
  kept: number[];
  /** Tactics cast (tactic id -> count). */
  tactics: Map<number, number>;
  /** Records of the block's gains that ran (events.ts ScriptGain.record). */
  gainsFired?: number[];
  /** The victory bonus set when the battle ended (given to every unit on the field on a win). */
  bonus?: number;
  /** Look-ahead search counters (GrindParams.search): phases searched, rollouts, phases where a candidate beat the greedy one. */
  search?: { phases: number; rollouts: number; changed: number };
}

interface Action {
  slot: number;
  x: number;
  y: number;
  kind: 'attack' | 'tactic' | 'wait' | 'item';
  target: number;
  tactic: number;
  /** kind 'item': the item id and its slot in the officer's 8 item slots. */
  item?: { id: number; index: number };
  value: number;
  exp: number;
  lethal: boolean;
  danger?: number;
}

/** One candidate of the search phase (searchPhase): other weights, or one command changed. */
interface PhasePlan {
  label: string;
  over?: Partial<GrindParams>;
  /** The command (in phase order) that takes the best action of another kind. */
  dev?: number;
  /** Filled with the commands played (to skip candidates that come out the same). */
  trace?: string[];
}

/** Kind of an action for the search's alternatives (waits by 2x2 block of cells). */
function actionKey(a: Action): string {
  return a.kind === 'wait' ? `w${a.x >> 1},${a.y >> 1}` : `${a.kind}${a.target},${a.tactic},${a.item?.id ?? ''}`;
}

// ---------------------------------------------------------------- the policy

/** Promotion items 0x13..0x1a (ab86): from class PROMOTE_FROM[k] at level >= PROMOTE_LEVEL[k] -> class+1. */
export const PROMOTE_FROM = [0, 1, 3, 4, 6, 7, 9, 10];
export const PROMOTE_LEVEL = [15, 30, 15, 30, 15, 30, 15, 30];

export class GrindPolicy {
  readonly stats: GrindStats = {
    turns: 0,
    finishTurn: null,
    actions: { attack: 0, kill: 0, tactic: 0, heal: 0, wait: 0 },
    byOfficer: new Map(),
    kept: [],
    tactics: new Map(),
    gainsFired: [],
    bonus: 0,
  };
  private finishing = false;
  private idleTurns = 0;
  private threat: number[][] = [];
  /** Trace sink (one line per command). */
  log: ((line: string) => void) | null = null;

  constructor(
    readonly scene: BattleScene,
    readonly p: GrindParams,
    readonly know: BattleKnowledge,
  ) {
    // a goal cell no unit can stand on never fires (거록: the gate cell (10,0) is impassable
    // terrain, so the battle is won by defeating the victory officer instead)
    const f = scene.b.s;
    if (process.env.GRIND_TRACE_HITS)
      for (const c of know.winCells) {
        const t = c.x0 < f.width && c.y0 < f.height ? terrainAt(f, c.x0, c.y0) : -1;
        console.error(`win cell ${c.x0},${c.y0} officer ${c.officer} terrain ${t} costs ${[0, 1, 2, 3].map((mt) => moveCost(mt, t)).join('/')} size ${f.width}x${f.height}`);
      }
    if (process.env.GRIND_TRACE_HITS)
      for (const u of scene.units) if (u.status !== Status.Empty) console.error(`unit ${u.slot} officer ${u.officer} at ${u.x},${u.y} status ${u.status} mode ${u.mode} flags ${u.flags}`);
    know.winCells = know.winCells.filter((c) => {
      for (let y = c.y0; y <= c.y1; y++)
        for (let x = c.x0; x <= c.x1; x++) {
          if (x >= f.width || y >= f.height) continue;
          const t = terrainAt(f, x, y);
          for (let mt = 0; mt < 4; mt++) if (moveCost(mt, t) !== 0xff) return true;
        }
      return false;
    });
    // sides of the turn events' officers: a defeat event that loses names one of ours to keep alive
    // (or an enemy never to kill); a big enemy wave late in the battle is a soft deadline
    for (const e of know.turns) {
      if (e.officer !== null && e.gameOver) {
        const s = scene.b.slotOfOfficer(e.officer);
        if (s !== NONE && s < PLAYER_SLOTS) know.guarded.add(e.officer);
        else if (s !== NONE) know.protect.add(e.officer);
      }
      if (e.turn !== null && e.turn >= 6) {
        const foes = e.reinforce.filter((o) => {
          const s = scene.b.slotOfOfficer(o);
          return s !== NONE && s >= PLAYER_SLOTS;
        }).length;
        if (foes >= 5) know.soft = Math.min(know.soft ?? 999, e.turn);
      }
    }
  }

  private looted = new Set<number>();
  /** Retreat (총퇴각, result 1) at the first player phase instead of playing. */
  retreatNow = false;

  /** Replaces the scene's player phase. Call from BattleExtras.afterSetup. */
  install(): void {
    const sc = this.scene as unknown as Record<string, unknown>;
    sc.playerPhase = () => this.playerPhase();
    if (process.env.GRIND_TRACE_HITS) {
      const real = this.scene as unknown as { doAttack: (a: number, d: number) => Promise<void>; castFlow: (s: number, t: number, p: boolean, tg?: number) => Promise<boolean> };
      const atk = real.doAttack.bind(this.scene), cast = real.castFlow.bind(this.scene);
      const L = () => this.b.slotOfOfficer(0);
      real.doAttack = async (a, d) => {
        const before = d === L() ? this.b.officerOf(this.scene.units[d]).hp : -1;
        const pred = d === L() ? this.hitOn(this.scene.units[a], this.scene.units[d], this.scene.units[d].x, this.scene.units[d].y) : 0;
        await atk(a, d);
        if (before >= 0) this.log?.(`  hit on leader by ${this.scene.units[a].officer} cls ${this.b.officerOf(this.scene.units[a]).cls} from ${this.scene.units[a].x},${this.scene.units[a].y}: ${before - this.b.officerOf(this.scene.units[d]).hp} (pred ${pred})`);
      };
      real.castFlow = async (sl, t, p, tg) => {
        const before = tg === L() ? this.b.officerOf(this.scene.units[tg]).hp : -1;
        const r = await cast(sl, t, p, tg);
        if (before >= 0) this.log?.(`  tactic ${t} on leader by ${this.scene.units[sl].officer}: ${before - this.b.officerOf(this.scene.units[tg!]).hp}`);
        return r;
      };
    }
    // which records the VM runs (for the gains fired): the 10 bytes it copies into ScriptState.record
    const ctx = this.scene.ctx;
    const run = ctx.runEvent.bind(ctx);
    ctx.runEvent = async (t) => {
      const r = await run(t);
      if (r !== 'none' && this.know.stage && this.know.block !== undefined) {
        const i = recordIndexOf(this.know.stage, this.know.block, ctx.vm.state.record);
        if (i !== null && (this.know.gains.some((g) => g.record === i) || this.know.gates.some((g) => g.record === i)) && !this.fired.has(i)) {
          this.fired.add(i);
          this.stats.gainsFired!.push(i);
          this.log?.(`gain: record ${i} fired`);
        }
      }
      this.stats.bonus = this.b.info.bonus;
      return r;
    };
  }

  private fired = new Set<number>();

  /** What a gain not yet had is worth now (0 when fired, automatic, or a way to win: the finish takes those). */
  private gainValue(g: ScriptGain): number {
    if (this.fired.has(g.record) || g.automatic || g.ends) return 0;
    const b = this.b;
    let v = 0;
    if (g.bonus > b.info.bonus) {
      let ws = 0;
      for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) if (u.status === Status.Field) ws += this.weight(u.slot);
      v += (g.bonus - b.info.bonus) * ws * 0.5;
    }
    for (const l of g.levels) {
      const s = b.slotOfOfficer(l.officer);
      const w = s !== NONE && s < PLAYER_SLOTS ? this.weight(s) : 1;
      v += l.value * 100 * w;
    }
    v += g.recruits.length * 150;
    if (g.needsFlags.length) v *= 0.5;
    return v * this.p.event;
  }

  /** Gains a unit standing at (x, y) after its action would fire (adjacency, cell, area). */
  private gainAt(u: Unit, x: number, y: number): number {
    if (!this.p.event) return 0;
    const b = this.b;
    let v = 0;
    for (const g of this.know.gains) {
      if (g.actor !== u.officer && !(g.actor === 0x400 && u.slot < PLAYER_SLOTS)) continue;
      if (g.trigger === 4 && g.other !== null) {
        const s = b.slotOfOfficer(g.other);
        if (s === NONE || this.scene.units[s].status !== Status.Field) continue;
        const o = this.scene.units[s];
        if (Math.abs(o.x - x) + Math.abs(o.y - y) !== 1) continue;
      } else if ((g.trigger === 6 || g.trigger === 11) && g.cell) {
        if (x < g.cell.x0 || x > g.cell.x1 || y < g.cell.y0 || y > g.cell.y1) continue;
      } else continue;
      v += this.gainValue(g);
    }
    return v;
  }

  /** Where a unit's best open gain is (for the pull towards it), with its value. */
  private gainGoal(u: Unit): { at: [number, number]; value: number } | null {
    if (!this.p.event) return null;
    const b = this.b;
    let best: { at: [number, number]; value: number } | null = null;
    for (const g of this.know.gains) {
      if (g.actor !== u.officer && !(g.actor === 0x400 && u.slot < PLAYER_SLOTS && g.trigger !== 4)) continue;
      const v = this.gainValue(g);
      if (v <= 0) continue;
      let at: [number, number] | null = null;
      if (g.trigger === 4 && g.other !== null) {
        const s = b.slotOfOfficer(g.other);
        if (s !== NONE && this.scene.units[s].status === Status.Field) at = [this.scene.units[s].x, this.scene.units[s].y];
      } else if ((g.trigger === 6 || g.trigger === 11) && g.cell) at = [(g.cell.x0 + g.cell.x1) >> 1, (g.cell.y0 + g.cell.y1) >> 1];
      if (at && (!best || v > best.value)) best = { at, value: v };
    }
    return best;
  }

  /** The cell of an open gate this unit should walk onto now (GrindParams.gate), or null. */
  private gateGoal(u: Unit): [number, number] | null {
    if (paramOr(this.p, 'gate') <= 0.5 || !this.know.gates.length) return null;
    const st = this.scene.ctx.vm.state;
    for (const g of this.know.gates) {
      if (g.actor !== u.officer && !(g.actor === 0x400 && u.slot < PLAYER_SLOTS)) continue;
      if (this.fired.has(g.record)) continue;
      // already brought about another way (하비: the turn-30 event lowers the bridge and brings 조조 in)
      if (g.reinforce.some((o) => {
        const sl = this.b.slotOfOfficer(o);
        return sl !== NONE && this.scene.units[sl].status === Status.Field;
      })) continue;
      if (!g.set.every((f) => getFlag(st, f)) || g.clear.some((f) => getFlag(st, f))) continue;
      const left = this.deadline() - this.b.info.turn;
      // gateLate set: at that many turns left (enemies near or not); else once none is near
      const at = paramOr(this.p, 'gateLate');
      if (!this.finishing && (at > 0 ? left > at : this.foesNear(8))) continue;
      return [(g.x0 + g.x1) >> 1, (g.y0 + g.y1) >> 1];
    }
    return null;
  }

  /**
   * 군악대 (1cb6:7cc8): at the next turn start every unit next to a class-12 unit (either side) gets
   * MP += that unit's level/10 + 1, up to its maximum. Worth about 1.3 exp per MP to a tactic user
   * (a support tactic gives +8 for 4..10 MP). A band unit values the tactic users next to it.
   */
  private bandValue(u: Unit, x: number, y: number, w: number): number {
    const b = this.b;
    const o = b.officerOf(u);
    const learned = (oo: typeof o) => b.learn.some((lv, i) => i % CLASS_COUNT === oo.cls && lv <= oo.level);
    let v = 0;
    for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
      if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
      const s = unitAt(b.s, nx, ny);
      if (s === NONE || s === u.slot) continue;
      const N = this.scene.units[s];
      if (N.status !== Status.Field || N.officer === 0xffff) continue;
      const on = b.officerOf(N);
      if (on.cls === 12 && learned(o)) v += Math.min(Math.trunc(on.level / 10) + 1, Math.max(0, maxMp(o) - u.mp)) * 1.3 * w;
      if (o.cls === 12 && s < PLAYER_SLOTS && learned(on)) v += Math.min(Math.trunc(o.level / 10) + 1, Math.max(0, maxMp(on) - N.mp)) * 1.3 * this.weight(s);
    }
    return v * this.p.band;
  }

  /** Mean level of the enemy units on the field. */
  private enemyLevel(): number {
    let n = 0, s = 0;
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const e = this.scene.units[i];
      if (e.status !== Status.Field || e.officer === 0xffff) continue;
      s += this.b.officerOf(e).level;
      n++;
    }
    return n ? s / n : 1;
  }

  /** A defeat event (trigger 12) of this enemy gives something. */
  private killGain(officer: number): number {
    let v = 0;
    for (const g of this.know.gains) if (g.trigger === 12 && g.actor === officer && !this.know.protect.has(officer)) v += this.gainValue(g);
    return v;
  }

  /** Enemy slot -> the damage the leader can do to it this phase from a cell within its guard. */
  private leaderKills = new Map<number, number>();
  private leaderActed = false;
  private leaderSeen: { hp: number; dw: number } | null = null;

  private buildLeaderKills() {
    this.leaderKills.clear();
    this.leaderActed = false;
    if (!this.p.feed || this.finishing) return;
    const b = this.b;
    const ls = b.slotOfOfficer(0);
    if (ls === NONE || ls >= PLAYER_SLOTS) return;
    const L = this.scene.units[ls];
    if (!this.controllable(L) || L.flags & UnitFlag.Acted) return;
    const o = b.officerOf(L);
    const range = CLASS_RANGE[o.cls];
    if (range === NONE) return;
    const home: [number, number] = [L.x, L.y];
    const at = L.y * b.width + L.x;
    b.s.unitAt[at] = NONE;
    this.buildThreat();
    b.s.unitAt[at] = ls;
    for (const [x, y] of this.reachable(L)) {
      b.place(ls, null, x, y);
      const d = this.danger(L, x, y);
      if (d.worst > o.hp * this.p.guard) continue;
      for (const e of unitsInRange(b.s, L, range, x, y, false)) {
        const E = this.scene.units[e];
        if (!(E.flags & UnitFlag.Visible) || this.know.protect.has(E.officer)) continue;
        const oe = b.officerOf(E);
        const dmg = physicalDamage({
          attack: attackPower(o, L.morale, b.s.items),
          defence: defencePower(oe, E.morale, b.s.items),
          attackerClass: o.cls,
          defenderClass: oe.cls,
          defenderTerrain: terrainAt(b.s, E.x, E.y),
          defenderHp: oe.hp,
          counter: false,
        });
        this.leaderKills.set(e, Math.max(this.leaderKills.get(e) ?? 0, dmg));
      }
    }
    b.place(ls, null, home[0], home[1]);
  }

  private get b() {
    return this.scene.b;
  }

  private weight(slot: number): number {
    const u = this.scene.units[slot];
    if (u.officer >= 0x100) return 0;
    const o = this.b.officerOf(u);
    if (o.level >= 99) return 0;
    return 1 + (this.p.need * (99 - o.level)) / 98;
  }

  private controllable(u: Unit): boolean {
    return u.status === Status.Field && u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted);
  }

  /**
   * The leader is all that is left to win with: no other unit of ours under our control on the
   * field with a quarter of its troops, and no turn event that ends the battle in our favour.
   */
  private leaderAlone(L: Unit): boolean {
    if (this.know.endsAt !== null) return false;
    for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) {
      if (u.slot === L.slot || !this.controllable(u)) continue;
      const o = this.b.officerOf(u);
      if (o.hp * 4 >= maxHp(o)) return false;
    }
    return true;
  }

  private enemiesOnField(): number {
    let n = 0;
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) if (this.scene.units[i].status === Status.Field) n++;
    return n;
  }

  private oursOnField(): number {
    let n = 0;
    for (let i = 0; i < PLAYER_SLOTS; i++) if (this.scene.units[i].status === Status.Field) n++;
    return n;
  }

  /** A duel / persuasion with this enemy is still to come (its actor on the field): it gives levels or a recruit, a kill would waste it. */
  private duelPending(off: number): boolean {
    if (this.deadline() - this.b.info.turn <= 2) return false;
    for (const g of this.know.gains) {
      if ((g.kind !== 'duel' && g.kind !== 'persuade') || g.other !== off || this.fired.has(g.record)) continue;
      if (g.actor === 0x400) return true;
      const s = g.actor !== null ? this.b.slotOfOfficer(g.actor) : NONE;
      if (s !== NONE && s < PLAYER_SLOTS && this.scene.units[s].status === Status.Field) return true;
    }
    return false;
  }

  /** The victory officer is below 70% of its troops (it may fall to a counter any time). */
  private victoryWorn(): boolean {
    const v = this.know.victory;
    const s = v === null ? NONE : this.b.slotOfOfficer(v);
    if (s === NONE || this.scene.units[s].status !== Status.Field) return false;
    const o = this.b.officerOf(this.scene.units[s]);
    return o.hp < maxHp(o) * 0.7;
  }

  /** The victory officer kept alive for the bonus walk-in. */
  private spared(off: number): boolean {
    return off === this.know.victory && this.bonusCell() !== null && this.bonusOn();
  }

  private killOk(target: number): boolean {
    const off = this.scene.units[target].officer;
    if (this.duelPending(off)) return false;
    if (off === this.know.victory && this.bonusOn()) return false;
    if (this.p.spareBand > 0.5 && !this.finishing && this.b.officerOf(this.scene.units[target]).cls === 12 && this.ourTacticUsers() > 0) return false;
    // the band farm keeps the enemy 군악대 (their MP is the renewable exp)
    if (!this.finishing && this.bandKeep.has(target)) return false;
    if (this.finishing) return !(this.endHeld() && this.endsBattle(target)) && (this.charge() || !this.know.protect.has(off));
    if (this.know.protect.has(off)) return false;
    // regrouping: kill what comes (the leader still spared)
    if (this.regroupUntil >= this.b.info.turn + 1) return true;
    // bracing against a wave: thin it while it outnumbers us (the grinding resumes on what is left)
    if (this.bracing() && this.enemiesOnField() > this.oursOnField()) return true;
    return this.enemiesOnField() - 1 >= this.p.keep;
  }

  private deadline(): number {
    const lim = this.b.info.turnLimit;
    // the soft deadline (finish before a big wave: 하비 finished from turn 2) is gone: the waves are
    // braced for and survived while grinding (Sukwon), know.soft stays for the report
    return Math.min(lim, this.know.deadline ?? 999, this.know.endsAt ?? 999);
  }

  // ---- hold the end (GrindParams.endHold): the battle-ending blow waits for the last turns

  /** endHeld() at the start of the search phase (a rollout's win is judged by it). */
  private srHeld = false;
  private endHeldMemo: { turn: number; v: boolean } | null = null;

  /**
   * The blow that ends the battle waits (while grinding too: the leader's own kill of the last
   * enemy, the hurt actor's ending duel): the turns left above what the ending needs (finishEstimate) plus endSpare,
   * and the leader (the defeat officer) above half its troops. Not for the plans with their own
   * timing (escape / bonus walk-in, 회남, the scripted steps) nor for the emergency finishes.
   */
  private endHeld(): boolean {
    if (paramOr(this.p, 'endHold') <= 0.5 || this.p.native) return false;
    const r = this.finishing ? this.stats.finishReason : undefined;
    if (r === 'leader' || r === 'losses' || r === 'escape' || r === 'native') return false;
    if (this.stepsLeft() > 0 || this.exitPlan || this.hnOn()) return false;
    const b = this.b;
    const t = b.info.turn;
    if (this.endHeldMemo && this.endHeldMemo.turn === t) return this.endHeldMemo.v;
    let v = this.enemiesOnField() > 0;
    for (const off of this.know.guarded) {
      const sl = b.slotOfOfficer(off);
      if (!v || sl === NONE || sl >= PLAYER_SLOTS) continue;
      const u = this.scene.units[sl];
      if (u.status !== Status.Field) continue;
      const o = b.officerOf(u);
      // (badly hurt, or a blow away from it where it stands: the end comes now)
      if (o.hp * 100 < maxHp(o) * 35 || (o.hp * 2 < maxHp(o) && this.danger(u, u.x, u.y).worst >= o.hp * 0.6)) v = false;
    }
    if (v) v = this.deadline() - t > this.finishEstimate() + paramOr(this.p, 'endSpare');
    if (!v && this.log && this.endHeldMemo?.v !== false) this.log(`end: released at turn ${t + 1} (${this.deadline() - t} turns left)`);
    this.endHeldMemo = { turn: t, v };
    return v;
  }

  /** Defeating this enemy ends the battle: the victory officer (or a protected one), or the last enemy on the field. */
  private endsBattle(target: number): boolean {
    const off = this.scene.units[target].officer;
    const v = this.victoryNow();
    if ((v !== null && off === v) || this.know.protect.has(off)) return true;
    return this.enemiesOnField() <= 1;
  }

  // ---- let them mend (GrindParams.nurse): the healing cells a weakened enemy we keep can reach stay free

  /** Cells (y*width+x) kept free this phase, or null. */
  private nurse: Uint8Array | null = null;

  /** Milking (GrindParams.milk): our side has slack this phase. */
  private slack = false;
  /** Enemy slots spared for milking this phase (they can mend). */
  private milkable = new Set<number>();
  /** Enemy slot -> the best weighted hit exp a unit of ours that can reach it this phase earns from it. */
  private bestHit = new Map<number, number>();

  private buildNurse() {
    this.nurse = null;
    this.slack = false;
    this.milkable.clear();
    this.bestHit.clear();
    if (this.p.native || this.hnOn() || this.exitPlan) return;
    if (this.finishing && !this.endHeld()) return;
    const b = this.b;
    const W = b.width, H = b.height;
    const turn = b.info.turn + 1;
    // slack: the enemies weak next to us, no wave due in the next 3 turns, the guarded officers in shape
    let slack = this.enemiesOnField() > 0 && this.sideStrength(false) <= this.sideStrength(true) * paramOr(this.p, 'milkRatio');
    if (slack)
      for (const e of this.know.turns) {
        if (e.turn === null || e.turn < turn || e.turn > turn + 3) continue;
        const foes = e.reinforce.filter((o) => {
          const sl = b.slotOfOfficer(o);
          return sl === NONE || sl >= PLAYER_SLOTS;
        }).length;
        if (foes >= 2) slack = false;
      }
    if (slack)
      for (const off of this.know.guarded) {
        const sl = b.slotOfOfficer(off);
        if (sl === NONE || sl >= PLAYER_SLOTS || this.scene.units[sl].status !== Status.Field) continue;
        const o = b.officerOf(this.scene.units[sl]);
        if (o.hp < maxHp(o) * 0.6) slack = false;
      }
    this.slack = slack;
    if (slack && paramOr(this.p, 'steer') > 0) {
      for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) {
        if (!this.controllable(u) || u.officer >= 0x100) continue;
        const o = b.officerOf(u);
        if (CLASS_RANGE[o.cls] === NONE) continue;
        const far = movePoints(o, b.s.items) + (CLASS_RANGE[o.cls] === 0 ? 1 : 2);
        const w = this.weight(u.slot) * (this.know.guarded.has(u.officer) ? 2 : 1);
        for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
          const E = this.scene.units[i];
          if (E.status !== Status.Field || E.officer === 0xffff || Math.abs(E.x - u.x) + Math.abs(E.y - u.y) > far) continue;
          const v = w * combatExp(true, o.level, b.officerOf(E).level, false, i);
          if (v > (this.bestHit.get(i) ?? 0)) this.bestHit.set(i, v);
        }
      }
    }
    const nurseOn = paramOr(this.p, 'nurse') > 0.5;
    const milkOn = slack && paramOr(this.p, 'milk') > 0;
    if (!nurseOn && !milkOn) return;
    const cells: [number, number][] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const t = b.s.terrain[y * W + x];
        if (t !== TERRAIN_VILLAGE && t !== TERRAIN_FORTRESS && t !== TERRAIN_BARRACKS) continue;
        const s2 = unitAt(b.s, x, y);
        if (s2 !== NONE && s2 >= PLAYER_SLOTS) continue;
        cells.push([x, y]);
      }
    // enemies that can hit 유비 / the defeat officer or a hurt unit of ours next phase are fought as before
    const hot = (i: number) => {
      for (const a of this.scene.units.slice(0, PLAYER_SLOTS)) {
        if (a.status !== Status.Field || a.officer === 0xffff) continue;
        const oa = b.officerOf(a);
        if (!this.know.guarded.has(a.officer) && oa.hp >= maxHp(oa) * 0.6) continue;
        if ((this.threat[a.y * W + a.x] ?? []).includes(i)) return true;
      }
      return false;
    };
    let m: Uint8Array | null = null;
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const E = this.scene.units[i];
      if (E.status !== Status.Field || E.officer === 0xffff) continue;
      const kept = !this.killOk(i) || (this.endHeld() && this.endsBattle(i));
      if (!kept && !(milkOn && !hot(i))) continue;
      if (this.healCell(E)) {
        // on a healing cell already: it comes back by itself
        if (!kept && milkOn) this.milkable.add(i);
        continue;
      }
      if (E.mode === AiMode.Hold || !cells.length) continue;
      const oe = b.officerOf(E);
      const mp = movePoints(oe, b.s.items);
      const mt = moveTypeOf(b.s, E);
      const near = cells.filter((c) => this.pathDist(c, mt, E.x, E.y) <= mp + 2);
      if (!near.length) continue;
      if (!kept && milkOn) this.milkable.add(i);
      // the AI's weak test (1cb6:c280): troops <= 2*(max/5) or morale < 40; its cells are kept free
      if (!nurseOn || !(Math.trunc(maxHp(oe) / 5) * 2 >= oe.hp || E.morale < 40)) continue;
      for (const c of near) {
        m ??= new Uint8Array(W * H);
        m[c[1] * W + c[0]] = 1;
      }
    }
    this.nurse = m;
    if (this.log && (m || this.milkable.size)) this.log(`milk: slack ${slack ? 1 : 0}, ${this.milkable.size} spared, ${m ? m.reduce((a, c) => a + c, 0) : 0} healing cells kept free at turn ${turn}`);
  }

  // ---- fish pen (GrindParams.pen): box one enemy in and farm it until the last turns

  /** The penned enemy's slot this phase (NONE: no pen). */
  private pen = NONE;
  /** The officer penned last (kept while it stays a fair pick). */
  private penOfficer = -1;
  /** Price per troop point of the pen (exp per damage of the first blow its troops do not cover). */
  private penLam = 0;
  /** Troops the pen keeps back for the counters of our units next to it (1cb6:e42e, half damage). */
  private penReserve = 0;
  /** Box it in (stand on its sides); off while it may walk to a healing cell kept free for it. */
  private penBox = false;
  /** The pen at the start of the search phase (a rollout that loses it is scored down). */
  private srPen = NONE;
  /** Healing cells kept free for the penned enemy to walk to (y*width+x), or null. */
  private penFree: Uint8Array | null = null;

  /** Free healing cells (village, fortress, barracks) enemy E can walk to this phase or the next (not in 부동 / 대기). */
  private penMendCells(E: Unit): [number, number][] {
    if (E.mode === AiMode.Hold || E.mode === AiMode.Wait) return [];
    const b = this.b;
    const W = b.width;
    const oe = b.officerOf(E);
    const mp = movePoints(oe, b.s.items);
    const mt = moveTypeOf(b.s, E);
    const out: [number, number][] = [];
    for (let y = Math.max(0, E.y - mp - 2); y <= Math.min(b.height - 1, E.y + mp + 2); y++)
      for (let x = Math.max(0, E.x - mp - 2); x <= Math.min(W - 1, E.x + mp + 2); x++) {
        const t = b.s.terrain[y * W + x];
        if (t !== TERRAIN_VILLAGE && t !== TERRAIN_FORTRESS && t !== TERRAIN_BARRACKS) continue;
        const s2 = unitAt(b.s, x, y);
        if (s2 !== NONE && s2 >= PLAYER_SLOTS) continue;
        if (this.pathDist([x, y], mt, E.x, E.y) <= mp + 2) out.push([x, y]);
      }
    return out;
  }

  private penOn(): boolean {
    if (paramOr(this.p, 'pen') <= 0.5 || this.p.native || this.hnOn()) return false;
    const st = this.know.stage;
    if (st && paramOr(this.p, 'yjEscape') > 0.5 && isYeonjuAt(st.chapter, st.index, this.know.block)) return false;
    return true;
  }

  /** Physical damage of our unit u on enemy E where they stand (counter: halved). */
  private blowOn(u: Unit, E: Unit, counter = false): number {
    const b = this.b;
    const o = b.officerOf(u), oe = b.officerOf(E);
    return physicalDamage({
      attack: attackPower(o, u.morale, b.s.items),
      defence: defencePower(oe, E.morale, b.s.items),
      attackerClass: o.cls,
      defenderClass: oe.cls,
      defenderTerrain: terrainAt(b.s, E.x, E.y),
      defenderHp: 0xffff,
      counter,
    });
  }

  /** A non-lethal blow of `loss` morale on E drives it off the field (confused at 0 morale, 1cb6:898c / a0d0). */
  private moraleLeaves(E: Unit, loss: number): boolean {
    const m = E.morale - loss;
    return m <= 0 && ((E.flags & UnitFlag.Confused) !== 0 || (loss > 0 && m < 30));
  }

  /** Our units that take part in the pen: controllable named officers in shape (half their troops). */
  private penUnits(): Unit[] {
    const b = this.b;
    return this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => this.controllable(u) && u.officer < 0x100 && b.officerOf(u).hp * 2 >= maxHp(b.officerOf(u)));
  }

  private buildPen() {
    const prev = this.pen;
    this.pen = NONE;
    this.penLam = 0;
    this.penReserve = 0;
    this.penBox = false;
    this.penFree = null;
    if (!this.penOn() || this.finishing) return;
    const b = this.b;
    const turn = b.info.turn + 1;
    if (turn < 2 || this.enemiesOnField() === 0) return;
    // no wave due in the next 2 turns
    for (const e of this.know.turns) {
      if (e.turn === null || e.turn < turn || e.turn > turn + 2) continue;
      const foes = e.reinforce.filter((o) => {
        const sl = b.slotOfOfficer(o);
        return sl === NONE || sl >= PLAYER_SLOTS;
      }).length;
      if (foes >= 2) return;
    }
    // the guarded officers in shape
    for (const off of this.know.guarded) {
      const sl = b.slotOfOfficer(off);
      if (sl === NONE || sl >= PLAYER_SLOTS || this.scene.units[sl].status !== Status.Field) continue;
      const o = b.officerOf(this.scene.units[sl]);
      if (o.hp < maxHp(o) * 0.5) return;
    }
    const ours = this.penUnits();
    if (ours.length < 2) return;
    const left = Math.max(1, this.deadline() - b.info.turn - this.p.finish);
    const so = this.sideStrength(true);
    const se = this.sideStrength(false);
    const anc = this.holding() ? this.anchorNow() : null;
    let best = NONE, bv = -1e9;
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const E = this.scene.units[i];
      if (E.status !== Status.Field || E.officer === 0xffff || !(E.flags & UnitFlag.Visible) || E.flags & UnitFlag.Scripted) continue;
      const oe = b.officerOf(E);
      // the others weak next to us
      const own = (oe.level + 5) * (oe.hp / Math.max(1, maxHp(oe)));
      if (se - own > so * paramOr(this.p, 'penRatio')) continue;
      // harmless enough: its blow on our units, on average, a small share of their troops
      let harm = 0, ev = 0, near = 99;
      for (const u of ours) {
        const o = b.officerOf(u);
        if (CLASS_RANGE[oe.cls] !== NONE) harm += this.hitOn(E, u, u.x, u.y) / Math.max(1, maxHp(o));
        const w = this.weight(u.slot) * (this.know.guarded.has(u.officer) ? 2 : 1);
        if (CLASS_RANGE[o.cls] !== NONE) ev += w * combatExp(true, o.level, oe.level, false, i);
        const mp = Math.max(1, movePoints(o, b.s.items));
        near = Math.min(near, Math.ceil(Math.max(0, this.pathDist([E.x, E.y], moveTypeOf(b.s, u), u.x, u.y) - 1) / mp));
      }
      harm /= ours.length;
      if (process.env.GRIND_TRACE_PEN) this.log?.(`  pen? ${E.officer} L${oe.level} hp ${oe.hp} harm ${harm.toFixed(2)} near ${near} others ${(se - own).toFixed(0)}/${so.toFixed(0)}`);
      if (harm > paramOr(this.p, 'penHarm')) continue;
      if (near > 4) continue;
      if (anc && Math.abs(anc[0] - E.x) + Math.abs(anc[1] - E.y) > 8) continue;
      // troops to farm: what the blows can take before the counter reserve, plus what a healing cell
      // brings back (150..250 a turn, 1cb6:7cc8): on one, or one it can walk to when weak (1cb6:c280)
      const mend = this.healCell(E) ? 1 : this.penMendCells(E).length ? 0.6 : 0;
      const room = Math.min(1, oe.hp / Math.max(1, maxHp(oe))) + mend * Math.min(3, (200 * left) / Math.max(1, maxHp(oe)));
      let v = ev * room - 4 * near - 20 * harm;
      // a 군악대 cannot hit back and gives its neighbours MP (1cb6:7cc8)
      if (oe.cls === 12) v += 10;
      // the band farm: a kept enemy band is the pen (boxed in, it neither walks off nor falls)
      if (this.bandFarming && this.bandKeep.has(i)) v += paramOr(this.p, 'bfPen');
      if (E.officer === this.penOfficer) v += 15;
      if (v > bv) [bv, best] = [v, i];
    }
    if (best === NONE) {
      if (prev !== NONE && this.log) this.log(`pen: off at turn ${turn}`);
      return;
    }
    const T = this.scene.units[best];
    const ot = b.officerOf(T);
    // our counters (attack type 0 units hit back at types 0 / 2 / 5) may finish it in its phase
    const at = CLASS_ATTACK_TYPE[ot.cls];
    let reserve = 0;
    if (at === 0 || at === 2 || at === 5)
      for (const u of ours) if (CLASS_ATTACK_TYPE[b.officerOf(u).cls] === 0) reserve = Math.max(reserve, this.blowOn(u, T, true));
    // the price: units by exp per damage point, each blow once a turn over the pen's turns (about
    // half of them in reach); the first unit the troops do not cover sets it
    const onHeal = this.healCell(T);
    const mendAt = onHeal ? [] : this.penMendCells(T);
    const pool = ot.hp - reserve + (onHeal ? 200 * left : mendAt.length ? 120 * left : 0);
    const rs = ours
      .filter((u) => CLASS_RANGE[b.officerOf(u).cls] !== NONE)
      .map((u) => {
        const d = Math.max(1, this.blowOn(u, T));
        const w = this.weight(u.slot) * (this.know.guarded.has(u.officer) ? 2 : 1);
        return { d, r: (w * combatExp(true, b.officerOf(u).level, ot.level, false, best)) / d };
      })
      .sort((x, y) => y.r - x.r);
    let cum = 0, lam = 0;
    for (let j = 0; j < rs.length; j++) {
      cum += rs[j].d * left * 0.5;
      if (cum > pool) {
        lam = j + 1 < rs.length ? rs[j + 1].r : 0;
        break;
      }
    }
    this.pen = best;
    this.penOfficer = T.officer;
    this.penLam = lam * paramOr(this.p, 'penPrice');
    this.penReserve = reserve;
    // weak (1cb6:c280: troops <= 2*(max/5) or morale < 40) next to a free healing cell: it walks
    // there by itself; the cells stay free and it is boxed in once on one
    const weak = Math.trunc(maxHp(ot) / 5) * 2 >= ot.hp || T.morale < 40;
    this.penBox = onHeal || !weak || !mendAt.length;
    this.penFree = null;
    if (!this.penBox) {
      this.penFree = new Uint8Array(b.width * b.height);
      for (const [x, y] of mendAt) this.penFree[y * b.width + x] = 1;
    }
    if (this.log && (prev !== best || turn % 5 === 0)) this.log(`pen: ${T.officer} L${ot.level} c${ot.cls} hp ${ot.hp} mor ${T.morale} at ${T.x},${T.y} turn ${turn}, price ${this.penLam.toFixed(3)}, reserve ${reserve}, box ${this.penBox ? 1 : 0}`);
  }

  /** The pen is up (from the last phase's pick: the finish checks it before the phase's maps are built). */
  private penning(): boolean {
    return this.pen !== NONE && this.scene.units[this.pen].status === Status.Field;
  }

  // ---- band farm (GrindParams.bandFarm): the 군악대's MP turned into flat-rate tactic exp

  /** Enemy 군악대 slots kept alive this phase (never killed, never driven off by morale). */
  private bandKeep = new Set<number>();
  /** The band farm runs this phase (safe): casters spend MP freely and the short ones stand next to a band. */
  private bandFarming = false;
  /** 군악대 slots on the field (either side) the casters gather around this phase. */
  private bands: number[] = [];
  /** The kept bands at the start of the search phase (a rollout that loses one is scored down). */
  private srBands = new Set<number>();

  private bandOn(): boolean {
    if (paramOr(this.p, 'bandFarm') <= 0.5 || this.p.native || this.hnOn()) return false;
    const st = this.know.stage;
    if (st && paramOr(this.p, 'yjEscape') > 0.5 && isYeonjuAt(st.chapter, st.index, this.know.block)) return false;
    return true;
  }

  /** u knows a flat-rate tactic at its level (confusion / morale 15..20, heals 21..35). */
  private knowsFlat(u: Unit): boolean {
    if (u.officer >= 0x100) return false;
    const o = this.b.officerOf(u);
    for (let t = 15; t < 36; t++) if (this.b.learn[t * CLASS_COUNT + o.cls] <= o.level) return true;
    return false;
  }

  /** MP a unit standing at (x, y) gets from the bands next to it at the next turn start (1cb6:7cc8), up to what it lacks. */
  private bandGain(u: Unit, x: number, y: number, spend = 0): number {
    const b = this.b;
    const o = b.officerOf(u);
    let g = 0;
    for (const s of this.bands) {
      if (s === u.slot) continue;
      const B = this.scene.units[s];
      if (B.status !== Status.Field || Math.abs(B.x - x) + Math.abs(B.y - y) !== 1) continue;
      g += Math.trunc(b.officerOf(B).level / 10) + 1;
    }
    return Math.min(g, Math.max(0, maxMp(o) - u.mp + spend));
  }

  private buildBand() {
    this.bandKeep.clear();
    this.bands = [];
    const was = this.bandFarming;
    this.bandFarming = false;
    if (!this.bandOn() || this.finishing) return;
    const b = this.b;
    const turn = b.info.turn + 1;
    const casters = this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => this.controllable(u) && this.knowsFlat(u));
    if (!casters.length) return;
    // emergencies: regrouping, or bracing against a wave that outnumbers us (kill what comes)
    const emergency = this.regroupUntil >= turn || (this.bracing() && this.enemiesOnField() > this.oursOnField());
    let keptStrength = 0;
    for (const u of this.scene.units) {
      if (u.status !== Status.Field || u.officer === 0xffff || b.officerOf(u).cls !== 12) continue;
      if (u.slot < PLAYER_SLOTS) {
        this.bands.push(u.slot);
        continue;
      }
      if (!(u.flags & UnitFlag.Visible) || u.flags & UnitFlag.Scripted || this.know.protect.has(u.officer)) continue;
      this.bands.push(u.slot);
      if (!emergency) {
        this.bandKeep.add(u.slot);
        const o = b.officerOf(u);
        keptStrength += (o.level + 5) * (o.hp / Math.max(1, maxHp(o)));
      }
    }
    if (!this.bands.length) return;
    // safe: the other enemies weak next to us, no wave due in the next 2 turns, the guarded officers in shape
    let safe = !emergency && this.sideStrength(false) - keptStrength <= this.sideStrength(true) * paramOr(this.p, 'bfRatio');
    if (safe)
      for (const e of this.know.turns) {
        if (e.turn === null || e.turn < turn || e.turn > turn + 2) continue;
        const foes = e.reinforce.filter((o) => {
          const sl = b.slotOfOfficer(o);
          return sl === NONE || sl >= PLAYER_SLOTS;
        }).length;
        if (foes >= 2) safe = false;
      }
    if (safe)
      for (const off of this.know.guarded) {
        const sl = b.slotOfOfficer(off);
        if (sl === NONE || sl >= PLAYER_SLOTS || this.scene.units[sl].status !== Status.Field) continue;
        const o = b.officerOf(this.scene.units[sl]);
        if (o.hp < maxHp(o) * 0.5) safe = false;
      }
    if (process.env.GRIND_TRACE_BAND) this.log?.(`  band? turn ${turn} se ${this.sideStrength(false).toFixed(0)} kept ${keptStrength.toFixed(0)} so ${this.sideStrength(true).toFixed(0)} safe ${safe ? 1 : 0} bands ${this.bands.map((s) => `${this.scene.units[s].officer}@${this.scene.units[s].x},${this.scene.units[s].y} m${this.scene.units[s].mode}`).join(' ')}`);
    if (!safe && paramOr(this.p, 'bfSpare') <= 0.5) this.bandKeep.clear();
    this.bandFarming = safe;
    if (safe && !this.inRollout) this.stats.bandTurns = (this.stats.bandTurns ?? 0) + 1;
    if (this.log && (safe !== was || (safe && turn % 5 === 0)))
      this.log(`band: ${safe ? 'farm' : 'off'} at turn ${turn}, bands ${this.bands.map((s) => `${this.scene.units[s].officer}@${this.scene.units[s].x},${this.scene.units[s].y}`).join(' ')}, kept ${this.bandKeep.size}, casters ${casters.length}`);
  }

  // ---- hold plan: form up near the start, let the enemy come, push out once the waves are broken

  private anchor: [number, number] | null = null;
  private quietTurns = 0;
  private holdBroken = false;
  private holding(): boolean {
    return (this.p.hold > 0.5 && !this.holdBroken) || this.bracing();
  }
  /** The cell the formation gathers around: the brace anchor while bracing, else the hold anchor. */
  private anchorNow(): [number, number] | null {
    return this.bracing() ? this.braceAnchor : this.anchor;
  }

  // ---- brace: a wave is coming (or units are falling): form up on defensible ground around 유비

  private waves: { turn: number; n: number; at: [number, number][] }[] | null = null;
  private braceUntil = 0;
  private braceAnchor: [number, number] | null = null;
  private regroupUntil = 0;
  private bracing(): boolean {
    if (this.exitPlan && !this.finishing) return true;
    const t = this.b.info.turn + 1;
    return this.braceAnchor !== null && ((this.p.brace > 0.5 && this.braceUntil >= t) || this.regroupUntil >= t);
  }
  private updateBrace() {
    if (!(this.p.brace > 0.5) || this.finishing) return;
    const b = this.b;
    const turn = b.info.turn + 1;
    const units = this.scene.units;
    if (this.waves === null) {
      this.waves = [];
      for (const e of this.know.turns) {
        if (e.turn === null || e.turn < 2) continue;
        const at: [number, number][] = [];
        for (const off of e.reinforce) {
          const i = b.slotOfOfficer(off);
          if (i === NONE || i < PLAYER_SLOTS) continue;
          const rec = this.scene.ctx.vm.state.units.find((d) => d.officer === off);
          if (rec && rec.x < b.width && rec.y < b.height) at.push([rec.x, rec.y]);
        }
        if (at.length >= 4) this.waves.push({ turn: e.turn, n: at.length, at });
      }
      if (this.waves.length) this.log?.(`brace: waves ${this.waves.map((w) => `T${w.turn}x${w.n}`).join(' ')}`);
    }
    // the latest the bracing may hold: the finish needs its turns at the end
    const cap = Math.min(b.info.turnLimit, this.know.deadline ?? 999) - this.p.finish - 4 - this.stepsLeft() * 12;
    const ahead = Math.round(0.5 + this.p.brace);
    let until = this.braceUntil;
    for (const w of this.waves) if (turn >= w.turn - ahead && turn <= w.turn) until = Math.max(until, w.turn + 2);
    const mine = units.slice(0, PLAYER_SLOTS).filter((u) => u.officer < 0x100 && u.status !== Status.Empty && u.status !== Status.Reserve);
    const ours = mine.filter((u) => u.status === Status.Field).length;
    const theirs = this.enemiesOnField();
    // a wave still heavy: keep the formation while they outnumber us and are close
    const waveOn = this.waves.some((w) => turn >= w.turn && turn <= w.turn + 6);
    if (waveOn && until === turn && this.braceAnchor && theirs >= ours * 1.5) {
      const [ax, ay] = this.braceAnchor;
      if (units.slice(PLAYER_SLOTS).some((e) => e.status === Status.Field && Math.abs(e.x - ax) + Math.abs(e.y - ay) <= 7)) until = turn + 1;
    }
    until = Math.min(until, cap);
    const was = this.bracing();
    this.braceUntil = until;
    if (until >= turn && (!was || !this.braceAnchor)) {
      this.braceAnchor = this.pickBraceAnchor();
      if (this.braceAnchor) this.log?.(`brace: T${turn}..T${until} at ${this.braceAnchor[0]},${this.braceAnchor[1]}`);
    }
  }
  /**
   * Where to brace: a cell 유비 reaches in about two turns whose surroundings are defensive terrain,
   * narrow (fewer open sides: chokepoints, map edges, rivers) and away from the enemy and the wave's
   * entry cells; healing terrain nearby counts too.
   */
  private pickBraceAnchor(): [number, number] | null {
    const b = this.b;
    const W = b.width, H = b.height;
    const ls = b.slotOfOfficer(0);
    const L = ls !== NONE ? this.scene.units[ls] : null;
    if (!L || L.status !== Status.Field) return null;
    const mt = moveTypeOf(b.s, L);
    const mp = movePoints(b.officerOf(L), b.s.items);
    const pass = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && moveCost(mt, b.s.terrain[y * W + x]) !== 0xff;
    const foes: [number, number][] = [];
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) if (e.status === Status.Field && e.officer !== 0xffff) foes.push([e.x, e.y]);
    const turn = b.info.turn + 1;
    for (const w of this.waves ?? []) if (w.turn >= turn) foes.push(...w.at);
    let best: [number, number] | null = null, bv = -1e9;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!pass(x, y)) continue;
        const d = this.pathDist([L.x, L.y], mt, x, y);
        if (d > mp * 2 + 2) continue;
        let open = 0, def = 0, cells = 0, heal = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const r = Math.abs(dx) + Math.abs(dy);
            if (r > 2 || !pass(x + dx, y + dy)) continue;
            const t = b.s.terrain[(y + dy) * W + x + dx];
            open++;
            if (r <= 1) {
              cells++;
              def += Math.min(30, terrainDefence(t));
            }
            if (t === TERRAIN_VILLAGE || t === TERRAIN_FORTRESS || t === TERRAIN_BARRACKS) heal++;
          }
        let near = 99;
        for (const [fx, fy] of foes) near = Math.min(near, Math.abs(fx - x) + Math.abs(fy - y));
        if (near <= 2) continue;
        const v = (def / Math.max(1, cells)) / 5 * this.p.terrain - 0.25 * open + heal * 1.5 + 0.5 * Math.min(near, 12) - 0.4 * Math.max(0, d - mp);
        if (v > bv) [bv, best] = [v, [x, y]];
      }
    return best;
  }
  private updateHold() {
    if (this.p.hold <= 0.5 || this.holdBroken) return;
    const b = this.b;
    const mine = this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && this.controllable(u));
    if (!this.anchor) {
      if (!mine.length) return;
      // the middle of our formation, snapped to a cell our units can stand on
      const cx = Math.round(mine.reduce((a, u) => a + u.x, 0) / mine.length), cy = Math.round(mine.reduce((a, u) => a + u.y, 0) / mine.length);
      let best: [number, number] = [mine[0].x, mine[0].y], bd = 1e9;
      for (let y = 0; y < b.height; y++)
        for (let x = 0; x < b.width; x++) {
          const t = terrainAt(b.s, x, y);
          if ([0, 1, 2, 3].every((mt) => moveCost(mt, t) === 0xff)) continue;
          const d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d < bd) [bd, best] = [d, [x, y]];
        }
      this.anchor = best;
    }
    const turn = b.info.turn + 1;
    const near = this.scene.units.slice(PLAYER_SLOTS).some((e) => e.status === Status.Field && Math.abs(e.x - this.anchor![0]) + Math.abs(e.y - this.anchor![1]) <= 7);
    this.quietTurns = near ? 0 : this.quietTurns + 1;
    // broken: the wave turn is past and nobody came near for 2 turns; or time is short for the push
    const waveDone = turn > (this.know.soft ?? 0) + 1;
    if ((waveDone && this.quietTurns >= 2) || turn >= b.info.turnLimit - 10) {
      this.holdBroken = true;
      this.log?.(`hold: pushing out at turn ${turn}`);
    }
  }

  // ---- player phase (1cb6:44de without the input loop)

  private async playerPhase() {
    const sc = this.scene;
    const b = this.b;
    this.stats.turns = b.info.turn + 1;
    // 총퇴각 is refused in formation-flag battles: no reroll there
    if (this.retreatNow && b.formation) this.retreatNow = false;
    if (this.p.native && !this.retreatNow) {
      // the computer plays our units from here on (computerPhases pass 0); units that join later
      // are handed over at the next player phase, before anything is drawn
      // the guarded officers (유비, the defeat officer) stay with the policy: the game's AI would
      // park 유비 in 대기 and walk it into the first enemy that comes in reach (거록, every try)
      for (let i = 0; i < PLAYER_SLOTS; i++) {
        const u = sc.units[i];
        if (u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted) && !this.know.guarded.has(u.officer)) u.mode = AiMode.AttackNearest;
      }
      if (!this.finishing) {
        this.finishing = true;
        this.stats.finishTurn = b.info.turn + 1;
        this.stats.finishReason = 'native';
      }
    }
    const any = sc.units.slice(0, PLAYER_SLOTS).some((u) => this.controllable(u));
    if (!any) return;
    if (b.info.turn === 0) await sc.victoryWindow(true);
    await sc.say(S.playerPhase);
    for (const u of sc.units) tryCure(b.rng, u, u.officer === 0xffff ? 0 : b.officerOf(u).lead);
    if (this.retreatNow && !b.formation) {
      // 기능 menu -> 총퇴각 -> yes (1cb6:44de battle menu item 1): the scene restarts the battle
      b.info.result = 1;
      return;
    }
    if (this.log && this.leaderSeen) {
      const ls = b.slotOfOfficer(0);
      const L = ls !== NONE ? sc.units[ls] : null;
      if (L && L.status === Status.Field) {
        const hp = b.officerOf(L).hp;
        if (hp < this.leaderSeen.hp) this.log(`  leader took ${this.leaderSeen.hp - hp} over the enemy phase (predicted worst ${Math.round(this.leaderSeen.dw)}) at ${L.x},${L.y}`);
      }
    }
    if (process.env.GRIND_TRACE_HITS) {
      const ls = b.slotOfOfficer(0);
      if (ls !== NONE) {
        const L = sc.units[ls];
        this.log?.(`  enemies near leader: ${sc.units.slice(PLAYER_SLOTS).filter((e) => e.status === Status.Field && Math.abs(e.x - L.x) + Math.abs(e.y - L.y) <= 99).map((e) => `${e.officer}@${e.x},${e.y} m${e.mode} L${this.b.officerOf(e).level} c${this.b.officerOf(e).cls} hp${this.b.officerOf(e).hp}`).join(' ')}`);
      }
    }
    this.updateHold();
    this.updateBrace();
    this.decideFinish();
    this.updatePark();
    this.buildThreat();
    this.updateHn();
    this.buildPrice();
    this.buildBand();
    this.buildNurse();
    this.buildPen();
    this.buildLeaderKills();
    const gained = !this.inRollout && paramOr(this.p, 'search') > 0.5 && !this.quietField() ? await this.searchPhase() : await this.actLoop(null);
    if (b.info.result) return;
    // counted in the finish too: frozen there, a finish begun right after a kill kept the weak pull
    // towards the enemy for good (태산: three units waited 12 turns out of reach of the last two)
    if (gained === 0 && b.info.turn >= 2) this.idleTurns++;
    else this.idleTurns = 0;
  }

  // ---- one pass of commands over the controllable units (the greedy phase, or a search candidate)

  private async actLoop(plan: PhasePlan | null): Promise<number> {
    const sc = this.scene;
    const b = this.b;
    const p0 = this.p;
    if (plan?.over) (this as { p: GrindParams }).p = { ...p0, ...plan.over };
    let decision = 0;
    try {
      // the leader moves last: the enemies' reach is then computed with the others where they ended up
      // (a unit that moves away after the leader opens a path: 거록, a reinforcement reached 유비 through it)
      const feedLast = this.p.feed > 0 && !this.finishing;
      // the walk to an escape / bonus cell goes in a column: the unit nearest its goal moves first (by
      // need, 경무 L7 took the head of 회남's one-wide bridge and held up five behind it for turns); not
      // in the other finishes
      const column = this.finishing && this.stats.finishReason === 'escape' && paramOr(this.p, 'column') > 0.5;
      let gained = 0;
      const done = new Set<number>();
      for (let guard = 0; guard < PLAYER_SLOTS * 2 && b.info.result === 0; guard++) {
        const list = sc.units.slice(0, PLAYER_SLOTS).filter((u) => this.controllable(u) && !(u.flags & (UnitFlag.Acted | UnitFlag.Confused)) && !done.has(u.slot));
        const wd = column ? this.walkDists(list) : null;
        const order = list.sort(
          (x, y) =>
            (feedLast ? (x.officer === 0 ? 1 : 0) - (y.officer === 0 ? 1 : 0) : 0) ||
            (wd ? wd.get(x.slot)! - wd.get(y.slot)! : 0) ||
            this.weight(y.slot) - this.weight(x.slot) ||
            x.slot - y.slot,
        );
        const u = order[0];
        if (!u) break;
        done.add(u.slot);
        // the enemies' reach as it is now (earlier units moved or fell), with this unit lifted off
        // its cell: the cell it leaves no longer blocks them
        const at = u.y * b.width + u.x;
        b.s.unitAt[at] = NONE;
        this.buildThreat();
        b.s.unitAt[at] = u.slot;
        this.altK = plan && plan.dev === decision ? 1 : 0;
        let act = this.bestAction(u);
        if (this.altK) {
          // the candidate's deviation: the best action of another kind (within srGap of the best)
          const k0 = actionKey(act);
          const alt = this.lastAlts.find((a) => actionKey(a) !== k0);
          if (alt && alt.value >= act.value - paramOr(this.p, 'srGap')) act = alt;
          this.altK = 0;
        }
        decision++;
        plan?.trace?.push(`${act.slot}:${act.kind}:${act.x},${act.y}:${act.target}:${act.tactic}:${act.item?.id ?? ''}`);
        if (u.officer === 0) {
          this.leaderActed = true;
          this.leaderSeen = { hp: b.officerOf(u).hp, dw: act.danger ?? 0 };
        }
        gained += await this.execute(act);
        if (b.info.result) break;
        await sc.victoryCheck();
      }
      this.decisions = decision;
      return gained;
    } finally {
      (this as { p: GrindParams }).p = p0;
      this.altK = 0;
    }
  }

  /** Walking distance of each unit to its goal in the escape walk (as bestAction: the 회남 fort, the bonus cell, its own goal; else the nearest enemy). */
  private walkDists(list: Unit[]): Map<number, number> {
    const enemies = this.scene.units.filter((e) => e.slot >= PLAYER_SLOTS && e.status === Status.Field);
    const bonus = !this.exitPlan ? this.bonusCell() : null;
    const m = new Map<number, number>();
    for (const u of list) {
      const mt = moveTypeOf(this.b.s, u);
      const goal = this.hnEsc() ? this.exitPlan!.cell : bonus ?? this.goalFor(u);
      m.set(u.slot, goal ? this.pathDist(goal, mt, u.x, u.y) : enemies.length ? this.foeDist(enemies, mt, u.x, u.y) : 0);
    }
    return m;
  }

  // ---- look-ahead search (GrindParams.search): candidate phases played out against the enemy's reply

  /** Set inside a rollout: the phase plays greedy (no search of its own) and nothing is logged. */
  private inRollout = false;
  /** bestAction collects the best action of each kind when set (lastAlts). */
  private altK = 0;
  private lastAlts: Action[] = [];
  /** Commands of the last actLoop. */
  private decisions = 0;
  /** Search counters (the report and the bench read them through stats.search). */
  private searchStats = { phases: 0, rollouts: 0, changed: 0 };

  /**
   * The candidates of one phase: the greedy phase, phases under other weights (bolder, more careful,
   * holding back, pressing, killing, sparing), and the greedy phase with one command changed to the
   * best action of another kind. Each candidate is a rule, not a fixed list of commands: replayed
   * on the real battle it adapts to the dice the rollouts did not see.
   */
  private searchCandidates(n: number): PhasePlan[] {
    const p = this.p;
    const out: PhasePlan[] = [{ label: 'greedy' }];
    const K = Math.max(1, paramOr(p, 'srK'));
    const vars: PhasePlan[] = [
      { label: 'careful', over: { risk: Math.min(4, p.risk * 2.5 + 0.5), guard: Math.max(0.3, p.guard * 0.8) } },
      { label: 'hold', over: { approach: 0, lead: 0, escort: Math.min(3, p.escort * 2 + 0.5) } },
      { label: 'bold', over: { risk: p.risk * 0.4 } },
      { label: 'press', over: { approach: Math.min(3, p.approach * 3 + 0.6), lead: Math.min(4, p.lead + 1) } },
      { label: 'kill', over: { kill: 2, conserve: 0 } },
      { label: 'spare', over: { kill: 0, conserve: Math.min(3, p.conserve * 2 + 0.5) } },
      // in trouble: everyone well clear of the enemy's reach, or closed up around the leader
      { label: 'flee', over: { risk: 4, guard: 0.3, approach: 0, lead: 0, kill: 2, conserve: 0 } },
      { label: 'huddle', over: { escort: 3, approach: 0, lead: 0, risk: Math.min(4, p.risk * 1.5 + 0.3) } },
      // the finish stuck short of its goal (the leader kept back by the danger): go in
      { label: 'charge', over: { risk: p.risk * 0.3, guard: 1.3, approach: 3, lead: 4, safe: 0 } },
    ];
    // in the finish the charge comes first (the weights that hold back matter less there)
    if (this.finishing) vars.unshift(vars.pop()!);
    const devs: PhasePlan[] = [];
    for (let j = 0; j < n; j++) devs.push({ label: `dev${j}`, dev: j });
    // interleave: weights first (they move every unit), then single changes
    for (let i = 0; out.length < K && (i < vars.length || i < devs.length); i++) {
      if (i < vars.length) out.push(vars[i]);
      if (out.length < K && i < devs.length) out.push(devs[i]);
    }
    return out.slice(0, K);
  }

  /**
   * Value of the battle now against the save taken at the start of the phase: exp gained (by need,
   * the leader's twice), the troops kept by every unit (a fallen unit loses its exp to come), the
   * leader's troops (gone = the battle lost), the enemy troops removed, and a win only when the
   * policy is finishing (an early end throws the turns left away).
   */
  private evaluate(sv: SceneSave): number {
    const b = this.b;
    const sc = this.scene;
    if (b.info.result === 3 || b.info.result === 1) return -1e6;
    const turnsLeft = Math.max(0, this.deadline() - b.info.turn - 1);
    const hpW = paramOr(this.p, 'srHp'), ldW = paramOr(this.p, 'srLeader'), foeW = paramOr(this.p, 'srFoe');
    let v = 0;
    let alive = 0;
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      const u = sc.units[i];
      if (u.status === Status.Empty || u.officer === 0xffff) continue;
      const o = b.officerOf(u);
      const guarded = this.know.guarded.has(u.officer);
      const was = sv.units[i];
      if (u.status !== Status.Field) {
        // a guarded officer gone loses the battle (the defeat event may not have run in the rollout)
        if (guarded && was.status === Status.Field) return -1e6;
        if (was.status !== Status.Field) continue;
      }
      const w = u.officer < 0x100 ? this.weight(i) * (guarded ? 2 : 1) : 0.5;
      if (u.officer < 0x100) {
        const d0 = sv.officers[u.officer].dyn;
        v += (o.level * 100 + o.exp - (d0.level * 100 + d0.exp)) * w;
      }
      if (u.status !== Status.Field) continue;
      alive++;
      const f = Math.min(1, o.hp / Math.max(1, maxHp(o)));
      // alive: its exp to come over the turns left (a fallen unit loses it all, however hurt it
      // was), plus its troops (a hurt unit is closer to falling)
      v += hpW * Math.max(0.5, w) * (5 * Math.min(turnsLeft, 20) + 40 * f);
      if (guarded) v -= ldW * 400 * (1 - f) ** 2;
    }
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const e = sc.units[i];
      const was = sv.units[i];
      if (e.officer === 0xffff || e.status === Status.Empty) continue;
      if (e.status === Status.Field) {
        const oe = b.officerOf(e);
        v += foeW * 10 * (1 - Math.min(1, oe.hp / Math.max(1, maxHp(oe))));
      } else if (was.status === Status.Field) v += (i === this.srPen || this.srBands.has(i)) && !this.finishing ? -150 : foeW * 10;
    }
    // the finish: progress to the win (the goal's distance, the victory officer's troops, or the
    // enemy's troops when every enemy must fall), more pressing as the turns run out
    if (this.finishing && b.info.result === 0) {
      const urg = paramOr(this.p, 'srProg') * (1 + 8 / (turnsLeft + 1));
      let minD = 99;
      for (let i = 0; i < PLAYER_SLOTS; i++) {
        const u = sc.units[i];
        if (!this.controllable(u)) continue;
        const g = this.goalFor(u);
        if (g) minD = Math.min(minD, this.pathDist(g, moveTypeOf(b.s, u), u.x, u.y));
      }
      if (minD < 99) v -= urg * 6 * Math.min(minD, 40);
      const vo = this.victoryNow();
      const vs = vo !== null ? b.slotOfOfficer(vo) : NONE;
      // (the end held: in place for it, no hurry to wear the victory officer / the last enemies down)
      if (this.srHeld) {
        // nothing
      } else if (vs !== NONE && sc.units[vs].status === Status.Field) {
        const ov = b.officerOf(sc.units[vs]);
        v -= urg * 150 * Math.min(1, ov.hp / Math.max(1, maxHp(ov)));
      } else if (vo === null && !this.wcells().length) {
        for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
          const e = sc.units[i];
          if (e.status !== Status.Field || e.officer === 0xffff) continue;
          const oe = b.officerOf(e);
          v -= urg * 40 * Math.min(1, oe.hp / Math.max(1, maxHp(oe)));
        }
      }
    }
    if (b.info.result === 2) v += this.finishing && !this.srHeld ? 3000 : -turnsLeft * 12 * alive;
    // the turns ran out without a win: lost
    else if (b.info.turn >= b.info.turnLimit - 1 && this.know.endsAt === null) return -5e5 + v;
    return v;
  }

  /** After our phase in a rollout: the enemy's reply, and with srDepth 2 one more full turn (greedy). */
  private async rolloutRest(depth: number) {
    const sc = this.scene as unknown as { computerPhases: () => Promise<void>; turn: () => Promise<void>; playerPhase: () => Promise<void> };
    const b = this.b;
    if (b.info.result === 0) await sc.computerPhases();
    for (let d = 1; d < depth && b.info.result === 0; d++) {
      b.info.turn++;
      if (b.info.turn >= b.info.turnLimit) break;
      b.stepWeather();
      await this.scene.eventLoop({ type: 'turn', turn: b.info.turn + 1 });
      if (b.info.result !== 0) break;
      const pp = sc.playerPhase;
      sc.playerPhase = () => this.playerPhase();
      try {
        await sc.turn();
      } finally {
        sc.playerPhase = pp;
      }
    }
  }

  /**
   * The search phase: every candidate is played on the live battle (from a save) with the enemy's
   * reply, under srSamples RNG seeds of its own (the same seeds for every candidate; never the
   * game's own coming draws, which no player knows), and scored by evaluate(); the best is then
   * played for real. Candidates whose commands come out the same as one already tried are skipped.
   */
  private async searchPhase(): Promise<number> {
    const sc = this.scene;
    const b = this.b;
    const ns = Math.max(1, paramOr(this.p, 'srSamples'));
    const depth = Math.max(1, paramOr(this.p, 'srDepth'));
    const log = this.log;
    this.srHeld = this.endHeld();
    this.srPen = this.penning() ? this.pen : NONE;
    this.srBands = new Set(this.bandKeep);
    const save = saveScene(sc, [this]);
    this.log = null;
    this.inRollout = true;
    let cands: PhasePlan[] = [{ label: 'greedy' }];
    const values: number[] = [];
    const seen = new Map<string, number>();
    let best = 0;
    // one candidate on one rollout seed
    const roll = async (plan: PhasePlan, s: number): Promise<number> => {
      restoreScene(sc, save);
      b.rng.seed = mixSeed(b.info.turn * 977 + s * 131 + 7, this.searchSeed);
      await this.actLoop(plan);
      await this.rolloutRest(depth);
      this.searchStats.rollouts++;
      return this.evaluate(save);
    };
    let verified = '';
    try {
      for (let ci = 0; ci < cands.length; ci++) {
        let v = 0;
        let dup = -1;
        for (let s = 0; s < ns; s++) {
          restoreScene(sc, save);
          b.rng.seed = mixSeed(b.info.turn * 977 + s * 131 + 7, this.searchSeed);
          const plan: PhasePlan = { ...cands[ci], trace: [] };
          await this.actLoop(plan);
          if (ci === 0 && s === 0) cands = this.searchCandidates(this.decisions);
          if (s === 0) {
            const sig = plan.trace!.join('|');
            const k = seen.get(sig);
            if (k !== undefined) {
              dup = k;
              break;
            }
            seen.set(sig, ci);
          }
          await this.rolloutRest(depth);
          this.searchStats.rollouts++;
          v += this.evaluate(save);
        }
        values.push(dup >= 0 ? values[dup] : v / ns);
        if (values[ci] > values[best] + 1e-6) best = ci;
      }
      // the greedy phase carries the long-term rules (formation, goals, the finish): another
      // candidate replaces it only when clearly better; in the finish only to save the leader
      const margin = paramOr(this.p, 'srMargin');
      // (or to win: a candidate that ends the battle while the greedy one does not)
      if (best !== 0 && (this.finishing ? values[0] > -1e5 && values[best] < values[0] + margin * 3 : values[best] < values[0] + margin)) best = 0;
      // the best of many noisy estimates is flattered (winner's curse): it is checked against the
      // greedy phase again on fresh seeds before it replaces it
      const nv = paramOr(this.p, 'srVerify');
      if (best !== 0 && nv > 0) {
        let vg = 0, vb = 0;
        for (let s = ns; s < ns + nv; s++) {
          vg += await roll({ label: 'greedy' }, s);
          vb += await roll(cands[best], s);
        }
        vg /= nv;
        vb /= nv;
        verified = ` verify ${vb.toFixed(0)} vs ${vg.toFixed(0)}`;
        if (this.finishing ? vg > -1e5 && vb < vg + margin * 3 : vb < vg + margin) best = 0;
      }
    } finally {
      restoreScene(sc, save);
      this.inRollout = false;
      this.log = log;
    }
    this.searchStats.phases++;
    if (best !== 0) this.searchStats.changed++;
    this.stats.search = { ...this.searchStats };
    this.log?.(`T${b.info.turn + 1} search: ${cands[best].label} ${values[best].toFixed(0)}${verified} (greedy ${values[0].toFixed(0)}; ${cands.map((c, i) => `${c.label} ${values[i]?.toFixed(0)}`).join(', ')})`);
    return this.actLoop(cands[best]);
  }

  /**
   * No enemy can come to blows with any of our units within the look-ahead (each side's moves and
   * ranges over srDepth turns, and a script wave not due): the rollouts would all score the same,
   * so the greedy phase is played without them. Not in the finish (its progress term differs).
   */
  private quietField(): boolean {
    if (this.finishing) return false;
    const b = this.b;
    const depth = Math.max(1, paramOr(this.p, 'srDepth'));
    const turn = b.info.turn + 1;
    if (this.know.turns.some((e) => e.turn !== null && e.turn > turn && e.turn <= turn + depth + 1 && e.reinforce.length > 0)) return false;
    const ours = this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && u.officer !== 0xffff);
    if (!ours.length) return true;
    let ourMove = 0;
    for (const u of ours) ourMove = Math.max(ourMove, movePoints(b.officerOf(u), b.s.items) + Math.max(1, CLASS_RANGE[b.officerOf(u).cls] === NONE ? 1 : CLASS_RANGE[b.officerOf(u).cls]));
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const e = this.scene.units[i];
      if (e.status !== Status.Field || e.officer === 0xffff) continue;
      const oe = b.officerOf(e);
      const r = CLASS_RANGE[oe.cls] === NONE ? 4 : Math.max(CLASS_RANGE[oe.cls], 3);
      const reach = depth * (movePoints(oe, b.s.items) + r + ourMove) + 2;
      for (const u of ours) if (Math.abs(u.x - e.x) + Math.abs(u.y - e.y) <= reach) return false;
    }
    return true;
  }

  /** Seed of this battle's rollout RNG (set by battle.ts from the snapshot seed; any fixed value works). */
  searchSeed = 0x5eed;

  // ---- 회남 plan (GrindParams.hnPlan): hold north-east, peel the waiting south at the bridge, escape

  /** The 회남 block (ch1 stage 2 block 12) with the plan on (absent in older plans: off). */
  private hnMemo: boolean | undefined = undefined;
  private hnOn(): boolean {
    if (this.hnMemo === undefined) this.hnMemo = !!(this.p.hnPlan > 0.5) && isHuainan(this.know);
    return this.hnMemo;
  }
  private hnPhase: 'hold' | 'peel' | 'escape' = 'hold';
  /** The waiting unit being peeled (its officer), until it falls. */
  private hnTarget: number | null = null;
  /** Cells the plan keeps out of (the reach of waiting units it is not peeling, widened by hnReach). */
  private hnBan: Uint8Array | null = null;
  /** Anchors: the formation's, 유비's (behind it while peeling), and the front line's (towards the wave). */
  private hnAnchor: [number, number] | null = null;
  private hnLeaderAnchor: [number, number] | null = null;
  private hnFrontAt: [number, number] | null = null;
  /** The cell where one of ours wakes the target alone (inside its reach only). */
  private hnBait: [number, number] | null = null;
  private hnTrapFired = false;
  private hnWaveOffs: number[] | null = null;

  /** An enemy that sits until we come in reach (대기), or walks to a cell (the turn-6 order): not chasing us. */
  private sleeping(e: Unit): boolean {
    return e.status === Status.Field && e.officer !== 0xffff && (e.mode === AiMode.Wait || e.mode === AiMode.MoveTo);
  }

  private hnEsc(): boolean {
    return this.hnOn() && this.finishing && this.stats.finishReason === 'escape' && !!this.exitPlan;
  }

  /** Healers, the band and the weak (hnWeak levels or more below our three strongest) stay inside the formation; the others form its front. */
  private hnInner(u: Unit): boolean {
    const o = this.b.officerOf(u);
    if (o.cls === 12) return true;
    if (this.hnWeakUnit(u)) return true;
    return castableTactics(o, 999, this.b.learn).some((t) => t >= 21 && t <= 35);
  }

  /** A unit hnWeak levels or more below the average of our three strongest (absent hnWeak: none). */
  private hnWeakUnit(u: Unit): boolean {
    if (!Number.isFinite(this.p.hnWeak) || u.officer >= 0x100) return false;
    const lv = this.scene.units
      .slice(0, PLAYER_SLOTS)
      .filter((a) => a.status === Status.Field && a.officer < 0x100)
      .map((a) => this.b.officerOf(a).level)
      .sort((a, b) => b - a)
      .slice(0, 3);
    if (!lv.length) return false;
    return this.b.officerOf(u).level <= lv.reduce((a, b) => a + b, 0) / lv.length - this.p.hnWeak;
  }

  /** Steps from `from` to `to` over the terrain (our leader's move type), as a cell list. */
  private hnPath(from: [number, number], to: [number, number], mt: number): [number, number][] {
    const b = this.b;
    const W = b.width;
    const out: [number, number][] = [];
    let [x, y] = from;
    out.push([x, y]);
    for (let guard = 0; guard < W * b.height && (x !== to[0] || y !== to[1]); guard++) {
      const d = this.pathDist(to, mt, x, y);
      let nx = x, ny = y;
      for (const [cx, cy] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
        if (cx < 0 || cy < 0 || cx >= W || cy >= b.height || moveCost(mt, b.s.terrain[cy * W + cx]) === 0xff) continue;
        if (this.pathDist(to, mt, cx, cy) < d) [nx, ny] = [cx, cy];
      }
      if (nx === x && ny === y) break;
      [x, y] = [nx, ny];
      out.push([x, y]);
    }
    return out;
  }

  /** At each player phase: the phase (hold -> peel), the target, the banned cells and the anchors. */
  private updateHn() {
    if (!this.hnOn() || this.finishing || !this.exitPlan) return;
    const b = this.b;
    const W = b.width, H = b.height;
    const turn = b.info.turn + 1;
    const units = this.scene.units;
    const ls = b.slotOfOfficer(0);
    const L = ls !== NONE ? units[ls] : null;
    if (!L || L.status !== Status.Field) return;
    const mt = moveTypeOf(b.s, L);
    if (L.x >= HN_TRAP[0] && L.x <= HN_TRAP[2] && L.y >= HN_TRAP[1] && L.y <= HN_TRAP[3]) this.hnTrapFired = true;
    if (this.hnWaveOffs === null) {
      this.hnWaveOffs = [];
      for (const e of this.know.turns) if (e.turn !== null && e.reinforce.length >= 4) this.hnWaveOffs.push(...e.reinforce);
    }
    const waveIn = this.know.turns.some((e) => e.turn !== null && e.reinforce.length >= 4 && e.turn <= turn);
    const waveLeft = this.hnWaveOffs.filter((off) => {
      const i = b.slotOfOfficer(off);
      return i !== NONE && i >= PLAYER_SLOTS && units[i].status === Status.Field;
    }).length;
    const hold = this.exitPlan.anchor;
    // the wave down: push for the fort now (Sukwon: no resting; out of MP they still attack and move)
    if (paramOr(this.p, 'hnPush') > 0.5 && waveIn && waveLeft <= paramOr(this.p, 'hnWave')) {
      this.finishing = true;
      this.stats.finishTurn = turn;
      this.stats.finishReason = 'escape';
      this.log?.(`회남: wave down, push for ${this.exitPlan.cell.join(',')} at turn ${turn}`);
      this.stats.kept = units.slice(PLAYER_SLOTS).filter((u) => u.status === Status.Field).map((u) => u.officer);
      return;
    }
    if (this.hnPhase === 'hold' && ((waveIn && waveLeft <= this.p.hnWave) || turn >= this.p.hnPeel)) {
      this.hnPhase = 'peel';
      this.log?.(`회남: peel from turn ${turn} (wave left ${waveLeft})`);
    }
    // the target: the waiting unit nearest the hold anchor by walking, kept until it falls
    if (this.hnPhase === 'peel') {
      const ts = this.hnTarget !== null ? b.slotOfOfficer(this.hnTarget) : NONE;
      if (ts === NONE || units[ts].status !== Status.Field) {
        this.hnTarget = null;
        let bd = 1e9;
        for (const e of units.slice(PLAYER_SLOTS)) {
          if (!this.sleeping(e)) continue;
          const d = this.pathDist(hold, mt, e.x, e.y);
          if (d < bd) [bd, this.hnTarget] = [d, e.officer];
        }
        if (this.hnTarget !== null) this.log?.(`회남: peel target ${this.hnTarget} at turn ${turn}`);
      }
    }
    const ts = this.hnTarget !== null ? b.slotOfOfficer(this.hnTarget) : NONE;
    const T = ts !== NONE && units[ts].status === Status.Field ? units[ts] : null;
    // healing up between peels: the target's reach is banned too while it still waits
    const mine = units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && u.officer !== 0xffff);
    let hp = 0, max = 0;
    for (const u of mine) {
      hp += b.officerOf(u).hp;
      max += maxHp(b.officerOf(u));
    }
    // (Sukwon: never just sit when the troops are down: the pull-back only while someone can heal
    // troops with the MP they have; otherwise waiting restores nothing and the peel goes on)
    const healer = mine.some((u) => castableTactics(b.officerOf(u), u.mp, b.learn).some((t) => (t >= 24 && t <= 29) || (t >= 33 && t <= 35)));
    const resting = this.hnPhase === 'peel' && hp < max * this.p.hnRest && !!T && this.sleeping(T) && healer;
    // the banned cells: where a waiting unit (not the target, unless resting) would see one of ours
    const ban = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
      for (const i of [...(this.threat[k] ?? []), ...(this.tthreat[k] ?? [])]) {
        const e = units[i];
        if (!this.sleeping(e) || (e === T && !resting)) continue;
        ban[k] = 1;
        break;
      }
    }
    for (let r = 0; r < this.p.hnReach; r++) {
      const prev = ban.slice();
      for (let k = 0; k < W * H; k++) {
        if (!prev[k]) continue;
        const x = k % W, y = (k - x) / W;
        for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) if (nx >= 0 && ny >= 0 && nx < W && ny < H) ban[ny * W + nx] = 1;
      }
    }
    this.hnBan = ban;
    this.hnBait = null;
    if (this.hnPhase === 'hold' || !T) {
      this.hnAnchor = hold;
      this.hnLeaderAnchor = hold;
    } else {
      // along the way from the hold anchor to the target: the furthest cell before the first banned one, hnBack back
      const path = this.hnPath(hold, [T.x, T.y], mt);
      let safe = path.length - 2;
      for (let i = 0; i < path.length - 1; i++)
        if (ban[path[i][1] * W + path[i][0]]) {
          safe = i - 1;
          break;
        }
      safe = Math.max(0, safe);
      const at = Math.max(0, safe - this.p.hnBack - (resting ? 3 : 0));
      this.hnAnchor = path[at];
      // the bait: the furthest safe cell, when the target (still waiting) sees it
      const bk = path[safe][1] * W + path[safe][0];
      if (!resting && this.sleeping(T) && [...(this.threat[bk] ?? []), ...(this.tthreat[bk] ?? [])].includes(T.slot)) this.hnBait = path[safe];
      this.hnLeaderAnchor = path[Math.max(0, at - 3)];
    }
    // the front: hnFront cells from the anchor towards the chasing enemies' middle (two cells out, the
    // wave overran it: 4 of 4 seeds lost by turn 16; one cell: 16 of 20 seeds to turn 30, none 14)
    const awake = units.slice(PLAYER_SLOTS).filter((e) => e.status === Status.Field && e.officer !== 0xffff && !this.sleeping(e));
    this.hnFrontAt = this.hnAnchor;
    if (awake.length && this.hnAnchor) {
      const cx = awake.reduce((a, e) => a + e.x, 0) / awake.length - this.hnAnchor[0];
      const cy = awake.reduce((a, e) => a + e.y, 0) / awake.length - this.hnAnchor[1];
      const n = Math.hypot(cx, cy);
      const f = this.p.hnFront;
      if (n > 0 && f > 0) this.hnFrontAt = [Math.round(this.hnAnchor[0] + (f * cx) / n), Math.round(this.hnAnchor[1] + (f * cy) / n)];
    }
    this.braceAnchor = this.hnAnchor;
    if (this.hnPhase === 'peel') this.log?.(`회남: T${turn} anchor ${this.hnAnchor?.join(',')} leader ${this.hnLeaderAnchor?.join(',')}${resting ? ' (healing)' : ''}${T ? ` target ${T.officer}@${T.x},${T.y} m${T.mode}` : ''}`);
  }

  /** 유비 may enter the trap strip (all enemies turn on him) only when he reaches (0,2) before any of them. */
  private hnTrapOk(u: Unit, x: number, y: number): boolean {
    if (this.hnTrapFired || x < HN_TRAP[0] || x > HN_TRAP[2] || y < HN_TRAP[1] || y > HN_TRAP[3] || !this.exitPlan) return true;
    const b = this.b;
    const cell = this.exitPlan.cell;
    const mp = Math.max(1, movePoints(b.officerOf(u), b.s.items));
    const lt = Math.ceil(this.pathDist(cell, moveTypeOf(b.s, u), x, y) / mp);
    if (lt > this.deadline() - b.info.turn - 1) return false;
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) {
      if (e.status !== Status.Field || e.officer === 0xffff) continue;
      const emp = Math.max(1, movePoints(b.officerOf(e), b.s.items));
      const ct = Math.ceil(Math.max(0, this.pathDist(cell, moveTypeOf(b.s, e), e.x, e.y) - 2) / emp);
      if (ct < lt) return false;
    }
    return true;
  }

  // ---- exit plan (하비): outnumbered 2:1 with an escape cell for 유비 -> hold near it, escape last

  /** undefined: not decided yet; null: no exit plan in this battle. */
  private exitPlan: { cell: [number, number]; anchor: [number, number] } | null | undefined = undefined;

  private decideExit() {
    if (this.exitPlan !== undefined) return;
    this.exitPlan = null;
    const pv = (k: 'exit' | 'exitMargin' | 'exitNear') => (Number.isFinite(this.p[k]) ? this.p[k] : PARAM_SPECS.find((sp) => sp.key === k)!.def);
    const b = this.b;
    const ls = b.slotOfOfficer(0);
    const L = ls !== NONE ? this.scene.units[ls] : null;
    if (!L || L.status !== Status.Field) return;
    const w = this.know.winCells.find((c) => c.officer === 0 || c.officer === 0x400);
    if (this.hnOn() && w) {
      // 회남: the hold anchor is learned (hnX, hnY), snapped to the nearest cell 유비 can walk to
      const mt0 = moveTypeOf(b.s, L);
      let best: [number, number] | null = null, bd = 1e9;
      for (let y = 0; y < b.height; y++)
        for (let x = 0; x < b.width; x++) {
          if (moveCost(mt0, b.s.terrain[y * b.width + x]) === 0xff || !this.reaches([L.x, L.y], mt0, x, y)) continue;
          const d = Math.abs(x - this.p.hnX) + Math.abs(y - this.p.hnY);
          if (d < bd) [bd, best] = [d, [x, y]];
        }
      if (best) {
        this.exitPlan = { cell: [w.x0, w.y0], anchor: best };
        this.braceAnchor = best;
        this.log?.(`회남 plan: hold near ${best[0]},${best[1]}, peel the waiting units at the bridge, escape to ${w.x0},${w.y0}`);
        return;
      }
    }
    if (!(pv('exit') > 0.5)) return;
    // only where the arrival (or a wipe-out) is the way to win: no officer to defeat, no script steps
    if (!w || this.know.steps.length || this.know.victory !== null) return;
    const ours = this.oursOnField();
    let theirs = this.enemiesOnField();
    for (const e of this.know.turns) {
      if (e.turn === null) continue;
      theirs += e.reinforce.filter((o) => {
        const i = b.slotOfOfficer(o);
        return i !== NONE && i >= PLAYER_SLOTS && this.scene.units[i].status !== Status.Field;
      }).length;
    }
    if (theirs < ours * 2) return;
    const cell: [number, number] = [w.x0, w.y0];
    const mt = moveTypeOf(b.s, L);
    const mp = movePoints(b.officerOf(L), b.s.items);
    const W = b.width, H = b.height;
    const pass = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && moveCost(mt, b.s.terrain[y * W + x]) !== 0xff;
    const foes: [number, number][] = [];
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) if (e.status === Status.Field && e.officer !== 0xffff) foes.push([e.x, e.y]);
    for (const ev of this.know.turns)
      for (const off of ev.reinforce) {
        const i = b.slotOfOfficer(off);
        if (i === NONE || i < PLAYER_SLOTS) continue;
        const rec = this.scene.ctx.vm.state.units.find((d) => d.officer === off);
        if (rec && rec.x < W && rec.y < H) foes.push([rec.x, rec.y]);
      }
    // the anchor: within three of 유비's moves of the cell, reachable, narrow and defensive, as far
    // from the enemy and the waves' entry cells as possible
    let best: [number, number] | null = null, bv = -1e9;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!pass(x, y)) continue;
        const dW = this.pathDist(cell, mt, x, y);
        if (dW > mp * 3 || !this.reaches([L.x, L.y], mt, x, y) || !this.reaches(cell, mt, x, y)) continue;
        let open = 0, def = 0, cells = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const r = Math.abs(dx) + Math.abs(dy);
            if (r > 2 || !pass(x + dx, y + dy)) continue;
            open++;
            if (r <= 1) {
              cells++;
              def += Math.min(30, terrainDefence(b.s.terrain[(y + dy) * W + x + dx]));
            }
          }
        let near = 99;
        for (const [fx, fy] of foes) near = Math.min(near, this.pathDist([fx, fy], mt, x, y));
        const v = ((def / Math.max(1, cells)) / 5) * this.p.terrain - 0.25 * open + 0.6 * Math.min(near, 16) - pv('exitNear') * dW;
        if (v > bv) [bv, best] = [v, [x, y]];
      }
    if (!best) return;
    this.exitPlan = { cell, anchor: best };
    this.braceAnchor = best;
    this.log?.(`exit plan: ${theirs} enemies (waves counted) vs ${ours}: hold near ${best[0]},${best[1]}, escape to ${cell[0]},${cell[1]}`);
  }

  /** Our units on the field that know a tactic (an enemy 군악대 next to them refills their MP). */
  private ourTacticUsers(): number {
    const b = this.b;
    return this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && u.officer !== 0xffff && b.learn.some((lv, i) => i % CLASS_COUNT === b.officerOf(u).cls && lv <= b.officerOf(u).level)).length;
  }

  /**
   * Turns 유비 needs to reach the exit cell now: move costs over the terrain, enemy units block,
   * a cell next to an enemy (zone of control) ends the move (costs a whole turn).
   */
  private exitTurns(cell: [number, number] | undefined = this.exitPlan?.cell, free = false): number {
    const plan = cell ? { cell } : null;
    const b = this.b;
    const ls = b.slotOfOfficer(0);
    if (!plan || ls === NONE) return 0;
    const L = this.scene.units[ls];
    const W = b.width, H = b.height;
    const mt = moveTypeOf(b.s, L);
    const mp = Math.max(1, movePoints(b.officerOf(L), b.s.items));
    const zoc = new Uint8Array(W * H);
    const blocked = new Uint8Array(W * H);
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) {
      if (e.status !== Status.Field || free) continue;
      blocked[e.y * W + e.x] = 1;
      for (const [nx, ny] of [[e.x, e.y - 1], [e.x + 1, e.y], [e.x, e.y + 1], [e.x - 1, e.y]]) if (nx >= 0 && ny >= 0 && nx < W && ny < H) zoc[ny * W + nx] = 1;
    }
    const dist = new Float64Array(W * H).fill(Infinity);
    const start = L.y * W + L.x;
    dist[start] = 0;
    const open = [start];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist[open[i]] < dist[open[bi]]) bi = i;
      const c = open.splice(bi, 1)[0];
      const cx = c % W, cy = (c - cx) / W;
      if (cx === plan.cell[0] && cy === plan.cell[1]) break;
      for (const [nx, ny] of [[cx, cy - 1], [cx + 1, cy], [cx, cy + 1], [cx - 1, cy]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        const mc = moveCost(mt, b.s.terrain[k]);
        if (mc === 0xff) continue;
        // an enemy on the way: it may move or fall, but count two turns for it
        const d = dist[c] + mc + (zoc[k] ? mp : 0) + (blocked[k] ? mp * 2 : 0);
        if (d < dist[k]) {
          if (dist[k] === Infinity) open.push(k);
          dist[k] = d;
        }
      }
    }
    const d = dist[plan.cell[1] * W + plan.cell[0]];
    return d === Infinity ? 99 : Math.ceil(d / mp);
  }

  /** The arrival cell that wins with a bonus for every unit (전원 경험치 +50). */
  private bonusCellMemo: [number, number] | null | undefined = undefined;
  private bonusCell(): [number, number] | null {
    return this.walk.off ? null : this.bonusCellRaw();
  }

  /** The bonus arrival cell, whether or not the walk-in is given up for now. */
  private bonusCellRaw(): [number, number] | null {
    if (this.bonusCellMemo !== undefined) return this.bonusCellMemo;
    this.bonusCellMemo = null;
    if (this.know.steps.length) return null;
    for (const g of this.know.gains) {
      // (계교: the +50 record does not end the battle itself, a win cell on the same square does)
      if (g.bonus <= 0 || !g.cell || (g.trigger !== 6 && g.trigger !== 11) || g.actor !== 0 || g.needsFlags.length) continue;
      if (!this.know.winCells.some((w) => w.officer === 0 && w.x0 <= g.cell!.x1 && w.x1 >= g.cell!.x0 && w.y0 <= g.cell!.y1 && w.y1 >= g.cell!.y0)) continue;
      this.bonusCellMemo = [g.cell.x0, g.cell.y0];
      break;
    }
    return this.bonusCellMemo;
  }

  /** The bonus arrival is still reachable in the turns left (the leader is spared for it). */
  private bonusOn(): boolean {
    const c = this.bonusCell();
    if (!c || this.fired.size < 0) return false;
    const ls = this.b.slotOfOfficer(0);
    if (ls === NONE || this.scene.units[ls].status !== Status.Field) return false;
    if (this.exitTurns(c) > this.deadline() - this.b.info.turn) return false;
    // only once the field is nearly clear (the leader and at most one more, the expert way: grind the
    // rest down, then walk in) or the walk-in has begun; a guarded cell (거록: six fresh units by the
    // gate) turns the walk-in into a loss on time
    if (this.stats.finishReason === 'escape') return true;
    // (and its way open: 신도's 순우경 at the narrows kept 유비 out for good, the leader spared to the end)
    if (this.enemiesOnField() <= 2) return this.walkClear(this.exitTurns(c));
    return false;
  }

  /** The bonus walk-in: the fewest turns the leader's way has needed since it began, and the turns without getting closer. */
  private walk = { best: 99, stuck: 0, off: false, offNeed: 99, offTurn: 0 };

  /**
   * A walk-in that gets no closer for three turns (신도: 유비 held back at the narrows by 순우경, the
   * spared leader) is given up: the finish goes back to winning the usual way, while there is time.
   * Given up is not for good: once the way opens again (순우경 off to a village to mend, the narrows
   * free) and the turns left still cover it, the walk-in resumes (a lone 유비 used to wait to the limit).
   */
  private walkCheck() {
    if (this.walk.off && this.finishing && !this.exitPlan) {
      const c = this.bonusCellRaw();
      const ls = this.b.slotOfOfficer(0);
      if (!c || ls === NONE || this.scene.units[ls].status !== Status.Field) return;
      const need = this.exitTurns(c);
      const left = this.deadline() - this.b.info.turn;
      const turn = this.b.info.turn + 1;
      // (not while the victory officer is worn down: finishing it off is the surer win, 신도's 순우경
      // at 68 troops limping to a village)
      if (this.victoryWorn()) return;
      if ((need < this.walk.offNeed || turn >= this.walk.offTurn + 2) && need <= left && need <= this.exitTurns(c, true) + 1) {
        this.walk = { best: need, stuck: 0, off: false, offNeed: 99, offTurn: 0 };
        this.stats.finishReason = 'escape';
        this.log?.(`finish: walk-in resumed at turn ${this.b.info.turn + 1}, ${need} turns to ${c.join(',')}`);
      }
      return;
    }
    if (this.walk.off || this.stats.finishReason !== 'escape' || !this.bonusCell() || this.exitPlan) return;
    const need = this.exitTurns(this.bonusCell()!);
    if (need < this.walk.best) {
      this.walk.best = need;
      this.walk.stuck = 0;
      return;
    }
    if (++this.walk.stuck < 3) return;
    this.walk.off = true;
    this.walk.offNeed = need;
    this.walk.offTurn = this.b.info.turn + 1;
    this.stats.finishReason = 'deadline';
    this.log?.(`finish: walk-in given up at turn ${this.b.info.turn + 1} (${need} turns away)`);
  }

  /** The walk-in's way is open: enemies on it cost the leader at most a turn more than the bare way. */
  private walkClear(need: number): boolean {
    return need <= this.exitTurns(this.bonusCell()!, true) + 1;
  }

  private decideFinish() {
    this.quiet = !this.finishing && this.quietCheck();
    this.walkCheck();
    if (this.finishing && this.stats.finishReason !== 'escape' && this.bonusCell() && this.bonusOn()) {
      // a finish already running (routing, the leader spared) turns into the walk-in when it is time
      const left = this.deadline() - this.b.info.turn;
      const need = this.exitTurns(this.bonusCell()!);
      const margin = Number.isFinite(this.p.exitMargin) ? this.p.exitMargin : 1;
      if ((left <= need + margin || this.victoryWorn()) && this.walkClear(need)) {
        this.stats.finishReason = 'escape';
        this.log?.(`finish: walk-in for the bonus at turn ${this.b.info.turn + 1}, ${need} turns to ${this.bonusCell()!.join(',')}`);
      }
      return;
    }
    this.farmOn = false;
    if (this.finishing) return;
    const b = this.b;
    this.farmOn = this.farmSafe();
    if (this.bonusCell() && this.bonusOn()) {
      const left = this.deadline() - b.info.turn;
      const need = this.exitTurns(this.bonusCell()!);
      const margin = Number.isFinite(this.p.exitMargin) ? this.p.exitMargin : 1;
      // (or the leader worn down: it may fall to a counter or an allied army in
      // the enemy phase and end the battle without the bonus, 계교's 원소)
      if ((left <= need + margin || this.victoryWorn()) && this.walkClear(need)) {
        this.finishing = true;
        this.stats.finishTurn = b.info.turn + 1;
        this.stats.finishReason = 'escape';
        this.log?.(`finish: walk-in for the bonus at turn ${b.info.turn + 1}, ${need} turns to ${this.bonusCell()!.join(',')} (deadline ${this.deadline()})`);
        this.stats.kept = this.scene.units.slice(PLAYER_SLOTS).filter((u) => u.status === Status.Field).map((u) => u.officer);
        return;
      }
    }
    this.decideExit();
    if (this.exitPlan) {
      // grind around the anchor; leave when the turns left just cover 유비's way (exitMargin spare)
      const left = this.deadline() - b.info.turn;
      const need = this.exitTurns();
      const margin = Number.isFinite(this.p.exitMargin) ? this.p.exitMargin : 1;
      // a way longer than the turns left (enemies in it) is not taken yet: hold on, it may clear
      // (회남: never a hopeless walk out at the end; 유비 stays covered and the turns are used)
      // 회남: only once peeling and the way is clear (enemies on it would cost 유비 more than a turn)
      const clear = !this.hnOn() || (this.hnPhase === 'peel' && need <= this.exitTurns(this.exitPlan.cell, true) + 1);
      if ((left <= need + margin && need <= left && clear) || (left <= 3 && !this.hnOn())) {
        this.finishing = true;
        this.stats.finishTurn = b.info.turn + 1;
        this.stats.finishReason = 'escape';
        this.log?.(`finish: escape at turn ${b.info.turn + 1}, ${need} turns to ${this.exitPlan.cell[0]},${this.exitPlan.cell[1]} (deadline ${this.deadline()})`);
        this.stats.kept = this.scene.units.slice(PLAYER_SLOTS).filter((u) => u.status === Status.Field).map((u) => u.officer);
      }
      return;
    }
    const left = this.deadline() - b.info.turn; // turns left including this one
    // each pending step (defeat X, march into an area) needs about 12 turns of the finish
    const stepTurns = this.stepsLeft() * 12;
    const deadlineHit = left <= this.p.finish + stepTurns;
    // bracing / regrouping: no early end (Sukwon: no emergency rush; the deadline still finishes the battle)
    if (this.bracing() && !deadlineHit) return;
    if (this.holding() && b.info.turnLimit - b.info.turn > this.p.finish) return;
    const needy = this.scene.units.slice(0, PLAYER_SLOTS).some((u) => u.status === Status.Field && this.weight(u.slot) > 0);
    // phases in a row without exp before the finish starts (idle)
    const idleN = Math.max(2, paramOr(this.p, 'idleFinish'));
    // going badly (the leader hurt, a third of the units gone)
    // our own officers only: allied armies under the computer (거록: 공손월's men) fall without it meaning much
    const mine = this.scene.units
      .slice(0, PLAYER_SLOTS)
      .filter((u) => u.officer < 0x100 && u.status !== Status.Empty && u.status !== Status.Reserve && ((this.scene.ctx.state.officers[u.officer]?.dyn.flags ?? 1) & 0x1f) === 0);
    const gone = mine.filter((u) => u.status !== Status.Field).length;
    const leaderHurt = mine.some((u) => this.know.guarded.has(u.officer) && u.status === Status.Field && b.officerOf(u).hp * 100 < maxHp(b.officerOf(u)) * (this.p.lead ? 35 : 60));
    const losses = gone * 3 >= mine.length;
    // a survival battle (a turn event wins it before any loss by time): never charge, keep grinding
    // safely until the event; the danger costs already pull a hurt leader back
    const survive = this.know.endsAt !== null && this.know.endsAt <= Math.min(b.info.turnLimit, this.know.deadline ?? 999);
    if (survive) return;
    // farm phase: safe now, so the early finishes wait; the finish starts when the turns left just
    // cover what it needs (walking to and killing what wins the battle) plus farmEnd spare
    if (this.farmOn && this.stepsLeft() === 0) {
      const need = this.bandFarming ? this.bandNeed() : this.farmNeed();
      if (left > need) {
        this.stats.farmTurns = (this.stats.farmTurns ?? 0) + 1;
        this.log?.(`farm: turn ${b.info.turn + 1}, ${left} turns left, finish needs ${need}`);
        return;
      }
      this.finishing = true;
      this.stats.finishTurn = b.info.turn + 1;
      this.stats.finishReason = 'farm';
      this.log?.(`finish: farm over at turn ${b.info.turn + 1} (needs ${need}, deadline ${this.deadline()})`);
      this.stats.kept = this.scene.units.slice(PLAYER_SLOTS).filter((u) => u.status === Status.Field).map((u) => u.officer);
      return;
    }
    // wake phase: every enemy left waits where it stands (태산: the groups far in the west) and the
    // turns cover more than the finish: no regroup against nobody, no early finish; mend and go
    // wake them (the finish still starts once its turns just remain)
    if (needy && this.stepsLeft() === 0 && !deadlineHit && this.wakeOn()) {
      const need = this.farmNeed();
      if (left > need) {
        if (this.idleTurns >= idleN || leaderHurt || losses) {
          this.stats.wakeTurns = (this.stats.wakeTurns ?? 0) + 1;
          this.log?.(`wake: turn ${b.info.turn + 1}, ${left} turns left, finish needs ${need}`);
        }
        return;
      }
    }
    // before the last third, going badly means defend and regroup (Sukwon: no fast win by the
    // 총대장 alone, no emergency means): pull back around 유비 on good terrain, heal, kill what
    // comes; never head for the enemy leader or the escape cell (연주: the defensive plan charged
    // 곽도 at turn 7 from here)
    if ((leaderHurt || losses) && !deadlineHit && !this.lateThird()) {
      const turn = b.info.turn + 1;
      if (this.regroupUntil < turn) {
        this.braceAnchor = this.pickBraceAnchor();
        this.log?.(`regroup: ${leaderHurt ? 'leader hurt' : 'losses'} at turn ${turn}${this.braceAnchor ? ` around ${this.braceAnchor[0]},${this.braceAnchor[1]}` : ''}`);
      }
      this.regroupUntil = turn + 1;
      return;
    }
    // the pen holds: no early finish (idle, nothing left to grind, the plan's reserved finish turns)
    // while its turns last; the finish starts when the turns left just cover it (as the farm phase)
    // (never past the plan's own finish turns: `finish` is the push the battle's end needs, 하비's
    // castle took 15 turns where the estimate said 5 and the holds ran into the time limit)
    if (this.penning() && needy && this.stepsLeft() === 0 && !leaderHurt && !losses && !deadlineHit && left > this.farmNeed()) return;
    // ... and so does the band farm (the casters earn every turn on the bands' MP)
    if (this.bandFarming && needy && this.stepsLeft() === 0 && !leaderHurt && !losses && !deadlineHit && left > this.bandNeed()) return;
    if (deadlineHit || !needy || this.idleTurns >= idleN || leaderHurt || losses) {
      this.finishing = true;
      this.stats.finishTurn = b.info.turn + 1;
      this.stats.finishReason = deadlineHit ? 'deadline' : !needy ? 'done' : this.idleTurns >= idleN ? 'idle' : leaderHurt ? 'leader' : 'losses';
      this.log?.(`finish: ${this.stats.finishReason} at turn ${b.info.turn + 1} (deadline ${this.deadline()})`);
      this.stats.kept = this.scene.units.slice(PLAYER_SLOTS).filter((u) => u.status === Status.Field).map((u) => u.officer);
    }
  }

  // ---- escort exit (GrindParams.escIdle): allies under the computer walking to a winning cell

  /** Exit cell (y * width + x) -> the slot of ours parked on it; freed for good once parkOff. */
  private parkAt = new Map<number, number>();
  private parkOff = false;

  /**
   * 장판파: the 백성 (our side, the computer's 이동 / 무공격이동 to it) walk to the exit cell, and the first to arrive
   * ends the battle (turn 8 of 70). One of ours stands on each such cell while exp is to be had;
   * it steps off after escIdle phases without exp, in the last escWin turns, in the finish, or when
   * the leader is hurt / half the party is gone (Sukwon: use the turns, but no idle turns).
   */
  private updatePark() {
    if (this.parkOff) return;
    const b = this.b;
    const W = b.width;
    const units = this.scene.units;
    // exit cell -> the fewest turns an escort needs to get there
    const cells = new Map<number, number>();
    for (const c of this.wcells()) {
      if (c.officer >= 0x400 || c.x0 !== c.x1 || c.y0 !== c.y1) continue;
      const s = b.slotOfOfficer(c.officer);
      if (s === NONE || s >= PLAYER_SLOTS) continue;
      const e = units[s];
      if (e.status !== Status.Field || (e.mode !== AiMode.MoveTo && e.mode !== AiMode.MoveNoAttack) || e.tx !== c.x0 || e.ty !== c.y0) continue;
      const k = c.y0 * W + c.x0;
      const et = this.pathDist([c.x0, c.y0], moveTypeOf(b.s, e), e.x, e.y) / Math.max(1, movePoints(b.officerOf(e), b.s.items));
      cells.set(k, Math.min(cells.get(k) ?? 99, et));
    }
    if (!cells.size) {
      this.parkAt.clear();
      return;
    }
    const mine = units.slice(0, PLAYER_SLOTS).filter((u) => u.officer < 0x100 && u.status !== Status.Empty && u.status !== Status.Reserve);
    const leaderHurt = mine.some((u) => this.know.guarded.has(u.officer) && u.status === Status.Field && b.officerOf(u).hp * 100 < maxHp(b.officerOf(u)) * (this.p.lead ? 35 : 60));
    const halfGone = mine.filter((u) => u.status !== Status.Field).length * 2 >= mine.length;
    const left = this.deadline() - b.info.turn;
    const why = this.finishing ? 'finish' : left <= paramOr(this.p, 'escWin') ? 'last turns' : this.idleTurns >= paramOr(this.p, 'escIdle') ? 'idle' : leaderHurt ? 'leader' : halfGone ? 'losses' : null;
    if (why) {
      this.parkOff = true;
      this.parkAt.clear();
      this.log?.(`escort: exit freed at turn ${b.info.turn + 1} (${why})`);
      return;
    }
    for (const [k, s] of [...this.parkAt]) if (!cells.has(k) || !this.controllable(units[s])) this.parkAt.delete(k);
    const taken = new Set(this.parkAt.values());
    for (const [k, et] of cells) {
      if (this.parkAt.has(k)) continue;
      const x = k % W, y = (k - x) / W;
      let bs = NONE, bd = 1e9;
      for (const u of units.slice(0, PLAYER_SLOTS)) {
        if (!this.controllable(u) || this.know.guarded.has(u.officer) || taken.has(u.slot)) continue;
        const o = b.officerOf(u);
        if (o.hp * 2 < maxHp(o)) continue;
        const d = this.pathDist([x, y], moveTypeOf(b.s, u), u.x, u.y) / Math.max(1, movePoints(o, b.s.items));
        if (d < bd) [bd, bs] = [d, u.slot];
      }
      // (one who cannot be there before the escorts would only walk alone into the enemy: 장판파 2nd's
      // exit lies past the enemy's lines)
      if (bs === NONE || bd > et + 1) continue;
      this.parkAt.set(k, bs);
      taken.add(bs);
      this.log?.(`escort: officer ${units[bs].officer} holds the exit ${x},${y} from turn ${b.info.turn + 1}`);
    }
  }

  /** The exit cell this unit holds (updatePark), or null. */
  private parkCellOf(slot: number): [number, number] | null {
    for (const [k, s] of this.parkAt) if (s === slot) return [k % this.b.width, Math.floor(k / this.b.width)];
    return null;
  }

  // ---- farm phase (GrindParams.farm): flat-rate exp on every turn once the battle is safe

  private farmOn = false;

  /** An enemy within `near` steps of one of our units on its own way (a gate waits until none is). */
  private foesNear(near: number): boolean {
    const b = this.b;
    const ours = this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status === Status.Field && u.officer !== 0xffff);
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const E = this.scene.units[i];
      if (E.status !== Status.Field || E.officer === 0xffff) continue;
      const mt = moveTypeOf(b.s, E);
      if (ours.some((u) => this.pathDist([u.x, u.y], mt, E.x, E.y) <= near)) return true;
    }
    return false;
  }

  /** Strength of a side on the field: (level + 5) times the troops share, summed. */
  private sideStrength(player: boolean): number {
    const b = this.b;
    let v = 0;
    for (const u of this.scene.units) {
      if (u.status !== Status.Field || u.officer === 0xffff || (u.slot < PLAYER_SLOTS) !== player) continue;
      const o = b.officerOf(u);
      v += (o.level + 5) * (o.hp / Math.max(1, maxHp(o)));
    }
    return v;
  }

  /**
   * Safe to farm: 유비 and the defeat officer above 60% troops and out of a lethal worst case, no
   * enemy wave due in the next 3 turns, and the enemies left at most farmRatio of our strength.
   * Battles with their own end plans (escape, bonus walk-in, 회남, scripted steps) are left alone.
   */
  private farmSafe(): boolean {
    if (paramOr(this.p, 'farm') <= 0.5 || this.finishing || this.p.native) return false;
    if (this.stepsLeft() > 0 || this.exitPlan || this.hnOn() || (this.bonusCell() && this.bonusOn())) return false;
    const b = this.b;
    const turn = b.info.turn + 1;
    if (turn < 3 || this.enemiesOnField() === 0) return false;
    for (const e of this.know.turns) {
      if (e.turn === null || e.turn < turn || e.turn > turn + 3) continue;
      const foes = e.reinforce.filter((o) => {
        const sl = b.slotOfOfficer(o);
        return sl === NONE || sl >= PLAYER_SLOTS;
      }).length;
      if (foes >= 2) return false;
    }
    // few enemies left (the ones kept alive and one more), weak next to us, and our side in shape
    if (this.enemiesOnField() > Math.max(2, this.p.keep) + 1) return false;
    if (this.sideStrength(false) > this.sideStrength(true) * paramOr(this.p, 'farmRatio')) return false;
    let share = 0, n = 0;
    for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) {
      if (u.status !== Status.Field || u.officer === 0xffff) continue;
      const o = b.officerOf(u);
      share += o.hp / Math.max(1, maxHp(o));
      n++;
    }
    if (!n || share / n < 0.5) return false;
    this.buildThreat();
    for (const off of this.know.guarded) {
      const sl = b.slotOfOfficer(off);
      if (sl === NONE || sl >= PLAYER_SLOTS) continue;
      const u = this.scene.units[sl];
      if (u.status !== Status.Field) continue;
      const o = b.officerOf(u);
      if (o.hp < maxHp(o) * 0.6) return false;
      if (this.danger(u, u.x, u.y).worst >= o.hp * 0.5) return false;
    }
    return true;
  }

  /** The wake phase is running (it holds through the fights it starts). */
  private wakeActive = false;
  /** The field is quiet this turn: every enemy waits (대기 / 부동) and none can hit a unit of ours. */
  private quiet = false;
  private quietCheck(): boolean {
    const b = this.b;
    let n = 0;
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) {
      if (e.status !== Status.Field || e.officer === 0xffff) continue;
      if (e.mode !== AiMode.Wait && e.mode !== AiMode.Hold) return false;
      n++;
    }
    if (!n) return false;
    this.buildThreat();
    for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) {
      if (u.status !== Status.Field) continue;
      const k = u.y * b.width + u.x;
      if ((this.threat[k]?.length ?? 0) > 0 || (this.tthreat[k]?.length ?? 0) > 0) return false;
    }
    return true;
  }
  private wakeOn(): boolean {
    const on = this.wakeCheck();
    if (on !== this.wakeActive) this.log?.(`wake: ${on ? 'on' : 'off'} at turn ${this.b.info.turn + 1}`);
    this.wakeActive = on;
    return on;
  }

  /**
   * The wake phase applies: every enemy on the field waits (대기 / 부동), none far above us, no
   * enemy wave due in the next 3 turns, a fit party, and (to begin) none of them engaged. Battles
   * with their own end plans are left alone.
   */
  private wakeCheck(): boolean {
    if (paramOr(this.p, 'wake') <= 0.5 || this.finishing || this.p.native) return false;
    if (this.exitPlan || this.hnOn() || (this.bonusCell() && this.bonusOn())) return false;
    const b = this.b;
    const turn = b.info.turn + 1;
    // a party to wake them with: three of ours with a quarter of their troops, 유비 above 60%
    // (계교: two fit units and one at 10 troops went back and forth between waking and regrouping)
    let fit = 0;
    for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) {
      if (!this.controllable(u)) continue;
      const o = b.officerOf(u);
      if (this.know.guarded.has(u.officer) && o.hp < maxHp(o) * 0.6) return false;
      if (o.hp * 4 >= maxHp(o)) fit++;
    }
    if (fit < 3) return false;
    // ... and the enemies left within our strength: none more than 2 levels above our best, their
    // side at most wakeRatio of ours (호로관: 여포 on his gate is never woken by three Lv3 officers)
    let top = 0;
    for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) if (this.controllable(u)) top = Math.max(top, b.officerOf(u).level);
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) if (e.status === Status.Field && e.officer !== 0xffff && b.officerOf(e).level > top + 2) return false;
    if (this.sideStrength(false) > this.sideStrength(true) * paramOr(this.p, 'wakeRatio')) return false;
    for (const e of this.scene.units.slice(PLAYER_SLOTS)) {
      if (e.status === Status.Field && e.officer !== 0xffff && e.mode !== AiMode.Wait && e.mode !== AiMode.Hold) return false;
    }
    if (!this.enemiesOnField()) return false;
    for (const e of this.know.turns) if (e.turn !== null && e.turn >= turn && e.turn <= turn + 3 && e.reinforce.length > 0) return false;
    // ... and, to begin, none of them engaged: no unit of ours stands where one can hit it (a 대기
    // unit fighting next to us stays in its mode; that fight is the usual grind and finish); once
    // begun, the phase holds through the fights it starts
    return this.wakeActive || this.quiet;
  }

  /** Turns the finish needs from here, doubled for safety half again, plus farmEnd. */
  /** Turns the finish needs while the band farm runs (to the last turns: bfEnd spare). */
  private bandNeed(): number {
    return this.finishEstimate() + paramOr(this.p, 'bfEnd');
  }

  private farmNeed(): number {
    return Math.ceil(this.finishEstimate() * 1.5) + paramOr(this.p, 'farmEnd');
  }

  /**
   * Turns the finish needs: walking to what wins the battle (a win cell, an adjacency partner, the
   * victory officer, or every enemy) and killing it with the hits of our units (the best four per
   * target, physical damage 1cb6:df14).
   */
  private finishEstimate(): number {
    const b = this.b;
    const ours = this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => this.controllable(u));
    if (!ours.length) return 0;
    const turnsTo = (u: Unit, at: [number, number], reach: number) => {
      const mp = Math.max(1, movePoints(b.officerOf(u), b.s.items));
      return Math.ceil(Math.max(0, this.pathDist(at, moveTypeOf(b.s, u), u.x, u.y) - reach) / mp);
    };
    const cells = this.wcells();
    if (cells.length) {
      let best = 99;
      for (const c of cells) {
        const at: [number, number] = [(c.x0 + c.x1) >> 1, (c.y0 + c.y1) >> 1];
        for (const u of ours) if (c.officer === u.officer || c.officer === 0x400) best = Math.min(best, turnsTo(u, at, 0));
      }
      if (best < 99) return best + 1;
    }
    for (const a of this.wadj()) {
      const s2 = b.slotOfOfficer(a.other);
      if (s2 === NONE || this.scene.units[s2].status !== Status.Field) continue;
      const T = this.scene.units[s2];
      for (const u of ours) if (u.officer === a.actor || a.actor === 0x400) return turnsTo(u, [T.x, T.y], 1) + 1;
    }
    const v = this.victoryNow();
    const vs = v !== null ? b.slotOfOfficer(v) : NONE;
    const targets = vs !== NONE && this.scene.units[vs].status === Status.Field ? [this.scene.units[vs]] : this.scene.units.slice(PLAYER_SLOTS).filter((e) => e.status === Status.Field);
    let walk = 0, kill = 0, hpSum = 0, dmgSum = 0;
    for (const T of targets) {
      const ot = b.officerOf(T);
      let near = 99;
      const dmgs: number[] = [];
      for (const u of ours) {
        const o = b.officerOf(u);
        const range = CLASS_RANGE[o.cls];
        near = Math.min(near, turnsTo(u, [T.x, T.y], range === 0 || range === NONE ? 1 : 2));
        dmgs.push(
          physicalDamage({
            attack: attackPower(o, u.morale, b.s.items),
            defence: defencePower(ot, T.morale, b.s.items),
            attackerClass: o.cls,
            defenderClass: ot.cls,
            defenderTerrain: terrainAt(b.s, T.x, T.y),
            defenderHp: 0xffff,
            counter: false,
          }),
        );
      }
      dmgs.sort((x, y) => y - x);
      const d = Math.max(1, dmgs.slice(0, 4).reduce((a, c) => a + c, 0));
      walk = Math.max(walk, near);
      kill = Math.max(kill, Math.ceil(ot.hp / d));
      hpSum += ot.hp;
      dmgSum += dmgs.reduce((a, c) => a + c, 0);
    }
    kill = Math.max(kill, Math.ceil(hpSum / Math.max(1, dmgSum)));
    return walk + kill;
  }

  /** The last third of the battle (turn limit, or a losing turn event before it). */
  private lateThird(): boolean {
    const lim = Math.min(this.b.info.turnLimit, this.know.deadline ?? 999);
    return (this.b.info.turn + 1) * 3 >= lim * 2;
  }

  /**
   * The finish may go for the enemy leader / the escape cell / a battle-ending event only in the
   * last third, once few enemies remain (a rout), or when the script's pending steps need the time
   * (서주 2nd); otherwise the finish routs: nearest enemies, the leader spared (Sukwon).
   */
  private charge(): boolean {
    if (!this.finishing) return false;
    if (this.stats.finishReason === 'escape') return true;
    // the bonus arrival still possible: no charge at the leader; the walk-in comes when it is time
    if (this.bonusOn()) return false;
    if (this.lateThird() || this.enemiesOnField() <= 3) return true;
    const stepTurns = this.stepsLeft() * 12;
    return stepTurns > 0 && this.deadline() - this.b.info.turn <= this.p.finish + stepTurns;
  }


  // ---- threat map: which enemies can attack each cell next phase

  private buildThreat() {
    const b = this.b;
    const n = b.width * b.height;
    this.enemyTactics.clear();
    this.targetCount.clear();
    this.riskMemo.clear();
    const rain = WEATHER_TYPE[b.info.weather] === RAIN;
    const parts: { i: number; r: { threat: number[]; tthreat: number[]; loose: number[] } }[] = [];
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const e = this.scene.units[i];
      if (e.status !== Status.Field || e.flags & UnitFlag.Confused || e.mode === AiMode.MoveNoAttack) continue;
      const oe = b.officerOf(e);
      const range = CLASS_RANGE[oe.cls];
      // damage tactics the AI could cast (d0fa/d2c4 consider every castable one)
      const tacs = castableTactics(oe, e.mp, b.learn).filter((t) => t <= 14 && !(rain && t < 5));
      this.enemyTactics.set(i, tacs);
      if (range === NONE && !tacs.length) continue;
      const mp = e.mode === AiMode.Hold ? 0 : movePoints(oe, b.s.items);
      const area = tacs.length ? Math.max(...tacs.map((t) => TACTIC_POWER[t])) | 0x80 : NONE;
      parts.push({ i, r: this.enemyReach(e, oe.cls, mp, range, area) });
    }
    // reinforcements a turn event brings in this turn or the next (거록: five units at turn 3, one
    // of them cast a 421 fire on 유비 who stood where nothing threatened him): they enter at their
    // deployment records and act in that enemy phase
    this.incoming.clear();
    const cur = b.info.turn + 1;
    for (const ev of this.know.turns) {
      if (ev.turn === null || (ev.turn !== cur && ev.turn !== cur + 1)) continue;
      for (const off of ev.reinforce) {
        const i = b.slotOfOfficer(off);
        if (i === NONE || i < PLAYER_SLOTS || this.scene.units[i].status !== Status.Reserve) continue;
        const rec = this.scene.ctx.vm.state.units.find((d) => d.officer === off);
        if (!rec || rec.x >= b.width || rec.y >= b.height) continue;
        const R = this.scene.units[i];
        const e = Object.assign(Object.create(Object.getPrototypeOf(R)) as Unit, R, { x: rec.x, y: rec.y, status: Status.Field });
        const oe = b.officerOf(e);
        const range = CLASS_RANGE[oe.cls];
        const tacs = castableTactics(oe, e.mp, b.learn).filter((t) => t <= 14 && !(rain && t < 5));
        this.enemyTactics.set(i, tacs);
        if (range === NONE && !tacs.length) continue;
        const mp = e.mode === AiMode.Hold ? 0 : movePoints(oe, b.s.items);
        const area = tacs.length ? Math.max(...tacs.map((t) => TACTIC_POWER[t])) | 0x80 : NONE;
        this.incoming.add(i);
        parts.push({ i, r: this.enemyReach(e, oe.cls, mp, range, area) });
      }
    }
    parts.sort((a, z) => a.i - z.i);
    // nothing changed since the last build (same enemies, same cached reaches): keep the maps
    const last = this.lastParts;
    if (last && last.length === parts.length && last.every((q, j) => q.i === parts[j].i && q.r === parts[j].r) && this.threat.length === n) return;
    this.lastParts = parts;
    this.threat = Array.from({ length: n }, () => []);
    this.tthreat = Array.from({ length: n }, () => []);
    this.loose = Array.from({ length: n }, () => []);
    for (const { i, r } of parts) {
      for (const k of r.threat) this.threat[k].push(i);
      for (const k of r.tthreat) this.tthreat[k].push(i);
      for (const k of r.loose) this.loose[k].push(i);
    }
  }
  private lastParts: { i: number; r: { threat: number[]; tthreat: number[]; loose: number[] } }[] | null = null;
  /** Reserve enemy slots counted as threats (they arrive by a turn event before the next enemy phase ends). */
  private incoming = new Set<number>();

  /**
   * One enemy's reach (cells it can attack / hit with a tactic / attack ignoring zones of control and
   * our other units), cached: the floods only see the units within mp+1 cells of it, so the result
   * is reused while none of those moved (most of our phase: one unit moves at a time).
   */
  private reachCache = new Map<number, { key: string; threat: number[]; tthreat: number[]; loose: number[] }>();
  private enemyReach(e: Unit, cls: number, mp: number, range: number, area: number): { threat: number[]; tthreat: number[]; loose: number[] } {
    const b = this.b;
    const W = b.width, H = b.height;
    const R = mp + 1;
    const ls = b.slotOfOfficer(0);
    const leaderAt = ls !== NONE && ls < PLAYER_SLOTS && this.scene.units[ls].status === Status.Field ? this.scene.units[ls].y * W + this.scene.units[ls].x : -1;
    // two independent 32-bit hashes of the occupied cells around it
    let h1 = 0x811c9dc5, h2 = 0x9747b28c;
    for (let y = Math.max(0, e.y - R); y <= Math.min(H - 1, e.y + R); y++)
      for (let x = Math.max(0, e.x - R); x <= Math.min(W - 1, e.x + R); x++) {
        const c = y * W + x;
        const v = b.s.unitAt[c];
        if (v === NONE) continue;
        const m = (c << 8) | v;
        h1 = Math.imul(h1 ^ m, 0x01000193);
        h2 = Math.imul(h2 ^ m, 0x5bd1e995) ^ (h2 >>> 13);
      }
    const key = `${e.x},${e.y},${mp},${range},${area},${cls},${e.flags & UnitFlag.Scripted},${leaderAt},${h1},${h2}`;
    const hit = this.reachCache.get(e.slot);
    if (hit && hit.key === key) return hit;
    const n = W * H;
    const grid = new Uint8Array(n);
    floodMove(b.s, e, [e.x, e.y], grid, { flags: 0, maxCost: mp });
    grid[e.y * W + e.x] = 0;
    const seen = new Uint8Array(n);
    const tseen = new Uint8Array(n);
    const threat: number[] = [], tthreat: number[] = [], loose: number[] = [];
    for (let c = 0; c < n; c++) {
      if (grid[c] === NONE) continue;
      const cx = c % W, cy = Math.trunc(c / W);
      if (range !== NONE)
        for (const [x, y] of rangeCells(b.s, cx, cy, range, false)) {
          const k = y * W + x;
          if (!seen[k]) {
            seen[k] = 1;
            threat.push(k);
          }
        }
      if (area !== NONE)
        for (const [x, y] of rangeCells(b.s, cx, cy, area, false)) {
          const k = y * W + x;
          if (!tseen[k]) {
            tseen[k] = 1;
            tthreat.push(k);
          }
        }
    }
    // the same reach without zones of control (our units die or move during the phase and
    // open the way: 소패, a cavalry unit through two fallen units): the leader's worst case
    // ... and through our own units too: the leader moves first, and the units that move after
    // it can open the way (거록: a reinforcement reached 유비 through a cell 관우 left)
    if (range !== NONE) {
      const lifted: number[] = [];
      for (let p = 0; p < PLAYER_SLOTS; p++) {
        const pu = this.scene.units[p];
        if (pu.status !== Status.Field || pu.officer === 0) continue;
        const k = pu.y * W + pu.x;
        if (b.s.unitAt[k] === p) {
          b.s.unitAt[k] = NONE;
          lifted.push(p);
        }
      }
      floodMove(b.s, e, [e.x, e.y], grid, { flags: 1, maxCost: mp });
      for (const p of lifted) b.s.unitAt[this.scene.units[p].y * W + this.scene.units[p].x] = p;
      grid[e.y * W + e.x] = 0;
      const lseen = new Uint8Array(n);
      for (let c = 0; c < n; c++) {
        if (grid[c] === NONE) continue;
        for (const [x, y] of rangeCells(b.s, c % W, Math.trunc(c / W), range, false)) {
          const k = y * W + x;
          if (!lseen[k]) {
            lseen[k] = 1;
            loose.push(k);
          }
        }
      }
    }
    const out = { key, threat, tthreat, loose };
    this.reachCache.set(e.slot, out);
    return out;
  }
  private loose: number[][] = [];
  private tthreat: number[][] = [];
  private enemyTactics = new Map<number, number[]>();

  /** Expected damage of enemy E's best damage tactic on u standing at (x, y). */
  private tacticOn(E: Unit, u: Unit, x: number, y: number): number {
    const b = this.b;
    const oe = b.officerOf(E);
    const o = b.officerOf(u);
    const terrain = terrainAt(b.s, x, y);
    let best = 0;
    for (const t of this.enemyTactics.get(E.slot) ?? []) {
      const e = Math.trunc(t / 5);
      if (!tacticTerrainOk(e, terrain)) continue;
      const [lo, hi] = this.tacticDamageRange(oe, o, e, TACTIC_POWER[t], terrain);
      const pc = tacticSkill(oe);
      let pt = tacticSkill(o) >> 2;
      if (resistsTactics(o.cls)) pt <<= 1;
      const hit = pc > 0 ? Math.max(0, pc - 1 - pt) / pc : 0;
      best = Math.max(best, ((lo + hi) / 2) * hit);
    }
    return best;
  }

  /** Our units each enemy can reach this phase (its attention is shared between them). */
  private targetsOf(e: number): number {
    let n = this.targetCount.get(e);
    if (n === undefined) {
      n = 0;
      const b = this.b;
      for (let i = 0; i < PLAYER_SLOTS; i++) {
        const u = this.scene.units[i];
        if (u.status === Status.Field && (this.threat[u.y * b.width + u.x] ?? []).includes(e)) n++;
      }
      this.targetCount.set(e, n);
    }
    return n;
  }
  private targetCount = new Map<number, number>();

  /**
   * Danger at (x, y) for u: `worst` = every enemy that can reach the cell hits u (used for the
   * leader), `expected` = each enemy's damage shared between the units it can reach.
   */
  private danger(u: Unit, x: number, y: number): { worst: number; expected: number; n?: number } {
    const b = this.b;
    let worst = 0, expected = 0, n = 0;
    const k = y * b.width + x;
    const here = this.threat[u.y * b.width + u.x] ?? [];
    const phys = this.threat[k] ?? [];
    const tac = this.tthreat[k] ?? [];
    const guarded = this.know.guarded.has(u.officer);
    const loose = guarded ? (this.loose[k] ?? []) : [];
    for (const e of new Set([...phys, ...tac, ...loose])) {
      const E = this.scene.units[e];
      if (!phys.includes(e) && !tac.includes(e)) {
        // reachable only through our lines: counts for the worst case alone
        if ((E.status === Status.Field || this.incoming.has(e)) && E.officer !== 0xffff) {
          worst += this.hitOn(E, u, x, y);
          n++;
        }
        continue;
      }
      // the map is built at the start of the phase: units removed since then no longer threaten
      if ((E.status !== Status.Field && !this.incoming.has(e)) || E.officer === 0xffff) continue;
      const d = Math.max(phys.includes(e) ? this.hitOn(E, u, x, y) : 0, tac.includes(e) ? this.tacticOn(E, u, x, y) : 0);
      worst += d;
      if (d > 0) n++;
      expected += d / Math.max(1, this.targetsOf(e) + (here.includes(e) ? 0 : 1));
    }
    return { worst, expected, n };
  }

  // ---- grinding phase: the best (cell, action) for one unit

  private reachable(u: Unit): [number, number][] {
    const b = this.b;
    const o = b.officerOf(u);
    const grid = b.s.grid;
    if (u.flags & UnitFlag.Moved) return [[u.x, u.y]];
    floodMove(b.s, u, [u.x, u.y], grid, { flags: 0, maxCost: movePoints(o, b.s.items) });
    const out: [number, number][] = [[u.x, u.y]];
    for (let c = 0; c < grid.length; c++) {
      if (grid[c] === NONE) continue;
      const x = c % b.width, y = Math.trunc(c / b.width);
      if ((x !== u.x || y !== u.y) && b.s.unitAt[c] === NONE) out.push([x, y]);
    }
    return out;
  }

  /** Steps from (x, y) to `goal` over cells this move type can enter (terrain only; cached). */
  private distMaps = new Map<string, Uint16Array>();
  /** Walking distance to the nearest enemy (multi-source flood over passable terrain, cached per enemy layout). */
  private foeMaps = new Map<string, Uint16Array>();
  private foeDist(enemies: Unit[], mt: number, x: number, y: number): number {
    const b = this.b;
    const W = b.width, H = b.height;
    const key = `${mt}|${enemies.map((e) => e.y * W + e.x).join(',')}`;
    let m = this.foeMaps.get(key);
    if (!m) {
      if (this.foeMaps.size > 64) this.foeMaps.clear();
      m = new Uint16Array(W * H).fill(0xffff);
      const q: number[] = [];
      for (const e of enemies) {
        const c = e.y * W + e.x;
        if (m[c] !== 0) {
          m[c] = 0;
          q.push(c);
        }
      }
      for (let h = 0; h < q.length; h++) {
        const c = q[h], cx = c % W, cy = (c - cx) / W;
        for (const [nx, ny] of [[cx, cy - 1], [cx + 1, cy], [cx, cy + 1], [cx - 1, cy]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (m[k] !== 0xffff || moveCost(mt, b.s.terrain[k]) === 0xff) continue;
          m[k] = m[c] + 1;
          q.push(k);
        }
      }
      this.foeMaps.set(key, m);
    }
    const d = m[y * W + x];
    if (d !== 0xffff) return d;
    let md = 99;
    for (const e of enemies) md = Math.min(md, Math.abs(e.x - x) + Math.abs(e.y - y));
    return md + 20;
  }
  /** (x, y) is reachable from `goal` over the terrain (pathDist's map). */
  private reaches(goal: [number, number], mt: number, x: number, y: number): boolean {
    this.pathDist(goal, mt, x, y);
    return this.distMaps.get(`${goal[0]},${goal[1]},${mt}`)![y * this.b.width + x] !== 0xffff;
  }

  private pathDist(goal: [number, number], mt: number, x: number, y: number): number {
    const b = this.b;
    const W = b.width, H = b.height;
    const key = `${goal[0]},${goal[1]},${mt}`;
    let m = this.distMaps.get(key);
    if (!m) {
      m = new Uint16Array(W * H).fill(0xffff);
      const q: number[] = [goal[1] * W + goal[0]];
      m[q[0]] = 0;
      for (let h = 0; h < q.length; h++) {
        const c = q[h], cx = c % W, cy = (c - cx) / W;
        for (const [nx, ny] of [[cx, cy - 1], [cx + 1, cy], [cx, cy + 1], [cx - 1, cy]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (m[k] !== 0xffff || moveCost(mt, b.s.terrain[k]) === 0xff) continue;
          m[k] = m[c] + 1;
          q.push(k);
        }
      }
      this.distMaps.set(key, m);
    }
    const d = m[y * W + x];
    return d === 0xffff ? Math.abs(goal[0] - x) + Math.abs(goal[1] - y) + 20 : d;
  }

  /**
   * Terrain worth of a cell (verified tables: TERRAIN_DEFENCE cuts physical damage taken by that
   * percent, defender side only — 1cb6:df14 has no attacker-terrain term; villages and fortresses
   * restore troops and morale at the turn start, barracks troops): a defensive cell counts where
   * enemies can reach it, a healing cell counts by the troops missing.
   */
  private terrainValue(u: Unit, x: number, y: number, hp: number, max: number): number {
    const b = this.b;
    const t = terrainAt(b.s, x, y);
    const k = y * b.width + x;
    const def = terrainDefence(t);
    const exposed = (this.threat[k]?.length ?? 0) + (this.tthreat[k]?.length ?? 0) > 0;
    let v = def < 100 ? (def / 10) * (exposed ? 1 : 0.2) : 0;
    if (t === TERRAIN_VILLAGE || t === TERRAIN_FORTRESS || t === TERRAIN_BARRACKS) v += (1 - hp / Math.max(1, max)) * 8;
    return v * this.p.terrain * (this.know.guarded.has(u.officer) ? 1.5 : 1);
  }

  /** Group number of the script's current group (only its records can fire). */
  private activeGroup(): number {
    const st = this.scene.ctx.vm.state;
    if (st.block !== this.know.block) return -1;
    return this.know.stage?.blocks[st.block]?.records[st.group]?.group ?? -1;
  }

  /** The step the script waits for now (서주 2nd: defeat 89, then 유비 into the south area), or null. */
  private step(): BattleKnowledge['steps'][number] | null {
    if (!this.know.steps.length) return null;
    const g = this.activeGroup();
    return this.know.steps.find((s) => s.group === g) ?? null;
  }

  /** Win cells that can fire now: a pending arrival step stands in for them. */
  private wcells(): BattleKnowledge['winCells'] {
    const st = this.step();
    if (!st) return this.know.winCells;
    return st.trigger === 12 ? [] : [{ officer: st.officer, x0: st.x0, y0: st.y0, x1: st.x1, y1: st.y1 }];
  }

  private wadj(): BattleKnowledge['winAdj'] {
    return this.step() ? [] : this.know.winAdj;
  }

  /** The officer whose defeat moves the battle on now: a pending defeat step, else the victory officer. */
  private victoryNow(): number | null {
    if (this.bonusOn()) return null;
    const st = this.step();
    if (st) return st.trigger === 12 ? st.officer : null;
    return this.know.victory;
  }

  /** Steps still to do (each needs time in the finish). */
  private stepsLeft(): number {
    if (!this.know.steps.length) return 0;
    const g = this.activeGroup();
    return this.know.steps.filter((s) => s.group >= g).length;
  }

  private winCell(u: Unit, x: number, y: number): boolean {
    for (const w of this.wcells())
      if ((w.officer === u.officer || w.officer === 0x400) && x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1) return true;
    return false;
  }

  /** Where a unit heads in the finish: its winning cell, else the victory officer, else null (nearest enemy). */
  private goalFor(u: Unit): [number, number] | null {
    const w = this.wcells().find((c) => c.officer === u.officer || c.officer === 0x400);
    if (w) return [(w.x0 + w.x1) >> 1, (w.y0 + w.y1) >> 1];
    const adj = this.wadj().find((a) => a.actor === u.officer || a.actor === 0x400);
    const target = adj ? adj.other : this.victoryNow();
    if (target !== null && target !== undefined) {
      const s = this.b.slotOfOfficer(target);
      if (s !== NONE && this.scene.units[s].status === Status.Field) return [this.scene.units[s].x, this.scene.units[s].y];
    }
    return null;
  }

  /** An adjacency event that ends the battle fires when this unit acts next to its partner. */
  private winAdjacent(u: Unit, x: number, y: number): boolean {
    for (const a of this.wadj()) {
      if (a.actor !== u.officer && !(a.actor === 0x400 && u.slot < PLAYER_SLOTS)) continue;
      const s = this.b.slotOfOfficer(a.other);
      if (s === NONE || this.scene.units[s].status !== Status.Field) continue;
      const o = this.scene.units[s];
      if (Math.abs(o.x - x) + Math.abs(o.y - y) === 1) return true;
    }
    return false;
  }

  /** (x, y) is next to an ending adjacency target whose actor (another unit, within 6 cells) has not reached it. */
  private blocksActor(u: Unit, x: number, y: number): boolean {
    for (const a of this.wadj()) {
      if (a.actor === u.officer || a.actor === 0x400) continue;
      const s = this.b.slotOfOfficer(a.other);
      const as = this.b.slotOfOfficer(a.actor);
      if (s === NONE || as === NONE || as >= PLAYER_SLOTS) continue;
      const T = this.scene.units[s], A = this.scene.units[as];
      if (T.status !== Status.Field || A.status !== Status.Field) continue;
      const da = Math.abs(A.x - T.x) + Math.abs(A.y - T.y);
      if (da <= 1 || da > 6) continue;
      if (Math.abs(T.x - x) + Math.abs(T.y - y) === 1) return true;
    }
    return false;
  }

  /**
   * u is the named actor of an ending duel / persuasion that gives levels, and it is time: the finish,
   * the last two turns, or the actor about to fall (below 40% troops, a lethal blow where it stands)
   * once only the partner is left or in the last third (earlier, the others keep grinding: 신도's
   * 장비-순우경 at turn 13 cut the battle short).
   */
  private duelNow(u: Unit, hp: number, max: number): boolean {
    if (this.bonusOn()) return false;
    const mine = this.wadj().filter((a) => a.actor === u.officer && this.know.gains.some((g) => g.trigger === 4 && g.actor === u.officer && g.other === a.other && g.levels.length && !this.fired.has(g.record)));
    if (!mine.length) return false;
    if ((this.finishing && !this.endHeld()) || this.deadline() - this.b.info.turn <= 2) return true;
    if (hp < max * 0.4 && (this.enemiesOnField() <= 1 || this.lateThird()) && this.danger(u, u.x, u.y).worst >= hp) return true;
    return false;
  }

  /** u is the actor of an unfired duel / persuasion (ending or not) with enemy officer `off`: acting next to it fires the event, killing it would waste it. */
  private ownDuel(u: Unit, off: number): boolean {
    for (const a of this.wadj()) if (a.actor === u.officer && a.other === off) return true;
    for (const g of this.know.gains)
      if ((g.kind === 'duel' || g.kind === 'persuade') && g.actor === u.officer && g.other === off && !this.fired.has(g.record)) return true;
    return false;
  }

  // ---- combat exp per enemy troop (GrindParams.cbPrice)

  /** Enemy slot -> exp per troop point the best of our units near it earns hitting it (its troops' price). */
  private price = new Map<number, number>();
  private priceScale = 0;
  private priceFloor = 0;
  private priceFade = 0;

  /** Healing terrain (village, fortress: troops and morale; barracks: troops) under an enemy. */
  private healCell(E: Unit): boolean {
    const t = terrainAt(this.b.s, E.x, E.y);
    return t === TERRAIN_VILLAGE || t === TERRAIN_FORTRESS || t === TERRAIN_BARRACKS;
  }

  /**
   * Each enemy's price: over our controllable units within their move + range + cbReach cells of
   * it, the best weighted hit exp per damage point (1cb6:e2f4 exp, 1cb6:df14 damage at its cell).
   */
  private buildPrice() {
    this.price.clear();
    if (!(paramOr(this.p, 'cbPrice') > 0) || this.finishing) return;
    const b = this.b;
    const reach = paramOr(this.p, 'cbReach');
    // only while we have the upper hand: against a stronger side every kill is safety first
    const se = this.sideStrength(false), so = this.sideStrength(true);
    const gate = paramOr(this.p, 'cbGate');
    this.priceScale = 1 - gate + gate * Math.min(1, Math.max(0, 2 * (1 - se / Math.max(1, so))));
    // a blow that does not kill takes nothing off the enemy's attack (1cb6:df14 does not read the
    // attacker's troops): it may be charged cbBase of the price even while outnumbered
    this.priceFloor = paramOr(this.p, 'cbBase');
    // ... and fading out towards the finish: the last turns need the enemies down
    const left = this.deadline() - b.info.turn - this.p.finish;
    this.priceFade = Math.min(1, Math.max(0, (left - 6) / 6));
    if (!this.priceFade || !(Math.max(this.priceScale, this.priceFloor) > 0)) return;
    // the units in shape to take the hits (a hurt one is pulled back to heal)
    const ours = this.scene.units.slice(0, PLAYER_SLOTS).filter((u) => this.controllable(u) && u.officer < 0x100 && CLASS_RANGE[b.officerOf(u).cls] !== NONE && b.officerOf(u).hp >= maxHp(b.officerOf(u)) * 0.5);
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
      const E = this.scene.units[i];
      if (E.status !== Status.Field || E.officer === 0xffff) continue;
      const oe = b.officerOf(E);
      // an enemy that can hit the leader or a hurt unit of ours next phase is fought as before
      let hot = false;
      for (const a of this.scene.units.slice(0, PLAYER_SLOTS)) {
        if (a.status !== Status.Field || a.officer === 0xffff) continue;
        const oa = b.officerOf(a);
        if (!this.know.guarded.has(a.officer) && oa.hp >= maxHp(oa) * 0.6) continue;
        if ((this.threat[a.y * b.width + a.x] ?? []).includes(i)) hot = true;
      }
      if (hot) continue;
      let best = 0;
      for (const u of ours) {
        const o = b.officerOf(u);
        const far = movePoints(o, b.s.items) + (CLASS_RANGE[o.cls] === 0 ? 1 : 2) + reach;
        if (Math.abs(u.x - E.x) + Math.abs(u.y - E.y) > far) continue;
        const w = this.weight(u.slot);
        const dmg = physicalDamage({
          attack: attackPower(o, u.morale, b.s.items),
          defence: defencePower(oe, E.morale, b.s.items),
          attackerClass: o.cls,
          defenderClass: oe.cls,
          defenderTerrain: terrainAt(b.s, E.x, E.y),
          defenderHp: 0xffff,
          counter: false,
        });
        best = Math.max(best, (w * combatExp(true, o.level, oe.level, false, i)) / Math.max(1, dmg));
      }
      this.price.set(i, best);
    }
  }

  /**
   * What `dmg` troops of enemy `e` cost in exp not earned later: its price times the damage (less
   * on healing terrain, it comes back), plus, for a kill on healing terrain, the hits it would
   * have kept giving.
   */
  private troopCost(e: number, dmg: number, lethal: boolean, w: number): number {
    const k = paramOr(this.p, 'cbPrice');
    if (!(k > 0) || this.finishing) return 0;
    const lam = this.price.get(e) ?? 0;
    if (!lam) return 0;
    const E = this.scene.units[e];
    const heal = this.healCell(E) ? paramOr(this.p, 'cbHeal') : 0;
    let c = k * this.priceFade * (lethal ? this.priceScale : Math.max(this.priceScale, this.priceFloor)) * lam * dmg * (1 - heal);
    if (lethal && heal > 0) {
      const left = Math.max(0, this.deadline() - this.b.info.turn - this.p.finish);
      c += heal * w * 8 * Math.min(6, left / 2);
    }
    return c;
  }

  /**
   * Where a badly hurt unit goes to heal (cbMend): the nearest village / fortress / barracks it can
   * walk to that no enemy stands on, the cells enemies can attack counted as 4 steps more. It comes
   * back with 150..250 troops a turn (1cb6:7cc8) and earns again instead of waiting out the battle.
   */
  private mendGoal(u: Unit): [number, number] | null {
    const b = this.b;
    const W = b.width, H = b.height;
    const mt = moveTypeOf(b.s, u);
    let best: [number, number] | null = null, bv = 1e9;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const t = b.s.terrain[y * W + x];
        if (t !== TERRAIN_VILLAGE && t !== TERRAIN_FORTRESS && t !== TERRAIN_BARRACKS) continue;
        if (Math.abs(x - u.x) + Math.abs(y - u.y) > 16) continue;
        const s2 = unitAt(b.s, x, y);
        if (s2 !== NONE && s2 !== u.slot) continue;
        const d = this.pathDist([x, y], mt, u.x, u.y);
        if (d > 18) continue;
        const v = d + 4 * Math.min(2, (this.threat[y * W + x]?.length ?? 0) + (this.tthreat[y * W + x]?.length ?? 0));
        if (v < bv) [bv, best] = [v, [x, y]];
      }
    return best;
  }

  /**
   * Counterattack exp a unit at (x, y) can expect over the enemy phase (1cb6:e42e: a class with
   * attack type 0 hits back at physical attacks of types 0 / 2 / 5 with chance force/150, and the
   * counter pays it the usual hit exp): each enemy that can reach the cell, shared between its targets.
   */
  private counterValue(u: Unit, x: number, y: number): number {
    const b = this.b;
    const o = b.officerOf(u);
    if (CLASS_ATTACK_TYPE[o.cls] !== 0) return 0;
    const pc = Math.min(1, o.force / 150);
    let v = 0;
    const here = this.threat[u.y * b.width + u.x] ?? [];
    for (const e of this.threat[y * b.width + x] ?? []) {
      const E = this.scene.units[e];
      if (E.status !== Status.Field || E.officer === 0xffff) continue;
      const oe = b.officerOf(E);
      const at = CLASS_ATTACK_TYPE[oe.cls];
      if (at !== 0 && at !== 2 && at !== 5) continue;
      v += (pc * combatExp(true, o.level, oe.level, false, e)) / Math.max(1, this.targetsOf(e) + (here.includes(e) ? 0 : 1));
    }
    return v;
  }

  private bestAction(u: Unit): Action {
    const b = this.b;
    const fin = this.finishing;
    const farming = this.farmOn && !fin;
    const slot = u.slot;
    const o = b.officerOf(u);
    // the leader's levels keep every later battle winnable: its exp counts double
    const w = this.weight(slot) * (this.know.guarded.has(u.officer) ? 2 : 1);
    const hp = Math.max(1, o.hp);
    const max = maxHp(o);
    const guarded = this.know.guarded.has(u.officer);
    const home: [number, number] = [u.x, u.y];
    const turnsLeft = Math.max(1, this.deadline() - b.info.turn);
    // what the unit is still worth in this battle: its exp to come (losing it ends that)
    const future = 10 + w * Math.min(turnsLeft, 10) * 4;
    // the leader heads only for a winning cell of its own (거록: 유비 reaching the gate wins)
    // ... unless the walk there is a long way round (하비: (0,2) lies past a river, the only way runs
    // through the enemy's lines; the old win by defeating everyone is the safer one)
    const own = this.wcells().find((c) => {
      if (c.officer !== u.officer) return false;
      if (!guarded) return true;
      const cx = (c.x0 + c.x1) >> 1, cy = (c.y0 + c.y1) >> 1;
      return this.pathDist([cx, cy], moveTypeOf(b.s, u), u.x, u.y) <= (Math.abs(cx - u.x) + Math.abs(cy - u.y)) * 1.5 + 6;
    });
    // ... or an enemy it wins by acting next to (태산: 유비 persuading 이명)
    const ownAdj = this.wadj().find((a) => a.actor === u.officer);
    const adjAt = ownAdj ? (() => { const s2 = b.slotOfOfficer(ownAdj.other); return s2 !== NONE && this.scene.units[s2].status === Status.Field ? ([this.scene.units[s2].x, this.scene.units[s2].y] as [number, number]) : null; })() : null;
    const chg = this.charge();
    const endHeld = this.endHeld();
    // the bonus walk-in heads for its cell whatever the way round: the turns were counted for it
    const walkIn = guarded && u.officer === 0 && fin && this.stats.finishReason === 'escape' && !this.exitPlan ? this.bonusCell() : null;
    // ... and the others clear the way there (the guards of the cell), leaving the spared leader be
    const walkAll = !walkIn && fin && this.stats.finishReason === 'escape' && !this.exitPlan ? this.bonusCell() : null;
    const goal = !fin || !chg ? null : this.hnEsc() ? this.exitPlan!.cell : walkIn ? walkIn : walkAll ? walkAll : guarded ? (own ? ([(own.x0 + own.x1) >> 1, (own.y0 + own.y1) >> 1] as [number, number]) : adjAt) : this.goalFor(u);
    const vNow = this.victoryNow();
    const vslot = vNow !== null ? b.slotOfOfficer(vNow) : NONE;
    let best: Action = { slot, x: u.x, y: u.y, kind: 'wait', target: NONE, tactic: NONE, value: -1e9, exp: 0, lethal: false };
    // the search asks for the best action of each kind too (alternatives for its candidates)
    const alts = this.altK > 0 ? new Map<string, Action>() : null;
    const offer = (a: Action) => {
      if (a.value > best.value) best = a;
      if (alts) {
        const key = actionKey(a);
        const q = alts.get(key);
        if (!q || a.value > q.value) alts.set(key, a);
      }
    };
    const enemies = this.scene.units.filter((e) => e.slot >= PLAYER_SLOTS && e.status === Status.Field);
    let throwBest: Action | null = null;
    const tactics = castableTactics(o, u.mp, b.learn).filter((t) => !(t < 5 && WEATHER_TYPE[b.info.weather] === RAIN));
    const held = u.officer < 0x100 ? b.stateOfficer(u).dyn.items.map((id, index) => ({ id, index })).filter((e) => e.id !== 0xff) : [];
    // danger is the sum over every enemy that can reach the cell (an overestimate: they also have
    // other targets), so the cost rises smoothly from half the troops to one and a half times them
    // expected damage drives the cost for everyone; the leader (유비 / the defeat officer) losing
    // loses the battle, so for it the worst case counts
    // level-aware: a leader weaker than the enemies around keeps a wider margin (worst case at most
    // half its troops at half their level), the full `guard` once it has caught up
    let guardEff = guarded ? this.p.guard * Math.min(1, Math.max(0.5, o.level / Math.max(1, this.enemyLevel()))) : this.p.guard;
    // the leader left alone in the finish (신도: everyone else fallen, 순우경 holding the narrows):
    // waiting loses on time for sure, so only a blow that could end it is refused
    // (not on the bonus walk-in itself: it waits for its way to open, and is given up when it stalls)
    const alone = guarded && fin && this.stats.finishReason !== 'escape' && this.leaderAlone(u);
    if (alone) guardEff = Math.max(guardEff, 1);
    const deathCost = (d: { worst: number; expected: number; n?: number }, p: number) => {
      const r = d.expected / hp;
      const lethal = Math.min(1.5, Math.max(0, r - 0.6));
      let c = this.p.risk * (future * (fin ? 0.3 : 1) * lethal + (w + 0.5) * 4 * Math.min(r, 1) ** 2);
      if (guarded) {
        const rw = d.worst / hp;
        c += 10000 * Math.min(1, Math.max(0, rw - guardEff) * 3) + (alone ? 0 : 100 * Math.min(rw, 1.5) ** 2 + this.p.safe * 60 * (d.n ?? 0));
      }
      return p * c;
    };
    const lone = paramOr(this.p, 'lone');
    const lslot = b.slotOfOfficer(0);
    const leaderPos: [number, number] | null = lslot !== NONE && lslot !== slot && this.scene.units[lslot].status === Status.Field ? [this.scene.units[lslot].x, this.scene.units[lslot].y] : null;
    // a healer with MP walks towards the most hurt ally, so heals (useless on full troops) stay possible
    let healGoal: [number, number] | null = null;
    // (회남 push: healers keep healing on the way, Sukwon)
    if ((!fin || this.hnEsc()) && tactics.some((t) => t >= 21 && t <= 35)) {
      let worst = 0.85;
      // 격려/응원/고무 (21..23, 30..32) restore morale: a unit below 100 morale is a target too
      const moraleHeals = tactics.some((t) => (t >= 21 && t <= 23) || (t >= 27 && t <= 29) || (t >= 30 && t <= 32));
      // (the ally in danger of falling this phase counts as more hurt: healRisk)
      const troopHeals = tactics.some((t) => healKind(t) & 1);
      const hr = paramOr(this.p, 'healRisk');
      for (const a of this.scene.units.slice(0, PLAYER_SLOTS)) {
        if (a.slot === slot || a.status !== Status.Field) continue;
        const oa = b.officerOf(a);
        const f = Math.min(oa.hp / Math.max(1, maxHp(oa)), moraleHeals ? a.morale / 100 + 0.1 : 9) - (troopHeals && hr > 0 ? hr * 0.5 * this.healRisk(a) : 0);
        if (f < worst) {
          worst = f;
          healGoal = [a.x, a.y];
        }
      }
    }
    const plus = (d: { worst: number; expected: number; n?: number }, extra: number) => ({ worst: d.worst + extra, expected: d.expected + extra, n: d.n });
    // the best script gain open to this unit (duel partner, persuasion target, bonus cell): walk to it
    const gg = !fin ? this.gainGoal(u) : null;
    // an open gate this unit walks onto (하비's drawbridge), in the finish too
    const gateAt = this.gateGoal(u);
    const feeding = !fin && !guarded && !this.leaderActed && this.leaderKills.size > 0;
    // a duel with the leader kept for the bonus walk-in would end the battle first (계교: 장비-문추):
    // its actor keeps off the cells next to it
    const vic = this.know.victory;
    const vs = vic !== null && this.spared(vic) && this.ownDuel(u, vic) ? b.slotOfOfficer(vic) : NONE;
    const avoid = vs !== NONE && this.scene.units[vs].status === Status.Field ? this.scene.units[vs] : null;
    // 회남 plan: banned cells and the unit's own anchor (유비 behind, healers / band inside, the rest in front)
    const hnEsc = this.hnEsc();
    const hnLive = this.hnOn() && !fin && !!this.exitPlan;
    const hnBan = hnLive ? this.hnBan : null;
    const hnWeak = hnLive && !guarded && this.hnWeakUnit(u);
    const hnAnc = !hnLive ? null : guarded ? this.hnLeaderAnchor : this.hnInner(u) ? this.hnAnchor : this.hnFrontAt;
    // an ending duel / persuasion of this unit's own is taken once nothing is left to grind (or the
    // actor is about to fall): the battle ends on a level instead of a kill (호로관: 장비-여포)
    const dn = this.duelNow(u, hp, max);
    // badly hurt: walk to a healing cell instead of waiting at the front (not in the small early
    // battles: three units, one gone to heal, left the others to 여포 at 호로관)
    // (any party size while regrouping on a quiet field: 태산, 유비 sat at 164 troops for 15 turns)
    const quietMend = this.quiet && this.regroupUntil >= b.info.turn + 1;
    // the fish pen: the penned enemy, and whether this unit takes part (in shape)
    const penT = this.penning() && !fin ? this.scene.units[this.pen] : null;
    const penOt = penT ? b.officerOf(penT) : null;
    const penMe = !!penT && u.officer < 0x100 && hp * 2 >= max;
    // the band farm: a caster short of MP (after this turn's cast) stands next to a band, the lowest
    // levels first (by weight); one with MP to spare leaves the cell to them
    const bandMe = this.bandFarming && !fin && this.bands.length > 0 && hp * 2 >= max && this.knowsFlat(u);
    const bandSpend = bandMe && tactics.some((t) => t >= 15) ? 4 : 0;
    let bandGoal: [number, number] | null = null;
    if (bandMe && maxMp(o) - u.mp + bandSpend >= 2) {
      let bd = 99;
      for (const s of this.bands) {
        const B = this.scene.units[s];
        if (s === slot || B.status !== Status.Field) continue;
        const d = Math.abs(B.x - u.x) + Math.abs(B.y - u.y);
        if (d < bd) [bd, bandGoal] = [d, [B.x, B.y]];
      }
    }
    // idle walk (GrindParams.idleAp): two commands in a row without exp, in shape, not in the finish
    const idleWalk = !fin && !guarded && hp * 2 >= max && (this.unitIdle.get(slot) ?? 0) >= 2 ? paramOr(this.p, 'idleAp') : 0;
    const idleD0 = idleWalk > 0 && !goal ? (this.p.walk > 0.5 ? this.foeDist(enemies, moveTypeOf(b.s, u), u.x, u.y) : enemies.reduce((m, e) => Math.min(m, Math.abs(e.x - u.x) + Math.abs(e.y - u.y)), 99)) : 99;
    const pk = this.parkCellOf(slot);
    const mend = (!fin || endHeld) && !hnLive && !this.exitPlan && hp < max * (paramOr(this.p, 'cbMend') + (guarded ? 0.2 : 0)) && paramOr(this.p, 'cbMend') > 0 && (quietMend || (fin && endHeld) || this.scene.units.slice(0, PLAYER_SLOTS).filter((v) => this.controllable(v)).length >= 5) ? this.mendGoal(u) : null;
    for (const [x, y] of this.reachable(u)) {
      if ((!chg || endHeld) && !(dn && this.winAdjacent(u, x, y)) && (this.winCell(u, x, y) || this.winAdjacent(u, x, y))) continue;
      if (avoid && Math.abs(avoid.x - x) + Math.abs(avoid.y - y) === 1) continue;
      if (hnEsc && guarded && !this.hnTrapOk(u, x, y)) continue;
      // stand on the cell for the evaluation (range shapes read the unit map)
      b.place(slot, null, x, y);
      // acting on a battle-ending cell (next to the persuasion / duel target, on the win cell) ends
      // the battle before any enemy moves: no danger there (팽성: 유비 kept off 조하 by the guard)
      const dang = (chg || dn) && (this.winAdjacent(u, x, y) || (chg && this.winCell(u, x, y))) ? { worst: 0, expected: 0, n: 0 } : this.danger(u, x, y);
      let base = -deathCost(dang, 1);
      // 회남: keep out of the reach of the waiting units not being peeled
      if (hnBan && hnBan[y * b.width + x]) base -= 300;
      // ... and wake the target alone: someone sturdy stands where only it can reach
      if (hnLive && !guarded && !hnWeak && this.hnBait && this.hnBait[0] === x && this.hnBait[1] === y) base += 30 * (hp / Math.max(1, max));
      const t = terrainAt(b.s, x, y);
      if (hp < max * this.p.retreat && (t === 8 || t === 13 || t === 14)) base += 6;
      // 회남 push: off the one-wide bridge (a unit parked on it, hurt or out of MP, held up the column and
      // 유비 behind it for turns); hurt units make for the villages at either end instead
      if (hnEsc && !guarded && t === 4) base -= 8;
      // stand next to allies: fewer sides open to the enemy
      let mates = 0;
      for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
        if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
        const v = unitAt(b.s, nx, ny);
        if (v !== NONE && v !== slot && sideOf(v)) mates++;
      }
      base += mates * (guarded ? 1.5 : 0.5);
      // a lone cell (no ally next to it) where two or more enemies together could bring the unit down:
      // walked out alone, it is ganged up on (회남: 관우 at T21 and T25, the second time to his fall)
      if (lone > 0 && !guarded && mates === 0 && (dang.n ?? 0) >= 2) base -= lone * this.p.risk * future * Math.min(1, Math.max(0, (dang.worst / hp - 0.9) / 0.6));
      // let a weakened enemy get away to heal (village, its own healers, regeneration) and come back
      // for more hits and tactics: do not stand next to it while grinding
      if (!fin)
        for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
          if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
          const v = unitAt(b.s, nx, ny);
          if (v === NONE || v < PLAYER_SLOTS) continue;
          const E = this.scene.units[v];
          if (E.status !== Status.Field || E.officer === 0xffff) continue;
          const oe = b.officerOf(E);
          if (oe.hp * 10 < maxHp(oe) * 3 && !(penT && v === this.pen)) base -= this.p.conserve * 4;
        }
      // the pen: stand on its sides (it cannot walk off, its blows go to the units next to it), and a
      // unit that hits back earns the counters' hit exp from its attacks (1cb6:e42e)
      if (penMe && penT && penOt && Math.abs(penT.x - x) + Math.abs(penT.y - y) === 1) {
        if (this.penBox) base += paramOr(this.p, 'penCell') * Math.min(1, hp / max);
        const at = CLASS_ATTACK_TYPE[penOt.cls];
        // (the counter's troops are the pen's too: at its price a strong counter costs more than it pays)
        if (CLASS_ATTACK_TYPE[o.cls] === 0 && (at === 0 || at === 2 || at === 5) && !(penT.flags & UnitFlag.Confused))
          base += paramOr(this.p, 'penCounter') * (w * combatExp(true, o.level, penOt.level, false, this.pen) - this.penLam * this.blowOn(u, penT, true)) * Math.min(1, o.force / 150) * 0.5;
      }
      // the end held: a unit that hits back (attack type 0) keeps out of the reach of an enemy whose
      // defeat ends the battle and whom its counter would kill (서주: 53 countered the last enemy dead at T23)
      if (endHeld && CLASS_ATTACK_TYPE[o.cls] === 0)
        for (const e of this.threat[y * b.width + x] ?? []) {
          const E = this.scene.units[e];
          if (E.status !== Status.Field || E.officer === 0xffff || !this.endsBattle(e)) continue;
          const oe = b.officerOf(E);
          const cd = physicalDamage({ attack: attackPower(o, u.morale, b.s.items), defence: defencePower(oe, E.morale, b.s.items), attackerClass: o.cls, defenderClass: oe.cls, defenderTerrain: terrainAt(b.s, E.x, E.y), defenderHp: 0xffff, counter: true });
          if (cd * 1.2 >= oe.hp) base -= 200;
        }
      // a healing cell a weakened enemy we keep alive can reach: left free for it (buildNurse)
      if (this.nurse && this.nurse[y * b.width + x]) base -= 30;
      if (penT && this.penFree && this.penFree[y * b.width + x]) base -= 30;
      let dist = 99;
      // walking distance over passable terrain (a manhattan pull leaves units stuck behind walls
      // and rivers: 서주 2nd, three units waited 20 turns in the corner north of 차주)
      if (goal) dist = this.pathDist(goal, moveTypeOf(b.s, u), x, y);
      else if (this.p.walk > 0.5) dist = this.foeDist(enemies, moveTypeOf(b.s, u), x, y);
      else for (const e of enemies) dist = Math.min(dist, Math.abs(e.x - x) + Math.abs(e.y - y));
      // nothing gained for 2+ turns (the enemy sits and waits): march on it instead of idling
      const anc = !fin && this.holding() ? (hnAnc ?? this.anchorNow()) : null;
      if (mend && quietMend) {
        base -= 2 * this.pathDist(mend, moveTypeOf(b.s, u), x, y);
      } else if (anc) {
        // stay in formation around the anchor: the enemy comes to us; 유비 at its middle
        const da = this.bracing() ? this.pathDist(anc, moveTypeOf(b.s, u), x, y) : Math.abs(anc[0] - x) + Math.abs(anc[1] - y);
        // (회남: firmer while peeling, and for 유비 always: left loose he backed into the south-east
        // corner away from the wave and was cut off there, 3 of 10 seeds lost at turn 14)
        base -= (hnLive && (guarded || this.hnPhase === 'peel') ? 10 : 4) * Math.max(0, da - (guarded ? 1 : 2));
        // bracing: tight around 유비 (the enemy finds no gap to reach him)
        if (this.bracing() && !guarded && leaderPos) base -= 1.5 * Math.max(0, Math.abs(leaderPos[0] - x) + Math.abs(leaderPos[1] - y) - 2);
      } else if (mend) {
        base -= 2 * this.pathDist(mend, moveTypeOf(b.s, u), x, y);
      } else if (penMe && penT && !goal) {
        // the pen: walk up to the penned enemy
        base -= 1.5 * Math.max(0, this.pathDist([penT.x, penT.y], moveTypeOf(b.s, u), x, y) - 1);
      } else if (!(farming && gg)) {
        // (회남 escape: the fort is 40+ steps from the hold; capped at 40 the far units saw no gain in
        // walking and sat out the whole push in the north-east)
        const apW = fin && goal ? 3 : this.idleTurns >= 2 || (farming && hp >= max * 0.5) ? Math.max(1.5, this.p.approach * 0.3) : this.p.approach * 0.3;
        // (the idle walk pulls only over cells no enemy reaches: a step into reach gains nothing over standing)
        if (idleWalk > apW) base -= idleWalk * Math.min((dang.n ?? 0) > 0 ? Math.max(dist, idleD0) : dist, 40);
        else base -= apW * Math.min(dist, hnEsc ? 200 : 40);
        // the leader levels like the others: it walks up to the fight instead of waiting at the back
        if (!fin && guarded && this.p.lead && !goal) base -= this.p.lead * Math.max(0, dist - 1);
      }
      if (!fin && !guarded && leaderPos) base -= this.p.escort * Math.max(0, Math.abs(leaderPos[0] - x) + Math.abs(leaderPos[1] - y) - 3);
      if (healGoal) base -= this.p.heal * 0.4 * Math.max(0, Math.abs(healGoal[0] - x) + Math.abs(healGoal[1] - y) - 1);
      if (this.p.band) base += this.bandValue(u, x, y, w);
      if (bandMe) {
        const g = this.bandGain(u, x, y, bandSpend);
        base += paramOr(this.p, 'bfCell') * w * g;
        if (!g && bandGoal) base -= 0.8 * Math.max(0, Math.abs(bandGoal[0] - x) + Math.abs(bandGoal[1] - y) - 1);
      }
      if (this.p.terrain) base += this.terrainValue(u, x, y, hp, max);
      // a counterattacking unit in shape where enemies will attack it: the counters pay hit exp
      if (!fin && !guarded && hp >= max * 0.7) base += paramOr(this.p, 'cbCounter') * w * this.counterValue(u, x, y) * Math.max(0, 1 - dang.worst / hp);
      // (farm phase: safe now, so the open gain, a +50 bonus cell for everyone, is walked to in earnest)
      if (gg && farming) base -= 3 * Math.max(0, this.pathDist(gg.at, moveTypeOf(b.s, u), x, y) - 1);
      else if (gg) base -= Math.min(3, gg.value / 100) * Math.max(0, Math.abs(gg.at[0] - x) + Math.abs(gg.at[1] - y) - 1);
      base += this.gainAt(u, x, y) * (fin ? 0.5 : 1);
      // an open gate: its officer walks onto the cell
      if (gateAt) base += gateAt[0] === x && gateAt[1] === y ? 200 : -4 * Math.min(this.pathDist(gateAt, moveTypeOf(b.s, u), x, y), 40);
      // escort exit: the unit holding it stands on the cell (the 백성's arrival there ends the battle)
      if (pk) base += pk[0] === x && pk[1] === y ? 300 : -20 * Math.min(this.pathDist(pk, moveTypeOf(b.s, u), x, y), 60);
      if ((chg || dn) && this.winAdjacent(u, x, y)) base += 400;
      // leave the cells next to an ending duel / persuasion target to its actor once it is close
      if (chg && this.blocksActor(u, x, y)) base -= 15;
      // a treasure cell not yet stepped on this battle (its event gives an item once)
      if (!fin && this.know.treasure.some((t) => t.x === x && t.y === y && (t.officer === u.officer || t.officer === 0x400) && !this.looted.has(y * b.width + x))) base += 40;
      if (base > best.value || alts) offer({ slot, x, y, kind: 'wait', target: NONE, tactic: NONE, value: base, exp: 0, lethal: false, danger: dang.worst });
      // physical attacks
      const range = CLASS_RANGE[o.cls];
      if (range !== NONE)
        for (const d of unitsInRange(b.s, u, range, x, y, false)) {
          const D = this.scene.units[d];
          if (!(D.flags & UnitFlag.Visible)) continue;
          const od = b.officerOf(D);
          const dmg = physicalDamage({
            attack: attackPower(o, u.morale, b.s.items),
            defence: defencePower(od, D.morale, b.s.items),
            attackerClass: o.cls,
            defenderClass: od.cls,
            defenderTerrain: terrainAt(b.s, D.x, D.y),
            defenderHp: od.hp,
            counter: false,
          });
          const lethal = dmg >= od.hp;
          // the pen is not finished while it holds, nor left for our counters to finish
          const penHit = !!penT && d === this.pen;
          if (penHit && (lethal || od.hp - dmg <= this.penReserve)) continue;
          // (pen on) an enemy we keep is not driven off by morale either: confused at 0 morale it leaves (1cb6:a0d0)
          if (!lethal && !fin && (this.penOn() || this.bandOn()) && this.moraleLeaves(D, moraleLoss(1, dmg, od.hp, od.level, D.morale)) && (penHit || !this.killOk(d))) continue;
          // the blow that ends the battle waits for the last turns (endHeld)
          if (lethal && this.endHeld() && this.endsBattle(d)) continue;
          // the leader may always take a kill (except a protected enemy): a kill is its safest exp
          // (the target cannot hit back) and a low-level leader is the usual reason battles are lost
          const kg = lethal ? this.killGain(D.officer) : 0;
          if (lethal && !kg && !this.killOk(d) && !(guarded && !this.know.protect.has(D.officer) && !this.duelPending(D.officer))) continue;
          // 태산: 유비 next to 이명 killed him on the last turn instead of persuading him
          if (lethal && this.ownDuel(u, D.officer)) continue;
          // the leader kept for the bonus walk-in: no blow that could take it with the rolls
          // (a badly hurt leader flees or routs, 계교's 원소 at turn 11: keep it above half)
          if (this.spared(D.officer) && (od.hp - dmg * 1.5 < maxHp(od) * 0.5 || walkAll)) continue;
          const hit = combatExp(true, o.level, od.level, false, d);
          const all = combatExp(true, o.level, od.level, lethal, d);
          let v = base;
          // (the end held: the enemies whose defeat ends the battle are farmed like in the grind, no rush on them)
          if (fin && !(endHeld && this.endsBattle(d))) v += w * all + (chg && d === vslot ? 500 : 0) + (lethal ? 60 : 0) + (dmg * 30) / Math.max(1, maxHp(od)) - (guarded && !lethal && d !== vslot ? 40 : 0);
          else if (penHit) {
            // the pen's troops go to the best exp per damage point first (buildPen's price)
            v += w * hit - this.penLam * dmg;
          } else {
            v += w * (hit + (all - hit) * this.p.kill) - (this.p.conserve * ((lethal ? od.hp : dmg) * 10)) / Math.max(1, maxHp(od)) - Math.min(this.troopCost(d, lethal ? od.hp : dmg, lethal, w), paramOr(this.p, 'cbCap') * w * all);
            // milking: a mendable enemy is not killed while we have slack; its troops go to the low levels first
            if (lethal && this.milkable.has(d)) v -= paramOr(this.p, 'milk') * w * 24;
            const bh = this.slack ? this.bestHit.get(d) ?? 0 : 0;
            if (lethal && bh > w * hit) v -= paramOr(this.p, 'steer') * (bh - w * hit) * 2;
          }
          // battle mode: the troops taken count by themselves (not only through the exp)
          const dw = paramOr(this.p, 'hnDmg');
          if (dw > 0) v += dw * ((100 * Math.min(dmg, od.hp)) / Math.max(1, maxHp(od)) + (lethal ? 50 : 0));
          // 회남: focus fire (the hurt enemy first: the wave thins faster, fewer hit back)
          if (hnLive) v += this.p.hnFocus * (20 * (1 - od.hp / Math.max(1, maxHp(od))) + (lethal ? 15 : 0));
          v += kg;
          // leave the leader a safe finishing blow: soften what it can kill from a guarded cell, and do not take it
          if (feeding && this.leaderKills.has(d)) {
            if (lethal) v -= this.p.feed * 30;
            else if (od.hp - dmg <= (this.leaderKills.get(d) ?? 0)) v += this.p.feed * 40;
          }
          // a dead target does not hit back: its threat leaves this cell
          if (lethal && (this.threat[y * b.width + x] ?? []).includes(d)) {
            const h = this.hitOn(D, u, x, y);
            v += deathCost(dang, 1) - deathCost({ worst: Math.max(0, dang.worst - h), expected: Math.max(0, dang.expected - h / Math.max(1, this.targetsOf(d))) }, 1);
          }
          // counterattack (1cb6:e42e): attack types 0/2/5 against a type-0 class
          const at = CLASS_ATTACK_TYPE[o.cls];
          if (!lethal && CLASS_ATTACK_TYPE[od.cls] === 0 && (at === 0 || at === 2 || at === 5)) {
            const cd = physicalDamage({
              attack: attackPower(od, D.morale, b.s.items),
              defence: defencePower(o, u.morale, b.s.items),
              attackerClass: od.cls,
              defenderClass: o.cls,
              defenderTerrain: t,
              defenderHp: 0xffff,
              counter: true,
            });
            const pc = Math.min(1, od.force / 150);
            v -= deathCost(plus(dang, cd), pc) - deathCost(dang, pc);
          }
          if (v > best.value || alts) offer({ slot, x, y, kind: 'attack', target: d, tactic: NONE, value: v, exp: all, lethal, danger: dang.worst });
        }
      // tactics
      for (const tc of tactics) {
        const a = this.tacticValue(u, tc, x, y, w);
        if (!a) continue;
        // farm phase: the flat-rate tactics are the point and MP is there to be spent
        let v = (farming || (fin && endHeld) || penT || this.bandFarming) && tc >= 15 ? base + a.value * paramOr(this.p, 'farmTac') : base + a.value - this.p.mp * TACTIC_MP[tc];
        if (chg && a.target === vslot && tc <= 14) v += 300;
        if (v > best.value || alts) offer({ slot, x, y, kind: 'tactic', target: a.target, tactic: tc, value: v, exp: a.exp, lethal: a.lethal, danger: dang.worst });
      }
      // items (ab86): promotions, troop heals (single and area), morale area heals, bombs
      for (const it of held) {
        const a = this.itemValue(u, it.id, x, y, w, guarded);
        if (!a) continue;
        let v = base + a.value;
        if (chg && a.target === vslot) v += 300;
        if (v > best.value || alts) offer({ slot, x, y, kind: 'item', target: a.target, tactic: NONE, item: it, value: v, exp: a.exp, lethal: a.lethal, danger: dang.worst });
        if (a.earn && (!throwBest || v + a.earn > throwBest.value)) throwBest = { slot, x, y, kind: 'item', target: a.target, tactic: NONE, item: it, value: v + a.earn, exp: a.exp, lethal: a.lethal, danger: dang.worst };
      }
    }
    b.place(slot, null, home[0], home[1]);
    // a scroll throw worth its exp (scrollEarn) replaces a wait, never a blow or a tactic
    if (throwBest && best.kind === 'wait' && throwBest.value > best.value) offer(throwBest);
    if (alts) this.lastAlts = [...alts.values()].sort((p, q) => q.value - p.value);
    return best;
  }

  /**
   * Value of using item `id` from (x, y) (1cb6:ab86): a promotion as soon as it is allowed (class
   * and level), a troop heal on a badly hurt ally (the leader first), a bomb like a hit. Items give
   * no exp of their own (a bomb hit does, through e91a).
   */
  private itemValue(u: Unit, id: number, x: number, y: number, w: number, guarded: boolean): { value: number; target: number; exp: number; lethal: boolean; earn?: number } | null {
    const b = this.b;
    const o = b.officerOf(u);
    void guarded;
    if (id >= 0x13 && id <= 0x1a) {
      const k = id - 0x13;
      if (o.cls !== PROMOTE_FROM[k] || o.level < PROMOTE_LEVEL[k]) return null;
      return { value: 600, target: NONE, exp: 0, lethal: false };
    }
    if ((id >= 0x1e && id <= 0x20) || (id >= 0x34 && id <= 0x36)) {
      const power = id >= 0x34 ? id - 0x34 : id % 3;
      let best: { value: number; target: number; exp: number; lethal: boolean } | null = null;
      for (const s of unitsInRange(b.s, u, power | 0x80, x, y, true)) {
        const T = this.scene.units[s];
        const ot = b.officerOf(T);
        const f = ot.hp / Math.max(1, maxHp(ot));
        const lead = this.know.guarded.has(T.officer);
        if (f >= (lead ? 0.75 : 0.45)) continue;
        const v = (1 - f) * (lead ? 400 : 60) - 8;
        if (!best || v > best.value) best = { value: v, target: s, exp: 0, lethal: false };
      }
      return best;
    }
    if (id >= 0x2e && id <= 0x33) {
      // area heals (ab86 -> baf6): troops (0x2e..0x30) or morale (0x31..0x33) of every ally in the
      // area around the user; worth it when several are hurt or the leader is
      const sub = (id - 0x2e) % 3;
      const morale = id >= 0x31;
      let v = 0;
      for (const s of unitsInRange(b.s, u, sub | 0x80, x, y, true)) {
        const T = this.scene.units[s];
        const ot = b.officerOf(T);
        const lead = this.know.guarded.has(T.officer);
        if (morale) {
          const conf = (T.flags & UnitFlag.Confused) !== 0;
          if (T.morale < 60 || conf) v += (100 - T.morale) * (lead ? 3 : 0.8) + (conf ? 40 : 0);
        } else {
          const f = ot.hp / Math.max(1, maxHp(ot));
          if (f < (lead ? 0.75 : 0.6)) v += (1 - f) * (lead ? 400 : 60);
        }
      }
      return v > 0 ? { value: v - 12, target: NONE, exp: 0, lethal: false } : null;
    }
    if (id === 0x21 || (id >= 0x2b && id <= 0x2d)) {
      // 폭탄 (1cb6:b029): (rand(21)+90)*15 = 1350..1650 troops at range 0x81, no roll, no counter, no
      // exp. 농무서/기상서/호우서 (ab86 at add9): the target is confused for sure (no a2aa roll), range
      // [0,1,0]|0x80 (0x2d also its enemy neighbours). Neither gives exp, so they are for battles
      // that are about surviving: worth what the target would hit us for this enemy phase (its
      // best blow on a unit it can reach, the leader counted double), and only on units that can
      // reach one of ours (a waiting unit out of reach is left asleep)
      const bomb = id === 0x21;
      const k = paramOr(this.p, bomb ? 'bomb' : 'confuse');
      if (k <= 0) return null;
      // 폭탄 are an emergency tool only (Sukwon 2026-10-16: "폭탄을 남용하진 마", levels are what
      // matter): at most one per battle (BOMBS_PER_BATTLE), and only on an enemy that can hit the
      // leader this phase for most of his troops; no battle plan (회남 included) is built on them.
      // The confusion items are kept for the hard battles (회남, the outnumbered escape battles)
      if (bomb && this.bombsUsed >= BOMBS_PER_BATTLE) return null;
      const hard = !bomb && (this.hnOn() || !!this.exitPlan);
      let best: { value: number; target: number; exp: number; lethal: boolean } | null = null;
      for (const d of unitsInRange(b.s, u, bomb ? 0x81 : CONFUSE_ITEM_RANGE[id - 0x2b] | 0x80, x, y, false)) {
        const D = this.scene.units[d];
        if (!(D.flags & UnitFlag.Visible) || D.status !== Status.Field) continue;
        if (!bomb && D.flags & UnitFlag.Confused) continue;
        // (confused at 0 morale the pen would leave the field, 1cb6:a0d0)
        if (!bomb && d === this.pen && this.penning() && D.morale === 0) continue;
        const od = b.officerOf(D);
        if (this.spared(D.officer) || this.know.protect.has(D.officer)) continue;
        const th = this.foeThreat(d);
        if (th <= 0) continue;
        if (!hard && !this.threatensLeader(d, bomb ? 0.8 : 0.4)) continue;
        let v: number;
        if (bomb) {
          const lethal = od.hp <= 1350;
          if (!lethal && od.hp > 1350 * 1.6) continue;
          v = k * (lethal ? 30 + th / 10 : (th / 20) * (1350 / od.hp)) - 40;
          if (!best || v > best.value) best = { value: v, target: d, exp: 0, lethal };
        } else {
          // the cure roll at the start of its phase (1cb6:8130): rand(100) < (lead+morale)/3
          const stay = 1 - Math.min(1, (od.lead + D.morale) / 300);
          v = k * stay * (th / 8) - 8;
          if (!best || v > best.value) best = { value: v, target: d, exp: 0, lethal: false };
        }
      }
      return best;
    }
    if (id >= 0x22 && id <= 0x2a) {
      const element = 2 - Math.trunc((id - 0x22) / 3);
      const power = (id - 0x22) % 3;
      if (element === 0 && WEATHER_TYPE[b.info.weather] === RAIN) return null;
      // a stock of cheap scrolls (GrindParams.scrolls) is meant to be thrown: a sure, counter-free hit
      const held = o.items.filter((v) => v >= 0x22 && v <= 0x2a).length;
      const cost = Number.isFinite(this.p.scrolls) && held >= 2 ? 1 : 6;
      const earn = held >= 2 ? paramOr(this.p, 'scrollEarn') : 0;
      const hnLive = this.hnOn() && !this.finishing && !!this.exitPlan;
      let best: { value: number; target: number; exp: number; lethal: boolean; earn?: number } | null = null;
      for (const d of unitsInRange(b.s, u, power | 0x80, x, y, false)) {
        const D = this.scene.units[d];
        if (!(D.flags & UnitFlag.Visible) || !tacticTerrainOk(element, terrainAt(b.s, D.x, D.y))) continue;
        const od = b.officerOf(D);
        const [lo, hi] = this.tacticDamageRange({ level: o.level, intel: o.intel }, { level: od.level, intel: od.intel, cls: od.cls }, element, power, terrainAt(b.s, D.x, D.y));
        const lethal = lo >= od.hp;
        if (lethal && !this.killOk(d)) continue;
        // the pen: never a scroll that could finish it (or leave it to our counters)
        const penH = d === this.pen && this.penning() && !this.finishing;
        if (penH && hi >= od.hp - this.penReserve) continue;
        if (this.spared(D.officer) && od.hp - lo * 2 < maxHp(od) * 0.5) continue;
        const ex = combatExp(true, o.level, od.level, lethal, d);
        let v = (this.finishing ? ex + (lo * 30) / Math.max(1, maxHp(od)) : penH ? w * ex - this.penLam * (lo + hi) / 2 : w * ex - (this.p.conserve * Math.min(lo, od.hp) * 10) / Math.max(1, maxHp(od))) - cost;
        // a stock to throw at an enemy at or above the thrower's level (8..16 exp for a few hundred
        // troops; on a weaker one, 4 exp, the troops are worth more to the low levels' blows): the exp
        // counts more and the stock costs nothing, but only against waiting (bestAction): in place of a
        // blow a scroll takes fewer troops (회남: the wave fell two turns later, the escape ran out of time)
        let bonus = 0;
        if (earn > 0 && ex >= 8) {
          bonus = cost + w * (ex - 4) * earn;
          const dmg = Math.min(od.hp, (lo + hi) / 2);
          const dw = paramOr(this.p, 'hnDmg');
          if (dw > 0) bonus += dw * ((100 * dmg) / Math.max(1, maxHp(od)) + (lethal ? 50 : 0));
          if (hnLive) bonus += this.p.hnFocus * (20 * (1 - od.hp / Math.max(1, maxHp(od))) + (lethal ? 15 : 0));
        }
        if (!best || v + bonus > best.value + (best.earn ?? 0)) best = { value: v, target: d, exp: ex, lethal, earn: bonus };
      }
      return best;
    }
    return null;
  }

  /** The most enemy `e` can do to one of ours this enemy phase (a unit in its reach; the leader counted double). */
  private foeThreat(e: number): number {
    const b = this.b;
    const E = this.scene.units[e];
    let best = 0;
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      const u = this.scene.units[i];
      if (u.status !== Status.Field || u.officer === 0xffff) continue;
      const k = u.y * b.width + u.x;
      const ph = (this.threat[k] ?? []).includes(e), tc = (this.tthreat[k] ?? []).includes(e);
      if (!ph && !tc) continue;
      const d = Math.max(ph ? this.hitOn(E, u, u.x, u.y) : 0, tc ? this.tacticOn(E, u, u.x, u.y) : 0);
      best = Math.max(best, d * (this.know.guarded.has(u.officer) ? 2 : 1));
    }
    return best;
  }

  /** 폭탄 thrown this battle (BOMBS_PER_BATTLE; the 회남 strike plan counts its own in too). */
  bombsUsed = 0;
  /** Player slot -> its commands in a row that earned no exp (GrindParams.idleAp). */
  private unitIdle = new Map<number, number>();

  /** Enemy `e` can hit the guarded leader this phase for at least `share` of its troops. */
  threatensLeader(e: number, share: number): boolean {
    const b = this.b;
    const ls = b.slotOfOfficer(0);
    if (ls === NONE) return false;
    const L = this.scene.units[ls];
    if (L.status !== Status.Field) return false;
    const k = L.y * b.width + L.x;
    const E = this.scene.units[e];
    const d = Math.max((this.threat[k] ?? []).includes(e) ? this.hitOn(E, L, L.x, L.y) : 0, (this.tthreat[k] ?? []).includes(e) ? this.tacticOn(E, L, L.x, L.y) : 0);
    return d >= b.officerOf(L).hp * share;
  }

  /** Physical damage enemy E would do to u standing at (x, y). */
  private hitOn(E: Unit, u: Unit, x: number, y: number): number {
    const b = this.b;
    const oe = b.officerOf(E);
    const o = b.officerOf(u);
    return physicalDamage({
      attack: attackPower(oe, E.morale, b.s.items),
      defence: defencePower(o, u.morale, b.s.items),
      attackerClass: oe.cls,
      defenderClass: o.cls,
      defenderTerrain: terrainAt(b.s, x, y),
      defenderHp: 0xffff,
      counter: false,
    });
  }

  /** Damage bounds of a tactic hit (1cb6:df14 kind 2 without the rolls). */
  private tacticDamageRange(c: { level: number; intel: number }, t: { level: number; intel: number; cls: number }, element: number, power: number, terr: number): [number, number] {
    const b = this.b;
    const u16 = (v: number) => v & 0xffff;
    let dmg = u16((Math.trunc(u16(c.level * c.intel) / 50) + c.intel) * 2 - Math.trunc(u16(t.level * t.intel) / 50) - t.intel + (power * 4 + element + 2) * 100);
    if (resistsTactics(t.cls)) dmg = Math.trunc(dmg / 2);
    if ((element === 0 && terr === TERRAIN_FOREST) || (element === 1 && WEATHER_TYPE[b.info.weather] === RAIN)) dmg += Math.trunc(dmg / 4);
    const extra = Math.trunc((dmg & 0xffff) / 50);
    return [dmg, dmg + Math.max(0, extra - 1)];
  }

  /**
   * How near ally T is to falling this enemy phase where it stands: 0 when the expected damage is
   * under 60% of its troops, rising to 1 at 110% (cached per threat map).
   */
  private healRisk(T: Unit): number {
    let r = this.riskMemo.get(T.slot);
    if (r === undefined) {
      const hp = Math.max(1, this.b.officerOf(T).hp);
      r = Math.min(1, Math.max(0, (this.danger(T, T.x, T.y).expected / hp - 0.6) * 2));
      this.riskMemo.set(T.slot, r);
    }
    return r;
  }
  private riskMemo = new Map<number, number>();

  private tacticValue(u: Unit, tc: number, x: number, y: number, w: number): { value: number; target: number; exp: number; lethal: boolean } | null {
    const b = this.b;
    const o = b.officerOf(u);
    const p = TACTIC_POWER[tc];
    if (tc <= 14) {
      const e = Math.trunc(tc / 5);
      let best: { value: number; target: number; exp: number; lethal: boolean } | null = null;
      for (const d of unitsInRange(b.s, u, p | 0x80, x, y, false)) {
        const D = this.scene.units[d];
        if (!(D.flags & UnitFlag.Visible) || !tacticTerrainOk(e, terrainAt(b.s, D.x, D.y))) continue;
        const hits = [d];
        if (tc % 5 >= 3)
          for (const [nx, ny] of [[D.x, D.y - 1], [D.x + 1, D.y], [D.x, D.y + 1], [D.x - 1, D.y]]) {
            if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height || !tacticTerrainOk(e, terrainAt(b.s, nx, ny))) continue;
            const v = unitAt(b.s, nx, ny);
            if (v !== NONE && !sideOf(v)) hits.push(v);
          }
        let exp = 0, burn = 0, spent = 0, ok = true, lethal = false, killP = 0;
        let left = this.enemiesOnField();
        for (const h of hits) {
          const H = this.scene.units[h];
          const oh = b.officerOf(H);
          const [lo, hi] = this.tacticDamageRange(o, oh, e, p, terrainAt(b.s, H.x, H.y));
          // the chance to land (1cb6:a2aa: rand(caster skill) above a quarter of the target's, half
          // against tactic-resistant classes); a miss does nothing but still pays the hit exp
          let pt = tacticSkill(oh) >> 2;
          if (resistsTactics(oh.cls)) pt <<= 1;
          const pc = tacticSkill(o);
          const land = paramOr(this.p, 'tacHit') > 0.5 ? (pc > 0 ? Math.max(0, pc - 1 - pt) / pc : 0) : 1;
          if (this.spared(H.officer) && oh.hp - hi * 1.5 < maxHp(oh) * 0.5) ok = false;
          // the pen: no tactic that could finish it (or leave it to our counters), nor drive it off by morale
          const penH = h === this.pen && this.penning() && !this.finishing;
          if (penH && hi >= oh.hp - this.penReserve) ok = false;
          if (hi < oh.hp && !this.finishing && (this.penOn() || this.bandOn()) && this.moraleLeaves(H, moraleLoss(2, hi, oh.hp, oh.level, H.morale)) && (penH || !this.killOk(h))) ok = false;
          if (hi >= oh.hp) {
            // a duel / persuasion partner is never killed by a tactic either (팽성: 경무's fire took 조하 from 유비)
            if (this.duelPending(H.officer)) ok = false;
            else if (this.endHeld() && (this.endsBattle(h) || left - 1 < 1)) ok = false;
            else if (!this.finishing && this.milkable.has(h) && paramOr(this.p, 'milk') > 0) ok = false;
            else if (this.finishing || (!this.know.protect.has(H.officer) && left - 1 >= this.p.keep)) {
              left--;
              lethal = true;
              if (lo >= oh.hp) exp += land * (combatExp(true, o.level, oh.level, true, h) - combatExp(true, o.level, oh.level, false, h));
              killP = Math.max(killP, land);
            } else ok = false;
          }
          exp += combatExp(true, o.level, oh.level, false, h);
          if (penH) spent += land * this.penLam * Math.min(oh.hp, (lo + hi) / 2);
          else {
            burn += (land * Math.min(oh.hp, (lo + hi) / 2) * 10) / Math.max(1, maxHp(oh));
            spent += land * this.troopCost(h, Math.min(oh.hp, (lo + hi) / 2), hi >= oh.hp, w);
          }
        }
        if (!ok) continue;
        const value = w * exp * this.p.tactic - this.p.conserve * burn - Math.min(spent, paramOr(this.p, 'cbCap') * w * exp * this.p.tactic) + paramOr(this.p, 'hnDmg') * (10 * burn + (lethal ? 50 * killP : 0));
        if (!best || value > best.value) best = { value, target: d, exp, lethal };
      }
      return best;
    }
    if (tc <= 20) {
      // (band farm: the safest target, not the first: a 0-morale unconfused one takes 견제 forever,
      // one that stays at 30 or more is never confused, 898c; a riskier one may be driven off)
      const pick = this.bandOn();
      let bestT: { value: number; target: number; exp: number; lethal: boolean } | null = null, bestPref = -1;
      for (const d of unitsInRange(b.s, u, p | 0x80, x, y, false)) {
        const D = this.scene.units[d];
        if (!(D.flags & UnitFlag.Visible)) continue;
        const od = b.officerOf(D);
        const affected = [d];
        if (tc === 17)
          for (const [nx, ny] of [[D.x, D.y - 1], [D.x + 1, D.y], [D.x, D.y + 1], [D.x - 1, D.y]]) {
            if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
            const v = unitAt(b.s, nx, ny);
            if (v !== NONE && !sideOf(v)) affected.push(v);
          }
        // a confused unit at morale 0 leaves the field (1cb6:a0d0): that is a defeat without kill exp
        const leaves = (s: number, drop: number) => {
          const U = this.scene.units[s];
          // (pen on, exact: a morale tactic that takes nothing off, at 0 morale, confuses no one, 898c:
          // an unconfused unit at 0 morale takes 견제 for +8 forever)
          if (this.penOn() || this.bandOn()) return tc <= 17 ? U.morale <= 0 : this.moraleLeaves(U, drop);
          return U.morale - drop <= 0 && (tc <= 17 || (U.flags & UnitFlag.Confused) !== 0 || U.morale - drop < 30);
        };
        let bad = false;
        for (const s of affected) {
          const drop = tc >= 18 ? moraleDrop(o, b.officerOf(this.scene.units[s]), p, this.scene.units[s].morale) : 0;
          if (leaves(s, drop) && (!this.killOk(s) || (s === this.pen && this.penning() && !this.finishing))) bad = true;
          // the leader kept for the bonus walk-in: a routed leader (morale 0) is a defeat too
          if (this.spared(this.scene.units[s].officer)) bad = true;
        }
        if (bad) continue;
        void od;
        if (!pick) return { value: w * 8 * this.p.control, target: d, exp: 8, lethal: false };
        const conf = (D.flags & UnitFlag.Confused) !== 0;
        const drop = tc >= 18 ? moraleDrop(o, od, p, D.morale) : 0;
        const pref = tc >= 18 ? (D.morale === 0 && !conf ? 3 : D.morale - drop >= 30 ? 2 : 0) : D.morale > 0 && !conf ? 1 : 0;
        if (pref > bestPref) [bestPref, bestT] = [pref, { value: w * 8 * this.p.control, target: d, exp: 8, lethal: false }];
      }
      return bestT;
    }
    const bonus = tc <= 29 && (o.cls === 12 || o.cls === 18) ? 12 : 8;
    if (tc <= 29) {
      const kind = healKind(tc);
      const hr = kind & 1 ? paramOr(this.p, 'healRisk') : 0;
      let pick = NONE, worst = 2, rescue = 0;
      for (const s of unitsInRange(b.s, u, p | 0x80, x, y, true)) {
        const T = this.scene.units[s];
        const ot = b.officerOf(T);
        if (!healUseful(kind, ot, T.morale, (T.flags & UnitFlag.Confused) !== 0)) continue;
        // troops: the ally the enemy can bring down this phase first (장비 fell at 회남's front while
        // the healer topped up a unit behind the lines)
        const risk = hr > 0 && s !== u.slot ? this.healRisk(T) : 0;
        const f = ot.hp / Math.max(1, maxHp(ot)) + T.morale / 1000 - hr * 0.5 * risk;
        if (f < worst) {
          worst = f;
          pick = s;
          rescue = risk;
        }
      }
      if (pick === NONE) return null;
      // the leader first: its troops are the battle
      const lead = this.know.guarded.has(this.scene.units[pick].officer) ? this.p.safe * 30 * Math.max(0, 1 - worst) : 0;
      // a rescue keeps the ally's exp to come (and its blows) in the battle
      const save = rescue > 0 ? hr * rescue * (10 + this.weight(pick) * Math.min(10, Math.max(1, this.deadline() - b.info.turn)) * 4) * 0.5 : 0;
      return { value: w * bonus * this.p.heal + lead + save, target: pick, exp: bonus, lethal: false };
    }
    const list = unitsInRange(b.s, u, ((tc - 30) % 3) | 0x80, x, y, true);
    if (!list.length) return null;
    return { value: w * 8 * this.p.heal, target: NONE, exp: 8, lethal: false };
  }

  // ---- execution (1cb6:a474 for the player: move d972, then the command, then 8ad2)

  private async execute(a: Action): Promise<number> {
    const sc = this.scene;
    const b = this.b;
    const u = sc.units[a.slot];
    const officer = u.officer;
    const o = b.officerOf(u);
    const before = o.level * 100 + o.exp;
    if (a.x !== u.x || a.y !== u.y) {
      b.place(a.slot, null, a.x, a.y);
      u.flags |= UnitFlag.Moved;
    }
    if (this.know.treasure.some((t) => t.x === a.x && t.y === a.y)) this.looted.add(a.y * b.width + a.x);
    const st = this.stats.byOfficer.get(officer) ?? { hits: 0, kills: 0, tactics: 0, heals: 0 };
    this.stats.byOfficer.set(officer, st);
    let kind = a.kind;
    this.log?.(`T${b.info.turn + 1}${this.finishing ? 'F' : ''} ${o.level}:${officer}@${u.x},${u.y} ${a.kind} ${a.tactic === NONE ? '' : 't' + a.tactic} ${a.target === NONE ? '' : '->' + sc.units[a.target].officer + '(' + b.officerOf(sc.units[a.target]).hp + ')'} v=${a.value.toFixed(1)} hp=${o.hp} mp=${u.mp} dw=${a.danger ?? ''}`);
    if (a.kind === 'attack') {
      const t = sc.units[a.target];
      const alive = () => t.status === Status.Field;
      await sc.doAttack(a.slot, a.target);
      if (!alive()) this.stats.actions.kill++;
      this.stats.actions.attack++;
    } else if (a.kind === 'item' && a.item) {
      const promo = a.item.id >= 0x13 && a.item.id <= 0x1a;
      const ok = await sc.useItem(a.slot, a.item.id, a.item.index, a.target);
      if (!ok) kind = 'wait';
      else {
        if (a.item.id === 0x21) this.bombsUsed++;
        this.stats.actions.item = (this.stats.actions.item ?? 0) + 1;
        if (promo) this.stats.actions.promoted = (this.stats.actions.promoted ?? 0) + 1;
      }
    } else if (a.kind === 'tactic') {
      const ok = await sc.castFlow(a.slot, a.tactic, false, a.target);
      if (!ok) kind = 'wait';
      else {
        this.stats.tactics.set(a.tactic, (this.stats.tactics.get(a.tactic) ?? 0) + 1);
        if (this.bandFarming && a.tactic >= 15 && !this.inRollout) this.stats.bandCasts = (this.stats.bandCasts ?? 0) + 1;
        if (a.tactic >= 21) this.stats.actions.heal++;
        else this.stats.actions.tactic++;
      }
    }
    if (kind === 'wait') this.stats.actions.wait++;
    u.flags |= UnitFlag.Acted;
    const gained = o.level * 100 + o.exp - before;
    this.unitIdle.set(a.slot, gained > 0 ? 0 : (this.unitIdle.get(a.slot) ?? 0) + 1);
    if (this.log && gained > 0) this.log(`  +${gained} exp`);
    if (a.kind === 'attack' || a.kind === 'item') {
      if (a.lethal) st.kills += Math.max(0, gained);
      else st.hits += Math.max(0, gained);
    } else if (kind === 'tactic') {
      if (a.tactic >= 21) st.heals += Math.max(0, gained);
      else st.tactics += Math.max(0, gained);
    }
    if (b.info.result === 0 && u.status === Status.Field) await sc.unitEvents(a.slot);
    return Math.max(0, gained);
  }
}

/** The player units' officers of a scene that gain exp (named, below 99). */
export function needyCount(scene: BattleScene): number {
  return scene.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer < 0x100 && scene.b.officerOf(u).level < 99).length;
}

export { tacticSkill };
