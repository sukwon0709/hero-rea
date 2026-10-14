// Koei LS11 archive decoder (see docs/FORMATS.md, "LS11 archives").

export function isLs11(data: Uint8Array): boolean {
  return (data[0] | 0x20) === 0x6c && (data[1] | 0x20) === 0x73 && data[2] === 0x31 && data[3] === 0x31;
}

interface Entry {
  csize: number;
  usize: number;
  offset: number;
}

function readEntries(data: Uint8Array): Entry[] {
  const be = data[0] === 0x4c && data[1] === 0x53; // "LS11" big-endian table, "Ls11" little-endian
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Entry[] = [];
  for (let p = 0x110; ; p += 12) {
    const csize = dv.getUint32(p, !be);
    if (csize === 0) break;
    out.push({ csize, usize: dv.getUint32(p + 4, !be), offset: dv.getUint32(p + 8, !be) });
  }
  return out;
}

export function decompress(dict: Uint8Array, src: Uint8Array, usize: number): Uint8Array {
  const out = new Uint8Array(usize);
  let pos = 0;
  let bit = 0;
  const getBit = () => {
    const b = (src[pos] >> (7 - bit)) & 1;
    if (++bit === 8) {
      bit = 0;
      pos++;
    }
    return b;
  };
  const code = () => {
    let n = 0;
    let a = 0;
    for (;;) {
      const b = getBit();
      a = (a << 1) | b;
      n++;
      if (!b) break;
    }
    let c = 0;
    for (let i = 0; i < n; i++) c = (c << 1) | getBit();
    return a + c;
  };
  let o = 0;
  while (o < usize) {
    const c = code();
    if (c < 256) {
      out[o++] = dict[c];
    } else {
      const dist = c - 256;
      const len = code() + 3;
      for (let i = 0; i < len && o < usize; i++, o++) out[o] = out[o - dist];
    }
  }
  return out;
}

/** Unpacks every entry of an LS11 archive. */
export function unpackLs11(data: Uint8Array): Uint8Array[] {
  const dict = data.subarray(0x10, 0x110);
  return readEntries(data).map(({ csize, usize, offset }) => {
    const chunk = data.subarray(offset, offset + csize);
    return csize === usize ? chunk.slice() : decompress(dict, chunk, usize);
  });
}
