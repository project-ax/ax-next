import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createInbox } from '../inbox.js';
import { createSessionStore } from '../store.js';
import { runSessionMigration, type SessionDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// Regression: a wakeWaiter mid-`await isTerminated(...)` (or fetchEntry)
// must not surface as an unhandled rejection when the kysely driver gets
// destroyed under it.
//
// Original bug (CI on PR #59 caught it; macOS local could not):
//   1. NOTIFY arrives → notification handler `void wakeWaiter(w)`-fires.
//   2. wakeWaiter awaits `isTerminated(...)` which queries through kysely.
//   3. Test completes; afterEach → plugin.shutdown → inbox.shutdown
//      (clears waiters) → kysely.destroy.
//   4. Step 2's query resumes → "driver has already been destroyed" →
//      because wakeWaiter was void-fired, the rejection is unhandled.
//
// This regression test reproduces the bug deterministically by matching
// the production isTerminated wiring (real `createSessionStore(db).get`)
// and forcing the destroy-during-wake window with an in-flight isTerminated
// caller queue.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterAll(async () => {
  if (container) await container.stop();
});

const opened: { destroy: () => Promise<void> }[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const o = opened.pop()!;
    await o.destroy().catch(() => {});
  }
  const cleanupClient = new pg.Client({ connectionString });
  await cleanupClient.connect();
  try {
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_inbox');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_sessions');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_session_owners');
  } finally {
    await cleanupClient.end().catch(() => {});
  }
});

describe('inbox shutdown race', () => {
  it('does NOT raise unhandled rejection when isTerminated rejects after shutdown', async () => {
    const pool = new pg.Pool({ connectionString, max: 5 });
    const db = new Kysely<SessionDatabase>({ dialect: new PostgresDialect({ pool }) });
    opened.push({
      destroy: () => db.destroy().catch(() => {}) as unknown as Promise<void>,
    });
    await runSessionMigration(db);

    const listenClient = new pg.Client({ connectionString });
    await listenClient.connect();
    opened.push({
      destroy: () => listenClient.end().catch(() => {}) as unknown as Promise<void>,
    });

    const store = createSessionStore(db);

    // Wrap isTerminated with a "block on signal" gate so the test can
    // freeze wakeWaiter mid-call. The gate is closed initially; we open it
    // AFTER inbox.shutdown() runs and AFTER db.destroy() runs, so the
    // resumed query lands on a destroyed kysely.
    let releaseGate: () => void = () => {};
    const gateOpenedP = new Promise<void>((r) => {
      releaseGate = r;
    });
    // claim() has its own isTerminated pre-check (at the entry point) that
    // runs BEFORE the LISTEN binding is installed. We let that one through
    // (returns false) so claim parks a waiter, then block on the SECOND call
    // — which is the wakeWaiter path triggered by our NOTIFY.
    let callCount = 0;
    const inbox = createInbox({
      db,
      listenClient,
      isTerminated: async (sessionId) => {
        callCount += 1;
        if (callCount === 1) {
          // Fast-path check inside claim() — non-terminal, let it proceed.
          return false;
        }
        // Second call is from wakeWaiter. Park here until shutdown + destroy
        // have run, then resume — that's the production-bug shape.
        await gateOpenedP;
        const rec = await store.get(sessionId);
        return rec === null || rec.terminated;
      },
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const sessionId = 'shutdown_race_1';
      const claimP = inbox.claim(sessionId, 0, 5000);
      // Give ensureListen() time to land.
      await new Promise((r) => setTimeout(r, 100));

      // Fire NOTIFY through a separate connection. listenClient's handler
      // void-fires wakeWaiter; wakeWaiter calls fetchEntry (returns null —
      // no entry queued), then awaits isTerminated → blocks on our gate.
      const notifier = new pg.Client({ connectionString });
      await notifier.connect();
      try {
        await notifier.query(`NOTIFY session_inbox_${sessionId}`);
      } finally {
        await notifier.end().catch(() => {});
      }

      // Wait for wakeWaiter to enter our isTerminated stub.
      await new Promise((r) => setTimeout(r, 200));

      // Run shutdown — this clears waiters and (with the fix) flips
      // shuttingDown=true so the resumed isTerminated→store.get can
      // see the right state.
      await inbox.shutdown();

      // Destroy the kysely driver BEFORE releasing the gate so the
      // resumed wakeWaiter's query lands on a destroyed driver — exactly
      // the production bug shape.
      await db.destroy();

      // Release the gate. wakeWaiter resumes, calls store.get → kysely
      // throws "driver has already been destroyed". Without the fix this
      // surfaces as unhandled. With the fix, wakeWaiter's catch sees
      // shuttingDown=true and bails.
      releaseGate();

      // Give the microtask queue time to flush the resumed wakeWaiter.
      await new Promise((r) => setTimeout(r, 300));

      // The waiter resolved-as-timeout from shutdown().
      const result = await claimP;
      expect(result).toEqual({ type: 'timeout', cursor: 0 });

      // The actual regression check: no unhandled rejection landed.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 15000);
});
