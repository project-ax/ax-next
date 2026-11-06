import { randomBytes } from 'node:crypto';
import { format } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';

// ---------------------------------------------------------------------------
// TASK-1047: when /auth/* fails before Better Auth can answer, the stderr line
// names the method, the route as registered (`/auth/*`) and the failure's
// codes. Never the request path, the query or the error's message.
//
// The path can carry a capability: Better Auth mounts
// `GET /reset-password/:token`. The message is no safer. Better Auth's errors
// can echo request fields, and Node's `new Request` TypeError quotes the whole
// URL.
//
// No Docker, on purpose. Better Auth is mocked to throw, so a request never
// touches the database. Init only needs the migration and the provider load to
// succeed, and kysely's DummyDriver answers every query with no rows. The real
// @ax/http-server and a real fetch complete the stack. This is its own file
// because the `better-auth` module mock would break the files that use the
// real one (handler-ready.test.ts says the same).
// ---------------------------------------------------------------------------

// A Better Auth reset token is generateId(24): 24 letters and digits.
const { TOKEN } = vi.hoisted(() => ({ TOKEN: 'Rk7Qm2Xv9Lp4Tn8Wb3Yc6Hd1' }));

vi.mock('better-auth', () => ({
  betterAuth: () => ({
    handler: async () => {
      // A message can quote the request; this one carries the token.
      throw Object.assign(new Error(`PRIVATE-MESSAGE reset-password:${TOKEN}`), {
        code: '57P01',
      });
    },
    $context: Promise.resolve({}),
  }),
}));

// Import the plugin AFTER vi.mock so its handler is built by the mock.
const { createAuthBetterPlugin } = await import('../plugin.js');

const ORIGINAL_ALLOW_NO_ORIGINS = process.env.AX_HTTP_ALLOW_NO_ORIGINS;
let harness: TestHarness | undefined;
let baseUrl: string;

beforeAll(async () => {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const inertDb = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
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
  baseUrl = `http://127.0.0.1:${http.boundPort()}`;
});

afterAll(async () => {
  await harness?.close({ onError: () => {} });
  if (ORIGINAL_ALLOW_NO_ORIGINS === undefined) {
    delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  } else {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = ORIGINAL_ALLOW_NO_ORIGINS;
  }
});

interface Captured {
  /** Every write, from every channel, one entry per write. */
  output: string[];
  /** The auth-better lines, each tagged with the channel it went to. */
  authLines: Array<{ via: 'stderr' | 'stdout' | 'console'; line: string }>;
}

/**
 * Everything written while `run` is in flight: stderr, stdout (the core
 * logger's channel) and the console. vitest gives its workers a console of its
 * own that never calls process.stdout/stderr.write, so a `console.error(err)`
 * would slip past the two stream spies unless the console is captured too.
 */
async function captureOutput<T>(run: () => Promise<T>): Promise<{ result: T } & Captured> {
  const output: string[] = [];
  const authLines: Captured['authLines'] = [];
  const push = (via: 'stderr' | 'stdout' | 'console', text: string): void => {
    output.push(text);
    if (text.startsWith('[ax/auth-better]')) authLines.push({ via, line: text });
  };
  const recordTo = (via: 'stderr' | 'stdout') =>
    ((chunk: unknown) => {
      push(via, String(chunk));
      return true;
    }) as typeof process.stderr.write;
  const spies = [
    vi.spyOn(process.stderr, 'write').mockImplementation(recordTo('stderr')),
    vi.spyOn(process.stdout, 'write').mockImplementation(recordTo('stdout')),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        push('console', format(...args));
      }),
    ),
  ];
  try {
    return { result: await run(), output, authLines };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** The shape of a real reset link: the token in the path, a callback in the query. */
function resetLink(): string {
  return `${baseUrl}/auth/reset-password/${TOKEN}?callbackURL=%2F`;
}

/** One whole exchange, body included, so the capture window covers all of it. */
async function fetchResetLink(init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(resetLink(), init);
  return { status: res.status, body: await res.json() };
}

describe('@ax/auth-better: the /auth/* handler-error line (TASK-1047)', () => {
  it('a Better Auth throw logs the route and its codes, never the path, the token or the message', async () => {
    const { result, output, authLines } = await captureOutput(() => fetchResetLink());
    expect(result).toEqual({ status: 500, body: { error: 'auth-handler-failed' } });
    expect(authLines).toEqual([
      {
        via: 'stderr',
        line: '[ax/auth-better] handler error on GET /auth/* {"code":"57P01","name":"Error"}\n',
      },
    ]);
    expect(output.join('')).not.toContain(TOKEN);
    expect(output.join('')).not.toContain('PRIVATE-MESSAGE');
  });

  it('a malformed X-Forwarded-Proto (our Request build throws, the URL in its message) logs the same line', async () => {
    const { result, output, authLines } = await captureOutput(() =>
      fetchResetLink({ headers: { 'x-forwarded-proto': 'a b' } }),
    );
    expect(result).toEqual({ status: 500, body: { error: 'auth-handler-failed' } });
    expect(authLines).toHaveLength(1);
    const { via, line } = authLines[0]!;
    expect(via).toBe('stderr');
    const prefix = '[ax/auth-better] handler error on GET /auth/* ';
    expect(line.startsWith(prefix), `line: ${line}`).toBe(true);
    // Node's own TypeError. Its cause codes are a Node detail, so only the name is pinned.
    expect(JSON.parse(line.slice(prefix.length))).toMatchObject({ name: 'TypeError' });
    expect(output.join('')).not.toContain(TOKEN);
  });
});
