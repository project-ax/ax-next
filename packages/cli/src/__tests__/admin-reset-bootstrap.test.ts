import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runAdminResetBootstrapCommand } from '../commands/admin/reset-bootstrap.js';
import { runAdminCommand } from '../commands/admin.js';

// ---------------------------------------------------------------------------
// Tests for `ax-next admin reset-bootstrap`. The CLI bootstraps a real kernel
// (database-postgres + onboarding) and calls the bootstrap:reset hook, so we
// stand up a postgres testcontainer here. Same pattern as @ax/onboarding's
// existing tests; the CLI is the kernel host, and the only thing distinct
// about it is the CLI-shaped wire surface (argv, env, stdout/stderr, exit
// codes).
//
// The four behavioural branches we cover (per the plan):
//   1. Fresh DB (no row), no flags → succeeds, prints banner, exit 0.
//   2. Pre-completed row, no flags → refuses, exits 1, error mentions
//      "completed".
//   3. Pre-completed row, --force → succeeds, banner printed.
//   4. --help → exits 0 with usage.
// Plus dispatcher routing through `runAdminCommand`.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await container.stop();
});

// Each test gets a fresh schema. The onboarding migration is idempotent
// (CREATE TABLE IF NOT EXISTS) but tests rely on starting state, so we
// drop between tests.
afterEach(async () => {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
  } finally {
    await k.destroy().catch(() => {});
  }
});

interface Captured {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  out: string[];
  err: string[];
}
function captureStreams(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    out,
    err,
  };
}

/**
 * Pre-seed a `completed` row by inserting one directly. We don't go
 * through the wizard — that would require auth-oidc + http-server +
 * agents + credentials all wired up, and the test is about the CLI's
 * branching, not the wizard's transactional shape (which has its own
 * dedicated test in @ax/onboarding).
 */
async function seedCompletedRow(): Promise<void> {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS bootstrap_state (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed')),
        token_hash TEXT NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(k);
    await sql`
      INSERT INTO bootstrap_state (id, status, token_hash, completed_at)
      VALUES (1, 'completed', 'pre-seeded-hash', NOW())
    `.execute(k);
  } finally {
    await k.destroy().catch(() => {});
  }
}

describe('admin reset-bootstrap — argument parsing', () => {
  it('--help prints usage and exits 0', async () => {
    const cap = captureStreams();
    const code = await runAdminResetBootstrapCommand({
      argv: ['--help'],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(0);
    expect(cap.out.some((l) => l.includes('reset-bootstrap'))).toBe(true);
    expect(cap.out.some((l) => l.includes('--force'))).toBe(true);
  });

  it('rejects unknown flag with exit 2 and usage', async () => {
    const cap = captureStreams();
    const code = await runAdminResetBootstrapCommand({
      argv: ['--bogus'],
      env: { DATABASE_URL: connectionString },
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
    expect(cap.err.some((l) => l.toLowerCase().includes('unknown argument'))).toBe(true);
  });

  it('errors with exit 2 when DATABASE_URL is unset', async () => {
    const cap = captureStreams();
    const code = await runAdminResetBootstrapCommand({
      argv: [],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
    expect(cap.err.some((l) => l.includes('DATABASE_URL'))).toBe(true);
  });
});

describe('admin reset-bootstrap — happy paths', () => {
  it('Branch 1: fresh DB, no flags → succeeds, prints banner with token, exit 0', async () => {
    const cap = captureStreams();
    const code = await runAdminResetBootstrapCommand({
      argv: [],
      env: { AX_PUBLIC_BASE_URL: 'http://localhost:8080' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      databaseOverride: { connectionString },
    });
    expect(code).toBe(0);

    // Banner shape (matches printTokenToStdout).
    expect(cap.out.some((l) => l.includes('First-run bootstrap'))).toBe(true);
    const tokenLine = cap.out.find((l) => l.startsWith('  token: '));
    expect(tokenLine).toBeDefined();
    // Token format: ax_bs_<base64url>
    expect(tokenLine).toMatch(/  token: ax_bs_[A-Za-z0-9_-]{40,}/);

    const urlLine = cap.out.find((l) => l.includes('/setup?token='));
    expect(urlLine).toBeDefined();
    expect(urlLine).toMatch(/http:\/\/localhost:8080\/setup\?token=ax_bs_/);
  });

  it('Branch 2: pre-completed row, no flags → refuses with exit 1 and "completed" error', async () => {
    await seedCompletedRow();

    const cap = captureStreams();
    const code = await runAdminResetBootstrapCommand({
      argv: [],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
      databaseOverride: { connectionString },
    });
    expect(code).toBe(1);
    const errAll = cap.err.join('\n');
    expect(errAll.toLowerCase()).toContain('completed');
    expect(errAll).toContain('--force');
    // Banner must NOT have been printed — we refused the operation.
    expect(cap.out.some((l) => l.includes('First-run bootstrap'))).toBe(false);

    // Verify the row was NOT modified.
    const k = new Kysely<{
      bootstrap_state: {
        id: number;
        status: string;
        token_hash: string;
        completed_at: Date | null;
      };
    }>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const row = await k
        .selectFrom('bootstrap_state')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirst();
      expect(row?.status).toBe('completed');
      expect(row?.token_hash).toBe('pre-seeded-hash');
    } finally {
      await k.destroy().catch(() => {});
    }
  });

  it('Branch 3: pre-completed row, --force → succeeds, banner printed, row reset', async () => {
    await seedCompletedRow();

    const cap = captureStreams();
    const code = await runAdminResetBootstrapCommand({
      argv: ['--force'],
      env: { AX_PUBLIC_BASE_URL: 'http://example.test:9999' },
      stdout: cap.stdout,
      stderr: cap.stderr,
      databaseOverride: { connectionString },
    });
    expect(code).toBe(0);
    expect(cap.out.some((l) => l.includes('First-run bootstrap'))).toBe(true);
    // baseUrl should reflect the env override.
    expect(cap.out.some((l) => l.includes('http://example.test:9999/setup?token='))).toBe(true);

    // Verify the row was reset to pending with a fresh hash.
    const k = new Kysely<{
      bootstrap_state: {
        id: number;
        status: string;
        token_hash: string;
        completed_at: Date | null;
      };
    }>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const row = await k
        .selectFrom('bootstrap_state')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirst();
      expect(row?.status).toBe('pending');
      expect(row?.token_hash).not.toBe('pre-seeded-hash');
      expect(row?.completed_at).toBeNull();
    } finally {
      await k.destroy().catch(() => {});
    }
  });

  it('on a pending DB, no flags → succeeds (recovery path for "I lost the token")', async () => {
    // Seed via the CLI itself so the row format matches production.
    const seedCap = captureStreams();
    let code = await runAdminResetBootstrapCommand({
      argv: [],
      env: {},
      stdout: seedCap.stdout,
      stderr: seedCap.stderr,
      databaseOverride: { connectionString },
    });
    expect(code).toBe(0);
    const firstTokenLine = seedCap.out.find((l) => l.startsWith('  token: '));
    expect(firstTokenLine).toBeDefined();

    // Now reset again — without --force. This is the legitimate recovery
    // path: row is pending, operator lost the printed token, wants a new one.
    const cap = captureStreams();
    code = await runAdminResetBootstrapCommand({
      argv: [],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
      databaseOverride: { connectionString },
    });
    expect(code).toBe(0);
    const secondTokenLine = cap.out.find((l) => l.startsWith('  token: '));
    expect(secondTokenLine).toBeDefined();
    expect(secondTokenLine).not.toBe(firstTokenLine);
  });
});

describe('admin command dispatcher → reset-bootstrap', () => {
  it('Branch 4 (dispatcher): runAdminCommand routes `reset-bootstrap` to the new command', async () => {
    const cap = captureStreams();
    const code = await runAdminCommand({
      argv: ['reset-bootstrap'],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
      databaseOverride: { connectionString },
    });
    expect(code).toBe(0);
    expect(cap.out.some((l) => l.includes('First-run bootstrap'))).toBe(true);
  });

  it('routes `reset-bootstrap --help` to the help branch (exit 0, usage on stdout)', async () => {
    const cap = captureStreams();
    const code = await runAdminCommand({
      argv: ['reset-bootstrap', '--help'],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(0);
    expect(cap.out.some((l) => l.includes('reset-bootstrap'))).toBe(true);
  });

  it('top-level admin USAGE mentions reset-bootstrap', async () => {
    const cap = captureStreams();
    const code = await runAdminCommand({
      argv: [],
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(2);
    expect(cap.err.some((l) => l.includes('reset-bootstrap'))).toBe(true);
  });
});
