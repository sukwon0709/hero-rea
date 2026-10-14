import { describe, expect, it } from 'vitest';
import { MSAVE_OFF, parseMSave } from '../src/formats/save';
import { OFFICER_DYN_SIZE, maxTroops, parseBakData, readEngineTables } from '../src/formats/tables';
import { EMPTY_ITEM, HERO, SaveEdit, classOptions, type GameData } from '../src/editor/model';
import { gameFile, hasGame } from './gamedir';

let data: GameData | undefined;
const D = (): GameData => (data ??= { bak: parseBakData(gameFile('BAKDATA.R3')), tables: readEngineTables(gameFile('MAIN.EXE')) });
const officerOff = (i: number) => MSAVE_OFF.officers + i * OFFICER_DYN_SIZE;

describe.skipIf(!hasGame)('save editor', () => {
  it('round-trips every shipped save byte for byte when nothing is edited', () => {
    for (let n = 0; n < 5; n++) {
      const b = gameFile(`MSAVE${n}.R3S`);
      const e = new SaveEdit(D(), b);
      expect(e.changed()).toBe(false);
      expect(e.bytes()).toEqual(b);
    }
  });

  it('roster is the 장수정보 list; names come from BAKDATA', () => {
    const e = new SaveEdit(D(), gameFile('MSAVE2.R3S'));
    const names = e.roster().map((i) => e.officer(i).st.name);
    expect(names.slice(0, 3)).toEqual(['유비', '관우', '장비']);
    expect(e.officer(HERO).dyn.level).toBe(3);
  });

  it('level, class and item edits change exactly the expected bytes', () => {
    const orig = gameFile('MSAVE2.R3S');
    const e = new SaveEdit(D(), orig);
    const t = D().tables;
    const items = D().bak.items;
    const 경기병 = t.classNames.indexOf('경기병');
    const 청룡 = items.findIndex((it) => it.name === '청룡언월도');
    expect(경기병).toBe(6);
    expect(청룡).toBeGreaterThanOrEqual(0);

    const k = 1; // 관우
    e.setLevel(k, 20);
    e.setExp(k, 42);
    e.setClass(k, 경기병);
    const held = e.items(k).length;
    e.setItem(k, 7, 청룡); // goes to the first free slot, items stay packed
    e.money = 1234;

    const out = e.bytes();
    const o = officerOff(k);
    const max = maxTroops(t, 경기병, 20);
    expect(max).toBe(10 * (10 * t.troopBase[6] + t.troopGrowth[6] * 19));
    const expected = orig.slice();
    expected[o + 5] = max & 0xff;
    expected[o + 6] = max >> 8;
    expected[o + 7] = 경기병;
    expected[o + 8] = 20;
    expected[o + 9] = 42;
    expected[o + 10 + held] = 청룡;
    expected[MSAVE_OFF.progress] = 1234 & 0xff;
    expected[MSAVE_OFF.progress + 1] = 1234 >> 8;
    expect(out).toEqual(expected);

    // the saved file parses back to the edited values
    const back = parseMSave(out).officers[k];
    expect(back).toMatchObject({ level: 20, exp: 42, cls: 경기병, troops: max });
    expect(back.items[held]).toBe(청룡);
  });

  it('clearing an item slot packs the remaining items', () => {
    const e = new SaveEdit(D(), gameFile('MSAVE1.R3S'));
    const k = 2; // 장비 holds five items in this save
    const before = e.items(k);
    expect(before.length).toBeGreaterThan(2);
    e.setItem(k, 1, EMPTY_ITEM);
    expect(e.items(k)).toEqual([before[0], ...before.slice(2)]);
    expect(e.save.officers[k].items.slice(before.length - 1)).toEqual(Array(9 - before.length).fill(EMPTY_ITEM));
  });

  it('class options follow the promotion lines and class books', () => {
    const names = D().tables.classNames;
    const hero = classOptions(HERO, 0, names);
    expect(hero.filter((c) => c.reach === 'line').map((c) => c.cls)).toEqual([0, 1, 2]);
    expect(hero.some((c) => c.reach === 'book')).toBe(false); // 유비 cannot use class books
    const other = classOptions(1, 0, names);
    expect(other.filter((c) => c.reach !== 'other').map((c) => c.cls)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 15, 18]);
    expect(other[1].minLevel).toBe(15);
    expect(other[8].minLevel).toBe(30);
  });
});
