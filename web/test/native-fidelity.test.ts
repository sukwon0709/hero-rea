// Native-mode stand-ins for OPEN.EXE, END.EXE and the formation screen, checked against what the original
// programs do (docs/GAMEFLOW.md "The opening" / "The ending", docs/GRAPHICS.md "Opening and ending
// programs"). The raster-mode and mask-blit tests need no game files; the runs need HERO_GAME_DIR.
import { describe, expect, it } from 'vitest';
import { headlessScreen } from '../src/native/battle/dev/headless';
import { GameFont } from '../src/formats/font';
import { Cutscene, Dgroup, Ls11Archive, TICK_MS, type CutsceneIo } from '../src/native/cutscene';
import { openingCutscene, playOpening } from '../src/native/opening';
import { Ending, endDgroupSeg, playEnding } from '../src/native/ending';
import { WIDTH } from '../src/engine/screen';
import { gameFile, hasGame } from './gamedir';

/** A virtual clock: every frame advances one SBOPL2 countdown tick. */
function virtualIo(clickAt = Infinity) {
  let tick = 0;
  const music: [number, string, number][] = [];
  const io: CutsceneIo = {
    screen: headlessScreen(),
    setPalette: () => {},
    frame: async () => {
      tick++;
    },
    now: () => tick * TICK_MS,
    skip: () => tick * TICK_MS >= clickAt,
    music: {
      play: (i) => music.push([tick * TICK_MS, 'play', i]),
      fadeOut: (s) => music.push([tick * TICK_MS, 'fade', s]),
    },
  };
  return { io, music, now: () => tick * TICK_MS };
}

/** A Cutscene over a fake one-paragraph EXE (enough for the drawing primitives). */
function bareCutscene() {
  const exe = new Uint8Array(0x40);
  exe[8] = 2; // header of 2 paragraphs
  const { io } = virtualIo();
  const archive = new Ls11Archive(new Uint8Array(0x120));
  const c = new Cutscene({ io, dg: new Dgroup(exe, 0), archive, font: {} as GameFont, mask16: 0, mask64: 0, ringAddr: 0, ds: new Uint8Array(0x10000) });
  return { c, screen: io.screen };
}

const at = (screen: { pixels: Uint8Array }, x: number, y: number) => screen.pixels[(y + 0x27) * WIDTH + x];

describe('GRPDRV raster modes (put routines at GRPDRV 0:4047, bit-image function select at 0:2F66)', () => {
  it('puts with copy, XOR, AND, OR, transparent and NOT', () => {
    const { c, screen } = bareCutscene();
    const src = new Uint8Array(0x10000);
    // one 8-pixel column, colour 0b0101 in every pixel: planes 0 and 2 set
    src[0] = 0xff;
    src[2] = 0xff;
    const expectRow = (mode: number, before: number, after: number) => {
      c.rop(0);
      c.box(0, 0, 8, 1, before);
      c.rop(mode);
      c.put(0, 0, 8, 1, src, 0);
      expect(at(screen, 3, 0)).toBe(after);
    };
    expectRow(0, 0b1010, 0b0101);
    expectRow(1, 0b0110, 0b0011);
    expectRow(2, 0b0110, 0b0100);
    expectRow(3, 0b1010, 0b1111);
    expectRow(5, 0b0000, 0b1010);
    src.fill(0, 0, 4);
    expectRow(4, 0b1001, 0b1001); // colour 0 is left out
  });

  it('draws 1-bit images through the function select: AND keeps the set bits and clears the rest', () => {
    const { c, screen } = bareCutscene();
    const bits = new Uint8Array(0x10000);
    bits[0] = 0xf0; // left half set
    c.box(0, 0, 8, 1, 9);
    c.textColor(2, 15, 0);
    c.bits(0, 0, 8, 1, bits, 0);
    expect(at(screen, 0, 0)).toBe(9);
    expect(at(screen, 7, 0)).toBe(0);
    c.textColor(3, 6, 0);
    c.bits(0, 0, 8, 1, bits, 0);
    expect(at(screen, 0, 0)).toBe(15);
    c.textColor(4, 2, 0);
    c.bits(0, 0, 8, 1, bits, 0);
    expect(at(screen, 0, 0)).toBe(2);
    expect(at(screen, 7, 0)).toBe(0);
  });
});

describe('END 0:0AC7 mask blit', () => {
  it('ANDs one source byte into the four plane bytes of a column (mode 2)', () => {
    const { c } = bareCutscene();
    const dst = new Uint8Array(0x10000).fill(0xff, 0, 16);
    const src = new Uint8Array(0x10000);
    src[0] = 0x0f;
    src[1] = 0xf0;
    c.maskBlit(dst, 0, 16, 2, 0, 0, 16, 1, 2, src, 0);
    expect([...dst.subarray(0, 8)]).toEqual([0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0]);
    expect(dst[8]).toBe(0xff); // second row untouched
  });

  it('clips like 0:024C: nothing when the source starts below the destination', () => {
    const { c } = bareCutscene();
    const dst = new Uint8Array(0x10000).fill(0xff, 0, 64);
    c.maskBlit(dst, 0, 16, 2, 0, 2, 16, 1, 2, new Uint8Array(0x10000), 0);
    expect(dst.subarray(0, 64).every((v) => v === 0xff)).toBe(true);
  });
});

describe.skipIf(!hasGame)('OPEN.EXE / END.EXE stand-ins (needs HERO_GAME_DIR)', () => {
  const font = () => new GameFont(gameFile('ALL_FONT.16P'), gameFile('HANKAKU.FNT'));

  it('plays the opening once through with its two songs, then fades to black', async () => {
    const v = virtualIo();
    const c = openingCutscene(v.io, { open: gameFile('OPEN.EXE'), opgrp: gameFile('OPGRP.R3'), font: font() });
    expect(await playOpening(c, false)).toBe('done');
    expect(v.music.filter((m) => m[1] === 'play').map((m) => m[2])).toEqual([0, 1]);
    expect(v.io.screen.pixels.every((p) => p === 0)).toBe(true);
  }, 120_000);

  it('finds END.EXE DGROUP in its startup code', () => {
    expect(endDgroupSeg(gameFile('END.EXE'))).toBe(0xb84);
  });

  const runEnding = async (type: number, clickAt = 600_000) => {
    const v = virtualIo(clickAt);
    const e = new Ending(v.io, {
      end: gameFile('END.EXE'),
      end1: gameFile('END1GRP.R3'),
      end2: gameFile('END2GRP.R3'),
      font: font(),
      edmusic: gameFile('EDMUSIC.R3'),
    });
    const c = e.c;
    let untils = 0;
    const until = c.until.bind(c);
    c.until = (cs: number) => {
      untils++;
      return until(cs);
    };
    await playEnding(e, type);
    return { ...v, untils };
  };

  // the END.EXE runs these were checked against (one per type) waited 1602 / 1601 / 1601 / 1667 times
  // and started the staff-roll song 252.5 s (types 0..2) or 246.8 s (type 3) in
  it('runs ending 3 (0:61BE) and the staff roll with the original waits and song times', async () => {
    const r = await runEnding(3);
    expect(r.untils).toBe(1667);
    const plays = r.music.filter((m) => m[1] === 'play');
    expect(plays.map((m) => m[2])).toEqual([1, 2]);
    expect(Math.abs(plays[1][0] - 246_758)).toBeLessThan(40);
  }, 180_000);

  it('runs ending 0 (0:312A) with the original waits', async () => {
    const r = await runEnding(0);
    expect(r.untils).toBe(1602);
    const plays = r.music.filter((m) => m[1] === 'play');
    expect(Math.abs(plays[1][0] - 252_499)).toBeLessThan(40);
  }, 180_000);

  it('leaves ending 1 on a click, then plays the staff roll until the next click', async () => {
    const r = await runEnding(1, 30_000);
    // the click ends 0:312A at once (0:6157) and, still held, the staff roll's first fade (0:7FA6)
    expect(r.music.at(-1)?.[1]).toBe('fade');
    expect(r.now()).toBeLessThan(40_000);
  }, 60_000);
});
