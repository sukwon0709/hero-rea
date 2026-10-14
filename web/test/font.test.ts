import { describe, expect, it } from 'vitest';
import { GameFont, TextConsole, dilate, embolden, ksIndex, parseFontR3, readGaijiCodes, renderText } from '../src/formats/font';
import type { IndexedImage } from '../src/formats/sprites';
import { gameFile, hasGame } from './gamedir';

describe('font', () => {
  it('dilates like 0000:84A4', () => {
    const bits = new Uint8Array(32);
    bits[5 * 2] = 0x01; // pixel (7, 5)
    bits[15 * 2 + 1] = 0x01; // pixel (15, 15): growth past the box is lost
    const d = dilate(bits, 2);
    const at = (x: number, y: number) => (d[y * 2 + (x >> 3)] >> (7 - (x & 7))) & 1;
    for (let y = 4; y <= 6; y++) for (let x = 6; x <= 8; x++) expect(at(x, y)).toBe(1);
    expect(at(5, 5) + at(9, 5) + at(7, 3) + at(7, 7)).toBe(0);
    expect(at(14, 14) + at(15, 14) + at(14, 15)).toBe(3);
  });

  it('emboldens across the byte boundary', () => {
    expect([...embolden(Uint8Array.from([0x81, 0x01, 0x40, 0x00]), 2)]).toEqual([0xc1, 0x81, 0x60, 0x00]);
  });

  it('pairs EUC-KR bytes, wraps and advances like 0cf5:0A2E', () => {
    const font = new GameFont(null, null); // missing files draw solid blocks
    const img: IndexedImage = { width: 64, height: 64, pixels: new Uint8Array(64 * 64) };
    const con = new TextConsole(font, img, { fg: 5, mode: 4, right: 3 });
    con.write([0xb0, 0xa1, 0x41]); // '가' (2 columns) then 'A'
    expect([con.s.x, con.s.y]).toEqual([3, 0]);
    expect(img.pixels[13 * 64 + 15]).toBe(5); // last row of a 14-row Hangul glyph
    expect(img.pixels[14 * 64 + 0]).toBe(0);
    con.write([0xb0, 0xa1]); // x = 3 > right - 1: wraps to the next line (pitch 18)
    expect([con.s.x, con.s.y]).toEqual([2, 18]);
    con.write([0x0d, 0x20, 0x42]); // CR swallows one following space
    expect(con.s.x).toBe(1);
    con.write([0x1b, 0x3d, 0x22, 0x21]); // ESC = row 2 (16 px), column 1
    expect([con.s.x, con.s.y]).toEqual([1, 16]);
  });

  describe.skipIf(!hasGame)('with game files', () => {
    it('indexes every ALL_FONT.16P record by its code', () => {
      const all = gameFile('ALL_FONT.16P');
      expect(all.length).toBe(3478 * 30);
      for (let i = 0; i < 3478; i++) expect(ksIndex(all[i * 30] | (all[i * 30 + 1] << 8))).toBe(i);
    });

    it('renders text', () => {
      const font = new GameFont(gameFile('ALL_FONT.16P'), gameFile('HANKAKU.FNT'));
      const img = renderText(font, [0xc1, 0xa6, 0x31], { fg: 15, outline: 0, background: 3 }); // '제1'
      expect([img.width, img.height]).toEqual([24, 16]);
      const colors = new Set(img.pixels);
      expect([...colors].sort((a, b) => a - b)).toEqual([0, 3, 15]);
    });

    it('reads FONT.R3 and its GRPDRV codes', () => {
      const codes = readGaijiCodes(gameFile('MAIN.EXE'));
      expect(codes[0]).toBe(0x7621);
      expect(codes[86]).toBe(0x767e);
      expect(codes.every((c, i) => i === 0 || c > codes[i - 1])).toBe(true);
      expect(parseFontR3(gameFile('FONT.R3'), codes).length).toBe(87);
    });
  });
});
