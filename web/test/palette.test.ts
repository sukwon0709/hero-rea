// Palette table and GRPDRV fade, checked against the original GRPDRV.EXE run by tools/palette_ref.py.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLACK, fadeSteps, readMainPalettes, toDac, toDigital8, type Rgb4 } from '../src/formats/palette';
import { GAME_DIR, gameFile, hasGame } from './gamedir';

const brgHex = (pal: Rgb4[]) => pal.map(([r, g, b]) => [b, r, g].map((v) => v.toString(16).padStart(2, '0')).join('')).join('');

function grpdrvFade(from: Rgb4[], to: Rgb4[], steps: number): number[][][] | null {
  try {
    const out = execFileSync(
      'python3',
      ['-I', join(__dirname, '../../tools/palette_ref.py'), GAME_DIR, brgHex(from), brgHex(to), String(steps)],
      { encoding: 'utf8', timeout: 120_000 },
    );
    return (JSON.parse(out) as { steps: number[][][] }).steps;
  } catch {
    return null; // python3 / unicorn unavailable
  }
}

describe('palette', () => {
  it('reduces to the digital 8 colours', () => {
    expect(toDigital8([[15, 15, 15], [0, 0, 0], [15, 0, 0], [0, 0, 15]])).toEqual([
      [15, 15, 15],
      [0, 0, 0],
      [15, 0, 0], // Y = (15*0x12B + 0x42F) / 0x85E = 2: red
      [0, 0, 15], // Y = (15*0x72 + 0x42F) / 0x85E = 1: blue
    ]);
  });

  describe.skipIf(!hasGame)('with game files', () => {
    const pals = hasGame ? readMainPalettes(gameFile('MAIN.EXE')) : [];

    it('reads the 9 palettes of MAIN.EXE', () => {
      expect(pals.length).toBe(9);
      // entries 0-7 are the shared UI colours except in palette 4, the PC-98 digital palette
      for (const n of [0, 1, 2, 3, 5, 6, 7, 8]) expect(pals[n].slice(0, 8)).toEqual(pals[0].slice(0, 8));
      expect(pals[4].slice(8)).toEqual(pals[4].slice(0, 8));
      expect(pals[5]).toEqual(pals[8]);
      expect(toDac(pals[4])[7]).toEqual([63, 63, 63]);
    });

    it('fades exactly like GRPDRV AH=16h', (ctx) => {
      for (const [from, to, steps] of [
        [pals[0], pals[3], 16],
        [pals[2], BLACK, 16],
        [BLACK, pals[5], 7],
        [pals[1], pals[4], 3],
      ] as [Rgb4[], Rgb4[], number][]) {
        const want = grpdrvFade(from, to, steps);
        if (!want) return ctx.skip(); // needs python3 with unicorn
        expect(fadeSteps(from, to, steps)).toEqual(want);
      }
    }, 600_000);
  });
});
