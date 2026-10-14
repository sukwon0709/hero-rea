// Drawing primitives of MAIN.EXE's UI layer, on the shared Screen (640x480 indexed).
//
// Coordinates here are screen pixels. The original works in a 640x400 "layout" drawn 40 lines down
// (GRAPHICS.md), so a layout y from the disassembly is screen y - 40. Text columns are 8-pixel bytes.
//
//  * window frames: 0cf5:151a / 1446 (8x8 3-plane MARK tiles from the table DS:0x0b6e, 8 styles x 8
//    tiles: 0 TL, 1 TR, 2 BL, 3 BR, 4 top, 5 left, 6 bottom, 7 right);
//  * window backgrounds: 0cf5:53be (16x16 quadrant tiles at MARK 0x6f0 + pattern*0x200, 2x2 tiles
//    alternating by column and row; partial columns/rows drawn as half tiles, 0000:7E4A masks 5 / 3);
//  * buttons: 0cf5:1ac8 (MARK 0x1f90 background or the 48x20 확인/Yes/No pictures, bevel lines);
//  * text: formats/font.ts TextConsole (0cf5:0A2E / 0E24).

import { HEIGHT, WIDTH, type Screen } from '../engine/screen';
import { TextConsole, type TextState } from '../formats/font';
import type { IndexedImage } from '../formats/sprites';
import type { GameAssets } from './assets';

export const LAYOUT_Y = 40;

const enc = eucKrEncoder();

/** Minimal EUC-KR encoder for strings the port itself builds (numbers, ASCII, Hangul from game text). */
function eucKrEncoder() {
  // Built lazily from the decoder: map every KS X 1001 code to its character.
  let table: Map<string, number> | null = null;
  const build = () => {
    const m = new Map<string, number>();
    const dec = new TextDecoder('euc-kr');
    for (let hi = 0xa1; hi <= 0xfe; hi++)
      for (let lo = 0xa1; lo <= 0xfe; lo++) {
        const ch = dec.decode(Uint8Array.of(hi, lo));
        if (ch.length === 1 && ch !== '�' && !m.has(ch)) m.set(ch, (hi << 8) | lo);
      }
    return m;
  };
  return {
    encode(s: string): Uint8Array {
      const out: number[] = [];
      for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if (c < 0x80) out.push(c);
        else {
          table ??= build();
          const k = table.get(ch);
          if (k !== undefined) out.push(k >> 8, k & 0xff);
          else out.push(0x3f);
        }
      }
      return Uint8Array.from(out);
    },
  };
}

/** EUC-KR bytes of a string or message (game messages are passed through as they are). */
export function bytesOf(t: string | Uint8Array | { bytes: Uint8Array }): Uint8Array {
  if (typeof t === 'string') return enc.encode(t);
  return t instanceof Uint8Array ? t : t.bytes;
}

/** Display width in 8-pixel columns (0cf5:46b0 strlen; EUC-KR pairs count 2). */
export function textCols(b: Uint8Array): number {
  let n = 0;
  for (const v of b) if (v !== 0x0a && v !== 0x0d) n++;
  return n;
}

export class Draw {
  readonly view: IndexedImage;
  private frameTiles = new Map<number, IndexedImage>();
  private bgTiles = new Map<number, IndexedImage>();
  private markCache = new Map<string, IndexedImage>();

  constructor(
    readonly screen: Screen,
    readonly assets: GameAssets,
  ) {
    this.view = { width: WIDTH, height: HEIGHT, pixels: screen.pixels };
  }

  dirty() {
    this.screen.dirty = true;
  }

  // ------------------------------------------------------------------ images

  /** Copies an indexed image; with `transparent0` colour 0 is skipped; values > 15 are always skipped. */
  image(img: IndexedImage, x: number, y: number, transparent0 = false) {
    const px = this.screen.pixels;
    for (let sy = 0; sy < img.height; sy++) {
      const dy = y + sy;
      if (dy < 0 || dy >= HEIGHT) continue;
      for (let sx = 0; sx < img.width; sx++) {
        const dx = x + sx;
        if (dx < 0 || dx >= WIDTH) continue;
        const c = img.pixels[sy * img.width + sx];
        if (c > 15 || (transparent0 && c === 0)) continue;
        px[dy * WIDTH + dx] = c;
      }
    }
    this.dirty();
  }

  /** Mirrored copy (bit-reversed rows), as the sprite code does for the other facing. */
  imageMirrored(img: IndexedImage, x: number, y: number, transparent0 = true) {
    const px = this.screen.pixels;
    for (let sy = 0; sy < img.height; sy++) {
      const dy = y + sy;
      if (dy < 0 || dy >= HEIGHT) continue;
      for (let sx = 0; sx < img.width; sx++) {
        const dx = x + img.width - 1 - sx;
        if (dx < 0 || dx >= WIDTH) continue;
        const c = img.pixels[sy * img.width + sx];
        if (c > 15 || (transparent0 && c === 0)) continue;
        px[dy * WIDTH + dx] = c;
      }
    }
    this.dirty();
  }

  /** Copies a cell (16x16 colour indices) into a clip rectangle. */
  cell(cell: Uint8Array, x: number, y: number, clip: Rect, transparent0 = false) {
    const px = this.screen.pixels;
    for (let sy = 0; sy < 16; sy++) {
      const dy = y + sy;
      if (dy < clip.y || dy >= clip.y + clip.h) continue;
      for (let sx = 0; sx < 16; sx++) {
        const dx = x + sx;
        if (dx < clip.x || dx >= clip.x + clip.w) continue;
        const c = cell[sy * 16 + sx];
        if (transparent0 && c === 0) continue;
        px[dy * WIDTH + dx] = c;
      }
    }
    this.dirty();
  }

  fill(x: number, y: number, w: number, h: number, color: number) {
    this.screen.fillRect(x, y, w, h, color);
  }

  /** GRPDRV AH=0Ch line (horizontal / vertical only are used by the UI). */
  line(x1: number, y1: number, x2: number, y2: number, color: number) {
    if (y1 === y2) this.fill(Math.min(x1, x2), y1, Math.abs(x2 - x1) + 1, 1, color);
    else if (x1 === x2) this.fill(x1, Math.min(y1, y2), 1, Math.abs(y2 - y1) + 1, color);
    else {
      const n = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
      for (let i = 0; i <= n; i++) this.fill(Math.round(x1 + ((x2 - x1) * i) / n), Math.round(y1 + ((y2 - y1) * i) / n), 1, 1, color);
    }
  }

  grab(r: Rect): Saved {
    return { r: { ...r }, data: this.screen.grab(r.x, r.y, r.w, r.h) };
  }

  restore(s: Saved) {
    this.screen.blit(s.data, s.r.w, s.r.h, s.r.x, s.r.y);
  }

  mark(offset: number, w: number, h: number, planes = 4): IndexedImage {
    const k = `${offset}:${w}:${h}:${planes}`;
    let img = this.markCache.get(k);
    if (!img) {
      img = this.assets.markImage(offset, w, h, planes);
      this.markCache.set(k, img);
    }
    return img;
  }

  // ------------------------------------------------------------------ windows

  private frameTile(style: number, i: number): IndexedImage {
    const k = style * 8 + i;
    let t = this.frameTiles.get(k);
    if (!t) {
      t = this.assets.markImage(this.assets.dsWord(0x0b6e + 2 * k), 8, 8, 3);
      this.frameTiles.set(k, t);
    }
    return t;
  }

  private bgTile(pattern: number, i: number): IndexedImage {
    const k = pattern * 4 + i;
    let t = this.bgTiles.get(k);
    if (!t) {
      t = this.assets.markImage(0x6f0 + pattern * 0x200 + i * 0x80, 16, 16, 4);
      this.bgTiles.set(k, t);
    }
    return t;
  }

  /** 0cf5:53be: background tiles over (x, y, w, h). `phase` = 1 starts on the second tile pair. */
  background(x: number, y: number, w: number, h: number, pattern: number, phase = 0) {
    const half = (img: IndexedImage, dx: number, dy: number, cw: number, ch: number) => {
      for (let sy = 0; sy < ch; sy++)
        for (let sx = 0; sx < cw; sx++) {
          const px = dx + sx, py = dy + sy;
          if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) this.screen.pixels[py * WIDTH + px] = img.pixels[sy * 16 + sx];
        }
    };
    const fullW = w & ~15;
    const fullH = h & ~15;
    let row = phase;
    let yy = y;
    for (; yy < y + fullH; yy += 16, row ^= 1) {
      let col = phase;
      let xx = x;
      for (; xx < x + fullW; xx += 16, col ^= 1) half(this.bgTile(pattern, row * 2 + col), xx, yy, 16, 16);
      if (w & 15) half(this.bgTile(pattern, row * 2 + col), xx, yy, 8, 16);
    }
    if (h & 15) {
      let col = phase;
      for (let xx = x; xx < x + fullW; xx += 16, col ^= 1) half(this.bgTile(pattern, row * 2 + col), xx, yy, 16, 8);
    }
    this.dirty();
  }

  /** 0cf5:151a: framed window; the background covers the inside (x+8, y+8, w-16, h-16). */
  window(x: number, y: number, w: number, h: number, style: number, pattern: number, background = true) {
    if (background) this.background(x + 8, y + 8, w - 16, h - 16, pattern);
    const row = (yy: number, left: number, mid: number, right: number, fill: boolean) => {
      const end = x + w - 8;
      this.image(this.frameTile(style, left), x, yy);
      let xx = x;
      if (fill) for (xx = x + 8; xx < end; xx += 8) this.image(this.frameTile(style, mid), xx, yy);
      else xx = end;
      this.image(this.frameTile(style, right), xx, yy);
    };
    row(y, 0, 4, 1, true);
    let yy = y + 8;
    for (; yy < y + h - 8; yy += 8) row(yy, 5, -1, 7, false);
    row(yy, 2, 6, 3, true);
  }

  // ------------------------------------------------------------------ buttons

  /**
   * 0cf5:1ac8: a button at (x, y) of w x h (h is 16 in every caller). kind 0 = text on the MARK 0x1f90
   * background, 1 확인, 2 Yes, 3 No (48x20 pictures). The face starts at y - 2, 20 rows.
   */
  button(b: Button) {
    const { x, y, w, h } = b;
    if (b.kind === 0) {
      const tile = this.mark(0x1f90, 8, 20);
      for (let xx = 0; xx < w; xx += 8) {
        const cw = Math.min(8, w - xx);
        for (let sy = 0; sy < 20; sy++)
          for (let sx = 0; sx < cw; sx++) {
            const px = x + xx + sx, py = y - 2 + sy;
            if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) this.screen.pixels[py * WIDTH + px] = tile.pixels[sy * 8 + sx];
          }
      }
    } else {
      this.image(this.mark(0x19f0 + (b.kind - 1) * 480, 48, 20), x, y - 2);
    }
    if (b.label && b.label.length) {
      const col = (x >> 3) + (((w >> 3) - textCols(b.label)) >> 1);
      this.text(b.label, col, y, { fg: b.disabled ? 2 : 7 });
    }
    this.line(x - 2, y - 4, x + w + 2, y - 4, 0);
    this.line(x - 2, y - 3, x + w + 1, y - 3, 7);
    this.line(x - 2, y - 3, x - 2, y + h + 3, 7);
    this.line(x - 1, y - 2, x - 1, y + h + 2, 7);
    this.fill(x - 2, y + h + 2, w + 2, 2, 0);
    this.fill(x + w, y - 4, 2, h + 6, 0);
    this.dirty();
  }

  /** Pressed look while the mouse button is held (inverted bevel; the original's 1d2e is not traced). */
  buttonPressed(b: Button) {
    const { x, y, w, h } = b;
    this.line(x - 2, y - 3, x + w + 1, y - 3, 0);
    this.line(x - 2, y - 3, x - 2, y + h + 3, 0);
    this.line(x - 1, y - 2, x - 1, y + h + 2, 0);
    this.dirty();
  }

  // ------------------------------------------------------------------ text

  /**
   * Prints EUC-KR bytes at column `col`, screen row `y` with mode 4 (transparent) like the dialogue
   * object DS:6390. Returns the console (its cursor shows where the text ended).
   */
  text(bytes: Uint8Array, col: number, y: number, opts: Partial<TextState> = {}): TextConsole {
    const con = new TextConsole(this.assets.font, this.view, { mode: 4, fg: 7, bg: 0, bottom: HEIGHT - 16, ...opts, x: col, y, margin: opts.margin ?? col });
    con.write(bytes);
    this.dirty();
    return con;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Saved {
  r: Rect;
  data: Uint8Array;
}

export interface Button {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: number;
  label?: Uint8Array;
  disabled?: boolean;
}

/** Hit area of a button (its visible face plus bevel). */
export function buttonRect(b: Button): Rect {
  return { x: b.x - 2, y: b.y - 4, w: b.w + 4, h: b.h + 8 };
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
