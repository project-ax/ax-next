import { describe, it, expect } from 'vitest';
import {
  REFUSAL_DESCRIPTION,
  createIdentityGate,
  decideIdentity,
  emailDomain,
  parseDomains,
  type IdentityAttempt,
  type IdentityRefusal,
  type LocalUserFacts,
} from '../identity-gate.js';

// TASK-1116. The identity gate's rules, Docker-free. sign-up-gate.test.ts
// drives the same gate through the real better-auth handler.

describe('parseDomains', () => {
  it('splits comma-separated domains, trims + lowercases', () => {
    expect(parseDomains('Example.com, partner.org')).toEqual(['example.com','partner.org']);
  });
  it('returns [] for null/undefined/empty', () => {
    expect(parseDomains(null)).toEqual([]);
    expect(parseDomains(undefined)).toEqual([]);
    expect(parseDomains('   ')).toEqual([]);
  });
  it('drops empty entries from trailing/double commas', () => {
    expect(parseDomains('a.com,,b.com,')).toEqual(['a.com','b.com']);
  });
});

describe('emailDomain', () => {
  it('returns the lowercased domain after the last @', () => {
    expect(emailDomain('Alice@Example.COM')).toBe('example.com');
  });
  it('returns empty string when no @', () => {
    expect(emailDomain('garbage')).toBe('');
  });
  it('returns empty string for a trailing @ (no domain part)', () => {
    expect(emailDomain('user@')).toBe('');
  });
});

interface Row {
  name: string;
  attempt?: Partial<IdentityAttempt>;
  /** Google's list. Default `['canopyworks.com']`. */
  google?: readonly string[];
  /** GitHub's list. Default `[]` (open). */
  github?: readonly string[];
  local?: LocalUserFacts;
  expected: IdentityRefusal | null;
}

const ATTEMPT: IdentityAttempt = {
  action: 'create-user',
  method: 'oauth',
  providerId: 'google',
  email: 'alice@canopyworks.com',
  emailVerified: true,
};

/** `local` is `{ emailVerified, role, accountCount }`. */
function local(emailVerified: boolean, role: string, accountCount: number): LocalUserFacts {
  return { emailVerified, role, accountCount };
}

const ROWS: Row[] = [
  { name: 'on-domain create', expected: null },
  { name: 'off-domain create', attempt: { email: 'x@evil.example' }, expected: 'email_domain_not_allowed' },
  {
    name: 'mixed case and spaces',
    google: parseDomains(' CanopyWorks.com , partner.org '),
    attempt: { email: 'Alice@CanopyWorks.COM' },
    expected: null,
  },
  { name: 'subdomain', attempt: { email: 'bob@eng.canopyworks.com' }, expected: 'email_domain_not_allowed' },
  { name: 'open provider', google: [], attempt: { email: 'x@anywhere.example' }, expected: null },
  {
    name: 'per-provider lists',
    github: ['canopyworks.com'],
    google: [],
    attempt: { providerId: 'github', email: 'x@evil.example' },
    expected: 'email_domain_not_allowed',
  },
  { name: 'unverified', attempt: { emailVerified: false }, expected: 'email_not_verified' },
  {
    name: 'email/password',
    attempt: { method: 'email-password', providerId: undefined },
    expected: 'sign_in_method_not_allowed',
  },
  // Only OAuth counts, even when something names a configured provider.
  {
    name: 'non-OAuth method naming a configured provider',
    attempt: { method: 'magic-link', providerId: 'google' },
    expected: 'sign_in_method_not_allowed',
  },
  { name: 'unconfigured provider', attempt: { providerId: 'oidc' }, expected: 'sign_in_method_not_allowed' },
  {
    name: 'off-domain sign-in',
    attempt: { action: 'sign-in', email: 'x@evil.example' },
    local: local(true, 'user', 1),
    expected: 'email_domain_not_allowed',
  },
  {
    name: 'off-domain admin sign-in',
    attempt: { action: 'sign-in', email: 'boss@partner.example' },
    local: local(true, 'admin', 1),
    expected: null,
  },
  // The admin pass is for an existing user, never for a new account.
  {
    name: 'off-domain create gets no admin pass',
    attempt: { email: 'boss@partner.example' },
    local: local(true, 'admin', 1),
    expected: 'email_domain_not_allowed',
  },
  { name: 'on-domain sign-in', attempt: { action: 'sign-in' }, local: local(true, 'user', 1), expected: null },
  { name: 'link to verified', attempt: { action: 'link-account' }, local: local(true, 'user', 1), expected: null },
  {
    name: 'pre-registered',
    attempt: { action: 'link-account' },
    local: local(false, 'user', 1),
    expected: 'account_not_linkable',
  },
  // A member with no sign-in method yet is no setup admin.
  {
    name: 'unverified member with no accounts',
    attempt: { action: 'link-account' },
    local: local(false, 'user', 0),
    expected: 'account_not_linkable',
  },
  {
    name: 'setup admin first sign-in',
    attempt: { action: 'link-account', email: 'admin@canopyworks.com' },
    local: local(false, 'admin', 0),
    expected: null,
  },
  {
    name: 'promoted pre-registered admin',
    attempt: { action: 'link-account' },
    local: local(false, 'admin', 1),
    expected: 'account_not_linkable',
  },
  { name: 'user vanished', attempt: { action: 'link-account' }, expected: 'account_not_linkable' },
  {
    name: 'off-list setup admin',
    attempt: { action: 'link-account', email: 'admin@evil.example' },
    local: local(false, 'admin', 0),
    expected: null,
  },
  {
    name: 'off-list admin is still unverified-checked',
    attempt: { action: 'link-account', email: 'admin@evil.example', emailVerified: false },
    local: local(false, 'admin', 0),
    expected: 'email_not_verified',
  },
];

describe('decideIdentity', () => {
  it.each(ROWS)('$name', ({ attempt, google, github, local: facts, expected }) => {
    const lists = new Map<string, readonly string[]>([
      ['google', google ?? ['canopyworks.com']],
      ['github', github ?? []],
    ]);
    expect(decideIdentity({ ...ATTEMPT, ...attempt }, lists, facts)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// createIdentityGate: what it hands decideIdentity, from better-auth's call.
// ---------------------------------------------------------------------------

type Gate = ReturnType<typeof createIdentityGate>;
type GateData = Parameters<Gate>[0];
type GateCtx = Parameters<Gate>[1];

/** A context whose adapter knows one user. A create-user lookup would throw. */
function ctxWith(user: Record<string, unknown> | null, accounts: unknown[]): GateCtx {
  return {
    context: {
      internalAdapter: {
        findUserById: async (id: string) => (user !== null && user['id'] === id ? user : null),
        findAccounts: async () => accounts,
      },
    },
  } as unknown as GateCtx;
}

const NO_DB = {} as GateCtx;

function oauth(action: GateData['source']['action'], providerId: string): GateData['source'] {
  return { action, method: 'oauth', oauth: { providerId } };
}

describe('createIdentityGate', () => {
  const gate = createIdentityGate([
    { kind: 'google', allowedDomains: 'canopyworks.com' },
    { kind: 'github' },
    // Never wired: a row of another kind configures nothing.
    { kind: 'oidc', allowedDomains: '' },
  ]);

  it('lets an on-domain sign-up through without reading the database', async () => {
    await expect(
      gate({ user: { email: 'alice@canopyworks.com', emailVerified: true }, source: oauth('create-user', 'google') }, NO_DB),
    ).resolves.toBeUndefined();
  });

  it('refuses with one generic sentence that names neither the email nor the list', async () => {
    const result = await gate(
      { user: { email: 'outsider@evil.example', emailVerified: true }, source: oauth('create-user', 'google') },
      NO_DB,
    );
    expect(result).toEqual({ error: 'email_domain_not_allowed', errorDescription: REFUSAL_DESCRIPTION });
    expect(REFUSAL_DESCRIPTION).toBe("This account can't sign in here. Ask your admin for help.");
  });

  it('treats a provider with no list as open, and a kind it does not gate as unconfigured', async () => {
    await expect(
      gate({ user: { email: 'x@anywhere.example', emailVerified: true }, source: oauth('create-user', 'github') }, NO_DB),
    ).resolves.toBeUndefined();
    await expect(
      gate({ user: { email: 'x@idp.example', emailVerified: true }, source: oauth('create-user', 'oidc') }, NO_DB),
    ).resolves.toEqual({ error: 'sign_in_method_not_allowed', errorDescription: REFUSAL_DESCRIPTION });
  });

  it("reads emailVerified from the provider's claim, never a truthy stand-in", async () => {
    // Only a real `true` counts: a string from an odd token fails closed.
    const truthy = 'true' as unknown as boolean;
    await expect(
      gate({ user: { email: 'alice@canopyworks.com', emailVerified: truthy }, source: oauth('create-user', 'google') }, NO_DB),
    ).resolves.toEqual({ error: 'email_not_verified', errorDescription: REFUSAL_DESCRIPTION });
  });

  it("links the setup wizard's admin (role admin, no accounts) and nobody else unverified", async () => {
    const admin = { id: 'u-admin', email: 'admin@canopyworks.com', emailVerified: false, role: 'admin' };
    const data: GateData = {
      user: { id: 'u-admin', email: 'admin@canopyworks.com', emailVerified: true },
      source: oauth('link-account', 'google'),
    };
    await expect(gate(data, ctxWith(admin, []))).resolves.toBeUndefined();
    // Once it has a sign-in method, it's no longer waiting for its first one.
    await expect(gate(data, ctxWith(admin, [{ providerId: 'credential' }]))).resolves.toEqual({
      error: 'account_not_linkable',
      errorDescription: REFUSAL_DESCRIPTION,
    });
    // A row with no role is a member.
    await expect(gate(data, ctxWith({ ...admin, role: undefined }, []))).resolves.toEqual({
      error: 'account_not_linkable',
      errorDescription: REFUSAL_DESCRIPTION,
    });
    // A link that lands on no user.
    await expect(gate(data, ctxWith(null, []))).resolves.toEqual({
      error: 'account_not_linkable',
      errorDescription: REFUSAL_DESCRIPTION,
    });
  });

  it('lets an existing admin sign in from outside the list, and no member', async () => {
    const data: GateData = {
      user: { id: 'u-boss', email: 'boss@partner.example', emailVerified: true },
      source: oauth('sign-in', 'google'),
    };
    const boss = { id: 'u-boss', email: 'boss@partner.example', emailVerified: true, role: 'admin' };
    await expect(gate(data, ctxWith(boss, [{ providerId: 'google' }]))).resolves.toBeUndefined();
    await expect(gate(data, ctxWith({ ...boss, role: 'user' }, [{ providerId: 'google' }]))).resolves.toEqual({
      error: 'email_domain_not_allowed',
      errorDescription: REFUSAL_DESCRIPTION,
    });
  });
});
