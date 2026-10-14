// Battle state for native mode: the unit table, the map and the shared combat/AI state, built
// from the script's deployment records the way 1cb6:3ab6 / 3926 do. Rules live in
// web/src/engine/battle/*; this file only glues them to GameState and the script context.

import type { GameState, Officer as StateOfficer } from '../../engine/state';
import type { ScriptState } from '../../engine/script';
import type { AiState } from '../../engine/battle/ai';
import type { CombatState } from '../../engine/battle/combat';
import { rebuildUnitMap } from '../../engine/battle/hex';
import { BattleMap, parseBattleMap } from '../../engine/battle/map';
import { ItemLookup, Rng, maxHp, maxMp, nextWeather } from '../../engine/battle/rules';
import {
  AiMode,
  CLASS_MOVE_TYPE,
  NONE,
  ORDER_TO_MODE,
  Officer,
  PLAYER_SLOTS,
  Status,
  UNIT_SLOTS,
  Unit,
  UnitFlag,
  WEATHER_TYPE,
  loadLearnTable,
  moveCost,
  newUnit,
} from '../../engine/battle/types';

export type BattleField = AiState & CombatState;

/** Battle state block (DS:0xe196). */
export interface BattleInfo {
  map: number;
  result: number; // +1: 0 running, 1 retry (총퇴각), 2 won, 3 lost, 4 quit
  turn: number; // +2, 0-based
  turnLimit: number; // +3
  weather: number; // +4
  bonus: number; // +0x24 victory bonus experience
}

/** Engine Officer view of a GameState officer (reads and writes go to the officer record). */
export function officerView(o: StateOfficer): Officer {
  return {
    get lead() {
      return o.leadership;
    },
    set lead(v: number) {
      o.leadership = v;
    },
    get force() {
      return o.strength;
    },
    set force(v: number) {
      o.strength = v;
    },
    get intel() {
      return o.intelligence;
    },
    set intel(v: number) {
      o.intelligence = v;
    },
    get hp() {
      return o.dyn.troops;
    },
    set hp(v: number) {
      o.dyn.troops = v;
    },
    get cls() {
      return o.dyn.cls;
    },
    set cls(v: number) {
      o.dyn.cls = v;
    },
    get level() {
      return o.dyn.level;
    },
    set level(v: number) {
      o.dyn.level = v;
    },
    get exp() {
      return o.dyn.exp;
    },
    set exp(v: number) {
      o.dyn.exp = v;
    },
    get items() {
      return o.dyn.items;
    },
  };
}

/** Faction bits of officer +0x1c (2cb6:0ef6); 0 = the player's own officers. */
export function factionOf(o: StateOfficer): number {
  return o.dyn.flags & 0x1f;
}

/** Officer +0x1e setter (0cf5:6f42): troops are clamped to the class maximum. */
export function setTroops(o: Officer, v: number): void {
  o.hp = Math.max(0, Math.min(v, maxHp(o)));
}

export class Battle {
  readonly info: BattleInfo;
  readonly map: BattleMap;
  readonly s: BattleField;
  readonly officers: Officer[];
  readonly learn: Uint8Array;
  /** Map-change log of MAP_CHIP (DS:0xe5aa); kept so a reload can replay it. */
  readonly chipLog: { x: number; y: number; kind: number; terrain: number }[] = [];

  constructor(
    readonly state: GameState,
    readonly script: ScriptState,
    hexzmap: Uint8Array[],
    main: Uint8Array,
    readonly rng: Rng,
    mapNo: number,
  ) {
    this.map = parseBattleMap(hexzmap[mapNo]);
    this.map = { ...this.map, chips: this.map.chips.slice(), terrain: this.map.terrain.slice() };
    this.info = { map: mapNo, result: 0, turn: 0, turnLimit: 0, weather: 1, bonus: 0 };
    this.officers = state.officers.map(officerView);
    this.learn = loadLearnTable(main);
    const items: ItemLookup = (id) => {
      const it = state.items[id];
      return it ? { value: it.power, type: it.type } : undefined;
    };
    const n = this.map.width * this.map.height;
    this.s = {
      width: this.map.width,
      height: this.map.height,
      terrain: this.map.terrain,
      unitAt: new Uint8Array(n).fill(NONE),
      units: Array.from({ length: UNIT_SLOTS }, (_, i) => newUnit(i)),
      officers: this.officers,
      rng,
      items,
      weather: 1,
      // archer volleys depend on the close-up option at the time of the attack (combat.ts fight())
      get closeup() {
        return (state.progress.battleOptions & 0xf0) === 0;
      },
      officerIds: state.officers.map((o) => o.id),
      learn: this.learn,
      grid: new Uint8Array(n).fill(NONE),
      foeMap: new Uint8Array(n).fill(NONE),
      influence: new Uint8Array(n),
      castable: [],
      ai: { target: NONE, dest: null, tactic: NONE, tacticPick: NONE, physPick: NONE, tacticTarget: NONE, score: 0 },
    };
  }

  get units(): Unit[] {
    return this.s.units;
  }

  get width(): number {
    return this.map.width;
  }

  get height(): number {
    return this.map.height;
  }

  officerOf(u: Unit): Officer {
    return this.officers[u.officer];
  }

  stateOfficer(u: Unit): StateOfficer {
    return this.state.officers[u.officer];
  }

  /** Battle options word (DS:0x7a84). */
  get options(): number {
    return this.state.progress.battleOptions;
  }

  /** 1cb6:defe: close-up scenes are shown when the option's high nibble is 0 ("본다"). */
  get closeupOn(): boolean {
    return (this.options & 0xf0) === 0;
  }

  weatherType(): number {
    return WEATHER_TYPE[this.info.weather];
  }

  stepWeather(): void {
    this.info.weather = nextWeather(this.rng, this.info.weather);
    this.s.weather = this.info.weather;
  }

  slotOfOfficer(officer: number): number {
    for (const u of this.units) if (u.officer === officer && u.status !== Status.Empty) return u.slot;
    return NONE;
  }

  onField(slot: number): boolean {
    return slot !== NONE && this.units[slot].status === Status.Field;
  }

  /** 1cb6:8264's flag handling only; the sprite itself is looked up by the view. */
  private resetUnit(u: Unit, officer: number): void {
    // 837c: officer, status 1 (reserve), MP from 9184
    u.officer = officer;
    u.status = Status.Reserve;
    u.mp = maxMp(this.officers[officer]) & 0xff;
  }

  /** 8222: empty slot. */
  clearSlot(slot: number): void {
    Object.assign(this.units[slot], newUnit(slot), { officer: 0xffff, x: NONE, y: NONE, mode: 0, flags: UnitFlag.Visible, status: Status.Empty });
    this.units[slot].morale = 100;
  }

  /**
   * 1cb6:8422: puts a reserve unit on the field at (x,y), or the nearest free cell its move type can
   * stand on (7b08's search, simplified to a breadth-first ring search; the original recurses N,E,S,W).
   */
  place(slot: number, facingLeft: boolean | null, x: number, y: number): boolean {
    const u = this.units[slot];
    if (x >= this.width || y >= this.height) return false;
    if (u.status === Status.Reserve) {
      const mt = CLASS_MOVE_TYPE[this.officerOf(u).cls];
      const free = (cx: number, cy: number) =>
        cx >= 0 && cy >= 0 && cx < this.width && cy < this.height && this.s.unitAt[cy * this.width + cx] === NONE &&
        moveCost(mt, this.map.terrain[cy * this.width + cx]) !== 0xff;
      let pos: [number, number] | null = free(x, y) ? [x, y] : null;
      for (let r = 1; !pos && r < Math.max(this.width, this.height); r++)
        for (let dy = -r; dy <= r && !pos; dy++)
          for (let dx = -r; dx <= r && !pos; dx++)
            if (Math.abs(dx) + Math.abs(dy) === r && free(x + dx, y + dy)) pos = [x + dx, y + dy];
      if (!pos) return false;
      [x, y] = pos;
      u.status = Status.Field;
      // 8d74: flag 0x10 = facing left; the record's bit 2 clear means facing left (1cb6:39b0)
      if (facingLeft !== null) {
        if (facingLeft) u.flags |= UnitFlag.Facing;
        else u.flags &= ~UnitFlag.Facing;
      }
    } else if (u.status === Status.Field) {
      this.s.unitAt[u.y * this.width + u.x] = NONE;
    }
    u.x = x;
    u.y = y;
    this.s.unitAt[y * this.width + x] = slot;
    return true;
  }

  /** Is the formation (출진) path active for this battle (2cb6:4e60 = ctx+0x1cb & 1)? */
  get formation(): boolean {
    return (this.script.hexFlag & 1) !== 0;
  }

  /**
   * 1cb6:3ab6 + 3926: builds the 45 unit slots from the deployment records. With the formation
   * flag the player units chosen beforehand (`preset`, slot order) are kept and placed at their
   * own record or at the first free placeholder record (officer >= 0x400).
   */
  setup(preset?: number[]): void {
    const sc = this.script;
    this.info.result = 0;
    this.info.bonus = 0;
    this.info.turn = 0;
    this.info.weather = 1;
    this.s.weather = 1;
    for (let i = 0; i < UNIT_SLOTS; i++) this.clearSlot(i);
    this.info.turnLimit = sc.battleB;
    let ps = 0;
    let es = PLAYER_SLOTS;
    for (let r = 0; r < UNIT_SLOTS; r++) {
      const d = sc.units[r];
      if (!d || d.officer === 0xffff || d.officer === 0x400) continue;
      if (d.officer >= this.officers.length) continue;
      if (!(d.flags & 1)) {
        if (this.formation) continue;
        if (ps >= PLAYER_SLOTS) continue;
        const slot = ps++;
        this.resetUnit(this.units[slot], d.officer);
        if (!(d.flags & 2)) this.place(slot, !(d.flags & 4), d.x, d.y);
        const o = this.officers[d.officer];
        this.units[slot].mp = maxMp(o) & 0xff;
        setTroops(o, maxHp(o));
      } else {
        if (es >= UNIT_SLOTS) continue;
        const slot = es++;
        const u = this.units[slot];
        this.resetUnit(u, d.officer);
        // 81c4: class = record +9, level = record +0xa, then full MP/troops, morale 100, visible
        const o = this.officers[d.officer];
        o.cls = d.a;
        o.level = d.b;
        u.flags &= UnitFlag.Facing;
        u.mp = maxMp(o) & 0xff;
        setTroops(o, maxHp(o));
        u.morale = 100;
        u.flags |= UnitFlag.Visible;
        if (!(d.flags & 2)) this.place(slot, !(d.flags & 4), d.x, d.y);
        // 2cb4:031a: AI order, only for non-player factions
        if (factionOf(this.state.officers[d.officer]) !== 0) {
          u.flags &= ~UnitFlag.Scripted;
          u.mode = ORDER_TO_MODE[d.kind] ?? AiMode.AttackNearest;
        }
        if (d.kind === 3 || d.kind === 5) {
          u.target = NONE;
          for (let k = 0; k < es - 1; k++) if (this.units[k].officer === d.param && this.units[k].status !== Status.Empty) u.target = k;
        } else if (d.kind === 4 || d.kind === 6) {
          u.tx = d.param & 0xff;
          u.ty = d.param >> 8;
        }
      }
    }
    if (this.formation && preset) {
      preset.slice(0, PLAYER_SLOTS).forEach((officer, slot) => {
        if (officer >= this.officers.length) return;
        this.resetUnit(this.units[slot], officer);
        const o = this.officers[officer];
        setTroops(o, maxHp(o));
      });
      for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
        const u = this.units[slot];
        if (u.status !== Status.Reserve) continue;
        u.flags &= ~0xc6;
        let rec = sc.units.slice(0, PLAYER_SLOTS).find((d) => d.officer === u.officer);
        if (!rec) {
          rec = sc.units.slice(0, PLAYER_SLOTS).find((d) => d.officer !== 0xffff && d.officer >= 0x400);
          if (rec) rec.officer = u.officer;
        }
        if (rec) this.place(slot, !(rec.flags & 4), rec.x, rec.y);
      }
    }
    // 3ab6: clear flag 4; player slots get mode 7, or 1 for officers of another faction (allies)
    for (let i = 0; i < UNIT_SLOTS; i++) {
      const u = this.units[i];
      u.flags &= ~UnitFlag.Scripted;
      if (i < PLAYER_SLOTS && u.officer !== 0xffff) u.mode = factionOf(this.state.officers[u.officer]) === 0 ? AiMode.Player : AiMode.AttackNearest;
    }
    rebuildUnitMap(this.s);
  }

  /** Reserve unit of an officer enters the field at its deployment record (REINFORCE, 2cb4:007e). */
  reinforce(officer: number): number {
    const slot = this.slotOfOfficer(officer);
    if (slot === NONE || this.units[slot].status !== Status.Reserve) return NONE;
    const rec = this.script.units.find((d) => d.officer === officer);
    if (!rec) return NONE;
    return this.place(slot, !(rec.flags & 4), rec.x, rec.y) ? slot : NONE;
  }

  /** No enemy left on the field (4abc). */
  noEnemiesLeft(): boolean {
    for (let i = PLAYER_SLOTS; i < UNIT_SLOTS; i++) if (this.units[i].status === Status.Field) return false;
    return true;
  }
}
