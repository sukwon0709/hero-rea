// Palettes: MAIN.EXE's palette table and GRPDRV's palette / fade functions (see docs/GRAPHICS.md, "Palettes").
//
// GRPDRV keeps 16 entries of 4 bits per channel. MAIN.EXE stores them as [B, R, G] byte triples (the PC-98
// order). Setting an entry converts each 4-bit value v to the 6-bit VGA DAC value (v << 2) | (v >> 2).

/** One palette entry, 4 bits per channel (0..15), in R, G, B order. */
export type Rgb4 = [number, number, number];
/** One VGA DAC entry, 6 bits per channel (0..63), in R, G, B order. */
export type Rgb6 = [number, number, number];

/** MAIN.EXE DGROUP image segment (DS offset X is at file offset header + 0x313A0 + X). */
export const MAIN_DGROUP_SEG = 0x313a;
/** DS offset of the palette table: 9 palettes x 16 entries x [B, R, G] (0cf5:497E reads 0x1050 + 0x30 * n). */
export const PALETTE_TABLE = 0x1050;
export const PALETTE_COUNT = 9;

/**
 * Known uses of the palette table entries. Entries 0..3 are the scene palettes: 0cf5:49F6 sets palette
 * ([DS:7A6C+5] & 0xF), the location mode written by 0cf5:ACD8 (0 at 0cf5:12869, 1 at 0cf5:E791, 2 at
 * 0cf5:128B7, 3 at 0cf5:C833). Palette 2 is verified pixel-exact on a palace screen; 0, 1 and 3 follow
 * from the code path only.
 */
export const PAL = {
  /** Mode 0: town (SMAP rooms). */
  town: 0,
  /** Mode 1: world map (MMAP). */
  worldMap: 1,
  /** Mode 2: palace / indoor (PMAP rooms). */
  palace: 2,
  /** Mode 3: battle. */
  battle: 3,
  /** The PC-98 digital 8-colour palette; set after PACKGRP pictures such as 0cf5:AA80. */
  digital: 4,
  /** Camp scenes; palettes 5 and 8 are identical. */
  camp: 5,
} as const;

/** Parses `count` [B, R, G] triples (MAIN.EXE / GRPDRV AH=15h layout) into R, G, B entries. */
export function parseBrg(data: Uint8Array, offset = 0, count = 16): Rgb4[] {
  const out: Rgb4[] = [];
  for (let i = 0; i < count; i++) {
    const p = offset + 3 * i;
    out.push([data[p + 1] & 0xf, data[p + 2] & 0xf, data[p] & 0xf]);
  }
  return out;
}

/** Reads the 9 palettes of MAIN.EXE (DS:1050). */
export function readMainPalettes(mainExe: Uint8Array): Rgb4[][] {
  const header = (mainExe[8] | (mainExe[9] << 8)) * 16;
  const base = header + MAIN_DGROUP_SEG * 16 + PALETTE_TABLE;
  return Array.from({ length: PALETTE_COUNT }, (_, n) => parseBrg(mainExe, base + 48 * n));
}

/** GRPDRV 0:28CD: 4-bit palette value to 6-bit DAC value. */
export function scale4to6(v: number): number {
  return ((v << 2) | (v >> 2)) & 0x3f;
}

/** 6-bit DAC value to 8 bits per channel, as a VGA/DOSBox display shows it. */
export function dac6to8(v: number): number {
  return (v << 2) | (v >> 4);
}

export function toDac(pal: Rgb4[]): Rgb6[] {
  return pal.map((c) => [scale4to6(c[0]), scale4to6(c[1]), scale4to6(c[2])] as Rgb6);
}

/** Packs a DAC palette as 0xAABBGGRR words (little-endian canvas RGBA). */
export function dacToRgba(dac: Rgb6[]): Uint32Array {
  const out = new Uint32Array(dac.length);
  dac.forEach((c, i) => (out[i] = 0xff000000 | (dac6to8(c[2]) << 16) | (dac6to8(c[1]) << 8) | dac6to8(c[0])));
  return out;
}

export function paletteToRgba(pal: Rgb4[]): Uint32Array {
  return dacToRgba(toDac(pal));
}

/** CSS colour string of a 4-bit entry. */
export function cssColor(c: Rgb4): string {
  const [r, g, b] = c.map((v) => dac6to8(scale4to6(v)));
  return `rgb(${r},${g},${b})`;
}

/**
 * GRPDRV AH=16h (0:2924): fades from the current palette to `to` in `steps` steps and returns the DAC
 * contents after each step (the last one equals toDac(to)). Every step interpolates from the starting
 * values, per channel: q = floor(|t - c| * k / steps), value = t >= c ? c + q : c - q (6-bit c, t).
 * The driver waits `waits` vertical retraces (0:3005) before each step; MAIN uses 16 steps, 2 waits
 * (0cf5:497E), so a full fade lasts 32 frames.
 */
export function fadeSteps(from: Rgb4[], to: Rgb4[], steps: number): Rgb6[][] {
  const out: Rgb6[][] = [];
  for (let k = 1; k <= steps; k++) {
    out.push(
      from.map((fc, i) =>
        fc.map((f, ch) => {
          const c = scale4to6(f);
          const t = scale4to6(to[i][ch]);
          const q = Math.floor((Math.abs(t - c) * k) / steps) & 0xff;
          return t >= c ? c + q : c - q;
        }) as Rgb6,
      ),
    );
  }
  return out;
}

/** The PC-98 digital colours indexed by luminance level 0..7 (DS:0CFE, [B,R,G] triples). */
export const DIGITAL8: Rgb4[] = [
  [0, 0, 0],
  [0, 0, 15],
  [15, 0, 0],
  [15, 0, 15],
  [0, 15, 0],
  [0, 15, 15],
  [15, 15, 0],
  [15, 15, 15],
];

/**
 * 0cf5:4910: reduces a palette to the 8 digital colours by luminance,
 * Y = (B*0x72 + G*0x24B + R*0x12B + 0x42F) / 0x85E (0..7), colour = DIGITAL8[Y].
 * 0cf5:497E applies it only when bit 3 of the word at DS:7A8A is clear and the palette is not all
 * zero; on VGA that bit is set (inferred from the emulator, which shows full colour).
 */
export function toDigital8(pal: Rgb4[]): Rgb4[] {
  return pal.map(([r, g, b]) => {
    const y = Math.trunc((b * 0x72 + g * 0x24b + r * 0x12b + 0x42f) / 0x85e);
    const d = DIGITAL8[y];
    return [d[0], d[1], d[2]] as Rgb4;
  });
}

/** A fade to black (0cf5:4A22 fades all 16 entries to zero). */
export const BLACK: Rgb4[] = Array.from({ length: 16 }, () => [0, 0, 0] as Rgb4);

/**
 * END.EXE's palette table: 43 x 16 [B, R, G] entries at load-image offset 0xC058 (found by content: entry 1
 * colours END1GRP.R3 picture 19 exactly as the emulator shows it; entry 31 equals MAIN palette 0 and
 * entries 29 and 33 equal MAIN palette 2). Which picture END.EXE shows with which entry is not traced.
 */
export const END_PALETTE_TABLE = 0xc058;
export const END_PALETTE_COUNT = 43;

export function readEndPalettes(endExe: Uint8Array): Rgb4[][] {
  const base = (endExe[8] | (endExe[9] << 8)) * 16 + END_PALETTE_TABLE;
  if (base + 48 * END_PALETTE_COUNT > endExe.length) return [];
  return Array.from({ length: END_PALETTE_COUNT }, (_, n) => parseBrg(endExe, base + 48 * n));
}
