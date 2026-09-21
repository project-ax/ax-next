import { beforeAll, afterAll } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runFactsContract, type FactsBackendFactory } from '@ax/memory-facts-contract';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createMemoryFactsPostgresPlugin } from '../plugin.js';
import { runFactsMigration } from '../schema.js';

// ---------------------------------------------------------------------------
// One container per test file — shared across every contract iteration.
//
// `adminDb` is a SEPARATE Kysely that outlives the per-test pools below. It
// exists because the per-test pool is deliberately destroyed mid-test by some
// cases, and something still has to be able to reset the table for the NEXT
// test.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
let adminDb: Kysely<unknown>;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
  adminDb = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  // Create the table once, up front, so the per-test TRUNCATE below always has
  // a target — including on the very first iteration, before any plugin has
  // run its own (identical, idempotent) migration.
  await runFactsMigration(adminDb);
}, 120_000);

afterAll(async () => {
  await adminDb?.destroy().catch(() => {});
  await stopPostgresContainer(container);
});

// ---------------------------------------------------------------------------
// Factory: registers database:get-instance on the bus the contract provides,
// then returns the facts plugin.
//
// `runFactsContract` calls this ONCE PER TEST (in beforeEach), and each
// iteration gets its OWN `@ax/database-postgres` instance. That is not just
// pool hygiene, it is what makes the §4.4 `store-unavailable` cases
// expressible at all: the contract tears the store down MID-TEST and then
// demands every hook reject rather than answer. The facts plugin has no
// `shutdown()` of its own — it borrows the shared Kysely and must never
// destroy a pool it does not own — so the only thing that can pull the store
// out from under it is the db plugin whose pool it borrowed. Sharing one pool
// across all cases (which the strata-postgres contract does) would make those
// cases untestable, and a second test file's pool would go down with it.
//
// Once destroyed, the captured Kysely rejects every query from its own
// RuntimeDriver with a plain `Error('driver has already been destroyed')` —
// NOT a PluginError, which matters because `inStore` passes PluginErrors
// through untouched. `postgres-edges.test.ts` pins both halves of that.
// ---------------------------------------------------------------------------

const factory: FactsBackendFactory = async (bus) => {
  // Reset at SETUP, never at teardown: several cases consume the teardown
  // themselves (they tear the store down mid-test and disarm the shared
  // afterEach), so a teardown-time reset would simply not happen for them and
  // would leak their rows into the next test.
  await sql`TRUNCATE memory_facts_v1`.execute(adminDb);

  const dbPlugin = createDatabasePostgresPlugin({ connectionString });
  await dbPlugin.init!({ bus, config: {} });

  const plugin = createMemoryFactsPostgresPlugin();

  // Idempotent: `createDatabasePostgresPlugin`'s own shutdown() guards on its
  // kysely handle, and this flag stops a second call from even reaching it.
  // The contract calls teardown once per test via afterEach, and the
  // store-unavailable cases call it themselves first — belt and braces, since
  // "not every backend promises that is safe" is exactly what the contract's
  // comment says.
  let tornDown = false;

  return {
    plugin,
    teardown: async () => {
      if (tornDown) return;
      tornDown = true;
      await dbPlugin.shutdown?.();
    },
  };
};

runFactsContract('@ax/memory-facts-postgres', factory);
