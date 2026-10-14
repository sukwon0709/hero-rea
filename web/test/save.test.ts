import { describe, expect, it } from 'vitest';
import {
  ESAVE_SIZE,
  MODE,
  MSAVE_SIZE,
  decodeSaveTime,
  eventFlag,
  formatSaveTime,
  parseESave,
  parseMSave,
  parseMSaveHeader,
  saveTitle,
  serializeESave,
  serializeMSave,
  serializeMSaveHeader,
} from '../src/formats/save';
import { parseBakData, parseBbksdat, readEngineTables } from '../src/formats/tables';
import { heroLevel, loadGame, newGame, rosterOfficers, toSave } from '../src/engine/state';
import { gameFile, hasGame } from './gamedir';

const slots = [0, 1, 2, 3, 4];

describe.skipIf(!hasGame)('saves round-trip byte-exact', () => {
  for (const n of slots) {
    it(`MSAVE${n}.R3S`, () => {
      const b = gameFile(`MSAVE${n}.R3S`);
      expect(b.length).toBe(MSAVE_SIZE);
      expect(serializeMSave(parseMSave(b))).toEqual(b);
    });
    it(`ESAVE${n}.R3S`, () => {
      const b = gameFile(`ESAVE${n}.R3S`);
      expect(b.length).toBe(ESAVE_SIZE);
      expect(serializeESave(parseESave(b))).toEqual(b);
    });
  }
  it('MSAVE.R3', () => {
    const b = gameFile('MSAVE.R3');
    expect(serializeMSaveHeader(parseMSaveHeader(b))).toEqual(b);
  });
});

describe.skipIf(!hasGame)('save contents', () => {
  let ctx: { tables: ReturnType<typeof readEngineTables>; bak: ReturnType<typeof parseBakData>; sec: (s: number) => ReturnType<typeof parseBbksdat> } | undefined;
  const C = () => {
    if (!ctx) {
      const bbk = gameFile('BBKSDAT1.R3');
      ctx = { tables: readEngineTables(gameFile('MAIN.EXE')), bak: parseBakData(gameFile('BAKDATA.R3')), sec: (s) => parseBbksdat(bbk, s) };
    }
    return ctx;
  };

  it('MSAVE.R3 is the new-game header', () => {
    const h = parseMSaveHeader(gameFile('MSAVE.R3'));
    expect(decodeSaveTime(h.timestamp)).toBeNull();
    expect(h.progress).toMatchObject({ money: 0, w2: 5000, battleOptions: 0x9001, flags: 0x0f, bgm: 0xffff, chapter: 0, speed: 2, scroll: 1 });
    expect(h.location).toMatchObject({ x: 0x0b, y: 0x0d, mode: MODE.TOWN, map: 0, entered: 1 });
    const { bak, sec, tables } = C();
    const g = newGame(h, bak, sec, tables);
    expect(g.towns[0].name).toBe('평원');
    expect(heroLevel(g)).toBe(1);
  });

  it('MSAVE2: chapter 1 at 신도', () => {
    const s = parseMSave(gameFile('MSAVE2.R3S'));
    expect(saveTitle(s)).toBe('제1장 계교 전투');
    expect(s.progress.money).toBe(60);
    expect(s.progress.chapter).toBe(1);
    const t = decodeSaveTime(s.timestamp);
    expect(t).not.toBeNull();
    expect(formatSaveTime(t!)).toMatch(/^\d\d\/\d\d\/\d\d \d\d:\d\d$/);
    const { bak, sec, tables } = C();
    const g = loadGame(s, parseESave(gameFile('ESAVE2.R3S')), bak, sec, tables);
    expect(g.towns[g.progress.territory].name).toBe('신도');
    expect(heroLevel(g)).toBe(3);
    expect(g.officers[0].dyn.troops).toBe(383); // saved value; max for 단병 Lv3 is 600
    expect(rosterOfficers(g).map((o) => o.name).slice(0, 3)).toEqual(['유비', '관우', '장비']);
    // toSave reproduces everything except the timestamp
    const out = serializeMSave(toSave(g));
    const orig = gameFile('MSAVE2.R3S');
    expect(out.subarray(5)).toEqual(orig.subarray(5));
  });

  it('ESAVE chapter matches MSAVE chapter', () => {
    for (const n of slots) {
      const m = parseMSave(gameFile(`MSAVE${n}.R3S`));
      const e = parseESave(gameFile(`ESAVE${n}.R3S`));
      if (decodeSaveTime(m.timestamp) === null) continue;
      expect(e.chapter).toBe(m.progress.chapter);
      expect(e.modeMap >> 12).toBe(m.location.mode & 15);
      if ((m.location.mode & 15) !== MODE.WORLD) expect(e.modeMap & 0xff).toBe(m.location.map); // world map: key map is 0
      expect(e.area).toBe(m.location.key);
      expect(typeof eventFlag(e, 0)).toBe('boolean');
    }
  });
});
