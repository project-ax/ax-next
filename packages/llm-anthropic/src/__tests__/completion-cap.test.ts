import { afterEach, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createLlmAnthropicPlugin } from '../plugin.js';
import { MAX_COMPLETION_BYTES, MAX_ERROR_BYTES } from '../completion-fetch.js';

afterEach(() => vi.unstubAllGlobals());

it('pins the host completion and error budgets', () => {
  expect(MAX_COMPLETION_BYTES).toBe(4 * 1024 * 1024);
  expect(MAX_ERROR_BYTES).toBe(64 * 1024);
});

it('a normal completion still passes through the real SDK and configured fetch', async () => {
  const fakeFetch = vi.fn(async () => new Response(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  }), { headers: { 'content-type': 'application/json' } }));
  const bus = new HookBus();
  await createLlmAnthropicPlugin({ apiKey: 'test-key', fetchImpl: fakeFetch }).init({ bus, config: {} });
  await expect(bus.call('llm:call:anthropic', makeAgentContext({ agentId: 'a', userId: 'u', sessionId: 's' }), {
    messages: [{ role: 'user', content: 'hello' }],
  })).resolves.toMatchObject({ text: 'hello', usage: { inputTokens: 3, outputTokens: 2 } });
  expect(fakeFetch).toHaveBeenCalledOnce();
});

function counted(total: number) {
  const stats = { bytes: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (stats.bytes >= total) return c.close();
      stats.bytes += 16 * 1024;
      c.enqueue(new Uint8Array(16 * 1024).fill(0x61));
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, stats };
}

it.each([[200, 4 * 1024 * 1024], [400, 64 * 1024]])(
  'stops reading an Anthropic status %i body at its byte budget', async (status, limit) => {
    const { body, stats } = counted(16 * 1024 * 1024);
    const fakeFetch = vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fakeFetch);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ apiKey: 'test-key', retryDelayMs: 0 }).init({ bus, config: {} });
    await expect(bus.call('llm:call:anthropic', makeAgentContext({ agentId: 'a', userId: 'u', sessionId: 's' }), {
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({ code: 'unknown' });
    await vi.waitFor(() => expect(stats.cancelled).toBe(true));
    expect(stats.bytes).toBeLessThanOrEqual(limit + 32 * 1024);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  },
);
