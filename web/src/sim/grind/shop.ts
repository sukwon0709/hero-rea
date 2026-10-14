// Grinding simulator, part 9: the merchant (도구상, OP31). Between battles the player can buy at the
// shop of a town whose current event group has a merchant (the harness reports those through
// PlaythroughOptions.onShop with the town's item list, DS:0x56a2 + town*8). Buying follows
// Game.shopBuy exactly: the price is item.price * 10, the item goes into the buyer's first free slot
// of 8, and the gold is taken. What to buy, in order:
//   1. promotion items (0x13..0x1a: 장창, 보병차, 연노, 투석기, 마개, 근위개, 무술교본, 의협교본) for
//      every officer of the party whose class they promote and who has the level for it (or is
//      within 3 levels of it), highest level first; they are used in the next battle (ab86);
//   2. troop heals (콩/보리/쌀 0x1e..0x20, 상약/한방약/차 0x34..0x36): two for 유비, one for each
//      of the party's strongest officers, the best one the gold allows;
//   3. bombs (scrolls 0x22..0x2a, which hit through e91a and give hit exp) with what is left above
//      a reserve, one each for the party's officers with the highest intelligence.
// Weapons, armour and horses are never sold in this game (story items only).

import type { GameState } from '../../engine/state';
import { PROMOTE_FROM, PROMOTE_LEVEL } from './policy';

export interface Purchase {
  officer: number;
  item: number;
  price: number;
}

/** Game.shopBuy (3cb4:2e34): price*10, first free slot, gold taken. False when it cannot be done. */
export function buyItem(state: GameState, officer: number, item: number): boolean {
  const it = state.items[item];
  const d = state.officers[officer]?.dyn;
  if (!it || !d || it.price === 0xff) return false;
  const price = it.price * 10;
  if (state.progress.money < price) return false;
  const free = d.items.indexOf(0xff);
  if (free < 0) return false;
  d.items[free] = it.index;
  state.progress.money -= price;
  return true;
}

const TROOP_HEALS = [0x1e, 0x1f, 0x20, 0x34, 0x35, 0x36];
const healPower = (id: number) => (id >= 0x34 ? id - 0x34 : id % 3);

/** The party the purchases are for: 유비's faction, active, named; 유비 first, then by level. */
export function party(state: GameState): number[] {
  const faction = state.officers[0].dyn.flags & 0x1f;
  return state.officers
    .map((o, i) => ({ o, i }))
    .filter(({ o, i }) => i < 0x100 && (o.dyn.flags & 0x80) !== 0 && (o.dyn.flags & 0x1f) === faction)
    .sort((a, b) => (a.i === 0 ? -1 : b.i === 0 ? 1 : b.o.dyn.level - a.o.dyn.level || a.i - b.i))
    .map(({ i }) => i);
}

/** One visit: buys by the rules above from `shop` (item ids). Returns what was bought. */
export function shopVisit(state: GameState, shop: number[], opts: { reserve?: number; bombs?: boolean } = {}): Purchase[] {
  const out: Purchase[] = [];
  const has = (o: number, id: number) => state.officers[o].dyn.items.includes(id);
  const free = (o: number) => state.officers[o].dyn.items.filter((v) => v === 0xff).length;
  const buy = (o: number, id: number) => {
    const price = (state.items[id]?.price ?? 0) * 10;
    if (buyItem(state, o, id)) {
      out.push({ officer: o, item: id, price });
      return true;
    }
    return false;
  };
  const team = party(state);
  // 1. promotions
  for (const o of team) {
    const d = state.officers[o].dyn;
    for (let k = 0; k < 8; k++) {
      const id = 0x13 + k;
      if (!shop.includes(id) || d.cls !== PROMOTE_FROM[k] || d.level < PROMOTE_LEVEL[k] - 3 || has(o, id)) continue;
      buy(o, id);
    }
  }
  // 2. troop heals, the strongest the shop has that the gold allows
  const heals = shop.filter((id) => TROOP_HEALS.includes(id)).sort((a, b) => healPower(b) - healPower(a) || b - a);
  if (heals.length) {
    const want = (o: number) => (o === 0 ? 2 : 1);
    for (const o of team.slice(0, 12)) {
      let n = state.officers[o].dyn.items.filter((v) => TROOP_HEALS.includes(v)).length;
      while (n < want(o) && free(o) > 2) {
        const id = heals.find((h) => (state.items[h]?.price ?? 0xff) * 10 <= state.progress.money);
        if (id === undefined || !buy(o, id)) break;
        n++;
      }
    }
  }
  // 3. bombs with what is left above the reserve
  if (opts.bombs !== false) {
    const reserve = opts.reserve ?? 1500;
    const bombs = shop.filter((id) => id >= 0x22 && id <= 0x2a).sort((a, b) => ((b - 0x22) % 3) - ((a - 0x22) % 3) || b - a);
    const smart = [...team].sort((a, b) => state.officers[b].intelligence - state.officers[a].intelligence).slice(0, 6);
    for (const o of smart) {
      if (!bombs.length || free(o) <= 2 || state.officers[o].dyn.items.some((v) => v >= 0x22 && v <= 0x2a)) continue;
      const id = bombs.find((h) => state.progress.money - (state.items[h]?.price ?? 0xff) * 10 >= reserve);
      if (id === undefined) break;
      buy(o, id);
    }
  }
  return out;
}
