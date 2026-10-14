// Compares the TypeScript SBOPL2 port with the original driver (tools/sbopl2_ref.py runs
// SBOPL2.COM under Unicorn): the OPL register writes and the timer tick they happen on must match
// exactly, for every song of MUSIC.R3 / OPMUSIC.R3 / EDMUSIC.R3 and every SFX in MAIN.EXE.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Sbopl2 } from '../src/audio/sequencer';
import { mainSfxBank, musicEntries, sfxCount } from '../src/audio/music';
import { GAME_DIR, gameFile, hasGame } from './gamedir';

type W = [number, number, number];

const TOOL = join(__dirname, '..', '..', 'tools', 'sbopl2_ref.py');
const MUSIC_TICKS = 40000; // ≈ 137 s of music per song
const SFX_TICKS = 1500;

function haveUnicorn(): boolean {
  if (!hasGame) return false;
  try {
    execFileSync('python3', ['-I', '-c', 'import unicorn, capstone'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function reference(ticks: number, jobs: string[]): Record<string, W[]> {
  const out = execFileSync('python3', ['-I', TOOL, GAME_DIR, 'batch', String(ticks), ...jobs], {
    maxBuffer: 1 << 30,
  });
  return JSON.parse(out.toString());
}

function port(ticks: number, setup: (d: Sbopl2) => void): W[] {
  const out: W[] = [];
  let tick = -1;
  const d = new Sbopl2((r, v) => out.push([tick, r, v]));
  d.reset();
  setup(d);
  for (tick = 0; tick < ticks; tick++) d.irq();
  return out;
}

function firstDiff(a: W[], b: W[]): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2])
      return `write #${i}: ts=${JSON.stringify(x)} ref=${JSON.stringify(y)} (ts ${a.length} / ref ${b.length} writes)`;
  }
  return '';
}

const run = haveUnicorn();

describe.skipIf(!run)('SBOPL2 port vs original driver', () => {
  for (const file of ['MUSIC.R3', 'OPMUSIC.R3', 'EDMUSIC.R3']) {
    it(`${file}: every song, register-exact`, { timeout: 600_000 }, () => {
      const entries = musicEntries(gameFile(file));
      const jobs = entries.map((_, i) => `${file}:${i}`);
      const ref = reference(MUSIC_TICKS, jobs);
      entries.forEach((bank, i) => {
        const ts = port(MUSIC_TICKS, (d) => {
          d.setMusicBank(bank, 0);
          d.play(1);
          d.setRepeat(1);
        });
        expect(ref[jobs[i]].length, jobs[i]).toBeGreaterThan(200);
        expect(firstDiff(ts, ref[jobs[i]]), jobs[i]).toBe('');
      });
    });
  }

  it('API sequence: play, SFX over music, stop SFX, fade-out, replay without repeat', { timeout: 120_000 }, () => {
    const events: [number, number, number][] = [
      [0, 0x01, 1], [0, 0x04, 1], [500, 0x11, 5], [530, 0x11, 7], [700, 0x12, 0], [900, 0x11, 12],
      [3000, 0x02, 8], [6000, 0x01, 1], [6000, 0x04, 0], [6100, 0x11, 3], [9000, 0x02, 0], [9050, 0x01, 1],
    ];
    const ticks = 12000;
    const file = 'MUSIC.R3';
    const entry = 3;
    const ref: W[] = JSON.parse(
      execFileSync('python3', ['-I', TOOL, GAME_DIR, 'script', file, String(entry), String(ticks), JSON.stringify(events)], {
        maxBuffer: 1 << 30,
      }).toString(),
    );
    const bank = musicEntries(gameFile(file))[entry];
    const sfx = mainSfxBank(gameFile('MAIN.EXE'));
    const out: W[] = [];
    let tick = -1;
    const d = new Sbopl2((r, v) => out.push([tick, r, v]));
    d.reset();
    d.setMusicBank(bank, 0);
    d.setSfxBank(sfx.data, sfx.offset);
    let e = 0;
    for (let t = 0; t < ticks; t++) {
      tick = t - 1;
      for (; e < events.length && events[e][0] <= t; e++) {
        const [, ah, al] = events[e];
        if (ah === 0x01) d.play(al);
        else if (ah === 0x02) d.stop(al);
        else if (ah === 0x04) d.setRepeat(al);
        else if (ah === 0x11) d.playSfx(al);
        else if (ah === 0x12) d.stopSfx();
      }
      tick = t;
      d.irq();
    }
    expect(firstDiff(out, ref)).toBe('');
  });

  it('MAIN.EXE SFX bank: every effect, register-exact', { timeout: 600_000 }, () => {
    const bank = mainSfxBank(gameFile('MAIN.EXE'));
    const n = sfxCount(bank);
    expect(n).toBeGreaterThan(10);
    const jobs = Array.from({ length: n }, (_, i) => `sfx:${i + 1}`);
    const ref = reference(SFX_TICKS, jobs);
    for (let i = 0; i < n; i++) {
      const ts = port(SFX_TICKS, (d) => {
        d.setSfxBank(bank.data, bank.offset);
        d.playSfx(i + 1);
      });
      expect(firstDiff(ts, ref[jobs[i]]), jobs[i]).toBe('');
    }
  });
});
