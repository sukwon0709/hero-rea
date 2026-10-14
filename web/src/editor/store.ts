// Where the editor reads and writes saves. Classic mode (play.ts) and Native mode (native/saves.ts) both
// keep MSAVEn.R3S / ESAVEn.R3S inside the one IndexedDB copy of the game folder (gamefiles.ts), so a
// slot written here is what both modes load. Uploaded files are edited in memory and downloaded.

import { strToU8, unzipSync, zipSync } from 'fflate';
import { saveCached, type GameFiles } from '../gamefiles';
import { ESAVE_SIZE, MSAVE_SIZE, SAVE_SLOTS, decodeSaveTime, esaveName, formatSaveTime, msaveName, parseMSave, saveTitle } from '../formats/save';

export interface SlotInfo {
  slot: number;
  empty: boolean;
  title: string;
  time: string;
}

/** The slot list as the game shows it (an all-zero timestamp is an empty slot, 0cf5:b576). */
export function listSlots(files: GameFiles): SlotInfo[] {
  const out: SlotInfo[] = [];
  for (let slot = 0; slot < SAVE_SLOTS; slot++) {
    const m = files.get(msaveName(slot));
    const t = m && m.length === MSAVE_SIZE ? decodeSaveTime(m.subarray(0, 5)) : null;
    if (!m || !t) out.push({ slot, empty: true, title: '', time: '' });
    else out.push({ slot, empty: false, title: saveTitle(parseMSave(m)), time: formatSaveTime(t) });
  }
  return out;
}

/** Writes a slot back into the shared store. `esave` is written only when given. */
export async function writeSlot(files: GameFiles, slot: number, msave: Uint8Array, esave?: Uint8Array | null): Promise<void> {
  files.set(msaveName(slot), msave);
  if (esave) files.set(esaveName(slot), esave);
  await saveCached(files);
}

export interface Upload {
  /** File name of the MSAVE as uploaded (MSAVEn.R3S normally). */
  name: string;
  msave: Uint8Array;
  esave: Uint8Array | null;
  /** Slot digit taken from the file name, or null. */
  slot: number | null;
}

/** Reads uploaded save files: loose MSAVEn.R3S (+ ESAVEn.R3S) or a zip holding them. */
export function readUpload(list: { name: string; data: Uint8Array }[]): Upload {
  const flat: { name: string; data: Uint8Array }[] = [];
  for (const f of list) {
    if (/\.zip$/i.test(f.name)) {
      for (const [n, d] of Object.entries(unzipSync(f.data))) if (!n.endsWith('/')) flat.push({ name: n.split('/').pop()!, data: d });
    } else flat.push(f);
  }
  const m = flat.find((f) => f.data.length === MSAVE_SIZE && (/^MSAVE/i.test(f.name) || !/^ESAVE/i.test(f.name)));
  if (!m) throw new Error(`MSAVE 파일이 없습니다 (${MSAVE_SIZE} bytes, MSAVEn.R3S).`);
  const digit = /(\d)\.R3S$/i.exec(m.name);
  const slot = digit ? +digit[1] : null;
  const e =
    flat.find((f) => f.data.length === ESAVE_SIZE && slot !== null && f.name.toUpperCase() === esaveName(slot)) ??
    flat.find((f) => f.data.length === ESAVE_SIZE && /^ESAVE/i.test(f.name));
  return { name: m.name, msave: m.data, esave: e?.data ?? null, slot: slot !== null && slot < SAVE_SLOTS ? slot : null };
}

/** A zip with MSAVEn.R3S and (when known) ESAVEn.R3S, in the original format. */
export function slotZip(slot: number, msave: Uint8Array, esave: Uint8Array | null): Uint8Array {
  const entries: Record<string, Uint8Array> = { [msaveName(slot)]: msave };
  if (esave) entries[esaveName(slot)] = esave;
  entries['README.TXT'] = strToU8('Hero (Samgukji Yeonggeoljeon) save slot, original MSAVE/ESAVE format. Copy both files into the GAME folder.\r\n');
  return zipSync(entries);
}

export function download(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
