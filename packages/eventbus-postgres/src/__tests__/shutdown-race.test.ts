import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { connect, createServer, type Socket } from 'node:net';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { Listener } from '../listener.js';

// ---------------------------------------------------------------------------
// TASK-1061: a connect that lands after shutdown() closes its client.
//
// shutdown() doesn't wait for a connect in flight. Before the fix, that
// connect landed later anyway and became the listener's client: the caller
// waiting on it sent its NOTIFY after shutdown, and the open socket kept the
// process alive. A holding proxy makes the connect land after shutdown() on
// demand: it forwards the client's bytes at once and holds the server's
// replies until release().
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
const listeners: Listener[] = [];
const unblock: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
});

afterEach(async () => {
  // Listeners first, so one a failed test left connecting doesn't start
  // retrying against the proxy we're about to close.
  for (const l of listeners.splice(0)) await l.shutdown();
  for (const f of unblock.splice(0)) await f();
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

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

/** Resolves to the rejection, or `undefined` if `p` resolved. */
function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

/**
 * A proxy in front of the container. Client bytes go upstream at once; the
 * server's replies are held until release(), then flushed, and pass straight
 * through after that. So a connect through it lands exactly when we say.
 */
async function holdingProxy(): Promise<{ url: string; accepted(): number; release(): void }> {
  const sockets: Socket[] = [];
  const flushers: Array<() => void> = [];
  let released = false;
  let accepted = 0;
  const server = createServer((client) => {
    accepted += 1;
    const upstream = connect(container.getPort(), container.getHost());
    sockets.push(client, upstream);
    // Either side resets when the other goes away; an unhandled 'error'
    // would crash the worker.
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    const held: Buffer[] = [];
    upstream.on('data', (chunk: Buffer) => {
      if (released) client.write(chunk);
      else held.push(chunk);
    });
    flushers.push(() => {
      for (const chunk of held.splice(0)) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  unblock.push(async () => {
    // Sockets before close(): in the red run the leaked client keeps its
    // socket open, and close() alone would wait on it past the hook timeout.
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  const url = new URL(container.getConnectionUri());
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.toString(),
    accepted: () => accepted,
    release: () => {
      released = true;
      for (const flush of flushers) flush();
    },
  };
}

/** How many server backends carry this application_name. */
async function backends(app: string): Promise<number> {
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
      [app],
    );
    return rows[0]!.n;
  } finally {
    await admin.end();
  }
}

describe('Listener shutdown during a connect', () => {
  it('a connect that lands after shutdown() ends its client, and the caller waiting on it is refused', async () => {
    const { records, logger } = recordingLogger();
    const proxy = await holdingProxy();
    const listener = new Listener({
      connectionString: `${proxy.url}?application_name=evb_shutdown_race`,
      connectTimeoutMs: 5_000,
      logger,
    });
    listeners.push(listener);
    const emitted = errorOf(listener.notify('evb_shutdown_race', '{}'));
    await expect.poll(() => proxy.accepted(), { timeout: 5_000 }).toBe(1);
    await listener.shutdown();
    proxy.release();
    // Soft, so a red run goes on to show the client left open as well.
    expect.soft(await emitted).toMatchObject({ message: 'eventbus-postgres listener is shut down' });
    await expect.poll(() => backends('evb_shutdown_race'), { timeout: 5_000 }).toBe(0);
    expect(records).toEqual([]);
  });
});
