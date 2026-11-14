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
import type { IsApprovedEmailInput, IsApprovedEmailOutput } from '../index.js';

// ---------------------------------------------------------------------------
// auth:is-approved-email contract (TASK-1094).
//
// @ax/channel-slack asks it about a Slack member it can't map to an AX
// account: is the email Slack verified for them on one of the install's
// approved domains? A yes lets that member talk to a channel's agent as an
// outsider. So the answer comes from the sign-in providers' domain lists alone
// (the rule auth:find-user-by-email applies, from the same helper), it never
// depends on accounts or says anything about them, and anything that isn't a
// plain, well-formed ASCII address is refused.
//
// We exercise the BUS surface, as find-user-by-email.test.ts does. Provider
// rows are seeded AFTER boot: the hook reads them at call time, and init's
// loadProviders then never tries to decrypt the dummy secrets.
// ---------------------------------------------------------------------------

const HOOK = 'auth:is-approved-email';

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

async function bootHarness(): Promise<TestHarness> {
  await withDb(async (k) => {
    for (const table of [
      'auth_providers',
      'auth_better_v1_verifications',
      'auth_better_v1_accounts',
      'auth_better_v1_sessions',
      'auth_better_v1_users',
    ]) {
      await k.schema.dropTable(table).ifExists().execute();
    }
  });
  // Same mocks as find-user-by-email.test.ts: no http-server, and pass-through
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

interface SeedProvider {
  allowedDomains: string | null;
  enabled: boolean;
}

/** Provider rows by kind. `oidc` is a kind the sign-in gate doesn't wire. */
type Providers = { google?: SeedProvider; github?: SeedProvider; oidc?: SeedProvider };

const CANOPY: SeedProvider = { allowedDomains: 'canopyworks.com', enabled: true };

/** Insert one provider row per kind given. The secrets are dummies nothing decrypts. */
async function seedProviders(providers: Providers): Promise<void> {
  await withDb(async (k) => {
    const now = new Date();
    for (const [kind, row] of Object.entries(providers)) {
      if (row === undefined) continue;
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

async function seedUsers(users: Array<{ id: string; email: string; verified: boolean }>): Promise<void> {
  await withDb(async (k) => {
    const now = new Date();
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
  });
}

function ask(email: string, ctx?: AgentContext): Promise<IsApprovedEmailOutput> {
  if (harness === undefined) throw new Error('boot the harness first');
  return harness.bus.call<IsApprovedEmailInput, IsApprovedEmailOutput>(
    HOOK,
    ctx ?? harness.ctx(),
    { email },
  );
}

// Characters past plain ASCII, built from code points so this file holds none.
// U+0130 (dotted capital I): a locale-aware lower() folds it to 'i'.
const DOTTED_CAPITAL_I = String.fromCharCode(0x0130);
// U+212A (Kelvin sign): JS toLowerCase() folds it to 'k'.
const KELVIN_SIGN = String.fromCharCode(0x212a);
const FULLWIDTH_SMALL_A = String.fromCharCode(0xff41);
const TAB = String.fromCharCode(0x09);
const NUL = String.fromCharCode(0x00);

const WITH_A_LIST: [string, Providers] = ['with a domain list', { google: CANOPY }];
const WITH_NO_LIST: [string, Providers] = ['with no domain list', {}];

describe('auth:is-approved-email contract', () => {
  const NO_APPROVED_DOMAINS: Array<[string, Providers]> = [
    ['no provider rows', {}],
    ['a Google row with no list', { google: { allowedDomains: null, enabled: true } }],
    ['a Google list of only commas and spaces', { google: { allowedDomains: ' , ,', enabled: true } }],
    [
      'blank Google and GitHub lists',
      {
        google: { allowedDomains: '  ', enabled: true },
        github: { allowedDomains: null, enabled: false },
      },
    ],
  ];

  it.each(NO_APPROVED_DOMAINS)(
    'with no approved domain configured (%s), any well-formed ASCII address is approved',
    async (_label, providers) => {
      harness = await bootHarness();
      await seedProviders(providers);

      expect(await ask('carol@gmail.com')).toEqual({ approved: true });
      expect(await ask('pat@partner.org')).toEqual({ approved: true });
    },
  );

  it("Google's list limits the domains", async () => {
    harness = await bootHarness();
    await seedProviders({ google: CANOPY });

    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });
  });

  it("GitHub's list limits the domains, with no Google row", async () => {
    harness = await bootHarness();
    await seedProviders({ github: CANOPY });

    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });
  });

  it("a domain on either provider's list is approved", async () => {
    harness = await bootHarness();
    await seedProviders({
      google: CANOPY,
      github: { allowedDomains: 'partner.org', enabled: true },
    });

    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    expect(await ask('pat@partner.org')).toEqual({ approved: true });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });
  });

  it("a blank list adds nothing: GitHub enabled with no list doesn't open Google's", async () => {
    harness = await bootHarness();
    await seedProviders({
      google: CANOPY,
      github: { allowedDomains: '  ', enabled: true },
    });

    expect(await ask('x@gmail.com')).toEqual({ approved: false });
    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
  });

  // Decided in TASK-1092 (its decisions shard, last row): the lists are the
  // install's company domains, and `enabled` only says which sign-in buttons
  // show. A disabled provider's list counts both ways.
  it("a disabled provider's list still keeps other domains out", async () => {
    harness = await bootHarness();
    await seedProviders({ google: { allowedDomains: 'canopyworks.com', enabled: false } });

    expect(await ask('carol@gmail.com')).toEqual({ approved: false });
    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
  });

  it("a disabled provider's list still approves its own domains", async () => {
    harness = await bootHarness();
    await seedProviders({
      google: CANOPY,
      github: { allowedDomains: 'partner.org', enabled: false },
    });

    expect(await ask('pat@partner.org')).toEqual({ approved: true });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });
  });

  it('a provider row of any other kind neither approves nor restricts', async () => {
    // Only the kinds the sign-in gate enforces count. A leftover `oidc` row
    // (the admin form once offered it) stays until someone deletes it.
    harness = await bootHarness();
    await seedProviders({ google: CANOPY, oidc: { allowedDomains: 'gmail.com', enabled: true } });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });

    await withDb((k) => k.deleteFrom('auth_providers').execute());
    await seedProviders({ oidc: CANOPY });
    expect(await ask('carol@gmail.com')).toEqual({ approved: true });
  });

  it('compares domains ignoring the case of ASCII letters, in the address and in the list', async () => {
    harness = await bootHarness();
    await seedProviders({
      google: CANOPY,
      github: { allowedDomains: 'Partner.ORG', enabled: true },
    });

    expect(await ask('A@CanopyWorks.COM')).toEqual({ approved: true });
    expect(await ask('pat@partner.org')).toEqual({ approved: true });
  });

  it('approves an exact domain only: a subdomain or a near miss is another domain', async () => {
    harness = await bootHarness();
    await seedProviders({ google: CANOPY });

    for (const probe of [
      'a@eng.canopyworks.com',
      'a@canopyworks.co',
      'a@canopyworks.com.evil.org',
      'a@evilcanopyworks.com',
      'a@canopyworks.com.',
    ]) {
      // Soft, so a failure lists every probe that was approved, not the first.
      expect.soft(await ask(probe), probe).toEqual({ approved: false });
    }
    expect(await ask('a@canopyworks.com')).toEqual({ approved: true });
  });

  it.each([WITH_A_LIST, WITH_NO_LIST])(
    'an address with any character outside printable ASCII is never approved (%s)',
    async (_label, providers) => {
      harness = await bootHarness();
      await seedProviders(providers);

      for (const probe of [
        `al${DOTTED_CAPITAL_I}ce@canopyworks.com`,
        // toLowerCase() turns this domain into canopyworks.com.
        `alice@canopywor${KELVIN_SIGN}s.com`,
        `${FULLWIDTH_SMALL_A}lice@canopyworks.com`,
        ' alice@canopyworks.com',
        'alice@canopyworks.com ',
        `alice${TAB}@canopyworks.com`,
        `alice${NUL}@canopyworks.com`,
      ]) {
        expect.soft(await ask(probe), JSON.stringify(probe)).toEqual({ approved: false });
      }
      // The control: the plain ASCII address is approved under the same setup.
      expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    },
  );

  it.each([WITH_A_LIST, WITH_NO_LIST])(
    'an address without exactly one @ between a local part and a domain is never approved (%s)',
    async (_label, providers) => {
      harness = await bootHarness();
      await seedProviders(providers);

      for (const probe of [
        'alice',
        'alice@',
        '@canopyworks.com',
        '@',
        // The part after the LAST @ is on the list, so a domain check alone passes it.
        'alice@bob@canopyworks.com',
      ]) {
        expect.soft(await ask(probe), probe).toEqual({ approved: false });
      }
      expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    },
  );

  it('rejects a malformed request with one fixed message that never echoes it', async () => {
    harness = await bootHarness();
    await seedProviders({ google: CANOPY });
    const h = harness;
    const call = (input: unknown): Promise<IsApprovedEmailOutput> =>
      h.bus.call<unknown, IsApprovedEmailOutput>(HOOK, h.ctx(), input);

    const tooLong = 'x'.repeat(305) + '@canopyworks.com';
    expect(tooLong).toHaveLength(321);
    const messages = new Set<string>();
    for (const input of [
      null,
      {},
      { email: 42 },
      // Would read as the address if anything stringified it.
      { email: ['alice@canopyworks.com'] },
      { email: '' },
      { email: tooLong },
    ]) {
      const label = JSON.stringify(input).slice(0, 40);
      const err = await call(input).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, label).toBeInstanceOf(PluginError);
      expect((err as PluginError).code, label).toBe('invalid-payload');
      messages.add((err as PluginError).message);
    }
    // One fixed sentence for every bad request, so it can't carry any of them.
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toMatch(/canopyworks|xxx|42/i);

    // 320 characters is the longest legal address: an answer, not an error.
    const longest = 'x'.repeat(304) + '@canopyworks.com';
    expect(longest).toHaveLength(320);
    expect(await call({ email: longest })).toEqual({ approved: true });
  });

  it('registers with a strict returns schema: { approved: boolean } and nothing else', async () => {
    const spy = vi.spyOn(HookBus.prototype, 'registerService');
    try {
      harness = await bootHarness();
      const registration = spy.mock.calls.find(([hookName]) => hookName === HOOK);
      expect(registration).toBeDefined();
      const returns = registration?.[3]?.returns;
      expect(returns).toBeDefined();
      expect(returns!.safeParse({ approved: true }).success).toBe(true);
      expect(returns!.safeParse({ approved: false }).success).toBe(true);
      // An implementation that says more (a user id, the matched domain) fails
      // loudly as invalid-return instead of having the extra keys quietly stripped.
      expect(returns!.safeParse({ approved: true, userId: 'usr_x' }).success).toBe(false);
      expect(returns!.safeParse({ approved: false, domain: 'gmail.com' }).success).toBe(false);
      expect(returns!.safeParse({ approved: 'true' }).success).toBe(false);
      expect(returns!.safeParse({}).success).toBe(false);
      expect(returns!.safeParse(null).success).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('an account changes nothing: the answer comes from the domain lists alone', async () => {
    harness = await bootHarness();
    await seedProviders({ google: CANOPY });

    // An empty users table: an address on the list needs no account.
    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });

    // A verified account doesn't approve an address off the list, and having
    // one (verified or not) or none never changes an answer on the list.
    await seedUsers([
      { id: 'usr_alice', email: 'alice@canopyworks.com', verified: true },
      { id: 'usr_carol', email: 'carol@gmail.com', verified: true },
      { id: 'usr_frank', email: 'frank@canopyworks.com', verified: false },
    ]);
    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });
    expect(await ask('frank@canopyworks.com')).toEqual({ approved: true });
    expect(await ask('zed@canopyworks.com')).toEqual({ approved: true });
  });

  it('reads no user row: it still answers with the users table gone', async () => {
    // Whatever it answers, it can't have learned anything about an account, so
    // it can never become an account-existence oracle.
    harness = await bootHarness();
    await seedProviders({ google: CANOPY });
    await withDb((k) => k.schema.dropTable('auth_better_v1_users').cascade().execute());

    expect(await ask('alice@canopyworks.com')).toEqual({ approved: true });
    expect(await ask('carol@gmail.com')).toEqual({ approved: false });
  });

  it('writes no log line, whatever it answers', async () => {
    harness = await bootHarness();
    await seedProviders({ google: CANOPY });
    const lines: string[] = [];
    const ctx = harness.ctx({
      logger: createLogger({ reqId: 'is-approved-email-test', writer: (line) => lines.push(line) }),
    });

    expect(await ask('alice@canopyworks.com', ctx)).toEqual({ approved: true });
    expect(await ask('carol@gmail.com', ctx)).toEqual({ approved: false });
    expect(await ask('@canopyworks.com', ctx)).toEqual({ approved: false });
    expect(await ask(`alice@canopywor${KELVIN_SIGN}s.com`, ctx)).toEqual({ approved: false });
    await expect(ask('', ctx)).rejects.toBeInstanceOf(PluginError);

    expect(lines).toEqual([]);
  });
});
