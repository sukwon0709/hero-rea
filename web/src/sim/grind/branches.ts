// Grinding simulator: story branches. The battle list is captured from a headless playthrough
// (capture.ts), so the branches the story takes decide which battles the campaign fights. The
// script offers them as CHOOSE menus or as a choice of whom to talk to on the field (see
// StoryPick in native/dev/playthrough.ts). Without picks the harness takes the first menu option
// and the lowest-numbered field record, which happens to give 신도, 거록, 태산-하구-팽성, 하구 and
// 양양 (no 여남 battle), but 신야1 instead of 박망파.
//
// Locations are chapter/stage/block of the scenario script (tools/snrdis.py); option indices and
// officer numbers are the script's. Code only, no game text.

import type { StoryPick } from '../../native/dev/playthrough';

export interface StoryBranch {
  /** Short key for --branch key=option. */
  key: string;
  /** What the branch decides. */
  what: string;
  options: Record<string, StoryPick>;
  /** The walkthroughs' recommendation (NOTES-walkthroughs), the default. */
  recommended: string;
}

const BANDITS: Record<number, string> = { 1: '태산', 2: '하구', 3: '팽성' };

export const STORY_BRANCHES: StoryBranch[] = [
  {
    key: 'sindo',
    what: '호로관 이후: 신도 or 광천',
    options: { 신도: { at: [1, 0, 3], choose: [0] }, 광천: { at: [1, 0, 3], choose: [1] } },
    recommended: '신도',
  },
  {
    key: 'julu',
    what: '거록 (+50 at the fort) or 청하',
    options: { 거록: { at: [1, 0, 10], choose: [0] }, 청하: { at: [1, 0, 10], choose: [1] } },
    recommended: '거록',
  },
  {
    // the 소패 hub (options 1 태산, 2 하구, 3 팽성; 0 goes back to 소패 and, after one battle, offers
    // to skip the rest): the order the three bandit battles are fought in
    key: 'bandits',
    what: 'order of the 소패 bandit battles',
    options: Object.fromEntries(
      [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]].map((o) => [o.map((i) => BANDITS[i]).join('-'), { at: [1, 2, 2], choose: o } as StoryPick]),
    ),
    recommended: '태산-하구-팽성',
  },
  {
    // 여포 토벌: talk to 순욱 (68) to attack 하구, to 곽가 (61) for 팽성
    key: 'lubu',
    what: '여포 토벌: 하구 (관우 talks to 장료: +50) or 팽성',
    options: { 하구: { at: [1, 3, 0], talk: 68 }, 팽성: { at: [1, 3, 0], talk: 61 } },
    recommended: '하구',
  },
  {
    // after 영천: flee to 양양 (2000 gold, no battle) or fight at 여남 (a battle: inserts one, so the
    // battle indices after it shift; kept at 양양 by default so existing elites/hints still line up)
    key: 'runan',
    what: '양양 (flee, no battle) or 여남 (battle, +50 when 유비 escapes)',
    options: { 양양: { at: [2, 0, 12], choose: [0] }, 여남: { at: [2, 0, 12], choose: [1] } },
    recommended: '양양',
  },
  {
    // 신야 회의장: talk to 장비 (2) and stay in the castle -> 신야1 (ends turn 30), or lend 제갈량
    // (125) the sword -> 박망파 (40 turns, the walkthroughs' pick)
    key: 'bowang',
    what: '박망파 or 신야1',
    options: { 박망파: { at: [2, 3, 1], talk: 125 }, 신야1: { at: [2, 3, 1], talk: 2 } },
    recommended: '박망파',
  },
];

/** Branch choices: key -> option name. */
export type BranchChoice = Record<string, string>;

/** The recommended choices with `over` applied (unknown keys or options throw). */
export function branchChoice(over: BranchChoice = {}): BranchChoice {
  const out: BranchChoice = Object.fromEntries(STORY_BRANCHES.map((b) => [b.key, b.recommended]));
  for (const [k, v] of Object.entries(over)) {
    const b = STORY_BRANCHES.find((x) => x.key === k);
    if (!b) throw new Error(`unknown branch ${k} (${STORY_BRANCHES.map((x) => x.key).join(', ')})`);
    if (!b.options[v]) throw new Error(`branch ${k}: unknown option ${v} (${Object.keys(b.options).join(', ')})`);
    out[k] = v;
  }
  return out;
}

/** Parses "bowang=신야1,runan=여남" (or repeated --branch values). */
export function parseBranches(specs: string[]): BranchChoice {
  const over: BranchChoice = {};
  for (const spec of specs)
    for (const kv of spec.split(',').filter(Boolean)) {
      const [k, v] = kv.split('=');
      over[k.trim()] = (v ?? '').trim();
    }
  return branchChoice(over);
}

/** The playthrough picks for a choice. */
export function storyPicks(choice: BranchChoice): StoryPick[] {
  return STORY_BRANCHES.map((b) => b.options[choice[b.key] ?? b.recommended]);
}

/** What captures made before the picks took (the harness's first option / lowest record). */
export const LEGACY_BRANCHES: BranchChoice = { sindo: '신도', julu: '거록', bandits: '태산-하구-팽성', lubu: '하구', runan: '양양', bowang: '신야1' };

/** The branches a capture took (LEGACY_BRANCHES for captures made before the picks). */
export function capturedBranches(snaps: { branches?: BranchChoice }[]): BranchChoice {
  return snaps[0]?.branches ?? LEGACY_BRANCHES;
}

/** The keys whose options differ. */
export function branchDiff(a: BranchChoice, b: BranchChoice): string[] {
  return STORY_BRANCHES.map((x) => x.key).filter((k) => (a[k] ?? '') !== (b[k] ?? ''));
}

export function branchLine(choice: BranchChoice): string {
  return STORY_BRANCHES.map((b) => `${b.key}=${choice[b.key] ?? '?'}`).join(',');
}
