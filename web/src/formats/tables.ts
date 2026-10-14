// Static data tables of MAIN.EXE: BAKDATA.R3, BBKSDAT1.R3, the FACEDAT.R3 / PACKGRP.R3 blob indexes,
// MSAVE.R3 (see save.ts), DISKn.R3I and the small per-town / per-class tables in MAIN.EXE's DGROUP.
// Layouts, field meanings and the code that reads each table: docs/DATA.md.
// Nothing here embeds game data; every table is read from the original files at runtime.

const eucKr = new TextDecoder('euc-kr');
const sjis = new TextDecoder('shift_jis');

/** NUL-terminated EUC-KR string. Unused entries hold Shift-JIS "ダミー"-style dummies, decoded as Shift-JIS. */
export function cstr(bytes: Uint8Array): string {
  let n = bytes.indexOf(0);
  if (n < 0) n = bytes.length;
  const b = bytes.subarray(0, n);
  for (let i = 0; i < b.length; i++) {
    // EUC-KR is only A1-FE lead + A1-FE trail; anything else means the Japanese tools' text.
    if (b[i] >= 0x80 && (b[i] < 0xa1 || b[i] === 0xff || i + 1 >= b.length || b[i + 1] < 0xa1)) return sjis.decode(b);
    if (b[i] >= 0x80) i++;
  }
  return eucKr.decode(b);
}

/** NUL-terminated Shift-JIS string (the half-width katakana name readings). */
export function sjisStr(bytes: Uint8Array): string {
  let n = bytes.indexOf(0);
  if (n < 0) n = bytes.length;
  return sjis.decode(bytes.subarray(0, n));
}

// ---------------------------------------------------------------- MAIN.EXE DGROUP

/** DGROUP image segment of MAIN.EXE (DS at run time). */
export const DGROUP_SEG = 0x313a;

/** `len` bytes at DS:`off` in the MAIN.EXE file image. */
export function dgroup(mainExe: Uint8Array, off: number, len: number): Uint8Array {
  const hdr = (mainExe[8] | (mainExe[9] << 8)) * 16;
  const p = hdr + DGROUP_SEG * 16 + off;
  return mainExe.subarray(p, p + len);
}

function dgroupStrings(mainExe: Uint8Array, ptrTable: number, count: number): string[] {
  const ptrs = dgroup(mainExe, ptrTable, count * 2);
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(cstr(dgroup(mainExe, ptrs[i * 2] | (ptrs[i * 2 + 1] << 8), 32)));
  return out;
}

export const CHAPTER_COUNT = 5;
export const SECTION_COUNT = 4;
export const CLASS_COUNT = 19;
export const FACTION_COUNT = 15;

/** Engine tables read from DGROUP (addresses are DS offsets). */
export interface EngineTables {
  /** DS:0x0ebc, byte per chapter: BBKSDAT1 section (0cf5:777a). */
  chapterSection: number[];
  /** DS:0x1360, byte per section: number of real towns (0cf5:778e). */
  sectionTownCount: number[];
  /** DS:0x1366, byte per section: first index into the two per-town tables below (0cf5:779c). */
  sectionTownBase: number[];
  /** DS:0x136c, 2 bytes per town (base+index): copied to town +0x16/+0x17 (0cf5:762a). */
  townPos: [number, number][];
  /** DS:0x1408, byte per town (base+index): SMAP.R3 entry of the town map, town +0x19 (0cf5:762a). */
  townSmapEntry: number[];
  /** Class names, near pointers at DS:0x0fd8 (strings from DS:0x0f5e). */
  classNames: string[];
  /** Faction names, near pointers at DS:0x0f1e (strings from DS:0x0ece); index = officer +0x1c & 0x1f. */
  factionNames: string[];
  /** DS:0x1338 / DS:0x134c, byte per class: troop base and per-level growth (0cf5:73b8). */
  troopBase: number[];
  troopGrowth: number[];
}

export function readEngineTables(mainExe: Uint8Array): EngineTables {
  const bytes = (off: number, n: number) => Array.from(dgroup(mainExe, off, n));
  const base = bytes(0x1366, SECTION_COUNT);
  const count = bytes(0x1360, SECTION_COUNT);
  const towns = base[SECTION_COUNT - 1] + count[SECTION_COUNT - 1];
  const pos = bytes(0x136c, towns * 2);
  return {
    chapterSection: bytes(0x0ebc, CHAPTER_COUNT),
    sectionTownCount: count,
    sectionTownBase: base,
    townPos: Array.from({ length: towns }, (_, i) => [pos[i * 2], pos[i * 2 + 1]] as [number, number]),
    townSmapEntry: bytes(0x1408, towns),
    classNames: dgroupStrings(mainExe, 0x0fd8, CLASS_COUNT),
    factionNames: dgroupStrings(mainExe, 0x0f1e, FACTION_COUNT),
    troopBase: bytes(0x1338, CLASS_COUNT),
    troopGrowth: bytes(0x134c, CLASS_COUNT),
  };
}

/** Maximum troops of an officer (0cf5:73b8): 10 * (10*base[class] + growth[class]*(level-1)). */
export function maxTroops(t: EngineTables, cls: number, level: number): number {
  return 10 * (10 * t.troopBase[cls] + t.troopGrowth[cls] * (level - 1));
}

// ---------------------------------------------------------------- BAKDATA.R3

export const NPC_TYPE_COUNT = 256;
export const ITEM_COUNT = 64;
export const OFFICER_COUNT = 384;
export const OFFICER_DYN_SIZE = 18;

export const BAKDATA_NPC = 0x0000; // 256 x 13
export const BAKDATA_ITEMS = 0x0d00; // 64 x 16
export const BAKDATA_OFFICERS = 0x1100; // 384 x 21
export const BAKDATA_DYN = 0x3080; // 384 x 18
export const BAKDATA_SIZE = 0x4b80;

/** Generic unit type (unit id 0x400|index), 13-byte record; loaded by 0cf5:73f6 into DS:0xbc96 (stride 0x10). */
export interface NpcType {
  index: number;
  name: string;
  /** rec[8] -> obj+5. Values 0x11..0x1c; probably the sprite/face set (inferred). */
  b8: number;
  /** rec[9] -> obj+4, rec[10] -> obj+2, rec[11] -> obj+3; meaning unknown. */
  b9: number;
  b10: number;
  b11: number;
  /** rec[12]: not read by 73f6 (0x80 in every record). */
  b12: number;
}

/** Item, 16-byte record; loaded by 0cf5:7812 into DS:0xd09a (stride 0x11). */
export interface Item {
  index: number;
  name: string;
  /** rec[13] -> +0xe: shop price; 0xff = not sold. */
  price: number;
  /** rec[14] -> +0xf: effect strength. */
  power: number;
  /** rec[15] -> +0x10 (clamped 0..15 by 0cf5:79ea): item kind, see docs/DATA.md. */
  type: number;
}

/** Officer static record (21 bytes), merged with the dynamic record by 0cf5:707a into DS:0x7a94 (stride 0x2c). */
export interface OfficerStatic {
  index: number;
  /** [0..5] -> +6 (6 bytes + NUL). */
  name: string;
  /** [6..13] -> +0xd: reading, Shift-JIS half-width katakana. */
  reading: string;
  /** [14..15] -> +0x16: FACEDAT.R3 entry. */
  face: number;
  /** [16] -> +5, meaning unknown (0 for 유비, 1 관우, 2 장비, ...). */
  b16: number;
  /** [17] -> +0x18 통솔, [18] -> +0x19 무력, [19] -> +0x1a 지력 (each clamped 0..100 by 0cf5:74c8). */
  leadership: number;
  strength: number;
  intelligence: number;
  /** [20] -> +0x1b, bit meaning unknown. */
  flags: number;
}

/** Officer dynamic record (18 bytes): BAKDATA defaults, MSAVE 0x695; 0cf5:724a load / 0cf5:7310 save. */
export interface OfficerDyn {
  /** [0] -> +0x1c: bit7 = active (set for almost every officer; 장수정보 lists active officers of 유비's faction), bit6 = ?, bits 0-4 = faction. */
  flags: number;
  /** [1] -> +0x2b (stored +2 in memory). */
  b1: number;
  /** [2] -> +2, [3] -> +3; meaning unknown. */
  b2: number;
  b3: number;
  /** [4] -> +0x1d (clamped 0..100); 100 everywhere. */
  b4: number;
  /** [5..6] -> +0x1e troops (clamped to maxTroops on load). */
  troops: number;
  /** [7] -> +0x20 class, [8] -> +0x21 level, [9] -> +0x22 exp. */
  cls: number;
  level: number;
  exp: number;
  /** [10..17] -> +0x23: 8 item slots, 0xff = empty. */
  items: number[];
}

export function parseOfficerDyn(b: Uint8Array, o: number): OfficerDyn {
  return {
    flags: b[o],
    b1: b[o + 1],
    b2: b[o + 2],
    b3: b[o + 3],
    b4: b[o + 4],
    troops: b[o + 5] | (b[o + 6] << 8),
    cls: b[o + 7],
    level: b[o + 8],
    exp: b[o + 9],
    items: Array.from(b.subarray(o + 10, o + 18)),
  };
}

export function writeOfficerDyn(d: OfficerDyn, b: Uint8Array, o: number): void {
  b[o] = d.flags;
  b[o + 1] = d.b1;
  b[o + 2] = d.b2;
  b[o + 3] = d.b3;
  b[o + 4] = d.b4;
  b[o + 5] = d.troops & 0xff;
  b[o + 6] = d.troops >> 8;
  b[o + 7] = d.cls;
  b[o + 8] = d.level;
  b[o + 9] = d.exp;
  for (let i = 0; i < 8; i++) b[o + 10 + i] = d.items[i];
}

export interface BakData {
  npcTypes: NpcType[];
  items: Item[];
  officers: OfficerStatic[];
  /** New-game dynamic officer records (0cf5:ae58 / b156). */
  defaultDyn: OfficerDyn[];
}

export function parseBakData(b: Uint8Array): BakData {
  if (b.length < BAKDATA_SIZE) throw new Error(`BAKDATA.R3: ${b.length} bytes`);
  const npcTypes: NpcType[] = [];
  for (let i = 0; i < NPC_TYPE_COUNT; i++) {
    const o = BAKDATA_NPC + i * 13;
    npcTypes.push({ index: i, name: cstr(b.subarray(o, o + 8)), b8: b[o + 8], b9: b[o + 9], b10: b[o + 10], b11: b[o + 11], b12: b[o + 12] });
  }
  const items: Item[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const o = BAKDATA_ITEMS + i * 16;
    items.push({ index: i, name: cstr(b.subarray(o, o + 12)), price: b[o + 13], power: b[o + 14], type: Math.min(b[o + 15], 15) });
  }
  const officers: OfficerStatic[] = [];
  for (let i = 0; i < OFFICER_COUNT; i++) {
    const o = BAKDATA_OFFICERS + i * 21;
    officers.push({
      index: i,
      name: cstr(b.subarray(o, o + 6)),
      reading: sjisStr(b.subarray(o + 6, o + 14)),
      face: b[o + 14] | (b[o + 15] << 8),
      b16: b[o + 16],
      leadership: Math.min(b[o + 17], 100),
      strength: Math.min(b[o + 18], 100),
      intelligence: Math.min(b[o + 19], 100),
      flags: b[o + 20],
    });
  }
  const defaultDyn: OfficerDyn[] = [];
  for (let i = 0; i < OFFICER_COUNT; i++) defaultDyn.push(parseOfficerDyn(b, BAKDATA_DYN + i * OFFICER_DYN_SIZE));
  return { npcTypes, items, officers, defaultDyn };
}

// ---------------------------------------------------------------- BBKSDAT1.R3

export const TOWN_COUNT = 32;
export const BBKSDAT_SECTION_SIZE = 0x380;
export const TOWN_DYN_SIZE = 6;

/** Town static record (23 bytes); 0cf5:762a builds the 0x20-byte town object at DS:0xcc98. */
export interface TownStatic {
  index: number;
  /** [0..7] -> +0, [8..19] -> +9 (Shift-JIS reading). */
  name: string;
  reading: string;
  /** [20], [21]: not read. */
  b20: number;
  b21: number;
  /** [22] -> +0x18, meaning unknown. */
  b22: number;
}

/** Town dynamic record: 5 bytes in BBKSDAT1, 6 in a save (0cf5:762a load, 0cf5:7708 save). */
export interface TownDyn {
  /** -> +0x1a */
  b0: number;
  /** -> +0x1b (u16) */
  w1: number;
  /** -> +0x1d, +0x1e */
  b3: number;
  b4: number;
  /** -> +0x1f; absent in BBKSDAT1 (new game sets 3). */
  b5: number;
}

export function parseTownDyn(b: Uint8Array, o: number, withB5: boolean): TownDyn {
  return { b0: b[o], w1: b[o + 1] | (b[o + 2] << 8), b3: b[o + 3], b4: b[o + 4], b5: withB5 ? b[o + 5] : 3 };
}

export function writeTownDyn(d: TownDyn, b: Uint8Array, o: number): void {
  b[o] = d.b0;
  b[o + 1] = d.w1 & 0xff;
  b[o + 2] = d.w1 >> 8;
  b[o + 3] = d.b3;
  b[o + 4] = d.b4;
  b[o + 5] = d.b5;
}

export interface TownSection {
  towns: TownStatic[];
  /** New-game dynamic records (b5 = 3). */
  defaultDyn: TownDyn[];
}

/** One 0x380-byte section of BBKSDAT1.R3 (section = EngineTables.chapterSection[chapter]). */
export function parseBbksdat(b: Uint8Array, section: number): TownSection {
  const base = section * BBKSDAT_SECTION_SIZE;
  if (b.length < base + BBKSDAT_SECTION_SIZE) throw new Error(`BBKSDAT1.R3: no section ${section}`);
  const towns: TownStatic[] = [];
  const defaultDyn: TownDyn[] = [];
  for (let i = 0; i < TOWN_COUNT; i++) {
    const o = base + i * 23;
    towns.push({
      index: i,
      name: cstr(b.subarray(o, o + 8)),
      reading: sjisStr(b.subarray(o + 8, o + 20)),
      b20: b[o + 20],
      b21: b[o + 21],
      b22: b[o + 22],
    });
    defaultDyn.push(parseTownDyn(b, base + TOWN_COUNT * 23 + i * 5, false));
  }
  return { towns, defaultDyn };
}

// ---------------------------------------------------------------- FACEDAT.R3 / PACKGRP.R3

export const FACEDAT_COUNT = 240; // 0cf5:50ec
export const PACKGRP_COUNT = 38; // 0cf5:520e

/** Blob archive: `count` x (u32 offset, u16 size), data at offset + 6*count. Returns the blobs. */
export function parseBlobIndex(b: Uint8Array, count: number): Uint8Array[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Uint8Array[] = [];
  const data = count * 6;
  for (let i = 0; i < count; i++) {
    const off = dv.getUint32(i * 6, true);
    const size = dv.getUint16(i * 6 + 4, true);
    out.push(b.subarray(data + off, data + off + size));
  }
  return out;
}

// ---------------------------------------------------------------- DISKn.R3I

/** Disk label file (Shift-JIS text) compared by the floppy-swap check 0cf5:409e. */
export function parseDiskLabel(b: Uint8Array): string {
  return sjis.decode(b);
}
