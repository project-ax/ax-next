import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { runConnectorsMigration, type ConnectorDatabase } from '../migrations.js';
import { createConnectorsPlugin } from '../plugin.js';
import type { ListInput, ListOutput } from '../types.js';

// SIGNINS-9 (slice 7) — every connector is shared, so the `visibility` column
// and its partial index are dropped. A database created with the OLD schema,
// holding private rows, keeps every row (live, now visible to everyone).

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

async function sql(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end().catch(() => {});
  }
}

const caps = JSON.stringify({ allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } });

const hasColumn = async () =>
  (await sql(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'connectors_v1_connectors' AND column_name = 'visibility'`,
  )).length === 1;
const hasIndex = async () =>
  (await sql(`SELECT 1 FROM pg_indexes WHERE indexname = 'connectors_v1_connectors_shared'`)).length === 1;

describe('migration drops the retired visibility column (SIGNINS-9)', () => {
  it('an OLD-schema database keeps its rows live, loses the column and index, and is idempotent', async () => {
    // The pre-slice-7 table + index, verbatim in substance.
    await sql(`
      CREATE TABLE connectors_v1_connectors (
        owner_user_id TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        usage_note    TEXT NOT NULL DEFAULT '',
        key_mode      TEXT NOT NULL CHECK (key_mode IN ('personal', 'workspace')),
        visibility    TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
        capabilities  JSONB NOT NULL,
        deleted_at    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner_user_id, connector_id)
      )`);
    await sql(`
      CREATE INDEX connectors_v1_connectors_shared
        ON connectors_v1_connectors (connector_id)
        WHERE deleted_at IS NULL AND visibility = 'shared'`);
    await sql(
      `INSERT INTO connectors_v1_connectors (owner_user_id, connector_id, name, key_mode, visibility, capabilities)
       VALUES ('ownerA', 'secretish', 'Was private', 'personal', 'private', $1::jsonb),
              ('ownerA', 'teamtool', 'Was shared', 'personal', 'shared', $1::jsonb)`,
      [caps],
    );
    expect(await hasColumn()).toBe(true);
    expect(await hasIndex()).toBe(true);

    const db = new Kysely<ConnectorDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
    });
    try {
      await runConnectorsMigration(db);
      await runConnectorsMigration(db); // idempotent
    } finally {
      await db.destroy();
    }

    expect(await hasColumn()).toBe(false);
    expect(await hasIndex()).toBe(false);
    expect(
      await sql('SELECT owner_user_id, connector_id, deleted_at FROM connectors_v1_connectors ORDER BY connector_id'),
    ).toEqual([
      { owner_user_id: 'ownerA', connector_id: 'secretish', deleted_at: null },
      { owner_user_id: 'ownerA', connector_id: 'teamtool', deleted_at: null },
    ]);

    // Boot the plugin (its init runs the migration a third time): another
    // user's list includes the formerly-private row.
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString }), createConnectorsPlugin()],
    });
    try {
      const listed = await h.bus.call<ListInput, ListOutput>('connectors:list', h.ctx({ userId: 'userB' }), {
        userId: 'userB',
      });
      expect(listed.connectors.map((c) => [c.id, c.canEdit]).sort()).toEqual([
        ['secretish', false],
        ['teamtool', false],
      ]);
    } finally {
      await h.close({ onError: () => {} });
    }
    expect(await hasColumn()).toBe(false);
  });

  it('a fresh database never has the column', async () => {
    await sql('DROP TABLE IF EXISTS connectors_v1_connectors');
    const db = new Kysely<ConnectorDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
    });
    try {
      await runConnectorsMigration(db);
    } finally {
      await db.destroy();
    }
    expect(await hasColumn()).toBe(false);
    expect(await hasIndex()).toBe(false);
  });
});
