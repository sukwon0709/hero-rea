// Tactical battle: record layouts and small engine constant tables (see docs/BATTLE.md).
//
// Addresses are image `seg:off` as in docs/ (Ghidra segment = image segment + 0x1000). `DS:xxxx`
// is an offset in DGROUP (image segment 0x313A). Every table here is a small per-class /
// per-terrain coefficient table; web/test/battle.test.ts checks each one byte-for-byte against
// MAIN.EXE.

/** Number of unit slots (DS:0xe2a2, 14 bytes each). Slots 0..14 are the player side, 15..44 the enemy. */
export const UNIT_SLOTS = 45;
export const PLAYER_SLOTS = 15;
export const NONE = 0xff;

/** Unit status, unit+9 (1cb6:4f18). */
export const enum Status {
  Empty = 0,
  Reserve = 1,
  Field = 2,
  Retreated = 4,
  Killed = 5,
}

/** Unit flag bits, unit+10 (set/cleared by 1cb6:9ff6 / 4eda, tested by 4eec). */
export const enum UnitFlag {
  Confused = 0x02,
  Scripted = 0x04, // script-controlled: unlimited moves, ignores ZOC, never attacks on its own
  Facing = 0x10,
  Visible = 0x20, // cleared for hidden ambushers
  Moved = 0x40,
  Acted = 0x80,
}

/** AI order, unit+0xb (1cb6:4f3e / 8a58). */
export const enum AiMode {
  MoveTo = 0, // 이동: head for the target unit (+5) or position (+6/+7)
  AttackNearest = 1, // 최단 적공격
  Hold = 2, // 부동: never moves, attacks from where it stands
  Wait = 3, // 대기: sits until an enemy can be reached this turn
  MoveNoAttack = 4, // 무공격이동
  Confused = 5,
  Paralysed = 6,
  Player = 7, // 입력: commanded by the player
}

/** A unit slot (DS:0xe2a2 + 14*i). */
export interface Unit {
  officer: number; // +0 u16 officer index (0 = 유비)
  slot: number; // +2 own slot index (side = slot < 15)
  x: number; // +3
  y: number; // +4
  target: number; // +5 AI target unit slot or 0xff
  tx: number; // +6 AI target position
  ty: number; // +7
  order: number; // +8 action order within the phase (1cb6:3e12)
  status: number; // +9 Status
  flags: number; // +10 UnitFlag
  mode: number; // +0xb AiMode
  morale: number; // +0xc 0..100
  mp: number; // +0xd tactic points (u8)
}

/** The battle-relevant part of an officer record (DS:0x7a94 + 0x2c*id). */
export interface Officer {
  lead: number; // +0x18 (defence, morale regen, confusion recovery)
  force: number; // +0x19 무력 (attack, counterattack chance)
  intel: number; // +0x1a 지력 (tactics)
  hp: number; // +0x1e u16 troops
  cls: number; // +0x20 class 0..18
  level: number; // +0x21 1..99
  exp: number; // +0x22 0..99
  items: number[]; // +0x23..+0x2a eight item ids, 0xff = empty
}

/** The battle-relevant part of an item record (DS:0xd09a + 17*id). */
export interface ItemInfo {
  value: number; // +0xf
  type: number; // +0x10: 0 weapon (attack %), 4 boots (move +value), 5 armour (defence %)
}

/** Battle state block, DS:0xe196. */
export interface BattleInfo {
  map: number; // +0 HEXZMAP entry
  result: number; // +1: 0 running, 2 won, 3 lost
  turn: number; // +2 0-based
  turnLimit: number; // +3
  weather: number; // +4 0..5, see WEATHER_TYPE
}

// ---- terrain (20 types; names via the pointer table DS:0x3e74) ----

export const TERRAIN_COUNT = 20;
/** Defence bonus in percent, 255 = impassable (DS:0x405e). */
export const TERRAIN_DEFENCE = [0, 20, 30, 255, 0, 255, 0, 5, 5, 255, 255, 0, 255, 30, 10, 0, 0, 255, 255, 255];
/** Movement cost [moveType][terrain], 255 = impassable (DS:0x400e). */
export const MOVE_COST = [
  [1, 1, 255, 255, 1, 255, 1, 1, 2, 255, 255, 1, 255, 2, 2, 2, 2, 255, 255, 255],
  [1, 255, 255, 255, 1, 255, 1, 1, 2, 255, 255, 2, 255, 3, 3, 3, 3, 255, 255, 255],
  [1, 2, 255, 255, 1, 255, 1, 1, 2, 255, 255, 2, 255, 2, 2, 2, 2, 255, 255, 255],
  [1, 1, 1, 255, 1, 255, 1, 1, 2, 255, 255, 1, 255, 2, 2, 2, 2, 255, 255, 255],
];
/**
 * Map 32 has one cell with terrain 255 (at 5,13). The original indexes past its tables for it,
 * reading these bytes (DS:0x400e+mt*20+255 and DS:0x405e+255).
 */
const TERRAIN_255_MOVE = [0xc0, 0xc2, 0xd9, 0xae];
const TERRAIN_255_DEFENCE = 0x20;
export function moveCost(moveType: number, terrain: number): number {
  return terrain < TERRAIN_COUNT ? MOVE_COST[moveType][terrain] : terrain === 255 ? TERRAIN_255_MOVE[moveType] : 0xff;
}
export function terrainDefence(terrain: number): number {
  return terrain < TERRAIN_COUNT ? TERRAIN_DEFENCE[terrain] : terrain === 255 ? TERRAIN_255_DEFENCE : 0xff;
}
/** Terrains that heal at the start of a turn: village/fortress heal troops and morale, barracks troops only (1cb6:7cc8). */
export const TERRAIN_VILLAGE = 8;
export const TERRAIN_FORTRESS = 13;
export const TERRAIN_BARRACKS = 14;
export const TERRAIN_FOREST = 1;
/** Terrains a fire/water/rock tactic may target, 0xff = unused slot (DS:0x47bc, checked by 1cb6:a392). */
export const TACTIC_TERRAIN = [
  [1, 7, 0, 6],
  [4, 0, 0xff, 0xff],
  [2, 11, 0xff, 0xff],
];

// ---- classes (19; names via DS:0xfd8) ----

export const CLASS_COUNT = 19;
export const CLASS_MOVE = [4, 4, 5, 4, 4, 3, 6, 5, 6, 4, 4, 4, 4, 4, 5, 4, 5, 3, 3]; // DS:0x3f8e
/** Attack type (DS:0x3fd2): 0 공격, 1 사격, 2 돌격, 5 맹수, 6 주술, 0xff none. Only type 0 counterattacks. */
export const CLASS_ATTACK_TYPE = [0xff, 0xff, 0xff, 1, 1, 1, 2, 2, 2, 0, 0, 0, 0xff, 5, 0, 6, 2, 0xff, 0xff];
/** Attack range shape for 1cb6:c018 (DS:0x3fe6), 0xff = cannot attack. */
export const CLASS_RANGE = [0, 1, 1, 2, 3, 4, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0xff, 1];
export const CLASS_MOVE_TYPE = [0, 0, 0, 0, 0, 0, 1, 1, 1, 3, 3, 3, 2, 3, 3, 0, 3, 0, 2]; // DS:0x3ffa
export const CLASS_HP_BASE = [5, 5, 5, 5, 5, 5, 5, 5, 5, 8, 8, 8, 3, 4, 6, 3, 7, 5, 3]; // DS:0x1338
export const CLASS_HP_GROWTH = [5, 5, 5, 4, 4, 4, 6, 6, 6, 4, 4, 4, 4, 5, 5, 5, 6, 5, 4]; // DS:0x134c
export const CLASS_ATTACK = [40, 60, 60, 30, 60, 80, 60, 70, 80, 50, 60, 70, 20, 80, 70, 20, 70, 20, 20]; // DS:0xffe
export const CLASS_DEFENCE = [40, 60, 80, 40, 40, 50, 30, 50, 60, 40, 50, 60, 20, 30, 60, 20, 80, 20, 20]; // DS:0x1012
export const CLASS_BAND = 12; // 군악대: restores MP to neighbours each turn
export const CLASS_SORCERER = 15; // 주술사
export const CLASS_SUPPLY = 18; // 수송대
/** Classes that resist tactics (double resistance, half damage) — 1cb6:a0aa. */
export function resistsTactics(cls: number): boolean {
  return cls === 12 || cls === 18 || cls === 15;
}

// ---- tactics (36; names via the far-pointer table DS:0x4438) ----

export const TACTIC_COUNT = 36;
/** Power / area level (DS:0x44c8). 3 = area heal. */
export const TACTIC_POWER = [
  0, 1, 2, 0, 1, 0, 1, 2, 0, 1, 0, 1, 2, 0, 1, 0, 2, 0, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 3, 3, 3, 3, 3, 3,
];
/** MP cost (DS:0x44ec). */
export const TACTIC_MP = [
  4, 8, 12, 16, 20, 6, 10, 14, 18, 22, 8, 12, 16, 20, 24, 8, 16, 24, 4, 8, 16, 4, 8, 12, 6, 10, 14, 12, 20, 28, 16, 24, 32,
  24, 32, 40,
];
/** Learn table DS:0x4510 is 36*19 bytes of game data: read it with loadLearnTable(). */
export const LEARN_TABLE_OFFSET = 0x4510;

/** Weather (state+4, 0..5) to weather type: 0 clear, 1 cloudy, 2 rain (DS:0x3b7c). */
export const WEATHER_TYPE = [0, 0, 0, 1, 2, 2];
export const RAIN = 2;

/** Target range of the confusion items 0x2b..0x2d (1cb6:add9 byte table, read at adfd; bit 0x80 added at ae00). */
export const CONFUSE_ITEM_RANGE = [0, 1, 0];

/** Deployment AI order code (deployment byte 6) to AiMode (DS:0x4fe6, used by 2cb4:031a). */
export const ORDER_TO_MODE = [3, 1, 2, 0, 0, 4, 4];

/** 4-way neighbours in direction order 0..3 = N, E, S, W (DS:0x4d1c). */
export const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
/** Diagonals (DS:0x4cfc). */
export const DIAGONALS: readonly (readonly [number, number])[] = [
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];
/** Axis unit vectors in the order used by the range shapes (DS:0x4d0c). */
export const AXES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function isPlayerSide(u: Unit): boolean {
  return u.slot < PLAYER_SLOTS;
}

export function newUnit(slot: number): Unit {
  return {
    officer: 0xffff,
    slot,
    x: 0,
    y: 0,
    target: NONE,
    tx: 0,
    ty: 0,
    order: NONE,
    status: Status.Empty,
    flags: UnitFlag.Visible,
    mode: AiMode.Player,
    morale: 100,
    mp: 0,
  };
}

// ---- reading engine tables out of MAIN.EXE at runtime ----

/** DGROUP image segment of MAIN.EXE. */
export const DGROUP_SEG = 0x313a;

/** Returns `len` bytes at DS:`off` from the MAIN.EXE file image. */
export function readDgroup(mainExe: Uint8Array, off: number, len: number): Uint8Array {
  const hdr = (mainExe[8] | (mainExe[9] << 8)) * 16;
  const p = hdr + DGROUP_SEG * 16 + off;
  return mainExe.slice(p, p + len);
}

/** The tactic learn table: level at which class c learns tactic t is table[t*19+c] (0xff = never). */
export function loadLearnTable(mainExe: Uint8Array): Uint8Array {
  return readDgroup(mainExe, LEARN_TABLE_OFFSET, TACTIC_COUNT * CLASS_COUNT);
}
