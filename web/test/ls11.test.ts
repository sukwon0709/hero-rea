import { describe, expect, it } from 'vitest';
import { unpackLs11, isLs11 } from '../src/formats/ls11';
import { gameFile, hasGame } from './gamedir';

describe.skipIf(!hasGame)('ls11', () => {
  it('unpacks HEXBMAP.R3', () => {
    const d = gameFile('HEXBMAP.R3');
    expect(isLs11(d)).toBe(true);
    const parts = unpackLs11(d);
    expect(parts.map((p) => p.length)).toEqual([230, 230, 230, 230, 230, 528, 528, 528, 528]);
  });
  it('unpacks the little-endian Ls11 variant', () => {
    const parts = unpackLs11(gameFile('END2GRP.R3'));
    expect(parts.length).toBe(25);
    expect(parts[0].length).toBe(23412);
  });
});
