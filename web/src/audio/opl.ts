// YM3812 (OPL2) emulator, written for this project from the chip's documented behaviour:
// log-sine / exponent ROM synthesis (tables generated from their defining formulas), the
// 4-state envelope generator with its rate/increment patterns, vibrato/tremolo LFOs, key scaling,
// feedback and the two connection modes. Rhythm mode and the timers are not emulated (SBOPL2
// never enables them: it only writes BD bits 7/6, see docs/SOUND.md).
//
// Output is produced at the chip's native rate (3.579545 MHz / 72 ≈ 49716 Hz).

export const OPL_RATE = 3579545 / 72;

const MULT2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]; // 2 × multiplier
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0]; // KSL 0, 3, 1.5, 6 dB/oct
/** Envelope increments per rate&3, indexed by the low 3 bits of the step counter. */
const EG_PATTERN = [
  [0, 1, 0, 1, 0, 1, 0, 1],
  [0, 1, 0, 1, 1, 1, 0, 1],
  [0, 1, 1, 1, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 1],
];
/** Register offset (0x00-0x15) → operator slot (0-17), -1 for unused offsets. */
const SLOT_OF = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17];

const LOGSIN = new Uint16Array(256);
const EXP = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  LOGSIN[i] = Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256);
  EXP[i] = Math.round(Math.pow(2, (255 - i) / 256) * 1024);
}

/** Attenuation (log2 units × 256) → linear amplitude 0..4084. */
function expOut(level: number): number {
  if (level > 0x1fff) level = 0x1fff;
  return (EXP[level & 0xff] << 1) >> (level >> 8);
}

/** Signed operator output for waveform ws at 10-bit phase, attenuation env (0..511). */
function waveOut(ws: number, phase: number, env: number): number {
  phase &= 0x3ff;
  const att = env << 3;
  let l: number;
  switch (ws) {
    case 1: // half sine
      if (phase & 0x200) return 0;
      l = phase & 0x100 ? LOGSIN[(phase & 0xff) ^ 0xff] : LOGSIN[phase & 0xff];
      return expOut(l + att);
    case 2: // abs sine
      l = phase & 0x100 ? LOGSIN[(phase & 0xff) ^ 0xff] : LOGSIN[phase & 0xff];
      return expOut(l + att);
    case 3: // quarter sine pulses
      if (phase & 0x100) return 0;
      return expOut(LOGSIN[phase & 0xff] + att);
    default: {
      l = phase & 0x100 ? LOGSIN[(phase & 0xff) ^ 0xff] : LOGSIN[phase & 0xff];
      const v = expOut(l + att);
      return phase & 0x200 ? ~v : v;
    }
  }
}

const ATTACK = 0;
const DECAY = 1;
const SUSTAIN = 2;
const RELEASE = 3;

class Slot {
  // register fields
  am = false;
  vib = false;
  egt = false;
  ksr = false;
  mult = 0;
  ksl = 0;
  tl = 0;
  ar = 0;
  dr = 0;
  sl = 0;
  rr = 0;
  ws = 0;
  // state
  phase = 0; // 19-bit accumulator
  level = 0x1ff; // envelope attenuation 0..511
  state = RELEASE;
  key = false;
  out = 0;
  prev = 0;
}

class Channel {
  fnum = 0;
  block = 0;
  key = false;
  fb = 0;
  cnt = 0;
  constructor(
    readonly a: Slot,
    readonly b: Slot,
  ) {}
}

export class Opl2 {
  private readonly slots: Slot[] = Array.from({ length: 18 }, () => new Slot());
  private readonly ch: Channel[] = [];
  private wse = false;
  private nts = 0;
  private dam = false;
  private dvb = false;
  private egCnt = 0;
  private sampleCnt = 0;
  private tremPos = 0;
  private vibPos = 0;

  constructor() {
    for (let c = 0; c < 9; c++) {
      const s = Math.floor(c / 3) * 6 + (c % 3);
      this.ch.push(new Channel(this.slots[s], this.slots[s + 3]));
    }
  }

  write(reg: number, val: number) {
    reg &= 0xff;
    val &= 0xff;
    const hi = reg & 0xe0;
    if (reg === 0x01) this.wse = (val & 0x20) !== 0;
    else if (reg === 0x08) this.nts = (val >> 6) & 1;
    else if (reg === 0xbd) {
      this.dam = (val & 0x80) !== 0;
      this.dvb = (val & 0x40) !== 0;
    } else if (hi >= 0x20 && hi <= 0x80 && (reg & 0x1f) < 0x16) {
      const s = SLOT_OF[reg & 0x1f];
      if (s < 0) return;
      const o = this.slots[s];
      switch (hi) {
        case 0x20:
          o.am = (val & 0x80) !== 0;
          o.vib = (val & 0x40) !== 0;
          o.egt = (val & 0x20) !== 0;
          o.ksr = (val & 0x10) !== 0;
          o.mult = val & 0x0f;
          break;
        case 0x40:
          o.ksl = val >> 6;
          o.tl = val & 0x3f;
          break;
        case 0x60:
          o.ar = val >> 4;
          o.dr = val & 0x0f;
          break;
        case 0x80:
          o.sl = val >> 4;
          o.rr = val & 0x0f;
          break;
      }
    } else if (hi === 0xe0 && (reg & 0x1f) < 0x16) {
      const s = SLOT_OF[reg & 0x1f];
      if (s >= 0) this.slots[s].ws = this.wse ? val & 3 : 0;
    } else if (reg >= 0xa0 && reg <= 0xa8) {
      const c = this.ch[reg - 0xa0];
      c.fnum = (c.fnum & 0x300) | val;
    } else if (reg >= 0xb0 && reg <= 0xb8) {
      const c = this.ch[reg - 0xb0];
      c.fnum = (c.fnum & 0xff) | ((val & 3) << 8);
      c.block = (val >> 2) & 7;
      const key = (val & 0x20) !== 0;
      if (key !== c.key) {
        c.key = key;
        for (const o of [c.a, c.b]) {
          if (key) {
            o.phase = 0;
            o.state = ATTACK;
          } else o.state = RELEASE;
          o.key = key;
        }
      }
    } else if (reg >= 0xc0 && reg <= 0xc8) {
      const c = this.ch[reg - 0xc0];
      c.fb = (val >> 1) & 7;
      c.cnt = val & 1;
    }
  }

  private envStep(o: Slot, c: Channel) {
    let r: number;
    switch (o.state) {
      case ATTACK:
        r = o.ar;
        break;
      case DECAY:
        r = o.dr;
        break;
      case SUSTAIN:
        if (o.egt) return;
        r = o.rr;
        break;
      default:
        r = o.rr;
    }
    if (o.state === DECAY && o.level >= (o.sl === 15 ? 0x1f0 : o.sl << 4)) {
      o.state = SUSTAIN;
      return;
    }
    if (r === 0) return;
    const ksv = (c.block << 1) | ((c.fnum >> (9 - this.nts)) & 1);
    let rate = 4 * r + (o.ksr ? ksv : ksv >> 2);
    if (rate > 63) rate = 63;
    const rhi = rate >> 2;
    const pat = EG_PATTERN[rate & 3];
    let inc: number;
    if (rhi < 12) {
      const sh = 12 - rhi;
      if (this.egCnt & ((1 << sh) - 1)) return;
      inc = pat[(this.egCnt >> sh) & 7];
    } else inc = pat[this.egCnt & 7] << (rhi - 12);
    if (o.state === ATTACK) {
      if (rhi === 15) o.level = 0;
      else if (inc) o.level += (~o.level * inc) >> 3;
      if (o.level <= 0) {
        o.level = 0;
        o.state = DECAY;
      }
    } else {
      o.level += inc;
      if (o.level > 0x1ff) o.level = 0x1ff;
    }
  }

  private opOut(o: Slot, c: Channel, mod: number, trem: number, vibFnum: number): number {
    // envelope
    const kslv = Math.max(0, (KSL_ROM[c.fnum >> 6] << 2) - ((8 - c.block) << 5));
    let env = o.level + (o.tl << 2) + (kslv >> KSL_SHIFT[o.ksl]) + (o.am ? trem : 0);
    if (env > 0x1ff) env = 0x1ff;
    // phase
    const fnum = o.vib ? vibFnum : c.fnum;
    const base = (fnum << c.block) >> 1;
    const ph = o.phase >> 9;
    o.phase = (o.phase + ((base * MULT2[o.mult]) >> 1)) & 0x7ffff;
    return waveOut(o.ws, ph + mod, env);
  }

  /** Renders n samples (mono, -1..1) at OPL_RATE into out[offset..]. */
  render(out: Float32Array, n: number, offset = 0) {
    for (let i = 0; i < n; i++) {
      // LFOs
      if ((this.sampleCnt & 63) === 0) this.tremPos = (this.tremPos + 1) % 210;
      if ((this.sampleCnt & 1023) === 0) this.vibPos = (this.vibPos + 1) & 7;
      this.sampleCnt = (this.sampleCnt + 1) >>> 0;
      const trem = (this.tremPos < 105 ? this.tremPos : 210 - this.tremPos) >> (this.dam ? 2 : 4);
      this.egCnt = (this.egCnt + 1) & 0xfffffff;
      let mix = 0;
      for (const c of this.ch) {
        const a = c.a;
        const b = c.b;
        this.envStep(a, c);
        this.envStep(b, c);
        if (a.level >= 0x1ff && b.level >= 0x1ff && a.state === RELEASE && b.state === RELEASE) {
          a.prev = a.out = 0;
          continue;
        }
        let range = (c.fnum >> 7) & 7;
        if ((this.vibPos & 3) === 0) range = 0;
        else if (this.vibPos & 1) range >>= 1;
        if (!this.dvb) range >>= 1;
        const vibFnum = (c.fnum + (this.vibPos & 4 ? -range : range)) & 0x3ff;
        const fbmod = c.fb ? (a.prev + a.out) >> (9 - c.fb) : 0;
        a.prev = a.out;
        a.out = this.opOut(a, c, fbmod, trem, vibFnum);
        if (c.cnt) mix += a.out + this.opOut(b, c, 0, trem, vibFnum);
        else mix += this.opOut(b, c, a.out, trem, vibFnum);
      }
      out[offset + i] = mix / 32768;
    }
  }
}
