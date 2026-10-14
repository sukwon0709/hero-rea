// Grinding simulator, part 8: reports. progress.json / progress.html (learning curve and the rules
// read off the best parameters and off top-vs-bottom runs), results.json and guide.md (the per-battle
// grinding guide, in Korean). Only names and numbers from the game appear (officers, battles,
// tactic names); no game text is copied.

import { PARAM_SPECS, type GrindParams, type ParamKey } from './policy';
import { paramCorrelations, type EvolveState } from './evolve';
import type { RealRunResult } from './realrun';
import type { CampaignBattle, CampaignResult } from './campaign';

/** Tactic names, filled by the caller from MAIN.EXE (DS:0x4438) when the game files are at hand. */
export const tacticNames: Map<number, string> = new Map();
const tname = (t: number | string) => tacticNames.get(Number(t)) ?? `책략${t}`;
/** Item names (BAKDATA), filled by the caller. */
export const itemNames: Map<number, string> = new Map();
const iname = (i: number) => itemNames.get(i) ?? `도구${i}`;
function boughtText(p: { item: number }[] | undefined): string {
  if (!p?.length) return '';
  const m = new Map<number, number>();
  for (const x of p) m.set(x.item, (m.get(x.item) ?? 0) + 1);
  return [...m.entries()].map(([i, n]) => `${iname(i)}${n > 1 ? '×' + n : ''}`).join(', ');
}

const PARAM_KO: Record<ParamKey, string> = {
  need: '저레벨 우선 가중치',
  keep: '살려 두는 적 수',
  finish: '마무리 시작(남은 턴)',
  tactic: '책략 경험치 가중',
  heal: '회복 책략 가중',
  kill: '처치 보너스 가중',
  conserve: '적 병력 아끼기',
  mp: 'MP 절약',
  risk: '위험 회피',
  retreat: '후퇴 기준 병력비',
  approach: '접근 성향',
  strong: '출진 고정 강자 수',
  guard: '유비 노출 한도(최악 피해/병력)',
  escort: '유비 곁에 모이기',
};

const f1 = (v: number) => (Math.round(v * 100) / 100).toString();

// ---------------------------------------------------------------- learned rules

export function learnedRules(st: EvolveState): string[] {
  const out: string[] = [];
  const b = st.best?.params;
  if (!b) return out;
  out.push(`적을 항상 ${b.keep}명 이상 남겨 둔다: 마지막 적·승리조건 장수(총대장)는 마무리 단계 전까지 공격하지 않는다.`);
  out.push(`제한 턴 ${b.finish}턴 전부터(또는 출진 장수가 모두 Lv99가 되면) 승리 조건을 노린다.`);
  out.push(
    b.need >= 1
      ? `경험치는 레벨이 낮은 장수 순서로 행동시켜 몰아준다(가중치 ${f1(b.need)}: Lv1 장수의 경험치를 Lv99 직전 장수의 약 ${f1(1 + b.need)}배로 평가).`
      : `레벨 차이를 크게 따지지 않고 그때그때 경험치가 큰 행동을 고른다(가중치 ${f1(b.need)}).`,
  );
  out.push(
    `혼란·사기저하·회복 책략은 성공/실패와 관계없이 +8(군악대·수송대의 단일 회복은 +12)이므로 MP가 남아 있으면 매 턴 사용한다(책략 가중 ${f1(b.tactic)}, 회복 가중 ${f1(b.heal)}). 가장 싼 책략(MP 4)부터 쓴다.`,
  );
  out.push(
    b.conserve >= 0.8
      ? `적 병력을 아낀다(가중 ${f1(b.conserve)}): 큰 피해를 주는 공격보다 피해가 작은 공격·책략으로 경험치를 얻고, 병력이 바닥난 적은 혼란/사기저하 대상으로 돌린다.`
      : `적 병력을 크게 아끼지 않는다(가중 ${f1(b.conserve)}): 적이 충분히 많은 전투에서는 그냥 때리는 편이 낫다.`,
  );
  out.push(
    b.kill >= 0.8
      ? `처치 보너스(32/48)를 적극 노린다: 막타는 레벨이 가장 낮은 장수에게 준다.`
      : `처치는 서두르지 않는다(가중 ${f1(b.kill)}): 처치 보너스보다 그 적에게서 앞으로 얻을 타격 경험치가 더 크다.`,
  );
  out.push(`출진 편성: ${b.strong}명은 최고 레벨 장수로 채워 승리를 보장하고, 나머지는 레벨이 가장 낮은 장수(Lv99 제외)로 채운다.`);
  out.push(`병력이 ${Math.round(b.retreat * 100)}% 미만인 장수는 마을·성채·병영 칸으로 물러나 회복한다. 유비와 패배조건 장수는 반격·포위로 쓰러질 위험이 있는 칸에 서지 않는다.`);
  // top vs bottom
  const corr = paramCorrelations(st);
  for (const s of PARAM_SPECS) {
    const c = corr[s.key];
    if (!c || Math.abs(c.corr) < 0.3) continue;
    out.push(
      `${PARAM_KO[s.key]}: 상위 25% 실행의 평균 ${f1(c.top)} vs 하위 25% ${f1(c.bottom)} (점수와의 상관 ${f1(c.corr)}) → ${c.corr > 0 ? '높을수록' : '낮을수록'} 좋았다.`,
    );
  }
  return out;
}

/** Facts read off the best campaign: who keeps what alive, what share of exp comes from where. */
export function campaignFacts(c: CampaignResult | { battles: CampaignBattle[] }): string[] {
  const out: string[] = [];
  let hits = 0, kills = 0, tac = 0, heals = 0;
  for (const b of c.battles) for (const g of b.gains) (hits += g.hits), (kills += g.kills), (tac += g.tactics), (heals += g.heals);
  const tot = hits + kills + tac + heals || 1;
  out.push(
    `경험치 출처: 타격 ${Math.round((hits * 100) / tot)}%, 처치 ${Math.round((kills * 100) / tot)}%, 공격·상태 책략 ${Math.round((tac * 100) / tot)}%, 회복 책략 ${Math.round((heals * 100) / tot)}%.`,
  );
  const tacCount = new Map<string, number>();
  for (const b of c.battles) for (const [t, n] of Object.entries(b.tactics)) tacCount.set(t, (tacCount.get(t) ?? 0) + n);
  const topT = [...tacCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topT.length) out.push(`가장 많이 쓴 책략: ${topT.map(([t, n]) => `${tname(t)} ${n}회`).join(', ')}.`);
  const forced = c.battles.filter((b) => b.forced);
  if (forced.length) out.push(`정책으로 이기지 못한 전투(강제 진행): ${forced.map((b) => b.name).join(', ')}.`);
  return out;
}

// ---------------------------------------------------------------- progress

/** Korean sentence per parameter for a move up / down (what the move means for play). */
const MOVE_KO: Record<ParamKey, [string, string]> = {
  need: ['레벨이 낮은 장수에게 경험치를 더 몰아주는 게 유리하다고 배움', '레벨 차이보다 그때그때 큰 경험치를 고르는 게 낫다고 배움'],
  keep: ['적을 더 많이 남겨 두는 게(사냥감 확보) 유리하다고 배움', '적을 덜 남기고 정리해도 손해가 적다고 배움'],
  finish: ['승리 조건을 더 일찍(제한 턴 여유를 두고) 노리는 게 안전하다고 배움', '마무리를 더 늦게 시작해 턴을 끝까지 쓰는 게 이득이라고 배움'],
  tactic: ['책략(+8 고정 경험치)을 더 자주 쓰는 게 유리하다고 배움', '책략보다 직접 공격이 낫다고 배움'],
  heal: ['회복 책략으로 경험치를 버는 게 유리하다고 배움', '회복 책략 비중을 줄이는 게 낫다고 배움'],
  kill: ['처치 보너스를 더 적극적으로 노리는 게 유리하다고 배움', '처치를 미루고 타격 경험치를 더 오래 뽑는 게 낫다고 배움'],
  conserve: ['적 병력을 아껴(약하게 때려) 오래 사냥하는 게 유리하다고 배움', '적 병력을 아낄 필요가 적다고 배움'],
  mp: ['MP를 아껴 두는 게 낫다고 배움', 'MP를 아끼지 말고 바로 쓰는 게 낫다고 배움'],
  risk: ['위험한 칸을 더 피하는 게 낫다고 배움(패배·퇴각 손실이 큼)', '위험을 조금 감수하고 적에게 붙는 게 이득이라고 배움'],
  retreat: ['병력이 줄면 더 일찍 물러나 회복하는 게 낫다고 배움', '후퇴를 늦추고 계속 싸우는 게 낫다고 배움'],
  approach: ['적에게 더 빨리 다가가는 게 유리하다고 배움', '천천히 다가가 적이 오게 하는 게 낫다고 배움'],
  strong: ['고레벨 장수를 더 많이 출진시켜 승리를 보장하는 게 낫다고 배움', '저레벨 장수를 더 많이 출진시켜 경험치를 나누는 게 낫다고 배움'],
  guard: ['유비를 조금 더 앞에 세워도 된다고 배움', '유비를 더 뒤에 두는 게 안전하다고 배움'],
  escort: ['다른 장수들이 유비 곁에서 싸우는 게(유비 보호·막타 기회) 낫다고 배움', '유비와 떨어져 각자 사냥하는 게 낫다고 배움'],
};

function fmtP(key: ParamKey, v: number) {
  const s = PARAM_SPECS.find((x) => x.key === key)!;
  return s.int ? String(Math.round(v)) : f1(v);
}

/** Notable moves of the parameter mean between generations, as Korean sentences. */
export function parameterMoves(st: EvolveState): { gen: number; key: ParamKey; from: number; to: number; text: string }[] {
  const out: { gen: number; key: ParamKey; from: number; to: number; text: string }[] = [];
  let prev: GrindParams | undefined = st.start;
  for (const h of st.history) {
    if (prev)
      for (const s of PARAM_SPECS) {
        const a = prev[s.key], b = h.meanParams[s.key];
        const moved = s.int ? Math.round(a) !== Math.round(b) : Math.abs(b - a) >= 0.12 * (s.max - s.min);
        if (!moved) continue;
        const [up, down] = MOVE_KO[s.key];
        out.push({ gen: h.gen, key: s.key, from: a, to: b, text: `${PARAM_KO[s.key]} ${fmtP(s.key, a)}→${fmtP(s.key, b)}: ${b > a ? up : down}` });
      }
    prev = h.meanParams;
  }
  return out;
}

/** The generation in progress (written after every candidate). */
export interface LiveStatus {
  gen: number;
  done: number;
  total: number;
  startedAt: number;
  /** Battles finished so far by each candidate's campaign. */
  battles: number[];
  battleCount: number;
  candidates: { objective: number; n99: number; top15: number; wins: number; forced: number; seconds: number }[];
}

/** One campaign from the plain defaults vs one from defaults + the hints.json defaults (cli ab). */
export interface HintAb {
  hint: Partial<GrindParams>;
  date: string;
  without: AbSide;
  with: AbSide;
}
interface AbSide {
  params: GrindParams;
  n99: number;
  top15: number;
  wins: number;
  forced: number;
  heals: number;
  tactics: number;
  healExp: number;
  exp: number;
  seconds: number;
  roster: { name: string; level: number }[];
}

function abHtml(ab: HintAb | undefined, st: EvolveState): string {
  const corr = paramCorrelations(st).heal;
  const last = st.history[st.history.length - 1];
  const learned = st.start && last
    ? `<p>학습 경과: 회복 가중(heal)은 시작값 ${f1(st.start.heal)}에서 현재 분포 평균 ${f1(last.meanParams.heal)}${st.best ? `, 최고 실행 ${f1(st.best.params.heal)}` : ''}${corr ? ` (지금까지 모든 후보에서 점수와의 상관 ${f1(corr.corr)})` : ''}. 학습이 힌트를 유지하면 이 값이 높게 남고, 손해라고 판단하면 내려간다.</p>`
    : '';
  if (!ab) return `<div class="card"><p class="dim">힌트 비교 실행(<code>cli.ts ab</code>)이 아직 없습니다.</p>${learned}</div>`;
  const row = (t: string, f: (x: AbSide) => string | number) => `<tr><td>${t}</td><td class="num">${f(ab.without)}</td><td class="num">${f(ab.with)}</td></tr>`;
  return `<div class="card"><p>힌트: <code>${esc(JSON.stringify(ab.hint))}</code>. 같은 탐색 시드·같은 예산으로 게임 전체를 두 번 시뮬레이션(학습 없이 시작값 그대로)한 비교.</p>
<table><tr><th></th><th class="num">힌트 없음(기본값)</th><th class="num">힌트 적용</th></tr>
${row('Lv99 장수', (x) => x.n99)}${row('상위 15명 레벨 합', (x) => x.top15)}${row('정책 승리 / 강제 진행', (x) => `${x.wins} / ${x.forced}`)}
${row('회복 책략 사용(회)', (x) => x.heals)}${row('회복으로 얻은 경험치', (x) => x.healExp)}${row('공격·상태 책략(회)', (x) => x.tactics)}${row('총 경험치', (x) => x.exp)}
${row('상위 장수', (x) => esc(x.roster.slice(0, 6).map((r) => `${r.name}${r.level}`).join(' ')))}</table>${learned}</div>`;
}

export interface BenchRow {
  index: number;
  name: string;
  mode: 'policy' | 'ai';
  wins: number;
  tries: number;
  reasons: Record<string, number>;
  exp: number;
}
export interface Bench {
  label: string;
  date: string;
  seeds: number;
  rows: BenchRow[];
}

function benchHtml(benches: Bench[]): string {
  if (!benches.length) return '<div class="card"><p class="dim">아직 측정 없음(<code>cli.ts bench --label before</code>).</p></div>';
  const keys = [...new Map(benches.flatMap((b) => b.rows.map((r) => [`${r.index}|${r.mode}`, r] as const))).values()];
  const head = benches.map((b) => `<th class="num">${esc(b.label)}<br><span class="dim">${b.date.slice(5, 16).replace('T', ' ')}</span></th>`).join('');
  const rows = keys
    .map((k) => {
      const cells = benches
        .map((b) => {
          const r = b.rows.find((x) => x.index === k.index && x.mode === k.mode);
          if (!r) return '<td></td>';
          const why = Object.entries(r.reasons).sort((x, y) => y[1] - x[1]).map(([w, n]) => `${w} ×${n}`).join(', ');
          return `<td class="num"><b>${r.wins}/${r.tries}</b>${why ? `<br><span class="dim">${esc(why)}</span>` : ''}</td>`;
        })
        .join('');
      return `<tr><td>${k.index + 1}. ${esc(k.name)}</td><td>${k.mode === 'ai' ? '게임 AI' : '노가다 정책'}</td>${cells}</tr>`;
    })
    .join('');
  return `<div class="card"><p>같은 출발 레벨(기준 캠페인의 그 전투 시작 시점)에서 난수 시드만 바꿔 여러 번 싸운 승리 수. 왼쪽이 이전, 오른쪽이 나중 측정(전투 정책 수정 전후).</p><table><tr><th>전투</th><th>방식</th>${head}</tr>${rows}</table></div>`;
}

export function progressJson(st: EvolveState, live?: LiveStatus, ab?: HintAb, benches: Bench[] = []) {
  return {
    benches,
    hintAb: ab ?? null,
    updated: new Date().toISOString(),
    running: live ?? null,
    start: st.start ?? null,
    generations: st.history.map((h) => ({
      gen: h.gen,
      seconds: Math.round(h.ms / 100) / 10,
      best: h.best,
      mean: Math.round(h.mean),
      bestN99: h.bestN99,
      pop: h.pop ?? h.candidates.length,
      frozen: h.frozen ?? [],
      candidates: h.candidates.map((c) => ({ objective: c.objective, n99: c.n99, top15: c.top15, wins: c.wins, forced: c.forced, seconds: Math.round(c.ms / 100) / 10, params: c.params })),
      meanParams: h.meanParams,
      stdParams: h.stdParams,
      eliteChanges: (h.eliteChanges ?? []).map((e) => ({ battle: e.battle, name: e.name, from: e.from, to: e.to })),
    })),
    moves: parameterMoves(st),
    best: st.best
      ? {
          params: st.best.params,
          objective: st.best.result.objective,
          n99: st.best.result.n99,
          top15: st.best.result.top15,
          wins: st.best.result.wins,
          forced: st.best.result.forced,
          roster: st.best.campaign.roster,
          battles: st.best.campaign.battles.map((b) => ({ index: b.index, name: b.name, won: b.won, forced: b.forced, turns: b.turns, turnLimit: b.turnLimit, expTotal: b.expTotal, keep: b.params.keep, rerolls: b.params.rerolls ?? 0, native: !!b.params.native, lossReasons: b.lossReasons ?? null, tries: b.variantsTried, attempts: b.attempts ?? null, bought: boughtText(b.purchases), promoted: b.actions.promoted ?? 0, items: b.actions.item ?? 0 })),
        }
      : null,
    rules: learnedRules(st),
    facts: st.best ? campaignFacts(st.best.campaign) : [],
    objective: 'Lv99 장수 수 × 100000 + 상위 15명 레벨 합 × 10 + 전체 장수가 얻은 레벨 수',
    paramSpecs: PARAM_SPECS.map((s) => ({ key: s.key, label: PARAM_KO[s.key], min: s.min, max: s.max, int: !!s.int })),
  };
}

function lossSummary(battles: { won: boolean; lossReasons: Record<string, number> | null }[]): string {
  const m = new Map<string, number>();
  for (const b of battles) {
    if (b.won || !b.lossReasons) continue;
    // the main reason of each forced battle
    const top = Object.entries(b.lossReasons).sort((x, y) => y[1] - x[1])[0];
    if (!top) continue;
    const key = top[0].replace(/ · .*$/, '').replace(/ \(게임 AI\)$/, '');
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}전투`).join(', ') || '없음';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const HINTS_EXAMPLE = `{
  "defaults": { "keep": 3, "need": 2.0 },
  "battles": {
    "사수관": { "finish": 10, "rerolls": 2 },
    "5": { "strong": 5, "risk": 2.5 }
  }
}`;

export function progressHtml(st: EvolveState, live?: LiveStatus, ab?: HintAb, benches: Bench[] = []): string {
  const data = progressJson(st, live, ab, benches);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const rules = [...data.rules, ...data.facts].map((r) => `<li>${esc(r)}</li>`).join('\n');
  const roster = (data.best?.roster ?? [])
    .slice(0, 30)
    .map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.level}</td><td class="num">${r.reached99At ?? ''}</td></tr>`)
    .join('');
  const params = data.best
    ? PARAM_SPECS.map((s) => `<tr><td>${PARAM_KO[s.key]} <span class="dim">(${s.key})</span></td><td class="num">${fmtP(s.key, data.best!.params[s.key])}</td><td class="dim">${s.min}–${s.max}</td></tr>`).join('')
    : '';
  const moves = data.moves.length
    ? data.moves.map((m) => `<li><b>세대 ${m.gen}</b> · ${esc(m.text)}</li>`).join('')
    : '<li>아직 눈에 띄는 변화가 없습니다(첫 세대가 끝나면 채워집니다).</li>';
  const keys = PARAM_SPECS.map((s) => s.key);
  const diff = (a: GrindParams | null, b: GrindParams | null) => {
    if (!a) return '새 작전';
    if (!b) return '작전 삭제(이 세대 최고 실행에서 패배)';
    const d = keys.filter((k) => fmtP(k, a[k]) !== fmtP(k, b[k])).map((k) => `${k} ${fmtP(k, a[k])}→${fmtP(k, b[k])}`);
    if ((a.rerolls ?? 0) !== (b.rerolls ?? 0)) d.push(`총퇴각 ${a.rerolls ?? 0}→${b.rerolls ?? 0}`);
    return d.join(', ') || '같음';
  };
  const elites = data.generations
    .flatMap((g) => g.eliteChanges.map((e) => `<tr><td>${g.gen}</td><td>${e.battle + 1}. ${esc(e.name)}</td><td>${esc(diff(e.from, e.to))}</td></tr>`))
    .join('');
  const battles = (data.best?.battles ?? [])
    .map((b) => `<tr><td>${b.index + 1}</td><td>${esc(b.name)}</td><td>${b.won ? '승리' : b.forced ? '<span class="bad">강제 진행</span>' : '패배'}</td><td class="num">${b.turns}/${b.turnLimit}</td><td class="num">${b.expTotal}</td><td class="num">${b.native ? '-' : b.keep}</td><td class="num">${b.rerolls}</td><td>${b.won ? (b.native ? '자동(게임 AI)' : '노가다 정책') : ''}</td><td class="num">${b.won ? b.attempts ?? '' : ''}</td><td class="dim">${esc(b.bought)}${b.promoted ? ` · 승진 ${b.promoted}` : ''}${b.items ? ` · 도구 사용 ${b.items}` : ''}</td><td class="dim">${b.lossReasons ? esc(Object.entries(b.lossReasons).sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r} ×${n}`).join(', ')) : ''}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>노가다 학습 진행</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--dim:#6b6b66;--card:#fff;--line:#e2e2dc;--a:#2f6fdd;--b:#d9822b;--c:#2e9d6a;--bad:#c4372f;--band:rgba(47,111,221,.15)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ecece8;--dim:#9a9a94;--card:#21211f;--line:#34342f;--a:#6aa0ff;--b:#f0a65a;--c:#5cc796;--bad:#ff7a70;--band:rgba(106,160,255,.18)}}
:root[data-theme="dark"]{--bg:#161615;--fg:#ecece8;--dim:#9a9a94;--card:#21211f;--line:#34342f;--a:#6aa0ff;--b:#f0a65a;--c:#5cc796;--bad:#ff7a70;--band:rgba(106,160,255,.18)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}h3{font-size:15px;margin:14px 0 4px}
.dim{color:var(--dim)}.bad{color:var(--bad)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0;overflow-x:auto}
.kpis{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px}.kpi{flex:1 1 140px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.kpi b{display:block;font-size:24px}table{border-collapse:collapse;width:100%}td,th{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums}svg{width:100%;height:auto}svg text{fill:var(--dim);font-size:11px}
.legend span{display:inline-block;margin-right:14px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
li{margin:4px 0}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:640px){.grid2{grid-template-columns:1fr}}
.minis{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}.mini{border:1px solid var(--line);border-radius:8px;padding:6px 8px}
.mini .t{font-size:12px}.mini svg text{font-size:10px}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font-size:13px}
.live{border-left:4px solid var(--c)}code{font-size:13px}
</style></head><body><main>
<h1>노가다(레벨 올리기) 학습 진행</h1>
<div class="dim">목표: Lv99에 도달한 장수 수를 최대화(동점이면 상위 15명 레벨 합). 점수 = Lv99 장수 수 × 100000 + 상위 15명 레벨 합 × 10 + 모든 장수가 이번 실행에서 얻은 레벨 수(경험치/100). 이 페이지는 세대가 끝날 때마다(그리고 후보 하나가 끝날 때마다) 다시 쓰이고, 열어 두면 60초마다 새로 고칩니다.</div>
<div id="live"></div>
<div class="kpis" id="kpis"></div>
<h2>세대별 개선</h2>
<div class="card"><div class="legend"><span><i class="sw" style="background:var(--a)"></i>세대 최고</span><span><i class="sw" style="background:var(--b)"></i>세대 평균</span><span><i class="sw" style="background:var(--c)"></i>Lv99 장수 수(최고 실행, 오른쪽 축)</span></div><svg id="chart" viewBox="0 0 900 300" role="img" aria-label="세대별 점수"></svg>
<p class="dim">점수 = Lv99 장수 수 × 100000 + 상위 15명 레벨 합 × 10 + 모든 장수가 얻은 레벨 수. 예: 5866 = Lv99 0명, 상위 15명 레벨 합 578(×10 = 5780), 얻은 레벨 86. (이전 실행의 progress 파일은 "Lv99 × 10000 + 상위 15명 레벨 합" 척도였기 때문에 578처럼 보였다. 이 페이지는 새 척도로만 그린다.)</p></div>

<h2>어떻게 배우나</h2>
<div class="card">
<ol>
<li><b>정책</b>: 전투마다 아군 행동을 고르는 규칙 기반 봇. ${PARAM_SPECS.length}개의 숫자(아래 파라미터)가 성향을 정한다: 적을 몇 명 남길지(keep), 제한 턴 몇 턴 전부터 승리를 노릴지(finish), 저레벨 장수에게 얼마나 몰아줄지(need), 책략·회복·처치를 얼마나 중시할지, 위험을 얼마나 피할지, 다른 장수가 유비 곁에 모일지(escort) 등. 전투 규칙·난수는 웹 포트의 실제 전투 엔진을 그대로 쓴다(헤드리스).</li>
<li><b>한 후보 = 게임 전체</b>: 파라미터 한 벌로 서장부터 엔딩까지 모든 전투(${st.best?.campaign.battles.length ?? 48}개)를 이어서 플레이한다. 앞 전투에서 오른 레벨이 다음 전투로 넘어간다. 전투마다 기본 파라미터 외에 변형 몇 개(공격적 변형, 돌연변이, 총퇴각으로 난수 다시 굴리기)를 시험해 가장 경험치가 많은 승리를 고른다.</li>
<li><b>교차 엔트로피 탐색(CEM)</b>: 세대마다 현재 평균·표준편차의 정규분포에서 후보를 뽑아 전부 플레이하고, 점수 상위 1/3의 평균 쪽으로 분포를 옮긴다(새 값 70% + 이전 30%). 표준편차가 줄어들수록 "확신"이 생긴 것. 지금까지의 최고 후보는 항상 다음 세대에 다시 들어간다.</li>
<li><b>전투별 최고 작전(엘리트)</b>: 최고 실행에서 각 전투가 쓴 파라미터를 저장해 두고, 다음 세대의 그 전투 탐색에서 먼저 시험하고 주변을 돌연변이시킨다.</li>
<li><b>공통 난수(CRN)</b>: 한 세대의 모든 후보는 같은 탐색 시드로 평가한다. 점수 차이가 운이 아니라 파라미터 차이에서 나오도록.</li>
<li><b>커리큘럼</b>: 이야기 순서대로, 엘리트 작전이 2세대 연속 유지된 앞쪽 전투는 "고정"되어 그 작전만 다시 돌린다(탐색 비용 절약). 고정된 전투에서 작전이 지면 다시 전체 탐색.</li>
<li><b>상점·도구·승진</b>: 전투 사이에 상점이 있는 마을을 지나면 금을 써서 산다(가격 ×10, 빈 칸에, 원작 상점 규칙 그대로). 우선순위는 ① 승진 도구(장창·연노·마개·무술교본 Lv15, 보병차·투석기·근위개·의협교본 Lv30, 해당 병종일 때) ② 병력 회복 도구(유비 2개, 주력 1개씩) ③ 남는 금으로 폭탄류. 전투 중 정책은 승진 도구를 쓸 수 있게 되면 바로 쓰고, 크게 다친 아군(특히 유비)에게 회복 도구를, 공격 대신 폭탄을 쓸 수 있다(폭탄 타격도 경험치). 보물 칸(밟으면 도구를 주는 칸)도 찾아간다.</li>
<li><b>재도전</b>: 모든 작전이 지면, 플레이어처럼 전투 시작부터 다시 한다(시작 직후 총퇴각으로 난수를 바꿔 정책·게임 AI 번갈아, 최대 K번). 그래도 지면 강제 진행.</li>
<li><b>적응형 개체 수</b>: 분포가 넓을 때(초반)는 후보를 많이, 수렴하면 적게 뽑는다(--pop이 상한, 최소 4).</li>
</ol>
</div>

<h2>배운 것</h2>
<div class="card"><h3>최고 파라미터에서 읽은 규칙</h3><ul>${rules || '<li>아직 세대가 없습니다.</li>'}</ul>
<h3>세대별로 바뀐 생각</h3><ul>${moves}</ul></div>

<h2>사람의 힌트가 준 효과: 회복 책략 적극 사용</h2>
${abHtml(ab, st)}

<h2>파라미터 변화(평균 ± 표준편차)</h2>
<div class="card"><div class="dim" style="margin-bottom:8px">선은 분포의 평균, 띠는 ±1 표준편차, 점은 그 세대 최고 후보의 값. 띠가 좁아지면 그 값에 수렴한 것.</div><div class="minis" id="minis"></div></div>

<div class="grid2">
<div><h2>최고 파라미터</h2><div class="card"><table>${params}</table></div></div>
<div><h2>최종 레벨(최고 실행)</h2><div class="card"><table><tr><th>장수</th><th class="num">Lv</th><th class="num">99 도달 전투#</th></tr>${roster}</table></div></div>
</div>

<h2>전투별 결과(최고 실행)</h2>
<div class="card"><table><tr><th>#</th><th>전투</th><th>결과</th><th class="num">턴</th><th class="num">경험치</th><th class="num">남긴 적</th><th class="num">총퇴각</th><th>방식</th><th class="num">승리까지 시도</th><th>상점 구입 · 승진 · 도구</th><th>실패 원인(시도별)</th></tr>${battles}</table>
<p class="dim">강제 진행 = 이 실행의 모든 시도(기본·엘리트·변형·게임 AI·총퇴각 재시도)가 졌다는 뜻. 그 전투는 경험치 0으로 치고 레벨을 그대로 다음 전투로 넘긴다(실제 게임이라면 이길 때까지 다시 해야 함). 원인 집계: ${esc(lossSummary(data.best?.battles ?? []))}</p></div>

<h2>자주 지는 전투: 수정 전후 승률</h2>
${benchHtml(benches)}

<h2>전투별 작전 변화(엘리트)</h2>
<div class="card"><table><tr><th>세대</th><th>전투</th><th>바뀐 값</th></tr>${elites || '<tr><td colspan="3" class="dim">아직 없음</td></tr>'}</table></div>

<h2>세대 기록</h2>
<div class="card"><table id="gens"><tr><th>세대</th><th class="num">최고</th><th class="num">평균</th><th class="num">Lv99</th><th class="num">후보 수</th><th class="num">고정 전투</th><th class="num">시간(초)</th></tr></table></div>

<h2>한계: 왜 아직 15명 Lv99가 안 되나</h2>
<div class="card"><ul>
<li><b>상한</b>: 레벨은 99를 넘지 못한다(한 번에 받는 경험치가 최대 64, Lv99부터는 경험치를 받지 않음, 스크립트의 능력치 증가도 99에서 멈춤).</li>
<li><b>행동 수</b>: 48전투의 제한 턴 합은 1847턴, 기본 출진 인원으로 곱하면 아군 장수 행동 기회가 약 16,800번. 15명을 Lv1→99로 올리려면 약 147,000 경험치가 필요하다. 상대가 5레벨 이상 높을 때의 타격 16을 매 행동마다 받아도 약 269,000이 상한이고, 아군이 적보다 높아지면 타격은 4, 책략은 8로 떨어진다(행동당 평균 8이면 134,000). 즉 이론상 가능 범위의 끝자락이고, 거의 모든 턴에 전원이 경험치 행동을 해야 한다.</li>
<li><b>지금 막히는 곳</b>: 강제 진행 전투의 대부분은 <b>유비 퇴각</b>으로 진다(위 표의 실패 원인). 유비가 Lv1~5에 머물러 병력 500으로는 장(3장) 이후 적 한 번의 공격에 쓰러진다.</li>
<li><b>장비</b>: 이 게임의 상점은 무기·방어구·말을 팔지 않는다(이야기로만 얻음). 상점에서 사는 것은 승진 도구, 회복·사기 도구, 책략서(폭탄류)다. 승진은 Lv15/30이 필요해서 레벨이 낮은 초반에는 도움이 안 된다. 상점 방문은 "그 마을에 상점 목록이 있으면 들른다"로 근사했다(포트의 필드 엔진은 도구상 건물 진입을 아직 구현하지 않음).</li>
<li><b>강제 진행의 취급</b>: 정책이 못 이긴 전투는 경험치 0, 레벨 그대로 다음 전투로 간다(실제로는 이길 때까지 재도전). 그래서 앞에서 막히면 뒤 전투도 줄줄이 막힌다.</li>
</ul></div>

<h2>사람의 지식 넣기: hints.json</h2>
<div class="card">
<p><code>/mnt/project-files/grind/hints.json</code>을 만들거나 고치면 다음 실행부터 반영된다.</p>
<ul>
<li><code>defaults</code>: 학습을 시작할 파라미터(처음 실행 또는 <code>--reset</code> 때만 사용). 지금 들어 있는 첫 힌트는 "회복 책략을 적극적으로"(heal 2.0, tactic 1.6, MP 절약 0.1). 회복은 병력이 가득 찬 대상에는 실패해 경험치가 없으므로, 정책은 병력이 줄어든 아군에게만 단일 회복을 쓰고(범위 회복 30–35는 범위에 아군이 있으면 항상 시전되어 +8), 회복 담당이 그 아군 옆으로 이동한다.</li>
<li><code>battles</code>: 전투 번호(0부터, 위 표의 # − 1) 또는 전투 이름 → 그 전투에서 먼저 시험할 파라미터. 적지 않은 값은 기본값을 쓴다. <code>rerolls</code>는 시작 직후 총퇴각해서 난수를 다시 굴리는 횟수.</li>
<li>파라미터 이름: ${PARAM_SPECS.map((s) => `<code>${s.key}</code>(${PARAM_KO[s.key]}, ${s.min}–${s.max})`).join(', ')}.</li>
</ul>
<pre>${esc(HINTS_EXAMPLE)}</pre>
</div>
</main>
<script>
const D=${json};
const G=D.generations;
const k=document.getElementById('kpis');
const best=D.best;
const kp=(t,v)=>{const d=document.createElement('div');d.className='kpi';d.innerHTML='<span class="dim">'+t+'</span><b>'+v+'</b>';k.appendChild(d)};
kp('세대 수',G.length);kp('Lv99 장수',best?best.n99:'-');kp('상위 15명 레벨 합',best?best.top15:'-');
kp('승리/강제',best?best.wins+' / '+best.forced:'-');
kp('세대당 평균 시간',G.length?Math.round(G.reduce((s,g)=>s+g.seconds,0)/G.length)+'초':'-');
if(D.running){const r=D.running;const el=document.getElementById('live');const mins=Math.round((Date.now()-r.startedAt)/60000);
 el.innerHTML='<div class="card live"><b>진행 중: 세대 '+r.gen+'</b> · 후보 '+r.done+'/'+r.total+' 완료 · 시작 후 '+mins+'분<br><span class="dim">후보별 진행(전투): '+r.battles.map((b,i)=>'#'+i+' '+b+'/'+r.battleCount).join(' · ')+'</span>'+(r.candidates.length?'<br><span class="dim">끝난 후보: '+r.candidates.map(c=>'Lv99 '+c.n99+', 합 '+c.top15+', 승 '+c.wins+' ('+Math.round(c.seconds)+'초)').join(' · ')+'</span>':'')+'<br><span class="dim">마지막 갱신 '+new Date(D.updated).toLocaleString()+'</span></div>'}
const tb=document.getElementById('gens');
for(const g of G){const r=tb.insertRow();r.innerHTML='<td>'+g.gen+'</td><td class="num">'+g.best+'</td><td class="num">'+g.mean+'</td><td class="num">'+g.bestN99+'</td><td class="num">'+g.pop+'</td><td class="num">'+g.frozen.length+'</td><td class="num">'+g.seconds+'</td>'}
const svg=document.getElementById('chart');const W=900,H=300,L=56,R=40,T=14,B=30;
if(G.length){
 const ys=G.flatMap(g=>[g.best,g.mean]);let lo=Math.min(...ys),hi=Math.max(...ys);if(hi===lo){hi+=1;lo-=1}
 const x=i=>L+(G.length===1?(W-L-R)/2:i*(W-L-R)/(G.length-1));const y=v=>T+(H-T-B)*(1-(v-lo)/(hi-lo));
 const n9=G.map(g=>g.bestN99);const nh=Math.max(15,...n9);const y2=v=>T+(H-T-B)*(1-v/nh);
 let s='';for(let i=0;i<=4;i++){const v=lo+(hi-lo)*i/4;s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--line)"/><text x="'+(L-6)+'" y="'+(y(v)+4)+'" text-anchor="end">'+Math.round(v)+'</text>'}
 s+='<text x="'+(W-R+6)+'" y="'+(y2(nh)+4)+'">'+nh+'</text><text x="'+(W-R+6)+'" y="'+(y2(0)+4)+'">0</text>';
 G.forEach((g,i)=>{s+='<text x="'+x(i)+'" y="'+(H-10)+'" text-anchor="middle">'+g.gen+'</text>'});
 const path=(f,c,w)=>'<polyline fill="none" stroke="'+c+'" stroke-width="'+w+'" points="'+G.map((g,i)=>x(i)+','+f(g)).join(' ')+'"/>';
 s+=path(g=>y(g.mean),'var(--b)',2)+path(g=>y(g.best),'var(--a)',2.5)+path(g=>y2(g.bestN99),'var(--c)',2);
 G.forEach((g,i)=>{s+='<circle cx="'+x(i)+'" cy="'+y(g.best)+'" r="3.5" fill="var(--a)"><title>세대 '+g.gen+': 최고 '+g.best+', 평균 '+g.mean+', Lv99 '+g.bestN99+'</title></circle>'});
 svg.innerHTML=s;
}
const M=document.getElementById('minis');
for(const p of D.paramSpecs){
 const pts=[];if(D.start)pts.push({g:'시작',m:D.start[p.key],s:0,b:null});
 for(const g of G){const bc=g.candidates.slice().sort((a,b)=>b.objective-a.objective)[0];pts.push({g:g.gen,m:g.meanParams[p.key],s:g.stdParams[p.key]||0,b:bc?bc.params[p.key]:null})}
 const w=200,h=70,l=4,r=4,t=6,bt=14;const x=i=>l+(pts.length<2?(w-l-r)/2:i*(w-l-r)/(pts.length-1));const y=v=>t+(h-t-bt)*(1-(Math.min(p.max,Math.max(p.min,v))-p.min)/(p.max-p.min));
 let s='<rect x="0" y="0" width="'+w+'" height="'+h+'" fill="none"/>';
 if(pts.length>1){s+='<polygon fill="var(--band)" points="'+pts.map((q,i)=>x(i)+','+y(q.m+q.s)).join(' ')+' '+pts.map((q,i)=>x(i)+','+y(q.m-q.s)).reverse().join(' ')+'"/>';
  s+='<polyline fill="none" stroke="var(--a)" stroke-width="2" points="'+pts.map((q,i)=>x(i)+','+y(q.m)).join(' ')+'"/>'}
 pts.forEach((q,i)=>{if(q.b!==null)s+='<circle cx="'+x(i)+'" cy="'+y(q.b)+'" r="2.5" fill="var(--b)"><title>세대 '+q.g+' 최고 후보 '+(+q.b).toFixed(2)+'</title></circle>';s+='<circle cx="'+x(i)+'" cy="'+y(q.m)+'" r="2" fill="var(--a)"><title>'+q.g+': 평균 '+q.m.toFixed(2)+' ± '+q.s.toFixed(2)+'</title></circle>'});
 s+='<text x="'+l+'" y="'+(h-2)+'">'+p.min+'</text><text x="'+(w-r)+'" y="'+(h-2)+'" text-anchor="end">'+p.max+'</text>';
 const last=pts[pts.length-1];const d=document.createElement('div');d.className='mini';
 d.innerHTML='<div class="t"><b>'+p.label+'</b> <span class="dim">'+p.key+' = '+(p.int?Math.round(last.m):last.m.toFixed(2))+'</span></div><svg viewBox="0 0 '+w+' '+h+'">'+s+'</svg>';M.appendChild(d)}
</script></body></html>
`;
}

// ---------------------------------------------------------------- guide + results

function battleRows(battles: CampaignBattle[]) {
  return battles.map((b) => ({
    index: b.index,
    chapter: b.chapter,
    name: b.name,
    won: b.won,
    forced: b.forced,
    turns: b.turns,
    turnLimit: b.turnLimit,
    finishTurn: b.finishTurn,
    keep: b.params.keep,
    kept: b.kept,
    actions: b.actions,
    tactics: Object.fromEntries(Object.entries(b.tactics).map(([t, n]) => [tname(t), n])),
    officers: b.gains.map((g) => ({ name: g.name, from: g.levelBefore, to: g.levelAfter, exp: g.expGained, hits: g.hits, kills: g.kills, tactics: g.tactics, heals: g.heals })),
    expTotal: b.expTotal,
  }));
}

export function resultsJson(r: RealRunResult, st: EvolveState) {
  return {
    result: r.result,
    seconds: Math.round(r.ms / 100) / 10,
    sandboxBattles: r.sandboxBattles,
    params: st.best?.params ?? null,
    n99: r.n99,
    top15: r.top15,
    roster: r.roster,
    battles: battleRows(r.battles).map((b, i) => ({ ...b, predicted: r.battles[i].predicted, exact: r.battles[i].matched, outcome: r.battles[i].outcome })),
    simulatedBest: st.best ? { n99: st.best.result.n99, top15: st.best.result.top15, roster: st.best.campaign.roster } : null,
    issues: r.issues,
  };
}

const CH = ['서장', '1장', '2장', '3장', '4장'];

export function guideMarkdown(r: RealRunResult, st: EvolveState): string {
  const L: string[] = [];
  const p = st.best?.params;
  L.push('# 삼국지영걸전 노가다(레벨 올리기) 공략');
  L.push('');
  L.push('헤드리스 시뮬레이터(원작 규칙·난수 그대로 재현한 웹 포트의 전투 엔진)로 전투마다 여러 작전을 시험해 가장 경험치를 많이 얻으면서 이기는 작전을 골라, 게임 처음부터 엔딩까지 실제로 플레이한 기록입니다. 수치는 그 플레이 결과입니다(난수 시드에 따라 달라집니다).');
  L.push('');
  L.push('## 결과 요약');
  L.push('');
  L.push(`- Lv99 도달 장수: **${r.n99}명**, 상위 15명 레벨 합 ${r.top15}`);
  L.push(`- 전투 ${r.battles.length}회 (정책으로 승리 ${r.battles.filter((b) => b.won).length}, 강제 진행 ${r.battles.filter((b) => b.forced).length})`);
  L.push(`- 소요 시간: ${(r.ms / 1000).toFixed(0)}초 (샌드박스 시뮬레이션 ${r.sandboxBattles}전투 포함)`);
  L.push('');
  L.push('| 장수 | 최종 Lv | Lv99 도달 전투 |');
  L.push('|---|---:|---|');
  for (const x of r.roster.slice(0, 24)) L.push(`| ${x.name} | ${x.level} | ${x.reached99At !== null ? r.battles.find((b) => b.index === x.reached99At)?.name ?? x.reached99At : ''} |`);
  L.push('');
  L.push('## 경험치 규칙(원작 그대로)');
  L.push('');
  L.push('- 타격 1회: 상대 레벨이 낮으면 4, 같거나 높으면 (차이+3)×2, 최대 16. 빗나가도 받는다.');
  L.push('- 처치: 적 총대장(첫 적 부대) 48, 자기보다 레벨이 높은 적 32, 아니면 64/(레벨차+2).');
  L.push('- 혼란·사기저하·회복 책략: 시전하면 +8(군악대·수송대의 단일 회복은 +12). 성공 여부와 무관. 범위 회복은 아군(자신 포함)이 범위에 있기만 하면 시전된다.');
  L.push('- 경험치 100마다 1레벨. Lv99가 되면 더 이상 오르지 않는다(한 번에 100 이상을 받는 경우가 없어 99를 넘지 못함).');
  L.push('- MP는 매 턴 회복되지 않고 전투 시작 시 가득 찬다 → 전투 안에서 다 쓰는 것이 이득. 군악대 옆 장수는 매 턴 MP를 회복한다.');
  L.push('');
  if (p) {
    L.push('## 기본 작전');
    L.push('');
    for (const rule of learnedRules(st)) L.push(`- ${rule}`);
    L.push('');
  }
  L.push('## 전투별 작전');
  L.push('');
  for (const b of r.battles) {
    L.push(`### ${b.index + 1}. ${CH[b.chapter] ?? b.chapter} ${b.name}의 전투`);
    L.push('');
    if (b.purchases?.length) L.push(`- 전투 전 상점 구입: ${boughtText(b.purchases)}.`);
    if (!b.won) {
      L.push(`- 시뮬레이터 정책으로는 이기지 못해 일반 플레이(강제 진행)로 넘김. 경험치 ${b.expTotal}.`);
      L.push('');
      continue;
    }
    if (b.params.native) {
      L.push(`- 노가다 정책으로는 이기기 어려워 아군을 게임의 자동 전투(AI)에 맡김${b.params.rerolls ? ` (시작 직후 총퇴각 ${b.params.rerolls}회로 난수를 바꾼 뒤)` : ''}. 턴 ${b.turns}/${b.turnLimit}, 경험치 ${b.expTotal}.`);
      L.push(`- 장수별: ${[...b.gains].sort((x, y) => y.expGained - x.expGained).map((x) => `${x.name} Lv${x.levelBefore}→${x.levelAfter}`).join(', ')}.`);
      L.push('');
      continue;
    }
    L.push(`- 턴: ${b.turns}/${b.turnLimit} (마무리 시작 ${b.finishTurn ?? '-'}턴). 살려 둔 적: ${b.kept.length ? b.kept.join(', ') : '없음'} (최소 ${b.params.keep}명 유지).`);
    const a = b.actions;
    L.push(`- 행동: 공격 ${a.attack}(처치 ${a.kill}), 공격·상태 책략 ${a.tactic}, 회복 책략 ${a.heal}, 도구 ${a.item ?? 0}(승진 ${a.promoted ?? 0}), 대기 ${a.wait}.`);
    const tc = Object.entries(b.tactics).sort((x, y) => y[1] - x[1]);
    if (tc.length) L.push(`- 책략: ${tc.map(([t, n]) => `${tname(t)} ${n}`).join(', ')}.`);
    const g = [...b.gains].sort((x, y) => y.expGained - x.expGained);
    L.push(`- 출진/추천 장수와 성과: ${g.map((x) => `${x.name} Lv${x.levelBefore}→${x.levelAfter}(+${x.expGained})`).join(', ')}.`);
    const main = g.filter((x) => x.expGained > 0).slice(0, 3).map((x) => {
      const src = [['타격', x.hits], ['처치', x.kills], ['책략', x.tactics], ['회복', x.heals]] as const;
      const top = [...src].sort((u, v) => v[1] - u[1])[0];
      return `${x.name}(${top[0]} 위주)`;
    });
    if (main.length) L.push(`- 패턴: 매 턴 레벨이 낮은 장수부터 행동, ${main.join(', ')}. 마지막 ${b.params.finish}턴에 승리 조건 달성.`);
    L.push('');
  }
  return L.join('\n');
}
