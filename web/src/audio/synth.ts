// SBOPL2 driver + OPL2 chip + resampler: produces audio at any output rate.
// Used by the AudioWorklet (worklet.ts), the ScriptProcessor fallback (player.ts) and tests.
import { Opl2, OPL_RATE } from './opl';
import { PIT_HZ, Sbopl2 } from './sequencer';

/** Commands accepted by the synth (also the worklet message format). */
export type SynthCommand =
  | { type: 'musicBank'; data: Uint8Array; offset?: number }
  | { type: 'sfxBank'; data: Uint8Array; offset?: number }
  /** Play song `song` (1-based) of the bank; `data` first replaces the bank contents in place.
   *  With `fadeFirst`, a playing song is first faded out at that speed (MAIN 0CF5:600A). */
  | { type: 'play'; song: number; repeat?: boolean; data?: Uint8Array; fadeFirst?: number }
  | { type: 'stop'; fade?: number }
  | { type: 'sfx'; n: number }
  | { type: 'stopSfx' }
  | { type: 'volume'; value: number };

export class Synth {
  readonly opl = new Opl2();
  readonly driver = new Sbopl2((r, v) => this.opl.write(r, v));
  private readonly samplesPerIrq = OPL_RATE / PIT_HZ; // ≈ 170.67 chip samples per timer tick
  private untilIrq = 0;
  private readonly buf = new Float32Array(4096);
  private bufLen = 0;
  private bufPos = 0;
  private frac = 0;
  private last = 0;
  /** Output gain: 2 matches the level of DOSBox's OPL emulation (the chip itself is ±4096 per channel). */
  private gain = 2;
  private dcIn = 0;
  private dcOut = 0;
  private readonly dcPole: number;
  private pendingPlay: SynthCommand | null = null;

  constructor(readonly outRate: number) {
    this.driver.reset();
    this.dcPole = 1 - (2 * Math.PI * 10) / outRate; // AC coupling (≈10 Hz high-pass), as on the sound card
  }

  command(c: SynthCommand) {
    const d = this.driver;
    switch (c.type) {
      case 'musicBank':
        d.setMusicBank(c.data, c.offset ?? 0);
        break;
      case 'sfxBank':
        d.setSfxBank(c.data, c.offset ?? 0);
        break;
      case 'play':
        if (c.fadeFirst && d.song) {
          // MAIN 0CF5:6086 → 5F56: AH=02h AL=speed, then wait until AH=03h reports no song
          d.stop(c.fadeFirst);
          this.pendingPlay = { ...c, fadeFirst: 0 };
          break;
        }
        this.pendingPlay = null;
        // what MAIN 0CF5:5F8E does: load the entry into the bank buffer, AH=01h AL=1, AH=04h AL=1
        if (c.data) {
          if (!d.hasMusicBank) d.setMusicBank(c.data, 0);
          else d.replaceMusicData(c.data);
        }
        d.play(c.song);
        d.setRepeat(c.repeat === false ? 0 : 1);
        break;
      case 'stop':
        this.pendingPlay = null;
        d.stop(c.fade ?? 0);
        break;
      case 'sfx':
        d.playSfx(c.n);
        break;
      case 'stopSfx':
        d.stopSfx();
        break;
      case 'volume':
        this.gain = c.value;
        break;
    }
  }

  /** Fills the internal buffer with chip-rate samples, running the driver's timer ticks in between. */
  private refill() {
    let n = 0;
    while (n < 1024) {
      if (this.untilIrq < 1) {
        this.driver.irq();
        this.untilIrq += this.samplesPerIrq;
        if (this.pendingPlay && !this.driver.song) this.command(this.pendingPlay);
      }
      const k = Math.min(1024 - n, Math.floor(this.untilIrq));
      this.opl.render(this.buf, k, n);
      n += k;
      this.untilIrq -= k;
    }
    this.bufLen = n;
    this.bufPos = 0;
  }

  /** Renders `n` mono samples at outRate into out[offset..] (linear interpolation from the chip rate). */
  render(out: Float32Array, n: number, offset = 0) {
    const step = OPL_RATE / this.outRate;
    for (let i = 0; i < n; i++) {
      while (this.frac >= 1) {
        if (this.bufPos >= this.bufLen) this.refill();
        this.last = this.buf[this.bufPos++];
        this.frac -= 1;
      }
      if (this.bufPos >= this.bufLen) this.refill();
      const next = this.buf[this.bufPos];
      const v = (this.last + (next - this.last) * this.frac) * this.gain;
      this.dcOut = v - this.dcIn + this.dcPole * this.dcOut;
      this.dcIn = v;
      out[offset + i] = this.dcOut;
      this.frac += step;
    }
  }
}
