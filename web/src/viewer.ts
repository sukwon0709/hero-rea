// Developer asset viewer: every graphics format decoded by src/formats/*, drawn with the palette the game
// uses for it (see docs/GRAPHICS.md). Game files come from the same picker / cache as play.html.
import { getGameFiles, type GameFiles } from './gamefiles';
import { unpackLs11 } from './formats/ls11';
import { decodeTfdce, splitOffsetTable } from './formats/tfdce';
import {
  PAL,
  BLACK,
  cssColor,
  dacToRgba,
  fadeSteps,
  paletteToRgba,
  readEndPalettes,
  readMainPalettes,
  type Rgb4,
} from './formats/palette';
import {
  MARK_REGIONS,
  cellSheet,
  composeCells,
  decodeCells,
  decodeInterleaved,
  decodeMarkImage,
  decodeSsc2,
  parseSsc1,
  readWorldMaps,
  renderSsc1Sprite,
  renderTileMap,
  squareFrame,
  type IndexedImage,
} from './formats/sprites';
import {
  ALL_FONT_RECORD,
  GameFont,
  HANGUL_ROWS,
  bitsToImage,
  parseFontR3,
  readGaijiCodes,
  renderText,
} from './formats/font';
import { decodeNpk, isNpk } from './formats/npk';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let files: GameFiles;
let mainPals: Rgb4[][] = [];
let endPals: Rgb4[][] = [];
const cache = new Map<string, Uint8Array[]>();

function file(name: string): Uint8Array | null {
  return files.get(name) ?? null;
}

/** LS11 entries of a game file (cached); [] when the file is missing. */
function ls11(name: string): Uint8Array[] {
  let v = cache.get(name);
  if (!v) {
    const f = file(name);
    v = f ? unpackLs11(f) : [];
    cache.set(name, v);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// palette / scale controls

const palSel = () => $<HTMLSelectElement>('#pal').value;
const scale = () => Number($<HTMLSelectElement>('#scale').value);
const mirror = () => $<HTMLInputElement>('#mirror').checked;

/** Resolves the palette select: 'auto' keeps the asset's own palette. */
function palette(auto: Rgb4[]): Rgb4[] {
  const v = palSel();
  if (v.startsWith('m')) return mainPals[Number(v.slice(1))] ?? auto;
  if (v.startsWith('e')) return endPals[Number(v.slice(1))] ?? auto;
  return auto;
}

const main = (n: number) => mainPals[n];

// ---------------------------------------------------------------------------------------------
// drawing helpers

function canvas(img: IndexedImage, pal: Rgb4[], s = scale()): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'px';
  c.width = Math.max(1, img.width);
  c.height = Math.max(1, img.height);
  c.style.width = `${c.width * s}px`;
  c.style.height = `${c.height * s}px`;
  const rgba = paletteToRgba(pal);
  const data = new ImageData(c.width, c.height);
  const out = new Uint32Array(data.data.buffer);
  for (let i = 0; i < img.pixels.length; i++) {
    const v = img.pixels[i];
    out[i] = v < 16 ? rgba[v] : 0; // > 15: transparent (empty cell)
  }
  c.getContext('2d')!.putImageData(data, 0, 0);
  return c;
}

function figure(img: IndexedImage, pal: Rgb4[], caption: string, s?: number): HTMLElement {
  const f = document.createElement('figure');
  f.append(canvas(img, pal, s));
  const cap = document.createElement('figcaption');
  cap.textContent = caption;
  f.append(cap);
  return f;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function section(root: HTMLElement, title: string, note?: string): HTMLElement {
  root.append(el('h2', title));
  if (note) root.append(el('p', note, 'note'));
  const g = el('div', undefined, 'grid');
  root.append(g);
  return g;
}

function missing(root: HTMLElement, names: string[]): boolean {
  const gone = names.filter((n) => !files.has(n));
  if (gone.length) root.append(el('p', `Missing: ${gone.join(', ')}`, 'note'));
  return gone.length > 0;
}

function swatches(label: string, colors: string[]): HTMLElement {
  const row = el('div', undefined, 'swatches');
  row.append(el('b', label));
  for (const c of colors) {
    const s = el('span', undefined, 'c');
    s.style.background = c;
    s.title = c;
    row.append(s);
  }
  return row;
}

// ---------------------------------------------------------------------------------------------
// groups

interface Group {
  id: string;
  title: string;
  render(root: HTMLElement): void;
}

const groups: Group[] = [
  {
    id: 'palettes',
    title: 'Palettes',
    render(root) {
      root.append(el('h2', 'MAIN.EXE palettes (DS:1050, 9 x 16 [B,R,G])'));
      root.append(
        el(
          'p',
          `Scene palette = location mode: ${PAL.town} town, ${PAL.worldMap} world map, ${PAL.palace} palace, ${PAL.battle} battle; ${PAL.digital} digital 8 colours; ${PAL.camp} (= 8) camp / dialogue screens.`,
          'note',
        ),
      );
      mainPals.forEach((p, i) => root.append(swatches(`MAIN ${i}`, p.map(cssColor))));
      if (endPals.length) {
        root.append(el('h2', 'END.EXE palettes (image offset 0xC058, 43 x 16 [B,R,G])'));
        endPals.forEach((p, i) => root.append(swatches(`END ${i}`, p.map(cssColor))));
      }
      root.append(el('h2', 'Fade (GRPDRV AH=16h, 16 steps)'));
      const ctl = el('div', undefined, 'vtools');
      const from = el('select');
      const to = el('select');
      const opts = [...mainPals.map((_, i) => `MAIN ${i}`), 'black'];
      for (const s of [from, to]) for (const [i, o] of opts.entries()) s.append(new Option(o, String(i)));
      from.value = String(opts.length - 1);
      to.value = '0';
      ctl.append('from ', from, ' to ', to);
      root.append(ctl);
      const out = el('div');
      root.append(out);
      const pick = (v: string) => mainPals[Number(v)] ?? BLACK;
      const draw = () => {
        out.replaceChildren();
        fadeSteps(pick(from.value), pick(to.value), 16).forEach((dac, k) => {
          const rgba = dacToRgba(dac);
          out.append(swatches(`step ${k + 1}`, [...rgba].map((v) => `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`)));
        });
      };
      from.onchange = to.onchange = draw;
      draw();
    },
  },
  {
    id: 'faces',
    title: 'Portraits',
    render(root) {
      if (missing(root, ['FACEDAT.R3'])) return;
      const g = section(root, 'FACEDAT.R3: 240 TF-DCE portraits, 64x80', 'Drawn in dialogue windows; the camp / dialogue palette 5 is the default.');
      splitOffsetTable(file('FACEDAT.R3')!).forEach((b, i) => g.append(figure(decodeTfdce(b), palette(main(PAL.camp)), `#${i}`)));
    },
  },
  {
    id: 'pictures',
    title: 'Event pictures',
    render(root) {
      if (missing(root, ['PACKGRP.R3'])) return;
      const g = section(root, 'PACKGRP.R3: 38 TF-DCE pictures', 'Palette chosen by the event script; default MAIN 0.');
      splitOffsetTable(file('PACKGRP.R3')!).forEach((b, i) => {
        const im = decodeTfdce(b);
        g.append(figure(im, palette(main(0)), `#${i} ${im.width}x${im.height}`));
      });
    },
  },
  {
    id: 'units',
    title: 'Battle units',
    render(root) {
      if (missing(root, ['HEXZCHR.R3'])) return;
      const g = section(root, 'HEXZCHR.R3: 47 units, 4 directions x 2 frames (16x16 cells)', 'Battle palette 3. Columns: direction 0..3, rows: frame 0, 1.');
      ls11('HEXZCHR.R3').forEach((e, i) => {
        const cells = decodeCells(e, mirror());
        g.append(figure(composeCells(cells, [0, 1, 2, 3, 4, 5, 6, 7], 4, 2), palette(main(PAL.battle)), `#${i}`));
      });
    },
  },
  {
    id: 'closeups',
    title: 'Close-up sprites',
    render(root) {
      if (missing(root, ['HEXICHR.R3', 'HEXBCHR.R3'])) return;
      const p = palette(main(PAL.battle));
      const a = section(root, 'HEXICHR.R3: 78 officers, 6x6 cells (96x96)');
      ls11('HEXICHR.R3').forEach((e, i) => a.append(figure(squareFrame(e, mirror()), p, `#${i}`)));
      const b = section(root, 'HEXBCHR.R3: 169 soldier poses (4x4 cells) + 12 effects (3x3 cells)');
      ls11('HEXBCHR.R3').forEach((e, i) => b.append(figure(squareFrame(e, mirror()), p, `#${i}`)));
    },
  },
  {
    id: 'tiles',
    title: 'Tile sets',
    render(root) {
      const sets: [string, number, number, string][] = [
        ['HEXZCHP.R3', 0, PAL.battle, 'battle map chips, set 0'],
        ['HEXZCHP.R3', 1, PAL.battle, 'second chip set (most maps)'],
        ['HEXZCHP.R3', 2, PAL.battle, 'second chip set (maps listed at DS:3DCC)'],
        ['HEXBCHP.R3', 0, PAL.battle, 'close-up backdrop chips'],
        ['HEXGRP.R3', 0, PAL.battle, 'battle UI cells (entries 1, 2 are EUC-KR text)'],
        ['MMAPBGPL.R3', 0, PAL.worldMap, 'world map tiles'],
        ['SMAPBGPL.R3', 0, PAL.town, 'town tiles'],
        ['SMAPBGPL.R3', 1, PAL.palace, 'palace / indoor tiles'],
      ];
      for (const [name, idx, pal, what] of sets) {
        const e = ls11(name)[idx];
        if (!e) continue;
        const cells = decodeCells(e);
        const g = section(root, `${name} #${idx}: ${cells.length} cells, ${what} (palette ${pal})`);
        g.append(canvas(cellSheet(cells, 16, 1, 0x10), palette(main(pal))));
      }
    },
  },
  {
    id: 'rooms',
    title: 'Towns & palaces',
    render(root) {
      if (missing(root, ['SMAP.R3', 'PMAP.R3', 'SMAPBGPL.R3'])) return;
      const tiles = ls11('SMAPBGPL.R3').map((e) => decodeCells(e));
      const a = section(root, 'SMAP.R3: town rooms, 32x20 BG map with SMAPBGPL #0 (palette 0)');
      ls11('SMAP.R3').forEach((e, i) => a.append(figure(renderTileMap(tiles[0], e, 32, 20), palette(main(PAL.town)), `#${i}`, 1)));
      const b = section(root, 'PMAP.R3: palace / indoor rooms, SMAPBGPL #1 (palette 2)');
      ls11('PMAP.R3').forEach((e, i) => b.append(figure(renderTileMap(tiles[1], e, 32, 20), palette(main(PAL.palace)), `#${i}`, 1)));
    },
  },
  {
    id: 'worldmap',
    title: 'World maps',
    render(root) {
      if (missing(root, ['MMAP.R3', 'MMAPBGPL.R3', 'MAIN.EXE'])) return;
      const tiles = decodeCells(ls11('MMAPBGPL.R3')[0]);
      const g = section(root, 'MMAP.R3 per chapter (sizes from DS:2F06), MMAPBGPL #0 tiles, palette 1');
      for (const m of readWorldMaps(file('MAIN.EXE')!)) {
        const e = ls11('MMAP.R3')[m.entry];
        if (!e) continue;
        g.append(figure(renderTileMap(tiles, e, m.width, m.height), palette(main(PAL.worldMap)), `chapter ${m.chapter + 1}: entry ${m.entry}, ${m.width}x${m.height}`, 1));
      }
    },
  },
  {
    id: 'town',
    title: 'Town sprites',
    render(root) {
      if (missing(root, ['SSCCHR1.R3', 'SSCCHR2.R3'])) return;
      const p = palette(main(PAL.palace));
      ls11('SSCCHR1.R3').forEach((e, i) => {
        const bank = parseSsc1(e);
        const g = section(root, `SSCCHR1.R3 #${i}: ${bank.sprites.length} objects, ${bank.cells.length} cells`);
        bank.sprites.forEach((s, k) => g.append(figure(renderSsc1Sprite(bank, s), p, `${k}`)));
      });
      const g = section(root, 'SSCCHR2.R3: 29 people x 4 frames (32x40: front, front, back, back)');
      ls11('SSCCHR2.R3').forEach((e, i) => decodeSsc2(e).forEach((im, k) => g.append(figure(im, p, `${i}.${k}`))));
    },
  },
  {
    id: 'mark',
    title: 'UI (MARK.R3)',
    render(root) {
      const mark = ls11('MARK.R3')[0];
      if (missing(root, ['MARK.R3']) || !mark) return;
      for (const r of MARK_REGIONS) {
        const g = section(root, `0x${r.offset.toString(16).toUpperCase()}: ${r.name} (${r.kind}, x${r.count}, ${r.ref})`);
        for (let i = 0; i < r.count; i++) g.append(figure(decodeMarkImage(mark, r, i), palette(main(0)), `${i}`));
      }
    },
  },
  {
    id: 'fonts',
    title: 'Fonts & text',
    render(root) {
      const all = file('ALL_FONT.16P');
      const han = file('HANKAKU.FNT');
      const font = new GameFont(all, han);
      const ui = palette(main(PAL.camp));
      // live text renderer
      root.append(el('h2', 'Text renderer (0cf5:0A2E / 0E24): EUC-KR, game control codes'));
      const ta = el('textarea', undefined, 'text');
      ta.rows = 3;
      ta.value = '유비 [설마 조조가 살아있으리라곤 꿈에도 생각지 않았다.]\n제1장 계교 전투  ABC 123';
      const fg = el('select');
      const ol = el('select');
      const bg = el('select');
      for (let i = 0; i < 16; i++) {
        fg.append(new Option(String(i), String(i)));
        ol.append(new Option(String(i), String(i)));
        bg.append(new Option(String(i), String(i)));
      }
      ol.prepend(new Option('none', ''));
      fg.value = '15';
      ol.value = '';
      bg.value = '0';
      const cols = el('input');
      cols.type = 'number';
      cols.value = '70';
      cols.min = '4';
      cols.max = '80';
      const bold = el('input');
      bold.type = 'checkbox';
      bold.id = 'bold';
      const boldLabel = el('label');
      boldLabel.append(bold, ' bold (END.EXE)');
      const tools = el('div', undefined, 'vtools');
      tools.append('fg ', fg, ' outline ', ol, ' background ', bg, ' columns ', cols, boldLabel);
      const out = el('div');
      root.append(ta, tools, out);
      const draw = () => {
        const bytes = encodeEucKr(ta.value);
        const img = renderText(font, bytes, {
          fg: Number(fg.value),
          outline: ol.value === '' ? null : Number(ol.value),
          background: Number(bg.value),
          columns: Math.min(80, Math.max(4, Number(cols.value) || 70)),
          bold: bold.checked,
        });
        out.replaceChildren(canvas(img, ui));
      };
      ta.oninput = fg.onchange = ol.onchange = bg.onchange = bold.onchange = cols.oninput = draw;
      draw();

      if (all) {
        const n = Math.floor(all.length / ALL_FONT_RECORD);
        const per = 64;
        const sheet: IndexedImage = { width: per * 17, height: Math.ceil(n / per) * 15, pixels: new Uint8Array(0) };
        sheet.pixels = new Uint8Array(sheet.width * sheet.height).fill(0x10);
        for (let i = 0; i < n; i++) {
          const g = bitsToImage(all.subarray(i * ALL_FONT_RECORD + 2, i * ALL_FONT_RECORD + 30), 2, HANGUL_ROWS, 15, 0);
          const x0 = (i % per) * 17;
          const y0 = Math.floor(i / per) * 15;
          for (let y = 0; y < g.height; y++) sheet.pixels.set(g.pixels.subarray(y * 16, y * 16 + 16), (y0 + y) * sheet.width + x0);
        }
        const g = section(root, `ALL_FONT.16P: ${n} glyphs, 16x14, KS X 1001 order (records of 30 bytes: code, 28 bytes)`);
        g.append(canvas(sheet, ui, 1));
      }
      if (han) {
        const g = section(root, 'HANKAKU.FNT: ASCII 0x20..0x7F, 8x16');
        const glyphs = Array.from({ length: han.length >> 4 }, (_, i) => bitsToImage(han.subarray(i * 16, i * 16 + 16), 1, 16, 15, 0));
        const sheet: IndexedImage = { width: 32 * 9, height: Math.ceil(glyphs.length / 32) * 17, pixels: new Uint8Array(32 * 9 * Math.ceil(glyphs.length / 32) * 17).fill(0x10) };
        glyphs.forEach((gl, i) => {
          for (let y = 0; y < 16; y++) sheet.pixels.set(gl.pixels.subarray(y * 8, y * 8 + 8), (Math.floor(i / 32) * 17 + y) * sheet.width + (i % 32) * 9);
        });
        g.append(canvas(sheet, ui));
      }
      const r3 = file('FONT.R3');
      if (r3) {
        const codes = file('MAIN.EXE') ? readGaijiCodes(file('MAIN.EXE')!) : undefined;
        const g = section(root, 'FONT.R3: 87 user-defined 16x16 glyphs, registered with GRPDRV AH=1Ch (codes at DS:2980)');
        parseFontR3(r3, codes).forEach((gl, i) => g.append(figure(bitsToImage(gl.bits, 2, 16, 15, 0), ui, `${i} ${gl.code.toString(16)}`)));
      }
    },
  },
  {
    id: 'oped',
    title: 'Opening & ending',
    render(root) {
      root.append(
        el(
          'p',
          'NPK016 pictures are decoded like OPEN.EXE / END.EXE 0x06E4; "auto" uses the palette in the NPK header, which is not always the one shown (END1GRP #19 is shown with END palette 1). Other entries are raw byte-interleaved 4-plane bitmaps (pairs of equal size look like AND mask + image) whose sizes are passed as constants to the blit at OPEN.EXE 0x0288 (e.g. OPGRP #60 is 16x24); set the width below. OPGRP.R3 in this copy is damaged from file offset ~0x60000 (entries 27+).',
          'note',
        ),
      );
      const tools = el('div', undefined, 'vtools');
      const rawW = el('input');
      rawW.type = 'number';
      rawW.min = '0';
      rawW.max = '640';
      rawW.step = '8';
      rawW.value = sessionRawWidth;
      tools.append('raw width (px, 0 = guess) ', rawW);
      root.append(tools);
      rawW.onchange = () => {
        sessionRawWidth = rawW.value;
        show('oped');
      };
      const forced = Math.floor((Number(rawW.value) || 0) / 8) * 8;
      for (const name of ['OPGRP.R3', 'END1GRP.R3', 'END2GRP.R3']) {
        const es = ls11(name);
        if (!es.length) continue;
        const g = section(root, `${name}: ${es.length} entries`);
        es.forEach((e, i) => {
          try {
            if (isNpk(e)) {
              const im = decodeNpk(e);
              g.append(figure(im, palette(im.header.palette), `#${i} NPK ${im.width}x${im.height}`, 1));
            } else {
              const w = forced || guessWidth(e.length);
              const h = Math.max(1, Math.floor(e.length / (w / 2)));
              g.append(figure(decodeInterleaved(e, 0, w, h), palette(main(0)), `#${i} raw ${e.length} B, shown ${w}x${h}`, 1));
            }
          } catch (err) {
            g.append(el('span', `#${i}: ${(err as Error).message}`, 'note'));
          }
        });
      }
    },
  },
];

let sessionRawWidth = '0';

/** A plausible width (multiple of 8, <= 640) for a raw 4-plane bitmap of `size` bytes. */
function guessWidth(size: number): number {
  for (const w of [640, 544, 512, 480, 448, 416, 400, 384, 352, 320, 288, 272, 256, 240, 224, 208, 192, 176, 160, 144, 128, 112, 96, 80, 64, 48, 32, 16, 8]) {
    const rowBytes = w / 2;
    if (size % rowBytes === 0 && size / rowBytes <= 400 && size / rowBytes >= 8) return w;
  }
  return 64;
}

// ---------------------------------------------------------------------------------------------
// EUC-KR encoding (browsers ship only the decoder): the KS X 1001 table is rebuilt once from it.

let eucTable: Map<string, number> | null = null;

function encodeEucKr(s: string): number[] {
  if (!eucTable) {
    eucTable = new Map();
    const pairs = new Uint8Array(94 * 94 * 2);
    let p = 0;
    for (let a = 0xa1; a <= 0xfe; a++) {
      for (let b = 0xa1; b <= 0xfe; b++) {
        pairs[p++] = a;
        pairs[p++] = b;
      }
    }
    const text = new TextDecoder('euc-kr').decode(pairs);
    [...text].forEach((ch, i) => {
      if (ch !== '�' && !eucTable!.has(ch)) eucTable!.set(ch, ((0xa1 + Math.floor(i / 94)) << 8) | (0xa1 + (i % 94)));
    });
  }
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c === 0x0a ? 0x0a : c);
    else {
      const code = eucTable.get(ch);
      if (code !== undefined) out.push(code >> 8, code & 0xff);
      else out.push(0x3f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

function show(id: string) {
  const g = groups.find((x) => x.id === id) ?? groups[0];
  for (const b of document.querySelectorAll<HTMLButtonElement>('#groups button')) b.setAttribute('aria-pressed', String(b.dataset.id === g.id));
  const root = $('#view');
  root.replaceChildren();
  g.render(root);
  if (location.hash.slice(1) !== g.id) history.replaceState(null, '', `#${g.id}`);
}

async function start() {
  files = await getGameFiles($('#picker'));
  const mainExe = file('MAIN.EXE')!;
  mainPals = readMainPalettes(mainExe);
  const end = file('END.EXE');
  endPals = end ? readEndPalettes(end) : [];
  const sel = $<HTMLSelectElement>('#pal');
  sel.append(new Option('auto (as the game)', 'auto'));
  mainPals.forEach((_, i) => sel.append(new Option(`MAIN ${i}`, `m${i}`)));
  endPals.forEach((_, i) => sel.append(new Option(`END ${i}`, `e${i}`)));
  const nav = $('#groups');
  for (const g of groups) {
    const b = el('button', g.title);
    b.type = 'button';
    b.dataset.id = g.id;
    b.onclick = () => show(g.id);
    nav.append(b);
  }
  nav.hidden = false;
  $('#tools').hidden = false;
  const rerender = () => show(location.hash.slice(1));
  sel.onchange = $<HTMLSelectElement>('#scale').onchange = $<HTMLInputElement>('#mirror').onchange = rerender;
  window.onhashchange = rerender;
  rerender();
}

start().catch((e) => {
  $('#view').textContent = `Error: ${(e as Error).message}`;
});
