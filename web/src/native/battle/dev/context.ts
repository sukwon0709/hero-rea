// Builds a minimal GameContext for the battle dev harness and the tests: the player's game files,
// a new game (MSAVE.R3) or a saved one (MSAVEn/ESAVEn), a script VM whose host shows text through
// DevUi, and runEvent = vm.dispatch. The real context is the field engine's (web/src/native).

import type { Assets, GameContext, Ui } from '../../context';
import type { Screen } from '../../../engine/screen';
import type { Input } from '../../../engine/input';
import type { SoundPlayer } from '../../../audio/player';
import { isLs11, unpackLs11 } from '../../../formats/ls11';
import { GameFont } from '../../../formats/font';
import { readMainPalettes, type Rgb4 } from '../../../formats/palette';
import { parseBakData, parseBbksdat, readEngineTables } from '../../../formats/tables';
import { parseChapter, type Chapter, type Message, type TalkLine } from '../../../formats/scenario';
import { msaveName, esaveName, parseMSave, parseMSaveHeader, parseESave } from '../../../formats/save';
import { loadGame, newGame, type GameState } from '../../../engine/state';
import { ScriptVM, newScriptState, readEventSave, type ScriptHost, type ScriptState } from '../../../engine/script';
import { BattleStart } from './setup';

export class DevAssets implements Assets {
  readonly main: Uint8Array;
  readonly font: GameFont;
  readonly palettes: Rgb4[][];
  private cache = new Map<string, Uint8Array[]>();
  private chapters = new Map<number, Chapter>();

  constructor(readonly files: Map<string, Uint8Array>) {
    this.main = this.file('MAIN.EXE');
    this.font = new GameFont(files.get('ALL_FONT.16P') ?? null, files.get('HANKAKU.FNT') ?? null);
    this.palettes = readMainPalettes(this.main);
  }

  file(name: string): Uint8Array {
    const f = this.files.get(name.toUpperCase());
    if (!f) throw new Error(`missing game file ${name}`);
    return f;
  }

  entries(name: string): Uint8Array[] {
    const k = name.toUpperCase();
    let e = this.cache.get(k);
    if (!e) {
      const f = this.file(k);
      e = isLs11(f) ? unpackLs11(f) : [f];
      this.cache.set(k, e);
    }
    return e;
  }

  chapter(c: number): Chapter {
    let ch = this.chapters.get(c);
    if (!ch) {
      ch = parseChapter(c, this.file(`SNR${c}D.R3`), this.file(`SNR${c}M.R3`));
      this.chapters.set(c, ch);
    }
    return ch;
  }
}

/** Builds the game state: slot < 0 = new game, else MSAVEn/ESAVEn. */
export function buildState(a: DevAssets, slot: number): { state: GameState; script: ScriptState } {
  const tables = readEngineTables(a.main);
  const bak = parseBakData(a.file('BAKDATA.R3'));
  const bbk = (n: number) => parseBbksdat(a.file('BBKSDAT1.R3'), n);
  if (slot < 0) {
    const state = newGame(parseMSaveHeader(a.file('MSAVE.R3')), bak, bbk, tables);
    const script = newScriptState();
    script.chapter = state.progress.chapter;
    return { state, script };
  }
  const es = a.files.get(esaveName(slot).toUpperCase());
  const state = loadGame(parseMSave(a.file(msaveName(slot))), es ? parseESave(es) : null, bak, bbk, tables);
  const script = es ? readEventSave(es) : newScriptState();
  return { state, script };
}

/** Script host of the harness: text through the Ui, battle maps end the run (BattleStart). */
export function devHost(ui: Ui, state: GameState): ScriptHost & { headless: boolean } {
  const name = (id: number) => state.officers[id]?.name ?? '';
  const host = {
    headless: false,
    async talk(line: TalkLine) {
      if (!host.headless) await ui.message(line, { face: state.officers[line.speaker]?.face, name: name(line.speaker) });
    },
    async ask(line: TalkLine) {
      return host.headless ? true : ui.confirm(line, { name: name(line.speaker) });
    },
    async narrate(m: Message) {
      if (!host.headless) await ui.message(m);
    },
    async caption(m: Message) {
      if (!host.headless) await ui.caption(m);
    },
    async title(m: Message) {
      ui.setTitle(m);
    },
    async stageTitle() {},
    async choose(options: Message[]) {
      return host.headless ? 0 : Math.max(0, await ui.menu(options));
    },
    async showPicture() {},
    async closePicture() {},
    async setMap(map: number) {
      if (map >> 12 === 3) throw new BattleStart(map & 0xfff);
    },
    async showMap() {},
    placeCharacter() {},
    moveCharacter() {},
    async waitMoves() {},
    removeCharacter() {},
    addGold(v: number) {
      state.progress.money = Math.min(10000, state.progress.money + v);
    },
    async addItem() {},
    async savePrompt() {},
    async gameOver() {},
  };
  return host;
}

export interface DevContextParts {
  screen: Screen;
  input: Input;
  ui: Ui;
  sound?: SoundPlayer | null;
}

export function buildContext(a: DevAssets, slot: number, parts: DevContextParts): { ctx: GameContext; host: ReturnType<typeof devHost> } {
  const { state, script } = buildState(a, slot);
  const host = devHost(parts.ui, state);
  // like the field engine's host: a method defined in ctx.battleHost takes over
  const routed = new Proxy(host, {
    get(t, k) {
      const bh = ctx.battleHost as Record<string | symbol, unknown> | null | undefined;
      const m = bh?.[k];
      if (typeof m === 'function') return m;
      return (t as unknown as Record<string | symbol, unknown>)[k];
    },
  });
  const vm = new ScriptVM((c) => a.chapter(c), routed, script);
  const ctx: GameContext = {
    battleHost: null,
    screen: parts.screen,
    input: parts.input,
    sound: parts.sound ?? null,
    assets: a,
    ui: parts.ui,
    state,
    vm,
    script: vm.state,
    async runEvent(t) {
      await vm.dispatch(t);
    },
  };
  return { ctx, host };
}
