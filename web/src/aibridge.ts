// Classic mode: the page side of the custom AI (커스텀 AI). See commander.ts for the file format
// and the strategy, autobattle.ts and asm/aiblob.asm for the game side.

import { AI_BLOB } from './autobattle';
import { decide, orderFile, ORDER_FILE, ORDERS_OFF, parseState, STATE_FILE, STATE_SIZE } from './commander';
import { loadBattleMaps, type BattleMap } from './engine/battle/map';
import type { GameFiles } from './gamefiles';

export interface BridgeCI {
  fsReadFile(file: string): Promise<Uint8Array>;
  fsWriteFile(file: string, contents: Uint8Array): Promise<void>;
}

const STORE_KEY = 'hero-custom-ai';
const POLL_MS = 200;
const LOG_LINES = 40;

function loadOn(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveOn(on: boolean) {
  try {
    localStorage.setItem(STORE_KEY, on ? '1' : '0');
  } catch {
    // only a convenience
  }
}

/** Extra files for the emulator's drive C: the AI routine, the order file and an empty state file. */
export function bridgeFiles(): { path: string; contents: Uint8Array }[] {
  return [
    { path: 'AI', contents: AI_BLOB.slice() },
    { path: ORDER_FILE, contents: Uint8Array.of(loadOn() ? 0 : ORDERS_OFF) },
    // fsReadFile never settles for a missing file, so the file the page polls exists from the start.
    { path: STATE_FILE, contents: new Uint8Array(1) },
  ];
}

/** Wires the 커스텀 AI checkbox and log, and answers the game's AISTATE.BIN while it is on. */
export function startBridge(panel: HTMLElement, files: GameFiles, getCi: () => BridgeCI | null) {
  const box = panel.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  const log = panel.querySelector<HTMLElement>('.ailog')!;
  let on = loadOn();
  let maps: BattleMap[] | null = null;
  let lastSeq = -1;
  let busy = false;
  box.checked = on;
  panel.hidden = false;

  // Newest entry first; an entry is one turn's orders.
  const write = (...lines: string[]) => {
    const div = document.createElement('div');
    div.textContent = lines.join('\n');
    log.prepend(div);
    while (log.childElementCount > LOG_LINES) log.lastElementChild!.remove();
  };

  const terrain = (map: number): Uint8Array | null => {
    try {
      maps ??= loadBattleMaps(files.get('HEXZMAP.R3')!);
      return maps[map]?.terrain ?? null;
    } catch {
      return null;
    }
  };

  box.onchange = async () => {
    on = box.checked;
    saveOn(on);
    const ci = getCi();
    // The game reads the first byte before each of its passes: 0xff means "do not wait".
    if (ci) await ci.fsWriteFile(ORDER_FILE, Uint8Array.of(on ? 0 : ORDERS_OFF));
    write(on ? '커스텀 AI 켜짐 (자동전투 중인 턴부터 적용)' : '커스텀 AI 꺼짐 (자동전투는 게임 AI로 진행)');
  };

  const read = (ci: BridgeCI) =>
    Promise.race([
      ci.fsReadFile(STATE_FILE).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);

  setInterval(async () => {
    const ci = getCi();
    if (!on || busy || !ci) return;
    busy = true;
    try {
      const data = await read(ci);
      if (!data || data.length !== STATE_SIZE || data[0] === lastSeq || !on) return;
      const s = parseState(data);
      if (!s) return;
      const orders = decide(s, terrain(s.map));
      await ci.fsWriteFile(ORDER_FILE, orderFile(s, orders));
      lastSeq = s.seq;
      write(`${s.turn + 1}턴`, ...orders.map((o) => `  ${o.text}`));
    } finally {
      busy = false;
    }
  }, POLL_MS);
}
