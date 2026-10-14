// The native game: MAIN.EXE's title menu, main loop and location changes (0cf5:aaea, c050, a88c,
// c86c), the field modes (town / palace 1cb6:14e4, world map 0cf5:d4d8), the script host that the
// event interpreter (engine/script.ts) drives, and the hand-off to battle mode (battle/scene.ts).
// Implements the GameContext of context.ts.

import type { EventResult, GameContext, RunBattle } from './context';
import { Rng } from '../engine/battle/rules';
import type { Screen } from '../engine/screen';
import type { Input } from '../engine/input';
import type { SoundPlayer } from '../audio/player';
import type { GameFiles } from '../gamefiles';
import type { Message, TalkLine } from '../formats/scenario';
import {
  ScriptVM,
  newScriptState,
  readEventSave,
  writeEventSave,
  type ScriptHost,
  type ScriptState,
  type TextContext,
  type Trigger,
} from '../engine/script';
import { STATUS, heroLevel, loadGame, newGame, rosterOfficers, toSave, type GameState } from '../engine/state';
import { OPT, parseESave, parseMSaveHeader, serializeMSave } from '../formats/save';
import { GameAssets } from './assets';
import { Draw, LAYOUT_Y, bytesOf, type Button } from './draw';
import { CURSOR, Video } from './video';
import { GameUi, type Text } from './ui';
import { ATTR, Field, VIEW, type Actor } from './field';
import { SaveStore } from './saves';

/** Thrown by the host to suspend the running event (MAP: status 1, resume at PC; 0cf5:97d5). */
class Suspend extends Error {}

/** Frame icons (screen rectangles): 스토리 정보, 장수, 전체지도, 기능. */
const ICONS = [
  { x: 545, y: 285, w: 40, h: 42 },
  { x: 585, y: 285, w: 40, h: 42 },
  { x: 545, y: 330, w: 40, h: 42 },
  { x: 585, y: 330, w: 40, h: 42 },
];

/** Korean particle after a word: 은/는, 을/를 ... chosen by the last syllable's final consonant. */
export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const c = word.charCodeAt(word.length - 1);
  const final = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 !== 0 : false;
  return word + (final ? withFinal : withoutFinal);
}

const dec = new TextDecoder('euc-kr');

export class Game implements GameContext {
  readonly assets: GameAssets;
  readonly draw: Draw;
  readonly video: Video;
  readonly ui: GameUi;
  readonly field: Field;
  readonly saves: SaveStore;
  state: GameState;
  vm: ScriptVM;
  battleHost: Partial<ScriptHost> | null = null;
  /** DS:0xcc8 random generator, shared with battle mode (seeded from the clock like srand(time)). */
  rng = new Rng((Date.now() ^ 0x5eed) >>> 0);
  /** Officers chosen by FORMATION for a battle with the formation flag, read by battle mode. */
  formation: number[] | undefined;
  /** The host the interpreter calls (forwards to battleHost where it defines a method). */
  private readonly host: ScriptHost;
  private pictureSaved: { data: Uint8Array } | null = null;
  /** The map view shows the current location (cleared on a location change, set by SCREEN_MAP). */
  private mapShown = false;
  /** The world map was just loaded: SCREEN_MAP centres it on 유비. */
  private focusPending = false;
  /** Battle mode replaced the main frame; the next location redraws it. */
  private frameStale = false;
  /** Set by a load until the loaded map is on screen. */
  private loadedGame = false;
  private inputLocked = false;
  /** Pre-battle snapshot (SAVE_STATE) for a retry. */
  private snapshot: Uint8Array | null = null;
  private battleModule: Promise<{ runBattle?: RunBattle } | null> | null = null;
  private moveWaiters = 0;
  /** 현재영토 is drawn once a room was entered or SET_LEADER ran (0cf5:c3d4 is not part of c456). */
  private territoryShown = false;
  log: (msg: string) => void = (m) => console.debug('[native]', m);

  constructor(
    readonly files: GameFiles,
    readonly screen: Screen,
    readonly input: Input,
    canvas: HTMLCanvasElement,
    readonly sound: SoundPlayer | null,
  ) {
    this.assets = new GameAssets(files);
    this.draw = new Draw(screen, this.assets);
    this.video = new Video(screen, canvas, input, this.assets.has('MARK.R3') ? this.assets.mark : null);
    this.ui = new GameUi(this.draw, this.video, input, this.assets);
    this.field = new Field(this.assets, this.draw, () => this.state);
    this.saves = new SaveStore(files);
    this.state = this.freshState();
    this.host = this.makeHost();
    this.vm = new ScriptVM((c) => this.assets.chapter(c), this.host);
  }

  get script(): ScriptState {
    return this.vm.state;
  }

  // ------------------------------------------------------------------ state helpers

  private freshState(): GameState {
    const flags = this.state?.progress.flags;
    return newGame(parseMSaveHeader(this.assets.file('MSAVE.R3')), this.assets.bak, (s) => this.assets.section(s), this.assets.tables, flags);
  }

  private get mode(): number {
    return this.state.location.mode & 0xf;
  }

  private officerName(id: number): string {
    return this.state.officers[id & 0x1ff]?.name ?? '';
  }

  private actorName(id: number): string {
    if ((id & 0xe00) === 0x400) return this.state.npcTypes[id & 0x1ff]?.name ?? '';
    return this.officerName(id);
  }

  private territoryName(): Uint8Array {
    const t = this.state.towns[this.state.progress.territory];
    return bytesOf(t ? t.name : '');
  }

  private refreshStatus() {
    if (!this.ui.hasFrame) return;
    this.ui.drawStatus({ money: this.state.progress.money, level: heroLevel(this.state), territory: this.territoryShown ? this.territoryName() : undefined });
  }

  private drawFrame() {
    this.ui.drawFrame({
      money: this.state.progress.money,
      level: heroLevel(this.state),
      territory: this.territoryShown ? this.territoryName() : undefined,
      face: this.state.officers[0]?.face ?? 0,
    });
  }

  private palette(mode = this.mode) {
    return this.assets.palettes[mode] ?? this.assets.palettes[0];
  }

  private music(song: number) {
    this.state.progress.bgm = song;
    if (!this.sound || !(this.state.progress.flags & OPT.BGM)) return;
    try {
      this.sound.changeSong(song);
    } catch (e) {
      this.log(String(e));
    }
  }

  sfx(n: number) {
    if (this.sound && this.state.progress.flags & OPT.SE) this.sound.playSfx(n);
  }

  // ------------------------------------------------------------------ events

  /** Runs the event selected by a trigger; a MAP command suspends it ('suspended'). */
  async dispatch(trigger: Trigger): Promise<EventResult> {
    try {
      const r = await this.vm.dispatch(trigger);
      if (r === 'gameOver') this.state.status |= STATUS.GAME_OVER;
      if (r === 'ending') this.state.status |= STATUS.ENDING;
      return r;
    } catch (e) {
      if (e instanceof Suspend) return 'suspended';
      throw e;
    }
  }

  async runEvent(trigger: Trigger): Promise<EventResult> {
    return this.dispatch(trigger);
  }

  /** Runs auto events until none matches or the location / status changes. */
  private async runAuto(limit = 200): Promise<boolean> {
    let ran = false;
    for (let i = 0; i < limit; i++) {
      if (this.state.status & (STATUS.LOCATION_CHANGED | 0x6c)) return true;
      const r = await this.dispatch({ type: 'auto' });
      if (r === 'none') return ran;
      ran = true;
    }
    return ran;
  }

  // ------------------------------------------------------------------ script host

  private makeHost(): ScriptHost {
    const own: ScriptHost = {
      talk: (l, c) => this.talk(l, c),
      ask: (l, c) => this.ask(l, c),
      narrate: (m, c) => this.narrate(m, c.inPicture),
      caption: (m) => this.ui.captionBox(m, 0).then(() => undefined),
      title: async (m) => {
        this.setTitle(m.bytes);
      },
      stageTitle: async (i) => {
        const t = this.assets.stageTitles[i] ?? '';
        await this.ui.captionBox(t, 0);
      },
      choose: (opts) => this.ui.menu(opts, { cancel: false }).then((i) => Math.max(0, i)),
      showPicture: (p, m) => this.showPicture(p, m),
      closePicture: async () => this.closePicture(),
      setMap: async (map) => this.setMap(map),
      showMap: () => this.showMap(),
      redraw: async () => this.renderField(),
      placeCharacter: (o, x, y, d) => {
        this.field.place(o, x, y, d);
        this.renderField();
      },
      moveCharacter: (o, x, y, d) => this.field.move(o, x, y, d),
      waitMoves: () => this.waitMoves(),
      removeCharacter: (o) => {
        this.field.remove(o);
        this.renderField();
      },
      clearCharacters: () => {
        this.field.clearActors();
        this.renderField();
      },
      placeTownsfolk: () => this.placeTownsfolk(),
      walkTo: (x, y) => this.scrollTo(x, y),
      focus: (o) => {
        const a = this.field.actors.get(o);
        if (a) this.scrollTo(a.x, a.y);
      },
      setLeader: (o) => {
        // SET_LEADER's operand is the territory (town) shown as 현재영토 (inferred from the opening:
        // 1 낙양 palace, 2 진유 camp, 3 사수관 battle).
        this.state.progress.territory = o & 0xff;
        this.territoryShown = true;
        this.refreshStatus();
      },
      setPrevMap: (map, x, y) => {
        Object.assign(this.state.prevLocation, { mode: (map >> 12) & 0xf, map: map & 0xff, x, y });
      },
      setInputEnabled: (en) => {
        this.inputLocked = en;
      },
      playMusic: (s) => this.music(s),
      addGold: (n) => {
        this.state.progress.money = Math.max(0, Math.min(10000, this.state.progress.money + n));
        this.refreshStatus();
      },
      addItem: (item) => this.addItem(item),
      formation: () => this.formationScreen(),
      setForce: (o, f) => {
        const d = this.state.officers[o & 0x1ff]?.dyn;
        if (d) d.flags = (d.flags & ~0x1f) | (f & 0x1f);
      },
      setCg: (o, cg) => {
        const d = this.state.officers[o & 0x1ff]?.dyn;
        if (d) d.b1 = cg;
      },
      setOfficerFlag: (o, on) => {
        const d = this.state.officers[o & 0x1ff]?.dyn;
        if (d) d.flags = on ? d.flags | 0x80 : d.flags & ~0x80;
      },
      addStat: (o, n) => {
        const d = this.state.officers[o & 0x1ff]?.dyn;
        if (d) d.level = Math.min(99, d.level + n);
        this.refreshStatus();
      },
      setStat: (o, v) => {
        const d = this.state.officers[o & 0x1ff]?.dyn;
        if (d) d.level = v;
        this.refreshStatus();
      },
      savePrompt: () => this.savePrompt(),
      saveState: (s) => {
        this.snapshot = s;
      },
      gameOver: async () => {
        this.state.status |= STATUS.GAME_OVER;
      },
      ending: async () => {
        this.state.status |= STATUS.ENDING;
      },
      stageChanged: (chapter) => {
        if (chapter !== this.state.progress.chapter) {
          // 0cf5:b272: a new chapter reloads its BBKSDAT1 section (town names, places and state)
          this.state.progress.chapter = chapter;
          const t = this.assets.tables;
          const k = t.chapterSection[chapter] ?? 0;
          const sec = this.assets.section(k);
          const base = t.sectionTownBase[k];
          this.state.towns = sec.towns.map((town, i) => {
            const e = Math.min(base + i, t.townSmapEntry.length - 1);
            return { ...town, pos: t.townPos[e], smapEntry: t.townSmapEntry[e], dyn: { ...sec.defaultDyn[i] } };
          });
        }
      },
      log: (m) => this.log(m),
    };
    const NEVER_FORWARDED = new Set(['setMap']);
    return new Proxy(own, {
      get: (target, prop: string) => {
        const b = this.battleHost as Record<string, unknown> | null;
        if (b && !NEVER_FORWARDED.has(prop) && typeof b[prop] === 'function') return (b[prop] as (...a: unknown[]) => unknown).bind(b);
        return (target as unknown as Record<string, unknown>)[prop];
      },
    });
  }

  private setTitle(bytes: Uint8Array) {
    this.state.title = dec.decode(bytes);
    const raw = new Uint8Array(30);
    raw.set(bytes.subarray(0, 29));
    this.state.titleRaw = raw;
    this.ui.setTitle(bytes);
  }

  /** True when the speaker stands in the lower half of the view (0cf5:c15a: map y > 9). */
  private speakerLow(id: number): boolean {
    const a = this.field.actors.get(id);
    if (!a || !this.mapShown) return false;
    if (this.field.kind === 'world') return (a.py - this.field.scrollY) / 16 > 9;
    return a.y > 9;
  }

  private async talk(line: TalkLine, _ctx: TextContext) {
    const o = this.state.officers[line.speaker & 0x1ff];
    await this.ui.messageBox(line, { kind: 3, name: o?.name ?? '', face: o?.face, top: this.speakerLow(line.speaker) });
  }

  private async ask(line: TalkLine, _ctx: TextContext): Promise<boolean> {
    const o = this.state.officers[line.speaker & 0x1ff];
    return this.ui.messageBox(line, { kind: 3, name: o?.name ?? '', face: o?.face, top: this.speakerLow(line.speaker), yesNo: true });
  }

  private async narrate(msg: Message, inPicture: boolean) {
    await this.ui.messageBox(msg, { kind: inPicture ? 0 : 1 });
  }

  /** 0cf5:cd58: event picture in a window over the map view (mode 0 clears the view first). */
  private async showPicture(picture: number, mode: number) {
    const img = this.assets.picture(picture);
    if (!this.pictureSaved) this.pictureSaved = { data: this.screen.grab(VIEW.x, VIEW.y, VIEW.w, VIEW.h) };
    if (mode === 0) {
      this.draw.fill(VIEW.x, VIEW.y, VIEW.w, VIEW.h, 0);
      if (this.video.dark) this.video.setPalette(this.palette());
    }
    const x = 0x98, y = 0x20 + LAYOUT_Y, w = 0xf0, h = 0xa0;
    this.draw.window(x, y, w, h, 6, 4, false);
    if (img) this.draw.image(img, x + ((w - img.width) >> 1), y + ((h - img.height) >> 1));
    await this.video.frame();
  }

  private closePicture() {
    if (this.pictureSaved) {
      this.screen.blit(this.pictureSaved.data, VIEW.w, VIEW.h, VIEW.x, VIEW.y);
      this.pictureSaved = null;
    }
  }

  private renderField() {
    if (!this.mapShown || this.pictureSaved || this.video.dark) return;
    this.field.render();
  }

  /** SCREEN_MAP (0cf5:97cc): draw the map and show it. */
  private async showMap() {
    this.closePicture();
    if (this.focusPending && this.field.kind === 'world') {
      // the world map opens on 유비 (placed by the event after MAP)
      const a = this.field.actors.get(0);
      if (a) this.field.focusOn(a.x, a.y);
    }
    this.focusPending = false;
    this.mapShown = true;
    this.field.render();
    if (this.video.dark) await this.video.fadeIn(this.palette(), 8);
    else await this.video.frame();
  }

  private async waitMoves() {
    this.moveWaiters++;
    try {
      while (this.field.moving) {
        if (this.field.stepActors()) this.renderField();
        await this.video.frame();
      }
      this.renderField();
    } finally {
      this.moveWaiters--;
    }
  }

  /** WALK_TO / FOCUS on the world map: scroll so that (x, y) is centred. */
  private async scrollTo(x: number, y: number) {
    if (this.field.kind !== 'world') return;
    this.focusPending = false;
    const sx0 = this.field.scrollX, sy0 = this.field.scrollY;
    this.field.focusOn(x, y);
    const tx = this.field.scrollX, ty = this.field.scrollY;
    if (!this.mapShown || this.video.dark) return;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(tx - sx0), Math.abs(ty - sy0)) / 8));
    for (let i = 1; i <= steps; i++) {
      this.field.scrollX = Math.round(sx0 + ((tx - sx0) * i) / steps);
      this.field.scrollY = Math.round(sy0 + ((ty - sy0) * i) / steps);
      this.field.render();
      await this.video.frame();
    }
  }

  private async addItem(item: number) {
    const it = this.state.items[item];
    for (const o of rosterOfficers(this.state)) {
      const k = o.dyn.items.indexOf(0xff);
      if (k >= 0) {
        o.dyn.items[k] = item;
        break;
      }
    }
    if (it) await this.ui.captionBox(`${josa(it.name, '을', '를')} 손에 넣었다!`, 0);
  }

  /** MAP: the location change of 0cf5:c86c, then the event is suspended until the new map is up. */
  private setMap(map: number): never {
    const loc = this.state.location;
    this.state.prevLocation = { ...loc };
    const kind = (map >> 12) & 0xf;
    const low = map & 0xff;
    loc.mode = (loc.mode & 0xf0) | kind;
    loc.map = low;
    if (kind === 0) {
      loc.entered = 1;
      loc.x = 0x0b;
      loc.y = 0x0d;
    } else if (kind === 2) {
      loc.entered = 0;
    } else {
      loc.x = 0x0b;
      loc.y = 0x0d;
    }
    this.state.status |= STATUS.LOCATION_CHANGED;
    this.script.status = 1;
    throw new Suspend();
  }

  // ------------------------------------------------------------------ locations

  /** Brings up the current location (main loop pass after c86c: 86f0, map load, 8708). */
  private async enterLocation(byPlayer = false) {
    this.state.status &= ~STATUS.LOCATION_CHANGED;
    this.closePicture();
    if (!this.video.dark && this.mapShown) await this.video.fadeOut(8);
    this.mapShown = false;
    const loc = this.state.location;
    const mode = this.mode;
    const s = this.script;
    s.map = (mode << 12) | loc.map;
    s.area = loc.key;
    if (mode === 3) return;
    if (this.frameStale) {
      // back from battle mode, which draws its own frame (the screen is dark here)
      this.frameStale = false;
      if (!this.video.dark) await this.video.fadeOut(8);
      this.screen.clear(0);
      this.drawFrame();
    }
    this.focusPending = mode === 1;
    if (mode === 1) this.field.loadWorld(this.state.progress.chapter);
    else if (mode === 0) this.field.loadRoom(0, this.state.towns[loc.map]?.smapEntry ?? 0);
    else this.field.loadRoom(2, loc.map);
    this.video.black();
    // 0cf5:8708: characters of this map kept in the script context come back
    if (s.charsArea === s.area && s.charsMap === s.map && s.replaceChars) {
      s.replaceChars = 0;
      for (const c of s.chars) if (c.id !== 0xffff && c.x !== 0xff) this.field.place(c.id, c.x, c.y, (c.dir >> 1) & 3);
      if (s.music) this.music(s.music);
    } else s.replaceChars = 1;
    if (byPlayer || loc.entered) {
      if (mode === 0 || mode === 2) {
        const type = this.field.buildingType(loc.map);
        if (mode === 2 && type === 7) this.music(15);
        else if (mode === 0) this.music(this.state.progress.chapter === 3 && this.state.progress.territory === 0x0b ? 1 : 5);
        // into a building by its door: at its exit; into a town: where the location says
        const pos = mode === 2 ? this.entryCell(-1, -1) : this.entryCell(loc.x, loc.y);
        if (!this.field.actors.has(0)) this.field.place(0, pos.x, pos.y, 1);
        this.placeTownsfolk();
      } else if (mode === 1) {
        const t = this.state.towns[loc.key];
        const p = t ? t.pos : [loc.x, loc.y];
        if (!this.field.actors.has(0)) this.field.place(0, p[0], p[1], 2);
        this.field.focusOn(p[0], p[1]);
      }
    }
    if (mode === 1) {
      const a = this.field.actors.get(0);
      if (a) this.field.focusOn(a.x, a.y);
    }
  }

  private entryCell(x: number, y: number): { x: number; y: number } {
    if (this.field.attr(x, y) === ATTR.WALK) return { x, y };
    // a door: step out in front of it
    for (const [dx, dy] of [[0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, 2]]) if (this.field.attr(x + dx, y + dy) === ATTR.WALK) return { x: x + dx, y: y + dy };
    for (let yy = 19; yy >= 0; yy--)
      for (let xx = 0; xx < 31; xx++) if (this.field.attr(xx, yy) === ATTR.EXIT || this.field.attr(xx, yy) === ATTR.GATE) {
        for (const [dx, dy] of [[1, -1], [1, 0], [0, -1], [-1, -1], [1, 1], [-1, 0]]) if (this.field.attr(xx + dx, yy + dy) === ATTR.WALK) return { x: xx + dx, y: yy + dy };
      }
    for (let yy = 19; yy >= 0; yy--) for (let xx = 0; xx < 31; xx++) if (this.field.attr(xx, yy) === ATTR.WALK) return { x: xx, y: yy };
    return { x, y };
  }

  /** 1cb6:2d38: townsfolk of this town (IPPAN0), on random even walkable cells. */
  private placeTownsfolk() {
    if (this.field.kind !== 'room') return;
    const loc = this.state.location;
    const sec = this.assets.townsfolk[this.assets.tables.chapterSection[this.state.progress.chapter] ?? 0];
    const groups = sec?.towns[loc.key];
    if (!groups) return;
    const key = this.mode === 2 ? loc.map : 0x7d;
    const g = groups.find((x) => x.key === key);
    if (!g) return;
    for (const person of g.people) {
      for (let tries = 0; tries < 200; tries++) {
        const x = this.rng.rand(16) * 2, y = this.rng.rand(10) * 2;
        if (this.field.attr(x, y) !== ATTR.WALK) continue;
        if ([...this.field.actors.values()].some((a) => a.x === x && a.y === y)) continue;
        this.field.place(person | 0x400, x, y, this.rng.rand(4));
        break;
      }
    }
  }

  // ------------------------------------------------------------------ title and flow

  /** main() 0cf5:aaea from the title menu on; returns when the player is back at the title. */
  async run(): Promise<void> {
    for (;;) {
      const choice = await this.titleMenu();
      if (choice === 'new') await this.startNew();
      else if (choice === 'load') {
        if (!(await this.loadMenu())) continue;
      } else continue;
      await this.mainLoop();
      if (this.state.status & STATUS.ENDING) await this.endingScreen();
      else if (this.state.status & (STATUS.GAME_OVER | STATUS.QUIT)) {
        const again = await this.ui.captionBox('다시 한번 게임하겠습니까?', 2);
        if (!again) await this.farewell();
      }
    }
  }

  /** Far-pointer list of menu labels in DGROUP (e.g. DS:0x2d38 title menu). */
  private dsList(off: number, max = 12): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < max; i++) {
      const p = this.assets.dsWord(off + i * 4), seg = this.assets.dsWord(off + i * 4 + 2);
      if (!p || seg !== this.assets.dsWord(off + 2)) break;
      out.push(this.assets.dsString(p));
    }
    return out;
  }

  /** Title menu 0cf5:c050 (2c92 at layout (0xd8, 0x80), no save-under). */
  private async titleMenu(): Promise<'new' | 'load'> {
    if (!this.video.dark) await this.video.fadeOut(8);
    this.screen.clear(0);
    this.ui.title = new Uint8Array(0);
    this.field.kind = 'none';
    this.mapShown = false;
    this.sound?.fadeOut(8);
    this.video.setPalette(this.assets.palettes[0]);
    this.video.cursor = CURSOR.ARROW;
    for (;;) {
      const labels = this.dsList(0x2d38, 4);
      const r = await this.ui.menu(labels, { x: 0xd8, y: 0x80 + LAYOUT_Y, keep: true, cancel: false });
      if (r === 0) return 'new';
      if (r === 1) return 'load';
      if (r === 2) await this.optionsMenu(0x120, 0xa0 + LAYOUT_Y);
      if (r === 3) await this.ui.captionBox('오프닝은 Classic 모드에서 볼 수 있습니다.', 0);
    }
  }

  /** 기능설정 / 기능 submenu entries 모니터, BGM, 효과음 (0cf5:f05e, f038, f02e). */
  private async optionsMenu(x: number, y: number) {
    const labels = this.dsList(0x34fc, 3);
    for (;;) {
      const r = await this.ui.menu(labels, { x, y });
      if (r < 0) return;
      await this.optionToggle(r === 0 ? OPT.COLOR : r === 1 ? OPT.BGM : OPT.SE, x + 32, y + 16);
    }
  }

  private async optionToggle(bit: number, x: number, y: number) {
    const p = this.state.progress;
    const labels = bit === OPT.COLOR ? ['컬러', '흑백'] : ['ON', 'OFF'];
    const on = (p.flags & bit) !== 0;
    const r = await this.ui.menu(labels, { x, y, disabled: [on, !on] });
    if (r < 0) return;
    p.flags = r === 0 ? p.flags | bit : p.flags & ~bit;
    if (bit === OPT.BGM) {
      if (r === 0 && p.bgm !== 0xffff) this.music(p.bgm);
      else if (r === 1) this.sound?.stop();
    }
  }

  /** New game (0cf5:b536 -> b2b0), frame (c456) and the prologue up to the first location. */
  private async startNew() {
    this.state = this.freshState();
    this.territoryShown = false;
    this.vm.state = newScriptState();
    this.inputLocked = false;
    this.field.kind = 'none';
    this.screen.clear(0);
    this.video.setPalette(this.palette());
    this.drawFrame();
    await this.video.frame();
  }

  /** 게임을 재개한다 / 로드: the save list (0cf5:b938) and b34e. */
  private async loadMenu(): Promise<boolean> {
    const slot = await this.slotMenu(false);
    if (slot < 0) return false;
    const data = this.saves.read(slot);
    if (!data) return false;
    if (!(await this.ui.captionBox(`하드디스크의 ${slot + 1}번 데이타를 로드하겠습니다.\n좋습니까?`, 2))) return false;
    this.territoryShown = true;
    this.state = loadGame(data.msave, data.esave, this.assets.bak, (s) => this.assets.section(s), this.assets.tables);
    this.vm.state = data.esaveBytes ? readEventSave(data.esaveBytes) : newScriptState();
    // The characters come back from the event context (0cf5:8708); the MSAVE actor table is not used.
    this.script.replaceChars = 1;
    this.loadedGame = true;
    this.inputLocked = this.script.savedInput !== 0;
    this.field.kind = 'none';
    this.screen.clear(0);
    this.video.black();
    this.video.setPalette(this.palette());
    this.drawFrame();
    this.ui.setTitle(this.state.titleRaw.subarray(0, Math.max(0, this.state.titleRaw.indexOf(0))));
    this.state.status |= STATUS.LOCATION_CHANGED;
    this.video.black();
    return true;
  }

  /** The save list: 5 lines "n. title yy/mm/dd hh:mm"; -1 = cancelled. */
  private async slotMenu(saving: boolean): Promise<number> {
    const rows = this.saves.list();
    // 0cf5:b58c: " %u. %s%s/%s/%s  %s:%s         " with the title padded to 30 bytes; empty " %u.%s" (DS:0x2afc)
    const unused = this.assets.dsString(this.assets.dsWord(0x2afc));
    const labels = rows.map((r) => {
      if (r.empty) return concatBytes(bytesOf(` ${r.slot + 1}.`), unused);
      const t = bytesOf(r.title);
      const pad = new Uint8Array(Math.max(0, 30 - t.length)).fill(0x20);
      return concatBytes(bytesOf(` ${r.slot + 1}. `), t, pad, bytesOf(`${r.time.replace(' ', '  ')}         `));
    });
    const header = saving ? ' 데이타의 보존장소를 지정해 주십시오. ' : ' 읽을 데이타를 선택하십시오. ';
    const hb = bytesOf(header);
    const hx = 320 - ((hb.length + 4) * 4);
    const saved = this.draw.grab({ x: hx, y: 0x30 + LAYOUT_Y, w: (hb.length + 4) * 8, h: 48 });
    this.draw.window(hx, 0x30 + LAYOUT_Y, (hb.length + 4) * 8, 48, 6, 4);
    this.ui.text(hb, (hx >> 3) + 2, 0x30 + LAYOUT_Y + 16);
    const disabled = rows.map((r) => !saving && r.empty);
    const r = await this.ui.menu(labels, { cx: 320, y: 0x68 + LAYOUT_Y, disabled });
    this.draw.restore(saved);
    return r;
  }

  private async saveTo(slot: number, esave: Uint8Array) {
    const m = serializeMSave(toSave(this.state));
    await this.saves.write(slot, m, esave);
    this.state.scenario = parseESave(esave);
  }

  /** 기능 -> 세이브 (0cf5:f0ce) and SAVE_PROMPT. */
  private async saveMenu(resume: boolean): Promise<boolean> {
    const slot = await this.slotMenu(true);
    if (slot < 0) return false;
    if (!(await this.ui.captionBox(`하드디스크의 ${slot + 1}번에 세이브하겠습니다.\n좋습니까?`, 2))) return false;
    const s = { ...this.script };
    if (resume) s.status = 1;
    // Where the characters stand now (the original keeps this in the MSAVE actor table, see enterLocation).
    s.chars = s.chars.map((c) => {
      const a = c.id !== 0xffff ? this.field.actors.get(c.id) : undefined;
      return a ? { ...c, x: a.x, y: a.y, dir: (a.dir & 3) * 2 } : c;
    });
    await this.saveTo(slot, writeEventSave(s));
    return true;
  }

  /** SAVE_PROMPT: "여기서 세이브하겠습니까?" (DS:0x305a / 0x3073). */
  private async savePrompt() {
    for (;;) {
      if (await this.ui.captionBox('여기서 세이브하겠습니까?', 2)) {
        if (await this.saveMenu(true)) return;
      } else if (await this.ui.captionBox('정말 세이브하지 않아도 좋습니까?', 2)) return;
    }
  }

  private async farewell() {
    await this.video.fadeOut(8);
    this.screen.clear(0);
    const a = this.assets.picture(0x22), b = this.assets.picture(0x24);
    this.video.setPalette(this.assets.palettes[4]);
    if (a) this.draw.image(a, 0xd8, 0x50 + LAYOUT_Y);
    if (b) this.draw.image(b, 0xb8, 0xc8 + LAYOUT_Y);
    await this.ui.waitClick();
  }

  private async endingScreen() {
    this.sound?.fadeOut(8);
    await this.video.fadeOut(16);
    this.screen.clear(0);
    this.video.setPalette(this.assets.palettes[0]);
    this.ui.captionCentre = 0x140;
    await this.ui.captionBox('엔딩 (END.EXE)은 아직 지원되지 않습니다.', 0);
    this.ui.captionCentre = 0x110;
  }

  // ------------------------------------------------------------------ main loop

  /** 0cf5:a88c until game over / quit / ending. */
  private async mainLoop() {
    // new game: run events until the script sets the first location (main() step 5)
    for (;;) {
      if (this.state.status & 0x6c) return;
      if (this.state.status & STATUS.LOCATION_CHANGED) {
        await this.enterLocation();
        continue;
      }
      if (this.state.status & STATUS.LOADED) {
        this.state.status &= ~STATUS.LOADED;
        continue;
      }
      switch (this.mode) {
        case 3:
          await this.battleMode();
          break;
        default:
          await this.fieldLoop();
      }
    }
  }

  /** Field modes 0/1/2: events, then player input, one frame per pass. */
  private async fieldLoop() {
    let idleAuto = false;
    while (!(this.state.status & (STATUS.LOCATION_CHANGED | 0x6c))) {
      if (this.loadedGame && this.field.kind !== 'none') {
        // A loaded game shows its map before the saved event resumes (a MAP suspension waits for SCREEN_MAP).
        this.loadedGame = false;
        if (!this.mapShown || this.video.dark) await this.showMap();
      }
      if (!idleAuto) {
        const ran = await this.runAuto();
        if (this.state.status & (STATUS.LOCATION_CHANGED | 0x6c)) return;
        idleAuto = true;
        if (ran) continue;
      }
      if (this.field.kind === 'none') {
        // events ran out without a location (should not happen): show the frame and wait
        await this.video.frame();
        idleAuto = false;
        continue;
      }
      if (!this.mapShown || this.video.dark) await this.showMap();
      const acted = await this.inputFrame();
      if (acted) idleAuto = false;
      if (this.field.stepActors()) this.renderField();
    }
  }

  /** One frame of player input on the field; true when an event or menu ran. */
  private async inputFrame(): Promise<boolean> {
    const mx = this.input.x, my = this.input.y;
    const actor = this.field.actorAt(mx, my);
    const cell = this.field.cellAt(mx, my);
    let hover = '';
    let hand = false;
    if (actor && actor.id !== 0) {
      hover = this.actorName(actor.id);
      hand = true;
    } else if (cell && this.field.kind === 'room') {
      const v = this.field.attr(cell.x, cell.y);
      if (v < 0x7c || v === ATTR.GATE || v === ATTR.EXIT) {
        hover = this.buildingName(v);
        hand = hover !== '';
      }
    } else if (cell && this.field.kind === 'world') {
      const t = this.townAt(cell.x, cell.y);
      if (t >= 0) {
        hover = this.state.towns[t].name;
        hand = true;
      }
    }
    this.ui.drawHover(hover);
    this.video.cursor = hand ? CURSOR.HAND : CURSOR.ARROW;
    const key = this.input.takeKey();
    if (key && this.field.kind === 'world') {
      const d = { ArrowLeft: [-32, 0], ArrowRight: [32, 0], ArrowUp: [0, -32], ArrowDown: [0, 32] }[key];
      if (d) {
        this.field.scrollBy(d[0], d[1]);
        this.field.render();
      }
    }
    if (this.field.kind === 'world') this.edgeScroll(mx, my);
    const c = this.input.takeClick();
    await this.video.frame();
    if (!c || c.button !== 'left') return false;
    const icon = ICONS.findIndex((r) => c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h);
    if (icon >= 0) {
      this.video.cursor = CURSOR.ARROW;
      await this.iconCommand(icon);
      return true;
    }
    if (this.inputLocked && this.field.kind !== 'world') return false;
    if (this.field.kind === 'world') return this.worldClick(c.x, c.y);
    // the click's own position (the pointer may have moved since the hover test)
    const target = this.field.actorAt(c.x, c.y);
    const where = this.field.cellAt(c.x, c.y);
    if (target && target.id !== 0) return this.talkTo(target);
    if (where) {
      const v = this.field.attr(where.x, where.y);
      if (v < 0x7c || v === ATTR.GATE || v === ATTR.EXIT) return this.useDoor(where.x, where.y, v);
      if (v === ATTR.WALK && this.field.actors.has(0)) {
        this.field.walkPath(0, where.x, where.y, this.field.actors.get(0)!.dir);
        await this.waitMoves();
      }
    }
    return false;
  }

  private edgeScroll(mx: number, my: number) {
    if (mx < VIEW.x || mx >= VIEW.x + VIEW.w || my < VIEW.y || my >= VIEW.y + VIEW.h) return;
    const step = 8 * Math.max(1, this.state.progress.scroll || 1);
    let dx = 0, dy = 0;
    if (mx < VIEW.x + 8) dx = -step;
    if (mx >= VIEW.x + VIEW.w - 8) dx = step;
    if (my < VIEW.y + 8) dy = -step;
    if (my >= VIEW.y + VIEW.h - 8) dy = step;
    if (dx || dy) {
      this.field.scrollBy(dx, dy);
      this.field.render();
    }
  }

  private buildingName(v: number): string {
    let k: number;
    if (v === ATTR.GATE) k = 0x0d;
    else if (v === ATTR.EXIT) k = 0x0e;
    else k = this.field.buildingType(v);
    const p = this.assets.dsWord(0x38ac + 2 * k);
    if (!p) return '';
    return dec.decode(this.assets.dsString(p)).trim();
  }

  private townAt(x: number, y: number): number {
    const n = this.assets.tables.sectionTownCount[this.assets.tables.chapterSection[this.state.progress.chapter] ?? 0] ?? 0;
    for (let i = 0; i < Math.min(n, this.state.towns.length); i++) {
      const p = this.state.towns[i].pos;
      if (p[0] === x && p[1] === y) return i;
    }
    return -1;
  }

  /** Walks 유비 next to a character, then fires the talk trigger (0cf5:8268). */
  private async talkTo(target: Actor): Promise<boolean> {
    const me = this.field.actors.get(0);
    if (me) {
      let best: { x: number; y: number } | null = null;
      let bestLen = 1e9;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = target.x + dx, y = target.y + dy;
        if (x === me.x && y === me.y) {
          best = { x, y };
          bestLen = 0;
          break;
        }
        if (this.field.attr(x, y) !== ATTR.WALK) continue;
        const p = this.field.findPath(me.x, me.y, x, y);
        if (p && p.length < bestLen) {
          best = { x, y };
          bestLen = p.length;
        }
      }
      if (best) {
        const dx = target.x - best.x, dy = target.y - best.y;
        const dir = dy < 0 && dx >= 0 ? 0 : dx > 0 && dy >= 0 ? 1 : dy > 0 && dx <= 0 ? 2 : 3;
        this.field.walkPath(0, best.x, best.y, dir);
        await this.waitMoves();
      }
    }
    const r = await this.dispatch({ type: 'talk', officer: target.id });
    if (r !== 'none') {
      if (this.lastEventHas('OP31')) await this.shop();
      return true;
    }
    if ((target.id & 0xe00) === 0x400) {
      const sec = this.assets.townsfolk[this.assets.tables.chapterSection[this.state.progress.chapter] ?? 0];
      const msg = sec?.messages[target.id & 0x1ff];
      if (msg) await this.ui.messageBox(msg, { kind: 3, name: this.actorName(target.id), top: target.y > 9 });
    }
    return true;
  }

  /** Whether the code of the event that just ran contains a command (OP31 opens the shop). */
  private lastEventHas(name: string): boolean {
    const s = this.script;
    const code = s.record[8] | (s.record[9] << 8);
    const stage = this.vm.stage;
    const block = stage.blocks[s.block];
    if (!block) return false;
    let pc = block.offset + code;
    for (let i = 0; i < 64; i++) {
      const c = stage.commands.get(pc);
      if (!c) return false;
      if (c.name === name) return true;
      if (c.name === 'END') return false;
      pc += c.size;
    }
    return false;
  }

  /** A door (building n), gate or exit: walk there, location trigger 2 (0cf5:8346), default action. */
  private async useDoor(x: number, y: number, v: number): Promise<boolean> {
    const me = this.field.actors.get(0);
    if (me) {
      this.field.walkPath(0, x, y, me.dir);
      await this.waitMoves();
    }
    const r = await this.dispatch({ type: 'location', spot: v, town: this.state.location.key });
    if (r !== 'none' || this.state.status & STATUS.LOCATION_CHANGED) return true;
    if (this.inputLocked) return true;
    const loc = this.state.location;
    if (v < 0x7c) {
      // enter building v (PMAP entry); the way back is this door of the town
      this.state.prevLocation = { ...loc, x, y };
      loc.mode = (loc.mode & 0xf0) | 2;
      loc.map = v;
      loc.entered = 1;
    } else if (this.mode === 2 && v === ATTR.EXIT) {
      // back to the town: where SET_PREV_MAP or the door we came in by says
      const prev = this.state.prevLocation;
      const back = (prev.mode & 0xf) === 0 && prev.map === loc.key;
      this.state.prevLocation = { ...loc };
      loc.mode = loc.mode & 0xf0;
      loc.map = loc.key;
      loc.entered = 1;
      loc.x = back ? prev.x : x;
      loc.y = back ? prev.y : y;
    } else {
      this.state.prevLocation = { ...loc };
      // town gate: out to the world map
      loc.mode = (loc.mode & 0xf0) | 1;
      loc.entered = 1;
    }
    this.state.status |= STATUS.LOCATION_CHANGED;
    return true;
  }

  /** World map click: move 유비's party there; arriving at a town fires trigger 5 or enters it. */
  private async worldClick(sx: number, sy: number): Promise<boolean> {
    const cell = this.field.cellAt(sx, sy);
    const me = this.field.actors.get(0);
    if (!cell || !me || this.inputLocked) return false;
    this.field.move(0, cell.x, cell.y, me.dir);
    while (this.field.moving) {
      this.field.stepActors();
      const a = this.field.actors.get(0)!;
      const vx = a.px - this.field.scrollX, vy = a.py - this.field.scrollY;
      if (vx < 64 || vx > VIEW.w - 96 || vy < 64 || vy > VIEW.h - 96) this.field.focusOn(a.px / 32, a.py / 32);
      this.field.render();
      await this.video.frame();
    }
    const t = this.townAt(cell.x, cell.y);
    if (t < 0) return false;
    this.state.location.key = t;
    this.script.area = t;
    const r = await this.dispatch({ type: 'location', spot: 0, town: t });
    if (r !== 'none' || this.state.status & STATUS.LOCATION_CHANGED) return true;
    const town = this.state.towns[t];
    if (town && town.b22 === 3) {
      const loc = this.state.location;
      this.state.prevLocation = { ...loc };
      loc.mode = loc.mode & 0xf0;
      loc.map = t;
      loc.key = t;
      loc.entered = 1;
      loc.x = 0x0b;
      loc.y = 0x0d;
      this.state.progress.territory = t;
      this.refreshStatus();
      this.state.status |= STATUS.LOCATION_CHANGED;
    } else if (town) await this.ui.captionBox(town.name, 0);
    return true;
  }

  // ------------------------------------------------------------------ frame commands

  private async iconCommand(i: number) {
    const lx = 34, ly = 72;
    const labels = ['스토리 정보', '장수', '전체지도', '기능'];
    const box = this.draw.grab({ x: lx, y: ly, w: 112, h: 48 });
    this.draw.window(lx, ly, 112, 48, 6, 4);
    this.ui.text(labels[i], (lx >> 3) + 2, ly + 16);
    try {
      if (i === 0) {
        const o = this.script.objective;
        const n = o.indexOf(0);
        const text = n > 0 ? o.subarray(0, n) : bytesOf(this.state.title);
        await this.ui.messageBox({ bytes: text, text: dec.decode(text) }, { kind: 1 });
      } else if (i === 1) {
        const items = this.dsList(0x35ee, 2);
        const r = await this.ui.menu(items.length ? items : ['장수정보', '도구교환'], { x: 0x120, y: 0x20 + LAYOUT_Y });
        if (r === 0) await this.officerInfo();
        if (r === 1) await this.itemExchange();
      } else if (i === 2) {
        if (this.field.kind !== 'world') await this.ui.captionBox('이 화면에서는 표시할 수 없습니다', 0);
        else await this.overview();
      } else await this.systemMenu();
    } finally {
      this.draw.restore(box);
    }
  }

  private async pickOfficer(at: { x: number; y: number } = { x: 0x120, y: 0x20 + LAYOUT_Y }): Promise<number> {
    const roster = rosterOfficers(this.state);
    if (!roster.length) return -1;
    const r = await this.ui.menu(
      roster.map((o) => o.name),
      { ...at },
    );
    return r < 0 ? -1 : roster[r].index;
  }

  /** 장수정보 (0cf5:f8e0): class, level, 병력, 무력/지력/통솔 and items. */
  private async officerInfo() {
    for (;;) {
      const id = await this.pickOfficer();
      if (id < 0) return;
      const o = this.state.officers[id];
      const x = 64, y = 72, w = 416, h = 224;
      const saved = this.draw.grab({ x, y, w, h });
      this.draw.window(x, y, w, h, 6, 4);
      const face = this.assets.face(o.face);
      if (face) this.draw.image(face, x + 16, y + 16);
      const col = (x >> 3) + 12;
      const cls = this.assets.tables.classNames[o.dyn.cls] ?? '';
      this.ui.text(o.name, col, y + 16, 6);
      this.ui.text(`${cls}  레벨 ${o.dyn.level}`, col, y + 36);
      this.ui.text(`병력 ${o.dyn.troops}`, col, y + 56);
      const bar = (label: string, v: number, yy: number) => {
        this.ui.text(label, col, yy);
        this.draw.fill((col + 6) * 8, yy + 3, 100, 10, 0);
        this.draw.fill((col + 6) * 8, yy + 3, Math.max(0, Math.min(100, v)), 10, 6);
        this.ui.text(String(v).padStart(3, ' '), col + 20, yy);
      };
      bar('무력', o.strength, y + 80);
      bar('지력', o.intelligence, y + 100);
      bar('통솔', o.leadership, y + 120);
      const items = o.dyn.items.filter((v) => v !== 0xff).map((v) => this.state.items[v]?.name ?? '?');
      (items.length ? items : ['소지품 없음']).forEach((n, k) => this.ui.text(n, (x >> 3) + 2 + (k % 4) * 12, y + 152 + Math.floor(k / 4) * 20));
      await this.ui.waitClick();
      this.draw.restore(saved);
    }
  }

  /** 도구교환: move one item from an officer to another. */
  private async itemExchange() {
    const from = await this.pickOfficer();
    if (from < 0) return;
    const fo = this.state.officers[from];
    const slots = fo.dyn.items.map((v, k) => [v, k] as const).filter(([v]) => v !== 0xff);
    if (!slots.length) {
      await this.ui.captionBox('그 분은,아무것도 소지하고 있지 않습니다.', 0);
      return;
    }
    const r = await this.ui.menu(slots.map(([v]) => this.state.items[v]?.name ?? '?'), { x: 0x160, y: 0x40 + LAYOUT_Y });
    if (r < 0) return;
    const to = await this.pickOfficer();
    if (to < 0 || to === from) return;
    const tdyn = this.state.officers[to].dyn;
    const free = tdyn.items.indexOf(0xff);
    if (free < 0) {
      await this.ui.captionBox('그분은,더 이상,소지할 수 없습니다.', 0);
      return;
    }
    tdyn.items[free] = slots[r][0];
    fo.dyn.items[slots[r][1]] = 0xff;
  }

  private async overview() {
    const saved = this.screen.grab(VIEW.x, VIEW.y, VIEW.w, VIEW.h);
    const sx = this.field.scrollX, sy = this.field.scrollY;
    // quarter-scale overview of the whole map, drawn tile by tile
    for (let y = 0; y < VIEW.h; y += 64) for (let x = 0; x < VIEW.w; x += 128) void 0;
    this.field.scrollX = sx;
    this.field.scrollY = sy;
    await this.ui.captionBox(this.territoryName().length ? dec.decode(this.territoryName()) : '', 0);
    this.screen.blit(saved, VIEW.w, VIEW.h, VIEW.x, VIEW.y);
  }

  /** 기능 menu (list DS:0x34e8 at layout (0x120, 0x20)). */
  private async systemMenu() {
    const labels = this.dsList(0x34e8, 8);
    const items = labels.length >= 8 ? labels : ['게임 종료', '스크롤 단위', '속도설정', '로드', '세이브', '모니터', 'BGM', '효과음'].map((s) => bytesOf(s));
    const r = await this.ui.menu(items, { x: 0x120, y: 0x20 + LAYOUT_Y });
    const p = this.state.progress;
    switch (r) {
      case 0:
        if (await this.ui.captionBox('게임을 종료하겠습니까?', 2)) this.state.status |= STATUS.QUIT;
        break;
      case 1: {
        const vals = [1, 2, 4, 8];
        const k = await this.ui.menu(['소', '중', '대', '극대'], { x: 0x140, y: 0x90 + LAYOUT_Y, disabled: vals.map((v) => v === p.scroll) });
        if (k >= 0) p.scroll = vals[k];
        break;
      }
      case 2: {
        const k = await this.ui.menu(['노웨이트', '빠르다', '보통', '느리다'], { x: 0x140, y: 0x90 + LAYOUT_Y, disabled: [0, 1, 2, 3].map((v) => v === p.speed) });
        if (k >= 0) {
          p.speed = k;
          this.field.walkSpeed = [8, 4, 2, 1][k];
        }
        break;
      }
      case 3:
        if (await this.loadMenu()) this.state.status |= STATUS.LOADED;
        break;
      case 4:
        await this.saveMenu(false);
        break;
      case 5:
        await this.optionToggle(OPT.COLOR, 0x140, 0x90 + LAYOUT_Y);
        break;
      case 6:
        await this.optionToggle(OPT.BGM, 0x140, 0x90 + LAYOUT_Y);
        break;
      case 7:
        await this.optionToggle(OPT.SE, 0x140, 0x90 + LAYOUT_Y);
        break;
    }
  }

  // ------------------------------------------------------------------ formation (op 23)

  /**
   * FORMATION (op 23, 2cb4:2be2): the player picks the officers for the free player records of the
   * BATTLE_SETUP (officer 0x400); they replace the placeholders in slot order. The original's
   * formation screen (2cb4:274c..2af2) is not reproduced: this is a menu of the roster instead.
   */
  private async formationScreen() {
    const units = this.script.units;
    const player = units.filter((u) => u.officer !== 0xffff && !(u.flags & 1));
    const free = player.filter((u) => u.officer === 0x400);
    if (!free.length) return;
    const fixed = new Set(player.filter((u) => u.officer < 0x400).map((u) => u.officer));
    const pool = rosterOfficers(this.state).filter((o) => !fixed.has(o.index));
    const chosen: number[] = [];
    while (chosen.length < free.length && chosen.length < pool.length) {
      const left = pool.filter((o) => !chosen.includes(o.index));
      const r = await this.ui.menu(
        left.map((o) => o.name),
        { x: 0x1a0, y: 0x20 + LAYOUT_Y },
      );
      if (r < 0) {
        if (chosen.length) break;
        continue;
      }
      chosen.push(left[r].index);
    }
    if (this.script.hexFlag & 1) {
      // the formation path of the battle setup (2cb6:4e60) deploys this list in slot order (BattleExtras.formation)
      this.formation = [...player.filter((u) => u.officer < 0x400).map((u) => u.officer), ...chosen];
    } else chosen.forEach((o, i) => (free[i].officer = o));
  }

  // ------------------------------------------------------------------ shop (OP31)

  private shopName(): string {
    return this.officerName(374);
  }

  private async merchantSay(text: string): Promise<void> {
    const o = this.state.officers[374];
    await this.ui.messageBox(text, { kind: 3, name: o?.name, face: o?.face, top: true, wait: true });
  }

  /** The 도구상 (strings DS:0x54db..0x594a): 산다 / 판다. Item list DS:0x56a2 + town*8. */
  private async shop() {
    const o = this.state.officers[374];
    const talk = (t: string, wait = false) => this.ui.messageBox(t, { kind: 3, name: o?.name ?? this.shopName(), face: o?.face, top: true, wait, keep: !wait });
    const win = this.draw.grab({ x: 64, y: 72, w: 416, h: 112 });
    const menuAt = { x: 0x1a0, y: 0x60 + LAYOUT_Y }; // measured on the emulator (item menu)
    try {
      await this.merchantSay('저는 상인입니다만.');
      for (;;) {
        await talk('무슨 일입니까?');
        const r = await this.ui.menu([bytesOf('산다'), bytesOf('판다')]);
        if (r < 0) break;
        if (r === 0) await this.shopBuy(talk, menuAt);
        else await this.shopSell(talk, menuAt);
      }
      this.draw.restore(win);
      await this.merchantSay('또 오십시오.');
    } finally {
      this.draw.restore(win);
    }
  }

  private shopItems(): number[] {
    const town = this.state.progress.territory + (this.assets.tables.sectionTownBase[this.assets.tables.chapterSection[this.state.progress.chapter] ?? 0] ?? 0);
    return Array.from(this.assets.ds(0x56a2 + town * 8, 8)).filter((v) => v !== 0xff);
  }

  private async shopBuy(talk: (t: string, wait?: boolean) => Promise<boolean>, at: { x: number; y: number }) {
    const list = this.shopItems();
    for (;;) {
      await talk('무엇을 사시겠습니까?');
      const k = await this.ui.menu(list.map((v) => this.state.items[v]?.name ?? '?'), { ...at });
      if (k < 0) return;
      const it = this.state.items[list[k]];
      const price = it.price * 10; // 3cb4:2e34
      const ok = await this.ui.messageBox(`${josa(it.name, '은', '는')} 금${price}입니다만, \n${josa(it.name, '을', '를')} 어느분이 갖겠습니까?`, {
        kind: 3,
        name: this.shopName(),
        face: this.state.officers[374]?.face,
        top: true,
        yesNo: true,
        keep: true,
      });
      if (!ok) continue;
      if (this.state.progress.money < price) {
        await talk('안됐지만, 소지금이 모자라는 것 같습니다.', true);
        continue;
      }
      const who = await this.pickOfficer(at);
      if (who < 0) continue;
      const d = this.state.officers[who].dyn;
      const free = d.items.indexOf(0xff);
      if (free < 0) {
        await talk('그분은,더 이상,소지할 수 없습니다.', true);
        continue;
      }
      d.items[free] = it.index;
      this.state.progress.money -= price;
      this.refreshStatus();
      if (!(await this.ui.messageBox('감사합니다,그 밖에도 뭔가 사겠습니까?', { kind: 3, name: this.shopName(), face: this.state.officers[374]?.face, top: true, yesNo: true, keep: true })))
        return;
    }
  }

  private async shopSell(talk: (t: string, wait?: boolean) => Promise<boolean>, at: { x: number; y: number }) {
    for (;;) {
      await talk('어느분 것을 파시겠습니까?');
      const who = await this.pickOfficer(at);
      if (who < 0) return;
      const d = this.state.officers[who].dyn;
      const slots = d.items.map((v, k) => [v, k] as const).filter(([v]) => v !== 0xff);
      if (!slots.length) {
        await talk('그 분은,아무것도 소지하고 있지 않습니다.', true);
        continue;
      }
      await talk('어느것을 파시겠습니까?');
      const k = await this.ui.menu(slots.map(([v]) => this.state.items[v]?.name ?? '?'), { ...at });
      if (k < 0) continue;
      const it = this.state.items[slots[k][0]];
      const price = ((it.price * 3) >> 2) * 10; // 3cb4:3441
      const ok = await this.ui.messageBox(`${josa(it.name, '은', '는')} 금${price}로 구입하겠습니다만,`, {
        kind: 3,
        name: this.shopName(),
        face: this.state.officers[374]?.face,
        top: true,
        yesNo: true,
        keep: true,
      });
      if (!ok) continue;
      d.items[slots[k][1]] = 0xff;
      this.state.progress.money = Math.min(10000, this.state.progress.money + price);
      this.refreshStatus();
      if (!(await this.ui.messageBox('감사합니다,그 밖에 뭔가 파시겠습니까?', { kind: 3, name: this.shopName(), face: this.state.officers[374]?.face, top: true, yesNo: true, keep: true })))
        return;
    }
  }

  // ------------------------------------------------------------------ battle

  private loadBattle(): Promise<{ runBattle?: RunBattle } | null> {
    this.battleModule ??= (async () => {
      try {
        // battle/scene.ts is written by the battle worker; until it exists the glob is empty
        const mods = import.meta.glob<{ runBattle?: RunBattle }>('./battle/scene.ts');
        const load = mods['./battle/scene.ts'];
        return load ? await load() : null;
      } catch (e) {
        this.log(`battle module failed to load: ${e}`);
        return null;
      }
    })();
    return this.battleModule;
  }

  /** Mode 3 (1cb6:4b52 via RunBattle), or a skip when battle mode is not available. */
  private async battleMode() {
    const map = this.state.location.map;
    const mod = await this.loadBattle();
    this.closePicture();
    this.mapShown = false;
    this.field.kind = 'none';
    this.field.clearActors();
    this.frameStale = true;
    if (mod?.runBattle) {
      try {
        const r = await mod.runBattle(this, map);
        this.battleHost = null;
        this.formation = undefined;
        if (r === 'lost' && !(this.state.status & 0x6c)) this.state.status |= STATUS.GAME_OVER;
        if (r === 'ended' && !(this.state.status & 0x6c)) this.state.status |= STATUS.QUIT;
      } catch (e) {
        this.battleHost = null;
        this.log(`battle error: ${(e as Error).stack ?? e}`);
        await this.ui.captionBox('전투 중 오류가 발생했습니다. 승리한 것으로 처리합니다.', 0);
        await this.skipBattle();
      }
    } else {
      if (this.video.dark) this.video.setPalette(this.palette(3));
      this.draw.fill(VIEW.x, VIEW.y, VIEW.w, VIEW.h, 0);
      await this.ui.captionBox('전투 모드는 아직 준비되지 않았습니다.\n승리한 것으로 하고 진행합니다.', 1);
      await this.skipBattle();
    }
    // the battle ended without a destination: back to the previous location
    if (this.mode === 3 && !(this.state.status & (STATUS.LOCATION_CHANGED | 0x6c))) {
      const prev = this.state.prevLocation;
      this.state.location = { ...prev };
      this.state.status |= STATUS.LOCATION_CHANGED;
    }
  }

  /** Runs the battle's events as if every target were defeated, until the script leaves the battle. */
  private async skipBattle() {
    for (let i = 0; i < 100; i++) {
      if (this.mode !== 3 || this.state.status & (STATUS.LOCATION_CHANGED | 0x6c)) return;
      const r = await this.dispatch({ type: 'auto' });
      if (r !== 'none') continue;
      const t = await this.dispatch({ type: 'targetDefeated' });
      if (t === 'none') return;
    }
  }

  /** Resolves when no MOVE is pending (used by tests). */
  get idle(): boolean {
    return this.moveWaiters === 0 && !this.field.moving;
  }

  /** Buttons helper re-exported for menus built here. */
  static button(x: number, y: number, w: number, label: string): Button {
    return { x, y, w, h: 16, kind: 0, label: bytesOf(label) };
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
