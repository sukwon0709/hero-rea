// OPL2 emulator sanity checks, and offline rendering of game songs (set AUDIO_WAV_DIR to also
// write them as .wav files for listening).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Opl2, OPL_RATE } from '../src/audio/opl';
import { Synth } from '../src/audio/synth';
import { mainSfxBank, musicEntries } from '../src/audio/music';
import { gameFile, hasGame } from './gamedir';

function zeroCrossHz(x: Float32Array, rate: number): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return (n * rate) / x.length;
}

/** Median over 0.5 s windows of the strongest frequency (radix-2 FFT, 8192 points, Hann window). */
function dominantHz(x: Float32Array, rate: number): number {
  const N = 8192;
  const peaks: number[] = [];
  for (let s = 0; s + N <= x.length; s += rate >> 1) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [re[i], re[j], im[i], im[j]] = [re[j], re[i], im[j], im[i]];
    }
    for (let len = 2; len <= N; len <<= 1) {
      const a = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len)
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(a * k);
          const wi = Math.sin(a * k);
          const p = i + k;
          const q = p + len / 2;
          const tr = re[q] * wr - im[q] * wi;
          const ti = re[q] * wi + im[q] * wr;
          re[q] = re[p] - tr;
          im[q] = im[p] - ti;
          re[p] += tr;
          im[p] += ti;
        }
    }
    let best = 5;
    for (let k = 5; k < N / 2; k++) if (re[k] ** 2 + im[k] ** 2 > re[best] ** 2 + im[best] ** 2) best = k;
    peaks.push((best * rate) / N);
  }
  peaks.sort((a, b) => a - b);
  return peaks[peaks.length >> 1];
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

function wav(x: Float32Array, rate: number): Uint8Array {
  const b = new Uint8Array(44 + x.length * 2);
  const dv = new DataView(b.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + x.length * 2, true);
  str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, x.length * 2, true);
  x.forEach((v, i) => dv.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true));
  return b;
}

describe('OPL2 emulator', () => {
  it('plays A4 (F-number 0x241, block 4) at ≈437.7 Hz', () => {
    const o = new Opl2();
    o.write(0x20, 0x01); // modulator mult 1
    o.write(0x23, 0x21); // carrier sustained (EGT), mult 1
    o.write(0x40, 0x3f); // modulator silent
    o.write(0x43, 0x00); // carrier full volume
    o.write(0x63, 0xf0); // carrier AR=15
    o.write(0x83, 0x0f);
    o.write(0xc0, 0x00);
    o.write(0xa0, 0x41);
    o.write(0xb0, 0x20 | (4 << 2) | 2);
    const x = new Float32Array(Math.round(OPL_RATE));
    o.render(x, x.length);
    expect(Math.abs(zeroCrossHz(x, OPL_RATE) - (577 * OPL_RATE) / 65536)).toBeLessThan(1.5);
    expect(rms(x)).toBeGreaterThan(0.05);
    o.write(0xb0, (4 << 2) | 2); // key off: RR=15 → silent quickly
    o.render(x, 4000);
    o.render(x, x.length);
    expect(rms(x)).toBeLessThan(0.001);
  });
});

describe.skipIf(!hasGame)('song rendering', () => {
  const rate = 44100;
  const dir = process.env.AUDIO_WAV_DIR;
  const render = (bank: Uint8Array, seconds: number) => {
    const s = new Synth(rate);
    s.command({ type: 'musicBank', data: bank });
    s.command({ type: 'play', song: 1 });
    const x = new Float32Array(rate * seconds);
    s.render(x, x.length);
    return x;
  };

  it('every MUSIC.R3 song is audible with a sensible pitch range', () => {
    musicEntries(gameFile('MUSIC.R3')).forEach((bank, i) => {
      const x = render(bank, 8);
      if (dir) writeFileSync(join(dir, `music${String(i).padStart(2, '0')}.wav`), wav(x, rate));
      expect(rms(x), `song ${i}`).toBeGreaterThan(0.01);
      let peak = 0;
      for (const v of x) peak = Math.max(peak, Math.abs(v));
      expect(peak, `song ${i}`).toBeLessThan(1.2);
      const hz = dominantHz(x, rate);
      expect(hz, `song ${i}`).toBeGreaterThan(60);
      expect(hz, `song ${i}`).toBeLessThan(2000);
    });
  });

  it('opening/ending songs and an SFX render', () => {
    for (const f of ['OPMUSIC.R3', 'EDMUSIC.R3'])
      musicEntries(gameFile(f)).forEach((bank, i) => {
        const x = render(bank, 8);
        if (dir) writeFileSync(join(dir, `${f.slice(0, 2).toLowerCase()}${i}.wav`), wav(x, rate));
        expect(rms(x), `${f} ${i}`).toBeGreaterThan(0.005);
      });
    const s = new Synth(rate);
    const sfx = mainSfxBank(gameFile('MAIN.EXE'));
    s.command({ type: 'sfxBank', data: sfx.data, offset: sfx.offset });
    s.command({ type: 'sfx', n: 1 });
    const x = new Float32Array(rate);
    s.render(x, x.length);
    expect(rms(x)).toBeGreaterThan(0.001);
  });
});
