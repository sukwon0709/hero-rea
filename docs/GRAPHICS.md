# Graphics

This document covers how the game's images, palettes and text are stored and drawn. Each format has a
bit-exact TypeScript decoder in `web/src/formats/`, and `web/viewer.html` (the asset viewer) shows all of
them.

| Module | Contents |
|---|---|
| `tfdce.ts` | TF-DCE images (FACEDAT, PACKGRP), a port of TFDED.COM |
| `palette.ts` | palette tables, the 4→6→8-bit colour path, GRPDRV fades, the digital-8 reduction |
| `sprites.ts` | planar layouts, cells, tile sets, unit and close-up banks, SSC sprites, MARK.R3, rooms and world maps |
| `font.ts` | ALL_FONT / HANKAKU glyphs, MAIN's text console and blitter modes, FONT.R3, END bold text |
| `npk.ts` | NPK016 pictures from the opening and ending (OPGRP, END1GRP, END2GRP) |

## Conventions

**Addresses.**
- `seg:off` addresses are MAIN.EXE load-image segments with the MZ header (0x6A00 bytes) stripped. Ghidra
  shows them as segment + 0x1000.
- The `0000` segment holds the low-level graphics code. `0cf5`, `1cb6` and `2cb4` hold game code.
- DGROUP is image segment 0x313A, so `DS:X` sits at file offset 0x6A00 + 0x313A0 + X.
- OPEN.EXE and END.EXE addresses are image offsets in their segment 0.

**Screen.**
- GRPDRV sets up 640×480 VGA with 16 colours (AH=20h reports 640×480).
- The game draws a 640×400 area starting 40 lines down. Every MAIN drawing routine adds the VRAM base
  0xC80 (= 40 × 80), so a pixel's byte offset is y·80 + x/8 + 0xC80.
- The routines that take y + 0x28 (40) are the exception. They are the 0000:5A10 and 0000:8371 callers
  (wrappers 0000:44F6 and 0000:44AE), which pass the full-screen row.

**GRPDRV.**
- The graphics driver is reached through a far-call table that MAIN copies at 0000:CA67. The driver's
  handler table is at GRPDRV 0:003D.
- The handlers end in `RETF`, so the reference tools call them directly instead of through `int 18h`.
- The function list is in [GAMEFLOW.md](GAMEFLOW.md#grpdrv-graphics-driver-api).
- MAIN's wrappers, all in segment `0000`, map to these functions:

  | Wrapper | AH |
  |---|---|
  | CB0C | 00 |
  | CB1C | 01 |
  | CB24 | 02 |
  | CB33 | 03 |
  | CBAC | 08 |
  | CC14 | 0C |
  | CC47 | 0D |
  | CCA0 | 0F |
  | CCD1 | 10 |
  | CCFE | 11 |
  | CD6F | 15 |
  | CD88 | 16 |
  | CE46 | 1B |
  | CE5B | 1C |

  The other wrappers have no callers. All images and text are drawn by MAIN's own code in segment
  `0000`, not by GRPDRV.

**Pixels in the TypeScript API.** Every decoder returns `IndexedImage` {width, height, pixels} with one
colour index (0..15) per byte. Values above 15 mark empty or transparent pixels, as cell sheets use them.

## Palettes

### Colour path

GRPDRV keeps 16 entries of 4 bits per channel. MAIN stores them as `[B, R, G]` byte triples, the PC-98
order.

| Step | Formula | Where |
|---|---|---|
| 4 bits → 6-bit DAC | v6 = (v << 2) \| (v >> 2) | GRPDRV 0:28CD, called by AH=15h at 0:28F2; `scale4to6` |
| 6-bit DAC → 8 bits | (v6 << 2) \| (v6 >> 4) | a VGA/DOSBox display; `dac6to8` |

### MAIN.EXE palette table: DS:1050, 9 × 16 × [B, R, G]

`readMainPalettes`. The table is read through these routines:

| Routine | What it does |
|---|---|
| 0cf5:497E (AL = palette, DL) | DL = 0: fades to the palette, 16 steps with 2 vertical-retrace waits per step (GRPDRV AH=16h). Otherwise sets it at once (AH=15h). |
| 0cf5:49F6 | sets the scene palette at once |
| 0cf5:4A08 | fades to palette AL |
| 0cf5:4A10 | fades to the scene palette |
| 0cf5:4A22 | fades all 16 entries to black |

The scene palette is the location mode, `[DS:7A6C+5] & 0xF` (read by 0cf5:21EA, written by 0cf5:ACD8).
The same nibble selects the screen ([GAMEFLOW.md](GAMEFLOW.md#main-loop--0cf5a88c)).

| Palette | Use | Evidence |
|---|---|---|
| 0 | town (SMAP rooms) | mode 0, written at 0cf5:12869 (code path only) |
| 1 | world map | mode 1, written at 0cf5:E791 (code path only) |
| 2 | palace / indoor (PMAP rooms) | mode 2, written at 0cf5:128B7; **verified**: a PMAP room matches the emulator pixel for pixel |
| 3 | battle | mode 3, written at 0cf5:C833 (code path only) |
| 4 | PC-98 digital 8 colours twice | set after PACKGRP pictures, around 0cf5:AA80–AAC6 (inferred from the code; not watched) |
| 5 (= 8) | camp, menus, dialogue | observed: every menu and dialogue screenshot uses only colours of palette 5 |
| 6, 7 | unknown | |

- Entries 0–7 are the same UI colours in every palette except 4.
- Palettes 5 and 8 are identical.
- `PAL` in `palette.ts` names these uses.

### Fade: GRPDRV AH=16h at 0:2924

- Every step interpolates from the starting DAC values. For each 6-bit channel c and target t,
  q = floor(|t − c| · k / steps), and the new value is c + q when t ≥ c, else c − q.
- Before each step the driver waits a number of vertical retraces (0:3005). MAIN uses 16 steps and 2 waits.
- `fadeSteps` reproduces the DAC after every step bit for bit. `tools/palette_ref.py` runs GRPDRV's own
  code for comparison.

### Digital-8 reduction: 0cf5:4910

- The luminance is Y = (B·0x72 + G·0x24B + R·0x12B + 0x42F) / 0x85E, giving a level 0..7.
- The colour becomes entry Y of the digital table at DS:0CFE.
- 0cf5:497E applies the reduction only when bit 3 of `[DS:7A80+0xA]` is clear (read by 0cf5:41CE). On VGA
  the game shows full colour.
- `toDigital8` implements it.

### END.EXE palette table: image offset 0xC058, 43 × 16 × [B, R, G]

`readEndPalettes`. The table was found by content:

- Entry 1 colours END1GRP picture 19 exactly as the emulator shows it.
- Entry 31 equals MAIN palette 0.
- Entries 29 and 33 equal MAIN palette 2.

Which entry END.EXE uses for each picture is not traced.

## Pixel layouts

All layouts are VGA planar: plane p holds bit p of each colour index, and the MSB of a byte is the leftmost
pixel.

| Layout | Bytes | Drawn by | Used for | TS |
|---|---|---|---|---|
| plane-major ("cell") | all rows of plane 0, then planes 1, 2, 3; rows are w/8 bytes. A 16×16 cell is 128 bytes. | 0000:6296 (opaque cell). Masked cells use 0000:5C32, where mask = NOT(p0\|p1\|p2\|p3), so colour 0 is transparent. | every tile and unit bank, SSCCHR | `decodePlanar`, `decodeCell` |
| byte-interleaved, 4 planes | for each 8-pixel column, the bytes of planes 0, 1, 2, 3 | 0000:5BEE → 0000:5A10 | MARK buttons and pictures | `decodeInterleaved` |
| byte-interleaved, 3 planes | planes 0, 1, 2 per column; plane 3 = 0 | 0000:8494 → 0000:8371 | MARK icons and frame tiles | `decodeInterleaved(…, 3)` |
| 16×16 interleaved tile | 4-plane interleaved, 128 bytes, drawn in quadrants by a mask (1 TL, 2 TR, 4 BL, 8 BR) | 0000:7E4A | MARK window backgrounds | `decodeInterleaved` |
| 1-bit bitmap | w/8 bytes per row | 0000:628E → 61AF / 614C / 60F2; 0000:6976 (two colours) | glyphs | `blit1`, `blit2` |

**Raster modes of the interleaved blitters 5A10 and 8371.** The low byte selects:

- 0 copy
- 1 XOR
- 2 AND
- 3 OR
- 4 transparent (colour 0 is skipped)

Bit 15 draws every row twice.

**Modes of the 1-bit blitter 628E.** The mode is AH of the colour word:

- 0: opaque (set bits take the colour, clear bits become 0)
- 1: XOR
- 2: AND (clear bits AND the screen with NOT colour)
- 3: OR
- 4: transparent
- above 4: the blitter set-up of the previous call is kept (0000:614C)

Bit 7 doubles rows. 0000:6976 draws pixel = bit ? fg : bg.

**Verification.** `tools/blit_ref.py` runs these MAIN.EXE routines in an emulator. `web/test/sprites.test.ts`
compares `decodeCell`, `decodeInterleaved`, `blit1`, `blit2` and `dilate` against them, covering every mode
and doubled rows, byte for byte.

## TF-DCE images (FACEDAT.R3, PACKGRP.R3)

**Containers.** Both files are a table of `{u32 offset, u16 size}` followed by the blobs
(`splitOffsetTable`).

| File | Contents | Drawn by |
|---|---|---|
| FACEDAT.R3 | 240 portraits, 64×80 | 0cf5:51B2 |
| PACKGRP.R3 | 38 pictures | 0cf5:520E |

PACKGRP sizes:

| Entries | Size |
|---|---|
| 0–1 | 640×400 |
| 2 | 512×320 |
| 3–33 | 224×144 |
| 34 | 208×112 |
| 35 | 208×24 |
| 36 | 272×40 |
| 37 | 176×112 |

**Decoding.**
- MAIN decodes a blob through TFDED.COM's `int 62h` with a parameter block (0cf5:52D4). It always passes
  flags = 1, which enables plane 3.
- TFDED.COM decodes straight into VGA memory, and the format relies on that. Back references read bytes
  already written to the same plane or to other planes.
- `tfdce.ts` therefore decodes into a model of the four 64 KiB planes.

**Header.**

| Offset | Size | Field |
|---|---|---|
| 0 | u8 | header length, always 2 |
| 1 | u8 | `'T'` |
| 2 | u8 | width in bytes |
| 3 | u16 | height |
| 5 | u16 | four 4-bit plane methods, pass 0 in the low nibble |
| 7 | u8 | four 2-bit physical plane numbers |
| 8 | u8 | flags: bit 6 means 16 palette words follow (never set in the game); bit 5 means a macro table follows (a count byte, then words) |

**Plane methods.**

| Method | Effect |
|---|---|
| 0 | keep the plane. On plane 3 it clears the plane instead: TFDED 0x2A4 leaves BH = 0. |
| 1 | fill with one byte |
| 2 | copy another plane |
| 3 | compressed |

**Compressed planes (TFDED 0x326).**
- The decoder walks byte columns top to bottom, then bottom to top (serpentine).
- Opcodes below 0x20 index the macro table, giving {op, arg}.

| Opcode (high nibble) | Effect |
|---|---|
| ≥ A | run of (op − 0x9E) copies of one byte |
| 8 | nibble-doubled byte pair, repeated |
| 6 | literal byte pair, repeated |
| 7 | literal bytes |
| 4 | copy from a distance back, in linear VRAM order |
| 5 / 9 | copy another plane through a mask kept in a 4-entry move-to-front list (00, FF, 55, AA); 9 rotates the mask |
| 3 | copy another plane: plain, inverted or rotated |
| 2 | copy from a distance back, in serpentine order |

The code comments in `tfdce.ts` give the TFDED offsets for each case.

**Verification.**
- `tools/tfdce_dump.py` runs the original TFDED.COM (`tools/tfdce_ref.py`) on all 278 images with flags 0
  and 1. It records hashes of the decoded rectangle and of all four planes.
- `web/test/tfdce.test.ts` matches all 556 cases. Set `HERO_TFDCE_REF` to the JSON file, which is kept
  outside the repo.
- These two files hold the only TF-DCE images in the game.

## Cell banks and tile sets

Every bank is LS11 and made of 16×16 plane-major cells.

| File | Entries | Layout | Palette |
|---|---|---|---|
| HEXZCHR.R3 | 47 × 1024 B | one unit per entry: 8 cells, cell = dir + 4·frame, dir 0..3, frame 0..1. 1cb6:6C28 draws cell 2·(v & ~3) + (v & 3) + (frame ? 4 : 0). `unitFrames` | 3 |
| HEXICHR.R3 | 78 × 4608 B | close-up officer: 36 cells, 6×6 (96×96). `squareFrame` | 3 |
| HEXBCHR.R3 | 169 × 2048 B + 12 × 1152 B | close-up soldier poses, 16 cells, 4×4 (64×64). Entries 169..180 are effects such as arrows: 9 cells, 3×3 (48×48). 1cb6:F11A selects 9 cells and entry 0xA9 + n; 1cb6:F153 selects 16. The row-major cell order is inferred from the images. | 3 |
| HEXZCHP.R3 | 10240 / 22272 / 22400 B | battle map chips. Entry 0 is always loaded; the second set is entry 2 for the maps listed at DS:3DCC, entry 1 otherwise (see [BATTLE.md](BATTLE.md#chip-sets-hexzchpr3)). | 3 |
| HEXBCHP.R3 | 28672 B | close-up backdrop chips, laid out by HEXBMAP | 3 |
| HEXGRP.R3 | 14592 B, 1576 B, 2016 B | entry 0: 114 cells of battle UI. **Entries 1 and 2 are EUC-KR text, not graphics.** | 3 |
| MMAPBGPL.R3 | 32640 B | 255 world-map tiles | 1 |
| SMAPBGPL.R3 | 27136 B, 30976 B | entry 0: town tiles (212); entry 1: palace / indoor tiles (242) | 0 / 2 |

- Close-up sprites are mirrored by bit-reversing each byte and swapping the bytes of a row (1cb6:F1CB,
  2cb4:0E9C). `decodeCell(…, mirror)` and `squareFrame(…, mirror)` do this; `squareFrame` also reverses the
  column order of the cells.
- The palette column for HEX\* files follows from the battle mode (scene palette 3). It has not been
  compared with a battle screenshot.

### Rooms: SMAP.R3 (12 entries) and PMAP.R3 (23 entries)

Loaded by 1cb6:0F9A (see [GAMEFLOW.md](GAMEFLOW.md#main-loop--0cf5a88c) for which entry a location uses).

| Bytes | Contents |
|---|---|
| first 640 | the 32×20 BG map, one SMAPBGPL cell per byte (`renderTileMap`). SMAP uses SMAPBGPL entry 0; PMAP uses entry 1. |
| next 640 | 0x7F or 0xFF per cell. Not graphics; probably walkability (inferred). |
| rest | 4-byte object records, drawn as SSCCHR1 objects and SSCCHR2 people |

The format of the object records belongs to the maps documentation.

**Verified:**
- PMAP entry 4 with SMAPBGPL entry 1 and palette 2, placed at (16, 56), matches an emulator screenshot
  pixel for pixel. The only differing pixels are under objects and people.
- The viewer's canvas reproduces the same result (18115 of 163840 pixels differ, all under sprites).

### World maps: MMAP.R3 (4 entries)

- The chapter index c comes from 0cf5:77DA(DS:7A80).
- The MMAP entry is the u16 at DS:2F9C + 2c: 0, 0, 1, 2, 3 for chapters 1..5.
- The size in 16-pixel tiles is DS:2F06[2c] (width) and [2c + 1] (height), read by 0cf5:D722: 96×96,
  96×96, 72×112, 120×88, 112×128.
- 0cf5:D722 halves the value when AL = 1.
- An entry holds width·height tile bytes (MMAPBGPL cells, row-major), then (width/2)·(height/2)/8 bytes:
  one bit per 2×2-tile block. The loader is 0cf5:E41C; what the bits mean is not traced.
- `readWorldMaps` reads the sizes. The test checks every entry's length against the formula.

## SSC sprites

**SSCCHR1.R3 (12 entries): furniture and objects.** Loader 0cf5:4AF8.

| Field | Contents |
|---|---|
| u8 | n, the number of sprites |
| n × {u8 w, u8 h, w·h cell bytes} | sprite size in cells and its cell indices; 0xFF = empty |
| u8 | number of cells |
| that many × 128 bytes | the cells |

- The game adds a running base to the cell bytes when it loads several banks.
- `parseSsc1` and `renderSsc1Sprite` decode it. The test checks that every entry is consumed exactly.

**SSCCHR2.R3 (29 × 2560 B): townspeople.** Loader 0cf5:4D5C.
- Each entry holds 4 frames of 32×40, each plane-major: front, front, back, back.
- The game copies a frame into a 32×48 buffer (at y = 8 or 0) and cuts it into 2×3 cells.
- `decodeSsc2` decodes it.

## MARK.R3: the UI bank

One LS11 entry of 14584 bytes, loaded at 0cf5:A436 into the handle at DS:679E. Regions are offsets into
the entry; the list is `MARK_REGIONS`.

| Offset | Contents | Layout | User |
|---|---|---|---|
| 0x0000 | 3 command icons, 24×24 | 3-plane | 2cb6:9B4C |
| 0x0288 | 47 frame tiles, 8×8 | 3-plane | 2cb6:6EC2 |
| 0x06F0 | 32 window-background tiles, 16×16 (8 patterns of 2×2) | quadrant tile | 1cf5:53BE via 0000:7E4A |
| 0x16F0 | 6 buttons, 16×16 | 4-plane | 1cf5:19D0 / 1982 |
| 0x19F0 | 3 buttons, 48×20 (확인 / Yes / No) | 4-plane | 1cf5:1AC8 |
| 0x1F90 | button background, 8×20 | 4-plane | 1cf5:1AC8 |
| 0x21E0 | 3 patterns, 8×10 | 4-plane | 2cb6:52A6, 1cf5:C996 via 0000:833E |
| 0x2338 | 12 mouse cursors, 0x90 B each | AND/OR masks | 1cf5:1244 |
| 0x29F8 | 8 tiles, 8×8 | 3-plane | 2cb6:6EC2 |
| 0x2AB8 | picture, 48×32 | 4-plane, drawn with mode 4 | 1cf5:FBCA |

The `1cf5`/`2cb6` addresses are in Ghidra numbering (image segment + 0x1000).

**Not identified:** 0x1FE0–0x21DF, 0x2258–0x2337 and 0x2DB8–0x38F7.

**Cursors** (`decodeCursor`, `renderCursor`).
- Each cursor is 24 rows × 3 bytes of AND mask, then 24 × 3 bytes of OR mask.
- 0000:B895 copies it, 0000:BABE pre-shifts it, and 0000:BBCA draws it: each plane is ANDed with the mask
  and ORed where the cursor colour has that plane bit.
- The colour is set by 0000:B937 to 7, called from 0cf5:0F86.
- The hot spot is (1, 1): 0cf5:11FA, int 33h AX=9.

**Verified:** the 확인 / Yes / No buttons match the emulator's yes/no dialog with 0 differing pixels. The
viewer's canvas was compared against the screenshot.

## Text

MAIN draws all text itself (`font.ts`).

### Fonts

| File | Contents |
|---|---|
| ALL_FONT.16P | 3478 records of 30 bytes: u16 code, then 16×14 (14 rows × 2 bytes) |
| HANKAKU.FNT | ASCII 0x20..0x7F, 8×16 (16 bytes per glyph) |

- **Glyph fetch (0cf5:0D44).** Two-byte codes from 0xA1A1 to 0xFDFE read 28 bytes at 30·idx + 2. The index
  comes from 0cf5:0D16: (hi − (hi ≥ 0xB0 ? 0xA4 : 0xA1))·94 + lo − 0xA1. All 3478 records match their own
  codes under this formula.
- **Missing files.** A missing font file draws solid blocks (0xFF fill at 0cf5:0D74 / 0DDA). A short read
  gives 0x0F0F.

### The text object

Dialogue uses the object at DS:6390. Init is 0cf5:0873. `TextState` mirrors its fields:

| Offset | Field | Default / notes |
|---|---|---|
| +1E | mode | bit 6 doubles the advance; bit 5 is vertical writing |
| +1F | fg | |
| +20 | bg | non-zero selects the opaque two-colour blit |
| +21 | x | in bytes |
| +23 | y | in pixels |
| +25 / +27 | column limits | 0 / 0x4F |
| +29 / +2B | row limits | 0 / 0x18F |
| +2D | margin | |
| +2F | outline colour | |
| +31 | line pitch | 0x12 (18) |
| +37 | hidden | |
| +39 | outline on | |

The colour setters 0cf5:0994 (fg), 09BC (bg) and 09E4 (outline) ignore values above 15.

### Character handler (0cf5:0A2E)

Ported as `TextConsole.putByte`.

- **EUC-KR pairing.** A lead byte 0xA1–0xC8 waits for a trail byte 0xA1–0xFE.
- **Newline.** 0x0A starts a new line (0cf5:096E): x = margin, y += pitch.
- **Carriage return.** 0x0D returns to the margin.
- **ESC sequences:**
  - `=` row col: 8-pixel rows, both values + 0x20
  - `C` fg
  - `B` bg
  - `F` outline colour (hex digit)
  - `G` outline on/off
  - `M` mode
  - `R` margin
  - `W` wait for input
- **Wrapping.** Text wraps when x passes the right limit. Two-byte codes need two columns. Codes
  0x2122–0x2125 do not wrap at the default limit.
- **Swallowed space.** After a CR, newline or wrap, one space is dropped (flag at DS:64DE).
- **Advance.** 1 or 2 columns, doubled when mode & 0x40. Vertical mode moves down instead.

### Drawing a character (0cf5:0E24)

1. If outline is on, the glyph dilated by 3×3 (0000:84A4: a horizontal pass, then a vertical one, within
   the 16-row box; `dilate`) is drawn first with mode 4 in the outline colour.
2. The glyph is then drawn with `blit1` in fg and the object's mode, or with `blit2` (fg/bg) when bg ≠ 0.

`renderText(font, bytes, opts)` renders an EUC-KR byte string into a new indexed bitmap.

**Verified:**
- The chapter caption "제1장 계교 전투" matches the emulator: 361 of 361 white pixels.
- The caption's black drop shadow comes from another routine that has not been identified.

### FONT.R3

- 87 glyphs of 16×16 (32 bytes each), read raw by 0cf5:A6A0.
- The glyphs GRPDRV already has under the same codes are saved first with AH=11h (0cf5:A6F8).
- The new glyphs are then registered with AH=1Ch under the codes listed at DS:2980 (0x7621..0x767E).
- MAIN's own text path never uses GRPDRV glyphs, so these only matter to GRPDRV text output.
- `parseFontR3` and `readGaijiCodes` read them.

### END.EXE captions

- END.EXE draws its captions with the same glyphs made bold: each row is ORed with itself shifted one pixel
  right (`embolden`, `renderText({bold: true})`).
- Inferred from the emulator: an ending caption matches 1757 of 1757 pixels. END.EXE's text routine is not
  traced.

## Opening and ending (OPGRP.R3, END1GRP.R3, END2GRP.R3)

All three are `Ls11` archives (little-endian table) with 62, 72 and 25 entries.

### NPK016

`npk.ts`.

**Header.**

| Offset | Size | Field |
|---|---|---|
| 0x00 | 6 | `"NPK016"` |
| 0x06 | u16 | 4 |
| 0x08 | u16 | 640 (screen width) |
| 0x0A | u16 | 400 (screen height) |
| 0x0C | u16 | width |
| 0x0E | u16 | height |
| 0x10 | 16 × u16 | palette, 0GRB |
| 0x30 | | data |

**Decoder.** OPEN.EXE and END.EXE share the same code: 0x06E4 is the entry, 0x073F the row loop, 0x07BD
the row conversion.

- **Row words.** A row is (width + 3)/4 little-endian words. Each word holds 4 pixels as four 4-bit plane
  slices.
- **Ring buffer.** Rows are LZ-coded into a ring of 5 rows × 0x140 bytes. OPEN.EXE keeps it on the stack at
  bp−0x75A.
- **Flags.** Flag bits come LSB first from a byte that is read when the previous 8 are used up.
- **Flag 0.** One literal word.
- **Flag 1.** A byte b, then a copy of (b & 0x1F) + 1 words:
  - from ((b >> 5 & 3) + 1)·2 bytes back;
  - or from that many rows back (× 0x140 bytes) when b & 0x80;
  - the source wraps backwards around the ring.

  A copy may run past the row end; the excess is overwritten by the next row.
- **Row conversion (0x07BD).** For words w1 = b1:b0 and w2 = b3:b2, the output plane bytes are
  [b1lo·16 + b3lo, b1hi·16 + b3hi, b0lo·16 + b2lo, b0hi·16 + b2hi]: byte-interleaved planes 0..3. An odd
  final word fills only the high nibbles.
- **Calling convention.** The caller passes far pointers to the source, the output and the ring
  (`call 0x6E4` at OPEN 0x2FFD, 0x710C, 0x7181).
- **64 KiB limit.** The output pointer does not cross segments. Pictures whose output exceeds 64 KiB (640
  wide, or END1GRP #33 at 408×400) would wrap in the original. `decodeNpk` writes linearly instead
  (untested).

**NPK entries:**

| File | Entries | Sizes |
|---|---|---|
| END1GRP | 0, 19, 33, 38, 39, 47, 48, 55, 68 | e.g. #19 is 544×176 |
| END2GRP | 0, 1, 8, 9, 10 | |
| OPGRP | 0, 3, 8, 10, 14, 18, 19, 20 (among entries 0–26; later entries are damaged) | 8, 10, 14 are 464×272 |

**Palettes.**
- The header palette is often a default digital palette, not the one shown. END1GRP #19 is shown with END
  palette 1.
- The OPEN.EXE palettes are not located.

**Verified:**
- `web/test/sprites-npk.test.ts` runs OPEN.EXE's decoder (`tools/npk_ref.py`) on 7 pictures and matches its
  output byte for byte.
- END1GRP #19 with END palette 1 matches the emulator screenshot of the ending everywhere except where
  rider sprites are drawn on top: 0 differing pixels outside x 289–511.

### Raw entries

- The other entries are raw byte-interleaved 4-plane bitmaps.
- Pairs of equal size often start with FF… and 00… respectively, which looks like an AND mask followed by
  an image (inferred).
- They are composed off screen by OPEN.EXE 0x0288, a memory-to-memory blit between 4-plane interleaved
  buffers. Its arguments are: destination, destination width and height, x, y, source width and height,
  mode (0 copy, 4 colour 0 transparent), and source.
- The sizes are constants at each call. For example, OPGRP entry 60 is blitted as 16×24 at (232, 168) into
  NPK #8 (464×272); see OPEN 0x2FC5–0x3030.
- Raw sizes have not been extracted. The viewer shows raw entries at a guessed width and lets you set it.

### OPGRP.R3 is damaged in this copy

- From entry 27 on, back references go out of range; this is first detected at file offset 0x604D6.
- Every stored (uncompressed) entry before 0x60000 starts with `NPK016`; those after it do not.
- So the file is damaged from about 0x60000. The cause is presumably a bad disk cluster (inferred).
- Entries 0–26 decode.

## Tools and tests

| Tool | Ground truth for |
|---|---|
| `tools/tfdce_ref.py`, `tools/tfdce_dump.py` | TFDED.COM, all TF-DCE images |
| `tools/palette_ref.py` | GRPDRV AH=15h / 16h (set and fade) |
| `tools/blit_ref.py` | MAIN.EXE blitters 6296, 5BEE, 8494, 7E4A, 628E, 6976, 84A4 |
| `tools/npk_ref.py` | the OPEN.EXE NPK016 decoder |

- The tests are `web/test/{tfdce,palette,sprites,sprites-npk,font}.test.ts`.
- They need `HERO_GAME_DIR`. The reference comparisons also need `python3` with `unicorn` (used by
  `tools/dosemu.py`) and are skipped without it.

**The asset viewer** is `web/viewer.html` with `web/src/viewer.ts`.
- It loads the game files with the same picker and cache as `play.html`.
- Groups: palettes and fades, portraits, event pictures, battle units, close-ups, tile sets, rooms, world
  maps, town sprites, MARK, fonts with a live EUC-KR text renderer, and the opening/ending pictures.
- "auto" uses the palette the game uses for each asset; any MAIN or END palette can be forced instead.

## GRPDRV raster modes and END.EXE blitters (native cutscenes)

These rules are what `web/src/native/cutscene.ts` implements.
* **put (AH=0Fh).** The mode set by AH=08h picks the routine from the table at GRPDRV `0:4047`: 0 copy
  (`3B40`), 1 XOR (`3CED`), 2 AND (`3C53`), 3 OR (`3D76`), 4 transparent, colour 0 skipped (`3EDC`), 5 NOT
  (`3DFF`). Rows from 400 down are left untouched (seen on the emulator; the clip code is not traced).
* **1-bit images (AH=13h, `0:4431`).** VGA write mode 3 with read mode 1. The function select comes from
  `0:2F66` (`[0, 18h XOR, 08h AND, 10h OR, 0, 0]`): set bits get the foreground and clear bits the background,
  both combined with the screen. Mode 4 skips clear bits and mode 5 swaps the two colours.
* **AH=1Ah** waits for vertical retrace (END `0:2B0B`; inferred from GRPDRV `0:3005`).
* **END `0:0AC7` mask blit.** One source byte per 8 pixels is applied to the four plane bytes: mode 2 ANDs,
  mode 4 ORs (it also toggles AH, reproduced), mode 0 copies. Clipping is done by `0:024C`. The source skip after
  each row is (source width in columns − columns)·4. This looks like an original bug and is reproduced.
* **END `0:0E26`/`0:0DBC`** write planes straight to VRAM. Arguments are in 8-pixel columns and the raster
  mode is ignored.
* **Emulator caveat.** The repo's `tools/dosemu.py` VGA model ignores read mode 1 (colour compare), so GRPDRV
  1-bit images come out wrong there. A scratch copy with the fix (and a GRPDRV high-level shim that honours the
  mode-1/2/3/5 function select) was used for the END comparisons above. Porting that fix to the repo tool is
  left to its owner.

## Open questions

- Palettes 0, 1 and 3 (town, world map, battle) are confirmed only by the code path, not by screenshots.
  Palettes 6 and 7 are unused as far as known.
- The routine that draws the status caption's drop shadow.
- MARK.R3 regions 0x1FE0–0x21DF, 0x2258–0x2337 and 0x2DB8–0x38F7.
- The meaning of the MMAP block-bit layer and of the second 640 bytes of SMAP/PMAP.
- OPEN.EXE / END.EXE: the palette for each picture, the size of each raw entry, and the sprite
  composition. END1GRP #20+ hold the rider overlay of picture 19.
- How the HEXBMAP layouts place HEXBCHP chips on the close-up screen (see BATTLE.md).
