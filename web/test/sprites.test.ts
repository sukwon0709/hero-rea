// Bitmap decoders and blit modes, checked against MAIN.EXE's own blitters run by tools/blit_ref.py,
// plus structural checks of the sprite banks.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unpackLs11 } from '../src/formats/ls11';
import {
  MARK_REGIONS,
  decodeCell,
  decodeInterleaved,
  decodeSsc2,
  markImageBytes,
  readWorldMaps,
  squareFrame,
  parseSsc1,
  unitFrames,
  type IndexedImage,
} from '../src/formats/sprites';
import { blit1, blit2, dilate } from '../src/formats/font';
import { GAME_DIR, gameFile, hasGame } from './gamedir';

interface Case {
  fn: string;
  data: string;
  x: number;
  y: number;
  w: number;
  h: number;
  arg?: number;
  fill?: number;
}

function reference(cases: Case[]): string[] | null {
  try {
    const out = execFileSync('python3', ['-I', join(__dirname, '../../tools/blit_ref.py'), GAME_DIR], {
      input: JSON.stringify(cases),
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 64 << 20,
    });
    return JSON.parse(out) as string[];
  } catch {
    return null; // python3 / unicorn unavailable
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s >>> 24;
  };
}

const random = (n: number, r: () => number) => Uint8Array.from({ length: n }, r);

describe.skipIf(!hasGame)('sprites', () => {
  it('parses every SSCCHR1 entry exactly', () => {
    for (const e of unpackLs11(gameFile('SSCCHR1.R3'))) {
      const bank = parseSsc1(e);
      const used = 1 + bank.sprites.reduce((a, s) => a + 2 + s.w * s.h, 0) + 1 + bank.cells.length * 128;
      expect(used).toBe(e.length);
    }
  });

  it('splits SSCCHR2 and HEXZCHR entries', () => {
    const ssc2 = unpackLs11(gameFile('SSCCHR2.R3'));
    expect(ssc2.length).toBe(29);
    expect(ssc2.every((e) => decodeSsc2(e).length === 4)).toBe(true);
    const z = unpackLs11(gameFile('HEXZCHR.R3'));
    expect(z.length).toBe(47);
    expect(unitFrames(z[0]).map((d) => d.length)).toEqual([2, 2, 2, 2]);
  });

  it('sizes close-up frames and world maps', () => {
    const b = unpackLs11(gameFile('HEXBCHR.R3'));
    expect(b.map((e) => squareFrame(e).width)).toEqual([...Array(169).fill(64), ...Array(12).fill(48)]);
    expect(unpackLs11(gameFile('HEXICHR.R3')).every((e) => squareFrame(e).width === 96)).toBe(true);
    const mmap = unpackLs11(gameFile('MMAP.R3'));
    const maps = readWorldMaps(gameFile('MAIN.EXE'));
    expect(maps.map((m) => m.entry)).toEqual([0, 0, 1, 2, 3]);
    for (const m of maps) expect(mmap[m.entry].length).toBe(m.width * m.height + ((m.width / 2) * (m.height / 2)) / 8);
  });

  it('keeps MARK regions inside the entry and apart', () => {
    const mark = unpackLs11(gameFile('MARK.R3'))[0];
    expect(mark.length).toBe(14584);
    const spans = MARK_REGIONS.map((r) => [r.offset, r.offset + r.count * markImageBytes(r)]).sort((a, b) => a[0] - b[0]);
    spans.forEach(([a, b], i) => {
      expect(b).toBeLessThanOrEqual(mark.length);
      if (i) expect(a).toBeGreaterThanOrEqual(spans[i - 1][1]);
    });
  });

  it('decodes and blits exactly like MAIN.EXE', (ctx) => {
    const r = rng(1234);
    const cell = unpackLs11(gameFile('HEXZCHR.R3'))[3].subarray(128, 256);
    const mark = unpackLs11(gameFile('MARK.R3'))[0];
    const i4 = mark.subarray(0x19f0, 0x19f0 + 480); // 48x20 button
    const i3 = mark.subarray(0, 216); // 24x24 icon
    const rnd4 = random(4 * 3 * 10, r);
    const bits = random(32, r);
    const cases: Case[] = [
      { fn: 'cell', data: hex(cell), x: 32, y: 16, w: 16, h: 16 },
      { fn: 'cell', data: hex(random(128, r)), x: 8, y: 3, w: 16, h: 16 },
      { fn: 'i4', data: hex(i4), x: 16, y: 5, w: 48, h: 20, arg: 0 },
      { fn: 'i3', data: hex(i3), x: 0, y: 0, w: 24, h: 24, arg: 0, fill: 12 },
      { fn: 'tile', data: hex(mark.subarray(0x6f0, 0x770)), x: 16, y: 0, w: 16, h: 16, arg: 15 },
      ...[0, 1, 2, 3, 4].map((m) => ({ fn: 'i4', data: hex(rnd4), x: 8, y: 1, w: 24, h: 10, arg: m, fill: 10 })),
      ...[0, 1, 2, 3, 4].map((m) => ({ fn: 'bits', data: hex(bits), x: 8, y: 2, w: 16, h: 16, arg: (m << 8) | 13, fill: 6 })),
      { fn: 'bits', data: hex(bits), x: 0, y: 0, w: 16, h: 16, arg: 0x8405, fill: 2 }, // doubled rows (8 source rows)
      { fn: 'bits2', data: hex(bits), x: 0, y: 0, w: 16, h: 16, arg: 0x0905 },
      { fn: 'dilate', data: hex(bits), x: 0, y: 0, w: 0, h: 0, arg: 2 },
      { fn: 'dilate', data: hex(bits.subarray(0, 16)), x: 0, y: 0, w: 0, h: 0, arg: 1 },
    ];
    const want = reference(cases);
    if (!want) return ctx.skip(); // needs python3 with unicorn
    const filled = (w: number, h: number, c: number): IndexedImage => ({ width: w, height: h, pixels: new Uint8Array(w * h).fill(c) });
    const got: string[] = [];
    got.push(hex(decodeCell(cell)));
    got.push(hex(decodeCell(Buffer.from(cases[1].data, 'hex'))));
    got.push(hex(decodeInterleaved(i4, 0, 48, 20).pixels));
    got.push(hex(decodeInterleaved(i3, 0, 24, 24, 3).pixels));
    got.push(hex(decodeInterleaved(mark, 0x6f0, 16, 16).pixels));
    for (const m of [0, 1, 2, 3, 4]) {
      const src = decodeInterleaved(rnd4, 0, 24, 10).pixels;
      // modes as the 1-bit blitter, applied per plane byte: AND/OR/XOR with the latched screen
      got.push(hex(src.map((c) => [c, c ^ 10, c & 10, c | 10, c ? c : 10][m])));
    }
    for (const m of [0, 1, 2, 3, 4]) {
      const img = filled(16, 16, 6);
      blit1(img, 0, 0, bits, 2, 16, 13, m);
      got.push(hex(img.pixels));
    }
    {
      const img = filled(16, 16, 2);
      blit1(img, 0, 0, bits, 2, 8, 5, 0x84);
      got.push(hex(img.pixels));
    }
    {
      const img = filled(16, 16, 0);
      blit2(img, 0, 0, bits, 2, 16, 5, 9);
      got.push(hex(img.pixels));
    }
    got.push(hex(dilate(bits, 2)));
    got.push(hex(dilate(bits.subarray(0, 16), 1)));
    expect(got).toEqual(want);
  }, 600_000);
});
