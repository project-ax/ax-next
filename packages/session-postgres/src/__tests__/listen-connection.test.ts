import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import {
  LISTEN_CONNECTION_SHUT_DOWN,
  ListenConnection,
  type ListenConnectionOptions,
} from '../listen-connection.js';

// ---------------------------------------------------------------------------
// TASK-1061: session-postgres's LISTEN connection reconnects.
//
// Before ListenConnection the plugin held one raw pg.Client for LISTEN. When
// Postgres ended that backend (a restart, a failover, pg_terminate_backend),
// nothing reconnected: every later queue-work rejected "not queryable" and a
// parked claim slept until its timeout, until the host restarted. These tests
// pin the parts of the reconnect that its signatures don't:
//   1. a failed connect schedules the next attempt itself (pg emits no client
//      'error' for a failed connect, so nothing else would);
//   2. queryIfConnected (the inbox's UNLISTEN) never opens a connection, and
//      nothing connects after shutdown();
//   3. a connect that lands after shutdown() ends its client;
//   4. a new client serves no caller until it has LISTENed every bound channel,
//      or a pg_notify could go out before the LISTEN a parked claim needs.
// ---------------------------------------------------------------------------

/** Port 1 is closed on test hosts, so a connect is refused at once (ECONNREFUSED). */
const UNREACHABLE = 'postgres://ax:unused@127.0.0.1:1/ax';

const opened: ListenConnection[] = [];
const unblock: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Shut down first, so no reconnect timer outlives its test; then drop the proxies.
  for (const listen of opened.splice(0)) await listen.shutdown();
  for (const f of unblock.splice(0)) await f();
});

function open(opts: ListenConnectionOptions): ListenConnection {
  const listen = new ListenConnection(opts);
  opened.push(listen);
  return listen;
}

interface LoggedRecord {
  level: string;
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function recordingLogger() {
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

function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  return address.port;
}

describe('without a database', () => {
  it('a failed connect schedules the next attempt, and each failure is one code-only warn line', async () => {
    const { records, logger } = recordingLogger();
    const listen = open({
      connectionString: UNREACHABLE,
      connectTimeoutMs: 1_000,
      keepAliveInitialDelayMs: 10_000,
      logger,
    });
    expect(await errorOf(listen.ensureConnected())).toMatchObject({ code: 'ECONNREFUSED' });
    // pg emits no client 'error' for a failed connect, so only the connect's own
    // catch can schedule the next attempt. The backoff's first wait is 1 s.
    await expect.poll(() => records.length, { timeout: 3_500 }).toBeGreaterThanOrEqual(2);
    const seen = records.length;
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual(
      Array.from({ length: seen }, () => [
        'warn',
        'session_postgres_listen_connect_failed',
        { code: 'ECONNREFUSED', name: 'Error' },
      ]),
    );
    await listen.shutdown();
    await new Promise((r) => setTimeout(r, 2_500)); // past the next 2 s backoff step
    expect(records).toHaveLength(seen);
  });

  it('queryIfConnected never connects, and query() after shutdown() is refused without connecting', async () => {
    const { records, logger } = recordingLogger();
    const listen = open({
      connectionString: UNREACHABLE,
      connectTimeoutMs: 1_000,
      keepAliveInitialDelayMs: 10_000,
      logger,
    });
    // A connect attempt to UNREACHABLE would log a connect_failed line.
    await expect(listen.queryIfConnected('UNLISTEN "x"')).resolves.toBeUndefined();
    expect(records).toEqual([]);
    await listen.shutdown();
    // A connect attempt would reject ECONNREFUSED instead.
    await expect(listen.query('SELECT 1')).rejects.toMatchObject({
      message: LISTEN_CONNECTION_SHUT_DOWN,
    });
    expect(records).toEqual([]);
  });
});

describe('against a real database', () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;

  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });

  /**
   * A TCP proxy in front of the container. It forwards the client's bytes at
   * once but holds the server's replies until `release()`, so a connect reaches
   * the database and then waits there for as long as the test likes.
   */
  async function holdingProxy(): Promise<{
    url: string;
    accepted: () => number;
    release: () => void;
  }> {
    const sockets: Socket[] = [];
    const flushes: Array<() => void> = [];
    let accepted = 0;
    let released = false;
    const server = createServer((socket) => {
      accepted += 1;
      socket.on('error', () => {});
      const upstream = connect(container.getPort(), container.getHost());
      upstream.on('error', () => {});
      sockets.push(socket, upstream);
      const held: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => {
        if (released) socket.write(chunk);
        else held.push(chunk);
      });
      flushes.push(() => {
        for (const chunk of held.splice(0)) socket.write(chunk);
      });
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    unblock.push(async () => {
      // Sockets before close(): a leaked client keeps its socket open, and
      // close() would wait on it until the hook timed out.
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const u = new URL(container.getConnectionUri());
    u.hostname = '127.0.0.1';
    u.port = String(port(server));
    return {
      url: u.toString(),
      accepted: () => accepted,
      release: () => {
        released = true;
        for (const flush of flushes) flush();
      },
    };
  }

  /** How many server backends carry this application_name. */
  async function backends(app: string): Promise<number> {
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      const r = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
        [app],
      );
      return r.rows[0]!.n;
    } finally {
      await admin.end().catch(() => {});
    }
  }

  it('a connect that lands after shutdown() ends its client and refuses its caller', async () => {
    const { records, logger } = recordingLogger();
    const proxy = await holdingProxy();
    const listen = open({
      connectionString: `${proxy.url}?application_name=session_listen_race`,
      connectTimeoutMs: 10_000,
      keepAliveInitialDelayMs: 10_000,
      logger,
    });
    const connected = errorOf(listen.ensureConnected());
    await expect.poll(() => proxy.accepted(), { timeout: 5_000 }).toBe(1);
    await listen.shutdown();
    proxy.release(); // the connect completes now, after shutdown()
    expect(await connected).toMatchObject({ message: LISTEN_CONNECTION_SHUT_DOWN });
    await expect.poll(() => backends('session_listen_race'), { timeout: 5_000 }).toBe(0);
    expect(records).toEqual([]);
  });

  it('a caller waits until a new client has LISTENed every bound channel', async () => {
    const { logger } = recordingLogger();
    const listen = open({
      connectionString,
      connectTimeoutMs: 10_000,
      keepAliveInitialDelayMs: 10_000,
      logger,
    });
    listen.bind({ onNotification: () => {}, channels: () => ['ch_gate'] });
    // Hold every LISTEN at a gate; everything else goes straight through.
    const original = pg.Client.prototype.query as (this: pg.Client, ...args: unknown[]) => unknown;
    let listenPending = false;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const text = args[0];
      if (typeof text === 'string' && text.startsWith('LISTEN ')) {
        listenPending = true;
        return gate.then(() => original.apply(this, args));
      }
      return original.apply(this, args);
    } as never);
    try {
      // Captured at once: a red run throws before awaiting it, and afterEach's
      // shutdown() would then reject it with nobody listening.
      const first = errorOf(listen.ensureConnected());
      await expect.poll(() => listenPending, { timeout: 10_000 }).toBe(true);
      let settled = false;
      const second = listen.query('SELECT 1 AS one');
      const markSettled = (): void => {
        settled = true;
      };
      second.then(markSettled, markSettled);
      await new Promise((r) => setTimeout(r, 200));
      expect(settled).toBe(false); // the client is connected, but hasn't LISTENed yet
      openGate();
      expect(await first).toBeUndefined();
      await expect(second).resolves.toMatchObject({ rows: [{ one: 1 }] });
    } finally {
      openGate(); // a red run must not leave the LISTEN parked
      spy.mockRestore();
    }
  });
});
