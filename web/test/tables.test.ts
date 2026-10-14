import { describe, expect, it } from 'vitest';
import {
  FACEDAT_COUNT,
  PACKGRP_COUNT,
  maxTroops,
  parseBakData,
  parseBbksdat,
  parseBlobIndex,
  parseDiskLabel,
  readEngineTables,
} from '../src/formats/tables';
import { gameFile, hasGame } from './gamedir';

describe.skipIf(!hasGame)('MAIN.EXE DGROUP tables', () => {
  let tc: ReturnType<typeof readEngineTables> | undefined;
  const T = () => (tc ??= readEngineTables(gameFile('MAIN.EXE')));
  it('chapter -> section and per-section town ranges', () => {
    expect(T().chapterSection).toEqual([0, 0, 1, 2, 3]);
    expect(T().sectionTownBase).toEqual([0, 22, 38, 64]);
    expect(T().sectionTownCount).toEqual([22, 16, 26, 14]);
    expect(T().townPos.length).toBe(78);
    expect(T().townSmapEntry.length).toBe(78);
  });
  it('names', () => {
    expect(T().classNames[0]).toBe('단병');
    expect(T().classNames[18]).toBe('수송대');
    expect(T().factionNames[0]).toBe('유비');
    expect(T().factionNames[14]).toBe('무소속');
  });
  it('max troops (0cf5:73b8)', () => {
    expect(maxTroops(T(), 0, 3)).toBe(600); // 유비 in save 2: 단병 Lv3, 병력 600 on the 장수정보 screen
  });
});

describe.skipIf(!hasGame)('BAKDATA.R3', () => {
  const B = () => parseBakData(gameFile('BAKDATA.R3'));
  it('officers', () => {
    const bak = B();
    const [yubi, gwanu, jangbi] = bak.officers;
    expect(yubi.name).toBe('유비');
    expect([yubi.leadership, yubi.strength, yubi.intelligence]).toEqual([91, 75, 64]);
    expect(yubi.reading).toBe('ﾘｭｳﾋﾞ');
    expect(gwanu.name).toBe('관우');
    expect(gwanu.face).toBe(1);
    expect(jangbi.name).toBe('장비');
    expect(bak.defaultDyn[1].items[0]).toBe(12); // 관우 starts with item 12
    expect(bak.defaultDyn[0].flags).toBe(0x80);
  });
  it('items and NPC types', () => {
    const bak = B();
    expect(bak.items[0].name).toBe('둔갑천서');
    expect(bak.items[0].price).toBe(0xff);
    expect(bak.items[27]).toMatchObject({ name: '술', price: 5, type: 3 });
    expect(bak.npcTypes[0].name).toBe('노인');
  });
});

describe.skipIf(!hasGame)('BBKSDAT1.R3', () => {
  it('has 4 sections of 32 towns', () => {
    const b = gameFile('BBKSDAT1.R3');
    expect(b.length).toBe(4 * 0x380);
    const s0 = parseBbksdat(b, 0);
    expect(s0.towns[0].name).toBe('평원');
    expect(s0.towns[18].name).toBe('신도');
    expect(s0.defaultDyn.every((d) => d.b5 === 3)).toBe(true);
    for (let s = 0; s < 4; s++) expect(parseBbksdat(b, s).towns.length).toBe(32);
  });
});

describe.skipIf(!hasGame)('blob indexes', () => {
  for (const [name, count] of [
    ['FACEDAT.R3', FACEDAT_COUNT],
    ['PACKGRP.R3', PACKGRP_COUNT],
  ] as const) {
    it(`${name} entries are contiguous and fill the file`, () => {
      const f = gameFile(name);
      const blobs = parseBlobIndex(f, count);
      let end = count * 6;
      for (const bl of blobs) {
        expect(bl.byteOffset - f.byteOffset).toBe(end);
        end += bl.length;
      }
      expect(end).toBe(f.length);
    });
  }
  it('disk labels', () => {
    expect(parseDiskLabel(gameFile('DISK1.R3I'))).toContain('三國志英傑伝');
  });
});
