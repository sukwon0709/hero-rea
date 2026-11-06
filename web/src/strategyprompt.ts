// Classic mode: turns a player's battle instructions (Korean or any language) into a commander
// Strategy (commander.ts) with one Claude API call. The call is made from the browser with the
// player's own API key, which stays in that browser's localStorage. The per-turn orders are still
// computed locally, so a battle never waits for the API.

import Anthropic from '@anthropic-ai/sdk';
import { FOCUS_RULES, ROLES, sanitizeStrategy, type Strategy } from './commander';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'focus', 'chaseRange', 'retreatAt', 'leaderRetreatAt', 'units'],
  properties: {
    summary: { type: 'string', description: 'One short Korean sentence describing the strategy.' },
    focus: { type: 'string', enum: FOCUS_RULES },
    chaseRange: { type: 'integer', description: 'Cells (0-40) within which a free unit chases the focus target.' },
    retreatAt: { type: 'number', description: 'Troop fraction 0-1 at which units retreat to recover; 0 = never.' },
    leaderRetreatAt: { type: 'number', description: 'The same for 유비 (the player leader).' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role', 'retreatAt'],
        properties: {
          name: { type: 'string', description: 'Officer name in Korean as the game shows it, e.g. 관우.' },
          role: { type: 'string', enum: ROLES },
          retreatAt: { type: 'number', description: 'Troop fraction 0-1 for this officer; -1 = use the strategy value.' },
        },
      },
    },
  },
};

const SYSTEM = `You configure the battle AI of the DOS game 삼국지영걸전 (Sangokushi Eiketsuden), which controls the player's units during auto-battle.
The player describes, in their own words, how the army should fight. Translate it into the settings below; keep the default for anything the player does not mention.

How the AI works each turn:
- A unit whose troops are at or below its retreat threshold walks, without attacking, to the nearest free village, fortress or barracks and recovers there. 0 means it never retreats.
- The other units act by role:
  - free: chases the focus target if it is within chaseRange cells, else attacks the nearest enemy.
  - charge: always chases the focus target (or the enemy commander), wherever it is.
  - guard: stays next to 유비 and attacks only enemies in reach.
  - hold: stays where it is and attacks only enemies in reach.
- focus: commander = the enemy commander when it is near (else the weakest nearby enemy); weakest = the weakest nearby enemy; nearest = no shared target, every free unit attacks its nearest enemy.

Defaults: focus commander, chaseRange 8, retreatAt 0.4, leaderRetreatAt 0.6, no unit rules (every unit free, retreatAt -1).
Write officer names in Korean as the game spells them (유비, 관우, 장비, 조운, 제갈량, ...). Write the summary in Korean.`;

/** Asks Claude for a Strategy matching `prompt`. `knownUnits` are the player's officers in the last battle, if any. */
export async function promptToStrategy(apiKey: string, prompt: string, knownUnits: string[]): Promise<Strategy> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const units = knownUnits.length ? `\n\nOfficers in the player's army in the current battle: ${knownUnits.join(', ')}` : '';
  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `${prompt}${units}` }],
  });
  if (res.stop_reason === 'refusal') throw new Error('요청이 거절되었습니다. 다른 표현으로 다시 적어 주세요.');
  if (res.stop_reason === 'max_tokens') throw new Error('응답이 너무 길어 잘렸습니다. 다시 시도해 주세요.');
  const text = res.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('전략을 받지 못했습니다.');
  return sanitizeStrategy(JSON.parse(text.text));
}
