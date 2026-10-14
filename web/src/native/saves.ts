// Save slots in the original byte format (MSAVEn.R3S + ESAVEn.R3S, formats/save.ts), kept in the same
// IndexedDB copy of the game folder that Classic mode uses (gamefiles.ts), so saves are shared between
// the two modes. Slots can be exported as a zip of the two files and imported again.

import { strToU8, unzipSync, zipSync } from 'fflate';
import { saveCached, type GameFiles } from '../gamefiles';
import {
  ESAVE_SIZE,
  MSAVE_SIZE,
  SAVE_SLOTS,
  decodeSaveTime,
  esaveName,
  formatSaveTime,
  msaveName,
  parseESave,
  parseMSave,
  saveTitle,
  type ESave,
  type MSave,
} from '../formats/save';

export interface SlotInfo {
  slot: number;
  empty: boolean;
  title: string;
  time: string;
}

export class SaveStore {
  constructor(readonly files: GameFiles) {}

  /** The save list of 0cf5:b938 (an all-zero timestamp is an empty slot, 0cf5:b576). */
  list(): SlotInfo[] {
    const out: SlotInfo[] = [];
    for (let slot = 0; slot < SAVE_SLOTS; slot++) {
      const m = this.files.get(msaveName(slot));
      if (!m || m.length !== MSAVE_SIZE) {
        out.push({ slot, empty: true, title: '', time: '' });
        continue;
      }
      const t = decodeSaveTime(m.subarray(0, 5));
      if (!t) {
        out.push({ slot, empty: true, title: '', time: '' });
        continue;
      }
      const h = parseMSave(m);
      out.push({ slot, empty: false, title: saveTitle(h), time: formatSaveTime(t) });
    }
    return out;
  }

  read(slot: number): { msave: MSave; esave: ESave | null; esaveBytes: Uint8Array | null } | null {
    const m = this.files.get(msaveName(slot));
    if (!m || m.length !== MSAVE_SIZE || !decodeSaveTime(m.subarray(0, 5))) return null;
    const e = this.files.get(esaveName(slot));
    const ok = e && e.length === ESAVE_SIZE;
    return { msave: parseMSave(m), esave: ok ? parseESave(e) : null, esaveBytes: ok ? e : null };
  }

  async write(slot: number, msave: Uint8Array, esave: Uint8Array) {
    this.files.set(msaveName(slot), msave);
    this.files.set(esaveName(slot), esave);
    await saveCached(this.files);
  }

  /** A zip holding MSAVEn.R3S and ESAVEn.R3S of a slot. */
  exportSlot(slot: number): Uint8Array | null {
    const m = this.files.get(msaveName(slot));
    const e = this.files.get(esaveName(slot));
    if (!m) return null;
    const entries: Record<string, Uint8Array> = { [msaveName(slot)]: m };
    if (e) entries[esaveName(slot)] = e;
    entries['README.TXT'] = strToU8('Hero (Samgukji Yeonggeoljeon) save slot, original MSAVE/ESAVE format.\r\n');
    return zipSync(entries);
  }

  /**
   * Imports save files: a zip or loose MSAVEn.R3S / ESAVEn.R3S files. `slot` overrides the slot digit in
   * the names (the pair goes to that slot). Returns the slots written.
   */
  async importFiles(list: { name: string; data: Uint8Array }[], slot?: number): Promise<number[]> {
    const flat: { name: string; data: Uint8Array }[] = [];
    for (const f of list) {
      if (/\.zip$/i.test(f.name)) {
        for (const [n, d] of Object.entries(unzipSync(f.data))) flat.push({ name: n.split('/').pop()!, data: d });
      } else flat.push(f);
    }
    const written = new Set<number>();
    for (const f of flat) {
      const m = /^([ME])SAVE(\d)\.R3S$/i.exec(f.name);
      if (!m) continue;
      const kind = m[1].toUpperCase();
      const s = slot ?? +m[2];
      if (s < 0 || s >= SAVE_SLOTS) continue;
      if (kind === 'M' && f.data.length !== MSAVE_SIZE) throw new Error(`${f.name}: ${f.data.length} bytes, expected ${MSAVE_SIZE}`);
      if (kind === 'E' && f.data.length !== ESAVE_SIZE) throw new Error(`${f.name}: ${f.data.length} bytes, expected ${ESAVE_SIZE}`);
      this.files.set(kind === 'M' ? msaveName(s) : esaveName(s), f.data);
      written.add(s);
    }
    if (written.size) await saveCached(this.files);
    return [...written].sort();
  }
}
