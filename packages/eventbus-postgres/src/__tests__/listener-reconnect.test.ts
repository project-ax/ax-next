import { describe, it, expect } from 'vitest';
import { Listener } from '../listener.js';

// ---------------------------------------------------------------------------
// Regression test for the reconnect-chain stall.
//
// Bug: pg@8.x does NOT emit 'error' for client.connect() failures (e.g.,
// ECONNREFUSED). The connection-time failure rejects the promise only —
// the 'error' event never fires. So when the original code relied on the
// 'error' handler to call scheduleReconnect(), the reconnect chain stalled
// after the first failed attempt: no event, no schedule, listener silently
// dead.
//
// Fix: catch in connect() explicitly calls scheduleReconnect() before
// re-throwing, so the backoff chain keeps trying.
//
// This test points at a closed port (127.0.0.1:1) and verifies that the
// listener fires the warn-log MORE THAN ONCE within a short window. With
// the bug present, only the first attempt logs and then nothing. With the
// fix, the 1s -> 2s backoff fires at least two attempts inside ~3.5s.
// ---------------------------------------------------------------------------

interface LoggedRecord {
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function makeRecordingLogger() {
  const records: LoggedRecord[] = [];
  const noop = (msg: string, bindings?: Record<string, unknown>) => {
    records.push({ msg, bindings });
  };
  return {
    records,
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      child: () => makeRecordingLogger().logger,
    },
  };
}

describe('Listener reconnect chain', () => {
  it('reschedules after a connect() failure (does NOT rely on error event)', async () => {
    const { records, logger } = makeRecordingLogger();
    // Port 1 — assumed closed on test hosts. Connect rejects with ECONNREFUSED.
    const listener = new Listener({
      connectionString: 'postgres://localhost:1/nope',
      logger,
    });

    // Kick off the first attempt; it will reject. We swallow because the
    // listener schedules its own retry from the catch.
    await listener.ensureConnected().catch(() => {});

    // Wait long enough for the second backoff tick (1s) plus jitter.
    // If the chain stalls after first failure, we'll see exactly ONE failure
    // log. With the fix, we should see at least two within ~2.5s.
    const failures: LoggedRecord[] = [];
    const start = Date.now();
    while (Date.now() - start < 3500) {
      failures.length = 0;
      for (const r of records) {
        if (r.msg === 'eventbus_postgres_listener_connect_failed') failures.push(r);
      }
      if (failures.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Stop the listener so the test process can exit cleanly.
    await listener.shutdown();

    expect(failures.length).toBeGreaterThanOrEqual(2);
  }, 10000);
});
