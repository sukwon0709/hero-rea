import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_BLOB, AUTO_BATTLE_PATCHES, canPatchAutoBattle, patchAutoBattle } from '../src/autobattle';
import { gameFile, hasGame } from './gamedir';

/** Load-image offsets of every word DOS relocates (far-call segments etc.). */
function relocated(exe: Uint8Array): Set<number> {
  const w = (o: number) => exe[o] | (exe[o + 1] << 8);
  const out = new Set<number>();
  for (let i = 0; i < w(6); i++) {
    const at = w(0x18) + 4 * i;
    out.add(w(at + 2) * 16 + w(at));
  }
  return out;
}

describe('auto-battle patch', () => {
  it('leaves files it does not recognise alone', () => {
    expect(patchAutoBattle(new Uint8Array([1, 2, 3]))).toBeNull();
    const fake = new Uint8Array(0x40000);
    fake.set([0x4d, 0x5a, 0, 0, 0, 0, 0, 0, 0x20, 0]);
    expect(canPatchAutoBattle(fake)).toBe(false);
  });

  it('patches regions that do not overlap', () => {
    const spans = AUTO_BATTLE_PATCHES.map((p) => [p.at, p.at + p.put.length]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
  });

  it.skipIf(!hasGame)('patches MAIN.EXE without touching relocated words', () => {
    const exe = gameFile('MAIN.EXE');
    const before = exe.slice();
    const out = patchAutoBattle(exe)!;
    expect(out).not.toBeNull();
    expect(exe).toEqual(before); // the stored file is not modified
    const hdr = (exe[8] | (exe[9] << 8)) * 16;
    const rel = relocated(exe);
    let changed = 0;
    for (let i = 0; i < exe.length; i++) {
      if (exe[i] === out[i]) continue;
      changed++;
      const img = i - hdr;
      expect(rel.has(img) || rel.has(img - 1)).toBe(false);
    }
    expect(changed).toBeGreaterThan(0);
    // Patching again is a no-op (already patched files are accepted, e.g. a patched copy in the zip).
    expect(patchAutoBattle(out)).toEqual(out);
  });

  it.skipIf(!hasGame)('names the new battle-menu entry 자동전투', () => {
    const out = patchAutoBattle(gameFile('MAIN.EXE'))!;
    const hdr = (out[8] | (out[9] << 8)) * 16;
    const ds = hdr + 0x313a0;
    const ptr = out[ds + 0x3aa0 + 36] | (out[ds + 0x3aa0 + 37] << 8);
    const end = out.indexOf(0, ds + ptr);
    expect(new TextDecoder('euc-kr').decode(out.subarray(ds + ptr, end))).toBe('자동전투');
    expect(out[hdr + 0x1cb60 + 0x47b3]).toBe(10); // menu entries
  });
});

// The patch bytes and AI_BLOB are the assembled asm/hook.asm and asm/aiblob.asm. Checked when nasm is installed.
const nasm = (() => {
  try {
    execFileSync('nasm', ['-v']);
    return true;
  } catch {
    return false;
  }
})();

function assemble(name: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'hero-asm-'));
  const out = join(dir, 'out.bin');
  execFileSync('nasm', ['-f', 'bin', '-o', out, join(__dirname, '../src/classic/asm', name)]);
  return new Uint8Array(readFileSync(out));
}

describe('custom-AI bridge code', () => {
  const put = (what: string) => AUTO_BATTLE_PATCHES.find((p) => p.what.startsWith(what))!.put;

  it.skipIf(!nasm)('matches asm/hook.asm', () => {
    const bin = assemble('hook.asm');
    const stub = put('custom-AI stub');
    expect([...bin.subarray(0, stub.length)]).toEqual(stub);
    expect([...bin.subarray(stub.length)]).toEqual(put('custom-AI loader'));
  });

  it.skipIf(!nasm)('matches asm/aiblob.asm', () => {
    const bin = assemble('aiblob.asm');
    expect(AI_BLOB.length).toBeLessThan(bin.length);
    expect(bin.subarray(0, AI_BLOB.length)).toEqual(AI_BLOB);
    expect(bin.subarray(AI_BLOB.length).every((b) => b === 0)).toBe(true);
    expect(bin.length).toBeLessThanOrEqual(0x7c0); // room at image 0000:a9a0
  });
});
