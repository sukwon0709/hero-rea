// Assets: the player's original game files, decoded lazily and cached (implements context.ts Assets).
// Nothing here is bundled: everything is read from the files the player loaded (gamefiles.ts).

import type { Assets } from './context';
import type { GameFiles } from '../gamefiles';
import { unpackLs11, isLs11 } from '../formats/ls11';
import { GameFont } from '../formats/font';
import { readMainPalettes, type Rgb4 } from '../formats/palette';
import { decodeTfdce, type TfdceImage } from '../formats/tfdce';
import {
  parseBakData,
  parseBbksdat,
  parseBlobIndex,
  readEngineTables,
  dgroup,
  FACEDAT_COUNT,
  PACKGRP_COUNT,
  type BakData,
  type EngineTables,
  type TownSection,
} from '../formats/tables';
import { parseChapter, parseTownsfolk, readStageTitles, type Chapter, type TownsfolkSection } from '../formats/scenario';
import { decodeInterleaved, decodeCells, decodeSsc2, parseSsc1, type IndexedImage, type Ssc1Bank } from '../formats/sprites';

/** Everything the field engine needs on top of the shared Assets contract. */
export class GameAssets implements Assets {
  readonly main: Uint8Array;
  readonly font: GameFont;
  readonly palettes: Rgb4[][];
  private ls11 = new Map<string, Uint8Array[]>();
  private faceCache = new Map<number, TfdceImage>();
  private packCache = new Map<number, TfdceImage>();
  private faceBlobs: Uint8Array[] | null = null;
  private packBlobs: Uint8Array[] | null = null;
  private chapters = new Map<number, Chapter>();
  private sections = new Map<number, TownSection>();
  private _tables: EngineTables | null = null;
  private _bak: BakData | null = null;
  private _townsfolk: TownsfolkSection[] | null = null;
  private _stageTitles: string[] | null = null;
  private cellCache = new Map<string, Uint8Array[]>();
  private ssc1Cache = new Map<number, Ssc1Bank>();
  private ssc2Cache = new Map<number, IndexedImage[]>();

  constructor(readonly files: GameFiles) {
    this.main = this.file('MAIN.EXE');
    this.font = new GameFont(files.get('ALL_FONT.16P') ?? null, files.get('HANKAKU.FNT') ?? null);
    this.palettes = readMainPalettes(this.main);
  }

  has(name: string): boolean {
    return this.files.has(name.toUpperCase());
  }

  file(name: string): Uint8Array {
    const f = this.files.get(name.toUpperCase());
    if (!f) throw new Error(`missing game file ${name}`);
    return f;
  }

  entries(name: string): Uint8Array[] {
    const key = name.toUpperCase();
    let v = this.ls11.get(key);
    if (!v) {
      const f = this.file(key);
      v = isLs11(f) ? unpackLs11(f) : [f];
      this.ls11.set(key, v);
    }
    return v;
  }

  /** DGROUP bytes of MAIN.EXE (DS:off). */
  ds(off: number, len: number): Uint8Array {
    return dgroup(this.main, off, len);
  }

  dsWord(off: number): number {
    const b = this.ds(off, 2);
    return b[0] | (b[1] << 8);
  }

  /** NUL-terminated EUC-KR bytes at DS:off. */
  dsString(off: number): Uint8Array {
    const b = this.ds(off, 512);
    const n = b.indexOf(0);
    return b.slice(0, n < 0 ? b.length : n);
  }

  get tables(): EngineTables {
    return (this._tables ??= readEngineTables(this.main));
  }

  get bak(): BakData {
    return (this._bak ??= parseBakData(this.file('BAKDATA.R3')));
  }

  section(n: number): TownSection {
    let s = this.sections.get(n);
    if (!s) {
      s = parseBbksdat(this.file('BBKSDAT1.R3'), n);
      this.sections.set(n, s);
    }
    return s;
  }

  chapter(c: number): Chapter {
    let ch = this.chapters.get(c);
    if (!ch) {
      ch = parseChapter(c, this.file(`SNR${c}D.R3`), this.file(`SNR${c}M.R3`));
      this.chapters.set(c, ch);
    }
    return ch;
  }

  get townsfolk(): TownsfolkSection[] {
    return (this._townsfolk ??= parseTownsfolk(this.file('IPPAN0.R3'), this.file('IPPAN0M.R3'), this.main));
  }

  get stageTitles(): string[] {
    return (this._stageTitles ??= readStageTitles(this.main));
  }

  /** FACEDAT.R3 portrait n (64 x 80, TF-DCE). */
  face(n: number): TfdceImage | null {
    let img = this.faceCache.get(n);
    if (!img) {
      this.faceBlobs ??= parseBlobIndex(this.file('FACEDAT.R3'), FACEDAT_COUNT);
      const blob = this.faceBlobs[n];
      if (!blob || !blob.length) return null;
      img = decodeTfdce(blob);
      this.faceCache.set(n, img);
    }
    return img;
  }

  /** PACKGRP.R3 picture n (TF-DCE). */
  picture(n: number): TfdceImage | null {
    let img = this.packCache.get(n);
    if (!img) {
      this.packBlobs ??= parseBlobIndex(this.file('PACKGRP.R3'), PACKGRP_COUNT);
      const blob = this.packBlobs[n];
      if (!blob || !blob.length) return null;
      img = decodeTfdce(blob);
      this.packCache.set(n, img);
    }
    return img;
  }

  /** MARK.R3 (one entry, the UI bank). */
  get mark(): Uint8Array {
    return this.entries('MARK.R3')[0];
  }

  /** A byte-interleaved image from MARK.R3 (frame tiles: 3 planes; buttons: 4). */
  markImage(offset: number, w: number, h: number, planes = 4): IndexedImage {
    return decodeInterleaved(this.mark, offset, w, h, planes);
  }

  /** 16x16 cells of an LS11 entry (tile sets). */
  cells(name: string, entry: number): Uint8Array[] {
    const key = `${name}#${entry}`;
    let c = this.cellCache.get(key);
    if (!c) {
      c = decodeCells(this.entries(name)[entry] ?? new Uint8Array(0));
      this.cellCache.set(key, c);
    }
    return c;
  }

  ssc1(entry: number): Ssc1Bank | null {
    let b = this.ssc1Cache.get(entry);
    if (!b) {
      const e = this.entries('SSCCHR1.R3')[entry];
      if (!e) return null;
      b = parseSsc1(e);
      this.ssc1Cache.set(entry, b);
    }
    return b;
  }

  /** SSCCHR2 entry: 4 frames of 32x40 (front, front, back, back). */
  ssc2(entry: number): IndexedImage[] | null {
    let f = this.ssc2Cache.get(entry);
    if (!f) {
      const e = this.entries('SSCCHR2.R3')[entry];
      if (!e) return null;
      f = decodeSsc2(e);
      this.ssc2Cache.set(entry, f);
    }
    return f;
  }
}
