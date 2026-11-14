import { describe, it, expect } from 'vitest';
import {
  REFUSAL_DESCRIPTION,
  createIdentityGate,
  decideIdentity,
  emailDomain,
  isDomainAllowed,
  isOnApprovedDomain,
  parseDomains,
  type IdentityAttempt,
  type IdentityRefusal,
  type LocalUserFacts,
} from '../identity-gate.js';
import { captureOutput } from './support/capture-output.js';

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

// The one domain predicate: the sign-in gate (decideIdentity rule 5) applies it to
// one provider's list, isOnApprovedDomain across all of them.
describe('isDomainAllowed', () => {
  it('allows any email when the list is empty (blank = open, as at sign-in)', () => {
    expect(isDomainAllowed('x@anywhere.com', [])).toBe(true);
  });
  it('matches the domain case-insensitively', () => {
    expect(isDomainAllowed('X@Example.COM', ['example.com'])).toBe(true);
  });
  it('rejects an out-of-list domain', () => {
    expect(isDomainAllowed('x@evil.com', ['example.com'])).toBe(false);
  });
  it('rejects a subdomain of a listed domain (the match is exact)', () => {
    expect(isDomainAllowed('x@eng.example.com', ['example.com'])).toBe(false);
  });
  it('rejects an address with no domain', () => {
    expect(isDomainAllowed('garbage', ['example.com'])).toBe(false);
  });
});

// Approved domains for a check that isn't a sign-in (auth:find-user-by-email):
// on at least one non-blank list; blank lists add nothing; no lists = any domain.
describe('isOnApprovedDomain', () => {
  it('approves any domain when no provider has a list', () => {
    expect(isOnApprovedDomain('x@anywhere.com', [])).toBe(true);
    expect(isOnApprovedDomain('x@anywhere.com', [[], []])).toBe(true);
  });
  it("approves a domain on either provider's list", () => {
    const lists = [['canopyworks.com'], ['partner.org']];
    expect(isOnApprovedDomain('a@canopyworks.com', lists)).toBe(true);
    expect(isOnApprovedDomain('p@Partner.ORG', lists)).toBe(true);
    expect(isOnApprovedDomain('c@gmail.com', lists)).toBe(false);
  });
  it("a blank list doesn't open a restricted one (fails closed)", () => {
    expect(isOnApprovedDomain('c@gmail.com', [['canopyworks.com'], []])).toBe(false);
    expect(isOnApprovedDomain('c@gmail.com', [[], ['canopyworks.com']])).toBe(false);
  });
  it('a subdomain or an address with no domain is never on a list', () => {
    expect(isOnApprovedDomain('d@eng.canopyworks.com', [['canopyworks.com']])).toBe(false);
    expect(isOnApprovedDomain('garbage', [['canopyworks.com']])).toBe(false);
  });
});

/** The existing account, with its email optional: by default it's the one the provider names. */
type LocalRow = Omit<LocalUserFacts, 'email'> & { email?: string };

interface Row {
  name: string;
  attempt?: Partial<IdentityAttempt>;
  /** Google's list. Default `['canopyworks.com']`. */
  google?: readonly string[];
  /** GitHub's list. Default `[]` (open). */
  github?: readonly string[];
  local?: LocalRow;
  expected: IdentityRefusal | null;
}

const ATTEMPT: IdentityAttempt = {
  action: 'create-user',
  method: 'oauth',
  providerId: 'google',
  email: 'alice@canopyworks.com',
  emailVerified: true,
};

/**
 * `local` is `{ emailVerified, role, accountCount }`, plus the account's own
 * email when it isn't the one the provider names.
 */
function local(emailVerified: boolean, role: string, accountCount: number, email?: string): LocalRow {
  return { emailVerified, role, accountCount, ...(email !== undefined ? { email } : {}) };
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
  // An existing account takes a sign-in only when the provider vouches for
  // that account's OWN email. A GitHub link made through the old
  // trusted-provider hole is still on file; its holder can verify an address of
  // their own, and nothing else tells the two apart (TASK-1116 review, R1-R3).
  {
    name: 'sign-in whose provider names another email',
    attempt: { action: 'sign-in', providerId: 'github', email: 'imp@evil.example' },
    local: local(true, 'user', 2, 'alice@canopyworks.com'),
    expected: 'email_mismatch',
  },
  {
    name: 'admin sign-in whose provider names another email',
    github: ['canopyworks.com'],
    attempt: { action: 'sign-in', providerId: 'github', email: 'imp@evil.example' },
    local: local(false, 'admin', 1, 'admin@canopyworks.com'),
    expected: 'email_mismatch',
  },
  {
    name: 'another email is refused before its domain is looked at',
    github: ['canopyworks.com'],
    attempt: { action: 'sign-in', providerId: 'github', email: 'imp@evil.example' },
    local: local(true, 'user', 2, 'alice@canopyworks.com'),
    expected: 'email_mismatch',
  },
  {
    name: 'the same email in another case',
    attempt: { action: 'sign-in' },
    local: local(true, 'user', 1, 'Alice@CanopyWorks.COM'),
    expected: null,
  },
  // The email is the provider's own spelling, and only plain ASCII is ever
  // compared (sign-up-gate.test.ts K1/K2: the look-alike that made this rule).
  {
    name: 'an address beyond plain ASCII',
    attempt: { email: 'jos\u00e9@canopyworks.com' },
    expected: 'email_not_supported',
  },
  {
    name: 'an address with a space in it',
    attempt: { email: 'alice @canopyworks.com' },
    expected: 'email_not_supported',
  },
  {
    name: 'no address the gate can read',
    attempt: { email: null },
    expected: 'email_not_supported',
  },
  {
    // The admin pass is for the domain list, never for an address the gate can't compare.
    name: 'an admin gets no pass on an address beyond plain ASCII',
    attempt: { action: 'sign-in', email: 'boss@p\u00e4rtner.example' },
    local: local(true, 'admin', 1),
    expected: 'email_not_supported',
  },
  {
    name: 'link whose provider names another email',
    attempt: { action: 'link-account' },
    local: local(true, 'user', 1, 'bob@canopyworks.com'),
    expected: 'email_mismatch',
  },
  { name: 'sign-in that lands on no user', attempt: { action: 'sign-in' }, expected: 'account_not_linkable' },
];

describe('decideIdentity', () => {
  it.each(ROWS)('$name', ({ attempt, google, github, local: facts, expected }) => {
    const lists = new Map<string, readonly string[]>([
      ['google', google ?? ['canopyworks.com']],
      ['github', github ?? []],
    ]);
    const tried: IdentityAttempt = { ...ATTEMPT, ...attempt };
    // The account's own email is the one the provider names, unless the row says otherwise.
    const found = facts === undefined ? undefined : { email: tried.email ?? '', ...facts };
    expect(decideIdentity(tried, lists, found)).toBe(expected);
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

/**
 * What better-auth hands the gate on an OAuth callback: the provider's profile
 * exactly as it sent it, and `user.email` after better-auth's own
 * `toLowerCase()`. `user` overrides any field of the user it passes.
 */
function fromProvider(
  action: GateData['source']['action'],
  providerId: string,
  email: string,
  user: GateData['user'] = {},
): GateData {
  return {
    user: { email: email.toLowerCase(), emailVerified: true, ...user },
    source: { action, method: 'oauth', oauth: { providerId, profile: { email } } },
  };
}

describe('createIdentityGate', () => {
  const gate = createIdentityGate([
    { kind: 'google', allowedDomains: 'canopyworks.com' },
    { kind: 'github' },
    // Never wired: a row of another kind configures nothing.
    { kind: 'oidc', allowedDomains: '' },
  ]);

  it('lets an on-domain sign-up through without reading the database', async () => {
    await expect(gate(fromProvider('create-user', 'google', 'alice@canopyworks.com'), NO_DB)).resolves.toBeUndefined();
  });

  it('refuses with one generic sentence that names neither the email nor the list', async () => {
    const result = await gate(fromProvider('create-user', 'google', 'outsider@evil.example'), NO_DB);
    expect(result).toEqual({ error: 'email_domain_not_allowed', errorDescription: REFUSAL_DESCRIPTION });
    expect(REFUSAL_DESCRIPTION).toBe("This account can't sign in here. Ask your admin for help.");
  });

  it('treats a provider with no list as open, and a kind it does not gate as unconfigured', async () => {
    await expect(gate(fromProvider('create-user', 'github', 'x@anywhere.example'), NO_DB)).resolves.toBeUndefined();
    await expect(gate(fromProvider('create-user', 'oidc', 'x@idp.example'), NO_DB)).resolves.toEqual({
      error: 'sign_in_method_not_allowed',
      errorDescription: REFUSAL_DESCRIPTION,
    });
  });

  it("reads emailVerified from the provider's claim, never a truthy stand-in", async () => {
    // Only a real `true` counts: a string from an odd token fails closed.
    const truthy = 'true' as unknown as boolean;
    await expect(
      gate(fromProvider('create-user', 'google', 'alice@canopyworks.com', { emailVerified: truthy }), NO_DB),
    ).resolves.toEqual({ error: 'email_not_verified', errorDescription: REFUSAL_DESCRIPTION });
  });

  it("links the setup wizard's admin (role admin, no accounts) and nobody else unverified", async () => {
    const admin = { id: 'u-admin', email: 'admin@canopyworks.com', emailVerified: false, role: 'admin' };
    const data = fromProvider('link-account', 'google', 'admin@canopyworks.com', { id: 'u-admin' });
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

  it("compares the provider's email with the one on the account's own row", async () => {
    // GitHub's list is open here, so only the account's email can refuse it.
    const alice = { id: 'u-alice', email: 'Alice@CanopyWorks.com', emailVerified: true, role: 'user' };
    const signIn = (email: string): GateData => fromProvider('sign-in', 'github', email, { id: 'u-alice' });
    await expect(gate(signIn('imp@evil.example'), ctxWith(alice, [{ providerId: 'github' }]))).resolves.toEqual({
      error: 'email_mismatch',
      errorDescription: REFUSAL_DESCRIPTION,
    });
    await expect(gate(signIn('alice@canopyworks.com'), ctxWith(alice, [{ providerId: 'github' }]))).resolves.toBeUndefined();
    // A sign-in that lands on no user is refused, not waved through.
    await expect(gate(signIn('alice@canopyworks.com'), ctxWith(null, []))).resolves.toEqual({
      error: 'account_not_linkable',
      errorDescription: REFUSAL_DESCRIPTION,
    });
  });

  // better-auth lowercases `user.email` with full Unicode rules before it calls
  // the gate. The raw profile is the provider's own spelling.
  describe("decides from the email as the provider sent it, never better-auth's lowercased copy", () => {
    const kate = { id: 'u-kate', email: 'kate@canopyworks.com', emailVerified: true, role: 'user' };
    const NOT_SUPPORTED = { error: 'email_not_supported', errorDescription: REFUSAL_DESCRIPTION };

    it('refuses a look-alike that lowercases into the account\'s address', async () => {
      // U+212A KELVIN SIGN: `toLowerCase()` hands the gate `kate@canopyworks.com`.
      const data = fromProvider('sign-in', 'github', 'Kate@canopyworks.com', { id: 'u-kate' });
      expect(data.user.email).toBe('kate@canopyworks.com');
      await expect(gate(data, ctxWith(kate, [{ providerId: 'github' }]))).resolves.toEqual(NOT_SUPPORTED);
    });

    it('takes the same address in any ASCII case', async () => {
      const data = fromProvider('sign-in', 'github', 'Kate@CanopyWorks.com', { id: 'u-kate' });
      await expect(gate(data, ctxWith(kate, [{ providerId: 'github' }]))).resolves.toBeUndefined();
    });

    it('refuses when the profile names no email', async () => {
      const noProfile: GateData = {
        user: { id: 'u-kate', email: 'kate@canopyworks.com', emailVerified: true },
        source: { action: 'sign-in', method: 'oauth', oauth: { providerId: 'github' } },
      };
      await expect(gate(noProfile, ctxWith(kate, [{ providerId: 'github' }]))).resolves.toEqual(NOT_SUPPORTED);
      const notAString: GateData = {
        ...noProfile,
        source: { action: 'sign-in', method: 'oauth', oauth: { providerId: 'github', profile: { email: 42 } } },
      };
      await expect(gate(notAString, ctxWith(kate, [{ providerId: 'github' }]))).resolves.toEqual(NOT_SUPPORTED);
    });

    it('never approves one address while better-auth acts on another', async () => {
      // An on-list address in the profile can't carry an off-list one through.
      const data = fromProvider('create-user', 'google', 'alice@canopyworks.com', { email: 'mallory@evil.example' });
      await expect(gate(data, NO_DB)).resolves.toEqual(NOT_SUPPORTED);
    });
  });

  it('logs one code-only line per refusal, and nothing when it lets one through', async () => {
    const refused = await captureOutput(() => gate(fromProvider('create-user', 'google', 'outsider@evil.example'), NO_DB));
    expect(refused.result).toEqual({ error: 'email_domain_not_allowed', errorDescription: REFUSAL_DESCRIPTION });
    expect(refused.authLines).toEqual([
      {
        via: 'stderr',
        line: '[ax/auth-better] sign-in refused {"code":"email_domain_not_allowed","action":"create-user","provider":"google"}\n',
      },
    ]);
    // Never the email, its domain or the allowed list.
    for (const text of ['outsider', 'evil.example', 'canopyworks']) {
      expect(refused.output.join('')).not.toContain(text);
    }

    const allowed = await captureOutput(() => gate(fromProvider('create-user', 'google', 'alice@canopyworks.com'), NO_DB));
    expect(allowed.result).toBeUndefined();
    expect(allowed.output).toEqual([]);
  });

  it('lets an existing admin sign in from outside the list, and no member', async () => {
    const data = fromProvider('sign-in', 'google', 'boss@partner.example', { id: 'u-boss' });
    const boss = { id: 'u-boss', email: 'boss@partner.example', emailVerified: true, role: 'admin' };
    await expect(gate(data, ctxWith(boss, [{ providerId: 'google' }]))).resolves.toBeUndefined();
    await expect(gate(data, ctxWith({ ...boss, role: 'user' }, [{ providerId: 'google' }]))).resolves.toEqual({
      error: 'email_domain_not_allowed',
      errorDescription: REFUSAL_DESCRIPTION,
    });
  });
});
