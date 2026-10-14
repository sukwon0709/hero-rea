# Data tables and saves

How MAIN.EXE stores its static tables and its saved games. Addresses are `segment:offset` in the loaded image,
as in [ENGINE.md](ENGINE.md). The Ghidra address is the image segment + 0x1000 (`0cf5:ae98` = `1cf5:ae98`).
`DS:x` is an offset in DGROUP (image segment `0x313A`), so file offset = `0x6A00 + 0x313A0 + x`.
"Inferred" means the meaning comes from the values or from how the UI shows them. It does not come from code
that interprets the field.

Code: `web/src/formats/tables.ts` (tables), `web/src/formats/save.ts` (saves, byte-exact round trip),
`web/src/engine/state.ts` (the in-memory objects), `tools/savedump.py` (prints a save).
Tests: `web/test/tables.test.ts`, `web/test/save.test.ts`.

## Overview

| File | Size | Format | Read by | Contents |
|---|---|---|---|---|
| `BAKDATA.R3` | 19328 | 4 fixed tables, not LS11 | `0cf5:ae0c` / `ae24` / `ae3e` / `ae58` | NPC types, items, officer static and default dynamic records |
| `BBKSDAT1.R3` | 3584 | 4 sections × 0x380 | `0cf5:b1de` (via `b2b0`, `b34e`, `b272`) | towns of each chapter section |
| `FACEDAT.R3` | | 240 × 6-byte index + blobs | `0cf5:50ec` | portraits (80×64, TF-DCE blobs, see GRAPHICS) |
| `PACKGRP.R3` | | 38 × 6-byte index + blobs | `0cf5:520e` | UI pictures. Entry 0 is the frame (`0cf5:c456`) |
| `DISK1..4.R3I` | 107 | Shift-JIS text | `0cf5:409e` | disk labels for the floppy-swap check |
| `MSAVE.R3` | 73 | = MSAVE bytes 0..0x48 | `0cf5:b2b0` | new-game state |
| `MSAVE0..4.R3S` | 8789 | see below | `0cf5:b34e` / `0cf5:ae98` | world state |
| `ESAVE0..4.R3S` | 1369 | see below | `0cf5:7c72` / `0cf5:7d5e` | script context (`DS:0xd4dc`) |
| `*.R3M` | – | – | never | names exist in the table `DS:0x2a48` but nothing opens them |

## BAKDATA.R3

Four tables back to back. None of them is compressed.

| Offset | Records | Size | Loader → memory |
|---|---|---|---|
| 0x0000 | 256 NPC types | 13 | `0cf5:73f6` → `DS:0xbc96`, stride 0x10 |
| 0x0D00 | 64 items | 16 | `0cf5:7812` → `DS:0xd09a`, stride 0x11 |
| 0x1100 | 384 officers (static) | 21 | `0cf5:707a` → `DS:0x7a94`, stride 0x2c |
| 0x3080 | 384 officers (default dynamic) | 18 | `0cf5:707a` (new game, through `ae58` / `b156`) |

### NPC type (13 bytes, unit id `0x400 | n`)

| Byte | → object | Meaning |
|---|---|---|
| 0..7 | +6 (8 + NUL) | name (EUC-KR: 노인, 남자애, 농민, …) |
| 8 | +5 | 0 or 0x11..0x1c. Probably the sprite set (inferred) |
| 9 | +4 | unknown |
| 10 | +2 | unknown |
| 11 | +3 | unknown |
| 12 | – | not read (0 or 0x80) |

Object +0 = `n | 0x400` (`0cf5:73f6`). The unit kind is `(id >> 8) & 0xe`: 2 = officer, 4 = generic (`0cf5:41be`).

### Item (16 bytes)

| Byte | → object | Meaning |
|---|---|---|
| 0..11 | +0 (12 + NUL) | name |
| 12 | – | not read (0) |
| 13 | +0xe | shop price. 0xff = not sold |
| 14 | +0xf | power |
| 15 | +0x10 | kind, clamped to 0..15 by `0cf5:79ea` |
| – | +0xd | the item's index |

Item kinds. The meanings are inferred from the item names and powers:

| Kind | Items | Power |
|---|---|---|
| 0 | swords and polearms (의천검 … 패자검) | attack bonus (10..24) |
| 1 | class books and equipment (둔갑천서, 장창, 보병차, 연노, 투석기, 마개, 근위개, 무술교본 …) | 0. Probably class change |
| 2 | tactic scrolls (폭탄, 낙석서 … 호우서) | 0. Single-use battle tactics |
| 3 | consumables and plot items (술, 콩, 보리, 쌀, 원군서, 상약, 차, 옥새, 칙명서 …) | 0 |
| 4 | horses (조황비전, 적로, 적토마) | 1..3 |
| 5 | strategy books (손자의병법서, 맹덕신서, 육도, 삼략, 오자의병법서) | 15..22 |

Item 63 is a Shift-JIS dummy (the bytes `93 6e 93 4e 96 e7`).

### Officer static record (21 bytes)

`0cf5:707a(obj, dyn, …, static, index)` builds the 44-byte officer object at `DS:0x7a94 + 0x2c*n`:

| Byte | → object | Meaning |
|---|---|---|
| – | +0 | `n \| 0x200` (unit id) |
| 0..5 | +6 (6 + NUL) | name |
| 6..13 | +0xd (8 + NUL) | reading, Shift-JIS half-width katakana (`ﾘｭｳﾋﾞ`) |
| 14..15 | +0x16 | portrait = FACEDAT entry |
| 16 | +5 | unknown (유비 0, 관우 1, 장비 2, 동탁 8 …) |
| 17 | +0x18 | 통솔 (clamped 0..100, `0cf5:74c8`) |
| 18 | +0x19 | 무력 |
| 19 | +0x1a | 지력 |
| 20 | +0x1b | flag bits, unknown |

유비 = 91 / 75 / 64 (통솔 / 무력 / 지력). The 장수정보 screen draws them as bars, in the order 무력, 지력, 통솔.

### Officer dynamic record (18 bytes)

This record appears in BAKDATA at 0x3080 (new game) and in every MSAVE at 0x695.
Load: `0cf5:724a` (or `707a`). Save: `0cf5:7310`.

| Byte | → object | Meaning |
|---|---|---|
| 0 | +0x1c | bit 7 = active (set for almost all officers), bit 6 = ? (`0cf5:7554`), bits 0..4 = faction (`0cf5:0ef6`) |
| 1 | +0x2b | stored in memory as value + 2; `7310` subtracts 2 again |
| 2, 3 | +2, +3 | unknown |
| 4 | +0x1d | 0..100 (clamped). 100 in every file. Unknown |
| 5..6 | +0x1e | troops (병력), u16. Clamped to the maximum on load |
| 7 | +0x20 | class (병종) |
| 8 | +0x21 | level |
| 9 | +0x22 | experience 0..99 |
| 10..17 | +0x23 | 8 item slots, 0xff = empty |

Maximum troops (`0cf5:73b8`) = `10 * (10*base[class] + growth[class]*(level-1))`. `base` is at `DS:0x1338` and
`growth` at `DS:0x134c`, one byte per class. Example: 단병 Lv3 → 600.

The faction names are at `DS:0xece`, through near pointers at `DS:0xf1e`: 유비 조조 손권 공손찬 원소 동탁 원술
여포 도겸 유표 유장 장노 마등 공융 무소속.
The class names are at `DS:0xf5e`, through pointers at `DS:0xfd8`: 단병 장병 전차 궁병 연노병 발석차 경기병 중기병
친위대 산적 흉적 의적 군악대 맹수부대 무도가대 주술사 이민족 백성 수송대 (19 classes).

## BBKSDAT1.R3 (towns)

Four sections of 0x380 bytes. Section = `byte DS:0xebc[chapter]` = 0, 0, 1, 2, 3 for chapters 0..4 (`0cf5:777a`).
A section holds 32 town records of 23 bytes, then 32 dynamic records of 5 bytes (736 + 160 = 896).
`0cf5:762a(obj, withB5, dyn, rec, idx)` builds the 0x20-byte town object at `DS:0xcc98 + 0x20*idx`:

| Source | → object | Meaning |
|---|---|---|
| rec 0..7 | +0 (8 + NUL) | name (평원, …, 신도 = section 0 town 18) |
| rec 8..19 | +9 (12 + NUL) | reading (Shift-JIS) |
| rec 20, 21 | – | not read |
| rec 22 | +0x18 | unknown |
| `DS:0x136c[2*(base+idx)]`, +1 | +0x16, +0x17 | 2 bytes per town; probably the world-map position (inferred) |
| `DS:0x1408[base+idx]` | +0x19 | SMAP.R3 entry of the town map (used by `1cb6:0f9a`) |
| dyn 0 | +0x1a | unknown |
| dyn 1..2 | +0x1b | u16, unknown |
| dyn 3, 4 | +0x1d, +0x1e | unknown |
| save dyn 5 | +0x1f | BBKSDAT1 has no 6th byte: a new game sets 3 |

`base = byte DS:0x1366[section]` = 0, 22, 38, 64 (`0cf5:779c`). The real town count per section is
`DS:0x1360[section]` = 22, 16, 26, 14 (`0cf5:778e`). The remaining entries in a section are Shift-JIS dummies.
The current town is `DS:0x7a80+0x10` (현재영토).

## FACEDAT.R3 / PACKGRP.R3

Both files use the same layout: `count × {u32 offset, u16 size}`, then the data, with each offset counted from
the end of the index. The count is a constant in the reader. FACEDAT has 240 entries (`0cf5:50ec`, index 0x5a0
bytes). PACKGRP has 38 (`0cf5:520e`, index 0xe4 bytes).
In both files the blobs are contiguous and end at the end of the file (checked in a test). FACEDAT entry = officer
static bytes 14..15. MAIN draws a portrait as 80×64 at `0cf5:4558(…, 0x50, 0x40, …)`.
The blob encoding (it starts `02 54 08 50 …`) belongs to GRAPHICS.

## DISKn.R3I

These files hold Shift-JIS text such as `DOS/V 三國志英傑伝 ﾃﾞｨｽｸ1 Ver 1.00 Rel 1.00` plus copyright lines.
`0cf5:409e` compares a disk's label with them before it reads from that floppy. The strings
SDISK (save disk) and KDISK (start disk) come from the same code. On a hard-disk install the check is skipped.

## Saves

### File names and writer

`DS:0x2a48` holds 6 near pointers: `A:MSAVE0.R3S, A:ESAVE0.R3S, B:IPPAN0.R3, B:IPPAN0M.R3, A:MSAVE0.R3M,
A:ESAVE0.R3M`. `0cf5:ae98` takes the table index in AX and the slot digit in DL, which replaces the `0` at
character 7. BX = 0x100 means hard disk, and the drive prefix is then dropped. No caller passes index 4 or 5,
so the `.R3M` names are never used (on DOS/V; inferred as PC-98 leftovers).

The writer `0cf5:ae98` builds the image in a buffer, writes `MSAVEn.R3S`, then writes `ESAVEn.R3S` through
`0cf5:7d5e(0xd4dc)`. The loader is `0cf5:b34e`, and `0cf5:7c72` reads the ESAVE.

### MSAVEn.R3S (8789 = 0x2255 bytes)

| Offset | Size | Memory | Serialiser (load / save) | Contents |
|---|---|---|---|---|
| 0x0000 | 5 | – | `0:608a` (RTC) | timestamp. All zero = empty slot (`0cf5:b576`) |
| 0x0005 | 30 | `DS:0xdb4c` | copy | chapter title shown in the slot list and in message bar 1 |
| 0x0023 | 20 | `DS:0x7a80` | `0cf5:6404` / `6538` | game progress |
| 0x0037 | 9 | `DS:0x7a6c` | `0cf5:690a` / `696c` | current location |
| 0x0040 | 9 | `DS:0x7a76` | same | previous location |
| 0x0049 | 62 × 26 | `DS:0x7406` | `0cf5:6686` / `67b0` | map actors |
| 0x0695 | 384 × 18 | `DS:0x7a94` | `0cf5:724a` / `7310` | officer dynamic records |
| 0x2195 | 32 × 6 | `DS:0xcc98+0x1a` | `0cf5:762a` / `7708` | town dynamic records |

The timestamp is 5 bytes: year (BCD, 2 digits), month in the high nibble (binary), day (BCD), hour (BCD), minute
(BCD). The list shows it as `yy/mm/dd hh:mm` (format `DS:0x2b25`).

**Game progress `DS:0x7a80`** (20 bytes, the same in the file):

| Offset | Size | Meaning |
|---|---|---|
| +0 | 2 | money (돈), 0..10000 (`0cf5:224c` clamps; add with `21b2`) |
| +2 | 2 | 0..10000. Always 5000. Unknown |
| +4 | 2 | battle options: 0x1000 toggles with the battle menu 적의 이동 (본다/안본다). Low nibble = 이동속도 (inferred). Read by `4e42` / `4e50` |
| +6 | 2 | unknown. The loader replaces values > 0x1d with 5 |
| +8 | 2 | 0x20. Unknown |
| +0xa | 2 | options, mirror of int 65h var0: 1 효과음 on, 2 BGM on, 4 unknown, 8 컬러 monitor (모니터 = 컬러/흑백), 0x40 copy protection passed |
| +0xc | 2 | `0cf5:25c4` / `25e2`. Unknown UI state (1) |
| +0xe | 2 | current BGM track, 0xffff = none. Resumed after a load (`639a` / `c120`) |
| +0x10 | 1 | current town (현재영토), index into `DS:0xcc98` |
| +0x11 | 1 | 스크롤 단위 1/2/4/8 = 소/중/대/극대 (기능 menu handler `0cf5:eee2`; `1cb6:0ebc` get / `0eca` set; submenu checked in the emulator) |
| +0x12 | 1 | chapter 0..4 (`0cf5:77da` / `c12e`) |
| +0x13 | 1 | 속도설정 0..3 = 노웨이트/빠르다/보통/느리다 (`0cf5:d638`, `1cb6:0eac`) |

**Location `DS:0x7a6c` / previous `DS:0x7a76`** (10 bytes in memory, 9 saved; byte +9 is cleared on load):

| Offset | Meaning |
|---|---|
| +0, +1 | player x, y. A new location starts at (0x0b, 0x0d) (`0cf5:c108`) |
| +2, +3 | unknown |
| +4 | area: the town index in a town or palace (`c0c8` / `acca`). This is event trigger 2's town |
| +5 | low nibble = mode: 0 town (SMAP), 1 world map (MMAP), 2 palace / indoor (PMAP), 3 battle (`acd8`, `21ea`) |
| +6 | map index (`c0d8` / `ace8`) |
| +7 | entered flag (`c0e8`, `cfae`) |
| +8 | `1cb6:175e` / `176c`, unknown |

**Map actor `DS:0x7406`** (26 bytes). The accessors are `0cf5:ecf6..eec2`, `55b2`, `55d0`, `55e0`.

| Offset | Meaning |
|---|---|
| +0, +1 | unknown |
| +2..5 | run-time far pointer, saved raw. Byte 3 is renormalised by `0:c1f8` on save and `0:c14c` on load |
| +6 | unit id (`0x200\|officer`, `0x400\|NPC type`). In palace saves many slots hold 0x200 with odd data (unknown) |
| +8, +9 | map position (`edb4`) |
| +0xa, +0xb | target position (`ede8`) |
| +0xe | sprite frame (`55d0`) |
| +0xf | flags (`55b2`; bits 0x84 tested) |
| +0x15 | `d62a` |
| +0x19 | 8 in every slot |

The map file seeds the actor table: `1cb6:1134` reads a count at map+0x4ec, then 3-byte records.

### Loader quirks (`0cf5:b34e`)

* The loader reads only 0x2235 bytes. `b01a(AX=1)` restores progress, both locations and the actors.
* It reloads BAKDATA and copies MSAVE+0x695 (0x1b00 bytes) over the default dynamic block, then `b156` builds
  the officers. The troops of each officer are clamped to the class/level maximum.
* It loads the BBKSDAT1 section for the chapter, copies MSAVE+0x2195 for **0xa0** bytes, and runs
  `b1de(AL=1)`. That function reads 6 × 32 = 0xc0 bytes, so towns 26 (last 2 bytes) to 31 come from stale buffer
  memory. Seen in the emulator: re-saving after a load changed bytes 0x2242 and 0x2254. Every section's
  entries ≥ 26 are dummies, so nothing visible depends on this. The port reads all 32.
* New game (`0cf5:b2b0`): `b01a(AX=0)` loads MSAVE.R3 but keeps the running option flags (+0xa). It then
  loads the BAKDATA defaults (`ae58` → `b156`) and the chapter's BBKSDAT1 section with `b1de(AL=0)` (5-byte
  dynamic records, +0x1f = 3).

**MSAVE.R3** (new game): money 0, +2 5000, +4 0x9001, +6 5, +8 0x20, flags 0x0f, +0xc 1, BGM none, town 0,
scroll 1 (소), chapter 0, speed 2 (보통). Location (0x0b, 0x0d), town mode, map 0, entered 1.

### ESAVEn.R3S (1369 = 0x559 bytes)

The file is the script context `DS:0xd4dc`, serialised in this order (`0cf5:7e4a` to a buffer, `0cf5:7f38`
back). [SCRIPT.md](SCRIPT.md) owns the field meanings:

| File | Size | Context field |
|---|---|---|
| 0x000 | 12 | +0 chapter, +2 stage, +4 block, +6 group start, +8 area, +0xa mode<<12 \| map |
| 0x00c | 2+2 | +0x1a5, +0x1a7 (area and map of the character table; 0xffff at start) |
| 0x010 | 0x174 | +0x31 characters (62 × 6) |
| 0x184 | 0x22 | +0x1a9..+0x1ca run state (iterator, current record, PC, status …) |
| 0x1a6 | 0x1ef | +0x1cd battle units (45 × 11) |
| 0x395 | 0x20 | +0x11 event flags. Flag n is byte n>>3, mask 0x80>>(n&7) (`9fe4` test, `a37a` set, `a3a6` clear) |
| 0x3b5 | 0x21 | +0x549 list |
| 0x3d6 | 0x181 | +0x3c8 objective string |
| 0x557 | 1 | +0x3c6 |
| 0x558 | 1 | +0x3c7 |

Before every dispatch, the main loop `0cf5:a88c` calls `0cf5:86f0(0xd4dc, mode<<12 | map, area)`, which sets +8 and
+0xa. In all five shipped saves, ESAVE chapter = MSAVE +0x12 and ESAVE +8 = location +4. The mode nibble of
+0xa matches too. For the world-map save (slot 4) the map byte of +0xa is 0 while location +6 is 3.

**M versus E**: MSAVE holds the world (money, options, where the player stands, officers, towns, actors). ESAVE holds
the scenario interpreter (which event runs next, flags, the battle setup). The game always writes both together
(`ae98`). The chapter script (`SNRnD.R3`) to load is the ESAVE chapter (`0cf5:7a86`).

## Verification

* `web/test/save.test.ts` checks that parse → serialize reproduces all five MSAVE and ESAVE files and MSAVE.R3
  byte for byte. It also checks that `loadGame` → `toSave` reproduces MSAVE2 except the timestamp, and checks
  values: slot 2 money 60, chapter 1, 현재영토 신도, 유비 Lv3.
* `web/test/tables.test.ts` checks officer stats, names, items, the town lists, the DGROUP tables, the max-troop
  formula and the FACEDAT / PACKGRP index sums.
* Emulator (js-dos with a copy-protection-patched MAIN.EXE copy): saving slot 5 after loading slot 3
  reproduced the slot-3 file except for these bytes: the timestamp, location +7, actor run-time bytes, 유비's
  troops (refilled to the maximum, 600) and the stale town bytes described above. The 장수정보 screen after
  loading slot 2 showed 유비 단병 Lv3, items 콩 ×2 and the stat bars matching BAKDATA.

## Open questions

* Progress +2, +6, +8, +0xc. Officer static byte 16 and dynamic bytes 1..4. Town +0x18, +0x1a..+0x1e. NPC
  type bytes 8..11. Most actor fields.
* Where the troops refill after a load happens (saved 383, shown and re-saved as 600).
* Progress flag bit 2: set in the defaults, meaning unknown.
