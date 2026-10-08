import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Logger, Plugin } from '@ax/core';
import { createTestHarness, stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { Kysely, PostgresDialect, type KyselyPlugin } from 'kysely';
import pg from 'pg';
import { runConnectorsMigration, type ConnectorDatabase } from '../migrations.js';
import { ALL_SHARED_STEP, makeAllConnectorsShared, type ResignTarget } from '../all-shared-step.js';
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

const capsWith = (credentials: unknown[]) =>
  JSON.stringify({ allowedHosts: [], credentials, mcpServers: [], packages: { npm: [], pypi: [] } });
const caps = JSON.stringify({ allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } });

/** Insert a row as the pre-slice-7 code could have left it. */
async function insertRow(
  owner: string,
  id: string,
  visibility: 'private' | 'shared',
  opts: { createdAt?: string; deleted?: boolean; keyMode?: 'personal' | 'workspace'; capsJson?: string } = {},
): Promise<void> {
  await sql(
    `INSERT INTO connectors_v1_connectors
       (owner_user_id, connector_id, name, key_mode, visibility, capabilities, created_at, deleted_at)
     VALUES ($1, $2, $2, $7, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)`,
    [
      owner, id, visibility, opts.capsJson ?? caps, opts.createdAt ?? '2026-01-01T00:00:00Z',
      opts.deleted ? '2026-02-01T00:00:00Z' : null, opts.keyMode ?? 'personal',
    ],
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

/** A purge that succeeds and does nothing (most step tests have no 2+ shared group). */
const okPurge = async (_targets: readonly ResignTarget[]): Promise<{ failed: number }> => ({ failed: 0 });

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

    const result = await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    expect(result).toEqual({ ran: true, flipped: 2, deduped: 0, resignIds: [] });
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

    const result = await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    expect(result).toEqual({ ran: true, flipped: 0, deduped: 1, resignIds: [] });
    expect(await rows()).toEqual([
      ['A', 'x', 'shared', true],
      ['B', 'x', 'private', false],
    ]);
  });

  it('keeps the earliest row when two private rows share an id', async () => {
    const db = await setup();
    await insertRow('A', 'y', 'private', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'y', 'private', { createdAt: '2026-02-01T00:00:00Z' });

    const result = await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    expect(result).toEqual({ ran: true, flipped: 1, deduped: 1, resignIds: [] });
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

    const result = await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    // Two SHARED definitions each: sign-ins may belong to the loser, so both
    // ids come back (sorted) for a re-sign-in purge.
    expect(result).toEqual({ ran: true, flipped: 0, deduped: 2, resignIds: ['w', 'z'] });
    expect(await rows()).toEqual([
      ['C', 'w', 'shared', true],
      ['D', 'w', 'shared', false],
      ['A', 'z', 'shared', false],
      ['B', 'z', 'shared', true],
    ]);
  });

  it('SECURITY: with any shared row, the earliest SHARED row wins, never an older private one', async () => {
    const db = await setup();
    await insertRow('P', 'crm', 'private', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('S1', 'crm', 'shared', { createdAt: '2026-02-01T00:00:00Z' });
    await insertRow('S2', 'crm', 'shared', { createdAt: '2026-03-01T00:00:00Z' });

    const result = await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    expect(result).toEqual({ ran: true, flipped: 0, deduped: 2, resignIds: ['crm'] });
    expect(await rows()).toEqual([
      ['P', 'crm', 'private', false],
      ['S1', 'crm', 'shared', true],
      ['S2', 'crm', 'shared', false],
    ]);
  });

  it('addendum: purges every 2+-shared id BEFORE any row is soft-deleted, with the workspace refs of every workspace definition', async () => {
    const db = await setup();
    await insertRow('A', 'dup', 'shared', { createdAt: '2026-01-01T00:00:00Z', keyMode: 'workspace', capsJson: capsWith([{ slot: 'TOKEN', kind: 'api-key' }]) });
    await insertRow('B', 'dup', 'shared', { createdAt: '2026-02-01T00:00:00Z', keyMode: 'workspace', capsJson: capsWith([{ slot: 'X', kind: 'api-key' }, { slot: 'Y', kind: 'api-key' }]) });
    await insertRow('C', 'dup', 'private', { createdAt: '2025-01-01T00:00:00Z', keyMode: 'workspace', capsJson: capsWith([{ slot: 'P', kind: 'api-key' }, { slot: 'Q', kind: 'api-key' }]) });
    await insertRow('A', 'one', 'shared', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'one', 'private', { createdAt: '2026-02-01T00:00:00Z' });
    const seen: Array<{ targets: readonly ResignTarget[]; liveDuring: number }> = [];
    const purge = async (targets: readonly ResignTarget[]) => {
      const live = await sql('SELECT 1 FROM connectors_v1_connectors WHERE deleted_at IS NULL');
      seen.push({ targets, liveDuring: live.length });
      return { failed: 0 };
    };

    const result = await makeAllConnectorsShared(db, recordingLogger([]), purge);

    // Called once, while all 5 rows were still live (before the dedup).
    expect(seen).toEqual([{
      targets: [{
        connectorId: 'dup',
        // Every WORKSPACE definition's global refs (the private row's too: a
        // company key is keyed by the id, so it may have been entered for any).
        globalRefs: ['account:dup', 'account:dup:P', 'account:dup:Q', 'account:dup:X', 'account:dup:Y'],
      }],
      liveDuring: 5,
    }]);
    expect(result).toEqual({ ran: true, flipped: 0, deduped: 3, resignIds: ['dup'] });
  });

  it('addendum: a purge that throws aborts the whole step (nothing soft-deleted, no marker, still ambiguous); the next run with a working purge completes', async () => {
    const db = await setup();
    await insertRow('A', 'dup', 'shared', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'dup', 'shared', { createdAt: '2026-02-01T00:00:00Z' });
    await insertRow('C', 'solo', 'private');
    const before = await rows();
    const calls: LogCall[] = [];

    const result = await makeAllConnectorsShared(db, recordingLogger(calls), async () => {
      throw new Error('vault down for connector dup');
    });

    expect(result).toEqual({ ran: false, flipped: 0, deduped: 0, resignIds: [] });
    expect(await rows()).toEqual(before);
    expect(await markers()).toEqual([]);
    expect(calls.filter((c) => c.msg === 'connectors_all_shared_failed')).toEqual([
      { level: 'warn', msg: 'connectors_all_shared_failed', bindings: { name: 'Error' } },
    ]);
    expect(JSON.stringify(calls)).not.toContain('dup');

    const retried: string[] = [];
    expect(
      await makeAllConnectorsShared(db, recordingLogger([]), async (targets) => {
        retried.push(...targets.map((t) => t.connectorId));
        return { failed: 0 };
      }),
    ).toEqual({ ran: true, flipped: 1, deduped: 1, resignIds: ['dup'] });
    // Still ambiguous on the retry, so it was detected again.
    expect(retried).toEqual(['dup']);
    expect(await markers()).toEqual([ALL_SHARED_STEP]);
  });

  it('addendum: a purge that REPORTS a failure aborts too, warning a count only', async () => {
    const db = await setup();
    await insertRow('A', 'dup', 'shared', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'dup', 'shared', { createdAt: '2026-02-01T00:00:00Z' });
    const before = await rows();
    const calls: LogCall[] = [];

    const result = await makeAllConnectorsShared(db, recordingLogger(calls), async () => ({ failed: 2 }));

    expect(result).toEqual({ ran: false, flipped: 0, deduped: 0, resignIds: [] });
    expect(await rows()).toEqual(before);
    expect(await markers()).toEqual([]);
    expect(calls.filter((c) => c.msg === 'connectors_all_shared_failed')).toEqual([
      { level: 'warn', msg: 'connectors_all_shared_failed', bindings: { name: 'ResignPurgeFailed', failed: 2 } },
    ]);
  });

  it('a group with no workspace definition passes no global refs', async () => {
    const db = await setup();
    await insertRow('A', 'dup', 'shared', { createdAt: '2026-01-01T00:00:00Z', capsJson: capsWith([{ slot: 'T', kind: 'api-key' }]) });
    await insertRow('B', 'dup', 'shared', { createdAt: '2026-02-01T00:00:00Z', capsJson: capsWith([{ slot: 'T', kind: 'api-key' }]) });
    const seen: ResignTarget[] = [];
    await makeAllConnectorsShared(db, recordingLogger([]), async (t) => {
      seen.push(...t);
      return { failed: 0 };
    });
    expect(seen).toEqual([{ connectorId: 'dup', globalRefs: [] }]);
  });

  it('does nothing on a second run', async () => {
    const db = await setup();
    await insertRow('A', 'alpha', 'private');
    expect(await makeAllConnectorsShared(db, recordingLogger([]), okPurge)).toEqual({ ran: true, flipped: 1, deduped: 0, resignIds: [] });

    // A private row written after the step (e.g. by a rolled-back image) is
    // left alone: the step is one-time.
    await insertRow('B', 'beta', 'private');
    const before = await rows();
    const result = await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    expect(result).toEqual({ ran: false, flipped: 0, deduped: 0, resignIds: [] });
    expect(await rows()).toEqual(before);
  });

  it('ignores soft-deleted rows', async () => {
    const db = await setup();
    await insertRow('A', 'gone', 'private', { deleted: true });
    await insertRow('A', 'x', 'shared');
    await insertRow('B', 'x', 'private', { deleted: true });

    const result = await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    expect(result).toEqual({ ran: true, flipped: 0, deduped: 0, resignIds: [] });
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

    await makeAllConnectorsShared(db, recordingLogger(calls), okPurge);

    const done = calls.filter((c) => c.msg === 'connectors_all_shared');
    expect(done).toHaveLength(1);
    expect(done[0]!.level).toBe('info');
    expect(Object.keys(done[0]!.bindings ?? {}).sort()).toEqual(['deduped', 'flipped', 'resigned']);
    expect(done[0]!.bindings).toEqual({ flipped: 1, deduped: 1, resigned: 0 });
    // Nothing logged anywhere carries an id or an owner.
    const text = JSON.stringify(calls);
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('owner-a');
    expect(text).not.toContain('owner-b');

    // A pass that changes nothing logs no `connectors_all_shared` line.
    await sql('DELETE FROM connectors_v1_boot_steps');
    const quiet: LogCall[] = [];
    expect(await makeAllConnectorsShared(db, recordingLogger(quiet), okPurge)).toEqual({ ran: true, flipped: 0, deduped: 0, resignIds: [] });
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
    const result = await makeAllConnectorsShared(failing, recordingLogger(calls), okPurge);

    expect(result).toEqual({ ran: false, flipped: 0, deduped: 0, resignIds: [] });
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
    expect(await makeAllConnectorsShared(healthy, recordingLogger([]), okPurge)).toEqual({ ran: true, flipped: 2, deduped: 1, resignIds: [] });
    expect(await rows()).toEqual([
      ['C', 'solo', 'shared', true],
      ['A', 'x', 'shared', true],
      ['B', 'x', 'private', false],
    ]);
    expect(await markers()).toEqual([ALL_SHARED_STEP]);
  });

  it("an INSERT that omits visibility reads back as shared (the column's DEFAULT)", async () => {
    const db = await setup();
    await makeAllConnectorsShared(db, recordingLogger([]), okPurge);

    await sql(
      `INSERT INTO connectors_v1_connectors (owner_user_id, connector_id, name, key_mode, capabilities)
       VALUES ('A', 'fresh', 'fresh', 'personal', $1::jsonb)`,
      [caps],
    );

    expect(await rows()).toEqual([['A', 'fresh', 'shared', true]]);
  });


});

// ---------------------------------------------------------------------------
// Fix round 1 — init wiring: the non-admin sweep runs BEFORE the step, and an
// id that had two or more SHARED definitions has its id-keyed sign-ins purged
// (agent-scope rows + the global OAuth client secret) after the step commits.
// ---------------------------------------------------------------------------

interface HookCall {
  hook: string;
  input: unknown;
}

/** Records `credentials:delete` / `credentials:purge-account`; optional auth stub. */
function capturePlugin(calls: HookCall[], admins?: Record<string, boolean>): Plugin {
  const registers = ['credentials:delete', 'credentials:purge-account', ...(admins ? ['auth:get-user'] : [])];
  return {
    manifest: { name: 'test/capture', version: '0.0.0', registers, calls: [], subscribes: [] },
    init({ bus }) {
      bus.registerService('credentials:delete', 'test/capture', async (_ctx, input) => {
        calls.push({ hook: 'credentials:delete', input });
        return undefined;
      });
      bus.registerService('credentials:purge-account', 'test/capture', async (_ctx, input) => {
        calls.push({ hook: 'credentials:purge-account', input });
        return { purged: 1 };
      });
      if (admins) {
        bus.registerService('auth:get-user', 'test/capture', async (_ctx, input) => {
          const { userId } = input as { userId: string };
          return userId in admins ? { id: userId, isAdmin: admins[userId] } : null;
        });
      }
    },
  };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), text: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function bootWith(extra: Plugin[]) {
  return createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), ...extra, createConnectorsPlugin()],
  });
}

const purgeCallsFor = (calls: HookCall[], id: string) =>
  calls.filter((c) => JSON.stringify(c.input).includes(`"${id}`) || JSON.stringify(c.input).includes(`:${id}:`));

describe('all-connectors-shared at plugin init (fix round 1)', () => {
  it('two SHARED definitions: keeps the earliest and purges the id\'s agent sign-ins and global client secret, logging a count only', async () => {
    await setup();
    // Both workspace-keyed, with different slots: the company key may have
    // been entered for either definition, so every global ref of either goes.
    await insertRow('owner-early', 'dupid', 'shared', {
      createdAt: '2026-01-01T00:00:00Z', keyMode: 'workspace', capsJson: capsWith([{ slot: 'TOKEN', kind: 'api-key' }]),
    });
    await insertRow('owner-late', 'dupid', 'shared', {
      createdAt: '2026-02-01T00:00:00Z', keyMode: 'workspace',
      capsJson: capsWith([{ slot: 'A', kind: 'api-key' }, { slot: 'B', kind: 'api-key' }]),
    });
    const calls: HookCall[] = [];
    const { result: h, text } = await captureStdout(() =>
      bootWith([capturePlugin(calls, { 'owner-early': true, 'owner-late': true })]),
    );
    try {
      expect(await rows()).toEqual([
        ['owner-early', 'dupid', 'shared', true],
        ['owner-late', 'dupid', 'shared', false],
      ]);
      const del = (ref: string) => ({ hook: 'credentials:delete', input: { scope: 'global', ownerId: null, ref } });
      expect(calls).toEqual([
        { hook: 'credentials:purge-account', input: { connectorId: 'dupid', scopes: ['agent'] } },
        del('account:dupid:OAUTH_CLIENT_SECRET'),
        // Fix round 2 — the workspace (company) keys of every definition.
        del('account:dupid'),
        del('account:dupid:A'),
        del('account:dupid:B'),
      ]);
      const lines = text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.filter((l) => l['msg'] === 'connectors_all_shared')).toEqual([
        expect.objectContaining({ flipped: 0, deduped: 1, resigned: 1 }),
      ]);
      // The step and its re-sign-in purge never log the id or an owner.
      const stepLines = lines.filter((l) => String(l['msg']).startsWith('connectors_all_shared'));
      expect(JSON.stringify(stepLines)).not.toContain('dupid');
      expect(JSON.stringify(stepLines)).not.toContain('owner-');
    } finally {
      await h.close({ onError: () => {} });
    }
  });

  it('one shared + one private: no purge', async () => {
    await setup();
    await insertRow('A', 'x', 'shared', { createdAt: '2026-02-01T00:00:00Z' });
    await insertRow('B', 'x', 'private', { createdAt: '2026-01-01T00:00:00Z' });
    const calls: HookCall[] = [];
    const h = await bootWith([capturePlugin(calls, { A: true, B: true })]);
    try {
      expect(await rows()).toEqual([
        ['A', 'x', 'shared', true],
        ['B', 'x', 'private', false],
      ]);
      expect(calls).toEqual([]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });

  it('runs at plugin init: two private rows, the earliest kept (flipped), no purge, and every user lists the one kept row', async () => {
    await setup();
    await insertRow('A', 'x', 'private', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('B', 'x', 'private', { createdAt: '2026-02-01T00:00:00Z' });
    const calls: HookCall[] = [];
    const h = await bootWith([capturePlugin(calls, { A: true, B: true })]);
    try {
      expect(await rows()).toEqual([
        ['A', 'x', 'shared', true],
        ['B', 'x', 'private', false],
      ]);
      expect(await markers()).toContain(ALL_SHARED_STEP);
      expect(calls).toEqual([]);
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

  it('the non-admin sweep runs FIRST, so the dedup never keeps a row the sweep then deletes', async () => {
    await setup();
    // A non-admin's older shared row and an admin's newer one. Step-first would
    // keep the non-admin's (earliest) and the sweep would then delete it,
    // leaving the id with no live definition.
    await insertRow('user1', 'crm', 'shared', { createdAt: '2026-01-01T00:00:00Z' });
    await insertRow('admin1', 'crm', 'shared', { createdAt: '2026-02-01T00:00:00Z' });
    const calls: HookCall[] = [];
    const h = await bootWith([capturePlugin(calls, { admin1: true, user1: false })]);
    try {
      expect(await rows()).toEqual([
        ['admin1', 'crm', 'shared', true],
        ['user1', 'crm', 'shared', false],
      ]);
      // The sweep removed user1's row while admin1's survived (no purge), and
      // the step then saw one live row: no dedup, no re-sign-in purge.
      expect(purgeCallsFor(calls, 'crm')).toEqual([]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });

  it('fix round 2: no auth provider → the non-admin sweep skips unmarked, so the step does not run and leaves no marker; a later boot with the sweep done runs it', async () => {
    await setup();
    await insertRow('A', 'x', 'private');
    const first = await bootWith([capturePlugin([])]);
    try {
      expect(await rows()).toEqual([['A', 'x', 'private', true]]);
      expect(await markers()).toEqual([]);
    } finally {
      await first.close({ onError: () => {} });
    }

    const second = await bootWith([capturePlugin([], { A: true })]);
    try {
      expect(await rows()).toEqual([['A', 'x', 'shared', true]]);
      expect((await markers()).sort()).toEqual([ALL_SHARED_STEP, 'non-admin-connector-removal'].sort());
    } finally {
      await second.close({ onError: () => {} });
    }
  });
});
