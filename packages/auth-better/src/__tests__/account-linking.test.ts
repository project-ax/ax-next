import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from '../migrations.js';

// The onboarding wizard creates the first admin as a bare email identity (no
// password, email unverified). The ONLY way to then sign in is a social
// provider, so implicit linking stays on and better-auth's own "the local email
// must be verified" check stays off: otherwise the operator is locked out of
// their own admin account (`account_not_linked`).
//
// Who may link is decided by the identity gate (`user.validateUserInfo`,
// identity-gate.ts, TASK-1116): a provider-verified email, and an existing user
// that is verified or is that setup admin before its first sign-in. No provider
// is trusted to skip email verification: GitHub reports unverified emails, and
// trusting it let an unverified copy of a teammate's email take over their
// account.
//
// Same mechanism as trusted-origins.test.ts: mock `better-auth` to capture the
// exact config object passed to `betterAuth(...)` and assert on it. The real
// OAuth round-trips are in sign-up-gate.test.ts.

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

  it('trusts no provider to skip email verification (TASK-1116)', () => {
    createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(capturedConfigs).toHaveLength(1);
    const account = capturedConfigs[0]?.['account'] as AccountConfig | undefined;
    expect(account?.accountLinking?.enabled).toBe(true);
    expect(account?.accountLinking?.trustedProviders).toBeUndefined();
  });

  it('disables requireLocalEmailVerified so the unverified wizard admin can link', () => {
    // better-auth defaults requireLocalEmailVerified to true, and the wizard
    // admin has email_verified=false. better-auth can't make that one
    // exception, so its check is off and the identity gate enforces the rule
    // instead: the local user must be verified, or be the setup admin before
    // its first sign-in.
    createBetterAuthHandler({ database: stubDb, providers: [] });
    const account = capturedConfigs[0]?.['account'] as AccountConfig | undefined;
    expect(account?.accountLinking?.requireLocalEmailVerified).toBe(false);
  });

  it('gates every identity through user.validateUserInfo', () => {
    createBetterAuthHandler({ database: stubDb, providers: [] });
    const user = capturedConfigs[0]?.['user'] as { validateUserInfo?: unknown } | undefined;
    expect(typeof user?.validateUserInfo).toBe('function');
  });

  it('never takes a role from a client or a provider profile (TASK-1116)', () => {
    // `input: false`: better-auth refuses `role` on /update-user and drops it
    // from a provider's profile, so only the setup wizard or SQL makes an admin.
    createBetterAuthHandler({ database: stubDb, providers: [] });
    const user = capturedConfigs[0]?.['user'] as
      | { additionalFields?: { role?: { input?: boolean; defaultValue?: unknown } } }
      | undefined;
    expect(user?.additionalFields?.role?.input).toBe(false);
    expect(user?.additionalFields?.role?.defaultValue).toBe('user');
  });

  it('turns email and password sign-in off (TASK-1116)', () => {
    // A typed email proves nothing without a verification mail, and ax sends
    // none. `enabled: false` also stops a password set before the fix.
    createBetterAuthHandler({ database: stubDb, providers: [] });
    expect(capturedConfigs[0]?.['emailAndPassword']).toEqual({ enabled: false });
  });

  it('refuses Google ID tokens posted by a client (TASK-1116)', () => {
    createBetterAuthHandler({
      database: stubDb,
      providers: [{ kind: 'google', clientId: 'c', clientSecret: 's' }],
    });
    const socialProviders = capturedConfigs[0]?.['socialProviders'] as
      | Record<string, { disableIdTokenSignIn?: boolean }>
      | undefined;
    expect(socialProviders?.['google']?.disableIdTokenSignIn).toBe(true);
  });
});
