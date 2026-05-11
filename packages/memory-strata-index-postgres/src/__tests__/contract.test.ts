import { beforeAll, afterAll } from 'vitest';
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
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Factory: registers database:get-instance on the bus the contract provides,
// then returns the indexer plugin. Teardown truncates the table so the next
// iteration starts from an empty index.
// ---------------------------------------------------------------------------

const factory: IndexBackendFactory = async (bus) => {
  // Register the database:get-instance provider on the contract's bus so the
  // postgres indexer plugin can resolve the shared Kysely instance during init.
  const dbPlugin = createDatabasePostgresPlugin({ connectionString });
  await dbPlugin.init!({ bus, config: {} });

  // Run the indexer's migration on the shared connection so the table exists
  // for this factory's teardown truncate.
  await sql`
    CREATE TABLE IF NOT EXISTS memory_strata_index_v1_docs (
      doc_id    TEXT PRIMARY KEY,
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
      ) STORED
    )
  `.execute(adminDb);

  const plugin = createMemoryStrataIndexPostgresPlugin();

  return {
    plugin,
    teardown: async () => {
      // Truncate the table rather than drop + recreate — faster between runs.
      await sql`TRUNCATE memory_strata_index_v1_docs`.execute(adminDb);
    },
  };
};

runIndexContract('@ax/memory-strata-index-postgres', factory);
