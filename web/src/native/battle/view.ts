// Battle screen: frame, scrolling map view, unit sprites, cursor, range shading, side panel and
// minimap. Positions are screen pixels (the original's 640x400 layout + 40, GRAPHICS.md).
//
//  * frame: PACKGRP.R3 picture 1 at y 40 (1cb6:3ab6 -> 0cf5:520e);
//  * map view: 13 x 11 cells of 32 px at (16, 72) (view object DS:0xe1bc, 2cb6:53fe(0x160, 0x1a0,
//    0x20, 0x10)); chips from HEXZCHP entry 0 (chip < 80) and entry secondChipSet(map) (chip >= 80);
//  * units: HEXZCHR entry chosen by 2cb6:8264, 2 frames of 2x2 cells, flag 0x10 mirrors (8d74);
//  * out-of-range shading and the hover box darken every pixel with (x+y) even to colour 0
//    (measured on the emulator; the drawing routine itself is not traced);
//  * side panel: 2cb6:5e0e (unit list) and 9b4c (unit details); bars 2cb6:52a6 with the 8x10
//    patterns at MARK.R3 0x2208 / 0x21e0 / 0x2230 (value tenths < 3 / < 7 / >= 7);
//  * minimap: 2x2 px per chip at x = ((0x28-W)*2/8 + 0x39)*8, y = ((0x18-H)*2/8 + 0x23)*8 + 40,
//    unit dots 4x4 colour 2 (player side) / 1 (enemy) (2cb6:632a). The chip colour tables
//    (DS:0x53cc..0x55cc) are not used yet: each chip takes its most frequent colour (approximation).

import type { GameContext } from '../context';
import { HEIGHT, WIDTH } from '../../engine/screen';
import { TextConsole, type TextState } from '../../formats/font';
import { decodeCells, decodeInterleaved, decodeMarkImage, MARK_REGIONS, type IndexedImage } from '../../formats/sprites';
import { decodeTfdce } from '../../formats/tfdce';
import { parseBlobIndex, PACKGRP_COUNT } from '../../formats/tables';
import { secondChipSet } from '../../engine/battle/map';
import { attackPower, defencePower, maxHp, maxMp } from '../../engine/battle/rules';
import { NONE, PLAYER_SLOTS, Status, UNIT_SLOTS, Unit, UnitFlag } from '../../engine/battle/types';
import type { Battle } from './model';
import { factionOf } from './model';
import { dsBytes, dsTable, euc, fmt, S } from './strings';

export const VIEW_X = 16;
export const VIEW_Y = 72;
export const VIEW_W = 13;
export const VIEW_H = 11;
export const CELL = 32;

const PANEL_TEXT: Partial<TextState> = { fg: 7, mode: 4, outline: true, outlineColor: 0 };

export interface Overlay {
  /** Cells shown in colour (others shaded), or null for no shading. */
  lit: Uint8Array | null;
  /** Cells drawn with a target marker (attack/tactic range picks). */
  marks?: Uint8Array | null;
}

export class BattleView {
  vx = 0;
  vy = 0;
  tick = 0;
  hover = NONE;
  /** Unit shown in the side panel, NONE = unit list. */
  panelUnit = NONE;
  panelTab = 0;
  cursor: [number, number] | null = null;
  overlay: Overlay = { lit: null };
  /** Units hidden during an animation step (drawn by the caller instead). */
  hidden = new Set<number>();
  /** Extra sprite positions in pixels relative to the cell, for walking. */
  offset = new Map<number, [number, number]>();
  blink = NONE;
  menuPressed = false;
  private frame: IndexedImage | null = null;
  private chips0: Uint8Array[] = [];
  private chips1: Uint8Array[] = [];
  private chipColour: number[] = [];
  private chr: Uint8Array[];
  private sprites = new Map<string, Uint8Array[]>();
  private hexgrp: Uint8Array;
  private mark: Uint8Array | null = null;
  private icons: IndexedImage[] = [];
  private patterns: IndexedImage[] = [];
  private title: Uint8Array;

  constructor(
    readonly ctx: GameContext,
    readonly b: Battle,
  ) {
    const a = ctx.assets;
    const chp = a.entries('HEXZCHP.R3');
    this.chips0 = decodeCells(chp[0]);
    this.chips1 = decodeCells(chp[secondChipSet(b.info.map)] ?? new Uint8Array(0));
    this.chr = a.entries('HEXZCHR.R3');
    this.hexgrp = a.entries('HEXGRP.R3')[0];
    try {
      const blobs = parseBlobIndex(a.file('PACKGRP.R3'), PACKGRP_COUNT);
      this.frame = decodeTfdce(blobs[1]);
    } catch {
      this.frame = null;
    }
    try {
      this.mark = a.entries('MARK.R3')[0];
      this.icons = [0, 1, 2].map((i) => decodeMarkImage(this.mark!, MARK_REGIONS[0], i));
      this.patterns = [0x2208, 0x21e0, 0x2230].map((o) => decodeInterleaved(this.mark!, o, 8, 10, 4));
    } catch {
      this.mark = null;
    }
    for (const c of [...this.chips0, ...this.chips1]) {
      const n = new Array<number>(16).fill(0);
      for (const p of c) n[p & 15]++;
      this.chipColour.push(n.indexOf(Math.max(...n)));
    }
    this.title = new Uint8Array(0);
  }

  get titleBytes(): Uint8Array {
    return this.title;
  }

  setTitle(bytes: Uint8Array) {
    this.title = bytes;
  }

  get screen() {
    return this.ctx.screen;
  }

  private chip(c: number): Uint8Array | undefined {
    return c < 80 ? this.chips0[c] : this.chips1[c - 80];
  }

  /** HEXZCHR entry for a unit (2cb6:8264). */
  spriteEntry(u: Unit): number {
    const cls = this.b.officerOf(u).cls;
    const enemy = u.slot >= PLAYER_SLOTS;
    if (u.flags & UnitFlag.Confused) return 0x2b + (enemy ? 1 : 0);
    if (u.officer === 0) return 0x26 + cls;
    if (u.officer === 4) return 0x2d;
    if (u.officer === 8) return 0x2e;
    return cls * 2 + (enemy ? 1 : 0);
  }

  private spriteCells(entry: number, mirror: boolean): Uint8Array[] {
    const key = `${entry}:${mirror ? 1 : 0}`;
    let c = this.sprites.get(key);
    if (!c) {
      c = decodeCells(this.chr[entry] ?? new Uint8Array(1024), mirror);
      this.sprites.set(key, c);
    }
    return c;
  }

  // ---- geometry

  cellAt(px: number, py: number): [number, number] | null {
    if (px < VIEW_X || py < VIEW_Y || px >= VIEW_X + VIEW_W * CELL || py >= VIEW_Y + VIEW_H * CELL) return null;
    const x = this.vx + Math.floor((px - VIEW_X) / CELL);
    const y = this.vy + Math.floor((py - VIEW_Y) / CELL);
    return x < this.b.width && y < this.b.height ? [x, y] : null;
  }

  cellPos(x: number, y: number): [number, number] {
    return [VIEW_X + (x - this.vx) * CELL, VIEW_Y + (y - this.vy) * CELL];
  }

  visible(x: number, y: number): boolean {
    return x >= this.vx && y >= this.vy && x < this.vx + VIEW_W && y < this.vy + VIEW_H;
  }

  clampView() {
    this.vx = Math.max(0, Math.min(this.vx, this.b.width - VIEW_W));
    this.vy = Math.max(0, Math.min(this.vy, this.b.height - VIEW_H));
  }

  /** 2cb6:5d1c: centre the view on a cell. */
  centre(x: number, y: number) {
    this.vx = x - (VIEW_W >> 1);
    this.vy = y - (VIEW_H >> 1);
    this.clampView();
  }

  /** 2cb6:6418: scroll only when the cell is outside the view (or within one cell of its edge). */
  ensureVisible(x: number, y: number) {
    if (x <= this.vx || x >= this.vx + VIEW_W - 1 || y <= this.vy || y >= this.vy + VIEW_H - 1) this.centre(x, y);
  }

  // ---- drawing

  text(bytes: Uint8Array, col: number, y: number, st: Partial<TextState> = PANEL_TEXT) {
    const dst = { width: WIDTH, height: HEIGHT, pixels: this.screen.pixels };
    new TextConsole(this.ctx.assets.font, dst, { ...st, x: col, y, right: 79, bottom: HEIGHT - 1 }).write(bytes);
  }

  private blitImg(img: IndexedImage, x: number, y: number, transparent = -1) {
    this.screen.blit(img.pixels, img.width, img.height, x, y, transparent);
  }

  /** Darkens a rectangle with the checker pattern. */
  shade(x0: number, y0: number, w: number, h: number) {
    const px = this.screen.pixels;
    for (let y = Math.max(0, y0); y < Math.min(HEIGHT, y0 + h); y++)
      for (let x = Math.max(0, x0 + ((x0 + y) & 1)); x < Math.min(WIDTH, x0 + w); x += 2) px[y * WIDTH + x] = 0;
  }

  private hexgrpImage(off: number, w: number, h: number): IndexedImage {
    return decodeInterleaved(this.hexgrp, off, w, h, 4);
  }

  drawFrame() {
    const s = this.screen;
    s.fillRect(0, 0, WIDTH, HEIGHT, 0);
    if (this.frame) this.blitImg(this.frame, 0, 40);
    if (this.menuPressed) this.blitImg(this.hexgrpImage(0x800, 64, 16), 16, 48);
    // battle name centred in the title box (1cb6:4d4e, "%s" 0x4f5a)
    const cols = this.title.length;
    if (cols) this.text(this.title, 39 - (cols >> 1), 48, { fg: 7, mode: 4 });
    // weather icon (4b52: HEXGRP 0 + type*0x200 at 0x250, 0x20)
    this.blitImg(this.hexgrpImage(this.b.weatherType() * 0x200, 32, 32), 592, 72);
  }

  drawMap() {
    const { b } = this;
    const W = b.width * 2;
    for (let cy = 0; cy < VIEW_H * 2; cy++) {
      for (let cx = 0; cx < VIEW_W * 2; cx++) {
        const mx = this.vx * 2 + cx;
        const my = this.vy * 2 + cy;
        const sx = VIEW_X + cx * 16;
        const sy = VIEW_Y + cy * 16;
        const chip = mx < W && my < b.height * 2 ? this.chip(b.map.chips[my * W + mx]) : undefined;
        if (chip) this.screen.blit(chip, 16, 16, sx, sy);
        else this.screen.fillRect(sx, sy, 16, 16, 0);
      }
    }
    const lit = this.overlay.lit;
    if (lit)
      for (let y = 0; y < VIEW_H; y++)
        for (let x = 0; x < VIEW_W; x++) {
          const mx = this.vx + x;
          const my = this.vy + y;
          if (mx < b.width && my < b.height && lit[my * b.width + mx]) continue;
          this.shade(VIEW_X + x * CELL, VIEW_Y + y * CELL, CELL, CELL);
        }
  }

  drawUnit(u: Unit, px: number, py: number, frame: number) {
    const mirror = (u.flags & UnitFlag.Facing) !== 0;
    const cells = this.spriteCells(this.spriteEntry(u), mirror);
    const f = frame & 1;
    const order = mirror ? [1, 0, 3, 2] : [0, 1, 2, 3];
    for (let k = 0; k < 4; k++) {
      const c = cells[4 * f + order[k]];
      if (c) this.screen.blit(c, 16, 16, px + (k & 1) * 16, py + (k >> 1) * 16, 0);
    }
  }

  drawUnits() {
    const frame = (this.tick >> 5) & 1;
    for (const u of this.b.units) {
      if (u.status !== Status.Field || this.hidden.has(u.slot)) continue;
      if (!(u.flags & UnitFlag.Visible) && u.slot >= PLAYER_SLOTS) continue;
      if (this.blink === u.slot && ((this.tick >> 2) & 1)) continue;
      const off = this.offset.get(u.slot) ?? [0, 0];
      if (!this.visible(u.x, u.y) && !this.offset.has(u.slot)) continue;
      const [px, py] = this.cellPos(u.x, u.y);
      this.clipUnit(u, px + off[0], py + off[1], u.flags & UnitFlag.Acted ? 0 : frame);
    }
  }

  /** Draws a unit sprite clipped to the map view. */
  clipUnit(u: Unit, px: number, py: number, frame: number) {
    if (px <= VIEW_X - CELL || py <= VIEW_Y - CELL || px >= VIEW_X + VIEW_W * CELL || py >= VIEW_Y + VIEW_H * CELL) return;
    if (px >= VIEW_X && py >= VIEW_Y && px + CELL <= VIEW_X + VIEW_W * CELL && py + CELL <= VIEW_Y + VIEW_H * CELL) {
      this.drawUnit(u, px, py, frame);
      return;
    }
    // partially outside: draw into a scratch buffer and copy the visible part
    const under = this.screen.grab(px, py, CELL, CELL);
    this.drawUnit(u, px, py, frame);
    const over = this.screen.grab(px, py, CELL, CELL);
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) {
        const sx = px + x;
        const sy = py + y;
        const inside = sx >= VIEW_X && sy >= VIEW_Y && sx < VIEW_X + VIEW_W * CELL && sy < VIEW_Y + VIEW_H * CELL;
        if (!inside) over[y * CELL + x] = under[y * CELL + x];
      }
    this.screen.blit(over, CELL, CELL, px, py);
  }

  drawMarks() {
    const m = this.overlay.marks;
    if (!m) return;
    for (let y = 0; y < VIEW_H; y++)
      for (let x = 0; x < VIEW_W; x++) {
        const mx = this.vx + x;
        const my = this.vy + y;
        if (mx >= this.b.width || my >= this.b.height || !m[my * this.b.width + mx]) continue;
        const px = VIEW_X + x * CELL;
        const py = VIEW_Y + y * CELL;
        this.rect(px + 2, py + 2, CELL - 4, CELL - 4, 2);
      }
  }

  rect(x: number, y: number, w: number, h: number, c: number) {
    const s = this.screen;
    s.fillRect(x, y, w, 1, c);
    s.fillRect(x, y + h - 1, w, 1, c);
    s.fillRect(x, y, 1, h, c);
    s.fillRect(x + w - 1, y, 1, h, c);
  }

  drawCursor() {
    if (!this.cursor || !this.visible(this.cursor[0], this.cursor[1])) return;
    const [px, py] = this.cellPos(this.cursor[0], this.cursor[1]);
    this.rect(px, py, CELL, CELL, 0);
    this.rect(px + 1, py + 1, CELL - 2, CELL - 2, 7);
    this.rect(px + 2, py + 2, CELL - 4, CELL - 4, 0);
  }

  /** The hover box of 2cb6:878a: name + level, class, troops, next to the unit. */
  drawHoverBox() {
    const slot = this.hover;
    if (slot === NONE) return;
    const u = this.b.units[slot];
    if (u.status !== Status.Field || !this.visible(u.x, u.y)) return;
    if (!(u.flags & UnitFlag.Visible) && slot >= PLAYER_SLOTS) return;
    const o = this.b.officerOf(u);
    const [px, py] = this.cellPos(u.x, u.y);
    let bx = px - 96;
    if (bx < VIEW_X) bx = px + CELL;
    let by = py - 32;
    if (by < VIEW_Y) by = VIEW_Y;
    if (by + 64 > VIEW_Y + VIEW_H * CELL) by = VIEW_Y + VIEW_H * CELL - 64;
    this.shade(bx, by, 96, 64);
    const col = (bx >> 3) + 1;
    const name = this.officerName(u);
    this.text(name, col, by + 4);
    this.text(fmt(dsBytes(this.ctx.assets.main, S.lv), o.level), col + Math.max(name.length + 1, 6), by + 4);
    this.text(dsTable(this.ctx.assets.main, S.classNames, o.cls), col, by + 22);
    this.text(fmt(dsBytes(this.ctx.assets.main, S.hpFrac), o.hp, maxHp(o)), col, by + 40);
  }

  officerName(u: Unit): Uint8Array {
    const so = this.b.stateOfficer(u);
    return encodeName(so.name);
  }

  /** 8fbc: faction shown for a unit. */
  factionFor(slot: number): number {
    const u = this.b.units[slot];
    if (slot >= PLAYER_SLOTS || this.b.slotOfOfficer(0) !== NONE) {
      let f = factionOf(this.b.state.officers[u.officer] ?? this.b.state.officers[0]);
      if (f === 14) {
        const lead = this.b.units[slot >= PLAYER_SLOTS ? PLAYER_SLOTS : 0];
        if (lead.officer !== 0xffff) f = factionOf(this.b.state.officers[lead.officer]);
      }
      return f;
    }
    return 0;
  }

  private header(faction: number) {
    const main = this.ctx.assets.main;
    for (let i = 0; i < 4; i++) this.blitImg(this.hexgrpImage(0x1200, 16, 16), 456 + i * 16, 80);
    const name = new Uint8Array([...dsTable(main, 0xf1e, faction), ...dsBytes(main, S.army)]);
    this.text(name, ((10 - name.length) >> 1) + 0x38, 80);
  }

  /** 2cb6:52a6 */
  bar(kind: 0 | 1, value: number, max: number, x: number, y: number, w = 96) {
    const fill = max === 0 ? 0 : Math.min(w, Math.floor((value * w) / max));
    const tenths = max === 0 ? 0 : Math.floor((value * 10) / max);
    const pat = this.patterns[tenths < 3 ? 0 : tenths < 7 ? 1 : 2];
    this.screen.fillRect(x, y - 1, w, 10, 0);
    if (pat)
      for (let yy = 0; yy < 10; yy++)
        for (let xx = 0; xx < fill; xx++) this.screen.pixels[(y - 1 + yy) * WIDTH + x + xx] = pat.pixels[yy * 8 + (xx & 7)];
    const main = this.ctx.assets.main;
    const col = (x >> 3) + (w >> 4) - 2 * (kind + 1);
    const f = kind === 1 ? fmt(dsBytes(main, 0x3e9f), value, max) : fmt(dsBytes(main, 0x3ea7), value);
    this.text(f, col, y - 4);
  }

  private panelBackground() {
    // the frame's panel area (layout 448..624 x 72..270): restore it from the frame picture
    if (this.frame) {
      const f = this.frame;
      for (let y = 72; y < 272; y++) {
        const sy = y - 40;
        this.screen.pixels.set(f.pixels.subarray(sy * f.width + 448, sy * f.width + 624), y * WIDTH + 448);
      }
    }
  }

  /** 2cb6:9b4c: details of one unit. */
  drawUnitPanel(slot: number) {
    const main = this.ctx.assets.main;
    const u = this.b.units[slot];
    const o = this.b.officerOf(u);
    this.header(this.factionFor(slot));
    this.text(this.officerName(u), 0x39, 0x4c + 40);
    this.text(dsTable(main, S.classNames, o.cls), 0x40, 0x4c + 40);
    this.text(fmt(dsBytes(main, 0x4249), o.level), 0x49, 0x4c + 40);
    const vals = [o.force, o.intel, o.lead];
    for (let i = 0; i < 3; i++) {
      this.text(fmt(dsBytes(main, 0x424f), vals[i]), 0x3c + 7 * i, 0x68 + 40);
      if (this.icons[i]) this.blitImg(this.icons[i], 0x1c8 + i * 0x38, 0x64 + 40);
    }
    const labels = [S.troops, S.morale, S.attack, S.defence, S.mp];
    labels.forEach((l, i) => this.text(dsBytes(main, l), 0x39, 0x84 + 40 + i * 24));
    const y0 = 0x84 + 40 + 4;
    this.bar(1, o.hp, maxHp(o), 520, y0);
    this.bar(0, u.morale, 100, 520, y0 + 24);
    this.bar(0, attackPower(o, u.morale, this.b.s.items), 2000, 520, y0 + 48);
    this.bar(0, defencePower(o, u.morale, this.b.s.items), 2000, 520, y0 + 72);
    this.bar(1, u.mp, maxMp(o) & 0xff, 520, y0 + 96);
    if (slot < PLAYER_SLOTS) {
      this.text(dsBytes(main, S.exp), 0x39, 0x84 + 40 + 5 * 24);
      this.bar(0, o.exp, 100, 520, y0 + 120);
    }
  }

  /** 2cb6:5e0e: list of the units of a tab. */
  drawListPanel(tab: number) {
    const main = this.ctx.assets.main;
    this.header(this.factionFor(tab === 0 ? 0 : PLAYER_SLOTS));
    const lo = tab === 0 ? 0 : PLAYER_SLOTS;
    const hi = tab === 0 ? PLAYER_SLOTS : UNIT_SLOTS;
    const rows: number[] = [];
    const units = this.b.units;
    if (tab === 0) for (let i = lo; i < hi; i++) if (units[i].status === Status.Field && this.factionFor(i) === 0) rows.push(i);
    for (let i = lo; i < hi; i++) if (units[i].status === Status.Field && this.factionFor(i) !== 0 && !rows.includes(i)) rows.push(i);
    for (let i = lo; i < hi; i++) if (units[i].status > Status.Field) rows.push(i);
    rows.slice(0, 10).forEach((slot, r) => {
      const u = units[slot];
      const y = r * 0x14 + 0x4a + 40;
      this.text(this.officerName(u), 0x39, y);
      if (u.status === Status.Field) {
        const o = this.b.officerOf(u);
        this.bar(1, o.hp, maxHp(o), 520, y + 4);
      } else this.text(dsBytes(main, S.offField), 0x41, y);
    });
  }

  drawPanel() {
    this.panelBackground();
    if (this.panelUnit !== NONE && this.b.units[this.panelUnit].status === Status.Field) this.drawUnitPanel(this.panelUnit);
    else this.drawListPanel(this.panelTab);
  }

  drawMinimap() {
    const { b } = this;
    const ox = (Math.trunc(((0x28 - b.width) * 2) / 8) + 0x39) * 8;
    const oy = (Math.trunc(((0x18 - b.height) * 2) / 8) + 0x23) * 8 + 40;
    const W = b.width * 2;
    for (let my = 0; my < b.height * 2; my++)
      for (let mx = 0; mx < W; mx++) {
        const c = b.map.chips[my * W + mx];
        const col = this.chipColour[c] ?? 0;
        this.screen.fillRect(ox + mx * 2, oy + my * 2, 2, 2, col);
      }
    for (const u of b.units) {
      if (u.status !== Status.Field) continue;
      if (!(u.flags & UnitFlag.Visible) && u.slot >= PLAYER_SLOTS) continue;
      this.screen.fillRect(ox + u.x * 4, oy + u.y * 4, 4, 4, u.slot < PLAYER_SLOTS ? 2 : 1);
    }
    this.rect(ox + this.vx * 4, oy + this.vy * 4, VIEW_W * 4, VIEW_H * 4, 7);
  }

  /** Minimap cell under a screen point, for click-to-scroll. */
  minimapCell(px: number, py: number): [number, number] | null {
    const { b } = this;
    const ox = (Math.trunc(((0x28 - b.width) * 2) / 8) + 0x39) * 8;
    const oy = (Math.trunc(((0x18 - b.height) * 2) / 8) + 0x23) * 8 + 40;
    const x = Math.floor((px - ox) / 4);
    const y = Math.floor((py - oy) / 4);
    return x >= 0 && y >= 0 && x < b.width && y < b.height ? [x, y] : null;
  }

  render() {
    this.drawFrame();
    this.drawMap();
    this.drawMarks();
    this.drawUnits();
    this.drawCursor();
    this.drawHoverBox();
    this.drawPanel();
    this.drawMinimap();
    this.screen.dirty = true;
  }

  async frameStep() {
    this.tick++;
    this.render();
    await this.ctx.ui.frame();
  }
}

/** Officer names are stored decoded in GameState; turn them back into EUC-KR for the font. */
const nameCache = new Map<string, Uint8Array>();
export function encodeName(s: string): Uint8Array {
  let b = nameCache.get(s);
  if (!b) {
    b = euc(s);
    nameCache.set(s, b);
  }
  return b;
}

