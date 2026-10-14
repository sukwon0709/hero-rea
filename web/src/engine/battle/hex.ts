// Battle grid geometry: neighbours, ZOC, attack/tactic range shapes, movement flood fill and
// path building, reproduced literally from MAIN.EXE (see docs/BATTLE.md, "Grid").
//
// Despite the HEX* file names the grid is square with 4-way movement.

import {
  AXES,
  CLASS_MOVE_TYPE,
  DIAGONALS,
  DIRS,
  moveCost,
  NONE,
  Officer,
  PLAYER_SLOTS,
  Status,
  Unit,
  UnitFlag,
} from './types';

/** What the grid code needs to know about the battle. */
export interface Field {
  width: number;
  height: number;
  terrain: Uint8Array; // width*height (map segment +0x0f00)
  unitAt: Uint8Array; // width*height unit slot or 0xff (map segment +0x12c0)
  units: Unit[]; // 45 slots (DS:0xe2a2)
  officers: Officer[]; // indexed by Unit.officer (DS:0x7a94)
}

export type Pos = [number, number];

/** Side of a slot: true for the player side (1cb6:4f26). */
export function sideOf(slot: number): boolean {
  return slot < PLAYER_SLOTS;
}

export function inBounds(f: Field, x: number, y: number): boolean {
  // Byte arithmetic in the original: x-1 at 0 wraps to 0xff and fails `x < width`.
  return x >= 0 && y >= 0 && x < f.width && y < f.height;
}

export function terrainAt(f: Field, x: number, y: number): number {
  return f.terrain[y * f.width + x];
}

export function unitAt(f: Field, x: number, y: number): number {
  return f.unitAt[y * f.width + x];
}

/** Neighbour in direction 0..3 (N, E, S, W) or null when off the map (1cb6:bdfa). */
export function neighbour(f: Field, x: number, y: number, dir: number): Pos | null {
  const nx = x + DIRS[dir][0];
  const ny = y + DIRS[dir][1];
  return inBounds(f, nx, ny) ? [nx, ny] : null;
}

/** Fills the unit map from the units on the field. */
export function rebuildUnitMap(f: Field): void {
  f.unitAt.fill(NONE);
  for (const u of f.units) if (u.status === Status.Field) f.unitAt[u.y * f.width + u.x] = u.slot;
}

/** True if a 4-neighbour of (x,y) holds a unit of the other side (1cb6:bd0e). */
export function enemyAdjacent(f: Field, playerSide: boolean, x: number, y: number): boolean {
  for (let d = 0; d < 4; d++) {
    const n = neighbour(f, x, y, d);
    if (!n) continue;
    const s = unitAt(f, n[0], n[1]);
    if (s !== NONE && sideOf(s) !== playerSide) return true;
  }
  return false;
}

export function moveTypeOf(f: Field, u: Unit): number {
  return CLASS_MOVE_TYPE[f.officers[u.officer].cls];
}

// ---- range shapes (1cb6:c018 / bf34) ----

/**
 * Cells of range shape `rangeType` around (x,y), in the exact order 1cb6:c018 visits them
 * (off-map cells dropped). Bit 0x80 of rangeType means "one larger, and keep the orthogonal
 * neighbours". With `self` the centre comes first.
 *
 *  r=0: N E S W                 r=1: N E S W + diagonals
 *  r=2: diagonals + (±2,0),(0,±2)
 *  r=3: diagonals + the 5x5 ring minus its corners
 *  r=4: r=3 + (±3,0),(0,±3) + (±2,±2)
 */
export function rangeCells(f: Field, x: number, y: number, rangeType: number, self = false): Pos[] {
  const out: Pos[] = [];
  const add = (cx: number, cy: number) => {
    if (inBounds(f, cx, cy)) out.push([cx, cy]);
  };
  const keepOrth = (rangeType & 0x80) !== 0;
  const r = (rangeType & 0x7f) + (keepOrth ? 1 : 0);
  if (self) add(x, y);
  if (r <= 1 || keepOrth) for (let d = 0; d < 4; d++) add(x + DIRS[d][0], y + DIRS[d][1]);
  if (r >= 1) for (const [dx, dy] of DIAGONALS) add(x + dx, y + dy);
  if (r === 2) for (const [dx, dy] of AXES) add(x + 2 * dx, y + 2 * dy);
  if (r >= 3) {
    for (let i = 0; i < 3; i++) {
      add(x + i - 1, y - 2);
      add(x + i - 1, y + 2);
    }
    for (let i = 0; i < 3; i++) {
      add(x + 2, y + i - 1);
      add(x - 2, y + i - 1);
    }
  }
  if (r === 4) {
    for (const [dx, dy] of AXES) add(x + 3 * dx, y + 3 * dy);
    for (const [dx, dy] of DIAGONALS) add(x + 2 * dx, y + 2 * dy);
  }
  return out;
}

/**
 * Units reachable by `unit`'s shape `rangeType` centred on (x,y) (1cb6:c018). With `allies`
 * (flag bit 0) the centre is included and same-side units are listed, otherwise enemies.
 * `mark` (the c018 flag bit 0x80 clear) receives unit.slot in every visited cell, which is how
 * the AI builds its "can attack from here" map.
 */
export function unitsInRange(
  f: Field,
  unit: Unit,
  rangeType: number,
  x: number,
  y: number,
  allies: boolean,
  mark?: Uint8Array,
): number[] {
  if (rangeType === NONE) return [];
  const side = sideOf(unit.slot);
  const out: number[] = [];
  for (const [cx, cy] of rangeCells(f, x, y, rangeType, allies)) {
    if (mark) mark[cy * f.width + cx] = unit.slot;
    const s = unitAt(f, cx, cy);
    if (s === NONE) continue;
    if ((sideOf(s) === side) === allies) out.push(s);
  }
  return out;
}

/** c018's return value: the previous AI target (DS:0xe51c) if listed, else the last unit listed. */
export function pickTarget(list: number[], previous: number): number {
  if (list.length === 0) return NONE;
  return list.includes(previous) ? previous : list[list.length - 1];
}

// ---- movement (1cb6:c9bc) ----

export const BFS_REACH = 2; // stop with 1 when the target cell is reached; also disables ZOC
export const BFS_EVALUATE = 4; // call `evaluate` on the start cell and on every newly reached cell
export const BFS_FIND_FOE = 8; // stop on a cell from which a visible enemy can be attacked

export interface BfsOptions {
  flags: number;
  maxCost: number;
  target?: Pos; // (0xff,0xff) when absent
  /** Map segment 0x6780 ("attackable from"): enemy slot per cell or 0xff, for BFS_FIND_FOE. */
  foeMap?: Uint8Array;
  evaluate?: (x: number, y: number) => void;
  /** Called after the grid is reset when BFS_EVALUATE is set, before the start cell is evaluated. */
  onEvaluateStart?: () => void;
}

/**
 * Flood fill of movement costs from `start` into `grid` (map segment +0x18bc, 0xff = unreached),
 * exactly as 1cb6:c9bc does it, including its quirks:
 *  - passes go over the whole map row-major and expand only cells whose value equals the
 *    current level d; the next d is the smallest value *set during this pass*, so cells set in
 *    an earlier pass with a value below that are never expanded;
 *  - the fill stops after a pass that sets nothing, or when d >= maxCost;
 *  - a cell next to an enemy (ZOC) is not expanded unless it is the start cell, flags&3, or the
 *    unit is script-controlled; friendly units can be passed, enemy cells cannot be entered.
 * Returns 0xff, 1 (BFS_REACH hit) or the enemy slot found with BFS_FIND_FOE.
 */
export function floodMove(f: Field, unit: Unit, start: Pos, grid: Uint8Array, o: BfsOptions): number {
  const mt = moveTypeOf(f, unit);
  const side = sideOf(unit.slot);
  const scripted = (unit.flags & UnitFlag.Scripted) !== 0;
  const tx = o.target ? o.target[0] : NONE;
  const ty = o.target ? o.target[1] : NONE;
  if (start[0] === tx && start[1] === ty) return NONE; // checked before the grid is reset
  const W = f.width;
  grid.fill(NONE, 0, W * f.height);
  grid[start[1] * W + start[0]] = 0;
  if (o.flags & BFS_EVALUATE) {
    o.onEvaluateStart?.();
    if (!scripted) o.evaluate?.(start[0], start[1]);
  }
  if (moveCost(mt, terrainAt(f, start[0], start[1])) === 0xff) return NONE;
  let d = 0;
  for (;;) {
    if (d >= o.maxCost) return NONE;
    let changed = false;
    let next = 0xff;
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < W; x++) {
        const v = grid[y * W + x];
        if (v !== d) continue;
        const isStart = x === start[0] && y === start[1];
        if (!isStart && !(o.flags & 3) && !scripted && enemyAdjacent(f, side, x, y)) continue;
        for (let dir = 0; dir < 4; dir++) {
          const n = neighbour(f, x, y, dir);
          if (!n) continue;
          const ni = n[1] * W + n[0];
          if (grid[ni] !== NONE) continue;
          const c = moveCost(mt, f.terrain[ni]);
          if (c === 0xff || c + v > o.maxCost) continue;
          const occ = f.unitAt[ni];
          if (occ !== NONE && sideOf(occ) !== side) continue;
          grid[ni] = c + v;
          changed = true;
          if (grid[ni] < next) next = grid[ni];
          if (o.flags & BFS_FIND_FOE && o.foeMap) {
            const foe = o.foeMap[ni];
            if (foe !== NONE && f.units[foe].flags & UnitFlag.Visible) return foe;
          }
          if (o.flags & BFS_REACH && n[0] === tx && n[1] === ty) return 1;
          if (o.flags & BFS_EVALUATE) o.evaluate?.(n[0], n[1]);
        }
      }
    }
    d = next;
    if (!changed) return NONE;
  }
}

export interface PathResult {
  /** Directions (0..3) leading from `to` back to `from` — the route a unit standing on `to` walks. */
  route: number[];
  /** Where the walk from `from` stopped (== to when reached). */
  stop: Pos;
  reached: boolean;
}

/**
 * Walks downhill on a flood-fill grid from `from` towards its origin `to` (1cb6:c772): at each
 * step it takes the neighbour with the smallest grid value below the current one (first in
 * N,E,S,W order on ties) whose terrain cost fits the remaining `budget`, skipping cells next to an
 * enemy unless they are `to` or the unit is script-controlled. The step list is then reversed
 * with each direction turned around, giving the route from `to` to `from`.
 */
export function walkPath(f: Field, unit: Unit, grid: Uint8Array, from: Pos, to: Pos, budget: number): PathResult {
  const mt = moveTypeOf(f, unit);
  const side = sideOf(unit.slot);
  const scripted = (unit.flags & UnitFlag.Scripted) !== 0;
  const W = f.width;
  let [cx, cy] = from;
  const steps: number[] = [];
  let reached = cx === to[0] && cy === to[1];
  let left = budget;
  while (!reached) {
    let best = NONE;
    let bestVal = grid[cy * W + cx];
    let bestCost = 0;
    for (let dir = 0; dir < 4; dir++) {
      const n = neighbour(f, cx, cy, dir);
      if (!n) continue;
      const isTo = n[0] === to[0] && n[1] === to[1];
      if (enemyAdjacent(f, side, n[0], n[1]) && !isTo && !scripted) continue;
      const g = grid[n[1] * W + n[0]];
      if (g >= bestVal) continue;
      const c = moveCost(mt, terrainAt(f, n[0], n[1]));
      if (c > left) continue;
      bestVal = g;
      best = dir;
      bestCost = c;
    }
    if (best === NONE) break;
    cx += DIRS[best][0];
    cy += DIRS[best][1];
    left -= bestCost;
    steps.push(best);
    reached = cx === to[0] && cy === to[1];
  }
  const route = steps.reverse().map((d) => (d + 2) & 3);
  return { route, stop: [cx, cy], reached };
}
