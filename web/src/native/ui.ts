// The original's windows, message boxes, menus and the main frame (implements context.ts Ui).
//
// Geometry is MAIN.EXE's, in layout coordinates converted to screen (y + 40):
//  * message boxes: 0cf5:c15a -> 28b6, window table DS:0x2d58 (8 bytes per kind: x, y, w, h), style 6
//    pattern 4; speaker portrait by 0cf5:51b2, name in colour 6, text in colour 7, 20-pixel lines;
//  * captions: 0cf5:3c5e (centre 272, layout y 0x90, 16-pixel lines);
//  * menus: 0cf5:2c92 (style 2 pattern 2, 24-pixel button rows);
//  * main frame: 0cf5:c456 (PACKGRP 0 at y 40), status fields 0cf5:c362 / c39a / c3d4, title bar
//    0cf5:c30e, hover name 1cb6:17e4; fields are cleared with 16x16 patches grabbed from the frame
//    (0cf5:4558 into DS:0x7206 / 0x7286, tiled by 0cf5:52ee).

import type { Ui } from './context';
import type { Message } from '../formats/scenario';
import type { Rgb4 } from '../formats/palette';
import type { Input } from '../engine/input';
import type { IndexedImage } from '../formats/sprites';
import type { GameAssets } from './assets';
import { CURSOR, type Video } from './video';
import { Draw, LAYOUT_Y, bytesOf, textCols, buttonRect, inRect, type Button, type Rect, type Saved } from './draw';

export type Text = Message | string | Uint8Array;

/** Window kinds of the table DS:0x2d58 (x, layout y, w, h). */
export const WINDOWS: Rect[] = [
  { x: 80, y: 200, w: 384, h: 128 },
  { x: 80, y: 112, w: 384, h: 128 },
  { x: 32, y: 112, w: 384, h: 128 },
  { x: 64, y: 208, w: 416, h: 112 },
  { x: 128, y: 32, w: 384, h: 112 },
];

export interface MessageOptions {
  /** FACEDAT portrait index (officer speakers only). */
  face?: number;
  name?: Text;
  /** Window kind (WINDOWS index), default 3 for talk and 0 for narration. */
  kind?: number;
  /** Talk window moved to the top (layout y 0x20) when the speaker stands low on the map (map y > 9). */
  top?: boolean;
  /** false = draw and return without waiting (the window is left on screen). */
  wait?: boolean;
  /** Show yes/no buttons on the last page; resolves true for yes. */
  yesNo?: boolean;
  /** Keep the window on screen after it closes (no restore). */
  keep?: boolean;
}

export interface MenuOptions {
  /** Left edge (screen x) and top (screen y) of the menu window. */
  x?: number;
  y?: number;
  title?: string;
  disabled?: boolean[];
  /** Do not restore the screen under the menu (title menu, flag 0x40). */
  keep?: boolean;
  /** Right click cancels (default true). */
  cancel?: boolean;
  /** Centre x when `x` is not given (default: the caption centre). */
  cx?: number;
  /** Minimum label width in columns (1cf5:2c92 starts its maximum at 8). */
  cols?: number;
}

/** Splits text into window lines the way 0cf5:0A2E wraps it (left col .. right col, CR/LF). */
export function layoutLines(bytes: Uint8Array, cols: number): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let cur: number[] = [];
  let x = 0;
  let skipSpace = false;
  const newline = () => {
    lines.push(Uint8Array.from(cur));
    cur = [];
    x = 0;
    skipSpace = true;
  };
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x0a) {
      newline();
      continue;
    }
    if (c === 0x0d) {
      // CR only returns to the margin; the LF that follows breaks the line (SCRIPT.md: '\r' ignored)
      skipSpace = true;
      continue;
    }
    if (c < 0x20) continue;
    const dbl = c > 0xa0 && c < 0xc9 && i + 1 < bytes.length;
    const width = dbl ? 2 : 1;
    if (x + width > cols) newline();
    if (skipSpace && c === 0x20) {
      skipSpace = false;
      continue;
    }
    skipSpace = false;
    if (dbl) {
      cur.push(c, bytes[++i]);
    } else cur.push(c);
    x += width;
  }
  if (cur.length) lines.push(Uint8Array.from(cur));
  return lines;
}

export class GameUi implements Ui {
  /** Frame picture (PACKGRP 0) as drawn at y 40, kept to clear fields. */
  private framePic: IndexedImage | null = null;
  private patches: IndexedImage[] = [];
  /** Title text of message bar 1 (DS:0xdb4c). */
  title: Uint8Array = new Uint8Array(0);
  private hover = '';
  /** Called whenever a wait for input is running each frame (field animation hooks). */
  onIdle: (() => void) | null = null;
  /** Speed setting (+0x13): message waits. */
  speed = 2;

  constructor(
    readonly draw: Draw,
    readonly video: Video,
    readonly input: Input,
    readonly assets: GameAssets,
  ) {}

  // ------------------------------------------------------------------ Ui basics

  frame(): Promise<void> {
    return this.video.frame();
  }

  async wait(ms: number) {
    const end = performance.now() + ms;
    while (performance.now() < end) await this.video.frame();
  }

  fadeOut(steps = 16) {
    return this.video.fadeOut(steps);
  }

  fadeIn(palette: Rgb4[], steps = 16) {
    return this.video.fadeIn(palette, steps);
  }

  /** Next click: 'left' / 'right' (Enter/Space = left, Escape = right). */
  async click(cursor: number = this.video.cursor): Promise<{ button: 'left' | 'right'; x: number; y: number }> {
    const prev = this.video.cursor;
    this.video.cursor = cursor;
    try {
      for (;;) {
        const c = this.input.takeClick();
        if (c) return c;
        const k = this.input.takeKey();
        if (k === 'Enter' || k === ' ') return { button: 'left', x: this.input.x, y: this.input.y };
        if (k === 'Escape') return { button: 'right', x: this.input.x, y: this.input.y };
        this.onIdle?.();
        await this.video.frame();
      }
    } finally {
      this.video.cursor = prev;
    }
  }

  /** 0cf5:25a6: waits for a click with the alternating wait cursor (MARK cursors 10 / 11). */
  async waitClick(): Promise<'left' | 'right'> {
    this.input.flush();
    const prev = this.video.cursor;
    let t = 0;
    try {
      for (;;) {
        this.video.cursor = (t++ >> 4) & 1 ? CURSOR.WAIT_B : CURSOR.WAIT_A;
        const c = this.input.takeClick();
        if (c) return c.button;
        const k = this.input.takeKey();
        if (k === 'Enter' || k === ' ') return 'left';
        if (k === 'Escape') return 'right';
        this.onIdle?.();
        await this.video.frame();
      }
    } finally {
      this.video.cursor = prev;
    }
  }

  // ------------------------------------------------------------------ text helpers

  text(t: Text | Uint8Array, col: number, y: number, fg = 7, mode = 4) {
    return this.draw.text(bytesOf(t), col, y, { fg, mode });
  }

  // ------------------------------------------------------------------ message boxes

  private portrait(face: number, x: number, y: number) {
    const img = this.assets.face(face);
    if (img) this.draw.image(img, x, y);
  }

  /**
   * 0cf5:28b6: a framed message window with optional portrait and name. Pages long text; resolves
   * when the last page is acknowledged (or the yes/no answer when `yesNo`).
   */
  async messageBox(t: Text, o: MessageOptions = {}): Promise<boolean> {
    const kind = o.kind ?? (o.name !== undefined ? 3 : 0);
    const win = { ...WINDOWS[kind] };
    if (o.top && kind === 3) win.y = 0x20;
    const x = win.x, y = win.y + LAYOUT_Y, w = win.w, h = win.h;
    const officer = o.face !== undefined;
    const speaker = o.name !== undefined;
    const lines = Math.floor((h - 16) / 20);
    const margin = (h - 20 * lines - 16) >> 1;
    const col = (officer ? 12 : 2) + (x >> 3);
    const cols = (w >> 3) - (officer ? 14 : 4);
    const perPage = Math.max(1, lines - (speaker ? 1 : 0));
    const all = layoutLines(bytesOf(t), cols);
    if (!all.length) all.push(new Uint8Array(0));
    const saved = o.keep ? null : this.draw.grab({ x, y, w, h });
    this.draw.window(x, y, w, h, 6, 4);
    if (officer) this.portrait(o.face!, x + 16, y + 16);
    const header = () => {
      if (speaker) this.text(o.name!, col, margin + y + 8, 6);
    };
    let answer = true;
    for (let p = 0; p < all.length; p += perPage) {
      if (p > 0) {
        // clear the text area with the background (53be phase 1) and redraw the name
        this.draw.background(col * 8, y + 8, x + w - 8 - col * 8, h - 16, 4, 1);
        if (officer) this.portrait(o.face!, x + 16, y + 16);
      }
      header();
      const page = all.slice(p, p + perPage);
      let ty = margin + y + 8 + (speaker ? 20 : 0);
      for (const line of page) {
        this.text(line, col, ty, 7);
        ty += 20;
      }
      const last = p + perPage >= all.length;
      if (last && o.yesNo) {
        answer = await this.yesNoButtons(((x + w) >> 3) - 15, y + h - 0x28 + 4);
      } else if (o.wait !== false || !last) {
        await this.waitClick();
      }
    }
    if (saved && o.wait !== false) this.draw.restore(saved);
    return answer;
  }

  /** Yes (kind 2) and No (kind 3) buttons at text column `col` / col + 7, row y (screen). */
  async yesNoButtons(col: number, y: number): Promise<boolean> {
    const yes: Button = { x: col * 8, y, w: 48, h: 16, kind: 2 };
    const no: Button = { x: (col + 7) * 8, y, w: 48, h: 16, kind: 3 };
    this.draw.button(yes);
    this.draw.button(no);
    const r = await this.pickButton([yes, no], false);
    return r === 0;
  }

  /** Waits until one of the buttons is clicked; -1 on right click when `cancel`. */
  async pickButton(buttons: Button[], cancel: boolean): Promise<number> {
    this.input.flush();
    for (;;) {
      const c = await this.click(CURSOR.ARROW);
      if (c.button === 'right') {
        if (cancel) return -1;
        continue;
      }
      const i = buttons.findIndex((b) => !b.disabled && inRect(buttonRect(b), c.x, c.y));
      if (i >= 0) {
        this.draw.buttonPressed(buttons[i]);
        await this.video.frames(4);
        this.draw.button(buttons[i]);
        return i;
      }
    }
  }

  message(text: Text, opts: { face?: number; name?: string; wait?: boolean } = {}): Promise<void> {
    return this.messageBox(text, { ...opts, kind: opts.name !== undefined ? 3 : 0 }).then(() => undefined);
  }

  confirm(text: Text, opts: { face?: number; name?: string } = {}): Promise<boolean> {
    if (opts.name === undefined && opts.face === undefined) return this.captionBox(text, 2);
    return this.messageBox(text, { ...opts, kind: 3, yesNo: true });
  }

  // ------------------------------------------------------------------ captions

  /** Caption centre (0cf5:3c5e local_e): 272, or 224 in battle. */
  captionCentre = 0x110;

  /**
   * 0cf5:3c5e: centred notice. mode 0 = wait for a click, 1 = 확인 button, 2 = yes/no (resolves the
   * answer).
   */
  async captionBox(t: Text, mode = 0): Promise<boolean> {
    const lines = layoutLines(bytesOf(t), 64);
    let cols = Math.max(1, ...lines.map((l) => textCols(l)));
    cols += cols & 1;
    let off = 0;
    if (cols & 3) {
      cols += 2;
      off = 1;
    }
    const w = (cols + 4) * 8;
    const h = (lines.length + 3) * 16 + (mode ? 32 : 0);
    const x = this.captionCentre - (w >> 1);
    const y = 0x90 + LAYOUT_Y;
    const saved = this.draw.grab({ x, y, w, h });
    this.draw.window(x, y, w, h, 6, 4);
    const tc = (x >> 3) + 2;
    lines.forEach((l, i) => {
      const pad = (cols - textCols(l)) >> 1;
      this.text(l, tc + pad + (off && !pad ? 0 : 0), 0xa0 + LAYOUT_Y + i * 16);
    });
    let answer = true;
    const by = lines.length * 16 + 0xb8 + LAYOUT_Y;
    const c = this.captionCentre >> 3;
    if (mode === 2) {
      const noCol = c - (cols >> 1) + cols - 8 + 2;
      answer = await this.yesNoButtonsAt((noCol - 7) * 8, noCol * 8, by);
    } else if (mode === 1) {
      const ok: Button = { x: (c - 3) * 8, y: by, w: 48, h: 16, kind: 1 };
      this.draw.button(ok);
      await this.pickButton([ok], false);
    } else {
      await this.waitClick();
    }
    this.draw.restore(saved);
    return answer;
  }

  private async yesNoButtonsAt(yx: number, nx: number, y: number): Promise<boolean> {
    const yes: Button = { x: yx, y, w: 48, h: 16, kind: 2 };
    const no: Button = { x: nx, y, w: 48, h: 16, kind: 3 };
    this.draw.button(yes);
    this.draw.button(no);
    return (await this.pickButton([yes, no], false)) === 0;
  }

  caption(text: Text): Promise<void> {
    return this.captionBox(text, 0).then(() => undefined);
  }

  // ------------------------------------------------------------------ menus

  /** Menu window geometry of 0cf5:2c92 (button rows). */
  menuGeometry(labels: Uint8Array[], x: number, y: number, cols = 8): { win: Rect; buttons: Button[] } {
    const n = labels.length;
    const maxlen = Math.max(cols, ...labels.map((l) => textCols(l)));
    const rowH = 24;
    const w = (maxlen + 2) * 8;
    const h = (rowH * n + 31) & ~15;
    let ly = y - LAYOUT_Y;
    if (ly < 16) ly = 0;
    if (h + ly > 0x17f) ly -= ((h + ly) - 0x171) & 0xfff0;
    const localC = ((h - rowH * n - 16) >> 1) + 8;
    const buttons = labels.map((label, i) => ({
      x: x + 8,
      y: (rowH - 16) / 2 + localC + ly + LAYOUT_Y + i * rowH,
      w: maxlen * 8,
      h: 16,
      kind: 0,
      label,
    }));
    return { win: { x, y: ly + LAYOUT_Y, w, h }, buttons };
  }

  /** Draws a menu and waits for a choice; -1 = cancelled. */
  async menu(items: Text[], opts: MenuOptions = {}): Promise<number> {
    const labels = items.map((t) => bytesOf(t));
    const maxlen = Math.max(opts.cols ?? 8, ...labels.map((l) => textCols(l)));
    const x = opts.x ?? (opts.cx ?? this.captionCentre) - ((maxlen + 2) * 4); // centred like the captions (emulator: 산다/판다 at x 232)
    const y = opts.y ?? 0x80 + LAYOUT_Y;
    const { win, buttons } = this.menuGeometry(labels, x, y, opts.cols);
    buttons.forEach((b, i) => ((b as Button).disabled = opts.disabled?.[i] ?? false));
    const saved: Saved | null = opts.keep ? null : this.draw.grab(win);
    this.draw.window(win.x, win.y, win.w, win.h, 2, 2);
    for (const b of buttons) this.draw.button(b);
    const r = await this.pickButton(buttons, opts.cancel ?? true);
    if (saved) this.draw.restore(saved);
    return r;
  }

  // ------------------------------------------------------------------ main frame

  /** 0cf5:c456: frame picture, field patches, title, portrait and status. */
  drawFrame(status: { money: number; level: number; territory?: Uint8Array; face: number }) {
    const pic = this.assets.picture(0);
    if (pic) {
      this.draw.image(pic, 0, LAYOUT_Y);
      this.framePic = pic;
      this.patches = [this.patch(0x18, 0x168 + LAYOUT_Y), this.patch(0x238, 0x88 + LAYOUT_Y)];
    }
    this.drawTitle();
    this.portrait(status.face, 0x228, 0x18 + LAYOUT_Y);
    this.drawStatus(status);
    this.drawHover('');
  }

  private patch(x: number, y: number): IndexedImage {
    return { width: 16, height: 16, pixels: this.draw.screen.grab(x, y, 16, 16) };
  }

  /** 0cf5:52ee: tiles patch `kind` over (x, y, w, h). */
  fillPatch(kind: number, x: number, y: number, w: number, h: number) {
    const p = this.patches[kind];
    if (!p) {
      this.draw.fill(x, y, w, h, 0);
      return;
    }
    const px = this.draw.screen.pixels;
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx, sy = y + yy;
        if (sx >= 0 && sx < 640 && sy >= 0 && sy < 480) px[sy * 640 + sx] = p.pixels[(yy & 15) * 16 + (xx & 15)];
      }
    this.draw.dirty();
  }

  setTitle(text: Text) {
    this.title = bytesOf(text).slice();
    this.drawTitle();
  }

  /** 0cf5:c30e */
  drawTitle() {
    if (!this.framePic) return;
    this.fillPatch(0, 0x10, 0x168 + LAYOUT_Y, 0xf0, 0x10);
    this.text(this.title, 3, 0x168 + LAYOUT_Y);
  }

  /** 0cf5:c362 / c39a / c3d4 */
  drawStatus(s: { money: number; level: number; territory?: Uint8Array; face?: number }) {
    if (!this.framePic) return;
    if (s.face !== undefined) this.portrait(s.face, 0x228, 0x18 + LAYOUT_Y);
    this.fillPatch(1, 0x238, 0x88 + LAYOUT_Y, 0x30, 0x10);
    // "%5u" at column 0x48; the emulator shows the digits one column left, as if the text console's
    // swallowed-space flag (DS:0x64de) were set here and ate the first pad space
    this.text(String(s.money).padStart(5, ' ').replace(/^ /, ''), 0x48, 0x88 + LAYOUT_Y);
    this.fillPatch(1, 0x248, 0xa0 + LAYOUT_Y, 0x20, 0x10);
    this.text(String(s.level).padStart(4, ' '), 0x49, 0xa0 + LAYOUT_Y);
    if (!s.territory) return;
    this.fillPatch(1, 0x238, 0xc8 + LAYOUT_Y, 0x30, 0x10);
    const t = s.territory;
    const pad = Math.max(0, 6 - textCols(t));
    const b = new Uint8Array(pad + t.length).fill(0x20);
    b.set(t, pad);
    this.text(b, 0x47, 0xc8 + LAYOUT_Y);
  }

  /** 1cb6:17e4: name under the mouse in message bar 2. */
  drawHover(name: string | Uint8Array) {
    const key = typeof name === 'string' ? name : Array.from(name).join(',');
    if (!this.framePic) return;
    if (key === this.hover && key !== '') return;
    this.hover = key;
    this.fillPatch(0, 0x110, 0x168 + LAYOUT_Y, 0x60, 0x10);
    const b = typeof name === 'string' ? bytesOf(name) : name;
    if (b.length) this.text(b, 0x23, 0x168 + LAYOUT_Y);
  }

  get hasFrame(): boolean {
    return this.framePic !== null;
  }

  /** Clears the map view (16, 56, 512, 320) to black. */
  clearView() {
    this.draw.fill(16, 56, 512, 320, 0);
  }
}
