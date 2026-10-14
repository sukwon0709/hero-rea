// A scripted player for the tests and the headless runs: it plays the player phase through the
// same clicks a person would make (unit, destination, command menu, target), choosing moves with
// the engine's AI planner. Needs ScriptedInput and a DevUi in auto mode (menus read menuAnswers).

import { planUnit } from '../../../engine/battle/ai';
import { unitsInRange } from '../../../engine/battle/hex';
import { AiMode, CLASS_RANGE, NONE, PLAYER_SLOTS, Status, UnitFlag, type Unit } from '../../../engine/battle/types';
import type { BattleScene } from '../scene';
import type { ScriptedInput } from './headless';
import type { DevUi } from './ui';

export interface BotOptions {
  /** Per-officer order: officer -> officer to walk to; such a unit attacks only that one. */
  goals?: Map<number, number>;
}

/** Hooks the bot into `input`: whenever the scene waits for a click, the bot supplies the next one. */
export function attachBot(scene: BattleScene, input: ScriptedInput, ui: DevUi, opts: BotOptions = {}) {
  const queue: (() => { x: number; y: number } | null)[] = [];
  const answers = (ui.opts.menuAnswers ??= []);
  const click = (x: number, y: number) => input.clicks.push({ button: 'left', x, y });
  const cellClick = (u: Unit) => () => {
    scene.v.ensureVisible(u.x, u.y);
    const [px, py] = scene.v.cellPos(u.x, u.y);
    return { x: px + 16, y: py + 16 };
  };

  /** The slot a unit with a goal heads for (it attacks nothing else), or NONE. */
  const goalSlot = (u: Unit) => {
    const goal = opts.goals?.get(u.officer);
    const gs = goal === undefined ? NONE : scene.b.slotOfOfficer(goal);
    return gs !== NONE && scene.units[gs].status === Status.Field ? gs : NONE;
  };

  const planFor = (slot: number) => {
    const b = scene.b;
    const u = scene.units[slot];
    const saved = { mode: u.mode, target: u.target, flags: u.flags };
    const gs = goalSlot(u);
    u.mode = gs !== NONE ? AiMode.MoveTo : AiMode.AttackNearest;
    u.target = u.mode === AiMode.MoveTo ? gs : NONE;
    u.flags &= ~(UnitFlag.Acted | UnitFlag.Moved);
    const plan = planUnit(b.s, u);
    Object.assign(u, saved);
    return plan;
  };

  const next = () => {
    if (queue.length) return;
    const slot = scene.units
      .slice(0, PLAYER_SLOTS)
      .findIndex((u) => u.status === Status.Field && u.mode === AiMode.Player && !(u.flags & (UnitFlag.Acted | UnitFlag.Confused | UnitFlag.Scripted)));
    if (slot < 0) {
      // nothing left to command: open the 기능 menu and pick 턴 종료 (item 0); auto confirm says yes
      queue.push(() => {
        answers.push(0);
        return { x: 40, y: 56 };
      });
      return;
    }
    const u = scene.units[slot];
    const plan = planFor(slot);
    const dest = plan?.dest ?? [u.x, u.y];
    queue.push(cellClick(u));
    // the command menu opens right after the walk, so its answers go in with the destination click
    const targets = () => {
      const b = scene.b;
      const [x, y] = [u.x, u.y];
      return unitsInRange(b.s, u, CLASS_RANGE[b.officerOf(u).cls], x, y, false).filter(
        (t) => scene.units[t].flags & UnitFlag.Visible && (goalSlot(u) === NONE || t === goalSlot(u)),
      );
    };
    queue.push(() => {
      const b = scene.b;
      const near = unitsInRange(b.s, u, CLASS_RANGE[b.officerOf(u).cls], dest[0], dest[1], false).filter(
        (t) => scene.units[t].flags & UnitFlag.Visible && (goalSlot(u) === NONE || t === goalSlot(u)),
      );
      if (near.length) answers.push(0, 3); // 공격 (falls back to 대기 when nobody is in range after all)
      else answers.push(3); // 대기
      scene.v.ensureVisible(dest[0], dest[1]);
      const [px, py] = scene.v.cellPos(dest[0], dest[1]);
      return { x: px + 16, y: py + 16 };
    });
    queue.push(() => {
      if (u.flags & UnitFlag.Acted) return null; // it waited instead (nobody in range after all)
      const list = targets();
      if (!list.length) return null;
      if (answers[0] === 3) answers.shift(); // the 대기 fallback is not needed
      const t = plan && list.includes(plan.target) ? plan.target : list[list.length - 1]; // as 1cb6:cd4a
      const tu = scene.units[t];
      const [px, py] = scene.v.cellPos(tu.x, tu.y);
      return { x: px + 16, y: py + 16 };
    });
  };

  input.onIdle = () => {
    for (let guard = 0; guard < 4 && !input.clicks.length; guard++) {
      next();
      const f = queue.shift();
      const c = f?.();
      if (c) click(c.x, c.y);
    }
  };
}
