// Scenario event interpreter: a re-implementation of MAIN.EXE's script VM (0cf5:8794) and its
// event selection (0cf5:81fe..85e0) on top of the parsed data of formats/scenario.ts.
// UI, maps and battles are delegated to a ScriptHost. See docs/SCRIPT.md.

import {
  type BattleUnitEntry,
  type Chapter,
  type Command,
  type EventRecord,
  type Message,
  type Stage,
  type TalkLine,
  EVENT_SAVE_SIZE,
} from '../formats/scenario';

// ---------------------------------------------------------------- state

/** One map character slot of the script context (ctx+0x31, 62 x 6 bytes). */
export interface CharSlot {
  id: number; // 0xffff = free; officer index, or townsperson | 0x400
  x: number;
  y: number;
  /** bit1 = moved by MOVE and possibly still walking. */
  flags: number;
  /** Facing as stored by the original (operand * 2). */
  dir: number;
}

/** One battle unit slot (ctx+0x1cd, 45 x 11 bytes). */
export interface UnitSlot {
  officer: number; // 0xffff = free
  x: number;
  y: number;
  /** bit0 = enemy side, bit1, bit2 (see BattleUnitEntry). */
  flags: number;
  kind: number;
  /** Bytes 7..8 (kind 3/5: an officer id, kind 4/6: two bytes). */
  param: number;
  a: number;
  b: number;
}

export const CHAR_SLOTS = 62;
export const UNIT_SLOTS = 45;

/**
 * The script context, i.e. the struct at DS:0xd4dc (comments give its offsets).
 * Everything here is what the original keeps; ESAVEn.R3S is a serialisation of it.
 */
export interface ScriptState {
  chapter: number; // +0x000  SNR file digit
  stage: number; // +0x002  LS11 entry of SNRxD / index of the SNRxM base table
  block: number; // +0x004  scene
  group: number; // +0x006  record index of the current group's first record
  area: number; // +0x008  set by the map loader (0cf5:86f0/8708)
  map: number; // +0x00a  map id; high nibble = map kind (0 town, 1 world, 2 event scene, 3 battle)
  flags: Uint8Array; // +0x011  256 scenario flags, flag n = bit (0x80 >> (n & 7)) of byte n >> 3
  chars: CharSlot[]; // +0x031
  charsArea: number; // +0x1a5  area/map the char table belongs to
  charsMap: number; // +0x1a7
  recordIter: number; // +0x1a9
  record: Uint8Array; // +0x1ab  copy of the running event record (10 bytes)
  pc: number; // +0x1b5  absolute offset in the stage data, 0xffff = none
  status: number; // +0x1b7  0 idle, 1 suspended (resume at pc), 2 waiting for MOVEs
  word1b9: number; // +0x1b9  (not used by the interpreter)
  replaceChars: number; // +0x1bb
  savedInput: number; // +0x1bd
  music: number; // +0x1bf
  extra1c1: Uint8Array; // +0x1c1..0x1ca (10 bytes, saved but not used by the interpreter)
  hexFlag: number; // +0x1cb  BATTLE_SETUP byte 0 != 0 (not saved)
  units: UnitSlot[]; // +0x1cd
  victory: { enabled: boolean; officer: number }; // +0x3bc/+0x3be (not saved)
  defeat: { enabled: boolean; officer: number }; // +0x3c0/+0x3c2 (not saved)
  battleB: number; // +0x3c6
  battleC: number; // +0x3c7
  objective: Uint8Array; // +0x3c8  EUC-KR, NUL-terminated (0x181 bytes)
  list: Uint8Array; // +0x549  SET_LIST: count + 32 bytes
}

export function newScriptState(): ScriptState {
  // MAIN.EXE 0cf5:7c1e
  return {
    chapter: 0, stage: 0, block: 0, group: 0, area: 0, map: 0,
    flags: new Uint8Array(32),
    chars: Array.from({ length: CHAR_SLOTS }, () => ({ id: 0xffff, x: 0, y: 0, flags: 0, dir: 0 })),
    charsArea: 0xffff, charsMap: 0xffff,
    recordIter: 0, record: new Uint8Array(10), pc: 0xffff, status: 0, word1b9: 0, replaceChars: 0,
    savedInput: 0, music: 0, extra1c1: new Uint8Array(10), hexFlag: 0,
    units: Array.from({ length: UNIT_SLOTS }, () => emptyUnit()),
    victory: { enabled: false, officer: 0 }, defeat: { enabled: false, officer: 0 },
    battleB: 0, battleC: 0, objective: new Uint8Array(0x181), list: new Uint8Array(0x21),
  };
}

function emptyUnit(): UnitSlot {
  return { officer: 0xffff, x: 0xff, y: 0xff, flags: 0xffff, kind: 0xff, param: 0xffff, a: 0xff, b: 0xff };
}

export function getFlag(s: ScriptState, n: number): boolean {
  return (s.flags[n >> 3] & (0x80 >> (n & 7))) !== 0;
}

export function setFlag(s: ScriptState, n: number, on: boolean) {
  if (on) s.flags[n >> 3] |= 0x80 >> (n & 7);
  else s.flags[n >> 3] &= ~(0x80 >> (n & 7));
}

/** Parses ESAVEn.R3S (0x559 bytes, layout of MAIN.EXE 0cf5:7e4a). */
export function readEventSave(b: Uint8Array): ScriptState {
  if (b.length < EVENT_SAVE_SIZE) throw new Error('event save too short');
  const w = (o: number) => b[o] | (b[o + 1] << 8);
  const s = newScriptState();
  [s.chapter, s.stage, s.block, s.group, s.area, s.map] = [0, 2, 4, 6, 8, 10].map(w);
  s.charsArea = w(0xc);
  s.charsMap = w(0xe);
  s.chars = Array.from({ length: CHAR_SLOTS }, (_, i) => {
    const o = 0x10 + i * 6;
    return { id: w(o), x: b[o + 2], y: b[o + 3], flags: b[o + 4], dir: b[o + 5] };
  });
  s.recordIter = w(0x184);
  s.record = b.slice(0x186, 0x190);
  s.pc = w(0x190);
  s.status = w(0x192);
  s.word1b9 = w(0x194);
  s.replaceChars = w(0x196);
  s.savedInput = w(0x198);
  s.music = w(0x19a);
  s.extra1c1 = b.slice(0x19c, 0x1a6);
  s.units = Array.from({ length: UNIT_SLOTS }, (_, i) => {
    const o = 0x1a6 + i * 11;
    return { officer: w(o), x: b[o + 2], y: b[o + 3], flags: w(o + 4), kind: b[o + 6], param: w(o + 7), a: b[o + 9], b: b[o + 10] };
  });
  s.flags = b.slice(0x395, 0x3b5);
  s.list = b.slice(0x3b5, 0x3d6);
  s.objective = b.slice(0x3d6, 0x557);
  s.battleB = b[0x557];
  s.battleC = b[0x558];
  return s;
}

/** Serialises the state in the ESAVEn.R3S layout. */
export function writeEventSave(s: ScriptState): Uint8Array {
  const b = new Uint8Array(EVENT_SAVE_SIZE);
  const w = (o: number, v: number) => {
    b[o] = v & 0xff;
    b[o + 1] = (v >> 8) & 0xff;
  };
  [s.chapter, s.stage, s.block, s.group, s.area, s.map].forEach((v, i) => w(i * 2, v));
  w(0xc, s.charsArea);
  w(0xe, s.charsMap);
  s.chars.forEach((c, i) => {
    const o = 0x10 + i * 6;
    w(o, c.id);
    b.set([c.x, c.y, c.flags, c.dir], o + 2);
  });
  w(0x184, s.recordIter);
  b.set(s.record, 0x186);
  w(0x190, s.pc);
  w(0x192, s.status);
  w(0x194, s.word1b9);
  w(0x196, s.replaceChars);
  w(0x198, s.savedInput);
  w(0x19a, s.music);
  b.set(s.extra1c1, 0x19c);
  s.units.forEach((u, i) => {
    const o = 0x1a6 + i * 11;
    w(o, u.officer);
    b[o + 2] = u.x;
    b[o + 3] = u.y;
    w(o + 4, u.flags);
    b[o + 6] = u.kind;
    w(o + 7, u.param);
    b[o + 9] = u.a;
    b[o + 10] = u.b;
  });
  b.set(s.flags, 0x395);
  b.set(s.list, 0x3b5);
  b.set(s.objective, 0x3d6);
  b[0x557] = s.battleB;
  b[0x558] = s.battleC;
  return b;
}

// ---------------------------------------------------------------- triggers

/** What the game reports to the event system (callers of 0cf5:81fe..85e0). */
export type Trigger =
  | { type: 'auto' } // every idle tick (81fe): records of trigger 0 (guarded) / 1
  | { type: 'talk'; officer: number } // talked to a map character (8268): trigger 3, p1 = id
  | { type: 'location'; spot: number; town: number } // town spot (8346/a0d4): trigger 2 p1=spot p2=town; on the world map (map kind 1) trigger 5 p1=town
  | { type: 'adjacent'; officer: number; other: number } // battle (82d6/a144): trigger 4 p1=other p2=officer
  | { type: 'unitAt'; officer: number; x: number; y: number } // battle (83b6/a172): trigger 6 p1=officer p2=y<<8|x
  | { type: 'targetDefeated' } // battle (842a): trigger 7
  | { type: 'leaderDefeated' } // battle (8494): trigger 8
  | { type: 'turn'; turn: number } // battle (84fe): trigger 9 p1 = turn (1-based)
  | { type: 'unitInArea'; officer: number; x: number; y: number } // battle (856c/a200): trigger 11
  | { type: 'unitDefeated'; officer: number }; // battle (85e0): trigger 12 p1 = officer

// ---------------------------------------------------------------- host

export interface TextContext {
  /** High nibble of the map id (0 town, 1 world map, 2 event scene, 3 battle). */
  mapKind: number;
}

/**
 * Everything the scripts make the game do. Promises resolve when the original would continue
 * (message acknowledged, menu chosen, characters arrived ...). Optional methods default to no-ops.
 */
export interface ScriptHost {
  // ---- text (0cf5:98f6, c15a, cf04, c340)
  /** TALK: one (speaker portrait + name, text) message box per line. */
  talk(line: TalkLine, ctx: TextContext): Promise<void>;
  /** TALK followed by ASK: only the first line is shown, with yes/no buttons. */
  ask(line: TalkLine, ctx: TextContext): Promise<boolean>;
  /** NARRATE: speaker-less text box; `inPicture` when a PICTURE window is open. */
  narrate(msg: Message, ctx: TextContext & { inPicture: boolean }): Promise<void>;
  /** CAPTION: small centred notice (place names, "got 100 gold!"). */
  caption(msg: Message): Promise<void>;
  /** TITLE: text of the title box in the bottom status bar (0cf5:c340; seen in the emulator: "서장 동탁타도군 일어나다."). */
  title(msg: Message): Promise<void>;
  /** STAGE_TITLE: caption with stage title `index` (MAIN.EXE DS:0x24fe, see readStageTitles). */
  stageTitle(index: number): Promise<void>;
  /** CHOOSE: menu of options; resolves to the 0-based index. */
  choose(options: Message[]): Promise<number>;
  /** PICTURE: event picture `picture` (PACKGRP entry, inferred); mode 0 = full screen, 1 = window. */
  showPicture(picture: number, mode: number): Promise<void>;
  /** Closes the PICTURE window (MAIN.EXE closes it before any command other than NARRATE). */
  closePicture(): Promise<void>;
  // ---- maps and characters
  /** MAP: switch to map `map` (kind = map >> 12; 3 = hex battle using ScriptState.units). */
  setMap(map: number, state: ScriptState): Promise<void>;
  /** SCREEN_MAP: show/redraw the map view (the original yields one main-loop pass here). */
  showMap(): Promise<void>;
  screenText?(): Promise<void>;
  redraw?(): Promise<void>;
  placeCharacter(officer: number, x: number, y: number, dir: number): void;
  moveCharacter(officer: number, x: number, y: number, dir: number): void;
  /** Called after the last of a run of consecutive MOVEs; resolve when everyone arrived. */
  waitMoves(): Promise<void>;
  removeCharacter(officer: number): void;
  clearCharacters?(): void;
  placeTownsfolk?(): void;
  walkTo?(x: number, y: number): Promise<void>;
  focus?(officer: number): void;
  setLeader?(officer: number): void;
  setPrevMap?(map: number, x: number, y: number): void;
  mapChip?(a: number, b: number, c: number): void;
  mapEffect?(a: number, b: number, c: number): Promise<void>;
  // ---- game state
  setInputEnabled?(enabled: boolean): void;
  playMusic?(song: number): void;
  addGold?(amount: number): void;
  battleData?(value: number): void;
  addItem?(item: number): Promise<void>;
  menuAdd?(value: number): void;
  setForce?(officer: number, force: number): void;
  setCg?(officer: number, cg: number): void;
  setOfficerFlag?(officer: number, on: boolean): void;
  addStat?(officer: number, amount: number): void;
  setStat?(officer: number, value: number): void;
  setSortie?(reset: boolean, slots: number[]): void;
  // ---- battle
  formation?(state: ScriptState): Promise<void>;
  battleEnd?(map: number, lost: boolean): Promise<void>;
  duel?(a: number, b: number): Promise<void>;
  unitAttack?(a: number, b: number): Promise<void>;
  reinforce?(officer: number): void;
  setAI?(officer: number, algo: number, a: number, b: number): void;
  unitForce?(officer: number, force: number): void;
  halve?(a: number, b: number): void;
  battleOp33?(): Promise<void>;
  battleOp34?(): Promise<void>;
  battleOp35?(officer: number, value: number): Promise<void>;
  // ---- flow
  savePrompt?(): Promise<void>;
  saveState?(save: Uint8Array): void;
  gameOver?(): Promise<void>;
  ending?(value: number): Promise<void>;
  /** A new stage/chapter was loaded (MAIN.EXE reloads BBKSDAT1 at 0cf5:b272 for a new chapter). */
  stageChanged?(chapter: number, stage: number): void;
  log?(msg: string): void;
}

export type RunResult =
  | 'none' // no record matched the trigger
  | 'end' // event finished (END in a resident group, CHOOSE target end ...); the group stays
  | 'next' // event finished and the script moved on (LEAVE_GROUP, GOTO_BLOCK, NEXT_CHAPTER, END of a
  //          non-resident group): the original's results 5/6, the caller keeps dispatching
  | 'gameOver'
  | 'ending';

// ---------------------------------------------------------------- interpreter

export class ScriptVM {
  state: ScriptState;
  /** Set while a PICTURE window is open (bp-0x1c in 0cf5:8794). */
  private pictureOpen = false;

  constructor(
    readonly loadChapter: (chapter: number) => Chapter,
    readonly host: ScriptHost,
    state?: ScriptState,
  ) {
    this.state = state ?? newScriptState();
  }

  get chapter(): Chapter {
    return this.loadChapter(this.state.chapter);
  }

  get stage(): Stage {
    return this.chapter.stages[this.state.stage];
  }

  private get blockRecords(): EventRecord[] {
    return this.stage.blocks[this.state.block].records;
  }

  /** Number of records in the current group and its resident bit (0cf5:7a2a). */
  private groupInfo(): { count: number; resident: boolean; first?: EventRecord } {
    const recs = this.blockRecords;
    const first = recs[this.state.group];
    if (!first) return { count: 0, resident: false };
    let n = 0;
    while (recs[this.state.group + n] && recs[this.state.group + n].group === first.group) n++;
    return { count: n, resident: first.resident, first };
  }

  private mapKind(): number {
    return (this.state.map >> 12) & 0xf;
  }

  /** Advances to the next group, block and stage (0cf5:9f68, a348, a3d2). */
  private advanceGroup() {
    const s = this.state;
    s.group += this.groupInfo().count;
    if (s.group < this.blockRecords.length) return;
    s.group = 0;
    s.block++;
    if (s.block < this.stage.blocks.length) return;
    s.block = 0;
    s.stage++;
    this.host.stageChanged?.(s.chapter, s.stage);
  }

  private selectRecord(r: EventRecord) {
    const s = this.state;
    s.record = this.stage.data.slice(this.stage.blocks[s.block].offset + r.index * 10, this.stage.blocks[s.block].offset + r.index * 10 + 10);
    s.pc = r.code;
    s.status = 0;
  }

  /** Predicates of 0cf5:a088..a268. */
  private matches(r: EventRecord, t: Trigger): boolean {
    switch (r.trigger) {
      case 0:
        if (t.type !== 'auto') return false;
        // a088: a resident group's auto record whose code starts with IF is guarded by that IF.
        if (this.groupInfo().resident) {
          const c = this.stage.commands.get(r.code);
          if (c?.name === 'IF') return this.evalIf(c);
        }
        return true;
      case 1:
        return true;
      case 2:
        // a0d4 type 2: p1 == spot && p2 == town
        return t.type === 'location' && r.p1 === t.spot && r.p2 === t.town;
      case 5:
        // a0d4 type 5 (only on the world map, map kind 1): p1 == town
        return t.type === 'location' && this.mapKind() === 1 && r.p1 === t.town;
      case 3:
        return t.type === 'talk' && r.p1 === t.officer;
      case 4:
        return t.type === 'adjacent' && r.p1 === t.other && r.p2 === t.officer;
      case 6:
        return t.type === 'unitAt' && r.p1 === t.officer && r.p2 === ((t.y << 8) | t.x);
      case 7:
        return t.type === 'targetDefeated';
      case 8:
        return t.type === 'leaderDefeated';
      case 9:
        return t.type === 'turn' && r.p1 === t.turn;
      case 11:
        return (
          t.type === 'unitInArea' && r.p1 === t.officer &&
          t.y >= r.p2 >> 8 && t.y <= r.p3 >> 8 && t.x >= (r.p2 & 0xff) && t.x <= (r.p3 & 0xff)
        );
      case 12:
        return t.type === 'unitDefeated' && r.p1 === t.officer;
    }
    return false;
  }

  private evalIf(c: Extract<Command, { name: 'IF' }>): boolean {
    return c.set.every((f) => getFlag(this.state, f)) && c.clear.every((f) => !getFlag(this.state, f));
  }

  /**
   * Runs the event selected by `trigger` (or resumes a suspended one). Mirrors the dispatchers
   * 0cf5:81fe..85e0 followed by 0cf5:8794: only the records of the current group are candidates,
   * the first match wins, trigger 1 matches anything.
   */
  async dispatch(trigger: Trigger): Promise<RunResult> {
    const s = this.state;
    if (s.status === 0) {
      const { count } = this.groupInfo();
      const recs = this.blockRecords;
      let found: EventRecord | undefined;
      for (s.recordIter = 0; s.recordIter < count; ) {
        const r = recs[s.group + s.recordIter++];
        this.selectRecord(r);
        if (r.trigger === 1 || this.matches(r, trigger)) {
          found = r;
          break;
        }
      }
      if (!found) {
        s.record[0] = 0xff;
        return 'none';
      }
    }
    return this.run();
  }

  /** Dispatches `auto` until nothing matches (what the battle loop 1cb6:85b3 does). */
  async runAuto(limit = 1000): Promise<RunResult> {
    let last: RunResult = 'none';
    for (let i = 0; i < limit; i++) {
      const r = await this.dispatch({ type: 'auto' });
      if (r === 'none') return last;
      last = r;
      if (r === 'gameOver' || r === 'ending') return r;
    }
    throw new Error('runAuto: event loop does not settle');
  }

  private text(id: number): Message {
    return this.chapter.messages.text(this.state.stage, id);
  }

  /** The interpreter loop (0cf5:8794). */
  async run(): Promise<RunResult> {
    const s = this.state;
    const h = this.host;
    // Running (or resuming) clears the suspension; a host that suspends again sets it while it runs.
    s.status = 0;
    let skip = 0;
    let talkMsg = -1;
    for (;;) {
      const stage = this.stage;
      const c = stage.commands.get(s.pc);
      if (!c) throw new Error(`script: no command at 0x${s.pc.toString(16)} (chapter ${s.chapter} stage ${s.stage})`);
      s.pc += c.size;
      if (skip > 0) {
        // 0cf5:8813: skipped commands are stepped over without effect
        skip--;
        continue;
      }
      if (this.pictureOpen && c.name !== 'NARRATE') {
        this.pictureOpen = false;
        await h.closePicture();
      }
      const peek = () => stage.commands.get(s.pc)?.name;
      const ctx: TextContext = { mapKind: this.mapKind() };
      switch (c.name) {
        case 'TALK':
          talkMsg = c.msg;
          if (peek() !== 'ASK') for (const line of this.chapter.messages.talk(s.stage, c.msg)) await h.talk(line, ctx);
          break;
        case 'ASK': {
          const line = this.chapter.messages.talk(s.stage, talkMsg)[0];
          const yes = await h.ask(line, ctx);
          if ((yes ? 1 : 0) === c.answer) skip = c.skip;
          break;
        }
        case 'MOVE': {
          const slot = this.charSlot(c.officer);
          if (slot) Object.assign(slot, { x: c.x, y: c.y, dir: c.dir * 2, flags: slot.flags | 2 });
          h.moveCharacter(c.officer, c.x, c.y, c.dir);
          if (peek() !== 'MOVE') await h.waitMoves();
          break;
        }
        case 'PLACE': {
          const slot = this.charSlot(c.officer);
          if (slot) Object.assign(slot, { x: c.x, y: c.y, dir: c.dir * 2 });
          h.placeCharacter(c.officer, c.x, c.y, c.dir);
          break;
        }
        case 'REMOVE': {
          const slot = this.charSlot(c.officer);
          if (slot) slot.id = 0xffff;
          h.removeCharacter(c.officer);
          break;
        }
        case 'CLEAR_CHARS':
          for (const ch of s.chars) Object.assign(ch, { id: 0xffff, flags: 0 });
          s.replaceChars = 0;
          h.clearCharacters?.();
          break;
        case 'MENU_ADD':
          h.menuAdd?.(c.value);
          break;
        case 'BATTLE_SETUP':
          this.battleSetup(c);
          break;
        case 'BATTLE_UNITS':
          this.battleUnits(c);
          break;
        case 'WEATHER':
        case 'NOP_MSG':
        case 'OP19':
        case 'OP31':
          break;
        case 'SCREEN_MAP':
          await h.showMap();
          break;
        case 'SCREEN_TEXT':
          await h.screenText?.();
          break;
        case 'PICTURE':
          await h.showPicture(c.picture, c.mode);
          this.pictureOpen = true;
          break;
        case 'NARRATE':
          await h.narrate(this.text(c.msg), { ...ctx, inPicture: this.pictureOpen });
          break;
        case 'MAP':
          s.map = c.map;
          await h.setMap(c.map, s);
          break;
        case 'CAPTION':
          await h.caption(this.text(c.msg));
          break;
        case 'TITLE':
          await h.title(this.text(c.msg));
          break;
        case 'STAGE_TITLE':
          await h.stageTitle(stageTitleIndex(this.text(c.msg).bytes));
          break;
        case 'GOTO_BLOCK':
          s.block = c.block;
          s.group = 0;
          s.pc = 0xffff;
          return 'next';
        case 'DUEL':
          await h.duel?.(c.a, c.b);
          break;
        case 'BATTLE_END':
          s.map = c.map;
          await h.battleEnd?.(c.map, peek() === 'GAME_OVER');
          break;
        case 'NEXT_CHAPTER':
          s.chapter++;
          s.stage = 0;
          s.block = 0;
          s.group = 0;
          h.stageChanged?.(s.chapter, s.stage);
          return 'next';
        case 'LEAVE_GROUP':
          this.advanceGroup();
          return 'next';
        case 'SET_FLAG':
          if (c.flag >= 0x100) h.log?.(`flag out of range ${c.flag}`);
          else setFlag(s, c.flag, c.clear === 0);
          break;
        case 'UNIT_ATTACK':
          for (const id of [c.a, c.b]) {
            const slot = this.charSlot(id);
            if (slot) slot.flags |= 2;
          }
          await h.unitAttack?.(c.a, c.b);
          break;
        case 'INPUT':
          // 0cf5:8f47: ctx+0x1bd = (operand == 0), i.e. 1 while the player may act (INPUT 0)
          s.savedInput = c.enable === 0 ? 1 : 0;
          h.setInputEnabled?.(c.enable !== 0);
          break;
        case 'REINFORCE':
          h.reinforce?.(c.officer);
          break;
        case 'ADD_ITEM':
          await h.addItem?.(c.item);
          break;
        case 'SET_AI':
          h.setAI?.(c.officer, c.algo, c.a, c.b);
          break;
        case 'SET_PREV_MAP':
          h.setPrevMap?.(c.map, c.x, c.y);
          break;
        case 'PLACE_TOWNSFOLK':
          h.placeTownsfolk?.();
          break;
        case 'SORTIE':
          h.setSortie?.(c.reset, c.officers);
          break;
        case 'IF':
          if (!this.evalIf(c)) skip = c.skip;
          break;
        case 'FORMATION':
          await h.formation?.(s);
          break;
        case 'SET_FORCE':
          h.setForce?.(c.officer, c.force);
          break;
        case 'CHOOSE': {
          const text = this.text(c.msg);
          const options = splitLines(text.bytes);
          const i = await h.choose(options);
          // 0cf5:9431: jump to the code of record (group start + choice + 1)
          const r = this.blockRecords[s.group + i + 1];
          if (!r) throw new Error(`CHOOSE: no record for choice ${i}`);
          this.selectRecord(r);
          break;
        }
        case 'MAP_CHIP':
          h.mapChip?.(c.a, c.b, c.c);
          break;
        case 'MAP_EFFECT':
          await h.mapEffect?.(c.a, c.b, c.c);
          break;
        case 'UNIT_FORCE':
          h.unitForce?.(c.officer, c.force);
          break;
        case 'GAME_OVER':
          await h.gameOver?.();
          return 'gameOver';
        case 'ENDING':
          await h.ending?.(c.value);
          return 'ending';
        case 'DATA':
          if (c.kind === 2) h.addGold?.(c.value);
          else if (c.kind === 4) h.battleData?.(c.value);
          break;
        case 'REDRAW':
          await h.redraw?.();
          break;
        case 'HALVE':
          h.halve?.(c.a, c.b);
          break;
        case 'SET_LEADER':
          h.setLeader?.(c.officer);
          break;
        case 'SET_CG':
          h.setCg?.(c.officer, c.cg);
          break;
        case 'OBJECTIVE': {
          const t = this.text(c.msg).bytes;
          s.objective.fill(0);
          s.objective.set(t.subarray(0, s.objective.length - 1));
          break;
        }
        case 'SET_LIST':
          s.list.fill(0);
          s.list[0] = c.values.length;
          s.list.set(c.values.slice(0, 32), 1);
          break;
        case 'BATTLE_OP33':
          await h.battleOp33?.();
          break;
        case 'BATTLE_OP34':
          await h.battleOp34?.();
          break;
        case 'BATTLE_OP35':
          await h.battleOp35?.(c.officer, c.value);
          break;
        case 'SAVE_STATE':
          h.saveState?.(writeEventSave(s));
          break;
        case 'OFFICER_FLAG':
          h.setOfficerFlag?.(c.officer, c.value !== 0);
          break;
        case 'MUSIC':
          s.music = c.song;
          h.playMusic?.(c.song);
          break;
        case 'ADD_STAT':
          h.addStat?.(c.officer, c.value);
          break;
        case 'SET_STAT':
          h.setStat?.(c.officer, c.value);
          break;
        case 'WALK_TO':
          await h.walkTo?.(c.x, c.y);
          break;
        case 'FOCUS':
          h.focus?.(c.officer);
          break;
        case 'SAVE_PROMPT':
          await h.savePrompt?.();
          break;
        case 'END':
          // 0cf5:9774: a non-resident group is done once one of its events ends
          if (!this.groupInfo().resident) {
            this.advanceGroup();
            return 'next';
          }
          return 'end';
        default: {
          const never: never = c;
          throw new Error(`unhandled command ${(never as Command).name}`);
        }
      }
    }
  }

  /**
   * Finds or allocates the slot of a character (0cf5:a2b2), after dropping the table if it
   * belongs to another map (the check at the start of 0cf5:9984 / 9a88 / 9cbc).
   */
  private charSlot(id: number): CharSlot | undefined {
    const s = this.state;
    if (s.charsArea !== s.area || s.charsMap !== s.map) {
      // "内部キャラバッファをクリアします"
      s.charsArea = s.area;
      s.charsMap = s.map;
      for (const ch of s.chars) Object.assign(ch, { id: 0xffff, flags: 0 });
      s.replaceChars = 0;
    }
    let free: CharSlot | undefined;
    for (const ch of s.chars) {
      if (ch.id === id) return ch;
      if (!free && ch.id === 0xffff) free = ch;
    }
    if (free) Object.assign(free, { id, x: 0xff, y: 0xff, flags: 0, dir: 0 });
    return free;
  }

  private battleSetup(c: Extract<Command, { name: 'BATTLE_SETUP' }>) {
    // 0cf5:8aa2
    const s = this.state;
    s.units = Array.from({ length: UNIT_SLOTS }, () => emptyUnit());
    s.battleB = c.b;
    s.battleC = c.c;
    s.hexFlag = c.hexFlag !== 0 ? 1 : 0;
    s.victory = { enabled: c.victoryEnabled !== 0, officer: c.victoryOfficer };
    s.defeat = { enabled: c.defeatEnabled !== 0, officer: c.defeatOfficer };
    let i = 0;
    for (const e of c.units) {
      if (e.officer === 0xffff || (e.condEnabled && !getFlag(s, e.condFlag))) continue;
      Object.assign(s.units[i++], { officer: e.officer, x: e.x, y: e.y, flags: e.flags });
    }
  }

  private battleUnits(c: Extract<Command, { name: 'BATTLE_UNITS' }>) {
    // 0cf5:91bd: drop the existing units of that side, then fill free slots
    const s = this.state;
    for (const u of s.units) {
      if (u.officer === 0xffff) continue;
      const enemy = (u.flags & 1) !== 0;
      if (enemy === (c.side === 0)) u.officer = 0xffff;
    }
    for (const e of c.units) {
      if ((e.condEnabled && !getFlag(s, e.condFlag)) || e.officer === 0xffff) continue;
      const u = s.units.find((x) => x.officer === 0xffff);
      if (!u) break;
      const kind = e.kind ?? 0;
      Object.assign(u, { officer: e.officer, x: e.x, y: e.y, flags: e.flags, kind, a: e.a, b: e.b });
      if (kind >= 3 && kind <= 6) u.param = e.param ?? 0;
    }
  }
}

/**
 * STAGE_TITLE's message is not a number but a character code: the first byte b with
 * b - 0x30 < 18 gives the title index ("00", "11" ... "::", "AA"; 0cf5:47b6).
 */
export function stageTitleIndex(bytes: Uint8Array): number {
  for (const b of bytes) if (b - 0x30 >= 0 && b - 0x30 < 0x12) return b - 0x30;
  return 0;
}

/** Splits a CHOOSE message at line breaks (0cf5:93be: runs of \n / \r separate options). */
export function splitLines(bytes: Uint8Array): Message[] {
  const out: Message[] = [];
  let start = 0;
  const dec = new TextDecoder('euc-kr');
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a || bytes[i] === 0x0d) {
      if (i > start) {
        const b = bytes.subarray(start, i);
        out.push({ bytes: b, text: dec.decode(b) });
      }
      start = i + 1;
    }
  }
  return out;
}

export type { BattleUnitEntry };
