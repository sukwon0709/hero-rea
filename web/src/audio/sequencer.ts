// Port of Koei's SBOPL2.COM ("Sound Blaster BGM Driver Version 1.01", int 66h), see docs/SOUND.md.
//
// Every routine below mirrors one routine of the original driver (addresses are offsets in the
// .COM image, i.e. CS:offset with the PSP at CS:0000) and keeps its 8/16-bit arithmetic, so the
// stream of OPL register writes is identical to the original (checked by web/test/audio.test.ts
// against the real driver running under tools/dosemu.py, see tools/sbopl2_ref.py).
//
// Timing: the driver reprograms PIT channel 0 to divisor 0x1000, so `irq()` must be called
// PIT_HZ (= 1193182 / 4096 ≈ 291.3) times per second.

export const PIT_HZ = 1193182 / 4096;

export type OplWrite = (reg: number, val: number) => void;

/** F-numbers for C..B (0:076A), followed by the bytes the driver would read past the table for
 *  out-of-range semitones (0:0782.., code bytes), so even nonsense input behaves like the original. */
const FNUM = [
  0x157, 0x16b, 0x181, 0x198, 0x1b0, 0x1ca, 0x1e5, 0x202, 0x220, 0x241, 0x263, 0x287,
  0x5150, 0xba52, 0x0388, 0x04b9, 0xec00, 0xfde2, 0x595a, 0xc358, 0x5150, 0xba52, 0x0388, 0x17b9,
];
/** Pitch-bend range per semitone count, (2^(n/12) - 1) * 0x7FFF (0:0730). */
const BEND_DEPTH = [0, 0x79c, 0xfad, 0x1838, 0x2145, 0x2adc, 0x3505, 0x3fc8, 0x4b2f, 0x5744, 0x6411, 0x71a1, 0x7fff];
/** Vibrato depth by instrument byte 0x10 & 15 (0:074A). */
const VIB_DEPTH = [
  0x4c, 0x72, 0xbe, 0x10a, 0x17d, 0x2fe, 0x79c, 0xfad, 0x2145, 0x2adc, 0x3fc8, 0x4b2f, 0x5744, 0x7fff, 0x9f58, 0xea08,
];
/** Operator register offset (first operator) of OPL channels 0..8 (channel records +0x27). */
const OP_OFF = [0, 1, 2, 8, 9, 10, 16, 17, 18];

const s8 = (v: number) => ((v & 0xff) ^ 0x80) - 0x80;
const s16 = (v: number) => ((v & 0xffff) ^ 0x8000) - 0x8000;

/** One channel record (0x30 bytes at 0:056A + 0x30*n). Field comments give the record offset. */
class Chan {
  ptr = 0; //        +00 stream position (offset in the bank segment), 0 = channel finished
  loop = 0; //       +02 loop point (0xFE), initially the stream start
  flags = 0; //      +04 1 never-read, 2 bend armed, 4 inst has LFO, 8 LFO on (F8), 0x20 tie, 0x40 keyed since load, 0x80 key on
  vol = 0; //        +05 volume 0..127
  note = 0; //       +06 current note (0xFF none)
  dur = 0; //        +07 duration (ticks)
  gate = 0; //       +08 key-on time (ticks)
  durCnt = 0; //     +09
  gateCnt = 0; //    +0A
  repCnt = 0; //     +0B
  repStart = 0; //   +0C
  repExit = 0; //    +0E
  freq = 0; //       +10 base block/F-number (A0/B0 without key-on)
  tlw = [0, 0]; //   +12 per-operator TL after volume
  trem = [0, 0]; //  +14 per-operator tremolo amount
  inst = 0; //       +16 instrument offset
  instBank: Uint8Array | null = null; // +18 instrument segment (null = none)
  transpose = 0; //  +1A from instrument byte 0x0B
  mod = 0; //        +1B bits 0-1 LFO state, 4 negative bend, 0x40 bend active, 0x80 LFO active
  lfoSpeed = 0; //   +1C
  lfoDepth = 0; //   +1E
  lfoCnt = 0; //     +20
  lfoDir = 0; //     +22
  lfoVal = 0; //     +24
  tl = [0, 0]; //    +28 cached KSL/TL register values
  fA0 = 0; //        +2A cached A0
  fB0 = 0; //        +2B cached B0 (with key-on bit)
  chVol = 0; //      +2C attenuation set by int 66h AH=80h (bit 7: never key on)
  chTrans = 0; //    +2D transpose set by int 66h AH=81h
  relCnt = 0; //     +2E ticks after key-off until the channel is silenced
  constructor(
    readonly ch: number, // +26 OPL channel
    readonly op: number, // +27 operator offset
  ) {}

  /** 0:09AB: clears +00..+25 and sets the defaults. */
  init() {
    this.ptr = this.loop = 0;
    this.flags = 1;
    this.vol = 0;
    this.note = 0xff;
    this.dur = 0x30;
    this.gate = 0x2d;
    this.durCnt = 1;
    this.gateCnt = this.repCnt = this.repStart = this.repExit = 0;
    this.freq = 0;
    this.tlw = [0, 0];
    this.trem = [0, 0];
    this.inst = 0;
    this.instBank = null;
    this.transpose = this.mod = this.lfoSpeed = this.lfoDepth = this.lfoCnt = this.lfoVal = 0;
    this.lfoDir = 1;
    this.relCnt = 0;
  }
}

export class Sbopl2 {
  private readonly c: Chan[] = OP_OFF.map((op, i) => new Chan(i, op));
  private mus: Uint8Array | null = null; // 0:055E music bank (segment = this buffer)
  private musOff = 0;
  private sfx: Uint8Array | null = null; // 0:0562 SFX bank
  private sfxOff = 0;

  private tempoInc = 0; //   0:0118
  private tempoAcc = 0; //   0:011A
  private musPending = 0; // 0:011C
  private sfxPending = 0; // 0:011E
  private sfxAcc = 0; //     0:0120
  private chainCnt = 1; //   0:0121
  private waitAcc = [0, 0]; // 0:0122/0123
  /** 0:0124/0126: countdown timers of int 66h AH=F0h/F1h (decremented at PIT_HZ*0x35/256). */
  readonly wait = [0, 0];
  private globalTicks = 0; // 0:071A
  private seed = 0x037d; //   0:071C
  /** 0:071E: music ticks since the song started (reset when it loops). */
  songTicks = 0;
  /** 0:0720: ticks since the SFX started. */
  sfxTicks = 0;
  private tempo = 0x78; //    0:0722
  private fadeSpeed = 0; //   0:0724
  private fadeSub = 0; //     0:0725
  private fadeStep = 0; //    0:0726
  private fadeAtt = 0; //     0:0727
  private repeat = 0; //      0:0728
  /** 0:0729: song number playing (1-based), 0 = none. */
  song = 0;
  private queuedRep = 0; //   0:072A
  private queued = 0; //      0:072B
  /** 0:072C: SFX number playing (1-based), 0 = none. */
  sfxNo = 0;
  private bd = 0; //          0:072D

  constructor(private readonly w: OplWrite) {}

  get hasMusicBank(): boolean {
    return this.mus !== null;
  }

  // ---------------------------------------------------------------- public API (int 66h)

  /** 0:115A: what the installer does to the chip (and what it does again on uninstall). */
  reset() {
    this.w(0x01, 0x20);
    this.w(0x08, 0x40);
    this.w(0xbd, 0x00);
    for (const c of this.c) {
      c.init();
      this.silence(c);
    }
  }

  /** AH=00h (0:0385): register the music bank (DS:DX) and stop the music. */
  setMusicBank(bank: Uint8Array, offset = 0) {
    this.stop(0);
    this.mus = bank;
    this.musOff = offset;
    for (let i = 0; i < 7; i++) {
      this.c[i].init();
      this.c[i].chVol = this.c[i].chTrans = 0;
    }
  }

  /** Replaces the contents of the registered music buffer without telling the driver, which is
   *  what MAIN does before every song (0CF5:5F8E reads the MUSIC.R3 entry into the buffer
   *  registered once at startup). */
  replaceMusicData(bank: Uint8Array) {
    this.mus = bank;
  }

  /** AH=01h (0:03B0): stop, then play song `n` (1-based) of the bank. */
  play(n: number) {
    this.stop(0);
    if (this.mus) this.startSong(n & 0xff);
  }

  /** AH=02h (0:03C6): AL=0 stops at once, otherwise fades out (AL = fade length; MAIN uses 8/16). */
  stop(fade: number) {
    this.queued = 0;
    if ((fade & 0xff) === 0) this.stopMusic();
    else this.fadeSpeed = fade & 0xff;
  }

  /** AH=04h (0:03EC): repeat flag (0 = play once). */
  setRepeat(on: number) {
    this.repeat = on & 0xff;
  }

  /** AH=08h (0:0458): song to start when the current one ends. */
  queue(n: number, repeat: number) {
    this.queued = n & 0xff;
    this.queuedRep = repeat & 0xff;
  }

  /** AH=10h (0:04CD): register the SFX bank. */
  setSfxBank(bank: Uint8Array, offset = 0) {
    this.stopSfx();
    this.sfx = bank;
    this.sfxOff = offset;
    this.sfxTicks = 0;
    this.keyOff(this.c[7]); // 0:0474
    this.keyOff(this.c[8]);
    for (let i = 7; i < 9; i++) {
      this.c[i].init();
      this.c[i].chVol = this.c[i].chTrans = 0;
    }
  }

  /** AH=11h (0:04FE): play SFX `n` (1-based). */
  playSfx(n: number) {
    this.stopSfx();
    if (this.sfx) this.startSfx(n & 0xff);
  }

  /** AH=12h (0:0512). */
  stopSfx() {
    this.sfxNo = 0;
    this.keyOff(this.c[7]); // 0:0474
    this.keyOff(this.c[8]);
    this.silence(this.c[7]);
    this.silence(this.c[8]);
    this.sfxTicks = 0;
  }

  /** AH=80h (0:053A): per-channel attenuation (bit 7 = keep keyed off). */
  setChannelVolume(ch: number, v: number) {
    const c = this.c[ch];
    c.chVol = v & 0xff;
    this.volume(c, c.vol);
  }

  /** AH=81h (0:054D): per-channel transpose (signed semitones). */
  setChannelTranspose(ch: number, v: number) {
    if (ch < 9) this.c[ch].chTrans = v & 0xff;
  }

  /** Timer interrupt handler (0:0225), called PIT_HZ times per second. */
  irq() {
    this.tempoAcc += this.tempoInc;
    if (this.tempoAcc > 0xffff) {
      this.tempoAcc &= 0xffff;
      this.musPending = (this.musPending + 1) & 0xffff;
    }
    this.sfxAcc += 0x36;
    if (this.sfxAcc > 0xff) {
      this.sfxAcc &= 0xff;
      this.sfxPending = (this.sfxPending + 1) & 0xffff;
    }
    for (let i = 0; i < 2; i++) {
      this.waitAcc[i] += 0x35;
      if (this.waitAcc[i] > 0xff) {
        this.waitAcc[i] &= 0xff;
        if (this.wait[i]) this.wait[i]--;
      }
    }
    if (--this.chainCnt === 0) {
      this.chainCnt = 16; // every 16th tick goes to the BIOS handler instead (18.2 Hz)
      return;
    }
    // 0:09DA
    while (this.musPending | this.sfxPending) {
      if (this.musPending) {
        this.musicTick();
        this.musPending--;
      }
      if (this.sfxPending) {
        this.sfxTick();
        this.sfxPending--;
      }
    }
  }

  // ---------------------------------------------------------------- OPL helpers

  /** 0:07BA */
  private keyOn(c: Chan) {
    if (!(c.chVol & 0x80)) {
      c.fB0 |= 0x20;
      this.w(0xb0 + c.ch, c.fB0);
      c.flags |= 0xc0;
      c.mod |= 3;
    }
    c.relCnt = 0;
  }

  /** 0:07E0 */
  private keyOff(c: Chan) {
    c.fB0 &= 0xdf;
    this.w(0xb0 + c.ch, c.fB0);
    c.flags &= 0x5f;
    c.mod &= 0xbf;
    c.relCnt = 0xff;
  }

  /** 0:0800 */
  private silence(c: Chan) {
    c.fA0 = c.fB0 = 0;
    this.w(0xa0 + c.ch, 0);
    this.w(0xb0 + c.ch, 0);
    this.w(0x80 + c.op, 0x0f);
    this.w(0x83 + c.op, 0x0f);
    this.w(0x40 + c.op, 0x3f);
    c.tl[0] = 0x3f;
    this.w(0x43 + c.op, 0x3f);
    c.tl[1] = 0x3f;
    c.flags &= 0x1f;
    c.mod &= 0xbf;
    c.relCnt = 0;
  }

  /** 0:0846: instrument bytes 0..10 → 20/23, C0, E0/E3, 40/43, 60/63, 80/83. */
  private loadInst(c: Chan, b: Uint8Array, p: number) {
    const op = c.op;
    this.w(0x20 + op, rd8(b, p));
    this.w(0x23 + op, rd8(b, p + 1));
    this.w(0xc0 + c.ch, rd8(b, p + 2));
    this.w(0xe0 + op, rd8(b, p + 3));
    this.w(0xe3 + op, rd8(b, p + 4));
    this.w(0x40 + op, rd8(b, p + 5));
    this.w(0x43 + op, rd8(b, p + 6));
    this.w(0x60 + op, rd8(b, p + 7));
    this.w(0x63 + op, rd8(b, p + 8));
    this.w(0x80 + op, rd8(b, p + 9));
    this.w(0x83 + op, rd8(b, p + 10));
  }

  /** 0:08A2: writes TL `t` (0..63) of operator k, reduced by its tremolo amount. */
  private setTL(c: Chan, k: number, t: number) {
    const loud = ~t & 0x3f;
    let v = loud - Math.floor((loud * c.trem[k]) / 0x7f);
    if (v < 0) v = 0;
    const old = c.tl[k];
    const out = (~v & 0x3f) | (old & 0xc0);
    if (out !== old) {
      c.tl[k] = out;
      this.w(0x40 + c.op + 3 * k, out);
    }
  }

  /** 0:08D2: block/F-number, keeping the key-on bit. */
  private setFreq(c: Chan, ax: number) {
    const bl = ax & 0xff;
    const bh = (ax >> 8) & 0xdf;
    if (bl === c.fA0 && bh === (c.fB0 & 0xdf)) return;
    this.w(0xa0 + c.ch, bl);
    c.fA0 = bl;
    c.fB0 = (c.fB0 & 0x20) | bh;
    this.w(0xb0 + c.ch, c.fB0);
  }

  /** 0:0903 */
  private setTempo(t: number) {
    t &= 0xff;
    if (!t) return;
    this.tempo = t;
    this.tempoInc = Math.floor((t * 0x464e) / 100) & 0xffff;
    this.tempoAcc = 0;
  }

  /** 0:0923: fade-out attenuation. */
  private fadeAdj(v: number) {
    let a = this.fadeAtt;
    a = a >= 0x80 ? a - 0x40 : a >> 1;
    v += a;
    return v > 0x7f ? 0x7f : v;
  }

  /** 0:0A76: applies volume v (0..127) to the carrier (and to the modulator in additive mode). */
  private volume(c: Chan, v: number) {
    v += c.chVol & 0x7f;
    if (v > 0x7f) v = 0x7f;
    if (c.ch < 7) v = this.fadeAdj(v);
    const att = v >> 1;
    const b = c.instBank;
    if (!b) return;
    let dh = rd8(b, c.inst + 2) | 2;
    for (let k = 0; k < 2; k++) {
      let t = rd8(b, c.inst + 5 + k) & 0x3f;
      const carry = dh & 1;
      dh >>= 1;
      if (carry) {
        t += att;
        if (t > 0x3f) t = 0x3f;
      }
      c.tlw[k] = t;
      this.setTL(c, k, t);
    }
  }

  /** 0:0AD3 */
  private resetTrem(c: Chan) {
    c.trem[0] = c.trem[1] = 0;
    this.volume(c, c.vol);
  }

  /** 0:0B18: select instrument at b[p]. */
  private setInst(c: Chan, b: Uint8Array, p: number) {
    c.inst = p;
    c.instBank = b;
    this.silence(c);
    this.loadInst(c, b, p);
    c.tl[0] = rd8(b, p + 5);
    c.tl[1] = rd8(b, p + 6);
    c.transpose = rd8(b, p + 0x0b);
    c.mod &= 0x7f;
    c.flags &= 0xfb;
    if (rd8(b, p + 0x15) !== 0) {
      c.flags |= 4;
      if (c.flags & 8) {
        c.mod |= 0x80;
        c.lfoCnt = c.lfoVal = 0;
        c.lfoDir = 1;
      }
    }
    this.resetTrem(c);
  }

  /** 0:0BA8: pitch bend of `semis` semitones (negative = down) over `period` LFO ticks. */
  private bend(c: Chan, semis: number, period: number) {
    c.lfoSpeed = Math.floor(0x8000 / period) & 0xffff;
    c.mod &= 0xfb;
    if (semis & 0x80) {
      semis = -semis & 0xff;
      c.mod |= 4;
    }
    if (semis > 12) semis = 0;
    c.lfoDepth = BEND_DEPTH[semis];
    c.lfoCnt = c.lfoVal = 0;
    c.lfoDir = 1;
    c.flags |= 2;
    this.setFreq(c, c.freq);
    this.resetTrem(c);
  }

  // ---------------------------------------------------------------- sequencing

  /** 0:030E */
  private startSong(n: number) {
    if (n === 0) return;
    const b = this.mus!;
    this.song = n;
    this.songTicks = 0;
    this.fadeSpeed = this.fadeSub = this.fadeStep = this.fadeAtt = 0;
    const base = (this.musOff + ((16 * (n - 1)) & 0xffff)) & 0xffff;
    let si = base;
    for (let i = 0; i < 7; i++) {
      const c = this.c[i];
      c.init();
      const w = rd16(b, si);
      si += 2;
      c.loop = c.ptr = w ? (w + base) & 0xffff : 0;
    }
    // The driver also loads an 8th word into channel 7 (an SFX channel, not re-initialised);
    // in the game's banks this word is the first two bytes after the 14-byte song header.
    const w7 = rd16(b, si);
    this.c[7].loop = this.c[7].ptr = w7 ? (w7 + base) & 0xffff : 0;
    this.bd = 0;
    this.w(0xbd, 0);
    this.setTempo(0x78);
  }

  /** 0:093E */
  private stopMusic() {
    this.song = this.fadeSpeed = this.fadeAtt = 0;
    for (let i = 0; i < 7; i++) {
      this.silence(this.c[i]);
      this.c[i].ptr = 0;
    }
  }

  /** 0:0960: end of song (no user callback installed). */
  private songEnd() {
    const al = this.queued;
    const bl = this.queuedRep;
    this.song = al;
    if (al) {
      this.repeat = bl;
      this.startSong(al);
    }
    this.queued = 0;
    this.queuedRep = bl;
  }

  /** 0:0491 */
  private startSfx(n: number) {
    if (n === 0) return;
    const b = this.sfx!;
    this.sfxNo = n;
    const base = (this.sfxOff + (((n - 1) << 2) & 0xffff)) & 0xffff;
    this.keyOff(this.c[7]);
    this.keyOff(this.c[8]);
    let si = base;
    for (let i = 7; i < 9; i++) {
      const c = this.c[i];
      c.init();
      c.vol = 0x0f;
      const w = rd16(b, si);
      si += 2;
      c.loop = c.ptr = w ? (w + base) & 0xffff : 0;
    }
  }

  /** 0:0CCD: one sequencer tick of a channel reading from bank b. */
  private chTick(c: Chan, b: Uint8Array) {
    if (c.ptr === 0) return;
    c.durCnt = (c.durCnt - 1) & 0xff;
    if (c.durCnt === 0) {
      c.ptr = this.readEvents(c, b, c.ptr);
      c.flags &= 0xfe;
      return;
    }
    if (c.gateCnt !== 0) {
      c.gateCnt = (c.gateCnt - 1) & 0xff;
      if (c.gateCnt === 0) this.keyOff(c);
    }
  }

  /** 0:0CF1: executes commands up to and including the next note/rest. Returns the new position. */
  private readEvents(c: Chan, b: Uint8Array, si: number): number {
    for (;;) {
      const op = rd8(b, si);
      si = (si + 1) & 0xffff;
      if (op <= 0x5f) {
        c.dur = rd8(b, si);
        c.gate = rd8(b, si + 1);
        si = (si + 2) & 0xffff;
        this.note(c, op, c.gate);
        return si;
      }
      if (op <= 0xbf) {
        this.note(c, op - 0x60, c.gate);
        return si;
      }
      if (op < 0xd0) {
        // C0-CF: no operation
      } else if (op < 0xe0) {
        si = this.repeatCmd(c, op, si); // 0:0A3E
      } else if (op < 0xee) {
        si = (si + 1) & 0xffff; // E0-ED: one ignored parameter byte (0:0CA1)
      } else {
        switch (op) {
          case 0xee: // 0:0C1C AM depth (BD bit 7)
            this.bd = (this.bd & 0x7f) | ((rd8(b, si) & 1) << 7);
            si = (si + 1) & 0xffff;
            this.w(0xbd, this.bd);
            break;
          case 0xef: // 0:0C34 vibrato depth (BD bit 6)
            this.bd = (this.bd & 0xbf) | ((rd8(b, si) & 1) << 6);
            si = (si + 1) & 0xffff;
            this.w(0xbd, this.bd);
            break;
          case 0xf0: // 0:0A6F volume
            c.vol = rd8(b, si) & 0x7f;
            si = (si + 1) & 0xffff;
            this.volume(c, c.vol);
            break;
          case 0xf1: {
            // 0:0AF7 tempo given as an OPL timer-B style value
            const ax = (~rd8(b, si) & 0xff) + 1;
            si = (si + 1) & 0xffff;
            this.setTempo(Math.floor(0x1312d / ((ax * 18) & 0xffff)));
            break;
          }
          case 0xf2: // 0:0AE4 tempo (not from the SFX channels)
            if (c.ch < 7 || c.ch === 9) this.setTempo(rd8(b, si));
            si = (si + 1) & 0xffff;
            break;
          case 0xf3:
            si = (si + 1) & 0xffff;
            break;
          case 0xf4: {
            // 0:0B11 instrument, relative to the command byte
            const p = (rd16(b, si) + si - 1) & 0xffff;
            si = (si + 2) & 0xffff;
            this.setInst(c, b, p);
            break;
          }
          case 0xf5:
            si = (si + 2) & 0xffff;
            break;
          case 0xf6: {
            // 0:0B7E pitch bend, period in tempo-relative units
            const semis = rd8(b, si);
            let ax = rd8(b, si + 1) || 0x100;
            si = (si + 2) & 0xffff;
            let cx = this.tempo || 1;
            cx = (cx << 4) & 0xffff;
            ax = Math.floor((ax * 0x4e2) / cx) & 0xffff;
            this.bend(c, semis, ax || 1);
            break;
          }
          case 0xf7: {
            // 0:0B73 pitch bend, period in LFO ticks
            const semis = rd8(b, si);
            const ax = rd8(b, si + 1) + 1;
            si = (si + 2) & 0xffff;
            this.bend(c, semis, ax);
            break;
          }
          case 0xf8: // 0:0BE9 LFO on
            if (!(c.mod & 0x80)) {
              c.flags |= 8;
              if (c.flags & 4) c.mod |= 0x83;
            }
            break;
          case 0xf9: // 0:0BFE LFO off
            if (c.mod & 0x80) {
              c.flags &= 0xf7;
              c.mod &= 0x7f;
              if (c.flags & 0xc0) {
                this.setFreq(c, c.freq);
                this.resetTrem(c);
              }
            }
            break;
          case 0xfd: // 0:0C4E leave the repeat on its last pass
            if (c.repCnt === 1) {
              c.repCnt = 0;
              c.repStart = 0;
              si = c.repExit;
            }
            break;
          case 0xfe: // 0:0C61 loop point
            c.loop = si;
            break;
          case 0xff: // 0:0C65 end of track
            this.keyOff(c);
            si = 0;
            if (c.ch < 7 && this.repeat && !(c.flags & 1)) {
              this.songTicks = 0;
              c.dur = 0x30;
              c.gate = 0x2d;
              c.durCnt = 1;
              c.gateCnt = c.repCnt = 0;
              c.repStart = 0;
              si = c.loop;
            }
            break;
          default: // FA-FC: no operation
            break;
        }
        if (si === 0) return 0;
      }
    }
  }

  /** 0:0A3E: D0 marks the repeat start, Dn (n=1..15) repeats the section n more times. */
  private repeatCmd(c: Chan, op: number, si: number): number {
    const n = op & 0x0f;
    if (n === 0) {
      if (c.repStart === 0) c.repStart = si;
      return si;
    }
    const start = c.repStart;
    if (start === 0) return si;
    if (c.repCnt === 0) {
      c.repCnt = (n + 1) & 0xff;
      c.repExit = si;
    }
    c.repCnt = (c.repCnt - 1) & 0xff;
    if (c.repCnt !== 0) return start;
    c.repStart = 0;
    return si;
  }

  /** 0:0D31: note (0..0x5F) with key-on time `gate` (0 = rest). */
  private note(c: Chan, n: number, gate: number) {
    if (gate === 0) {
      c.note = 0xff;
      if (c.flags & 0x80) this.keyOff(c);
    } else {
      const sum = (n + s8(c.transpose) + s8(c.chTrans)) & 0xffff;
      const ss = s16(sum);
      const q = Math.trunc(ss / 12);
      let oct = q & 0xff;
      let semi = (ss - q * 12) & 0xff;
      let al: number;
      if (sum >> 8 === 0) {
        if (oct > 7) {
          oct = 7;
          al = (semi + 0x54) & 0xff;
        } else al = sum & 0xff;
      } else {
        oct = 0;
        if (semi !== 0) semi = (semi + 12) & 0xff;
        al = semi;
      }
      let retrigger = true;
      if (c.flags & 0x20) {
        if (al === c.note) retrigger = false; // tied to the same note: just continue
      } else if (c.flags & 0x80) this.keyOff(c);
      if (retrigger) {
        c.note = al;
        const ax = (FNUM[semi] | (((oct << 2) & 0xff) << 8)) & 0xffff;
        this.setFreq(c, ax);
        c.freq = ax;
        if (!(c.flags & 0x20)) this.keyOn(c);
        c.mod &= 0xbf;
      }
      if (c.flags & 2) c.mod |= 0x40;
    }
    c.durCnt = c.dur;
    c.gateCnt = c.gate;
    c.flags &= 0xdd;
    if (c.gate > c.dur) c.flags |= 0x20;
  }

  /** 0:0DD8: one music tick (tempo-driven). */
  private musicTick() {
    if (this.song) {
      const b = this.mus!;
      let any = 0;
      for (let i = 0; i < 7; i++) {
        this.chTick(this.c[i], b);
        any |= this.c[i].ptr;
      }
      this.songTicks = (this.songTicks + 1) & 0xffff;
      if (any) return;
      this.songEnd();
      if (this.song) return;
    }
    this.tempoInc = 0;
    this.tempo = 0;
  }

  /** 0:0E13: one tick of the SFX streams (channels 7 and 8). */
  private sfxStreamTick() {
    if (!this.sfxNo) return;
    const b = this.sfx!;
    let any = 0;
    for (let i = 7; i < 9; i++) {
      this.chTick(this.c[i], b);
      any |= this.c[i].ptr;
    }
    this.sfxTicks = (this.sfxTicks + 1) & 0xffff;
    if (!any) {
      this.sfxNo = 0;
      this.sfxTicks = 0;
    }
  }

  /** 0:10A0: fixed-rate tick (PIT_HZ * 0x36/256 ≈ 61.4 Hz): fade, SFX, bends, LFOs. */
  private sfxTick() {
    if (this.fadeSpeed) {
      let al = (this.fadeSub + 1) & 0xff;
      if (al >= 4) {
        if (this.fadeStep >= this.fadeSpeed) {
          this.stopMusic();
          this.songEnd();
          this.globalTicks = (this.globalTicks + 1) & 0xffff;
          return;
        }
        const bx = (this.fadeSpeed * this.fadeSpeed) & 0xffff;
        this.fadeStep = (this.fadeStep + 1) & 0xff;
        const r = Math.floor((this.fadeStep * this.fadeStep * 0xff) / bx);
        const a = r > 0xff ? 0xff : r & 0xff;
        if (a !== this.fadeAtt) {
          this.fadeAtt = a;
          for (let i = 0; i < 7; i++) this.volume(this.c[i], this.c[i].vol);
        }
        al = 0;
      }
      this.fadeSub = al;
    }
    this.sfxStreamTick();
    for (const c of this.c) {
      if (c.mod & 0x40) {
        let ax = this.bendStep(c);
        if (c.mod & 4) ax = -ax & 0xffff;
        ax = this.applyFreq(c, ax);
        if (c.lfoVal === 0x7fff) {
          c.freq = ax;
          c.mod &= 0xbf;
        }
      } else if (c.instBank) this.lfo(c);
    }
    this.globalTicks = (this.globalTicks + 1) & 0xffff;
  }

  /** 0:0E52: lfoVal += speed*dir unless that crosses the sign; returns [value, crossed]. */
  private step(c: Chan): [number, boolean] {
    const ax = (s16(c.lfoSpeed) * s16(c.lfoDir)) & 0xffff;
    const old = c.lfoVal;
    const nv = (old + ax) & 0xffff;
    if ((old ^ nv) & 0x8000) return [old, true];
    c.lfoVal = nv;
    return [nv, false];
  }

  /** 0:0E98: one-shot ramp to 0x7FFF. */
  private bendStep(c: Chan): number {
    if (c.lfoVal === 0x7fff) return 0x7fff;
    if (this.step(c)[1]) c.lfoVal = 0x7fff;
    return c.lfoVal;
  }

  /** 0:0F02: LFO waveform by instrument byte 0x0E. */
  private wave(c: Chan, b: Uint8Array): number {
    let kind = rd8(b, c.inst + 0x0e);
    if (kind > 4) kind = 0;
    let ax: number;
    switch (kind) {
      case 0: {
        // 0:0E6B saw
        const [v, crossed] = this.step(c);
        if (crossed) c.lfoVal = -c.lfoVal & 0xffff;
        ax = v;
        break;
      }
      case 1: {
        // 0:0EAD square
        const cx = Math.floor(0x7fff / c.lfoSpeed);
        const q = cx ? Math.floor(c.lfoCnt / cx) : 0;
        ax = q & 1 ? 0x8000 : 0x7fff;
        c.lfoVal = ax;
        break;
      }
      case 2: {
        // 0:0E74 triangle
        const cx = c.lfoDir;
        const add = (s16((c.lfoSpeed << 1) & 0xffff) * s16(cx)) & 0xffff;
        const old = c.lfoVal;
        let nv = (old + add) & 0xffff;
        if ((old ^ nv) & 0x8000 && (cx ^ nv) & 0x8000) {
          nv = old;
          c.lfoDir = -c.lfoDir & 0xffff;
        }
        c.lfoVal = nv;
        ax = nv;
        break;
      }
      case 3: {
        // 0:0ECE random
        const cx = Math.floor(0x7fff / c.lfoSpeed) | 1;
        ax = this.seed;
        if (s16(c.lfoCnt) % cx === 0) {
          ax = ((s16(this.seed) * 0x383) % 0x7fff) & 0xffff;
          this.seed = ax;
        }
        break;
      }
      default:
        ax = this.bendStep(c); // 0:0E98
    }
    return ax === 0x8000 ? 0x8001 : ax;
  }

  /** 0:0F29: block/F-number = base pitch moved by v/0x7FFF of lfoDepth (v signed). */
  private applyFreq(c: Chan, v: number): number {
    const fnum = c.freq & 0x3ff;
    let res: number;
    if (!(v & 0x8000)) {
      let a = Math.floor((fnum * v) / 0x7fff);
      a = Math.floor((a * c.lfoDepth) / 0x7fff);
      let bx = c.freq & 0x1c00;
      a = (a + fnum) & 0xffff;
      while (a > 0x3ff) {
        if (bx < 0x1c00) {
          bx += 0x400;
          a >>= 1;
        } else {
          bx = 0x1c00;
          a = 0x3ff;
        }
      }
      res = a | bx;
    } else {
      const d = Math.floor(((-v & 0xffff) * c.lfoDepth) / 0x7fff) & 0xffff;
      let prod = fnum * 0x7fff;
      let cx = d + 0x7fff;
      if (cx > 0xffff) {
        cx >>>= 1;
        prod >>>= 1;
      }
      res = (Math.floor(prod / cx) & 0xffff) | (c.freq & 0x1c00);
    }
    this.setFreq(c, res);
    return res;
  }

  /** 0:0FFC: instrument LFO (vibrato via bytes 0C-10, tremolo via 11-13, delay 14). */
  private lfo(c: Chan) {
    const b = c.instBank!;
    const p = c.inst;
    if (!(c.mod & 0x80)) {
      c.lfoCnt = (c.lfoCnt + 1) & 0xffff;
      return;
    }
    const keyed = (c.flags & 0xc0) !== 0;
    if (keyed) {
      if (c.relCnt) {
        c.relCnt--;
        if (c.relCnt === 0) this.silence(c);
      }
      c.lfoDepth = VIB_DEPTH[rd8(b, p + 0x10) & 0x0f];
      c.lfoSpeed = rd16(b, p + 0x0c);
    }
    if (!keyed || c.lfoSpeed === 0) {
      c.mod |= 3;
      c.lfoCnt = (c.lfoCnt + 1) & 0xffff;
      return;
    }
    let state = c.mod & 3;
    if (state === 0) {
      c.lfoCnt = (c.lfoCnt + 1) & 0xffff;
      return;
    }
    if (state === 1) {
      c.lfoCnt = (c.lfoCnt - 1) & 0xffff;
      if (c.lfoCnt !== 0) return;
      state = 0x107c;
    } else if (state === 3) {
      c.mod = (c.mod & 0xfc) | 1;
      const d = rd8(b, p + 0x14);
      if (d === 0) {
        if (rd8(b, p + 0x0e) === 4) state = 0x107c;
        else {
          c.lfoCnt = this.globalTicks;
          state = 0x1089;
        }
      } else if (d === 1) state = 0x107c;
      else {
        c.lfoCnt = (((d - 1) & 0xff) << 2) + 1;
        return;
      }
    }
    if (state === 0x107c) {
      c.lfoCnt = c.lfoVal = 0;
      c.lfoDir = 1;
    }
    if (state === 0x107c || state === 0x1089) c.mod = (c.mod & 0xfc) | 2;
    // 0:1091
    const w = this.wave(c, b);
    // 0:0F1C: scale by instrument byte 0x0F (signed, /127)
    this.applyFreq(c, Math.trunc((s8(rd8(b, p + 0x0f)) * s16(w)) / 0x7f) & 0xffff);
    this.tremolo(c, b, w);
    c.lfoCnt = (c.lfoCnt + 1) & 0xffff;
  }

  /** 0:0F91: tremolo from the LFO value. */
  private tremolo(c: Chan, b: Uint8Array, ax: number) {
    const p = c.inst;
    const kind = rd8(b, p + 0x0e);
    if (kind === 4) ax = (ax << 1) & 0xffff;
    else if (kind === 1) ax = ax & 0x8000 ? 0xffff : 0;
    else if (kind === 2) {
      if (ax & 0x8000) ax = -ax & 0xffff;
      ax = (ax << 1) & 0xffff;
    }
    const t = s8(rd8(b, p + 0x11));
    const depth = (t < 0 ? -t : t) & 0x7f;
    if (t < 0) ax = ~ax & 0xffff;
    const amt = Math.floor((ax * depth) / 0xfffe);
    for (let k = 0; k < 2; k++) {
      c.trem[k] = Math.floor((amt * (rd8(b, p + 0x12 + k) & 0x0f)) / 15) & 0xff;
      this.setTL(c, k, c.tlw[k]);
    }
  }
}

function rd8(b: Uint8Array, p: number): number {
  return b[p & 0xffff] ?? 0;
}

function rd16(b: Uint8Array, p: number): number {
  return rd8(b, p) | (rd8(b, p + 1) << 8);
}
