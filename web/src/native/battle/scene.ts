// Battle mode of native mode: the main loop of MAIN.EXE's tactical battle (1cb6:4b52), the turn
// (3db2), the player phase with its menus (44de, a474, d972, 657e, a8e2, b2d6), the computer
// phases (3f32 / ce50) and the per-action script events (8ad2, 4abc, 8504). Rules and AI come from
// web/src/engine/battle; this file sequences them, draws through view.ts and talks to the script
// through ctx.runEvent. docs/BATTLE.md ("Player phase") describes the flow with addresses.

import type { GameContext, RunBattle } from '../context';
import type { Trigger } from '../../engine/script';
import { Rng, castableTactics, healAmounts, maxHp, maxMp, movePoints, tacticsLearnedAt, tryCure, regenerate, setMorale, tacticTerrainOk } from '../../engine/battle/rules';
import { areaHealItem, attack, bombItem, castTactic, fight, unitLeaves, type CastResult, type HitResult } from '../../engine/battle/combat';
import { actionOrder, applyMove, attackTargetAfterMove, planUnit, type Plan } from '../../engine/battle/ai';
import { floodMove, rangeCells, rebuildUnitMap, terrainAt, unitAt, unitsInRange, walkPath, neighbour, sideOf } from '../../engine/battle/hex';
import { battleNameLines } from '../../engine/battle/map';
import {
  AiMode,
  CLASS_BAND,
  CLASS_MOVE_TYPE,
  CLASS_RANGE,
  DIRS,
  NONE,
  PLAYER_SLOTS,
  RAIN,
  Status,
  TACTIC_MP,
  TACTIC_POWER,
  UNIT_SLOTS,
  Unit,
  UnitFlag,
  moveCost,
} from '../../engine/battle/types';
import { Battle } from './model';
import { BattleView, CELL, VIEW_H, VIEW_W, VIEW_X, VIEW_Y } from './view';
import { BattleHost } from './host';
import { dsBytes, dsTable, dsWord, euc, fmt, msg, S, type FmtArg } from './strings';
import { closeupScene } from './effects';

/** Optional extras a GameContext may carry (see the report's contract additions). */
export interface BattleExtras {
  /** The game's shared RNG (DS:0xcc8). Without it the battle seeds its own. */
  rng?: Rng;
  /** Player officers chosen on the formation screen (slot order), for stages with formation. */
  formation?: number[];
  /** Zero-player mode (DS:0x3a3c bit 0): player units are computer-controlled (tests, demo). */
  autoPlay?: boolean;
  /** Called after the units are deployed (harness / tests: give autoplay units orders). */
  afterSetup?: (scene: BattleScene) => void;
}

/** Sound effect numbers passed to SoundPlayer.playSfx (MAIN.EXE 0cf5:6280 arguments). */
const SFX = { select: 0, cancel: 1, leave: 9, error: 10, hit: 0x13 } as const;
const MUSIC_LOST = 4;

export const runBattle: RunBattle = async (ctx, map) => {
  const scene = new BattleScene(ctx, map, ctx as GameContext & BattleExtras);
  const r = await scene.run();
  // 1cb6:3926 skips the player records of a battle with the formation flag: the player slots a won
  // battle leaves deploy again in the next one (진창 -> 장안, 업1 -> 업2 -> 업3)
  if (r === 2) {
    const ex = ctx as GameContext & BattleExtras;
    ex.formation = scene.units
      .slice(0, PLAYER_SLOTS)
      .filter((u) => u.status !== Status.Empty && u.officer < 0x400)
      .map((u) => u.officer);
  }
  return r === 2 ? 'won' : r === 3 ? 'lost' : 'ended';
};

type FireResult = 'none' | 'stop' | 'more';

export class BattleScene {
  readonly b: Battle;
  readonly v: BattleView;
  readonly host: BattleHost;
  private snapshot: { dyn: string; script: string; money: number } | null = null;
  /** Location mode and main-loop status bits when the battle began (see checkLeftBattle). */
  private readonly entryMode: number;
  private readonly entryStatus: number;

  constructor(
    readonly ctx: GameContext,
    readonly mapNo: number,
    readonly extras: BattleExtras = {},
  ) {
    this.entryMode = ctx.state.location.mode;
    this.entryStatus = ctx.state.status & 0x6e;
    const rng = extras.rng ?? new Rng((Date.now() ^ 0x5eed) >>> 0);
    this.b = new Battle(ctx.state, ctx.vm.state, ctx.assets.entries('HEXZMAP.R3'), ctx.assets.main, rng, mapNo);
    this.v = new BattleView(ctx, this.b);
    this.host = new BattleHost(this);
    const names = battleNameLines(ctx.assets.file('HEXZMAP.R3'));
    const line = names[mapNo] ?? new Uint8Array(0);
    this.v.setTitle(new Uint8Array([...line, ...dsBytes(ctx.assets.main, 0x3dff)]));
  }

  get main(): Uint8Array {
    return this.ctx.assets.main;
  }

  get units(): Unit[] {
    return this.b.units;
  }

  get result(): number {
    return this.b.info.result;
  }

  // ---------------------------------------------------------------- small helpers

  sfx(n: number) {
    this.ctx.sound?.playSfx(n);
  }

  async redraw() {
    await this.v.frameStep();
  }

  async frames(n: number) {
    for (let i = 0; i < n; i++) await this.v.frameStep();
  }

  /** 0cf5:3c5e: message box with a DS format string. */
  async say(off: number, ...args: FmtArg[]) {
    this.v.render();
    await this.ctx.ui.message(msg(fmt(dsBytes(this.main, off), ...args)));
    await this.redraw();
  }

  async sayBytes(b: Uint8Array) {
    this.v.render();
    await this.ctx.ui.message(msg(b));
    await this.redraw();
  }

  async ask(off: number, ...args: FmtArg[]): Promise<boolean> {
    this.v.render();
    const r = await this.ctx.ui.confirm(msg(fmt(dsBytes(this.main, off), ...args)));
    await this.redraw();
    return r;
  }

  name(slot: number): Uint8Array {
    return this.v.officerName(this.units[slot]);
  }

  /** The menu helper: items from DS strings or bytes; returns -1 on cancel. */
  async menu(items: Uint8Array[], x?: number, y?: number, disabled?: boolean[]): Promise<number> {
    this.v.render();
    const r = await this.ctx.ui.menu(items.map(msg), { x, y, disabled });
    await this.redraw();
    return r;
  }

  // ---------------------------------------------------------------- script events

  /**
   * One dispatch (0cf5:81fe..85e0 + 8794). 'more' stands for the original's results 5/6 (the event
   * suspended or the script moved on, so the caller keeps dispatching); 'stop' for an event that ended.
   */
  async fire(t: Trigger): Promise<FireResult> {
    this.v.render();
    const r = await this.ctx.runEvent(t);
    this.checkLeftBattle();
    rebuildUnitMap(this.b.s);
    this.v.render();
    if (r === 'none') return 'none';
    return r === 'next' || r === 'suspended' ? 'more' : 'stop';
  }

  /**
   * An event that changed the map (MAP 0x1000 after BATTLE_END: the field engine suspends the event,
   * switches the location and sets status 0x02) or ended the game (GAME_OVER: status 0x20) ends the
   * battle even when no BATTLE_END set the result.
   */
  private checkLeftBattle() {
    const st = this.ctx.state;
    const fresh = (st.status & 0x6e) & ~this.entryStatus;
    const moved = this.entryMode === 3 && st.location.mode !== 3;
    if (this.b.info.result === 0 && (moved || fresh)) this.b.info.result = st.status & 0x20 ? 3 : 2;
  }

  /** while (ev in 5,6 and no result): e = trigger, else auto; run (4b52, 4abc, 8504 loops). */
  async eventLoop(first: Trigger | null, autoFallback = true): Promise<boolean> {
    let ran = false;
    for (let i = 0; i < 32 && this.result === 0; i++) {
      let r: FireResult = first ? await this.fire(first) : 'none';
      if (r === 'none' && autoFallback) r = await this.fire({ type: 'auto' });
      if (r === 'none') break;
      ran = true;
      if (r !== 'more') break;
    }
    return ran;
  }

  /** A trigger with the 0x400 "any player unit" fallback of 8ad2 / 85e0. */
  private async fireUnit(make: (officer: number) => Trigger, slot: number): Promise<FireResult> {
    const u = this.units[slot];
    let r = await this.fire(make(u.officer));
    if (r === 'none' && slot < PLAYER_SLOTS) r = await this.fire(make(0x400));
    return r;
  }

  /** 1cb6:8ad2: events after a unit acted (position, area, adjacency), then the auto loop. */
  async unitEvents(slot: number) {
    const u = this.units[slot];
    if (u.flags & UnitFlag.Scripted || u.status !== Status.Field) return;
    const steps: ((s: number) => Promise<FireResult>)[] = [
      (s) => this.fireUnit((o) => ({ type: 'unitAt', officer: o, x: this.units[s].x, y: this.units[s].y }), s),
      (s) => this.fireUnit((o) => ({ type: 'unitInArea', officer: o, x: this.units[s].x, y: this.units[s].y }), s),
      async (s) => {
        let last: FireResult = 'none';
        const me = this.units[s];
        for (let d = 0; d < 4 && this.result === 0; d++) {
          const n = neighbour(this.b.s, me.x, me.y, d);
          if (!n) continue;
          const other = unitAt(this.b.s, n[0], n[1]);
          if (other === NONE) continue;
          const neighbourOfficer = this.units[other].officer;
          let r = await this.fire({ type: 'adjacent', other: me.officer, officer: neighbourOfficer });
          if (r === 'none' && s < PLAYER_SLOTS) r = await this.fire({ type: 'adjacent', other: 0x400, officer: neighbourOfficer });
          if (r !== 'none') last = r;
          if (r === 'stop') break;
        }
        return last;
      },
    ];
    for (const step of steps) {
      for (let i = 0; i < 16 && this.result === 0; i++) {
        if (this.units[slot].status !== Status.Field) return;
        const r = await step(slot);
        if (r !== 'more') break;
      }
      await this.eventLoop(null);
      if (this.result !== 0) return;
    }
  }

  /** 1cb6:4abc */
  async victoryCheck() {
    if (this.result !== 0) return;
    if (this.b.noEnemiesLeft()) await this.eventLoop({ type: 'targetDefeated' });
    else await this.fire({ type: 'auto' });
  }

  /** 1cb6:8504: a unit leaves the field, with its script events. */
  async leave(slot: number) {
    const u = this.units[slot];
    if (u.status !== Status.Field) return;
    unitLeaves(this.b.s, slot);
    this.sfx(SFX.leave);
    await this.redraw();
    if (u.flags & UnitFlag.Scripted) return;
    const sc = this.ctx.vm.state;
    let ran = false;
    if (sc.victory.enabled && sc.victory.officer === u.officer) ran = await this.eventLoop({ type: 'targetDefeated' });
    else if (sc.defeat.enabled && sc.defeat.officer === u.officer) ran = await this.eventLoop({ type: 'leaderDefeated' });
    else ran = await this.eventLoop(null);
    if (this.result === 0) {
      const r = await this.fireUnit((o) => ({ type: 'unitDefeated', officer: o }), slot);
      if (r !== 'none') ran = true;
    }
    if (ran) return;
    if (u.officer === 0) {
      this.b.info.result = 3;
      this.ctx.sound?.changeSong?.(MUSIC_LOST);
      await this.say(S.lostNarration);
    } else await this.say(S.retreated, this.name(slot)); // 1cb6:8716: always 퇴각 here (0x41cc is unreachable)
  }

  async leaveAll(slots: number[]) {
    for (const s of [...new Set(slots)]) {
      if (this.units[s].status === Status.Field && mustGo(this, s)) await this.leave(s);
    }
  }

  // ---------------------------------------------------------------- main loop

  async run(): Promise<number> {
    const restore = this.host.install();
    try {
      this.takeSnapshot();
      for (;;) {
        const r = await this.battle();
        if (r !== 1) return r;
        this.restoreSnapshot(); // 총퇴각: back to the start of the battle
      }
    } finally {
      restore();
    }
  }

  private takeSnapshot() {
    const st = this.ctx.state;
    this.snapshot = {
      dyn: JSON.stringify(st.officers.map((o) => o.dyn)),
      script: JSON.stringify(this.ctx.vm.state, (_k, v) => (v instanceof Uint8Array ? { __u8: Array.from(v) } : v)),
      money: st.progress.money,
    };
  }

  private restoreSnapshot() {
    const snap = this.snapshot;
    if (!snap) return;
    const st = this.ctx.state;
    (JSON.parse(snap.dyn) as typeof st.officers[number]['dyn'][]).forEach((d, i) => Object.assign(st.officers[i].dyn, d));
    const sc = JSON.parse(snap.script, (_k, v) => (v && typeof v === 'object' && '__u8' in v ? Uint8Array.from(v.__u8) : v));
    Object.assign(this.ctx.vm.state, sc);
    st.progress.money = snap.money;
  }

  /** 1cb6:4b52 */
  private async battle(): Promise<number> {
    const b = this.b;
    b.setup(this.extras.formation);
    // autoPlay (harness/tests): the computer plays the player's units
    if (this.extras.autoPlay) for (let i = 0; i < PLAYER_SLOTS; i++) if (this.units[i].mode === AiMode.Player) this.units[i].mode = AiMode.AttackNearest;
    this.extras.afterSetup?.(this);
    const leader = this.units[0];
    if (leader.status === Status.Field) this.v.centre(leader.x, leader.y);
    this.v.panelUnit = NONE;
    this.v.render();
    await this.ctx.ui.fadeIn(this.ctx.assets.palettes[3]);
    while (b.info.result === 0) {
      if (b.info.turn >= b.info.turnLimit) {
        await this.timeout();
        break;
      }
      b.stepWeather();
      await this.redraw();
      await this.say(S.turnBanner, b.info.turn + 1, dsTable(this.main, S.weatherNames, b.weatherType()));
      // turn events: 84fe(turn+1), else 81fe, while the result is 5/6
      await this.eventLoop({ type: 'turn', turn: b.info.turn + 1 });
      if (b.info.result === 0) await this.turn();
      b.info.turn++;
    }
    await this.finish();
    return b.info.result;
  }

  private async timeout() {
    await this.say(S.timeout);
    let any = false;
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      if (this.units[i].officer === 0 && this.units[i].status !== Status.Empty) {
        await this.leave(i);
        any = true;
      }
    }
    if (!any && this.units[0].status === Status.Field) await this.leave(0);
    this.b.info.result = 3;
  }

  /** 1cb6:4a30 */
  private async finish() {
    const b = this.b;
    if (b.info.result === 2 && b.info.bonus !== 0) {
      await this.say(S.bonusExp, b.info.bonus);
      for (let i = 0; i < PLAYER_SLOTS; i++) {
        const u = this.units[i];
        if (u.status !== Status.Field) continue;
        await this.gainExp(i, b.info.bonus);
      }
    }
    for (const u of this.units) if (u.status === Status.Field) u.status = Status.Reserve;
  }

  /** 0cf5:6f64 with its messages: level-up and newly learned tactics. */
  async gainExp(slot: number, amount: number) {
    const o = this.b.officerOf(this.units[slot]);
    const before = o.level;
    const id = this.ctx.state.officers[this.units[slot].officer].id;
    const k = id & 0xf1ff;
    if ((k >= 0x100 && k <= 0x15f) || o.level >= 99) return;
    let total = o.exp + amount;
    if (total >= 100) {
      const n = Math.trunc(total / 100);
      total -= n * 100;
      o.level = (o.level + n) & 0xff;
    }
    o.exp = total & 0xff;
    await this.levelUpMessages(slot, before);
  }

  async levelUpMessages(slot: number, before: number) {
    const o = this.b.officerOf(this.units[slot]);
    if (o.level === before || slot >= PLAYER_SLOTS) return;
    await this.say(0x1305, this.name(slot), o.level);
    for (let lv = before + 1; lv <= o.level; lv++)
      for (const t of tacticsLearnedAt(o.cls, lv, this.b.learn)) await this.say(0x1326, dsTable(this.main, S.tactics, t, true));
  }

  /** 1cb6:3db2 */
  private async turn() {
    const b = this.b;
    for (let i = 0; i < UNIT_SLOTS; i++) {
      this.units[i].flags &= ~(UnitFlag.Moved | UnitFlag.Acted);
      if (i < PLAYER_SLOTS) this.regen(i);
    }
    await this.eventLoop(null); // 3d6c
    if (b.info.result) return;
    await this.redraw();
    await this.playerPhase();
    if (b.info.result) return;
    await this.computerPhases();
  }

  /** 1cb6:7cc8 */
  regen(slot: number) {
    const u = this.units[slot];
    if (u.officer === 0xffff) {
      // the draws happen for every slot handed in, even empty ones
      this.b.rng.rand(11);
      this.b.rng.rand(5);
      return;
    }
    const o = this.b.officerOf(u);
    const onField = u.status === Status.Field;
    const terrain = onField ? terrainAt(this.b.s, u.x, u.y) : 0;
    const r = regenerate(this.b.rng, o, u.morale, onField, terrain, onField && o.cls === CLASS_BAND ? o.level : undefined);
    if (!onField) return;
    o.hp = r.hp;
    if (r.morale !== null) setMorale(this.b.rng, u, o.lead, r.morale);
    if (r.bandMp)
      for (let d = 0; d < 4; d++) {
        const n = neighbour(this.b.s, u.x, u.y, d);
        if (!n) continue;
        const v = unitAt(this.b.s, n[0], n[1]);
        if (v === NONE) continue;
        const vu = this.units[v];
        vu.mp = Math.min(vu.mp + r.bandMp, maxMp(this.b.officerOf(vu))) & 0xff;
      }
  }

  // ---------------------------------------------------------------- player phase (1cb6:44de)

  private playerControllable(u: Unit): boolean {
    return u.status === Status.Field && u.mode === AiMode.Player && !(u.flags & UnitFlag.Scripted);
  }

  private async playerPhase() {
    const b = this.b;
    const any = this.units.slice(0, PLAYER_SLOTS).some((u) => this.playerControllable(u));
    if (!any) return;
    if (b.info.turn === 0) await this.victoryWindow(true);
    await this.say(S.playerPhase);
    for (const u of this.units) tryCure(b.rng, u, u.officer === 0xffff ? 0 : this.b.officerOf(u).lead);
    await this.redraw();
    for (;;) {
      if (b.info.result) return;
      const act = await this.playerInput();
      if (act === 'end') return;
      await this.redraw();
      await this.victoryCheck();
      if (b.info.result) return;
      const left = this.units
        .slice(0, PLAYER_SLOTS)
        .some((u) => this.playerControllable(u) && !(u.flags & UnitFlag.Acted) && !(u.flags & UnitFlag.Confused));
      if (!left && (await this.ask(dsWord(this.main, S.endTurnAsk)))) return;
    }
  }

  /** Waits for one player action; returns 'end' when the phase should end. */
  private async playerInput(): Promise<'acted' | 'end' | 'none'> {
    const inp = this.ctx.input;
    for (;;) {
      await this.redraw();
      if (this.b.info.result) return 'end';
      this.updateHover();
      this.edgeScroll();
      const key = inp.takeKey();
      if (key) this.keyScroll(key);
      if (key === 'Escape') {
        const r = await this.battleMenu();
        if (r !== 'none') return r;
        continue;
      }
      const c = inp.takeClick();
      if (!c) continue;
      if (c.button === 'right' || (c.x >= 16 && c.x < 80 && c.y >= 48 && c.y < 64)) {
        if (c.button === 'left') this.v.menuPressed = true;
        const r = await this.battleMenu();
        this.v.menuPressed = false;
        if (r !== 'none') return r;
        continue;
      }
      if (this.tabClick(c.x, c.y)) continue;
      const mm = this.v.minimapCell(c.x, c.y);
      if (mm) {
        this.v.centre(mm[0], mm[1]);
        continue;
      }
      const cell = this.v.cellAt(c.x, c.y);
      if (!cell) continue;
      const slot = unitAt(this.b.s, cell[0], cell[1]);
      if (slot === NONE || (!(this.units[slot].flags & UnitFlag.Visible) && slot >= PLAYER_SLOTS)) continue;
      this.sfx(SFX.select);
      this.v.panelUnit = slot;
      await this.blinkUnit(slot);
      const acted = await this.unitCommand(slot);
      this.v.cursor = null;
      this.v.overlay = { lit: null };
      if (acted) return 'acted';
    }
  }

  private tabClick(x: number, y: number): boolean {
    if (y < 73 || y >= 104) return false;
    const tab = x >= 448 && x < 528 ? 0 : x >= 528 && x < 560 ? 1 : x >= 560 && x < 592 ? 2 : -1;
    if (tab < 0) return false;
    this.v.panelTab = tab;
    this.v.panelUnit = NONE;
    return true;
  }

  private updateHover() {
    const inp = this.ctx.input;
    const cell = this.v.cellAt(inp.x, inp.y);
    let slot = NONE;
    if (cell) {
      slot = unitAt(this.b.s, cell[0], cell[1]);
      if (slot !== NONE && !(this.units[slot].flags & UnitFlag.Visible) && slot >= PLAYER_SLOTS) slot = NONE;
    }
    this.v.hover = slot;
    this.v.cursor = cell;
    if (slot !== NONE) this.v.panelUnit = slot;
    else if (cell) this.v.panelUnit = NONE;
  }

  private edgeScroll() {
    const { x, y } = this.ctx.input;
    if ((this.v.tick & 7) !== 0) return;
    const inFrame = x < VIEW_X + VIEW_W * CELL + 8 && y >= VIEW_Y - 8 && y < VIEW_Y + VIEW_H * CELL + 8;
    if (!inFrame) return;
    if (x < VIEW_X) this.v.vx--;
    else if (x >= VIEW_X + VIEW_W * CELL) this.v.vx++;
    if (y < VIEW_Y) this.v.vy--;
    else if (y >= VIEW_Y + VIEW_H * CELL) this.v.vy++;
    this.v.clampView();
  }

  private keyScroll(key: string) {
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const m = d[key];
    if (!m) return;
    this.v.vx += m[0];
    this.v.vy += m[1];
    this.v.clampView();
  }

  private async blinkUnit(slot: number) {
    // 9028: the selected unit blinks three times
    const u = this.units[slot];
    this.v.ensureVisible(u.x, u.y);
    for (let i = 0; i < 3; i++) {
      this.v.hidden.add(slot);
      await this.frames(4);
      this.v.hidden.delete(slot);
      await this.frames(4);
    }
  }

  /** The 기능 menu (2c92 list DS:0x3aa0 at (0, 0x40)). */
  private async battleMenu(): Promise<'end' | 'none'> {
    const items: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) items.push(dsTable(this.main, S.battleMenu, i, true));
    const sel = await this.menu(items, 48, 88);
    if (sel < 0) {
      this.sfx(SFX.cancel);
      return 'none';
    }
    const opts = this.ctx.state.progress;
    switch (sel) {
      case 0:
        return (await this.ask(dsWord(this.main, S.endTurnAsk))) ? 'end' : 'none';
      case 1:
        if (!this.b.formation) {
          if (await this.ask(dsWord(this.main, S.retreatAsk))) {
            this.b.info.result = 1;
            return 'end';
          }
        } else await this.say(S.retreatNo);
        return 'none';
      case 2:
        await this.victoryWindow(false);
        return 'none';
      case 3: {
        const s = await this.menu([0, 1].map((i) => dsTable(this.main, S.closeupMenu, i, true)), 0x60, 0x78 + 40);
        if (s >= 0) opts.battleOptions = (opts.battleOptions & ~0xf0) | (s << 4);
        return 'none';
      }
      case 4: {
        const s = await this.menu([0, 1, 2, 3, 4].map((i) => dsTable(this.main, S.speedMenu, i, true)), 0x60, 0x78 + 40);
        if (s >= 0) opts.battleOptions = (opts.battleOptions & ~0x0f) | s;
        return 'none';
      }
      case 5: {
        // 4214 with the 본다/안 본다 list: 적의 이동 (0x1000)
        const s = await this.menu([0, 1].map((i) => dsTable(this.main, S.closeupMenu, i, true)), 0x60, 0x78 + 40);
        if (s === 0) opts.battleOptions &= ~0x1000;
        else if (s === 1) opts.battleOptions |= 0x1000;
        return 'none';
      }
      case 6:
      case 7: {
        const bit = sel === 6 ? 2 : 1;
        const s = await this.menu([0, 1].map((i) => dsTable(this.main, S.closeupMenu, i, true)), 0x60, 0x78 + 40);
        if (s === 0) opts.flags |= bit;
        else if (s === 1) opts.flags &= ~bit;
        if (bit === 2 && s === 1) this.ctx.sound?.fadeOut?.();
        return 'none';
      }
      case 8:
        if (await this.ask(S.quitAsk)) {
          this.b.info.result = 4;
          return 'end';
        }
        return 'none';
    }
    return 'none';
  }

  /** 1cb6:4316: chapter + battle name, victory conditions, turn count. */
  async victoryWindow(start: boolean) {
    const main = this.main;
    const sc = this.ctx.vm.state;
    const lines: number[] = [];
    const push = (b: Uint8Array) => lines.push(...b, 0x0a);
    push(fmt(dsBytes(main, 0x3c82), chapterName(this), this.v.titleBytes));
    push(dsBytes(main, 0x3c8f));
    const n = sc.objective.indexOf(0);
    push(sc.objective.slice(0, n < 0 ? sc.objective.length : n));
    if (start) push(fmt(dsBytes(main, 0x3cb0), this.b.info.turnLimit));
    else push(fmt(dsBytes(main, 0x3c98), this.b.info.turn + 1, this.b.info.turnLimit));
    lines.pop();
    await this.sayBytes(Uint8Array.from(lines));
  }

  // ---------------------------------------------------------------- unit command (1cb6:a474)

  async unitCommand(slot: number): Promise<boolean> {
    const u = this.units[slot];
    const from: [number, number] = [u.x, u.y];
    if (u.flags & UnitFlag.Visible || slot < PLAYER_SLOTS) {
      if (!(await this.moveUnit(slot))) return false;
    }
    for (;;) {
      const hidden = !(u.flags & UnitFlag.Visible);
      let codes: number[];
      let items: Uint8Array[];
      if (hidden) {
        codes = [8, 9];
        items = [0, 1].map((i) => dsTable(this.main, S.ambushMenu, i, true));
      } else {
        codes = [1, 2, 3, 4];
        items = codes.map((c) => dsTable(this.main, S.commands, c, true));
      }
      const [px, py] = this.v.cellPos(u.x, u.y);
      const sel = await this.menu(items, px + CELL + 8 > 400 ? px - 104 : px + CELL + 8, Math.max(VIEW_Y, py - 16));
      if (sel < 0) {
        // 1cb6:bcb2: back to where the unit stood
        this.sfx(SFX.cancel);
        u.flags &= ~UnitFlag.Moved;
        if (u.x !== from[0] || u.y !== from[1]) this.b.place(slot, null, from[0], from[1]);
        this.v.panelUnit = slot;
        return false;
      }
      let acted = false;
      switch (codes[sel]) {
        case 1:
        case 8:
          acted = await this.attackCommand(slot);
          break;
        case 2:
          acted = await this.tacticCommand(slot);
          break;
        case 3:
          acted = await this.itemCommand(slot);
          break;
        case 4:
          u.flags |= UnitFlag.Acted;
          acted = true;
          break;
        case 9:
          if (await this.ask(S.ambushAsk)) u.flags |= UnitFlag.Visible;
          break;
      }
      if (acted || u.flags & UnitFlag.Acted) {
        u.flags |= UnitFlag.Acted;
        await this.redraw();
        if (this.result === 0) await this.unitEvents(slot);
        return true;
      }
    }
  }

  /** 1cb6:d972: show the movement range and walk to the clicked cell. Returns false on cancel. */
  async moveUnit(slot: number): Promise<boolean> {
    const u = this.units[slot];
    const b = this.b;
    let refusal = 0;
    if (slot >= PLAYER_SLOTS) refusal = S.notOurs;
    else if (u.mode !== AiMode.Player) refusal = S.notControllable;
    else if (u.flags & UnitFlag.Confused) refusal = S.confusedNoCmd;
    else if (u.flags & (UnitFlag.Acted | UnitFlag.Moved)) refusal = u.flags & UnitFlag.Acted ? S.alreadyActed : 0;
    const o = b.officerOf(u);
    const grid = b.s.grid;
    if (u.flags & UnitFlag.Moved && !(u.flags & UnitFlag.Acted) && refusal === 0) return true;
    floodMove(b.s, u, [u.x, u.y], grid, { flags: 0, maxCost: refusal ? movePoints(o, b.s.items) : movePoints(o, b.s.items) });
    this.v.overlay = { lit: grid.map((g) => (g !== NONE ? 1 : 0)) };
    if (refusal) {
      await this.say(refusal);
      // d910: wait for a click with the range shown
      await this.waitClick();
      this.sfx(SFX.error);
      this.v.overlay = { lit: null };
      return false;
    }
    for (;;) {
      const c = await this.waitClick();
      if (c.button === 'right') {
        this.sfx(SFX.cancel);
        this.v.overlay = { lit: null };
        return false;
      }
      const cell = this.v.cellAt(c.x, c.y);
      if (!cell) continue;
      const [x, y] = cell;
      if (x === u.x && y === u.y) {
        this.sfx(SFX.select);
        this.v.overlay = { lit: null };
        return true;
      }
      const g = grid[y * b.width + x];
      if (g !== NONE && unitAt(b.s, x, y) === NONE) {
        const path = walkPath(b.s, u, grid, [x, y], [u.x, u.y], 0xff);
        this.v.overlay = { lit: null };
        await this.animateRoute(slot, path.route);
        u.flags |= UnitFlag.Moved;
        return true;
      }
      this.sfx(SFX.error);
      await this.say(S.notMoveRange);
    }
  }

  async waitClick(): Promise<{ button: 'left' | 'right'; x: number; y: number }> {
    const inp = this.ctx.input;
    for (;;) {
      await this.redraw();
      this.v.cursor = this.v.cellAt(inp.x, inp.y);
      this.edgeScroll();
      const k = inp.takeKey();
      if (k === 'Escape') return { button: 'right', x: inp.x, y: inp.y };
      if (k) this.keyScroll(k);
      const c = inp.takeClick();
      if (c) return c;
    }
  }

  /** Movement animation (1cb6:91ca per step for the player, c3f4 for the computer); no RNG. */
  async animateRoute(slot: number, route: number[]) {
    const u = this.units[slot];
    const speed = (this.ctx.state.progress.battleOptions & 0x0f) + 1; // 1속..5속
    const steps = Math.max(2, 10 - speed * 2);
    for (const d of route) {
      const [dx, dy] = DIRS[d];
      this.face(u, dx);
      if (!this.v.visible(u.x + dx, u.y + dy)) this.v.ensureVisible(u.x + dx, u.y + dy);
      for (let i = 1; i <= steps; i++) {
        this.v.offset.set(slot, [Math.round((dx * CELL * i) / steps), Math.round((dy * CELL * i) / steps)]);
        await this.v.frameStep();
      }
      this.v.offset.delete(slot);
      this.b.s.unitAt[u.y * this.b.width + u.x] = NONE;
      u.x += dx;
      u.y += dy;
      this.b.s.unitAt[u.y * this.b.width + u.x] = slot;
    }
    await this.redraw();
  }

  /** 1cb6:d8c4 / ce01: face the target; flag 0x10 set = facing left (the cells as stored), clear = mirrored. */
  face(u: Unit, dx: number) {
    if (dx === 0) return;
    if (dx < 0) u.flags |= UnitFlag.Facing;
    else u.flags &= ~UnitFlag.Facing;
  }

  /**
   * 1cb6:657e for the player: mark the cells of range shape `range`, wait for a click on a unit of
   * the wanted side. Returns the slot or NONE.
   */
  async pickTarget(slot: number, allies: boolean, range: number): Promise<number> {
    const u = this.units[slot];
    const b = this.b;
    const marks = new Uint8Array(b.width * b.height);
    const cells = rangeCells(b.s, u.x, u.y, range, allies);
    for (const [x, y] of cells) marks[y * b.width + x] = 1;
    const cand = unitsInRange(b.s, u, range, u.x, u.y, allies).filter((t) => allies || this.units[t].flags & UnitFlag.Visible);
    if (cand.length === 0) {
      await this.say(allies ? S.allyNone : S.enemyNone);
      return NONE;
    }
    this.v.overlay = { lit: marks, marks };
    try {
      for (;;) {
        const c = await this.waitClick();
        if (c.button === 'right') {
          this.sfx(SFX.cancel);
          return NONE;
        }
        const cell = this.v.cellAt(c.x, c.y);
        if (!cell) continue;
        const [x, y] = cell;
        if (!marks[y * b.width + x]) {
          this.sfx(SFX.error);
          await this.say(allies ? S.outOfRange : S.outOfAttackRange);
          continue;
        }
        const t = unitAt(b.s, x, y);
        if (t === NONE) continue;
        if (sideOf(t) !== sideOf(slot) && allies) {
          this.sfx(SFX.error);
          await this.say(S.isEnemy);
          continue;
        }
        if (sideOf(t) === sideOf(slot) && !allies) {
          this.sfx(SFX.error);
          await this.say(S.isAlly);
          continue;
        }
        this.sfx(SFX.select);
        return t;
      }
    } finally {
      this.v.overlay = { lit: null };
    }
  }

  private async attackCommand(slot: number): Promise<boolean> {
    const o = this.b.officerOf(this.units[slot]);
    const range = CLASS_RANGE[o.cls];
    if (range === NONE) return false;
    const t = await this.pickTarget(slot, false, range);
    if (t === NONE) return false;
    await this.doAttack(slot, t);
    return true;
  }

  /** cd4a/d862 + e91a: a physical attack with its display and departures. */
  async doAttack(a: number, d: number) {
    const A = this.units[a];
    const D = this.units[d];
    this.face(A, D.x - A.x);
    this.face(D, A.x - D.x);
    this.v.ensureVisible(D.x, D.y);
    const lvA = this.b.officerOf(A).level;
    const lvD = this.b.officerOf(D).level;
    const before = this.snapshotHp([a, d]);
    const res = attack(this.b.s, a, d);
    await this.showHit(res, before);
    await this.levelUpMessages(a, lvA);
    if (res.counter) await this.levelUpMessages(d, lvD);
    await this.leaveAll(res.left);
  }

  private snapshotHp(slots: number[]): Map<number, { hp: number; morale: number }> {
    const m = new Map<number, { hp: number; morale: number }>();
    for (const s of slots) m.set(s, { hp: this.b.officerOf(this.units[s]).hp, morale: this.units[s].morale });
    return m;
  }

  /** e91a's display part: close-up scene (when on) or the map blink, then the counterattack. */
  async showHit(h: HitResult, before: Map<number, { hp: number; morale: number }>, kind = 1) {
    const prevD = before.get(h.defender) ?? { hp: this.b.officerOf(this.units[h.defender]).hp + h.damage, morale: this.units[h.defender].morale + h.moraleLoss };
    if (this.b.closeupOn) {
      await closeupScene(this, h, prevD, kind);
    } else {
      this.v.ensureVisible(this.units[h.defender].x, this.units[h.defender].y);
      this.sfx(SFX.hit);
      for (let i = 0; i < 3; i++) {
        this.v.hidden.add(h.defender);
        await this.frames(4);
        this.v.hidden.delete(h.defender);
        await this.frames(4);
      }
      if (kind === 2 && h.damage === 0) await this.say(0x4f45, this.name(h.attacker));
    }
    if (h.counter) {
      await this.say(h.attacker < PLAYER_SLOTS ? 0x4f66 : 0x4f5b);
      const hpA = this.b.officerOf(this.units[h.attacker]).hp + h.counter.damage;
      const m = new Map(before);
      m.set(h.attacker, { hp: hpA, morale: this.units[h.attacker].morale });
      await this.showHit(h.counter, m);
    }
  }

  // ---------------------------------------------------------------- tactics (1cb6:b2d6)

  private async tacticCommand(slot: number): Promise<boolean> {
    const u = this.units[slot];
    const o = this.b.officerOf(u);
    const list = castableTactics(o, u.mp, this.b.learn).filter((t) => !(t < 5 && this.b.weatherType() === RAIN));
    if (list.length === 0) {
      await this.say(S.noTactics);
      return false;
    }
    for (;;) {
      const items = list.map((t) => {
        const n = dsTable(this.main, S.tactics, t, true);
        const pad = Math.max(1, 10 - n.length);
        return new Uint8Array([...n, ...new Array(pad).fill(0x20), ...euc(String(TACTIC_MP[t]).padStart(2, ' '))]);
      });
      const [px, py] = this.v.cellPos(u.x, u.y);
      const sel = await this.menu(items, px > 260 ? px - 168 : px + CELL + 8, Math.max(VIEW_Y, py - 32));
      if (sel < 0) return false;
      if (await this.castFlow(slot, list[sel], true)) return true;
    }
  }

  /**
   * b2d6: target choice and effects of tactic t. `player` selects the target with the cursor;
   * otherwise the AI's choice (DS:0xe51c) is used.
   */
  async castFlow(slot: number, t: number, player: boolean, aiTarget = NONE): Promise<boolean> {
    const u = this.units[slot];
    const b = this.b;
    if (TACTIC_MP[t] > u.mp) {
      if (player) await this.say(S.mpShort);
      return false;
    }
    if (!player) await this.say(S.tacticUsed, this.name(slot), dsTable(this.main, S.tactics, t, true));
    let target = aiTarget;
    const p = TACTIC_POWER[t];
    if (t <= 29) {
      const allies = t >= 21;
      if (t <= 14 && Math.trunc(t / 5) === 0 && b.weatherType() === RAIN) {
        await this.say(S.rainNoFire);
        return false;
      }
      if (player) {
        target = await this.pickTarget(slot, allies, p | 0x80);
        if (target === NONE) return false;
        if (t <= 14) {
          const tu = this.units[target];
          if (!tacticTerrainOk(Math.trunc(t / 5), terrainAt(b.s, tu.x, tu.y))) return false;
        }
      }
    }
    const watch = t <= 29 && target !== NONE ? [slot, target] : [slot];
    if (t >= 30) for (const s of unitsInRange(b.s, u, ((t - 30) % 3) | 0x80, u.x, u.y, true)) watch.push(s);
    const before = this.snapshotHp(watch);
    const lv = b.officerOf(u).level;
    const res = castTactic(b.s, slot, t, target);
    if (!res.ok) {
      if (t >= 30) await this.say(S.noAllyInRange);
      return false;
    }
    await this.showCast(slot, t, res, before);
    await this.levelUpMessages(slot, lv);
    await this.leaveAll(res.left);
    return true;
  }

  private async showCast(slot: number, t: number, res: CastResult, before: Map<number, { hp: number; morale: number }>) {
    for (const h of res.hits) {
      await this.showHit(h, before, 2);
      if (h.damage === 0 && this.b.closeupOn) await this.say(0x4f45, this.name(slot));
    }
    for (const c of res.confused) await this.say(S.confused, this.name(c));
    if (t >= 15 && t <= 17 && res.confused.length === 0) await this.say(0x4f45, this.name(slot));
    if (t >= 18 && t <= 20) {
      const tgt = [...before.keys()].find((k) => k !== slot);
      if (tgt !== undefined && this.units[tgt].morale !== before.get(tgt)!.morale) await this.say(S.moraleDown, this.name(tgt));
      else await this.say(0x4f45, this.name(slot));
    }
    for (const h of res.healed) {
      const u = this.units[h.slot];
      this.v.ensureVisible(u.x, u.y);
      for (let i = 0; i < 2; i++) {
        this.v.hidden.add(h.slot);
        await this.frames(3);
        this.v.hidden.delete(h.slot);
        await this.frames(3);
      }
    }
    void t;
  }

  // ---------------------------------------------------------------- items (1cb6:a8e2 / ab86)

  private async itemCommand(slot: number): Promise<boolean> {
    const u = this.units[slot];
    const so = this.b.stateOfficer(u);
    const held = so.dyn.items.map((id, i) => ({ id, i })).filter((e) => e.id !== 0xff);
    if (held.length === 0) {
      await this.say(S.noItems);
      return false;
    }
    for (;;) {
      if (u.flags & UnitFlag.Acted) return true;
      const ops = [0, 1, 2, 3].map((i) => dsTable(this.main, S.itemOps, i, true));
      const op = await this.menu(ops, 0x60, 0x78 + 40);
      if (op < 0) return false;
      for (;;) {
        const now = so.dyn.items.map((id, i) => ({ id, i })).filter((e) => e.id !== 0xff);
        if (now.length === 0) break;
        const names = now.map((e) => euc(this.ctx.state.items[e.id]?.name ?? '?'));
        const k = await this.menu(names, 0x80, 0x80 + 40);
        if (k < 0) break;
        const it = now[k];
        if (op === 0) {
          if (await this.useItem(slot, it.id, it.i)) u.flags |= UnitFlag.Acted;
        } else if (op === 1) {
          const t = await this.pickTarget(slot, true, 0);
          if (t !== NONE && t !== slot) {
            const to = this.b.stateOfficer(this.units[t]).dyn.items;
            const free = to.indexOf(0xff);
            if (free < 0) await this.say(S.giveFull);
            else {
              to[free] = it.id;
              so.dyn.items[it.i] = 0xff;
              await this.say(S.gave, euc(this.ctx.state.items[it.id]?.name ?? ''));
              u.flags |= UnitFlag.Acted;
            }
          }
        } else if (op === 2) {
          so.dyn.items[it.i] = 0xff;
          await this.say(S.dropped, euc(this.ctx.state.items[it.id]?.name ?? ''));
          u.flags |= UnitFlag.Acted;
        } else {
          await this.sayBytes(euc(this.ctx.state.items[it.id]?.name ?? ''));
        }
        if (u.flags & UnitFlag.Acted) return true;
      }
    }
  }

  /**
   * ab86: item effects in battle. Returns true when the item was used up. `target` skips the
   * target pick (the grinding simulator's player, as castFlow's aiTarget does for tactics).
   */
  async useItem(slot: number, id: number, index: number, target = NONE): Promise<boolean> {
    const b = this.b;
    const u = this.units[slot];
    const o = b.officerOf(u);
    const so = b.stateOfficer(u);
    const consume = () => {
      so.dyn.items[index] = 0xff;
    };
    const name = euc(this.ctx.state.items[id]?.name ?? '');
    const pick = (ally: boolean, range: number) => (target !== NONE ? Promise.resolve(target) : this.pickTarget(slot, ally, range));
    if (id >= 0x13 && id <= 0x1a) {
      // promotion (docs/BATTLE.md, read from ab86): from class FROM[k] at level >= LV[k] -> class+1
      const k = id - 0x13;
      if (o.cls !== [0, 1, 3, 4, 6, 7, 9, 10][k] || o.level < [15, 30, 15, 30, 15, 30, 15, 30][k]) {
        await this.say(S.notUsable);
        return false;
      }
      await this.say(S.usedItem, name);
      o.cls += 1;
      o.hp = Math.min(o.hp, maxHp(o));
      consume();
      return true;
    }
    if (id <= 0x02 || (id >= 0x10 && id <= 0x12)) {
      // class change to [15,18,12,3,6,0][...]: refused for 유비, the same class, the same class line,
      // or a move type that cannot stand on the current terrain
      const to = [15, 18, 12, 3, 6, 0][id <= 0x02 ? id : id - 0x10 + 3];
      const refused =
        u.officer === 0 || o.cls === to || Math.trunc(o.cls / 3) * 3 === to || moveCost(CLASS_MOVE_TYPE[to], terrainAt(b.s, u.x, u.y)) === 0xff;
      if (refused) {
        await this.say(S.notUsable);
        return false;
      }
      await this.say(S.usedItem, name);
      o.cls = to;
      o.hp = Math.min(o.hp, maxHp(o));
      consume();
      return true;
    }
    if (id >= 0x22 && id <= 0x2a) {
      // bombs: element 2 - (id-0x22)/3, power (id-0x22)%3, e91a kind 3
      const element = 2 - Math.trunc((id - 0x22) / 3);
      const power = (id - 0x22) % 3;
      if (element === 0 && b.weatherType() === RAIN) {
        await this.say(S.rainNoFire);
        return false;
      }
      const t = await pick(false, power | 0x80);
      if (t === NONE || sideOf(t) === sideOf(slot)) return false;
      const tu = this.units[t];
      if (!tacticTerrainOk(element, terrainAt(b.s, tu.x, tu.y))) return false;
      await this.say(S.usedItem, name);
      const before = this.snapshotHp([slot, t]);
      const h = fight(b.s, slot, t, 3, (element << 4) | power);
      await this.showHit(h, before, 3);
      consume();
      await this.leaveAll(h.left);
      return true;
    }
    if ((id >= 0x1b && id <= 0x20) || (id >= 0x34 && id <= 0x36)) {
      const power = id >= 0x34 ? id - 0x34 : id % 3;
      const kind = id >= 0x34 ? 3 : id >= 0x1e ? 1 : 2;
      const t = await pick(true, power | 0x80);
      if (t === NONE) return false;
      const tu = this.units[t];
      const to = b.officerOf(tu);
      const useful = !(kind === 1 && to.hp === maxHp(to)) && !(kind === 2 && tu.morale === 100 && !(tu.flags & UnitFlag.Confused)) &&
        !(kind === 3 && to.hp === maxHp(to) && tu.morale === 100 && !(tu.flags & UnitFlag.Confused));
      if (!useful) return false;
      await this.say(S.usedItem, name);
      healItem(this, t, power, kind);
      consume();
      return true;
    }
    if (id === 0x21) {
      // 폭탄 (b029): one enemy in range 0x81, fixed damage, no exp (bombItem)
      await this.say(S.bombAttack);
      const t = await pick(false, 0x81);
      if (t === NONE || sideOf(t) === sideOf(slot)) return false;
      await this.say(S.bombThrow);
      const tu = this.units[t];
      const r = bombItem(b.s, t);
      this.v.ensureVisible(tu.x, tu.y);
      this.sfx(SFX.hit);
      for (let i = 0; i < 2; i++) {
        this.v.hidden.add(t);
        await this.frames(4);
        this.v.hidden.delete(t);
        await this.frames(4);
      }
      consume();
      for (const v of r.left) await this.leave(v);
      return true;
    }
    if (id >= 0x2e && id <= 0x33) {
      // area heals (ab86 -> baf6, no caster): troops for 0x2e..0x30, morale for 0x31..0x33, area and
      // power (id-0x2e)%3 around the user; kept when no ally is in the area
      const watch = [slot, ...unitsInRange(b.s, u, ((id - 0x2e) % 3) | 0x80, u.x, u.y, true)];
      const before = this.snapshotHp(watch);
      const res = areaHealItem(b.s, slot, id);
      if (!res.ok) {
        await this.say(S.noAllyInRange);
        return false;
      }
      consume();
      await this.showCast(slot, 30, res, before);
      return true;
    }
    if (id >= 0x2b && id <= 0x2d) {
      await this.say(S.confuseEnemy);
      const t = await pick(false, 0x80);
      if (t === NONE) return false;
      if (this.units[t].flags & UnitFlag.Confused) {
        await this.say(S.alreadyConfused);
        return false;
      }
      const hitList = [t];
      if (id === 0x2d)
        for (let d = 0; d < 4; d++) {
          const n = neighbour(b.s, this.units[t].x, this.units[t].y, d);
          if (!n) continue;
          const v = unitAt(b.s, n[0], n[1]);
          if (v !== NONE && sideOf(v) !== sideOf(slot)) hitList.push(v);
        }
      consume();
      for (const v of hitList) {
        this.units[v].flags |= UnitFlag.Confused;
        await this.say(S.confused, this.name(v));
        if (mustGo(this, v)) await this.leave(v);
      }
      return true;
    }
    void o;
    await this.say(S.notUsable);
    return false;
  }

  // ---------------------------------------------------------------- computer phases (1cb6:3f32)

  private async computerPhases() {
    const b = this.b;
    for (let pass = 0; pass < 2 && b.info.result === 0; pass++) {
      const player = pass === 0;
      if (!player) {
        await this.say(S.enemyPhase);
        for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) {
          this.regen(i);
          const u = this.units[i];
          tryCure(b.rng, u, u.officer === 0xffff ? 0 : b.officerOf(u).lead);
        }
      }
      const order = actionOrder(b.s, player);
      for (const slot of order) {
        if (b.info.result) return;
        const u = this.units[slot];
        if (u.mode === AiMode.Player) continue;
        if (u.status !== Status.Field) continue;
        await this.aiUnit(slot);
        if (b.info.result) return;
        if (this.units[slot].status === Status.Field) await this.unitEvents(slot);
        await this.victoryCheck();
      }
    }
  }

  /** ce50: one computer unit (plan, move, attack or tactic). */
  async aiUnit(slot: number) {
    const b = this.b;
    const u = this.units[slot];
    const watch = !(b.options & 0x1000) || slot < PLAYER_SLOTS;
    const from: [number, number] = [u.x, u.y];
    const plan = planUnit(b.s, u);
    if (!plan) return;
    // c3f4 animates the walk; the RNG is not touched (BATTLE.md, "Verification")
    const route = this.routeTo(u, from, plan);
    applyMove(b.s, u, plan);
    const to: [number, number] = [u.x, u.y];
    if (watch && (to[0] !== from[0] || to[1] !== from[1]) && route.length) {
      this.b.place(slot, null, from[0], from[1]);
      this.v.ensureVisible(from[0], from[1]);
      await this.animateRoute(slot, route);
      if (u.x !== to[0] || u.y !== to[1]) this.b.place(slot, null, to[0], to[1]);
    }
    if (u.flags & UnitFlag.Scripted || u.mode === AiMode.MoveNoAttack || u.flags & UnitFlag.Confused) return;
    if (b.s.ai.tactic === NONE) {
      const t = attackTargetAfterMove(b.s, u);
      if (t !== NONE) {
        this.v.ensureVisible(u.x, u.y);
        await this.doAttack(slot, t);
      }
    } else {
      await this.castFlow(slot, b.s.ai.tactic, false, b.s.ai.target);
    }
    u.flags |= UnitFlag.Acted;
  }

  /** The walk applyMove makes (Plan.route), for the animation. */
  private routeTo(_u: Unit, _from: [number, number], plan: Plan): number[] {
    return plan.route;
  }

}

// ---------------------------------------------------------------- helpers

function mustGo(scene: BattleScene, slot: number): boolean {
  const u = scene.units[slot];
  const o = scene.b.officerOf(u);
  return o.hp === 0 || ((u.flags & UnitFlag.Confused) !== 0 && u.morale === 0);
}

function chapterName(scene: BattleScene): Uint8Array {
  // 1cb6:4372: near pointer table DS:0x3c78 indexed by the progress chapter (0cf5:77da)
  return dsTable(scene.main, 0x3c78, scene.ctx.state.progress.chapter);
}

/** b8c0 without a caster (items): single heal of `kind` (1 troops, 2 morale, 3 both) at `power`. */
function healItem(scene: BattleScene, slot: number, power: number, kind: number) {
  const b = scene.b;
  const u = scene.units[slot];
  const o = b.officerOf(u);
  const h = healAmounts(b.rng, power, kind, null, o, u.morale);
  if (kind & 1) o.hp = Math.min(o.hp + h.hp, maxHp(o));
  if (kind & 2) setMorale(b.rng, u, o.lead, u.morale + h.morale);
}
