// Scenario event scripts: SNRxD.R3 (event data, LS11) + SNRxM.R3 (messages, EUC-KR), the
// townsfolk tables IPPAN0.R3 / IPPAN0M.R3 and the event-state save ESAVEn.R3S.
// Format, opcode semantics and MAIN.EXE addresses: docs/SCRIPT.md (interpreter 0cf5:8794).

import { unpackLs11 } from './ls11';

// ---------------------------------------------------------------- commands

/** Operand letters: b = u8, w = u16, m = message id (u16), o = officer id (u16), f = flag number (u8). */
type FieldSpec = `${string}:${'b' | 'w' | 'm' | 'o' | 'f'}`;

/** Fixed-layout opcodes: [opcode, operands, MAIN.EXE handler offset in segment 0cf5]. */
export const FIXED_OPS = {
  TALK: [0x00, ['msg:m'], 0x8a10],
  MOVE: [0x01, ['officer:o', 'x:b', 'y:b', 'dir:b'], 0x8a32],
  MENU_ADD: [0x02, ['value:b'], 0x8a85],
  WEATHER: [0x04, [], 0x8bec],
  SCREEN_MAP: [0x05, [], 0x97cc],
  SCREEN_TEXT: [0x06, [], 0x8bf8],
  PICTURE: [0x07, ['picture:b', 'mode:b'], 0x8c03],
  NARRATE: [0x08, ['msg:m'], 0x8c22],
  MAP: [0x09, ['map:w'], 0x97d5],
  PLACE: [0x0a, ['officer:o', 'x:b', 'y:b', 'dir:b'], 0x8c7c],
  CAPTION: [0x0b, ['msg:m'], 0x8cb2],
  NOP_MSG: [0x0c, ['unused:w', 'msg:m'], 0x8ceb],
  TITLE: [0x0d, ['msg:m'], 0x8d21],
  STAGE_TITLE: [0x0e, ['msg:m'], 0x8d58],
  GOTO_BLOCK: [0x0f, ['block:b'], 0x8da7],
  DUEL: [0x10, ['a:o', 'b:o'], 0x8dd2],
  BATTLE_END: [0x11, ['map:w'], 0x8e18],
  NEXT_CHAPTER: [0x12, [], 0x8e6b],
  LEAVE_GROUP: [0x13, [], 0x97f6],
  SET_FLAG: [0x14, ['flag:f', 'clear:b'], 0x8e92],
  ASK: [0x15, ['answer:b', 'skip:b'], 0x8ec6],
  UNIT_ATTACK: [0x16, ['a:o', 'b:o'], 0x8f05],
  INPUT: [0x17, ['enable:b'], 0x8f47],
  REMOVE: [0x18, ['officer:o'], 0x8f6e],
  OP19: [0x19, ['value:w'], -1],
  REINFORCE: [0x1a, ['officer:o'], 0x8f82],
  ADD_ITEM: [0x1b, ['item:b'], 0x8fb2],
  SET_AI: [0x1c, ['officer:o', 'algo:b', 'a:b', 'b:b'], 0x8ff6],
  SET_PREV_MAP: [0x1d, ['map:w', 'x:b', 'y:b'], 0x9098],
  CLEAR_CHARS: [0x1e, [], 0x90c7],
  PLACE_TOWNSFOLK: [0x1f, [], 0x90d2],
  FORMATION: [0x23, [], 0x9341],
  SET_FORCE: [0x24, ['officer:o', 'force:b'], 0x9349],
  CHOOSE: [0x25, ['msg:m'], 0x9385],
  MAP_CHIP: [0x26, ['a:b', 'b:b', 'c:b'], 0x947d],
  MAP_EFFECT: [0x27, ['a:b', 'b:b', 'c:b'], 0x94b8],
  UNIT_FORCE: [0x28, ['officer:o', 'force:b'], 0x94f3],
  GAME_OVER: [0x29, [], 0x980e],
  ENDING: [0x2a, ['value:b'], 0x9826],
  DATA: [0x2b, ['kind:b', 'value:w'], 0x952d],
  REDRAW: [0x2c, [], 0x956d],
  HALVE: [0x2d, ['a:b', 'b:b'], 0x95a1],
  SET_LEADER: [0x2e, ['officer:o', 'a:b', 'b:b', 'c:b'], 0x95c3],
  SET_CG: [0x2f, ['officer:o', 'cg:b'], 0x95f0],
  OBJECTIVE: [0x30, ['msg:m'], 0x962c],
  OP31: [0x31, [], -1],
  BATTLE_OP33: [0x33, [], 0x968d],
  BATTLE_OP34: [0x34, [], 0x9698],
  BATTLE_OP35: [0x35, ['officer:o', 'value:b'], 0x96a3],
  SAVE_STATE: [0x36, [], 0x96bc],
  OFFICER_FLAG: [0x37, ['officer:o', 'value:b'], 0x96d9],
  MUSIC: [0x38, ['song:b'], 0x96f7],
  ADD_STAT: [0x39, ['officer:o', 'value:b'], 0x9712],
  SET_STAT: [0x3a, ['officer:o', 'value:b'], 0x972f],
  WALK_TO: [0x3b, ['x:b', 'y:b'], 0x9847],
  FOCUS: [0x3c, ['officer:o'], 0x974c],
  SAVE_PROMPT: [0x3d, ['suspend:b'], 0x975e],
  END: [0xff, [], 0x9774],
} as const satisfies Record<string, readonly [number, readonly FieldSpec[], number]>;

type FixedName = keyof typeof FIXED_OPS;
type FieldName<S> = S extends `${infer K}:${string}` ? K : never;
type FixedFields<N extends FixedName> = { [K in FieldName<(typeof FIXED_OPS)[N][1][number]>]: number };

interface CommandBase {
  /** Offset of the opcode within the stage data. */
  offset: number;
  /** Size in bytes including the opcode. */
  size: number;
  op: number;
}

export type FixedCommand = { [N in FixedName]: CommandBase & { name: N } & FixedFields<N> }[FixedName];

/** One unit slot of BATTLE_SETUP (9 bytes) / BATTLE_UNITS (13 bytes). */
export interface BattleUnitEntry {
  officer: number; // 0xffff = empty slot; 0x400 = generic soldier (inferred)
  x: number;
  y: number;
  /** Flag word stored at unit+4: bit0 = enemy side (side byte == 0), bit1, bit2 (see docs/SCRIPT.md). */
  flags: number;
  /** When set, the entry is only used if scenario flag `condFlag` is set. */
  condEnabled: boolean;
  condFlag: number;
  raw: number[];
  // BATTLE_UNITS only:
  kind?: number;
  param?: number;
  a?: number;
  b?: number;
}

export interface BattleSetupCommand extends CommandBase {
  name: 'BATTLE_SETUP';
  hexFlag: number; // -> ctx+0x1cb (= value != 0)
  b: number; // -> ctx+0x3c6
  c: number; // -> ctx+0x3c7
  unused: number;
  victoryEnabled: number; // -> ctx+0x3bc (!= 0)
  victoryOfficer: number; // -> ctx+0x3be
  unused2: number;
  defeatEnabled: number; // -> ctx+0x3c0 (!= 0)
  defeatOfficer: number; // -> ctx+0x3c2
  units: BattleUnitEntry[]; // 30 entries
}

export interface BattleUnitsCommand extends CommandBase {
  name: 'BATTLE_UNITS';
  /** 0 = enemy army (unit flag bit0 set), else allied; existing units of that side are removed first. */
  side: number;
  units: BattleUnitEntry[]; // 30 entries
}

export interface SortieCommand extends CommandBase {
  name: 'SORTIE';
  reset: boolean;
  officers: number[];
}

export interface IfCommand extends CommandBase {
  name: 'IF';
  /** Number of following commands skipped when the condition is false. */
  skip: number;
  set: number[];
  clear: number[];
}

export interface SetListCommand extends CommandBase {
  name: 'SET_LIST';
  values: number[];
}

export type Command = FixedCommand | BattleSetupCommand | BattleUnitsCommand | SortieCommand | IfCommand | SetListCommand;
export type CommandName = Command['name'];

const BY_OPCODE = new Map<number, [FixedName, readonly FieldSpec[]]>();
for (const [name, [op, fields]] of Object.entries(FIXED_OPS)) BY_OPCODE.set(op, [name as FixedName, fields]);

/** Opcodes with a MAIN.EXE handler or a parse rule; anything else is an unknown opcode. */
export function isKnownOpcode(op: number): boolean {
  return BY_OPCODE.has(op) || op === 0x03 || op === 0x20 || op === 0x21 || op === 0x22 || op === 0x32;
}

export class ScenarioFormatError extends Error {}

const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);

/** Instruction size (opcode included). Variable-size rules follow the handlers, see docs/SCRIPT.md. */
export function commandSize(d: Uint8Array, o: number): number {
  const op = d[o];
  switch (op) {
    case 0x03:
      return 1 + 11 + 30 * 9;
    case 0x22:
      return 1 + 1 + 30 * 13;
    case 0x20:
      return 2 + (d[o + 1] & 0x7f);
    case 0x21: {
      const n1 = d[o + 2];
      return 3 + n1 + 1 + d[o + 3 + n1];
    }
    case 0x32:
      return 2 + d[o + 1];
  }
  const spec = BY_OPCODE.get(op);
  if (!spec) throw new ScenarioFormatError(`unknown opcode 0x${op.toString(16)} at 0x${o.toString(16)}`);
  return 1 + spec[1].reduce((n, f) => n + (/:[wmo]$/.test(f) ? 2 : 1), 0);
}

function parseUnit(d: Uint8Array, q: number, long: boolean, side = 0): BattleUnitEntry {
  const officer = u16(d, q);
  if (!long) {
    // MAIN.EXE 0cf5:8b46: id, x, y, side, condEnable, condFlag, f4, f2
    const [x, y, side, cen, cfl, f4, f2] = d.subarray(q + 2, q + 9);
    const flags = (f4 === 1 ? 4 : 0) | (f2 >= 1 ? 2 : 0) | (side === 0 ? 1 : 0);
    return { officer, x, y, flags, condEnabled: cen !== 0, condFlag: cfl, raw: Array.from(d.subarray(q, q + 9)) };
  }
  // MAIN.EXE 0cf5:9200: id, x, y, condEnable, condFlag, f4, f2, kind, param(w), a, b
  const [x, y, cen, cfl, f4, f2, kind] = d.subarray(q + 2, q + 9);
  return {
    officer, x, y,
    flags: (f4 === 1 ? 4 : 0) | (f2 >= 1 ? 2 : 0) | (side === 0 ? 1 : 0),
    condEnabled: cen !== 0, condFlag: cfl, raw: Array.from(d.subarray(q, q + 13)),
    kind, param: u16(d, q + 9), a: d[q + 11], b: d[q + 12],
  };
}

/** Decodes the command at `o`. Throws ScenarioFormatError on an unknown opcode. */
export function parseCommand(d: Uint8Array, o: number): Command {
  const op = d[o];
  const size = commandSize(d, o);
  const base = { offset: o, size, op };
  const p = o + 1;
  switch (op) {
    case 0x03: {
      const units: BattleUnitEntry[] = [];
      for (let i = 0; i < 30; i++) units.push(parseUnit(d, p + 11 + i * 9, false));
      return {
        ...base, name: 'BATTLE_SETUP', hexFlag: d[p], b: d[p + 1], c: d[p + 2], unused: d[p + 3],
        victoryEnabled: d[p + 4], victoryOfficer: u16(d, p + 5), unused2: d[p + 7],
        defeatEnabled: d[p + 8], defeatOfficer: u16(d, p + 9), units,
      };
    }
    case 0x22: {
      const units: BattleUnitEntry[] = [];
      for (let i = 0; i < 30; i++) units.push(parseUnit(d, p + 1 + i * 13, true, d[p]));
      return { ...base, name: 'BATTLE_UNITS', side: d[p], units };
    }
    case 0x20:
      return { ...base, name: 'SORTIE', reset: (d[p] & 0x80) !== 0, officers: Array.from(d.subarray(p + 1, p + 1 + (d[p] & 0x7f))) };
    case 0x21: {
      const n1 = d[p + 1];
      const n2 = d[p + 2 + n1];
      return {
        ...base, name: 'IF', skip: d[p],
        set: Array.from(d.subarray(p + 2, p + 2 + n1)),
        clear: Array.from(d.subarray(p + 3 + n1, p + 3 + n1 + n2)),
      };
    }
    case 0x32:
      return { ...base, name: 'SET_LIST', values: Array.from(d.subarray(p + 1, p + 1 + d[p])) };
  }
  const [name, fields] = BY_OPCODE.get(op)!;
  const cmd: Record<string, number | string> = { ...base, name };
  let q = p;
  for (const f of fields) {
    const [k, t] = f.split(':');
    if (t === 'w' || t === 'm' || t === 'o') {
      cmd[k] = u16(d, q);
      q += 2;
    } else cmd[k] = d[q++];
  }
  return cmd as unknown as FixedCommand;
}

/** Message id referenced by a command (TALK, NARRATE, CAPTION, TITLE, STAGE_TITLE, CHOOSE, OBJECTIVE, NOP_MSG). */
export function commandMessage(c: Command): number | undefined {
  return 'msg' in c ? c.msg : undefined;
}

// ---------------------------------------------------------------- event data (SNRxD)

export const TRIGGERS = {
  0: 'auto',
  1: 'default',
  2: 'location',
  3: 'talk',
  4: 'adjacent',
  5: 'destination',
  6: 'unitAt',
  7: 'targetDefeated',
  8: 'leaderDefeated',
  9: 'turn',
  11: 'unitInArea',
  12: 'unitDefeated',
} as const;

/** One 10-byte event record of a block. */
export interface EventRecord {
  /** Index within the block's record list (the value kept at ctx+6 / used by CHOOSE). */
  index: number;
  trigger: number;
  group: number;
  /** Bit 7 of byte 1: the group stays current after an event of it ends (left with LEAVE_GROUP). */
  resident: boolean;
  p1: number;
  p2: number;
  p3: number;
  /** Absolute offset of the event code in the stage data. */
  code: number;
}

export interface Block {
  index: number;
  offset: number;
  records: EventRecord[];
  /** Record index of the first record of every group, in order. */
  groupStarts: number[];
}

export interface Stage {
  chapter: number;
  index: number;
  data: Uint8Array;
  blocks: Block[];
  /** Every command of the stage keyed by its offset. */
  commands: Map<number, Command>;
}

function parseStage(chapter: number, index: number, d: Uint8Array): Stage {
  const offsets: number[] = [];
  for (let o = 0; ; o += 2) {
    const v = u16(d, o);
    if (v === 0xffff) break;
    offsets.push(v);
  }
  const commands = new Map<number, Command>();
  const blocks = offsets.map((bo, bi): Block => {
    const records: EventRecord[] = [];
    for (let o = bo; d[o] !== 0xff; o += 10) {
      records.push({
        index: records.length, trigger: d[o], group: d[o + 1] & 0x7f, resident: (d[o + 1] & 0x80) !== 0,
        p1: u16(d, o + 2), p2: u16(d, o + 4), p3: u16(d, o + 6), code: bo + u16(d, o + 8),
      });
    }
    const groupStarts = records.filter((r, i) => i === 0 || records[i - 1].group !== r.group).map((r) => r.index);
    // Code follows the record table; sweep it linearly up to the next block.
    const end = bi + 1 < offsets.length ? offsets[bi + 1] : d.length;
    if (records.length) {
      let o = Math.min(...records.map((r) => r.code));
      while (o < end) {
        const c = parseCommand(d, o);
        commands.set(o, c);
        o += c.size;
      }
      if (o !== end) throw new ScenarioFormatError(`block ${bi}: code overruns block end`);
      for (const r of records)
        if (!commands.has(r.code)) throw new ScenarioFormatError(`block ${bi} record ${r.index}: code 0x${r.code.toString(16)} is not on a command boundary`);
    }
    return { index: bi, offset: bo, records, groupStarts };
  });
  return { chapter, index, data: d, blocks, commands };
}

// ---------------------------------------------------------------- messages (SNRxM)

const eucKr = new TextDecoder('euc-kr');

export function decodeEucKr(bytes: Uint8Array): string {
  return eucKr.decode(bytes);
}

export interface Message {
  bytes: Uint8Array;
  text: string;
}

export interface TalkLine extends Message {
  /** Officer index (0 = Liu Bei ...), i.e. the record DS:0x7a94 + id*0x2c. */
  speaker: number;
}

export class MessageFile {
  /** Absolute file offset of every stage's message area. */
  readonly bases: number[];

  constructor(readonly data: Uint8Array) {
    const n = u16(data, 0) >> 1;
    this.bases = [];
    for (let i = 0; i < n; i++) {
      let b = u16(data, i * 2);
      // The table is 16-bit; MAIN.EXE 0cf5:7b30 hard-codes +0x10000 for the bases 0x59d0 and 0x1029
      // (SNR3M stages 3 and 4). Equivalent rule: a base below its predecessor has wrapped.
      while (i > 0 && b < this.bases[i - 1]) b += 0x10000;
      this.bases.push(b);
    }
  }

  private cstr(o: number): [Uint8Array, number] {
    let e = o;
    while (e < this.data.length && this.data[e] !== 0) e++;
    return [this.data.subarray(o, e), e + 1];
  }

  /** A plain message (NARRATE, CAPTION, TITLE, CHOOSE, OBJECTIVE ...). */
  text(stage: number, id: number): Message {
    const [bytes] = this.cstr(this.bases[stage] + id);
    return { bytes, text: decodeEucKr(bytes) };
  }

  /** A TALK message: (u16 speaker, NUL-terminated text)* terminated by speaker 0xffff. */
  talk(stage: number, id: number): TalkLine[] {
    const out: TalkLine[] = [];
    let p = this.bases[stage] + id;
    for (;;) {
      const speaker = u16(this.data, p);
      p += 2;
      if (speaker === 0xffff) return out;
      const [bytes, next] = this.cstr(p);
      out.push({ speaker, bytes, text: decodeEucKr(bytes) });
      p = next;
    }
  }
}

export interface Chapter {
  index: number;
  stages: Stage[];
  messages: MessageFile;
}

/** Parses SNR{chapter}D.R3 and SNR{chapter}M.R3. */
export function parseChapter(chapter: number, dFile: Uint8Array, mFile: Uint8Array): Chapter {
  const stages = unpackLs11(dFile).map((d, i) => parseStage(chapter, i, d));
  return { index: chapter, stages, messages: new MessageFile(mFile) };
}

/** Stage titles shown by STAGE_TITLE (MAIN.EXE DS:0x24fe: 18 pointers to EUC-KR strings). */
export function readStageTitles(mainExe: Uint8Array): string[] {
  const ds = 0x6a00 + 0x313a0;
  const out: string[] = [];
  for (let i = 0; i < 18; i++) {
    const p = ds + u16(mainExe, ds + 0x24fe + i * 2);
    let e = p;
    while (mainExe[e]) e++;
    out.push(decodeEucKr(mainExe.subarray(p, e)));
  }
  return out;
}

// ---------------------------------------------------------------- townsfolk (IPPAN0 / IPPAN0M)

export interface TownsfolkGroup {
  /** Matched against the game state's location byte (0x7a6c+6) in event maps, 0x7d otherwise. */
  key: number;
  people: number[];
}

export interface TownsfolkSection {
  /** Placement groups per town (index = town number, byte 0x7a6c+4). */
  towns: TownsfolkGroup[][];
  /** Message of townsperson n (the char id is n | 0x400); null where the table holds 0xffff. */
  messages: (Message | null)[];
}

/**
 * IPPAN0.R3 holds 4 sections (MAIN.EXE DS:0x393a lengths, DS:0x3942 u32 offsets), selected by
 * table DS:0x0ebc[chapter] = [0,0,1,2,3]; IPPAN0M.R3 section bases are at DS:0x2dd0.
 * Section: u8 townCount, u16 table[]: townCount placement offsets (relative to section+1, 0 = none),
 * then the message count M, then M message offsets into the IPPAN0M section (0xffff = none).
 * Placement (1cb6:2d38): table[town] -> u8 n, n x {u8 key, u8 count, u16 person[count]}.
 * Messages (0cf5:c51a): table[townCount + 1 + person] -> offset in the IPPAN0M section.
 */
export function parseTownsfolk(ippan: Uint8Array, ippanM: Uint8Array, mainExe: Uint8Array): TownsfolkSection[] {
  const ds = 0x6a00 + 0x313a0;
  const out: TownsfolkSection[] = [];
  for (let s = 0; s < 4; s++) {
    const len = u16(mainExe, ds + 0x393a + s * 2);
    const off = u16(mainExe, ds + 0x3942 + s * 4) | (u16(mainExe, ds + 0x3944 + s * 4) << 16);
    const mBase = u16(mainExe, ds + 0x2dd0 + s * 4) | (u16(mainExe, ds + 0x2dd2 + s * 4) << 16);
    const sec = ippan.subarray(off, off + len);
    const n = sec[0];
    const entry = (i: number) => u16(sec, 1 + 2 * i);
    const towns: TownsfolkGroup[][] = [];
    for (let t = 0; t < n; t++) {
      const groups: TownsfolkGroup[] = [];
      const o = entry(t);
      if (o) {
        let q = 1 + o;
        const cnt = sec[q++];
        for (let g = 0; g < cnt; g++) {
          const key = sec[q], c = sec[q + 1];
          q += 2;
          const people: number[] = [];
          for (let k = 0; k < c; k++, q += 2) people.push(u16(sec, q));
          groups.push({ key, people });
        }
      }
      towns.push(groups);
    }
    // table[townCount] = message count; then one offset per townsperson (0xffff = none).
    const count = entry(n);
    const messages: (Message | null)[] = [];
    for (let i = 0; i < count; i++) {
      const mo = entry(n + 1 + i);
      if (mo === 0xffff) {
        messages.push(null);
        continue;
      }
      let e = mBase + mo;
      while (e < ippanM.length && ippanM[e]) e++;
      const bytes = ippanM.subarray(mBase + mo, e);
      messages.push({ bytes, text: decodeEucKr(bytes) });
    }
    out.push({ towns, messages });
  }
  return out;
}

// ---------------------------------------------------------------- event-state save (ESAVEn.R3S)

/** Size of the serialised script context (MAIN.EXE 0cf5:7e4a / 0cf5:7f38). */
export const EVENT_SAVE_SIZE = 0x559;
