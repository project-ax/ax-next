import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createSessionPostgresPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Regression test for Fix 3 (production hardening):
//
// pg.Pool and the dedicated LISTEN pg.Client emit 'error' asynchronously
// (idle-pool socket failures, postgres restart in k8s, post-connect socket
// errors). Without listeners attached, Node treats them as unhandled and
// crashes the process. We assert the plugin survives a synthetic 'error'
// event on the LISTEN connection — proving the listener is in place.
//
// We trigger a real socket-level failure: from a parallel pg connection,
// call `pg_terminate_backend(<plugin's listen pid>)` to abruptly close
// the plugin's LISTEN socket. That causes pg's Client to emit 'error'.
// If the plugin missed its `'error'` handler, the test runner crashes.
//
// TASK-1058: pg-pool listens for a pooled client's 'error' only while it is
// idle, so the second test kills a client that is checked out (session:create's
// transaction, waiting on a lock). Every line is codes only (faultLogFields).
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: Awaited<ReturnType<typeof createTestHarness>>[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanupClient = new pg.Client({ connectionString });
  await cleanupClient.connect();
  try {
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_inbox');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_sessions');
  } finally {
    await cleanupClient.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface LoggedRecord {
  level: string;
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function makeRecordingLogger() {
  const records: LoggedRecord[] = [];
  const make = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    records.push({ level, msg, bindings });
  };
  const logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => logger,
  };
  return { records, logger };
}

describe('@ax/session-postgres background error handlers', () => {
  // TASK-1058 review: a client that dies BETWEEN queries emits twice (the
  // server's error, then the socket closing). The kill tests below only kill
  // mid-query, which emits once, so this drives the pool's own 'acquire' /
  // 'release' handlers with a stand-in client to pin "first event only" and
  // "detached at release".
  it("logs a checked-out client's first 'error' only, codes only, and detaches at release (TASK-1058)", async () => {
    const { records, logger } = makeRecordingLogger();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    // Calls through to the real `on`; read the handlers before mockRestore clears the calls.
    const spy = vi.spyOn(pg.Pool.prototype, 'on');
    try {
      const h = await createTestHarness({ plugins: [createSessionPostgresPlugin({ connectionString, logger })] });
      harnesses.push(h);
      for (const [event, handler] of spy.mock.calls) {
        if (event === 'acquire' || event === 'release') handlers.set(event as string, handler as (...args: unknown[]) => void);
      }
    } finally {
      spy.mockRestore();
    }
    const client = new EventEmitter();
    handlers.get('acquire')!(client);
    client.emit('error', Object.assign(new Error('PRIVATE pg text at 10.0.0.7'), { code: '57P01' }));
    client.emit('error', new Error('Connection terminated unexpectedly'));
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'session_postgres_client_error', { code: '57P01', name: 'Error' }],
    ]);
    handlers.get('release')!(undefined, client);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('idle and LISTEN connections a terminated backend drops log codes only, no crash (TASK-1058)', async () => {
    const { records, logger } = makeRecordingLogger();
    const plugin = createSessionPostgresPlugin({ connectionString, logger });
    const h = await createTestHarness({ plugins: [plugin] });
    harnesses.push(h);
    void h;

    // Capture process-level unhandled events — if the plugin missed an
    // 'error' listener, Node would funnel through here and crash.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);

    const lines = (msg: string) => records.filter((r) => r.msg === msg).map((r) => r.bindings);
    try {
      // Find the plugin's LISTEN backend pid by looking up the pg connection
      // that's running `LISTEN` (or has app_name we can identify). We don't
      // tag the connection today, so just terminate ALL connections from the
      // test except our own — that's effectively what postgres restart does.
      const admin = new pg.Client({ connectionString });
      await admin.connect();
      try {
        await admin.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
        `);
      } finally {
        await admin.end().catch(() => {});
      }

      // The LISTEN client reports twice (below); wait for both, then leave
      // room for a stray line, if one were coming.
      await expect
        .poll(() => lines('session_postgres_listen_client_error').length, { timeout: 10_000 })
        .toBe(2);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
    }

    // Process didn't crash — that's the headline assertion.
    expect(unhandled).toEqual([]);
    expect(records.every((r) => r.level === 'error')).toBe(true);
    // Idle-pool and LISTEN lines only: a checked-out listener left on after
    // release would add a client line (init's migration checked the idle
    // pooled client out once before it went idle).
    expect(new Set(records.map((r) => r.msg))).toEqual(
      new Set(['session_postgres_pool_error', 'session_postgres_listen_client_error']),
    );
    // The LISTEN client reports the server's error, then the socket closing.
    expect(lines('session_postgres_listen_client_error')).toStrictEqual([
      { code: '57P01', name: 'error' },
      { name: 'Error' },
    ]);
    // pg-pool reports each idle pooled client once (init's migration leaves one).
    const pool = lines('session_postgres_pool_error');
    expect(pool.length).toBeGreaterThanOrEqual(1);
    for (const b of pool) expect(b).toStrictEqual({ code: '57P01', name: 'error' });
  }, 15000);

  it("survives Postgres ending a checked-out client's session mid-transaction: one code-only line, no crash (TASK-1058)", async () => {
    const { records, logger } = makeRecordingLogger();
    const h = await createTestHarness({
      plugins: [createSessionPostgresPlugin({ connectionString, logger })],
    });
    harnesses.push(h);
    // `locker` holds the table lock in an open transaction; `admin` polls and
    // kills. Polling from inside the locker's transaction would read a stale
    // pg_stat_activity snapshot.
    const locker = new pg.Client({ connectionString });
    const admin = new pg.Client({ connectionString });
    await locker.connect();
    await admin.connect();
    // Stands in for the host: production has no uncaughtException handler, and
    // vitest reports nothing while another listener exists, so this list is
    // the only witness.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    let outcome: unknown;
    try {
      const lockerPid = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE session_postgres_v1_sessions IN ACCESS EXCLUSIVE MODE');
      // session:create's transaction: BEGIN, then an INSERT that waits behind
      // the lock on a checked-out client.
      const created = h.bus
        .call('session:create', h.ctx(), { sessionId: 's-dropped', workspaceRoot: '/tmp/ws' })
        .then(
          () => 'created',
          (err: unknown) => err,
        );
      // The waiter is chosen by pg_blocking_pids alone: pg_stat_activity's own
      // row fields can lag it within the same query.
      let waiter = 0;
      await expect
        .poll(
          async () => {
            const { rows } = await admin.query<{ pid: number }>(
              'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
              [lockerPid],
            );
            waiter = rows[0]?.pid ?? 0;
            return rows.length;
          },
          { timeout: 10_000 },
        )
        .toBe(1);
      // The INSERT gets the 57P01. Kysely's ROLLBACK keeps the client checked
      // out while its socket closes.
      await admin.query('SELECT pg_terminate_backend($1, 10000)', [waiter]);
      outcome = await created;
      await new Promise((r) => setTimeout(r, 200)); // room for a second line, if one were coming
    } finally {
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
      await locker.query('ROLLBACK').catch(() => {});
      await locker.end().catch(() => {});
      await admin.end().catch(() => {});
    }
    expect(unhandled).toEqual([]);
    expect(outcome).toBeInstanceOf(Error); // the caller still sees the failure
    // pg-pool dropped the dead client at release, so the pool still answers.
    await expect(
      h.bus.call('session:create', h.ctx(), { sessionId: 's-after', workspaceRoot: '/tmp/ws' }),
    ).resolves.toMatchObject({ sessionId: 's-after' });
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'session_postgres_client_error', { name: 'Error' }],
    ]);
  }, 30_000);
});
