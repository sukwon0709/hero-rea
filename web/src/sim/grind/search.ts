// Grinding simulator: save and restore a running battle in place, for the look-ahead search of the
// player phase (GrindParams.search, policy.ts searchPhase). A save holds everything the battle
// changes while it runs: the officers' records (troops, level, exp, class, items), the money and
// the main-loop status/location, the script context and the VM, the battle block (turn, result,
// weather, bonus), the unit table, the unit map and the AI scratch maps, the map chips (MAP_CHIP),
// the RNG and the battle host's duel state, plus the policy objects' own fields. A rollout plays
// on the live scene and is undone with restoreScene: no second scene is built.

import type { BattleScene } from '../../native/battle/scene';
import type { OfficerDyn } from '../../formats/tables';
import type { Unit } from '../../engine/battle/types';

interface OfficerSave {
  dyn: OfficerDyn;
  lead: number;
  force: number;
  intel: number;
}

export interface SceneSave {
  officers: OfficerSave[];
  progress: unknown;
  location: unknown;
  prevLocation: unknown;
  status: number;
  script: unknown;
  pictureOpen: unknown;
  info: Record<string, number>;
  units: Unit[];
  unitAt: Uint8Array;
  grid: Uint8Array;
  foeMap: Uint8Array;
  influence: Uint8Array;
  terrain: Uint8Array | number[];
  chips: Uint8Array | number[];
  chipLog: number;
  effectLog: { x: number; y: number; terrain: number }[];
  weather: number;
  ai: Record<string, unknown>;
  castable: unknown[];
  rng: number;
  hostMoves: unknown[];
  hostDuel: unknown;
  objs: { obj: Record<string, unknown>; fields: Record<string, unknown> }[];
}

/** Policy fields never copied: the wiring, the static knowledge and the caches keyed by what they cover. */
const SKIP = new Set(['scene', 'sc', 'p', 'know', 'log', 'policy', 'reachCache', 'distMaps', 'foeMaps', 'threat', 'tthreat', 'loose', 'lastParts', 'search', 'prev', 'lo', 'o', 'wave', 'inRollout', 'altK', 'lastAlts', 'decisions', 'searchStats', 'searchSeed']);

function saveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (SKIP.has(k)) continue;
    const v = obj[k];
    if (typeof v === 'function') continue;
    out[k] = v !== null && typeof v === 'object' ? structuredClone(v) : v;
  }
  return out;
}

/** Saves the live battle (and the given policy objects' fields). */
export function saveScene(scene: BattleScene, objs: object[] = []): SceneSave {
  const st = scene.ctx.state;
  const b = scene.b;
  const s = b.s;
  const vm = scene.ctx.vm as unknown as Record<string, unknown>;
  const host = scene.host as unknown as { moves: unknown[]; duel: unknown };
  return {
    officers: st.officers.map((o) => ({ dyn: { ...o.dyn, items: [...o.dyn.items] }, lead: o.leadership, force: o.strength, intel: o.intelligence })),
    progress: { ...st.progress },
    location: { ...st.location },
    prevLocation: { ...st.prevLocation },
    status: st.status,
    script: structuredClone(scene.ctx.vm.state),
    pictureOpen: vm.pictureOpen,
    info: { ...(b.info as unknown as Record<string, number>) },
    units: s.units.map((u) => ({ ...u })),
    unitAt: s.unitAt.slice(),
    grid: s.grid.slice(),
    foeMap: s.foeMap.slice(),
    influence: s.influence.slice(),
    terrain: b.map.terrain.slice(),
    chips: b.map.chips.slice(),
    chipLog: b.chipLog.length,
    effectLog: b.effectLog.map((e) => ({ ...e })),
    weather: s.weather,
    ai: { ...(s.ai as unknown as Record<string, unknown>) },
    castable: structuredClone(s.castable),
    rng: b.rng.seed,
    hostMoves: structuredClone(host.moves ?? []),
    hostDuel: host.duel ? { ...(host.duel as object) } : null,
    objs: objs.map((obj) => ({ obj: obj as Record<string, unknown>, fields: saveFields(obj as Record<string, unknown>) })),
  };
}

function setArr(dst: Uint8Array | number[], src: Uint8Array | number[]) {
  if (dst instanceof Uint8Array) dst.set(src as Uint8Array);
  else for (let i = 0; i < src.length; i++) dst[i] = src[i];
}

/** Puts the battle back as it was saved (the save stays usable for more restores). */
export function restoreScene(scene: BattleScene, sv: SceneSave): void {
  const st = scene.ctx.state;
  const b = scene.b;
  const s = b.s;
  sv.officers.forEach((o, i) => {
    const off = st.officers[i];
    const items = off.dyn.items;
    Object.assign(off.dyn, o.dyn);
    items.length = 0;
    items.push(...o.dyn.items);
    off.dyn.items = items;
    off.leadership = o.lead;
    off.strength = o.force;
    off.intelligence = o.intel;
  });
  Object.assign(st.progress, sv.progress);
  Object.assign(st.location, sv.location);
  Object.assign(st.prevLocation, sv.prevLocation);
  st.status = sv.status;
  const script = scene.ctx.vm.state as unknown as Record<string, unknown>;
  const fresh = structuredClone(sv.script) as Record<string, unknown>;
  for (const k of Object.keys(script)) if (!(k in fresh)) delete script[k];
  Object.assign(script, fresh);
  (scene.ctx.vm as unknown as Record<string, unknown>).pictureOpen = sv.pictureOpen;
  Object.assign(b.info, sv.info);
  sv.units.forEach((u, i) => Object.assign(s.units[i], u));
  s.unitAt.set(sv.unitAt);
  s.grid.set(sv.grid);
  s.foeMap.set(sv.foeMap);
  s.influence.set(sv.influence);
  setArr(b.map.terrain, sv.terrain);
  setArr(b.map.chips, sv.chips);
  b.chipLog.length = sv.chipLog;
  b.effectLog.splice(0, b.effectLog.length, ...sv.effectLog.map((e) => ({ ...e })));
  s.weather = sv.weather;
  Object.assign(s.ai, sv.ai);
  s.castable = structuredClone(sv.castable) as typeof s.castable;
  b.rng.seed = sv.rng;
  const host = scene.host as unknown as { moves: unknown[]; duel: unknown };
  host.moves = structuredClone(sv.hostMoves);
  host.duel = sv.hostDuel ? { ...(sv.hostDuel as object) } : null;
  for (const { obj, fields } of sv.objs) {
    for (const [k, v] of Object.entries(fields)) obj[k] = v !== null && typeof v === 'object' ? structuredClone(v) : v;
    if ('lastParts' in obj) obj.lastParts = null;
  }
}

/** Mixes two numbers into a 32-bit seed (rollout RNG seeds: never the game's own future draws). */
export function mixSeed(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  return h >>> 0 || 1;
}
