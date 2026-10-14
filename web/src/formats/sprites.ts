// Bitmap formats of the game's tile, sprite and UI banks (see docs/GRAPHICS.md, "Cells", "SSC sprites",
// "MARK.R3"). Everything decodes to 4-bit colour indices, one byte per pixel, row-major.
//
// Two planar layouts are used:
//  * plane-major ("cell") data: all rows of plane 0, then plane 1, 2, 3; each row is width/8 bytes,
//    MSB = leftmost pixel. 16x16 cells (128 bytes) are the unit of the tile engine (0000:6296).
//  * byte-interleaved data: for every 8-pixel byte column the bytes of plane 0..3 follow each other
//    (or plane 0..2 for the 3-plane variant, plane 3 = 0). Drawn by 0000:5A10 / 0000:8371.

export interface IndexedImage {
  width: number;
  height: number;
  /** Colour indices 0..15. Colour 0 is transparent wherever the game draws the bitmap masked. */
  pixels: Uint8Array;
}

export const CELL = 16;
export const CELL_BYTES = 128;

/** Decodes plane-major planar data (rows of width/8 bytes per plane, planes one after another). */
export function decodePlanar(data: Uint8Array, offset: number, width: number, height: number, planes = 4): IndexedImage {
  const bpr = width >> 3;
  const planeSize = bpr * height;
  const pixels = new Uint8Array(width * height);
  for (let p = 0; p < planes; p++) {
    const base = offset + p * planeSize;
    for (let y = 0; y < height; y++) {
      for (let xb = 0; xb < bpr; xb++) {
        const v = data[base + y * bpr + xb] ?? 0;
        if (!v) continue;
        const o = y * width + xb * 8;
        for (let b = 0; b < 8; b++) if (v & (0x80 >> b)) pixels[o + b] |= 1 << p;
      }
    }
  }
  return { width, height, pixels };
}

/** Decodes byte-interleaved planar data (0000:5A10 with planes = 4, 0000:8371 with planes = 3). */
export function decodeInterleaved(data: Uint8Array, offset: number, width: number, height: number, planes = 4): IndexedImage {
  const bpr = width >> 3;
  const pixels = new Uint8Array(width * height);
  let s = offset;
  for (let y = 0; y < height; y++) {
    for (let xb = 0; xb < bpr; xb++) {
      const o = y * width + xb * 8;
      for (let p = 0; p < planes; p++) {
        const v = data[s++] ?? 0;
        if (!v) continue;
        for (let b = 0; b < 8; b++) if (v & (0x80 >> b)) pixels[o + b] |= 1 << p;
      }
    }
  }
  return { width, height, pixels };
}

/**
 * One 16x16 cell (128 bytes, plane-major). `mirror` flips it horizontally the way HEXBCHR/HEXICHR
 * unit sprites are mirrored (1cb6:F1CB, 2cb4:0E9C: bytes bit-reversed and the two bytes of a row swapped).
 */
export function decodeCell(data: Uint8Array, offset = 0, mirror = false): Uint8Array {
  const px = decodePlanar(data, offset, CELL, CELL).pixels;
  if (mirror) for (let y = 0; y < CELL; y++) px.subarray(y * CELL, y * CELL + CELL).reverse();
  return px;
}

/** All whole cells of a buffer (tile sets: HEX?CHP, HEXGRP#0, SMAPBGPL, MMAPBGPL; unit banks: HEX?CHR). */
export function decodeCells(data: Uint8Array, mirror = false): Uint8Array[] {
  const n = Math.floor(data.length / CELL_BYTES);
  return Array.from({ length: n }, (_, i) => decodeCell(data, i * CELL_BYTES, mirror));
}

/**
 * The 1-bit mask MAIN builds for a masked cell (0000:5C32: mask = NOT(p0|p1|p2|p3), i.e. colour 0 is
 * transparent), returned as 1 = opaque per pixel.
 */
export function cellOpacity(cell: Uint8Array): Uint8Array {
  return cell.map((c) => (c ? 1 : 0));
}

/**
 * Lays out cells on a grid. `indices[i]` selects the cell drawn at column i % cols, row i / cols;
 * `empty` (default 0xFF) leaves the position blank (colour 0).
 */
export function composeCells(cells: Uint8Array[], indices: ArrayLike<number>, cols: number, rows: number, empty = 0xff): IndexedImage {
  const width = cols * CELL;
  const height = rows * CELL;
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < cols * rows; i++) {
    const k = indices[i];
    if (k === undefined || k === empty || !cells[k]) continue;
    const cx = (i % cols) * CELL;
    const cy = Math.floor(i / cols) * CELL;
    const c = cells[k];
    for (let y = 0; y < CELL; y++) pixels.set(c.subarray(y * CELL, y * CELL + CELL), (cy + y) * width + cx);
  }
  return { width, height, pixels };
}

/** Draws `src` onto `dst` at (x, y); with `transparent0`, colour 0 pixels are skipped (masked blit). */
export function blit(dst: IndexedImage, src: IndexedImage, x: number, y: number, transparent0 = false): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const c = src.pixels[sy * src.width + sx];
      if (transparent0 && !c) continue;
      dst.pixels[dy * dst.width + dx] = c;
    }
  }
}

/** Packs cells into one sheet image, `cols` cells per row, with a 1-pixel gap of `gapColor`. */
export function cellSheet(cells: Uint8Array[], cols: number, gap = 1, gapColor = 0): IndexedImage {
  const rows = Math.max(1, Math.ceil(cells.length / cols));
  const step = CELL + gap;
  const img: IndexedImage = { width: cols * step, height: rows * step, pixels: new Uint8Array(cols * step * rows * step).fill(gapColor) };
  cells.forEach((c, i) => blit(img, { width: CELL, height: CELL, pixels: c }, (i % cols) * step, Math.floor(i / cols) * step));
  return img;
}

// ---------------------------------------------------------------------------------------------
// Tile maps

/**
 * Renders a cols x rows map of tile indices (one byte per cell). SMAP.R3 / PMAP.R3 entries begin with
 * the 32x20 BG map drawn with SMAPBGPL entry 0 (SMAP) or 1 (PMAP) (1cb6:0F9A); the next 640 bytes
 * are not graphics (0x7F/0xFF per cell, inferred walkability) and object records follow.
 */
export function renderTileMap(tiles: Uint8Array[], map: Uint8Array, cols: number, rows: number, offset = 0): IndexedImage {
  return composeCells(tiles, map.subarray(offset, offset + cols * rows), cols, rows, 0x100);
}

// ---------------------------------------------------------------------------------------------
// Unit banks

/**
 * HEXZCHR entries (1024 bytes = 8 cells) hold one unit: cell = dir + 4 * frame, dir 0..3, frame 0..1
 * (1cb6:6C28 draws cell 2*(v & ~3) + (v & 3) + (frame ? 4 : 0)). Returns [dir][frame].
 */
export function unitFrames(entry: Uint8Array): Uint8Array[][] {
  const cells = decodeCells(entry);
  return [0, 1, 2, 3].map((d) => [cells[d], cells[d + 4]]);
}

/**
 * A square close-up frame: HEXICHR entries are 36 cells (6x6, 96x96 px, mounted officer), HEXBCHR
 * entries 0..168 are 16 cells (4x4, 64x64 px, soldier poses) and 169..180 are 9 cells (3x3, 48x48 px,
 * effects such as arrows). 1cb6:F11A selects 9 cells per frame for entry 0xA9 + n and 1cb6:F153 selects
 * 16; the row-major cell order is inferred from the images, not traced.
 */
export function squareFrame(entry: Uint8Array, mirror = false): IndexedImage {
  const cells = decodeCells(entry, mirror);
  const side = Math.round(Math.sqrt(cells.length));
  const order = Array.from({ length: side * side }, (_, i) => {
    if (!mirror) return i;
    const x = i % side;
    return i - x + (side - 1 - x); // mirrored cells also swap columns
  });
  return composeCells(cells, order, side, side);
}

// ---------------------------------------------------------------------------------------------
// World map (MMAP.R3 + MMAPBGPL.R3)

/** DS offset of the world map size table: per chapter [width, height] in 16-px tiles (0cf5:D722). */
export const WORLD_MAP_DIMS = 0x2f06;
/** DS offset of the MMAP.R3 entry number per chapter (u16, 0cf5:E457). */
export const WORLD_MAP_ENTRY = 0x2f9c;
export const WORLD_MAP_CHAPTERS = 5;
/** MAIN.EXE DGROUP offset in the load image (DS:X is at header + 0x313A0 + X). */
const MAIN_DS_FILE = 0x313a0;

export interface WorldMapInfo {
  chapter: number;
  entry: number;
  width: number;
  height: number;
}

/**
 * The world map of each chapter (chapter = 0cf5:77DA(DS:7A80)). MMAP.R3 entry `entry` holds width*height
 * tile bytes (MMAPBGPL.R3 entry 0 cells, row-major) followed by (width/2)*(height/2)/8 bytes, one bit
 * per 2x2 tile block (0cf5:E41C loads both; what the bits mean is not traced).
 */
export function readWorldMaps(mainExe: Uint8Array): WorldMapInfo[] {
  const header = (mainExe[8] | (mainExe[9] << 8)) * 16;
  const ds = header + MAIN_DS_FILE;
  return Array.from({ length: WORLD_MAP_CHAPTERS }, (_, chapter) => ({
    chapter,
    entry: mainExe[ds + WORLD_MAP_ENTRY + 2 * chapter] | (mainExe[ds + WORLD_MAP_ENTRY + 2 * chapter + 1] << 8),
    width: mainExe[ds + WORLD_MAP_DIMS + 2 * chapter],
    height: mainExe[ds + WORLD_MAP_DIMS + 2 * chapter + 1],
  }));
}

// ---------------------------------------------------------------------------------------------
// SSC sprites (SSCCHR1.R3 / SSCCHR2.R3)

export interface Ssc1Sprite {
  /** Size in cells. */
  w: number;
  h: number;
  /** w*h local cell indices, row-major; 0xFF = empty. */
  cells: number[];
}

export interface Ssc1Bank {
  sprites: Ssc1Sprite[];
  cells: Uint8Array[];
}

/**
 * SSCCHR1 entry (loader 0cf5:4AF8): u8 nSprites; nSprites x {u8 w, u8 h, w*h cell bytes}; u8 nCells;
 * nCells x 128-byte cells. The game adds a running base to the cell bytes when it loads several banks.
 */
export function parseSsc1(entry: Uint8Array): Ssc1Bank {
  let p = 0;
  const n = entry[p++];
  const sprites: Ssc1Sprite[] = [];
  for (let i = 0; i < n; i++) {
    const w = entry[p++];
    const h = entry[p++];
    sprites.push({ w, h, cells: Array.from(entry.subarray(p, p + w * h)) });
    p += w * h;
  }
  const nCells = entry[p++];
  const cells = Array.from({ length: nCells }, (_, i) => decodeCell(entry, p + i * CELL_BYTES));
  if (p + nCells * CELL_BYTES > entry.length) throw new Error('SSCCHR1: truncated entry');
  return { sprites, cells };
}

export function renderSsc1Sprite(bank: Ssc1Bank, sprite: Ssc1Sprite): IndexedImage {
  return composeCells(bank.cells, sprite.cells, sprite.w, sprite.h);
}

export const SSC2_FRAME_W = 32;
export const SSC2_FRAME_H = 40;
export const SSC2_FRAME_BYTES = 640;

/**
 * SSCCHR2 entry (loader 0cf5:4D5C): 2560 bytes = 4 frames of 32x40 pixels, each plane-major
 * (4 planes x 40 rows x 4 bytes). The game copies a frame into a 32x48 buffer (at y = 8 or 0) and
 * cuts it into 2x3 cells.
 */
export function decodeSsc2(entry: Uint8Array): IndexedImage[] {
  const n = Math.floor(entry.length / SSC2_FRAME_BYTES);
  return Array.from({ length: n }, (_, i) => decodePlanar(entry, i * SSC2_FRAME_BYTES, SSC2_FRAME_W, SSC2_FRAME_H));
}

// ---------------------------------------------------------------------------------------------
// MARK.R3: UI bank (one 14584-byte entry, loaded at 0cf5:A436 into handle DS:679E)

export type MarkKind = 'i4' | 'i3' | 'cell4' | 'cursor';

export interface MarkRegion {
  name: string;
  offset: number;
  kind: MarkKind;
  /** Pixel size of one image. */
  width: number;
  height: number;
  count: number;
  /** Function that uses it. */
  ref: string;
}

/** Bytes per image of a region. */
export function markImageBytes(r: Pick<MarkRegion, 'kind' | 'width' | 'height'>): number {
  switch (r.kind) {
    case 'i4':
    case 'cell4':
      return (r.width >> 3) * r.height * 4;
    case 'i3':
      return (r.width >> 3) * r.height * 3;
    case 'cursor':
      return 0x90;
  }
}

/**
 * Sub-images of MARK.R3 identified from their users (offsets into the entry). Not yet identified:
 * 0x1FE0-0x21DF, 0x2258-0x2337 and 0x2DB8-0x38F7.
 */
export const MARK_REGIONS: MarkRegion[] = [
  { name: 'command icons 24x24', offset: 0x0000, kind: 'i3', width: 24, height: 24, count: 3, ref: '2cb6:9B4C' },
  { name: 'frame tiles 8x8', offset: 0x0288, kind: 'i3', width: 8, height: 8, count: 47, ref: '2cb6:6EC2' },
  { name: 'window backgrounds (2x2 tiles)', offset: 0x06f0, kind: 'cell4', width: 16, height: 16, count: 32, ref: '1cf5:53BE' },
  { name: 'buttons 16x16', offset: 0x16f0, kind: 'i4', width: 16, height: 16, count: 6, ref: '1cf5:19D0' },
  { name: 'buttons 48x20', offset: 0x19f0, kind: 'i4', width: 48, height: 20, count: 3, ref: '1cf5:1AC8' },
  { name: 'button background 8x20', offset: 0x1f90, kind: 'i4', width: 8, height: 20, count: 1, ref: '1cf5:1AC8' },
  { name: 'patterns 8x10', offset: 0x21e0, kind: 'i4', width: 8, height: 10, count: 3, ref: '2cb6:52A6, 1cf5:C996' },
  { name: 'mouse cursors 24x24', offset: 0x2338, kind: 'cursor', width: 24, height: 24, count: 12, ref: '1cf5:1244' },
  { name: 'frame tiles 8x8', offset: 0x29f8, kind: 'i3', width: 8, height: 8, count: 8, ref: '2cb6:6EC2' },
  { name: 'picture 48x32', offset: 0x2ab8, kind: 'i4', width: 48, height: 32, count: 1, ref: '1cf5:FBCA' },
];

export interface MarkCursor {
  /** 24x24; 0 = transparent, 1 = keep screen AND mask = 0 (black), 2 = cursor colour. */
  andMask: Uint8Array;
  orMask: Uint8Array;
}

/**
 * Software mouse cursor (0x90 bytes; 0000:B895 copies it, 0000:BABE pre-shifts it, 0000:BBCA draws it):
 * 24 rows x 3 bytes AND mask, then 24 rows x 3 bytes OR mask. Every plane is ANDed with the first and
 * ORed with the second where the cursor colour (0000:B937, set to 7 by 0cf5:0F86) has that plane bit.
 * Hot spot (1, 1) (0cf5:0F86 -> 0cf5:11FA, int 33h AX=9).
 */
export function decodeCursor(data: Uint8Array, offset: number): MarkCursor {
  const andMask = new Uint8Array(24 * 24);
  const orMask = new Uint8Array(24 * 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const bit = 0x80 >> (x & 7);
      andMask[y * 24 + x] = data[offset + y * 3 + (x >> 3)] & bit ? 1 : 0;
      orMask[y * 24 + x] = data[offset + 72 + y * 3 + (x >> 3)] & bit ? 1 : 0;
    }
  }
  return { andMask, orMask };
}

/** Composites a cursor over a background colour index: result pixel = (bg AND mask) OR (or ? colour : 0). */
export function renderCursor(c: MarkCursor, color = 7, background = -1): IndexedImage {
  const pixels = new Uint8Array(24 * 24);
  for (let i = 0; i < pixels.length; i++) {
    const bg = background < 0 ? 0 : background;
    pixels[i] = (c.andMask[i] ? bg : 0) | (c.orMask[i] ? color : 0);
  }
  return { width: 24, height: 24, pixels };
}

/** Decodes image `index` of a MARK region. 'cell4' tiles are 16x16 byte-interleaved (0000:7E4A). */
export function decodeMarkImage(mark: Uint8Array, r: MarkRegion, index: number): IndexedImage {
  const off = r.offset + index * markImageBytes(r);
  if (r.kind === 'cursor') return renderCursor(decodeCursor(mark, off));
  return decodeInterleaved(mark, off, r.width, r.height, r.kind === 'i3' ? 3 : 4);
}
