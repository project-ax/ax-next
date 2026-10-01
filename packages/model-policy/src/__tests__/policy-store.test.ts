import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { createPolicyStore } from '../policy-store.js';
import { serializeStored } from '../policy.js';
import { POLICY_STORAGE_KEY } from '../shared.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const BUILTIN = { allowed: [OPUS, SONNET], default: SONNET };

function fakeLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  const l = {
    errors,
    debug() {},
    info() {},
    warn() {},
    error(msg: string) {
      errors.push(msg);
    },
    child() {
      return l;
    },
  } as Logger & { errors: string[] };
  return l;
}

function setup(opts: { ttlMs?: number } = {}) {
  const bus = new HookBus();
  const storage = new Map<string, Uint8Array>();
  const counts = { gets: 0, sets: 0 };
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>('storage:get', 'test', async (_c, i) => {
    counts.gets += 1;
    return { value: storage.get(i.key) };
  });
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>('storage:set', 'test', async (_c, i) => {
    counts.sets += 1;
    storage.set(i.key, i.value);
    return {};
  });
  let t = 0;
  const logger = fakeLogger();
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin', logger });
  const store = createPolicyStore({
    bus,
    builtin: BUILTIN,
    now: () => new Date(t),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return { store, storage, counts, ctx, logger, advance: (ms: number) => (t += ms) };
}

describe('createPolicyStore.read', () => {
  it('serves the built-in policy when nothing is saved', async () => {
    const { store, ctx } = setup();
    expect(await store.read(ctx)).toEqual({
      source: 'builtin',
      version: 0,
      allowed: [OPUS, SONNET],
      default: SONNET,
    });
  });

  it('serves a saved policy', async () => {
    const { store, storage, ctx } = setup();
    storage.set(
      POLICY_STORAGE_KEY,
      serializeStored({ version: 4, allowed: [KIMI], default: KIMI, updatedAt: 'T', updatedBy: 'u1' }),
    );
    expect(await store.read(ctx)).toEqual({
      source: 'admin',
      version: 4,
      allowed: [KIMI],
      default: KIMI,
      updatedAt: 'T',
      updatedBy: 'u1',
    });
  });

  it('falls back to the built-in policy, warns, and logs once when the saved document is corrupt', async () => {
    const { store, storage, ctx, logger, advance } = setup();
    storage.set(POLICY_STORAGE_KEY, new TextEncoder().encode('{nope'));
    const view = await store.read(ctx);
    expect(view).toMatchObject({ source: 'builtin', version: 0, warning: 'saved-policy-unreadable' });
    advance(15_001);
    await store.read(ctx);
    expect(logger.errors).toEqual(['model_policy_unreadable']);
  });

  it('caches reads inside the ttl and re-reads after it', async () => {
    const { store, counts, ctx, advance } = setup({ ttlMs: 1000 });
    await store.read(ctx);
    await store.read(ctx);
    expect(counts.gets).toBe(1);
    advance(1001);
    await store.read(ctx);
    expect(counts.gets).toBe(2);
  });

  it('returns copies, so a caller cannot corrupt the cache', async () => {
    const { store, ctx } = setup();
    const first = await store.read(ctx);
    first.allowed.push('anthropic/evil');
    expect((await store.read(ctx)).allowed).toEqual([OPUS, SONNET]);
  });
});

describe('createPolicyStore.save', () => {
  it('saves, bumps the version, and is visible to the next read at once (even inside the ttl)', async () => {
    const { store, ctx } = setup({ ttlMs: 60_000 });
    await store.read(ctx); // warm the cache with the built-in view
    const saved = await store.save(ctx, { baseVersion: 0, allowed: [KIMI, SONNET], default: KIMI }, 'usr_admin');
    expect(saved).toMatchObject({ ok: true, policy: { source: 'admin', version: 1, default: KIMI, updatedBy: 'usr_admin' } });
    expect(await store.read(ctx)).toMatchObject({ source: 'admin', version: 1, allowed: [KIMI, SONNET] });
  });

  it('rejects a stale baseVersion and leaves storage untouched', async () => {
    const { store, counts, ctx } = setup();
    await store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: SONNET }, 'u1');
    const setsBefore = counts.sets;
    const r = await store.save(ctx, { baseVersion: 0, allowed: [OPUS], default: OPUS }, 'u2');
    expect(r).toEqual({ ok: false, code: 'stale-version' });
    expect(counts.sets).toBe(setsBefore);
  });

  it('returns the validation error and writes nothing for an invalid policy', async () => {
    const { store, storage, ctx } = setup();
    const r = await store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: OPUS }, 'u1');
    expect(r).toMatchObject({ ok: false, code: 'default-not-selected' });
    expect(storage.size).toBe(0);
  });

  it('lets exactly one of two racing saves win', async () => {
    const { store, ctx } = setup();
    const [a, b] = await Promise.all([
      store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: SONNET }, 'u1'),
      store.save(ctx, { baseVersion: 0, allowed: [OPUS], default: OPUS }, 'u2'),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it('repairs a corrupt document: the next save (baseVersion 0) replaces it and clears the warning', async () => {
    const { store, storage, ctx } = setup();
    storage.set(POLICY_STORAGE_KEY, new TextEncoder().encode('garbage'));
    const r = await store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: SONNET }, 'u1');
    expect(r).toMatchObject({ ok: true, policy: { version: 1 } });
    const view = await store.read(ctx);
    expect(view.warning).toBeUndefined();
    expect(view.source).toBe('admin');
  });
});
