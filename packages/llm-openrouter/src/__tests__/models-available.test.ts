import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createLlmOpenRouterPlugin } from '../plugin.js';
import { fetchOpenRouterModels } from '../models-available.js';

const BASE = 'https://openrouter.ai/api/v1';
const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

function stub(respond: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), method: init?.method, headers });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchOpenRouterModels', () => {

  it('stops reading and cancels an oversized streaming response', async () => {
    let chunks = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        if (chunks <= 8) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const impl = (async () => new Response(stream)) as typeof fetch;
    expect(await fetchOpenRouterModels(impl, BASE, 'key')).toEqual({ status: 'error', models: [] });
    expect(cancelled).toBe(true);
    expect(chunks).toBe(6);
  });

  it('maps the public list to refs and labels and sends the key as a Bearer token', async () => {
    const s = stub(() =>
      json({
        data: [
          { id: 'x-ai/grok-4.6', name: 'xAI: Grok 4.6' },
          { id: 'openai/gpt-6.1-sol-pro:batch', name: 'OpenAI: GPT-6.1 Sol Pro (batch)' },
          { id: 'no-name/model' },
        ],
      }),
    );
    const out = await fetchOpenRouterModels(s.impl, BASE, 'sk-or-secret');
    expect(out).toEqual({
      status: 'live',
      models: [
        { ref: 'openrouter/x-ai/grok-4.6', label: 'xAI: Grok 4.6' },
        { ref: 'openrouter/openai/gpt-6.1-sol-pro:batch', label: 'OpenAI: GPT-6.1 Sol Pro (batch)' },
        { ref: 'openrouter/no-name/model', label: 'no-name/model' },
      ],
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ url: `${BASE}/models`, method: 'GET' });
    expect(s.calls[0]!.headers.authorization).toBe('Bearer sk-or-secret');
  });

  it('skips entries without a usable id', async () => {
    const s = stub(() => json({ data: [{ id: 42 }, { id: '' }, null, 'x', { id: 'ok/one', name: 'One' }] }));
    const out = await fetchOpenRouterModels(s.impl, BASE, 'k');
    expect(out.models.map((m) => m.ref)).toEqual(['openrouter/ok/one']);
  });

  it.each([
    ['a non-200 answer', () => json({ error: 'nope' }, 500)],
    ['malformed JSON', () => new Response('{nope', { status: 200 })],
    ['a body without a data array', () => json({ data: 'nope' })],
    ['a body over 5 MiB', () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200 })],
  ])('reports an error for %s', async (_label, respond) => {
    const out = await fetchOpenRouterModels(stub(respond).impl, BASE, 'k');
    expect(out).toEqual({ status: 'error', models: [] });
  });

  it('reports an error when the network throws, and never echoes the key', async () => {
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED sk-or-secret');
    }) as typeof fetch;
    const out = await fetchOpenRouterModels(impl, BASE, 'sk-or-secret');
    expect(out).toEqual({ status: 'error', models: [] });
    expect(JSON.stringify(out)).not.toContain('sk-or-secret');
  });
});

describe('models:list-available:openrouter (the registered hook)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });

  it('static mode: uses the configured key', async () => {
    const s = stub(() => json({ data: [{ id: 'a/b', name: 'B' }] }));
    const bus = new HookBus();
    await createLlmOpenRouterPlugin({ apiKey: 'sk-static', fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    const out = await bus.call('models:list-available:openrouter', ctx, {});
    expect(out).toEqual({ status: 'live', models: [{ ref: 'openrouter/a/b', label: 'B' }] });
    expect(s.calls[0]!.headers.authorization).toBe('Bearer sk-static');
  });

  it('credential-resolution mode: uses the stored key for the calling user', async () => {
    const s = stub(() => json({ data: [{ id: 'a/b', name: 'B' }] }));
    const bus = new HookBus();
    const asked: Array<{ ref: string; userId: string }> = [];
    bus.registerService<{ ref: string; userId: string }, string>('credentials:get', 'test', async (_c, i) => {
      asked.push(i);
      return 'sk-from-store';
    });
    await createLlmOpenRouterPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    await bus.call('models:list-available:openrouter', ctx, {});
    expect(asked).toEqual([{ ref: 'provider:openrouter', userId: 'u1' }]);
    expect(s.calls[0]!.headers.authorization).toBe('Bearer sk-from-store');
  });

  it('credential-resolution mode with no key anywhere: no-key, and nothing goes on the wire', async () => {
    const s = stub(() => json({ data: [] }));
    const bus = new HookBus();
    bus.registerService('credentials:get', 'test', async () => {
      throw new PluginError({ code: 'not-found', plugin: '@ax/credentials', message: 'none' });
    });
    await createLlmOpenRouterPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:list-available:openrouter', ctx, {})).toEqual({ status: 'no-key', models: [] });
    expect(s.calls).toHaveLength(0);
  });
});
