// NPK016 pictures (OPGRP.R3, END1GRP.R3, END2GRP.R3), decoded as OPEN.EXE / END.EXE do (see
// docs/GRAPHICS.md, "NPK016"). The decoder is the same code in both programs, image offsets 0x06E4
// (entry), 0x073F (LZ rows) and 0x07BD (row conversion).
//
// Layout: "NPK016", u16 4, u16 640, u16 400 (screen size), u16 width, u16 height, 16 palette words
// (0GRB, 4 bits per channel), then the compressed rows from offset 0x30.

import type { Rgb4 } from './palette';
import { decodeInterleaved, type IndexedImage } from './sprites';

export const NPK_MAGIC = 'NPK016';
export const NPK_DATA = 0x30;
/** Bytes per row slot in the decoder's ring buffer (160 words = 640 pixels). */
const ROW = 0x140;
/** The ring holds 5 rows (0x640 bytes, on OPEN.EXE's stack at bp-0x75A). */
const RING = 0x640;

export interface NpkHeader {
  screenWidth: number;
  screenHeight: number;
  width: number;
  height: number;
  /** 16 entries, R, G, B 0..15. */
  palette: Rgb4[];
}

export function isNpk(entry: Uint8Array): boolean {
  if (entry.length < NPK_DATA) return false;
  for (let i = 0; i < 6; i++) if (entry[i] !== NPK_MAGIC.charCodeAt(i)) return false;
  return true;
}

export function parseNpkHeader(entry: Uint8Array): NpkHeader {
  if (!isNpk(entry)) throw new Error('NPK016: bad magic');
  const u16 = (o: number) => entry[o] | (entry[o + 1] << 8);
  const palette: Rgb4[] = [];
  for (let i = 0; i < 16; i++) {
    const v = u16(0x10 + 2 * i);
    palette.push([(v >> 4) & 15, (v >> 8) & 15, v & 15]); // 0GRB
  }
  return { screenWidth: u16(8), screenHeight: u16(10), width: u16(12), height: u16(14), palette };
}

export interface NpkImage extends IndexedImage {
  header: NpkHeader;
  /** The decoder's output: per row, 4 bytes for every 8 pixels (byte-interleaved planes 0..3). */
  planar: Uint8Array;
  /** Bytes per output row. */
  rowBytes: number;
}

/**
 * Decodes an NPK016 entry. Each row is (width + 3) / 4 little-endian words; a word holds 4 pixels as
 * four 4-bit plane slices. Rows are LZ-coded into a 5-row ring (0x073F): flag bits come LSB first from
 * a byte read whenever the previous 8 are used up; flag 0 copies one literal word; flag 1 reads a byte b
 * and copies (b & 0x1F) + 1 words from distance ((b >> 5 & 3) + 1) * 2 bytes, or that many rows
 * (x 0x140 bytes) when b & 0x80, wrapping backwards around the ring. A copy may run past the row end;
 * the excess is overwritten by the next row. 0x07BD then gathers the 4-pixel slices of two words into
 * the four plane bytes of 8 pixels.
 */
export function decodeNpk(entry: Uint8Array): NpkImage {
  const header = parseNpkHeader(entry);
  const { width, height } = header;
  const wpr = (width + 3) >> 2;
  const rowBytes = 4 * ((wpr + 1) >> 1);
  const planar = new Uint8Array(rowBytes * height);
  const ring = new Uint8Array(RING + 0x100); // slack for copies that run past the last ring row
  let si = NPK_DATA;
  let di = 0;
  let al = 0;
  let ah = 0;
  let out = 0;
  const src = (i: number) => entry[i] ?? 0;
  for (let row = 0; row < height; row++) {
    const start = di;
    let left = wpr;
    for (;;) {
      if (!ah) {
        al = src(si++);
        ah = 0xff;
      }
      const flag = al & 1;
      al = (al >> 1) | ((ah & 1) << 7);
      ah >>= 1;
      let n: number;
      if (!flag) {
        ring[di] = src(si);
        ring[di + 1] = src(si + 1);
        si += 2;
        di += 2;
        n = 1;
      } else {
        const b = src(si++);
        n = (b & 0x1f) + 1;
        let dist = (((b >> 5) & 3) + 1) * 2;
        if (b & 0x80) dist *= 0xa0;
        let s = di;
        if (dist > di) s += RING;
        s -= dist;
        for (let k = 0; k < 2 * n; k++) ring[di++] = ring[s++];
      }
      if (left <= n) break; // sub bx, dx / ja
      left -= n;
    }
    // 0x07BD: two words w1 = b1:b0, w2 = b3:b1 -> plane bytes (w1 nibble << 4 | w2 nibble)
    let p = start;
    for (let k = 0; k < wpr >> 1; k++) {
      const b0 = ring[p];
      const b1 = ring[p + 1];
      const b2 = ring[p + 2];
      const b3 = ring[p + 3];
      p += 4;
      planar[out++] = ((b1 & 15) << 4) | (b3 & 15);
      planar[out++] = (b1 & 0xf0) | (b3 >> 4);
      planar[out++] = ((b0 & 15) << 4) | (b2 & 15);
      planar[out++] = (b0 & 0xf0) | (b2 >> 4);
    }
    if (wpr & 1) {
      const b0 = ring[p];
      const b1 = ring[p + 1];
      planar[out++] = (b1 & 15) << 4;
      planar[out++] = b1 & 0xf0;
      planar[out++] = (b0 & 15) << 4;
      planar[out++] = b0 & 0xf0;
    }
    di = start + ROW;
    if (di >= RING) di -= RING;
  }
  const img = decodeInterleaved(planar, 0, rowBytes * 2, height);
  // crop to the stated width
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) pixels.set(img.pixels.subarray(y * img.width, y * img.width + width), y * width);
  return { width, height, pixels, header, planar, rowBytes };
}
