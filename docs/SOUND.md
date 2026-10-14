# Sound: SBOPL2 driver, music and sound effects

The game's sound is FM only: Koei's `SBOPL2.COM` ("Sound Blaster BGM Driver Version 1.01,
Copyright (C) 1991-93 KOEI") is loaded by `HERO.COM` as a TSR, drives an OPL2 (YM3812) at
ports 0x388/0x389 and is called through `int 66h`. Music lives in `MUSIC.R3`, `OPMUSIC.R3`
and `EDMUSIC.R3`; the sound effects are a bank inside `MAIN.EXE`.

The web port (`web/src/audio/`) contains a register-exact TypeScript port of the driver
(`sequencer.ts`), an OPL2 emulator (`opl.ts`), the file parsers (`music.ts`) and WebAudio
output (`player.ts`, `worklet.ts`, `synth.ts`). `web/sound.html` is a sound test page.

Addresses: `SBOPL2.COM` offsets are CS offsets with the PSP at CS:0000 (so the file starts at
0:0100). `MAIN.EXE`/`OPEN.EXE`/`END.EXE` addresses are image `seg:off` (Ghidra = seg + 0x1000).

## 1. Driver installation and timing

* Entry 0:0100 jumps to the installer 0:129B: checks the command line (`OFF`/`ALL`), refuses to
  install twice (0:11ED looks for `SB DRV` just before the current int 66h handler), detects the chip with the timer
  test at 0:1214, copies `SB DRV\0` over 0:0100, sets `int 66h` → 0:0108 (`jmp 0:0140`), hooks
  `int 8` with 0:0225 (0:1185) and stays resident (`int 21h AH=31h`). 0:11B9 sets the
  "installed" flag 0:0128 and resets the chip (0:115A: reg 01←20h (waveform select enable),
  08←40h (note select), BD←00h, then every channel record is initialised and silenced).
* **Timer.** 0:1185 programs PIT channel 0 to divisor 0x1000: the interrupt runs at
  1193182 / 4096 = **291.304 Hz** (`PIT_HZ` in `sequencer.ts`). The handler 0:0225 per tick:
  * `[011A] += [0118]` (16-bit, the tempo increment); on carry one **music tick** is queued (`[011C]++`).
  * `[0120] += 36h` (8-bit); on carry one **fixed tick** is queued (`[011E]++`): 291.304 × 54/256 = **61.45 Hz**.
  * `[0122]/[0123] += 35h`; on carry the user countdowns `[0124]`/`[0126]` (int 66h F0h/F1h) are decremented (60.3 Hz).
  * `[0121]` counts down from 16 (initially 1): every 16th tick goes to the old BIOS handler (18.2 Hz)
    instead of being processed; otherwise EOI, and unless the driver is busy (`[072E]`), 0:09DA
    switches to its own stack and alternates `music tick (0:0DD8)` / `fixed tick (0:10A0)` until
    both queues are empty.
* **Tempo.** 0:0903 `setTempo(t)`: `[0722] = t`, `[0118] = t × 0x464E / 100`. Music ticks per
  second = 291.304 × [0118] / 65536 ≈ 0.803 × t, i.e. **≈48 ticks per beat** at t BPM
  (in the data a quarter note is 48, an eighth 24). Every song starts at t = 120 (0:030E).
  With no song the increment is 0 (0:0E07).

## 2. int 66h API (dispatcher 0:02BA, tables 0:029A / 0:02AE / 0:02B6)

| AH | Routine | Function |
| --- | --- | --- |
| 00h | 0:0385 | Register music bank DS:DX; stops the music, re-inits channels 0-6. Returns AX=0. |
| 01h | 0:03B0 | Stop, then play song AL (1-based) of the bank (0:030E). |
| 02h | 0:03C6 | AL=0: stop now (0:093E). AL≠0: fade out with speed AL. Clears the queued song. Returns AL=song playing, AH=repeat flag. |
| 03h | 0:03D9 | Returns AL=song playing (0 = none), AH=repeat flag, BX=music ticks since start/loop (`[071E]`). |
| 04h | 0:03EC | Repeat flag `[0728]` = AL (0 = play once). |
| 05h | 0:03F1 | Load instrument DS:DX (or none) into SFX channel AL (0/1 → OPL 7/8). |
| 06h | 0:0433 | Key a note DL (≤5Fh) on SFX channel AL. |
| 07h | 0:044E | Key off SFX channel AL. |
| 08h | 0:0458 | Queue song AL with repeat flag DL, started when the current song ends (0:0960). |
| 09h | 0:0462 | Exchange the song-end callback (far pointer DS:DX). |
| 10h | 0:04CD | Register SFX bank DS:DX (stops SFX, re-inits channels 7-8). |
| 11h | 0:04FE | Stop SFX, then play SFX AL (1-based) (0:0491). |
| 12h | 0:0512 | Stop SFX. |
| 13h | 0:052D | Returns AL=SFX playing, BX=SFX ticks. |
| 80h | 0:053A | Channel AL attenuation `[+2C]` = DL (added to the volume; bit 7 = never key on). |
| 81h | 0:054D | Channel AL (<9) transpose `[+2D]` = DL (signed semitones). |
| F0h/F1h | 0:015D | AL=0: get BX = countdown 0/1; AL≠0: set it (game wait timers, 60.3 Hz). |
| FEh / FFh | 0:014A / 0:0140 | Driver info / uninstall. 70h-7Fh are forwarded to a PCM driver (`int 66h` chain at 0:0110). |

Other AH values (e.g. 14h, which MAIN calls at 0CF5:5FD2/61C4 for another sound device) do nothing.

`MAIN.EXE` uses: AH=00h (0:B52A via 0CF5:5E5C, once at start-up, on the song buffer), 10h
(0CF5:5E90, SFX bank `3021:0004`), 01h+04h (0CF5:5F8E, AL=1 both), 02h + polling 03h
(0CF5:5F56, fade then wait), 03h (0CF5:5F00), 11h (0CF5:619A, AL = n+1), 12h (0CF5:617A),
13h (0CF5:614C) and the F0h/F1h timers (0:B33B-B35F). `OPEN.EXE` and `END.EXE` link the same
library (OPEN 0:85FE-8A3A, END 0:9584-98C0; their `int 66h` stubs are at 0:01BD-0242).

## 3. Music files and banks

`MUSIC.R3` (20 entries), `OPMUSIC.R3` (2), `EDMUSIC.R3` (3) are not LS11:

```
u16 count
count × { u32 offset; u16 size }       offsets relative to the end of this table
entries                                each one SBOPL2 music bank
```

(MAIN 0CF5:5DD0 reads entry i from file offset `2 + 6·count + offset`.) The game loads one entry
at a time into the buffer it registered with AH=00h and plays song 1 of it, so every bank holds
exactly one song:

```
+00  7 × u16   track offsets of OPL channels 0..6, relative to the song header (0 = unused)
+0E  ...       track data and instruments
```

The driver addresses song n at `bank + 16·(n-1)` and reads **eight** words (0:030E): the 8th
goes to channel 7 (an SFX channel) without re-initialising it. In these banks that word is the
first two bytes after the 14-byte header, so it is harmless unless a song starts while an SFX
is playing (the SFX's channel 7 then continues from a bogus offset in the SFX segment). The port
reproduces this.

Songs use 4-7 channels; the SFX channels 7 and 8 are never used by music, so music and effects
never steal each other's voices.

### Track commands (0:0CF1; jump table 0:0CA3)

A channel reads commands until a note or rest; each note sets the countdowns.

| Byte | Params | Meaning |
| --- | --- | --- |
| 00-5F | len, gate | Note n (octave n/12, C=0); `len` ticks to the next event, key held `gate` ticks. gate=0 → rest. gate > len → tie into the next note (0:0DCF). |
| 60-BF | | Note n-60h reusing the last len/gate. |
| C0-CF | | No operation. |
| D0 | | Repeat start (0:0A3E). |
| D1-DF | | Repeat: jump back to D0 (n & 15) more times (one level, no nesting). |
| E0-ED | 1 | Ignored (one parameter). |
| EE | b | BD bit 7 (tremolo depth 4.8 dB) = b & 1 (0:0C1C). |
| EF | b | BD bit 6 (vibrato depth 14 cents) = b & 1 (0:0C34). |
| F0 | v | Volume v & 7Fh (0:0A6F). |
| F1 | t | Tempo from a timer-B style value: `78125 / ((256 - t) · 18)` (low byte) (0:0AF7). |
| F2 | t | Tempo t (BPM-like). Ignored on SFX channels (0:0AE4). |
| F3 / F5 | 1 / 2 | Ignored. |
| F4 | rel16 | Instrument at (address of the F4 byte + rel16) (0:0B11). |
| F6 | s, p | Pitch bend by s semitones (signed, ≤12) over p·1250 / (16·tempo) fixed ticks (0:0B7E). |
| F7 | s, p | Pitch bend by s semitones over p+1 fixed ticks (0:0B73). |
| F8 / F9 | | Instrument LFO on / off (0:0BE9 / 0:0BFE). |
| FA-FC | | No operation. |
| FD | | Leave the repeat on its last pass (0:0C4E). |
| FE | | Loop point (0:0C61); defaults to the track start. |
| FF | | End of track (0:0C65): key off; if the repeat flag is set (music channels only) jump to the loop point, otherwise the channel stops. |

When all seven music tracks have stopped, 0:0960 calls the user callback (if any) and starts the
queued song (AH=08h) or ends playback.

**Notes** (0:0D31): `n + instrument transpose + channel transpose` → octave/semitone (clamped to
octave 7), F-number from the table at 0:076A (`157h 16Bh 181h 198h 1B0h 1CAh 1E5h 202h 220h 241h
263h 287h`, C..B, i.e. A = 0x241 = 437.7 Hz in octave 4), written to A0/B0 keeping the key bit. A
new note keys off the previous one first unless it is tied (legato: same note → nothing,
different note → frequency change only).

**Volume** (0:0A76): `att = (volume + channel attenuation [+ fade]) / 2`, added to the carrier TL
(and to the modulator TL when the instrument uses additive synthesis), clamped to 63.

### Instruments (22 bytes, loaded by 0:0B18 / 0:0846)

| Bytes | Meaning |
| --- | --- |
| 00-01 | regs 20h/23h (AM, VIB, EGT, KSR, MULT) modulator/carrier |
| 02 | reg C0h (feedback, connection) |
| 03-04 | regs E0h/E3h (waveform) |
| 05-06 | regs 40h/43h (KSL, TL) |
| 07-08 | regs 60h/63h (AR, DR) |
| 09-0A | regs 80h/83h (SL, RR) |
| 0B | transpose (signed semitones) |
| 0C-0D | LFO speed (u16; 0 = no LFO) |
| 0E | LFO waveform: 0 saw, 1 square, 2 triangle, 3 random, 4 one-shot ramp |
| 0F | vibrato amount (signed, /127) |
| 10 | vibrato depth index (& 15) into the table at 0:074A |
| 11 | tremolo depth (signed; negative inverts) |
| 12-13 | tremolo share of modulator/carrier (& 15, /15) |
| 14 | LFO delay: 0 = phase from the global counter, 1 = none, n = (n-1)·4+1 fixed ticks |
| 15 | non-zero: instrument has an LFO (enabled by F8) |

Selecting an instrument silences the channel first (0:0800).

## 4. Fixed tick (0:10A0, 61.45 Hz)

1. **Fade-out** (`[0724]` = speed s): every 4 fixed ticks the step k advances and the extra
   attenuation becomes `255·k²/s²` (0:0923 maps it to volume: a/2 below 128, a-64 above). After
   step s the music stops (0:093E) and the queued song, if any, starts. A fade lasts about
   (s+1) × 65 ms: s=8 ≈ 0.6 s (MAIN), 16 ≈ 1.1 s (OPEN/END), 0x50 ≈ 5.3 s (end of OPEN).
2. **SFX tracks** (0:0E13): channels 7 and 8 run their tracks here, i.e. at the fixed rate,
   independent of the music tempo.
3. For all 9 channels: a running **pitch bend** (0:0E98 ramp of `speed·dir` up to 0x7FFF,
   applied by 0:0F29 as `fnum · (1 ± v·depth/0x7FFF²)` with block carry), otherwise the
   instrument **LFO** (0:0FFC): waveform 0:0F02, vibrato 0:0F1C/0:0F29, tremolo 0:0F91 (lowers
   each operator's TL by up to `loudness·amount/127`). A key-off starts a 255-tick countdown
   after which the LFO path silences the channel.

## 5. Sound effects

`MAIN.EXE` registers the bank at image `3021:0004` (pushed at MAIN 0CF5:5EE0; file offset
`0x6A00 + 0x30214`). Entries are 4 bytes: track offsets for OPL channels 7 and 8 relative to
the entry. The data has 44 entries; MAIN's sound test lists 43 names (table DS:3364, MAIN
0CF5:F25C) and 0CF5:61FE ignores numbers above 42. SFX tracks use the same commands (they
start with volume 15, 0:0491). MAIN plays effect n with AH=11h AL=n+1 (0CF5:619A), from 67 call
sites of 0CF5:6280(0x66F2, n) (only when the effects option, bit 0 of 0x7A80, is on); 0CF5:61FE
first stops a playing effect and waits for it. `OPEN.EXE` registers an SFX bank too (0:8672 →
0:8638, image `09DC:000C`) and `END.EXE` links the same code, but neither ever plays an effect
(their AH=11h wrappers OPEN 0:8B5C / END 0:9AE2 have no callers).

## 6. Which song plays when

Song titles come from MAIN's music test ("음악을 즐긴다", table DS:312E, read by 0CF5:F1A6,
which plays the selected index i as `MUSIC.R3` entry i). MAIN's song changer is 0CF5:600A
(object 0x66EE): if the music option (bit 1 of the option word 0x7A80) is off it only fades the
music out and records i; otherwise, if song i
is already playing nothing happens, otherwise the current song is faded out at speed 8 and
waited for (0CF5:6086 → 5F56), entry i is loaded and played with repeat on (0CF5:5F8E), and
the number is stored in the game state (0CF5:639A, restored after loading a save at 0CF5:B34E).

| # | Title | Uses found in code (everything else is chosen by event scripts) |
| --- | --- | --- |
| 0 | 이벤트 프롤로그 (event prologue) | |
| 1 | 마을안 (in town) | 2CB6:14E4 in one map/state combination (`77DA()==3 && 221A()==0Bh`), inferred |
| 2 | 무장사망 (officer death) | |
| 3 | 행군이동 (march) | |
| 4 | 전투패배 (battle lost) | 2CB6:8504 (battle ends with the player's side gone, inferred), 3CB4:01BA |
| 5 | 개인이동 (individual movement) | 1CF5:D4D8, 2CB6:14E4 default (map screens) |
| 6 | 동료가입 (comrade joins) | |
| 7 | 전투승리 (battle won) | |
| 8 | 이벤트 에필로그 (event epilogue) | |
| 9 | 조조군 (Cao Cao's army) | |
| 10 | 조비 (Cao Pi) | |
| 11 | 적습 (enemy attack) | |
| 12 | 출진 (sortie) | |
| 13 | 원소 (Yuan Shao) | |
| 14 | 손권 (Sun Quan) | |
| 15 | 성내 (inside the castle) | 2CB6:14E4 (when `21EA(0x7A6C)==2` and the location type is 7: castle interiors, inferred) |
| 16 | 여포군 (Lü Bu's army) | |
| 17 | 범용 (general) | |
| 18 | 결투 (duel) | 3CB4:125E starts a duel with 18 after saving the current song (3CB4:18D6); 3CB4:1824 restores it |
| 19 | 도적 (bandits) | |

Event scripts choose the music with **script opcode 38h** (handlers in 1CF5:47B6 and
1CF5:8794: the argument read by 1CF5:A03C is stored at object+1BFh and passed to 600A;
1CF5:8708 replays it after a scene change). Mapping each scenario event to its song therefore
needs the event-script decoder (`SNR*D.R3`). Other music control: 1CF5:A766 stops music and
SFX (quitting), 1CF5:AA58/AAEA fade out at speed 16 between chapters.

`OPEN.EXE` (song changer 0:8806, fade 16; all calls in 0:2D10): `OPMUSIC.R3` entry 0 with
repeat off for the intro animation (`8806(0)` then `88B8` → AH=04h AL=0), then entry 1 with
repeat on for the title, faded out at speed 0x50 at the end (`8880(0x50)`). `END.EXE` (song
changer 0:978C): `EDMUSIC.R3` entry 0 with repeat off (0:312A), entry 1 with repeat off
(0:61BE), then 0:7F70 waits until it has finished (0:987E loop), plays entry 2 with repeat on
and fades out at speed 8 at the end.

## 7. The web implementation

* `music.ts`: `musicEntries()` (container), `mainSfxBank()` (finds `3021:0004` through the
  `push` at MAIN 0CF5:5EE0), `songTitles()`/`sfxNames()` (read from the player's MAIN.EXE),
  `disassembleTrack()` (debugging).
* `sequencer.ts`: `Sbopl2`, a routine-by-routine port of the driver (every method names its
  original address) emitting OPL register writes; `irq()` is the 0:0225 timer handler and must
  be called `PIT_HZ` times per second. The original quirks are kept (8-bit wraparounds, the
  channel-7 word, the 16th-tick BIOS chain that delays processing).
* `opl.ts`: an OPL2 emulator written for this project (no third-party code): log-sine/exp
  tables from their formulas, envelope generator with the rate/increment patterns, KSL/KSR,
  feedback, both connections, 4 waveforms, AM/vibrato LFOs. Rhythm mode, timers and CSM are not
  emulated (SBOPL2 never uses them). Runs at 49716 Hz.
* `synth.ts`: driver + chip + linear resampler + 10 Hz DC blocker; output gain 2 (the level of
  DOSBox's OPL emulation).
* `player.ts`: `SoundPlayer` with `start()` (call from a user gesture), `playSong(i, file,
  repeat)`, `changeSong(i, file, fade)` (MAIN's 600A behaviour), `stop()`, `fadeOut(speed)`,
  `playSfx(n)` (MAIN numbering), `stopSfx()`, `volume`. Runs in an AudioWorklet
  (`worklet.ts`), with a ScriptProcessor fallback.

### Verification

* `tools/sbopl2_ref.py` runs the original `SBOPL2.COM` under `tools/dosemu.py` (installer state
  reproduced, OPL ports hooked, the timer handler invoked once per PIT tick) and records
  `(tick, register, value)`. `web/test/audio.test.ts` compares the port with it: all 25 songs
  for 40000 ticks (≈137 s, several loops), all 44 SFX for 1500 ticks, and a scripted sequence
  (SFX over music, SFX interrupted and stopped, fade-out, replay without repeat, stop) — the
  register streams and tick numbers are identical. The test skips without `HERO_GAME_DIR` or
  without Python/Unicorn.
* `web/test/audio-opl.test.ts`: the chip produces 437.7 Hz for F-number 241h block 4 and goes
  silent after key-off; every song renders audibly with a dominant frequency in the musical
  range (set `AUDIO_WAV_DIR` to write WAV files). Rendered against DOSBox's DBOPL (PyOPL, used
  only as an outside reference) with the same register stream, songs 0/3/5/9 gave envelope
  correlations 0.97-0.998 and mean spectral similarity 0.975-1.0; DBOPL's output is exactly 2×
  this emulator's, hence the default gain.
