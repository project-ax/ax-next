import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import type { AuthBetterDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// TASK-8 regression — the plugin's init() MUST await better-auth's async
// adapter-init before reporting ready.
//
// better-auth resolves its database adapter on a background promise
// (`auth.$context`) that runs a schema-introspection query. Before this fix
// the plugin built the handler and returned from init() WITHOUT awaiting
// that promise, so the query ran in the background, unawaited. When a test
// then tore down the shared pg.Pool / Postgres testcontainer, the in-flight
// query hit a dying connection → `57P01` →
// `BetterAuthError: Failed to initialize database adapter`. The race only
// lost under full-suite concurrency (background init runs slower), which is
// why only push-to-main full runs flaked.
//
// We mock `better-auth` so `$context` is a deferred promise WE control. With
// the fix, the plugin's `init()` (driven through `bootstrap` inside
// `createTestHarness`) MUST NOT resolve until we release `$context`. Without
// the fix it resolves immediately — the assertion below is the bug-catcher.
//
// A real Postgres testcontainer + real @ax/database-postgres back the
// `database:get-instance` hook so the plugin's pre-handler steps
// (runAuthBetterMigration + loadProviders) run against a real DB — only the
// better-auth construction is mocked, keeping the seam under test honest.
// ---------------------------------------------------------------------------

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

// Import the plugin AFTER vi.mock so the handler picks up the mocked
// betterAuth (and thus our controllable $context).
const { createAuthBetterPlugin } = await import('../plugin.js');

let container: StartedPostgreSqlContainer;
let connectionString: string;
let harness: TestHarness | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  // Release any context the test left pending so no promise dangles, then
  // stop the container.
  for (const d of contexts) d.resolve({});
  if (container) await container.stop();
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

afterEach(async () => {
  if (harness !== undefined) {
    await harness.close({ onError: () => {} });
    harness = undefined;
  }
  contexts.length = 0;
});

describe('@ax/auth-better — init() awaits adapter-init (TASK-8)', () => {
  it('does not finish booting until better-auth $context settles', async () => {
    await dropTables();

    let booted = false;
    const bootP = createTestHarness({
      services: {
        'http:register-route': async () => ({ unregister: () => {} }),
        'credentials:envelope-encrypt': async (_ctx, input) => ({
          ciphertext: Buffer.from(
            (input as { plaintext: string }).plaintext,
            'utf8',
          ),
        }),
        'credentials:envelope-decrypt': async (_ctx, input) => ({
          plaintext: Buffer.from(
            (input as { ciphertext: Uint8Array }).ciphertext,
          ).toString('utf8'),
        }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAuthBetterPlugin(),
      ],
    }).then((h) => {
      booted = true;
      harness = h;
      return h;
    });

    // Wait until better-auth has been constructed (the handler build issued
    // its $context). Poll the microtask/macrotask queue a bounded number of
    // times — the migration + loadProviders run against the real DB first,
    // so it isn't instantaneous.
    for (let i = 0; i < 200 && contexts.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(contexts).toHaveLength(1);

    // The adapter-init ($context) is still pending → boot MUST still be
    // pending too. Give the loop a few turns to prove init() is genuinely
    // blocked on ready(), not merely slow.
    await new Promise((r) => setTimeout(r, 50));
    expect(booted).toBe(false);

    // Release the adapter-init → boot completes.
    contexts[0]!.resolve({});
    await bootP;
    expect(booted).toBe(true);
  });
});
