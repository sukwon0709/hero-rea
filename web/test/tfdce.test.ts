// Compares the TF-DCE port with the original TFDED.COM (ground truth from tools/tfdce_dump.py).
// Needs HERO_GAME_DIR, plus HERO_TFDCE_REF = path of the tfdce_ref.json written by
//   python3 -I tools/tfdce_dump.py $HERO_GAME_DIR <scratch dir>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unpackLs11 } from '../src/formats/ls11';
import { decodeTfdce, drawTfdce, splitOffsetTable, Vram, looksLikeTfdce } from '../src/formats/tfdce';
import { gameFile, hasGame } from './gamedir';

const REF = process.env.HERO_TFDCE_REF ?? '';
const hasRef = hasGame && REF !== '' && existsSync(REF);

const sha = (...parts: Uint8Array[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

function blob(key: string): Uint8Array {
  const [file, idx] = key.split('#');
  const d = gameFile(file);
  const parts = file === 'FACEDAT.R3' || file === 'PACKGRP.R3' ? splitOffsetTable(d) : unpackLs11(d);
  return parts[Number(idx)];
}

describe.skipIf(!hasGame)('tfdce', () => {
  it('splits FACEDAT.R3 and PACKGRP.R3', () => {
    const faces = splitOffsetTable(gameFile('FACEDAT.R3'));
    expect(faces.length).toBe(240);
    expect(faces.every(looksLikeTfdce)).toBe(true);
    const pack = splitOffsetTable(gameFile('PACKGRP.R3'));
    expect(pack.length).toBe(38);
    const img = decodeTfdce(faces[0]);
    expect([img.width, img.height]).toEqual([64, 80]);
  });

  it.skipIf(!hasRef)('matches TFDED.COM pixel-exactly on every TF-DCE image', () => {
    const ref = JSON.parse(readFileSync(REF, 'utf8')) as Record<
      string,
      { w: number; h: number; flags0: { rect: string; vram: string }; flags1: { rect: string; vram: string } }
    >;
    const keys = Object.keys(ref);
    expect(keys.length).toBe(240 + 38);
    const bad: string[] = [];
    for (const key of keys) {
      const b = blob(key);
      for (const flags of [0, 1] as const) {
        const vram = new Vram();
        const r = drawTfdce(vram, b, 0, 0, flags);
        const px = vram.read(0, 0, r.header.width, r.header.height);
        const want = ref[key][`flags${flags}`];
        if (sha(px) !== want.rect || sha(...vram.planes) !== want.vram) bad.push(`${key} flags=${flags}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
