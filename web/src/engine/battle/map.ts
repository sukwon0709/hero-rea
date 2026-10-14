// Battle map files: HEXZMAP.R3 (grid maps), HEXBMAP.R3 (close-up combat backdrops).
// See docs/BATTLE.md, "Map data". Loader: 2cb6:373c; names: 2cb6:4d4e; close-up: 2cb6:edb8.

import { unpackLs11 } from '../../formats/ls11';

/** One tactical map. The grid is square (4-neighbour) despite the HEX file names. */
export interface BattleMap {
  /** Width/height in cells. A cell is 2x2 chips of 16x16 px (32x32 px). */
  width: number;
  height: number;
  /** (2*width) x (2*height) chip indices into the HEXZCHP chip set, row-major. */
  chips: Uint8Array;
  /** width x height terrain types (0..19), row-major. */
  terrain: Uint8Array;
}

export const HEXZMAP_MAPS = 58; // entries 0..57 are maps
export const HEXZMAP_NAMES = 58; // entry 58 is the list of battle names (EUC-KR, one per line)

/** Parses one HEXZMAP entry: u8 chipW, u8 chipH, chipW*chipH chips, (chipW/2)*(chipH/2) terrain bytes. */
export function parseBattleMap(entry: Uint8Array): BattleMap {
  const cw = entry[0];
  const ch = entry[1];
  const width = cw >> 1;
  const height = ch >> 1;
  const chips = entry.slice(2, 2 + cw * ch);
  const terrain = entry.slice(2 + cw * ch, 2 + cw * ch + width * height);
  if (terrain.length !== width * height) throw new Error('HEXZMAP entry truncated');
  return { width, height, chips, terrain };
}

/** All maps of HEXZMAP.R3. */
export function loadBattleMaps(hexzmap: Uint8Array): BattleMap[] {
  return unpackLs11(hexzmap)
    .slice(0, HEXZMAP_MAPS)
    .map(parseBattleMap);
}

/**
 * The battle-name lines of HEXZMAP entry 58 as raw EUC-KR byte strings (CR/LF stripped).
 * 2cb6:4d4e picks the line whose index is the current scenario's battle number (1cf5:ace8)
 * and appends " 의 전투".
 */
export function battleNameLines(hexzmap: Uint8Array): Uint8Array[] {
  const text = unpackLs11(hexzmap)[HEXZMAP_NAMES];
  const out: Uint8Array[] = [];
  let s = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === 0x0a || text[i] === 0x0d || text[i] === 0) {
      if (i > s) out.push(text.slice(s, i));
      s = i + 1;
      if (i < text.length && text[i] === 0) break;
    }
  }
  return out;
}

/**
 * Maps that use HEXZCHP entry 2 instead of entry 1 as their second chip set (DS:0x3dcc,
 * 19 words, tested by 2cb6:4d1a). Entry 0 is loaded at offset 0 of the chip segment (handle
 * DS:0x676e) and the second set right after it, at offset 0x2800.
 */
const SECOND_CHIPSET_MAPS = [0, 1, 4, 8, 10, 16, 20, 28, 29, 30, 35, 36, 39, 40, 42, 43, 44, 50, 52];

/** HEXZCHP.R3 entry loaded after entry 0 for map `map` (2cb6:373c / 4d1a). */
export function secondChipSet(map: number): number {
  return SECOND_CHIPSET_MAPS.includes(map) ? 2 : 1;
}

/** HEXBMAP entry (230-byte part) for the defender's terrain in the close-up combat scene (DS:0x4e42). */
export const CLOSEUP_BACK = [4, 3, 0, 0, 1, 0, 2, 4, 4, 0, 0, 0, 0, 2, 4, 2, 2, 0, 0, 0];
/** HEXBMAP entry (528-byte part) for the defender's terrain (DS:0x4e56). */
export const CLOSEUP_FRONT = [7, 7, 7, 5, 6, 5, 5, 7, 7, 5, 5, 8, 5, 5, 7, 5, 5, 5, 5, 5];

/**
 * The two HEXBMAP chip layouts for a close-up fight on `terrain`. 2cb6:edb8 copies them to the
 * map segment at 0x2110 (230 bytes) and 0x21f6 (528 bytes); they index HEXBCHP.R3 chips.
 * Their exact screen arrangement has not been traced.
 */
export function closeupBackdrop(hexbmap: Uint8Array, terrain: number): { back: Uint8Array; front: Uint8Array } {
  const parts = unpackLs11(hexbmap);
  return { back: parts[CLOSEUP_BACK[terrain]], front: parts[CLOSEUP_FRONT[terrain]] };
}
