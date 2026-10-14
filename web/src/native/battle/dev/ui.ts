// A small stand-in for the field engine's Ui, used only by the battle dev harness and the tests:
// plain framed boxes, the game font, click/key to continue. With `auto` every box returns at once
// (message: continue, confirm: yes, menu: first enabled item).

import type { Ui } from '../../context';
import type { Message } from '../../../formats/scenario';
import type { Screen } from '../../../engine/screen';
import type { Input } from '../../../engine/input';
import { HEIGHT, WIDTH } from '../../../engine/screen';
import { TextConsole, type GameFont } from '../../../formats/font';
import type { Rgb4 } from '../../../formats/palette';
import { euc } from '../strings';

const bytesOf = (t: Message | string): Uint8Array => (typeof t === 'string' ? euc(t) : t.bytes);

export interface DevUiOptions {
  auto?: boolean;
  /** Called for every box (tests log the texts). */
  log?: (kind: string, text: string) => void;
  /** Wait for the next animation frame (browser) or not at all (tests). */
  nextFrame?: () => Promise<void>;
  /** Menu answers for auto mode, consumed in order (-1 = cancel); default the first enabled item. */
  menuAnswers?: number[];
}

export class DevUi implements Ui {
  constructor(
    readonly screen: Screen,
    readonly input: Input,
    readonly font: GameFont,
    readonly opts: DevUiOptions = {},
  ) {}

  private text(b: Uint8Array, col: number, y: number, right = 79, fg = 7) {
    const dst = { width: WIDTH, height: HEIGHT, pixels: this.screen.pixels };
    const tc = new TextConsole(this.font, dst, { fg, mode: 4, outline: true, outlineColor: 0, x: col, y, left: col, margin: col, right, bottom: HEIGHT - 1, lineHeight: 18 });
    tc.write(b);
    return tc.s.y;
  }

  private lines(b: Uint8Array, cols: number): number {
    let n = 1;
    let c = 0;
    for (let i = 0; i < b.length; i++) {
      const v = b[i];
      if (v === 0x0a) {
        n++;
        c = 0;
        continue;
      }
      if (v === 0x1b) {
        i += 2;
        continue;
      }
      const w = v >= 0xa1 ? 2 : 1;
      if (w === 2) i++;
      if (c + w > cols) {
        n++;
        c = 0;
      }
      c += w;
    }
    return n;
  }

  private box(x: number, y: number, w: number, h: number) {
    const s = this.screen;
    s.fillRect(x, y, w, h, 1);
    s.fillRect(x, y, w, 2, 7);
    s.fillRect(x, y + h - 2, w, 2, 7);
    s.fillRect(x, y, 2, h, 7);
    s.fillRect(x + w - 2, y, 2, h, 7);
    s.fillRect(x + 2, y + 2, w - 4, 1, 0);
    s.fillRect(x + 2, y + h - 3, w - 4, 1, 0);
  }

  private async waitInput(): Promise<'left' | 'right'> {
    this.input.flush();
    for (;;) {
      await this.frame();
      const k = this.input.takeKey();
      if (k === 'Escape') return 'right';
      if (k === 'Enter' || k === ' ') return 'left';
      const c = this.input.takeClick();
      if (c) return c.button;
    }
  }

  async message(t: Message | string, opts?: { face?: number; name?: string }): Promise<void> {
    const b = bytesOf(t);
    this.opts.log?.('message', (opts?.name ? opts.name + ': ' : '') + new TextDecoder('euc-kr').decode(b));
    if (this.opts.auto) return;
    const n = this.lines(b, 64) + (opts?.name ? 1 : 0);
    const h = n * 18 + 24;
    const x = 64;
    const y = Math.min(300, 440 - h);
    const under = this.screen.grab(x, y, 512, h);
    this.box(x, y, 512, h);
    let ty = y + 12;
    if (opts?.name) {
      this.text(euc(opts.name), (x >> 3) + 2, ty, 79, 6);
      ty += 18;
    }
    this.text(b, (x >> 3) + 2, ty, (x >> 3) + 2 + 63);
    await this.waitInput();
    this.screen.blit(under, 512, h, x, y);
  }

  async confirm(t: Message | string, opts?: { face?: number; name?: string }): Promise<boolean> {
    const b = bytesOf(t);
    this.opts.log?.('confirm', new TextDecoder('euc-kr').decode(b));
    if (this.opts.auto) return true;
    const n = this.lines(b, 56) + (opts?.name ? 1 : 0);
    const h = n * 18 + 56;
    const x = 96;
    const y = Math.min(260, 440 - h);
    const under = this.screen.grab(x, y, 448, h);
    this.box(x, y, 448, h);
    this.text(b, (x >> 3) + 2, y + 12, (x >> 3) + 57);
    const by = y + h - 32;
    const yes = { x: x + 120, y: by, w: 64, h: 22 };
    const no = { x: x + 264, y: by, w: 64, h: 22 };
    for (const [r, label] of [[yes, '예'], [no, '아니오']] as const) {
      this.screen.fillRect(r.x, r.y, r.w, r.h, 2);
      this.text(euc(label), (r.x >> 3) + 1, r.y + 3);
    }
    this.input.flush();
    let res = false;
    for (;;) {
      await this.frame();
      const k = this.input.takeKey();
      if (k === 'Enter' || k === 'y') {
        res = true;
        break;
      }
      if (k === 'Escape' || k === 'n') break;
      const c = this.input.takeClick();
      if (!c) continue;
      if (c.button === 'right') break;
      const inside = (r: typeof yes) => c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h;
      if (inside(yes)) {
        res = true;
        break;
      }
      if (inside(no)) break;
    }
    this.screen.blit(under, 448, h, x, y);
    return res;
  }

  async menu(items: (Message | string)[], opts?: { x?: number; y?: number; title?: string; disabled?: boolean[] }): Promise<number> {
    const bs = items.map(bytesOf);
    this.opts.log?.('menu', bs.map((b) => new TextDecoder('euc-kr').decode(b)).join(' | '));
    const dis = opts?.disabled ?? [];
    if (this.opts.auto) {
      const a = this.opts.menuAnswers?.shift();
      if (a !== undefined) return a;
      const i = bs.findIndex((_, k) => !dis[k]);
      return i;
    }
    const cols = Math.max(8, ...bs.map((b) => b.length)) + 2;
    const w = cols * 8 + 8;
    const ih = 24;
    const h = bs.length * ih + 8;
    const x = Math.max(0, Math.min(WIDTH - w, opts?.x ?? 200));
    const y = Math.max(0, Math.min(HEIGHT - h, opts?.y ?? 120));
    const under = this.screen.grab(x, y, w, h);
    this.input.flush();
    let res = -1;
    for (;;) {
      this.screen.fillRect(x, y, w, h, 13);
      this.screen.fillRect(x + 1, y + 1, w - 2, h - 2, 0);
      const hov = this.input.x >= x && this.input.x < x + w ? Math.floor((this.input.y - y - 4) / ih) : -1;
      bs.forEach((b, i) => {
        const iy = y + 4 + i * ih;
        this.screen.fillRect(x + 4, iy, w - 8, ih - 2, dis[i] ? 13 : i === hov ? 6 : 2);
        this.text(b, ((x + 4) >> 3) + 1 + ((cols - 2 - b.length) >> 1), iy + 3, 79, dis[i] ? 0 : 7);
      });
      await this.frame();
      const k = this.input.takeKey();
      if (k === 'Escape') break;
      const c = this.input.takeClick();
      if (!c) continue;
      if (c.button === 'right') break;
      const i = Math.floor((c.y - y - 4) / ih);
      if (c.x >= x && c.x < x + w && i >= 0 && i < bs.length && !dis[i]) {
        res = i;
        break;
      }
      if (c.x < x || c.x >= x + w || c.y < y || c.y >= y + h) break;
    }
    this.screen.blit(under, w, h, x, y);
    return res;
  }

  async caption(t: Message | string): Promise<void> {
    const b = bytesOf(t);
    this.opts.log?.('caption', new TextDecoder('euc-kr').decode(b));
    if (this.opts.auto) return;
    const w = b.length * 8 + 32;
    const x = (WIDTH - w) >> 1;
    const y = 220;
    const under = this.screen.grab(x, y, w, 36);
    this.box(x, y, w, 36);
    this.text(b, (x >> 3) + 2, y + 10);
    this.input.flush();
    for (let i = 0; i < 90; i++) {
      await this.frame();
      if (this.input.takeClick() || this.input.takeKey()) break;
    }
    this.screen.blit(under, w, 36, x, y);
  }

  setTitle(t: Message | string): void {
    this.opts.log?.('title', new TextDecoder('euc-kr').decode(bytesOf(t)));
  }

  async fadeOut(steps = 16): Promise<void> {
    if (this.opts.auto) return;
    for (let i = steps; i >= 0; i--) {
      this.screen.brightness = (256 * i) / steps;
      this.screen.dirty = true;
      await this.frame();
    }
  }

  async fadeIn(palette: Rgb4[], steps = 16): Promise<void> {
    this.screen.setPalette(palette);
    if (this.opts.auto) {
      this.screen.brightness = 256;
      return;
    }
    for (let i = 0; i <= steps; i++) {
      this.screen.brightness = (256 * i) / steps;
      this.screen.dirty = true;
      await this.frame();
    }
  }

  async frame(): Promise<void> {
    this.screen.present();
    if (this.opts.nextFrame) await this.opts.nextFrame();
  }

  async wait(ms: number): Promise<void> {
    if (this.opts.auto) return;
    const end = performance.now() + ms;
    while (performance.now() < end) await this.frame();
  }
}
