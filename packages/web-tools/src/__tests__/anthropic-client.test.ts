import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runWebSearch, runWebExtract } from '../anthropic-client.js';

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

  it('throws when the server keeps pausing past the iteration cap', async () => {
    const paused = { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'still working' }] };
    // Never reaches end_turn — every iteration is pause_turn.
    const client = fakeClient([paused, paused, paused, paused, paused, paused]);
    await expect(runWebSearch(client, { model: 'm', maxTokens: 100 }, 'x')).rejects.toThrow(/pause_turn|cap/i);
  });

  it('throws when no web_search_tool_result block is returned (tool never ran)', async () => {
    const noToolResp = {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I answered from memory without searching.' }],
    };
    const client = fakeClient([noToolResp]);
    await expect(runWebSearch(client, { model: 'm', maxTokens: 100 }, 'x')).rejects.toThrow(/no web_search_tool_result/i);
  });
});

const FETCH_RESPONSE = {
  stop_reason: 'end_turn',
  content: [
    {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srv_2',
      content: {
        type: 'web_fetch_result',
        url: 'https://example.com/article',
        content: {
          type: 'document',
          title: 'Article Title',
          source: { type: 'text', media_type: 'text/plain', data: 'Full article text.' },
        },
      },
    },
  ],
};

describe('runWebExtract', () => {
  it('returns extracted text + title for a text/plain document', async () => {
    const client = fakeClient([FETCH_RESPONSE]);
    const out = await runWebExtract(client, { model: 'm', maxTokens: 1024 }, 'https://example.com/article', 50000);
    expect(out).toEqual({
      url: 'https://example.com/article',
      title: 'Article Title',
      text: 'Full article text.',
    });
  });

  it('throws unsupported for a binary/PDF (base64) document', async () => {
    const pdf = {
      stop_reason: 'end_turn',
      content: [{
        type: 'web_fetch_tool_result',
        tool_use_id: 's',
        content: { type: 'web_fetch_result', url: 'https://x/p.pdf', content: { type: 'document', title: null, source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } } },
      }],
    };
    const client = fakeClient([pdf]);
    await expect(runWebExtract(client, { model: 'm', maxTokens: 100 }, 'https://x/p.pdf', 1000)).rejects.toThrow(/unsupported/i);
  });

  it('throws a clean error on a fetch error block', async () => {
    const errResp = {
      stop_reason: 'end_turn',
      content: [{ type: 'web_fetch_tool_result', tool_use_id: 's', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } }],
    };
    const client = fakeClient([errResp]);
    await expect(runWebExtract(client, { model: 'm', maxTokens: 100 }, 'https://x', 1000)).rejects.toThrow(/url_not_accessible/);
  });
});
