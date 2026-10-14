// Presents the shared 640x480 indexed Screen on the canvas the way the original's VGA DAC shows it:
// 4-bit palette values go through GRPDRV's 4->6 bit scaling and the DAC's 6->8 bit expansion
// (formats/palette.ts), fades follow GRPDRV AH=16h step for step (fadeSteps), and the mouse cursor is
// the software cursor from MARK.R3 drawn on top (0000:BBCA; colour 7, hot spot (1,1), 0cf5:0F86).

import { HEIGHT, WIDTH, type Screen } from '../engine/screen';
import type { Input } from '../engine/input';
import { BLACK, dac6to8, fadeSteps, scale4to6, type Rgb4, type Rgb6 } from '../formats/palette';
import { decodeCursor, type MarkCursor } from '../formats/sprites';

/** Cursor shapes used by MAIN (index into the 12 cursors of MARK.R3 at 0x2338). */
export const CURSOR = { ARROW: 0, HAND: 1, WAIT_A: 10, WAIT_B: 11 } as const;

export class Video {
  /** While set, the DAC holds these values instead of screen.palette (fades, faded-out screens). */
  private dac: Rgb6[] | null = null;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private rgba: Uint32Array;
  private cursors: MarkCursor[] = [];
  /** Current cursor shape, -1 = hidden. */
  cursor = CURSOR.ARROW as number;
  /** Frames presented so far (60 Hz). */
  ticks = 0;
  private lastSig = '';

  constructor(
    readonly screen: Screen,
    readonly canvas: HTMLCanvasElement,
    readonly input: Input,
    mark: Uint8Array | null,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(WIDTH, HEIGHT);
    this.rgba = new Uint32Array(this.image.data.buffer);
    if (mark) for (let i = 0; i < 12; i++) this.cursors.push(decodeCursor(mark, 0x2338 + i * 0x90));
  }

  /** True while the display is forced to black (after fadeOut, before fadeIn). */
  get dark(): boolean {
    return this.dac !== null && this.dac.every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0);
  }

  present(force = false) {
    const pal: Rgb6[] =
      this.dac ?? this.screen.palette.map((c) => [scale4to6(c[0]), scale4to6(c[1]), scale4to6(c[2])] as Rgb6);
    const lut = new Uint32Array(16);
    for (let i = 0; i < 16; i++) lut[i] = 0xff000000 | (dac6to8(pal[i][2]) << 16) | (dac6to8(pal[i][1]) << 8) | dac6to8(pal[i][0]);
    const sig = `${this.input.x},${this.input.y},${this.cursor},${lut.join(',')}`;
    if (!force && !this.screen.dirty && sig === this.lastSig) return;
    this.lastSig = sig;
    const px = this.screen.pixels;
    const out = this.rgba;
    for (let i = 0; i < px.length; i++) out[i] = lut[px[i] & 15];
    const cur = this.cursors[this.cursor];
    if (cur && !this.dark) {
      // 0000:BBCA: screen AND mask, then OR colour 7 where the OR mask is set.
      const cx = this.input.x - 1;
      const cy = this.input.y - 1;
      for (let y = 0; y < 24; y++) {
        const sy = cy + y;
        if (sy < 0 || sy >= HEIGHT) continue;
        for (let x = 0; x < 24; x++) {
          const sx = cx + x;
          if (sx < 0 || sx >= WIDTH) continue;
          const k = y * 24 + x;
          const keep = cur.andMask[k] ? px[sy * WIDTH + sx] & 15 : 0;
          const c = cur.orMask[k] ? keep | 7 : keep;
          if (!cur.andMask[k] || cur.orMask[k]) out[sy * WIDTH + sx] = lut[c];
        }
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
    this.screen.dirty = false;
  }

  /** Waits for the next animation frame and presents. */
  frame(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.ticks++;
        this.present();
        resolve();
      };
      if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') requestAnimationFrame(done);
      else setTimeout(done, 16);
    });
  }

  async frames(n: number) {
    for (let i = 0; i < n; i++) await this.frame();
  }

  private currentRgb4(): Rgb4[] {
    if (!this.dac) return this.screen.palette.map((c) => [c[0], c[1], c[2]] as Rgb4);
    // fades always start from a settled DAC; map 6-bit values back to 4 bits
    return this.dac.map((c) => c.map((v) => v >> 2) as Rgb4);
  }

  /**
   * GRPDRV AH=16h as MAIN calls it (0cf5:497E / 4A22): `steps` steps, `waits` retraces before each.
   * Fading to black leaves the display dark until the next fadeIn/setPalette.
   */
  async fadeTo(target: Rgb4[], steps = 16, waits = 2) {
    const from = this.currentRgb4();
    for (const dac of fadeSteps(from, target, steps)) {
      this.dac = dac;
      this.screen.dirty = true;
      await this.frames(waits);
    }
    if (target === BLACK || target.every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0)) {
      this.dac = BLACK.map(() => [0, 0, 0] as Rgb6);
    } else {
      this.screen.setPalette(target);
      this.dac = null;
    }
    this.screen.dirty = true;
    this.present(true);
  }

  fadeOut(steps = 16, waits = 2) {
    return this.fadeTo(BLACK, steps, waits);
  }

  async fadeIn(palette: Rgb4[], steps = 16, waits = 2) {
    if (!this.dac) this.dac = BLACK.map(() => [0, 0, 0] as Rgb6);
    await this.fadeTo(palette, steps, waits);
  }

  /** GRPDRV AH=15h: set the palette at once (also ends a faded-out state). */
  setPalette(palette: Rgb4[]) {
    this.screen.setPalette(palette);
    this.dac = null;
    this.screen.dirty = true;
  }

  /** Forces the display black at once. */
  black() {
    this.dac = BLACK.map(() => [0, 0, 0] as Rgb6);
    this.screen.dirty = true;
  }
}
