import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { captureOutput } from './support/capture-output.js';
import { requestWithHost } from './support/request-with-host.js';

// ---------------------------------------------------------------------------
// TASK-1052: a malformed Host gets a fixed 400 that Better Auth's own rate
// limiter has already counted, and the endpoint never runs.
//
// This is the REAL Better Auth, so the limiter, the plugin pipeline and the
// router under test are all its own. It pins the order our refusal relies on:
// better-auth 1.7.7's router `onRequest` runs disabled paths, the schema
// check, the rate limiter, then each plugin's `onRequest`. An upgrade that
// reorders them goes red here.
//
// No Docker. The one thing changed is `advanced.database.validateSchema`,
// turned off: with no Postgres, the runtime schema check fails every request
// on the inert DummyDriver BEFORE the limiter runs (MEASURED). The driver
// records each query it is asked to run, which is how "the endpoint never
// ran" is proved: zero queries for a refused request, some for the control.
//
// Better Auth's limiter store is module-level, so every Better Auth instance
// in this file shares it: each test uses its own path, so buckets never mix.
// No request sends x-forwarded-for, so the client IP is Better Auth's test
// fallback (127.0.0.1) for all of them.
// ---------------------------------------------------------------------------

const { queries, barrier } = vi.hoisted(() => ({
  queries: [] as string[],
  // When `size` > 0, Better Auth's handler holds each call until `size` calls
  // have entered it, then lets them all go. That forces concurrent requests to
  // overlap between forwardToBetterAuth writing its box and the refuse plugin
  // reading it. Without it, each request gets from writing its box to the
  // plugin reading it without yielding to the event loop, so a box shared
  // across requests would still pass (MEASURED by review).
  //
  // Bounded: if fewer than `size` calls arrive within STALL_MS (a request that
  // failed before reaching Better Auth), it records how many did in
  // `stalledAt` and releases them, so the test fails on that, not a timeout.
  barrier: {
    size: 0,
    held: [] as Array<() => void>,
    stalledAt: undefined as number | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  },
}));

const STALL_MS = 5_000;

function releaseBarrier(): void {
  clearTimeout(barrier.timer);
  barrier.timer = undefined;
  for (const release of barrier.held.splice(0)) release();
}

vi.mock('better-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('better-auth')>();
  type Options = Parameters<typeof actual.betterAuth>[0];
  return {
    ...actual,
    betterAuth: (o: Options) => {
      const built = actual.betterAuth({
        ...o,
        advanced: {
          ...o.advanced,
          database: { ...o.advanced?.database, validateSchema: false },
        },
      });
      const inner = built.handler;
      return Object.assign(built, {
        handler: async (r: Request) => {
          if (barrier.size > 0) {
            await new Promise<void>((go) => {
              barrier.held.push(go);
              if (barrier.held.length >= barrier.size) {
                releaseBarrier();
              } else if (barrier.timer === undefined) {
                barrier.timer = setTimeout(() => {
                  barrier.stalledAt = barrier.held.length;
                  releaseBarrier();
                }, STALL_MS);
              }
            });
          }
          return inner(r);
        },
      });
    },
  };
});

// Import the plugin AFTER vi.mock so its handler is built by the wrapper.
const { createAuthBetterPlugin } = await import('../plugin.js');

// minPasswordLength is 12. Not secrets: nothing here signs anyone in.
const PASSWORD = 'correcthorsebattery';
const NEW_PASSWORD = 'horsebatterystaple';

const BAD_REQUEST_LINE = '[ax/auth-better] bad request on POST /auth/* {"code":"malformed-host"}\n';

/** kysely's inert driver, plus a record of every query it was asked to run. */
class CountingDriver extends DummyDriver {
  override async acquireConnection(): Promise<DatabaseConnection> {
    const inner = await super.acquireConnection();
    return {
      executeQuery: <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
        queries.push(compiled.sql);
        return inner.executeQuery<R>(compiled);
      },
      streamQuery: <R>(compiled: CompiledQuery, chunkSize?: number) =>
        inner.streamQuery<R>(compiled, chunkSize),
    };
  }
}

const ORIGINAL_ALLOW_NO_ORIGINS = process.env.AX_HTTP_ALLOW_NO_ORIGINS;
const ORIGINAL_TRUST_PROXY = process.env.AX_TRUST_PROXY;
let harness: TestHarness | undefined;
let port: number;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  delete process.env.AX_TRUST_PROXY;
  const inertDb = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new CountingDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: randomBytes(32),
    allowedOrigins: [],
  });
  harness = await createTestHarness({
    services: {
      'database:get-instance': async () => ({ db: inertDb }),
      // The plugin declares both in `calls`. The inert database has no
      // provider rows, so neither is ever reached.
      'credentials:envelope-encrypt': async (_ctx, input) => ({
        ciphertext: Buffer.from((input as { plaintext: string }).plaintext, 'utf8'),
      }),
      'credentials:envelope-decrypt': async (_ctx, input) => ({
        plaintext: Buffer.from((input as { ciphertext: Uint8Array }).ciphertext).toString('utf8'),
      }),
    },
    plugins: [http, createAuthBetterPlugin()],
  });
  port = http.boundPort();
});

afterAll(async () => {
  await harness?.close({ onError: () => {} });
  restoreEnv('AX_HTTP_ALLOW_NO_ORIGINS', ORIGINAL_ALLOW_NO_ORIGINS);
  restoreEnv('AX_TRUST_PROXY', ORIGINAL_TRUST_PROXY);
});

/** The status, after reading the body so nothing is left on the connection. */
async function statusOf(response: Promise<Response>): Promise<number> {
  const r = await response;
  await r.arrayBuffer();
  return r.status;
}

describe('@ax/auth-better: a malformed Host is a counted 400 (TASK-1052)', () => {
  it('a malformed Host gets a fixed 400 that the rate limiter counted, and one code-only line per 400', async () => {
    const signIn = (host: string) =>
      requestWithHost(port, {
        method: 'POST',
        path: '/auth/sign-in/email',
        host,
        json: { email: 'nobody@example.com', password: PASSWORD },
      });
    const hosts = ['marker one', 'marker-two.example/x', 'marker3@x', 'marker four', `127.0.0.1:${port}`];
    const { result, output, authLines } = await captureOutput(async () => {
      const answers: Array<{ status: number; body: string }> = [];
      // One at a time: the limiter counts them in order.
      for (const host of hosts) answers.push(await signIn(host));
      return answers;
    });
    // /sign-in* allows 3 per 10s. The three refusals used them up, so the 4th
    // malformed Host and then a well-formed one (same bucket) get Better
    // Auth's own 429.
    expect(result.map((a) => a.status)).toEqual([400, 400, 400, 429, 429]);
    for (const a of result.slice(0, 3)) {
      expect(JSON.parse(a.body)).toEqual({ error: 'malformed-host' });
    }
    // One line per 400 actually served: a 429 writes none (bounded per client per path).
    expect(authLines).toEqual([
      { via: 'stderr', line: BAD_REQUEST_LINE },
      { via: 'stderr', line: BAD_REQUEST_LINE },
      { via: 'stderr', line: BAD_REQUEST_LINE },
    ]);
    expect(output.join('')).not.toContain('marker');
  });

  it('a refused request never reaches the endpoint', async () => {
    const signUp = (host: string) =>
      requestWithHost(port, {
        method: 'POST',
        path: '/auth/sign-up/email',
        host,
        json: { email: 'refused@example.com', password: PASSWORD, name: 'Refused' },
      });
    queries.length = 0;
    const { result: refused, authLines } = await captureOutput(() => signUp('marker five'));
    expect(refused.status).toBe(400);
    // Better Auth's own answer to this sign-up on the inert database is ALSO a
    // 400 (FAILED_TO_CREATE_USER, after it queries), so the body is what proves
    // the refusal.
    expect(JSON.parse(refused.body)).toEqual({ error: 'malformed-host' });
    expect(queries).toEqual([]);
    expect(authLines).toEqual([{ via: 'stderr', line: BAD_REQUEST_LINE }]);

    // Control: the same sign-up on a well-formed Host reaches the endpoint,
    // which queries. Its status is Better Auth's business.
    queries.length = 0;
    await signUp(`127.0.0.1:${port}`);
    expect(queries.length).toBeGreaterThan(0);
  });

  it('a malformed X-Forwarded-Proto is an ordinary request that the rate limiter counts', async () => {
    const changePassword = (headers: Record<string, string>) =>
      statusOf(
        fetch(`http://127.0.0.1:${port}/auth/change-password`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-requested-with': 'ax-admin',
            ...headers,
          },
          // A full body: a partial one is refused (400 VALIDATION_ERROR)
          // before Better Auth ever looks for a session.
          body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push(await changePassword({ 'x-forwarded-proto': 'a b' }));
    statuses.push(await changePassword({}));
    // No session: Better Auth's own 401 each time, never our 500. The limiter
    // counted all three (/change-password allows 3 per 10s), so the 4th is 429.
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  // Pins the `malformedHost` flag. A leaked `refused` flag would only change
  // which GET's method lands in the (identical) log line, so it isn't pinned here.
  it('a malformed-Host flag never leaks into a concurrent request', async () => {
    const getSession = () => statusOf(fetch(`http://127.0.0.1:${port}/auth/get-session`));
    // All four are inside Better Auth's handler, boxes written, before any of
    // them reaches the refuse plugin.
    barrier.size = 4;
    barrier.stalledAt = undefined;
    const { result, authLines } = await captureOutput(() =>
      Promise.all([
        requestWithHost(port, { method: 'GET', path: '/auth/get-session', host: 'marker six' }).then(
          (r) => r.status,
        ),
        getSession(),
        getSession(),
        getSession(),
      ]),
    ).finally(() => {
      barrier.size = 0;
      releaseBarrier();
    });
    // All four reached Better Auth's handler together.
    expect(barrier.stalledAt).toBeUndefined();
    // With no cookie, Better Auth answers `null` with a 200.
    expect(result).toEqual([400, 200, 200, 200]);
    expect(authLines).toEqual([
      {
        via: 'stderr',
        line: '[ax/auth-better] bad request on GET /auth/* {"code":"malformed-host"}\n',
      },
    ]);
  });
});
