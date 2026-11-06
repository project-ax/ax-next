import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createSessionPostgresPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-1061 acceptance: chat survives Postgres ending the LISTEN connection.
//
// Before, the plugin held one raw pg.Client for LISTEN and nothing reconnected
// it. Once Postgres ended that backend (a restart, a failover,
// pg_terminate_backend), every later session:queue-work rejected "Client has
// encountered a connection error and is not queryable" (after its INSERT had
// landed), a claim on a new channel rejected the same way, and a parked claim
// slept until its timeout. The orchestrator turns that rejection into
// queue-work-failed, so every chat turn failed until the host restarted.
//
// Here the backend is found by its last statement in pg_stat_activity (an idle
// LISTEN connection shows `query = 'LISTEN "session_inbox_<id>"'`), killed with a
// claim parked on it, and must come back on a new backend that LISTENs on the
// parked claim's channel again, so a later queue wakes the claim.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close({ onError: () => {} });
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

/**
 * Waits for exactly one backend whose last statement was `query`, other than
 * the pid `not`, and returns its pid.
 */
async function pollPid(
  admin: pg.Client,
  query: string,
  { not = 0, timeout = 5_000 }: { not?: number; timeout?: number } = {},
): Promise<number> {
  let pid = 0;
  await expect
    .poll(
      async () => {
        const { rows } = await admin.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE query = $1 AND pid <> $2',
          [query, not],
        );
        pid = rows[0]?.pid ?? 0;
        return rows.length;
      },
      { timeout },
    )
    .toBe(1);
  return pid;
}

describe('the LISTEN connection, after Postgres ends it', () => {
  it('a claim parked before its LISTEN backend is terminated is woken by a later queue once the connection comes back', async () => {
    const { records, logger } = makeRecordingLogger();
    const h = await createTestHarness({
      plugins: [createSessionPostgresPlugin({ connectionString, logger })],
    });
    harnesses.push(h);
    await h.bus.call('session:create', h.ctx(), { sessionId: 's1', workspaceRoot: '/tmp/ws' });
    await h.bus.call('session:create', h.ctx(), { sessionId: 's2', workspaceRoot: '/tmp/ws' });

    // Stands in for the host: production has no uncaughtException handler, and
    // vitest reports nothing while another listener exists, so this list is
    // the only witness.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      const parked = h.bus.call('session:claim-work', h.ctx(), {
        sessionId: 's1',
        cursor: 0,
        timeoutMs: 20_000,
      });
      const old = await pollPid(admin, 'LISTEN "session_inbox_s1"');
      await admin.query('SELECT pg_terminate_backend($1, 10000)', [old]);
      // A new backend, LISTENing on the parked claim's channel again. The first
      // reconnect waits 1 s.
      await pollPid(admin, 'LISTEN "session_inbox_s1"', { not: old, timeout: 10_000 });

      const queuedAt = Date.now();
      await expect(
        h.bus.call('session:queue-work', h.ctx(), {
          sessionId: 's1',
          entry: { type: 'user-message', payload: { role: 'user', content: 'hi' }, reqId: 'r1' },
        }),
      ).resolves.toEqual({ cursor: 0 });
      // A delivery returns the NEXT cursor (inbox.ts deliver()).
      await expect(parked).resolves.toMatchObject({ type: 'user-message', reqId: 'r1', cursor: 1 });
      expect(Date.now() - queuedAt).toBeLessThan(5_000); // a wake, not the 20 s timeout

      // A claim on a channel nobody had LISTENed on before the kill works too.
      const fresh = h.bus.call('session:claim-work', h.ctx(), {
        sessionId: 's2',
        cursor: 0,
        timeoutMs: 20_000,
      });
      await pollPid(admin, 'LISTEN "session_inbox_s2"');
      await h.bus.call('session:queue-work', h.ctx(), { sessionId: 's2', entry: { type: 'cancel' } });
      await expect(fresh).resolves.toMatchObject({ type: 'cancel', cursor: 1 });
    } finally {
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
      await admin.end().catch(() => {});
    }
    expect(unhandled).toEqual([]);
    // The killed client reports twice (the server's error, then the socket
    // closing), and the reconnect succeeded, so nothing else.
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'session_postgres_listen_client_error', { code: '57P01', name: 'error' }],
      ['error', 'session_postgres_listen_client_error', { name: 'Error' }],
    ]);
  }, 60_000);
});
