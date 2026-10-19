# Scenario / event system

How `MAIN.EXE` stores, selects and runs story events, and how the TypeScript port replays them.

Addresses are image `seg:off` (load segment 0). The Ghidra segment is the image segment + 0x1000, so
`0cf5:7a86` is Ghidra `1cf5:7a86`. DGROUP is image segment `0x313A`: `DS:X` is at file offset
`0x6A00 + 0x313A0 + X` of `MAIN.EXE`. Calling convention is MS C 7 large model, pascal-like (callee pops).
Anything marked *(inferred)* comes from how the data is used, not from a handler that was read fully.

Code:

| File | What |
|---|---|
| `tools/snrdis.py` | Disassembler: `python3 -I tools/snrdis.py GAME_DIR [chapter [stage]] [--no-text]` |
| `web/src/formats/scenario.ts` | Parsers for SNRxD/SNRxM, IPPAN0/IPPAN0M, stage titles |
| `web/src/engine/script.ts` | `ScriptVM` interpreter, `ScriptHost` interface, ESAVE read/write |
| `web/test/scenario.test.ts`, `web/test/script.test.ts` | Tests (skip without `HERO_GAME_DIR`) |

## Files

| File | Format |
|---|---|
| `SNR0D.R3`..`SNR4D.R3` | LS11 archive, one entry per *stage*; event code (below) |
| `SNR0M.R3`..`SNR4M.R3` | Raw (not LS11) message file, EUC-KR text |
| `IPPAN0.R3` / `IPPAN0M.R3` | Townsfolk ("일반" = generic people) placement tables and messages |
| `IPPAN0.DMP` | Text hex dump of `IPPAN0.R3` (`Start:000000 Total:3640bytes`); unused by the game |
| `IPPAN.DMP` | Text hex dump of the original Japanese (Shift-JIS) townsfolk messages; a development leftover, unused |
| `ESAVE0..4.R3S` | Serialised script context (0x559 bytes), see [Event save](#event-save-esavenr3s) |

Chapters (= SNR digit) have `[1, 5, 4, 5, 3]` stages; 14132 commands in total.

### Loader (`0cf5:7a86`)

* Builds `"A:SNRxD.R3"` (template `DS:0x2250`) and `"A:SNRxM.R3"` (`DS:0x225c`) from `ctx.chapter`.
* Loads LS11 entry `ctx.stage` of the D file into the buffer whose handle is `ctx+0xc`.
* Reads the u16 at offset `ctx.stage*2` of the M file into `ctx+0x3c4` (message base).
* `0cf5:7b30` reads a message: seeks to `base + msgId`, reads 0x400 bytes; `0cf5:7bac` copies the
  zero-terminated EUC-KR string. SNR3M is over 64 KiB: `7b30` hard-codes `+0x10000` for bases `0x59d0`
  and `0x1029` (chapter 3, stages 3 and 4). The general rule used by the port: a base smaller than its
  predecessor has wrapped (chapter 3 bases: `0xa, 0x558d, 0xa32a, 0x11029, 0x159d0`).

### D file entry (one stage)

```
u16 blockOffset[]  terminated by 0xffff            (offsets from entry start)
block:
  record[]  10 bytes each, terminated by a 0xff byte:
    u8  trigger
    u8  group        bit7 = resident (group stays active, see Flow)
    u16 p1, p2, p3   trigger parameters
    u16 code         offset of the event code, relative to the block start
  code               commands, up to the next block
```

A linear sweep from the lowest record `code` offset to the next block parses exactly into commands in every
stage, and every record offset lands on a command boundary (checked by `parseStage` and the tests).

### M file

`u16 stageBase[stageCount]` then strings. A message id in a command is relative to the stage base.
TALK messages are a list of `(u16 speaker, string)` pairs ending with speaker `0xffff` *(layout as parsed by
`MessageFile.talk`; all 14132 commands resolve with no decoding errors)*.

### Text control codes

The text renderer (`0cf5:28b6` / `27c0`) handles only `'\n'` (line break). `'\r'` is ignored, so the
`"\r\n"` pairs in the files are one line break. Lines wrap automatically at the window width and long text
pages (wait for click). No other control codes occur in any SNR*M or IPPAN0M string. Verified in the
emulator: the second prologue narration breaks after "시작했다." where the data has `\r\n`.

Speaker ids index the officer table `DS:0x7a94` (0x2c bytes per officer, name at +6, read by `0cf5:4374`);
`id | 0x200` means "officer handle" and `id | 0x400` means a townsperson in trigger parameters.

## Script context (`DS:0xd4dc`)

| Offset | Size | Meaning |
|---|---|---|
| +0x0 | 2 | chapter (SNR digit) |
| +0x2 | 2 | stage (LS11 entry, M-file base index) |
| +0x4 | 2 | block |
| +0x6 | 2 | group start: record index of the current group |
| +0x8 | 2 | area |
| +0xa | 2 | map id; high nibble (`ctx+0xb & 0xf0`) = map kind: 0 town, 1 world, 2 event scene, 3 hex battle |
| +0xc | 2 | buffer handle of the loaded D entry |
| +0x11 | 32 | event flags: flag n = byte `n>>3`, mask `0x80 >> (n&7)` (256 flags) |
| +0x31 | 62×6 | characters on the map: `{u16 id, x, y, flags (bit1 moving), dir (operand×2)}` |
| +0x1a5 / +0x1a7 | 2+2 | area / map the character table belongs to (table reset on map change) |
| +0x1a9 | 2 | record iterator |
| +0x1ab | 10 | copy of the current record |
| +0x1b5 | 2 | PC (offset in block) |
| +0x1b7 | 2 | status: 0 idle, 1 suspended (resume at PC, "イベント継続"), 2 waiting for moves |
| +0x1bb | 2 | replace-chars flag |
| +0x1bd | 2 | saved input enable |
| +0x1bf | 2 | music |
| +0x1cb | 2 | hex flag (BATTLE_SETUP header) |
| +0x1cd | 45×11 | battle units: `{u16 officer, x, y, u16 flags (bit0 enemy, bit1/bit2 see 0x03), kind, u16 param, a, b}` |
| +0x3bc / +0x3be | 2+2 | victory target: enabled, officer |
| +0x3c0 / +0x3c2 | 2+2 | defeat target: enabled, officer |
| +0x3c4 | 2 | message base of the stage |
| +0x3c6 / +0x3c7 | 1+1 | battle bytes from BATTLE_SETUP |
| +0x3c8 | 0x181 | objective string (OBJECTIVE) |
| +0x549 | 1+32 | SET_LIST: count + bytes |

`ScriptState` in `script.ts` mirrors this with named fields.

### Event save (`ESAVEn.R3S`)

0x559 bytes, written by `0cf5:7e4a`, read by `0cf5:7f38` / `7fe0`:

| File offset | Size | Context |
|---|---|---|
| 0x000 | 0xc | +0x0..+0xb |
| 0x00c | 2 | +0x1a5 |
| 0x00e | 2 | +0x1a7 |
| 0x010 | 0x174 | characters (+0x31) |
| 0x184 | 0x22 | +0x1a9..+0x1ca |
| 0x1a6 | 0x1ef | units (+0x1cd) |
| 0x395 | 0x20 | flags (+0x11) |
| 0x3b5 | 0x21 | list (+0x549) |
| 0x3d6 | 0x181 | objective (+0x3c8) |
| 0x557 | 1 | +0x3c6 |
| 0x558 | 1 | +0x3c7 |

Not saved: victory/defeat targets, hex flag, message base (recomputed by the loader / next BATTLE_SETUP).
`readEventSave`/`writeEventSave` round-trip all five shipped saves byte for byte. ESAVE0 = chapter 0 stage 0
block 4 group 2, PC 0x3de, flag 0 set. The file-name table at `DS:0x2a48` (built by `0cf5:ae76`) is
`MSAVE0.R3S, ESAVE0.R3S, IPPAN0.R3, IPPAN0M.R3, MSAVE0.R3M, ESAVE0.R3M`.

## Event selection

`0cf5:81fe..85e0` (via `817c` / `a312`). Only records of the current group (starting at `ctx+6`; `0cf5:7a2a`
returns the group's record count and the resident bit of its first record) are candidates. The first record
whose predicate matches runs; trigger 1 always matches. For trigger 0 (`0cf5:a088`): when the group is
resident and its code starts with IF, that IF is evaluated first (`8794` mode 1) to decide whether it fires.

| Trigger | Name (`TRIGGERS`) | Matches when |
|---|---|---|
| 0 | auto | group is not resident, or the leading IF holds |
| 1 | always | always |
| 2 | location | `p1 == spot && p2 == town` (town = `byte DS:0x7a6c+4`) |
| 3 | talk | talking to officer `p1` |
| 4 | adjacent | officer `p2` next to `p1` |
| 5 | town | entering town `p1` on the world map |
| 6 | unitAt | unit `p1` at `p2 = y<<8 | x` |
| 7 | targetDefeated | victory officer defeated (`0cf5:86b8`) |
| 8 | leaderDefeated | defeat officer defeated |
| 9 | turn | turn `== p1` (battle-state byte +2, plus 1) |
| 0xb | unitInArea | unit `p1` inside rectangle `p2..p3` (each `y<<8 | x`) |
| 0xc | unitDefeated | unit `p1` defeated |

Officer `0x400` in a parameter means "any generic soldier" (fallback). Callers: town loop `0cf5:e89e`
(kind 0 auto, 1 talk, 2 location) and the battle loops `1cb6:85b3`, `1cb6:8b47`, `1cb6:4be4`.

## Flow

* END (`0xff`, `0cf5:9774`): if the group is not resident, `9f68` advances `ctx+6` past the group (by its record
  count). Past the last group, `a348` does block++; past the block table, `a3d2` does stage++, block 0 and reloads.
  A resident group stays current (e.g. the camp talk group before a battle).
* LEAVE_GROUP (`0x13`): explicit advance, as END on a non-resident group.
* GOTO_BLOCK b: block = b, group = 0, PC = -1, stop.
* NEXT_CHAPTER (`0x12`, `0cf5:9f56`): chapter++, stage 0; `b272` reloads BBKSDAT1 for the new chapter.
* IF / ASK skip counts are *instruction counts*. The skip loop (`0cf5:8813`) uses the length table `DS:0x2522`,
  which is wrong for 0x1d (2 instead of 4) and has no entry for 0xff. No skip range in the data contains 0x1d or
  END (test `keeps conditional skips inside the event`), so this never matters.
* Interpreter return codes: 0/1 finished, 2 map change, 5 moves pending, 6 still moving, 7 game over, 8 ending.
  Commands that set status 1 (MAP, SCREEN_MAP, WALK_TO, SAVE_PROMPT b≠0) suspend the event; the main loop
  redraws and resumes at the saved PC on the next dispatch.

## Opcodes

Handlers are in segment `0cf5`. `o` = u16 officer, `w` = u16, `b` = u8, `m` = u16 message id. Opcode names
come from the Shift-JIS debug strings at `DS:0x2559..0x2917` where present, otherwise they are descriptive.

| Op | Name | Operands | Handler | Semantics |
|---|---|---|---|---|
| 00 | TALK | m | 8a10 → 98f6 | Message box per (speaker, text) line; portrait + name. If the next op is ASK, nothing is shown here |
| 01 | MOVE | o x y dir | 8a32 / 9a88 | Walk character; consecutive MOVEs are started together, then the VM waits (status 2) |
| 02 | MENU_ADD | b | 8a85 → 9e74 | *(inferred)* enables a menu/command entry |
| 03 | BATTLE_SETUP | 0x119 bytes | 8aa2 | Header: hexFlag, b→+0x3c6, b→+0x3c7, unused, victoryEn, w victory, unused, defeatEn, w defeat; then 30 × `{w id, x, y, side (0 = enemy → flags bit0), condEn, condFlag, a (==1 → bit2), b (≥1 → bit1)}`. Units are memset 0xff then filled in order; an entry with condEn whose flag is clear is skipped |
| 04 | WEATHER | – | 8bec | no-op |
| 05 | SCREEN_MAP | – | 97cc / 987c | `cad8(1,1)` redraw map, status 1 (yields) |
| 06 | SCREEN_TEXT | – | 8bf8 | unused in data |
| 07 | PICTURE | b pic, b mode | 8c03 → cd58 | Event picture window; closed (`ce78`) before any following command other than NARRATE |
| 08 | NARRATE | m | 8c22 → c15a | Speaker-less text box |
| 09 | MAP | w | 97d5 | `ctx.map = w`, status 1, return 2 (map change) |
| 0a | PLACE | o x y dir | 8c7c / 9984 | Put character on map |
| 0b | CAPTION | m | 8cb2 → cf04 → 3c5e | Small notice ("낙양 궁전", "금 100을 손에 넣었다!") |
| 0c | NOP_MSG | w m | 8ceb | no-op |
| 0d | TITLE | m | 8d21 → c340 | Text in the bottom status-bar title box |
| 0e | STAGE_TITLE | m | 8d58 → 47b6 | Index = first byte of message − 0x30 (strings are "00", "11", …, "::", …, "AA"); title pointers `DS:0x24fe` (18) |
| 0f | GOTO_BLOCK | b | 8da7 | see Flow |
| 10 | DUEL | o o | 8dd2 → 2cb4:09d2 | One-on-one duel |
| 11 | BATTLE_END | w | 8e18 → 2cb4:01ba | Leave battle to map w; "lost" when the next op is GAME_OVER |
| 12 | NEXT_CHAPTER | – | 8e6b | see Flow |
| 13 | LEAVE_GROUP | – | 97f6 | see Flow |
| 14 | SET_FLAG | b flag, b v | 8e92 | v == 0 **sets**, v ≠ 0 clears (confirmed with ESAVE0); flag ≥ 0x100 is an error |
| 15 | ASK | b answer, b skip | 8ec6 | Shows the first TALK line with yes/no (`98f6` mode 1; `c15a` dl bits 6–7 = 2); yes = 1. If result == answer, skip `skip` commands |
| 16 | UNIT_ATTACK | o o | 8f05 / 9c5a | *(inferred)* scripted attack animation |
| 17 | INPUT | b | 8f47 | Enable/disable player input |
| 18 | REMOVE | o | 8f6e / 9cbc | Remove character |
| 19 | – | w | none | never dispatched |
| 1a | REINFORCE | o | 8f82 | *(inferred)* bring unit onto the battlefield |
| 1b | ADD_ITEM | b | 8fb2 / 6d9c | Give item (officer item slots +0x23, ×8) |
| 1c | SET_AI | o algo a b | 8ff6 | Battle AI for a unit |
| 1d | SET_PREV_MAP | w b b | 9098 / c8fe | Return map and position (length table says 2; real length 4) |
| 1e | CLEAR_CHARS | – | 90c7 / a28c | Clear character table |
| 1f | PLACE_TOWNSFOLK | – | 90d2 → 1cb6:2d38 | Place IPPAN people |
| 20 | SORTIE | b n, b[n&0x7f] | 90e3 / c93e | n&0x80 = reset; values are party slots (`DS:0xcc98 + i*0x20`), bit0 cleared |
| 21 | IF | b skip, b n1, b set[n1], b n2, b clear[n2] | 9123 | If all `set` flags are set and all `clear` flags clear, continue; else skip `skip` commands. Length 3+n1+1+n2 |
| 22 | BATTLE_UNITS | b side, 30 × 13 | 91bd | Entry `{w id, x, y, condEn, condFlag, a, b, kind, w param, a2, b2}`; flags bit0 = side==0; existing units of that side removed, free slots filled; param kept for kinds 3–6 |
| 23 | FORMATION | – | 9341 → 2cb4:2be2 | *(name inferred)* pre-battle unit formation |
| 24 | SET_FORCE | o b | 9349 / 2196 | Officer +0x1c low 5 bits = force |
| 25 | CHOOSE | m | 9385 | Lines split on `\n`/`\r` into a menu (`2c92`); choice i jumps to record `group + i + 1` and continues |
| 26 | MAP_CHIP | b b b | 947d | *(inferred)* change a map tile |
| 27 | MAP_EFFECT | b x, b y, b kind | 94b8 | Fire (0) / flood (1) on a cell, 2 puts it out (`2cb4:0420`, BATTLE.md) |
| 28 | UNIT_FORCE | o b | 94f3 | Battle unit side |
| 29 | GAME_OVER | – | 980e | return 7 |
| 2a | ENDING | b | 9826 | `int 65h`; return 8 |
| 2b | DATA | b kind, w | 952d | kind 2: gold += w (`21b2`, `DS:0x7a80`); kind 4: `2cb4:0b72` |
| 2c | REDRAW | – | 956d | Redraw screen |
| 2d | HALVE | b b | 95a1 | *(inferred)* halves a unit value |
| 2e | SET_LEADER | o b b b | 95c3 / cbb4 | Player leader officer; the three bytes are discarded |
| 2f | SET_CG | o b | 95f0 | Officer +0x2b (portrait/graphic) |
| 30 | OBJECTIVE | m | 962c | Stored at ctx+0x3c8 |
| 31 | – | – | none | occurs twice, never reached |
| 32 | SET_LIST | b n, b[n] | 964d | ctx+0x549 |
| 33 | BATTLE_OP33 | – | 968d | unknown battle op |
| 34 | BATTLE_OP34 | – | 9698 | unknown battle op |
| 35 | BATTLE_OP35 | o b | 96a3 | unknown battle op |
| 36 | SAVE_STATE | – | 96bc | `7e4a` (write ESAVE) + `ad5a` |
| 37 | OFFICER_FLAG | o b | 96d9 | Officer +0x1c bit 0x40 (`9e44`) |
| 38 | MUSIC | b | 96f7 / 600a | Play song |
| 39 | ADD_STAT | o b | 9712 / 6bee | Officer +0x21 (level) += b, capped at 99 |
| 3a | SET_STAT | o b | 972f / 9e64 | Officer +0x20 = b |
| 3b | WALK_TO | x y | 9847 / ec0a | Player walks to x,y; status 1 |
| 3c | FOCUS | o | 974c / ec4c | Scroll to officer |
| 3d | SAVE_PROMPT | b | 975e | b ≠ 0: status 1 first; `f112` asks "여기서 세이브하겠습니까?" |
| ff | END | – | 9774 | see Flow |

## Game state touched by scripts

| DS address | Meaning |
|---|---|
| 0x7a6c | +4 town, +5 game mode, +6 location (IPPAN key) |
| 0x7a80 | +0 gold; +0x12 byte selects the IPPAN section via `DS:0x0ebc` |
| 0x7a94 | officers, 0x2c bytes, up to 0x180. +6 name, +0x1c force (low 5 bits) / bit 0x40 flag, +0x20, +0x21 level (≤99), +0x23 items (8), +0x2b cg |
| 0xcc98 | party slots, 0x20 bytes each (SORTIE) |
| 0xd4dc | script context (above) |
| 0xe5aa, 0xe196, 0xe5b4 | battle structures (turn counter at battle-state +2) |

The officer table is BSS, filled at runtime from the game data (see the data worker's docs).

## Townsfolk (IPPAN0)

* `IPPAN0.R3` has 4 sections; lengths at `DS:0x393a`, u32 offsets at `DS:0x3942` (0, 0x3bd, 0x6ce, 0xae5).
  Section = `DS:0x0ebc[byte DS:0x7a80+0x12]` = `[0,0,1,2,3]`.
* Section: `u8 townCount` (equals the table `DS:0x1360`: 22, 16, 26, 14), u16 town placement offsets (relative to
  section+1), u16 message count, u16 message offsets into the IPPAN0M section (`0xffff` = none). IPPAN0M section
  bases are u32 at `DS:0x2dd0`: 0, 0x2c25, 0x508b, 0x7a3b.
* Placement (`1cb6:2d38`): `u8 n`, then n × `{u8 key, u8 count, u16 person[count]}`. The key is compared with
  `byte DS:0x7a6c+6` in game mode 2, else with 0x7d *(meaning of the key inferred)*. People go to random walkable
  tiles. Talking to one runs `0cf5:c51a` with its message.

## Interpreter port (`web/src/engine/script.ts`)

* `new ScriptVM(loadChapter, host, state?)`; `loadChapter(c)` returns `parseChapter(c, SNRcD, SNRcM)`.
* `dispatch(trigger)` does the group selection and runs the event; `runAuto()` repeats `auto` dispatches until
  nothing fires. The host's main loop calls `dispatch` with `talk`, `location`, `unitAt`, `turn`, … as the
  player acts, then `runAuto()`.
* `ScriptHost` has the required display/map methods (`talk`, `ask`, `narrate`, `caption`, `title`, `stageTitle`,
  `choose`, `showPicture`, `closePicture`, `setMap`, `showMap`, `placeCharacter`, `moveCharacter`, `waitMoves`,
  `removeCharacter`) and optional ones for everything else. All state the scripts own is in `vm.state`
  (`ScriptState`), which serialises to ESAVE format.

## Verification

* All 5 chapters parse, 14132 commands, no unknown opcode, every message decodes (`scenario.test.ts`).
* Prologue runs headlessly (`script.test.ts`): opening, palace scene, allied camp talks (flags 0/1), Sishui Gate
  battle setup (units and victory officer), treasure IF, Hulao Gate, chapter end, and on into chapter 1.
* Resuming from ESAVE4 continues at the saved PC with the expected line.
* Emulator spot-check (Playwright, js-dos): after "게임을 개시한다" the original shows the title
  "서장 동탁타도군 일어나다." in the status bar, picture 3 with the two narrations in order (the `\r\n` break
  visible), then the Luoyang palace map with 동탁's line "폐하, 염려하지 마십시요. 정치는 제가 알아서 하겠습니다."
  followed by 헌제 (speaker 382) "......" — the same order as the test log. The CAPTION "낙양 궁전" and the
  stage-title card were not caught in a screenshot (shown briefly between clicks).

## Open questions

* Exact effects of 0x16, 0x23, 0x26, 0x27, 0x2d, 0x33–0x35, 0x37, 0x39/0x3a field meaning, 0x3b/0x3c details,
  0x05 vs 0x06, and 0x2b kind 4.
* Precise SORTIE semantics and the IPPAN placement key.
* Talk window position (top or bottom) seems to depend on the speaker's screen position *(observed, not traced)*.
