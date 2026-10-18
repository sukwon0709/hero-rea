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
  control: '견제 책략(혼란·사기) 가중',
  heal: '회복 책략 가중',
  kill: '처치 보너스 가중',
  conserve: '적 병력 아끼기',
  mp: 'MP 절약',
  risk: '위험 회피',
  retreat: '후퇴 기준 병력비',
  approach: '접근 성향',
  strong: '출진 고정 강자 수',
  exitMargin: '탈출 계획: 유비 이동 턴에 더하는 여유 턴',
  exitNear: '탈출 계획: 거점이 탈출 칸에 가까운 정도',
  exit: '탈출 계획(탈출 칸이 있고 적이 두 배 이상이면 탈출 칸 근처 요지에서 버티며 육성, 남은 턴이 이동 거리만큼일 때 유비 탈출)',
  area: '상점에서 범위 회복 서(원대서·평기서 등)를 먼저 구입',
  healers: '출진 회복 담당 수(회복 책략을 익힌 장수를 저레벨부터 먼저 출진)',
  guard: '유비 노출 한도(최악 피해/병력)',
  escort: '유비 곁에 모이기',
  event: '스크립트 이득(전원 경험치·일기토·설득) 가중',
  feed: '유비 막타 몰아주기',
  safe: '유비 안전(닿는 적 1명당 비용)',
  band: '군악대 옆 MP 회복 활용',
  lead: '유비도 앞으로(적에게 다가가기)',
  hold: '진형 유지(시작 지점에서 버티며 적을 맞이하기)',
  terrain: '지형 활용(방어 지형에 서기, 마을·성채에서 회복)',
  walk: '걷는 거리 기준 접근(강·벽 뒤에서 대기하지 않도록 실제 이동 거리로 가장 가까운 적에게 접근)',
  brace: '증원 대비(증원 몇 턴 전·아군 손실 시 유비 주위로 방어 지형에 진형 짜고 버티기)',
  scrolls: '상점에서 싼 병법서(초열서 등)를 장수마다 이만큼 구입(MP가 없을 때 던져 경험치)',
  bonusExit: '전원 경험치 +50 도착 칸이 있으면 총대장을 살려 두고 마지막에 유비 도착',
  spareBand: '적 군악대를 살려 둠(인접한 아군 MP 회복)',
  hnPlan: '회남 작전(북동쪽에서 증원을 버티고, 다리에서 남쪽 대기 부대를 하나씩 끌어내 잡고, 길이 열리면 유비 탈출)',
  hnX: '회남 작전: 북동쪽 거점 열',
  hnY: '회남 작전: 북동쪽 거점 행',
  hnPeel: '회남 작전: 늦어도 이 턴에 끌어내기 시작',
  hnWave: '회남 작전: 증원이 이만큼 남으면 끝난 것으로 봄',
  hnReach: '회남 작전: 다른 대기 부대 사거리에서 떨어지는 칸 수',
  hnBack: '회남 작전: 끌어낼 때 거점을 뒤로 물리는 칸 수',
  hnRest: '회남 작전: 다음 끌어내기 전에 회복할 병력비',
  hnFront: '회남 작전: 전열(회복 담당·군악대 제외)이 거점에서 적 쪽으로 나가는 칸 수',
  hnFocus: '회남 작전: 집중 공격(가장 다친 적부터 쓰러뜨리기)',
  hnWeak: '회남 작전: 상위 3명보다 이만큼 레벨이 낮은 장수는 진형 안쪽에서 사거리 밖에 둠(출진은 강한 장수부터)',
  bomb: '폭탄(1350~1650 피해, 경험치 없음)을 이번 적 턴에 아군을 칠 수 있는 적에게 던지는 비중',
  confuse: '혼란 도구(농무서·기상서·호우서, 반드시 혼란)를 아군을 칠 수 있는 적에게 쓰는 비중',
  bombBuy: '도구상: 폭탄(500냥, 서주)을 일행이 이만큼 들 때까지 삼',
  confuseBuy: '도구상: 혼란 도구(농무서 50냥, 북해)를 일행이 이만큼 들 때까지 삼',
  hnStrike: '회남 기습: 6턴 여포군 출현 지점 옆에 미리 서서 폭탄으로 먼저 치고, 남쪽은 미끼로 하나씩 끌어냄',
  healKeep: '도구상: 회복 도구·싼 병법서를 살 때 남겨 둘 돈 (서주 폭탄용 저축)',
  hnStageX: '회남 기습: 증원 직전 턴에 설 칸 (x)',
  hnStageY: '회남 기습: 증원 직전 턴에 설 칸 (y)',
  hnExtra: '회남 기습: 미끼 칸이 목표 말고 더 깨워도 되는 대기 적 수',
  hnWaveRisk: '회남 기습: 증원군이 남은 동안 아군(유비 제외) 위험 가중치',
  farm: '경험치 농사(안전해지면 제한 턴까지 고정 경험치 책략)',
  lure: '거록·계교 유인 작전: 대기 부대를 미끼로 한두 기씩 끌어내 잡고, 총대장은 마지막, 길이 비면 유비를 +50 칸으로',
  luExtra: '유인 작전: 미끼 칸이 목표 말고 더 깨워도 되는 대기 적 수',
  luMargin: '유인 작전: 유비가 +50 칸까지 걷는 턴에 더하는 여유 턴',
  luKill: '유인 작전: 길이 막혔을 때 총대장을 마지막에 잡으러 가는 데 남겨 둘 턴',
  luEngaged: '유인 작전: 다음 미끼를 내보내기 전에 남아 있어도 되는 깨어난 적 수',
  luHold: '유인 작전: 처음 버티는 턴에 더하는 턴 수',
  cbPrice: '전투 경험치: 적 병력 한 점의 값(가까운 아군이 그 적에게서 얻을 최고 경험치/피해) × 피해로 공격 비용을 매김 — 약한 공격·저레벨 장수에게 적을 남김',
  cbHeal: '전투 경험치: 마을·성채 위 적(매 턴 150~250 회복)에게 준 피해 중 비용에서 빼는 몫, 그 적을 살려 두는 비중',
  cbCounter: '전투 경험치: 반격하는 장수(산적·무도가 계열)를 적이 칠 칸으로 끄는 힘(반격도 경험치)',
  cbBase: '전투 경험치: 적이 더 강할 때도 죽이지 않는 공격에 매기는 값의 비율(죽이지 않는 공격은 적의 공격력을 줄이지 않음)',
  cbCap: '전투 경험치: 병력 비용이 공격 자체의 경험치 값에서 깎을 수 있는 최대 비율(1 미만이면 비용 때문에 공격 대신 대기하지 않음)',
  cbMend: '병력이 이 비율 아래로 떨어진 장수는 가장 가까운 마을·성채·병영으로 가서 회복한 뒤 다시 싸움',
  cbGate: '전투 경험치: 아군이 더 강해진 뒤에만 병력 값을 매기는 정도(1: 그때만, 0: 늘)',
  cbReach: '전투 경험치: 적의 값에 넣는 아군의 거리(이동+사거리 밖으로 이만큼)',
  farmEnd: '농사 후 마무리 여유 턴',
  farmRatio: '농사 시작: 남은 적 전력 / 아군 전력 상한',
  farmTac: '농사 중 고정 경험치 책략 가중',
  wake: '남은 적이 모두 대기 중이고 턴이 남으면 조기 마무리 대신 깨워서 싸움',
  wakeRatio: '깨우기 시작: 남은 적 전력 / 아군 전력 상한',
  search: '내 턴 탐색(후보 수를 적 턴까지 돌려 보고 고름) 켜기',
  srK: '탐색: 한 턴에 시험할 후보 수',
  srSamples: '탐색: 후보마다 굴리는 난수 표본 수',
  srDepth: '탐색: 내다보는 깊이(1 = 적 턴까지, 2 = 한 턴 더)',
  srHp: '탐색: 아군 병력 보존 가중치',
  srLeader: '탐색: 유비 병력 가중치',
  srFoe: '탐색: 적 병력 감소 가중치',
  srGap: '탐색: 대안 행동이 최선보다 낮아도 되는 폭',
  srMargin: '탐색: 기본 수 대신 고를 때 필요한 평가 차이',
  srProg: '탐색: 마무리 때 승리 조건 진척 가중치',
  srVerify: '탐색: 고른 후보를 새 표본으로 다시 확인하는 횟수',
  srLure: '탐색 중에도 거록·계교 유인 작전 쓰기',
  endHold: '전투를 끝내는 마지막 격파를 마지막 턴까지 미루기',
  endSpare: '마지막 격파에 남겨 두는 여유 턴',
  nurse: '살려 둘 약해진 적이 마을·성채·병영으로 가서 회복하게 길 비워 주기',
  milk: '여유 있을 때 회복할 수 있는 적은 죽이지 않고 계속 때리기',
  milkRatio: '여유 판단: 남은 적 전력이 아군의 이 비율 이하',
  steer: '여유 있을 때 레벨 낮은 아군에게 공격 몰아주기',
  hnDmg: '전투 모드: 적 병력을 깎는 값 (경험치 외에)',
  hnPush: '회남: 지원군을 쓰러뜨리면 바로 다리를 건너 성채로 진격',
  promoLead: '상점: 전직 레벨이 가까운 장수의 전직 아이템 값을 남겨 둠 (레벨 차)',
  yjEscape: '연주: 유비가 정해진 길로 돌아 (3,19)로 탈출 (15~17턴)',
  yjSamples: '연주 탈출: 수마다 굴려 보는 난수 표본 수',
  column: '탈출·보너스 칸 행군: 목표에 가까운 부대부터 움직이기 (다리에서 줄 막힘 방지)',
  healRisk: '이번 적 턴에 쓰러질 수 있는 아군부터 병력 회복',
  lone: '아군 없이 적 둘 이상에 노출되는 칸을 피하기',
  tacHit: '공격 책략의 성공 확률을 계산에 넣기',
  idleFinish: '경험치 없는 턴이 이만큼 이어지면 마무리 시작',
  pen: '가두리양식장: 적 장수 하나를 둘러싸 가두고 마지막 턴까지 살려 두며 때리기',
  penRatio: '가두리: 나머지 적의 힘이 우리 힘의 이 비율 이하일 때만',
  penHarm: '가두리: 대상의 한 방이 우리 부대 병력의 이 비율 이하인 적만 고르기',
  penPrice: '가두리: 대상 병력을 데미지당 경험치가 좋은 공격에 먼저 돌리는 가격의 무게',
  penCell: '가두리: 대상 옆 칸에 서는 값',
  penCounter: '가두리: 대상의 공격에 반격해서 얻는 경험치의 무게',
  sell: '도구상 판매: 0 안 함, 1 직업변경서·안 쓰는 장비, 2 강한 병법서도(싼 것과 바꿈), 3 빈 칸마다 초열서 대량 구입',
  idleAp: '경험치 없이 두 번 쉰 부대가 가장 가까운 적에게 걸어가는 세기(0 끔)',
  scrollEarn: '싼 병법서(2장 이상)를 던지는 값을 경험치의 몇 배 더 쳐 줄지(0 예전대로)',
  escIdle: '호위 탈출(장판파 백성): 경험치 없는 턴이 몇 번 이어지면 출구 칸을 비켜 줄지',
  escWin: '호위 탈출: 남은 턴이 몇 턴 이하가 되면 출구 칸을 비켜 줄지',
  bandFarm: '군악대 농사: 군악대를 살려 두고 그 옆에서 매 턴 책략(견제·회복)으로 경험치 벌기',
  bfRatio: '군악대 농사: 나머지 적의 힘이 우리 힘의 이 비율 이하일 때만',
  bfSpare: '군악대 농사: 적 군악대를 처음부터 살려 두기 (아니면 안전해진 뒤부터)',
  bfCell: '군악대 농사: 책략을 쓸 부대가 군악대 옆 칸에 서는 값 (얻는 MP 1당)',
  bfPen: '군악대 농사: 적 군악대를 가두리 대상으로 고르는 값',
  bfEnd: '군악대 농사: 마무리에 필요한 턴 위에 남겨 둘 여유 턴',
  gate: '조건이 갖춰진 관문 칸(하비 적교)으로 가서 지도를 엶',
  gateLate: '남은 턴이 이만큼이 되면 관문을 엶 (0 = 가까운 적이 없어지는 대로)',
  farmReach: '가두리·군악대 농사의 안전 판단에 두 턴 안에 우리에게 닿을 수 있는 적만 셈 (닫힌 관문 너머·깨우지 않을 대기 부대는 뺌)',
  wakeAvoid: '옆에서 행동하거나 쓰러뜨리면 잠든 적 부대가 모두 돌격해 오는 적장(무릉의 오조·양안) 옆 칸을 피하고, 그 적장은 치지 않고 돌아서 감',
  wakeKill: '잠든 적 부대를 깨우는 적장을 돌아가는 마무리에, 길목의 잠든 적 하나마다 셈하는 턴 수',
  wakeReroll: '잠든 적 부대를 깨우는 적장들이 이기는 곳으로 가는 길을 모두 막은 배치면, 첫 턴에 총퇴각해 다시 배치하는 횟수',
  capture: '모두 점령해야 이기는 칸들(공안의 성채 넷)을 원군 턴 전에 나눠 점령하고, 적을 깨우는 구역(중앙)에는 들어가지 않음',
  capSlack: '성채 점령: 원군 턴까지 남은 턴이 걷는 턴 + 이 값 이하가 되면 맡은 성채로 출발',
  capLast: '성채 점령: 마지막 성채는 원군 전 마지막 턴보다 이 턴 수만큼 먼저 점령 (그 전 턴들은 계속 경험치를 모음)',
  capLoot: '성채 점령 중, 적이 가깝지 않은 보물 칸(공안의 고취구·해일서)으로 가장 가까운 한가한 부대를 보냄',
  fireRing: '걸어서 닿을 수 없는 적(부 2차: 성문 닫힌 성 안의 유괴)에게는 그 적을 칠 수 있는 칸(두 칸 거리)까지의 거리로 다가가고, 그곳에서 칠 수 있는 부대(궁병·노병·발석차, 공격 책략)만 보냄',
  sleeper: '도착하면 다가오는 적 증원이 제자리에 서게 되는 구역(부 2차: 8턴 전 동쪽 산길)이 열려 있는 동안, 제때 닿을 수 있는 가장 가까운 부대를 그곳으로 보냄',
  bandEnd: '군악대 사냥 중에도 남은 턴이 마무리에 필요한 만큼이 되면 마무리를 시작함(가맹관1: 성문 앞 적 여섯이 남아 2턴 전에야 시작)',
  castIdle: '싸움으로 얻은 경험치 없이(서로 회복·격려만) 이 턴 수가 지나면 적에게 다가감(와구관2: 40턴 동안 제자리)',
  finNeed: '승리 조건 장수가 전장에 있으면, 마무리에 필요한 예상 턴의 이 배수만큼 남았을 때 마무리를 시작함',
  finPath: '승리 조건 장수까지 가는 길 근처의 적 하나마다 마무리 예상 턴에 더하는 턴',
  gainPick: '일기토·설득의 주인공(가맹관2의 엄안, 정군산의 황충)을 출진 명단에 먼저 넣음',
  ambush: '들어가면 적 부대가 나타나는 구역(가맹관1: 장노 앞의 마초 복병)에는 때가 될 때까지 들어가지 않고, 때가 되면 유비 둘레로 진을 친 뒤 한 부대만 보냄',
  ambTurns: '복병과 싸울 턴으로 마무리 전에 남겨 두는 턴 수(늦어도 이때 복병 구역에 들어감)',
  duelKeep: '앞으로 일기토를 할 장수(가맹관1의 장비, 정군산의 황충)를 죽을 수 있는 자리에서 빼는 가중치',
  finCharge: '남은 턴이 마무리 예상 턴만큼이 되면 가까운 적 대신 승리 조건 장수에게 곧장 감',
  duelOut: '전세가 기울면(유비 병력 60% 아래, 적이 1.5배) 끝내는 일기토(정군산의 황충-하후연)를 바로 함',
  duelReach: '지금 하는 끝내는 일기토를 밀어붙임: 상대가 닿으면 먼저 움직이고, 다가오는 상대에게는 과감히 다가가며, 다른 부대는 상대 옆 칸을 비워 주고 막는 적을 먼저 침(정군산의 황충-하후연, 가맹관2의 엄안-하후덕)',
  ambWake: '기다리던 3부대 이상을 깨워 덤비게 하는 지역(양평관 r4)도 매복처럼 때가 될 때까지 들어가지 않음',
  ypPlan: '양평관 작전: 숲에 진을 치고 r4를 불러 숲에서 싸우고, 다리 동쪽에서 강 건너 수비대를 쏘아 끌어낸 뒤 건너가 서쪽 강가에 진을 치고 r5를 부름, 조조는 마지막',
  farmHold: '마무리 중에도 끝내는 공격(총대장 격파, 끝내는 일기토·설득, 승리 칸)은 잡을 적이 남아 있고 턴이 넉넉하면 미룸(장사: 관우-황충 일기토가 보병 넷을 남기고 끝냈음)',
  holdWalk: '적이 모두 제자리에서 기다리면 지형을 따라 걷는 거리로 다가감(강릉: 강 건너 성의 진교 수비대)',
  wakeShut: '잠든 적 부대를 깨우는 적장들이 모든 길을 막으면(무릉) 마무리까지 그 옆을 피하고 길목 앞에서 대기하는 적을 끌어내 싸운 뒤, 마무리에 깨운 부대와 싸울 턴을 셈해 지나감',
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
  const cr = c as Partial<CampaignResult>;
  if (cr.frontier) out.push(`최고 실행은 ${cr.frontier.index + 1}번째 전투 ${cr.frontier.name}에서 모든 재도전이 실패해 멈췄다(앞의 ${cr.cleared}전투 클리어).`);
  else if (cr.cleared !== undefined && c.battles.length) out.push(`최고 실행은 ${cr.cleared}전투를 모두 이기고 끝까지 갔다.`);
  return out;
}

// ---------------------------------------------------------------- progress

/** Korean sentence per parameter for a move up / down (what the move means for play). */
const MOVE_KO: Record<ParamKey, [string, string]> = {
  need: ['레벨이 낮은 장수에게 경험치를 더 몰아주는 게 유리하다고 배움', '레벨 차이보다 그때그때 큰 경험치를 고르는 게 낫다고 배움'],
  keep: ['적을 더 많이 남겨 두는 게(사냥감 확보) 유리하다고 배움', '적을 덜 남기고 정리해도 손해가 적다고 배움'],
  finish: ['승리 조건을 더 일찍(제한 턴 여유를 두고) 노리는 게 안전하다고 배움', '마무리를 더 늦게 시작해 턴을 끝까지 쓰는 게 이득이라고 배움'],
  tactic: ['책략(+8 고정 경험치)을 더 자주 쓰는 게 유리하다고 배움', '책략보다 직접 공격이 낫다고 배움'],
  control: ['혼란·사기 저하 같은 견제 책략으로 적을 묶어 두고 경험치를 버는 게 낫다고 배움', '견제 책략보다 다른 행동이 낫다고 배움'],
  heal: ['회복 책략으로 경험치를 버는 게 유리하다고 배움', '회복 책략 비중을 줄이는 게 낫다고 배움'],
  kill: ['처치 보너스를 더 적극적으로 노리는 게 유리하다고 배움', '처치를 미루고 타격 경험치를 더 오래 뽑는 게 낫다고 배움'],
  conserve: ['적 병력을 아껴(약하게 때려) 오래 사냥하는 게 유리하다고 배움', '적 병력을 아낄 필요가 적다고 배움'],
  mp: ['MP를 아껴 두는 게 낫다고 배움', 'MP를 아끼지 말고 바로 쓰는 게 낫다고 배움'],
  risk: ['위험한 칸을 더 피하는 게 낫다고 배움(패배·퇴각 손실이 큼)', '위험을 조금 감수하고 적에게 붙는 게 이득이라고 배움'],
  retreat: ['병력이 줄면 더 일찍 물러나 회복하는 게 낫다고 배움', '후퇴를 늦추고 계속 싸우는 게 낫다고 배움'],
  approach: ['적에게 더 빨리 다가가는 게 유리하다고 배움', '천천히 다가가 적이 오게 하는 게 낫다고 배움'],
  exitMargin: ['탈출을 더 일찍 시작하는 편이 낫다고 배움', '탈출을 더 늦게 시작하는 편이 낫다고 배움'],
  exitNear: ['탈출 칸 가까이에서 버티는 편이 낫다고 배움', '탈출 칸에서 떨어진 요지에서 버티는 편이 낫다고 배움'],
  exit: ['압도적인 전투에서 탈출 칸 근처에서 버티다 마지막에 탈출하는 편이 낫다고 배움', '탈출 계획 없이 싸우는 편이 낫다고 배움'],
  area: ['범위 회복 서를 먼저 사는 편이 낫다고 배움', '단일 회복 아이템을 사는 편이 낫다고 배움'],
  healers: ['회복 담당을 더 많이 출진시키는 편이 낫다고 배움', '회복 담당을 줄이는 편이 낫다고 배움'],
  strong: ['고레벨 장수를 더 많이 출진시켜 승리를 보장하는 게 낫다고 배움', '저레벨 장수를 더 많이 출진시켜 경험치를 나누는 게 낫다고 배움'],
  guard: ['유비를 조금 더 앞에 세워도 된다고 배움', '유비를 더 뒤에 두는 게 안전하다고 배움'],
  escort: ['다른 장수들이 유비 곁에서 싸우는 게(유비 보호·막타 기회) 낫다고 배움', '유비와 떨어져 각자 사냥하는 게 낫다고 배움'],
  event: ['전원 경험치 칸·일기토·설득 같은 스크립트 이득을 더 적극적으로 노리는 게 낫다고 배움', '스크립트 이득보다 평소 사냥이 낫다고 배움'],
  feed: ['적을 깎아 두고 막타를 유비에게 넘기는 게 낫다고 배움', '막타는 아무나 치는 게 낫다고 배움'],
  safe: ['유비를 적이 닿는 칸에서 더 멀리 두는 게 낫다고 배움', '유비가 적 사거리에 조금 들어가도 된다고 배움'],
  lead: ['유비도 다른 장수처럼 앞에 나가 싸우며 레벨을 올리는 게 낫다고 배움', '유비는 뒤에 있는 게 낫다고 배움'],
  hold: ['시작 지점에 진을 치고 적이 오게 하는 편이 낫다고 배움', '진을 치지 않고 나가 싸우는 편이 낫다고 배움'],
  terrain: ['방어 지형·회복 지형을 더 적극적으로 쓰는 편이 낫다고 배움', '지형보다 다른 것을 우선하는 편이 낫다고 배움'],
  walk: ['실제 이동 거리로 접근하는 편이 낫다고 배움', '직선 거리 접근이 낫다고 배움'],
  brace: ['증원 전에 더 일찍·더 단단히 진형을 짜는 편이 낫다고 배움', '증원 대비를 줄이고 자유롭게 싸우는 편이 낫다고 배움'],
  band: ['책략 쓰는 장수를 군악대 옆에 붙여 MP를 매 턴 채우는 게 낫다고 배움', '군악대 옆에 모일 필요가 적다고 배움'],
  scrolls: ['병법서를 더 많이 사서 MP 없을 때 던지는 편이 낫다고 배움', '병법서를 덜 사는 편이 낫다고 배움'],
  bonusExit: ['전원 +50 도착 칸으로 끝내는 편이 낫다고 배움', '총대장을 쓰러뜨려 끝내는 편이 낫다고 배움'],
  spareBand: ['적 군악대를 살려 두는 편이 낫다고 배움', '적 군악대를 먼저 쓰러뜨리는 편이 낫다고 배움'],
  hnPlan: ['회남에서 버티기-끌어내기-탈출 작전이 낫다고 배움', '회남에서 평소대로 싸우는 편이 낫다고 배움'],
  hnX: ['회남 거점을 더 동쪽에 두는 편이 낫다고 배움', '회남 거점을 더 서쪽에 두는 편이 낫다고 배움'],
  hnY: ['회남 거점을 더 남쪽에 두는 편이 낫다고 배움', '회남 거점을 더 북쪽에 두는 편이 낫다고 배움'],
  hnPeel: ['회남에서 끌어내기를 더 늦게 시작하는 편이 낫다고 배움', '회남에서 끌어내기를 더 일찍 시작하는 편이 낫다고 배움'],
  hnWave: ['증원이 더 남아 있어도 끌어내기를 시작하는 편이 낫다고 배움', '증원을 더 줄이고 끌어내는 편이 낫다고 배움'],
  hnReach: ['다른 대기 부대와 더 떨어지는 편이 낫다고 배움', '다른 대기 부대에 더 붙어도 된다고 배움'],
  hnBack: ['끌어낼 때 더 뒤에서 기다리는 편이 낫다고 배움', '끌어낼 때 더 앞으로 나가는 편이 낫다고 배움'],
  hnRest: ['끌어내기 사이에 더 많이 회복하는 편이 낫다고 배움', '회복을 덜 하고 계속 끌어내는 편이 낫다고 배움'],
  hnFront: ['전열을 적 쪽으로 더 내미는 편이 낫다고 배움', '전열을 거점에 붙이는 편이 낫다고 배움'],
  hnFocus: ['다친 적에게 공격을 더 모으는 편이 낫다고 배움', '공격을 고르게 나누는 편이 낫다고 배움'],
  hnWeak: ['레벨 차이가 더 커야 약한 장수로 보는 편이 낫다고 배움', '조금만 낮아도 약한 장수로 보호하는 편이 낫다고 배움'],
  bomb: ['폭탄은 아껴 두는 편이 낫다고 배움', '폭탄을 적극적으로 쓰는 편이 낫다고 배움'],
  confuse: ['혼란 도구는 아껴 두는 편이 낫다고 배움', '혼란 도구를 적극적으로 쓰는 편이 낫다고 배움'],
  bombBuy: ['폭탄을 덜 사는 편이 낫다고 배움', '폭탄을 더 사는 편이 낫다고 배움'],
  confuseBuy: ['혼란 도구를 덜 사는 편이 낫다고 배움', '혼란 도구를 더 사는 편이 낫다고 배움'],
  hnStrike: ['회남에서 기습을 쓰지 않는 편이 낫다고 배움', '회남에서 기습을 쓰는 편이 낫다고 배움'],
  healKeep: ['회복 도구에 돈을 더 쓰는 편이 낫다고 배움', '돈을 더 모아 두는 편이 낫다고 배움'],
  hnStageX: ['기습 대기 칸을 서쪽으로', '기습 대기 칸을 동쪽으로'],
  hnStageY: ['기습 대기 칸을 북쪽으로', '기습 대기 칸을 남쪽으로'],
  hnExtra: ['미끼를 더 조심스럽게', '미끼를 더 과감하게'],
  hnWaveRisk: ['증원군 앞에서 더 과감하게', '증원군 앞에서 더 조심스럽게'],
  farm: ['안전해지면 남은 턴을 경험치 농사에 쓰는 게 유리하다고 배움', '농사보다 일찍 끝내는 게 낫다고 배움'],
  lure: ['거록·계교에서 유인 작전을 쓰지 않는 편이 낫다고 배움', '거록·계교에서 유인 작전을 쓰는 편이 낫다고 배움'],
  luExtra: ['미끼를 더 조심스럽게', '미끼를 더 과감하게'],
  luMargin: ['+50 칸으로 더 늦게 출발', '+50 칸으로 더 일찍 출발'],
  luKill: ['총대장 마무리를 더 늦게', '총대장 마무리를 더 일찍'],
  luEngaged: ['깨어난 적을 다 잡고 다음 미끼', '깨어난 적이 남아도 다음 미끼'],
  luHold: ['처음 버티기를 더 짧게', '처음 버티기를 더 길게'],
  cbPrice: ['큰 공격도 아끼지 않는 편이 낫다고 배움', '적 병력을 아껴 작은 공격으로 여러 번 치는 편이 낫다고 배움'],
  cbHeal: ['마을·성채 위 적도 그냥 치는 편이 낫다고 배움', '마을·성채 위 적은 회복시키며 계속 치는 편이 낫다고 배움'],
  cbCounter: ['반격 장수도 공격을 피하는 편이 낫다고 배움', '반격 장수를 적 앞에 세우는 편이 낫다고 배움'],
  cbBase: ['적이 강할 때는 병력을 아끼지 않는 편이 낫다고 배움', '적이 강할 때도 큰 공격을 아끼는 편이 낫다고 배움'],
  cbCap: ['병력 비용은 목표 고르기에만 쓰는 편이 낫다고 배움', '병력 비용이 크면 공격을 쉬는 편이 낫다고 배움'],
  cbMend: ['다친 장수도 앞에 남는 편이 낫다고 배움', '다친 장수를 일찍 마을로 보내는 편이 낫다고 배움'],
  cbGate: ['처음부터 병력을 아끼는 편이 낫다고 배움', '아군이 우세해진 뒤에만 병력을 아끼는 편이 낫다고 배움'],
  cbReach: ['가까운 아군만 적의 값에 넣는 편이 낫다고 배움', '먼 아군까지 적의 값에 넣는 편이 낫다고 배움'],
  farmEnd: ['농사 후 마무리에 여유 턴을 더 두는 게 안전하다고 배움', '마무리 여유를 줄여 농사 턴을 늘리는 게 이득이라고 배움'],
  farmRatio: ['적이 더 남아 있어도 농사를 시작하는 게 낫다고 배움', '적을 더 줄인 뒤에 농사를 시작하는 게 안전하다고 배움'],
  farmTac: ['농사 중 고정 경험치 책략을 더 우선하는 게 유리하다고 배움', '농사 중에도 공격이 낫다고 배움'],
  wake: ['대기 중인 적을 깨워 남은 턴을 쓰는 게 낫다고 배움', '대기 중인 적을 깨우러 가지 않고 일찍 마무리하는 게 낫다고 배움'],
  wakeRatio: ['적이 더 강해도 깨우러 가는 게 낫다고 배움', '적이 충분히 약할 때만 깨우는 게 안전하다고 배움'],
  search: ['한 수 앞 탐색 없이 바로 고르는 게 낫다고 배움', '적 턴까지 내다보고 고르는 게 낫다고 배움'],
  srK: ['후보를 적게 보는 게 낫다고 배움', '후보를 많이 보는 게 낫다고 배움'],
  srSamples: ['표본 하나로 충분하다고 배움', '표본을 여럿 보는 게 낫다고 배움'],
  srDepth: ['적 턴까지만 보는 게 낫다고 배움', '한 턴 더 내다보는 게 낫다고 배움'],
  srHp: ['병력보다 경험치를 챙기는 게 낫다고 배움', '병력을 아끼는 게 낫다고 배움'],
  srLeader: ['유비 병력을 덜 따지는 게 낫다고 배움', '유비 병력을 꼭 지키는 게 낫다고 배움'],
  srFoe: ['적 병력을 깎는 데 덜 신경 쓰는 게 낫다고 배움', '적 병력을 깎아 두는 게 낫다고 배움'],
  srGap: ['최선에 가까운 대안만 보는 게 낫다고 배움', '조금 못한 대안도 시험하는 게 낫다고 배움'],
  srMargin: ['조금만 나아도 바꾸는 게 낫다고 배움', '확실히 나을 때만 바꾸는 게 낫다고 배움'],
  srProg: ['마무리를 서두르지 않는 게 낫다고 배움', '마무리 때 승리 조건을 서두르는 게 낫다고 배움'],
  srVerify: ['다시 확인하지 않는 게 낫다고 배움', '새 표본으로 다시 확인하는 게 낫다고 배움'],
  srLure: ['탐색만으로 싸우는 게 낫다고 배움', '탐색 중에도 유인 작전을 쓰는 게 낫다고 배움'],
  endHold: ['끝낼 수 있을 때 바로 끝내는 게 낫다고 배움', '마지막 턴까지 끝내기를 미루는 게 낫다고 배움'],
  endSpare: ['여유 턴을 적게 두는 게 낫다고 배움', '여유 턴을 넉넉히 두는 게 낫다고 배움'],
  nurse: ['회복 칸을 막아도 되는 게 낫다고 배움', '약해진 적이 회복하게 비워 주는 게 낫다고 배움'],
  milk: ['회복할 적도 바로 잡는 게 낫다고 배움', '회복할 적은 살려 두고 계속 때리는 게 낫다고 배움'],
  milkRatio: ['적이 아주 약할 때만 여유로 보는 게 낫다고 배움', '적이 꽤 남아도 여유로 보는 게 낫다고 배움'],
  steer: ['누구나 때리는 게 낫다고 배움', '레벨 낮은 아군에게 몰아주는 게 낫다고 배움'],
  hnDmg: ['경험치만 보는 게 낫다고 배움', '적 병력을 깎는 것도 쳐주는 게 낫다고 배움'],
  hnPush: ['지원군 뒤에도 버티는 게 낫다고 배움', '지원군을 쓰러뜨리면 바로 진격하는 게 낫다고 배움'],
  promoLead: ['전직 아이템 값을 덜 남기는 게 낫다고 배움', '전직 아이템 값을 일찍부터 남기는 게 낫다고 배움'],
  yjEscape: ['연주에서 탈출하지 않는 게 낫다고 배움', '연주에서 일찍 탈출하는 게 낫다고 배움'],
  yjSamples: ['연주 탈출 표본을 줄이는 게 낫다고 배움', '연주 탈출 표본을 늘리는 게 낫다고 배움'],
  column: ['약한 부대부터 움직이는 게 낫다고 배움', '목표에 가까운 부대부터 움직이는 게 낫다고 배움'],
  healRisk: ['가장 다친 아군부터 회복하는 게 낫다고 배움', '쓰러질 위기의 아군부터 회복하는 게 낫다고 배움'],
  lone: ['홀로 나서도 되는 게 낫다고 배움', '홀로 노출되는 칸을 피하는 게 낫다고 배움'],
  tacHit: ['책략은 늘 성공한다고 보는 게 낫다고 배움', '책략 성공 확률을 따지는 게 낫다고 배움'],
  idleFinish: ['빈 턴이 짧게 이어져도 마무리하는 게 낫다고 배움', '빈 턴을 오래 기다린 뒤 마무리하는 게 낫다고 배움'],
  pen: ['가두리 없이 싸우는 게 낫다고 배움', '적 하나를 가둬 두고 계속 때리는 게 낫다고 배움'],
  penRatio: ['나머지 적이 아주 약할 때만 가두는 게 낫다고 배움', '나머지 적이 남아 있어도 일찍 가두는 게 낫다고 배움'],
  penHarm: ['약한 적만 가두는 게 낫다고 배움', '센 적도 가두는 게 낫다고 배움'],
  penPrice: ['누구든 가둔 적을 때리는 게 낫다고 배움', '데미지당 경험치가 좋은 부대만 때리는 게 낫다고 배움'],
  penCell: ['가둔 적 옆에 꼭 붙지 않아도 된다고 배움', '가둔 적 사방을 막는 게 낫다고 배움'],
  penCounter: ['반격 경험치는 덜 따지는 게 낫다고 배움', '반격 경험치를 노려 붙는 게 낫다고 배움'],
  sell: ['안 쓰는 도구를 덜 파는 게 낫다고 배움', '팔아서 병법서를 많이 사는 게 낫다고 배움'],
  idleAp: ['쉬는 부대가 덜 걸어 나가는 게 낫다고 배움', '쉬는 부대가 적에게 더 걸어 나가는 게 낫다고 배움'],
  scrollEarn: ['병법서를 덜 던지는 게 낫다고 배움', '병법서를 더 던지는 게 낫다고 배움'],
  escIdle: ['출구를 일찍 비켜 주는 게 낫다고 배움', '출구를 더 오래 막는 게 낫다고 배움'],
  escWin: ['마지막까지 출구를 막는 게 낫다고 배움', '출구를 조금 일찍 비켜 주는 게 낫다고 배움'],
  bandFarm: ['군악대를 따로 챙기지 않는 게 낫다고 배움', '군악대를 살려 두고 그 MP로 책략을 쓰는 게 낫다고 배움'],
  bfRatio: ['나머지 적이 아주 약할 때만 군악대 농사를 하는 게 낫다고 배움', '적이 남아 있어도 일찍 군악대 농사를 하는 게 낫다고 배움'],
  bfSpare: ['안전해진 뒤에만 적 군악대를 살려 두는 게 낫다고 배움', '처음부터 적 군악대를 살려 두는 게 낫다고 배움'],
  bfCell: ['군악대 옆에 꼭 붙지 않아도 된다고 배움', 'MP가 모자란 부대가 군악대 옆에 붙는 게 낫다고 배움'],
  bfPen: ['적 군악대를 꼭 가두지 않아도 된다고 배움', '적 군악대를 가둬 두는 게 낫다고 배움'],
  bfEnd: ['마무리 턴을 넉넉히 남기는 게 낫다고 배움', '군악대 농사를 마지막 턴 가까이까지 하는 게 낫다고 배움'],
  gate: ['관문을 그냥 두는 게 낫다고 배움', '관문을 여는 게 낫다고 배움'],
  gateLate: ['관문을 주변 적이 없어지는 대로 여는 게 낫다고 배움', '관문을 정해진 턴에 여는 게 낫다고 배움'],
  farmReach: ['농사의 안전 판단에 전장의 모든 적을 세는 게 낫다고 배움', '농사의 안전 판단에 가까이 올 수 있는 적만 세는 게 낫다고 배움'],
  wakeAvoid: ['잠든 적 부대를 깨우는 적장 옆도 지나가는 게 낫다고 배움', '잠든 적 부대를 깨우는 적장을 피해 돌아가는 게 낫다고 배움'],
  wakeKill: ['돌아가는 길의 잠든 적을 적게 셈 (마무리를 늦게 시작)', '돌아가는 길의 잠든 적을 넉넉히 셈 (마무리를 일찍 시작)'],
  wakeReroll: ['길이 막힌 배치도 그대로 싸우는 게 낫다고 배움', '길이 막힌 배치면 첫 턴에 총퇴각해 다시 배치하는 게 낫다고 배움'],
  capture: ['모두 점령해야 이기는 칸들을 원군 전에 점령하는 게 낫다고 배움', '모두 점령해야 이기는 칸들을 노리지 않고 싸우는 게 낫다고 배움'],
  capSlack: ['성채로 늦게 출발 (경험치를 더 모음)', '성채로 일찍 출발 (점령이 확실함)'],
  capLast: ['마지막 성채를 원군 직전에 점령 (경험치를 더 모음)', '마지막 성채를 일찍 점령 (승리가 확실함)'],
  capLoot: ['성채 점령 중 보물 칸은 지나가다 밟을 때만 줍는 게 낫다고 배움', '성채 점령 중 비어 있는 보물 칸으로 한 부대를 보내는 게 낫다고 배움'],
  fireRing: ['성 안에 갇힌 적에게는 칠 수 있는 칸까지 걸어가고 칠 수 있는 부대만 보내는 게 낫다고 배움', '성 안에 갇힌 적에게도 예전처럼 직선 거리로 다가가는 게 낫다고 배움'],
  sleeper: ['증원을 멈춰 세우는 구역에 제때 한 부대를 보내는 게 낫다고 배움', '증원을 멈춰 세우는 구역에 따로 부대를 보내지 않는 게 낫다고 배움'],
  bandEnd: ['군악대 사냥을 마무리 시간에 맞춰 끝내는 게 낫다고 배움', '군악대 사냥을 마감 턴까지 이어가는 게 낫다고 배움'],
  castIdle: ['회복만 하는 턴을 더 오래 참고 기다리는 게 낫다고 배움', '싸움 없는 턴이 이어지면 더 빨리 적에게 다가가는 게 낫다고 배움'],
  finNeed: ['마무리를 예상보다 더 여유 있게 일찍 시작하는 게 안전하다고 배움', '마무리를 예상 턴에 더 가깝게 늦추는 게 이득이라고 배움'],
  finPath: ['가는 길의 적 하나마다 마무리 시간을 더 넉넉히 잡는 게 낫다고 배움', '가는 길의 적을 마무리 시간에 덜 반영해도 된다고 배움'],
  gainPick: ['일기토·설득 주인공을 먼저 출진시키는 게 낫다고 배움', '일기토·설득 주인공을 꼭 출진시키지 않아도 된다고 배움'],
  ambush: ['복병 구역을 피하다가 때를 골라 진을 치고 들어가는 게 낫다고 배움', '복병 구역을 따로 가리지 않는 게 낫다고 배움'],
  ambTurns: ['복병을 더 일찍 불러내 싸울 턴을 넉넉히 두는 게 낫다고 배움', '복병을 마무리 직전까지 미뤄도 된다고 배움'],
  duelKeep: ['일기토할 장수를 더 아끼는 게 낫다고 배움', '일기토할 장수도 다른 장수처럼 싸우게 하는 게 낫다고 배움'],
  finCharge: ['마무리를 시작하면 바로 승리 조건 장수에게 가는 게 낫다고 배움', '마지막 3분의 1 전까지는 가까운 적부터 치는 게 낫다고 배움'],
  duelOut: ['전세가 기울면 끝내는 일기토로 바로 마치는 게 낫다고 배움', '전세가 기울어도 일기토는 마무리 때까지 미루는 게 낫다고 배움'],
  duelReach: ['끝내는 일기토를 밀어붙이는 게 낫다고 배움', '끝내는 일기토를 밀어붙이지 않는 게 낫다고 배움'],
  ambWake: ['적을 깨우는 지역은 때가 될 때까지 피하는 게 낫다고 배움', '적을 깨우는 지역을 피하지 않는 게 낫다고 배움'],
  ypPlan: ['양평관에서 숲·다리·서쪽 강가 단계 작전을 쓰는 게 낫다고 배움', '양평관에서 단계 작전 없이 싸우는 게 낫다고 배움'],
  farmHold: ['마무리 중에도 잡을 적이 남으면 끝내는 공격을 미루는 게 낫다고 배움', '마무리가 시작되면 바로 끝내는 게 낫다고 배움'],
  holdWalk: ['기다리는 적에게 지형을 따라 걸어가는 게 낫다고 배움', '기다리는 적에게 걸어가지 않는 게 낫다고 배움'],
  wakeShut: ['길을 막은 깨우는 적장은 마무리까지 피하고 길목 앞에서 기다리는 게 낫다고 배움', '길을 막은 깨우는 적장 옆도 처음부터 지나가는 게 낫다고 배움'],
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
  candidates: { objective: number; n99: number; top15: number; wins: number; forced: number; seconds: number; cleared?: number; frontier?: { index: number; name: string } | null }[];
}

/** One campaign from the plain defaults vs one from defaults + the hints.json defaults (cli ab). */
export interface HintAb {
  hint: Partial<GrindParams>;
  /** A/B other than the first (heal) one: its name (hint-ab-<label>.json), what the "without" side was, and a Korean title. */
  label?: string;
  base?: Partial<GrindParams>;
  title?: string;
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
  /** Script gains the bot got / could have had (won battles), victory bonuses received, 유비's final level. */
  gainsFired?: number;
  gainsOpen?: number;
  bonuses?: number;
  liuBei?: number;
  control?: number;
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
${row('Lv99 장수', (x) => x.n99)}${row('상위 15명 레벨 합', (x) => x.top15)}${row('이긴 전투 / 강제 진행(5차까지의 비교만)', (x) => `${x.wins} / ${x.forced}`)}
${row('회복 책략 사용(회)', (x) => x.heals)}${row('회복으로 얻은 경험치', (x) => x.healExp)}${row('공격·상태 책략(회)', (x) => x.tactics)}${row('총 경험치', (x) => x.exp)}
${row('상위 장수', (x) => esc(x.roster.slice(0, 6).map((r) => `${r.name}${r.level}`).join(' ')))}</table>${learned}</div>`;
}

/** The other A/Bs (user tips): plain table, same columns plus the script gains. */
export function tipsAbHtml(abs: HintAb[]): string {
  if (!abs.length) return '<div class="card"><p class="dim">유저 팁 비교 실행(<code>cli.ts ab --label tips</code>)이 아직 없습니다.</p></div>';
  return abs
    .map((ab) => {
      const row = (t: string, f: (x: AbSide) => string | number | undefined) => `<tr><td>${t}</td><td class="num">${f(ab.without) ?? '-'}</td><td class="num">${f(ab.with) ?? '-'}</td></tr>`;
      return `<div class="card"><h3>${esc(ab.title ?? ab.label ?? '')}</h3><p>팁 없음: <code>${esc(JSON.stringify(ab.base ?? {}))}</code><br>팁 적용: <code>${esc(JSON.stringify(ab.hint))}</code><br><span class="dim">같은 탐색 시드·예산, 학습 없이 시작값 그대로 ${esc(ab.date.slice(0, 16))}</span></p>
<table><tr><th></th><th class="num">팁 없음</th><th class="num">팁 적용</th></tr>
${row('Lv99 장수', (x) => x.n99)}${row('상위 15명 레벨 합', (x) => x.top15)}${row('이긴 전투 / 강제 진행(5차까지의 비교만)', (x) => `${x.wins} / ${x.forced}`)}${row('유비 최종 레벨', (x) => x.liuBei)}
${row('스크립트 이득 달성 / 가능(이긴 전투)', (x) => (x.gainsFired === undefined ? undefined : `${x.gainsFired} / ${x.gainsOpen}`))}${row('전원 경험치 보너스 받은 전투', (x) => x.bonuses)}
${row('견제 책략(혼란·사기, 회)', (x) => x.control)}${row('회복 책략(회)', (x) => x.heals)}${row('총 경험치', (x) => x.exp)}${row('상위 장수', (x) => esc(x.roster.slice(0, 6).map((r) => `${r.name}${r.level}`).join(' ')))}</table></div>`;
    })
    .join('\n');
}

/** Per battle: the script's gains (bonus exp, duels, persuasions; got or not) and what ends it early. */
export function scriptHtml(battles: CampaignBattle[]): string {
  const rows = battles
    .filter((b) => b.script && (b.script.gains.length || b.script.early.length))
    .map((b) => {
      const g = b.script!.gains.map((x) => `${x.automatic ? '<span class="dim">' : ''}${esc(x.when)} → ${esc(x.gives)} ${x.automatic ? '(자동)</span>' : !b.won ? '<span class="dim">(패배)</span>' : x.fired ? '<b>✓</b>' : '✗'}`).join('<br>');
      return `<tr><td>${b.index + 1}. ${esc(b.name)}</td><td>${b.won ? '승리' : b.forced ? '강제' : '멈춤'}</td><td class="dim">${g}</td><td class="num">${b.script!.bonus || ''}</td><td class="dim">${esc(b.script!.early.join(' · '))}</td></tr>`;
    })
    .join('');
  return `<div class="card"><p>각 전투 스크립트(이벤트 블록)에서 찾은 이득: <b>전원 경험치</b>(DATA 4 → 승리 시 전장의 아군 전원이 받는 보너스, 4a30), <b>일기토</b>(지정 장수가 지정 적 옆에서 행동 → 그 장수 Lv+1, 적 퇴장), <b>설득</b>(유비가 지정 적 옆에서 행동 → 아군 합류, 유비 Lv+1), 그 밖의 레벨 증가. ✓ = 최고 실행의 봇이 달성, ✗ = 못 함. 오른쪽 열은 제한 턴보다 먼저 끝나거나 판이 바뀌는 조건(봇은 큰 증원 전에 마무리를 시작).</p>
<table><tr><th>전투</th><th>결과</th><th>조건 → 이득</th><th class="num">받은 보너스</th><th>일찍 끝나는 조건</th></tr>${rows || '<tr><td colspan="5" class="dim">아직 기록 없음(이 기능 이후의 세대부터 채워짐)</td></tr>'}</table></div>`;
}

export function scriptMarkdown(battles: CampaignBattle[]): string[] {
  const L: string[] = ['## 전투별 스크립트 이득(전원 경험치·일기토·설득)과 일찍 끝나는 조건', '', '| 전투 | 조건 → 이득 | 봇 | 일찍 끝나는 조건 |', '|---|---|---|---|'];
  for (const b of battles) {
    if (!b.script || (!b.script.gains.length && !b.script.early.length)) continue;
    const g = b.script.gains.map((x) => `${x.when} → ${x.gives}${x.automatic ? ' (자동)' : ''}`).join('<br>');
    const got = b.script.gains.map((x) => (x.automatic ? '-' : !b.won ? '패배' : x.fired ? '✓' : '✗')).join('<br>');
    L.push(`| ${b.index + 1}. ${b.name} | ${g} | ${got} | ${b.script.early.join(' · ')} |`);
  }
  L.push('');
  return L;
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

/** 유비's level after a won battle and the average level of the other officers that fought in it. */
function liuBeiAndTeam(b: CampaignBattle): { liuBei: number | null; teamAvg: number | null } {
  const liu = b.gains.find((g) => g.officer === 0);
  const team = b.gains.filter((g) => g.officer !== 0);
  return { liuBei: liu ? liu.levelAfter : null, teamAvg: team.length ? Math.round((team.reduce((a, g) => a + g.levelAfter, 0) / team.length) * 10) / 10 : null };
}

export function progressJson(st: EvolveState, live?: LiveStatus, ab?: HintAb, benches: Bench[] = [], abs: HintAb[] = []) {
  return {
    benches,
    hintAb: ab ?? null,
    tipsAb: abs,
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
      candidates: h.candidates.map((c) => ({ objective: c.objective, n99: c.n99, top15: c.top15, wins: c.wins, forced: c.forced, cleared: c.cleared ?? null, frontier: c.frontier ?? null, seconds: Math.round(c.ms / 100) / 10, params: c.params })),
      // where this generation's best run stopped (null = it reached the end); cleared = battles won before it
      frontier: h.frontier ?? null,
      cleared: h.cleared ?? null,
      fresh: !!h.fresh,
      // a restart-lineage generation: where its best run so far stands
      restart: h.restart ?? null,
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
          cleared: st.best.campaign.cleared ?? null,
          frontier: st.best.campaign.frontier ?? null,
          roster: st.best.campaign.roster,
          battles: st.best.campaign.battles.map((b) => ({ index: b.index, name: b.name, won: b.won, forced: b.forced, turns: b.turns, turnLimit: b.turnLimit, expTotal: b.expTotal, keep: b.params.keep, rerolls: b.params.rerolls ?? 0, native: !!b.params.native, lossReasons: b.lossReasons ?? null, tries: b.variantsTried, attempts: b.attempts ?? null, bought: boughtText(b.purchases), promoted: b.actions.promoted ?? 0, items: b.actions.item ?? 0, ...liuBeiAndTeam(b), early: b.script?.early ?? [], start: b.start ?? null })),
        }
      : null,
    rules: learnedRules(st),
    facts: st.best ? campaignFacts(st.best.campaign) : [],
    objective: '클리어한 전투 수(이야기 순서, 못 이긴 전투에서 그 실행은 멈춤) × 10,000,000 + Lv99 장수 수 × 100,000 + 상위 15명 레벨 합 × 50 + 클리어한 전투에서 얻은 경험치 ÷ 25 + 유비 레벨 × 50(유비를 아군과 함께 키우기; 빨리 끝낸 클리어보다 경험치를 많이 얻은 클리어가 위). 즉 더 멀리 간 실행이 항상 위이고, 같은 곳까지 갔으면 레벨로 비교. (5차까지의 실행은 못 이긴 전투를 강제 진행했고 클리어 항이 없었음)',
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

export function progressHtml(st: EvolveState, live?: LiveStatus, ab?: HintAb, benches: Bench[] = [], abs: HintAb[] = []): string {
  const data = progressJson(st, live, ab, benches, abs);
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
    .map((b) => `<tr><td>${b.index + 1}</td><td>${esc(b.name)}</td><td>${b.won ? '승리' : b.forced ? '<span class="bad">강제 진행</span>' : '<span class="bad">여기서 멈춤</span>'}</td><td class="num">${b.turns}/${b.turnLimit}</td><td class="num">${b.expTotal}</td><td class="num">${b.native ? '-' : b.keep}</td><td class="num">${b.rerolls}</td><td>${b.won ? (b.native ? '자동(게임 AI)' : '노가다 정책') : ''}</td><td class="num">${b.won ? b.attempts ?? '' : ''}</td><td class="dim">${esc(b.bought)}${b.promoted ? ` · 승진 ${b.promoted}` : ''}${b.items ? ` · 도구 사용 ${b.items}` : ''}</td><td class="dim">${b.lossReasons ? esc(Object.entries(b.lossReasons).sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r} ×${n}`).join(', ')) : ''}</td></tr>`)
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
<li><b>스크립트 이득과 일찍 끝나는 조건</b>: 전투마다 이벤트 블록을 읽어 전원 경험치 조건(특정 칸 도착·특정 적 격파 등), 일기토(지정 장수가 지정 적 옆에서 행동 → Lv+1), 설득(유비가 옆에서 행동 → 합류, 유비 Lv+1)을 찾고, 해당 장수를 그 칸·그 적 옆으로 보낸다(event 가중). 턴 이벤트(N턴 패배·N턴 승리·대규모 증원·아군 이탈)와 "이 장수가 쓰러지면 패배"도 읽어서, 6턴 이후 5부대 이상 증원이 오면 그 전에 마무리하고, 지켜야 할 아군은 유비처럼 보호한다.</li>
<li><b>지원 책략(격려·원조 등)</b>: 원작 b2d6 확인 결과 회복 계열(21–35)은 성공하면 +8(군악대·수송대 병종의 단일 회복은 +12), 대상이 이미 가득(병력 최대 또는 사기 100)이면 실패해 MP도 경험치도 없다. 격려(21)는 사기, 원조(24)는 병력 회복. 배우는 레벨(DS:0x4510): 유비 병종 0은 회복 없음, 승진 후 병종 1·2는 격려 Lv24·원조 Lv28, 병종 4·5 같음, 6–8은 격려 Lv12, 9–11은 격려 Lv16·원조 Lv20, 군악대(12)는 격려 Lv1부터. 봇은 사기·병력이 줄어든 아군을 찾아가 시전한다(유비가 레벨을 올려 승진해야 쓸 수 있음).</li>
<li><b>군악대</b>: 원작 7cc8 확인: 매 턴 시작에 군악대(병종 12) 상하좌우 4칸의 모든 부대(적 포함)가 MP += 군악대 레벨/10+1(최대 MP까지). 시뮬레이터도 같은 규칙. 봇은 책략을 쓰는 장수를 군악대 옆에 붙이고(band), 군악대 장수는 출진에 항상 넣는다.</li>
<li><b>유비도 싸운다</b>: 유비가 거의 공격하지 않은 이유는 위험 비용 때문에 뒤에 머물러 사거리 안에 적이 없었기 때문(신야2까지 Lv2는 강제 진행 기준 캡처의 값, 시뮬레이터 캠페인에서도 Lv4–5). 이제 유비도 가장 가까운 적에게 다가가고(lead), 막는 것은 "최악의 경우에도 죽지 않는가"(guard 1.0) 하나뿐이다.</li>
<li><b>견제 책략</b>: 혼란·사기 저하(15–20)는 공격 책략과 따로 가중(control)한다. 적을 죽이지 않고 묶어 두면서 +8을 받으므로 사냥을 오래 할 수 있다(유저 팁).</li>
<li><b>재도전</b>: 모든 작전이 지면, 플레이어처럼 전투 시작부터 다시 한다(시작 직후 총퇴각으로 난수를 바꿔 싸움 위주·수비 위주·버티기 작전을 번갈아, 최대 K번, 직전 최고 실행이 멈춘 전투는 2K번. 1턴부터 총대장·탈출 칸으로 돌진하는 비상수단(게임 AI 대행, 마무리 99)은 쓰지 않음 — 벽은 레벨로 넘음). 그래도 지면 그 실행은 거기서 멈춘다(예전: 강제 진행.</li>
<li><b>적응형 개체 수</b>: 분포가 넓을 때(초반)는 후보를 많이, 수렴하면 적게 뽑는다(--pop이 상한, 최소 4).</li>
</ol>
</div>

<h2>배운 것</h2>
<div class="card"><h3>최고 파라미터에서 읽은 규칙</h3><ul>${rules || '<li>아직 세대가 없습니다.</li>'}</ul>
<h3>세대별로 바뀐 생각</h3><ul>${moves}</ul></div>

<h2>사람의 힌트가 준 효과: 회복 책략 적극 사용</h2>
${abHtml(ab, st)}

<h2>유저 팁의 효과: 전원 경험치·일기토·설득, 견제 책략, 유비 안전과 막타</h2>
${tipsAbHtml(abs)}

<h2>전투별 스크립트 이득과 일찍 끝나는 조건</h2>
${scriptHtml(st.best?.campaign.battles ?? [])}

<h2>파라미터 변화(평균 ± 표준편차)</h2>
<div class="card"><div class="dim" style="margin-bottom:8px">선은 분포의 평균, 띠는 ±1 표준편차, 점은 그 세대 최고 후보의 값. 띠가 좁아지면 그 값에 수렴한 것.</div><div class="minis" id="minis"></div></div>

<div class="grid2">
<div><h2>최고 파라미터</h2><div class="card"><table>${params}</table></div></div>
<div><h2>최종 레벨(최고 실행)</h2><div class="card"><table><tr><th>장수</th><th class="num">Lv</th><th class="num">99 도달 전투#</th></tr>${roster}</table></div></div>
</div>

<h2>전투별 결과(최고 실행)</h2>
<div class="card"><table><tr><th>#</th><th>전투</th><th>결과</th><th class="num">턴</th><th class="num">경험치</th><th class="num">남긴 적</th><th class="num">총퇴각</th><th>방식</th><th class="num">승리까지 시도</th><th>상점 구입 · 승진 · 도구</th><th>실패 원인(시도별)</th></tr>${battles}</table>
<p class="dim">멈춤 = 이 실행의 모든 시도(기본·엘리트·변형·총퇴각 재시도)가 진 전투. 그 실행은 거기서 끝난다(강제로 이기고 넘어가지 않음). 점수는 그 전까지 클리어한 전투 수가 먼저이고, 다음 세대는 그 전투에 변형·재도전을 두 배로 쓴다. 원인 집계: ${esc(lossSummary(data.best?.battles ?? []))}</p></div>

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
<li><b>지금 막히는 곳</b>: 실행이 멈추는 전투(이전에는 강제 진행)의 대부분은 <b>유비 퇴각</b>으로 진다(위 표의 실패 원인). 유비가 Lv1~5에 머물러 병력 500으로는 장(3장) 이후 적 한 번의 공격에 쓰러진다.</li>
<li><b>유비의 경험치원(스크립트·엔진 조사)</b>: ① 승리 보너스(DATA 4, 보통 50)는 승리 순간 전장에 있는 아군 <i>전원</i>에게 주어진다(4a30). 유비는 모든 전투에 출진하므로 매번 받는다. ② 설득 이벤트는 유비가 지정 적 옆에서 행동하면 그 적이 합류하고 유비 Lv+1(태산·하구·팽성, 신도1 3회, 부 5회, 정군산 등 약 13레벨). ③ 레벨이 낮을수록 타격 경험치가 크다((레벨차+3)×2, 최대 16, 상대가 높으면 처치 32). 그래서 실제 플레이에서는 늘 출진하는 유비가 오히려 99를 찍기 쉽다. 봇은 이제 유비를 안전한 칸에만 두되(위험 비용, 닿는 적 1명당 비용, 유비 우선 회복) 다른 장수가 적을 깎아 두고 막타를 유비에게 넘긴다(feed). 유비도 15×99 목표에 포함된다.</li>
<li><b>장비</b>: 이 게임의 상점은 무기·방어구·말을 팔지 않는다(이야기로만 얻음). 상점에서 사는 것은 승진 도구, 회복·사기 도구, 책략서(폭탄류)다. 승진은 Lv15/30이 필요해서 레벨이 낮은 초반에는 도움이 안 된다. 상점 방문은 "그 마을에 상점 목록이 있으면 들른다"로 근사했다(포트의 필드 엔진은 도구상 건물 진입을 아직 구현하지 않음).</li>
<li><b>못 이긴 전투의 취급</b>: 재도전을 다 써도 못 이기면 그 실행은 그 전투에서 멈춘다(플레이어라면 거기서 막힌 것). 강제로 이기고 넘어가지 않는다. 학습 점수는 몇 번째 전투까지 갔는지가 먼저이고, 레벨은 같은 곳까지 간 실행끼리의 비교에 쓴다. 각 세대에서 최고 실행이 멈춘 전투는 progress.json의 generations[].frontier에 있다.</li>
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
kp('클리어 전투',best?(best.cleared??best.wins)+(best.frontier?' (멈춤: '+(best.frontier.index+1)+'. '+best.frontier.name+')':' (끝까지)'):'-');
kp('세대당 평균 시간',G.length?Math.round(G.reduce((s,g)=>s+g.seconds,0)/G.length)+'초':'-');
if(D.running){const r=D.running;const el=document.getElementById('live');const mins=Math.round((Date.now()-r.startedAt)/60000);
 el.innerHTML='<div class="card live"><b>진행 중: 세대 '+r.gen+'</b> · 후보 '+r.done+'/'+r.total+' 완료 · 시작 후 '+mins+'분<br><span class="dim">후보별 진행(전투): '+r.battles.map((b,i)=>'#'+i+' '+b+'/'+r.battleCount).join(' · ')+'</span>'+(r.candidates.length?'<br><span class="dim">끝난 후보: '+r.candidates.map(c=>'클리어 '+(c.cleared??c.wins)+(c.frontier?' (멈춤 '+(c.frontier.index+1)+'. '+c.frontier.name+')':'')+', Lv99 '+c.n99+', 합 '+c.top15+' ('+Math.round(c.seconds)+'초)').join(' · ')+'</span>':'')+'<br><span class="dim">마지막 갱신 '+new Date(D.updated).toLocaleString()+'</span></div>'}
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
    battles: battleRows(r.battles).map((b, i) => ({ ...b, predicted: r.battles[i].predicted, exact: r.battles[i].matched, outcome: r.battles[i].outcome, script: r.battles[i].script ?? null })),
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
  L.push(`- 전투 ${r.battles.length}회 (정책으로 승리 ${r.battles.filter((b) => b.won).length}, 봇이 못 이겨 하네스가 대신 넘긴 전투 ${r.battles.filter((b) => !b.won).length}; 학습(evolve)에서는 못 이긴 전투에서 실행이 멈추지만, 실제 게임 실행은 가이드를 끝까지 쓰려고 하네스가 대신 진행)`);
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
  L.push('- 승리 보너스(전원 경험치): 스크립트의 DATA 4가 정한 값(보통 50)을 승리 순간 전장의 아군 전원이 받는다. 조건(특정 칸 도착, 특정 적 격파 등)은 아래 표 참고. 한 전투에 하나만(덮어쓰기).');
  L.push('- 일기토: 지정 장수가 지정 적 옆에서 행동하면 일어나고 그 장수 Lv+1, 적은 퇴장(승리 조건 장수면 그대로 승리). 설득: 유비가 지정 적 옆에서 행동하면 그 적이 합류하고 유비 Lv+1.');
  L.push('- 유비는 모든 전투에 나가므로 승리 보너스를 매번 받고, 레벨이 낮을 때는 타격 16·처치 32를 받는다. 안전한 칸에서 다른 장수가 깎아 둔 적에게 막타를 치게 하면 99까지 키우기 쉽다.');
  L.push('- 견제 책략(혼란·사기 저하)은 적을 죽이지 않고 +8을 준다: 공격 책략보다 먼저, 회복과 함께 쓴다.');
  L.push('');
  if (p) {
    L.push('## 기본 작전');
    L.push('');
    for (const rule of learnedRules(st)) L.push(`- ${rule}`);
    L.push('');
  }
  L.push(...scriptMarkdown(r.battles));
  L.push('## 전투별 작전');
  L.push('');
  for (const b of r.battles) {
    L.push(`### ${b.index + 1}. ${CH[b.chapter] ?? b.chapter} ${b.name}의 전투`);
    L.push('');
    if (b.purchases?.length) L.push(`- 전투 전 상점 구입: ${boughtText(b.purchases)}.`);
    if (b.start) L.push(`- 시작: 소지금 ${b.start.gold}, 폭탄 ${b.start.bombs}개, 아군 상위 9명 평균 Lv${b.start.top9.toFixed(1)} (출진 평균 Lv${b.start.sortie.toFixed(1)}) / 적 평균 Lv${b.start.enemyAvg.toFixed(1)} (최고 Lv${b.start.enemyMax}, ${b.start.enemies}부대).`);
    if (!b.won) {
      L.push(`- 시뮬레이터 정책으로는 이기지 못함(학습 실행이라면 여기서 멈춤). 이후 전투는 참고용으로 하네스가 이 전투를 대신 넘긴 상태에서 계속. 경험치 ${b.expTotal}.`);
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

/** progress.md: the same summary as progress.html for readers who cannot open HTML. */
export function progressMarkdown(d: ReturnType<typeof progressJson>): string {
  const L: string[] = [];
  const best = d.best;
  L.push('# 노가다 학습 진행 상황\n');
  L.push(`갱신: ${d.updated}  `);
  L.push(`점수 기준: ${d.objective}\n`);
  L.push('## 현재 최고 기록\n');
  if (best) {
    const fr = best.frontier;
    L.push(`- 클리어한 전투: ${best.cleared ?? best.wins}개${fr ? ` (여기서 멈춤: ${fr.name})` : ' (끝까지 클리어)'}`);
    L.push(`- 상위 15명 레벨 합: ${best.top15} (목표 1485 = 15 × 99)`);
    L.push(`- Lv99 장수: ${best.n99}명`);
    const lb = best.roster.find((r) => r.officer === 0);
    if (lb) L.push(`- 유비: Lv${lb.level}`);
    L.push('\n| 순위 | 장수 | 레벨 |\n|---|---|---|');
    best.roster.slice(0, 15).forEach((r, i) => L.push(`| ${i + 1} | ${r.name} | ${r.level} |`));
    L.push('');
    if (best.battles.length) {
      L.push('## 최고 기록의 전투별 결과\n');
      L.push('턴: 사용한 턴 / 제한 턴. ※ 표시는 제한 턴 전에 끝나거나 바뀌는 전투(버티기 승리, 증원 등)라 턴을 다 못 쓰는 것이 정상일 수 있음.\n');
      L.push('| # | 전투 | 결과 | 턴 | 얻은 경험치 | 유비 레벨 | 아군 평균 레벨 | 시도 | 구입 |');
      L.push('|---|---|---|---|---|---|---|---|---|');
      for (const x of best.battles) {
        const res = x.won ? '승리' : x.forced ? '강제 진행' : '여기서 멈춤';
        const early = x.early.length ? ` ※ ${x.early.join(', ')}` : '';
        L.push(`| ${x.index + 1} | ${x.name} | ${res} | ${x.turns}/${x.turnLimit}${early} | ${x.expTotal} | ${x.liuBei ?? '-'} | ${x.teamAvg ?? '-'} | ${x.tries} | ${x.bought || ''} |`);
      }
      L.push('');
    }
  }
  L.push('## 세대별 결과\n');
  L.push('| 세대 | 막힌 전투 | 최고 점수 | 평균 점수 | 최고 후보 클리어 | 최고 후보 상위15 합 | Lv99 | 고정된 전투 수 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const g of d.generations) {
    const c = g.candidates.length ? g.candidates.reduce((a, b) => (b.objective > a.objective ? b : a)) : null;
    const rl = g.restart as { gen: number; wallName: string; level: number; cleared: number; frontier: { name: string } | null; top9: number; ended?: string } | null;
    const rtag = rl ? ` (재시작 계보 ${rl.gen}세대: ${rl.cleared}전 클리어${rl.frontier ? `, ${rl.frontier.name}에서 멈춤` : ''}, 상위9 평균 Lv${rl.top9} / 목표 Lv${rl.level}(${rl.wallName})${rl.ended ? `, 종료: ${rl.ended}` : ''})` : g.fresh ? ' (처음부터 재시작)' : '';
    L.push(`| ${g.gen + 1}${rtag} | ${g.frontier ? g.frontier.name : g.cleared !== null ? '끝까지' : '-'} | ${g.best} | ${g.mean} | ${c?.cleared ?? c?.wins ?? ''} | ${c?.top15 ?? ''} | ${g.bestN99} | ${g.frozen.length} |`);
  }
  if (d.running) L.push(`\n${d.running.gen + 1}세대 진행 중: 후보 ${d.running.done} / ${d.running.total}개 완료`);
  L.push('');
  L.push('## 학습으로 바뀐 전략\n');
  for (const m of d.moves) L.push(`- ${m.gen + 1}세대: ${m.text}`);
  L.push('');
  L.push('## 지금 쓰는 규칙\n');
  for (const r of d.rules) L.push(`- ${r}`);
  L.push('');
  L.push('## 관찰된 사실\n');
  for (const f of d.facts) L.push(`- ${f}`);
  L.push('');
  L.push('## 고수 팁 비교 (A/B)\n');
  L.push('| 비교 | 승리 (전/후) | 상위15 합 (전/후) | 총 경험치 (전/후) | 유비 (전/후) |');
  L.push('|---|---|---|---|---|');
  for (const ab of d.tipsAb) {
    const w = ab.without as unknown as Record<string, unknown>, x = ab.with as unknown as Record<string, unknown>;
    const t = ab as unknown as { title?: string; label?: string };
    const name = t.title || t.label || Object.entries(ab.hint ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
    L.push(`| ${name} | ${w.wins} → ${x.wins} | ${w.top15} → ${x.top15} | ${w.exp} → ${x.exp} | ${w.liuBei} → ${x.liuBei} |`);
  }
  L.push('');
  return L.join('\n') + '\n';
}
