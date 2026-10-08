import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Logger } from '@ax/core';
import { createTestHarness, stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { Kysely, PostgresDialect, type KyselyPlugin } from 'kysely';
import pg from 'pg';
import { runConnectorsMigration, type ConnectorDatabase } from '../migrations.js';
import { ALL_SHARED_STEP, makeAllConnectorsShared } from '../all-shared-step.js';
import { createConnectorsPlugin } from '../plugin.js';

// SIGNINS-9 (slice 7) — every connector is shared. A one-time boot step flips
// every live private row to shared and, where one id has more than one live
// row, keeps exactly one of them (soft-deleting the rest).

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const opened: Kysely<ConnectorDatabase>[] = [];
function makeKysely(plugins: KyselyPlugin[] = []): Kysely<ConnectorDatabase> {
  const k = new Kysely<ConnectorDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
    plugins,
  });
  opened.push(k);
  return k;
}

async function sql(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end().catch(() => {});
  }
}

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.destroy();
  await sql('DROP TABLE IF EXISTS connectors_v1_connectors');
  await sql('DROP TABLE IF EXISTS connectors_v1_authored');
  await sql('DROP TABLE IF EXISTS connectors_v1_boot_steps');
});

const caps = JSON.stringify({ allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } });

/** Insert a row as the pre-slice-7 code could have left it. */
async function insertRow(
  owner: string,
  id: string,
  visibility: 'private' | 'shared',
  opts: { createdAt?: string; deleted?: boolean } = {},
): Promise<void> {
  await sql(
    `INSERT INTO connectors_v1_connectors
       (owner_user_id, connector_id, name, key_mode, visibility, capabilities, created_at, deleted_at)
     VALUES ($1, $2, $2, 'personal', $3, $4::jsonb, $5::timestamptz, $6::timestamptz)`,
    [owner, id, visibility, caps, opts.createdAt ?? '2026-01-01T00:00:00Z', opts.deleted ? '2026-02-01T00:00:00Z' : null],
  );
}

/** [owner, id, visibility, live?] for every row, ordered. */
async function rows(): Promise<Array<[unknown, unknown, unknown, boolean]>> {
  const out = await sql(
    'SELECT owner_user_id, connector_id, visibility, deleted_at FROM connectors_v1_connectors ORDER BY connector_id, owner_user_id',
  );
  return out.map((r) => [r['owner_user_id'], r['connector_id'], r['visibility'], r['deleted_at'] === null]);
}

const markers = async () => (await sql('SELECT name FROM connectors_v1_boot_steps')).map((r) => r['name']);

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function recordingLogger(calls: LogCall[]): Logger {
  const at = (level: LogCall['level']) => (msg: string, bindings?: Record<string, unknown>) => {
    calls.push({ level, msg, bindings });
  };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

async function setup(plugins: KyselyPlugin[] = []): Promise<Kysely<ConnectorDatabase>> {
  const db = makeKysely(plugins);
  await runConnectorsMigration(db);
  return db;
}

/** A Kysely plugin that rejects the `n`th UPDATE statement (1-based). */
function failNthUpdate(n: number): KyselyPlugin {
  let seen = 0;
  return {
    transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode') {
        seen += 1;
        if (seen === n) throw new Error('injected update failure for connector secret-id');
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  };
}

describe('makeAllConnectorsShared (boot step)', () => {
  it('flips every live private row to shared and marks itself done', async () => {
    const db = await setup();
    await insertRow('A', 'alpha', 'private');
    await insertRow('B', 'beta', 'private');

    const result = await makeAllConnectorsShared(db, recordingLogger([]));

    expect(result).toEqual({ ran: true, flipped: 2, deduped: 0 });
    expect(await rows()).toEqual([
      ['A', 'alpha', 'shared', true],
      ['B', 'beta', 'shared', true],
    ]);
    expect(await markers()).toEqual([ALL_SHARED_STEP]);
    expect(ALL_SHARED_STEP).toBe('all-connectors-shared');
  });

  it('keeps the shared row when one shared and one private row share an id', async () => {
    const db = await setup();
    // B's private row is older, but the one shared row always wins.
    await insertRow('A', 'x', 'shared', { createdAt: '2026-03-01T00:00:00Z' });
    await insertRow('B', 'x', 'private', { createdAt: '2026-01-01T00:00:00Z' });

    const result = await makeAllConnectorsShared(db, recordingLogger([]));

    expect(result).toEqual({ ran: true, flipped: 0, deduped: 1 });
    expect(await rows()).toEqual([
      ['A', 'x', 'shared', true],
      ['B', 'x', 'private', false],
    ]);
  });

  it('keeps the earliest row when two private rows share an id', async () => {
    const db = await setup();
    await insertRow('A', 'y', 'private', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'y', 'private', { createdAt: '2026-02-01T00:00:00Z' });

    const result = await makeAllConnectorsShared(db, recordingLogger([]));

    expect(result).toEqual({ ran: true, flipped: 1, deduped: 1 });
    expect(await rows()).toEqual([
      ['A', 'y', 'shared', true],
      ['B', 'y', 'private', false],
    ]);
  });

  it('keeps the earliest row (tie broken by owner) when two shared rows share an id', async () => {
    const db = await setup();
    await insertRow('B', 'z', 'shared', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('A', 'z', 'shared', { createdAt: '2026-02-01T00:00:00Z' });
    // Same created_at: the owner id breaks the tie.
    await insertRow('D', 'w', 'shared', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('C', 'w', 'shared', { createdAt: '2026-01-01T00:00:00Z' });

    const result = await makeAllConnectorsShared(db, recordingLogger([]));

    expect(result).toEqual({ ran: true, flipped: 0, deduped: 2 });
    expect(await rows()).toEqual([
      ['C', 'w', 'shared', true],
      ['D', 'w', 'shared', false],
      ['A', 'z', 'shared', false],
      ['B', 'z', 'shared', true],
    ]);
  });

  it('does nothing on a second run', async () => {
    const db = await setup();
    await insertRow('A', 'alpha', 'private');
    expect(await makeAllConnectorsShared(db, recordingLogger([]))).toEqual({ ran: true, flipped: 1, deduped: 0 });

    // A private row written after the step (e.g. by a rolled-back image) is
    // left alone: the step is one-time.
    await insertRow('B', 'beta', 'private');
    const before = await rows();
    const result = await makeAllConnectorsShared(db, recordingLogger([]));

    expect(result).toEqual({ ran: false, flipped: 0, deduped: 0 });
    expect(await rows()).toEqual(before);
  });

  it('ignores soft-deleted rows', async () => {
    const db = await setup();
    await insertRow('A', 'gone', 'private', { deleted: true });
    await insertRow('A', 'x', 'shared');
    await insertRow('B', 'x', 'private', { deleted: true });

    const result = await makeAllConnectorsShared(db, recordingLogger([]));

    expect(result).toEqual({ ran: true, flipped: 0, deduped: 0 });
    expect(await rows()).toEqual([
      ['A', 'gone', 'private', false],
      ['A', 'x', 'shared', true],
      ['B', 'x', 'private', false],
    ]);
    // The tombstone's deleted_at is untouched.
    const [tomb] = await sql(
      "SELECT deleted_at FROM connectors_v1_connectors WHERE owner_user_id = 'B' AND connector_id = 'x'",
    );
    expect((tomb!['deleted_at'] as Date).toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('logs counts only, once, and only when something changed', async () => {
    const db = await setup();
    await insertRow('owner-a', 'secret-id', 'private');
    await insertRow('owner-b', 'secret-id', 'private', { createdAt: '2026-05-01T00:00:00Z' });
    const calls: LogCall[] = [];

    await makeAllConnectorsShared(db, recordingLogger(calls));

    const done = calls.filter((c) => c.msg === 'connectors_all_shared');
    expect(done).toHaveLength(1);
    expect(done[0]!.level).toBe('info');
    expect(Object.keys(done[0]!.bindings ?? {}).sort()).toEqual(['deduped', 'flipped']);
    expect(done[0]!.bindings).toEqual({ flipped: 1, deduped: 1 });
    // Nothing logged anywhere carries an id or an owner.
    const text = JSON.stringify(calls);
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('owner-a');
    expect(text).not.toContain('owner-b');

    // A pass that changes nothing logs no `connectors_all_shared` line.
    await sql('DELETE FROM connectors_v1_boot_steps');
    const quiet: LogCall[] = [];
    expect(await makeAllConnectorsShared(db, recordingLogger(quiet))).toEqual({ ran: true, flipped: 0, deduped: 0 });
    expect(quiet.filter((c) => c.msg === 'connectors_all_shared')).toEqual([]);
  });

  it('a failure part-way rolls back, never throws, records no marker, and the next run finishes', async () => {
    await setup();
    await insertRow('A', 'x', 'private', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'x', 'private', { createdAt: '2026-02-01T00:00:00Z' });
    await insertRow('C', 'solo', 'private');
    const before = await rows();

    // The dedup UPDATE runs, then the flip UPDATE rejects.
    const failing = makeKysely([failNthUpdate(2)]);
    const calls: LogCall[] = [];
    const result = await makeAllConnectorsShared(failing, recordingLogger(calls));

    expect(result).toEqual({ ran: false, flipped: 0, deduped: 0 });
    expect(await markers()).toEqual([]);
    // One transaction: the dedup that ran before the failure is rolled back.
    expect(await rows()).toEqual(before);
    const failed = calls.filter((c) => c.msg === 'connectors_all_shared_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe('warn');
    expect(failed[0]!.bindings).toEqual({ name: 'Error' });
    // The error message (which may carry an id) is never logged.
    expect(JSON.stringify(calls)).not.toContain('secret-id');

    const healthy = makeKysely();
    expect(await makeAllConnectorsShared(healthy, recordingLogger([]))).toEqual({ ran: true, flipped: 2, deduped: 1 });
    expect(await rows()).toEqual([
      ['C', 'solo', 'shared', true],
      ['A', 'x', 'shared', true],
      ['B', 'x', 'private', false],
    ]);
    expect(await markers()).toEqual([ALL_SHARED_STEP]);
  });

  it("an INSERT that omits visibility reads back as shared (the column's DEFAULT)", async () => {
    const db = await setup();
    await makeAllConnectorsShared(db, recordingLogger([]));

    await sql(
      `INSERT INTO connectors_v1_connectors (owner_user_id, connector_id, name, key_mode, capabilities)
       VALUES ('A', 'fresh', 'fresh', 'personal', $1::jsonb)`,
      [caps],
    );

    expect(await rows()).toEqual([['A', 'fresh', 'shared', true]]);
  });

  it('runs at plugin init: a booted plugin has flipped and deduped the rows, and every user lists the one kept row', async () => {
    await setup();
    await insertRow('A', 'x', 'private', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'x', 'private', { createdAt: '2026-02-01T00:00:00Z' });

    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString }), createConnectorsPlugin()],
    });
    try {
      expect(await rows()).toEqual([
        ['A', 'x', 'shared', true],
        ['B', 'x', 'private', false],
      ]);
      expect(await markers()).toContain(ALL_SHARED_STEP);
      // The id is no longer ambiguous: B (whose row lost) resolves A's.
      const listed = await h.bus.call<{ userId: string }, { connectors: Array<{ id: string; canEdit?: boolean }> }>(
        'connectors:list',
        h.ctx({ userId: 'B' }),
        { userId: 'B' },
      );
      expect(listed.connectors.map((c) => [c.id, c.canEdit])).toEqual([['x', false]]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });
});
