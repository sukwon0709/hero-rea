// Save editor model: the officer records, money and items of an MSAVEn.R3S, edited in place on the
// parsed save (formats/save.ts) so that serialising an unedited save gives back the same bytes.
// Names (officers, classes, items, factions) all come from the player's BAKDATA.R3 / MAIN.EXE.
// Rules used here and where they come from (docs/DATA.md, docs/BATTLE.md):
//   max troops  0cf5:73b8  10 * (10*base[class] + growth[class]*(level-1)), tables at DS:0x1338 / 0x134c.
//               The save stores the current troops; the loader 0cf5:724a only clamps them to this maximum.
//   max MP      1cb6:9184  not saved: computed at the start of every battle from 지력 and level.
//   promotion   1cb6:ab86  items 0x13..0x1a: class [0,1,3,4,6,7,9,10] -> class+1 at level >= 15 / 30.
//   class book  1cb6:ab86  items 0x00..0x02, 0x10..0x12 change to [15,18,12,3,6,0]; refused for 유비.
//   level-up    0cf5:6f64  exp 0..99, level += exp/100.

import { MSAVE_SIZE, decodeSaveTime, formatSaveTime, parseMSave, saveTitle, serializeMSave, type MSave } from '../formats/save';
import { CLASS_COUNT, maxTroops, type BakData, type EngineTables, type Item, type OfficerDyn, type OfficerStatic } from '../formats/tables';
import { attackPower, defencePower, maxMp, movePoints } from '../engine/battle/rules';
import type { Officer as BattleOfficer } from '../engine/battle/types';

export const ITEM_SLOTS = 8;
export const EMPTY_ITEM = 0xff;
export const MAX_LEVEL = 99;
export const MAX_EXP = 99;
/** 0cf5:224c clamps money to 10000. */
export const MAX_MONEY = 10000;
/** Officer 0 is 유비 (the player). */
export const HERO = 0;

/** Promotion items 0x13..0x1a (1cb6:ab86): from class -> class + 1 at the given level. */
const PROMOTE_FROM = [0, 1, 3, 4, 6, 7, 9, 10];
const PROMOTE_LEVEL = [15, 30, 15, 30, 15, 30, 15, 30];
/** Class-change items 0x00..0x02, 0x10..0x12 (1cb6:ab86). */
const CLASS_BOOK_TARGETS = [15, 18, 12, 3, 6, 0];
/** Classes 0..11 form four promotion lines of three (class/3, as the attack triangle groups them). */
const LINE_CLASSES = 12;

export interface GameData {
  bak: BakData;
  tables: EngineTables;
}

export type ClassReach = 'line' | 'book' | 'other';

export interface ClassOption {
  cls: number;
  name: string;
  reach: ClassReach;
  /** Level the class needs when reached by promotion (15 or 30), else 0. */
  minLevel: number;
}

/** The promotion line of a class: [first, first+1, first+2], or just [cls] outside lines. */
export function classLine(cls: number): number[] {
  if (cls >= LINE_CLASSES) return [cls];
  const b = cls - (cls % 3);
  return [b, b + 1, b + 2];
}

/** Level a class needs when reached through the promotion items (0 for the first class of a line). */
export function promotionLevel(cls: number): number {
  const i = PROMOTE_FROM.indexOf(cls - 1);
  return cls < LINE_CLASSES && i >= 0 ? PROMOTE_LEVEL[i] : 0;
}

/**
 * Which classes an officer can reach in the game from `origCls`: its own promotion line, and (except for
 * 유비) the class-book targets plus the lines those start. Everything else is 'other'.
 */
export function classOptions(officer: number, origCls: number, names: string[]): ClassOption[] {
  const line = new Set(classLine(origCls));
  const book = new Set<number>();
  if (officer !== HERO) for (const t of CLASS_BOOK_TARGETS) for (const c of classLine(t)) book.add(c);
  const out: ClassOption[] = [];
  for (let c = 0; c < Math.min(CLASS_COUNT, names.length); c++) {
    const reach: ClassReach = line.has(c) ? 'line' : book.has(c) ? 'book' : 'other';
    out.push({ cls: c, name: names[c], reach, minLevel: promotionLevel(c) });
  }
  return out;
}

export interface Derived {
  maxTroops: number;
  maxMp: number;
  attack: number;
  defence: number;
  move: number;
}

/** Values the engine derives from the record (not saved), with morale 100 for attack / defence. */
export function derived(data: GameData, st: OfficerStatic, d: OfficerDyn): Derived {
  const o: BattleOfficer = {
    lead: st.leadership,
    force: st.strength,
    intel: st.intelligence,
    hp: d.troops,
    cls: d.cls,
    level: d.level,
    exp: d.exp,
    items: d.items,
  };
  const items = (id: number) => {
    const it = data.bak.items[id];
    return it ? { value: it.power, type: it.type } : undefined;
  };
  const safe = d.cls < CLASS_COUNT;
  return {
    maxTroops: safe ? maxTroops(data.tables, d.cls, d.level) : 0,
    maxMp: maxMp(o),
    attack: safe ? attackPower(o, 100, items) : 0,
    defence: safe ? defencePower(o, 100, items) : 0,
    move: safe ? movePoints(o, items) : 0,
  };
}

/** One loaded save being edited. `save` is the parsed MSAVE; edits change it in place. */
export class SaveEdit {
  readonly save: MSave;
  /** The class each officer had when loaded (for the reachable-class list). */
  readonly origClass: number[];

  constructor(
    readonly data: GameData,
    readonly original: Uint8Array,
  ) {
    if (original.length !== MSAVE_SIZE) throw new Error(`MSAVE: ${original.length} bytes, expected ${MSAVE_SIZE}`);
    this.save = parseMSave(original);
    this.origClass = this.save.officers.map((o) => o.cls);
  }

  bytes(): Uint8Array {
    return serializeMSave(this.save);
  }

  /** True when serialising now gives different bytes than were loaded. */
  changed(): boolean {
    const b = this.bytes();
    return b.some((v, i) => v !== this.original[i]);
  }

  title(): string {
    return saveTitle(this.save);
  }

  time(): string {
    const t = decodeSaveTime(this.save.timestamp);
    return t ? formatSaveTime(t) : '';
  }

  officer(i: number): { st: OfficerStatic; dyn: OfficerDyn } {
    return { st: this.data.bak.officers[i], dyn: this.save.officers[i] };
  }

  /** Faction of an officer: dynamic byte 0 bits 0..4 (0cf5:0ef6). */
  faction(i: number): number {
    return this.save.officers[i].flags & 0x1f;
  }

  /** The 장수정보 list (0cf5:f8e0): bit 7 set and the same faction as 유비, in table order. */
  roster(): number[] {
    const f = this.faction(HERO);
    const out: number[] = [];
    this.save.officers.forEach((d, i) => {
      if ((d.flags & 0x80) !== 0 && (d.flags & 0x1f) === f) out.push(i);
    });
    return out;
  }

  derived(i: number): Derived {
    const { st, dyn } = this.officer(i);
    return derived(this.data, st, dyn);
  }

  /**
   * Level 1..99. The troops follow the new maximum (0cf5:73b8) when `refill` is set, otherwise they are
   * only clamped to it, as the loader would.
   */
  setLevel(i: number, level: number, refill = true): void {
    const d = this.save.officers[i];
    d.level = clampInt(level, 1, MAX_LEVEL);
    this.fitTroops(i, refill);
  }

  setExp(i: number, exp: number): void {
    this.save.officers[i].exp = clampInt(exp, 0, MAX_EXP);
  }

  setClass(i: number, cls: number, refill = true): void {
    this.save.officers[i].cls = clampInt(cls, 0, CLASS_COUNT - 1);
    this.fitTroops(i, refill);
  }

  setTroops(i: number, troops: number): void {
    const max = this.derived(i).maxTroops;
    this.save.officers[i].troops = clampInt(troops, 0, max);
  }

  private fitTroops(i: number, refill: boolean): void {
    const d = this.save.officers[i];
    const max = this.derived(i).maxTroops;
    if (refill || d.troops > max) d.troops = max;
  }

  /** The officer's items without the empty slots. */
  items(i: number): number[] {
    return this.save.officers[i].items.filter((v) => v !== EMPTY_ITEM);
  }

  /** Sets slot `slot` to an item id or EMPTY_ITEM. Clearing a slot moves the later items up. */
  setItem(i: number, slot: number, item: number): void {
    const d = this.save.officers[i];
    if (slot < 0 || slot >= ITEM_SLOTS) return;
    if (item === EMPTY_ITEM) {
      const rest = d.items.filter((v, k) => k !== slot && v !== EMPTY_ITEM);
      d.items = [...rest, ...Array(ITEM_SLOTS - rest.length).fill(EMPTY_ITEM)];
      return;
    }
    if (item < 0 || item >= this.data.bak.items.length) return;
    // Items are kept packed: a new item goes after the last one held.
    const held = d.items.filter((v) => v !== EMPTY_ITEM).length;
    if (d.items[slot] === EMPTY_ITEM && slot > held) slot = held;
    d.items[slot] = item;
  }

  setFaction(i: number, faction: number, active: boolean): void {
    const d = this.save.officers[i];
    d.flags = (d.flags & 0x60) | (active ? 0x80 : 0) | (faction & 0x1f);
  }

  get money(): number {
    return this.save.progress.money;
  }

  set money(v: number) {
    this.save.progress.money = clampInt(v, 0, MAX_MONEY);
  }
}

export function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

/** True for names decoded from the Japanese tools' placeholder entries (not EUC-KR Hangul). */
export function isPlaceholderName(name: string): boolean {
  return name === '' || !/[가-힣]/.test(name);
}

/** Item label for lists: the item's own name, or `#id` when the record is a placeholder. */
export function itemLabel(it: Item | undefined, id: number): string {
  if (!it) return `#${id}`;
  return isPlaceholderName(it.name) ? `#${id} (?)` : it.name;
}
