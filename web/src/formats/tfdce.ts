// TF-DCE image decoder: a port of TFDED.COM's int 62h handler (see docs/GRAPHICS.md, "TF-DCE").
//
// TFDED decodes straight into VGA planar memory, and the format relies on that: back references
// read bytes that were already written to the same plane (or to other planes) of video memory,
// and a pass may leave a plane untouched. The port therefore decodes into a model of the four
// 64 KiB VGA planes (`Vram`) and then reads the image rectangle back as 4-bit colour indices.

export const VRAM_BASE = 0xc80; // TFDED: destination offset = y*80 + x_bytes + 0xC80
export const STRIDE = 80; // bytes per scanline (640 px)

/** The four VGA bit planes, 64 KiB each, addressed like segment A000. */
export class Vram {
  readonly planes: Uint8Array[] = [0, 1, 2, 3].map(() => new Uint8Array(0x10000));

  /** Reads a rectangle (x0 in pixels, y0 rows below `base`) as 4-bit colour indices. */
  read(x0: number, y0: number, w: number, h: number, base = VRAM_BASE): Uint8Array {
    const out = new Uint8Array(w * h);
    const [p0, p1, p2, p3] = this.planes;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const off = (base + (y0 + y) * STRIDE + ((x0 + x) >> 3)) & 0xffff;
        const bit = 7 - ((x0 + x) & 7);
        out[y * w + x] =
          ((p0[off] >> bit) & 1) | (((p1[off] >> bit) & 1) << 1) | (((p2[off] >> bit) & 1) << 2) | (((p3[off] >> bit) & 1) << 3);
      }
    }
    return out;
  }

  clear(): void {
    for (const p of this.planes) p.fill(0);
  }
}

export interface TfdceHeader {
  /** Width in bytes (8 pixels each). */
  widthBytes: number;
  width: number;
  height: number;
  /** Four 4-bit plane methods, pass 0 in the low nibble: 0 keep, 1 fill, 2 copy plane, 3 compressed. */
  methods: number;
  /** Four 2-bit physical plane numbers, pass 0 in the low bits. */
  planeOrder: number;
  /** Header flag byte: bit 6 = 16-word palette follows, bit 5 = macro table follows. */
  flagByte: number;
  /** Embedded 16 palette words (flag bit 6), or null. TFDED skips them and no game image has them. */
  palette: Uint16Array | null;
  /** Offset of the macro-code word table (bit 5) in the blob, or -1. */
  tableOffset: number;
  tableLength: number;
  /** Offset of the plane data. */
  dataOffset: number;
}

export function parseTfdceHeader(blob: Uint8Array): TfdceHeader {
  let p = blob[0]; // header length byte (the bytes after it up to that length are skipped)
  const widthBytes = blob[p++];
  const height = blob[p] | (blob[p + 1] << 8);
  p += 2;
  const methods = blob[p] | (blob[p + 1] << 8);
  p += 2;
  const planeOrder = blob[p++];
  const flagByte = blob[p++];
  let palette: Uint16Array | null = null;
  if (flagByte & 0x40) {
    palette = new Uint16Array(16);
    for (let i = 0; i < 16; i++) palette[i] = blob[p + 2 * i] | (blob[p + 2 * i + 1] << 8);
    p += 32;
  }
  let tableOffset = -1;
  let tableLength = 0;
  if (flagByte & 0x20) {
    tableLength = blob[p++];
    tableOffset = p;
    p += 2 * tableLength;
  }
  return { widthBytes, width: widthBytes * 8, height, methods, planeOrder, flagByte, palette, tableOffset, tableLength, dataOffset: p };
}

/**
 * Plausibility check used to find TF-DCE blobs in data files. TFDED itself checks nothing; every
 * game image starts with header length 2 followed by 'T' (0x54), which this requires (heuristic).
 */
export function looksLikeTfdce(blob: Uint8Array): boolean {
  if (blob.length < 10 || blob[0] < 2 || blob[0] > 16 || blob[1] !== 0x54) return false;
  const h = parseTfdceHeader(blob);
  if (h.widthBytes === 0 || h.widthBytes > 80 || h.height === 0 || h.height > 480) return false;
  for (let i = 0; i < 4; i++) if (((h.methods >> (4 * i)) & 0xf) > 3) return false;
  return h.dataOffset <= blob.length;
}

export interface DrawResult {
  header: TfdceHeader;
  /** Bit mask of physical planes the decoder wrote. */
  planesWritten: number;
  /** Number of blob bytes consumed. */
  consumed: number;
}

const ROTATE_NONE = 0;
const ROTATE_ONCE = 1;
const ROTATE_TWICE = 2;

/**
 * Exactly what `int 62h` (AX = parameter block, func 0) does: decodes `blob` into `vram` at
 * byte column `xBytes`, row `y`. `flags` bit 0 enables writing physical plane 3 (MAIN.EXE always
 * passes 1, see 0CF5:52D4).
 */
export function drawTfdce(vram: Vram, blob: Uint8Array, xBytes: number, y: number, flags = 1): DrawResult {
  const hdr = parseTfdceHeader(blob);
  const W = hdr.widthBytes;
  const H = hdr.height;
  if (W === 0 || H === 0) throw new Error('TF-DCE: empty image');
  const origin = (y * STRIDE + xBytes + VRAM_BASE) & 0xffff;
  const planeTab = [0, 1, 2, 3].map((i) => (hdr.planeOrder >> (2 * i)) & 3);
  const mtf = [0x00, 0xff, 0x55, 0xaa]; // TFDED 0x6D8, reset from 0x6DC on every call
  const s = blob;
  let si = hdr.dataOffset;
  let methods = hdr.methods;
  let planesWritten = 0;
  const rd = () => s[si++ & 0xffff];

  const fillRect = (plane: Uint8Array, v: number) => {
    let di = origin;
    for (let r = 0; r < H; r++, di += STRIDE) for (let c = 0; c < W; c++) plane[(di + c) & 0xffff] = v;
  };

  // Compressed plane (TFDED 0x326): column-major serpentine over byte columns.
  const decodePlane = (pi: number) => {
    const plane = vram.planes[pi];
    let dir = STRIDE; // TFDED [0x663]
    let di = origin;
    let dx = H; // rows left in the current column
    let bp = W; // columns left
    // Called after each byte store (di already incremented). Returns true when the plane is full.
    const step = (): boolean => {
      if (--dx === 0) {
        dir = -dir;
        dx = H;
        return --bp === 0;
      }
      di = (di - 1 + dir) & 0xffff;
      return false;
    };
    const put = (v: number) => {
      plane[di] = v;
      di = (di + 1) & 0xffff;
    };

    for (;;) {
      let op = rd();
      let arg = -1; // operand from a macro table word, -1 = read from the stream
      if (op < 0x20) {
        const t = hdr.tableOffset + 2 * op; // [0x349] + 2*op (only meaningful when the table exists)
        op = s[t & 0xffff];
        arg = s[(t + 1) & 0xffff];
      }
      const hi = op >> 4;
      if (arg >= 0 && (hi === 0 || hi === 1 || hi === 6)) continue; // table no-ops (0x5FD)

      if (hi >= 0xa) {
        // run: n copies of a byte (0x392 / 0x362)
        const n = (op - 0x9e) & 0xff;
        const v = arg >= 0 ? arg : rd();
        for (let k = 0; k < n; k++) {
          put(v);
          if (step()) return;
        }
      } else if (hi === 0x8 || hi === 0x6) {
        // two-byte pattern repeated (0x3B4 nibble-doubled / 0x3C2 literal pair)
        const n = (op & 0xf) + 1;
        let a: number, b: number;
        if (hi === 0x8) {
          const v = arg >= 0 ? arg : rd();
          a = (v & 0xf) * 0x11;
          b = (v >> 4) * 0x11;
        } else {
          a = rd();
          b = rd();
        }
        for (let k = 0; k < n; k++) {
          put(a);
          if (step()) return;
          put(b);
          if (step()) return;
        }
      } else if (hi === 0x7) {
        if (arg >= 0) {
          // 0x52A: one byte
          put(arg);
          if (step()) return;
        } else {
          // 0x3F4: literal bytes
          const n = (op & 0xf) + 1;
          for (let k = 0; k < n; k++) {
            put(rd());
            if (step()) return;
          }
        }
      } else if (hi === 0x4) {
        // 0x40C / 0x36C: copy from `dist` bytes back in linear VRAM order, same plane
        const dist = (op & 0xf) + 1;
        const n = (arg >= 0 ? arg : rd()) + 2;
        let src = (di - dist) & 0xffff;
        for (let k = 0; k < n; k++) {
          plane[di] = plane[src];
          di = (di + 1) & 0xffff;
          src = (src + 1) & 0xffff;
          if (--dx === 0) {
            dir = -dir;
            dx = H;
            if (--bp === 0) return;
          } else {
            di = (di - 1 + dir) & 0xffff;
            src = (src - 1 + dir) & 0xffff;
          }
        }
      } else if (hi === 0x5 || hi === 0x9) {
        // 0x448 / 0x376: masked copy from another plane at the same offset
        let planeIdx: number, mask: number, n: number;
        if (arg < 0 && (op & 0xc) === 0xc) {
          // new mask value inserted at MTF slot 2
          mask = rd();
          n = rd() + 2;
          planeIdx = op & 3;
          mtf[3] = mtf[2];
          mtf[2] = mask;
        } else {
          const k = op & 3;
          planeIdx = (op >> 2) & 3;
          n = (arg >= 0 ? arg : rd()) + 2;
          mask = mtf[k];
          if (k > 0) {
            mtf[k] = mtf[k - 1];
            mtf[k - 1] = mask;
          }
        }
        let rot = ROTATE_NONE;
        if (hi === 0x9) rot = mask === 0x55 || mask === 0xaa ? ROTATE_ONCE : ROTATE_TWICE;
        const src = vram.planes[planeTab[planeIdx]];
        let m = mask;
        for (let k = 0; k < n; k++) {
          put(src[di] & m);
          if (rot !== ROTATE_NONE) m = ((m << rot) | (m >> (8 - rot))) & 0xff;
          if (step()) return;
        }
      } else if (hi === 0x3) {
        // 0x604 / 0x388: transformed copy from another plane at the same offset
        const n = (arg >= 0 ? arg : rd()) + 2;
        const src = vram.planes[planeTab[(op >> 2) & 3]];
        const f = op & 3;
        for (let k = 0; k < n; k++) {
          let v = src[di];
          if (f === 1) v = ~v & 0xff;
          else if (f === 2) v = ((v >> 1) | (v << 7)) & 0xff;
          else if (f === 3) v = ((v << 1) | (v >> 7)) & 0xff;
          put(v);
          if (step()) return;
        }
      } else if (hi === 0x2) {
        // 0x552 / 0x54E: copy from `dist` bytes back in serpentine (decode) order, same plane
        const n = (op & 0xf) + 3;
        const dist = arg >= 0 ? arg : rd();
        const q = Math.floor(dist / H);
        const rem = dist % H;
        const done = (H - dx) & 0xffff;
        let srcLeft: number, back: number;
        if (done >= rem) {
          srcLeft = (dx + rem) & 0xffff;
          back = q;
        } else {
          srcLeft = (rem - done) & 0xffff;
          back = q + 1;
        }
        const srcBp = (bp + back) & 0xffff;
        let srcDir = back & 1 ? -dir : dir;
        const row = srcDir === STRIDE ? (H - srcLeft) & 0xffff : (srcLeft - 1) & 0xffff;
        let src = (origin + W - srcBp + row * STRIDE) & 0xffff;
        for (let k = 0; k < n; k++) {
          plane[di] = plane[src];
          di = (di + 1) & 0xffff;
          src = (src + 1) & 0xffff;
          if (step()) return;
          if (--srcLeft === 0) {
            srcDir = -srcDir;
            srcLeft = H;
          } else {
            src = (src - 1 + srcDir) & 0xffff;
          }
        }
      } else {
        throw new Error(`TF-DCE: bad opcode ${op.toString(16)} at ${si - 1}`);
      }
    }
  };

  for (let pass = 0; pass < 4; pass++) {
    const pi = planeTab[pass];
    if (pi === 3 && !(flags & 1)) continue; // plane 3 disabled: no method nibble is consumed
    const m = methods & 0xf;
    methods >>= 4;
    const plane = vram.planes[pi];
    if (m === 0) {
      if (pi === 3) {
        // TFDED 0x2A4: `and bx, 0Fh` leaves BH = 0, so method 0 on plane 3 clears it
        fillRect(plane, 0);
        planesWritten |= 8;
      }
    } else if (m === 1) {
      fillRect(plane, rd());
      planesWritten |= 1 << pi;
    } else if (m === 2) {
      const src = vram.planes[planeTab[rd() & 3]];
      let di = origin;
      for (let r = 0; r < H; r++, di += STRIDE)
        for (let c = 0; c < W; c++) plane[(di + c) & 0xffff] = src[(di + c) & 0xffff];
      planesWritten |= 1 << pi;
    } else if (m === 3) {
      decodePlane(pi);
      planesWritten |= 1 << pi;
    } else if (m !== 4) {
      throw new Error(`TF-DCE: bad plane method ${m}`);
    }
  }
  return { header: hdr, planesWritten, consumed: si };
}

export interface TfdceImage {
  width: number;
  height: number;
  /** width*height colour indices 0..15. */
  pixels: Uint8Array;
  header: TfdceHeader;
  planesWritten: number;
}

/** Decodes a TF-DCE blob on its own (zeroed VRAM, position 0,0, flags 1 as MAIN.EXE uses). */
export function decodeTfdce(blob: Uint8Array, flags = 1): TfdceImage {
  const vram = new Vram();
  const r = drawTfdce(vram, blob, 0, 0, flags);
  const { width, height } = r.header;
  return {
    width,
    height,
    pixels: vram.read(0, 0, width, height),
    header: r.header,
    planesWritten: r.planesWritten,
  };
}

/** Splits FACEDAT.R3 / PACKGRP.R3: a table of {u32 offset, u16 size} followed by the blobs. */
export function splitOffsetTable(data: Uint8Array): Uint8Array[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ents: [number, number][] = [];
  for (let p = 0; p + 6 <= data.length; p += 6) {
    const off = dv.getUint32(p, true);
    const size = dv.getUint16(p + 4, true);
    if (ents.length && off !== ents[ents.length - 1][0] + ents[ents.length - 1][1]) break;
    if (!ents.length && off !== 0) break;
    ents.push([off, size]);
  }
  const base = ents.length * 6;
  return ents.map(([o, s]) => data.subarray(base + o, base + o + s));
}
