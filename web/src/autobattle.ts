// Classic mode: AI auto-battle ("자동전투") for the original MAIN.EXE.
//
// The engine already has a zero-player mode (0인 플레이, docs/BATTLE.md "Turn structure"): debug
// command 2 at 1cb6:414b sets DS:0x3a3c bit 0 and gives every player unit in mode 7 (player-controlled)
// mode 1 (attack nearest). The player phase (1cb6:44de) is skipped when no unit on the field is in
// mode 7, so the computer pass 0 (1cb6:3f32) moves the player's units with the same AI as the enemy.
// While bit 0 is set, the computer phase checks for input before every unit (1cb6:3fa4); when it
// finds some, it clears the bit and puts every player unit back in mode 7 ("0인 플레이를 나갑니다"),
// so the player gets the next turn. Bit 0 is cleared at every battle start (1cb6:3acc), so
// the mode lasts for the current battle only.
//
// The Korean release hides the DEBUG entry of the battle menu (9 of the 10 entries are shown). The
// patches show a 10th entry named 자동전투 and make the debug command it opens (1cb6:4072) go straight
// to the zero-player case instead of showing the debug menu. The other debug cases (1cb6:40b5..4149)
// can no longer be reached, and their bytes hold the two small routines below.
//
// The original input check (0cf5:10d6) only reads whether the right mouse button is down at that
// instant, and the battle messages wait for the button to be released, so it is hard to hit. The
// patches add a check of the BIOS keyboard buffer first: any key pressed during the computer's moves
// is kept until the next unit and then ends the mode. The buffer is emptied when the mode starts, so
// keys pressed earlier in the game do not end it at once. The right-button check still works.
//
// The patch is applied to the copy of MAIN.EXE handed to the emulator; the stored file is untouched.
// Bytes that DOS relocates at load (far-call segments) are never overwritten.

interface Patch {
  what: string;
  /** Offset in the load image (file offset minus the MZ header). */
  at: number;
  expect: number[];
  put: number[];
}

const CODE = 0x1cb60; // segment 1cb6
const DGROUP = 0x313a0;

/** "자동전투" in EUC-KR, NUL-terminated (9 bytes; the debug string it replaces has 11). */
const LABEL = [0xc0, 0xda, 0xb5, 0xbf, 0xc0, 0xfc, 0xc5, 0xf5, 0x00];

export const AUTO_BATTLE_PATCHES: Patch[] = [
  {
    what: 'battle menu shows 10 entries instead of 9 (1cb6:47b2 push 9)',
    at: CODE + 0x47b2,
    expect: [0x6a, 0x09],
    put: [0x6a, 0x0a],
  },
  {
    what: 'entry 9 label: DS:0x3a9a "DEBUG" -> DS:0x3acc (battle menu table DS:0x3aa0, far pointers)',
    at: DGROUP + 0x3aa0 + 9 * 4,
    expect: [0x9a, 0x3a],
    put: [0xcc, 0x3a],
  },
  {
    what: 'DS:0x3acc: first debug-menu string (no longer shown) -> 자동전투',
    at: DGROUP + 0x3acc,
    expect: [0xdc, 0xb0, 0xcc, 0xdf, 0x4f, 0x4e, 0x2f, 0x4f, 0x46],
    put: LABEL,
  },
  {
    // 1cb6:4087 `mov dx,0x40` (before the debug menu call 0cf5:2c92) becomes `jmp 40dd`.
    // The words already pushed for the menu stay on the stack; the function's `leave` drops them.
    what: 'debug command skips its menu (1cb6:4087)',
    at: CODE + 0x4087,
    expect: [0xba, 0x40],
    put: [0xeb, 0x54],
  },
  {
    // 40dd: mov ah,1 / int 16h / jz 40e9 / xor ah,ah / int 16h / jmp 40dd   (empty the key buffer)
    // 40e9: xor dx,dx / jmp 4114 / nop
    what: 'enable: empty the BIOS key buffer (1cb6:40dd, dead debug code)',
    at: CODE + 0x40dd,
    expect: [0x83, 0xc4, 0x06, 0x80, 0x0e, 0x3c, 0x3a, 0x08, 0xe9, 0x22, 0x01, 0x1e, 0x68, 0xd9, 0x3b, 0x6a, 0x01],
    put: [0xb4, 0x01, 0xcd, 0x16, 0x74, 0x06, 0x32, 0xe4, 0xcd, 0x16, 0xeb, 0xf4, 0x31, 0xd2, 0xeb, 0x27, 0x90],
  },
  // Enable: remember which player units are player-controlled (mode 7) in a 15-bit mask at
  // DS:0x3ad5 (the unused tail of the replaced debug string), so the exit gives back exactly those
  // and leaves allied officers (도겸, 공손찬, ...) under the computer as in normal play.
  {
    // 4114: mov bx,0xe371 (slot 14 mode) / l: mov al,[bx] / sub al,7 / cmp al,1 / rcl dx,1 / jmp 4134
    what: 'enable: mask of mode-7 player units, part 1 (1cb6:4114, dead debug code)',
    at: CODE + 0x4114,
    expect: [0x0a, 0xc0, 0x74, 0x03, 0xe9, 0xef, 0x00, 0x68, 0xdc, 0xd4, 0x9a, 0x2a, 0x84],
    put: [0xbb, 0x71, 0xe3, 0x8a, 0x07, 0x2c, 0x07, 0x3c, 0x01, 0xd1, 0xd2, 0xeb, 0x13],
  },
  {
    // 4134: sub bx,14 / cmp bl,0x9f / jne l / jmp 4140   (stops after slot 0, DS:0xe2ad)
    what: 'enable: mask of mode-7 player units, part 2 (1cb6:4134, dead debug code)',
    at: CODE + 0x4134,
    expect: [0x8b, 0xf0, 0xeb, 0xc9, 0x68, 0xdc, 0xd4, 0x9a, 0xfe, 0x81],
    put: [0x83, 0xeb, 0x0e, 0x80, 0xfb, 0x9f, 0x75, 0xdb, 0xeb, 0x02],
  },
  {
    // 4140: mov [0x3ad5],dx / mov ax,2 / jmp 4095   (switch case 2 = 0인 플레이 at 414b)
    what: 'enable: store the mask, then debug case 2 (1cb6:4140, dead debug code)',
    at: CODE + 0x4140,
    expect: [0x89, 0x46, 0xfe, 0x40, 0x75, 0x03, 0xe9, 0xc1, 0x00, 0xeb],
    put: [0x89, 0x16, 0xd5, 0x3a, 0xb8, 0x02, 0x00, 0xe9, 0x4b, 0xff],
  },
  {
    // 3fab `push 0x64e2` (argument of the right-button check 0cf5:10d6) becomes `call 40c7`.
    what: 'computer phase: check the keyboard before the right button (1cb6:3fab)',
    at: CODE + 0x3fab,
    expect: [0x68, 0xe2, 0x64],
    put: [0xe8, 0x19, 0x01],
  },
  {
    // 40c7: mov ah,1 / int 16h / jz 40b5 / xor ah,ah / int 16h / pop ax / jmp 40fb
    what: 'key pressed: consume it and leave the mode (1cb6:40c7, dead debug code)',
    at: CODE + 0x40c7,
    expect: [0x83, 0xc4, 0x06, 0x80, 0x26, 0x3c, 0x3a, 0xf7, 0xe9, 0x38, 0x01, 0x1e, 0x68],
    put: [0xb4, 0x01, 0xcd, 0x16, 0x74, 0xe8, 0x32, 0xe4, 0xcd, 0x16, 0x58, 0xeb, 0x27],
  },
  {
    // 40b5: pop ax / push 0x64e2 / push ax / ret — push the argument the call replaced and return
    // to 3fae, the original right-button check.
    what: 'no key: fall back to the right-button check (1cb6:40b5, dead debug code)',
    at: CODE + 0x40b5,
    expect: [0xf6, 0x06, 0x3c, 0x3a, 0x08, 0x74],
    put: [0x58, 0x68, 0xe2, 0x64, 0x50, 0xc3],
  },
  // The original exit (1cb6:403b) returns from the computer phase, so every unit that has not
  // acted yet this turn, the enemy's included, loses its move, and it gives every player-side unit
  // mode 7, allies included. The exit below gives mode 7 back only to the units in the mask, clears
  // bit 0, shows the same message and then carries on with the phase, so the enemy still moves and
  // the player gets the next turn.
  {
    // 3fb7 `jmp 403b` (right button pressed) becomes `jmp 40fb`.
    what: 'right button: use the exit below (1cb6:3fb7)',
    at: CODE + 0x3fb7,
    expect: [0xe9, 0x81, 0x00],
    put: [0xe9, 0x41, 0x01],
  },
  {
    // 40fb: mov dx,[0x3ad5] / mov bx,0xe2ad / l: shr dx,1 / jnc m / mov byte [bx],7 /
    //       m: add bx,14 / or dx,dx / jnz l / jmp 4123
    // (unit records DS:0xe2a2, 14 bytes each, mode at +0xb; slots 0..14 are the player's)
    what: 'exit: the remembered units back to mode 7 (1cb6:40fb, dead debug code)',
    at: CODE + 0x40fb,
    expect: [
      0xbe, 0x05, 0x00, 0x8b, 0x7e, 0x06, 0x83, 0xfe, 0x05, 0x74, 0x08, 0x83, 0xfe, 0x06, 0x74, 0x03, 0xe9, 0xfc,
      0x00, 0x57, 0x9a, 0x68, 0x4f,
    ],
    put: [
      0x8b, 0x16, 0xd5, 0x3a, 0xbb, 0xad, 0xe2, 0xd1, 0xea, 0x73, 0x03, 0xc6, 0x07, 0x07, 0x83, 0xc3, 0x0e, 0x0b,
      0xd2, 0x75, 0xf2, 0xeb, 0x11,
    ],
  },
  {
    // 4123: and byte [0x3a3c],0xfe / push ds / push 0x3bb2 / push 0 / jmp 40ee
    // 40ee is the (now unused) debug code's `lcall 0cf5:3c5e` (message box), then `add sp,6`.
    what: 'exit: clear the mode bit and show "0인 플레이를 나갑니다" (1cb6:4123, dead debug code)',
    at: CODE + 0x4123,
    expect: [0x89, 0x46, 0xfe, 0x40, 0x74, 0x0f, 0xff, 0x76, 0xfe, 0x68, 0xdc, 0xd4, 0x9a],
    put: [0x80, 0x26, 0x3c, 0x3a, 0xfe, 0x1e, 0x68, 0xb2, 0x3b, 0x6a, 0x00, 0xeb, 0xbe],
  },
  {
    // 40f6 (after the message call and `add sp,6`): jmp 3fba, the next unit of the phase.
    what: 'exit: continue the computer phase (1cb6:40f6)',
    at: CODE + 0x40f6,
    expect: [0xc7, 0x46, 0xfc],
    put: [0xe9, 0xc1, 0xfe],
  },
  // Custom AI (지휘형, commander.ts): before every computer pass the game far-calls a small routine
  // loaded from the file AI (asm/aiblob.asm). While 자동전투 is on and the page has the custom AI
  // on, it writes the battle to AISTATE.BIN and waits for the page's orders in AIORDER.BIN.
  // The resident part is asm/hook.asm.
  {
    // 3f7f `cmp byte [bp-3],1` (start of each pass) becomes `call 418f / nop`; the stub redoes the compare.
    what: 'computer pass: call the custom-AI stub (1cb6:3f7f)',
    at: CODE + 0x3f7f,
    expect: [0x80, 0x7e, 0xfd, 0x01],
    put: [0xe8, 0x0d, 0x02, 0x90],
  },
  {
    what: 'custom-AI stub: load the file AI once, then far-call it (1cb6:418f, dead debug code)',
    at: CODE + 0x418f,
    expect: [
      0x83, 0xc6, 0x0e, 0x81, 0xfe, 0x74, 0xe3, 0x72, 0xef, 0x1e, 0x68, 0x13, 0x3c, 0xeb, 0xd9, 0xf6, 0x06, 0x3c,
      0x3a, 0x04, 0x74, 0x15, 0x1e, 0x68, 0x41, 0x3c, 0x6a, 0x00, 0x9a, 0x5e,
    ],
    put: [
      0xa1, 0xd9, 0x3a, 0x09, 0xc0, 0x75, 0x04, 0x0e, 0xe8, 0x0e, 0x00, 0x83, 0xf8, 0x01, 0x74, 0x04, 0xff, 0x1e,
      0xd7, 0x3a, 0x80, 0x7e, 0xfd, 0x01, 0xc3, 0x1e, 0x68, 0xde, 0x3a, 0xcb,
    ],
  },
  {
    what: 'custom-AI loader and its far pointer (DS:0x3ad7, the unused debug-menu strings)',
    at: DGROUP + 0x3ad7,
    expect: [
      0x82, 0x67, 0x82, 0x64, 0x82, 0x77, 0x8f, 0x9f, 0x97, 0x98, 0x00, 0x82, 0x4f, 0x90, 0x6c, 0xcc, 0xdf, 0xda,
      0xb2, 0x00, 0x50, 0x4c, 0x41, 0x59, 0x45, 0x52, 0x8c, 0x52, 0x91, 0x53, 0x93, 0xfc, 0x97, 0xcd, 0x00, 0x91,
      0xce, 0x90, 0xed, 0x4f, 0x4e, 0x2f, 0x4f, 0x46, 0x46, 0x00, 0xda, 0xcd, 0xde, 0xd9, 0xb1, 0xaf, 0xcc,
    ],
    put: [
      0x00, 0x00, 0x00, 0x00, 0x41, 0x49, 0x00, 0xb8, 0x00, 0x3d, 0xba, 0xdb, 0x3a, 0xcd, 0x21, 0x72, 0x1d, 0x93,
      0x1e, 0x8c, 0xd8, 0x2d, 0xa0, 0x26, 0x8e, 0xd8, 0xb4, 0x3f, 0xb9, 0xc0, 0x07, 0x31, 0xd2, 0xcd, 0x21, 0xb4,
      0x3e, 0xcd, 0x21, 0x8c, 0xd8, 0x1f, 0xa3, 0xd9, 0x3a, 0xcb, 0xb8, 0x01, 0x00, 0xa3, 0xd9, 0x3a, 0xcb,
    ],
  },
];

function headerSize(exe: Uint8Array): number {
  return (exe[8] | (exe[9] << 8)) * 16;
}

/** Whether `exe` is the MAIN.EXE these patches were made for (or already carries them). */
export function canPatchAutoBattle(exe: Uint8Array): boolean {
  if (exe.length < 2 || exe[0] !== 0x4d || exe[1] !== 0x5a) return false;
  const hdr = headerSize(exe);
  return AUTO_BATTLE_PATCHES.every((p) => {
    const at = hdr + p.at;
    if (at + p.put.length > exe.length) return false;
    const has = (bytes: number[]) => bytes.every((b, i) => exe[at + i] === b);
    return has(p.expect) || has(p.put);
  });
}

/**
 * Returns a copy of MAIN.EXE with the 자동전투 battle-menu entry, or null when the file is not the
 * release the patches were made for (then the game should run unpatched).
 */
export function patchAutoBattle(exe: Uint8Array): Uint8Array | null {
  if (!canPatchAutoBattle(exe)) return null;
  const out = exe.slice();
  const hdr = headerSize(exe);
  for (const p of AUTO_BATTLE_PATCHES) out.set(p.put, hdr + p.at);
  return out;
}

/**
 * The file AI: asm/aiblob.asm assembled (`nasm -f bin`), up to the end of its file names. The
 * loader reads it to image 0000:a9a0 (asm/hook.asm); the buffer after the names is not stored.
 */
export const AI_BLOB = Uint8Array.from(
  (
    '807efd000f859600f6063c3a010f848d005657061e0e07e885002e803ee400ff74782efe06c90079062ec606c900010e1f' +
    'b43c31c9bacc00cd21725e93b440b90100bac900cd211f1eb440b9f0ff31d2cd21b43ecd21beb600fbf4e8410072232ea0' +
    'e4002e3a06c900751881f9d300751207060e1fbee500bfa2e2b9d200fcf3a4eb171e31c08ed8a16c041f2e3b06ca0074c6' +
    '2ea3ca004e75bf1f075f5ecb1e0e1fc606e400ffb8003dbad800cd21721693b43fb9d400bae400cd2189c1730231c9b43e' +
    'cd21f81fc3000000414953544154452e42494e0041494f524445522e42494e00'
  )
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
);
