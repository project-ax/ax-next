import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from '../migrations.js';

// TASK-8 regression — the flaky full-suite 57P01 teardown.
//
// better-auth's `betterAuth({...})` returns synchronously but kicks off an
// async adapter-init stored on `auth.$context` (a promise that runs DB
// queries to introspect the schema). Before this fix the plugin built the
// handler and NEVER awaited that promise — so the introspection query ran in
// the background, unawaited, and could still be in flight when a test tore
// down the shared pg.Pool / Postgres testcontainer. The dying connection
// then surfaced as `57P01` → `BetterAuthError: Failed to initialize database
// adapter`. Only the full suite hit it because its concurrency slowed the
// background init enough to lose the race against teardown.
//
// The fix gives `HandlerHandle` a `ready(): Promise<void>` seam that resolves
// only once the CURRENT instance's `$context` adapter-init settles, so the
// plugin's `init()` can drain it before reporting ready — no unawaited query
// left to race teardown.
//
// We mock `better-auth` so `$context` is a deferred promise WE control, which
// makes the "ready() awaits adapter init" contract assertable without a live
// DB. Lives in its own file because the module-level mock would interfere
// with handler.test.ts (which exercises real better-auth).

interface Deferred {
  promise: Promise<unknown>;
  resolve: (v?: unknown) => void;
  reject: (e?: unknown) => void;
}

function defer(): Deferred {
  let resolve!: (v?: unknown) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res as (v?: unknown) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Hoisted so the holder survives across cases; each betterAuth() call pulls
// the next queued deferred so a rebuild gets its own controllable $context.
const { contexts } = vi.hoisted(() => ({
  contexts: [] as Deferred[],
}));

vi.mock('better-auth', () => ({
  betterAuth: () => {
    const d = defer();
    contexts.push(d);
    return {
      handler: async () => new Response(null, { status: 200 }),
      $context: d.promise,
    };
  },
}));

const { createBetterAuthHandler } = await import('../handler.js');

const stubDb = {} as Kysely<AuthBetterDatabase>;

describe('createBetterAuthHandler — ready() adapter-init seam (TASK-8)', () => {
  beforeEach(() => {
    contexts.length = 0;
  });

  it('exposes ready() on the handle', () => {
    const handle = createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(typeof handle.ready).toBe('function');
  });

  it('ready() does not resolve until the adapter-init ($context) settles', async () => {
    const handle = createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(contexts).toHaveLength(1);

    let settled = false;
    const readyP = handle.ready().then(() => {
      settled = true;
    });

    // Give the microtask queue a few turns — ready() must still be pending
    // because $context hasn't resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    contexts[0]!.resolve({});
    await readyP;
    expect(settled).toBe(true);
  });

  it('ready() rejects (not an unhandled rejection) when adapter-init fails', async () => {
    const handle = createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(contexts).toHaveLength(1);

    const err = new Error('Failed to initialize database adapter');
    contexts[0]!.reject(err);

    await expect(handle.ready()).rejects.toThrow(
      'Failed to initialize database adapter',
    );
  });

  it('ready() tracks the CURRENT instance after rebuild()', async () => {
    const handle = createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(contexts).toHaveLength(1);
    // First instance's adapter-init settles.
    contexts[0]!.resolve({});
    await handle.ready();

    handle.rebuild({ database: stubDb, providers: [] });
    expect(contexts).toHaveLength(2);

    let settled = false;
    const readyP = handle.ready().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    // The new instance's $context is still pending → ready() must wait on it.
    expect(settled).toBe(false);

    contexts[1]!.resolve({});
    await readyP;
    expect(settled).toBe(true);
  });
});
