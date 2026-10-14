// Battle dev harness entry (battle-dev.html): pick a battle of a chapter, start it from a new game
// or a save slot (the script's own BATTLE_SETUP / BATTLE_UNITS run first, see setup.ts), and play
// it with the real battle scene. Text boxes come from DevUi, not the field engine's Ui.

import { getGameFiles } from '../../../gamefiles';
import { Screen, WIDTH, HEIGHT } from '../../../engine/screen';
import { Input } from '../../../engine/input';
import { SoundPlayer } from '../../../audio/player';
import { Rng } from '../../../engine/battle/rules';
import { DevAssets, buildContext } from './context';
import { DevUi } from './ui';
import { listBattles, prepareBattle, type BattleEntry } from './setup';
import { BattleScene } from '../scene';

function fit(canvas: HTMLCanvasElement, stage: HTMLElement) {
  const r = stage.getBoundingClientRect();
  const availW = Math.max(320, r.width - 16);
  const availH = Math.max(240, window.innerHeight - stage.offsetTop - 140);
  const s = Math.min(availW / WIDTH, availH / HEIGHT);
  const scale = s >= 1 ? Math.floor(s * 2) / 2 : s;
  canvas.style.width = `${Math.floor(WIDTH * scale)}px`;
  canvas.style.height = `${Math.floor(HEIGHT * scale)}px`;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function main() {
  const files = await getGameFiles(document.getElementById('picker')!);
  const a = new DevAssets(files);
  const stage = document.getElementById('stage')!;
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const logEl = document.getElementById('log')!;
  stage.hidden = false;
  fit(canvas, stage);
  window.addEventListener('resize', () => fit(canvas, stage));
  const screen = new Screen(canvas);
  const input = new Input(canvas);
  let sound: SoundPlayer | null = null;
  try {
    sound = new SoundPlayer(files);
  } catch (e) {
    console.warn('sound unavailable', e);
  }
  const startSound = () => {
    sound?.start().catch(() => undefined);
    window.removeEventListener('pointerdown', startSound);
  };
  window.addEventListener('pointerdown', startSound);

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const chapterSel = $<HTMLSelectElement>('chapter');
  const battleSel = $<HTMLSelectElement>('battle');
  for (let c = 0; files.has(`SNR${c}D.R3`); c++) chapterSel.add(new Option(`Chapter ${c}`, String(c)));
  let battles: BattleEntry[] = [];
  const fillBattles = () => {
    battles = listBattles(a.chapter(+chapterSel.value));
    battleSel.innerHTML = '';
    battles.forEach((b, i) => battleSel.add(new Option(`#${i} map ${b.map} (stage ${b.stage}, block ${b.block})`, String(i))));
  };
  chapterSel.onchange = fillBattles;
  fillBattles();

  const log = (k: string, t: string) => {
    logEl.textContent = `${k}: ${t}\n${logEl.textContent ?? ''}`.slice(0, 20000);
  };
  let running = false;
  $<HTMLButtonElement>('start').onclick = async () => {
    if (running) {
      location.reload(); // a running battle has no clean abort; start over
      return;
    }
    const entry = battles[+battleSel.value];
    if (!entry) return;
    running = true;
    $<HTMLButtonElement>('start').textContent = 'Restart';
    const auto = $<HTMLInputElement>('auto').checked;
    const ui = new DevUi(screen, input, a.font, { nextFrame, log });
    const { ctx, host } = buildContext(a, +$<HTMLSelectElement>('source').value, { screen, input, ui, sound });
    if (!$<HTMLInputElement>('closeup').checked) ctx.state.progress.battleOptions |= 0x10;
    else ctx.state.progress.battleOptions &= ~0xf0;
    host.headless = true; // the lead-in events before the battle are not shown
    const map = await prepareBattle(ctx.vm, entry);
    host.headless = false;
    const scene = new BattleScene(ctx, map, { rng: new Rng(+$<HTMLInputElement>('seed').value >>> 0), autoPlay: auto });
    (window as unknown as { battle: BattleScene }).battle = scene;
    const r = await scene.run();
    log('result', r === 2 ? 'won' : r === 3 ? 'lost' : `ended (${r})`);
  };
}

main().catch((e) => {
  console.error(e);
  document.getElementById('log')!.textContent = String((e as Error).stack ?? e);
});
