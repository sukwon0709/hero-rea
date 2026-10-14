# Tactical battles

This document covers the battle system of `MAIN.EXE` (삼국지영걸전, DOS/V): the HEX map files, the
battle RAM layout, turn structure, every rule formula, tactics and items, the computer AI, and the
script commands as seen from the battle side. The TypeScript port lives in `web/src/engine/battle/`.

**Addresses.** Addresses are image `seg:off`, with load segment 0, the same convention as
`SCRIPT.md`. The Ghidra segment is the image segment + 0x1000, so `1cb6:c9bc` is Ghidra
`2cb6:c9bc` and `2cb4:031a` is Ghidra `3cb4:031a`.

- The battle code is mostly in segment `1cb6`. Script-facing battle helpers are in `2cb4`, and the
  runtime (RNG, officer records, messages) is in `0cf5`.
- `DS:X` is DGROUP (image segment `0x313A`, file offset `0x6A00 + 0x313A0 + X`). SS = DS.
- Calling convention: MS C 7, large model, pascal (the callee pops, and the first argument is pushed
  first, so `[bp+6]` is the last argument). Many small helpers take register arguments; these are
  noted where they matter.

**Evidence levels.**

- **verified**: compared with the original routine executed under Unicorn on thousands of generated
  inputs (`tools/battle_ref.py`, see [Verification](#verification)).
- **read**: transcribed from the disassembly but not executed.
- **inferred**: deduced from how the data is used.

Unmarked statements in the rules sections are *read* unless the section says otherwise.

## Code map

| File | Contents |
|---|---|
| `web/src/engine/battle/types.ts` | Record layouts (`Unit`, `Officer`, `BattleInfo`) and the small engine tables (terrain, class, tactic, direction). `readDgroup()` and `loadLearnTable()` read tables from MAIN.EXE at runtime |
| `web/src/engine/battle/map.ts` | HEXZMAP/HEXBMAP parsing, battle-name lines, chip-set selection |
| `web/src/engine/battle/hex.ts` | Grid helpers, ZOC, range shapes (`c018`), movement flood fill (`c9bc`), path walk (`c772`) |
| `web/src/engine/battle/rules.ts` | RNG, attack/defence/HP/MP/move, damage, morale, confusion, regeneration, weather, experience |
| `web/src/engine/battle/combat.ts` | Attack sequence (`e91a`/`ec82`), tactic casting (`b2d6`), unit removal (`8504`) |
| `web/src/engine/battle/ai.ts` | Computer AI (`ce50` and helpers), action order (`3e12`) |
| `tools/battle_ref.py` | Unicorn harness that runs the original routines on random inputs and prints JSON |
| `web/test/battle.test.ts` | Unit tests; table checks against MAIN.EXE; map parsing (game-gated) |
| `web/test/battle-ref.test.ts` | TS vs the original for every harness case (game-gated, needs `python3` + `unicorn`) |

## Map data

### HEXZMAP.R3: grid maps

The file is an LS11 archive with 59 entries, loaded by `1cb6:373c` (entry = battle state +0) into
the scratch segment `DS:0x678c`.

**Entries 0..57 are maps**:

```
u8  chipW, chipH          ; in 16x16 chips; width = chipW/2, height = chipH/2 (cells)
u8  chips[chipW*chipH]    ; row-major chip indices (2x2 chips per cell)
u8  terrain[width*height] ; row-major terrain type 0..19
```

- `373c` stores `width = chipW>>1` at `DS:0xe194` and `height = chipH>>1` at `DS:0xe195`.
- It copies the chips to map segment +0 and the terrain to map segment +0xf00.
- It then replays the script's map-change log (`2cb4:0368`, see
  [Script commands](#script-commands-battle-side)).
- Map 0 is 28×16. **Map 32 has one cell with terrain 255** at (5,13), which is out of every table;
  see [Quirks](#quirks).

**Entry 58** is the list of battle names, as EUC-KR lines. `1cb6:4d4e` picks a line by the
scenario's battle number (`0cf5:ace8`) and appends " 의 전투". See `battleNameLines()`.

**The grid is square with 4 neighbours**, despite the HEX names. Direction order is
0 N, 1 E, 2 S, 3 W (`DS:0x4d1c`, dx/dy as word pairs). Diagonals are at `DS:0x4cfc` and the axis
order used by the range shapes is at `DS:0x4d0c`.

### Chip sets (HEXZCHP.R3)

`373c` loads HEXZCHP entry 0 at chip segment `DS:0x676e` +0, then a second set at +0x2800:

- entry 2 if the map number is in the 19-word list at `DS:0x3dcc` (tested by `1cb6:4d1a`),
- entry 1 otherwise.

`secondChipSet()` has the list; the test checks it against the EXE. The same index selects the
script map-change chip offsets (`DS:0x4ffa`).

### HEXBMAP.R3: close-up backdrops

When close-up battle scenes are enabled (option byte `DS:0x7a84 & 0xf0`, tested by `1cb6:defe`),
`1cb6:edb8` builds the backdrop from the **defender's terrain**:

- HEXBMAP entry `DS:0x4e42[terrain]` (230 bytes) is copied to map segment +0x2110.
- HEXBMAP entry `DS:0x4e56[terrain]` (528 bytes) is copied to +0x21f6.

These are HEXBCHP chip layouts. The tables are `CLOSEUP_BACK` and `CLOSEUP_FRONT`, and
`closeupBackdrop()` returns the two entries.

**Close-up screen (traced, not yet ported).** Read from the disassembly; the port still draws a simplified
panel (`effects.ts closeupScene`).
* `1cb6:6D34(view, scroll)` draws a grid of 26 × 13 cells of 16 px at (16, 32) in 640×400 coordinates. That is
  the map view area: VRAM offset `0xC80 + y*80` in `0:7002`. Rows 0..4 come from the 230-byte layout (row stride
  46, starting at column scroll/3, a parallax layer). Rows 5..12 come from the 528-byte layout (stride 66,
  starting at column scroll). Each byte is a HEXBCHP chip of 128 bytes.
* `0:7002` copies the chip, then for 4 sprite layers (map segment +0x1680, 0x2A4 bytes each, a 26×13 word grid,
  0xFFFF = empty) ANDs the cell's mask and ORs its planes. The cells were converted by `0:5C32` into 160 bytes:
  a mask of NOT(p0|p1|p2|p3), then the planes. Code < 0x190 picks a cell in handle `0x676E` (code·0xA0),
  otherwise handle `0x6774`. A cell is redrawn only when the byte map at +0x2406 is 0xFF or differs from its chip.
* `f690` puts a 4×4-cell soldier at (x, y), code (11·side + pose)·16 + k. Sprite row r goes into layer 3−r, one
  grid row down, so lower soldiers cover the ones behind. `f5d4` does the same with 3×3 effect cells, code
  0x160 + 9·pose. Pose 0xFF erases the footprint.
* `f052` loads HEXBCHR into these banks. The soldier entry base is the sum of `DS:4E08[0..class)`, and the pose
  counts come from `DS:4DF5`. The arrow entry is 0xA9 + `DS:4E1B[class]`, and the tactic entry is
  0x9A + 6·element. Left-side banks are mirrored, with the cell order fixed by `DS:4F8C`/`DS:4F94`.
* `f3c6` draws min(5, troops/600 + 1) soldiers per side. Positions come from `DS:4E2E` (left) and `DS:4E38`
  (right), with the far side pushed 40 cells off screen. Class 5 is drawn as two 4×4 parts 3 cells apart.
* Sequence (`e91a`, from `ec37`): `edb8` (setup, info panels `f752` at x 0x18 / 0x168, 1 s or a click). Then
  for an attack: `fa26` (wind-up), `fb2e` (41 frames: the camera scrolls 0→40 and the defender walks in),
  `fc3a` (strike). Tactics and bombs use `fcba` (21 frames, 2 cells per frame). `febc` follows: hit frames, about
  one per 100 damage. Every frame waits `DS:4E6A` = 1 countdown tick (`0cf5:5C38`). None of these routines calls
  the RNG (`0cf5:48C4`).



## RAM layout

### Handles and segments

Handles are DS words that hold a paragraph. `0cf5:1fe2(handle)` returns its offset 0, and
`0cf5:582e` the far pointer.

| Handle | Contents (offsets in that segment) |
|---|---|
| `DS:0x677a` map segment | +0x0000 chips (2W×2H bytes); +0x0f00 terrain (W×H); +0x12c0 unit map (slot or 0xff); +0x18bc movement grid (`c9bc`, 0xff = unreached); +0x1c7c path steps; +0x2110 / +0x21f6 close-up backdrop |
| `DS:0x6780` AI segment | +0x0000 foe map (enemy slot attackable from that cell, or 0xff); +0x0f00 influence (u8 per cell) |
| `DS:0x676e` chip graphics | HEXZCHP entry 0 at +0, second set at +0x2800 |
| `DS:0x678c` | scratch for file loads (HEXZMAP entry, strings) |
| image segment `0x30b9` (relocated constant) | +0x00 target list built by `c018` (0xff-terminated); +0x64 castable-tactic list built by `c9bc` with flag 4 |

### Unit records: DS:0xe2a2, 45 × 14 bytes

Slots 0..14 are the player side and 15..44 the enemy side. Side test: `1cb6:4f26`. Accessors
are in `1cb6:4e60..4fca`.

| Off | Size | Field | Notes |
|---|---|---|---|
| +0 | u16 | officer | index into DS:0x7a94 (0 = 유비) (`4e92`) |
| +2 | u8 | slot | own index |
| +3,+4 | u8,u8 | x, y | `4ecc` returns a pointer to x,y |
| +5 | u8 | target | AI target unit slot, 0xff = none |
| +6,+7 | u8,u8 | tx, ty | AI target position (`9fa6`) |
| +8 | u8 | order | acting order in the phase (`3e12`, `4eae`/`4ebe`) |
| +9 | u8 | status | 0 empty, 1 reserve (not yet on the map), 2 on the field, 4 retreated (`4f18`/`4f08`) |
| +0xa | u8 | flags | 0x02 confused, 0x04 script-controlled, 0x10 facing left (set by `8d74`; the cells face left, so a clear flag draws mirrored), 0x20 visible (cleared for hidden ambushers), 0x40 moved, 0x80 acted. Set/clear/test: `9ff6` / `4eda` / `4eec` |
| +0xb | u8 | mode | AI order (`4f3e` / `8a58`): 0 move to target, 1 attack nearest, 2 hold, 3 wait, 4 move without attacking, 7 player-controlled. Codes 5 and 6 are *inferred* (confused/paralysed names in the UI); the AI code only tests 0..4 |
| +0xc | u8 | morale | 0..100 (`a1a6` / `898c`) |
| +0xd | u8 | mp | tactic points (`4e9e` / `a07a`) |

### Officer records: DS:0x7a94, 0x2c bytes

Only the battle fields are listed. `SCRIPT.md` has the rest.

| Off | Field |
|---|---|
| +0x00 | u16 id. Generic officers have `(id & 0xf1ff)` in 0x100..0x15f |
| +0x18 | 통솔 lead (defence, morale regeneration, confusion recovery) |
| +0x19 | 무력 force (attack, counterattack chance) |
| +0x1a | 지력 intel (tactics) |
| +0x1e | u16 troops (HP). Set through `0cf5:6f42`, which clamps to the maximum |
| +0x20 | class 0..18 |
| +0x21 | level |
| +0x22 | exp 0..99 |
| +0x23..+0x2a | 8 item ids, 0xff = empty |

**Item records** are at DS:0xd09a, 17 bytes each:

- +0xf: value.
- +0x10: type. 0 weapon (attack +value%), 4 boots (move +value), 5 armour (defence +value%).

The best value per type counts; items do not stack.

### Battle state: DS:0xe196 (BattleInfo)

| Off | Field |
|---|---|
| +0 | HEXZMAP map number |
| +1 | result: 0 running, 2 won, 3 lost (`a1d2` sets it) |
| +2 | turn, 0-based (script condition "turn" compares +2 plus 1) |
| +3 | turn limit |
| +4 | weather 0..5. Type `DS:0x3b7c` = [0,0,0,1,2,2]: 0 clear, 1 cloudy, 2 rain |
| +0x24 | victory bonus experience (script `DATA` kind 4 → `2cb4:0b72` → `0bfc`) |

`DS:0xe194` / `DS:0xe195` hold the map width and height. `DS:0x0` holds 유비's slot (set by
`3926`).

### Other battle variables

| Address | Meaning |
|---|---|
| `DS:0xcc8` | u32 RNG seed. Seeded by `0cf5:48aa` |
| `DS:0xe1bc` | battle view and cursor object (scroll `6418`, redraw `5e0e`) |
| `DS:0xe51c` | AI: chosen target (attack or tactic). `1cb6:657e` returns it as the AI's target choice |
| `DS:0xe51e`,`e51f` | AI: chosen destination x,y (0xff = none) |
| `DS:0xe520` | AI: chosen tactic, 0xff = physical attack |
| `DS:0xe521` | AI: best tactic of the last `d0fa` call |
| `DS:0xe522` | AI: best physical target of the last `c58e` call (**stale between calls**) |
| `DS:0xe523` | AI: target of `e521` |
| `DS:0xe524` | AI: best cell value so far |
| `DS:0xe525` | AI: bit 0 enables a "stay next to the commander" branch in `ce50`/`a474`. Only ever written as 0 (`c2be`), so the branch is dead |
| `DS:0xe52e` | combat struct used by `e91a` (attacker, defender, kind, parameter, damage, morale loss, exp, counter flag) |
| `DS:0xe5aa` | script-battle object: +1 far pointer and +5 length of the map-change log (4-byte records) |
| `DS:0xe5b4` | duel scene object (script ops 10/33/34/35) |
| `DS:0x7a84` | options. `& 0xf0` = close-up battle scenes on |
| `DS:0x3a3c` | bit 0: allies on automatic, and a keypress returns them to mode 7 (`3f32`). Bit 2 skips the computer phase (debug, *inferred*) |
| `DS:0xd4dc` + 0x1cd | deployment records (see below) |

### Deployment records: script context DS:0xd4dc + 0x1cd, 45 × 11 bytes

These are written by script ops `BATTLE_SETUP` (03) and `BATTLE_UNITS` (22) (see `SCRIPT.md`) and
read by `1cb6:3926`. The accessor is `0cf5:c13e`.

| Off | Field |
|---|---|
| +0 | u16 officer (0xffff = empty, 0x400 = skipped) |
| +2,+3 | x, y |
| +4 | u16 flags: bit 0 enemy side; bit 1 reserve (not placed until `REINFORCE`/`PLACE`); bit 2 facing: clear = facing left. `3926:39b0` passes `(flags & 4) == 0` to `8422`, which hands it to `8d74`, the setter of unit flag 0x10 (facing left). It is not visibility: the visible flag 0x20 comes from `8222`/`81c4` |
| +6 | AI order code 0..6, mapped through `DS:0x4fe6` = [3,1,2,0,0,4,4] to the unit mode (`ORDER_TO_MODE`) |
| +7 | u16 param: codes 3 and 5 = target officer; codes 4 and 6 = target position (x = low byte, y = high byte) |
| +9,+0xa | enemies only: class and level. `81c4(unit, +0xa, +9)` sets the officer's class from +9 and its level from +0xa, then full MP and troops, morale 100 and the visible flag. In the prologue, 화웅 gets class 6, level 5 |

## Battle setup

`1cb6:3926` builds the units from the deployment records:

```
for each record r (0..44):
  skip if officer is 0xffff or 0x400
  if officer == 0: DS:0 = next player slot
  if player side (flags bit0 == 0):
    skipped when 4e60(ctx) != 0          ; (inferred: the player's sortie list is used instead)
    u = next player slot (from 0): 837c(u, officer)
    unless reserve: 8422(u, visible = !(flags&4), x, y)     ; put on the field
    mp = maxMp(officer) (9184), troops = maxHp (73b8 -> 6f42)
  else:
    u = next enemy slot (from 15): 837c(u, officer); 81c4(u, r+0xa, r+9)
    unless reserve: 8422(u, !(flags&4), x, y)
    2cb4:031a: clear flag 4, mode = DS:0x4fe6[code]   (only if 0ef6(officer) != 0)
    codes 3/5: target = unit of officer r.param (2cb4:0a4e -> a1c2)
    codes 4/6: (tx,ty) = r.param (2cb4:0a1c -> 9fa6)
remaining enemy slots: 8222 (cleared)
```

`1cb6:4b52` is the battle main loop: `3ab6` (screen setup) and `3d68` (empty), then:

```
while result == 0:
  if turn >= turnLimit: timeout
  4cac weather step
  draw weather icon (4e08), "turn" banner (message 0x3dc1)
  ev = 5
  while ev in (5,6) and 4f68(state) == 0:            ; run turn events
     e = 0cf5:84fe(ctx, turn+1); if e == -1: e = 0cf5:81fe(ctx); if e == -1: break
     ev = 0cf5:8794(ctx, e)
  if result == 0: 3db2 (one turn)
  turn++
timeout: message 0x3da3; every player slot holding officer 0 leaves (8504);
         if there is none and slot 0 is on the field, slot 0 leaves; result = 3
4a30: if result == 2: every player unit on the field gets 6f64(exp + state[0x24])
      (message 0x3d66 when nonzero); all units on the field get status 1
```

The event functions (`0cf5:81fe`, `84fe`, `842a`, `8794`) belong to the script engine (`SCRIPT.md`).

## Turn structure

Each turn (`1cb6:3db2`):

```
for slot 0..44: clear flags 0xc0 (moved, acted); if slot < 15: regen 7cc8(slot)
3d6c: run pending events (81fe/8794 until none or result set)
redraw; 44de player phase (menus; owned by the UI)
3f32 computer phases
```

The computer phases (`1cb6:3f32`), passes 0 and 1:

```
pass 0: player side units whose mode != 7 (allies on automatic)
pass 1: message 0x3ba8; for slot 15..44: regen 7cc8(slot), cure attempt 8130(slot)
        then the enemy side
each pass: 3e12 ordering; for o in 0..44 while result == 0:
   if DS:0x3a3c&1 and a key was pressed: clear bit 0, all player units mode 7, stop
   the first unit of the side with order == o and mode != 7: ce50(unit)
```

**Action order** (`1cb6:3e12`) for one side:

1. Set every order to 0xff.
2. Number the units standing on recovery terrain (village 8, fortress 13, barracks 14; test
   `bcf4`).
3. Then number the weak units (`c280`: `(maxHp/5)*2 >= troops` or morale < 40).
4. Then number all the rest.

Each group is in slot order, regardless of status. Code: `actionOrder()`.

After each unit acts, `1cb6:8ad2` runs the unit's events and `4abc` checks victory. When there is
no enemy on the field, `4abc` runs the "all enemies gone" events (`842a`/`8794` loop, else `81fe`).
The victory itself is set by the script's `BATTLE_END`.

## Grid rules

### Zone of control

A cell is in ZOC when a 4-neighbour holds a unit of the other side (`1cb6:bd0e`).

### Range shapes (`1cb6:c018`, verified)

`c018(unit, rangeType, x, y, flags)` lists the units in a shape centred on (x,y). `rangeCells()`
reproduces the exact visiting order.

- Bit 0x80 of the range type means one size larger, keeping the orthogonal neighbours.
- With the "allies" flag (bit 0), the centre is included and same-side units are listed.
- With flag bit 0x80 clear, every visited cell gets the unit's slot written into the foe map.
- The return value is the previous AI target `DS:0xe51c` if it is listed, else the last unit
  listed (`pickTarget()`).

| r | cells |
|---|---|
| 0 | N E S W (4) |
| 1 | + diagonals (8) |
| 2 | diagonals + (±2,0),(0,±2) (8) |
| 3 | diagonals + 5×5 ring without its corners (16) |
| 4 | r3 + (±3,0),(0,±3),(±2,±2) (24) |
| 0x80/0x81/0x82 | 8/12/20 cells (tactic areas) |

The class attack range is at `DS:0x3fe6`, with 0xff = cannot attack.

### Movement flood fill (`1cb6:c9bc`, verified)

Arguments: `[bp+6]` unit, `[bp+8]` ty, `[bp+0xa]` tx, `[bp+0xc]` flags, `[bp+0xe]` maxCost,
`[bp+0x10]` start-position pointer. Code: `floodMove()`.

```
if start == (tx,ty): return 0xff                 ; before the grid is reset
grid[*] = 0xff; grid[start] = 0
if flags&4: build the castable list (30b9:0064); unless scripted: d6f8(start)
if moveCost(start terrain) == 255: return 0xff
d = 0
loop:
  if d >= maxCost: return 0xff
  changed = false; next = 0xff
  for every cell, row-major, with grid == d:
     skip if in ZOC, unless cell == start, flags&3, or the unit is scripted
     for dir N,E,S,W: neighbour n with grid[n] == 0xff,
          cost c = MOVE_COST[moveType][terrain(n)] != 255, c + d <= maxCost,
          and no other-side unit on n
        grid[n] = c + d; changed = true; next = min(next, grid[n])
        flags&8: if foeMap[n] != 0xff and that unit is visible: return foeMap[n]
        flags&2: if n == (tx,ty): return 1
        flags&4: d6f8(n)
  d = next
  if !changed: return 0xff
```

Quirk: `next` is the minimum of the values set *in this pass*, so a cell set earlier with a smaller
value than `next` is never expanded. The test "flood fill skips cells set below the next level"
shows an example. Friendly units can be passed but other-side cells cannot be entered. The
movement budget is `1cb6:7c1e` (class move `DS:0x3f8e` + the best type-4 item), or 100 for scripted
units.

### Path walk (`1cb6:c772`, verified through the AI)

`walkPath(from → to)` goes downhill on the grid:

- At each step, take the neighbour with the strictly smaller grid value (the first in N,E,S,W order
  on ties) whose terrain cost fits the remaining budget.
- Skip ZOC cells unless the cell is `to` or the unit is scripted.
- Reverse the steps with `(d+2)%4`.

In mode 1, used by the AI, a walk that stops short calls `c4f2` at the stop cell with 50 if a unit
stands there, else 30. `1cb6:c3f4` moves a unit along `walkPath(dest → own, budget 0xff)` and sets
flag 0x40. Animation: `91ca`/`8e82`; they make no RNG draws (see [Verification](#verification)).

## Officer values

All verified.

| Value | Routine | Formula |
|---|---|---|
| attack | `0cf5:6aee` via `1cb6:7c90` (unit morale) | `a = 4000/(140-force)`; `a = (a + 2*CLASS_ATTACK[cls] + morale)*(level+10)/10`; `a += a*weapon%/100`; minimum 1, u16 |
| defence | `0cf5:6c1c` via `7cac` | the same with lead, `CLASS_DEFENCE`, armour |
| max troops | `0cf5:73b8` | `(10*HP_BASE[cls] + HP_GROWTH[cls]*(level-1))*10` |
| max MP | `1cb6:9184` | `intel*(level+10)*5/200` (u16 products); >256 → 255, exactly 256 stays (stored as 0 in the u8 MP) |
| move | `1cb6:7c1e` | `CLASS_MOVE[cls] + best boots value` |

The class tables are `DS:0xffe` attack, `0x1012` defence, `0x1338`/`0x134c` HP, `0x3f8e` move,
`0x3fd2` attack type, `0x3fe6` range, and `0x3ffa` move type. Terrain tables: `0x400e` move cost
[4][20] and `0x405e` defence %. All of these are checked byte-for-byte by `battle.test.ts`.

## Combat sequence

### One attack (`1cb6:e91a`)

The combat struct is at `DS:0xe52e`. `kind` 1 = physical (param = the attacker's class attack type;
7 = counterattack), 2 = tactic (param = element<<4 | power), 3 = bomb item.

1. **Arrow animation RNG**: for kind 1, param ≠ 7 and attacker class 3..5 (archers), 4 × rand(16)
   per volley. The draw loop at `1cb6:eab5` runs `2*n` passes with n = 1 when close-ups are on
   (`DS:0x7a84 & 0xf0 == 0`, tested at `defe`) and n = 2 when they are off. That is 8 draws with
   close-ups and 16 without. This must be reproduced for RNG sync. (`combat.ts fight()` draws 8 for
   `closeup = true` and 16 for false; the battle scene's `closeup` follows the option.)
2. `df14` damage (verified):
   - kind 1: class triangle via class/3 groups. Foot beats archers, archers beat horse, horse beats
     foot. Defence -25% against the beaten group, +25% against the stronger.
     `dmg = atk > def/2 ? (atk - def/2)*(100 - terrainDef)/100 : 0`; halved for a counterattack;
     minimum 1; capped at the troops.
   - kind 2/3: `pc = intel + level*intel/100` (caster); `pt = (same for target) >> 2`;
     `base = (power*4 + element + 2)*100`; `bonus = kind 2 ? (level*intel/50 + intel)*2 : 0`;
     `dmg = u16(bonus - tLevel*tIntel/50 - tIntel + base)`.
     - Draw `roll = rand(pc)`.
     - If the target is class 12/15/18: `pt *= 2`, `dmg /= 2`.
     - Fire on forest, or water in rain: `dmg += dmg/4`.
     - `dmg += rand((dmg & 0xffff)/50)`.
     - kind 2 misses (dmg 0) if `roll <= pt`. Capped at the troops.
3. `e26c` morale loss (verified): killed → all of it; kind 1 `dmg/(tLevel+5)/3`; kind 2/3
   `dmg/100`; minimum 1 if dmg > 0; capped at the morale.
4. `e2f4` experience, player-side attackers only (verified):
   - Hit: `tLevel < aLevel ? 4 : (tLevel - aLevel + 3)*2`, max 16.
   - Kill bonus: 48 for slot 15 (the enemy commander), 32 if the target's level is higher, else
     `64/(aLevel - tLevel + 2)`.
5. `e3c6`: an attacker without the visible flag becomes visible (the ambush is sprung).
6. `e42e` counterattack: only kind 1 against a class whose attack type is 0, with
   `rand(150) < force`. Cancelled if the incoming type is not 0/2/5 or the defender was killed.
7. `ec82` applies the result:
   - Troops -= dmg (`6f42`).
   - If the defender survived: morale via `898c`.
   - Attacker exp via `0cf5:6f64`.
   - The counter is dropped if troops == 0 or the defender is confused.
   - The counter runs as `e91a(defender, attacker, 1, 7)`.
   - Then the removal check: `a0d0` (troops 0, or confused with morale 0) → `8504`.

Code: `fight()` and `attack()` (`cd4a`/`d862` set flag 0x80).

### Unit leaves (`1cb6:8504`)

Status becomes 4 and the cell is cleared. Mode-0 units chasing that slot get target 0xff and mode 1.
Then the defeat/retreat events run (`0cf5:86b8`, `842a`, `8494`, `85e0`). Code: `unitLeaves()`; the
events are the caller's job.

If no event ran (`di == 0` at `86ac`):
- For officer 0 (유비), the battle is lost: result 3 (`a1d2(e196, 3)`), song 4, and message
  `DS:0x4171`.
- Otherwise the message is `DS:0x41b9` ("%s은(는) 퇴각했다!", `8716`).

The `DS:0x41cc` ("전사했다") branch at `8725` is only reached when the officer is 0. The result
test at `8705` returns first, so in practice it is unreachable.

### Morale and confusion

- `898c(unit, v)` clamps v to 0..100.
  - **A drop** to a value < 30 (an unsigned compare, so a negative request never counts) confuses on
    `rand(5) < 3`.
  - **A rise**, or a set to 100 that does not lower morale, calls `8130`.
- `8130` (cure): if confused and on the field, `rand(100) < (lead + morale)/3` clears the flag.
- A confused unit does nothing in `ce50`.

### Start-of-turn regeneration (`1cb6:7cc8`)

```
heal = (rand(11)+15)*10; gain = lead/10 + rand(5) + 1     ; drawn for EVERY unit passed in
if not on field: return
if heal+troops < max and heal+troops+10 > max: heal = max - troops
if morale+gain < 100 and morale+gain+10 > 100: gain = 100 - morale
what = terrain 8/13 -> 3, terrain 14 -> 1; items 0x37 |= 2, 0x38 |= 1, 8 |= 3
what&1: troops = min(troops+heal, max); what&2: 898c(morale+gain)
class 12 (군악대): every adjacent unit (either side) gets mp += level/10+1, capped at maxMp & 0xff (a07a)
```

### Weather (`1cb6:4cac`)

`r = rand(6)`. Weather steps one toward r; a result of 0 is stored as 5 and 5 as 0.

### Level-up (`0cf5:6f64(officer, newTotal)`)

- Generic officers and officers at level ≥ 99 change nothing.
- Otherwise `level += total/100` with no clamp (`7580`), and `exp = total % 100`.
- Tactics whose learn level equals the new level are announced. The learn table is `DS:0x4510`,
  36×19, read with `loadLearnTable()`.

## Tactics

There are 36 tactics. Names: `DS:0x4438`. Power: `DS:0x44c8` (3 = area heal). MP: `DS:0x44ec`.

| t | kind | element/effect |
|---|---|---|
| 0–14 | damage, e = t/5 (0 fire, 1 water, 2 rock), p = power | `t%5 >= 3` also hits the adjacent enemies on valid terrain |
| 15–17 | confusion | t 17 also rolls for the adjacent enemies |
| 18–20 | morale drop | |
| 21–29 | single heal: kind 3 for t ≥ 27, 1 for t ≥ 24, else 2 | 1 troops, 2 morale, 3 both |
| 30–35 | area heal: kind 1 if t > 32 else 2, area `((t-30)%3)|0x80` | |

**Terrain check** (`1cb6:a392`): `DS:0x47bc` holds 4 terrains per element, padded with 0xff:
fire 1,7,0,6; water 4,0; rock 2,11. The padding entries are compared too.

**Cast** (`1cb6:b2d6(caster, t)`, target from `657e`) fails without spending MP if:

- MP < cost,
- the tactic is fire in rain,
- there is no target,
- or the terrain check fails.

On success, by tactic:

- **Damage**: `e91a(kind 2, (e<<4)|p)` on the target, plus the adjacent enemies for `t%5 >= 3`.
- **15–17**: `a2aa(BL=2)` succeeds → confused.
- **18–20**: `a2aa(BL=4)` succeeds → morale drop `min(u16(cLevel/10 + (p+2)*10 - tLevel/10), morale)`
  via `898c`.
- **21–29**: `a200` usefulness check, then `b8c0`. A heal is useless when kind 1 meets full
  troops, kind 2 meets morale 100 without confusion, or kind 3 meets both.
- **30–35**: `baf6`: every ally in the area, including the caster's own cell, gets `b8c0` with the
  caster bonus.

After a success: +8 exp for t ≥ 15 (+12 for class 12/18 casting 21–29), MP -= cost, flag 0x80.
Code: `castTactic()`.

`a2aa` (verified) takes AL caster, DL target and BL divisor:

- `pc = intel + level*intel/100`, `pt = (target's) / BL`.
- `r = rand(pc)`; `pt *= 2` for classes 12/15/18.
- Succeeds when `r > pt`.

The whole BL byte is the divisor.

**Heal** (`1cb6:b8c0`):

- Troops: `(p+1)*600` (+ `level*intel/20` with a caster) + `rand(that/10)`, capped at the missing
  troops.
- Morale: `(p+3)*10` (+ `level/10`) + `rand(that/10)`, then `min(100 - morale, m & 0xff)` via
  `898c`.

The troops draw comes first. Code: `healAmounts()`.

## Items in battle (`1cb6:ab86`)

Read; not executed. Used items are consumed (`6d1c`/`7590`) and the user gets flag 0x80.

| ids | effect |
|---|---|
| 0x00–0x02, 0x10–0x12 | class change to `[15,18,12,3,6,0][...]`. Refused for 유비, for the same class, when `class/3*3` equals the new class, or when the new move type cannot stand on the current terrain |
| 0x13–0x1a | promotion: from class `[0,1,3,4,6,7,9,10]` at level ≥ `[15,30,15,30,15,30,15,30]` → class+1 |
| 0x1b–0x20 | single heal: power `id%3`, kind `id >= 0x1e ? 1 : 2` (`b8c0`, no caster bonus) |
| 0x21 | special damage `min((rand(21)+90)*15, troops)`; if the target survives, morale -= `min(rand(10)+30, morale)`. No exp |
| 0x22–0x2a | bombs: element `2 - (id-0x22)/3`, power `(id-0x22)%3`, `e91a` kind 3 |
| 0x2b–0x2d | confusion, always succeeds; 0x2d also hits the adjacent enemies |
| 0x2e–0x33 | area heal (`baf6`, no caster bonus): kind `id >= 0x31 ? 2 : 1`, area `(id-0x2e)%3` |
| 0x34–0x36 | single heal kind 3, power `id-0x34` |

## AI

The AI is a literal port in `ai.ts`. Every helper below was verified against the original except
where marked; see [Verification](#verification).

### Per-unit flow (`1cb6:ce50(unit)`)

```
mp = scripted ? 100 : movePoints
if target != 0xff and units[target].status != 2: target = 0xff; mode = 1
if status != 2 or flags&0x80: return
if confused: return
c2be prepare
switch mode:
  0, 4: goal = target != 0xff ? pos(target) : (tx,ty)
        if scripted:
           if c9bc(flag 2, from own, to goal, maxCost 0xff) hits: dest = goal
           else: dest = own; (tx,ty) = own
        else:
           f = findFoe(mp)                         ; c9bc flag 8
           if target != 0xff and target == f: c4f2(50, goal); evaluate(mp)
           else:
             c4f2(30, goal)
             if c9bc(flag 2, from goal, to own, 0xff) hits: approach(goal); evaluate(mp)
             else dc00
  1:    dc00
  2:    evaluate(0); dest = own                    ; only its own cell
  3:    if findFoe(mp) != 0xff: evaluate(mp) else dest = own
c3f4: move along walkPath(dest -> own)              ; flag 0x40
8a6e: if target == 0xff and pos == (tx,ty) and mode in (0,4): mode = 3
if not scripted and mode != 4:
   if e520 == 0xff: cd4a attack: t = pickTarget(c018(classRange, new pos), e51c); attack if t != 0xff
   else: b2d6(e520) on e51c
```

- `evaluate(m)` is `c9bc` with flag 4 and maxCost m from the unit's cell; it calls `d6f8` on every
  reached cell.
- `approach(goal)` is `c772` mode 1 on the grid filled from the goal.
- `cd4a` does not attack for scripted units, mode 4, or units that already acted.

`planUnit()` / `applyMove()` / `aiTakeTurn()` implement this. The planning helpers are verified;
the move and act glue is read.

### `dc00`: attack nearest

```
if findFoe(mp) != 0xff: evaluate(mp); return
e = findFoe(0xff)
if e == 0xff: dest = own; return
if c9bc(flag 2, from pos(e), to own, 0xff) hits: approach(pos(e)); evaluate(mp)
(otherwise dest stays 0xff: the unit does not move)
```

### `c2be`: prepare

1. foeMap = 0xff. For every other-side unit on the field, mark the cells of the **moving unit's**
   class range shape centred on that enemy with the enemy's slot (`c018` with marking).
2. Influence = 0. A weak unit (`c280`) gets +50 on every terrain 8/13/14 cell.
3. Set `e524 = 0`, `e51c = e51e = e520 = 0xff`, `e525 = 0`.

### `c4f2`: influence spread

Arguments: AX = value, BX = position pointer.

```
spread(v, p): if v > 0 and terrainDef(p) != 255 and infl[p] == 0 and no unit on p:
                 infl[p] += v; for each neighbour: spread(v-20, n)
```

### `d6f8(cell)`: cell evaluation

```
if a unit other than the mover stands on cell: return
if not scripted:
  if mode != 4:
     phys = (foeMap[cell] != 0xff or cell == own) ? c58e(cell) : 0
     tac  = d0fa(cell)
     infl[cell] += max(phys, tac)                 (u8)
  infl[cell] += min(terrainDef/5, 255 - infl[cell]); +1 more on the unit's own cell
if infl[cell] > e524:
  if tac > phys: e520 = e521; e51c = e523
  else:          e520 = 0xff; e51c = e522          ; e522 may be stale from an earlier cell
  e524 = infl[cell]; e51e = cell
```

### `c58e` / `c616`: physical scores

- `c58e(cell)` sets `e522 = 0xff`. For every enemy in the class range from the cell:
  `s = (c616 >> 4) & 0xff`, minimum 1. It keeps the strict maximum in `e522` and returns it.
- `c616` (u16 arithmetic):
  - atk = attack (`7c90`, unit morale), def = defence (`7cac`), with the class triangle applied via
    `def ± def>>2`.
  - `dmg = def/2 < atk ? (atk - def/2)*(100 - terrainDef)/100 : 1`.
  - Score = `dmg + troops/6`, +30 if the target is the unit's current target.

### `d0fa` / `d2c4` / `d528`: tactic scores

For each castable tactic t (`30b9:0064`) with power p:

- **Area heal (p == 3)**: kind = t > 0x20 ? 1 : 2, sub = (t-30)%3. For the allies in area
  `sub|0x80`, including the own cell: score = `min(max(Σ d528 - 100, 0) >> 4, 255)`.
- **Otherwise**: targets in area `p|0x80`; allies when t ≥ 0x15, else enemies.
  Score = `min(d2c4 >> 4, 255)`, +30 when nonzero and the target is the current target.
- The best is kept in `e521`/`e523` and returned.

`d2c4(t, target)`:

| t | value |
|---|---|
| ≤ 14 | 0 for fire in rain or when `a392` fails. Else `v = u16(u16(((p+1)*4+e)*50 + (int_c + lvl_c*int_c/50))*2 - lvl_t*int_t/50 - int_t)`; `v += v/4` for fire on forest or water in rain; `v += rand(v/50)` |
| 15–17 | 0 if the target is already confused; else `(a2aa(BL=0x82) ? 300 : 0) + rand(300)` (0x82 divides by 130) |
| 18–20 | `min(lvl_c/10 + (p+2)*10 - lvl_t/10, morale) * (rand(10)+1)` |
| 21–29 | kind as in [Tactics](#tactics); 0 if useless (`a200`), else `d528` |
| ≥ 30 | 0 |

`d528(target, power, kind)`:

- **Troops part**: `(p+1)*600 + lvl*int/20 + rand(that/10)`, capped at the missing troops. 0 if
  below maxHp/10, else `+ (2-p)*50`.
- **Morale part**: `(p+3)*10 + lvl/10 + rand(that/10)`, capped at `100 - morale`. 0 if < 10, else
  `+ (2-p)*5`; ×20 if the morale is < 40.

**These estimates draw from the RNG.** An AI turn advances the seed even when the unit only moves.

## Script commands (battle side)

The script VM (`SCRIPT.md`) dispatches on map kind `ctx+0xb & 0xf0`; 0x30 is the hex battle. These
are the battle branches:

| Op | Name (SCRIPT.md) | Battle routine | Effect |
|---|---|---|---|
| 01 | MOVE o x y dir | `0cf5:9a88` → `2cb4:0130` | Refused if x ≥ width or y ≥ height. Otherwise: set flag 4 (scripted), mode 0, `(tx,ty) = (x,y)`, run `ce50` at once (BFS flag 2, unlimited moves, no ZOC), then clear flags 0xc4 |
| (wait) | — | `0cf5:9c00` → `2cb4:018e` | Returns 1 while `8a6e` says the unit has not arrived |
| 0a / 1a | PLACE / REINFORCE o | `0cf5:9984` → `2cb4:007e` | If the officer's unit is in reserve (status 1), find its deployment record, scroll there and put it on the field at the **record's** x,y (`8422`, facing from record flag bit 2) |
| 00 | TALK | `0cf5:9b9e` → `2cb4:0208` | Message box; if the speaker's unit is on the field, scroll to it first |
| 10 | DUEL o o | `2cb4:09d2` → `125e` | Starts the duel scene (`DS:0xe5b4`) between the two units |
| 11 / 29 | BATTLE_END w / GAME_OVER | `2cb4:01ba` | In battle mode (game mode 3): result = `param == 0 ? 2 : 3`; param 3 also plays song 4. GAME_OVER passes 3 |
| 16 | UNIT_ATTACK o o | `0cf5:9c5a` → `2cb4:02e4` | **No-op in battle** (it only marks the two characters busy) |
| 18 | REMOVE o | `0cf5:9cbc` → `2cb4:02e8` | Set flag 4, `8504` (leaves; events run), clear flag 4 |
| 1c | SET_AI o code | `2cb4:031a` | If `0cf5:0ef6(officer)` (AI-controlled officer, *inferred*): clear flag 4 and set mode = `DS:0x4fe6[code]` |
| 26 | MAP_CHIP x y kind | `2cb4:05e6` | Change a cell's chips and terrain; see below |
| 27 | MAP_EFFECT b b b | `2cb4:0420` | Map effect at a cell (*not traced*) |
| 28 | UNIT_FORCE o b | `2cb4:08f2` | Moves the officer's unit to a free slot on the **other** side (defection): `0cf5:2228(officer, b)`, copy the record (`0b84`; mode 7 if it becomes a player unit and the officer is not AI-controlled, else 3), free the old slot. Message `DS:0x501e` if no slot is free |
| 2b | DATA 4 w | `2cb4:0b72` | Battle state +0x24 = w (victory bonus exp) |
| 2d | HALVE b1 b2 | `2cb4:0a9a` | For every unit on the field of one side (b1: 0 player, else enemy): b2 == 0 halves morale via `898c` (can confuse), otherwise halves troops |
| 33 / 34 / 35 | duel ops | `2cb4:1824` / `1736` / `14d0` | 33 ends the duel and reloads the battle map (`373c`, redraw units, music). 34 is the clash animation: 5 rounds × (rand(3), rand(3), then rand(2) per frame unless both are 2). 35 plays duel action b for an officer |

**MAP_CHIP** (`2cb4:05e6(kind, y, x)`): kind bit 0x80 means replay (no scroll, no log).

- `kind & 0x7f == 2`: replace chips via `DS:0x500c` → `DS:0x5015` (9 pairs). If chip 0xd3 appears,
  the terrain becomes `DS:0x4ff7` or `DS:0x4ff9`, chosen by bit 0.
- Other kinds apply only when the cell's terrain is `DS:0x4ff6[kind]`. They add the per-chip-set
  offset `DS:0x4ffa[chipset*4 + kind]` to the 4 chips (0xc5 → 0xc7 and 0xc6 → 0xe6 are special) and
  set the terrain from `DS:0x4ff5[kind (+2 when bit 0 is clear)]`.
- Each live change is appended to the log at `DS:0xe5aa` as `{x, y, kind|0x80, terrain}`.
  `2cb4:0368` replays the log after every map load. The meaning of the changes (gates, bridges)
  is *inferred*.

## Quirks

These are reproduced on purpose:

- **Terrain 255 on map 32.** The original reads past its tables. The move costs are bytes
  `DS:0x400e + mt*20 + 255` = 0xc0, 0xc2, 0xd9, 0xae for move types 0..3, and the defence is 0x20
  (`moveCost()`/`terrainDefence()`). `a392` compares the 0xff padding too, so water and rock tactics
  accept that cell.
- **ZOC exemption is for the start cell**, not the target. The compare at `c9bc:cb83` is against
  `[bp+0x10]`.
- **A stale `e522`** can make `d6f8` record a physical target that is not reachable from the chosen
  cell. `cd4a` re-picks after the move.
- **The confusion probe** `a2aa(BL=0x82)` divides by 130, because the whole BL byte is the divisor.
- **Regeneration draws RNG for every unit** handed to `7cc8`, even empty slots and reserve units.
- **Max MP of exactly 256** is stored as 0.
- **No level clamp** in `6f64`: a big experience gain can pass 99.
- **The "follow the commander" code** (`e525` bit 0) is dead.
- **Morale setter**: a negative request never triggers confusion, but a set to 100 that does not
  lower morale still tries a cure.

## Verification

`tools/battle_ref.py` loads MAIN.EXE with relocations into `tools/dosemu.py` (Unicorn). It maps the
handles to scratch segments (`0x677a` → 0x5000, `0x6780` → 0x6000, `0x678c` → 0x7000, `0x6774` →
0x8000) and calls the original routines with DS = SS = DGROUP.

The inputs are random officers, items, maps (every terrain, plus 255) and unit layouts. It prints
JSON. Nothing from the game files is printed except computed numbers.

`web/test/battle-ref.test.ts` replays every case through the TypeScript code and compares outputs
**and the RNG seed afterwards**:

- `rand`, attack/defence/max troops/max MP/move.
- `df14`, `e26c`, `e2f4`.
- `a2aa`.
- `c018` (list, return value, marks).
- `c9bc` (flags 0).
- `c4f2`.
- `c2be` + `c9bc` flag 4 + `d6f8`, which covers `c58e`, `c616`, `d0fa`, `d2c4`, `d528`. Compared:
  the foe map, influence, grid, every AI scratch byte and the RNG.
- `dc00`, which covers `c772` mode 1.

The AI scratch bytes are seeded from the pre-call values (`ai0`), because the original keeps stale
values. Results: 4 seeds × 1500 cases (`BATTLE_REF_CASES=1500 BATTLE_REF_SEED=7|11|12|13`) all
match. The default run is 140 cases at seed 7.

Not executed (display-heavy), only read: `ce50` glue, `c3f4`, `cd4a`, `e91a`/`ec82` sequencing,
`e42e`, `b2d6`, `b8c0`, `baf6`, `ab86`, `7cc8`, `898c`, `8130`, `4cac`, `6f64`.

A call-graph walk to depth 5 from `1cb6:c3f4` (the move animation) finds no path to
`rand` (`0cf5:4884`/`48c4`). The computer move animation does not touch the RNG.

Run:

```
HERO_GAME_DIR=/path/to/game npx vitest run test/battle.test.ts test/battle-ref.test.ts
python3 -I tools/battle_ref.py /path/to/game 50 1 | head
```

## Battle screen and player phase

This is what the native battle scene (`web/src/native/battle/`) reproduces. Coordinates are screen
pixels, and the layout is 40 px lower than the original's own y because the frame is drawn at
y 40. Unless marked, the addresses are where the value was read. Strings are read from MAIN.EXE
at run time.

### Layout

- **Frame**: PACKGRP entry 1 (TF-DCE) at (0, 40). It already has the title box, the 기능 button and
  the 아군/적군 tabs.
- **HEXGRP entry 0** is 4-plane *interleaved*:
  - weather icons at `type*0x200` (32×32, at (592, 72); 0 맑음, 1 흐림, 2 비)
  - 기능 button, normal `0x600` and pressed `0x800` (64×16 at (16, 48))
  - tab header tile `0x1200`
- **Panel icons** (force, intelligence, leadership): MARK.R3 offset 0, 24×24, 3 planes, at
  x 456/512/568, y 140.
- **Map view**: 13×11 cells of 32 px from (16, 72).
  - A unit is HEXZCHR entry `2cb6:8264`. Frame f uses cells 4f..4f+3, and colour 0 is
    transparent.
  - The cells as stored face **left**. Units without flag 0x10 are drawn mirrored. The flag is set
    by `8d74`. `d8c4` (attack) and `ce01` (AI) face the target, setting 0x10 when the target's
    x is smaller.
- **Panel body**: black from (447, 112) to (630, 310). The frame picture has it blue there. This
  was measured on emulator screenshots; the routine that clears it was not traced.
- **Unit detail** `2cb6:9b4c`:
  - At y 116: name at column 0x39, class at 0x40, and `Lv%2u` (`DS:0x4249`) at 0x49.
  - At y 144: force, intelligence and leadership, `%3u` (`0x424f`), at columns 0x3c/0x43/0x4a.
  - Rows from `DS:0x4236` at y 172 + 24i: 병력, 사기치, 공격력, 방어력, 책략치, and 경험치 for the
    player side only.
  - Bars are at x 520, width 96. Attack and defence use the scale 2000.
- **Bars** `2cb6:52a6`:
  - A black rectangle at (x, y-1), w×10.
  - Fill `value*w/max`, made of 8×10 MARK patterns: `0x2208` when the tenths are below 3,
    `0x21e0` below 7, else `0x2230`.
  - The text has outline colour 0, at column `(x>>3)+(w>>4)-2*(kind+1)`, row y-4, in the format
    `%4u/%4u` (`0x3e9f`) or `%4u` (`0x3ea7`).
- **Unit list** `2cb6:5e0e`:
  - Rows at y = 20r + 114: name at column 0x39, troop bar at column 0x41, or `-전선이탈-` for a
    unit that left.
  - Tab 0 lists slots 0..14: own faction first, then the others, then those who left. The other
    tabs list slots 15..44.
- **Header** `8fbc`: the faction name (`DS:0xf1e` near pointers) plus `군`. Faction 14 (무소속)
  takes the faction of slot 0 or slot 15.
- **Minimap** origin:
  - x = `((0x28-W)*2/8 + 0x39)*8`
  - y = `((0x18-H)*2/8 + 0x23)*8 + 40`
  - Each chip is 2×2 px and each unit 4×4 (colour 2 player, 1 enemy). The chip colours in the
    port are approximated: the most frequent colour of the chip.
- **Title box**: `battleNameLines(HEXZMAP)[map]` + `DS:0x3dff` ("의 전투").
- **Turn banner**: `DS:0x3dc1` with turn + 1 and the weather name from `DS:0x3a4c[type]`.

### Player phase (`1cb6:44de`)

1. On turn 1, the victory window `4316` shows:
   - `0x3c82` chapter + battle name
   - `0x3c8f` 승리조건 and the objective
   - `0x3cb0` turn limit (later `0x3c98` current/limit)
2. The banner `DS:0x3d20` (Player군 순서), then `tryCure` for every slot.
3. Input loop:
   - Hovering a unit shows its detail panel.
   - Scrolling works at the view edges and with the arrow keys.
   - Clicking a tab switches the list; clicking the minimap centres the view.
   - Clicking empty ground goes to `7094`, a cheat-code input with no visible effect.
   - A right click or the 기능 button opens the battle menu (`DS:0x3aa0`): 턴 종료, 총퇴각
     (result 1 = retry the battle; refused with formation), 승리조건, close-up on/off
     (`battleOptions` bits 4..7), speed (bits 0..3), enemy moves shown (bit 12), BGM/SE flags, and
     quit.
   - Clicking a unit makes it blink 3 times (`9028`), then runs the unit command `a474`.
4. After each action the scene runs the unit's events (`8ad2`) and the victory check (`4abc`).
   When no commandable unit is left, the `DS:0x3d1c` confirm ends the phase.

**Unit command** `a474`:
- First the move `d972`:
  - The range is the flood fill with the unit's move points.
  - Refusals: not ours (`0x4d51`), not controllable (`0x4d66`), confused (`0x4d80`), already
    acted (`0x4da2`). A cell outside the range gives `0x4d3c`.
  - Clicking the own cell means "stay". A right click cancels and puts the unit back (`bcb2`).
- Then the menu of codes 1..4 from the far-pointer table `DS:0x430c`: 공격, 책략, 도구, 대기. A
  hidden unit gets the two-entry `DS:0x4866` menu (attack, or show itself after the `0x48aa`
  confirm).
- 공격 is target pick `657e`:
  - Marked cells come from the class range shape.
  - A click outside gives `0x3f33`; on an ally, `0x3f07`. With nobody in range, `0x3edb`.
  - Then `e91a` with the close-up, or the result text of `e4a6`.
- 책략 is `b2d6`:
  - The list is `castableTactics`; not enough MP gives `0x4b84`.
  - The target range is `TACTIC_POWER[t] | 0x80`: enemies for damage, confusion and morale
    tactics, allies for heals.
  - Message `0x4bda` for the player, `0x4b9e` for the AI.
- 도구 is `a8e2`:
  - The item list, then 사용한다 / 준다 / 버린다 / 본다 (`DS:0x4346`).
  - 준다 picks an adjacent ally with a free slot (`0x48f0` if it has none), message `0x48d8`.
  - 버린다: `0x4916`. No items: `0x48bd`.
  - Use (`ab86`):
    - Bombs 0x22..0x2a target an enemy at range power|0x80; fire is refused in rain (`0x4a80`).
    - Heals target allies; area heals go through `baf6`.
    - Confusion items 0x2b..0x2d.

**Events after an action** (`8ad2`), each repeated while the dispatch reports "keep going":
- position (trigger `unitAt`), area (`unitInArea`), and adjacency;
- then `auto`.

For adjacency (trigger 4), every occupied neighbour N..W is tried:
- first `p1 = acting officer, p2 = neighbour's officer`;
- for a player unit, then `p1 = 0x400` (any player unit).

The prologue's duel is block 5 record 5 of chapter 0 stage 0: `p1 = 1` (관우), `p2 = 5` (화웅).
It fires only when 관우 acts next to 화웅, not when 화웅 acts.

**Computer phases** `3f32`:
- Pass 0 runs the player-side units that the computer controls (mode ≠ 7).
- Pass 1 opens with the `적군 순서` banner and regeneration for slots 15..44, and runs the enemy
  units.
- The order comes from `3e12` (`actionOrder`). Each unit is `ce50`, then `8ad2`, then `4abc`.
- The move animation `c3f4` and the close-up drawing (`edb8..febc`) draw no random numbers, so
  turning the animation or the close-ups off changes nothing except the archer volleys above.

**Ending**:
- `BATTLE_END` sets the result. The script VM passes `lost` = "the next command is GAME_OVER",
  and the port maps that to 3, else 2.
- Losing plays song 4.
- A turn count reaching the limit (`ctx+0x3c6`) gives `DS:0x3da3`, retreats all of 유비's units,
  and sets result 3.
- A victory bonus (`DATA 4`) is shared out at `4a30`.

### Duel (script ops 10, 33, 34, 35)

Op 34 (`2cb4:1736`) runs five rounds:
- `a = (rand(3)+2)*2` and `b = (rand(3)+2)*2`;
- then, unless a == b == 8, one `rand(2)` per frame for 2 frames (it picks the clash sound).

The port draws the duel as two enlarged units facing each other. The draws are exact; the
animation is not.

## Open questions

- **The close-up port.** The screen layout is traced (see *HEXBMAP.R3: close-up backdrops*) but not ported yet. The port's
  close-up is a simplified panel (enlarged unit sprites, troop bar, the original result strings).
- **Status codes 5/6 and modes 5/6** are not produced by any battle routine that was read.
- **`MAP_EFFECT`** (`2cb4:0420`) is not traced.
- **`7b08`**, the free-cell search used when a deployment cell is taken, recurses N, E, S, W. The
  port uses a ring search, which can pick a different cell when several are free.
- **The RNG seed source** `0cf5:48aa` (called at game start) is not documented here.
- The player phase, its menus and the deployment bytes +9/+0xa are answered above (*Battle screen
  and player phase*, *Deployment records*).
