// Script commands while a battle runs: the battle branches of the script VM (docs/BATTLE.md,
// "Script commands (battle side)", 2cb4:007e..1824). The VM's host belongs to the field engine;
// for the length of a battle the scene puts these methods in ctx.battleHost, which that host
// forwards to (web/src/native/context.ts).

import type { ScriptHost } from '../../engine/script';
import type { TalkLine } from '../../formats/scenario';
import { applyMove, planUnit } from '../../engine/battle/ai';
import { unitLeaves } from '../../engine/battle/combat';
import { rebuildUnitMap } from '../../engine/battle/hex';
import { secondChipSet } from '../../engine/battle/map';
import { setMorale } from '../../engine/battle/rules';
import { AiMode, NONE, ORDER_TO_MODE, PLAYER_SLOTS, Status, UNIT_SLOTS, UnitFlag, readDgroup } from '../../engine/battle/types';
import { factionOf } from './model';
import type { BattleScene } from './scene';
import { duelAction, duelClash, duelEnd, duelStart } from './effects';

type HostOverrides = Partial<ScriptHost>;

export class BattleHost {
  private moves: { officer: number; x: number; y: number }[] = [];
  /** Duel scene state (DS:0xe5b4), null when no duel is shown. */
  duel: { a: number; b: number } | null = null;

  constructor(readonly scene: BattleScene) {}

  /**
   * Installs the battle methods as ctx.battleHost (the field engine's host forwards every method
   * defined there); returns the function that removes them again.
   */
  install(): () => void {
    const ctx = this.scene.ctx;
    const prev = ctx.battleHost ?? null;
    ctx.battleHost = this.overrides();
    return () => {
      ctx.battleHost = prev;
    };
  }

  private overrides(): HostOverrides {
    const sc = this.scene;
    const b = sc.b;
    const ui = sc.ctx.ui;
    const who = (id: number) => sc.ctx.state.officers[id];
    return {
      // TALK: 2cb4:0208 scrolls to the speaker's unit first, then the usual portrait box
      talk: async (line: TalkLine) => {
        this.focusOfficer(line.speaker);
        await sc.redraw();
        await ui.message(line, { face: who(line.speaker)?.face, name: who(line.speaker)?.name });
        await sc.redraw();
      },
      ask: async (line: TalkLine) => {
        this.focusOfficer(line.speaker);
        await sc.redraw();
        const r = await ui.confirm(line, { face: who(line.speaker)?.face, name: who(line.speaker)?.name });
        await sc.redraw();
        return r;
      },
      showMap: async () => {
        await sc.redraw();
      },
      redraw: async () => {
        await sc.redraw();
      },
      focus: (officer: number) => this.focusOfficer(officer),
      // BATTLE_END: 2cb4:01ba sets the result: 3 (and song 4) when GAME_OVER follows, else 2.
      // GAME_OVER itself is left to the field engine (it ends the game after the battle).
      battleEnd: async (_map: number, lost: boolean) => {
        b.info.result = lost ? 3 : 2;
        if (lost) sc.ctx.sound?.changeSong?.(4);
      },
      // PLACE / REINFORCE: 2cb4:007e
      placeCharacter: (officer: number) => {
        this.reinforce(officer);
      },
      reinforce: (officer: number) => {
        this.reinforce(officer);
      },
      // MOVE: 2cb4:0130 (script-controlled walk, run in waitMoves)
      moveCharacter: (officer: number, x: number, y: number) => {
        this.moves.push({ officer, x, y });
      },
      waitMoves: async () => {
        const list = this.moves.splice(0);
        for (const m of list) await this.scriptedMove(m.officer, m.x, m.y);
      },
      // REMOVE: 2cb4:02e8: flag 4 (no events), leave, clear flag 4
      removeCharacter: (officer: number) => {
        const slot = b.slotOfOfficer(officer);
        if (slot === NONE || b.units[slot].status !== Status.Field) return;
        const u = b.units[slot];
        u.flags |= UnitFlag.Scripted;
        unitLeaves(b.s, slot);
        sc.sfx(9);
        u.flags &= ~UnitFlag.Scripted;
      },
      // SET_AI: 2cb4:031a (order code through DS:0x4fe6; the target bytes as for deployment, inferred)
      setAI: (officer: number, algo: number, a: number, bb: number) => {
        const slot = b.slotOfOfficer(officer);
        if (slot === NONE) return;
        if (factionOf(sc.ctx.state.officers[officer]) === 0) return;
        const u = b.units[slot];
        u.flags &= ~UnitFlag.Scripted;
        u.mode = ORDER_TO_MODE[algo] ?? AiMode.AttackNearest;
        if (algo === 3 || algo === 5) u.target = b.slotOfOfficer(a | (bb << 8));
        else if (algo === 4 || algo === 6) {
          u.tx = a;
          u.ty = bb;
        }
      },
      // UNIT_FORCE: 2cb4:08f2 defection to the other side
      unitForce: (officer: number, force: number) => this.defect(officer, force),
      // HALVE: 2cb4:0a9a
      halve: (side: number, what: number) => {
        const lo = side === 0 ? 0 : PLAYER_SLOTS;
        const hi = side === 0 ? PLAYER_SLOTS : UNIT_SLOTS;
        for (let i = lo; i < hi; i++) {
          const u = b.units[i];
          if (u.status !== Status.Field) continue;
          const o = b.officerOf(u);
          if (what === 0) setMorale(b.rng, u, o.lead, u.morale >> 1);
          else o.hp = o.hp >> 1;
        }
      },
      // DATA 4: 2cb4:0b72 victory bonus experience
      battleData: (value: number) => {
        b.info.bonus = value;
      },
      mapChip: (x: number, y: number, kind: number) => this.mapChip(x, y, kind),
      duel: async (a: number, bb: number) => {
        this.duel = { a, b: bb };
        await duelStart(sc, a, bb);
      },
      battleOp34: async () => {
        await duelClash(sc);
      },
      battleOp35: async (officer: number, value: number) => {
        await duelAction(sc, officer, value);
      },
      battleOp33: async () => {
        this.duel = null;
        await duelEnd(sc);
      },
      unitAttack: async () => {
        // 2cb4:02e4: no-op in battle
      },
    };
  }

  private focusOfficer(officer: number) {
    const slot = this.scene.b.slotOfOfficer(officer);
    if (slot === NONE) return;
    const u = this.scene.b.units[slot];
    if (u.status === Status.Field) this.scene.v.ensureVisible(u.x, u.y);
  }

  private reinforce(officer: number) {
    const b = this.scene.b;
    const slot = b.reinforce(officer);
    if (slot !== NONE) this.scene.v.ensureVisible(b.units[slot].x, b.units[slot].y);
  }

  /** 2cb4:0130: flag 4, mode 0 towards (x,y), ce50 at once, then clear flags 0xc4. */
  private async scriptedMove(officer: number, x: number, y: number) {
    const sc = this.scene;
    const b = sc.b;
    if (x >= b.width || y >= b.height) return;
    const slot = b.slotOfOfficer(officer);
    if (slot === NONE || b.units[slot].status !== Status.Field) return;
    const u = b.units[slot];
    u.flags |= UnitFlag.Scripted;
    u.mode = AiMode.MoveTo;
    u.target = NONE;
    u.tx = x;
    u.ty = y;
    u.flags &= ~UnitFlag.Acted;
    const from: [number, number] = [u.x, u.y];
    const plan = planUnit(b.s, u);
    if (plan && plan.route.length) {
      applyMove(b.s, u, plan);
      const to: [number, number] = [u.x, u.y];
      b.place(slot, null, from[0], from[1]);
      sc.v.ensureVisible(from[0], from[1]);
      await sc.animateRoute(slot, plan.route);
      if (u.x !== to[0] || u.y !== to[1]) b.place(slot, null, to[0], to[1]);
    }
    u.flags &= ~(UnitFlag.Scripted | UnitFlag.Moved | UnitFlag.Acted);
  }

  /** 2cb4:08f2 */
  private defect(officer: number, force: number) {
    const sc = this.scene;
    const b = sc.b;
    const slot = b.slotOfOfficer(officer);
    if (slot === NONE) return;
    const toPlayer = slot >= PLAYER_SLOTS;
    const lo = toPlayer ? 0 : PLAYER_SLOTS;
    const hi = toPlayer ? PLAYER_SLOTS : UNIT_SLOTS;
    let dst = NONE;
    for (let i = lo; i < hi; i++) if (b.units[i].status === Status.Empty) {
      dst = i;
      break;
    }
    const so = sc.ctx.state.officers[officer];
    so.dyn.flags = (so.dyn.flags & ~0x1f) | (force & 0x1f);
    if (dst === NONE) return;
    const src = b.units[slot];
    const d = b.units[dst];
    Object.assign(d, { ...src, slot: dst });
    d.mode = toPlayer && factionOf(so) === 0 ? AiMode.Player : AiMode.Wait;
    b.clearSlot(slot);
    rebuildUnitMap(b.s);
  }

  /** MAP_CHIP (2cb4:05e6) with the tables at DS:0x4ff5..0x5015 (docs/BATTLE.md). */
  private mapChip(x: number, y: number, kind: number) {
    const b = this.scene.b;
    if (x >= b.width || y >= b.height) return;
    const main = this.scene.ctx.assets.main;
    const t = readDgroup(main, 0x4ff5, 0x30);
    const at = (off: number) => t[off - 0x4ff5];
    const k = kind & 0x7f;
    const W = b.width * 2;
    const chips = [(2 * y) * W + 2 * x, (2 * y) * W + 2 * x + 1, (2 * y + 1) * W + 2 * x, (2 * y + 1) * W + 2 * x + 1];
    const ti = y * b.width + x;
    if (k === 2) {
      const pairs = readDgroup(main, 0x500c, 9);
      const repl = readDgroup(main, 0x5015, 9);
      let d3 = false;
      for (const c of chips) {
        const i = pairs.indexOf(b.map.chips[c]);
        if (i >= 0) b.map.chips[c] = repl[i];
        if (b.map.chips[c] === 0xd3) d3 = true;
      }
      if (d3) b.map.terrain[ti] = kind & 1 ? at(0x4ff9) : at(0x4ff7);
    } else {
      if (b.map.terrain[ti] !== at(0x4ff6 + k)) return;
      const chipset = secondChipSet(b.info.map) - 1; // which chip-set pair (inferred)
      const add = readDgroup(main, 0x4ffa + chipset * 4 + k, 1)[0];
      for (const c of chips) {
        const v = b.map.chips[c];
        b.map.chips[c] = v === 0xc5 ? 0xc7 : v === 0xc6 ? 0xe6 : (v + add) & 0xff;
      }
      b.map.terrain[ti] = at(0x4ff5 + k + (kind & 1 ? 0 : 2));
    }
    if (!(kind & 0x80)) b.chipLog.push({ x, y, kind: kind | 0x80, terrain: b.map.terrain[ti] });
  }
}
