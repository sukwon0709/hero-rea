// Dev harness: a headless whole-game playthrough of native mode. It drives the real Game (title menu,
// field engine, script VM, battle mode) with scripted input only:
//
//  * every message is acknowledged, yes/no questions answer yes, menus take their first enabled entry
//    (CHOOSE, formation), shops are left at once, SAVE_PROMPT saves to a chosen slot;
//  * on the field a planner reads the records of the current event group and makes the clicks a
//    player would make to fire one (talk to a character, walk through a door, leave a town, travel
//    to a town on the world map), preferring records whose code moves the story on;
//  * battles run in zero-player mode (autoPlay) with a few guards (유비 and the defeat officer hold
//    back when weak). When a battle goes badly the bot retreats (총퇴각, the original's restart) and
//    after `botAttempts` tries it switches to a clearly labelled debug "force win": the victory
//    officer and the enemies on the field are removed through the battle's own leave path (1cb6:8504),
//    so the script's real victory events (BATTLE_END, MAP) run.
//
// Every battle is recorded (won by the bot or forced), and so is everything suspicious (synthetic
// triggers, engine log lines, hangs). Used by web/test/native-playthrough.test.ts and by hand from
// vite-node scripts.

import { Game } from '../game';
import { Screen } from '../../engine/screen';
import type { Input } from '../../engine/input';
import { Rng } from '../../engine/battle/rules';
import { AiMode, NONE, PLAYER_SLOTS, Status, UNIT_SLOTS } from '../../engine/battle/types';
import { maxHp } from '../../engine/battle/rules';
import { battleNameLines } from '../../engine/battle/map';
import { storyName } from '../../sim/grind/names';
import { recordCommands } from '../battle/dev/setup';
import { runBattle as realRunBattle, type BattleScene } from '../battle/scene';
import type { RunBattle } from '../context';
import type { Trigger } from '../../engine/script';
import type { EventRecord, Stage } from '../../formats/scenario';
import { ATTR, VIEW, type Actor } from '../field';
import type { Button } from '../draw';

const dec = new TextDecoder('euc-kr');

type Click = { button: 'left' | 'right'; x: number; y: number };

/** Scripted input with the Input interface; `onIdle` is asked for more when the queue is empty. */
export class PlayInput {
  x = 320;
  y = 240;
  left = false;
  right = false;
  clicks: Click[] = [];
  keys: string[] = [];
  onIdle: (() => void) | null = null;
  takeClick(): Click | undefined {
    if (!this.clicks.length) this.onIdle?.();
    const c = this.clicks.shift();
    if (c) {
      this.x = c.x;
      this.y = c.y;
    }
    return c;
  }
  takeKey(): string | undefined {
    return this.keys.shift();
  }
  flush() {}
  next(): Promise<void> {
    return Promise.resolve();
  }
  asInput(): Input {
    return this as unknown as Input;
  }
}

function stubCanvas(): HTMLCanvasElement {
  const ctx2d = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
  };
  return { width: 640, height: 480, getContext: () => ctx2d } as unknown as HTMLCanvasElement;
}

export interface BattleRecord {
  chapter: number;
  stage: number;
  block: number;
  map: number;
  name: string;
  /** 'bot' = won by play, 'forced' = debug force win, 'lost', 'ended' (quit), 'error'. */
  outcome: 'bot' | 'forced' | 'lost' | 'ended' | 'error' | 'running';
  attempts: number;
  turns: number;
  forcedHow?: string;
}

export interface PlaythroughOptions {
  /** 'new' (default) or a save slot to load from the title menu. */
  start?: 'new' | { slot: number };
  seed?: number;
  /** Battle attempts played by the bot before forcing (default 3). */
  botAttempts?: number;
  /** Never let the bot play: force every battle at once (fast smoke runs). */
  forceAll?: boolean;
  /** Slot SAVE_PROMPT saves into (default 4); -1 = decline saving. */
  saveSlot?: number;
  /** Frames without any progress before the run is declared hung (default 400000). */
  hangFrames?: number;
  /** Log the units once per turn. */
  traceBattles?: boolean;
  /** Stop condition checked on every progress change. */
  stopWhen?: (p: Playthrough) => boolean;
  log?: (line: string) => void;
  /** Screenshot sink (called with a name and the screen) on location and battle starts. */
  shot?: (name: string, screen: Screen) => void;
  /** CHOOSE answers not to give ("menu key#occurrence=answer"), learned by playToEnd from story game overs. */
  avoidChoices?: Set<string>;
  /** CHOOSE answers start at this option instead of the first (coverage runs: the other story branches). */
  choiceOffset?: number;
  /**
   * Called once per town between two battles when the town has a shop (a non-empty item list at
   * DS:0x56a2 + town*8, as Game.shopItems), with that list. The harness itself never shops; a caller
   * can buy here (the grinding simulator spends gold on promotions, heals and bombs).
   */
  onShop?: (game: Game, items: number[]) => void;
}

export type PlayResult = 'ending' | 'gameOver' | 'quit' | 'stopped' | 'hang' | 'error';

class Stop extends Error {}
class Hang extends Error {}

const PROGRESS_OPS = new Set(['LEAVE_GROUP', 'GOTO_BLOCK', 'NEXT_CHAPTER', 'MAP', 'BATTLE_SETUP', 'ENDING', 'SORTIE', 'FORMATION']);

export class Playthrough {
  readonly game: Game;
  readonly input = new PlayInput();
  readonly battles: BattleRecord[] = [];
  readonly issues: string[] = [];
  readonly transcript: string[] = [];
  frames = 0;
  private lastSig = '';
  private sigFrame = 0;
  private heartbeat = 0;
  private attempted = new Set<string>();
  private unreachable = new Set<string>();
  private synthetic = new Set<string>();
  private resets = new Set<string>();
  private idleNoPlan = 0;
  private locSig = '';
  private current: BattleRecord | null = null;
  /** The outcome of run(), once it returned. */
  result: PlayResult | null = null;
  readonly opts: Required<Omit<PlaythroughOptions, 'stopWhen' | 'log' | 'shot' | 'traceBattles' | 'avoidChoices' | 'choiceOffset' | 'onShop'>> & PlaythroughOptions;
  private shopsSeen = new Set<string>();

  constructor(files: Map<string, Uint8Array>, opts: PlaythroughOptions = {}) {
    this.opts = { start: 'new', seed: 12345, botAttempts: 3, forceAll: false, saveSlot: 4, hangFrames: 400_000, ...opts };
    const screen = new Screen(stubCanvas());
    this.game = new Game(files, screen, this.input.asInput(), stubCanvas(), null);
    this.install();
  }

  log(line: string) {
    this.opts.log?.(line);
  }

  issue(line: string) {
    const where = `[ch${this.game.script.chapter} st${this.game.script.stage} bl${this.game.script.block} gr${this.game.script.group}]`;
    this.issues.push(`${where} ${line}`);
    this.log(`ISSUE ${where} ${line}`);
  }

  // ---------------------------------------------------------------- hooks

  private install() {
    const g = this.game;
    const v = g.video;
    v.fast = true;
    // frames cost nothing: no presentation, a macrotask every 256 frames so timers can run
    v.frame = () => {
      v.ticks++;
      this.frames++;
      if ((this.frames & 1023) === 0) this.checkProgress();
      if ((this.frames & 255) === 0) return new Promise<void>((r) => setTimeout(r, 0));
      return Promise.resolve();
    };
    const ui = g.ui as unknown as Record<string, unknown>;
    ui.waitClick = async () => 'left';
    ui.pickButton = async (buttons: Button[], cancel: boolean) => this.answer(buttons, cancel);
    const mb = g.ui.messageBox.bind(g.ui);
    g.ui.messageBox = async (t, o = {}) => {
      const text = typeof t === 'string' ? t : t instanceof Uint8Array ? dec.decode(t) : t.text;
      const name = o.name === undefined ? '' : typeof o.name === 'string' ? o.name : o.name instanceof Uint8Array ? dec.decode(o.name) : o.name.text;
      this.transcript.push(`${name ? name + ': ' : ''}${text.replace(/\r?\n/g, ' ')}`);
      return mb(t, o);
    };
    const cb = g.ui.captionBox.bind(g.ui);
    g.ui.captionBox = async (t, mode = 0) => {
      const text = typeof t === 'string' ? t : t instanceof Uint8Array ? dec.decode(t) : t.text;
      this.transcript.push(`[${text.replace(/\r?\n/g, ' ')}]`);
      if (mode === 2 && /다시 한번 게임하겠습니까/.test(text)) throw new Stop('game over prompt');
      return cb(t, mode);
    };
    g.log = (m) => {
      this.log(`game: ${m}`);
      if (/error|unhandled|out of range/i.test(m)) this.issue(`engine log: ${m.split('\n')[0]}`);
    };
    const gx = g as unknown as Record<string, unknown>;
    gx.rng = new Rng(this.opts.seed);
    gx.autoPlay = true;
    gx.afterSetup = (sc: BattleScene) => this.battleSetup(sc);
    // battle mode through a wrapper that records the outcome
    const wrapped: RunBattle = async (ctx, map) => {
      const names = battleNameLines(g.assets.file('HEXZMAP.R3'));
      const rec: BattleRecord = {
        chapter: g.script.chapter,
        stage: g.script.stage,
        block: g.script.block,
        map,
        name: storyName(g.script.chapter, g.script.stage, g.script.block, dec.decode(names[map] ?? new Uint8Array(0)).trim()),
        outcome: 'running',
        attempts: 0,
        turns: 0,
      };
      this.battles.push(rec);
      this.current = rec;
      this.log(`BATTLE start ${rec.name} (map ${map}) ch${rec.chapter} st${rec.stage} bl${rec.block}`);
      try {
        const r = await realRunBattle(ctx, map);
        if (r === 'won') rec.outcome = rec.forcedHow ? 'forced' : 'bot';
        else rec.outcome = r;
        this.log(`BATTLE end ${rec.name}: ${rec.outcome}${rec.forcedHow ? ' (' + rec.forcedHow + ')' : ''} attempts ${rec.attempts} turns ${rec.turns}`);
        return r;
      } catch (e) {
        if (e instanceof Stop || e instanceof Hang) throw e;
        rec.outcome = 'error';
        this.issue(`battle ${rec.name} threw: ${(e as Error).stack ?? e}`);
        throw e;
      } finally {
        this.current = null;
      }
    };
    gx.battleModule = Promise.resolve({ runBattle: wrapped });
    const dispatch = g.dispatch.bind(g);
    g.dispatch = async (t: Trigger) => {
      const r = await dispatch(t);
      if (r !== 'none') this.heartbeat++;
      return r;
    };
    this.input.onIdle = () => this.fieldStep();
    // CHOOSE: take the options in turn each time the same menu comes back (route hubs such as the
    // 소패 bandit choice loop until every target was visited)
    const host = g.vm.host as unknown as { choose(o: { text: string }[]): Promise<number>; ask(l: unknown, c: unknown): Promise<boolean> };
    const ask = host.ask.bind(host);
    host.ask = async (l, c) => {
      this.declineNext = !this.askAnswer();
      return ask(l, c);
    };
    const choose = host.choose.bind(host);
    host.choose = async (o) => {
      this.chooseKey = `${g.script.chapter}/${g.script.stage}/${g.script.block}/${g.script.group}/${o.map((x) => x.text).join('|')}`;
      // options whose target record (group + i + 1) runs into GAME_OVER (story dead ends), or jumps back to
      // the start of this block (a quiz answered wrong: 노숙's questions in chapter 3 restart until all are right)
      const recs = g.vm.stage.blocks[g.vm.state.block]?.records ?? [];
      const avoid = (pred: (c: { name: string; block?: number }) => boolean) =>
        new Set(
          o.map((_, i) => i).filter((i) => {
            const r = recs[g.vm.state.group + i + 1];
            return !!r && (recordCommands(g.vm.stage, r.code) as { name: string; block?: number }[]).some(pred);
          }),
        );
      this.chooseUnsafe = avoid((c) => c.name === 'GAME_OVER');
      const loops = avoid((c) => c.name === 'GOTO_BLOCK' && c.block === g.vm.state.block);
      // an option with an IF may loop only conditionally (the 소패 hub returns once every road is done)
      for (const i of [...loops]) {
        const r = recs[g.vm.state.group + i + 1];
        if (r && recordCommands(g.vm.stage, r.code).some((c) => c.name === 'IF')) loops.delete(i);
      }
      if (loops.size < o.length) for (const i of loops) this.chooseUnsafe.add(i);
      try {
        return await choose(o);
      } finally {
        this.chooseKey = null;
      }
    };
  }

  /** ASK: the answer whose branch does not run into GAME_OVER (yes when both are safe). */
  private askAnswer(): boolean {
    const vm = this.game.vm;
    const stage = vm.stage;
    // the interpreter has already stepped past ASK: find it just before the PC
    let ask: { answer: number; skip: number } | null = null;
    for (let back = 1; back <= 4 && !ask; back++) {
      const c = stage.commands.get(vm.state.pc - back);
      if (c?.name === 'ASK' && c.size === back) ask = c;
    }
    if (!ask) return true;
    const dies = (answer: number) => {
      let pc = vm.state.pc;
      let skip = answer === ask!.answer ? ask!.skip : 0;
      for (let i = 0; i < 64; i++) {
        const c = stage.commands.get(pc);
        if (!c) return false;
        pc += c.size;
        if (skip > 0) {
          skip--;
          continue;
        }
        if (c.name === 'GAME_OVER') return true;
        if (c.name === 'END' || c.name === 'GOTO_BLOCK' || c.name === 'LEAVE_GROUP' || c.name === 'NEXT_CHAPTER') return false;
      }
      return false;
    };
    const yes = !dies(1) || dies(0);
    if (!yes) this.log('ASK: answering no (yes leads to GAME_OVER)');
    return yes;
  }

  private chooseKey: string | null = null;
  private chooseUnsafe = new Set<number>();
  /** Every CHOOSE answer given, in order ("menu key#occurrence=answer"). */
  readonly choices: string[] = [];
  private chooseCount = new Map<string, number>();

  /** Answers a button pick: yes / OK / the first enabled entry; shops are left. */
  private answer(buttons: Button[], cancel: boolean): number {
    this.heartbeat++;
    const labels = buttons.map((b) => (b.label ? dec.decode(b.label).trim() : ''));
    if (labels.includes('산다') && cancel) return -1;
    // the save list: "n. ..." rows
    if (labels.length === 5 && labels.every((l, i) => l.startsWith(`${i + 1}.`))) {
      const want = this.loadingSlot ?? this.opts.saveSlot;
      this.loadingSlot = null;
      if (want < 0 || buttons[want]?.disabled) return cancel ? -1 : buttons.findIndex((b) => !b.disabled);
      return want;
    }
    if (labels.length === 4 && labels[0] === dec.decode(this.game.assets.dsString(this.game.assets.dsWord(0x2d38))).trim()) {
      // the title menu: once at the start; coming back to it ends the run
      if (!this.titlePending) throw new Stop(this.game.state.status & 0x04 ? 'ending' : 'title');
      this.titlePending = false;
      return this.opts.start === 'new' ? 0 : 1;
    }
    if (buttons.length === 2 && buttons[0].kind === 2 && buttons[1].kind === 3) {
      if (this.declineNext) {
        this.declineNext = false;
        return 1;
      }
      return 0;
    }
    if (this.chooseKey) {
      const n = this.chooseCount.get(this.chooseKey) ?? 0;
      this.chooseCount.set(this.chooseKey, n + 1);
      const bad = (i: number) => this.chooseUnsafe.has(i) || !!this.opts.avoidChoices?.has(`${this.chooseKey}#${n}=${i}`);
      let k = (n + (this.opts.choiceOffset ?? 0)) % buttons.length;
      for (let j = 0; j < buttons.length && bad(k); j++) k = (k + 1) % buttons.length;
      this.choices.push(`${this.chooseKey}#${n}=${k}`);
      this.log(`CHOOSE ${k} of ${labels.join(' / ')}${this.chooseUnsafe.size ? ` (avoiding ${[...this.chooseUnsafe].join(',')})` : ''}`);
      return k;
    }
    const i = buttons.findIndex((b) => !b.disabled);
    return i < 0 ? (cancel ? -1 : 0) : i;
  }

  private forcingNow = false;
  private titlePending = true;
  private loadingSlot: number | null = null;
  private declineNext = false;

  /** Progress signature; a run that keeps it for `hangFrames` frames is hung. */
  private checkProgress() {
    const g = this.game;
    const s = g.script;
    const l = g.state.location;
    const sig = `${s.chapter}/${s.stage}/${s.block}/${s.group}/${s.pc}/${l.mode}/${l.map}/${l.key}/${this.heartbeat}/${this.battles.length}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.sigFrame = this.frames;
      if (this.opts.stopWhen?.(this)) throw new Stop('stop condition');
      return;
    }
    if (this.frames - this.sigFrame > this.opts.hangFrames) throw new Hang(`no progress for ${this.frames - this.sigFrame} frames at ${sig} field=${g.field.kind}`);
  }

  // ---------------------------------------------------------------- run

  async run(): Promise<PlayResult> {
    const g = this.game;
    if (this.opts.start !== 'new') this.loadingSlot = this.opts.start.slot;
    try {
      await g.run();
      this.result = 'stopped';
    } catch (e) {
      if (e instanceof Stop) {
        const st = g.state.status;
        this.result = e.message === 'ending' || st & 0x04 ? 'ending' : st & 0x20 ? 'gameOver' : st & 0x40 ? 'quit' : 'stopped';
      } else if (e instanceof Hang) {
        this.issue(`HANG: ${e.message}`);
        this.result = 'hang';
      } else {
        this.issue(`ERROR: ${(e as Error).stack ?? e}`);
        this.result = 'error';
      }
    }
    return this.result;
  }

  // ---------------------------------------------------------------- field planner

  private get mode(): number {
    return this.game.state.location.mode & 0xf;
  }

  private groupRecords(): EventRecord[] {
    const g = this.game;
    const s = g.script;
    const recs = g.vm.stage.blocks[s.block]?.records ?? [];
    const first = recs[s.group];
    if (!first) return [];
    const out: EventRecord[] = [];
    for (let i = s.group; i < recs.length && recs[i].group === first.group; i++) out.push(recs[i]);
    return out;
  }

  private score(stage: Stage, r: EventRecord): number {
    const cmds = recordCommands(stage, r.code);
    if (cmds.some((c) => c.name === 'OP31')) return -1; // shop
    if (cmds.some((c) => PROGRESS_OPS.has(c.name))) return 3;
    if (cmds.some((c) => c.name === 'SET_FLAG' || c.name === 'ADD_ITEM' || c.name === 'SET_FORCE')) return 2;
    return 1;
  }

  private key(r: EventRecord): string {
    const s = this.game.script;
    return `${s.chapter}/${s.stage}/${s.block}/${s.group}/${r.index}/${Array.from(s.flags).join('.')}`;
  }

  /** Called whenever the game waits for a click and none is queued. */
  private fieldStep() {
    const g = this.game;
    const st = g.state.status;
    if (st & 0x20) throw new Stop('game over');
    if (st & 0x04) throw new Stop('ending');
    if (this.mode === 3 || g.field.kind === 'none' || g.field.moving || this.input.clicks.length) return;
    const ls = `${g.state.location.mode}/${g.state.location.map}/${g.state.location.key}/${g.field.kind}`;
    if (ls !== this.locSig) {
      this.locSig = ls;
      this.checkLocation();
    }
    const stage = g.vm.stage;
    if (this.opts.onShop) {
      // the town the party is in has a 도구상 when its shop list (DS:0x56a2 + town*8, as
      // Game.shopItems) is not empty; offered once per town between two battles. The port's field
      // engine opens the shop only through OP31 events, the original also through the 도구상
      // building (not traced, docs/GAMEFLOW.md), so this is the stand-in for walking in there.
      const t = g.assets.tables;
      const town = g.state.progress.territory + (t.sectionTownBase[t.chapterSection[g.state.progress.chapter] ?? 0] ?? 0);
      const items = Array.from(g.assets.ds(0x56a2 + town * 8, 8)).filter((v) => v !== 0xff);
      const key = `${town}/${this.battles.length}`;
      if (items.length && !this.shopsSeen.has(key)) {
        this.shopsSeen.add(key);
        this.opts.onShop(g, items);
      }
    }
    const cands = this.groupRecords()
      .filter((r) => r.trigger === 2 || r.trigger === 3 || r.trigger === 5)
      .map((r) => ({ r, score: this.score(stage, r) }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score || a.r.index - b.r.index);
    for (const { r } of cands) {
      const k = this.key(r);
      if (this.attempted.has(k) || this.unreachable.has(`${k}@${ls}`)) continue;
      const act = this.plan(r);
      if (act === 'unreachable') {
        this.unreachable.add(`${k}@${ls}`);
        continue;
      }
      this.idleNoPlan = 0;
      if (act.final) this.attempted.add(k);
      this.input.clicks.push({ button: 'left', x: act.x, y: act.y });
      return;
    }
    // nothing reachable: after a while fire the best record directly (a planner gap, logged)
    if (++this.idleNoPlan < 600) return;
    this.idleNoPlan = 0;
    const pick = cands.find((c) => !this.synthetic.has(this.key(c.r)));
    if (!pick) {
      // everything was tried: start over once per position, then leave it to the hang detection
      const pos = `${g.script.chapter}/${g.script.stage}/${g.script.block}/${g.script.group}`;
      if (cands.length === 0 || this.resets.has(pos)) return;
      this.resets.add(pos);
      this.synthetic.clear();
      this.attempted.clear();
      this.unreachable.clear();
      return;
    }
    const r = pick.r;
    this.synthetic.add(this.key(r));
    const t = this.triggerOf(r);
    const locked = (g as unknown as { inputLocked: boolean }).inputLocked;
    const how = this.attempted.has(this.key(r)) ? 'clicked but it did not fire' : 'no way to reach it';
    const attrs = new Set<number>();
    if (g.field.kind === 'room') for (let y = 0; y < 20; y++) for (let x = 0; x < 31; x++) attrs.add(g.field.attr(x, y));
    this.issue(
      `synthetic trigger ${JSON.stringify(t)} (record ${r.index}, ${how} from ${ls}${locked ? ', input locked' : ''}; attrs ${[...attrs].sort((a, b) => a - b).join(',')})`,
    );
    void g.dispatch(t);
  }

  private triggerOf(r: EventRecord): Trigger {
    switch (r.trigger) {
      case 2:
        return { type: 'location', spot: r.p1, town: r.p2 };
      case 5:
        return { type: 'location', spot: 0, town: r.p1 };
      case 3:
        return { type: 'talk', officer: r.p1 };
      default:
        return { type: 'talk', officer: 0 };
    }
  }

  /** The next click towards firing record r, or 'unreachable' from here. */
  private plan(r: EventRecord): { x: number; y: number; final: boolean } | 'unreachable' {
    const g = this.game;
    const f = g.field;
    const loc = g.state.location;
    const locked = (g as unknown as { inputLocked: boolean }).inputLocked;
    if (r.trigger === 3 || r.trigger === 1) {
      if (f.kind !== 'room' || locked) return 'unreachable';
      const a = r.trigger === 3 ? f.actors.get(r.p1) : [...f.actors.values()].find((x) => x.id !== 0);
      if (!a) return 'unreachable';
      const p = this.actorPoint(a);
      return p ? { ...p, final: true } : 'unreachable';
    }
    const wantTown = r.trigger === 5 ? r.p1 : r.p2;
    if (r.trigger === 5 || (r.trigger === 2 && this.mode === 1 && r.p1 === 0)) {
      if (this.mode === 1) return this.townClick(wantTown, true);
      return this.towardsWorld();
    }
    // trigger 2: spot p1 of town p2 (a door / gate / exit of the room)
    if (this.mode === 1) return this.townClick(wantTown, false);
    if (loc.key !== wantTown) return this.towardsWorld();
    if (this.mode === 2 && r.p1 < ATTR.GATE) {
      // a door of the town: leave the building first
      const p = this.cellOf((v) => v === ATTR.EXIT) ?? this.cellOf((v) => v === ATTR.GATE);
      return p ? { ...p, final: false } : 'unreachable';
    }
    if (locked) return 'unreachable';
    const p = this.cellOf((v) => v === r.p1);
    return p ? { ...p, final: true } : 'unreachable';
  }

  private towardsWorld(): { x: number; y: number; final: boolean } | 'unreachable' {
    if ((this.game as unknown as { inputLocked: boolean }).inputLocked) return 'unreachable';
    const p = this.mode === 2 ? this.cellOf((v) => v === ATTR.EXIT) ?? this.cellOf((v) => v === ATTR.GATE) : this.cellOf((v) => v === ATTR.GATE);
    return p ? { ...p, final: false } : 'unreachable';
  }

  private townClick(t: number, final: boolean): { x: number; y: number; final: boolean } | 'unreachable' {
    const g = this.game;
    const town = g.state.towns[t];
    if (!town) return 'unreachable';
    const me = g.field.actors.get(0);
    if (me && me.x === town.pos[0] && me.y === town.pos[1] && g.state.location.key === t) {
      // already there: step off and back on
      g.field.focusOn(town.pos[0] + 1, town.pos[1]);
      return { x: VIEW.x + (town.pos[0] + 1) * 32 - g.field.scrollX + 16, y: VIEW.y + town.pos[1] * 32 - g.field.scrollY + 16, final: false };
    }
    g.field.focusOn(town.pos[0], town.pos[1]);
    return { x: VIEW.x + town.pos[0] * 32 - g.field.scrollX + 16, y: VIEW.y + town.pos[1] * 32 - g.field.scrollY + 16, final };
  }

  /** Screen point of the room cell nearest to 유비 whose attribute passes `ok`, at a pixel no other character covers
   *  (a click on a townsperson standing in front of a door talks instead). */
  private cellOf(ok: (v: number) => boolean): { x: number; y: number } | null {
    const f = this.game.field;
    const me = f.actors.get(0);
    const cells: [number, number, number][] = [];
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 31; x++) if (ok(f.attr(x, y))) cells.push([me ? Math.abs(x - me.x) + Math.abs(y - me.y) : 0, x, y]);
    cells.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cy] of cells)
      for (const [dx, dy] of [[8, 8], [3, 3], [12, 3], [3, 12], [12, 12], [8, 14], [8, 2]]) {
        const x = VIEW.x + cx * 16 + dx, y = VIEW.y + cy * 16 + dy;
        const hit = f.actorAt(x, y);
        if (!hit || hit.id === 0) return { x, y };
      }
    return cells.length ? { x: VIEW.x + cells[0][1] * 16 + 8, y: VIEW.y + cells[0][2] * 16 + 8 } : null;
  }

  /** A screen point where Field.actorAt picks this actor. */
  private actorPoint(a: Actor): { x: number; y: number } | null {
    const f = this.game.field;
    for (let dy = -32; dy < 24; dy += 2)
      for (let dx = -8; dx < 28; dx += 2) {
        const x = VIEW.x + Math.round(a.px) + dx, y = VIEW.y + Math.round(a.py) + dy;
        if (f.actorAt(x, y) === a) return { x, y };
      }
    return null;
  }

  /** On every new location: sprites and characters must be drawable. */
  private checkLocation() {
    const g = this.game;
    const f = g.field;
    const loc = g.state.location;
    this.log(`LOC mode ${loc.mode & 0xf} map ${loc.map} key ${loc.key} kind ${f.kind} actors ${[...f.actors.keys()].join(',')}`);
    const sprite = (f as unknown as { actorSprite(a: Actor): unknown }).actorSprite.bind(f);
    for (const a of f.actors.values()) {
      if (!sprite(a)) this.issue(`no sprite for actor ${a.id} (${g.state.officers[a.id & 0x1ff]?.name ?? '?'}) at mode ${loc.mode & 0xf} map ${loc.map}`);
    }
    this.opts.shot?.(`loc-ch${g.script.chapter}-bl${g.script.block}-m${loc.mode & 0xf}-${loc.map}`, g.screen);
  }

  // ---------------------------------------------------------------- battle bot

  private battleSetup(sc: BattleScene) {
    const rec = this.current;
    if (!rec) return;
    rec.attempts++;
    const forcing = this.opts.forceAll || rec.attempts > this.opts.botAttempts;
    const vm = this.game.script;
    const guarded = new Set<number>([0]);
    if (vm.defeat.enabled) guarded.add(vm.defeat.officer);
    const players = sc.units.slice(0, PLAYER_SLOTS).filter((u) => u.status !== Status.Empty && u.officer !== 0xffff).length;
    if (!players) this.issue(`battle ${rec.name}: no player units (formation flag ${sc.b.formation ? 1 : 0}, sortie list ${JSON.stringify(this.game.formation ?? null)})`);
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      const u = sc.units[i];
      if (u.status === Status.Empty || u.officer === 0xffff) continue;
      if (guarded.has(u.officer) && u.mode === AiMode.AttackNearest) u.mode = AiMode.Wait;
    }
    // drawing every frame is most of the cost of a headless battle: draw one frame in 32 (the
    // drawing code still runs; screenshots get a full frame)
    if (!this.opts.shot && !(sc.v as unknown as { throttled?: boolean }).throttled) {
      const v = sc.v as unknown as { throttled?: boolean; render(): void; tick: number };
      const render = v.render.bind(v);
      v.throttled = true;
      v.render = () => {
        if ((v.tick & 31) === 0) render();
      };
    }
    this.opts.shot?.(`battle-${rec.chapter}-${rec.map}-a${rec.attempts}`, this.game.screen);
    // units that join the player during the battle (REINFORCE, SET_FORCE ...) arrive in player mode after the
    // autoPlay switch of the setup: hand them to the computer too, or the player phase waits for input
    if (!(sc as unknown as { autoJoin?: boolean }).autoJoin) {
      (sc as unknown as { autoJoin?: boolean }).autoJoin = true;
      const loop = sc.eventLoop.bind(sc);
      sc.eventLoop = async (first, autoFallback) => {
        const r = await loop(first, autoFallback);
        for (let i = 0; i < PLAYER_SLOTS; i++) if (sc.units[i].mode === AiMode.Player) sc.units[i].mode = AiMode.AttackNearest;
        return r;
      };
    }
    // safety net: a guarded officer about to fall makes the bot retreat (or, out of attempts, force)
    const origLeave = sc.leave.bind(sc);
    sc.leave = async (slot: number) => {
      const u = sc.units[slot];
      if (slot < PLAYER_SLOTS && guarded.has(u.officer) && u.status === Status.Field && !sc.b.info.result && !this.forcingNow) {
        const o = sc.b.officerOf(u);
        if (o.hp === 0) o.hp = 1;
        if (rec.attempts < this.opts.botAttempts && !sc.b.formation) {
          this.log(`BATTLE ${rec.name}: retreat (leader falling) at turn ${sc.b.info.turn + 1}`);
          sc.b.info.result = 1;
        } else {
          done = true;
          await this.forceWin(sc, rec);
        }
        return;
      }
      await origLeave(slot);
    };
    const orig = sc.aiUnit.bind(sc);
    let done = false;
    // the real deadline: the turn limit, or a turn event that ends the game (업2: the fire spreads, turn 28)
    let deadline = sc.b.info.turnLimit;
    {
      const stage = this.game.vm.stage;
      for (const r of stage.blocks[this.game.script.block]?.records ?? [])
        if (r.trigger === 9 && r.p1 > 0 && recordCommands(stage, r.code).some((c) => c.name === 'GAME_OVER')) deadline = Math.min(deadline, r.p1);
    }
    sc.aiUnit = async (slot: number) => {
      this.heartbeat++;
      rec.turns = sc.b.info.turn + 1;
      if (forcing && !done) {
        done = true;
        await this.forceWin(sc, rec);
        if (sc.b.info.result) return;
      }
      if (sc.b.info.result) return;
      if (slot < PLAYER_SLOTS) this.orders(sc, guarded, rec.attempts);
      if (this.opts.traceBattles && slot === sc.units.findIndex((u) => u.status === Status.Field)) {
        const vm = this.game.script;
        this.log(`TURN ${sc.b.info.turn + 1}/${sc.b.info.turnLimit} victory ${vm.victory.enabled ? vm.victory.officer : '-'} ` +
          sc.units.filter((u) => u.status === Status.Field).map((u) => `${u.slot}:${u.officer}@${u.x},${u.y} m${u.mode} t${u.target === NONE ? '-' : u.target} hp${sc.b.officerOf(u).hp}`).join(' '));
      }
      await orig(slot);
      if (sc.b.info.result || forcing) return;
      // going badly: retreat (총퇴각 restarts the battle) or, out of attempts, force
      if (sc.b.info.turn + 2 >= deadline) {
        if (rec.attempts < this.opts.botAttempts && !sc.b.formation) {
          this.log(`BATTLE ${rec.name}: retreat (turn limit) at turn ${sc.b.info.turn + 1}`);
          sc.b.info.result = 1;
        } else {
          done = true;
          await this.forceWin(sc, rec);
        }
      }
    };
  }

  /**
   * Orders for the computer-played player units: walk to a winning position of the script (unit
   * position / area records whose event ends the battle as a win), else go for the victory officer,
   * else attack the nearest enemy; guarded officers (유비, the defeat officer) hold back when weak.
   */
  private orders(sc: BattleScene, guarded: Set<number>, attempt: number) {
    // odd attempts fight as a group (attack the nearest enemy), even ones go for the victory officer
    const charge = attempt % 2 === 0;
    const b = sc.b;
    const stage = this.game.vm.stage;
    const recs = stage.blocks[this.game.script.block]?.records ?? [];
    const goals: { officer: number; x: number; y: number }[] = [];
    const current = new Set(this.groupRecords().map((r) => r.index));
    for (const r of recs) {
      if (r.trigger !== 6 && r.trigger !== 11) continue;
      const cmds = recordCommands(stage, r.code);
      if (cmds.some((c) => c.name === 'GAME_OVER' || c.name === 'ADD_ITEM')) continue; // traps, treasure
      // a position the current event group waits for, or one whose event wins the battle
      const end = cmds.findIndex((c) => c.name === 'BATTLE_END');
      if (!current.has(r.index) && end < 0) continue;
      const x0 = r.p2 >> 8, y0 = r.p2 & 0xff;
      const [x, y] = r.trigger === 6 ? [x0, y0] : [(x0 + (r.p3 >> 8)) >> 1, (y0 + (r.p3 & 0xff)) >> 1];
      goals.push({ officer: r.p1, x, y });
    }
    const vm = this.game.script;
    const vslot = vm.victory.enabled ? b.slotOfOfficer(vm.victory.officer) : NONE;
    const vOn = charge && vslot !== NONE && sc.units[vslot].status === Status.Field;
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      const u = sc.units[i];
      if (u.status !== Status.Field || u.mode === AiMode.Player || u.mode === AiMode.Confused || u.mode === AiMode.Paralysed) continue;
      const o = b.officerOf(u);
      const goal = goals.find((gl) => gl.officer === u.officer) ?? goals.find((gl) => gl.officer === 0x400);
      if (goal) {
        u.mode = AiMode.MoveTo;
        u.target = NONE;
        u.tx = goal.x;
        u.ty = goal.y;
      } else if (guarded.has(u.officer) && o.hp * 2 < maxHp(o)) u.mode = AiMode.Hold;
      else if (u.officer === 0 && charge) u.mode = AiMode.Wait;
      else if (vOn) {
        u.mode = AiMode.MoveTo;
        u.target = vslot;
      } else u.mode = AiMode.AttackNearest;
    }
  }

  /**
   * Debug force win: removes the victory officer, then every enemy on the field, through the scene's
   * leave path (their events run as if they were beaten); if the script still has not ended the
   * battle, fires the records of the current group whose code ends the battle as a win.
   */
  async forceWin(sc: BattleScene, rec: BattleRecord) {
    const b = sc.b;
    const vm = this.game.script;
    const how: string[] = [];
    rec.forcedHow = 'pending';
    this.forcingNow = true;
    const kill = async (slot: number) => {
      const u = sc.units[slot];
      if (u.status !== Status.Field) return;
      b.officerOf(u).hp = 0;
      await sc.leave(slot);
    };
    const stage = this.game.vm.stage;
    const tried = new Set<string>();
    for (let step = 0; step < 16 && b.info.result === 0; step++) {
      if (vm.victory.enabled) {
        const slot = b.slotOfOfficer(vm.victory.officer);
        if (slot !== NONE && sc.units[slot].status === Status.Field) {
          await kill(slot);
          how.push('victory officer');
          continue;
        }
      }
      let any = false;
      for (let i = PLAYER_SLOTS; i < UNIT_SLOTS && b.info.result === 0; i++) {
        if (sc.units[i].status === Status.Field) {
          await kill(i);
          any = true;
        }
      }
      if (any) {
        how.push('enemies');
        if (b.info.result === 0) await sc.victoryCheck();
        continue;
      }
      // nobody left to beat: fire the next record of the current group that does not lose the game
      // (unit position / area / turn triggers the bot did not reach)
      const pos = `${vm.stage}/${vm.block}/${vm.group}`;
      const r = this.groupRecords().find((x) => {
        if (tried.has(`${pos}/${x.index}`) || x.trigger === 8) return false;
        if (recordCommands(stage, x.code).some((c) => c.name === 'GAME_OVER')) return false;
        return this.battleTrigger(x) !== null;
      });
      if (!r) break;
      tried.add(`${pos}/${r.index}`);
      const t = this.battleTrigger(r)!;
      how.push(`trigger ${t.type}`);
      await sc.eventLoop(t);
    }
    this.forcingNow = false;
    rec.forcedHow = how.join(', ') || 'nothing';
    if (b.info.result === 0) this.issue(`force win of ${rec.name} did not end the battle`);
    this.log(`BATTLE ${rec.name}: FORCED (${rec.forcedHow}) result ${b.info.result}`);
  }

  private battleTrigger(r: EventRecord): Trigger | null {
    switch (r.trigger) {
      case 4:
        return { type: 'adjacent', other: r.p1, officer: r.p2 };
      case 6:
        // cells are x<<8|y (engine/script.ts, MAIN.EXE a172)
        return { type: 'unitAt', officer: r.p1, x: r.p2 >> 8, y: r.p2 & 0xff };
      case 7:
        return { type: 'targetDefeated' };
      case 9:
        return { type: 'turn', turn: r.p1 };
      case 11:
        return { type: 'unitInArea', officer: r.p1, x: r.p2 >> 8, y: r.p2 & 0xff };
      case 12:
        return { type: 'unitDefeated', officer: r.p1 };
      case 0:
      case 1:
        return { type: 'auto' };
    }
    return null;
  }

  /** Per-chapter summary of the battles. */
  summary(): string {
    const lines: string[] = [];
    for (const b of this.battles) lines.push(`ch${b.chapter} st${b.stage} bl${b.block} map ${b.map} ${b.name}: ${b.outcome}${b.forcedHow ? ' [' + b.forcedHow + ']' : ''} (attempts ${b.attempts}, turns ${b.turns})`);
    return lines.join('\n');
  }
}

/**
 * Plays from the title menu until the ending, starting over when the story ends in a game over that followed a
 * CHOOSE answer. The last answer is avoided on the next run; when the run dies again right after the same menu,
 * the answer before it is blamed instead (a choice whose consequence comes later, e.g. 조조's jade belt in
 * chapter 1 is followed by a harmless quiz). Returns the last run.
 */
export async function playToEnd(files: Map<string, Uint8Array>, opts: PlaythroughOptions = {}, maxRuns = 10): Promise<Playthrough> {
  const avoid = new Set(opts.avoidChoices ?? []);
  const menu = (c: string) => c.slice(0, c.lastIndexOf('='));
  let last: { len: number; menu: string; depth: number; avoided: string } | null = null;
  for (let run = 1; ; run++) {
    const p = new Playthrough(files, { ...opts, avoidChoices: avoid });
    const r = await p.run();
    const ch = p.choices;
    if (r !== 'gameOver' || !ch.length || run >= maxRuns) return p;
    // a lost battle is the bot's failure, not a story choice
    if (p.battles[p.battles.length - 1]?.outcome === 'lost' && p.game.script.chapter === p.battles[p.battles.length - 1].chapter) {
      const b = p.battles[p.battles.length - 1];
      if (p.game.script.stage === b.stage && p.game.script.block === b.block) return p;
    }
    let depth = 1;
    if (last && last.len === ch.length && last.menu === menu(ch[ch.length - 1])) {
      depth = last.depth + 1;
      avoid.delete(last.avoided);
    }
    const blame: string | undefined = ch[ch.length - depth];
    if (!blame) return p;
    opts.log?.(`RESTART: game over; avoiding CHOOSE ${blame} (run ${run + 1})`);
    avoid.add(blame);
    last = { len: ch.length, menu: menu(ch[ch.length - 1]), depth, avoided: blame };
  }
}
