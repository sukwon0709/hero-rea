// Battle-mode text: the original's format strings are read from MAIN.EXE at run time (nothing is
// copied into the repo) and formatted with a small printf that works on EUC-KR bytes.
//
// String addresses are DGROUP offsets (`DS:xxxx`) as used by the routines named in scene.ts.

import { readDgroup } from '../../engine/battle/types';
import type { Message } from '../../formats/scenario';

/** NUL-terminated EUC-KR bytes at DS:`off`. */
export function dsBytes(main: Uint8Array, off: number): Uint8Array {
  const b = readDgroup(main, off, 0x200);
  const n = b.indexOf(0);
  return b.slice(0, n < 0 ? b.length : n);
}

export function dsWord(main: Uint8Array, off: number): number {
  const b = readDgroup(main, off, 2);
  return b[0] | (b[1] << 8);
}

/** Entry i of a table of near pointers (2 bytes) or far pointers (4 bytes, offset first) at DS:`table`. */
export function dsTable(main: Uint8Array, table: number, i: number, far = false): Uint8Array {
  return dsBytes(main, dsWord(main, table + i * (far ? 4 : 2)));
}

let eucTable: Map<string, number> | null = null;

/** EUC-KR encoding of a string (ASCII and KS X 1001 only). */
export function euc(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) {
      out.push(c);
      continue;
    }
    if (!eucTable) {
      eucTable = new Map();
      const pairs = new Uint8Array(94 * 94 * 2);
      let p = 0;
      for (let a = 0xa1; a <= 0xfe; a++) for (let b = 0xa1; b <= 0xfe; b++) (pairs[p++] = a), (pairs[p++] = b);
      [...new TextDecoder('euc-kr').decode(pairs)].forEach((k, i) => {
        if (k !== '�' && !eucTable!.has(k)) eucTable!.set(k, ((0xa1 + Math.floor(i / 94)) << 8) | (0xa1 + (i % 94)));
      });
    }
    const k = eucTable.get(ch);
    if (k === undefined) out.push(0x3f);
    else out.push(k >> 8, k & 0xff);
  }
  return Uint8Array.from(out);
}

export type FmtArg = number | Uint8Array | string;

/**
 * The subset of C printf the battle strings use: %s, %u, %d, %w (word), with an optional width
 * (right-aligned, space padded). Arguments that are strings are encoded with euc().
 */
export function fmt(f: Uint8Array, ...args: FmtArg[]): Uint8Array {
  const out: number[] = [];
  let a = 0;
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (c !== 0x25 || i + 1 >= f.length) {
      out.push(c);
      continue;
    }
    let j = i + 1;
    let width = 0;
    while (f[j] >= 0x30 && f[j] <= 0x39) width = width * 10 + f[j++] - 0x30;
    const conv = f[j];
    i = j;
    if (conv === 0x25) {
      out.push(0x25);
      continue;
    }
    const v = args[a++] ?? 0;
    let piece: Uint8Array;
    if (conv === 0x73) piece = typeof v === 'string' ? euc(v) : typeof v === 'number' ? euc(String(v)) : v;
    else piece = euc(String(typeof v === 'number' ? (conv === 0x64 ? v | 0 : v >>> 0) : 0));
    for (let k = piece.length; k < width; k++) out.push(0x20);
    out.push(...piece);
  }
  return Uint8Array.from(out);
}

export function msg(bytes: Uint8Array): Message {
  return { bytes, text: new TextDecoder('euc-kr').decode(bytes) };
}

/** Message strings used by the battle code (DS offsets). */
export const S = {
  turnBanner: 0x3dc1, // '제 %u턴 %s' (4b52)
  weatherNames: 0x3a4c, // near pointers by weather type
  timeout: 0x3da3, // 4b52
  bonusExp: 0x3d66, // 4a30
  playerPhase: 0x3d20, // 44de
  enemyPhase: 0x3ba8, // 3f32
  autoAbort: 0x3bb2, // 3f32
  endTurnAsk: 0x3d1c, // 44de, pointer
  retreatAsk: 0x3d1e, // 44de, pointer
  retreatNo: 0x3d2e,
  quitAsk: 0x3d4f,
  battleMenu: 0x3aa0, // far pointers, 9 shown
  closeupMenu: 0x3b44, // 본다 / 안 본다
  speedMenu: 0x3b64, // 1속..5속
  lostNarration: 0x4171, // 8504
  retreated: 0x41b9,
  killed: 0x41cc,
  lv: 0x41df,
  hpFrac: 0x41e7,
  commands: 0x430c, // far pointers: '', 공격, 책략, 도구, 대기, 개문 ...
  ambushMenu: 0x4866,
  ambushAsk: 0x48aa,
  noTactics: 0x488a,
  itemOps: 0x4346, // 사용한다 준다 버린다 본다
  noItems: 0x48bd,
  gave: 0x48d8,
  giveFull: 0x48f0,
  dropped: 0x4916,
  rainNoFire: 0x4a80,
  mpShort: 0x4b84,
  confuseEnemy: 0x4ad2,
  bombAttack: 0x4b3c, // 폭탄으로 적을 공격합니다
  bombThrow: 0x4b55, // 폭탄을 던져라!
  alreadyConfused: 0x4ae5,
  notUsable: 0x4b64,
  confused: 0x4287,
  moreConfused: 0x429d,
  moraleLost: 0x42bb,
  allyNone: 0x3ec1,
  enemyNone: 0x3edb,
  isEnemy: 0x3ef7,
  isAlly: 0x3f07,
  outOfRange: 0x3f21,
  outOfAttackRange: 0x3f33,
  notMoveRange: 0x4d3c,
  notOurs: 0x4d51,
  notControllable: 0x4d66,
  confusedNoCmd: 0x4d80,
  alreadyActed: 0x4da2,
  tacticUsed: 0x4b9e,
  usedItem: 0x4abf,
  moraleDown: 0x4c22,
  stillConfused: 0x4c75,
  healedArea: 0x4cc2,
  noAllyInRange: 0x4cde,
  troops: 0x4214, // 병력
  morale: 0x4219, // 사기치
  attack: 0x4220, // 공격력
  defence: 0x4227, // 방어력
  mp: 0x422e, // 책략치
  exp: 0x4256, // 경험치
  army: 0x3eb0, // '군'
  offField: 0x3eb6, // '-전선이탈-'
  tactics: 0x4438, // far pointers, 36 tactic names
  classNames: 0x0fd8, // near pointers, 19 class names
} as const;
