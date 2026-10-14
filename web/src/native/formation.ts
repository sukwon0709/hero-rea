// FORMATION (script op 23): the pre-battle formation screen of MAIN.EXE, 2cb4:2be2.
//
// Addresses are MAIN.EXE segment:offset (Ghidra's 3cb4 = 2cb4 here). Coordinates in the comments are
// layout coordinates (screen y - 40), as in the disassembly.
//
//  * 2be2 entry: 274c builds the click map, 2ba8 shows the whole army and asks "도구를 교환하겠습니까?"
//    (item exchange, mode 2), 29dc builds the list of officers that may take part, then mode 0 (pick
//    officers) runs until 종료 is confirmed; 2af2 shows the chosen list, 1aca writes it into the battle
//    setup (the caller does this: see game.ts formationScreen).
//  * 290c: PACKGRP.R3 picture 2 at (16, 16); field patches grabbed at (0x20, 0x20) and (0x150, 0xc0)
//    into DS:0x7306 / 0x7386 (0cf5:4558, args y then x), tiled by 0cf5:52ee with selectors 2 / 3.
//  * slots: 6 per page at the columns DS:0x5282 {4, 0x16} and rows DS:0x5286 {0x50, 0x90, 0xd0}
//    (1b62); 1dfa draws one: HEXZCHR icon (0cf5:c5e6), level, name (1d84), 병력 (troops).
//  * 2862: the event loop of a mode (mode functions DS:0x54ac, click handlers DS:0x5358 + 17 * mode),
//    hit-testing the 80 x 25 cell map of 0cf5:12b8 / 1312 (regions 0x10..0x15 slots, 0x16 / 0x17 page
//    up / down, 0x18 종료, 0x19..0x20 item rows).
//  * officer details (1ff8): class, level, 통솔력 / 무력 / 지력 (order DS:0x52fa), name, portrait
//    (0cf5:51b2) and the item list (18e2, sorted ascending by 0cf5:cf1a).
//  * selected officers' icons are drawn by 1000:63ba with the masks 1000:6506(1) patches in:
//    rows 0,1 mod 4 keep pixels with x & 2 == 0, rows 2,3 those with x & 2 != 0, the rest become 0.

import { TextConsole } from '../formats/font';
import { maxTroops } from '../formats/tables';
import { decodeCells, type IndexedImage } from '../formats/sprites';
import type { GameState, Officer } from '../engine/state';
import type { UnitSlot } from '../engine/script';
import type { Input } from '../engine/input';
import type { GameAssets } from './assets';
import { Draw, LAYOUT_Y, bytesOf, type Button } from './draw';
import { CURSOR, type Video } from './video';
import type { GameUi } from './ui';

export interface FormationHost {
  assets: GameAssets;
  draw: Draw;
  ui: GameUi;
  video: Video;
  input: Input;
  state: GameState;
  /** ScriptState.units: the BATTLE_SETUP table (DS:0xd4dc + 0x1cd, 0x2d entries). */
  units: UnitSlot[];
  sfx(n: number): void;
  /**
   * Harness play (Game.autoPlay): decisions go through ui.pickButton with one button per sensible
   * click, so the dev playthrough's answer() (first enabled button, yes to yes/no) completes it.
   */
  auto?: boolean;
}

export interface FormationResult {
  /** DS:0xe5d8: the fixed officers (first `fixed` entries) and the picks (-1 = empty). */
  chosen: number[];
  fixed: number;
}

const MSG = 0x5258; // near pointers to the screen's messages
const ICON_FILE = 'HEXZCHR.R3'; // DS:0xe54 (0cf5:c644)
const SLOT_X = [4, 0x16]; // DS:0x5282, columns
const SLOT_Y = [0x50, 0x90, 0xd0]; // DS:0x5286
const STAT_ORDER = [2, 0, 1]; // DS:0x52fa: 통솔력, 무력, 지력 (0cf5:c70e kinds)
const CLASS_RANK = 0x50c2; // sort key per class (1976)
const ITEM_KINDS = 0x50b6; // item kind names
const CLASS_NAMES = 0x0fd8;
/** 274c / DS:0x54c0: page up, page down, 종료 as (col, row, w, h) in 8 x 16 cells. */
const BUTTONS: [number, number, number, number][] = [
  [14, 18, 4, 1],
  [14, 19, 4, 1],
  [32, 18, 6, 2],
];

type Click = { button: 'left' | 'right'; region: number };

const NONE = -1;
const NOP = 2; // handler result "nothing happened" (242e)

export async function runFormation(h: FormationHost): Promise<FormationResult> {
  return new Formation(h).run();
}

class Formation {
  private readonly a: GameAssets;
  private readonly d: Draw;
  private readonly con: TextConsole;
  private readonly grid = new Uint8Array(80 * 25);
  private patches: IndexedImage[] = [];
  private icons: Uint8Array[][] = [];

  // DS variables of the original
  private list: number[] = []; // dac6: officers shown (0x42 max)
  private count = 0; // db4a
  private page = 0; // e600
  private lastPage = 0; // e5fe
  private chosen: number[] = new Array(15).fill(NONE); // e5d8
  private total = 0; // e5f6: player slots of the battle setup
  private fixed = 0; // e5f8: officers already placed (first entries of chosen)
  private remaining = 0; // e5fa
  private shown = NONE; // e5fc: officer whose details are on screen
  private giver = NONE; // e5ca: officer giving an item (record pointer in the original)
  private overview = false; // e5c8: the first army overview (no remaining count)
  private giverPage = 0; // e5cc
  private item = 0; // e5cd
  private items: number[] = new Array(8).fill(0xff); // e5d0

  constructor(private readonly h: FormationHost) {
    this.a = h.assets;
    this.d = h.draw;
    this.con = new TextConsole(this.a.font, this.d.view, { mode: 4, fg: 7, bg: 0, bottom: 480 - 16 });
  }

  // ---------------------------------------------------------------- data helpers

  private officer(i: number): Officer {
    return this.h.state.officers[i];
  }

  private dsText(ptr: number): Uint8Array {
    return this.a.dsString(ptr);
  }

  private msg(i: number): Uint8Array {
    return this.dsText(this.a.dsWord(MSG + 2 * i));
  }

  private dsByte(off: number): number {
    return this.a.ds(off, 1)[0];
  }

  /** 0cf5:6f42(rec, 0cf5:73b8(rec)): troops back to the maximum. */
  private heal(o: Officer) {
    o.dyn.troops = maxTroops(this.a.tables, o.dyn.cls, o.dyn.level);
  }

  /** 1d62: index of `o` among the first `total` chosen entries, or -1. */
  private chosenIndex(o: number): number {
    for (let i = 0; i < this.total; i++) if (this.chosen[i] === o) return i;
    return NONE;
  }

  // ---------------------------------------------------------------- drawing primitives

  /** 0cf5:52ee: tiles patch `sel` (2 = DS:0x7306, 3 = DS:0x7386) over (x, y, w, h). */
  private clear(sel: number, h: number, x: number, y: number, w: number) {
    const p = this.patches[sel - 2];
    if (!p) return;
    const px = this.d.screen.pixels;
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx, sy = y + yy + LAYOUT_Y;
        if (sx >= 0 && sx < 640 && sy >= 0 && sy < 480) px[sy * 640 + sx] = p.pixels[(yy & 15) * 16 + (xx & 15)];
      }
    this.d.dirty();
  }

  /** 0cf5:091e(text, y, col) then 0cf5:0f18 (printf); the text object keeps its colours and mode. */
  private print(y: number, col: number, ...parts: (string | Uint8Array)[]) {
    const s = this.con.s;
    s.x = col;
    s.y = y + LAYOUT_Y;
    s.margin = col;
    for (const p of parts) this.con.write(typeof p === 'string' ? latin(p) : p);
    this.d.dirty();
  }

  private fg(c: number) {
    this.con.s.fg = c;
  }

  private bg(c: number) {
    this.con.s.bg = c;
  }

  /** 0cf5:c5e6: 2 x 2 HEXZCHR cells (offsets DS:0x2de0); mode 0 = 1000:63ba masked, 1 = 1000:6296. */
  private icon(icon: number, x: number, y: number, mode: number) {
    const cells = this.icons[icon];
    if (!cells) return;
    const px = this.d.screen.pixels;
    for (let c = 0; c < 4; c++) {
      const cell = cells[c];
      if (!cell) continue;
      const cx = x + (c & 1) * 16, cy = y + (c >> 1) * 16 + LAYOUT_Y;
      for (let yy = 0; yy < 16; yy++)
        for (let xx = 0; xx < 16; xx++) {
          let v = cell[yy * 16 + xx];
          if (mode === 0 && ((yy & 2) === 0 ? (xx & 2) !== 0 : (xx & 2) === 0)) v = 0;
          const sx = cx + xx, sy = cy + yy;
          if (sx >= 0 && sx < 640 && sy >= 0 && sy < 480) px[sy * 640 + sx] = v;
        }
    }
    this.d.dirty();
  }

  /** 0cf5:5524: sound 0, then the button box in XOR (557c draws it again to undo it). */
  private press(x: number, y: number, w: number, h: number) {
    this.h.sfx(0);
    this.xorBox(x, y, w, h);
  }

  /** 0cf5:4418 as 5524 / 557c call it: GRPDRV AH=08h mode 1 colour 7, AH=0Dh box (XOR fill, inferred from the emulator). */
  private xorBox(x: number, y: number, w: number, h: number, c = 7) {
    const px = this.d.screen.pixels;
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx, sy = y + yy + LAYOUT_Y;
        if (sx >= 0 && sx < 640 && sy >= 0 && sy < 480) px[sy * 640 + sx] ^= c;
      }
    this.d.dirty();
  }

  // ---------------------------------------------------------------- screen parts

  /** 1b62: slot position of list index `i` (column, layout y). */
  private pos(i: number): [number, number] {
    return [SLOT_X[i & 1], SLOT_Y[(i >> 1) % 3]];
  }

  /** 274c: the click map (0cf5:12b8: id, rows, cols, row, col). */
  private regions() {
    const set = (id: number, rows: number, cols: number, row: number, col: number) => {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (row + r < 25 && col + c < 80) this.grid[(row + r) * 80 + col + c] = id;
    };
    for (let i = 0; i < 6; i++) {
      const [col, y] = this.pos(i);
      set(0x10 + i, 3, 0x10, y >> 4, col);
    }
    BUTTONS.forEach(([col, row, w, hh], i) => set(0x16 + i, hh, w, row, col));
    for (let i = 0; i < 8; i++) set(0x19 + i, 1, 0x14, 0xc + i, 0x2a);
  }

  /** 0cf5:1312: region under a screen point (0 = none). */
  private regionAt(x: number, y: number): number {
    const ly = y - LAYOUT_Y;
    if (ly < 0 || ly > 399 || x < 0 || x >= 640) return 0;
    return this.grid[(ly >> 4) * 80 + (x >> 3)];
  }

  /** 290c: the screen. */
  private drawScreen() {
    this.fg(7);
    this.bg(0);
    const pic = this.a.picture(2);
    if (pic) this.d.image(pic, 0x10, 0x10 + LAYOUT_Y);
    const grab = (x: number, y: number): IndexedImage => ({ width: 16, height: 16, pixels: this.d.screen.grab(x, y + LAYOUT_Y, 16, 16) });
    this.patches = [grab(0x20, 0x20), grab(0x150, 0xc0)];
    this.drawPages();
    this.print(0x128, 0x1c, this.dsText(0x54cc)); // "인"
  }

  /** 1a70: "/ n" pages. */
  private drawPages() {
    this.clear(2, 0x10, 0x60, 0x128, 0x10);
    this.print(0x128, 0xa, fmt(this.dsText(0x528c), this.lastPage + 1));
  }

  /** 1cf4: page number. */
  private drawPageNo() {
    this.clear(2, 0x10, 0x40, 0x128, 0x10);
    this.print(0x128, 8, fmt(this.dsText(0x52c7), this.page + 1));
  }

  /** 1d28: officers still to pick (not during the overview). */
  private drawRemaining() {
    this.clear(2, 0x10, 0xd0, 0x128, 0x10);
    if (!this.overview) this.print(0x128, 0x1a, fmt(this.dsText(0x52d1), this.remaining));
  }

  /** 1d84: name centred in 7 columns from col + 8, in colour `c` (o < 0 only clears). */
  private drawName(col: number, y: number, o: number, c: number) {
    this.clear(2, 0x10, (col + 8) * 8, y, 0x30);
    if (o < 0) return;
    const name = bytesOf(this.officer(o).name);
    this.fg(c);
    this.print(y, col + 8 + (((7 - name.length) & 0xffff) >> 1), fmt(this.dsText(0x52de), name));
  }

  private iconOf(o: number): number {
    return o === 0 ? 0x13 : this.officer(o).dyn.cls;
  }

  /** 1dfa: one slot. */
  private drawSlot(col: number, y: number, o: number) {
    this.fg(7);
    const off = this.officer(o);
    let mode = 1;
    let c = 7;
    if (this.chosenIndex(o) !== NONE || this.giver === o) {
      mode = 0;
      c = 2;
    }
    this.icon(this.iconOf(o), col * 8, y, mode);
    this.clear(2, 0x10, (col + 2) * 8, y + 0x20, 0x10);
    this.print(y + 0x20, col + 2, fmt(this.dsText(0x52e7), off.dyn.level));
    this.drawName(col, y + 0x20, o, c);
    this.fg(7);
    this.print(y + 8, col + 0xc, fmt(this.dsText(0x52ee), off.dyn.troops));
  }

  /** 1f14: the current page of six slots. */
  private drawPage() {
    this.bg(1);
    for (let i = 0; i < 6; i++) {
      const k = this.page * 6 + i;
      const [col, y] = this.pos(k);
      this.clear(2, 0x10, (col + 0xc) * 8, y + 8, 0x20);
      if (k >= this.count) {
        this.clear(2, 0x20, col * 8, y, 0x20);
        this.clear(2, 0x10, (col + 2) * 8, y + 0x20, 0x10);
        this.drawName(col, y + 0x20, NONE, 0);
      } else this.drawSlot(col, y, this.list[k]);
    }
    this.bg(0);
    this.fg(7);
    this.drawRemaining();
    this.drawPageNo();
  }

  /** 18e2: item row `row` of the officer on display, in colour `c`. */
  private drawItem(row: number, c: number) {
    this.fg(c);
    const y = (row + 0xc) * 16;
    this.clear(3, 0x10, 0x150, y, 0xa0);
    const id = this.items[row];
    if (id === 0xff) return;
    const it = this.h.state.items[id];
    this.print(y, 0x2a, fmt(this.dsText(0x50d5), bytesOf(it?.name ?? '')));
    this.print(y, 0x36, fmt(this.dsText(0x50de), this.dsText(this.a.dsWord(ITEM_KINDS + 2 * ((it?.type ?? 0) & 0xff)))));
  }

  /** 1ff8: details of officer `o`. */
  private drawDetails(o: number) {
    this.bg(0);
    const off = this.officer(o);
    this.clear(2, 0x10, 0x1a0, 0x18, 0x40);
    this.print(0x18, 0x34, this.dsText(this.a.dsWord(CLASS_NAMES + 2 * off.dyn.cls)));
    this.clear(2, 0x10, 0x1e0, 0x30, 0x10);
    this.print(0x30, 0x3c, pad(off.dyn.level, 2));
    const stats = [off.strength, off.intelligence, off.leadership];
    for (let i = 0; i < 3; i++) {
      const y = 0x50 + 0x20 * i;
      this.clear(2, 0x10, 0x1d8, y, 0x18);
      this.print(y, 0x3b, pad(stats[STAT_ORDER[i]], 3));
    }
    this.clear(2, 0x10, 0x150, 0x80, 0x40);
    this.clear(2, 0x10, 0x150, 0x90, 0x40);
    this.print(0x90, 0x2a, bytesOf(off.name));
    const face = this.a.face(off.face);
    if (face) this.d.image(face, 0x150, 0x20 + LAYOUT_Y);
    // 0cf5:cf1a: the officer's items, sorted ascending
    const held = off.dyn.items.filter((v) => v !== 0xff).sort((p, q) => p - q);
    this.items = [...held, ...new Array(8 - held.length).fill(0xff)];
    if (held.length) for (let r = 0; r < 8; r++) this.drawItem(r, 7);
    else {
      this.clear(3, 0x80, 0x150, 0xc0, 0xa0);
      this.print(0xc0, 0x2a, this.dsText(0x530b)); // 소지품 없음
    }
  }

  /** 1c52 */
  private clearMessage() {
    this.clear(2, 0x10, 0x18, 0x20, 0x120);
  }

  /** 1c66: message line; kind 0x11 = "<item>(을) 누구에게 주겠습니까?", 0x14 = none; wait 1 / 2. */
  private async message(wait: number, text: Uint8Array, kind: number): Promise<void> {
    this.clearMessage();
    this.bg(0);
    if (kind === 0x11) {
      const name = bytesOf(this.h.state.items[this.item]?.name ?? '');
      this.print(0x20, 3, fmt(this.dsText(0x529c), name));
    } else if (kind !== 0x14) this.print(0x20, 3, fmt(this.dsText(0x52be), text));
    if (wait === 1 || wait === 2) {
      await this.waitClick(0x3c); // 0cf5:254c, 251e(0x3c)
      if (wait === 1) this.clearMessage();
    }
  }

  // ---------------------------------------------------------------- input

  /** 0cf5:251e: up to `n` ticks or a click. */
  private async waitClick(n: number) {
    this.h.input.flush();
    for (let i = 0; i < n; i++) {
      if (!this.h.auto && (this.h.input.takeClick() || this.h.input.takeKey())) return;
      await this.h.video.frame();
    }
  }

  /** One click of 2862 (0cf5:1054 / 2514 / 1312). */
  private async click(mode: number): Promise<Click> {
    if (this.h.auto) return this.autoClick(mode);
    const c = await this.h.ui.click(CURSOR.ARROW);
    return { button: c.button, region: c.button === 'left' ? this.regionAt(c.x, c.y) : 0 };
  }

  /** Harness decisions: one button per useful region, in the order a first-enabled answer should take. */
  private async autoClick(mode: number): Promise<Click> {
    const regions: number[] = [];
    if (mode === 0 && this.remaining > 0) {
      for (let i = 0; i < 6; i++) {
        const k = this.page * 6 + i;
        if (k < this.count && this.chosenIndex(this.list[k]) === NONE) regions.push(0x10 + i);
      }
      const later = this.list.slice((this.page + 1) * 6, this.count).some((o) => this.chosenIndex(o) === NONE);
      if (!regions.length && later) regions.push(0x17);
    }
    if (mode === 0 || mode === 2) regions.push(0x18);
    if (!regions.length) return { button: 'right', region: 0 };
    const buttons: Button[] = regions.map((r) => ({ x: 0, y: 0, w: 8, h: 16, kind: 0 }) as Button);
    const i = await this.h.ui.pickButton(buttons, true);
    if (i < 0) return { button: 'right', region: 0 };
    return { button: 'left', region: regions[i] };
  }

  /** 2862: runs mode `mode` until a handler returns -1 or 1. */
  private async loop(mode: number): Promise<number> {
    let redraw = true;
    let result = 0;
    for (;;) {
      if (redraw) await this.modeEnter(mode);
      redraw = false;
      const c = await this.click(mode);
      if (c.button === 'left' && c.region >= 0x10 && c.region <= 0x20) {
        result = await this.handle(mode, c.region - 0x10);
        if (result === -1 || result === 1) return result;
        if (result === 0) redraw = true;
      }
      if (c.button === 'right' && (mode === 3 || mode === 4)) {
        if (mode === 3) this.giver = NONE;
        return -1;
      }
    }
  }

  /** The mode functions DS:0x54ac (26c0, 26d8, 26dc, 26f4, 2734) with the redraw flag set. */
  private async modeEnter(mode: number) {
    switch (mode) {
      case 0:
        await this.message(0, this.msg(1), 1);
        break;
      case 2:
        await this.message(0, this.msg(15), 0xf);
        break;
      case 3:
        this.page = this.giverPage;
        this.drawPage();
        await this.message(0, this.msg(16), 0x10);
        if (this.giver !== NONE && this.shown !== this.giver) {
          this.shown = this.giver;
          this.drawDetails(this.giver);
        }
        break;
      case 4:
        await this.message(0, this.msg(17), 0x11);
        break;
    }
  }

  /** The click handlers DS:0x5358 (17 per mode). */
  private async handle(mode: number, r: number): Promise<number> {
    if (r < 6) {
      if (mode === 0) return this.toggle(r);
      if (mode === 2) return this.pickGiver(r);
      if (mode === 4) return this.give(r);
      return NOP;
    }
    if (r === 6 && mode !== 3) return this.pageUp();
    if (r === 7 && mode !== 3) return this.pageDown();
    if (r === 8 && mode === 0) return this.confirm(4); // 239e
    if (r === 8 && mode === 2) return this.confirm(19); // 269a
    if (r >= 9 && mode === 3) return this.pickItem(r - 9);
    return NOP;
  }

  /** 239e / 269a: 종료 pressed, caption yes/no (2304). */
  private async confirm(msg: number): Promise<number> {
    this.press(0x100, 0x120, 0x30, 0x20);
    const yes = await this.h.ui.captionBox(this.msg(msg), 2);
    this.xorBox(0x100, 0x120, 0x30, 0x20);
    return yes ? -1 : 0;
  }

  /** 23c4 */
  private async pageUp(): Promise<number> {
    if (this.page === 0) return NOP;
    return this.turnPage(0x120, -1);
  }

  /** 23f8 */
  private async pageDown(): Promise<number> {
    if (this.page === this.lastPage) return NOP;
    return this.turnPage(0x130, 1);
  }

  private async turnPage(y: number, step: number): Promise<number> {
    this.press(0x70, y, 0x20, 0x10);
    this.page += step;
    this.drawPage();
    await this.release();
    this.xorBox(0x70, y, 0x20, 0x10);
    return 0;
  }

  /** 0cf5:254c: waits until the button is released (clicks here are whole events). */
  private async release() {
    await this.h.video.frame();
  }

  /** 2194: mode 0 slot click: pick or release an officer. */
  private async toggle(r: number): Promise<number> {
    const k = this.page * 6 + r;
    if (k >= this.count) return NOP;
    this.h.sfx(0);
    const o = this.list[k];
    if (o !== this.shown) {
      this.shown = o;
      this.drawDetails(o);
    }
    const [col, y] = this.pos(k);
    this.fg(7);
    const at = this.chosenIndex(o);
    if (at !== NONE) {
      if (at < this.fixed) {
        this.h.sfx(2);
        await this.message(1, this.msg(2), 2);
        await this.release();
      } else {
        this.remaining++;
        this.drawName(col, y + 0x20, o, 7);
        this.drawRemaining();
        this.chosen[at] = NONE;
        this.icon(this.iconOf(o), col * 8, y, 1);
      }
    } else if (this.remaining === 0) {
      this.h.sfx(2);
      await this.message(1, this.msg(3), 3);
      await this.release();
    } else {
      this.remaining--;
      this.drawName(col, y + 0x20, o, 2);
      this.drawRemaining();
      const free = this.chosenIndex(NONE);
      if (free !== NONE) this.chosen[free] = o;
      this.icon(this.iconOf(o), col * 8, y, 0);
    }
    await this.release();
    return 0;
  }

  /** 248c: mode 2 slot click: the officer who gives an item. */
  private async pickGiver(r: number): Promise<number> {
    const page = this.page;
    const k = r + page * 6;
    if (k >= this.count) return NOP;
    this.giverPage = page;
    this.h.sfx(0);
    const o = this.list[k];
    const [col, y] = this.pos(k);
    this.shown = o;
    this.drawDetails(o);
    this.giver = o;
    this.drawSlot(col, y, o);
    if (this.officer(o).dyn.items.every((v) => v === 0xff)) {
      // the "(은) 아무것도 갖고 있지 않습니다." line is printed, then 1c66 clears the line before waiting
      this.clearMessage();
      this.bg(0);
      this.print(0x20, 3, fmt(this.dsText(0x532d), bytesOf(this.officer(o).name)));
      this.h.sfx(2);
      await this.message(0, this.msg(20), 0x14);
      await this.waitAnyClick();
      this.giver = NONE;
    } else {
      this.fg(7);
      await this.loop(3);
      await this.release();
      if (page !== this.page) return 0;
    }
    this.drawSlot(col, y, o);
    return 0;
  }

  /** 0cf5:2556 */
  private async waitAnyClick() {
    if (this.h.auto) return;
    this.h.input.flush();
    await this.h.ui.click(CURSOR.ARROW);
  }

  /** 2432: mode 3 item row click. */
  private async pickItem(row: number): Promise<number> {
    const id = this.items[row];
    if (id === 0xff) return NOP;
    this.h.sfx(0);
    this.item = id;
    this.drawItem(row, 2);
    const r = await this.loop(4);
    if (r === 1) return -1;
    this.drawItem(row, 7);
    return 0;
  }

  /** 259c: mode 4 slot click: give the item to this officer. */
  private async give(r: number): Promise<number> {
    const k = this.page * 6 + r;
    if (k >= this.count) return NOP;
    const o = this.list[k];
    if (o === this.giver) return NOP;
    this.h.sfx(0);
    this.shown = o;
    this.drawDetails(o);
    this.fg(7);
    const target = this.officer(o);
    if (!target.dyn.items.includes(0xff)) {
      this.h.sfx(2);
      await this.message(1, this.msg(18), 0x12);
      await this.release();
      return 0;
    }
    // 2340: "<name>님께 주어도 좋습니까?"
    const q = new Uint8Array([...bytesOf(target.name), ...this.dsText(0x5317)]);
    if (!(await this.h.ui.captionBox(q, 2))) {
      await this.release();
      return -1;
    }
    const from = this.officer(this.giver).dyn.items;
    target.dyn.items[target.dyn.items.indexOf(0xff)] = this.item; // 0cf5:6d70
    const slot = from.indexOf(this.item); // 0cf5:6d1c
    if (slot >= 0) from[slot] = 0xff; // 0cf5:7590
    this.giver = NONE;
    this.shown = o;
    this.drawDetails(o);
    return 1;
  }

  // ---------------------------------------------------------------- lists

  private sameFaction(): Officer[] {
    const hero = this.h.state.officers[0];
    const f = hero.dyn.flags & 0x1f; // 2cb6:0ef6
    return this.h.state.officers.filter((o) => (o.dyn.flags & 0x1f) === f).slice(0, 0x180);
  }

  /** 1976: the hero first, then by class rank (DS:0x50c2) and level (higher first). */
  private sort() {
    const n = this.count;
    const at = this.list.indexOf(0);
    if (at > 0 && at < n) [this.list[0], this.list[at]] = [this.list[at], this.list[0]];
    const rank = (o: number) => this.dsByte(CLASS_RANK + this.officer(o).dyn.cls);
    for (let i = 1; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.list[i], b = this.list[j];
        if (rank(b) < rank(a) || (rank(b) === rank(a) && this.officer(b).dyn.level > this.officer(a).dyn.level)) {
          this.list[j] = a;
          this.list[i] = b;
        }
      }
    }
  }

  /** 1aa4 */
  private setPages(n: number) {
    this.page = 0;
    this.lastPage = Math.floor(n / 6);
    if (this.lastPage && n % 6 === 0) this.lastPage--;
  }

  /** 2b28: every active officer of the hero's faction (troops restored). */
  private armyList() {
    this.list = [];
    for (const o of this.sameFaction()) {
      if (!(o.dyn.flags & 0x80)) continue; // 0cf5:eed2
      this.heal(o);
      this.list.push(o.index);
      if (this.list.length === 0x42) break;
    }
    this.count = this.list.length;
    this.sort();
    this.setPages(this.count);
  }

  /** 1bac: fixed officers and free player slots of the battle setup. */
  private setupSlots() {
    this.chosen = new Array(15).fill(NONE);
    this.fixed = 0;
    this.total = 0;
    for (const u of this.h.units.slice(0, 0x2d)) {
      const id = u.officer;
      if (id === 0xffff) continue;
      if (id < 0x400 && this.h.state.officers[id]) this.heal(this.officer(id));
      if (u.flags & 1) continue;
      if (id < 0x400) {
        const o = this.h.state.officers[id];
        if (o && (o.dyn.flags & 0x1f) === 0) {
          this.total++;
          this.chosen[this.fixed++] = id;
        }
      } else this.total++;
    }
    this.remaining = this.total - this.fixed;
    this.shown = NONE;
  }

  /** 29dc: the officers that may take part (DS:0x529a = 1: the hero is always in). */
  private candidateList() {
    this.setupSlots();
    if (this.chosenIndex(0) === NONE) {
      const free = this.chosenIndex(NONE);
      if (free !== NONE) this.chosen[free] = 0;
    }
    this.list = [];
    const inSetup = (i: number) => this.h.units.slice(0, 0x2d).some((u) => u.officer === i); // 29b2
    for (const o of this.sameFaction()) {
      if (!(o.dyn.flags & 0x80)) continue;
      if (this.remaining !== 0 || inSetup(o.index)) this.list.push(o.index);
      this.heal(o);
      if (this.list.length === 0x42) break;
    }
    this.count = this.list.length;
    if (this.count - this.fixed < this.remaining) this.remaining = this.count - this.fixed;
    this.setPages(this.count);
    this.sort();
    this.drawScreen();
  }

  /** 27e4: the final list (the chosen officers only). */
  private finalList() {
    this.list = this.chosen.slice(0, this.total).filter((o) => o !== NONE);
    this.count = this.list.length;
    this.setPages(this.count);
    this.drawPages();
    this.drawPage();
  }

  // ---------------------------------------------------------------- entry

  async run(): Promise<FormationResult> {
    const files = this.a.entries(ICON_FILE);
    // 0cf5:c644: icons 0..0x12 = HEXZCHR entries 0, 2, .., 0x24; icon 0x13 = entry 0x26 + the hero's class
    for (let i = 0; i < 0x13; i++) this.icons[i] = decodeCells(files[i * 2] ?? new Uint8Array(0x200)).slice(0, 4);
    this.icons[0x13] = decodeCells(files[0x26 + this.officer(0).dyn.cls] ?? new Uint8Array(0x200)).slice(0, 4);
    const savedScreen = this.d.grab({ x: 0, y: 0, w: 640, h: 480 });
    this.regions();
    // 2ba8: the army, then the item exchange question with 종료 shown pressed
    this.overview = true;
    this.giver = NONE;
    this.shown = NONE;
    this.armyList();
    this.drawScreen();
    this.drawPage();
    this.press(0x100, 0x120, 0x30, 0x20);
    const exchange = await this.h.ui.captionBox(this.msg(14), 2);
    this.xorBox(0x100, 0x120, 0x30, 0x20);
    if (exchange) await this.loop(2);
    this.giver = NONE;
    this.overview = false;
    this.candidateList();
    this.drawPage();
    if (this.remaining === 0) await this.message(1, this.msg(0), 0);
    await this.message(0, this.remaining ? this.msg(1) : this.msg(0), this.remaining ? 1 : 0);
    await this.loop(0);
    this.finalList();
    await this.h.video.frame();
    this.d.restore(savedScreen);
    return { chosen: this.chosen.slice(0, this.total), fixed: this.fixed };
  }
}

// ---------------------------------------------------------------- printf subset

function latin(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

function pad(v: number, w: number): Uint8Array {
  return latin(String(v).padStart(w, ' '));
}

/** sprintf with the %s / %Nd / %Nu conversions the screen's format strings use. */
function fmt(f: Uint8Array, ...args: (number | Uint8Array)[]): Uint8Array {
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (c !== 0x25) {
      out.push(c);
      continue;
    }
    let j = i + 1;
    let w = 0;
    while (j < f.length && f[j] >= 0x30 && f[j] <= 0x39) w = w * 10 + f[j++] - 0x30;
    const conv = f[j];
    const a = args[k++];
    if (conv === 0x73) out.push(...(a instanceof Uint8Array ? a : []));
    else out.push(...pad(typeof a === 'number' ? a : 0, w));
    i = j;
  }
  return Uint8Array.from(out);
}
