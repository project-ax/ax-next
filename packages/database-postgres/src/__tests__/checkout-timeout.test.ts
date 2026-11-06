import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { sql, type Kysely } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin, type DatabasePostgresConfig } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-1049: a caller waits a bounded time for a pool connection.
//
// pg's default (connectionTimeoutMillis: 0) waits forever, both behind a full
// pool and on a new connection the database never answers. These tests make
// each of those waits genuinely hang, then check they end with pg's own
// timeout error.
// ---------------------------------------------------------------------------

const unblock: Array<() => void | Promise<void>> = [];
const harnesses: TestHarness[] = [];

afterEach(async () => {
  // Unblock first: a pool can't end while one of its connections is held or
  // still connecting. splice(0) so the next teardown doesn't re-run entries.
  for (const f of unblock.splice(0)) await f();
  for (const h of harnesses.splice(0)) await h.close();
});

async function instance(config: DatabasePostgresConfig): Promise<Kysely<unknown>> {
  const h = await createTestHarness({ plugins: [createDatabasePostgresPlugin(config)] });
  harnesses.push(h);
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  return db;
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  return `postgres://ax:unused@127.0.0.1:${address.port}/ax`;
}

/** Check out the pool's only connection and keep it until `release()`. */
async function holdOnlyConnection(
  db: Kysely<unknown>,
): Promise<{ release: () => void; holder: Promise<void> }> {
  let held!: () => void;
  const heldP = new Promise<void>((resolve) => {
    held = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = db.connection().execute(async () => {
    held();
    await gate;
  });
  unblock.push(release);
  // If the hold's own connect fails, fail now with that error.
  await Promise.race([heldP, holder]);
  return { release, holder };
}

describe('checkout timeout, against a database that never answers', () => {
  it('a new connection the database never answers fails once the timeout passes', async () => {
    const db = await instance({ connectionString: await silentServer(), checkoutTimeoutMs: 300 });
    const started = performance.now();
    await expect(sql`SELECT 1`.execute(db)).rejects.toMatchObject({
      message: 'Connection terminated due to connection timeout',
      code: 'db-connect-timeout',
    });
    const waited = performance.now() - started;
    // Loose floor: a new timer counts from the event loop's cached time, so on a
    // starved runner it can fire a little early by wall clock. The message above
    // already proves the timeout path ran.
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(3_000);
  }, 10_000);

  // Passes on the unfixed plugin too: it guards against tagging every connect failure.
  it('a refused connection keeps its own code: only a timeout is tagged (TASK-1058)', async () => {
    const closed = createServer(); // a port nothing listens on: bind one, note it, close it
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const db = await instance({
      connectionString: `postgres://ax:unused@127.0.0.1:${port}/ax`,
      checkoutTimeoutMs: 300,
    });
    await expect(sql`SELECT 1`.execute(db)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  // TASK-1058 review: a connect failure with no code of its own that ISN'T a
  // timeout (a server that answers junk and hangs up) stays untagged. Passes on
  // the unfixed plugin too: it is a forward guard for the exact-message check,
  // without which this would read as a timeout.
  it('a connection the server drops without a code stays untagged: only a timeout is tagged (TASK-1058)', async () => {
    const sockets: Socket[] = [];
    const junk = createServer((socket) => {
      socket.on('error', () => {});
      sockets.push(socket);
      socket.once('data', () => socket.end('Z'));
    });
    await new Promise<void>((resolve) => junk.listen(0, '127.0.0.1', resolve));
    unblock.push(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => junk.close(() => resolve()));
    });
    const { port } = junk.address() as AddressInfo;
    const db = await instance({ connectionString: `postgres://ax:unused@127.0.0.1:${port}/ax`, checkoutTimeoutMs: 2_000 });
    const err: unknown = await sql`SELECT 1`.execute(db).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Connection terminated unexpectedly');
    expect(err).not.toHaveProperty('code');
  });

  // TASK-1058 review: pg-pool counts a connection still connecting as a busy
  // slot, so in an outage a caller queued behind it gets db-checkout-timeout,
  // not db-connect-timeout. Pins the behaviour SECURITY.md describes.
  it('in an outage, a caller queued behind an unanswered connection gets db-checkout-timeout (TASK-1058)', async () => {
    const db = await instance({ connectionString: await silentServer(), poolMax: 1, checkoutTimeoutMs: 400 });
    const codes = await Promise.all(
      [0, 1].map(() => sql`SELECT 1`.execute(db).then(() => 'ok', (e: unknown) => (e as { code?: unknown }).code)),
    );
    // Sorted: pins one of each without depending on the order Kysely resumes the callers in.
    expect([...codes].sort()).toEqual(['db-checkout-timeout', 'db-connect-timeout']);
  }, 10_000);

  it('waits 5 seconds when checkoutTimeoutMs is not set', async () => {
    const db = await instance({ connectionString: await silentServer() });
    const started = performance.now();
    await expect(sql`SELECT 1`.execute(db)).rejects.toMatchObject({
      message: 'Connection terminated due to connection timeout',
      code: 'db-connect-timeout',
    });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4_900);
    expect(waited).toBeLessThan(10_000);
  }, 20_000);

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])(
    'refuses checkoutTimeoutMs %s at boot',
    async (value) => {
      await expect(
        createTestHarness({
          plugins: [
            createDatabasePostgresPlugin({
              connectionString: 'postgres://ax@127.0.0.1:1/ax',
              checkoutTimeoutMs: value as number,
            }),
          ],
        }),
      ).rejects.toMatchObject({
        name: 'PluginError',
        code: 'invalid-config',
        plugin: '@ax/database-postgres',
      });
    },
  );

  // These pass on the unfixed plugin too (it ignored the field). They only guard
  // against a validator that refuses the ends of the valid range.
  it.each([1, 2_147_483_647])('accepts checkoutTimeoutMs %s', async (value) => {
    // Boots; the pool is lazy, so nothing connects.
    await instance({ connectionString: 'postgres://ax@127.0.0.1:1/ax', checkoutTimeoutMs: value });
  });
});

describe('checkout timeout, against a real database', () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;

  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });

  it('a caller waiting for the only connection fails once the timeout passes, and the pool still serves afterwards', async () => {
    const db = await instance({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000 });
    const { release, holder } = await holdOnlyConnection(db);
    const started = performance.now();
    await expect(sql`SELECT 1`.execute(db)).rejects.toMatchObject({
      message: 'timeout exceeded when trying to connect',
      code: 'db-checkout-timeout',
    });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(3_000);
    release();
    await holder;
    // A caller that gave up must not have taken the slot:
    expect((await sql<{ one: number }>`SELECT 1::int AS one`.execute(db)).rows[0]?.one).toBe(1);
  }, 15_000);
});
