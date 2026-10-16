// Grinding simulator, part 1: a battle sandbox. A snapshot of the game at the moment a battle map is
// entered (GameState + script context + the shared RNG seed + the sortie list) is replayed through
// the real battle scene (web/src/native/battle/scene.ts: the same turn loop, AI, combat rules,
// script events and RNG draws) with a headless context: no drawing, no frame waits, every message
// acknowledged. A GrindPolicy (policy.ts) plays the player phase. Results match what the real game
// gives for the same state, seed and player decisions; the sandbox host mirrors the field engine's
// battle-time host methods (game.ts makeHost) for the commands that change state.

import type { Assets, GameContext, Ui } from '../../native/context';
import { rosterOfficers, type GameState } from '../../engine/state';
import { ScriptVM, type ScriptHost, type ScriptState } from '../../engine/script';
import { Rng } from '../../engine/battle/rules';
import { NONE, PLAYER_SLOTS, Status } from '../../engine/battle/types';
import { BattleScene } from '../../native/battle/scene';
import { DevAssets } from '../../native/battle/dev/context';
import { headlessScreen, ScriptedInput } from '../../native/battle/dev/headless';

/** The FORMATION that preceded a battle: which deployment records were free picks. */
export interface FormationInfo {
  /** Player records of ScriptState.units that held placeholders (officer >= 0x400) before FORMATION. */
  records: number[];
  /** Officers placed by the setup itself (faction 0, id < 0x400). */
  fixed: number[];
  /** The battle uses the formation path (hexFlag & 1): the list goes to BattleExtras.formation. */
  hexFormation: boolean;
}

/** The game at the start of one battle (Game.battleMode -> runBattle). */
export interface BattleSnapshot {
  index: number;
  chapter: number;
  stage: number;
  block: number;
  map: number;
  name: string;
  state: GameState;
  script: ScriptState;
  rngSeed: number;
  /** Game.formation when the battle began (the sortie list for formation-flag battles). */
  formation: number[] | undefined;
  /** Set when a FORMATION ran for this battle. */
  formationInfo: FormationInfo | null;
  /** Officer level/exp/class/items after the baseline battle (for carrying story changes between battles). */
  after?: { level: number; exp: number; cls?: number; items?: number[] }[];
  /** Gold after the baseline battle. */
  moneyAfter?: number;
  /** Shop item lists the story passed through since the previous battle (merchant towns). */
  shops?: number[][];
}

export function cloneSnapshot<T>(v: T): T {
  return structuredClone(v);
}

class Suspend extends Error {}

const noUi: Ui = {
  message: async () => {},
  confirm: async () => true,
  menu: async () => 0,
  caption: async () => {},
  setTitle: () => {},
  fadeOut: async () => {},
  fadeIn: async () => {},
  frame: async () => {},
  wait: async () => {},
};

/** Script host for the sandbox: the state-changing methods of the field engine's host (game.ts). */
export function sandboxHost(state: GameState, chapterOf: () => number): ScriptHost {
  const off = (o: number) => state.officers[o & 0x1ff]?.dyn;
  return {
    talk: async () => {},
    ask: async () => true,
    narrate: async () => {},
    caption: async () => {},
    title: async () => {},
    stageTitle: async () => {},
    choose: async () => 0,
    showPicture: async () => {},
    closePicture: async () => {},
    // game.ts setMap: changeLocation + Suspend; the scene sees the location change (checkLeftBattle)
    setMap: async (map: number) => {
      const loc = state.location;
      state.prevLocation = { ...loc };
      loc.mode = (loc.mode & 0xf0) | ((map >> 12) & 0xf);
      loc.map = map & 0xff;
      state.status |= 0x02;
      throw new Suspend();
    },
    showMap: async () => {},
    redraw: async () => {},
    placeCharacter: () => {},
    moveCharacter: () => {},
    waitMoves: async () => {},
    removeCharacter: () => {},
    addGold: (n: number) => {
      state.progress.money = Math.max(0, Math.min(10000, state.progress.money + n));
    },
    // ADD_ITEM (op 0x1b -> 0cf5:6d9c), as game.ts addItem: the first free slot of the first roster
    // officer that has one (in a battle too: 회남's 업화서, 계교's 장창 and 연노 are battle treasures)
    addItem: async (item: number) => {
      for (const o of rosterOfficers(state)) {
        const k = o.dyn.items.indexOf(0xff);
        if (k >= 0) {
          o.dyn.items[k] = item;
          break;
        }
      }
    },
    setForce: (o: number, f: number) => {
      const d = off(o);
      if (d) d.flags = (d.flags & ~0x1f) | (f & 0x1f);
    },
    setCg: (o: number, cg: number) => {
      const d = off(o);
      if (d) d.b1 = cg;
    },
    setOfficerFlag: (o: number, on: boolean) => {
      const d = off(o);
      if (d) d.flags = on ? d.flags | 0x80 : d.flags & ~0x80;
    },
    addStat: (o: number, n: number) => {
      const d = off(o);
      if (d) d.level = Math.min(99, d.level + n);
    },
    setStat: (o: number, v: number) => {
      const d = off(o);
      if (d) d.level = v;
    },
    gameOver: async () => {
      state.status |= 0x20;
    },
    ending: async () => {
      state.status |= 0x04;
    },
    savePrompt: async () => {},
    saveState: () => {},
    stageChanged: () => {
      void chapterOf;
    },
  } as ScriptHost;
}

export interface SandboxRun {
  scene: BattleScene;
  ctx: GameContext;
  rng: Rng;
}

let sharedAssets: { files: Map<string, Uint8Array>; a: DevAssets } | null = null;
export function assetsFor(files: Map<string, Uint8Array>): DevAssets {
  if (!sharedAssets || sharedAssets.files !== files) sharedAssets = { files, a: new DevAssets(files) };
  return sharedAssets.a;
}

/**
 * Builds a headless battle scene over `snap` (cloned: the snapshot is left untouched). `prepare`
 * may edit the cloned state first (carried levels, formation picks).
 */
export function buildSandbox(
  files: Map<string, Uint8Array>,
  snap: BattleSnapshot,
  afterSetup: (scene: BattleScene) => void,
  prepare?: (state: GameState, script: ScriptState, extras: { formation: number[] | undefined }) => void,
): SandboxRun {
  const a = assetsFor(files);
  const state = cloneSnapshot(snap.state);
  const script = cloneSnapshot(snap.script);
  const extras = { formation: snap.formation ? [...snap.formation] : undefined };
  prepare?.(state, script, extras);
  const host = sandboxHost(state, () => script.chapter);
  let ctx: GameContext;
  const routed = new Proxy(host, {
    get(t, k) {
      if (k !== 'setMap') {
        const bh = ctx.battleHost as Record<string | symbol, unknown> | null | undefined;
        const m = bh?.[k];
        if (typeof m === 'function') return m;
      }
      return (t as unknown as Record<string | symbol, unknown>)[k];
    },
  });
  const vm = new ScriptVM((c) => a.chapter(c), routed as ScriptHost, script);
  const rng = new Rng(snap.rngSeed);
  const input = new ScriptedInput();
  ctx = {
    battleHost: null,
    screen: headlessScreen(),
    input: input.asInput(),
    sound: null,
    assets: a as Assets,
    ui: noUi,
    state,
    vm,
    script: vm.state,
    rng,
    runEvent: async (t) => {
      try {
        const r = await vm.dispatch(t);
        if (r === 'gameOver') state.status |= 0x20;
        if (r === 'ending') state.status |= 0x04;
        return r;
      } catch (e) {
        if (e instanceof Suspend) return 'suspended';
        throw e;
      }
    },
  };
  const scene = new BattleScene(ctx, snap.map, { rng, formation: extras.formation, autoPlay: false, afterSetup });
  makeHeadless(scene);
  return { scene, ctx, rng };
}

/** Removes drawing and frame waits from a scene (display only: no RNG draws are skipped). */
export function makeHeadless(scene: BattleScene): void {
  const v = scene.v as unknown as Record<string, unknown> & { tick: number };
  v.render = () => {};
  v.frameStep = async () => {
    v.tick++;
  };
  v.ensureVisible = () => {};
  v.centre = () => {};
  // every drawing primitive (the duel scene and the close-ups redraw the map and a shaded panel per
  // frame: a third of a campaign's time went into pixels nobody sees); pure display, no game state
  const proto = Object.getPrototypeOf(scene.v) as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(proto)) if (/^(draw|shade$|text$|rect$|bar$|clipUnit$|blitImg$)/.test(k) && typeof proto[k] === 'function') v[k] = () => {};
  const scr = scene.ctx.screen as unknown as Record<string, unknown>;
  scr.fillRect = () => {};
  scr.blit = () => {};
  scr.clear = () => {};
  scr.present = () => {};
  scr.grab = (_x: number, _y: number, w: number, h: number) => new Uint8Array(w * h);
  const sc = scene as unknown as Record<string, unknown>;
  // showHit is the hit display (close-up or blink) and the recursion into the counter's display
  sc.showHit = async () => {};
  sc.animateRoute = async (slot: number, route: number[]) => {
    // the walk without frames: same cells, same unit-map updates (no RNG either way)
    const u = scene.units[slot];
    const DIRS = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    for (const d of route) {
      const [dx, dy] = DIRS[d];
      scene.b.s.unitAt[u.y * scene.b.width + u.x] = NONE;
      u.x += dx;
      u.y += dy;
      scene.b.s.unitAt[u.y * scene.b.width + u.x] = slot;
    }
  };
  sc.blinkUnit = async () => {};
}

/** Officer level*100 + exp (the total the level-up rule works on). */
export function totalExp(state: GameState, officer: number): number {
  const d = state.officers[officer].dyn;
  return d.level * 100 + d.exp;
}

/** Player officers of the scene (deployed, not generic). */
export function deployed(scene: BattleScene): number[] {
  return scene.units
    .slice(0, PLAYER_SLOTS)
    .filter((u) => u.status !== Status.Empty && u.officer < 0x100)
    .map((u) => u.officer);
}
