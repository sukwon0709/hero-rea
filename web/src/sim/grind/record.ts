// Grinding simulator: a battle recorder for replays ("videocasts"). It hooks a headless battle scene
// and its GrindPolicy and writes down every real action (the look-ahead search's rollouts are
// skipped): the player's moves and commands, the computer's units, script messages and talk, with
// a snapshot of every unit before and after, the troop/morale changes and the exp each officer got.
// The graphics it needs (map chips, unit sprite cells and the battle palette, decoded from the
// game's own files by BattleView) are exported once, so a renderer outside the game (a script that
// writes video frames) can draw the battle without the game files. No game data is stored here.

import { AiMode, NONE, PLAYER_SLOTS, Status, UnitFlag, type Unit } from '../../engine/battle/types';
import { maxHp, maxMp } from '../../engine/battle/rules';
import { dac6to8, scale4to6 } from '../../formats/palette';
import type { BattleScene } from '../../native/battle/scene';
import { dsTable, S } from '../../native/battle/strings';
import type { GrindPolicy } from './policy';

const dec = new TextDecoder('euc-kr');

/** One unit on a recorded frame. */
export interface ReplayUnit {
  slot: number;
  officer: number;
  name: string;
  x: number;
  y: number;
  status: number;
  flags: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  morale: number;
  level: number;
  exp: number;
  cls: number;
  /** HEXZCHR entry (BattleView.spriteEntry). */
  sprite: number;
}

export interface ReplayHit {
  slot: number;
  /** Troops lost (negative = healed). */
  dhp: number;
  dmorale: number;
  /** Left the field during the action. */
  left: boolean;
}

export interface ReplayFrame {
  /** select: before an action (the unit at its start, arrow to where it goes); result: after it;
   *  msg: a message outside an action (turn banner, script talk, events). */
  kind: 'select' | 'result' | 'msg';
  turn: number;
  phase: 'player' | 'enemy' | 'ally' | 'event';
  actor?: number;
  from?: [number, number];
  to?: [number, number];
  target?: number;
  /** What the action was: attack, tactic name, item, wait, move. */
  action?: string;
  /** Messages shown during the action or this message frame (speaker: text). */
  text: string[];
  hits?: ReplayHit[];
  exp?: { officer: number; name: string; gained: number; level: number }[];
  units: ReplayUnit[];
  /** Map chips (only on frames where they changed since the last frame, and on the first). */
  chips?: number[];
}

export interface ReplayAssets {
  width: number;
  height: number;
  /** 16 RGB8 colours. */
  palette: [number, number, number][];
  /** Map chip images by chip id (16x16 indexed, row-major), only the ids used. */
  chips: Record<number, number[]>;
  /** Unit sprite cells by `${entry}:${mirror}`: 8 cells of 16x16 (2 frames x 2x2), colour 0 transparent. */
  sprites: Record<string, number[][]>;
  classNames: string[];
  tacticNames: string[];
}

interface Internals {
  inRollout: boolean;
  execute: (a: { slot: number; x: number; y: number; kind: string; target: number; tactic: number; item?: { id: number } }) => Promise<number>;
}

export class BattleRecorder {
  frames: ReplayFrame[] = [];
  private inAction: string[] | null = null;
  private lastChips = '';
  private spriteKeys = new Set<string>();
  private usedChips = new Set<number>();

  constructor(
    readonly scene: BattleScene,
    readonly policy: GrindPolicy,
  ) {}

  private get rollout(): boolean {
    return (this.policy as unknown as Internals).inRollout;
  }

  private officerName(u: Unit): string {
    return this.scene.b.stateOfficer(u).name;
  }

  snapshot(): ReplayUnit[] {
    const b = this.scene.b;
    const out: ReplayUnit[] = [];
    for (const u of b.units) {
      if (u.status === Status.Empty || u.officer === 0xffff) continue;
      const o = b.officerOf(u);
      const sprite = this.scene.v.spriteEntry(u);
      this.spriteKeys.add(`${sprite}:${(u.flags & UnitFlag.Facing) === 0 ? 1 : 0}`);
      out.push({
        slot: u.slot, officer: u.officer, name: this.officerName(u), x: u.x, y: u.y, status: u.status, flags: u.flags,
        hp: o.hp, maxHp: maxHp(o), mp: u.mp, maxMp: maxMp(o) & 0xff, morale: u.morale, level: o.level, exp: o.exp, cls: o.cls, sprite,
      });
    }
    return out;
  }

  private phase(slot: number): ReplayFrame['phase'] {
    return slot < PLAYER_SLOTS ? (this.scene.units[slot].mode === AiMode.Player ? 'player' : 'ally') : 'enemy';
  }

  private push(f: Omit<ReplayFrame, 'turn' | 'units' | 'chips'>): ReplayFrame {
    const chips = this.scene.b.map.chips;
    const key = chips.join(',');
    const frame: ReplayFrame = { ...f, turn: this.scene.b.info.turn + 1, units: this.snapshot() };
    if (key !== this.lastChips) {
      frame.chips = [...chips];
      for (const c of chips) this.usedChips.add(c);
      this.lastChips = key;
    }
    this.frames.push(frame);
    return frame;
  }

  private exps(): Map<number, number> {
    const m = new Map<number, number>();
    for (const u of this.scene.units.slice(0, PLAYER_SLOTS)) {
      if (u.status === Status.Empty || u.officer >= 0x100) continue;
      const o = this.scene.b.officerOf(u);
      m.set(u.slot, o.level * 100 + o.exp);
    }
    return m;
  }

  /** Runs one action between a select frame and a result frame. */
  private async action<T>(slot: number, to: [number, number] | null, target: number, action: string, run: () => Promise<T>): Promise<T> {
    const sc = this.scene;
    const u = sc.units[slot];
    const before = new Map(sc.units.map((v) => [v.slot, { hp: v.officer === 0xffff ? 0 : sc.b.officerOf(v).hp, morale: v.morale, field: v.status === Status.Field }]));
    const e0 = this.exps();
    const from: [number, number] = [u.x, u.y];
    const sel = this.push({ kind: 'select', phase: this.phase(slot), actor: slot, from, to: to ?? undefined, target: target === NONE ? undefined : target, action, text: [] });
    const text: string[] = [];
    this.inAction = text;
    let r: T;
    try {
      r = await run();
    } finally {
      this.inAction = null;
    }
    const hits: ReplayHit[] = [];
    for (const v of sc.units) {
      const b0 = before.get(v.slot);
      if (!b0 || v.officer === 0xffff) continue;
      const hp = sc.b.officerOf(v).hp;
      const left = b0.field && v.status !== Status.Field;
      if (hp !== b0.hp || v.morale !== b0.morale || left) hits.push({ slot: v.slot, dhp: b0.hp - hp, dmorale: b0.morale - v.morale, left });
    }
    const e1 = this.exps();
    const exp: NonNullable<ReplayFrame['exp']> = [];
    for (const [s, t] of e1) {
      const g = t - (e0.get(s) ?? t);
      if (g > 0) exp.push({ officer: sc.units[s].officer, name: this.officerName(sc.units[s]), gained: g, level: sc.b.officerOf(sc.units[s]).level });
    }
    // a computer unit that neither moved nor acted (waiting) makes no frames
    const moved = u.x !== from[0] || u.y !== from[1];
    if (slot >= PLAYER_SLOTS && !moved && !hits.length && !text.length) {
      this.frames.splice(this.frames.indexOf(sel), 1);
      return r;
    }
    if (!sel.to) sel.to = [u.x, u.y];
    this.push({ kind: 'result', phase: this.phase(slot), actor: slot, from, to: [u.x, u.y], target: sel.target, action, text, hits, exp });
    return r;
  }

  /** Hooks the scene, the policy and the message box (call from a sceneHooks entry). */
  install(): () => void {
    const sc = this.scene as unknown as Record<string, unknown>;
    const pol = this.policy as unknown as Internals;
    const main = this.scene.ctx.assets.main;
    const tname = (t: number) => dec.decode(dsTable(main, S.tactics, t, true)).trim();
    const exec = pol.execute.bind(this.policy);
    pol.execute = async (a) => {
      if (this.rollout) return exec(a);
      const label = a.kind === 'tactic' ? tname(a.tactic) : a.kind === 'item' ? `item ${a.item?.id ?? ''}` : a.kind;
      return this.action(a.slot, [a.x, a.y], a.target, label, () => exec(a));
    };
    const ai = (sc.aiUnit as (s: number) => Promise<void>).bind(this.scene);
    sc.aiUnit = async (slot: number) => {
      if (this.rollout || this.scene.units[slot].status !== Status.Field) return ai(slot);
      return this.action(slot, null, NONE, 'ai', () => ai(slot));
    };
    // the AI's tactic shows up as its message (S.tacticUsed); the action label is refined from it
    const ui = this.scene.ctx.ui as unknown as Record<string, unknown>;
    const msg0 = ui.message as (t: { text: string; speaker?: number } | string, o?: { name?: string }) => Promise<void>;
    const conf0 = ui.confirm as typeof msg0;
    const onMsg = (t: { text: string; speaker?: number } | string, o?: { name?: string }) => {
      if (this.rollout) return;
      const s = (typeof t === 'string' ? t : t.text).replace(/\s+/g, ' ').trim();
      if (!s) return;
      const line = o?.name ? `${o.name}: ${s}` : s;
      if (this.inAction) this.inAction.push(line);
      else this.push({ kind: 'msg', phase: 'event', text: [line] });
    };
    ui.message = async (t: { text: string } | string, o?: { name?: string }) => {
      onMsg(t, o);
      return msg0(t, o);
    };
    ui.confirm = async (t: { text: string } | string, o?: { name?: string }) => {
      // the end-of-phase question is not shown
      if (typeof t !== 'string' && !/턴을 종료|종료하/.test(t.text)) onMsg(t, o);
      return conf0(t, o);
    };
    return () => {
      ui.message = msg0;
      ui.confirm = conf0;
    };
  }

  /** The graphics the recorded frames use, decoded from the game's files through BattleView. */
  assets(): ReplayAssets {
    const v = this.scene.v as unknown as { chip: (c: number) => Uint8Array | undefined; spriteCells: (e: number, m: boolean) => Uint8Array[] };
    const main = this.scene.ctx.assets.main;
    const chips: ReplayAssets['chips'] = {};
    for (const c of this.usedChips) {
      const img = v.chip(c);
      if (img) chips[c] = [...img];
    }
    const sprites: ReplayAssets['sprites'] = {};
    for (const k of this.spriteKeys) {
      const [e, m] = k.split(':').map(Number);
      sprites[k] = v.spriteCells(e, m === 1).map((c) => [...c]);
    }
    const pal = this.scene.ctx.assets.palettes[3];
    return {
      width: this.scene.b.width,
      height: this.scene.b.height,
      palette: pal.map((c) => c.map((x) => dac6to8(scale4to6(x))) as [number, number, number]),
      chips,
      sprites,
      classNames: Array.from({ length: 19 }, (_, i) => dec.decode(dsTable(main, S.classNames, i)).trim()),
      tacticNames: Array.from({ length: 36 }, (_, i) => dec.decode(dsTable(main, S.tactics, i, true)).trim()),
    };
  }
}
