# Game flow, screens and menus

This document covers the top-level flow of the game: HERO.COM, MAIN.EXE `main()`, the title menu, the main-loop
state machine, and the hand-over to OPEN.EXE and END.EXE. It also covers the non-battle screen layout, the menus,
the controls and the GRPDRV graphics-driver API. Addresses follow [ENGINE.md](ENGINE.md): image `seg:off`. The
Ghidra address is the image segment + 0x1000. `DS:x` is DGROUP (image segment 0x313A). Screen coordinates are on
the 640×480 VGA screen. The PC-98-style 640×400 layout is drawn at y offset 40, so screen y = layout y + 40.
"Inferred" marks conclusions that no code path confirms.

Data structures named here (`DS:0x7a80` progress, `DS:0x7a6c` location, officers, towns, saves) are described in
[DATA.md](DATA.md). The script interpreter (`DS:0xd4dc`, `0cf5:8794`) is described in [SCRIPT.md](SCRIPT.md).
Battles (mode 3, `1cb6:4b52`) are described in BATTLE.md.

## Process chain (HERO.COM)

HERO.COM loads `SBOPL2.COM` (sound), `GRPDRV.EXE` (graphics) and `TFDED.COM` (Hangul) as TSRs. It then runs a
loop: exec `B:MAIN.EXE` and dispatch on its exit code through the table at HERO.COM offset 0x749.

| MAIN exit code | HERO.COM action |
|---|---|
| 0 | exec `A:OPEN.EXE` (opening), then run MAIN again |
| 1 | exec `A:END.EXE` (ending), then quit to DOS |
| 2 | print "Not enough memory." and quit |
| 3 | quit to DOS |
| 4 | run MAIN again (restart) |

MAIN runs first. The opening runs only when the title-menu choice 오프닝을 본다 is picked (exit 0). FORMATS.md
lists the order as "OPEN → MAIN → END", but the actual flow is MAIN-driven.

HERO.COM also provides **int 65h** (handler at HERO.COM 0xa12). The game uses it to keep the options across the
MAIN/OPEN/END restarts:

| AH | Function |
|---|---|
| 0 | return the machine flag word `[0x520]` |
| 1 | copy 21 bytes from CX:BX into the HERO buffer 0x700 |
| 2 | return CX:BX = buffer 0x700 |
| 3..9 | variable `cs:0x715 + 2*(AH-3)`: AL = 0 stores BX, AL ≠ 0 returns it in AX |

MAIN reads var 0 with `AX=0x301` (`0cf5:aaee`). It holds the option flags: initially 0x0f, and bit 0x40 is set
once copy protection has passed (`0cf5:25b0` writes it back). These are the same bits as `DS:0x7a80+0xa`.

## main() — `0cf5:aaea`

1. `int 65h AX=0x301` reads the flags. If bit 0x40 is clear, run the copy-protection prompt `0cf5:a3e4`
   (ENGINE.md), then set 0x40, store it to `DS:0x7a80+0xa` (`0cf5:acf6`) and to int 65h (`25b0`). The result test at
   `0cf5:ab01` is followed by an unconditional `jmp`, so the failure branch at `ab05` (exit 3) is never taken from
   here.
2. Set exit code = 3, `acd8(0x7a6c, 0)` (mode 0), `0cf5:a7e8` (init: memory `a50c`, `MARK.R3` `a432`, …),
   `0cf5:7c1c(0xd4dc)` (reset the script context).
3. **Title menu** `0cf5:c050` (see below) returns the choice. `DS:0xdaba` (status) and `DS:0x2d52` are cleared.
   * 3 (오프닝을 본다) → exit 0.
   * −1 → the farewell screen `0cf5:aa58` (PACKGRP pictures 0x22 and 0x24 placed by `52d4` with (0xd8, 0x50) and
     (0xb8, 0xc8); waits for a click with `2556`), then exit 3.
4. `0cf5:7a86(0xd4dc)` loads the chapter script `SNRnD/SNRnM` for context +0 (chapter).
5. New game only: draw the frame (`0cf5:c456`, PACKGRP 0). Then call `1cb6:2edc(0, 0xff)` (run events) until
   `DS:0xdaba & 2`. That runs the prologue until the script sets the first location.
6. Main loop: `r = 0cf5:a88c(choice)`. The first call passes the title choice and later calls pass 0xff.
   * `r & 8` (a game was loaded from the 기능 menu): reload the chapter script (`7a86`) and `13fe(0x650c)`, then
     continue.
   * `r & 4` (**ending**): stop the music (`0:6086`), palette fade-out (GRPDRV AH=16h via `0:cd88`), exit code 1 →
     END.EXE. On floppy installs it first asks for disk 3 (`409e`).
   * `r & 0x60` (**game over** 0x20 or **quit** 0x40): ask "다시 한번 게임하겠습니까?" (`3c5e(2, DS:0x2a2e)`). Yes →
     exit 4 (MAIN restarts, back to the title). No → farewell screen `aa58` → exit 3.
7. `0cf5:a766(code)` exits with the code.

### Status bits `DS:0xdaba`

| Bit | Set by | Meaning |
|---|---|---|
| 0x02 | `0cf5:c86c` | location changed; the loop re-dispatches on the new mode |
| 0x04 | script result 8 (`0cf5:e930`, `1cb6:2f65`) | ending |
| 0x08 | 기능 → 로드 (`0cf5:f19c`) | game loaded; main reloads the chapter script |
| 0x20 | script result 7, or battle result 3 | game over |
| 0x40 | 기능 → 게임 종료 confirmed (`0cf5:f044`, text `DS:0x3018`), or battle result 4 | quit |

Menus test `daba & 0x6e` to close themselves when any of these happen (`0cf5:f424`).

## Title menu — `0cf5:c050`

The menu is built by the generic menu routine `0cf5:2c92` from the far-pointer list `DS:0x2d38`, with handlers at
`DS:0x2cec`. It is drawn centred at screen ≈(217,169)-(351,279) over a black screen.

| Item | Handler | Action |
|---|---|---|
| 게임을 개시한다 | `0cf5:b536` | new game: `b2b0` loads MSAVE.R3, BAKDATA and BBKSDAT1 (DATA.md) |
| 게임을 재개한다 | `0cf5:bdae` | `bd1e(AX=1, DX=0x100)` save list (`b938`) → `b34e` load |
| 기능설정 | `0cf5:bfde` | submenu `DS:0x34fc` at layout (0x120, 0xa0) = screen (288,200): 모니터 (`f05e`, 컬러/흑백), BGM (`f038`), 효과음 (`f02e`); handlers `DS:0x2ce0` |
| 오프닝을 본다 | `0cf5:c012` | returns 3 → exit 0 → OPEN.EXE |

Right click closes a submenu. On the title menu itself, right click returns −1 (inferred from the −1 path; not tried
in the emulator).

## Main loop — `0cf5:a88c`

Each pass reads the mode from the low nibble of `DS:0x7a6c+5`. It first calls
`0cf5:86f0(0xd4dc, mode<<12 | map, area)` (script context +0xa / +8) and then dispatches:

| Mode | Screen | Handler | Map data |
|---|---|---|---|
| 0 | town | `1cb6:14e4` | `SMAP.R3` entry = town +0x19 (`1cb6:0f9a`, `1784`). `SMAPBGPL.R3` entry 0 |
| 1 | world map | `0cf5:d4d8` (commands `d382`, tables `DS:0x373e` / `0x37ce` / `0x37aa`) | `MMAP.R3` / `MMAPBGPL.R3` |
| 2 | palace / indoor | `1cb6:14e4` | `PMAP.R3` entry = location +6. `SMAPBGPL.R3` entry 1 |
| 3 | battle | `1cb6:4b52(0xe196)` | HEX* files (BATTLE.md) |

Battle results (mode 3):
* 1 = retry. The pre-battle snapshot at `DS:0x67a4` is restored (`7fe0` / `adb4`).
* 3 → status 0x20 (game over).
* 4 → status 0x40 (quit).
* Anything else → `0cf5:c86c` with the destination set by the script.

Towns and palaces run events through the interpreter. The result codes are listed in SCRIPT.md: 2 = map change →
`c86c`, 7 = game over, 8 = ending.

### Location change — `0cf5:c86c`

`0cf5:d004` reads the destination key from the script context. `key >> 12` selects the kind:

| Kind | Routine | New mode | Position |
|---|---|---|---|
| 0 | `1cb6:2c48` | 0 town | (0x0b, 0x0d) |
| 1 | `0cf5:e780` | 1 world map | (0x0b, 0x0d) |
| 2 | `1cb6:2c96` | 2 palace | from the map |
| 3 | `0cf5:c822` | 3 battle | (0x0b, 0x0d) |

Each routine stores the mode (`acd8`) and the map (`c0d8`) into `DS:0x7a6c`, plus the area (`c0c8`) for kinds 1
and 3. It clears the actor table (`ecf6`), sets the entered flag (`c0e8` = 1) and the position (`c108`), and sets
`daba |= 2`. The previous location is kept in `DS:0x7a76`.

## Screen layout (town, palace, world map)

The frame is PACKGRP picture 0, drawn by `0cf5:c456`. Measured on emulator screenshots (screen coordinates):

| Element | Screen rectangle | Notes |
|---|---|---|
| map view | x 16..527, y 56..375 (512×320) | black 2-px border around it (14..528 × 54..376) |
| portrait box | ≈(544,54)-(626,130) | 유비's portrait, 80×64 FACEDAT |
| status panel | ≈(544,168)-(626,262) | 돈 / 레벨 / 현재영토 |
| icon grid | 2×2, centres (565,305), (605,305), (565,350), (605,350) | 스토리 정보, 장수, 전체지도, 기능 |
| message bar 1 | x 15..257, y ≈390..424 | chapter title `DS:0xdb4c` |
| message bar 2 | x 271..369, same y | name under the mouse |
| logo | bottom right | part of the frame picture |

Text is positioned with `1cf5:091e(obj 0x6390, y, x)`, where y is in 400-line layout pixels and x is in 8-pixel
character cells. It is printed with `1cf5:0f18(obj, fmt, …)` (printf). Inline escapes: `ESC 'C' n` colour,
`ESC 'B' n` background, `ESC 'M' n` mode.

| Field | Code | Layout (y, x cells) | Screen (x, y) | Format |
|---|---|---|---|---|
| money `DS:0x7a80+0` | `0cf5:c362` | (136, 72) | (576, 176) | `%5u` |
| level = 유비's officer +0x21 | same | (160, 73) | (584, 200) | `%4u` |
| territory = town name of `DS:0x7a80+0x10` | `0cf5:c3d4` | (200, 71) | (568, 240) | `%6s` |
| chapter title | | (360, 3) | (24, 400) | |
| hover name | `1cb6:17e4` | (0x168, 0x23) | (280, 400) | format `DS:0x38cc` |

For a building, the hover name comes from the map table `DS:0x3838` with names at `DS:0x38ac` and the list at
`DS:0x3858`: 궁전 회의장 관청 주점 의사집 집회소 학문소 도구상 저택 성문 출구. For a person, it is the officer
or NPC-type name.

The talk window is ≈(66,72)-(476,184) with the speaker's portrait at (80,84) and the name and text to its right
(observed). It is drawn by the script engine (SCRIPT.md).

## Commands and menus

The game is mouse-driven. **Left click** selects or advances text. **Right click** cancels or closes a menu.
Clicking a character on the map talks to them (observed). Clicking elsewhere presumably moves 유비 (inferred).
In the emulator, arrow keys and Enter did nothing in menus or story text. The keyboard is only read by the copy-protection prompt
(`0:b380` int 16h). The GRPDRV keyboard functions (1Eh, 24h) have wrappers in MAIN but no callers.

Menus use `0cf5:2c92(bx = far-pointer list, ax = x, dx = y, …)` with layout coordinates. A label box naming the
open command appears at the top left of the map view, ≈(34,72)-(134,118), for example "스토리 정보" or "기능".

| Icon | Action |
|---|---|
| 스토리 정보 (565,305) | shows the current objective / story text |
| 장수 (605,305) | menu `DS:0x35ee`: 장수정보 (`0cf5:f8e0`, officer sheet), 도구교환 (item exchange) |
| 전체지도 (565,350) | world overview. Indoors it says "이 화면에서는 표시할 수 없습니다" |
| 기능 (605,350) | 기능 menu, below |

**장수정보** lists the officers with dynamic flag bit 7 set and the same faction as 유비 (`+0x1c & 0x1f`). For
each one it shows the class name, level, 병력, the 무력/지력/통솔 bars and up to 8 items (DATA.md).

**기능 menu**: list `DS:0x34e8` at layout (0x120, 0x20) = screen (288,72), handlers `DS:0x3478` (`0cf5:f3c2`). The
DOS/V build shows 8 items. Two more (음량, 음악시간) need `DS:0x2d52 & 4`, which is never set. With that bit, the 9th
handler (`0cf5:f27e`, the music room "음악을 즐긴다 / 효과음을 즐긴다") would be reached through item 9's slot.

| Item | Handler | Effect |
|---|---|---|
| 게임 종료 | `0cf5:f044` | confirm (`3c5e`, `DS:0x3018`) → `daba |= 0x40` |
| 스크롤 단위 | `0cf5:eee2` | submenu at screen (320,184): 소/중/대/극대 → `DS:0x7a80+0x11` = 1/2/4/8 |
| 속도설정 | `0cf5:f2ae` | 노웨이트/빠르다/보통/느리다 → `+0x13` (`d638`) |
| 로드 | `0cf5:f152` | save list → load, `daba |= 8` |
| 세이브 | `0cf5:f0ce` | save list → confirm "하드디스크의 n번에 세이브하겠습니다" → `ae98` |
| 모니터 | `0cf5:f05e` | 컬러/흑백 → flag 8 |
| BGM | `0cf5:f038` | ON/OFF → flag 2 (toggle `0cf5:ef76` with mask `DS:0x3014[1]`) |
| 효과음 | `0cf5:f02e` | ON/OFF → flag 1 (mask `DS:0x3014[0]`) |

The entry for the current value is drawn without its label in the submenus (seen in the emulator; inferred
meaning).

**Save/load list** (`0cf5:b938`): 5 lines `n. <title> yy/mm/dd hh:mm`. An empty slot is one with an all-zero
timestamp (`b576`). Picking a slot asks for a yes/no confirmation.

**Battle menu** (BATTLE.md): `DS:0x3aa0` 턴 종료, 총퇴각, 승리조건, 부대전투, 이동속도, 적의 이동, BGM, 효과음,
게임종료, DEBUG. 이동속도 and 적의 이동 change `DS:0x7a80+4`.

**Shops** (도구상): strings from `DS:0x54db`, 산다/판다 at `DS:0x591c`. Prices come from the item table (DATA.md).
The shop flow itself was not traced.

## GRPDRV graphics-driver API

`GRPDRV.EXE` ("GRAPHIC DRIVER V0.00 (c) KOEI") stays resident. Its first bytes are:

```
+0x13  jmp far <old int 18h>       ; int 18h vector points here (set with int 21h AX=2518h)
+0x18  jmp far 0:2163              ; API entry
+0x1d  "GRAPHIC DRIVER V0.00 (c) KOEI"
```

int 18h only chains to the old vector, so nobody executes `int 18h`. The vector is a pointer to the driver. A
client reads the far pointer at `0:0060` (int 18h), or at `0:0068` (int 1Ah) if the first does not match, and
compares the signature at vector+0xa. It then **far-calls** vector+5 with the function number in AH. MAIN does this
in `0:ca67`:

* `"GRAPHIC DRIVER V1."` (18 bytes): copy that driver's own 38 far pointers (found through vector+0x2a) into
  `cs:0xc9ce`.
* `"GRAPHIC DRIVE"` only (any version, such as the shipped V0.00): fill all 38 slots with vector+5.

The entry `0:2163` jumps to `cs:[0x3d + 2*AH]` for AH < 0x26, and each function ends with `retf`. MAIN calls slot
n through a wrapper at `0:cb0c..0:cf37` that loads the registers from C arguments. The wrappers for 0Ah..1Dh add the
origin `cs:0xc9b4/0xc9b6` to x/y (set by `0:cb4a`, cleared by AH=0). HERO.COM far-calls AH=0 / AH=1 itself and then
patches its own pointer so that AH < 2 does nothing.

The per-function descriptions below come from the first instructions of each handler in GRPDRV and from the MAIN
wrapper's registers. They are not traced in depth. GRAPHICS.md owns the drawing details.

| AH | GRPDRV | Registers (MAIN wrapper) | Function (inferred) | MAIN callers |
|---|---|---|---|---|
| 00 | 2199 | – | init once (`[0x93]`): int 21h 3800h country check → `[0x196f]`, save mode, set VGA mode | `0cf5:5bae` |
| 01 | 224f | – | terminate: restore the video mode and cursor shape | `0cf5:5c04` |
| 02, 03 | 226f, 2270 | AL | no-ops (`retf`) | `0cf5:c456`, `c4de` |
| 04 | 2291 | – | clear VRAM (0x4b00 words per plane) | – |
| 05 / 06 | 22b6 / 22cc | AL | set / get colour `[0xa0]` | – |
| 07 | 22d1 | AL | set the plane / write mode `[0xa2]` | – |
| 08 | 22ea | AL, BL, BH | set three draw parameters `[0x94..0x98]` | `0cf5:4418`, `458e`, `1cb6:dcc0` |
| 09 | 22ff | BX (0/1), CX (≤ 16), DS:SI | define a pattern / tile | – |
| 0A | 2346 | BX = x, CX = y | pset (clipped to `[0x1940..0x1946]`) | – |
| 0B | 23a6 | BX, CX | point / pattern read (unclear) | – |
| 0C | 244a | (BX,CX)-(SI,DI), DX | line | `0cf5:458e` |
| 0D | 249f | (BX,CX)-(SI,DI), AL | box / filled box | `0cf5:4418` |
| 0E | 24fc | BX, CX, DL, AL | paint / flood fill | – |
| 0F | 25dd | BX, CX, SI = w, DI = h, DL, DH | fill rectangle | `1cb6:dcc0` (4×) |
| 10 | 2621 | BX, CX, SI, DI, ES:BP | put image (`0x427c`) | `1cb6:dcc0` (2×) |
| 11 | 26d6 | BX = code, ES:DI | full-width (DBCS) glyph | `0cf5:a6f8` |
| 12 | 27a7 | BL, ES:DI | half-width glyph | – |
| 13 | 27fe | BX, CX, SI, DI, ES:BP | get image | – |
| 14 | 287b | AL = index, BL, CL, DL | set one palette entry (table `0x1991`, 3 bytes per entry) | – |
| 15 | 28f2 | AL = first, CL = count, DS:SI | set a palette block | `0cf5:497e` |
| 16 | 2924 | AL, CL, CH, DX, ES:BX | palette fade (palette.test.ts reproduces it) | `0cf5:497e`, `4a22`, `aaea` |
| 17 | 2a1a | BX, CX, DX, SI, DI, BP | VRAM-to-VRAM copy | – |
| 18 | 2c2a | BX, CX, DX, SI, ES:DI | image transfer, clipped | – |
| 19 | 2d08 | BX, CX, DX, SI, ES:DI | image transfer, bounded to 640×480 | – |
| 1A | 2daa | BX = n | wait n vertical retraces (`0x3005`) | – |
| 1B | 2db8 | AL, BL, BH | set text colours `[0x9a..0x9e]` | `0cf5:453e`, `5bae` |
| 1C | 2de5 | BX, ES:DI | draw a DBCS string / glyph (`[0x196f]`) | `0cf5:a670` (2×) |
| 1D | 2e50 | BX, CX, SI, DI | set the clip rectangle (clamped to 640×480) | – |
| 1E | 2e8b | – | key pressed? (int 16h AH=11h) | – |
| 1F | 2e9b | BX | normalise a scan code (E0/F0 prefixes) | – |
| 20 | 2eb2 | – | screen size: AX = 640, BX = 480 | – |
| 21 | 2eb9 | BX, CX, ES:DI | read the palette | – |
| 22 | 2edc | – | open the file named at `0x19d1` (font?) | – |
| 23 | 2f21 | ES:BX | call the user hook `[0x19db]` | – |
| 24 | 2f37 | – | read key (int 16h AH=10h) + shift state | – |
| 25 | 2f43 | AL = two colour nibbles | colour pair through table `0x19c1`, then AH=1Bh | – |

## Native stand-ins for OPEN.EXE, END.EXE and the formation screen

The native mode replays these programs from the original files (`web/src/native/opening.ts`, `ending.ts`,
`formation.ts`, drawing through `cutscene.ts`). Times use the SBOPL2 int 66h F0h/F1h countdown (60.3 Hz,
SOUND.md); END's waits compare an absolute tick accumulator (`DS:27B2/27B6/27BA`) through `0:A9FA`.

**The ending (END.EXE, DGROUP = image segment 0xB84, from `mov di,0B84h` at entry+0x0D).**
* The type is int 65h variable 4, written by MAIN's script op ENDING at `0cf5:9826`; the native host keeps
  the operand and passes it to `runEnding` (`game.ts`).
* Dispatch after start-up: type 3 runs `0:61BE` (END2GRP.R3, named at `DS:080A`); any other type runs
  `0:312A` (END1GRP.R3). `0:312A` only tests `type != 0`, so types 1 and 2 play the same scene. The staff roll
  `0:7F70` (END1GRP) always follows.
* A click inside `0:312A`/`0:61BE` jumps to their exit path (`fadeTo(0x6B8)`, cls). The roll's exit path is
  `musicFade(8)`, `fadeTo(0x6B8)`, cls.
* Staff roll: 20 pages (pointers `DS:240C..2432`). Each line dissolves in 16 steps two frames after the line
  above; every odd page dissolves to the next picture (56..64) with `fadeStep` towards `DS:602 + (i/2)*2`. It
  waits for EDMUSIC song 1 to end (`0:987E`, only with BGM on), then plays song 2. The last pictures are entries
  0x44 and 0, then `fadeTo(0x818)` and a click.
* Ending 3 checks its timing once (`0:6B75`, via `0:A8CE`/`0:1256`): if the first frame came more than 0.2 s
  late it switches to 8 rows per step with delay 0x32. The meaning of the test is inferred.
* Verification: the port's top-level call sequence equals traces of END.EXE run under the scratch emulator
  (`tools/dosemu.py` with GRPDRV) for all four types: arguments, wait targets and music times (song 2 starts at
  252 499 ms for types 0..2 and 246 758 ms for type 3; 1602 / 1601 / 1601 / 1667 waits). Frames at every point
  where the picture is stable for more than 300 ms are pixel-identical to the emulator: 150 of 150 for type 0 and
  204 of 204 for type 3. `web/test/native-fidelity.test.ts` checks the waits and song times.

**The opening (OPEN.EXE).** 189 of 190 stable frames are pixel-identical to the emulator run; the test checks
that both songs play and that the run ends on black.

## Verification

* Title menu, 기능설정 submenu, frame, talk window, 기능 menu (8 items), 스크롤 단위 submenu (소/중/대/극대),
  모니터 submenu (컬러/흑백), 장수정보 sheet and the save / load lists were all observed in js-dos. The run used the
  original files plus a scratch copy of MAIN.EXE with a `retf` at `0cf5:a3e4`, which skips the code prompt.
  Coordinates come from those screenshots.
* Exit codes and their dispatch come from the code (`main()` above and HERO.COM's table). They were not
  exercised one by one in the emulator.

## Open questions

* The exact return values of the title handlers (only 0 = new game, 3 = opening and −1 are pinned down).
* Mode 1 (world map) command set (`0cf5:d382` tables) and the 전체지도 / 스토리 정보 screens, beyond what is
  listed above.
* Shops (도구상) and 도구교환 flows. The 음량 / 음악시간 items and their dead handler slot.
* Where troops are refilled between loading a save and the next save (DATA.md).
