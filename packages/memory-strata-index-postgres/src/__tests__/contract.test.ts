import { beforeAll, afterAll } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { sql } from 'kysely';
import { runIndexContract, type IndexBackendFactory } from '@ax/memory-strata-index-contract';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createMemoryStrataIndexPostgresPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// One container per test file — shared across all contract iterations.
// The factory TRUNCATES the table between runs so each test starts clean.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
// Shared Kysely for DDL ops (truncate between runs). Created once the
// container is up; destroyed in afterAll.
let adminDb: Kysely<unknown>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
  adminDb = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });
}, 120_000);

afterAll(async () => {
  await adminDb?.destroy().catch(() => {});
  await stopPostgresContainer(container);
});

// ---------------------------------------------------------------------------
// Factory: registers database:get-instance on the bus the contract provides,
// then returns the indexer plugin. Teardown truncates the table so the next
// iteration starts from an empty index.
// ---------------------------------------------------------------------------

const factory: IndexBackendFactory = async (bus) => {
  // Register the database:get-instance provider on the contract's bus so the
  // postgres indexer plugin can resolve the shared Kysely instance during init.
  // runIndexContract calls this factory once PER TEST (in beforeEach), so each
  // iteration opens its own pg.Pool here. We capture dbPlugin and shut it down
  // in teardown — without that, every per-test pool stays open until the
  // container stops in afterAll, and the plugin's pool.on('error') listener
  // then LOGS a benign 57P01 ("terminating connection due to administrator
  // command") once per orphaned pool. That's handled noise (the suite stays
  // green), but it's noise; draining the pool gracefully here silences it.
  const dbPlugin = createDatabasePostgresPlugin({ connectionString });
  await dbPlugin.init!({ bus, config: {} });

  // Pre-create the v2 table (TASK-186 — agent-keyed schema, composite PK) on
  // the shared connection so this factory's teardown truncate has a table to
  // target even before the plugin's own migration runs. Must match the
  // plugin's runIndexMigration exactly.
  await sql`
    CREATE TABLE IF NOT EXISTS memory_strata_index_v2_docs (
      agent_key TEXT NOT NULL,
      doc_id    TEXT NOT NULL,
      category  TEXT NOT NULL,
      slug      TEXT NOT NULL,
      summary   TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      body      TEXT NOT NULL,
      headers   TEXT NOT NULL,
      search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(headers, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(body,    '')), 'C')
      ) STORED,
      PRIMARY KEY (agent_key, doc_id)
    )
  `.execute(adminDb);

  const plugin = createMemoryStrataIndexPostgresPlugin();

  return {
    plugin,
    teardown: async () => {
      // Truncate the table rather than drop + recreate — faster between runs.
      await sql`TRUNCATE memory_strata_index_v2_docs`.execute(adminDb);
      // Drain THIS iteration's db-plugin pool gracefully (kysely.destroy()),
      // so it isn't still open when the container stops in afterAll. Without
      // this the plugin's pool.on('error') logs a benign 57P01 per pool at
      // teardown. shutdown() is best-effort/idempotent (guards on its own
      // kysely), so it's safe to await here.
      await dbPlugin.shutdown?.();
    },
  };
};

runIndexContract('@ax/memory-strata-index-postgres', factory);
