import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { Logger } from '@ax/core';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createSessionPostgresPlugin, type SessionPostgresConfig } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-1056: session-postgres bounds its connects (pool + LISTEN client) and
// its statements (pool only).
//
// pg's defaults wait forever for a connect and never cancel a statement. Each
// test makes the wait genuinely hang, then checks it ends with the bound.
// ---------------------------------------------------------------------------

const unblock: Array<() => void | Promise<void>> = [];
const harnesses: TestHarness[] = [];

afterEach(async () => {
  // Unblock first: a pool can't end while a connection is held or connecting.
  for (const f of unblock.splice(0)) await f();
  for (const h of harnesses.splice(0)) await h.close({ onError: () => {} });
});

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

async function boot(config: SessionPostgresConfig): Promise<TestHarness> {
  const h = await createTestHarness({ plugins: [createSessionPostgresPlugin(config)] });
  harnesses.push(h);
  return h;
}

function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  return address.port;
}

/** A TCP server that accepts connections and never writes a byte. */
async function silentServer(): Promise<string> {
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
    await closeServer(server);
  });
  return `postgres://ax:unused@127.0.0.1:${port(server)}/ax`;
}

/** The StartupMessage: int32 length, int32 protocol, then key\0value\0 pairs, \0. */
function parseStartup(chunk: Buffer): Record<string, string> {
  const length = chunk.readInt32BE(0);
  const parts = chunk
    .subarray(8, length - 1)
    .toString('utf8')
    .split('\0');
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]!] = parts[i + 1]!;
  return out;
}

let container: StartedPostgreSqlContainer;
let connectionString: string;

/**
 * A TCP proxy in front of the container. The first `forward` connections are
 * piped through; later ones are accepted and never answered.
 */
async function proxy(forward: number): Promise<{
  url: string;
  acceptedAt: number[];
  startup: Array<Record<string, string>>;
}> {
  const acceptedAt: number[] = [];
  const startup: Array<Record<string, string>> = [];
  const sockets: Socket[] = [];
  let n = 0;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    sockets.push(socket);
    acceptedAt.push(performance.now());
    n += 1;
    let first = true;
    const forwarded = n <= forward;
    const upstream = forwarded ? connect(container.getPort(), container.getHost()) : undefined;
    if (upstream !== undefined) {
      upstream.on('error', () => {});
      sockets.push(upstream);
      upstream.on('data', (chunk: Buffer) => {
        socket.write(chunk);
      });
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
    }
    socket.on('data', (chunk: Buffer) => {
      if (first) {
        first = false;
        startup.push(parseStartup(chunk));
      }
      upstream?.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  unblock.push(async () => {
    for (const s of sockets) s.destroy();
    await closeServer(server);
  });
  const u = new URL(container.getConnectionUri());
  u.hostname = '127.0.0.1';
  u.port = String(port(server));
  return { url: u.toString(), acceptedAt, startup };
}

/** Hold ACCESS EXCLUSIVE on the sessions table until `release()`. */
async function holdTableLock(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN');
  await client.query('LOCK TABLE session_postgres_v1_sessions IN ACCESS EXCLUSIVE MODE');
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  };
  unblock.push(release);
  return release;
}

describe('connect timeout, against a database that never answers', () => {
  it("the pool's first connection fails once checkoutTimeoutMs passes, so init fails", async () => {
    const silent = await silentServer();
    const started = performance.now();
    await expect(
      boot({ connectionString: silent, checkoutTimeoutMs: 300, logger }),
    ).rejects.toThrow('Connection terminated due to connection timeout'); // pg-pool's message: the pool timed out
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(3_000);
  }, 10_000);

  it('waits 5 seconds when checkoutTimeoutMs is not set', async () => {
    const silent = await silentServer();
    const started = performance.now();
    await expect(boot({ connectionString: silent, logger })).rejects.toThrow(
      'Connection terminated due to connection timeout',
    );
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4_900);
    expect(waited).toBeLessThan(10_000);
  }, 20_000);
});

// pg lays the connection string's query parameters over the explicit config,
// so one of these would silently replace (or switch off) statementTimeoutMs.
it.each([
  'postgres://ax@127.0.0.1:1/ax?statement_timeout=0',
  'postgres://ax@127.0.0.1:1/ax?sslmode=no-verify&STATEMENT_TIMEOUT=0',
  'postgres://ax@127.0.0.1:1/ax?statement%5Ftimeout=0',
  'postgres://ax@127.0.0.1:1/ax?options=-c%20statement_timeout%3D0',
])('refuses a connection string that sets the statement timeout itself: %s', (connectionString) => {
  expect(thrownBy(() => createSessionPostgresPlugin({ connectionString }))).toMatchObject({
    name: 'PluginError',
    code: 'invalid-config',
    plugin: '@ax/session-postgres',
    message: expect.stringContaining('statementTimeoutMs'),
  });
});

describe.each(['checkoutTimeoutMs', 'statementTimeoutMs'] as const)(
  '%s at construction',
  (field) => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])(
      'refuses %s',
      (value) => {
        expect(
          thrownBy(() =>
            createSessionPostgresPlugin({
              connectionString: 'postgres://ax@127.0.0.1:1/ax',
              [field]: value,
            } as SessionPostgresConfig),
          ),
        ).toMatchObject({
          name: 'PluginError',
          code: 'invalid-config',
          plugin: '@ax/session-postgres',
        });
      },
    );

    // These pass on the unfixed plugin too; they guard the ends of the range.
    it.each([1, 2_147_483_647])('accepts %s', (value) => {
      expect(
        thrownBy(() =>
          createSessionPostgresPlugin({
            connectionString: 'postgres://ax@127.0.0.1:1/ax',
            [field]: value,
          } as SessionPostgresConfig),
        ),
      ).toBeUndefined();
    });
  },
);

describe('against a real database', () => {
  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
    // Boot and close one plugin with the defaults, so the schema exists and
    // later boots' migrations are no-ops, even under a 300 ms bound.
    const h = await createTestHarness({
      plugins: [createSessionPostgresPlugin({ connectionString, logger })],
    });
    await h.close({ onError: () => {} });
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });

  it("the LISTEN client's connect fails once checkoutTimeoutMs passes, so init fails", async () => {
    const p = await proxy(1); // the migration's one pool connection gets through; the LISTEN client's doesn't
    const err = await errorOf(boot({ connectionString: p.url, checkoutTimeoutMs: 1_000, logger }));
    const rejectedAt = performance.now();
    expect(String((err as Error | undefined)?.message)).toContain('timeout expired'); // pg Client's own message, not pg-pool's
    expect(p.acceptedAt).toHaveLength(2);
    const waited = rejectedAt - p.acceptedAt[1]!;
    expect(waited).toBeGreaterThanOrEqual(800);
    expect(waited).toBeLessThan(3_000);
  }, 15_000);

  it('the LISTEN client waits 5 seconds when checkoutTimeoutMs is not set', async () => {
    const p = await proxy(1);
    const err = await errorOf(boot({ connectionString: p.url, logger }));
    const rejectedAt = performance.now();
    expect(String((err as Error | undefined)?.message)).toContain('timeout expired');
    expect(p.acceptedAt).toHaveLength(2);
    const waited = rejectedAt - p.acceptedAt[1]!;
    expect(waited).toBeGreaterThanOrEqual(4_800);
    expect(waited).toBeLessThan(10_000);
  }, 20_000);

  it('a statement that runs past statementTimeoutMs fails with 57014, and the only connection serves the next call', async () => {
    const h = await boot({
      connectionString,
      poolMax: 1,
      checkoutTimeoutMs: 1_000,
      statementTimeoutMs: 300,
      logger,
    });
    const release = await holdTableLock(); // after boot: the migration creates the table
    const call = () =>
      h.bus.call('session:resolve-token', h.ctx(), { token: 'task-1056-no-such-token' });
    const started = performance.now();
    const err = await errorOf(call());
    expect((err as { cause?: { code?: string } } | undefined)?.cause?.code).toBe('57014'); // the bus wraps the DatabaseError
    expect(performance.now() - started).toBeLessThan(3_000);
    await release();
    await expect(call()).resolves.toBeNull(); // poolMax 1: the cancelled statement's connection came back usable
  }, 15_000);

  it('defaults: the pool connects with a 30 s statement_timeout, the LISTEN client with none', async () => {
    const p = await proxy(Number.POSITIVE_INFINITY);
    await boot({ connectionString: p.url, logger });
    expect(p.startup).toHaveLength(2); // [0] = the pool (the migration runs first), [1] = the LISTEN client
    expect(p.startup[0]).toMatchObject({ statement_timeout: '30000' });
    expect(p.startup[1]).not.toHaveProperty('statement_timeout');
  }, 15_000);
});
