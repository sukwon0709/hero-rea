// Screen and input without a browser, for the battle tests: a canvas stub for Screen and a queue
// of scripted clicks/keys with the Input interface.

import { Screen } from '../../../engine/screen';
import type { Input } from '../../../engine/input';

export function headlessScreen(): Screen {
  const ctx2d = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx2d } as unknown as HTMLCanvasElement;
  return new Screen(canvas);
}

type Click = { button: 'left' | 'right'; x: number; y: number };

/** Input with a scripted queue; `onIdle` is asked for more input when the queue runs dry. */
export class ScriptedInput {
  x = 320;
  y = 240;
  left = false;
  right = false;
  clicks: Click[] = [];
  keys: string[] = [];
  onIdle: (() => void) | null = null;

  takeClick(): Click | undefined {
    if (!this.clicks.length) this.onIdle?.();
    const c = this.clicks.shift();
    if (c) {
      this.x = c.x;
      this.y = c.y;
    }
    return c;
  }

  takeKey(): string | undefined {
    return this.keys.shift();
  }

  flush() {
    // scripted input is never discarded
  }

  next(): Promise<void> {
    return Promise.resolve();
  }

  asInput(): Input {
    return this as unknown as Input;
  }
}
