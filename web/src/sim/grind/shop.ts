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
//   (2a. with opts.areaHeals, before the single heals: area heals (ab86 -> baf6, the user's 3x3 or
//      larger, no caster bonus): one troop scroll (원대서/원부서/원군서 0x2e..0x30) each for 유비 and
//      the next three, one morale scroll (평기서/활기서/용기서 0x31..0x33) for 유비, the strongest
//      that leaves 200 gold;)
//   (2b. before the single heals: one 폭탄 (0x21) when opts.bombItems >= 1 (an emergency tool,
//      not a plan: Sukwon, no bomb abuse) and the confusion items (농무서/기상서/호우서 0x2b..0x2d)
//      up to opts.confuseItems held in the party (see below);)
//   (the single heals and the cheap scrolls (3s) keep opts.healKeep gold;)
//   3. bombs (scrolls 0x22..0x2a, which hit through e91a and give hit exp) with what is left above
//      a reserve, one each for the party's officers with the highest intelligence;
//   (3s. with opts.scrolls = N instead: the namu.wiki 병법서 grind. Every party officer, lowest level
//      first, is filled up to N of the cheapest weakest scrolls (초열서 0x28 at 50 gold, then
//      소용돌이서 0x25, 낙석서 0x22). A bomb cannot miss and gets no counter, so each one is a sure
//      hit-exp action for an officer with no MP left; keeps 100 gold and 1 free slot. After the
//      heals: buying them first lost 서주 (the early gold, 200..800, does not cover both).)
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
export function shopVisit(
  state: GameState,
  shop: number[],
  opts: { reserve?: number; bombs?: boolean; areaHeals?: boolean; scrolls?: number; bombItems?: number; confuseItems?: number; healKeep?: number; promoLead?: number } = {},
): Purchase[] {
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
  // (1b. with opts.promoLead = N: the gold for the promotion items of the party members within N
  // levels of their promotion level (and not holding the item yet) is kept back from every buy
  // below, so it is there when a merchant sells them: Sukwon promotes whenever he can)
  const promoReserve = promotionReserve(state, team, opts.promoLead);
  const spendable = () => state.progress.money - promoReserve;
  const buyLesser = (o: number, id: number) => ((state.items[id]?.price ?? 0) * 10 <= spendable() ? buy(o, id) : false);
  // 2a. area heals first when asked (GrindParams.area): the gold goes to them before the single heals
  if (opts.areaHeals) {
    const pickArea = (lo: number, hi: number) =>
      shop.filter((id) => id >= lo && id <= hi).sort((a, b) => b - a).find((h) => state.progress.money - (state.items[h]?.price ?? 0xff) * 10 >= 200);
    for (const o of team.slice(0, 4)) {
      if (free(o) <= 2 || state.officers[o].dyn.items.some((v) => v >= 0x2e && v <= 0x30)) continue;
      const id = pickArea(0x2e, 0x30);
      if (id === undefined) break;
      buyLesser(o, id);
    }
    if (team.includes(0) && free(0) > 2 && !state.officers[0].dyn.items.some((v) => v >= 0x31 && v <= 0x33)) {
      const id = pickArea(0x31, 0x33);
      if (id !== undefined) buyLesser(0, id);
    }
  }
  // 2b. 폭탄 (0x21, 1350..1650 troops for sure, 1cb6:b029; 서주, at most one) and the confusion
  // items (0x2b..0x2d, a sure confusion; 북해): up to opts.bombItems / opts.confuseItems held in
  // the party, carried by the strongest (they are deployed), 200 gold kept. The policy keeps them
  // for emergencies (폭탄: one per battle, to save the leader).
  const stock = (lo: number, hi: number) => team.reduce((n, o) => n + state.officers[o].dyn.items.filter((v) => v >= lo && v <= hi).length, 0);
  const fill = (lo: number, hi: number, want: number, cheapest: boolean, keep = true) => {
    const ids = shop.filter((id) => id >= lo && id <= hi).sort((a, b) => (cheapest ? a - b : b - a));
    if (!ids.length || want <= 0) return;
    let n = stock(lo, hi);
    for (let pass = 0; pass < 8 && n < want; pass++)
      for (const o of team.slice(0, 6)) {
        if (n >= want) break;
        if (free(o) <= 1) continue;
        const id = ids.find((h) => state.progress.money - (state.items[h]?.price ?? 0xff) * 10 >= 200);
        if (id === undefined || !(keep ? buyLesser(o, id) : buy(o, id))) return;
        n++;
      }
  };
  // (the one emergency 폭탄 comes before the promotion reserve)
  fill(0x21, 0x21, Math.min(1, Math.round(opts.bombItems ?? 0)), false, false);
  fill(0x2b, 0x2d, Math.round(opts.confuseItems ?? 0), true);
  // 2. troop heals, the strongest the shop has that the gold allows
  const want = opts.scrolls === undefined || !Number.isFinite(opts.scrolls) ? -1 : Math.round(opts.scrolls);
  const heals = shop.filter((id) => TROOP_HEALS.includes(id)).sort((a, b) => healPower(b) - healPower(a) || b - a);
  const buyHeals = (who: number[]) => {
    if (!heals.length) return;
    const need = (o: number) => (o === 0 ? 2 : 1);
    for (const o of who) {
      let n = state.officers[o].dyn.items.filter((v) => TROOP_HEALS.includes(v)).length;
      while (n < need(o) && free(o) > 2) {
        const id = heals.find((h) => (state.items[h]?.price ?? 0xff) * 10 <= state.progress.money - (opts.healKeep ?? 0));
        if (id === undefined || !buyLesser(o, id)) break;
        n++;
      }
    }
  };
  const healed = team.slice(0, 12);
  buyHeals(healed);

  // 3s. cheap scrolls for everyone, lowest level first (GrindParams.scrolls; NaN/undefined = rule 3)
  if (want >= 0 && opts.bombs !== false) {
    const cheap = [0x28, 0x25, 0x22].filter((id) => shop.includes(id));
    const low = [...team].filter((o) => state.officers[o].dyn.level < 99).sort((a, b) => state.officers[a].dyn.level - state.officers[b].dyn.level || a - b);
    for (const o of low) {
      let n = state.officers[o].dyn.items.filter((v) => v >= 0x22 && v <= 0x2a).length;
      while (n < want && free(o) > 1) {
        const id = cheap.find((h) => state.progress.money - (state.items[h]?.price ?? 0xff) * 10 >= Math.max(100, opts.healKeep ?? 0));
        if (id === undefined || !buyLesser(o, id)) break;
        n++;
      }
    }
  }
  // 3. bombs with what is left above the reserve
  if (want < 0 && opts.bombs !== false) {
    const reserve = opts.reserve ?? 1500;
    const bombs = shop.filter((id) => id >= 0x22 && id <= 0x2a).sort((a, b) => ((b - 0x22) % 3) - ((a - 0x22) % 3) || b - a);
    const smart = [...team].sort((a, b) => state.officers[b].intelligence - state.officers[a].intelligence).slice(0, 6);
    for (const o of smart) {
      if (!bombs.length || free(o) <= 2 || state.officers[o].dyn.items.some((v) => v >= 0x22 && v <= 0x2a)) continue;
      const id = bombs.find((h) => state.progress.money - (state.items[h]?.price ?? 0xff) * 10 >= reserve);
      if (id === undefined) break;
      buyLesser(o, id);
    }
  }
  return out;
}

/** Gold kept for promotion items (1b): party members within `lead` levels of their promotion level
 * without the item yet; 0 when `lead` is not given. */
export function promotionReserve(state: GameState, team: number[], lead: number | undefined): number {
  if (lead === undefined || !Number.isFinite(lead) || lead < 0) return 0;
  let r = 0;
  for (const o of team) {
    const d = state.officers[o].dyn;
    for (let k = 0; k < 8; k++) {
      const id = 0x13 + k;
      if (d.cls !== PROMOTE_FROM[k] || d.level < PROMOTE_LEVEL[k] - lead || d.items.includes(id)) continue;
      r += (state.items[id]?.price ?? 0) * 10;
    }
  }
  return r;
}
