// The opening (OPEN.EXE), played the way OPEN.EXE plays it: the same pictures from OPGRP.R3, the
// same palettes, captions and mask tables read from the player's OPEN.EXE, the same transitions and
// the same timing (see docs/GAMEFLOW.md, "The opening", and native/cutscene.ts for the primitives).
//
// Flow (0:2BC2): GRPDRV origin (0, 0x27), then 0:2D10 until it returns 0. 0:2D10 is one long straight
// sequence of calls; any wait that sees a mouse click jumps to its exit path 0:7365 (stop the palette
// cycle, fade the music at speed 0x50, fade to black, clear) and returns 0. When it runs to the end it
// returns 1 and 0:2BC2 starts it again, so the opening loops until the player clicks.
//
// openingScript() below is that call sequence in order, with the arguments of each call (x, y, width,
// height, buffer, offset, palette DS offset, caption list DS offset, wait target in 1/100 s since the
// last timer reset). It was taken from an instrumented run of OPEN.EXE (every helper call logged with
// its arguments) and checked against the disassembly; loops of the original are kept as loops where
// they are plain (candle, rider).
//
// OPGRP.R3 entries 27+ are damaged in the known copy of the game (docs/GRAPHICS.md); they are loaded
// with OPEN's own LS11 loader, garbage and all, so they show the same noise as the original does.

import type { Screen } from '../engine/screen';
import type { Input } from '../engine/input';
import type { SoundPlayer } from '../audio/player';
import type { GameFont } from '../formats/font';
import type { Video } from './video';
import { Cutscene, Dgroup, Ls11Archive, Skip, type CutsceneIo } from './cutscene';

/** OPEN.EXE's DGROUP paragraph, read from `mov ax, 0A90h` in the palette-cycle callback (0:2C87). */
export function openDgroupSeg(exe: Uint8Array): number {
  const hdr = (exe[8] | (exe[9] << 8)) * 16;
  const p = hdr + 0x2c87;
  return exe[p] === 0xb8 ? exe[p + 1] | (exe[p + 2] << 8) : 0xa90;
}

export interface OpeningFiles {
  open: Uint8Array; // OPEN.EXE
  opgrp: Uint8Array; // OPGRP.R3
  font: GameFont;
}

/** Makes the machine for OPEN.EXE (mask tables DS:EA and DS:F2, 0:76BC / 0:77CC). */
export function openingCutscene(io: CutsceneIo, files: OpeningFiles): Cutscene {
  const dg = new Dgroup(files.open, openDgroupSeg(files.open));
  // 0:2D10 runs with BP = DS:2EBE (emulator run): the archive object is its local at BP-0x112 = DS:2DAC
  // and the NPK ring at BP-0x75A = DS:2764; 0:9CC6, called from it, has its file buffer at DS:2346.
  const ds = new Uint8Array(0x10000);
  const archive = new Ls11Archive(files.opgrp, { ds, obj: 0x2dac, buf: 0x2346, handle: 6 });
  const c = new Cutscene({ io, dg, archive, font: files.font, mask16: 0xea, mask64: 0xf2, ringAddr: 0x2764, ds });
  return c;
}

/**
 * Plays the opening on `c`. Returns 'skipped' after a click, or 'done' when it ran to the end and
 * `loop` is false (with `loop` the original starts over, so it only ever ends by a click).
 */
export async function playOpening(c: Cutscene, loop = true): Promise<'skipped' | 'done'> {
  for (;;) {
    let done = false;
    try {
      await openingScript(c);
      done = true;
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
    }
    // 0:7365
    c.cycleOff();
    c.musicFade(0x50);
    await c.fadeTo(0x7a, false);
    c.cls();
    if (!done) return 'skipped';
    if (!loop) return 'done';
  }
}

export interface OpeningHost {
  files: { get(name: string): Uint8Array | undefined };
  font: GameFont;
  screen: Screen;
  video: Video;
  input: Input;
  /** null when there is no sound or BGM is off (OPEN 0:8806 checks the option bit). */
  sound: SoundPlayer | null;
}

/** The title menu's "오프닝을 본다": runs the opening in the browser until the player clicks or presses a key. */
export async function runOpening(h: OpeningHost): Promise<void> {
  const open = h.files.get('OPEN.EXE');
  const opgrp = h.files.get('OPGRP.R3');
  if (!open || !opgrp) return;
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
      ? { play: (i, repeat) => sound.playSong(i, 'OPMUSIC.R3', repeat), fadeOut: (speed) => sound.fadeOut(speed) }
      : null,
  };
  const cursor = video.cursor;
  video.cursor = -1;
  input.flush();
  const c = openingCutscene(io, { open, opgrp, font: h.font });
  try {
    await playOpening(c);
  } finally {
    video.cursor = cursor;
    input.flush();
  }
}

/** 0:2D10 */
export async function openingScript(c: Cutscene): Promise<void> {
  const [B0, B1, B2, B3, B4, B5] = c.seg;
  c.clearAll(); // 0:249E (GRPDRV AH=04h)
  await c.fadeTo(0x7a);
  c.cls();
  c.resetTimer();
  c.load(3, B0, 0);
  c.npk(216, 96, 208, 112, B0, 0x30);
  await c.fadeTo(0x1c8);
  c.resetTimer();
  c.load(53, B0, 0);
  await c.until(100);
  c.put(216, 224, 208, 24, B0, 0);
  await c.until(300);
  await c.fadeTo(0x7a);
  c.cls();
  c.load(61, B0, 0);
  c.npk(248, 120, 144, 56, B0, 0x30);
  c.load(54, B0, 0);
  c.npk(128, 192, 384, 40, B0, 0x30);
  await c.until(520);
  c.setPal(0x1c8);
  c.load(2, B0, 0);
  await c.until(620);
  c.put(128, 274, 400, 24, B0, 0);
  await c.until(800);
  await c.fadeTo(0x7a);
  c.cls();
  c.load(60, B0, 0);
  c.load(8, B1, 0);
  c.unpack(B1, 0, B2, 0);
  c.blit(B2, 0, 464, 272, 232, 168, 16, 24, 0, B0, 0);
  c.load(9, B3, 0);
  await c.until(1020);
  c.resetTimer();
  c.song(0, false); // OPMUSIC.R3 entry 0, repeat off (0:3096 -> 0:88B8)
  c.setPal(0x288);
  c.memset(B1, 0, 0xf680, 0);
  await c.wipe1(88, 32, 464, 272, B1, 0, B2, 0);
  await c.until(280);
  // 0:311A: a flickering candle, 8 frames of 16 x 24 from entry 60, three palettes in turn
  for (let i = 0; i < 8; i++) {
    await c.until(330 + 50 * i);
    c.put(320, 200, 16, 24, B0, 0xc0 * i);
    c.setPal([0x2b8, 0x2e8, 0x288][i % 3]);
  }
  c.get(208, 8, 224, 328, B1, 0);
  await c.until(780);
  await c.diss16(208, 8, 224, 328, B1, 0, B3, 0, 0x318);
  await c.fadeTo(0x318);
  c.text1(0x7a2, 0, 0, B3, 0);
  await c.until(1080);
  c.outline(48, 40, 544, 60, B3, 0);
  c.text1(0x81a, 0, 0, B3, 0);
  await c.until(1280);
  c.outline(48, 100, 392, 80, B3, 0);
  c.text1(0x886, 0, 0, B3, 0);
  await c.until(1480);
  c.outline(48, 180, 432, 60, B3, 0);
  c.text1(0x8c6, 0, 0, B3, 0);
  await c.until(1680);
  c.outline(48, 240, 456, 20, B3, 0);
  c.load(10, B0, 0);
  c.load(11, B4, 0);
  c.load(12, B3, 0);
  await c.until(2780);
  await c.fadeTo(0x7a);
  c.cls();
  c.npk(88, 32, 464, 272, B0, 0x30);
  c.get(216, 112, 152, 136, B1, 0);
  c.load(59, B0, 0);
  c.rop(4);
  c.put(320, 112, 48, 72, B0, 0);
  c.rop(0);
  c.load(13, B3, 0x1040);
  await c.until(3080);
  await c.fadeTo(0x348);
  await c.until(3280);
  // 0:3840 / 0:390D: the rider comes down the road (entry 13 frames, 48 x 72, over the saved background)
  for (let k = 0; k < 16; k++) {
    c.memcpy(B5, 0, B1, 0, 0x2860);
    if (k < 13) c.blit(B5, 0, 152, 136, 96 - 8 * k, 4 + 5 * k, 48, 72, 4, B0, [0x6c0, 0xd80, 0x1440, 0][k % 4]);
    else c.blit(B5, 0, 152, 136, 0, 64, 48, 72, 4, B0, 0x1b00 + 0x6c0 * (k - 13));
    c.put(216, 112, 152, 136, B5, 0);
    await c.until(3320 + 40 * k);
  }
  c.rop(0);
  c.text2(0x932, 0, 7, B0, 0);
  c.get(400, 184, 240, 168, B1, 0);
  await c.until(4020);
  await c.diss16(400, 184, 240, 168, B1, 0, B4, 0);
  c.get(464, 184, 80, 104, B1, 0);
  await c.until(4220);
  await c.diss16(464, 184, 80, 104, B1, 0, B3, 0);
  c.memset(B2, 0, 0x2e40, 0);
  await c.until(4370);
  await c.diss16(80, 320, 296, 40, B2, 0, B0, 0);
  await c.until(4770);
  await c.diss16(80, 320, 296, 40, B2, 0, B0, 0x1720);
  await c.until(4920);
  await c.diss16(464, 184, 80, 104, B1, 0, B3, 0x1040);
  await c.fadeTo(0x7a);
  c.cls();
  c.load(14, B0, 0);
  c.npk(88, 32, 464, 272, B0, 0x30);
  c.text2(0x996, 0, 7, B3, 0);
  c.put(80, 320, 440, 40, B3, 0);
  c.load(16, B0, 0);
  await c.until(5520);
  await c.fadeTo(0x378);
  c.load(17, B0, 0x7b40);
  await c.until(6120);
  await c.fadeTo(0x7a);
  c.cls();
  c.put(88, 32, 464, 272, B0, 0);
  c.text2(0xb22, 0, 7, B3, 0);
  c.put(80, 320, 504, 40, B3, 0);
  c.get(80, 320, 504, 40, B4, 0);
  await c.until(6520);
  await c.fadeTo(0x378);
  await c.until(6920);
  await c.diss16(80, 320, 504, 40, B4, 0, B3, 0x2760);
  c.load(21, B2, 0);
  await c.until(7320);
  await c.diss16(80, 320, 504, 40, B4, 0, B3, 0x4ec0);
  await c.until(7720);
  await c.diss16(80, 320, 504, 40, B4, 0, B3, 0x7620);
  await c.until(8120);
  await c.diss16(80, 320, 504, 40, B4, 0, B3, 0x9d80);
  await c.until(8520);
  await c.diss16(80, 320, 504, 40, B4, 0, B3, 0xc4e0);
  c.load(18, B0, 0);
  c.memset(B3, 0, 0x2760, 0);
  await c.until(8920);
  await c.diss16(80, 320, 504, 40, B4, 0, B3, 0);
  c.memset(B3, 0, 0xf680, 0);
  await c.wipe2(88, 32, 464, 272, B1, 0, B3, 0);
  c.text2(0xc34, 0, 7, B3, 0);
  c.setPal(0x7a);
  c.npk(88, 112, 464, 192, B0, 0x30);
  c.get(88, 112, 232, 192, B0, 0);
  c.load(19, B4, 0);
  c.npk(104, 160, 64, 72, B4, 0x30);
  c.load(20, B4, 0);
  c.npk(192, 120, 104, 104, B4, 0x30);
  c.get(88, 112, 232, 192, B4, 0);
  c.get(320, 112, 232, 192, B5, 0);
  c.cls();
  await c.until(9370);
  await c.fadeTo(0x3a8);
  await c.wipe1(88, 112, 232, 192, B1, 0, B0, 0);
  c.memset(B1, 0, 0x2d00, 0);
  await c.diss16(80, 320, 576, 40, B1, 0, B3, 0);
  c.get(80, 320, 576, 40, B1, 0);
  await c.until(9770);
  await c.diss16(80, 320, 576, 40, B1, 0, B3, 0x2d00);
  await c.until(10170);
  await c.diss16(80, 320, 576, 40, B1, 0, B3, 0x5a00);
  await c.until(10570);
  await c.diss16(80, 320, 576, 40, B1, 0, B3, 0x8700);
  c.get(88, 112, 232, 192, B0, 0);
  c.memset(B1, 0, 0x5700, 0);
  await c.until(10970);
  await c.diss16(88, 112, 232, 192, B0, 0, B4, 0);
  await c.until(11170);
  await c.diss64(320, 112, 232, 192, B1, 0, B5, 0);
  c.text2(0xd24, 0, 7, B3, 0);
  c.get(360, 0, 240, 256, B1, 0);
  await c.until(11420);
  await c.diss16(360, 0, 240, 256, B1, 0, B2, 0);
  c.memset(B2, 0, 0x2580, 0);
  await c.until(11820);
  await c.diss16(80, 320, 480, 40, B2, 0, B3, 0);
  c.load(23, B1, 0);
  await c.until(12220);
  c.load(24, B1, 0x7b40);
  await c.until(12620);
  await c.diss16(80, 320, 480, 40, B2, 0, B3, 0x2580);
  c.load(55, B0, 0);
  c.load(56, B4, 0);
  await c.until(13220);
  await c.fadeTo(0x7a);
  c.cls();
  c.put(88, 32, 464, 272, B1, 0);
  c.put(80, 320, 480, 40, B3, 0x7080);
  await c.until(13620);
  await c.fadeTo(0x3a8);
  c.load(58, B3, 0);
  c.memset(B2, 0, 0xf680, 0);
  await c.until(14220);
  await c.diss16(88, 32, 464, 272, B1, 0, B2, 0);
  c.load(57, B2, 0);
  await c.until(14620);
  await c.fadeTo(0x7a);
  c.cls();
  c.npk(0, 16, 640, 92, B0, 0x30);
  c.npk(0, 108, 640, 92, B4, 0x30);
  c.npk(0, 200, 640, 92, B2, 0x30);
  c.npk(0, 292, 640, 92, B3, 0x30);
  c.text1(0xef0, 0, 0, B4, 0);
  c.get(0, 120, 632, 128, B3, 0);
  c.outline(0, 128, 632, 120, B4, 0x2508);
  c.get(0, 120, 632, 128, B5, 0);
  c.put(0, 120, 632, 128, B3, 0);
  c.memcpy(B2, 0, B3, 0, 0x9e00);
  c.outline(0, 128, 632, 120, B4, 0);
  c.get(0, 120, 632, 128, B1, 0);
  c.put(0, 120, 632, 128, B3, 0);
  await c.until(15020);
  await c.fadeTo(0x6a8);
  await c.diss16(0, 120, 632, 128, B3, 0, B1, 0);
  await c.until(16320);
  await c.diss16(0, 120, 632, 128, B1, 0, B3, 0);
  await c.until(16620);
  await c.diss16(0, 120, 632, 128, B3, 0, B5, 0);
  await c.until(17170);
  c.load(7, B0, 0);
  await c.until(17820);
  await c.diss16(0, 120, 632, 128, B5, 0, B2, 0);
  c.get(68, 140, 504, 116, B1, 0);
  c.load(4, B3, 0);
  await c.until(18020);
  await c.diss16(68, 140, 504, 116, B1, 0, B0, 0, 0x1f8);
  c.load(6, B0, 0);
  c.get(68, 140, 504, 116, B2, 0);
  await c.until(18545);
  c.rop(4);
  c.put(160, 200, 320, 8, B3, 0x280);
  c.rop(0);
  c.memcpy(B5, 0, B2, 0, 0x7230);
  c.blit(B5, 0, 504, 116, 0, 0, 504, 116, 4, B0, 0);
  c.put(68, 140, 504, 116, B5, 0);
  c.rop(4);
  c.load(1, B0, 0);
  c.get(368, 384, 264, 16, B1, 0);
  await c.until(18915);
  c.setPal(0x228);
  await c.until(18945);
  await c.fadeTo(0x258);
  await c.until(19175);
  await c.diss16(368, 384, 264, 16, B1, 0, B0, 0);
  c.load(25, B2, 0);
  c.memset(B1, 0, 0x7800, 0);
  c.load(26, B0, 0);
  await c.until(19700);
  await c.fadeTo(0x7a);
  c.cls();
  c.cycle(30, 0x70e);
  await c.until(20100);
  c.song(1, true); // entry 1 for the title, repeating
  await c.wipe1(0, 144, 640, 96, B1, 0, B2, 0);
  c.get(280, 0, 360, 320, B2, 0);
  c.memcpy(B3, 0, B2, 0, 0xe100);
  c.blit(B3, 0, 360, 320, 0, 0, 360, 320, 4, B0, 0);
  c.get(280, 0, 360, 320, B1, 0);
  await c.until(20500);
  await c.diss16(280, 0, 360, 320, B1, 0, B3, 0);
  c.text1(0xfc8, 0, 0, B3, 0);
  c.get(96, 160, 448, 80, B0, 0);
  await c.until(20900);
  c.put(96, 160, 448, 80, B0, 0);
  c.outline(96, 160, 448, 80, B3, 0);
  c.get(96, 160, 448, 80, B3, 0);
  await c.until(22100);
  await c.diss16(96, 160, 448, 80, B3, 0, B0, 0);
  await c.until(22300);
  c.get(280, 0, 360, 320, B1, 0);
  await c.diss16(280, 0, 360, 320, B1, 0, B2, 0);
  c.load(27, B0, 0);
  c.get(0, 0, 352, 320, B2, 0);
  c.memcpy(B3, 0, B2, 0, 0xdc00);
  c.blit(B3, 0, 352, 320, 0, 0, 352, 320, 4, B0, 0);
  c.get(0, 0, 352, 320, B1, 0);
  await c.until(22800);
  await c.diss16(0, 0, 352, 320, B1, 0, B3, 0);
  await c.until(23200);
  await c.diss16(0, 0, 352, 320, B1, 0, B2, 0);
  await c.until(23400);
  c.cycleOff();
  await c.fadeTo(0x7a);
  c.load(28, B0, 0);
  c.load(31, B1, 0);
  c.npk(0, 144, 640, 96, B0, 0x30);
  c.get(192, 144, 144, 56, B2, 0);
  c.load(29, B0, 0);
  await c.until(23700);
  await c.fadeTo(0x498);
  await c.until(24200);
  await c.until(24400);
  c.setPal(0x4c8);
  await c.until(24410);
  c.setPal(0x498);
  await c.until(24510);
  c.setPal(0x4c8);
  await c.until(24520);
  c.setPal(0x498);
  await c.until(24530);
  c.setPal(0x4c8);
  await c.until(24540);
  c.setPal(0x498);
  await c.until(24640);
  c.npk(192, 144, 144, 56, B0, 0x30);
  c.load(30, B0, 0);
  c.npk(40, 216, 240, 160, B0, 0x30);
  c.setPal(0x4c8);
  await c.until(24690);
  c.put(192, 144, 144, 56, B2, 0);
  await c.fadeTo(0x498);
  await c.until(25090);
  c.setPal(0x4c8);
  await c.until(25100);
  c.setPal(0x498);
  await c.until(25200);
  c.setPal(0x4c8);
  await c.until(25210);
  c.setPal(0x498);
  await c.until(25220);
  c.setPal(0x4c8);
  await c.until(25230);
  c.setPal(0x498);
  c.rop(0);
  c.get(280, 0, 360, 320, B2, 0);
  c.memcpy(B3, 0, B2, 0, 0xe100);
  await c.until(25330);
  c.blit(B3, 0, 360, 320, 0, 0, 360, 320, 4, B1, 0);
  await c.diss16(280, 0, 360, 320, B2, 0, B3, 0);
  c.setPal(0x4c8);
  await c.until(25450);
  await c.fadeTo(0x498);
  await c.until(25630);
  c.setPal(0x4c8);
  await c.until(25640);
  c.setPal(0x498);
  c.text1(0x103e, 0, 0, B3, 0);
  c.get(72, 152, 488, 40, B0, 0);
  await c.until(25940);
  c.put(72, 152, 488, 40, B0, 0);
  c.outline(72, 152, 488, 40, B3, 0);
  c.get(72, 152, 488, 40, B1, 0);
  c.get(72, 152, 488, 40, B3, 0);
  c.text2(0x10a6, 0, 7, B3, 0);
  c.memset(B4, 0, 0x780, 0);
  await c.until(27140);
  await c.fadeTo(0x7a);
  c.cls();
  c.load(32, B0, 0);
  c.memset(B1, 0, 0xf000, 0);
  await c.until(27540);
  await c.diss16(0, 0, 384, 320, B1, 0, B0, 0, 0x528);
  c.load(33, B0, 0);
  c.get(256, 0, 384, 208, B1, 0);
  c.get(256, 0, 384, 208, B2, 0);
  c.setPal(0x528);
  await c.until(28140);
  await c.diss16(256, 0, 384, 208, B1, 0, B0, 0);
  await c.diss16(200, 384, 240, 16, B4, 0, B3, 0x960);
  c.load(34, B0, 0);
  await c.until(28740);
  await c.fadeTo(0x558);
  await c.until(28940);
  await c.diss16(256, 0, 384, 208, B1, 0, B2, 0);
  c.get(416, 0, 192, 320, B1, 0);
  c.get(416, 0, 192, 320, B2, 0);
  c.setPal(0x528);
  await c.until(29140);
  await c.diss16(416, 0, 192, 320, B1, 0, B0, 0);
  await c.diss16(200, 384, 240, 16, B4, 0, B3, 0x12c0);
  c.load(35, B0, 0);
  await c.until(29740);
  await c.fadeTo(0x558);
  await c.until(29940);
  await c.diss16(416, 0, 192, 320, B1, 0, B2, 0);
  c.get(384, 8, 224, 184, B1, 0);
  c.get(384, 8, 224, 184, B2, 0);
  c.setPal(0x528);
  await c.until(30140);
  await c.diss16(384, 8, 224, 184, B1, 0, B0, 0);
  await c.diss16(200, 384, 240, 16, B4, 0, B3, 0);
  await c.until(30740);
  await c.fadeTo(0x558);
  await c.until(30940);
  await c.diss16(384, 8, 224, 184, B1, 0, B2, 0);
  await c.until(31140);
  await c.diss16(200, 384, 240, 16, B4, 0, B3, 0x1c20);
  c.load(36, B0, 0);
  await c.until(31540);
  await c.fadeTo(0x7a);
  c.cls();
  c.npk(0, 144, 640, 96, B0, 0x30);
  c.get(0, 144, 640, 96, B1, 0);
  c.get(0, 0, 320, 320, B5, 0);
  await c.until(31940);
  await c.fadeTo(0x5b8);
  c.cycle(30, 0x722);
  c.text1(0x111c, 0, 0, B4, 0);
  c.load(37, B0, 0);
  c.get(0, 0, 320, 320, B2, 0);
  c.memcpy(B3, 0, B2, 0, 0xc800);
  c.blit(B3, 0, 320, 320, 0, 0, 320, 320, 4, B0, 0);
  await c.until(32540);
  await c.diss16(0, 0, 320, 320, B2, 0, B3, 0);
  c.halveCyclePeriod(); // 0:6232 shr byte [1569h], 1
  c.get(208, 152, 448, 40, B0, 0);
  await c.until(32940);
  c.put(208, 152, 448, 40, B0, 0);
  c.outline(208, 152, 448, 40, B4, 0);
  c.get(208, 152, 448, 40, B3, 0);
  c.get(208, 152, 448, 40, B4, 0);
  await c.until(34140);
  await c.diss16(208, 152, 448, 40, B4, 0, B0, 0);
  c.load(40, B0, 0);
  c.get(344, 8, 240, 160, B2, 0);
  c.memcpy(B3, 0, B2, 0, 0x4b00);
  c.memcpy(B4, 0, B2, 0, 0x4b00);
  c.blit(B3, 0, 240, 160, 0, 0, 240, 160, 4, B0, 0);
  await c.until(34440);
  await c.diss16(344, 8, 240, 160, B2, 0, B3, 0);
  c.get(0, 0, 320, 320, B2, 0);
  await c.until(34840);
  await c.diss16(0, 0, 320, 320, B2, 0, B5, 0);
  c.get(344, 8, 240, 160, B2, 0);
  await c.diss16(344, 8, 240, 160, B2, 0, B4, 0);
  c.text1(0x117e, 0, 0, B3, 0);
  c.load(41, B0, 0);
  c.get(368, 0, 272, 320, B2, 0);
  c.memcpy(B5, 0, B2, 0, 0xaa00);
  c.memcpy(B1, 0, B2, 0, 0xaa00);
  c.blit(B5, 0, 272, 320, 0, 0, 272, 320, 4, B0, 0);
  await c.until(35440);
  await c.diss16(368, 0, 272, 320, B2, 0, B5, 0);
  c.load(42, B0, 0);
  c.get(56, 8, 240, 160, B2, 0);
  c.memcpy(B4, 0, B2, 0, 0x4b00);
  c.memcpy(B5, 0, B2, 0, 0x4b00);
  c.blit(B5, 0, 240, 160, 0, 0, 240, 160, 4, B0, 0);
  await c.until(35840);
  await c.diss16(56, 8, 240, 160, B2, 0, B5, 0);
  c.memcpy(B5, 0, B4, 0, 0x4b00);
  c.get(48, 168, 288, 60, B4, 0);
  c.put(48, 168, 288, 60, B4, 0);
  await c.until(36040);
  c.outline(48, 168, 288, 60, B3, 0);
  c.textColor(0, 7, 0);
  c.get(48, 168, 288, 60, B3, 0);
  c.get(368, 0, 272, 320, B2, 0);
  await c.until(36640);
  await c.diss16(368, 0, 272, 320, B2, 0, B1, 0);
  c.get(56, 8, 240, 160, B2, 0);
  await c.diss16(56, 8, 240, 160, B2, 0, B5, 0);
  c.memset(B0, 0, 0x7800, 0);
  c.get(0, 144, 640, 96, B1, 0);
  await c.until(37040);
  await c.diss16(0, 144, 640, 96, B1, 0, B0, 0);
  c.cycleOff();
  c.load(44, B0, 0);
  c.memset(B2, 0, 0x580, 0);
  await c.until(37240);
  await c.diss16(272, 152, 88, 32, B2, 0, B0, 0, 0x678);
  await c.until(37440);
  c.put(272, 152, 88, 32, B0, 0x580);
  await c.until(37490);
  c.put(272, 152, 88, 32, B0, 0xb00);
  await c.until(37690);
  c.put(272, 152, 88, 32, B0, 0x1080);
  c.load(43, B0, 0);
  c.get(224, 56, 184, 248, B1, 0);
  await c.until(37990);
  await c.diss16(224, 56, 184, 248, B1, 0, B0, 0);
  c.load(45, B0, 0);
  c.memset(B5, 0, 0x7800, 0);
  c.blit(B5, 0, 192, 320, 8, 0, 176, 320, 4, B0, 0);
  c.get(224, 32, 192, 320, B2, 0);
  await c.until(38790);
  await c.diss16(224, 32, 192, 320, B2, 0, B5, 0);
  c.load(46, B0, 0);
  c.load(47, B0, 0x1000);
  c.load(48, B0, 0x2000);
  c.get(288, 64, 64, 128, B2, 0);
  await c.until(39190);
  await c.diss16(288, 64, 64, 128, B2, 0, B0, 0x1000);
  c.load(51, B1, 0);
  c.get(424, 32, 176, 320, B2, 0);
  await c.until(39590);
  await c.diss16(424, 32, 176, 320, B2, 0, B1, 0);
  c.load(49, B1, 0);
  c.get(288, 64, 64, 128, B2, 0);
  await c.until(39990);
  await c.diss16(288, 64, 64, 128, B2, 0, B0, 0);
  await c.until(40090);
  await c.diss16(288, 64, 64, 128, B2, 0, B0, 0x2000);
  c.get(40, 32, 176, 320, B2, 0);
  await c.until(40490);
  await c.diss16(40, 32, 176, 320, B2, 0, B1, 0);
  c.get(56, 64, 480, 184, B2, 0);
  c.memcpy(B4, 0, B2, 0, 0xe880);
  c.blit(B4, 0, 480, 184, 232, 0, 64, 128, 0, B0, 0);
  c.load(50, B1, 0);
  c.unpack(B1, 0, B5, 0);
  c.blit(B4, 0, 480, 184, 0, 80, 72, 104, 0, B5, 0);
  c.load(52, B1, 0);
  c.unpack(B1, 0, B5, 0);
  c.blit(B4, 0, 480, 184, 416, 16, 64, 88, 0, B5, 0);
  await c.until(40890);
  await c.diss16(56, 64, 480, 184, B2, 0, B4, 0);
  await c.until(41490);
  await c.fadeTo(0x7a);
  c.cls();
  c.setPal(0x678);
  c.text2(0x11e0, 0, 7, B3, 0);
  c.memset(B0, 0, 0x24e0, 0);
  await c.until(41690);
  await c.diss16(80, 176, 472, 40, B0, 0, B3, 0);
  c.memset(B1, 0, 0x24e0, 0);
  await c.until(42490);
  await c.diss16(80, 176, 472, 40, B0, 0, B1, 0);
}
