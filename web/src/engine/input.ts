// Mouse and keyboard input in original screen coordinates (640x480).
import { WIDTH, HEIGHT } from './screen';

export type Button = 'left' | 'right';

export class Input {
  x = WIDTH / 2;
  y = HEIGHT / 2;
  left = false;
  right = false;
  private clicks: { button: Button; x: number; y: number }[] = [];
  private keys: string[] = [];
  private waiters: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const pos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      this.x = Math.max(0, Math.min(WIDTH - 1, Math.floor(((e.clientX - r.left) / r.width) * WIDTH)));
      this.y = Math.max(0, Math.min(HEIGHT - 1, Math.floor(((e.clientY - r.top) / r.height) * HEIGHT)));
    };
    canvas.addEventListener('mousemove', pos);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      pos(e);
      if (e.button === 0) this.left = true;
      if (e.button === 2) this.right = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.left) {
        this.left = false;
        this.push({ button: 'left', x: this.x, y: this.y });
      }
      if (e.button === 2 && this.right) {
        this.right = false;
        this.push({ button: 'right', x: this.x, y: this.y });
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.push(e.key);
      this.wake();
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'Escape'].includes(e.key)) e.preventDefault();
    });
  }

  private push(c: { button: Button; x: number; y: number }) {
    this.clicks.push(c);
    this.wake();
  }

  private wake() {
    const w = this.waiters.splice(0);
    w.forEach((f) => f());
  }

  takeClick() {
    return this.clicks.shift();
  }

  takeKey() {
    return this.keys.shift();
  }

  flush() {
    this.clicks.length = 0;
    this.keys.length = 0;
  }

  /** Resolves on the next click or key press (whichever comes first). */
  next(): Promise<void> {
    if (this.clicks.length || this.keys.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
}
