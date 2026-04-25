import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness } from '@ax/test-harness';
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
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: Awaited<ReturnType<typeof createTestHarness>>[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
  if (container) await container.stop();
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
  it('survives a forced socket termination on the LISTEN client (logs, no crash)', async () => {
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

    // Give the LISTEN socket time to surface the error event.
    await new Promise((r) => setTimeout(r, 500));

    process.off('uncaughtException', onUnhandled);
    process.off('unhandledRejection', onUnhandled);

    // Process didn't crash — that's the headline assertion. Additionally
    // we expect at least one of our background error logs to have fired
    // (pool error or listen client error, depending on which surfaced
    // first).
    expect(unhandled).toEqual([]);
    const bgErrors = records.filter(
      (r) =>
        r.level === 'error' &&
        (r.msg === 'session_postgres_pool_error' ||
          r.msg === 'session_postgres_listen_client_error'),
    );
    expect(bgErrors.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});
