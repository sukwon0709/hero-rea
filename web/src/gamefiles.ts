// Loads the original game data (GAME folder) supplied by the player and caches it in IndexedDB.
// Game data is never bundled with this site: the player provides their own copy once.
import { unzipSync, zipSync } from 'fflate';

export type GameFiles = Map<string, Uint8Array>; // key: upper-case file name, e.g. "MAIN.EXE"

const DB = 'hero-rea';
const STORE = 'files';
// The game data and the save slots are stored as two records. The game data is written once, when the
// player loads Hero.zip; the saves are rewritten whenever the game saves. Loading Hero.zip again (on a new
// browser profile, after "Forget game files", or after the browser evicted the data) therefore never
// replaces the saves made in this browser with the old ones inside the zip.
const GAME_KEY = 'game';
const SAVES_KEY = 'saves';

// Files that must be present for the data to count as a valid copy of the game.
export const REQUIRED = ['HERO.COM', 'MAIN.EXE', 'OPEN.EXE', 'GRPDRV.EXE', 'TFDED.COM', 'SNR0D.R3'];

/** Save files the game writes: MSAVEn.R3S / ESAVEn.R3S slots, plus MSAVE.R3 and the MSAVEn.R3M variants. */
export const SAVE_FILE = /^(MSAVE\d?|ESAVE\d)\.R3[SM]$|^MSAVE\.R3$/;

export const isSaveFile = (name: string) => SAVE_FILE.test(name);

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getRecord(db: IDBDatabase, key: string): Promise<Record<string, Uint8Array> | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putRecord(db: IDBDatabase, key: string, value: Record<string, Uint8Array>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function savesOf(files: GameFiles): Record<string, Uint8Array> {
  return Object.fromEntries([...files].filter(([name]) => isSaveFile(name)));
}

/** The game files stored in this browser with the stored saves on top, or null when no game is stored. */
export async function loadCached(): Promise<GameFiles | null> {
  try {
    const db = await openDb();
    const game = await getRecord(db, GAME_KEY);
    if (!game) return null;
    const files: GameFiles = new Map(Object.entries(game));
    const saves = await getRecord(db, SAVES_KEY);
    if (saves) for (const [name, data] of Object.entries(saves)) files.set(name, data);
    // Caches written before saves had their own record kept them inside the game record: move them out.
    else await putRecord(db, SAVES_KEY, savesOf(files)).catch(() => undefined);
    return files;
  } catch {
    return null;
  }
}

/** Asks the browser not to evict this site's storage when space runs low (and, in Safari, after 7 days). */
async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

/**
 * Stores a freshly loaded copy of the game. Saves already stored in this browser win over the ones in the
 * zip (they are copied into `files`); slots only the zip has are kept. Resolves to false when storing failed.
 */
export async function storeGame(files: GameFiles): Promise<boolean> {
  try {
    const db = await openDb();
    const saves = await getRecord(db, SAVES_KEY);
    if (saves) for (const [name, data] of Object.entries(saves)) files.set(name, data);
    await putRecord(db, GAME_KEY, Object.fromEntries([...files].filter(([name]) => !isSaveFile(name))));
    await putRecord(db, SAVES_KEY, savesOf(files));
    await requestPersistence();
    return true;
  } catch (e) {
    console.warn('hero-rea: could not store game files in IndexedDB', e);
    return false;
  }
}

/**
 * Stores the save files of `files` in IndexedDB (the game data itself is stored once by storeGame).
 * Resolves to false when that failed (the files stay usable for this session).
 */
export async function saveCached(files: GameFiles): Promise<boolean> {
  try {
    await putRecord(await openDb(), SAVES_KEY, savesOf(files));
    return true;
  } catch (e) {
    // storage unavailable (private window etc.): the game still runs for this session
    console.warn('hero-rea: could not store saves in IndexedDB', e);
    return false;
  }
}

/** Forgets the stored game files. The saves stay, so loading Hero.zip again brings them back. */
export async function clearCached(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(GAME_KEY);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/** A zip of every stored save file, for moving saves to another browser or device. */
export function exportSaves(files: GameFiles): Uint8Array {
  return zipSync(savesOf(files));
}

/**
 * Restores save files from a zip made by exportSaves (or loose MSAVE/ESAVE files) into `files` and stores
 * them. Returns the names restored.
 */
export async function importSaves(files: GameFiles, list: FileList | File[]): Promise<string[]> {
  const found: [string, Uint8Array][] = [];
  for (const f of Array.from(list)) {
    const data = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      for (const [p, d] of Object.entries(unzipSync(data))) found.push([p.split('/').pop()!.toUpperCase(), d]);
    } else found.push([f.name.toUpperCase(), data]);
  }
  const names = found.filter(([n]) => isSaveFile(n)).map(([n, d]) => (files.set(n, d), n));
  if (!names.length) throw new Error('No MSAVE/ESAVE files found.');
  if (!(await saveCached(files))) throw new Error('Could not store the saves in this browser.');
  return names;
}

// Picks the directory that contains HERO.COM out of a flat list of (path, bytes).
function pickGameDir(entries: [string, Uint8Array][]): GameFiles {
  const norm = entries.map(([p, d]) => [p.replace(/\\/g, '/'), d] as [string, Uint8Array]);
  const hero = norm.find(([p]) => p.split('/').pop()!.toUpperCase() === 'HERO.COM');
  if (!hero) throw new Error('HERO.COM was not found. Choose Hero.zip or the GAME folder.');
  const dir = hero[0].slice(0, hero[0].length - 'HERO.COM'.length);
  const files: GameFiles = new Map();
  for (const [p, d] of norm) {
    if (!p.startsWith(dir)) continue;
    const rest = p.slice(dir.length);
    if (!rest || rest.includes('/')) continue;
    files.set(rest.toUpperCase(), d);
  }
  const missing = REQUIRED.filter((f) => !files.has(f));
  if (missing.length) throw new Error(`Missing game files: ${missing.join(', ')}`);
  return files;
}

export async function fromZip(file: Blob): Promise<GameFiles> {
  const data = new Uint8Array(await file.arrayBuffer());
  const un = unzipSync(data);
  return pickGameDir(Object.entries(un).filter(([p]) => !p.endsWith('/')));
}

export async function fromFileList(list: FileList | File[]): Promise<GameFiles> {
  const arr = Array.from(list);
  if (arr.length === 1 && /\.zip$/i.test(arr[0].name)) return fromZip(arr[0]);
  const entries: [string, Uint8Array][] = [];
  for (const f of arr) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    entries.push([path, new Uint8Array(await f.arrayBuffer())]);
  }
  return pickGameDir(entries);
}

// Wires a drop zone + file inputs; resolves once valid game files were provided.
export function promptForFiles(root: HTMLElement): Promise<GameFiles> {
  return new Promise((resolve) => {
    const zipInput = root.querySelector<HTMLInputElement>('input[data-kind=zip]')!;
    const dirInput = root.querySelector<HTMLInputElement>('input[data-kind=dir]')!;
    const err = root.querySelector<HTMLElement>('.error')!;
    const handle = async (list: FileList | File[]) => {
      err.textContent = '';
      try {
        const files = await fromFileList(list);
        await storeGame(files);
        resolve(files);
      } catch (e) {
        err.textContent = (e as Error).message;
      }
    };
    zipInput.onchange = () => zipInput.files && handle(zipInput.files);
    dirInput.onchange = () => dirInput.files && handle(dirInput.files);
    root.ondragover = (e) => {
      e.preventDefault();
      root.classList.add('drag');
    };
    root.ondragleave = () => root.classList.remove('drag');
    root.ondrop = (e) => {
      e.preventDefault();
      root.classList.remove('drag');
      if (e.dataTransfer?.files.length) handle(e.dataTransfer.files);
    };
  });
}

export async function getGameFiles(root: HTMLElement): Promise<GameFiles> {
  const cached = await loadCached();
  if (cached && REQUIRED.every((f) => cached.has(f))) {
    void requestPersistence();
    return cached;
  }
  root.hidden = false;
  const files = await promptForFiles(root);
  root.hidden = true;
  return files;
}
