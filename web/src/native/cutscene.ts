// The picture-show machinery shared by OPEN.EXE (opening) and END.EXE (ending), ported routine by
// routine so that a cutscene script can call the same primitives with the same arguments as the
// original (see docs/GRAPHICS.md, "Opening and ending programs").
//
// OPEN.EXE addresses are image offsets in its segment 0. END.EXE links the same library code at other
// addresses (listed in ending.ts).
//
// Memory model: the programs allocate six 64 KiB buffers (OPEN DS:162E..164C) and keep pictures in
// them as byte-interleaved 4-plane bitmaps (per row, per 8 pixels: plane 0, 1, 2, 3 bytes). Offsets
// are 16-bit inside a buffer and wrap the way 8086 offsets do; `Seg` is one such buffer.
//
// Screen: GRPDRV is told to add (0, 0x27) to every coordinate (OPEN 0:24A6 called from 0:2BC2), so
// the 640x400 picture area sits at rows 39..438 of the 640x480 screen.

import type { Screen } from '../engine/screen';
import { WIDTH, HEIGHT } from '../engine/screen';
import type { Rgb4 } from '../formats/palette';
import { parseBrg } from '../formats/palette';
import type { GameFont } from '../formats/font';

export const ORIGIN_Y = 0x27;
/** SBOPL2 int 66h F0h/F1h countdown rate: 1193182 / 4096 Hz x 0x35 / 256 (docs/SOUND.md). */
export const TICK_HZ = ((1193182 / 4096) * 0x35) / 256;
export const TICK_MS = 1000 / TICK_HZ;
/** int 1Ch rate: SBOPL2 passes every 16th of its 291.3 Hz interrupts on to the BIOS (18.2 Hz). */
export const INT1C_MS = (65536 * 1000) / 1193182;

export type Seg = Uint8Array;

/** Thrown by any wait when the player asks to skip (the original jumps to its exit path). */
export class Skip extends Error {
  constructor() {
    super('skipped');
  }
}

/** What a cutscene needs from the host (browser game or a headless test). */
export interface CutsceneIo {
  screen: Screen;
  /** Load the DAC with these 4-bit values now (GRPDRV AH=15h). */
  setPalette(p: Rgb4[]): void;
  /** Present and wait for the next display frame. */
  frame(): Promise<void>;
  /** Milliseconds, monotonic. */
  now(): number;
  /** True if the player clicked (or pressed a key) since the last call: OPEN 0:9B24 polls int 33h AX=3. */
  skip(): boolean;
  /** Music: play an entry of the program's music file, or fade out at a speed (int 66h). */
  music?: { play(index: number, repeat: boolean): void; fadeOut(speed: number): void } | null;
}

/** The program's DGROUP as a byte view (palettes, mask tables and caption lists live there). */
export class Dgroup {
  readonly base: number;
  constructor(
    readonly exe: Uint8Array,
    seg: number,
  ) {
    const hdr = (exe[8] | (exe[9] << 8)) * 16;
    this.base = hdr + seg * 16;
  }
  u8(off: number): number {
    return this.exe[this.base + off] ?? 0;
  }
  u16(off: number): number {
    return this.u8(off) | (this.u8(off + 1) << 8);
  }
  /** NUL-terminated string at DS:off. */
  str(off: number): Uint8Array {
    const out: number[] = [];
    for (let p = off; this.u8(p) !== 0 && out.length < 512; p++) out.push(this.u8(p));
    return Uint8Array.from(out);
  }
  /** Zero-terminated list of near string pointers at DS:off. */
  list(off: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let p = off; this.u16(p) !== 0 && out.length < 64; p += 2) out.push(this.str(this.u16(p)));
    return out;
  }
  /** 16 x [B, R, G] palette at DS:off. */
  palette(off: number): Rgb4[] {
    return parseBrg(this.exe, this.base + off);
  }
}

// ------------------------------------------------------------------------------------- LS11 loader

interface Ls11Entry {
  csize: number;
  usize: number;
  offset: number;
}

/**
 * Where the loader's state sits in DGROUP (all stack locals of the script function and of the loader):
 * the archive object (handle word at +4, dictionary at +6) and the loader's 1 KiB file buffer.
 */
export interface Ls11Memory {
  ds: Uint8Array;
  obj: number;
  buf: number;
  handle: number;
}

/**
 * LS11 entry loader as OPEN 0:9CC6 / 0:9C4A / 0:2A44 run it, including on a damaged stream: the bit
 * reader keeps reading the file past the entry, 1 KiB at a time into a buffer on the stack (0:9B52);
 * at end of file it returns -1, which 0:9C4A takes as a literal; copies wrap inside the 64 KiB
 * destination segment; the 16-bit byte counter must reach exactly 0. A code >= 0x8000 (or the -1)
 * is a literal read from DGROUP before the dictionary (signed compare at 0:9C60): with `mem` given
 * those bytes come from the modelled DGROUP (the program's data, the archive object, the file buffer
 * as it is at that moment); anything else there (other stack frames) is not modelled and reads 0.
 */
export class Ls11Archive {
  private entries: Ls11Entry[] = [];
  private dict: Uint8Array;

  constructor(
    readonly data: Uint8Array,
    private readonly mem: Ls11Memory | null = null,
  ) {
    this.dict = data.subarray(0x10, 0x110);
    if (mem) {
      // 0:9B9E: the object as filled when the archive is opened
      mem.ds.fill(0, mem.obj, mem.obj + 6);
      mem.ds[mem.obj + 1] = 1;
      mem.ds[mem.obj + 4] = mem.handle & 0xff;
      mem.ds[mem.obj + 5] = mem.handle >> 8;
      mem.ds.set(this.dict, mem.obj + 6);
    }
    const be = data[0] === 0x4c && data[1] === 0x53;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let p = 0x110; p + 12 <= data.length; p += 12) {
      const csize = dv.getUint32(p, !be);
      if (csize === 0) break;
      this.entries.push({ csize, usize: dv.getUint32(p + 4, !be), offset: dv.getUint32(p + 8, !be) });
    }
  }

  get count(): number {
    return this.entries.length;
  }

  /** Loads entry n to dst:off; returns its unpacked size. */
  load(n: number, dst: Seg, off: number): number {
    const e = this.entries[n];
    if (!e) return 0;
    const data = this.data;
    let di = off & 0xffff;
    if (e.csize === e.usize) {
      // 0:928C: plain read
      for (let i = 0; i < e.usize; i++) {
        dst[di] = data[e.offset + i] ?? 0;
        di = (di + 1) & 0xffff;
      }
      return e.usize;
    }
    let pos = e.offset;
    let dl = 0;
    let dh = 0;
    // 0:9B52: refill the 1 KiB buffer when it is used up; a read of 0 bytes is the end of the file
    let inBuf = 0;
    const readByte = () => {
      if (inBuf === 0) {
        const n = Math.max(0, Math.min(0x400, data.length - pos));
        if (n === 0) return -1;
        if (this.mem) for (let k = 0; k < n; k++) this.mem.ds[(this.mem.buf + k) & 0xffff] = data[pos + k];
        inBuf = n;
      }
      inBuf--;
      return data[pos++];
    };
    const stray = (c: number) => (this.mem ? this.mem.ds[(this.mem.obj + 6 + c) & 0xffff] : 0);
    // 0:2A44
    const code = (): number => {
      let si = 0;
      let dI = 0;
      let cx = 0;
      let l = dl;
      let h = dh;
      for (;;) {
        h--;
        if (h < 0) {
          const b = readByte();
          if (b < 0) return 0xffff;
          l = b;
          h = 7;
        }
        cx++;
        const bit = l >> 7;
        l = (l << 1) & 0xff;
        if (bit) si = (si * 2 + 1) & 0xffff;
        else {
          si = (si * 2) & 0xffff;
          break;
        }
      }
      for (; cx > 0; cx--) {
        h--;
        if (h < 0) {
          const b = readByte();
          if (b < 0) return 0xffff;
          l = b;
          h = 7;
        }
        const bit = l >> 7;
        l = (l << 1) & 0xff;
        dI = ((dI << 1) | bit) & 0xffff;
      }
      dl = l;
      dh = h;
      return (si + dI) & 0xffff;
    };
    let left = e.usize & 0xffff;
    do {
      const c = code();
      const signed = c >= 0x8000 ? c - 0x10000 : c;
      if (signed < 0x100) {
        dst[di] = signed >= 0 ? this.dict[signed] : stray(c);
        di = (di + 1) & 0xffff;
        left = (left - 1) & 0xffff;
      } else {
        let src = (di - c + 0x100) & 0xffff;
        const len = (code() + 3) & 0xffff;
        for (let i = 0; i < len; i++) {
          dst[di] = dst[src];
          di = (di + 1) & 0xffff;
          src = (src + 1) & 0xffff;
        }
        left = (left - len) & 0xffff;
      }
    } while (left !== 0);
    return e.usize;
  }
}

// ------------------------------------------------------------------------------------- NPK016 rows

/** Ring memory for npkRows: a 64 KiB segment and the ring's offset in it. */
export interface NpkRing {
  mem: Uint8Array;
  base: number;
}

/**
 * The NPK016 row decoder (GRPDRV AH=19h, and OPEN/END 0:06E4 into memory): `w` x `h` pixels from the
 * compressed stream at src:off (the entry + 0x30). Calls `row(y, planar)` with the row's interleaved
 * plane bytes (4 per 8 pixels). Same algorithm as formats/npk.ts decodeNpk, but with the size given
 * by the caller (damaged entries have no usable header), 16-bit offsets, and the 5-row ring in a
 * 64 KiB segment as in the original (0:06E4 keeps it on the stack, so copies that run past its end
 * land in the caller's frame).
 */
export function npkRows(
  src: Seg,
  off: number,
  w: number,
  h: number,
  row: (y: number, planar: Uint8Array) => void,
  ring: NpkRing = { mem: new Uint8Array(0x10000), base: 0 },
) {
  const RING = 0x640;
  const ROW = 0x140;
  const wpr = (w + 3) >> 2;
  const { mem, base } = ring;
  const R = (i: number) => mem[(base + i) & 0xffff];
  const W = (i: number, v: number) => (mem[(base + i) & 0xffff] = v);
  const planar = new Uint8Array(4 * ((wpr + 1) >> 1));
  let si = off & 0xffff;
  let di = 0;
  let al = 0;
  let ah = 0;
  const rd = () => {
    const v = src[si];
    si = (si + 1) & 0xffff;
    return v;
  };
  for (let y = 0; y < h; y++) {
    const start = di;
    let left = wpr;
    for (;;) {
      if (!ah) {
        al = rd();
        ah = 0xff;
      }
      const flag = al & 1;
      al = (al >> 1) | ((ah & 1) << 7);
      ah >>= 1;
      let n: number;
      if (!flag) {
        W(di, rd());
        W(di + 1, rd());
        di += 2;
        n = 1;
      } else {
        const b = rd();
        n = (b & 0x1f) + 1;
        let dist = (((b >> 5) & 3) + 1) * 2;
        if (b & 0x80) dist *= 0xa0;
        let s = di;
        if (dist > di) s += RING;
        s -= dist;
        for (let k = 0; k < 2 * n; k++) W(di++, R(s++));
      }
      if (left <= n) break;
      left -= n;
    }
    let p = start;
    let o = 0;
    for (let k = 0; k < wpr >> 1; k++) {
      const b0 = R(p), b1 = R(p + 1), b2 = R(p + 2), b3 = R(p + 3);
      p += 4;
      planar[o++] = ((b1 & 15) << 4) | (b3 & 15);
      planar[o++] = (b1 & 0xf0) | (b3 >> 4);
      planar[o++] = ((b0 & 15) << 4) | (b2 & 15);
      planar[o++] = (b0 & 0xf0) | (b2 >> 4);
    }
    if (wpr & 1) {
      const b0 = R(p), b1 = R(p + 1);
      planar[o++] = (b1 & 15) << 4;
      planar[o++] = b1 & 0xf0;
      planar[o++] = (b0 & 15) << 4;
      planar[o++] = b0 & 0xf0;
    }
    row(y, planar);
    di = start + ROW;
    if (di >= RING) di -= RING;
  }
}

// ------------------------------------------------------------------------------------- the machine

export interface CutsceneOptions {
  io: CutsceneIo;
  dg: Dgroup;
  archive: Ls11Archive;
  font: GameFont;
  /** DS offsets of the dissolve mask tables (OPEN DS:EA, 4 words, and DS:F2, 8 words). */
  mask16: number;
  mask64: number;
  /** DS offset of 0:06E4's ring buffer (a local of the script function). */
  ringAddr: number;
  /** The DGROUP memory model shared with the archive (see Cutscene.ds). */
  ds: Uint8Array;
}

export class Cutscene {
  readonly seg: Seg[] = Array.from({ length: 6 }, () => new Uint8Array(0x10000));
  /** DGROUP memory (data and stack), as far as it is known: the program's initialized data, plus what
   * this port writes there itself (0:06E4's ring). The LS11 loader reads stray bytes from it. */
  readonly ds: Uint8Array;
  /** DS:0x46, the palette last given to the DAC (fades step it in place). */
  cur: Rgb4[] = Array.from({ length: 16 }, () => [0, 0, 0] as Rgb4);
  /** GRPDRV AH=08h raster mode for puts (0 copy, 4 colour 0 transparent). */
  private ropMode = 0;
  /** GRPDRV AH=1Bh: 1-bit put mode, foreground, background. */
  private txt = [0, 7, 0];
  private t0 = 0;
  private cycleList: number[] = [];
  private cyclePos = 0;
  private cyclePeriod = 0;
  private cycleCount = 0;
  private last1c = 0;
  /** int 66h countdown target (absolute tick number). */
  private countdown = 0;
  readonly io: CutsceneIo;
  readonly dg: Dgroup;
  /** The open picture archive (END.EXE opens END1GRP.R3 or END2GRP.R3 per routine). */
  archive: Ls11Archive;

  constructor(private readonly o: CutsceneOptions) {
    this.io = o.io;
    this.dg = o.dg;
    this.archive = o.archive;
    this.ds = o.ds;
    // the program's initialized data (it ends well below the stack, where the archive object lives)
    this.ds.set(o.dg.exe.subarray(o.dg.base, Math.min(o.dg.exe.length, o.dg.base + 0x10000)));
    this.last1c = Math.floor(this.io.now() / INT1C_MS);
    this.t0 = this.io.now();
  }

  private get screen(): Screen {
    return this.io.screen;
  }

  // ---------------------------------------------------------------- time

  private tick(): number {
    return Math.floor(this.io.now() / TICK_MS);
  }

  /** One display frame; runs the int 1Ch palette-cycle callback for each int 1Ch that passed. */
  private async nextFrame() {
    await this.io.frame();
    const t = Math.floor(this.io.now() / INT1C_MS);
    for (; this.last1c < t; this.last1c++) this.cycleTick();
  }

  private checkSkip(skippable = true) {
    if (skippable && this.io.skip()) throw new Skip();
  }

  /** 0:7406: countdown of n ticks; a click ends it (Skip). */
  async ticks(n: number, skippable = true) {
    const end = this.tick() + n;
    while (this.tick() < end) {
      this.checkSkip(skippable);
      await this.nextFrame();
    }
  }

  /** GRPDRV AH=1Ah (END 0:2B0B): wait for the vertical retrace; here, the next display frame. */
  async vsync() {
    await this.nextFrame();
  }

  /** Milliseconds since resetTimer (the clock 0:9A74 / END 0:A9FA compare against). */
  get elapsed(): number {
    return this.io.now() - this.t0;
  }

  /** 0:990C: restart the elapsed-time clock (the callers also zero their target, DS:1564). */
  resetTimer() {
    this.t0 = this.io.now();
  }

  /** 0:9A74: wait until `cs` hundredths of a second have passed since resetTimer, then one tick. */
  async until(cs: number) {
    while (this.io.now() - this.t0 < cs * 10) {
      this.checkSkip();
      await this.nextFrame();
    }
    await this.ticks(1, false); // 0:9AAF: the result of this countdown is ignored
  }

  // ---------------------------------------------------------------- palettes

  pal(off: number): Rgb4[] {
    return this.dg.palette(off);
  }

  /** 0:75B0: set palette DS:off now. */
  setPal(off: number) {
    this.setPalette(this.pal(off));
  }

  setPalette(p: Rgb4[]) {
    this.cur = p.map((c) => [c[0], c[1], c[2]] as Rgb4);
    this.io.setPalette(this.cur);
  }

  /**
   * 0:744E: one fade step toward DS:off: every component moves by 1. Returns 0 when nothing changed
   * (palette set at once), 1 after a 4-tick wait, 2 when a click cut the wait short (skippable only).
   */
  async fadeStep(target: Rgb4[], skippable: boolean): Promise<number> {
    const end = this.tick() + 4;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      for (let k = 0; k < 3; k++) {
        const t = target[i][k];
        if (t < this.cur[i][k]) {
          this.cur[i][k]--;
          changed = true;
        } else if (t > this.cur[i][k]) {
          this.cur[i][k]++;
          changed = true;
        }
      }
    }
    if (changed) {
      while (this.tick() < end) {
        if (skippable && this.io.skip()) return 2;
        await this.nextFrame();
      }
    }
    this.io.setPalette(this.cur);
    return changed ? 1 : 0;
  }

  /** 0:753E: fade fully to DS:off (4 ticks a step). */
  async fadeTo(off: number, skippable = true) {
    const target = this.pal(off);
    for (;;) {
      const r = await this.fadeStep(target, skippable);
      if (r === 2) throw new Skip();
      if (r === 0) return;
    }
  }

  /** 0:2CC8: cycle through the zero-terminated palette list at DS:list every period + 1 int 1Ch ticks. */
  cycle(period: number, list: number) {
    this.cycleList = [];
    for (let p = list; this.dg.u16(p) !== 0 && this.cycleList.length < 32; p += 2) this.cycleList.push(this.dg.u16(p));
    this.cyclePeriod = period;
    this.cycleCount = 0;
    this.cyclePos = 0;
  }

  /** The cycle period byte DS:1569 halved in place (OPEN 0:6232). */
  halveCyclePeriod() {
    this.cyclePeriod >>= 1;
  }

  /** 0:2CF4 */
  cycleOff() {
    this.cycleList = [];
  }

  /** 0:2C86, the int 1Ch callback. */
  private cycleTick() {
    if (!this.cycleList.length) return;
    if (this.cycleCount) {
      this.cycleCount--;
      return;
    }
    this.cycleCount = this.cyclePeriod;
    if (this.cyclePos >= this.cycleList.length) this.cyclePos = 0;
    this.setPal(this.cycleList[this.cyclePos++]);
  }

  // ---------------------------------------------------------------- memory

  /** 0:9CC6 */
  load(entry: number, dst: Seg, off: number) {
    this.archive.load(entry, dst, off);
  }

  /** 0:8E50 */
  memset(dst: Seg, off: number, n: number, v: number) {
    for (let i = 0; i < n; i++) dst[(off + i) & 0xffff] = v;
  }

  /** 0:8D94 */
  memcpy(dst: Seg, doff: number, src: Seg, soff: number, n: number) {
    if (dst === src && doff > soff) {
      for (let i = n - 1; i >= 0; i--) dst[(doff + i) & 0xffff] = src[(soff + i) & 0xffff];
    } else for (let i = 0; i < n; i++) dst[(doff + i) & 0xffff] = src[(soff + i) & 0xffff];
  }

  /** 0:06E4: unpack the NPK016 entry at src:soff into dst:doff as an interleaved bitmap. */
  unpack(src: Seg, soff: number, dst: Seg, doff: number) {
    const w = src[(soff + 12) & 0xffff] | (src[(soff + 13) & 0xffff] << 8);
    const h = src[(soff + 14) & 0xffff] | (src[(soff + 15) & 0xffff] << 8);
    // A damaged entry (no NPK016 header) gives sizes like 24399 x 46974: the original then runs its
    // decoder over hundreds of megabytes, wrapping its output and overrunning its stack (the program
    // crashes after the opening). That is not reproduced; the destination is left as it is.
    if (src[soff & 0xffff] !== 0x4e || src[(soff + 1) & 0xffff] !== 0x50 || src[(soff + 2) & 0xffff] !== 0x4b) return;
    let o = doff;
    npkRows(
      src,
      soff + 0x30,
      w,
      h,
      (_y, planar) => {
        for (let i = 0; i < planar.length; i++) dst[(o + i) & 0xffff] = planar[i];
        o += planar.length;
      },
      { mem: this.ds, base: this.o.ringAddr },
    );
  }

  /**
   * 0:0288: memory-to-memory blit between interleaved bitmaps, clipped to the destination (0:024C);
   * x is taken in 8-pixel columns. Mode 0 copies, mode 4 leaves colour-0 pixels of the source out;
   * other modes draw nothing.
   */
  blit(dst: Seg, doff: number, dw: number, dh: number, x: number, y: number, sw: number, sh: number, mode: number, src: Seg, soff: number) {
    let cx0 = x >> 3;
    let y0 = y;
    const swc = sw >> 3;
    const dwc = dw >> 3;
    let cx1 = cx0 + swc - 1;
    let y1 = y + sh - 1;
    if (cx0 >= dwc || y0 >= dh || cx1 < 0 || y1 < 0) return;
    const skipC = cx0 < 0 ? -cx0 : 0;
    const skipR = y0 < 0 ? -y0 : 0;
    if (cx0 < 0) cx0 = 0;
    if (y0 < 0) y0 = 0;
    if (cx1 >= dwc) cx1 = dwc - 1;
    if (y1 >= dh) y1 = dh - 1;
    const cols = cx1 - cx0 + 1;
    const rows = y1 - y0 + 1;
    if ((mode & 0x7fff) !== 0 && (mode & 0x7fff) !== 4) return;
    for (let r = 0; r < rows; r++) {
      let d = (doff + ((y0 + r) * dwc + cx0) * 4) & 0xffff;
      let s = (soff + ((skipR + r) * swc + skipC) * 4) & 0xffff;
      for (let c = 0; c < cols; c++) {
        if (mode === 0) {
          for (let p = 0; p < 4; p++) dst[(d + p) & 0xffff] = src[(s + p) & 0xffff];
        } else {
          const m = ~(src[s] | src[(s + 1) & 0xffff] | src[(s + 2) & 0xffff] | src[(s + 3) & 0xffff]) & 0xff;
          for (let p = 0; p < 4; p++) dst[(d + p) & 0xffff] = (dst[(d + p) & 0xffff] & m) | src[(s + p) & 0xffff];
        }
        d = (d + 4) & 0xffff;
        s = (s + 4) & 0xffff;
      }
    }
  }

  /**
   * END 0:0AC7: blit a 1-bit source (rows of sw / 8 bytes) into an interleaved bitmap, clipped like
   * blit (0:024C). Mode 2 (0:0BAA) ANDs each source byte into the 4 plane bytes of its column; mode 4
   * (0:0BE5) ORs it in, except that it keeps AH from the jump-table index and flips it every byte, so
   * every second column first clears the destination; mode 0 (0:0B90) copies 4 source bytes per
   * column; modes 1 and 3 do nothing. After a clipped row the source skips (sw / 8 - columns) * 4
   * bytes, as the original does.
   */
  maskBlit(dst: Seg, doff: number, dw: number, dh: number, x: number, y: number, sw: number, sh: number, mode: number, src: Seg, soff: number) {
    let cx0 = x >> 3;
    let y0 = y;
    const swc = sw >> 3;
    const dwc = dw >> 3;
    let cx1 = cx0 + swc - 1;
    let y1 = y + sh - 1;
    if (cx0 >= dwc || y0 >= dh || cx1 < 0 || y1 < 0) return;
    const skipC = cx0 < 0 ? -cx0 : 0;
    const skipR = y0 < 0 ? -y0 : 0;
    if (cx0 < 0) cx0 = 0;
    if (y0 < 0) y0 = 0;
    if (cx1 >= dwc) cx1 = dwc - 1;
    if (y1 >= dh) y1 = dh - 1;
    const cols = cx1 - cx0 + 1;
    const rows = y1 - y0 + 1;
    const m = mode & 0x7fff;
    if (m !== 0 && m !== 2 && m !== 4) return;
    let s = (soff + skipR * swc + skipC) & 0xffff;
    const sskip = (swc - cols) * 4;
    let ah = 0;
    for (let r = 0; r < rows; r++) {
      let d = (doff + ((y0 + r) * dwc + cx0) * 4) & 0xffff;
      for (let c = 0; c < cols; c++) {
        if (m === 0) {
          for (let p = 0; p < 4; p++) dst[(d + p) & 0xffff] = src[(s + p) & 0xffff];
          s = (s + 4) & 0xffff;
        } else {
          const v = src[s];
          s = (s + 1) & 0xffff;
          if (m === 2) for (let p = 0; p < 4; p++) dst[(d + p) & 0xffff] &= v;
          else {
            const keep = ~ah & 0xff;
            for (let p = 0; p < 4; p++) dst[(d + p) & 0xffff] = (dst[(d + p) & 0xffff] & keep) | v;
            ah ^= 0xff;
          }
        }
        d = (d + 4) & 0xffff;
      }
      s = (s + sskip) & 0xffff;
    }
  }

  // ---------------------------------------------------------------- GRPDRV

  private plot(x: number, y: number, c: number) {
    y += ORIGIN_Y;
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    this.screen.pixels[y * WIDTH + x] = c;
  }

  /** GRPDRV AH=04h AL=1 (0:249E): clear the whole screen. */
  clearAll() {
    this.screen.clear(0);
  }

  /** GRPDRV AH=08h */
  rop(mode: number) {
    this.ropMode = mode;
  }

  /** GRPDRV AH=1Bh */
  textColor(mode: number, fg: number, bg: number) {
    this.txt = [mode, fg, bg];
  }

  /** GRPDRV AH=0Dh: filled box. */
  box(x: number, y: number, w: number, h: number, c: number) {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.plot(x + xx, y + yy, c);
    this.screen.dirty = true;
  }

  /** 0:73E2: g08(0) + box(0, 0, 640, 400, 0). */
  cls() {
    this.rop(0);
    this.box(0, 0, 640, 400, 0);
  }

  /** GRPDRV AH=0Fh: put an interleaved bitmap (AH=08h mode 4: colour 0 transparent). */
  put(x: number, y: number, w: number, h: number, src: Seg, off: number) {
    const rb = ((w + 7) >> 3) * 4;
    const transparent = this.ropMode === 4;
    for (let yy = 0; yy < h; yy++) {
      // GRPDRV's put leaves rows from 400 down untouched (END.EXE ending 3 puts 96x64 frames at y 340..356:
      // the emulator running the real put shows nothing below row 400; the clip code itself is not traced)
      if (y + yy >= 400) break;
      for (let xx = 0; xx < w; xx++) {
        const b = (off + yy * rb + (xx >> 3) * 4) & 0xffff;
        const bit = 7 - (xx & 7);
        const c =
          ((src[b] >> bit) & 1) |
          (((src[(b + 1) & 0xffff] >> bit) & 1) << 1) |
          (((src[(b + 2) & 0xffff] >> bit) & 1) << 2) |
          (((src[(b + 3) & 0xffff] >> bit) & 1) << 3);
        if (transparent) {
          if (c) this.plot(x + xx, y + yy, c);
        } else this.plot(x + xx, y + yy, this.ropMode ? this.combine(this.ropMode, x + xx, y + yy, c) : c);
      }
    }
    this.screen.dirty = true;
  }

  /** GRPDRV put modes (per-mode routines at GRPDRV 0:4047): 1 XOR 0:3CED, 2 AND 0:3C53, 3 OR 0:3D76, 5 NOT 0:3DFF. */
  private combine(mode: number, x: number, y: number, c: number): number {
    const sy = y + ORIGIN_Y;
    const d = x >= 0 && x < WIDTH && sy >= 0 && sy < HEIGHT ? this.screen.pixels[sy * WIDTH + x] : 0;
    if (mode === 1) return d ^ c;
    if (mode === 2) return d & c;
    if (mode === 3) return d | c;
    if (mode === 5) return ~c & 15;
    return c;
  }

  /**
   * END 0:0E26 (0:0DBC): copy an interleaved bitmap straight to VRAM at column `col`, row y (+0x27),
   * `cols` 8-pixel columns wide, ignoring the raster mode; nothing if it would leave the screen (0:0C2A).
   */
  putDirect(col: number, y: number, cols: number, h: number, src: Seg, off: number) {
    if (col >= 0x50 || !cols || col + cols > 0x50 || y >= 0x333 || !h || y + h >= 0x334) return;
    const mode = this.ropMode;
    this.ropMode = 0;
    this.put(col * 8, y, cols * 8, h, src, off);
    this.ropMode = mode;
  }

  /** GRPDRV AH=10h: read the screen into an interleaved bitmap. */
  get(x: number, y: number, w: number, h: number, dst: Seg, off: number) {
    const rb = ((w + 7) >> 3) * 4;
    for (let i = 0; i < rb * h; i++) dst[(off + i) & 0xffff] = 0;
    for (let yy = 0; yy < h; yy++) {
      const sy = y + yy + ORIGIN_Y;
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        const c = sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT ? this.screen.pixels[sy * WIDTH + sx] : 0;
        const b = off + yy * rb + (xx >> 3) * 4;
        const m = 0x80 >> (xx & 7);
        for (let p = 0; p < 4; p++) if ((c >> p) & 1) dst[(b + p) & 0xffff] |= m;
      }
    }
  }

  /** GRPDRV AH=19h: draw the NPK016 stream at src:off (entry + 0x30). */
  npk(x: number, y: number, w: number, h: number, src: Seg, off: number) {
    npkRows(src, off, w, h, (yy, planar) => {
      for (let xx = 0; xx < w; xx++) {
        const b = (xx >> 3) * 4;
        const bit = 7 - (xx & 7);
        const c =
          ((planar[b] >> bit) & 1) |
          (((planar[b + 1] >> bit) & 1) << 1) |
          (((planar[b + 2] >> bit) & 1) << 2) |
          (((planar[b + 3] >> bit) & 1) << 3);
        this.plot(x + xx, y + yy, c);
      }
    });
    this.screen.dirty = true;
  }

  /** GRPDRV AH=13h: 1-bit bitmap, rows of (w + 7) / 8 bytes, colours from AH=1Bh (mode 4: no background). */
  bits(x: number, y: number, w: number, h: number, src: Seg, off: number) {
    const rb = (w + 7) >> 3;
    const [mode, f, b] = this.txt;
    // GRPDRV 0:4431: VGA write mode 3 with the function select of table 0:2F66 (1 XOR, 2 AND, 3 OR);
    // mode 4 leaves the background out, mode 5 swaps the colours (0:44DD)
    const fg = mode === 5 ? b : f;
    const bg = mode === 5 ? f : b;
    const fn = mode >= 1 && mode <= 3 ? mode : 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const on = (src[(off + yy * rb + (xx >> 3)) & 0xffff] >> (7 - (xx & 7))) & 1;
        if (!on && mode === 4) continue;
        const c = on ? fg : bg;
        this.plot(x + xx, y + yy, fn ? this.combine(fn, x + xx, y + yy, c) : c);
      }
    }
    this.screen.dirty = true;
  }

  /**
   * White caption with a black outline, as every caller of 0:7D10 draws it: the 1-bit bitmap in colour 0
   * at (x-1, y), (x+1, y), (x, y-1), (x, y+1), then in colour 7 at (x, y), background transparent.
   */
  outline(x: number, y: number, w: number, h: number, src: Seg, off: number) {
    this.textColor(4, 0, 0);
    this.bits(x - 1, y, w, h, src, off);
    this.bits(x + 1, y, w, h, src, off);
    this.bits(x, y - 1, w, h, src, off);
    this.bits(x, y + 1, w, h, src, off);
    this.textColor(4, 7, 0);
    this.bits(x, y, w, h, src, off);
  }

  /** Music (OPEN 0:8806 + 0:88B8, END 0:978C): play an entry; repeat is on unless turned off. */
  song(index: number, repeat: boolean) {
    this.io.music?.play(index, repeat);
  }

  /** Music fade (OPEN 0:8880). */
  musicFade(speed: number) {
    this.io.music?.fadeOut(speed);
  }

  // ---------------------------------------------------------------- transitions

  /** 0:744E or 0:7406 between the steps of a transition; throws Skip on a click. */
  private async between(fadePal: number) {
    if (fadePal) {
      if ((await this.fadeStep(this.pal(fadePal), true)) === 2) throw new Skip();
    } else await this.ticks(1);
  }

  /**
   * 0:78DE (16 steps, mask step 0:76BC) / 0:7966 (64 steps, 0:77CC): ordered dissolve of src into work,
   * put at (x, y) after each step. Step i takes k = i*7 mod 16 (i*23 mod 64), mask word DS:mask[k mod 4
   * (8)] and every 4th (8th) row from row k / 4 (k / 8); work = mask & work | ~mask & src per 2 words.
   */
  async dissolve(steps: 16 | 64, x: number, y: number, w: number, h: number, work: Seg, woff: number, src: Seg, soff: number, fadePal = 0) {
    for (let i = 0; i < steps; i++) {
      this.step(steps, i, w, h, work, woff, src, soff);
      await this.between(fadePal);
      this.put(x, y, w, h, work, woff);
    }
  }

  /** One step of the dissolve (0:76BC / 0:77CC, END 0:8642 / 0:8752), which scripts also call directly. */
  step(steps: 16 | 64, i: number, w: number, h: number, work: Seg, woff: number, src: Seg, soff: number) {
    const group = steps === 16 ? 4 : 8;
    const mul = steps === 16 ? 7 : 0x17;
    const table = steps === 16 ? this.o.mask16 : this.o.mask64;
    const cols = w >> 3;
    const rb = cols * 4;
    const k = (i * mul) % steps;
    const mask = this.dg.u16(table + (k % group) * 2);
    const lo = mask & 0xff, hi = mask >> 8;
    const n = Math.floor(h / group);
    for (let r = 0; r < n; r++) {
      const base = ((Math.floor(k / group) + r * group) * rb) & 0xffff;
      for (let c = 0; c < cols; c++) {
        for (let p = 0; p < 4; p++) {
          const m = p & 1 ? hi : lo;
          const a = (woff + base + c * 4 + p) & 0xffff;
          const b = (soff + base + c * 4 + p) & 0xffff;
          work[a] = (m & work[a]) | (~m & src[b] & 0xff);
        }
      }
    }
  }

  async diss16(x: number, y: number, w: number, h: number, work: Seg, woff: number, src: Seg, soff: number, fadePal = 0) {
    return this.dissolve(16, x, y, w, h, work, woff, src, soff, fadePal);
  }

  async diss64(x: number, y: number, w: number, h: number, work: Seg, woff: number, src: Seg, soff: number, fadePal = 0) {
    return this.dissolve(64, x, y, w, h, work, woff, src, soff, fadePal);
  }

  /** 0:79EE: copy rows r and h-r-1 of src into work, 4*w bytes (8 rows) each, as the original does. */
  private wipeRows(w: number, h: number, r: number, work: Seg, woff: number, src: Seg, soff: number) {
    const rb = (w >> 3) * 4;
    const n = w * 4;
    this.memcpy(work, (woff + rb * r) & 0xffff, src, (soff + rb * r) & 0xffff, n);
    const o = ((h - r - 1) * rb) & 0xffff;
    this.memcpy(work, (woff + o) & 0xffff, src, (soff + o) & 0xffff, n);
  }

  private putRows(x: number, y: number, w: number, r: number, work: Seg, woff: number) {
    const off = (woff + Math.floor((r * w) / 8) * 4) & 0xffff;
    this.put(x, y + r, w, 2, work, off);
  }

  /** 0:7B92: wipe from the middle row pair outwards, two rows per tick at each side. */
  async wipe1(x: number, y: number, w: number, h: number, work: Seg, woff: number, src: Seg, soff: number, fadePal = 0) {
    for (let si = h >> 1; si > 0; ) {
      si -= 2;
      this.wipeRows(w, h, si + 1, work, woff, src, soff);
      this.wipeRows(w, h, si, work, woff, src, soff);
      await this.between(fadePal);
      this.putRows(x, y, w, si, work, woff);
      this.putRows(x, y, w, h - si - 2, work, woff);
    }
  }

  /** 0:7A5A: wipe from the top and bottom edges inwards. */
  async wipe2(x: number, y: number, w: number, h: number, work: Seg, woff: number, src: Seg, soff: number, fadePal = 0) {
    const n = h >> 1;
    for (let si = 0; si < n; si += 2) {
      this.wipeRows(w, h, si, work, woff, src, soff);
      this.wipeRows(w, h, si + 1, work, woff, src, soff);
      await this.between(fadePal);
      this.putRows(x, y, w, si, work, woff);
      this.putRows(x, y, w, h - si - 2, work, woff);
    }
  }

  // ---------------------------------------------------------------- captions

  /** Bold glyph rows as 0:7D10 / 0:8120 build them: [b0 | b0>>1, b0<<7 | b1>>1 | b1, b1<<7] per row. */
  private boldGlyph(text: Uint8Array, i: number): { rows: number[][]; adv: number; next: number } {
    const c = text[i];
    if (c >= 0xa1) {
      const code = (c << 8) | (text[i + 1] ?? 0);
      const g = code >= 0xa1a1 && code <= 0xfdfe ? this.o.font.glyph(code).bits : new Uint8Array(32);
      const rows: number[][] = [];
      for (let r = 0; r < 16; r++) {
        const b0 = g[r * 2], b1 = g[r * 2 + 1];
        rows.push([b0 | (b0 >> 1), ((b0 << 7) & 0xff) | (b1 >> 1) | b1, (b1 << 7) & 0xff]);
      }
      return { rows, adv: 2, next: i + 2 };
    }
    const g = this.o.font.glyph(c).bits;
    const rows: number[][] = [];
    for (let r = 0; r < 16; r++) rows.push([g[r] | (g[r] >> 1), (g[r] << 7) & 0xff]);
    return { rows, adv: 1, next: i + 1 };
  }

  /**
   * 0:7D10: render the caption list at DS:list into a 1-bit bitmap at dst:off. Width (bytes) is the
   * longest line + 2; lines are 20 rows apart from row `top` (second stack word), text from byte 1.
   * Returns the width in bytes and the height (20 * lines + extra + top).
   */
  text1(list: number, extra: number, top: number, dst: Seg, off: number): { width: number; height: number } {
    const lines = this.dg.list(list);
    const width = Math.max(0, ...lines.map((l) => l.length)) + 2;
    const height = 20 * lines.length + extra + top;
    this.memset(dst, off, (height * width) & 0xffff, 0);
    lines.forEach((text, j) => {
      let d = off + width * (top + 20 * j) + 1;
      for (let i = 0; i < text.length && text[i] !== 0; ) {
        const g = this.boldGlyph(text, i);
        for (let r = 0; r < 16; r++) g.rows[r].forEach((v, k) => (dst[(d + r * width + k) & 0xffff] |= v));
        d += g.adv;
        i = g.next;
      }
    });
    return { width, height };
  }

  /**
   * 0:8120: the same captions as an interleaved 4-plane bitmap in the planes of `planes` (colour), on
   * black; rows are width * 4 bytes, text from column 1, lines 20 rows apart from row `top`.
   */
  text2(list: number, top: number, planes: number, dst: Seg, off: number): { width: number; height: number } {
    const lines = this.dg.list(list);
    const width = Math.max(0, ...lines.map((l) => l.length)) + 2;
    const height = 20 * lines.length + top;
    this.memset(dst, off, (height * width * 4) & 0xffff, 0);
    const rb = width * 4;
    lines.forEach((text, j) => {
      let d = off + rb * (top + 20 * j) + 4;
      for (let i = 0; i < text.length && text[i] !== 0; ) {
        const g = this.boldGlyph(text, i);
        for (let r = 0; r < 16; r++) {
          g.rows[r].forEach((v, k) => {
            for (let p = 0; p < 4; p++) if (planes & (1 << p)) dst[(d + r * rb + k * 4 + p) & 0xffff] |= v;
          });
        }
        d += g.adv * 4;
        i = g.next;
      }
    });
    return { width, height };
  }
}
