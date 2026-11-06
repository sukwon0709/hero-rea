import { describe, expect, it } from 'vitest';
import { branchChoice, branchDiff, capturedBranches, LEGACY_BRANCHES, parseBranches, storyPicks, STORY_BRANCHES } from '../src/sim/grind/branches';

describe('grind story branches', () => {
  it('defaults to the walkthrough picks', () => {
    const c = branchChoice();
    expect(c).toEqual({ sindo: '신도', julu: '거록', bandits: '태산-하구-팽성', lubu: '하구', runan: '양양', bowang: '박망파' });
    // the playthrough picks: 제갈량 (125) in the 신야 council for 박망파, the hub in 태산-하구-팽성 order
    const picks = storyPicks(c);
    expect(picks).toContainEqual({ at: [2, 3, 1], talk: 125 });
    expect(picks).toContainEqual({ at: [1, 2, 2], choose: [1, 2, 3] });
  });

  it('parses overrides and rejects unknown keys or options', () => {
    expect(parseBranches(['bowang=신야1,runan=여남']).bowang).toBe('신야1');
    expect(parseBranches(['bowang=신야1', 'bandits=팽성-태산-하구']).bandits).toBe('팽성-태산-하구');
    expect(storyPicks(parseBranches(['bandits=팽성-태산-하구']))).toContainEqual({ at: [1, 2, 2], choose: [3, 1, 2] });
    expect(() => parseBranches(['bowang=장판파'])).toThrow(/unknown option/);
    expect(() => parseBranches(['nope=1'])).toThrow(/unknown branch/);
  });

  it('treats captures without branches as the old default path', () => {
    expect(capturedBranches([{}])).toEqual(LEGACY_BRANCHES);
    expect(branchDiff(LEGACY_BRANCHES, branchChoice())).toEqual(['bowang']);
    expect(STORY_BRANCHES.every((b) => b.options[b.recommended] && b.options[LEGACY_BRANCHES[b.key]])).toBe(true);
  });
});
