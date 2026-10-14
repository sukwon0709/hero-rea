# Data formats

Notes from reverse engineering the Korean DOS/V release of Koei's *Sangokushi Eiketsuden*
(삼국지영걸전, 三國志英傑傳; `MAIN.EXE` banner: "Rekoeition Sangokushi Eiketsuden PC-9801,DOS/V …
Programmed by T.FUJINUMA 1994,1995", built with the Microsoft C 7 runtime).

Text in the data files is Korean in EUC-KR (KS C 5601), e.g. `c1 a6 31 c0 e5` = "제1장".

## Files

| File | Used by | Contents |
| --- | --- | --- |
| `HERO.COM` | | Shell: loads `SBOPL2.COM` (OPL2 driver), `GRPDRV.EXE` (graphics driver) and `TFDED.COM` (TF-DCE image decoder), then runs `MAIN.EXE` and acts on its exit code: 0 = run `OPEN.EXE` then MAIN again, 1 = run `END.EXE` and quit, 3 = quit, 4 = restart MAIN (see docs/GAMEFLOW.md) |
| `OPEN.EXE` / `OPGRP.R3` / `OPMUSIC.R3` | opening | Intro graphics (Ls11) and music |
| `MAIN.EXE` | game | Engine (MS C 7, large model, 6776 relocations, not packed) |
| `END.EXE` / `END1GRP.R3` / `END2GRP.R3` / `EDMUSIC.R3` | ending | Ending graphics and music |
| `SNR0D.R3`…`SNR4D.R3` | MAIN | Scenario (chapter 0 = prologue … 4) event data, LS11 |
| `SNR0M.R3`…`SNR4M.R3` | MAIN | Scenario message text (EUC-KR) |
| `IPPAN0.R3`, `IPPAN0M.R3` | MAIN | "General" (일반) shared events and messages |
| `HEX*.R3` | MAIN | Hex battle maps (`HEXZMAP`, `HEXBMAP`), map chips (`HEXZCHP`, `HEXBCHP`), unit sprites (`HEXZCHR`, `HEXBCHR`, `HEXICHR`), battle UI (`HEXGRP`) |
| `MMAP.R3`, `SMAP.R3`, `PMAP.R3`, `MMAPBGPL.R3`, `SMAPBGPL.R3` | MAIN | Town/field maps and their background tiles |
| `SSCCHR1.R3`, `SSCCHR2.R3` | MAIN | Sprites for the TF-SSC software sprite system |
| `FACEDAT.R3` | MAIN | Portraits |
| `PACKGRP.R3` | MAIN | Packed UI/event pictures |
| `MARK.R3` | MAIN | Icons/marks |
| `BAKDATA.R3`, `BBKSDAT1.R3` | MAIN | Officer (무장) and item tables (EUC-KR names) |
| `ALL_FONT.16P` | MAIN | Full-width Hangul/Hanja/symbol font: 3478 records of 30 bytes = KS C 5601 code (u16 LE) + 16×14 bitmap (14 rows × 2 bytes, MSB = left) |
| `HANKAKU.FNT` | MAIN | 8×16 half-width font (96 glyphs × 16 bytes) |
| `FONT.R3` | MAIN | Extra glyphs |
| `MUSIC.R3`, `OPMUSIC.R3`, `EDMUSIC.R3` | | OPL2 music |
| `MSAVE*.R3S`, `ESAVE*.R3S`, `MSAVE.R3` | MAIN | Save slots |
| `DISK*.R3I` | MAIN | Disk labels (Shift-JIS "DOS/V 三國志英傑伝 ディスクN Ver 1.") |

## LS11 archives

Most `*.R3` graphics/map files are Koei LS11 archives (`tools/ls11.py`).

```
0x000  magic "LS11" (table big-endian) or "Ls11" (DOS/V graphics packs, table little-endian), padded to 16 bytes
0x010  256-byte dictionary (byte values ordered by frequency)
0x110  entries of 3 × u32: compressed size, uncompressed size, file offset; terminated by a 0 size
```

An entry whose compressed size equals its uncompressed size is stored raw. Otherwise the data
is an MSB-first bit stream of variable-length integers:

```
code(): read bits while they are 1 (n = number of bits read including the final 0),
        prefix = those bits as a number, then read n more bits → value = prefix + suffix
loop until output is full:
    c = code()
    if c < 256: emit dictionary[c]
    else:       distance = c - 256; length = code() + 3; copy from output[-distance]
```

This matches `OPEN.EXE` 0:9C4A (decoder) and 0:2A44 (bit reader). Every entry of every LS11 file
decodes cleanly except `OPGRP.R3` entries 27+ in this copy of the game, which appear to be
damaged (the bit stream desynchronises); those are intro animation frames.
