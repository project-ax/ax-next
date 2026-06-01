import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runHostGrantsMigration, type HostGrantsDatabase } from '../migrations.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<HostGrantsDatabase>[] = [];

function makeKysely(): Kysely<HostGrantsDatabase> {
  const k = new Kysely<HostGrantsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('host_grants_v1_grants').ifExists().execute();
    } catch {
      /* drained */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('host_grants_v1_grants migration', () => {
  it('creates the table with the compound PK (owner_user_id, agent_id, host)', async () => {
    const db = makeKysely();
    await runHostGrantsMigration(db);

    await db
      .insertInto('host_grants_v1_grants')
      .values([
        { owner_user_id: 'u1', agent_id: 'a1', host: 'a.example.com' },
        { owner_user_id: 'u1', agent_id: 'a1', host: 'b.example.com' },
        { owner_user_id: 'u1', agent_id: 'a2', host: 'a.example.com' }, // distinct agent → allowed
      ])
      .execute();

    const rows = await db
      .selectFrom('host_grants_v1_grants')
      .selectAll()
      .where('owner_user_id', '=', 'u1')
      .where('agent_id', '=', 'a1')
      .orderBy('host')
      .execute();
    expect(rows.map((r) => r.host)).toEqual(['a.example.com', 'b.example.com']);

    // Duplicate compound key rejected.
    await expect(
      db
        .insertInto('host_grants_v1_grants')
        .values({ owner_user_id: 'u1', agent_id: 'a1', host: 'a.example.com' })
        .execute(),
    ).rejects.toThrow();
  });

  it('is idempotent (running twice does not throw)', async () => {
    const db = makeKysely();
    await runHostGrantsMigration(db);
    await expect(runHostGrantsMigration(db)).resolves.toBeUndefined();
  });
});
