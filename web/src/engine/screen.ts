// 640x480 indexed-colour framebuffer that mirrors the original VGA 16-colour screen.
// Palette entries are stored the way GRPDRV keeps them: 4 bits per channel (0..15).

export const WIDTH = 640;
export const HEIGHT = 480;

export type Rgb4 = [number, number, number];

export class Screen {
  readonly pixels = new Uint8Array(WIDTH * HEIGHT);
  readonly palette: Rgb4[] = Array.from({ length: 16 }, () => [0, 0, 0] as Rgb4);
  /** 0 = black, 256 = full brightness; used for fades. */
  brightness = 256;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private rgba: Uint32Array;
  dirty = true;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(WIDTH, HEIGHT);
    this.rgba = new Uint32Array(this.image.data.buffer);
  }

  setPalette(entries: Rgb4[], start = 0) {
    entries.forEach((e, i) => (this.palette[start + i] = [e[0], e[1], e[2]]));
    this.dirty = true;
  }

  clear(color = 0) {
    this.pixels.fill(color);
    this.dirty = true;
  }

  fillRect(x: number, y: number, w: number, h: number, color: number) {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(WIDTH, x + w), y1 = Math.min(HEIGHT, y + h);
    for (let yy = y0; yy < y1; yy++) this.pixels.fill(color, yy * WIDTH + x0, yy * WIDTH + x1);
    this.dirty = true;
  }

  /** Copies an indexed bitmap; pixels equal to `transparent` (if given) are skipped. */
  blit(src: Uint8Array, w: number, h: number, x: number, y: number, transparent = -1) {
    for (let yy = 0; yy < h; yy++) {
      const dy = y + yy;
      if (dy < 0 || dy >= HEIGHT) continue;
      for (let xx = 0; xx < w; xx++) {
        const dx = x + xx;
        if (dx < 0 || dx >= WIDTH) continue;
        const c = src[yy * w + xx];
        if (c !== transparent) this.pixels[dy * WIDTH + dx] = c;
      }
    }
    this.dirty = true;
  }

  /** Reads back a rectangle (for save-under of windows and sprites). */
  grab(x: number, y: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const dx = x + xx, dy = y + yy;
        out[yy * w + xx] = dx >= 0 && dx < WIDTH && dy >= 0 && dy < HEIGHT ? this.pixels[dy * WIDTH + dx] : 0;
      }
    }
    return out;
  }

  present() {
    if (!this.dirty) return;
    const lut = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const [r, g, b] = this.palette[i].map((v) => Math.min(255, ((v * 17) * this.brightness) >> 8));
      lut[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    const px = this.pixels, out = this.rgba;
    for (let i = 0; i < px.length; i++) out[i] = lut[px[i] & 15];
    this.ctx.putImageData(this.image, 0, 0);
    this.dirty = false;
  }
}
