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
  ListAdminsInput,
  ListAdminsOutput,
} from '../index.js';

// ---------------------------------------------------------------------------
// auth:list-admins contract (TASK-1170).
//
// @ax/channel-slack asks it who to DM when a team admin asks for their agent's
// own Slack bot. It answers every account that is an admin NOW and whose email
// a provider verified, oldest first (then by id), each as `{ userId, email }`
// and nothing else. An unverified address could be someone else's, and the
// caller writes to whoever owns it, so an admin nobody verified is left out.
// The addresses are personal data, so the hook logs nothing.
//
// We exercise the BUS surface, as find-user-by-email.test.ts does. Rows are
// seeded AFTER boot: the hook reads the table at call time.
// ---------------------------------------------------------------------------

const HOOK = 'auth:list-admins';

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

interface SeedUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  verified: boolean;
  createdAt: Date;
}

/**
 * Insert `users` one statement at a time, in the order given. On a fresh table
 * that is also the order a query with no ORDER BY reads them back in, so the
 * ordering tests insert in the opposite of the order they expect.
 */
async function seed(users: SeedUser[]): Promise<void> {
  await withDb(async (k) => {
    for (const u of users) {
      await k
        .insertInto('auth_better_v1_users')
        .values({
          id: u.id,
          email: u.email,
          email_verified: u.verified,
          name: u.name,
          image: null,
          role: u.role,
          created_at: u.createdAt,
          updated_at: u.createdAt,
        })
        .execute();
    }
  });
}

function list(ctx?: AgentContext): Promise<ListAdminsOutput> {
  if (harness === undefined) throw new Error('boot the harness first');
  return harness.bus.call<ListAdminsInput, ListAdminsOutput>(HOOK, ctx ?? harness.ctx(), {});
}

// Fixed dates, so "oldest first" never rests on how fast the rows were written.
const JAN = new Date('2026-01-05T09:00:00.000Z');
const FEB = new Date('2026-02-05T09:00:00.000Z');
const MAR = new Date('2026-03-05T09:00:00.000Z');

// The oldest admin, with the id that sorts LAST: ordering by id, or by nothing
// (she's inserted last), puts her second.
const ZOE: SeedUser = {
  id: 'usr_zoe',
  email: 'zoe@canopyworks.com',
  name: 'Zoe Admin',
  role: 'admin',
  verified: true,
  createdAt: JAN,
};
// A newer admin, with the id that sorts FIRST.
const AMIR: SeedUser = {
  id: 'usr_amir',
  email: 'amir@canopyworks.com',
  name: 'Amir Admin',
  role: 'admin',
  verified: true,
  createdAt: MAR,
};
// An admin whose email no provider has verified.
const CLEO: SeedUser = {
  id: 'usr_cleo',
  email: 'cleo@canopyworks.com',
  name: 'Cleo Admin',
  role: 'admin',
  verified: false,
  createdAt: FEB,
};
// A verified member who isn't an admin.
const DAN: SeedUser = {
  id: 'usr_dan',
  email: 'dan@canopyworks.com',
  name: 'Dan Member',
  role: 'user',
  verified: true,
  createdAt: FEB,
};

describe('auth:list-admins contract', () => {
  it('lists every admin whose email is verified, oldest first, as { userId, email } and nothing else', async () => {
    harness = await bootHarness();
    // Newest admin first, oldest last: the opposite of the expected order.
    await seed([AMIR, DAN, CLEO, ZOE]);

    // Not Cleo (unverified), not Dan (not an admin), and no name, role or
    // verified flag: toStrictEqual fails on any extra key.
    expect(await list()).toStrictEqual({
      admins: [
        { userId: 'usr_zoe', email: 'zoe@canopyworks.com' },
        { userId: 'usr_amir', email: 'amir@canopyworks.com' },
      ],
    });
  });

  it('breaks a created_at tie by id', async () => {
    harness = await bootHarness();
    // One created_at for all three, inserted highest id first: without the
    // tie-break they come back in insertion order (TASK-1169's lesson).
    const tied = (letter: string): SeedUser => ({
      id: `usr_tie_${letter}`,
      email: `tie.${letter}@canopyworks.com`,
      name: `Tie ${letter.toUpperCase()}`,
      role: 'admin',
      verified: true,
      createdAt: FEB,
    });
    await seed([tied('c'), tied('b'), tied('a')]);

    expect(await list()).toStrictEqual({
      admins: [
        { userId: 'usr_tie_a', email: 'tie.a@canopyworks.com' },
        { userId: 'usr_tie_b', email: 'tie.b@canopyworks.com' },
        { userId: 'usr_tie_c', email: 'tie.c@canopyworks.com' },
      ],
    });
  });

  it('with no admins, or none verified, answers { admins: [] }', async () => {
    harness = await bootHarness();
    expect(await list()).toStrictEqual({ admins: [] });

    // A verified member, and the wizard's admin before any provider verified
    // her email (auth:create-bootstrap-user stores it unverified).
    await seed([DAN]);
    const wizard = await harness.bus.call<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
      'auth:create-bootstrap-user',
      harness.ctx(),
      { displayName: 'Admin', email: 'admin@canopyworks.com' },
    );
    expect(wizard.user.isAdmin).toBe(true);

    expect(await list()).toStrictEqual({ admins: [] });
  });

  it('reads the table at call time', async () => {
    harness = await bootHarness();
    await seed([ZOE, CLEO]);
    expect(await list()).toStrictEqual({
      admins: [{ userId: 'usr_zoe', email: 'zoe@canopyworks.com' }],
    });

    // Demoted: gone at the next call.
    await withDb((k) =>
      k.updateTable('auth_better_v1_users').set({ role: 'user' }).where('id', '=', 'usr_zoe').execute(),
    );
    expect(await list()).toStrictEqual({ admins: [] });

    // A provider verified Cleo's email: listed at the next call.
    await withDb((k) =>
      k
        .updateTable('auth_better_v1_users')
        .set({ email_verified: true })
        .where('id', '=', 'usr_cleo')
        .execute(),
    );
    expect(await list()).toStrictEqual({
      admins: [{ userId: 'usr_cleo', email: 'cleo@canopyworks.com' }],
    });
  });

  it('is registered with a strict returns schema', async () => {
    const spy = vi.spyOn(HookBus.prototype, 'registerService');
    try {
      harness = await bootHarness();
      const registration = spy.mock.calls.find(([hookName]) => hookName === HOOK);
      expect(registration).toBeDefined();
      const returns = registration?.[3]?.returns;
      expect(returns).toBeDefined();
      expect(returns!.safeParse({ admins: [] }).success).toBe(true);
      expect(
        returns!.safeParse({ admins: [{ userId: 'usr_x', email: 'x@canopyworks.com' }] }).success,
      ).toBe(true);
      // An implementation that says more (a name, a role, a count) fails
      // loudly as invalid-return instead of having the extra keys quietly
      // stripped.
      expect(returns!.safeParse({ admins: [{ userId: 'u', email: 'e', name: 'n' }] }).success).toBe(false);
      expect(returns!.safeParse({ admins: [], more: 1 }).success).toBe(false);
      // And one that says less, or nothing, fails the same way.
      expect(returns!.safeParse({ admins: [{ userId: '', email: 'e' }] }).success).toBe(false);
      expect(returns!.safeParse({ admins: [{ userId: 'u', email: '' }] }).success).toBe(false);
      expect(returns!.safeParse({ admins: [{ userId: 'u' }] }).success).toBe(false);
      expect(returns!.safeParse({}).success).toBe(false);
      expect(returns!.safeParse(null).success).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs no address', async () => {
    harness = await bootHarness();
    await seed([ZOE, AMIR, CLEO]);
    const lines: string[] = [];
    const ctx = harness.ctx({
      logger: createLogger({ reqId: 'list-admins-test', writer: (line) => lines.push(line) }),
    });
    // The plugin's other log channel: its own lines go straight to stderr.
    const stderr = vi.spyOn(process.stderr, 'write');
    let written: string[];
    try {
      expect(await list(ctx)).toStrictEqual({
        admins: [
          { userId: 'usr_zoe', email: 'zoe@canopyworks.com' },
          { userId: 'usr_amir', email: 'amir@canopyworks.com' },
        ],
      });
    } finally {
      written = stderr.mock.calls.map(([chunk]) =>
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      stderr.mockRestore();
    }

    // No line or field carries any part of an address, listed or not.
    expect([...lines, ...written].join('\n')).not.toMatch(/zoe|amir|cleo|canopyworks/i);
    // The contract: no log line at all.
    expect(lines).toEqual([]);
  });

  it('a database fault throws: it never answers an empty list in its place', async () => {
    // An empty list would read as "no admins to tell" and hide the outage.
    harness = await bootHarness();
    await seed([ZOE]);
    // The control: the hook is there and answers, so the rejection below is
    // the fault's, not a missing hook's.
    expect(await list()).toStrictEqual({
      admins: [{ userId: 'usr_zoe', email: 'zoe@canopyworks.com' }],
    });
    await withDb((k) => k.schema.dropTable('auth_better_v1_users').cascade().execute());

    await expect(list()).rejects.toBeInstanceOf(PluginError);
  });

  it('the manifest registers it', () => {
    expect(createAuthBetterPlugin().manifest.registers).toContain(HOOK);
  });
});
