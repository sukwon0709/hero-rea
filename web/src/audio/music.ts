// Music containers (MUSIC.R3 / OPMUSIC.R3 / EDMUSIC.R3) and the SFX bank inside MAIN.EXE.
// See docs/SOUND.md for the format.

/**
 * `*.R3` music file: u16 count, count × {u32 offset, u16 size}, then the entries; offsets are
 * relative to the end of the table (MAIN 0CF5:5DD0 reads entry i at 2 + 6*count + offset).
 * Each entry is one SBOPL2 music bank holding one song.
 */
export function musicEntries(file: Uint8Array): Uint8Array[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const n = dv.getUint16(0, true);
  const base = 2 + 6 * n;
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(2 + 6 * i, true);
    const size = dv.getUint16(6 + 6 * i, true);
    if (base + off + size > file.length) throw new Error(`music entry ${i} out of range`);
    out.push(file.subarray(base + off, base + off + size));
  }
  return out;
}

/** A bank as SBOPL2 sees it: the segment contents and the offset passed in DX. */
export interface Bank {
  data: Uint8Array;
  offset: number;
}

/**
 * The SFX bank MAIN.EXE registers with int 66h AH=10h: `push 3021h; push 4; call 0CF5:5E90`
 * at MAIN 0CF5:5EE0, i.e. image segment 0x3021, offset 4. The returned buffer is the whole
 * segment (as the driver addresses it), with `offset` = 4.
 */
export function mainSfxBank(mainExe: Uint8Array): Bank {
  const hdr = (mainExe[8] | (mainExe[9] << 8)) * 16;
  const at = hdr + 0x0cf5 * 16 + 0x5ee0;
  const code = mainExe.subarray(at, at + 6);
  if (code[0] !== 0x68 || code[3] !== 0x68) throw new Error('MAIN.EXE: SFX bank reference not found');
  const seg = code[1] | (code[2] << 8);
  const offset = code[4] | (code[5] << 8);
  const start = hdr + seg * 16;
  return { data: mainExe.slice(start, Math.min(start + 0x10000, mainExe.length)), offset };
}

/** Number of SFX in MAIN's bank: entries are 4 bytes (two relative words), up to the first data. */
export function sfxCount(bank: Bank): number {
  const b = bank.data;
  let first = 0xffff;
  let n = 0;
  for (let p = bank.offset; p + 4 <= first && p + 4 <= b.length; p += 4, n++) {
    for (let k = 0; k < 2; k++) {
      const w = b[p + 2 * k] | (b[p + 2 * k + 1] << 8);
      if (w) first = Math.min(first, p + w);
    }
  }
  return n;
}

// ---------------------------------------------------------------- disassembly (docs / debugging)

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Lists the events of the track starting at `p` (until FF), one string per event. */
export function disassembleTrack(b: Uint8Array, p: number, max = 4000): string[] {
  const out: string[] = [];
  const rd = (q: number) => b[q] ?? 0;
  while (out.length < max) {
    const at = p;
    const op = rd(p++);
    let s: string;
    if (op <= 0xbf) {
      const n = op <= 0x5f ? op : op - 0x60;
      s = `${NOTE[n % 12]}${Math.floor(n / 12)}`;
      if (op <= 0x5f) {
        s += ` len=${rd(p)} gate=${rd(p + 1)}`;
        p += 2;
      }
    } else if (op < 0xd0) s = `nop ${op.toString(16)}`;
    else if (op === 0xd0) s = 'repeat-start';
    else if (op < 0xe0) s = `repeat x${(op & 15) + 1}`;
    else {
      const a = rd(p);
      const w = rd(p) | (rd(p + 1) << 8);
      switch (op) {
        case 0xee: s = `am-depth ${a}`; p++; break;
        case 0xef: s = `vib-depth ${a}`; p++; break;
        case 0xf0: s = `volume ${a}`; p++; break;
        case 0xf1: s = `tempo-timer ${a}`; p++; break;
        case 0xf2: s = `tempo ${a}`; p++; break;
        case 0xf4: s = `instrument @${((at + w) & 0xffff).toString(16)}`; p += 2; break;
        case 0xf5: s = `skip2 ${w.toString(16)}`; p += 2; break;
        case 0xf6: s = `bend ${(a << 24) >> 24} over ${rd(p + 1)} (tempo units)`; p += 2; break;
        case 0xf7: s = `bend ${(a << 24) >> 24} over ${rd(p + 1) + 1} ticks`; p += 2; break;
        case 0xf8: s = 'lfo-on'; break;
        case 0xf9: s = 'lfo-off'; break;
        case 0xfd: s = 'repeat-break'; break;
        case 0xfe: s = 'loop-point'; break;
        case 0xff: s = 'end'; break;
        default:
          if (op < 0xee || op === 0xf3) {
            s = `skip1 ${op.toString(16)} ${a}`;
            p++;
          } else s = `nop ${op.toString(16)}`;
      }
    }
    out.push(`${at.toString(16).padStart(4, '0')}: ${s}`);
    if (op === 0xff) break;
  }
  return out;
}

// ---------------------------------------------------------------- names shown by MAIN's sound test

/** Reads a table of `n` far pointers (seg:off into the image) to NUL-terminated EUC-KR strings. */
function farStrings(exe: Uint8Array, tableSeg: number, tableOff: number, n: number): string[] {
  const hdr = (exe[8] | (exe[9] << 8)) * 16;
  const dec = new TextDecoder('euc-kr');
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = hdr + tableSeg * 16 + tableOff + 4 * i;
    const off = exe[p] | (exe[p + 1] << 8);
    const seg = exe[p + 2] | (exe[p + 3] << 8);
    let q = hdr + seg * 16 + off;
    const start = q;
    while (q < exe.length && exe[q] !== 0) q++;
    out.push(dec.decode(exe.subarray(start, q)));
  }
  return out;
}

const MAIN_DS = 0x313a;

/** Titles of the 20 MUSIC.R3 songs from the "음악을 즐긴다" music test (MAIN 0CF5:F208, table DS:312E). */
export function songTitles(mainExe: Uint8Array): string[] {
  return farStrings(mainExe, MAIN_DS, 0x312e, 20);
}

/** Names of the 43 effects of the "효과음을 즐긴다" sound test (table DS:3364); index = MAIN's SFX number. */
export function sfxNames(mainExe: Uint8Array): string[] {
  return farStrings(mainExe, MAIN_DS, 0x3364, 43);
}
