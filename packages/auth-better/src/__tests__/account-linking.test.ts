import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from '../migrations.js';

// Regression: the onboarding wizard creates the first admin as a bare email
// identity (no password — local password support is deferred). The ONLY way to
// then sign in is a social provider, but better-auth refuses to link a social
// sign-in to a pre-existing email unless that provider is trusted — it returns
// `account_not_linked` and the operator is locked out of their own admin
// account. The fix: configure `account.accountLinking.trustedProviders` so the
// email-verifying providers (google, github) auto-link by matching email.
//
// Same mechanism as trusted-origins.test.ts: mock `better-auth` to capture the
// exact config object passed to `betterAuth(...)` and assert on it, rather than
// driving a real OAuth round-trip.

const { capturedConfigs } = vi.hoisted(() => ({
  capturedConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('better-auth', () => ({
  betterAuth: (cfg: Record<string, unknown>) => {
    capturedConfigs.push(cfg);
    return {
      handler: async () => new Response(null, { status: 200 }),
      $context: Promise.resolve({}),
    };
  },
}));

const { createBetterAuthHandler } = await import('../handler.js');

const stubDb = {} as Kysely<AuthBetterDatabase>;

type AccountConfig = {
  accountLinking?: {
    enabled?: boolean;
    trustedProviders?: string[];
    requireLocalEmailVerified?: boolean;
  };
};

describe('createBetterAuthHandler — account linking', () => {
  beforeEach(() => {
    capturedConfigs.length = 0;
  });

  it('trusts the email-verifying providers (google, github) for auto-linking', () => {
    createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(capturedConfigs).toHaveLength(1);
    const account = capturedConfigs[0]?.['account'] as AccountConfig | undefined;
    expect(account?.accountLinking?.enabled).toBe(true);
    expect(account?.accountLinking?.trustedProviders).toEqual(['google', 'github']);
  });

  it('disables requireLocalEmailVerified so the unverified wizard admin can link', () => {
    // better-auth defaults requireLocalEmailVerified to true; the wizard admin
    // has email_verified=false, so the trustedProviders bypass alone is NOT
    // enough — this second clause must also be cleared or sign-in still throws
    // account_not_linked.
    createBetterAuthHandler({ database: stubDb, providers: [] });
    const account = capturedConfigs[0]?.['account'] as AccountConfig | undefined;
    expect(account?.accountLinking?.requireLocalEmailVerified).toBe(false);
  });

  it('does NOT trust generic oidc (email-verification varies by IdP)', () => {
    createBetterAuthHandler({ database: stubDb, providers: [] });
    const account = capturedConfigs[0]?.['account'] as AccountConfig | undefined;
    expect(account?.accountLinking?.trustedProviders).not.toContain('oidc');
  });
});
