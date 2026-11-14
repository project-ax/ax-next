import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { HookBus, PluginError, createLogger, type AgentContext } from '@ax/core';
import { createAuthBetterPlugin } from '../plugin.js';
import type { AuthBetterDatabase } from '../migrations.js';
import type {
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  FindUserByEmailInput,
  FindUserByEmailOutput,
} from '../index.js';

// ---------------------------------------------------------------------------
// auth:find-user-by-email contract (TASK-1092).
//
// The hook maps an email that an identity provider verified (Slack, for
// @ax/channel-slack) to the AX account that owns it. Returning the wrong
// person's id hands one person's agent to another, so every rule fails closed:
// ASCII case-insensitive but otherwise exact (printable ASCII only), verified
// accounts only, approved sign-in domains only, and two verified case variants
// match nobody. It returns only the id.
//
// We exercise the BUS surface, as bootstrap-user.test.ts does. Rows are
// seeded AFTER boot: the hook reads the tables at call time, and init's
// loadProviders then never tries to decrypt the dummy Google secret.
// ---------------------------------------------------------------------------

const HOOK = 'auth:find-user-by-email';

let container: StartedPostgreSqlContainer;
let connectionString: string;
let harness: TestHarness | undefined;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

async function dropTables(): Promise<void> {
  const k = new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    await k.schema.dropTable('auth_providers').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_verifications').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_accounts').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_sessions').ifExists().execute();
    await k.schema.dropTable('auth_better_v1_users').ifExists().execute();
  } finally {
    await k.destroy().catch(() => {});
  }
}

async function bootHarness(): Promise<TestHarness> {
  await dropTables();
  // Same mocks as bootstrap-user.test.ts: no http-server, and pass-through
  // envelope hooks so verifyCalls() lets the plugin boot.
  return createTestHarness({
    services: {
      'http:register-route': async (_ctx, _input) => ({ unregister: () => {} }),
      'credentials:envelope-encrypt': async (_ctx, input) => ({
        ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
      }),
      'credentials:envelope-decrypt': async (_ctx, input) => ({
        plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
      }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAuthBetterPlugin(),
    ],
  });
}

afterEach(async () => {
  if (harness !== undefined) {
    await harness.close({ onError: () => {} });
    harness = undefined;
  }
});

/** Run `fn` on a short-lived connection of our own, closed afterwards. */
async function withDb(fn: (k: Kysely<AuthBetterDatabase>) => Promise<unknown>): Promise<void> {
  const k = new Kysely<AuthBetterDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    await fn(k);
  } finally {
    await k.destroy().catch(() => {});
  }
}

interface SeedUser {
  id: string;
  email: string;
  verified: boolean;
}

interface SeedProvider {
  allowedDomains: string | null;
  enabled: boolean;
}

const DEFAULT_GOOGLE: SeedProvider = { allowedDomains: 'canopyworks.com', enabled: true };

/**
 * Insert user rows, the `google` provider row unless `google` is null, and the
 * `github` row when `github` is given. The secrets are dummies: nothing
 * decrypts them, because the rows land after boot and this test never fires
 * auth:providers-changed.
 */
async function seed(
  users: SeedUser[],
  google: SeedProvider | null = DEFAULT_GOOGLE,
  github: SeedProvider | null = null,
): Promise<void> {
  await withDb(async (k) => {
    const now = new Date();
    if (users.length > 0) {
      await k
        .insertInto('auth_better_v1_users')
        .values(
          users.map((u) => ({
            id: u.id,
            email: u.email,
            email_verified: u.verified,
            name: null,
            image: null,
            role: 'user' as const,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
    }
    for (const [kind, row] of [['google', google], ['github', github]] as const) {
      if (row === null) continue;
      await k
        .insertInto('auth_providers')
        .values({
          kind,
          client_id: 'cid',
          client_secret_encrypted: Buffer.from('x'),
          discovery_url: null,
          allowed_domains: row.allowedDomains,
          enabled: row.enabled,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  });
}

/** One more provider row, of a kind the sign-in gate doesn't wire. */
async function insertProviderRow(kind: string, allowedDomains: string): Promise<void> {
  await withDb(async (k) => {
    const now = new Date();
    await k
      .insertInto('auth_providers')
      .values({
        kind,
        client_id: 'cid',
        client_secret_encrypted: Buffer.from('x'),
        discovery_url: null,
        allowed_domains: allowedDomains,
        enabled: true,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
}

function find(email: string, ctx?: AgentContext): Promise<FindUserByEmailOutput> {
  if (harness === undefined) throw new Error('boot the harness first');
  return harness.bus.call<FindUserByEmailInput, FindUserByEmailOutput>(
    HOOK,
    ctx ?? harness.ctx(),
    { email },
  );
}

const ALICE: SeedUser = { id: 'usr_alice', email: 'alice@canopyworks.com', verified: true };
const CAROL: SeedUser = { id: 'usr_carol', email: 'carol@gmail.com', verified: true };

describe('auth:find-user-by-email contract', () => {
  it('returns only the id for a verified email on an approved domain', async () => {
    harness = await bootHarness();
    await seed([ALICE]);

    const r = await find('alice@canopyworks.com');
    expect(r).toEqual({ userId: 'usr_alice' });
    // Nothing but the id leaves: no email, name or admin flag.
    expect(Object.keys(r!)).toEqual(['userId']);
  });

  it('returns null when no account has that email', async () => {
    harness = await bootHarness();
    await seed([ALICE]);

    expect(await find('zed@canopyworks.com')).toBeNull();
  });

  it('matches case-insensitively in both directions', async () => {
    harness = await bootHarness();
    await seed([ALICE, { id: 'usr_bob', email: 'Bob@CanopyWorks.com', verified: true }]);

    // Mixed-case input, lowercase stored row.
    expect(await find('ALICE@CanopyWorks.COM')).toEqual({ userId: 'usr_alice' });
    // Lowercase input, mixed-case stored row (the wizard stores what was typed).
    expect(await find('bob@canopyworks.com')).toEqual({ userId: 'usr_bob' });
  });

  it('an unverified email is never found: the wizard admin until a provider verifies it', async () => {
    harness = await bootHarness();
    const created = await harness.bus.call<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
      'auth:create-bootstrap-user',
      harness.ctx(),
      { displayName: 'Admin', email: 'admin@canopyworks.com' },
    );
    await seed([{ id: 'usr_frank', email: 'frank@canopyworks.com', verified: false }]);

    expect(await find('admin@canopyworks.com')).toBeNull();
    expect(await find('frank@canopyworks.com')).toBeNull();

    // A Google or GitHub sign-in that links the account flips the flag.
    await withDb((k) =>
      k
        .updateTable('auth_better_v1_users')
        .set({ email_verified: true })
        .where('id', '=', created.user.id)
        .execute(),
    );
    expect(await find('admin@canopyworks.com')).toEqual({ userId: created.user.id });
    // Frank still isn't, with a verified account elsewhere in the table.
    expect(await find('frank@canopyworks.com')).toBeNull();
  });

  it('an unverified row never stands in for another account and never makes the verified owner ambiguous', async () => {
    // Email/password sign-up is open over the API (TASK-1116), so anyone can
    // hold an unverified row under somebody else's address. The verified rule
    // is part of the match itself, before ambiguity is counted.
    harness = await bootHarness();
    await seed([
      // The owner, as Google sign-up stores it (lowercased) and verifies it.
      ALICE,
      // An unverified case variant of the same address: e.g. a wizard admin
      // typed as 'ALICE@…', or a pre-registered row.
      { id: 'usr_squatter', email: 'ALICE@canopyworks.com', verified: false },
      // Bob's address, pre-registered by someone else. Bob never signed in.
      { id: 'usr_prereg', email: 'bob@canopyworks.com', verified: false },
    ]);

    // Correct: the verified owner, never the unverified row, and not null
    // (the unverified variant is not a second match).
    expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
    expect(await find('ALICE@canopyworks.com')).toEqual({ userId: 'usr_alice' });
    // None: the unverified holder isn't found, and the verified row elsewhere
    // doesn't stand in for it.
    expect(await find('bob@canopyworks.com')).toBeNull();
  });

  it('two unverified case variants never crowd out the verified owner', async () => {
    // Guards the verified rule staying inside the query. A refactor to "fetch
    // two matches, then drop the unverified ones in JS" fails here: the
    // variants are inserted first, so a scan that stops at two sees only them.
    harness = await bootHarness();
    await seed([
      { id: 'usr_variant_upper', email: 'GRACE@canopyworks.com', verified: false },
      { id: 'usr_variant_mixed', email: 'Grace@canopyworks.com', verified: false },
      { id: 'usr_grace', email: 'grace@canopyworks.com', verified: true },
    ]);

    expect(await find('grace@canopyworks.com')).toEqual({ userId: 'usr_grace' });
    expect(await find('GRACE@canopyworks.com')).toEqual({ userId: 'usr_grace' });
  });

  it('an email on another domain is not found, including a subdomain', async () => {
    harness = await bootHarness();
    await seed([CAROL, { id: 'usr_dave', email: 'dave@eng.canopyworks.com', verified: true }]);

    expect(await find('carol@gmail.com')).toBeNull();
    // Exact domain match, the same as sign-in: a subdomain is another domain.
    expect(await find('dave@eng.canopyworks.com')).toBeNull();
  });

  it('no wildcard, prefix, substring or Unicode lookalike match', async () => {
    harness = await bootHarness();
    // No Google row, so any domain is approved: only the match rules decide.
    await seed([ALICE, CAROL], null);

    for (const probe of [
      '%',
      '%@canopyworks.com',
      '_lice@canopyworks.com',
      'lice@canopyworks.com',
      'alice@canopyworks.co',
      'alice@canopyworks.com.evil.org',
      ' alice@canopyworks.com',
      'alice@canopyworks.com ',
      // Lookalikes a locale-aware lower() folds onto ASCII: U+0130 (dotted
      // capital I) to 'i', U+212A (Kelvin sign) to 'k'. Only A-Z may fold.
      'al\u0130ce@canopyworks.com',
      'alice@canopywor\u212As.com',
      'carol@gma\u0130l.com',
      // Fullwidth 'a' (U+FF41): no Unicode normalization either.
      '\uFF41lice@canopyworks.com',
      // Refused before any query, so a NUL byte is a miss, not a database error.
      'alice\u0000@canopyworks.com',
    ]) {
      // Soft, so a failure lists every probe that matched (or threw), not the first.
      expect
        .soft(
          await find(probe).catch((e: unknown) => e),
          `probe ${JSON.stringify(probe)}`,
        )
        .toBeNull();
    }
    // The controls: the exact addresses are found under the same setup.
    expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
    expect(await find('carol@gmail.com')).toEqual({ userId: 'usr_carol' });
  });

  it('a stored lookalike never matches a plain ASCII address', async () => {
    // The other direction. The input is plain ASCII and passes the input
    // check, so only the ASCII-only fold on the stored side keeps these rows
    // from answering for alice and mallory.
    harness = await bootHarness();
    await seed([
      { id: 'usr_lookalike', email: 'al\u0130ce@canopyworks.com', verified: true },
      { id: 'usr_kelvin', email: 'mallory@canopywor\u212As.com', verified: true },
    ]);

    expect(await find('alice@canopyworks.com')).toBeNull();
    expect(await find('mallory@canopyworks.com')).toBeNull();
  });

  it('an address with a character outside printable ASCII is never found, even stored exactly', async () => {
    // Fails closed. An ASCII-only fold can't say which non-ASCII addresses are
    // "the same", so the hook answers none of them, and it answers before any
    // query. A verified account with such an email can't be mapped by this hook.
    harness = await bootHarness();
    await seed([{ id: 'usr_jose', email: 'jos\u00E9@canopyworks.com', verified: true }]);

    expect(await find('jos\u00E9@canopyworks.com')).toBeNull();
  });

  it.each([
    ['no Google provider row', null],
    ['a Google row with no list', { allowedDomains: null, enabled: true }],
    ['a Google row with a blank list', { allowedDomains: '  ', enabled: true }],
  ] as const)(
    'with no approved domains configured (%s), any verified domain is found',
    async (_label, google) => {
      harness = await bootHarness();
      await seed([CAROL], google);

      expect(await find('carol@gmail.com')).toEqual({ userId: 'usr_carol' });
    },
  );

  it('a disabled Google provider still limits the domains', async () => {
    // Turning Google sign-in off must not widen who can be found.
    harness = await bootHarness();
    await seed([ALICE, CAROL], { allowedDomains: 'canopyworks.com', enabled: false });

    expect(await find('carol@gmail.com')).toBeNull();
    expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
  });

  // Since TASK-1116, sign-in checks each provider's own list, so a GitHub list
  // restricts too. Before this, the lookup read Google's list only: with no
  // Google row it found an off-domain GitHub member that sign-in refuses (merge
  // review, 2026-11-13). The blank-Google row pins the fail-closed choice: there
  // carol could sign in through Google, but a blank list adds nothing here.
  it.each([
    ['no Google row', null],
    ['a blank Google list', { allowedDomains: '  ', enabled: true }],
  ] as const)(
    "a GitHub provider's list limits the domains too (%s)",
    async (_label, google) => {
      harness = await bootHarness();
      await seed([ALICE, CAROL], google, { allowedDomains: 'canopyworks.com', enabled: true });

      expect(await find('carol@gmail.com')).toBeNull();
      expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
    },
  );

  it('a disabled GitHub provider still limits the domains', async () => {
    harness = await bootHarness();
    await seed([ALICE, CAROL], null, { allowedDomains: 'canopyworks.com', enabled: false });

    expect(await find('carol@gmail.com')).toBeNull();
    expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
  });

  it("a domain on either provider's list is approved", async () => {
    harness = await bootHarness();
    await seed(
      [ALICE, CAROL, { id: 'usr_pat', email: 'pat@partner.org', verified: true }],
      { allowedDomains: 'canopyworks.com', enabled: true },
      { allowedDomains: 'partner.org', enabled: true },
    );

    expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
    expect(await find('pat@partner.org')).toEqual({ userId: 'usr_pat' });
    expect(await find('carol@gmail.com')).toBeNull();
  });

  it("a disabled provider's list still approves its own domains", async () => {
    // Decided (TASK-1092 shard): the lists are the install's approved domains,
    // and enabling says only which sign-in buttons show. So a disabled list
    // keeps other domains out AND keeps its own approved, even though pat can't
    // sign in through either provider here. To stop mapping a domain, remove it
    // from the list or delete the provider.
    harness = await bootHarness();
    await seed(
      [CAROL, { id: 'usr_pat', email: 'pat@partner.org', verified: true }],
      { allowedDomains: 'canopyworks.com', enabled: true },
      { allowedDomains: 'partner.org', enabled: false },
    );

    expect(await find('pat@partner.org')).toEqual({ userId: 'usr_pat' });
    expect(await find('carol@gmail.com')).toBeNull();
  });

  it('a provider row of any other kind configures nothing', async () => {
    // Only the kinds the sign-in gate enforces count. A leftover `oidc` row
    // (the admin form once offered it) stays in the table until deleted.
    harness = await bootHarness();
    await seed([CAROL], DEFAULT_GOOGLE);
    await insertProviderRow('oidc', 'gmail.com');
    expect(await find('carol@gmail.com')).toBeNull();
  });

  it('a provider row of any other kind restricts nothing either', async () => {
    harness = await bootHarness();
    await seed([CAROL], null);
    await insertProviderRow('oidc', 'canopyworks.com');
    expect(await find('carol@gmail.com')).toEqual({ userId: 'usr_carol' });
  });

  it("a blank GitHub list doesn't open a restricted Google list", async () => {
    // Fails closed: a gmail GitHub member could sign in, but isn't found here.
    harness = await bootHarness();
    await seed([ALICE, CAROL], DEFAULT_GOOGLE, { allowedDomains: null, enabled: true });

    expect(await find('carol@gmail.com')).toBeNull();
    expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
  });

  it('any domain in the comma-separated list is approved', async () => {
    harness = await bootHarness();
    await seed([ALICE, { id: 'usr_pat', email: 'pat@partner.org', verified: true }], {
      allowedDomains: 'canopyworks.com, Partner.ORG',
      enabled: true,
    });

    expect(await find('alice@canopyworks.com')).toEqual({ userId: 'usr_alice' });
    expect(await find('pat@partner.org')).toEqual({ userId: 'usr_pat' });
  });

  it('two verified accounts that differ only in case match nobody, and the warning carries no email', async () => {
    // The UNIQUE on email is case-sensitive and the wizard stores what was
    // typed, so case variants can coexist. Never pick one of them.
    harness = await bootHarness();
    await seed([
      { id: 'usr_erin_upper', email: 'Erin@canopyworks.com', verified: true },
      { id: 'usr_erin_lower', email: 'erin@canopyworks.com', verified: true },
    ]);
    const lines: string[] = [];
    const ctx = harness.ctx({
      logger: createLogger({ reqId: 'find-user-test', writer: (line) => lines.push(line) }),
    });

    expect(await find('erin@canopyworks.com', ctx)).toBeNull();
    expect(await find('ERIN@canopyworks.com', ctx)).toBeNull();

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const ambiguous = entries.filter((e) => e['msg'] === 'auth_find_user_by_email_ambiguous');
    expect(ambiguous).toHaveLength(2);
    for (const e of ambiguous) expect(e['level']).toBe('warn');
    // Code-only: neither half of the address reaches a log line.
    expect(lines.join('\n')).not.toMatch(/\berin\b|canopyworks/i);
  });

  it('a miss on the domain or the verified rule logs a code-only reason, never the address', async () => {
    // So an operator can tell "not verified yet" from "wrong domain" when a
    // Slack user isn't recognized. The caller still only ever sees null.
    harness = await bootHarness();
    await seed([ALICE, CAROL, { id: 'usr_frank', email: 'frank@canopyworks.com', verified: false }]);
    const lines: string[] = [];
    const ctx = harness.ctx({
      logger: createLogger({ reqId: 'find-user-test', writer: (line) => lines.push(line) }),
    });
    /** Look `email` up, check the result, and return [level, msg] of each reason it logged. */
    const reasons = async (email: string, want: FindUserByEmailOutput): Promise<string[][]> => {
      const from = lines.length;
      expect(await find(email, ctx), email).toEqual(want);
      return lines
        .slice(from)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => String(e['msg']).startsWith('auth_find_user_by_email_'))
        .map((e) => [String(e['level']), String(e['msg'])]);
    };

    // A verified account matched, but its domain isn't on the list.
    expect(await reasons('carol@gmail.com', null)).toEqual([
      ['info', 'auth_find_user_by_email_off_domain'],
    ]);
    // Only an unverified account holds the address (in any ASCII case).
    expect(await reasons('FRANK@canopyworks.com', null)).toEqual([
      ['info', 'auth_find_user_by_email_unverified_only'],
    ]);
    // No account at all, and a hit: no reason either way.
    expect(await reasons('zed@canopyworks.com', null)).toEqual([]);
    expect(await reasons('alice@canopyworks.com', { userId: 'usr_alice' })).toEqual([]);

    // Code-only: no field of any line carries any part of an address.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/carol|gmail|frank|\bzed\b|alice|canopyworks/i);
  });

  it('rejects a malformed request without echoing it', async () => {
    harness = await bootHarness();
    const h = harness;
    const call = (input: unknown): Promise<FindUserByEmailOutput> =>
      h.bus.call<unknown, FindUserByEmailOutput>(HOOK, h.ctx(), input);

    const tooLong = 'x'.repeat(305) + '@canopyworks.com';
    expect(tooLong).toHaveLength(321);
    for (const input of [null, {}, { email: 42 }, { email: '' }, { email: tooLong }]) {
      const err = await call(input).then(
        () => undefined,
        (e: unknown) => e,
      );
      const label = JSON.stringify(input).slice(0, 40);
      expect(err, label).toBeInstanceOf(PluginError);
      expect((err as PluginError).code, label).toBe('invalid-payload');
      expect((err as PluginError).message, label).not.toMatch(/canopyworks/i);
    }

    // 320 characters is the longest legal address: a miss, not an error.
    const longest = 'x'.repeat(304) + '@canopyworks.com';
    expect(longest).toHaveLength(320);
    expect(await call({ email: longest })).toBeNull();
  });

  it('registers with a strict returns schema: only { userId } or null', async () => {
    const spy = vi.spyOn(HookBus.prototype, 'registerService');
    try {
      harness = await bootHarness();
      const registration = spy.mock.calls.find(([hookName]) => hookName === HOOK);
      expect(registration).toBeDefined();
      const returns = registration?.[3]?.returns;
      expect(returns).toBeDefined();
      expect(returns!.safeParse({ userId: 'usr_x' }).success).toBe(true);
      expect(returns!.safeParse(null).success).toBe(true);
      // An implementation that returns more than the id fails loudly
      // (invalid-return) instead of having the extra keys quietly stripped.
      expect(returns!.safeParse({ userId: 'usr_x', email: 'a@b.c' }).success).toBe(false);
      expect(returns!.safeParse({ userId: '' }).success).toBe(false);
      expect(returns!.safeParse(undefined).success).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
