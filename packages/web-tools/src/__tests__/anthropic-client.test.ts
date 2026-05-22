import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runWebSearch } from '../anthropic-client.js';

// Build a fake Anthropic client whose messages.create returns the queued
// responses in order (one per call, to exercise the pause_turn loop).
function fakeClient(responses: unknown[]): Anthropic {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { messages: { create } } as unknown as Anthropic;
}

const SEARCH_RESULT_RESPONSE = {
  stop_reason: 'end_turn',
  content: [
    { type: 'text', text: 'Here is what I found.' },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [
        { type: 'web_search_result', url: 'https://a.com', title: 'A', page_age: 'May 1, 2026', encrypted_content: 'SECRET' },
        { type: 'web_search_result', url: 'https://b.com', title: 'B', page_age: null, encrypted_content: 'SECRET2' },
      ],
    },
  ],
};

describe('runWebSearch', () => {
  it('harvests results, drops encrypted_content, maps page_age to age, collects summary', async () => {
    const client = fakeClient([SEARCH_RESULT_RESPONSE]);
    const out = await runWebSearch(client, { model: 'claude-sonnet-4-6', maxTokens: 1024 }, 'cats');
    expect(out).toEqual({
      query: 'cats',
      results: [
        { title: 'A', url: 'https://a.com', age: 'May 1, 2026' },
        { title: 'B', url: 'https://b.com' },
      ],
      summary: 'Here is what I found.',
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('continues through pause_turn up to the cap', async () => {
    const paused = { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'working' }] };
    const client = fakeClient([paused, SEARCH_RESULT_RESPONSE]);
    const out = await runWebSearch(client, { model: 'm', maxTokens: 100 }, 'cats');
    expect(out.results).toHaveLength(2);
    expect((client.messages.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it('throws a clean error when the search returns an error block', async () => {
    const errResp = {
      stop_reason: 'end_turn',
      content: [{ type: 'web_search_tool_result', tool_use_id: 's', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }],
    };
    const client = fakeClient([errResp]);
    await expect(runWebSearch(client, { model: 'm', maxTokens: 100 }, 'x')).rejects.toThrow(/max_uses_exceeded/);
  });
});
