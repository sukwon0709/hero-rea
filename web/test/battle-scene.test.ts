// Battle scene (native mode): text helpers, the duel's random draws, and, with HERO_GAME_DIR, the
// prologue battle (사수관) played headless from a new game: deployment, autoplay to victory through
// the script's duel event, and the player phase driven by scripted clicks.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { euc, fmt } from '../src/native/battle/strings';
import { officerView } from '../src/native/battle/model';
import { duelClash } from '../src/native/battle/effects';
import { Rng } from '../src/engine/battle/rules';
import { AiMode, PLAYER_SLOTS, Status, UnitFlag } from '../src/engine/battle/types';
import type { Officer as StateOfficer } from '../src/engine/state';
import type { BattleScene } from '../src/native/battle/scene';
import { GAME_DIR, hasGame } from './gamedir';

const dec = (b: Uint8Array) => new TextDecoder('euc-kr').decode(b);

describe('battle text helpers', () => {
  it('encodes EUC-KR and formats like the original printf', () => {
    expect(dec(euc('유비 Lv'))).toBe('유비 Lv');
    expect(dec(fmt(euc('%s(는) %4u의 병력'), '관우', 66))).toBe('관우(는)   66의 병력');
    expect(dec(fmt(euc('%2u/%2u %d%%'), 3, 30, -1))).toBe(' 3/30 -1%');
  });

  it('maps a state officer onto the engine officer view', () => {
    const so = { leadership: 91, strength: 75, intelligence: 64, dyn: { troops: 300, items: [1, 255], level: 2, exp: 10, cls: 0 } };
    const o = officerView(so as unknown as StateOfficer);
    expect([o.lead, o.force, o.intel, o.hp]).toEqual([91, 75, 64, 300]);
    o.hp = 120;
    expect(so.dyn.troops).toBe(120);
  });
});

describe('duel (script op 34, 2cb4:1736)', () => {
  it('draws two rand(3) per round and one rand(2) per frame unless both rolled 8', async () => {
    const rng = new Rng(7);
    const ref = new Rng(7);
    let expected = 0;
    for (let r = 0; r < 5; r++) {
      const a = (ref.rand(3) + 2) * 2;
      const c = (ref.rand(3) + 2) * 2;
      expected += 2;
      if (a !== 8 || c !== 8)
        for (let f = 0; f < 2; f++) {
          ref.rand(2);
          expected++;
        }
    }
    let draws = 0;
    const counting = { rand: (n: number) => (draws++, rng.rand(n)) };
    const fake = { b: { rng: counting }, sfx() {}, v: { tick: 0 }, ctx: { ui: { frame: async () => {} } } };
    await duelClash(fake as unknown as BattleScene);
    expect(draws).toBe(expected);
    expect(rng.seed).toBe(ref.seed);
  });
});

// ------------------------------------------------------------------ with the game files

async function prologue(opts: { autoPlay?: boolean; bot?: boolean; seed?: number; goal?: boolean }) {
  const { DevAssets, buildContext } = await import('../src/native/battle/dev/context');
  const { DevUi } = await import('../src/native/battle/dev/ui');
  const { headlessScreen, ScriptedInput } = await import('../src/native/battle/dev/headless');
  const { listBattles, prepareBattle } = await import('../src/native/battle/dev/setup');
  const { BattleScene } = await import('../src/native/battle/scene');
  const { attachBot } = await import('../src/native/battle/dev/bot');
  const files = new Map<string, Uint8Array>();
  for (const f of readdirSync(GAME_DIR)) files.set(f.toUpperCase(), new Uint8Array(readFileSync(join(GAME_DIR, f))));
  const a = new DevAssets(files);
  const screen = headlessScreen();
  const input = new ScriptedInput();
  const log: string[] = [];
  const ui = new DevUi(screen, input.asInput(), a.font, { auto: true, log: (k, t) => log.push(`${k}: ${t}`) });
  const { ctx, host } = buildContext(a, -1, { screen, input: input.asInput(), ui });
  const entry = listBattles(a.chapter(0))[0];
  host.headless = true;
  const map = await prepareBattle(ctx.vm, entry);
  host.headless = false;
  const scene = new BattleScene(ctx, map, {
    rng: new Rng(opts.seed ?? 12345),
    autoPlay: opts.autoPlay,
    afterSetup: (sc) => {
      // 관우 heads for 화웅: their adjacency event (block 5 record 5) is the duel that ends the battle
      if (opts.goal) {
        sc.units[1].mode = AiMode.MoveTo;
        sc.units[1].target = sc.b.slotOfOfficer(5);
      }
    },
  });
  if (opts.bot) attachBot(scene, input, ui);
  return { scene, log, map, ctx };
}

describe.skipIf(!hasGame)('battle scene: prologue (사수관)', () => {
  it('deploys the units of the script (BATTLE_SETUP, 1cb6:3926)', async () => {
    const { scene, map } = await prologue({});
    expect(map).toBe(0);
    scene.b.setup();
    const field = scene.units.filter((u) => u.status === Status.Field);
    expect(field.filter((u) => u.slot < PLAYER_SLOTS).map((u) => u.officer)).toEqual([0, 1, 2]);
    const hx = scene.units[scene.b.slotOfOfficer(5)];
    expect(scene.b.officerOf(hx).cls).toBe(6);
    expect(scene.b.officerOf(hx).level).toBe(5);
    expect(hx.mode).toBe(AiMode.Hold);
    // record bit 2 clear = facing left (8d74); the player side starts facing left, the enemy right
    expect(scene.units[0].flags & UnitFlag.Facing).toBe(UnitFlag.Facing);
    expect(hx.flags & UnitFlag.Facing).toBe(0);
    expect(field.every((u) => u.flags & UnitFlag.Visible)).toBe(true);
    expect(scene.b.info.turnLimit).toBe(30);
  });

  it('is won by autoplay through the duel event', async () => {
    const { scene, log } = await prologue({ autoPlay: true, goal: true });
    const r = await scene.run();
    expect(r).toBe(2);
    expect(log.some((l) => l.includes('화웅'))).toBe(true);
    expect(scene.ctx.battleHost).toBeNull();
  }, 120_000);

  it('plays the player phase from scripted clicks', async () => {
    const { scene, log } = await prologue({ bot: true });
    const r = await scene.run();
    expect([2, 3]).toContain(r);
    expect(log.filter((l) => l.startsWith('menu: ')).length).toBeGreaterThan(5);
    expect(log.some((l) => l.includes('병력을 잃었다'))).toBe(true);
  }, 120_000);
});

describe.skipIf(!hasGame)('battle scene: area heal items (ab86 -> baf6)', () => {
  it('heals the troops / morale of every ally in the area, no exp, item used up', async () => {
    const { maxHp } = await import('../src/engine/battle/rules');
    const { unitAt } = await import('../src/engine/battle/hex');
    const { NONE } = await import('../src/engine/battle/types');
    const { scene } = await prologue({});
    const b = scene.b;
    b.setup();
    const u = scene.units[0];
    // bring 관우 and 장비 next to 유비 (area 1 = the user's cell and its neighbours)
    const free = [[u.x + 1, u.y], [u.x - 1, u.y], [u.x, u.y + 1], [u.x, u.y - 1]].filter(
      ([x, y]) => x >= 0 && y >= 0 && x < b.width && y < b.height && unitAt(b.s, x, y) === NONE,
    );
    expect(free.length).toBeGreaterThanOrEqual(2);
    b.place(1, null, free[0][0], free[0][1]);
    b.place(2, null, free[1][0], free[1][1]);
    const so = b.stateOfficer(u);
    const exp0 = [0, 1, 2].map((s) => b.stateOfficer(scene.units[s]).dyn.exp);
    // 원부서 (0x2f): troops, power 1 -> (1+1)*600 + rand(120), capped at the missing troops
    for (const s of [0, 1, 2]) b.officerOf(scene.units[s]).hp = 50;
    so.dyn.items[0] = 0x2f;
    expect(await scene.useItem(0, 0x2f, 0)).toBe(true);
    expect(so.dyn.items[0]).toBe(0xff);
    for (const s of [0, 1, 2]) {
      const o = b.officerOf(scene.units[s]);
      expect(o.hp - 50).toBeGreaterThanOrEqual(Math.min(1200, maxHp(o) - 50));
      expect(o.hp - 50).toBeLessThanOrEqual(1319);
    }
    // 활기서 (0x32): morale, power 1 -> (1+3)*10 + rand(4)
    for (const s of [0, 1, 2]) scene.units[s].morale = 40;
    so.dyn.items[1] = 0x32;
    expect(await scene.useItem(0, 0x32, 1)).toBe(true);
    expect(so.dyn.items[1]).toBe(0xff);
    for (const s of [0, 1, 2]) {
      expect(scene.units[s].morale).toBeGreaterThanOrEqual(80);
      expect(scene.units[s].morale).toBeLessThanOrEqual(83);
    }
    // items give no exp
    expect([0, 1, 2].map((s) => b.stateOfficer(scene.units[s]).dyn.exp)).toEqual(exp0);
  }, 60_000);
});
