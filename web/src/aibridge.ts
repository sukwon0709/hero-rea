// Classic mode: the page side of the custom AI (커스텀 AI). See commander.ts for the file format
// and the strategy, autobattle.ts and asm/aiblob.asm for the game side.

import { AI_BLOB } from './autobattle';
import {
  decide,
  DEFAULT_STRATEGY,
  orderFile,
  ORDER_FILE,
  ORDERS_OFF,
  parseState,
  sanitizeStrategy,
  STATE_FILE,
  STATE_SIZE,
  type Strategy,
} from './commander';
import { loadBattleMaps, type BattleMap } from './engine/battle/map';
import type { GameFiles } from './gamefiles';

export interface BridgeCI {
  fsReadFile(file: string): Promise<Uint8Array>;
  fsWriteFile(file: string, contents: Uint8Array): Promise<void>;
}

const STORE_KEY = 'hero-custom-ai';
const STRATEGY_KEY = 'hero-custom-ai-strategy';
const PROMPT_KEY = 'hero-custom-ai-prompt';
const API_KEY = 'hero-anthropic-api-key';
const POLL_MS = 200;
const LOG_LINES = 40;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // only a convenience
  }
}

const loadOn = () => load(STORE_KEY) === '1';
const saveOn = (on: boolean) => save(STORE_KEY, on ? '1' : '0');

function loadStrategy(): Strategy {
  const raw = load(STRATEGY_KEY);
  if (!raw) return DEFAULT_STRATEGY;
  try {
    return sanitizeStrategy(JSON.parse(raw));
  } catch {
    return DEFAULT_STRATEGY;
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
  let strategy = loadStrategy();
  let lastUnits: string[] = [];
  box.checked = on;
  panel.hidden = false;
  setupPrompt();

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

  // The strategy prompt: Claude turns it into a Strategy once; the turns use it without waiting.
  function setupPrompt() {
    const text = panel.querySelector<HTMLTextAreaElement>('.aiprompt')!;
    const key = panel.querySelector<HTMLInputElement>('.aikey')!;
    const apply = panel.querySelector<HTMLButtonElement>('.aiapply')!;
    const reset = panel.querySelector<HTMLButtonElement>('.aireset')!;
    const status = panel.querySelector<HTMLElement>('.aistatus')!;
    const shown = panel.querySelector<HTMLElement>('.aistrategy')!;
    const json = panel.querySelector<HTMLElement>('.aijson')!;
    const show = () => {
      shown.textContent = strategy.summary;
      json.textContent = JSON.stringify(strategy, null, 2);
    };
    text.value = load(PROMPT_KEY) ?? '';
    key.value = load(API_KEY) ?? '';
    show();
    key.onchange = () => save(API_KEY, key.value.trim() || null);
    reset.onclick = () => {
      strategy = DEFAULT_STRATEGY;
      save(STRATEGY_KEY, null);
      status.textContent = '기본 전략으로 돌아왔습니다.';
      show();
    };
    apply.onclick = async () => {
      const prompt = text.value.trim();
      const apiKey = key.value.trim();
      if (!prompt) return void (status.textContent = '전략을 적어 주세요.');
      if (!apiKey) return void (status.textContent = 'Anthropic API 키를 넣어 주세요.');
      save(PROMPT_KEY, prompt);
      save(API_KEY, apiKey);
      apply.disabled = true;
      status.textContent = 'Claude가 전략을 설정으로 바꾸는 중...';
      try {
        // Loaded on first use, so the page does not carry the SDK until a prompt is applied.
        const { promptToStrategy } = await import('./strategyprompt');
        strategy = await promptToStrategy(apiKey, prompt, lastUnits);
        save(STRATEGY_KEY, JSON.stringify(strategy));
        status.textContent = '적용했습니다. 다음 자동전투 턴부터 이 전략을 씁니다.';
        write(`전략 변경: ${strategy.summary}`);
        show();
      } catch (e) {
        const err = e as { status?: number; message?: string };
        status.textContent =
          err.status === 401 ? 'API 키가 맞지 않습니다.' : `전략을 만들지 못했습니다: ${err.message ?? String(e)}`;
      } finally {
        apply.disabled = false;
      }
    };
  }

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
      lastUnits = s.ours.map((u) => u.name);
      const orders = decide(s, terrain(s.map), strategy);
      await ci.fsWriteFile(ORDER_FILE, orderFile(s, orders));
      lastSeq = s.seq;
      write(`${s.turn + 1}턴`, ...orders.map((o) => `  ${o.text}`));
    } finally {
      busy = false;
    }
  }, POLL_MS);
}
