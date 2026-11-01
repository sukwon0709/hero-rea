import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearCached, exportSaves, importSaves, loadCached, saveCached, storeGame, type GameFiles } from '../src/gamefiles';
import { unzipSync } from 'fflate';

const b = (...v: number[]) => new Uint8Array(v);

function zipGame(saveByte: number): GameFiles {
  return new Map([
    ['HERO.COM', b(1)],
    ['MAIN.EXE', b(2)],
    ['MSAVE1.R3S', b(saveByte)],
    ['ESAVE1.R3S', b(saveByte)],
  ]);
}

describe('game file cache', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory(); // a fresh, empty browser profile
  });

  it('keeps the game after the first load', async () => {
    expect(await loadCached()).toBeNull();
    await storeGame(zipGame(0));
    const files = await loadCached();
    expect(files?.get('MAIN.EXE')).toEqual(b(2));
  });

  it('keeps saves made in the browser when Hero.zip is loaded again', async () => {
    const files = zipGame(0);
    await storeGame(files);
    files.set('MSAVE1.R3S', b(9));
    files.set('MSAVE2.R3S', b(7));
    await saveCached(files);

    await clearCached(); // "Forget game files"
    expect(await loadCached()).toBeNull();

    const again = zipGame(0); // the zip still has the old slot 1
    await storeGame(again);
    expect(again.get('MSAVE1.R3S')).toEqual(b(9));
    const cached = await loadCached();
    expect(cached?.get('MSAVE1.R3S')).toEqual(b(9));
    expect(cached?.get('MSAVE2.R3S')).toEqual(b(7));
    expect(cached?.get('ESAVE1.R3S')).toEqual(b(0)); // slots only the zip has are kept
  });

  it('backs saves up and restores them', async () => {
    const files = zipGame(5);
    await storeGame(files);
    const zip = exportSaves(files);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(['ESAVE1.R3S', 'MSAVE1.R3S']);

    const other = zipGame(0);
    await storeGame(other);
    files.set('MSAVE1.R3S', b(0));
    const restored = await importSaves(other, [new File([zip], 'hero-saves.zip')]);
    expect(restored.sort()).toEqual(['ESAVE1.R3S', 'MSAVE1.R3S']);
    expect((await loadCached())?.get('MSAVE1.R3S')).toEqual(b(5));
  });
});
