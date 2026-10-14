// Save files: MSAVEn.R3S (8789 B, world state), ESAVEn.R3S (1369 B, scenario/event state) and the
// new-game template MSAVE.R3 (73 B = the first 0x49 bytes of an MSAVE). parse* / serialize* are
// byte-exact inverses: every byte, known or not, lands in a field.
// Layout, DGROUP origins and the MAIN.EXE code: docs/DATA.md ("Saves"). Writer 0cf5:ae98, loader 0cf5:b34e.

import { OFFICER_COUNT, OFFICER_DYN_SIZE, OfficerDyn, TOWN_COUNT, TOWN_DYN_SIZE, TownDyn, cstr, parseOfficerDyn, parseTownDyn, writeOfficerDyn, writeTownDyn } from './tables';

export const MSAVE_SIZE = 0x2255;
export const MSAVE_HEADER_SIZE = 0x49; // MSAVE.R3
export const ESAVE_SIZE = 0x559;
export const ACTOR_COUNT = 62;
export const ACTOR_SIZE = 26;
export const SAVE_SLOTS = 5;

export const MSAVE_OFF = {
  timestamp: 0x0000, // 5
  title: 0x0005, // 30, from DS:0xdb4c
  progress: 0x0023, // 20, DS:0x7a80 (0cf5:6404 / 6538)
  location: 0x0037, // 9, DS:0x7a6c (0cf5:690a / 696c)
  prevLocation: 0x0040, // 9, DS:0x7a76
  actors: 0x0049, // 62 x 26, DS:0x7406 (0cf5:6686 / 67b0)
  officers: 0x0695, // 384 x 18, officer table DS:0x7a94 (0cf5:724a / 7310)
  towns: 0x2195, // 32 x 6, town table DS:0xcc98 (0cf5:762a / 7708)
} as const;

// ---------------------------------------------------------------- timestamp

/** Raw 5-byte timestamp from the RTC (0:608a); all zero = empty slot (0cf5:b576). */
export interface SaveTime {
  /** Two-digit year (BCD byte 0). */
  year: number;
  /** Binary month, high nibble of byte 1 (the low nibble is kept in `raw`). */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const bcd = (v: number) => (v >> 4) * 10 + (v & 15);
const toBcd = (v: number) => ((Math.floor(v / 10) % 10) << 4) | v % 10;

export function decodeSaveTime(raw: Uint8Array): SaveTime | null {
  if (raw.every((v) => v === 0)) return null;
  return { year: bcd(raw[0]), month: raw[1] >> 4, day: bcd(raw[2]), hour: bcd(raw[3]), minute: bcd(raw[4]) };
}

export function encodeSaveTime(t: SaveTime): Uint8Array {
  return Uint8Array.of(toBcd(t.year % 100), (t.month & 15) << 4, toBcd(t.day), toBcd(t.hour), toBcd(t.minute));
}

/** "yy/mm/dd hh:mm" as the load/save list shows it (format DS:0x2b25). */
export function formatSaveTime(t: SaveTime): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `${p(t.year)}/${p(t.month)}/${p(t.day)} ${p(t.hour)}:${p(t.minute)}`;
}

// ---------------------------------------------------------------- DS:0x7a80 game progress (20 B)

export interface GameProgress {
  /** +0 money (0..10000; 0cf5:224c clamps). */
  money: number;
  /** +2 u16 (0..10000), always 5000; meaning unknown. */
  w2: number;
  /** +4 battle options: 0x1000 = "적의 이동 안본다" toggle, low nibble = enemy move speed (inferred). */
  battleOptions: number;
  /** +6 u16; the loader replaces values > 0x1d with 5. Unknown. */
  w6: number;
  /** +8 u16 (0x20); unknown. */
  w8: number;
  /** +0xa option flags, mirrors int 65h var0: 1 효과음, 2 BGM, 4 unknown, 8 컬러 monitor, 0x40 protection passed. */
  flags: number;
  /** +0xc u16 (0cf5:25c4 / 25e2); unknown UI state. */
  wC: number;
  /** +0xe current BGM track, 0xffff = none. */
  bgm: number;
  /** +0x10 current territory = town index (DS:0xcc98). */
  territory: number;
  /** +0x11 스크롤 단위 1/2/4/8 = 소/중/대/극대 (기능 menu handler 0cf5:eee2; 1cb6:0ebc get / 0eca set). */
  scroll: number;
  /** +0x12 chapter 0..4. */
  chapter: number;
  /** +0x13 속도설정 0..3 = 노웨이트/빠르다/보통/느리다. */
  speed: number;
}

export const OPT = { SE: 0x01, BGM: 0x02, COLOR: 0x08, PROTECTION_OK: 0x40 } as const;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function w16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
}

export function parseProgress(b: Uint8Array, o: number): GameProgress {
  return {
    money: u16(b, o),
    w2: u16(b, o + 2),
    battleOptions: u16(b, o + 4),
    w6: u16(b, o + 6),
    w8: u16(b, o + 8),
    flags: u16(b, o + 10),
    wC: u16(b, o + 12),
    bgm: u16(b, o + 14),
    territory: b[o + 16],
    scroll: b[o + 17],
    chapter: b[o + 18],
    speed: b[o + 19],
  };
}

export function writeProgress(p: GameProgress, b: Uint8Array, o: number): void {
  w16(b, o, p.money);
  w16(b, o + 2, p.w2);
  w16(b, o + 4, p.battleOptions);
  w16(b, o + 6, p.w6);
  w16(b, o + 8, p.w8);
  w16(b, o + 10, p.flags);
  w16(b, o + 12, p.wC);
  w16(b, o + 14, p.bgm);
  b[o + 16] = p.territory;
  b[o + 17] = p.scroll;
  b[o + 18] = p.chapter;
  b[o + 19] = p.speed;
}

// ---------------------------------------------------------------- DS:0x7a6c location (9 B saved, 10 in memory)

export const MODE = { TOWN: 0, WORLD: 1, PALACE: 2, BATTLE: 3 } as const;

export interface Location {
  /** +0, +1 player position (new location: 0x0b, 0x0d via 0cf5:c108). */
  x: number;
  y: number;
  /** +2, +3 unknown. */
  b2: number;
  b3: number;
  /** +4 area: the town index while in a town or palace (event trigger 2); 0cf5:c0c8 / acca; stored to ESAVE +8. */
  key: number;
  /** +5 low nibble = mode (MODE), high nibble kept as is. */
  mode: number;
  /** +6 map index (SMAP / PMAP / MMAP entry; 0cf5:c0d8). */
  map: number;
  /** +7 "entered" flag (0cf5:c0e8). */
  entered: number;
  /** +8 (1cb6:175e). The in-memory +9 is cleared on load and not saved. */
  b8: number;
}

export function parseLocation(b: Uint8Array, o: number): Location {
  return { x: b[o], y: b[o + 1], b2: b[o + 2], b3: b[o + 3], key: b[o + 4], mode: b[o + 5], map: b[o + 6], entered: b[o + 7], b8: b[o + 8] };
}

export function writeLocation(l: Location, b: Uint8Array, o: number): void {
  b.set([l.x, l.y, l.b2, l.b3, l.key, l.mode, l.map, l.entered, l.b8], o);
}

// ---------------------------------------------------------------- DS:0x7406 map actors (26 B)

export interface Actor {
  b0: number;
  b1: number;
  /** +2..5 run-time far pointer, saved raw (byte 3 is renormalised by 0:c1f8 on save, 0:c14c on load). */
  ptr: number;
  /** +6 unit id: 0x200|officer or 0x400|NPC type; 0 = unused slot. */
  unitId: number;
  /** +8, +9 map position (0cf5:edb4). */
  x: number;
  y: number;
  /** +0xa..+0x19 kept raw: +a/+b target (ede8), +e sprite frame (55d0), +f flags (55b2), +15 (d62a). */
  rest: Uint8Array;
}

export function parseActor(b: Uint8Array, o: number): Actor {
  return {
    b0: b[o],
    b1: b[o + 1],
    ptr: (b[o + 2] | (b[o + 3] << 8) | (b[o + 4] << 16) | (b[o + 5] << 24)) >>> 0,
    unitId: u16(b, o + 6),
    x: b[o + 8],
    y: b[o + 9],
    rest: b.slice(o + 10, o + ACTOR_SIZE),
  };
}

export function writeActor(a: Actor, b: Uint8Array, o: number): void {
  b[o] = a.b0;
  b[o + 1] = a.b1;
  for (let i = 0; i < 4; i++) b[o + 2 + i] = (a.ptr >>> (8 * i)) & 0xff;
  w16(b, o + 6, a.unitId);
  b[o + 8] = a.x;
  b[o + 9] = a.y;
  b.set(a.rest, o + 10);
}

// ---------------------------------------------------------------- MSAVE

export interface MSaveHeader {
  /** Raw RTC bytes; decodeSaveTime() for the value. */
  timestamp: Uint8Array;
  /** Raw 30 bytes (bytes after the NUL are kept); `cstr(titleRaw)` = chapter title shown in the slot list. */
  titleRaw: Uint8Array;
  progress: GameProgress;
  location: Location;
  prevLocation: Location;
}

export interface MSave extends MSaveHeader {
  actors: Actor[];
  officers: OfficerDyn[];
  towns: TownDyn[];
}

export function saveTitle(h: MSaveHeader): string {
  return cstr(h.titleRaw);
}

function parseHeader(b: Uint8Array): MSaveHeader {
  return {
    timestamp: b.slice(0, 5),
    titleRaw: b.slice(5, 35),
    progress: parseProgress(b, MSAVE_OFF.progress),
    location: parseLocation(b, MSAVE_OFF.location),
    prevLocation: parseLocation(b, MSAVE_OFF.prevLocation),
  };
}

function writeHeader(h: MSaveHeader, b: Uint8Array): void {
  b.set(h.timestamp, 0);
  b.set(h.titleRaw, 5);
  writeProgress(h.progress, b, MSAVE_OFF.progress);
  writeLocation(h.location, b, MSAVE_OFF.location);
  writeLocation(h.prevLocation, b, MSAVE_OFF.prevLocation);
}

/** MSAVE.R3: the new-game header, read by 0cf5:b2b0 (0x49 bytes). */
export function parseMSaveHeader(b: Uint8Array): MSaveHeader {
  if (b.length < MSAVE_HEADER_SIZE) throw new Error(`MSAVE header: ${b.length} bytes`);
  return parseHeader(b);
}

export function serializeMSaveHeader(h: MSaveHeader): Uint8Array {
  const b = new Uint8Array(MSAVE_HEADER_SIZE);
  writeHeader(h, b);
  return b;
}

export function parseMSave(b: Uint8Array): MSave {
  if (b.length !== MSAVE_SIZE) throw new Error(`MSAVE: ${b.length} bytes, expected ${MSAVE_SIZE}`);
  const actors: Actor[] = [];
  for (let i = 0; i < ACTOR_COUNT; i++) actors.push(parseActor(b, MSAVE_OFF.actors + i * ACTOR_SIZE));
  const officers: OfficerDyn[] = [];
  for (let i = 0; i < OFFICER_COUNT; i++) officers.push(parseOfficerDyn(b, MSAVE_OFF.officers + i * OFFICER_DYN_SIZE));
  const towns: TownDyn[] = [];
  for (let i = 0; i < TOWN_COUNT; i++) towns.push(parseTownDyn(b, MSAVE_OFF.towns + i * TOWN_DYN_SIZE, true));
  return { ...parseHeader(b), actors, officers, towns };
}

export function serializeMSave(s: MSave): Uint8Array {
  const b = new Uint8Array(MSAVE_SIZE);
  writeHeader(s, b);
  s.actors.forEach((a, i) => writeActor(a, b, MSAVE_OFF.actors + i * ACTOR_SIZE));
  s.officers.forEach((d, i) => writeOfficerDyn(d, b, MSAVE_OFF.officers + i * OFFICER_DYN_SIZE));
  s.towns.forEach((t, i) => writeTownDyn(t, b, MSAVE_OFF.towns + i * TOWN_DYN_SIZE));
  return b;
}

/**
 * Bytes the original loader actually takes from the town block: 0cf5:b34e copies only 0xa0 of the
 * 0xc0 bytes into its buffer, so towns 27..31 (and 2 bytes of town 26) come from stale memory. Those
 * towns are dummies in every section, so a port can simply read all 32.
 */
export const MSAVE_LOADER_TOWN_BYTES = 0xa0;

// ---------------------------------------------------------------- ESAVE (scenario object DS:0xd4dc)

/**
 * File layout of ESAVEn.R3S = fields of the script context DS:0xd4dc in this order. Serialised into a buffer
 * by 0cf5:7e4a and back by 0cf5:7f38; 0cf5:7d5e / 7c72 write / read the file.
 */
export const ESAVE_FIELDS = [
  // [file offset, object offset, size]
  [0x000, 0x000, 2], // chapter (SNRnD/SNRnM digit, 0cf5:7a86)
  [0x002, 0x002, 2], // stage
  [0x004, 0x004, 2], // block
  [0x006, 0x006, 2], // group start
  [0x008, 0x008, 2], // area = location +4 (0cf5:86f0)
  [0x00a, 0x00a, 2], // = mode<<12 | map (0cf5:86f0)
  [0x00c, 0x1a5, 2], // init 0xffff
  [0x00e, 0x1a7, 2], // init 0xffff
  [0x010, 0x031, 0x174],
  [0x184, 0x1a9, 0x22],
  [0x1a6, 0x1cd, 0x1ef], // 45 x 11 battle units
  [0x395, 0x011, 0x20], // 256 event flags, MSB first (0cf5:9fe4 test / a37a set / a3a6 clear)
  [0x3b5, 0x549, 0x21],
  [0x3d6, 0x3c8, 0x181],
  [0x557, 0x3c6, 1],
  [0x558, 0x3c7, 1],
] as const;

/** Field names follow docs/SCRIPT.md ("Script context"); web/src/engine/script.ts has the interpreter's own copy. */
export interface ESave {
  /** +0 chapter, +2 stage, +4 block, +6 group start. */
  chapter: number;
  stage: number;
  block: number;
  groupStart: number;
  /** +8 area = location +4 (0cf5:86f0). */
  area: number;
  /** +0xa mode<<12 | map (0cf5:86f0). */
  modeMap: number;
  /** +0x1a5 / +0x1a7 area and map the character table belongs to (0xffff initially). */
  charArea: number;
  charMap: number;
  /** +0x31: 62 x 6 characters on the map. */
  characters: Uint8Array;
  /** +0x1a9..+0x1ca: record iterator, current record copy, PC, status, ... */
  runState: Uint8Array;
  /** +0x1cd: 45 x 11 battle units. */
  units: Uint8Array;
  /** +0x11: 256 event flags. */
  flags: Uint8Array;
  /** +0x549: SET_LIST count + 32 bytes. */
  list: Uint8Array;
  /** +0x3c8: objective string. */
  objective: Uint8Array;
  /** +0x3c6 / +0x3c7 battle bytes from BATTLE_SETUP. */
  b3c6: number;
  b3c7: number;
}

export function parseESave(b: Uint8Array): ESave {
  if (b.length !== ESAVE_SIZE) throw new Error(`ESAVE: ${b.length} bytes, expected ${ESAVE_SIZE}`);
  return {
    chapter: u16(b, 0),
    stage: u16(b, 2),
    block: u16(b, 4),
    groupStart: u16(b, 6),
    area: u16(b, 8),
    modeMap: u16(b, 10),
    charArea: u16(b, 12),
    charMap: u16(b, 14),
    characters: b.slice(0x010, 0x184),
    runState: b.slice(0x184, 0x1a6),
    units: b.slice(0x1a6, 0x395),
    flags: b.slice(0x395, 0x3b5),
    list: b.slice(0x3b5, 0x3d6),
    objective: b.slice(0x3d6, 0x557),
    b3c6: b[0x557],
    b3c7: b[0x558],
  };
}

export function serializeESave(e: ESave): Uint8Array {
  const b = new Uint8Array(ESAVE_SIZE);
  [e.chapter, e.stage, e.block, e.groupStart, e.area, e.modeMap, e.charArea, e.charMap].forEach((v, i) => w16(b, i * 2, v));
  b.set(e.characters, 0x010);
  b.set(e.runState, 0x184);
  b.set(e.units, 0x1a6);
  b.set(e.flags, 0x395);
  b.set(e.list, 0x3b5);
  b.set(e.objective, 0x3d6);
  b[0x557] = e.b3c6;
  b[0x558] = e.b3c7;
  return b;
}

/** Event flag n (0..255): byte n>>3, bit 0x80>>(n&7) (0cf5:9fe4). */
export function eventFlag(e: ESave, n: number): boolean {
  return (e.flags[n >> 3] & (0x80 >> (n & 7))) !== 0;
}

export function setEventFlag(e: ESave, n: number, on: boolean): void {
  if (on) e.flags[n >> 3] |= 0x80 >> (n & 7);
  else e.flags[n >> 3] &= ~(0x80 >> (n & 7));
}

// ---------------------------------------------------------------- file names (DS:0x2a48, 0cf5:ae98)

/** Save file names; the slot digit replaces the "0" (char 7 of the drive-prefixed name). R3M variants are never used. */
export function msaveName(slot: number): string {
  return `MSAVE${slot}.R3S`;
}
export function esaveName(slot: number): string {
  return `ESAVE${slot}.R3S`;
}
