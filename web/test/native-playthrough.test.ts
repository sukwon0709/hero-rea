// Native mode, whole game: the headless playthrough harness (src/native/dev/playthrough.ts).
//
//  * With HERO_GAME_DIR: every shipped save slot (MSAVE0..4 / ESAVE0..4, at different chapters) loads
//    from the title menu and the story goes on from there (a few events, up to the next battle start
//    or the ending).
//  * With HERO_GAME_DIR and HERO_PLAYTHROUGH=1 (long, opt-in): a new game played from the title menu
//    to the ending. Battles are won by the bot or by the harness's labelled debug force win; the
//    per-battle record is printed. A story game over caused by a menu answer starts the game over with that
//    answer avoided (playToEnd).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_DIR, hasGame } from './gamedir';

function loadFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const f of readdirSync(GAME_DIR)) files.set(f.toUpperCase(), new Uint8Array(readFileSync(join(GAME_DIR, f))));
  return files;
}

describe.skipIf(!hasGame)('native: shipped save slots load and continue', () => {
  for (const slot of [0, 1, 2, 3, 4]) {
    it(`slot ${slot + 1}`, async () => {
      const { Playthrough } = await import('../src/native/dev/playthrough');
      const files = loadFiles();
      let start = -1;
      const p = new Playthrough(files, {
        start: { slot },
        forceAll: true,
        // stop once the story moved on from the saved position: a battle began, or a few more
        // script steps ran
        stopWhen: (pp) => {
          const s = pp.game.script;
          const at = s.chapter * 1000 + s.stage * 100 + s.block;
          if (start < 0) start = at;
          return pp.battles.length > 0 || at !== start;
        },
      });
      const r = await p.run();
      expect(p.issues).toEqual([]);
      expect(['stopped', 'ending']).toContain(r);
      // the loaded state is the saved one (same chapter as the event save)
      expect(p.game.state.progress.chapter).toBe(p.game.script.chapter);
    }, 120_000);
  }
});

const long = hasGame && process.env.HERO_PLAYTHROUGH === '1';

describe.skipIf(!long)('native: whole game playthrough (HERO_PLAYTHROUGH=1)', () => {
  it('plays a new game to the ending', async () => {
    const { playToEnd } = await import('../src/native/dev/playthrough');
    // a story game over after a CHOOSE answer restarts the game with that answer avoided
    const p = await playToEnd(loadFiles(), { log: process.env.HERO_PLAYTHROUGH_LOG ? (l) => console.log(l) : undefined });
    const r = p.result;
    console.log(`playthrough: ${r}, ${p.frames} frames\n${p.summary()}\nissues:\n${p.issues.join('\n')}`);
    expect(r).toBe('ending');
    expect(p.battles.every((b) => b.outcome === 'bot' || b.outcome === 'forced')).toBe(true);
    expect(p.issues.filter((i) => !i.includes('synthetic trigger'))).toEqual([]);
  }, 4 * 3600_000);
});
