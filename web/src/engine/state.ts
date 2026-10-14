// Persistent game state of MAIN.EXE, modelled on its DGROUP objects. Each field names the DS address
// it mirrors; docs/DATA.md and docs/GAMEFLOW.md give the code that reads and writes them.
// newGame() follows 0cf5:b2b0, loadGame() follows 0cf5:b34e and toSave() follows 0cf5:ae98.

import {
  BakData,
  EngineTables,
  Item,
  NpcType,
  OfficerDyn,
  OfficerStatic,
  TownDyn,
  TownSection,
  TownStatic,
  maxTroops,
} from '../formats/tables';
import { Actor, ESave, GameProgress, Location, MSave, MSaveHeader, encodeSaveTime } from '../formats/save';

export { MODE } from '../formats/save';

/** Bits of the main-loop status byte DS:0xdaba (main() 0cf5:aaea, loop 0cf5:a88c). */
export const STATUS = {
  /** Location changed: run 0cf5:c86c. */
  LOCATION_CHANGED: 0x02,
  /** Ending reached (event result 8): MAIN exits with code 1 -> END.EXE. */
  ENDING: 0x04,
  /** A game was loaded from the 기능 menu (0cf5:f19c): reload the chapter script. */
  LOADED: 0x08,
  /** Game over (event result 7 or battle result 3): "다시 한번 게임하겠습니까?" */
  GAME_OVER: 0x20,
  /** Quit (게임 종료 confirmed, or battle result 4). */
  QUIT: 0x40,
} as const;

/** MAIN.EXE exit codes as dispatched by HERO.COM (table at HERO.COM 0x749). */
export const EXIT = { OPENING: 0, ENDING: 1, NO_MEMORY: 2, QUIT: 3, RESTART: 4 } as const;

/** Unit id helpers (0cf5:212a, 0cf5:41be). */
export const UNIT = {
  OFFICER: 0x200,
  NPC: 0x400,
  isOfficer: (id: number) => (id & 0xe00) === 0x200,
  isNpc: (id: number) => (id & 0xe00) === 0x400,
  index: (id: number) => id & 0x1ff,
} as const;

/** One entry of the officer table DS:0x7a94 (stride 0x2c, 384 entries), built by 0cf5:707a. */
export interface Officer extends OfficerStatic {
  /** +0 = index | 0x200. */
  id: number;
  dyn: OfficerDyn;
}

/** One entry of the town table DS:0xcc98 (stride 0x20, 32 entries), built by 0cf5:762a. */
export interface Town extends TownStatic {
  /** +0x16/+0x17 from DS:0x136c. */
  pos: [number, number];
  /** +0x19 SMAP.R3 entry, from DS:0x1408. */
  smapEntry: number;
  /** +0x1a..+0x1f */
  dyn: TownDyn;
}

export interface GameState {
  /** DS:0x7a80 */
  progress: GameProgress;
  /** DS:0x7a6c current location; DS:0x7a76 previous one. */
  location: Location;
  prevLocation: Location;
  /** DS:0x7406, 62 x 26 map actors. */
  actors: Actor[];
  /** DS:0x7a94 */
  officers: Officer[];
  /** DS:0xcc98, for the chapter's BBKSDAT1 section. */
  towns: Town[];
  /** DS:0xbc96 (generic NPC types) and DS:0xd09a (items): static, from BAKDATA. */
  npcTypes: NpcType[];
  items: Item[];
  /** DS:0xdb4c chapter title (message bar 1; save slot title). */
  title: string;
  /** Raw title bytes as saved (trailing bytes after the NUL are preserved). */
  titleRaw: Uint8Array;
  /** DS:0xd4dc scenario object (ESAVE); owned by the script engine, null before the chapter loads. */
  scenario: ESave | null;
  /** DS:0xdaba main-loop status bits (STATUS). */
  status: number;
}

const clampU16 = (v: number) => Math.min(v, 10000); // 0cf5:224c

function buildOfficers(bak: BakData, dyn: OfficerDyn[], tables: EngineTables): Officer[] {
  return bak.officers.map((s, i) => {
    const d = { ...dyn[i], items: [...dyn[i].items], b4: Math.min(dyn[i].b4, 100) };
    const max = maxTroops(tables, d.cls, d.level);
    if (d.troops > max) d.troops = max; // 0cf5:707a / 724a
    return { ...s, id: i | UNIT.OFFICER, dyn: d };
  });
}

function buildTowns(section: TownSection, sectionIndex: number, dyn: TownDyn[], tables: EngineTables): Town[] {
  const base = tables.sectionTownBase[sectionIndex];
  return section.towns.map((t, i) => {
    const k = Math.min(base + i, tables.townSmapEntry.length - 1); // dummies past the section read neighbouring bytes
    return { ...t, pos: tables.townPos[k], smapEntry: tables.townSmapEntry[k], dyn: { ...dyn[i] } };
  });
}

function header(h: MSaveHeader): Pick<GameState, 'progress' | 'location' | 'prevLocation' | 'title' | 'titleRaw'> {
  const p = { ...h.progress, money: clampU16(h.progress.money), w2: clampU16(h.progress.w2) };
  if (p.w6 > 0x1d) p.w6 = 5; // 0cf5:6404
  const raw = h.titleRaw.slice();
  const n = raw.indexOf(0);
  const title = new TextDecoder('euc-kr').decode(raw.subarray(0, n < 0 ? raw.length : n));
  return { progress: p, location: { ...h.location }, prevLocation: { ...h.prevLocation }, title, titleRaw: raw };
}

/**
 * New game (0cf5:b2b0): MSAVE.R3 header, BAKDATA default officers and the BBKSDAT1 section of the
 * chapter in MSAVE.R3 (+0x12). The option flags are kept from the running session (b01a with AX=0).
 */
export function newGame(msaveR3: MSaveHeader, bak: BakData, bbksdat: (section: number) => TownSection, tables: EngineTables, optionFlags?: number): GameState {
  const h = header(msaveR3);
  if (optionFlags !== undefined) h.progress.flags = optionFlags;
  const section = tables.chapterSection[h.progress.chapter];
  const sec = bbksdat(section);
  return {
    ...h,
    actors: [],
    officers: buildOfficers(bak, bak.defaultDyn, tables),
    towns: buildTowns(sec, section, sec.defaultDyn, tables),
    npcTypes: bak.npcTypes,
    items: bak.items,
    scenario: null,
    status: 0,
  };
}

/** Load (0cf5:b34e): MSAVEn + ESAVEn; static parts come from BAKDATA / BBKSDAT1 as in the original. */
export function loadGame(save: MSave, esave: ESave | null, bak: BakData, bbksdat: (section: number) => TownSection, tables: EngineTables): GameState {
  const h = header(save);
  const section = tables.chapterSection[h.progress.chapter];
  return {
    ...h,
    actors: save.actors.map((a) => ({ ...a, rest: a.rest.slice() })),
    officers: buildOfficers(bak, save.officers, tables),
    towns: buildTowns(bbksdat(section), section, save.towns, tables),
    npcTypes: bak.npcTypes,
    items: bak.items,
    scenario: esave,
    status: STATUS.LOCATION_CHANGED,
  };
}

/** Builds the MSAVE image the way 0cf5:ae98 does (timestamp from `now`). */
export function toSave(s: GameState, now: Date = new Date()): MSave {
  return {
    timestamp: encodeSaveTime({
      year: now.getFullYear() % 100,
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    }),
    titleRaw: s.titleRaw.slice(),
    progress: { ...s.progress },
    location: { ...s.location },
    prevLocation: { ...s.prevLocation },
    actors: s.actors.map((a) => ({ ...a, rest: a.rest.slice() })),
    officers: s.officers.map((o) => ({ ...o.dyn, items: [...o.dyn.items] })),
    towns: s.towns.map((t) => ({ ...t.dyn })),
  };
}

/** 유비's level, shown in the side panel as 레벨 (0cf5:c362 area). */
export function heroLevel(s: GameState): number {
  return s.officers[0].dyn.level;
}

/** Officers listed by 장수정보 (0cf5:f8e0): same faction as 유비 and dyn bit 7 set. */
export function rosterOfficers(s: GameState): Officer[] {
  const faction = s.officers[0].dyn.flags & 0x1f;
  return s.officers.filter((o) => (o.dyn.flags & 0x80) !== 0 && (o.dyn.flags & 0x1f) === faction);
}
