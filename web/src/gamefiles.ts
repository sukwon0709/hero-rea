// Loads the original game data (GAME folder) supplied by the player and caches it in IndexedDB.
// Game data is never bundled with this site: the player provides their own copy once.
import { unzipSync } from 'fflate';

export type GameFiles = Map<string, Uint8Array>; // key: upper-case file name, e.g. "MAIN.EXE"

const DB = 'hero-rea';
const STORE = 'files';
const KEY = 'game';

// Files that must be present for the data to count as a valid copy of the game.
export const REQUIRED = ['HERO.COM', 'MAIN.EXE', 'OPEN.EXE', 'GRPDRV.EXE', 'TFDED.COM', 'SNR0D.R3'];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadCached(): Promise<GameFiles | null> {
  try {
    const db = await openDb();
    const obj = await new Promise<Record<string, Uint8Array> | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return obj ? new Map(Object.entries(obj)) : null;
  } catch {
    return null;
  }
}

/** Stores the files in IndexedDB. Resolves to false when that failed (the files stay usable for this session). */
export async function saveCached(files: GameFiles): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(Object.fromEntries(files), KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    // storage unavailable (private window etc.): the game still runs for this session
    console.warn('hero-rea: could not store game files in IndexedDB', e);
    return false;
  }
}

export async function clearCached(): Promise<void> {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY);
  } catch {
    /* ignore */
  }
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
        await saveCached(files);
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
  if (cached && REQUIRED.every((f) => cached.has(f))) return cached;
  root.hidden = false;
  const files = await promptForFiles(root);
  root.hidden = true;
  return files;
}
