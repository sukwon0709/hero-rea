// "Classic" mode: runs the original DOS executables inside js-dos (DOSBox compiled to WebAssembly).
import { getGameFiles, saveCached, clearCached, exportSaves, importSaves, isSaveFile, GameFiles } from './gamefiles';
import { ESAVE_SIZE, MSAVE_SIZE } from './formats/save';

declare global {
  interface Window {
    Dos: (el: HTMLElement, opts: Record<string, unknown>) => unknown;
  }
}

interface CommandInterface {
  fsReadFile(file: string): Promise<Uint8Array>;
}

// Mirrors the dosbox.conf shipped with the original DOSBox package (svga_s3, sb16, fixed cycles).
const DOSBOX_CONF = `
[sdl]
autolock=false
[dosbox]
machine=svga_s3
memsize=16
[cpu]
core=normal
cputype=auto
cycles=fixed 10000
[mixer]
rate=44100
[sblaster]
sbtype=sb16
sbbase=220
irq=7
dma=1
hdma=5
oplmode=auto
[dos]
xms=true
ems=true
umb=true
[autoexec]
mount c .
c:
HERO.COM
`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// fsReadFile never settles when the file is missing, so a read that hangs must not block the others.
function readWithTimeout(ci: CommandInterface, name: string, ms = 3000): Promise<Uint8Array | null> {
  return Promise.race([
    ci.fsReadFile(name).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

let persisting = false;
// Set while restoring saves from a backup, so the poll does not copy the emulator's older saves back.
let stopped = false;
// Save files the emulator has changed that are not in IndexedDB yet (read, but the write is still on its
// way or failed). Closing the page now would lose them.
const pending = new Set<string>();

// Sizes of the slot files; a slot file of any other length is one the game is still writing.
const SLOT_SIZE: Record<string, number> = { M: MSAVE_SIZE, E: ESAVE_SIZE };
const complete = (name: string, data: Uint8Array) => {
  const m = /^([ME])SAVE\d\.R3S$/.exec(name);
  return !m || data.length === SLOT_SIZE[m[1]];
};
const same = (a: Uint8Array, b: Uint8Array | undefined) => !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** Copies the save files the game changed into IndexedDB (only those files, see saveCached). */
async function persistSaves(ci: CommandInterface, files: GameFiles) {
  if (persisting || stopped) return;
  persisting = true;
  try {
    const changed = new Map<string, Uint8Array>();
    for (const name of [...files.keys()]) {
      if (!isSaveFile(name)) continue;
      const data = await readWithTimeout(ci, name);
      if (!data) continue;
      if (same(data, files.get(name))) {
        pending.delete(name);
        continue;
      }
      pending.add(name);
      if (complete(name, data)) changed.set(name, data);
    }
    if (!changed.size) return;
    const previous = new Map<string, Uint8Array>();
    for (const [name, data] of changed) {
      previous.set(name, files.get(name)!);
      files.set(name, data);
    }
    if (await saveCached(files, changed.keys())) for (const name of changed.keys()) pending.delete(name);
    // On failure put the old bytes back so the next poll sees the change again and retries.
    else for (const [name, old] of previous) files.set(name, old);
  } finally {
    persisting = false;
  }
}

// The Korean release asks for a manual code at startup ("INPUT CODE [火地金]").
// MAIN.EXE picks r = rand() % 1000, shows its three decimal digits as characters from
// DIGITS (hundreds, tens, ones) and expects the decimal value of a 1000-entry word table.
// The table sits at image offset 0xA997 of MAIN.EXE (see docs/ENGINE.md, "Copy protection").
const DIGITS = '金木水火土日月天地人';

function codeTable(main: Uint8Array): Uint16Array | null {
  const hdr = (main[8] | (main[9] << 8)) * 16;
  const off = hdr + 0xa997;
  if (off + 2000 > main.length) return null;
  const t = new Uint16Array(1000);
  for (let i = 0; i < 1000; i++) t[i] = main[off + 2 * i] | (main[off + 2 * i + 1] << 8);
  return t;
}

function setupCodeHelper(files: GameFiles) {
  const panel = document.getElementById('codehelp')!;
  const table = codeTable(files.get('MAIN.EXE')!);
  if (!table) return;
  const picked: number[] = [];
  const shown = panel.querySelector<HTMLElement>('.picked')!;
  const result = panel.querySelector<HTMLElement>('.code')!;
  const keys = panel.querySelector<HTMLElement>('.keys')!;
  const render = () => {
    shown.textContent = picked.map((d) => DIGITS[d]).join('') || '···';
    result.textContent = picked.length === 3 ? String(table[picked[0] * 100 + picked[1] * 10 + picked[2]]) : '';
  };
  [...DIGITS].forEach((ch, d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ch;
    b.onclick = () => {
      if (picked.length === 3) picked.length = 0;
      picked.push(d);
      render();
    };
    keys.appendChild(b);
  });
  panel.querySelector<HTMLButtonElement>('.reset')!.onclick = () => {
    picked.length = 0;
    render();
  };
  panel.hidden = false;
  render();
}

async function main() {
  const picker = document.getElementById('picker')!;
  const files = await getGameFiles(picker);

  const base = import.meta.env.BASE_URL;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${base}js-dos/js-dos.css`;
  document.head.appendChild(css);
  await loadScript(`${base}js-dos/js-dos.js`);

  setupCodeHelper(files);
  const el = document.getElementById('dos')!;
  el.hidden = false;
  let ci: CommandInterface | null = null;
  window.Dos(el, {
    dosboxConf: DOSBOX_CONF,
    // js-dos transfers these buffers to its worker, which detaches them. Pass copies: if `files` held
    // detached buffers, every later saveCached(files) would fail with a DataCloneError and saves were lost.
    initFs: [...files].map(([path, contents]) => ({ path, contents: contents.slice() })),
    pathPrefix: `${base}js-dos/emulators/`,
    autoStart: true,
    kiosk: true,
    noCloud: true,
    onEvent: (name: string, arg: unknown) => {
      if (name === 'ci-ready') ci = arg as CommandInterface;
    },
  });
  // The game writes MSAVE*/ESAVE* files when saving; copy them back to IndexedDB. Reading the save files
  // takes a few milliseconds, so poll often: with the old 5 s poll a save made in the last seconds before
  // reloading or closing the page was lost, and loading it later gave back an older game.
  setInterval(() => ci && persistSaves(ci, files), 250);
  // Also try when the tab is hidden or closed. The page may be gone before this finishes, hence the poll.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && ci) persistSaves(ci, files);
  });
  // A save that is not stored yet: let the browser ask before the page goes away.
  window.addEventListener('beforeunload', (e) => {
    if (!stopped && pending.size) e.preventDefault();
  });

  document.getElementById('export')!.onclick = async () => {
    if (ci) await persistSaves(ci, files);
    const url = URL.createObjectURL(new Blob([exportSaves(files) as BlobPart], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `hero-saves-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const imp = document.getElementById('import') as HTMLInputElement;
  imp.onchange = async () => {
    if (!imp.files?.length) return;
    stopped = true;
    while (persisting) await new Promise((r) => setTimeout(r, 100));
    try {
      await importSaves(files, imp.files);
      location.reload(); // the running emulator still has the old files
    } catch (e) {
      stopped = false;
      alert((e as Error).message);
    }
    imp.value = '';
  };

  document.getElementById('forget')!.onclick = async () => {
    await clearCached();
    location.reload();
  };
}

main();
