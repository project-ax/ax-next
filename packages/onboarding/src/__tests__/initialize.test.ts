import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin } from '@ax/http-server';
import { createOnboardingPlugin } from '../plugin.js';
import type { BootstrapStatusOutput } from '../types.js';

const COOKIE_KEY = randomBytes(32);

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const cleanupKyselys: Kysely<unknown>[] = [];

async function bootHarness(opts: {
  env?: Record<string, string | undefined>;
  stdoutFails?: boolean;
  fileFails?: boolean;
  tokenFilePath?: string;
}): Promise<{
  harness: TestHarness;
  stdoutLines: string[];
  fileWrites: Array<{ path: string; token: string }>;
}> {
  const stdoutLines: string[] = [];
  const fileWrites: Array<{ path: string; token: string }> = [];

  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    // Stub the auth/tx/credential/agent hooks that onboarding declares in its
    // `calls`. initialize.test.ts doesn't load storage-postgres, credentials,
    // or agents; those routes are not exercised here, so stubs satisfy
    // verifyCalls without weakening any assertion.
    services: {
      'auth:create-bootstrap-user': async () => ({ user: { id: 'stub', email: null, displayName: null, isAdmin: true }, oneTimeToken: 'stub-token' }),
      'auth:complete-bootstrap-user': async () => ({ sessionCookie: { name: 'ax_auth_session', value: 'stub', opts: { path: '/', sameSite: 'Lax', maxAge: 60 } } }),
      'auth:require-user': async () => { throw new Error('auth:require-user not expected in initialize tests'); },
      'db:transact': async () => { throw new Error('db:transact not expected in initialize tests'); },
      'credentials:set': async () => { throw new Error('credentials:set not expected in initialize tests'); },
      'agents:create': async () => { throw new Error('agents:create not expected in initialize tests'); },
      'storage:set': async () => { throw new Error('storage:set not expected in initialize tests'); },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      http,
      createOnboardingPlugin({
        baseUrl: 'http://localhost:8080',
        tokenFilePath: opts.tokenFilePath ?? '/dev/null/never-used',
        envOverride: opts.env ?? {},
        stdoutWriter: opts.stdoutFails
          ? () => {
              throw new Error('stdout broken');
            }
          : (line) => stdoutLines.push(line),
        tokenFileWriter: opts.fileFails
          ? async () => {
              throw new Error('file broken');
            }
          : async (path, token) => {
              fileWrites.push({ path, token });
            },
      }),
    ],
  });
  harnesses.push(harness);
  return { harness, stdoutLines, fileWrites };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Drop the bootstrap_state table so each test starts clean.
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  cleanupKyselys.push(k);
  await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
});

afterAll(async () => {
  for (const k of cleanupKyselys) await k.destroy().catch(() => {});
  if (container) await container.stop();
});

describe('bootstrap:initialize', () => {
  it('first boot, no env var: generates token, prints to stdout AND writes file, status=pending', async () => {
    const { harness, stdoutLines, fileWrites } = await bootHarness({});
    expect(stdoutLines.join('\n')).toMatch(/ax_bs_[A-Za-z0-9_-]+/);
    expect(fileWrites.length).toBe(1);
    expect(fileWrites[0].token).toMatch(/^ax_bs_/);
    const status = await harness.bus.call<unknown, BootstrapStatusOutput>(
      'bootstrap:status',
      harness.ctx(),
      {},
    );
    expect(status.status).toBe('pending');
  });

  it('first boot with AX_BOOTSTRAP_TOKEN: hashes env var, NO stdout output, status=pending', async () => {
    const { harness, stdoutLines, fileWrites } = await bootHarness({
      env: { AX_BOOTSTRAP_TOKEN: 'my-token-value' },
    });
    expect(stdoutLines).toEqual([]);
    expect(fileWrites).toEqual([]);
    const status = await harness.bus.call<unknown, BootstrapStatusOutput>(
      'bootstrap:status',
      harness.ctx(),
      {},
    );
    expect(status.status).toBe('pending');
  });

  it('subsequent boot after completion: no-op, no token printed', async () => {
    // First boot: get to pending.
    const { harness: h1 } = await bootHarness({});
    // Manually transition to completed via direct UPDATE (simulates the
    // route layer having called complete()). Cleaner than depending on
    // future tasks' route code.
    const k = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    cleanupKyselys.push(k);
    await sql`UPDATE bootstrap_state SET status='completed', completed_at=NOW() WHERE id=1`.execute(k);
    await h1.close({ onError: () => {} });
    harnesses.pop();

    // Second boot.
    const { harness: h2, stdoutLines, fileWrites } = await bootHarness({});
    expect(stdoutLines).toEqual([]);
    expect(fileWrites).toEqual([]);
    const status = await h2.bus.call<unknown, BootstrapStatusOutput>(
      'bootstrap:status',
      h2.ctx(),
      {},
    );
    expect(status.status).toBe('completed');
  });

  it('panics on first boot if BOTH stdout AND tokenfile fail', async () => {
    await expect(
      bootHarness({ stdoutFails: true, fileFails: true }),
    ).rejects.toThrow(/cannot expose bootstrap token/i);
  });
});
