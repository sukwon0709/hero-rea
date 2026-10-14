// Fonts and text drawing (see docs/GRAPHICS.md, "Text").
//
// MAIN.EXE draws text itself, byte-aligned into VGA memory: Hangul / symbols (KS X 1001 in EUC-KR) come
// from ALL_FONT.16P (16x14), ASCII from HANKAKU.FNT (8x16). A text object (DS:6390 for dialogue) holds
// the cursor, colours and drawing mode; `TextConsole` mirrors it and its character handler 0cf5:0A2E.

import type { IndexedImage } from './sprites';

/** ALL_FONT.16P record: u16 code + 14 rows x 2 bytes. */
export const ALL_FONT_RECORD = 30;
export const HANGUL_ROWS = 14;

/** 0cf5:0D16: record index of a two-byte code (rows A1-AF, then B0-C8 packed after them). */
export function ksIndex(code: number): number {
  const hi = code >> 8;
  const lo = code & 0xff;
  return (hi - (hi >= 0xb0 ? 0xa4 : 0xa1)) * 94 + lo - 0xa1;
}

export interface Glyph {
  /** Width in bytes (1 = 8 px, 2 = 16 px). */
  wbytes: number;
  /** Rows drawn (16 for 1-byte glyphs, 14 for 2-byte glyphs). */
  rows: number;
  /** 16 rows x wbytes, MSB = leftmost pixel; rows past `rows` are 0. */
  bits: Uint8Array;
}

export class GameFont {
  /** Either file may be missing; the game then draws solid blocks (0xFF fill, 0cf5:0D74 / 0DDA). */
  constructor(
    readonly allFont: Uint8Array | null,
    readonly hankaku: Uint8Array | null,
  ) {}

  /** 0cf5:0D44: the glyph for a character code (two-byte codes are lead << 8 | trail). */
  glyph(code: number): Glyph {
    if (code >= 0x200) {
      const bits = new Uint8Array(32);
      if (code >= 0xa1a1 && code <= 0xfdfe) {
        const idx = ksIndex(code);
        const off = ALL_FONT_RECORD * idx + 2;
        if (!this.allFont) bits.fill(0xff);
        else if (off + 28 > this.allFont.length) bits.fill(0x0f, 0, 28); // short read -> 0x0F0F fill
        else bits.set(this.allFont.subarray(off, off + 28));
      }
      // codes >= 0x200 outside A1A1..FDFE are not fetched by the game at all (stale buffer); blank here
      return { wbytes: 2, rows: HANGUL_ROWS, bits };
    }
    const idx = code >= 0x20 && code <= 0x7f ? code - 0x20 : 0;
    const bits = new Uint8Array(16);
    if (!this.hankaku) bits.fill(0xff);
    else if (idx * 16 + 16 > this.hankaku.length) bits.fill(0x0f);
    else bits.set(this.hankaku.subarray(idx * 16, idx * 16 + 16));
    return { wbytes: 1, rows: 16, bits };
  }
}

/**
 * 0000:84A4: 3x3 dilation of a 16-row glyph bitmap (horizontal pass, then vertical), used for outlines.
 * Pixels outside the 8/16 x 16 box are lost.
 */
export function dilate(bits: Uint8Array, wbytes: number): Uint8Array {
  const out = new Uint8Array(16 * wbytes);
  const w = wbytes * 8;
  const row = (y: number) => {
    let v = 0;
    for (let b = 0; b < wbytes; b++) v = (v << 8) | bits[y * wbytes + b];
    return v;
  };
  const mask = (1 << w) - 1;
  const h = Array.from({ length: 16 }, (_, y) => {
    const v = row(y);
    return (v | (v << 1) | (v >>> 1)) & mask;
  });
  for (let y = 0; y < 16; y++) {
    const v = h[y] | (y > 0 ? h[y - 1] : 0) | (y < 15 ? h[y + 1] : 0);
    for (let b = 0; b < wbytes; b++) out[y * wbytes + b] = (v >>> (8 * (wbytes - 1 - b))) & 0xff;
  }
  return out;
}

/**
 * Draw modes of the 1-bit blitter 0000:628E -> 0000:61AF (AH of the colour word):
 * 0 opaque (set bits = colour, clear bits = 0, whole bytes), 1 XOR, 2 AND, 3 OR, 4 transparent.
 * Bit 7 (word bit 15) draws every row twice.
 */
export type DrawMode = number;

/** 0000:61AF / 0000:60F2: draws a 1-bit bitmap (wbytes x rows) at byte column xb, row y. */
export function blit1(dst: IndexedImage, xb: number, y: number, bits: Uint8Array, wbytes: number, rows: number, color: number, mode: DrawMode): void {
  const doubled = (mode & 0x80) !== 0;
  const m = mode & 0x7f;
  let dy = y;
  for (let r = 0; r < rows; r++) {
    for (let rep = 0; rep < (doubled ? 2 : 1); rep++, dy++) {
      if (dy < 0 || dy >= dst.height) continue;
      for (let b = 0; b < wbytes; b++) {
        const v = bits[r * wbytes + b];
        for (let i = 0; i < 8; i++) {
          const x = (xb + b) * 8 + i;
          if (x < 0 || x >= dst.width) continue;
          const set = (v & (0x80 >> i)) !== 0;
          const p = dy * dst.width + x;
          const old = dst.pixels[p];
          switch (m) {
            case 0:
              dst.pixels[p] = set ? color : 0;
              break;
            case 1:
              if (set) dst.pixels[p] = old ^ color;
              break;
            case 2:
              if (!set) dst.pixels[p] = old & ~color & 0xf;
              break;
            case 3:
              if (set) dst.pixels[p] = old | color;
              break;
            case 4:
              if (set) dst.pixels[p] = color;
              break;
            default:
              break; // modes > 4 leave the blitter state unchanged in the original (0000:614C)
          }
        }
      }
    }
  }
}

/** 0000:6976: opaque two-colour blit, pixel = bit ? fg : bg. */
export function blit2(dst: IndexedImage, xb: number, y: number, bits: Uint8Array, wbytes: number, rows: number, fg: number, bg: number): void {
  for (let r = 0; r < rows; r++) {
    const dy = y + r;
    if (dy < 0 || dy >= dst.height) continue;
    for (let b = 0; b < wbytes; b++) {
      const v = bits[r * wbytes + b];
      for (let i = 0; i < 8; i++) {
        const x = (xb + b) * 8 + i;
        if (x >= 0 && x < dst.width) dst.pixels[dy * dst.width + x] = v & (0x80 >> i) ? fg : bg;
      }
    }
  }
}

/** The text object fields MAIN uses (offsets into the object, defaults from 0cf5:0873). */
export interface TextState {
  /** +1E draw mode; bit 6 doubles the advance, bit 5 = vertical writing. */
  mode: number;
  /** +1F foreground colour. */
  fg: number;
  /** +20 background colour; non-zero selects the opaque two-colour blit. */
  bg: number;
  /** +21 cursor column in bytes (8 px). */
  x: number;
  /** +23 cursor row in pixels. */
  y: number;
  /** +25 / +27 left and right column limits (bytes); default 0..79. */
  left: number;
  right: number;
  /** +29 / +2B top and bottom (pixels); default 0..399. */
  top: number;
  bottom: number;
  /** +2D column a CR / newline returns to. */
  margin: number;
  /** +2F outline colour. */
  outlineColor: number;
  /** +31 line pitch in pixels (default 18). */
  lineHeight: number;
  /** +37 non-zero: advance without drawing. */
  hidden: boolean;
  /** +39 non-zero: draw an outline first. */
  outline: boolean;
  /** Not a MAIN field: END.EXE's emboldened text (see embolden()). */
  bold: boolean;
}

export function defaultTextState(): TextState {
  return {
    mode: 0,
    fg: 0,
    bg: 0,
    x: 0,
    y: 0,
    left: 0,
    right: 0x4f,
    top: 0,
    bottom: 0x18f,
    margin: 0,
    outlineColor: 0,
    lineHeight: 0x12,
    hidden: false,
    outline: false,
    bold: false,
  };
}

const hexDigit = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : (c >= 0x61 && c <= 0x7a ? c - 0x20 : c) - 0x37);

/**
 * Port of MAIN's text output: 0cf5:0A2E (control codes, EUC-KR pairing, wrapping, advance) and
 * 0cf5:0E24 (outline + glyph). Control codes: 0x0A newline, 0x0D carriage return, ESC sequences
 * ESC '=' row col (8-px rows, columns from `left`, both +0x20), ESC 'C' fg, ESC 'B' bg, ESC 'F' outline
 * colour (hex digits), ESC 'G' outline on/off, ESC 'M' mode, ESC 'R' margin (+0x20), ESC 'W' wait.
 */
export class TextConsole {
  readonly s: TextState;
  private lead = 0;
  private esc = 0;
  /** DS:64DE: set by CR/newline/wrap; a following space is swallowed. */
  private skipSpace = false;

  constructor(
    readonly font: GameFont,
    readonly dst: IndexedImage,
    state: Partial<TextState> = {},
  ) {
    this.s = { ...defaultTextState(), ...state };
  }

  newline(): void {
    const s = this.s;
    s.x = s.margin;
    if (s.y + s.lineHeight <= s.bottom) s.y += s.lineHeight;
    this.skipSpace = true;
  }

  /** 0cf5:0E24: draws one character at the cursor without moving it. */
  drawChar(code: number): void {
    const s = this.s;
    if (s.hidden) return;
    const g = this.font.glyph(code);
    if (s.bold) g.bits = embolden(g.bits, g.wbytes);
    if (s.outline) blit1(this.dst, s.x, s.y, dilate(g.bits, g.wbytes), g.wbytes, g.rows, s.outlineColor, 4);
    if (s.bg === 0) blit1(this.dst, s.x, s.y, g.bits, g.wbytes, g.rows, s.fg, s.mode);
    else blit2(this.dst, s.x, s.y, g.bits, g.wbytes, g.rows, s.fg, s.bg);
  }

  /** 0cf5:0A2E with its second argument 0. */
  putByte(c: number): void {
    const s = this.s;
    switch (this.esc) {
      case 1:
        this.esc = { 0x3d: 2, 0x42: 8, 0x43: 4, 0x46: 9, 0x47: 10, 0x4d: 6, 0x52: 5 }[c] ?? 0;
        return; // 'W' (0cf5:25A6, wait for input) and unknown commands end the sequence
      case 2:
        s.y = Math.min((s.top + (c - 0x20) * 8) & 0xffff, s.bottom); // 0cf5:0900, unsigned min 0cf5:4654
        this.esc = 3;
        return;
      case 3:
        s.x = this.wrapColumn(c - 0x20);
        this.esc = 0;
        return;
      case 4:
        if ((hexDigit(c) & 0xffff) <= 15) s.fg = hexDigit(c); // 0cf5:0994 ignores values > 15
        this.esc = 0;
        return;
      case 5:
        s.margin = this.wrapColumn(c - 0x20);
        this.esc = 0;
        return;
      case 6:
        s.mode = (c - 0x30) & 0xff;
        this.esc = 0;
        return;
      case 8:
        if ((hexDigit(c) & 0xffff) <= 15) s.bg = hexDigit(c); // 0cf5:09BC ignores values > 15
        this.esc = 0;
        return;
      case 9:
        if ((hexDigit(c) & 0xffff) <= 15) s.outlineColor = hexDigit(c); // 0cf5:09E4 ignores values > 15
        this.esc = 0;
        return;
      case 10:
        s.outline = c - 0x30 !== 0;
        this.esc = 0;
        return;
    }
    let code: number;
    if (this.lead) {
      code = c > 0xa0 && c < 0xff ? (this.lead << 8) | c : c;
      this.lead = 0;
    } else {
      if (c > 0xa0 && c < 0xc9) {
        this.lead = c;
        return;
      }
      if (c === 0x1b) {
        this.esc = 1;
        return;
      }
      if (c < 0x20) {
        if (c === 0x0a) this.newline();
        else if (c === 0x0d) {
          s.x = s.margin;
          this.skipSpace = true;
        }
        return;
      }
      code = c;
    }
    const single = code < 0x200;
    if (s.x > (single ? s.right : s.right - 1) && (s.right !== 0x4f || code < 0x2122 || code > 0x2125)) this.newline();
    if (this.skipSpace && code === 0x20) {
      this.skipSpace = false;
      return;
    }
    this.drawChar(code);
    this.skipSpace = false;
    if (s.mode & 0x20) {
      s.y += (s.mode & 0xc0 ? 0x10 : 0) + s.lineHeight;
      if (s.y > s.bottom) s.y = 0;
      this.skipSpace = true;
      return;
    }
    s.x += (single ? 1 : 2) * (s.mode & 0x40 ? 2 : 1);
  }

  write(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.putByte(bytes[i]);
  }

  private wrapColumn(v: number): number {
    const s = this.s;
    const span = s.right - s.left + 1;
    let d = v;
    if (span <= v) {
      d = v - span;
      while (d >= span) d -= span;
    }
    return d + s.left;
  }
}

/**
 * END.EXE draws the ending captions with the same glyphs made bold: each row ORed with itself shifted one
 * pixel right, within the glyph box. Inferred from the emulator (an END.EXE caption matches 1757 of 1757
 * pixels); END.EXE's text routine is not traced.
 */
export function embolden(bits: Uint8Array, wbytes: number): Uint8Array {
  const out = bits.slice();
  for (let r = 0; r * wbytes < bits.length; r++) {
    let carry = 0;
    for (let b = 0; b < wbytes; b++) {
      const v = bits[r * wbytes + b];
      out[r * wbytes + b] = v | (v >> 1) | carry;
      carry = (v & 1) << 7;
    }
  }
  return out;
}

export interface RenderTextOptions {
  fg?: number;
  bg?: number;
  mode?: DrawMode;
  outline?: number | null;
  /** Columns (bytes) before wrapping; default: no wrapping within 80 columns. */
  columns?: number;
  lineHeight?: number;
  /** Fill colour of the returned bitmap. */
  background?: number;
  /** END.EXE style bold text. */
  bold?: boolean;
}

/**
 * Renders EUC-KR bytes (with the game's control codes) into a new indexed bitmap just large enough
 * for the text. Defaults: fg 15, transparent mode 4, line pitch 18.
 */
export function renderText(font: GameFont, bytes: ArrayLike<number>, opts: RenderTextOptions = {}): IndexedImage {
  const columns = opts.columns ?? 80;
  const state: Partial<TextState> = {
    fg: opts.fg ?? 15,
    bg: opts.bg ?? 0,
    mode: opts.mode ?? 4,
    outline: opts.outline !== undefined && opts.outline !== null,
    outlineColor: opts.outline ?? 0,
    right: columns - 1,
    lineHeight: opts.lineHeight ?? 0x12,
    bottom: 0x7fff,
    bold: opts.bold ?? false,
  };
  // measure on a scratch console, then draw
  const probe = new TextConsole(font, { width: 0, height: 0, pixels: new Uint8Array(0) }, { ...state, hidden: true });
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < bytes.length; i++) {
    probe.putByte(bytes[i]);
    maxX = Math.max(maxX, probe.s.x);
    maxY = Math.max(maxY, probe.s.y);
  }
  const width = Math.max(1, Math.min(columns, maxX)) * 8;
  const height = maxY + 16;
  const img: IndexedImage = { width, height, pixels: new Uint8Array(width * height).fill(opts.background ?? 0) };
  new TextConsole(font, img, state).write(bytes);
  return img;
}

/** EUC-KR bytes to a JavaScript string (browsers and Node ship the euc-kr TextDecoder). */
export function decodeEucKr(bytes: Uint8Array): string {
  return new TextDecoder('euc-kr').decode(bytes);
}

// ---------------------------------------------------------------------------------------------
// FONT.R3: user-defined characters

/** DS offset of the table of the 87 GRPDRV character codes FONT.R3 glyphs are installed as (0cf5:A6A0). */
export const GAIJI_CODE_TABLE = 0x2980;
export const GAIJI_COUNT = 87;

/**
 * FONT.R3: 87 glyphs of 16x16 (32 bytes, 2 bytes per row, MSB left), read raw (0xAE0 bytes) by
 * 0cf5:A6A0 and registered with GRPDRV AH=1Ch (0000:CE5B) under the codes listed at DS:2980.
 * MAIN's own text path (0cf5:0D44) never reads GRPDRV glyphs.
 */
export function parseFontR3(data: Uint8Array, codes?: number[]): { code: number; bits: Uint8Array }[] {
  return Array.from({ length: Math.min(GAIJI_COUNT, data.length >> 5) }, (_, i) => ({
    code: codes?.[i] ?? 0,
    bits: data.slice(i * 32, i * 32 + 32),
  }));
}

/** Reads the 87 codes at DS:2980 of MAIN.EXE. */
export function readGaijiCodes(mainExe: Uint8Array): number[] {
  const header = (mainExe[8] | (mainExe[9] << 8)) * 16;
  const base = header + 0x313a0 + GAIJI_CODE_TABLE;
  return Array.from({ length: GAIJI_COUNT }, (_, i) => mainExe[base + 2 * i] | (mainExe[base + 2 * i + 1] << 8));
}

/** Expands a 1-bit bitmap (wbytes x rows) to an indexed image with colours fg/bg. */
export function bitsToImage(bits: Uint8Array, wbytes: number, rows: number, fg = 15, bg = 0): IndexedImage {
  const img: IndexedImage = { width: wbytes * 8, height: rows, pixels: new Uint8Array(wbytes * 8 * rows).fill(bg) };
  blit2(img, 0, 0, bits, wbytes, rows, fg, bg);
  return img;
}
