// NPK016 pictures, checked against OPEN.EXE's own decoder run by tools/npk_ref.py.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unpackLs11 } from '../src/formats/ls11';
import { decodeNpk, isNpk, parseNpkHeader } from '../src/formats/npk';
import { GAME_DIR, gameFile, hasGame } from './gamedir';

function reference(entries: Uint8Array[]): (string | null)[] | null {
  try {
    const out = execFileSync('python3', ['-I', join(__dirname, '../../tools/npk_ref.py'), GAME_DIR], {
      input: JSON.stringify(entries.map((e) => Buffer.from(e).toString('hex'))),
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 << 20,
    });
    return JSON.parse(out) as (string | null)[];
  } catch {
    return null; // python3 / unicorn unavailable
  }
}

describe.skipIf(!hasGame)('NPK016', () => {
  it('finds the pictures in the ending archives', () => {
    const end1 = unpackLs11(gameFile('END1GRP.R3'));
    const npk = end1.flatMap((e, i) => (isNpk(e) ? [i] : []));
    expect(npk).toEqual([0, 19, 33, 38, 39, 47, 48, 55, 68]);
    expect(parseNpkHeader(end1[19])).toMatchObject({ screenWidth: 640, screenHeight: 400, width: 544, height: 176 });
  });

  it('decodes exactly like OPEN.EXE 0x06E4', (ctx) => {
    const end1 = unpackLs11(gameFile('END1GRP.R3'));
    const end2 = unpackLs11(gameFile('END2GRP.R3'));
    const cases = [end1[0], end1[19], end1[39], end1[47], end1[68], end2[0], end2[10]];
    const want = reference(cases);
    if (!want) return ctx.skip(); // needs python3 with unicorn
    const got = cases.map((e) => Buffer.from(decodeNpk(e).planar).toString('hex'));
    expect(want.every((w) => w !== null)).toBe(true);
    expect(got).toEqual(want);
  }, 900_000);
});
