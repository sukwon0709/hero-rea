// The ending (END.EXE), played the way END.EXE plays it: the pictures of END1GRP.R3 / END2GRP.R3, the
// palettes, captions, dissolve masks and petal paths read from the player's END.EXE, the songs of
// EDMUSIC.R3, and the same timing (see docs/GAMEFLOW.md, "The ending", and native/cutscene.ts for the
// primitives, which END.EXE links from the same library as OPEN.EXE).
//
// Flow (END 0:3050): GRPDRV origin (0, 0x27), read the ending type (int 65h AH=04h AL=1, set by MAIN
// before it runs END.EXE), then
//   type 0..2: 0:312A (END1GRP.R3; types 1 and 2 take the same path, 0:312A only tests type != 0)
//   type 3:    0:61BE (END2GRP.R3)
// and in every case the staff roll 0:7F70 (END1GRP.R3), which ends on a mouse click.
//
// Each of 0:312A / 0:61BE / 0:7F70 is one long sequence of calls whose waits are absolute: a 32-bit
// target in DS:27B2 (27B6, 27BA) grows by a constant before every 0:A9FA, which waits until that many
// 1/100 s have passed since 0:A892 reset the clock (Cutscene.until). Any wait or fade that sees a click
// jumps to the routine's exit path (fade to black at DS:6B8 without skipping, clear) and the next
// routine runs. The call sequences below were taken from instrumented runs of END.EXE (every library
// call logged with its arguments, one run per type) and checked against the disassembly; loops that
// draw from tables (the petals, the staff roll, the palette ramp, the scroll) are ported from the code.

import type { Screen } from '../engine/screen';
import type { Input } from '../engine/input';
import type { SoundPlayer } from '../audio/player';
import { Sbopl2, PIT_HZ } from '../audio/sequencer';
import { musicEntries } from '../audio/music';
import type { GameFont } from '../formats/font';
import { parseBrg } from '../formats/palette';
import type { Video } from './video';
import { Cutscene, Dgroup, Ls11Archive, Skip, type CutsceneIo, type Seg } from './cutscene';

/** END.EXE's DGROUP paragraph, from `mov di, 0B84h` in its startup code (entry + 0Dh). */
export function endDgroupSeg(exe: Uint8Array): number {
  const hdr = (exe[8] | (exe[9] << 8)) * 16;
  const ip = exe[0x14] | (exe[0x15] << 8);
  const cs = exe[0x16] | (exe[0x17] << 8);
  const p = hdr + cs * 16 + ip + 0x0d;
  return exe[p] === 0xbf ? exe[p + 1] | (exe[p + 2] << 8) : 0xb84;
}

export interface EndingFiles {
  end: Uint8Array; // END.EXE
  end1: Uint8Array; // END1GRP.R3
  end2: Uint8Array; // END2GRP.R3
  font: GameFont;
  /** EDMUSIC.R3, to know when a song that is not repeated has ended (0:987E). */
  edmusic?: Uint8Array;
}

/** The machine for END.EXE plus what its routines share. */
export class Ending {
  readonly c: Cutscene;
  readonly arch1: Ls11Archive;
  readonly arch2: Ls11Archive;
  /** When the song last started with repeat off ends (ms on the io clock), for 0:987E. */
  private songEnd = 0;
  private readonly lengths: number[] = [];

  constructor(
    io: CutsceneIo,
    readonly files: EndingFiles,
  ) {
    const dg = new Dgroup(files.end, endDgroupSeg(files.end));
    // END1GRP.R3 and END2GRP.R3 have no damaged entries, so the loader's stack memory is not modelled
    this.arch1 = new Ls11Archive(files.end1);
    this.arch2 = new Ls11Archive(files.end2);
    const ds = new Uint8Array(0x10000);
    // dissolve masks: 0:8642 reads DS:728 (4 words), 0:8752 DS:730 (8 words)
    this.c = new Cutscene({ io, dg, archive: this.arch1, font: files.font, mask16: 0x728, mask64: 0x730, ringAddr: 0, ds });
    if (files.edmusic) {
      for (const bank of musicEntries(files.edmusic)) this.lengths.push(songLength(bank));
    }
  }

  /** 0:978C + 0:983E (repeat off): play EDMUSIC.R3 entry `n` once. */
  song(n: number) {
    this.c.song(n, false);
    this.songEnd = this.c.io.now() + (this.lengths[n] ?? 0);
  }

  /** 0:802C: wait while 0:987E reports the song still playing (only when BGM is on). */
  async waitSongEnd() {
    if (!this.c.io.music) return;
    while (this.c.io.now() < this.songEnd) await this.c.vsync();
  }
}

/** Length of a song played once, by running the SBOPL2 sequencer without sound (ms). */
function songLength(bank: Uint8Array): number {
  const s = new Sbopl2(() => {});
  s.setMusicBank(bank);
  s.setRepeat(0);
  s.play(1);
  let n = 0;
  const max = PIT_HZ * 1200;
  while (s.song !== 0 && n < max) {
    s.irq();
    n++;
  }
  return (n * 1000) / PIT_HZ;
}

/** Plays the ending of `type` (0..3) and the staff roll; returns when the player clicks at the end. */
export async function playEnding(e: Ending, type: number): Promise<void> {
  const c = e.c;
  try {
    if (type === 3) {
      c.archive = e.arch2;
      await ending3(e);
    } else {
      c.archive = e.arch1;
      await ending012(e, type);
    }
  } catch (err) {
    if (!(err instanceof Skip)) throw err;
  }
  // 0:6157 / 0:7F18
  await c.fadeTo(0x6b8, false);
  c.cls();
  c.archive = e.arch1;
  try {
    await staffRoll(e);
  } catch (err) {
    if (!(err instanceof Skip)) throw err;
  }
  // 0:8356
  c.musicFade(8);
  await c.fadeTo(0x6b8, false);
  c.cls();
}

/** fadeStep toward DS:off that leaves on a click, as every caller checks `cmp ax, 2`. */
async function fadeStep(c: Cutscene, off: number) {
  if ((await c.fadeStep(c.pal(off), true)) === 2) throw new Skip();
}

/** (80 - columns) * 8 / 2 rounded down to a multiple of 8, as 0:335D / 0:5A5D centre a caption. */
function centre(cols: number): number {
  return Math.trunc(((0x50 - cols) * 8) / 2) & ~7;
}

// ------------------------------------------------------------------------------------- 0:312A

/** 0:312A, endings 0..2 (only `type !== 0` is tested). */
async function ending012(e: Ending, type: number) {
  const c = e.c;
  const [B0, B1, B2, B3, B4, B5] = c.seg;
  const t1 = type !== 0;
  c.clearAll();
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(20, B4, 0);
  c.load(1, B4, 0x8c00);
  c.load(19, B2, 0);
  c.load(21, B0, 0);
  c.npk(48, 104, 0x220, 176, B2, 48);
  c.get(48, 104, 0x220, 176, B2, 0);
  c.textColor(2, 15, 0);
  c.bits(0x170, 120, 224, 160, B4, 0x8c00);
  c.rop(3);
  c.put(0x170, 120, 224, 160, B4, 0);
  c.rop(0);
  c.get(48, 104, 0x220, 176, B3, 0);
  c.cls();
  c.memset(B1, 0, 0xbb00, 0);
  c.resetTimer();
  e.song(0);
  c.setPal(0x848);
  await c.wipe1(48, 104, 0x220, 176, B1, 0, B3, 0);
  // 0:3358: the first caption, two lines at a time under the scrolling picture
  const cap = c.text1(0x11b6, 0, 0, B5, 0);
  const capX = centre(cap.width);
  c.memset(B3, 0, (cap.height * cap.width * 4) & 0xffff, 0);
  await c.until(200);
  c.textColor(0, 7, 0);
  // 0:33D8: the rider moves 4 px left a frame, two frames alternating; a new caption pair every 6
  for (let i = 0; i < 32; i++) {
    const x = 0x168 - 4 * i; // 0:3573 loops while the x it just used is >= 0xF0
    const f = i % 2;
    const line = Math.floor(i / 6);
    c.memcpy(B3, 0, B2, 0, 0xbb00);
    c.maskBlit(B3, 0, 0x220, 0xb0, x - 0x30, 0x10, 0xe0, 0xa0, 2, B4, ((f + 8) * 0x1180) & 0xffff);
    c.blit(B3, 0, 0x220, 0xb0, x - 0x30, 0x10, 0xe0, 0xa0, 4, B4, f * 0x4600);
    c.maskBlit(B3, 0, 0x220, 0xb0, capX - 0x30, 0xb8, cap.width * 8, 0x28, 2, B5, (cap.width * line * 0x28) & 0xffff);
    await c.until(0x145 + 125 * i);
    c.put(48, 104, 0x220, 176, B3, 0);
    c.bits(capX, 0x120, cap.width * 8, 40, B5, (cap.width * line * 0x28) & 0xffff);
  }
  await c.until(0x10cc);
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(23, B1, 0);
  c.memcpy(B2, 0, B0, 0, 0x3000);
  c.load(22, B0, 0x3000);
  c.put(0x138, 184, 0x100, 96, B0, 0);
  c.get(0x168, 184, 160, 72, B0, 0x7380);
  c.memcpy(B3, 0, B1, 0, 0x3000);
  c.put(72, 56, 0x100, 96, B1, 0);
  c.get(120, 56, 160, 72, B1, 0x7380);
  await c.until(0x11f8);
  await c.fadeTo(0x968);
  c.load(24, B1, 0x3000);
  for (let i = 0; i < 2; i++) {
    await c.until(0x12de + 0x12c * i);
    c.put(0x168, 184, 160, 72, B0, 0x4680);
    await c.until(0x12e8 + 0x12c * i);
    c.put(120, 56, 160, 72, B1, 0x4680);
    await c.until(0x12fc + 0x12c * i);
    c.put(0x168, 184, 160, 72, B0, 0x3000);
    await c.until(0x1306 + 0x12c * i);
    c.put(120, 56, 160, 72, B1, 0x3000);
    await c.until(0x131a + 0x12c * i);
    c.put(0x168, 184, 160, 72, B0, 0x7380);
    await c.until(0x1324 + 0x12c * i);
    c.put(120, 56, 160, 72, B1, 0x7380);
  }
  await c.until(0x14fa);
  c.put(0x168, 184, 160, 72, B0, 0x3000);
  await c.until(0x1504);
  c.put(120, 56, 160, 72, B1, 0x3000);
  const flash = [0x878, 0x8a8, 0x8d8, 0x908, 0x938];
  for (let i = 0; i < 6; i++) {
    await c.until(0x15b8 + 10 * i);
    c.setPal(i < 5 ? flash[i] : 0x968);
  }
  await c.until(0x1694);
  c.put(0x168, 184, 160, 72, B0, 0x7380);
  await c.until(0x169e);
  c.put(120, 56, 160, 72, B1, 0x7380);
  await c.until(0x1766);
  c.put(0x168, 184, 160, 72, B0, 0x4680);
  await c.until(0x1770);
  c.put(120, 56, 160, 72, B1, 0x4680);
  await c.until(0x1784);
  c.put(0x168, 184, 160, 72, B0, 0x3000);
  await c.until(0x178e);
  c.put(120, 56, 160, 72, B1, 0x3000);
  await c.until(0x17a2);
  c.put(0x168, 184, 160, 72, B0, 0x7380);
  await c.until(0x17ac);
  c.put(120, 56, 160, 72, B1, 0x7380);
  await c.until(0x1874);
  await c.until(0x18f6);
  for (let i = 0; i < 5; i++) {
    c.setPal(flash[i]);
    await c.until(0x1900 + 10 * i);
  }
  c.put(0x138, 184, 0x100, 96, B0, 0);
  c.get(0x118, 184, 0x120, 96, B0, 0);
  c.put(72, 56, 0x100, 96, B1, 0);
  c.get(104, 56, 0x120, 96, B1, 0);
  await c.until(0x198c);
  for (let i = 0; i < 22; i++) {
    c.put(0x118 + 16 * i, 184, 0x120, 96, B0, 0);
    c.put(104 - 16 * i, 56, 0x120, 96, B1, 0);
    await c.until(0x199b + 15 * i);
  }
  c.setPal(0x6b8);
  c.load(25, B0, 0);
  c.memcpy(B1, 0, B0, 0, 0xdac0);
  c.memcpy(B2, 0, B0, 0, 0xdac0);
  c.memcpy(B3, 0, B0, 0, 0xdac0);
  c.load(66, B4, 0);
  // four copies of the picture, each with one frame of the animation at its top
  const frames = [B0, B1, B2, B3];
  frames.forEach((b, k) => {
    c.put(208, 48, 224, 104, b, 0);
    c.put(232, 48, 192, 104, B4, 0x2700 * k);
    c.get(208, 48, 224, 104, b, 0);
  });
  c.put(208, 48, 224, 0x130, B0, 0);
  await c.until(0x1cca);
  await c.fadeTo(0x998);
  await c.until(0x1d60);
  // 0:4195: scroll up 2 rows a step through the four frames, straight to VRAM (0:0E26) after a retrace
  scroll: for (let si = 0, di = 0; ; si += 0x380, di += 8) {
    for (let k = 0; k < 4; k++) {
      await c.until(0x1d6f + 60 * (di >> 3) + 15 * k);
      await c.vsync();
      c.putDirect(0x1a, 0x30, 0x1c, 0x130, frames[k], (si + 0xe0 * k) & 0xffff);
      if (k === 0 ? si >= 0x55c0 : di + 2 * k >= 0xc4) break scroll;
    }
  }
  c.get(208, 252, 224, 100, B1, 0);
  await c.until(0x23c3);
  for (let i = 0; i < 5; i++) {
    c.load(26 + i, B0, 0);
    await c.until(0x2431 + 110 * i);
    await c.diss16(208, 252, 224, 100, B1, 0, B0, 0);
  }
  c.get(0x110, 0x110, 96, 80, B0, 0);
  c.load(31, B1, 0);
  c.load(2, B1, 0x1e00);
  await c.until(0x26b1);
  c.textColor(2, 15, 0);
  // 0:443A: a picture rises out of the bottom edge, two rows a frame
  for (let i = 0, si = 0x15e; si >= 0x110; i++, si -= 2) {
    const f = i % 2;
    c.memcpy(B2, 0, B0, 0, 0xf00);
    c.maskBlit(B2, 0, 0x60, 0x50, 0, si - 0x110, 0x60, 0x160 - si, 2, B1, (f + 8) * 0x3c0);
    c.blit(B2, 0, 0x60, 0x50, 0, si - 0x110, 0x60, 0x160 - si, 4, B1, f * 0xf00);
    await c.until(0x26cf + 30 * i);
    c.put(0x110, 0x110, 96, 80, B2, 0);
  }
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(32, B0, 0);
  await c.until(0x2db9);
  c.put(184, 64, 0x110, 224, B0, 0x7700);
  await c.fadeTo(0x9f8);
  await c.until(0x2e81);
  for (let i = 0; i < 16; i++) {
    await c.until(0x2eb3 + 50 * i);
    c.put(184, 64, 0x110, 224, B0, [0, 0x7700][i % 2]);
  }
  await c.until(0x32cd);
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(34, B0, 0);
  c.textColor(3, 1, 0);
  c.bits(136, 0, 0x198, 0x190, B0, 0);
  c.get(136, 0, 0x198, 200, B0, 0);
  c.get(136, 200, 0x198, 200, B2, 0);
  c.cls();
  c.load(33, B1, 0);
  c.npk(136, 0, 0x198, 0x190, B1, 48);
  c.get(136, 0, 0x198, 200, B1, 0);
  c.get(136, 200, 0x198, 200, B3, 0);
  await c.until(0x33f9);
  await c.fadeTo(0x9f8);
  await c.until(0x3525);
  const flash2 = [0xa28, 0xa58, 0xa88, 0xab8];
  for (let i = 0; i < 4; i++) {
    await c.until(0x3589 + 10 * i);
    c.setPal(flash2[i]);
  }
  await c.until(0x35c5);
  c.setPal(0x9f8);
  await c.until(0x368d);
  for (let i = 0; i < 16; i++) {
    c.step(16, i, 0x198, 200, B1, 0, B0, 0);
    c.step(16, i, 0x198, 200, B3, 0, B2, 0);
    c.put(136, 0, 0x198, 200, B1, 0);
    c.put(136, 200, 0x198, 200, B3, 0);
    await fadeStep(c, 0x330);
  }
  c.load(35, B0, 0);
  c.textColor(3, 2, 0);
  c.bits(176, 40, 0x140, 0x138, B0, 0);
  c.load(36, B0, 0);
  c.textColor(3, 4, 0);
  c.bits(232, 88, 200, 200, B0, 0);
  c.load(37, B0, 0);
  c.textColor(3, 8, 0);
  c.bits(0x130, 144, 64, 56, B0, 0);
  await c.until(0x39ad);
  await paletteRamp(c, 0x39b7);
  await c.until(0x3bdd);
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(69, B0, 0);
  c.load(70, B2, 0);
  c.load(71, B3, 0);
  c.textColor(2, 15, 0);
  c.bits(0x130, 144, 64, 56, B2, 0);
  c.rop(3);
  c.put(0x130, 144, 64, 56, B0, 0);
  await c.until(0x3ca5);
  c.setPal(0xb78);
  c.rop(0);
  for (let i = 0; i < 4; i++) {
    await c.until(0x3cb4 + 15 * i);
    c.put(0x130, 144, 64, 56, B0, 0x700 * i);
  }
  c.load(40, B1, 0);
  c.load(3, B2, 0);
  c.rop(3);
  await c.until(0x3df9);
  c.setPal(0xae8);
  c.bits(0x110, 216, 120, 112, B2, 0);
  c.put(0x110, 216, 120, 112, B1, 0);
  await c.until(0x3e0d);
  await c.fadeTo(0xb78);
  c.load(41, B1, 0);
  c.load(42, B3, 0);
  c.load(43, B5, 0);
  c.load(4, B0, 0);
  c.load(5, B2, 0);
  c.load(7, B4, 0);
  c.textColor(2, 15, 0);
  c.rop(3);
  await c.until(0x406f);
  c.setPal(0xae8);
  c.bits(184, 160, 128, 168, B2, 0);
  c.put(184, 160, 128, 168, B1, 0);
  c.bits(0x170, 144, 104, 184, B4, 0);
  c.put(0x170, 144, 104, 184, B3, 0);
  await c.until(0x4083);
  await c.fadeTo(0xb78);
  c.rop(0);
  c.load(9, B2, 0);
  c.load(44, B3, 0);
  c.textColor(2, 15, 0);
  c.rop(3);
  await c.until(0x42db);
  if (!t1) {
    c.setPal(0xae8);
    c.bits(0, 40, 216, 0x120, B2, 0);
    c.put(0, 40, 216, 0x120, B5, 0);
    c.load(11, B2, 0);
    c.bits(0x1b8, 40, 200, 0x120, B2, 0);
    c.put(0x1b8, 40, 200, 0x120, B3, 0);
    await c.until(0x42ef);
    await c.fadeTo(0xb78);
    c.load(38, B4, 0);
  } else c.load(39, B4, 0);
  await c.until(0x44e3);
  if (!t1) {
    c.get(0, 40, 0x140, 0x120, B1, 0);
    c.get(0x140, 40, 0x140, 0x120, B2, 0);
    c.setPal(0xb18);
    c.npk(0, 40, 0x280, 0x120, B4, 48);
  } else {
    c.get(176, 40, 0x138, 0x120, B1, 0);
    c.setPal(0xb18);
    c.npk(176, 40, 0x138, 0x120, B4, 48);
  }
  c.rop(4);
  if (!t1) {
    c.put(0, 40, 0x140, 0x120, B1, 0);
    c.put(0x140, 40, 0x140, 0x120, B2, 0);
  } else c.put(176, 40, 0x138, 0x120, B1, 0);
  await c.until(0x451f);
  await c.fadeTo(0xba8);
  c.load(45, B0, 0);
  await c.until(0x4907);
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(46, B1, 0);
  c.put(0, 40, 0x140, 0x120, B0, 0);
  c.put(0x140, 40, 0x140, 0x120, B1, 0);
  await c.until(0x4b5f);
  await c.fadeTo(t1 ? 0xc08 : 0xbd8);
  await c.until(0x4db7);
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(47, B0, 0);
  c.npk(184, 64, 0x110, 224, B0, 48);
  if (!t1) {
    c.text2(0x1254, 0, 7, B0, 0);
    c.put(40, 0x130, 0x228, 40, B0, 0);
  }
  await c.until(0x4f47);
  await c.fadeTo(t1 ? 0xc68 : 0xc38);
  c.load(48, B4, 0);
  c.load(49, B1, 0);
  c.load(13, B2, 0);
  await c.until(0x5203);
  await c.fadeTo(0x6b8);
  c.cls();
  // two versions of the three portraits, B3 and (after 0:5963) the screen, then a dissolve between them
  const portraits = (first: number, loaded: boolean) => {
    c.rop(3);
    c.textColor(2, 15, 0);
    c.npk(184, 64, 0x110, 224, B4, 48);
    const at: [number, number][] = [
      [184, 104],
      [0x128, 64],
      [0x160, 104],
    ];
    at.forEach(([x, w], k) => {
      if (k || !loaded) {
        c.load(first + 2 * k, B1, 0);
        c.load(first - 36 + 2 * k, B2, 0);
      }
      c.bits(x, 152, w, 144, B2, 0);
      c.put(x, 152, w, 144, B1, 0);
    });
  };
  portraits(49, true);
  c.get(184, 64, 0x110, 232, B3, 0);
  c.cls();
  portraits(50, false);
  await c.until(0x5393);
  await c.fadeTo(t1 ? 0xc68 : 0xc38);
  c.rop(0);
  c.get(184, 64, 0x110, 232, B0, 0);
  await c.until(0x5523);
  await c.diss16(184, 64, 0x110, 232, B0, 0, B3, 0);
  await c.until(0x577b);
  await c.fadeTo(0x6b8);
  c.cls();
  c.rop(0);
  c.load(55, B0, 0);
  c.npk(0, 40, 0x280, 0x120, B0, 48);
  // 0:5A36: the last two captions, each outlined over the picture and kept in B4 / B3
  const a = c.text1(t1 ? 0x150e : 0x1392, 0, 0, B4, 0);
  const ax = centre(a.width);
  const b = c.text1(0x158a, 0, 0, B3, 0);
  const bx = centre(b.width);
  c.outline(bx, 160, b.width * 8, b.height, B3, 0);
  c.get(ax, 104, a.width * 8, a.height, B3, 0);
  c.npk(0, 40, 0x280, 0x120, B0, 48);
  c.outline(ax, 104, a.width * 8, a.height, B4, 0);
  c.get(ax, 104, a.width * 8, a.height, B4, 0);
  c.load(65, B0, 0);
  c.load(67, B1, 0);
  await petals(e, type, ax, a.width, a.height);
}

/**
 * 0:4A7A: brighten the colours plane by plane. Every entry i of the palette at BP-52h is DS:32C (one
 * colour) scaled by the sum of the levels DS:360+p of the planes p set in i, over 16, capped at
 * DS:32C; it is set every 1/10 s while the levels climb (DS:364+p marks a plane that reached 16 and
 * now falls back) until plane 2 has climbed and fallen back to 0. The levels live in DGROUP.
 */
async function paletteRamp(c: Cutscene, t0: number) {
  const ds = c.ds;
  const local = new Uint8Array(48);
  const build = () => {
    for (let i = 0; i < 16; i++) {
      for (let k = 0; k < 3; k++) {
        const base = ds[0x32c + k];
        let v = 0;
        for (let p = 0; p < 4; p++) if (i & (1 << p)) v += base * ds[0x360 + p];
        v = Math.trunc(v / 16) & 0xff;
        local[i * 3 + k] = v > base ? base : v;
      }
    }
  };
  for (let n = 0; ; n++) {
    build();
    await c.until(t0 + 10 * n);
    c.setPalette(parseBrg(local, 0));
    for (let si = 0; si < 4; si++) {
      if (ds[0x364 + si]) {
        if (si !== 3 && ds[0x360 + si]) ds[0x360 + si]--;
      } else if (ds[0x363 + si] || ds[0x35f + si] > 10) {
        ds[0x360 + si] = (ds[0x360 + si] + 1) & 0xff;
        if (ds[0x360 + si] === 0x10) ds[0x364 + si] = 1;
      }
    }
    if (ds[0x366] && !ds[0x362]) break;
  }
  c.setPalette(parseBrg(local, 0));
}

/**
 * 0:5D08..0:6156: sixteen petals fall over the last picture while the caption at (x, 0x68) dissolves
 * from B4 to B3. Each petal (11 bytes at BP-102h + 11j: x and y for two frame parities, path, variant,
 * step) follows path j % 17 of the table DS:C8 (17 paths of 18 x positions), 16 px down per frame; at
 * the end of a path it starts again on path frame % 17. Petals are drawn on alternate frames for each
 * parity, the background under them saved in B5 (masks B1, sprites B0, work B2).
 */
async function petals(e: Ending, type: number, capX: number, cols: number, capH: number) {
  const c = e.c;
  const [B0, B1, B2, B3, B4, B5] = c.seg;
  const dg = c.dg;
  const pathX = (path: number, step: number) => dg.u16(0xc8 + (path * 18 + step) * 2);
  interface Petal {
    x: number[];
    y: number[];
    path: number;
    v: number;
    step: number;
  }
  const ps: Petal[] = [];
  for (let j = 0; j < 16; j++) {
    const path = j % 17;
    const step = j % 18;
    const x = pathX(path, step);
    // y[0] is not set (a stack word; 0 in the emulator run)
    const p: Petal = { x: [x, x], y: [0, step * 16 + 0x28], path, v: j % 6, step };
    ps.push(p);
    c.get(p.x[0], p.y[0], 16, 16, B5, j << 7);
    c.get(p.x[1], p.y[1], 16, 16, B5, (j + 16) << 7);
  }
  await c.until(0x59d3);
  await c.fadeTo(type ? 0xcc8 : 0xc98);
  await c.until(0x5a9b);
  for (let k = 0, par = 0; k < 0x46; k++) {
    par ^= 1;
    ps.forEach((p, j) => c.put(p.x[par], p.y[par], 16, 16, B5, ((par << 4) + j) << 7));
    if (k >= 0x17 && k - 0x17 < 0x10) c.step(16, k - 0x14, cols * 8, capH, B4, 0, B3, 0);
    else c.step(16, 0, cols * 8, capH, B4, 0, B4, 0);
    c.put(capX, 0x68, cols * 8, capH, B4, 0);
    ps.forEach((p, j) => {
      if (++p.step === 0x12) {
        p.path = k % 17;
        p.v = k % 6;
        p.step = 0;
      }
      p.x[par] = pathX(p.path, p.step);
      p.y[par] = p.step * 16 + 0x28;
      const o = j << 7;
      c.get(p.x[par], p.y[par], 16, 16, B2, o);
      const cel = (p.step % 3) + p.v * 3;
      composite(B2, o, B1, cel << 5, B0, cel << 7);
      c.get(p.x[par], p.y[par], 16, 16, B5, ((par << 4) + j) << 7);
    });
    ps.forEach((p, j) => c.put(p.x[par], p.y[par], 16, 16, B2, j << 7));
    await c.until(0x5a9b + 0x19 * (k + 1));
  }
  await c.fadeTo(0x6b8);
  c.cls();
}

/** 0:6008: 16 rows of a 16-px cel: dst = mask & dst | sprite, one mask byte for 4 plane bytes. */
function composite(dst: Seg, doff: number, mask: Seg, moff: number, spr: Seg, soff: number) {
  for (let i = 0; i < 32; i++) {
    const m = mask[(moff + i) & 0xffff];
    for (let p = 0; p < 4; p++) {
      const d = (doff + i * 4 + p) & 0xffff;
      dst[d] = (m & dst[d]) | spr[(soff + i * 4 + p) & 0xffff];
    }
  }
}

// ------------------------------------------------------------------------------------- 0:61BE

/** 0:61BE, ending 3 (END2GRP.R3). */
async function ending3(e: Ending) {
  const c = e.c;
  const [B0, B1, B2, B3, B4] = c.seg;
  const dg = c.dg;
  const s16 = (off: number) => (dg.u16(off) << 16) >> 16;
  let t = 0;
  const wait = async (cs: number) => {
    t += cs;
    await c.until(t);
  };
  c.clearAll();
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(0, B0, 0);
  c.npk(0, 0x24, 0x140, 0x148, B0, 0x30);
  c.load(1, B0, 0);
  c.npk(0x140, 0x24, 0x140, 0x148, B0, 0x30);
  c.resetTimer();
  e.song(1);
  await c.fadeTo(0xf68);
  c.load(2, B0, 0);
  c.get(0x10, 0xf0, 0x260, 100, B2, 0);
  await wait(0x190);
  // 0:6312: six portraits fade in at (0x178, 0x54) row block by row block (9 blocks of 16 rows, each
  // a 16-step dissolve started one frame after the block above), each with its caption (DS:368..372)
  for (let n = 0, di = 0x368; di < 0x374; n++, di += 2) {
    c.get(0x178, 0x54, 0xe0, 0x90, B3, 0);
    await wait(0x96);
    for (let f = 0; f < 0x19; f++) {
      for (let j = 0, o = 0; o < 0x3f00; j++, o += 0x700) if (j <= f) c.step(16, f & 15, 0xe0, 0x10, B3, o, B0, o);
      await wait(0x14);
      c.put(0x178, 0x54, 0xe0, 0x90, B3, 0);
      if (f > 5) await fadeStep(c, 0xf38);
    }
    const cap = c.text1(dg.u16(di), 0, 0, B4, 0);
    c.get(0x10, 0xf0, 0x260, 100, B3, 0);
    await c.diss16(0x10, 0xf0, 0x260, 100, B3, 0, B2, 0);
    c.get(0x10, 0xf0, 0x260, 100, B2, 0);
    c.outline(0x10, 0xf0, cap.width * 8, cap.height, B4, 0);
    await wait(0x6e);
    if (di !== 0x372) c.load(n + 3, B0, 0);
    await wait(0x38e);
    await c.fadeTo(0xf68);
    await wait(0x96);
  }
  c.load(0x15, B4, 0);
  c.load(0x18, B4, 0x300);
  c.load(8, B2, 0);
  await wait(0x190);
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(9, B0, 0);
  c.npk(0, 0, 0x280, 400, B0, 0x30);
  c.get(0, 0, 0x280, 200, B0, 0);
  c.get(0, 200, 0x280, 200, B1, 0);
  c.npk(0, 0, 0x280, 400, B2, 0x30);
  c.get(0, 0, 0x280, 200, B2, 0);
  c.get(0, 200, 0x280, 200, B3, 0);
  c.rop(4);
  // 0:6796: 25 small birds (path k % 8 of the table DS:40E, 8 paths of 25 x positions, 16 px down a
  // step) and two big ones (paths of DS:59E; a negative entry means: draw the big bird at -x, y + the
  // next word)
  interface Bird {
    path: number;
    v: number;
    step: number;
    anim: number;
  }
  const small: Bird[] = [];
  for (let k = 0; k < 25; k++) {
    const b: Bird = { path: k % 8, v: k % 2, step: k % 25, anim: k % 3 };
    small.push(b);
    c.put(dg.u16(0x40e + (b.path * 25 + b.step) * 2), b.step << 4, 0x10, 0x10, B4, (b.v * 3 + b.anim) << 7);
  }
  // DS-relative stack bytes BP-18h.. as set at 0:6827 (the anim byte of each is not set; 25 % 3 is used)
  const big: Bird[] = [
    { path: 0, v: 0, step: 0, anim: 0 },
    { path: 1, v: 1, step: 0xfc, anim: 0 },
  ];
  for (const b of big) c.put(dg.u16(0x59e + (b.step + b.path * 25) * 2), (b.step << 4) & 0xffff, 0x10, 0x10, B4, (b.v * 3 + (25 % 3)) << 7);
  c.rop(0);
  await wait(0x1f4);
  await c.fadeTo(0xf98);
  await wait(0xc8);
  const smallBirds = (y: number) => {
    const inc = y & 1 ? 1 : 2;
    small.forEach((b, k) => {
      c.put(dg.u16(0x40e + (b.path * 25 + b.step) * 2), b.step << 4, 0x10, 0x10, B4, (b.v * 3 + b.anim) << 7);
      if (++b.step === 0x19) {
        b.path = k % 8;
        b.v = k % 2;
        b.step = 0;
      }
      b.anim = (b.anim + inc) % 3;
    });
  };
  const bigAt = (b: Bird) => 0x59e + (b.step + b.path * 25) * 2;
  // 0:68F6: the sky scrolls down out of the picture (4 rows a frame, 1/4 s; 8 rows and 1/2 s if the
  // first frame came more than 0.2 s late, 0:6B75)
  let rows = 4;
  let delay = 0x19;
  for (let n = 0, di = 0; di < 200; n++, di += rows) {
    if (n) {
      c.put(0, 0, 0x280, di, B1, ((200 - di) * 0x140) & 0xffff);
      c.put(0, di, 0x280, 200, B2, 0);
      c.put(0, di + 200, 0x280, 200 - di, B3, 0);
    }
    c.rop(4);
    for (const b of big) {
      const a = bigAt(b);
      if (s16(a) < 0) {
        if (b.v % 5 !== 4) b.v++;
        c.rop(0);
        c.put(-s16(a), s16(a + 2) + di, 0x60, 0x40, B4, (b.v * 0xc00 + 0x300) & 0xffff);
        c.rop(4);
      } else c.put(s16(a), (b.step << 4) + di, 0x10, 0x10, B4, (b.v * 3 + (di % 3)) << 7);
      if (s16(bigAt(b)) >= 0) {
        b.step = (b.step + 1) & 0xff;
        if (s16(bigAt(b)) < 0) b.v = (b.path * 5) & 0xff;
      }
    }
    smallBirds(di);
    c.rop(0);
    if (di === 0 && Math.floor(c.elapsed / 10) - t > 20) {
      delay = 0x32;
      rows = 8;
    }
    await wait(delay);
  }
  for (let di = 0; di <= 0xc8; di += rows) {
    c.put(0, 0, 0x280, di, B0, ((200 - di) * 0x140) & 0xffff);
    c.put(0, di, 0x280, 200, B1, 0);
    c.put(0, di + 200, 0x280, 200 - di, B2, 0);
    for (const b of big) {
      const a = bigAt(b);
      c.put(-s16(a), s16(a + 2) + di + 200, 0x60, 0x40, B4, (b.v * 0xc00 + 0x300) & 0xffff);
    }
    c.rop(4);
    smallBirds(di);
    c.rop(0);
    await wait(delay);
  }
  for (let di = 0; di <= 0x78; di += rows) {
    c.put(0, 0, 0x280, 200, B0, 0);
    c.put(0, 200, 0x280, 200, B1, 0);
    c.rop(4);
    smallBirds(di);
    c.rop(0);
    await wait(delay);
  }
  const B5 = c.seg[5];
  c.load(0xb, B0, 0);
  c.load(0x11, B0, 0x3c80);
  c.load(0xd, B1, 0);
  c.load(0x12, B1, 0x3c80);
  c.load(10, B3, 0);
  await wait(0xc8);
  await c.fadeTo(0x6b8);
  c.cls();
  // 0:6FB5: three figures (masked with their 1-bit shapes) in front of a landscape at (0x70, 0x70)
  c.npk(0x70, 0x70, 0x1a0, 0xb0, B3, 0x30);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B0, 0x4ba0);
  c.load(0x16, B1, 0x4ba0);
  const cranes = Array.from({ length: 12 }, (_, k) => ({ path: k % 7, v: k % 3, step: k % 11 }));
  c.textColor(2, 0xf, 0);
  c.rop(3);
  c.bits(0xe0, 0x70, 0xb0, 0xb0, B0, 0x3c80);
  c.put(0xe0, 0x70, 0xb0, 0xb0, B0, 0);
  c.load(0xc, B2, 0);
  c.rop(0);
  c.put(0xf8, 0xb8, 0x30, 0x10, B2, 0);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B5, 0);
  c.put(0x70, 0x70, 0x1a0, 0xb0, B0, 0x4ba0);
  c.rop(3);
  c.bits(0x70, 0x70, 0xb0, 0xb0, B1, 0x3c80);
  c.put(0x70, 0x70, 0xb0, 0xb0, B1, 0);
  c.bits(0xe0, 0x70, 0xb0, 0xb0, B0, 0x3c80);
  c.put(0xe0, 0x70, 0xb0, 0xb0, B0, 0);
  c.rop(0);
  c.get(0xf8, 0xb8, 0x30, 0x10, B4, 0);
  c.put(0xf8, 0xb8, 0x30, 0x10, B2, 0);
  c.load(0xe, B2, 0);
  c.get(0x88, 0xc0, 0x30, 0x10, B4, 0x280);
  c.put(0x88, 0xc0, 0x30, 0x10, B2, 0);
  c.get(0x70, 0x70, 0xb0, 0xb0, B5, 0x8f00);
  c.put(0xf8, 0xb8, 0x30, 0x10, B4, 0);
  c.put(0x88, 0xc0, 0x30, 0x10, B4, 0x280);
  c.load(0xf, B2, 0);
  c.load(0x13, B2, 0x3c80);
  c.rop(3);
  c.bits(0x160, 0x70, 0xb0, 0xb0, B2, 0x3c80);
  c.put(0x160, 0x70, 0xb0, 0xb0, B2, 0);
  c.rop(0);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B3, 0);
  await c.fadeTo(0xfc8);
  await wait(0x226);
  // 0:7451: twelve cranes fly over it (paths of DS:374, 7 paths of 11 x positions, from row 0x70)
  const flock = async (n: number) => {
    c.rop(4);
    for (const r of cranes) {
      c.put(dg.u16(0x374 + (r.step + r.path * 11) * 2), (r.step + 7) * 16, 0x10, 0x10, B1, (((r.v * 4 + (n % 4)) << 7) + 0x4ba0) & 0xffff);
      if (++r.step === 0xb) {
        r.path = n % 7;
        r.v = n % 3;
        r.step = 0;
      }
    }
    c.rop(0);
    await wait(0x32);
  };
  for (let n = 0; n <= 0x10; n++) {
    c.put(0x70, 0x70, 0x1a0, 0xb0, B3, 0);
    await flock(n);
  }
  c.put(0x70, 0x70, 0x1a0, 0xb0, B3, 0);
  c.load(0xc, B2, 0);
  c.put(0xf8, 0xb8, 0x30, 0x10, B2, 0);
  c.load(0xe, B2, 0x400);
  c.put(0x88, 0xc0, 0x30, 0x10, B2, 0x400);
  c.load(0x10, B2, 0x800);
  c.put(0x170, 0xb0, 0x38, 0x18, B2, 0x800);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B4, 0);
  for (let n = 0; n < 0x28; n++) {
    if (n < 0x10) c.step(16, n, 0x1a0, 0xb0, B3, 0, B4, 0);
    c.put(0x70, 0x70, 0x1a0, 0xb0, B3, 0);
    await flock(n);
    if (n < 0x10) await fadeStep(c, 0xff8);
  }
  c.get(0x70, 0x70, 0x1a0, 0xb0, B4, 0);
  for (let si = 0x58, di = 0x8f00; di < 0xcb80; si += 0xd0, di += 0x58) {
    c.memcpy(B3, si - 0x58, B5, di, 0x58);
    c.memcpy(B3, si, B5, si, 0x78);
  }
  // dissolves through the versions of the picture kept in B3, B5, B4 while the cranes keep flying
  const dissolve = async (dst: Seg, src: Seg) => {
    for (let n = 0; n < 0x10; n++) {
      c.step(16, n, 0x1a0, 0xb0, dst, 0, src, 0);
      c.put(0x70, 0x70, 0x1a0, 0xb0, dst, 0);
      await flock(n);
    }
  };
  await dissolve(B4, B3);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B4, 0);
  await dissolve(B4, B5);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B3, 0);
  c.memcpy(B4, 0, B0, 0x4ba0, 0x8f00);
  await dissolve(B3, B4);
  const cap = c.text1(0x1b7a, 0, 0, B4, 0);
  const cx = centre(cap.width);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B2, 0);
  c.outline(cx, 0xc0, cap.width * 8, cap.height, B4, 0);
  c.rop(0);
  c.get(0x70, 0x70, 0x1a0, 0xb0, B4, 0);
  await wait(0x1c2);
  await dissolve(B4, B2);
  for (let n = 0; n < 0x1e; n++) {
    c.put(0x70, 0x70, 0x1a0, 0xb0, B3, 0);
    await flock(n);
    if (n >= 0xe) await fadeStep(c, 0x6b8);
  }
}

// ------------------------------------------------------------------------------------- 0:7F70

/**
 * 0:7F70, the staff roll: 20 pages of the caption lists DS:240C..2432 (white, 0:90A6) fade in line by
 * line at (0x180, 0x20), each line a 16-step dissolve started 2 frames after the one above; every
 * second page the picture on the left (B3, 0x120 x 0xF0 at 0, 0) dissolves to the next (entries 56..64)
 * while the palette steps toward the next of DS:602; then a last picture and a click.
 */
async function staffRoll(e: Ending) {
  const c = e.c;
  const [B0, B1, B2, B3] = c.seg;
  await c.fadeTo(0x6b8);
  c.cls();
  c.resetTimer();
  let t = 0;
  const wait = async (cs: number) => {
    t += cs;
    await c.until(t);
  };
  c.rop(0);
  c.setPal(0xcf8);
  c.memset(B1, 0, 0x8700, 0);
  c.memset(B2, 0, 0xffff, 0);
  await wait(200);
  await e.waitSongEnd();
  e.song(2);
  let pic = 0;
  for (let idx = 0, ptr = 0x240c; ptr < 0x2434; idx++, ptr += 2) {
    const { width: cols, height: h } = c.text2(c.dg.u16(ptr), 0, 7, B0, 0);
    for (let f = 0; f < 50; f++) {
      for (let j = 0; j <= 16; j++) {
        if (f < 2 * j) continue;
        const o = (cols * j * 80) & 0xffff;
        c.step(16, f & 15, cols * 8, 20, B2, o, B0, o);
      }
      c.put(0x180, 0x20, cols * 8, h, B2, 0);
      await wait(10);
    }
    await wait(0x64);
    let waited = 0;
    if (ptr > 0x240c && idx & 1) {
      for (let i = 0; i < 16; i++) {
        c.step(16, i, 0x120, 0xf0, B1, 0, B3, 0);
        c.put(0, 0, 0x120, 0xf0, B1, 0);
        await wait(0xf);
        waited += 0xf;
        if (ptr < 0x2430) await fadeStep(c, c.dg.u16(0x602 + (idx >> 1) * 2));
      }
      pic++;
    } else if (pic < 9) c.load(0x38 + pic, B3, 0);
    else c.memset(B3, 0, 0x8700, 0);
    await wait(0x1f4 - waited);
  }
  await c.fadeTo(0x6b8);
  c.cls();
  c.load(0x44, B0, 0);
  c.npk(0xd8, 0x50, 0xd0, 0x70, B0, 0x30);
  c.load(0, B0, 0);
  c.npk(0xb8, 0xc8, 0x110, 0x28, B0, 0x30);
  await wait(200);
  await c.fadeTo(0x818);
  await wait(0x190);
  // 0:8340: poll the mouse buttons (0:7F42) until one is down
  for (;;) {
    await c.vsync();
    if (c.io.skip()) break;
  }
}

// ------------------------------------------------------------------------------------- host

export interface EndingHost {
  files: { get(name: string): Uint8Array | undefined };
  font: GameFont;
  screen: Screen;
  video: Video;
  input: Input;
  /** null when there is no sound or BGM is off (0:978C / 0:987E check the option bit). */
  sound: SoundPlayer | null;
}

/** Runs END.EXE's ending of `type` in the browser; returns false when its files are missing. */
export async function runEnding(h: EndingHost, type: number): Promise<boolean> {
  const end = h.files.get('END.EXE');
  const end1 = h.files.get('END1GRP.R3');
  const end2 = h.files.get('END2GRP.R3');
  if (!end || !end1 || !end2) return false;
  const { video, input, sound } = h;
  const io: CutsceneIo = {
    screen: h.screen,
    setPalette: (p) => video.setPalette(p),
    frame: () => video.frame(),
    now: () => performance.now(),
    skip: () => {
      let hit = false;
      while (input.takeClick()) hit = true;
      while (input.takeKey() !== undefined) hit = true;
      return hit;
    },
    music: sound
      ? { play: (i, repeat) => sound.playSong(i, 'EDMUSIC.R3', repeat), fadeOut: (speed) => sound.fadeOut(speed) }
      : null,
  };
  const cursor = video.cursor;
  video.cursor = -1;
  input.flush();
  const e = new Ending(io, { end, end1, end2, font: h.font, edmusic: h.files.get('EDMUSIC.R3') });
  try {
    await playEnding(e, type & 0xffff);
  } finally {
    video.cursor = cursor;
    input.flush();
  }
  return true;
}
