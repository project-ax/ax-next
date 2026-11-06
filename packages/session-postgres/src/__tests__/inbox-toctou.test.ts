import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Logger } from '@ax/core';
import { createInbox } from '../inbox.js';
import { ListenConnection } from '../listen-connection.js';
import { runSessionMigration, type SessionDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// Focused regression test for the ensureListen TOCTOU race.
//
// We can't easily force the race through the public plugin surface — pg's
// LISTEN query usually completes quickly enough that two queued claims
// don't overlap deterministically. So we wrap the real LISTEN connection's
// `query()` so it delays the FIRST LISTEN long enough for a second
// concurrent ensureListen call to read the same `cur = 0`.
//
// With the bug present (the original increment-after-await), both calls
// set the count to 1. When the first claim resolves and decrements, count
// goes 1 -> 0, the channel is UNLISTENed, and the second claim's queue
// notification never arrives. With the fix (synchronous increment before
// the await), the second call reads count = 1 and increments to 2; the
// first decrement leaves it at 1; the channel stays LISTENed; the second
// claim wakes correctly.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const opened: { destroy: () => Promise<void> }[] = [];

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

afterEach(async () => {
  while (opened.length > 0) {
    const o = opened.pop()!;
    await o.destroy().catch(() => {});
  }
  // Clean tables for the next test.
  const cleanupClient = new pg.Client({ connectionString });
  await cleanupClient.connect();
  try {
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_inbox');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_sessions');
  } finally {
    await cleanupClient.end().catch(() => {});
  }
});

describe('inbox ensureListen TOCTOU', () => {
  it('two concurrent claims on the same channel both wake when entries arrive', async () => {
    // Set up real pool + kysely + migration for a real backing inbox table.
    const pool = new pg.Pool({ connectionString, max: 5 });
    const db = new Kysely<SessionDatabase>({ dialect: new PostgresDialect({ pool }) });
    opened.push({ destroy: () => db.destroy().catch(() => {}) as unknown as Promise<void> });
    await runSessionMigration(db);

    // Real LISTEN connection, but we wrap its `query` to inject a delay on the
    // first LISTEN call. That delay is what gives the second concurrent
    // ensureListen call a chance to read cur = 0 before our increment lands.
    const listen = new ListenConnection({
      connectionString,
      connectTimeoutMs: 5_000,
      keepAliveInitialDelayMs: 10_000,
      logger,
    });
    opened.push({ destroy: () => listen.shutdown() });
    await listen.ensureConnected();

    const realQuery = listen.query.bind(listen);
    let firstListenSeen = false;
    listen.query = (text, values) => {
      if (text.startsWith('LISTEN ') && !firstListenSeen) {
        firstListenSeen = true;
        return new Promise((resolve, reject) => {
          // 200ms is enough for a second ensureListen to ride past the
          // pre-await read of `cur` and reproduce the clobber.
          setTimeout(() => {
            realQuery(text, values).then(resolve, reject);
          }, 200);
        });
      }
      return realQuery(text, values);
    };

    // Insert a session row directly so isTerminated returns false. Inbox
    // doesn't read sessions; we just need a sessionId.
    const inbox = createInbox({
      db,
      listen,
      isTerminated: async () => false,
    });

    const sessionId = 'toctou-1';
    // Fire two concurrent claims at different cursors. Both will go to the
    // slow path and call ensureListen back-to-back.
    const claimAP = inbox.claim(sessionId, 0, 5000);
    const claimBP = inbox.claim(sessionId, 1, 5000);

    // Wait long enough for the staged LISTEN delay to clear.
    await new Promise((r) => setTimeout(r, 350));
    // Queue two entries. Both claim handlers should wake — A on cursor 0,
    // B on cursor 1. With the bug, A's finishWaiter UNLISTENs the channel
    // before B's notification arrives, so B times out.
    await inbox.queue(sessionId, {
      type: 'user-message',
      payload: { role: 'user', content: 'a' },
      reqId: 'r-a',
    });
    // Small gap so A's wake + UNLISTEN actually fires before B's notify.
    await new Promise((r) => setTimeout(r, 100));
    await inbox.queue(sessionId, {
      type: 'user-message',
      payload: { role: 'user', content: 'b' },
      reqId: 'r-b',
    });

    const [a, b] = await Promise.all([claimAP, claimBP]);
    expect(a).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'a' },
      reqId: 'r-a',
      cursor: 1,
    });
    expect(b).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'b' },
      reqId: 'r-b',
      cursor: 2,
    });

    await inbox.shutdown();
  }, 15000);
});
