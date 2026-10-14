// "Classic" mode: runs the original DOS executables inside js-dos (DOSBox compiled to WebAssembly).
import { getGameFiles, saveCached, clearCached, GameFiles } from './gamefiles';

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

const SAVE_FILE = /^(MSAVE\d?|ESAVE\d)\.R3[SM]$|^MSAVE\.R3$/;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function persistSaves(ci: CommandInterface, files: GameFiles) {
  let changed = false;
  for (const name of files.keys()) {
    if (!SAVE_FILE.test(name)) continue;
    try {
      const data = await ci.fsReadFile(name);
      const old = files.get(name)!;
      if (data.length !== old.length || data.some((b, i) => b !== old[i])) {
        files.set(name, data);
        changed = true;
      }
    } catch {
      /* file not readable right now */
    }
  }
  if (changed) await saveCached(files);
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
    initFs: [...files].map(([path, contents]) => ({ path, contents })),
    pathPrefix: `${base}js-dos/emulators/`,
    autoStart: true,
    kiosk: true,
    noCloud: true,
    onEvent: (name: string, arg: unknown) => {
      if (name === 'ci-ready') ci = arg as CommandInterface;
    },
  });
  // The game writes MSAVE*/ESAVE* files when saving; copy them back to IndexedDB periodically.
  setInterval(() => ci && persistSaves(ci, files), 5000);

  document.getElementById('forget')!.onclick = async () => {
    await clearCached();
    location.reload();
  };
}

main();
