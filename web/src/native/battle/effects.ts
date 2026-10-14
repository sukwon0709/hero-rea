// Battle effects drawn over the map view: the close-up combat result (1cb6:e91a with close-ups on,
// result text of 1cb6:e4a6) and the duel scene (script ops DUEL / 33 / 34 / 35, 2cb4:09d2..1824).
//
// Both are simplified: the close-up shows the two units enlarged with the troop bar and the
// original's result strings, not the HEXBMAP/HEXBCHR animation; the duel shows the two units
// facing each other. The random draws of op 34 are reproduced exactly (2cb4:1736): five rounds of
// two rand(3), then per frame (2 frames) one rand(2) unless both rolls were 2.

import type { HitResult } from '../../engine/battle/combat';
import { maxHp } from '../../engine/battle/rules';
import { NONE, PLAYER_SLOTS, Unit } from '../../engine/battle/types';
import type { BattleScene } from './scene';
import { CELL, VIEW_H, VIEW_W, VIEW_X, VIEW_Y } from './view';
import { dsBytes, fmt } from './strings';

const BOX_X = VIEW_X + 32;
const BOX_Y = VIEW_Y + 64;
const BOX_W = VIEW_W * CELL - 64;
const BOX_H = 192;

function drawBig(scene: BattleScene, u: Unit, x: number, y: number, frame: number, faceRight: boolean) {
  // draw the 32x32 sprite at 2x by drawing it to the screen and scaling the grabbed block
  const v = scene.v;
  const saved = v.screen.grab(x, y, 32, 32);
  const flags = u.flags;
  if (faceRight) u.flags &= ~0x10;
  else u.flags |= 0x10;
  v.screen.fillRect(x, y, 32, 32, 0);
  v.drawUnit(u, x, y, frame);
  u.flags = flags;
  const img = v.screen.grab(x, y, 32, 32);
  v.screen.blit(saved, 32, 32, x, y);
  const big = new Uint8Array(64 * 64);
  for (let yy = 0; yy < 64; yy++) for (let xx = 0; xx < 64; xx++) big[yy * 64 + xx] = img[(yy >> 1) * 32 + (xx >> 1)];
  v.screen.blit(big, 64, 64, x, y, 0);
}

function panel(scene: BattleScene) {
  const v = scene.v;
  v.render();
  v.shade(VIEW_X, VIEW_Y, VIEW_W * CELL, VIEW_H * CELL);
  v.screen.fillRect(BOX_X, BOX_Y, BOX_W, BOX_H, 1);
  v.rect(BOX_X, BOX_Y, BOX_W, BOX_H, 7);
  v.rect(BOX_X + 2, BOX_Y + 2, BOX_W - 4, BOX_H - 4, 0);
}

/** Close-up result of one hit (kind 1 attack, 2 tactic, 3 bomb). */
export async function closeupScene(scene: BattleScene, h: HitResult, prev: { hp: number; morale: number }, kind: number) {
  const b = scene.b;
  const main = scene.ctx.assets.main;
  const A = b.units[h.attacker];
  const D = b.units[h.defender];
  const od = b.officerOf(D);
  const oa = b.officerOf(A);
  const max = maxHp(od);
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    panel(scene);
    const atkLeft = h.attacker < PLAYER_SLOTS ? false : true;
    const lx = BOX_X + 32;
    const rx = BOX_X + BOX_W - 96;
    const ax = atkLeft ? lx : rx;
    const dx = atkLeft ? rx : lx;
    const lunge = i < steps / 2 ? Math.round((i * 24) / (steps / 2)) * (atkLeft ? 1 : -1) : 0;
    drawBig(scene, A, ax + lunge, BOX_Y + 24, (i >> 2) & 1, atkLeft);
    if (!(i > steps / 2 && i & 2)) drawBig(scene, D, dx, BOX_Y + 24, 0, !atkLeft);
    const nameA = scene.name(h.attacker);
    const nameD = scene.name(h.defender);
    scene.v.text(fmt(dsBytes(main, 0x4faa), oa.level, nameA), (ax >> 3) - 1, BOX_Y + 96);
    scene.v.text(fmt(dsBytes(main, 0x4faa), od.level, nameD), (dx >> 3) - 1, BOX_Y + 96);
    const hp = i <= steps / 2 ? prev.hp : Math.round(prev.hp - ((prev.hp - od.hp) * (i - steps / 2)) / (steps / 2));
    scene.v.bar(1, Math.max(0, hp), max, BOX_X + 120, BOX_Y + 140, 128);
    if (i === steps / 2) scene.sfx(0x13);
    await scene.ctx.ui.frame();
  }
  const lines: number[] = [];
  const push = (x: Uint8Array) => lines.push(...x, 0x0a);
  if (h.damage === 0) push(fmt(dsBytes(main, kind === 2 ? 0x4f45 : 0x4ecd), kind === 2 ? scene.name(h.attacker) : scene.name(h.defender)));
  else {
    push(fmt(dsBytes(main, 0x4eea), scene.name(h.defender), h.damage));
    if (h.moraleLoss) push(fmt(dsBytes(main, 0x4f06), h.moraleLoss));
  }
  if (h.exp && h.attacker < PLAYER_SLOTS) push(fmt(dsBytes(main, 0x4f23), scene.name(h.attacker), h.exp));
  lines.pop();
  await scene.ctx.ui.message({ bytes: Uint8Array.from(lines), text: new TextDecoder('euc-kr').decode(Uint8Array.from(lines)) });
  void NONE;
  await scene.redraw();
}

// ---------------------------------------------------------------- duel

let duelPair: { a: number; b: number } | null = null;

function duelFrame(scene: BattleScene, offA: number, offB: number, flash: boolean) {
  const b = scene.b;
  if (!duelPair) return;
  panel(scene);
  const sa = b.slotOfOfficer(duelPair.a);
  const sb = b.slotOfOfficer(duelPair.b);
  const cx = BOX_X + BOX_W / 2;
  if (sa !== NONE) drawBig(scene, b.units[sa], cx - 96 + offA, BOX_Y + 48, scene.v.tick >> 3, true);
  if (sb !== NONE) drawBig(scene, b.units[sb], cx + 32 - offB, BOX_Y + 48, scene.v.tick >> 3, false);
  if (sa !== NONE) scene.v.text(scene.name(sa), ((cx - 96) >> 3) + 1, BOX_Y + 128);
  if (sb !== NONE) scene.v.text(scene.name(sb), ((cx + 32) >> 3) + 1, BOX_Y + 128);
  if (flash) scene.v.rect(cx - 8, BOX_Y + 64, 16, 16, 7);
}

export async function duelStart(scene: BattleScene, a: number, b: number) {
  duelPair = { a, b };
  for (let i = 0; i < 20; i++) {
    scene.v.tick++;
    duelFrame(scene, 0, 0, false);
    await scene.ctx.ui.frame();
  }
}

/** Script op 34 (2cb4:1736): five clashes; the RNG draws are those of the original. */
export async function duelClash(scene: BattleScene) {
  const rng = scene.b.rng;
  for (let round = 0; round < 5; round++) {
    const a = (rng.rand(3) + 2) * 2;
    const c = (rng.rand(3) + 2) * 2;
    for (let f = 0; f < 2; f++) {
      const offA = a === 8 ? 0 : (a - 2) * 4;
      const offB = c === 8 ? 0 : (c - 2) * 4;
      if (a !== 8 || c !== 8) scene.sfx(0x29 - (rng.rand(2) === 0 ? 1 : 0));
      for (let k = 0; k < 6; k++) {
        scene.v.tick++;
        duelFrame(scene, offA, offB, f === 1);
        await scene.ctx.ui.frame();
      }
    }
  }
}

/** Script op 35 (2cb4:14d0): an action of one duelist (drawn as a short lunge; no RNG). */
export async function duelAction(scene: BattleScene, officer: number, value: number) {
  const isA = duelPair?.a === officer;
  for (let k = 0; k < 16; k++) {
    scene.v.tick++;
    const off = value === 4 || value === 5 ? (k & 4 ? 12 : 0) : Math.min(k, 8) * 2;
    duelFrame(scene, isA ? off : 0, isA ? 0 : off, value === 5 && k > 8);
    await scene.ctx.ui.frame();
  }
}

/** Script op 33 (2cb4:1824): the duel ends and the battle map comes back. */
export async function duelEnd(scene: BattleScene) {
  duelPair = null;
  await scene.redraw();
}
