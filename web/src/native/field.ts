// Map views of the field engine: town / palace rooms (SMAP.R3 / PMAP.R3, mode 0 / 2) and the world map
// (MMAP.R3, mode 1), with their objects and characters, drawn into the map view (16, 56, 512 x 320).
//
//  * rooms: 1cb6:0F9A. 32x20 BG cells (SMAPBGPL entry 0 town / 1 palace), a 31x20 attribute grid at
//    +640 (0x7F walkable, 0xFF blocked, < 0x7C door to building n, 0x7C / 0x7D gate / exit) and object
//    records at +0x4EC: u8 n, n x {sprite, x, y}. Objects are SSCCHR1 sprites (bank 0 in towns,
//    DS:0x37FA[DS:0x3838[map]] in palaces) with their bottom-left corner at the cell's bottom-left
//    (verified pixel-exact on PMAP 0).
//  * characters: 1cb6:2A80 / 0cf5:C2B0. In rooms an officer uses SSCCHR2 entry = static byte 16 (+5),
//    a generic NPC its type's byte 8; four 32x40 frames (front, front, back, back). Facing (compass,
//    the iso art turned 45 degrees): 0 = back mirrored, 1 = front mirrored, 2 = front, 3 = back. The
//    frame sits in a 32x48 buffer at y 8 or 0 (0cf5:4EC4), i.e. 16 or 24 pixels above the cell; both
//    occur on the same screen, picked per character (verified on the opening palace scene).
//  * world map: 0cf5:D4D8. MMAP tiles of 16 pixels, positions in 32-pixel units (town positions
//    DS:0x136C use the same grid). Characters use SSCCHR1 entry dyn byte 1 + 2 for officers (3 for
//    others), sprites [W W N N E E S S] (verified: 화웅 facing south = sprite 7 at (32x, 32y)).

import type { GameAssets } from './assets';
import type { Draw, Rect } from './draw';
import type { IndexedImage } from '../formats/sprites';
import { parseSsc1, renderSsc1Sprite, readWorldMaps, type Ssc1Bank } from '../formats/sprites';
import type { GameState } from '../engine/state';
import { UNIT } from '../engine/state';

export const VIEW: Rect = { x: 16, y: 56, w: 512, h: 320 };
export const ROOM_W = 31;
export const ROOM_H = 20;
export const ATTR = { WALK: 0x7f, BLOCK: 0xff, GATE: 0x7c, EXIT: 0x7d } as const;

/** Room facing -> [SSCCHR2 frame, mirrored]. */
const ROOM_DIR: [number, boolean][] = [
  [2, true],
  [0, true],
  [0, false],
  [2, false],
];
/** World facing -> first of the two SSCCHR1 sprites. */
const WORLD_DIR = [2, 4, 6, 0];

export interface Actor {
  id: number;
  /** Grid position (room cells or world units). */
  x: number;
  y: number;
  /** Pixel position of the cell origin in map coordinates while walking. */
  px: number;
  py: number;
  dir: number;
  /** 0 or 1: buffer position (rooms) / animation frame (world). */
  phase: number;
  path: { x: number; y: number }[];
  /** Final facing after the walk. */
  endDir: number;
  step: number;
  hidden?: boolean;
}

interface Sprite {
  img: IndexedImage;
  x: number;
  y: number;
  mirror: boolean;
  /** Sort key. */
  depth: number;
  actor?: Actor;
}

/** Hash used for the per-character buffer position (stable across redraws). */
function phaseOf(id: number, x: number, y: number) {
  return ((id * 7 + x * 3 + y * 5) >> 1) & 1;
}

export class Field {
  kind: 'none' | 'room' | 'world' = 'none';
  /** 0 town, 1 world, 2 palace (location mode). */
  mode = 0;
  room: Uint8Array | null = null;
  roomEntry = -1;
  private bg: IndexedImage | null = null;
  private objects: Sprite[] = [];
  readonly actors = new Map<number, Actor>();
  /** World map. */
  private world: { w: number; h: number; tiles: Uint8Array; cells: Uint8Array[] } | null = null;
  scrollX = 0;
  scrollY = 0;
  private banks = new Map<number, Ssc1Bank>();
  private ssc1Img = new Map<string, IndexedImage>();
  /** Speed in pixels per frame. */
  walkSpeed = 2;

  constructor(
    readonly assets: GameAssets,
    readonly draw: Draw,
    readonly state: () => GameState,
  ) {}

  // ------------------------------------------------------------------ loading

  private bank(entry: number): Ssc1Bank | null {
    let b = this.banks.get(entry);
    if (!b) {
      const e = this.assets.entries('SSCCHR1.R3')[entry];
      if (!e) return null;
      b = parseSsc1(e);
      this.banks.set(entry, b);
    }
    return b;
  }

  private ssc1Sprite(entry: number, index: number): IndexedImage | null {
    const k = `${entry}:${index}`;
    let img = this.ssc1Img.get(k);
    if (!img) {
      const b = this.bank(entry);
      const sp = b?.sprites[index];
      if (!b || !sp) return null;
      img = renderSsc1Sprite(b, sp);
      this.ssc1Img.set(k, img);
    }
    return img;
  }

  /** 1cb6:0F9A: loads a town (mode 0, SMAP entry) or palace / event room (mode 2, PMAP entry). */
  loadRoom(mode: 0 | 2, entry: number) {
    const file = mode === 2 ? 'PMAP.R3' : 'SMAP.R3';
    const data = this.assets.entries(file)[entry];
    if (!data) throw new Error(`${file} has no entry ${entry}`);
    this.kind = 'room';
    this.mode = mode;
    this.room = data;
    this.roomEntry = entry;
    this.world = null;
    this.scrollX = this.scrollY = 0;
    const cells = this.assets.cells('SMAPBGPL.R3', mode === 2 ? 1 : 0);
    const px = new Uint8Array(VIEW.w * VIEW.h);
    for (let i = 0; i < 640; i++) {
      const c = cells[data[i]];
      if (!c) continue;
      const cx = (i % 32) * 16, cy = Math.floor(i / 32) * 16;
      for (let y = 0; y < 16; y++) px.set(c.subarray(y * 16, y * 16 + 16), (cy + y) * VIEW.w + cx);
    }
    this.bg = { width: VIEW.w, height: VIEW.h, pixels: px };
    // objects (1cb6:1138)
    const bankNo = mode === 2 ? this.assets.ds(0x37fa + this.assets.ds(0x3838 + entry, 1)[0], 1)[0] : 0;
    this.objects = [];
    const n = data[0x4ec] ?? 0;
    for (let k = 0; k < n; k++) {
      const o = 0x4ed + 3 * k;
      const img = this.ssc1Sprite(bankNo, data[o]);
      if (!img) continue;
      const ox = data[o + 1], oy = data[o + 2];
      this.objects.push({ img, x: ox * 16, y: (oy + 1) * 16 - img.height, mirror: false, depth: oy * 2 });
    }
    this.actors.clear();
  }

  /** 0cf5:E41C: the chapter's world map. */
  loadWorld(chapter: number) {
    const info = readWorldMaps(this.assets.main)[chapter] ?? readWorldMaps(this.assets.main)[0];
    const tiles = this.assets.entries('MMAP.R3')[info.entry];
    this.kind = 'world';
    this.mode = 1;
    this.room = null;
    this.roomEntry = -1;
    this.bg = null;
    this.objects = [];
    this.world = { w: info.width, h: info.height, tiles, cells: this.assets.cells('MMAPBGPL.R3', 0) };
    this.actors.clear();
  }

  attr(x: number, y: number): number {
    if (!this.room || x < 0 || y < 0 || x >= ROOM_W || y >= ROOM_H) return ATTR.BLOCK;
    return this.room[640 + y * ROOM_W + x];
  }

  /** Building type of a door (DS:0x3838[pmap]). */
  buildingType(door: number): number {
    return this.assets.ds(0x3838 + door, 1)[0];
  }

  // ------------------------------------------------------------------ characters

  private unitScale() {
    return this.kind === 'world' ? 32 : 16;
  }

  place(id: number, x: number, y: number, dir: number) {
    const s = this.unitScale();
    let a = this.actors.get(id);
    if (!a) {
      a = { id, x, y, px: x * s, py: y * s, dir, phase: phaseOf(id, x, y), path: [], endDir: dir, step: 0 };
      this.actors.set(id, a);
    }
    Object.assign(a, { x, y, px: x * s, py: y * s, dir, endDir: dir, path: [] });
  }

  remove(id: number) {
    this.actors.delete(id);
  }

  clearActors() {
    this.actors.clear();
  }

  /** Starts a walk to (x, y); the character faces `dir` on arrival. */
  move(id: number, x: number, y: number, dir: number) {
    const a = this.actors.get(id);
    if (!a) {
      this.place(id, x, y, dir);
      return;
    }
    a.path = [{ x, y }];
    a.endDir = dir;
  }

  /** Walk along cells (room) avoiding blocked attributes; falls back to a straight line. */
  walkPath(id: number, x: number, y: number, dir: number) {
    const a = this.actors.get(id);
    if (!a) return;
    const path = this.kind === 'room' ? this.findPath(a.x, a.y, x, y) : null;
    a.path = path && path.length ? path : [{ x, y }];
    a.endDir = dir;
  }

  /** Breadth-first path over walkable cells (8 neighbours). */
  findPath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] | null {
    if (sx === tx && sy === ty) return [];
    const W = ROOM_W, H = ROOM_H;
    const prev = new Int32Array(W * H).fill(-1);
    const start = sy * W + sx;
    prev[start] = start;
    const q = [start];
    const free = (x: number, y: number) => {
      if (x === tx && y === ty) return true;
      const v = this.attr(x, y);
      if (v === ATTR.BLOCK) return false;
      for (const o of this.actors.values()) if (o.x === x && o.y === y && !o.hidden) return false;
      return true;
    };
    while (q.length) {
      const c = q.shift()!;
      const cx = c % W, cy = (c / W) | 0;
      if (cx === tx && cy === ty) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (prev[n] !== -1 || !free(nx, ny)) continue;
        prev[n] = c;
        q.push(n);
      }
    }
    const end = ty * W + tx;
    if (prev[end] === -1) return null;
    const out: { x: number; y: number }[] = [];
    for (let c = end; c !== start; c = prev[c]) out.push({ x: c % W, y: (c / W) | 0 });
    return out.reverse();
  }

  get moving(): boolean {
    for (const a of this.actors.values()) if (a.path.length) return true;
    return false;
  }

  /** Advances walking characters by one frame; returns true when something moved. */
  stepActors(): boolean {
    const s = this.unitScale();
    const speed = this.kind === 'world' ? this.walkSpeed * 2 : this.walkSpeed;
    let changed = false;
    for (const a of this.actors.values()) {
      if (!a.path.length) continue;
      const t = a.path[0];
      const tx = t.x * s, ty = t.y * s;
      const dx = tx - a.px, dy = ty - a.py;
      const dist = Math.hypot(dx, dy);
      if (dy < 0 && dx >= 0) a.dir = 0;
      else if (dx > 0 && dy >= 0) a.dir = 1;
      else if (dy > 0 && dx <= 0) a.dir = 2;
      else if (dx < 0 && dy <= 0) a.dir = 3;
      if (dist <= speed) {
        a.px = tx;
        a.py = ty;
        a.x = t.x;
        a.y = t.y;
        a.path.shift();
        if (!a.path.length) a.dir = a.endDir;
      } else {
        a.px += (dx / dist) * speed;
        a.py += (dy / dist) * speed;
      }
      a.step += speed;
      if (a.step >= s / 2) {
        a.step = 0;
        a.phase ^= 1;
      }
      changed = true;
    }
    return changed;
  }

  /** World map: centre the view on a position (32-pixel units). */
  focusOn(x: number, y: number) {
    if (!this.world) return;
    const maxX = Math.max(0, this.world.w * 16 - VIEW.w);
    const maxY = Math.max(0, this.world.h * 16 - VIEW.h);
    this.scrollX = Math.max(0, Math.min(maxX, x * 32 - VIEW.w / 2)) & ~31;
    this.scrollY = Math.max(0, Math.min(maxY, y * 32 - VIEW.h / 2)) & ~31;
  }

  scrollBy(dx: number, dy: number) {
    if (!this.world) return;
    const maxX = Math.max(0, this.world.w * 16 - VIEW.w);
    const maxY = Math.max(0, this.world.h * 16 - VIEW.h);
    this.scrollX = Math.max(0, Math.min(maxX, this.scrollX + dx));
    this.scrollY = Math.max(0, Math.min(maxY, this.scrollY + dy));
  }

  // ------------------------------------------------------------------ sprites of characters

  private actorSprite(a: Actor): Sprite | null {
    const st = this.state();
    const isOfficer = UNIT.isOfficer(a.id) || (a.id & 0xe00) === 0;
    const idx = a.id & 0x1ff;
    if (this.kind === 'room') {
      let entry: number;
      if ((a.id & 0xe00) === 0x400) entry = st.npcTypes[idx]?.b8 ?? 0x11;
      else entry = st.officers[idx]?.b16 ?? 0;
      const frames = this.assets.ssc2(entry);
      if (!frames) return null;
      const [f, mirror] = ROOM_DIR[a.dir & 3];
      const walking = a.path.length > 0;
      const img = frames[f + (walking ? a.phase : 0)] ?? frames[f];
      const lift = walking ? 16 : a.phase ? 24 : 16;
      return { img, x: Math.round(a.px), y: Math.round(a.py) - lift, mirror, depth: a.y * 2 + 1, actor: a };
    }
    const entry = isOfficer ? (st.officers[idx]?.dyn.b1 ?? 0) + 2 : 3;
    const img = this.ssc1Sprite(entry, WORLD_DIR[a.dir & 3] + (a.path.length ? a.phase : 1));
    if (!img) return null;
    return { img, x: Math.round(a.px) - this.scrollX, y: Math.round(a.py) - this.scrollY, mirror: false, depth: a.y * 2 + 1, actor: a };
  }

  private sprites(): Sprite[] {
    const list: Sprite[] = [...this.objects];
    for (const a of this.actors.values()) {
      if (a.hidden) continue;
      const s = this.actorSprite(a);
      if (s) list.push(s);
    }
    // stable sort by depth (row), objects before characters on the same row
    return list.map((s, i) => [s, i] as const).sort((p, q) => p[0].depth - q[0].depth || p[1] - q[1]).map((p) => p[0]);
  }

  // ------------------------------------------------------------------ drawing

  /** Draws the whole map view. */
  render() {
    const px = this.draw.screen.pixels;
    const W = 640;
    if (this.kind === 'none') {
      this.draw.fill(VIEW.x, VIEW.y, VIEW.w, VIEW.h, 0);
      return;
    }
    if (this.kind === 'room' && this.bg) {
      for (let y = 0; y < VIEW.h; y++) px.set(this.bg.pixels.subarray(y * VIEW.w, y * VIEW.w + VIEW.w), (VIEW.y + y) * W + VIEW.x);
    } else if (this.world) {
      const { w, h, tiles, cells } = this.world;
      const tx0 = Math.floor(this.scrollX / 16), ty0 = Math.floor(this.scrollY / 16);
      const ox = this.scrollX % 16, oy = this.scrollY % 16;
      for (let ty = 0; ty <= VIEW.h / 16; ty++)
        for (let tx = 0; tx <= VIEW.w / 16; tx++) {
          const mx = tx0 + tx, my = ty0 + ty;
          const cell = mx < w && my < h ? cells[tiles[my * w + mx]] : undefined;
          const bx = tx * 16 - ox, by = ty * 16 - oy;
          for (let y = 0; y < 16; y++) {
            const sy = by + y;
            if (sy < 0 || sy >= VIEW.h) continue;
            for (let x = 0; x < 16; x++) {
              const sx = bx + x;
              if (sx < 0 || sx >= VIEW.w) continue;
              px[(VIEW.y + sy) * W + VIEW.x + sx] = cell ? cell[y * 16 + x] : 0;
            }
          }
        }
    }
    for (const s of this.sprites()) this.blit(s);
    this.draw.dirty();
  }

  private blit(s: Sprite) {
    const px = this.draw.screen.pixels;
    const { img } = s;
    for (let y = 0; y < img.height; y++) {
      const sy = s.y + y;
      if (sy < 0 || sy >= VIEW.h) continue;
      for (let x = 0; x < img.width; x++) {
        const sx = s.x + x;
        if (sx < 0 || sx >= VIEW.w) continue;
        const c = img.pixels[y * img.width + (s.mirror ? img.width - 1 - x : x)];
        if (!c || c > 15) continue;
        px[(VIEW.y + sy) * 640 + VIEW.x + sx] = c;
      }
    }
  }

  // ------------------------------------------------------------------ picking

  /** Character under screen point (topmost opaque pixel). */
  actorAt(sx: number, sy: number): Actor | null {
    const vx = sx - VIEW.x, vy = sy - VIEW.y;
    if (vx < 0 || vy < 0 || vx >= VIEW.w || vy >= VIEW.h) return null;
    const list = this.sprites().filter((s) => s.actor);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const x = vx - s.x, y = vy - s.y;
      if (x < 0 || y < 0 || x >= s.img.width || y >= s.img.height) continue;
      if (s.img.pixels[y * s.img.width + (s.mirror ? s.img.width - 1 - x : x)]) return s.actor!;
    }
    return null;
  }

  /** Grid cell under a screen point. */
  cellAt(sx: number, sy: number): { x: number; y: number } | null {
    const vx = sx - VIEW.x, vy = sy - VIEW.y;
    if (vx < 0 || vy < 0 || vx >= VIEW.w || vy >= VIEW.h) return null;
    if (this.kind === 'world') return { x: Math.floor((vx + this.scrollX) / 32), y: Math.floor((vy + this.scrollY) / 32) };
    return { x: Math.floor(vx / 16), y: Math.floor(vy / 16) };
  }
}
