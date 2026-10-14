import { describe, expect, it } from 'vitest';
import { parseChapter, parseTownsfolk, readStageTitles, isKnownOpcode, type Command } from '../src/formats/scenario';
import { gameFile, hasGame } from './gamedir';

describe.skipIf(!hasGame)('scenario', () => {
  // describe bodies run during collection even when skipped, so only read files when present
  const chapters = hasGame ? [0, 1, 2, 3, 4].map((c) => parseChapter(c, gameFile(`SNR${c}D.R3`), gameFile(`SNR${c}M.R3`))) : [];

  it('parses every chapter without unknown opcodes', () => {
    expect(chapters.map((c) => c.stages.length)).toEqual([1, 5, 4, 5, 3]);
    let total = 0;
    for (const ch of chapters)
      for (const st of ch.stages)
        for (const c of st.commands.values()) {
          expect(isKnownOpcode(c.op)).toBe(true);
          total++;
        }
    expect(total).toBe(14132); // same count as tools/snrdis.py
  });

  it('resolves every message reference', () => {
    for (const ch of chapters)
      for (const st of ch.stages)
        for (const c of st.commands.values()) {
          if (c.name === 'TALK') {
            const lines = ch.messages.talk(st.index, c.msg);
            expect(lines.length).toBeGreaterThan(0);
            for (const l of lines) {
              expect(l.speaker).toBeLessThan(0x180);
              expect(l.text).not.toContain('�');
            }
          } else if ('msg' in c) {
            expect(ch.messages.text(st.index, c.msg).text).not.toContain('�');
          }
        }
  });

  it('keeps conditional skips inside the event (no END or 0x1d skipped)', () => {
    // The original skips with a length table (DS:0x2522) that is wrong for 0x1d and has no entry for 0xff.
    for (const ch of chapters)
      for (const st of ch.stages) {
        const offs = [...st.commands.keys()].sort((a, b) => a - b);
        offs.forEach((o, i) => {
          const c = st.commands.get(o)!;
          const n = c.name === 'IF' ? c.skip : c.name === 'ASK' ? c.skip : 0;
          for (let k = 1; k <= n; k++) {
            const s = st.commands.get(offs[i + k]) as Command;
            expect(['END', 'SET_PREV_MAP']).not.toContain(s.name);
          }
        });
      }
  });

  it('decodes the prologue', () => {
    const ch = chapters[0];
    const st = ch.stages[0];
    expect(st.blocks.length).toBe(10);
    const first = st.commands.get(st.blocks[0].records[0].code)!;
    expect(first).toMatchObject({ name: 'INPUT', enable: 1 });
    expect(ch.messages.text(0, 0x3).text).toBe('서장 동탁타도군 일어나다.');
    const talk = ch.messages.talk(0, 0x1c0);
    expect(talk.map((l) => l.speaker)).toEqual([3, 382, 3]);
    expect(talk[1].text).toBe('......');
    expect(readStageTitles(gameFile('MAIN.EXE'))[0]).toBe('서장 동탁타도군 일어나다.');
  });

  it('handles the >64 KiB message file of chapter 3', () => {
    expect(chapters[3].messages.bases).toEqual([0xa, 0x558d, 0xa32a, 0x11029, 0x159d0]);
  });

  it('parses the townsfolk tables', () => {
    const secs = parseTownsfolk(gameFile('IPPAN0.R3'), gameFile('IPPAN0M.R3'), gameFile('MAIN.EXE'));
    expect(secs.map((s) => s.towns.length)).toEqual([22, 16, 26, 14]);
    for (const s of secs) {
      expect(s.messages.filter((m) => m).length).toBeGreaterThan(10);
      for (const m of s.messages) if (m) expect(m.text).not.toContain('�');
      for (const t of s.towns) for (const g of t) for (const p of g.people) expect(p).toBeLessThan(s.messages.length);
    }
  });
});
