// Shared contract between the parts of the native engine (field/town/world/events and battle).
// Implemented by web/src/native/{assets,ui,game}.ts; consumed by web/src/native/battle/*.

import type { Screen } from '../engine/screen';
import type { Input } from '../engine/input';
import type { SoundPlayer } from '../audio/player';
import type { GameFont } from '../formats/font';
import type { Rgb4 } from '../formats/palette';
import type { GameState } from '../engine/state';
import type { ScriptVM, ScriptState, Trigger } from '../engine/script';
import type { Message } from '../formats/scenario';

/** Decoded original files, loaded lazily and cached. Keys are upper-case file names. */
export interface Assets {
  file(name: string): Uint8Array;
  /** LS11 archive entries (unpacked), e.g. entries('HEXZCHR.R3'). */
  entries(name: string): Uint8Array[];
  readonly main: Uint8Array; // MAIN.EXE image as read from disk
  readonly font: GameFont;
  /** MAIN.EXE palette table (DS:0x1050), 9 palettes. */
  readonly palettes: Rgb4[][];
}

/** Window / text primitives that look like the original's (same frame, font and colours). */
export interface Ui {
  /** Message box with optional portrait (face index) and speaker name; resolves on click/key. */
  message(text: Message | string, opts?: { face?: number; name?: string; wait?: boolean }): Promise<void>;
  /** Yes/no box; resolves true for yes. */
  confirm(text: Message | string, opts?: { face?: number; name?: string }): Promise<boolean>;
  /** Vertical menu; resolves the chosen index, or -1 when cancelled (right click / Esc). */
  menu(items: (Message | string)[], opts?: { x?: number; y?: number; title?: string; disabled?: boolean[] }): Promise<number>;
  /** Small centred caption that disappears after a moment or a click. */
  caption(text: Message | string): Promise<void>;
  /** Bottom status-bar title text. */
  setTitle(text: Message | string): void;
  fadeOut(steps?: number): Promise<void>;
  fadeIn(palette: Rgb4[], steps?: number): Promise<void>;
  /** Wait one frame (~1/60 s), presenting the screen. */
  frame(): Promise<void>;
  wait(ms: number): Promise<void>;
}

export interface GameContext {
  screen: Screen;
  input: Input;
  sound: SoundPlayer | null;
  assets: Assets;
  ui: Ui;
  state: GameState;
  vm: ScriptVM;
  script: ScriptState;
  /** Fires a script trigger and runs the resulting event (battle uses this for per-turn / per-action events). */
  runEvent(trigger: Trigger): Promise<void>;
}

/** Entry point of battle mode, implemented in web/src/native/battle/scene.ts. */
export type RunBattle = (ctx: GameContext, map: number) => Promise<'won' | 'lost' | 'ended'>;
