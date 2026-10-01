import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createLlmAnthropicPlugin } from '../plugin.js';
import { fetchAnthropicModels } from '../models-available.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });

function stub(pages: Array<() => Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let n = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), headers });
    const page = pages[Math.min(n, pages.length - 1)]!;
    n += 1;
    return page();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchAnthropicModels', () => {

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
    expect(await fetchAnthropicModels(impl, 'key')).toEqual({ status: 'error', models: [] });
    expect(cancelled).toBe(true);
    expect(chunks).toBe(6);
  });

  it('lists models with the two required headers and a 1000-item page', async () => {
    const s = stub([
      () =>
        json({
          data: [
            { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', type: 'model' },
            { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', type: 'model' },
            { id: 'claude-noname' },
          ],
          has_more: false,
          last_id: 'claude-noname',
        }),
    ]);
    const out = await fetchAnthropicModels(s.impl, 'sk-ant-secret');
    expect(out).toEqual({
      status: 'live',
      models: [
        { ref: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
        { ref: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { ref: 'anthropic/claude-noname', label: 'claude-noname' },
      ],
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(s.calls[0]!.headers['x-api-key']).toBe('sk-ant-secret');
    expect(s.calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('follows has_more / last_id to the next page', async () => {
    const s = stub([
      () => json({ data: [{ id: 'm1', display_name: 'One' }], has_more: true, last_id: 'm1' }),
      () => json({ data: [{ id: 'm2', display_name: 'Two' }], has_more: false, last_id: 'm2' }),
    ]);
    const out = await fetchAnthropicModels(s.impl, 'k');
    expect(out.models.map((m) => m.ref)).toEqual(['anthropic/m1', 'anthropic/m2']);
    expect(s.calls[1]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=m1');
  });

  it('stops after 5 pages even if the server keeps saying has_more', async () => {
    const s = stub([() => json({ data: [{ id: 'm' }], has_more: true, last_id: 'm' })]);
    await fetchAnthropicModels(s.impl, 'k');
    expect(s.calls).toHaveLength(5);
  });

  it.each([
    ['a non-200 answer', () => json({ error: 'nope' }, 401)],
    ['malformed JSON', () => new Response('{nope', { status: 200 })],
    ['a body without a data array', () => json({ data: 'nope' })],
    ['a body over 5 MiB', () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200 })],
  ])('reports an error for %s', async (_label, respond) => {
    expect(await fetchAnthropicModels(stub([respond]).impl, 'k')).toEqual({ status: 'error', models: [] });
  });

  it('reports an error when the network throws, and never echoes the key', async () => {
    const impl = (async () => {
      throw new Error('boom sk-ant-secret');
    }) as typeof fetch;
    const out = await fetchAnthropicModels(impl, 'sk-ant-secret');
    expect(out).toEqual({ status: 'error', models: [] });
    expect(JSON.stringify(out)).not.toContain('sk-ant-secret');
  });
});

describe('models:list-available:anthropic (the registered hook)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it('static mode: uses the configured key', async () => {
    const s = stub([() => json({ data: [{ id: 'm1', display_name: 'One' }], has_more: false })]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ apiKey: 'sk-ant-static', fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:list-available:anthropic', ctx, {})).toEqual({
      status: 'live',
      models: [{ ref: 'anthropic/m1', label: 'One' }],
    });
    expect(s.calls[0]!.headers['x-api-key']).toBe('sk-ant-static');
  });

  it('credential-resolution mode: uses the stored key for the calling user', async () => {
    const s = stub([() => json({ data: [{ id: 'm1' }], has_more: false })]);
    const bus = new HookBus();
    const asked: Array<{ ref: string; userId: string }> = [];
    bus.registerService<{ ref: string; userId: string }, string>('credentials:get', 'test', async (_c, i) => {
      asked.push(i);
      return 'sk-ant-from-store';
    });
    await createLlmAnthropicPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    await bus.call('models:list-available:anthropic', ctx, {});
    expect(asked).toEqual([{ ref: 'provider:anthropic', userId: 'u1' }]);
    expect(s.calls[0]!.headers['x-api-key']).toBe('sk-ant-from-store');
  });

  it('credential-resolution mode with no key anywhere: no-key, and nothing goes on the wire', async () => {
    const s = stub([() => json({ data: [] })]);
    const bus = new HookBus();
    bus.registerService('credentials:get', 'test', async () => {
      throw new PluginError({ code: 'not-found', plugin: '@ax/credentials', message: 'none' });
    });
    await createLlmAnthropicPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:list-available:anthropic', ctx, {})).toEqual({ status: 'no-key', models: [] });
    expect(s.calls).toHaveLength(0);
  });
});
