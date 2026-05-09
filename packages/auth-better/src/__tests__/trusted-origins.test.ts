import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from '../migrations.js';

// FU-2 — Phase 1 follow-up. better-auth's CSRF protection on email/password
// sign-in, OAuth callbacks, and CSRF-token-bearing forms relies on
// `trustedOrigins` to bound which origins can complete an auth flow.
//
// We mock the `better-auth` module at the file level so we can capture the
// exact config passed into `betterAuth(...)` and assert `trustedOrigins`
// without driving real CSRF behavior (which would require a live HTTP
// server + DB and is brittle to library internals).
//
// This test lives in its own file because the global mock would interfere
// with `handler.test.ts`'s rebuild-error assertion — that test exercises
// real better-auth's failure path.

// Hoisted by vitest before module evaluation; the holder array survives
// across test cases so we can clear it in beforeEach.
const { capturedConfigs } = vi.hoisted(() => ({
  capturedConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('better-auth', () => ({
  betterAuth: (cfg: Record<string, unknown>) => {
    capturedConfigs.push(cfg);
    return {
      // Real better-auth returns `auth.handler: (req) => Promise<Response>`.
      handler: async () => new Response(null, { status: 200 }),
      // build() in handler.ts attaches `.catch(...)` to $context to swallow
      // deferred adapter-init failures; satisfy that with a never-rejecting
      // promise so we don't trip an unhandled-rejection during the test.
      $context: Promise.resolve({}),
    };
  },
}));

// Import AFTER vi.mock so the SUT picks up the mock.
const { createBetterAuthHandler } = await import('../handler.js');

const stubDb = {} as Kysely<AuthBetterDatabase>;

describe('createBetterAuthHandler — trustedOrigins plumbing', () => {
  beforeEach(() => {
    capturedConfigs.length = 0;
  });

  it('passes an explicit trustedOrigins list to betterAuth()', () => {
    createBetterAuthHandler({
      database: stubDb,
      providers: [],
      trustedOrigins: ['https://ax.example.com', 'http://localhost:8080'],
    });
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]?.['trustedOrigins']).toEqual([
      'https://ax.example.com',
      'http://localhost:8080',
    ]);
  });

  it("falls back to ['*'] when trustedOrigins is omitted", () => {
    createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]?.['trustedOrigins']).toEqual(['*']);
  });

  it('rebuild() forwards the new trustedOrigins value to betterAuth()', () => {
    const handle = createBetterAuthHandler({
      database: stubDb,
      providers: [],
      trustedOrigins: ['https://old.example.com'],
    });
    expect(capturedConfigs).toHaveLength(1);
    handle.rebuild({
      database: stubDb,
      providers: [],
      trustedOrigins: ['https://new.example.com'],
    });
    expect(capturedConfigs).toHaveLength(2);
    expect(capturedConfigs[1]?.['trustedOrigins']).toEqual([
      'https://new.example.com',
    ]);
  });
});
