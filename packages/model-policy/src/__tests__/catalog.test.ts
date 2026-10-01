import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { createCatalog, normalizeModels, sanitizeLabel } from '../catalog.js';

function logger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  const l = {
    warns,
    debug() {},
    info() {},
    warn(msg: string) {
      warns.push(msg);
    },
    error() {},
    child() {
      return l;
    },
  } as Logger & { warns: string[] };
  return l;
}

const log = logger();
const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin', logger: log });
const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openrouter', name: 'OpenRouter' },
];

type Out = { status: 'live' | 'no-key' | 'error'; models: Array<{ ref: string; label: string }> };

function boot(handlers: Record<string, (() => Promise<unknown>) | undefined>) {
  const bus = new HookBus();
  const calls: Record<string, number> = {};
  for (const [hook, fn] of Object.entries(handlers)) {
    if (fn === undefined) continue;
    bus.registerService(hook, 'test', async () => {
      calls[hook] = (calls[hook] ?? 0) + 1;
      return fn();
    });
  }
  let t = 1_000_000;
  const catalog = createCatalog({
    bus,
    providers: PROVIDERS,
    now: () => t,
    ttlMs: 600_000,
    timeoutMs: 50,
    minRefreshMs: 15_000,
  });
  return { catalog, calls, advance: (ms: number) => (t += ms) };
}

const live = (...refs: string[]): Out => ({
  status: 'live',
  models: refs.map((ref) => ({ ref, label: `Label ${ref}` })),
});

describe('sanitizeLabel', () => {
  it('strips control, bidirectional and invisible characters and collapses whitespace', () => {
    expect(sanitizeLabel('  Claude‮ Son\u0000net\n 4.6​ ', 'fb')).toBe('Claude Son net 4.6');
  });
  it('caps the length at 120 characters', () => {
    expect(sanitizeLabel('a'.repeat(10_000), 'fb')).toHaveLength(120);
  });
  it('falls back for empty, whitespace-only, and non-string labels', () => {
    expect(sanitizeLabel('', 'fb')).toBe('fb');
    expect(sanitizeLabel('‮​', 'fb')).toBe('fb');
    expect(sanitizeLabel(42, 'fb')).toBe('fb');
  });
});

describe('normalizeModels', () => {
  it('keeps valid refs for the provider, dedupes, and sanitises labels', () => {
    expect(
      normalizeModels('openrouter', [
        { ref: 'openrouter/x-ai/grok-4.6', label: 'Grok‮ 4.6' },
        { ref: 'openrouter/x-ai/grok-4.6', label: 'dup' },
        { ref: 'openrouter/openai/gpt-6.1-sol-pro:batch', label: 'GPT batch' },
      ]),
    ).toEqual([
      { ref: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6' },
      { ref: 'openrouter/openai/gpt-6.1-sol-pro:batch', label: 'GPT batch' },
    ]);
  });

  it('accepts the list-supported shape ({ id, label })', () => {
    expect(normalizeModels('anthropic', [{ id: 'anthropic/claude-opus-4-7', label: 'Opus' }])).toEqual([
      { ref: 'anthropic/claude-opus-4-7', label: 'Opus' },
    ]);
  });

  it('drops hostile entries instead of failing', () => {
    const hostile = [
      { ref: 'anthropic/claude-x', label: 'wrong provider' }, // wrong prefix for openrouter
      { ref: 'openrouter/has space', label: 'x' },
      { ref: 'openrouter/evil‮id', label: 'x' },
      { ref: 'openrouter/line\nbreak', label: 'x' },
      { ref: `openrouter/${'a'.repeat(300)}`, label: 'too long' },
      { ref: 'nope', label: 'bare' },
      { ref: 42, label: 'not a string' },
      null,
      'a string',
      { label: 'no ref' },
    ];
    expect(normalizeModels('openrouter', hostile)).toEqual([]);
  });

  it('caps the list at 2000 models', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ ref: `openrouter/v/m-${i}`, label: `M${i}` }));
    expect(normalizeModels('openrouter', many)).toHaveLength(2000);
  });

  it('returns [] for a non-array', () => {
    expect(normalizeModels('openrouter', { nope: true })).toEqual([]);
  });
});

describe('createCatalog.get', () => {
  it('throttles refreshes after a failed first fetch, even without a good cache', async () => {
    const { catalog, calls, advance } = boot({
      'models:list-available:openrouter': async () => ({ status: 'error', models: [] }),
    });
    await catalog.get(ctx, { refresh: true });
    await catalog.get(ctx, { refresh: true });
    expect(calls['models:list-available:openrouter']).toBe(1);
    advance(15_001);
    await catalog.get(ctx, { refresh: true });
    expect(calls['models:list-available:openrouter']).toBe(2);
  });

  it('coalesces simultaneous provider requests', async () => {
    const { catalog, calls } = boot({
      'models:list-available:openrouter': async () => live('openrouter/a/b'),
    });
    await Promise.all([catalog.get(ctx, { refresh: true }), catalog.get(ctx, { refresh: true })]);
    expect(calls['models:list-available:openrouter']).toBe(1);
  });

  it('bounds fallback hooks as well as live hooks', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': async () => ({ status: 'error', models: [] }),
      'models:list-supported:openrouter': () => new Promise(() => {}),
    });
    const answer = await Promise.race([
      catalog.get(ctx, { refresh: false }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(answer?.providers[0]?.status).toBe('error');
  });

  it('omits providers that register no list-available hook', async () => {
    const { catalog } = boot({ 'models:list-available:openrouter': async () => live('openrouter/a/b') });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers.map((p) => p.id)).toEqual(['openrouter']);
  });

  it('returns live models with a fetchedAt and the provider display name', async () => {
    const { catalog } = boot({ 'models:list-available:anthropic': async () => live('anthropic/claude-opus-4-7') });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({
      id: 'anthropic',
      name: 'Anthropic',
      status: 'live',
      models: [{ ref: 'anthropic/claude-opus-4-7', label: 'Label anthropic/claude-opus-4-7' }],
    });
    expect(typeof r.providers[0]!.fetchedAt).toBe('string');
  });

  it('reuses the cache inside the ttl and refetches after it', async () => {
    const { catalog, calls, advance } = boot({ 'models:list-available:openrouter': async () => live('openrouter/a/b') });
    await catalog.get(ctx, { refresh: false });
    await catalog.get(ctx, { refresh: false });
    expect(calls['models:list-available:openrouter']).toBe(1);
    advance(600_001);
    await catalog.get(ctx, { refresh: false });
    expect(calls['models:list-available:openrouter']).toBe(2);
  });

  it('forces a refresh past the cache, but at most once per 15 s per provider', async () => {
    const { catalog, calls, advance } = boot({ 'models:list-available:openrouter': async () => live('openrouter/a/b') });
    await catalog.get(ctx, { refresh: false }); // 1
    await catalog.get(ctx, { refresh: true }); // forced: 2
    await catalog.get(ctx, { refresh: true }); // rate-limited: served from cache
    expect(calls['models:list-available:openrouter']).toBe(2);
    advance(15_001);
    await catalog.get(ctx, { refresh: true }); // allowed again: 3
    expect(calls['models:list-available:openrouter']).toBe(3);
  });

  it('reports no-key with no models', async () => {
    const { catalog } = boot({ 'models:list-available:openrouter': async () => ({ status: 'no-key', models: [] }) });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ id: 'openrouter', status: 'no-key', models: [] });
  });

  it('falls back to models:list-supported when the provider fails and nothing is cached', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': async () => {
        throw new Error('boom');
      },
      'models:list-supported:openrouter': async () => ({
        models: [{ id: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6', kind: 'either' }],
      }),
    });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({
      status: 'fallback',
      models: [{ ref: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6' }],
    });
    expect(log.warns).toContain('model_catalog_provider_failed');
  });

  it("reports 'error' with no models when there is no fallback either", async () => {
    const { catalog } = boot({ 'models:list-available:openrouter': async () => ({ status: 'error', models: [] }) });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ status: 'error', models: [] });
  });

  it("serves the last good list as 'cached' when a later fetch fails", async () => {
    let fail = false;
    const { catalog, advance } = boot({
      'models:list-available:openrouter': async () => (fail ? { status: 'error', models: [] } : live('openrouter/a/b')),
    });
    await catalog.get(ctx, { refresh: false });
    fail = true;
    advance(600_001);
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ status: 'cached', models: [{ ref: 'openrouter/a/b' }] });
  });

  it('treats a live answer with no valid models as a failure (broken response shape)', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': async () => ({ status: 'live', models: [{ ref: 'nope', label: 'x' }] }),
    });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ status: 'error', models: [] });
  });

  it('times out a slow provider without holding up the other one', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': () => new Promise(() => {}), // never resolves
      'models:list-available:anthropic': async () => live('anthropic/claude-opus-4-7'),
    });
    const r = await catalog.get(ctx, { refresh: false });
    const byId = Object.fromEntries(r.providers.map((p) => [p.id, p.status]));
    expect(byId).toEqual({ anthropic: 'live', openrouter: 'error' });
  });

  it('sanitises and filters what a provider returns', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': async () => ({
        status: 'live',
        models: [
          { ref: 'openrouter/ok/one', label: 'One‮' },
          { ref: 'openrouter/bad id', label: 'spaces' },
          { ref: 'anthropic/not-mine', label: 'wrong provider' },
        ],
      }),
    });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]!.models).toEqual([{ ref: 'openrouter/ok/one', label: 'One' }]);
  });
});
