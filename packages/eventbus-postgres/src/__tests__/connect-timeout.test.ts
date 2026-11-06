import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import type { Plugin } from '@ax/core';
import { createEventbusPostgresPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-1056: the listener's connect waits a bounded time.
//
// pg's default (connectionTimeoutMillis: 0) waits forever on a database that
// accepts the connection and never answers. Every emit and subscribe shares
// that one attempt, and nothing ever retried. These tests make the connect
// genuinely hang, then check it ends with pg's own timeout error and joins
// the listener's existing backoff chain.
// ---------------------------------------------------------------------------

const unblock: Array<() => void | Promise<void>> = [];
const harnesses: TestHarness[] = [];

afterEach(async () => {
  // Unblock first: a connect that never answers can't be ended. close() runs
  // the plugin's shutdown, which also clears any pending reconnect timer.
  for (const f of unblock.splice(0)) await f();
  for (const h of harnesses.splice(0)) await h.close({ onError: () => {} });
});

async function harness(plugin: Plugin): Promise<TestHarness> {
  const h = await createTestHarness({ plugins: [plugin] });
  harnesses.push(h);
  return h;
}

interface LoggedRecord {
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function recordingLogger() {
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
      child: () => recordingLogger().logger,
    },
  };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** A TCP server that accepts connections and never writes a byte. */
async function silentServer(): Promise<{ url: string; accepted: () => number }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    // The client resets the socket when it times out; an unhandled 'error'
    // would crash the worker.
    socket.on('error', () => {});
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  unblock.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  return {
    url: `postgres://ax:unused@127.0.0.1:${address.port}/ax`,
    accepted: () => sockets.length,
  };
}

describe('connect timeout, against a database that never answers', () => {
  it('an emit fails once connectTimeoutMs passes, and the listener tries again', async () => {
    const s = await silentServer();
    const log = recordingLogger();
    const h = await harness(
      createEventbusPostgresPlugin({
        connectionString: s.url,
        connectTimeoutMs: 300,
        logger: log.logger,
      }),
    );
    const started = performance.now();
    await expect(
      h.bus.call('eventbus:emit', h.ctx(), { channel: 'task1056', payload: {} }),
    ).rejects.toThrow('timeout expired');
    const waited = performance.now() - started;
    // Loose floor: a new timer counts from the event loop's cached time, so on a
    // starved runner it can fire a little early by wall clock. The message above
    // already proves the timeout path ran.
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(3_000);
    expect(
      log.records.filter((r) => r.msg === 'eventbus_postgres_listener_connect_failed'),
    ).toHaveLength(1);
    // The existing backoff (1 s first) runs again; before the bound, nothing ever retried.
    await expect.poll(() => s.accepted(), { timeout: 3_000 }).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('waits 5 seconds when connectTimeoutMs is not set', async () => {
    const s = await silentServer();
    const log = recordingLogger();
    const h = await harness(
      createEventbusPostgresPlugin({ connectionString: s.url, logger: log.logger }),
    );
    const started = performance.now();
    await expect(
      h.bus.call('eventbus:emit', h.ctx(), { channel: 'task1056', payload: {} }),
    ).rejects.toThrow('timeout expired');
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4_900);
    expect(waited).toBeLessThan(10_000);
  }, 20_000);

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])(
    'refuses connectTimeoutMs %s at construction',
    (value) => {
      expect(
        thrownBy(() =>
          createEventbusPostgresPlugin({
            connectionString: 'postgres://ax@127.0.0.1:1/ax',
            connectTimeoutMs: value as number,
          }),
        ),
      ).toMatchObject({
        name: 'PluginError',
        code: 'invalid-config',
        plugin: '@ax/eventbus-postgres',
      });
    },
  );

  // Vacuous before the fix: the option didn't exist, so nothing was refused.
  it.each([1, 2_147_483_647])('accepts connectTimeoutMs %s', (value) => {
    expect(
      thrownBy(() =>
        createEventbusPostgresPlugin({
          connectionString: 'postgres://ax@127.0.0.1:1/ax',
          connectTimeoutMs: value,
        }),
      ),
    ).toBeUndefined();
  });
});
