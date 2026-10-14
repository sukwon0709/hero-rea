// Native mode entry point (native.html): loads the player's game files like play.ts does, sets up the
// 640x480 canvas (scaled by whole steps where possible, nearest-neighbour), sound on the first gesture,
// and runs the game.

import { clearCached, getGameFiles } from '../gamefiles';
import { Screen, WIDTH, HEIGHT } from '../engine/screen';
import { Input } from '../engine/input';
import { SoundPlayer } from '../audio/player';
import { Game } from './game';

function fit(canvas: HTMLCanvasElement, stage: HTMLElement) {
  const r = stage.getBoundingClientRect();
  const availW = Math.max(320, r.width - 16), availH = Math.max(240, window.innerHeight - stage.offsetTop - 16);
  const s = Math.min(availW / WIDTH, availH / HEIGHT);
  const scale = s >= 1 ? Math.floor(s * 2) / 2 : s; // crisp half steps above 1x
  canvas.style.width = `${Math.floor(WIDTH * scale)}px`;
  canvas.style.height = `${Math.floor(HEIGHT * scale)}px`;
}

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function main() {
  const picker = document.getElementById('picker')!;
  const files = await getGameFiles(picker);
  const stage = document.getElementById('stage')!;
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  stage.hidden = false;
  const screen = new Screen(canvas);
  const input = new Input(canvas);
  fit(canvas, stage);
  window.addEventListener('resize', () => fit(canvas, stage));

  let sound: SoundPlayer | null = null;
  try {
    sound = new SoundPlayer(files);
  } catch (e) {
    console.warn('sound unavailable', e);
  }
  const startSound = () => {
    sound?.start().catch(() => undefined);
    window.removeEventListener('pointerdown', startSound);
    window.removeEventListener('keydown', startSound);
  };
  window.addEventListener('pointerdown', startSound);
  window.addEventListener('keydown', startSound);

  const game = new Game(files, screen, input, canvas, sound);
  (window as unknown as { heroNative: Game }).heroNative = game;

  const slotSel = document.getElementById('slot') as HTMLSelectElement;
  document.getElementById('export')!.onclick = () => {
    const slot = +slotSel.value;
    const zip = game.saves.exportSlot(slot);
    if (zip) download(`hero-save-${slot + 1}.zip`, zip);
    else alert(`Slot ${slot + 1} is empty.`);
  };
  const imp = document.getElementById('import') as HTMLInputElement;
  imp.onchange = async () => {
    if (!imp.files?.length) return;
    try {
      const list = await Promise.all(Array.from(imp.files).map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
      const single = list.length && list.every((f) => !/\.zip$/i.test(f.name));
      const slots = await game.saves.importFiles(list, single ? +slotSel.value : undefined);
      alert(slots.length ? `Imported into slot ${slots.map((s) => s + 1).join(', ')}.` : 'No MSAVEn.R3S / ESAVEn.R3S files found.');
    } catch (e) {
      alert((e as Error).message);
    }
    imp.value = '';
  };
  document.getElementById('forget')!.onclick = async () => {
    await clearCached();
    location.reload();
  };

  await game.run();
}

main().catch((e) => {
  console.error(e);
  const p = document.createElement('pre');
  p.textContent = String((e as Error).stack ?? e);
  document.body.appendChild(p);
});
