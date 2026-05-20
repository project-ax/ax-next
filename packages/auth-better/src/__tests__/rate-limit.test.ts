import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from '../migrations.js';

// Pins `@ax/auth-better`'s built-in rate-limiter at 30 req / 60s / IP on
// `/auth/*`, always-on (no NODE_ENV gate).
//
// Better-auth's default rate-limiter is production-only and uses 100 req
// / 10s globally (= 600/min), which is too permissive for /auth/*.
// Without explicit config the boot would regress posture on:
//   - dev/test environments (rate-limit disabled entirely)
//   - OAuth callbacks + any /auth/* path without a built-in special-rule
//     (100 per 10s = 600/min — 20× more permissive than 30/min)
//
// This test pins the explicit `rateLimit` block on the `betterAuth({...})`
// call so a future refactor can't quietly drop it. The capture-mock
// pattern mirrors `trusted-origins.test.ts` — we never drive real
// better-auth rate-limit behavior here (that's covered by better-auth's
// own test suite); we assert the config we hand it.

const { capturedConfigs } = vi.hoisted(() => ({
  capturedConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('better-auth', () => ({
  betterAuth: (cfg: Record<string, unknown>) => {
    capturedConfigs.push(cfg);
    return {
      handler: async () => new Response(null, { status: 200 }),
      // build() attaches `.catch(...)` to swallow deferred adapter-init
      // failures; give it a never-rejecting promise so the test doesn't
      // trip an unhandled-rejection.
      $context: Promise.resolve({}),
    };
  },
}));

// Import AFTER vi.mock so the SUT picks up the mock.
const { createBetterAuthHandler } = await import('../handler.js');

const stubDb = {} as Kysely<AuthBetterDatabase>;

describe('createBetterAuthHandler — rateLimit posture', () => {
  beforeEach(() => {
    capturedConfigs.length = 0;
  });

  it('passes a rateLimit config to betterAuth() pinned at 30/min', () => {
    createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(capturedConfigs).toHaveLength(1);
    const rateLimit = capturedConfigs[0]?.['rateLimit'];
    expect(rateLimit).toEqual({
      enabled: true,
      window: 60,
      max: 30,
      storage: 'memory',
    });
  });

  it('forces enabled:true so dev/test environments are not regressed', () => {
    // Better-auth's untouched default is `enabled: isProduction`. We must
    // override to true so a `NODE_ENV=development` boot still rate-limits
    // /auth/* — always-on posture.
    createBetterAuthHandler({ database: stubDb, providers: [] });
    const rateLimit = capturedConfigs[0]?.['rateLimit'] as { enabled: unknown };
    expect(rateLimit.enabled).toBe(true);
  });

  it('global max is at or below 30 per 60s window', () => {
    // Pin the inequality, not just the literal values. If a future tweak
    // wants to tighten further (e.g., 20/min) this still passes — what we
    // refuse is regressing TO weaker than 30/min.
    createBetterAuthHandler({ database: stubDb, providers: [] });
    const rateLimit = capturedConfigs[0]?.['rateLimit'] as {
      window: number;
      max: number;
    };
    // Normalize to requests-per-minute so the assertion reads naturally
    // even if window/max change in lockstep (e.g., 15/30s == 30/60s).
    const requestsPerMinute = (rateLimit.max / rateLimit.window) * 60;
    expect(requestsPerMinute).toBeLessThanOrEqual(30);
  });

  it('rebuild() carries the rateLimit config through to the new handler', () => {
    const handle = createBetterAuthHandler({
      database: stubDb,
      providers: [],
    });
    expect(capturedConfigs).toHaveLength(1);
    handle.rebuild({
      database: stubDb,
      providers: [{ kind: 'google', clientId: 'x', clientSecret: 'y' }],
    });
    expect(capturedConfigs).toHaveLength(2);
    // Both configs carry the same rate-limit block — a rebuild never
    // silently drops it.
    expect(capturedConfigs[1]?.['rateLimit']).toEqual(
      capturedConfigs[0]?.['rateLimit'],
    );
  });
});
