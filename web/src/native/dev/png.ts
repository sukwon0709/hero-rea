// Dev helper: encodes the 640x480 indexed Screen as a PNG (palette through the same 4->6->8 bit
// scaling as video.ts), for headless playthrough screenshots. Not used by the game itself.

import { zlibSync } from 'fflate';
import type { Screen } from '../../engine/screen';
import { dac6to8, scale4to6 } from '../../formats/palette';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const t = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}

/** PNG of the screen (8-bit indexed, 16-entry palette). */
export function screenPng(screen: Screen): Uint8Array {
  const w = 640, h = 480;
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(screen.pixels.subarray(y * w, y * w + w).map((v) => v & 15), y * (w + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const plte = new Uint8Array(48);
  screen.palette.forEach((c, i) => plte.set(c.map((v) => dac6to8(scale4to6(v))), i * 3));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
