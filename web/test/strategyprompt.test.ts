import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptToStrategy } from '../src/strategyprompt';

afterEach(() => vi.unstubAllGlobals());

describe('strategy prompt', () => {
  it('sends the prompt with a JSON schema and cleans the answer', async () => {
    let body: Record<string, unknown> = {};
    let headers: Headers = new Headers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        headers = new Headers(init.headers);
        const answer = { summary: '관우 돌격', focus: 'commander', chaseRange: 10, retreatAt: 0.3, leaderRetreatAt: 0.6, units: [{ name: '관우', role: 'charge', retreatAt: -1 }] };
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: JSON.stringify(answer) }],
            stop_reason: 'end_turn',
            stop_details: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const st = await promptToStrategy('sk-ant-api03-test', '관우는 돌격', ['유비', '관우']);
    expect(st.units).toEqual([{ name: '관우', role: 'charge', retreatAt: null }]);
    expect(st.retreatAt).toBe(0.3);
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect((body.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect(JSON.stringify(body.messages)).toContain('유비, 관우');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(headers.get('authorization')).toBe('Bearer sk-ant-api03-test');
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
  });
});
