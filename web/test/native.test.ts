// Native mode (field engine): text layout, Korean particles and save slots without the game files;
// with HERO_GAME_DIR, the rooms and a headless run of the real Game from the title menu through the
// prologue into the first battle (사수관), won by autoplay, and back on the world map.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutLines } from '../src/native/ui';
import { josa } from '../src/native/game';
import { SaveStore } from '../src/native/saves';
import { ESAVE_SIZE, MSAVE_SIZE, encodeSaveTime, esaveName, msaveName } from '../src/formats/save';
import { GAME_DIR, hasGame } from './gamedir';

const enc = (s: string) => {
  // EUC-KR for the few Hangul syllables used below, ASCII otherwise
  const table: Record<string, number[]> = { 가: [0xb0, 0xa1], 나: [0xb3, 0xaa] };
  const out: number[] = [];
  for (const ch of s) out.push(...(table[ch] ?? [ch.charCodeAt(0)]));
  return Uint8Array.from(out);
};
const dec = (b: Uint8Array) => new TextDecoder('euc-kr').decode(b);

describe('native text layout (0cf5:0a2e rules)', () => {
  it('wraps by columns, keeps two-byte codes whole and swallows one space after a break', () => {
    const lines = layoutLines(enc('가나 가나 가나'), 9).map(dec);
    expect(lines).toEqual(['가나 가나', '가나']);
  });

  it('ignores CR, breaks on LF', () => {
    expect(layoutLines(enc('ab\r\n cd'), 40).map(dec)).toEqual(['ab', 'cd']);
  });
});

describe('josa', () => {
  it('picks the particle by the final consonant', () => {
    expect(josa('초열서', '을', '를')).toBe('초열서를');
    expect(josa('콩', '을', '를')).toBe('콩을');
    expect(josa('술', '은', '는')).toBe('술은');
  });
});

describe('save slots', () => {
  it('lists, reads, exports and imports slots in the original byte format', async () => {
    const files = new Map<string, Uint8Array>();
    const store = new SaveStore(files);
    expect(store.list().every((s) => s.empty)).toBe(true);
    const m = new Uint8Array(MSAVE_SIZE);
    m.set(encodeSaveTime({ year: 26, month: 10, day: 14, hour: 7, minute: 39 }), 0);
    m.set([0xb0, 0xa1], 5); // title "가"
    const e = new Uint8Array(ESAVE_SIZE);
    await store.write(3, m, e);
    expect(files.get(msaveName(3))).toBe(m);
    const row = store.list()[3];
    expect(row.empty).toBe(false);
    expect(row.title).toBe('가');
    expect(row.time).toBe('26/10/14 07:39');
    expect(store.read(3)?.esaveBytes).toBe(e);
    const zip = store.exportSlot(3)!;
    const other = new SaveStore(new Map());
    expect(await other.importFiles([{ name: 'slot.zip', data: zip }], 1)).toEqual([1]);
    expect(other.files.get(msaveName(1))).toEqual(m);
    expect(other.files.get(esaveName(1))).toEqual(e);
    await expect(other.importFiles([{ name: 'MSAVE0.R3S', data: new Uint8Array(3) }])).rejects.toThrow();
  });
});

// ------------------------------------------------------------------ with the game files

function loadFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const f of readdirSync(GAME_DIR)) files.set(f.toUpperCase(), new Uint8Array(readFileSync(join(GAME_DIR, f))));
  return files;
}

describe.skipIf(!hasGame)('native field engine with the game files', () => {
  it('loads the 진유 camp (PMAP 14) with a walkable floor', async () => {
    const { GameAssets } = await import('../src/native/assets');
    const { Draw } = await import('../src/native/draw');
    const { Field, ATTR } = await import('../src/native/field');
    const { headlessScreen } = await import('../src/native/battle/dev/headless');
    const assets = new GameAssets(loadFiles());
    const field = new Field(assets, new Draw(headlessScreen(), assets), () => {
      throw new Error('no state needed');
    });
    field.loadRoom(2, 14);
    let walk = 0;
    for (let y = 0; y < 20; y++) for (let x = 0; x < 32; x++) if (field.attr(x, y) === ATTR.WALK) walk++;
    expect(walk).toBeGreaterThan(150);
    expect(field.attr(16, 11)).toBe(ATTR.WALK); // 유비 stands here in the opening
    expect(assets.stageTitles.length).toBeGreaterThan(10);
  });

  it('plays from the title menu through the prologue and wins the first battle', async () => {
    const { Game } = await import('../src/native/game');
    const { headlessScreen, ScriptedInput } = await import('../src/native/battle/dev/headless');
    const { Rng } = await import('../src/engine/battle/rules');
    const { VIEW } = await import('../src/native/field');
    const screen = headlessScreen();
    const input = new ScriptedInput();
    const canvas = {
      width: 640,
      height: 480,
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
      }),
    } as unknown as HTMLCanvasElement;
    const game = new Game(loadFiles(), screen, input.asInput(), canvas, null);
    game.video.fast = true;
    // every message is read at once and every choice takes the first button (new game, Yes)
    const ui = game.ui as unknown as Record<string, unknown>;
    ui.waitClick = async () => 'left';
    (game as unknown as { savePrompt: () => Promise<void> }).savePrompt = async () => {};
    const g = game as unknown as Record<string, unknown>;
    g.rng = new Rng(12345);
    g.autoPlay = true;
    class Done extends Error {}
    let battles = 0;
    let atSecond: { money: number; chapter: number; block: number } | null = null;
    g.afterSetup = (sc: { units: { mode: number; target: number }[]; b: { slotOfOfficer(o: number): number } }) => {
      battles++;
      if (battles === 1) {
        // 관우 heads for 화웅: their adjacency event is the duel that ends the battle
        sc.units[1].mode = 0;
        sc.units[1].target = sc.b.slotOfOfficer(5);
        return;
      }
      // the second battle (호로관) started: the first one was won and the story went on; quit here
      atSecond = { money: game.state.progress.money, chapter: game.script.chapter, block: game.script.block };
      game.state.status |= 0x40;
    };
    ui.pickButton = async () => {
      if (atSecond) throw new Done(); // "다시 한번 게임하겠습니까?" after quitting
      return 0;
    };
    const talked = new Set<number>();
    input.onIdle = () => {
      if (game.state.status & 0x20) throw new Error('game over');
      // the 진유 camp: talk to 관우 (officer 1), who asks whether to march out
      const me = game.field.actors.get(0);
      const a = game.field.actors.get(1);
      if (game.field.kind === 'room' && a && me && !me.path.length && !talked.has(game.script.block)) {
        talked.add(game.script.block);
        input.clicks.push({ button: 'left', x: VIEW.x + a.px + 8, y: VIEW.y + a.py - 10 });
      }
    };
    await expect(game.run()).rejects.toBeInstanceOf(Done);
    expect(battles).toBe(2);
    // 500 from 조조, 100 for 사수관; chapter 0 block 7 is the 호로관 battle
    expect(atSecond).toEqual({ money: 600, chapter: 0, block: 7 });
  }, 300_000);
});
