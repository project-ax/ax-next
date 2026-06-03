import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { randomBytes } from 'node:crypto';
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

const ORIGINAL_CREDENTIALS_KEY = process.env.AX_CREDENTIALS_KEY;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
  // The reset-bootstrap CLI now loads @ax/credentials so its
  // bootstrap:reset-cleanup subscriber chain runs end-to-end. The
  // credentials plugin refuses to boot without AX_CREDENTIALS_KEY —
  // mirror what the host pod injects via the helm secret.
  process.env.AX_CREDENTIALS_KEY = randomBytes(32).toString('hex');
}, 60_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
  if (ORIGINAL_CREDENTIALS_KEY === undefined) {
    delete process.env.AX_CREDENTIALS_KEY;
  } else {
    process.env.AX_CREDENTIALS_KEY = ORIGINAL_CREDENTIALS_KEY;
  }
});

// Each test gets a fresh schema. Migrations are idempotent (CREATE TABLE
// IF NOT EXISTS) but tests rely on starting state, so we drop between
// tests. We also drop the auth/agent/storage tables that the new full
// plugin set creates so the cleanup-cascade assertions stay deterministic.
afterEach(async () => {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1 }),
    }),
  });
  try {
    // FK order: auth_better_v1_{accounts,sessions} reference users; drop them (and verifications) before users.
    await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_better_v1_verifications`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_better_v1_accounts`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_better_v1_sessions`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_better_v1_users`.execute(k);
    await sql`DROP TABLE IF EXISTS auth_providers`.execute(k);
    await sql`DROP TABLE IF EXISTS agents_v1_agents`.execute(k);
    await sql`DROP TABLE IF EXISTS storage_postgres_v1_kv`.execute(k);
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
 * through the wizard — that would require auth-better + http-server +
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

  it('cleanup-cascade wipes admin/agent/credential rows on --force reset', async () => {
    // Regression for the fan-out-fired-on-empty-bus bug: a previous CLI
    // build only loaded @ax/database-postgres + @ax/onboarding, so when
    // bootstrap:reset fired bootstrap:reset-cleanup the auth/agent/
    // credentials subscribers weren't on the bus and never wiped their
    // tables. The next wizard run would then hit
    // "admin already exists; bootstrap refused".
    //
    // Pre-seed the three table sets the cascade is supposed to wipe,
    // run reset-bootstrap --force, and assert all three are empty.

    // Run a no-op reset first to provision schemas (auth-better's
    // migration creates auth_better_v1_users, agents'  creates
    // agents_v1_agents, storage-postgres' creates storage_postgres_v1_kv).
    const seedCap = captureStreams();
    const seedCode = await runAdminResetBootstrapCommand({
      argv: [],
      env: {},
      stdout: seedCap.stdout,
      stderr: seedCap.stderr,
      databaseOverride: { connectionString },
    });
    // If schema provisioning fails, every assertion below fires a
    // confusing "relation does not exist" — assert exit 0 here so the
    // failure points at the seed step instead.
    expect(seedCode).toBe(0);

    // Now seed test rows.
    const k = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      await sql`
        INSERT INTO auth_better_v1_users (id, email, name, role, created_at, updated_at)
        VALUES ('usr_test', 'test@local', 'Test', 'admin', NOW(), NOW())
      `.execute(k);
      await sql`
        INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at, created_at, updated_at)
        VALUES ('sess_test', 'usr_test', 'tok_test', NOW() + INTERVAL '1 hour', NOW(), NOW())
      `.execute(k);
      await sql`
        INSERT INTO agents_v1_agents (
          agent_id, owner_type, owner_id, visibility, display_name, model,
          allowed_tools, mcp_config_ids, created_at, updated_at
        )
        VALUES (
          'agt_test', 'user', 'usr_test', 'personal', 'Test Agent',
          'claude-sonnet-4-6', '[]', '[]', NOW(), NOW()
        )
      `.execute(k);
      await sql`
        INSERT INTO storage_postgres_v1_kv (key, value, updated_at)
        VALUES ('credential:v2:user:usr_test:anthropic-api', 'cipher'::bytea, NOW())
      `.execute(k);
      // Note: we deliberately don't seed an auth_providers row here as a
      // "survivor" guard. auth-better's loadProviders runs at boot and
      // AES-GCM-decrypts every row's client_secret_encrypted; a fake
      // ciphertext fails decrypt and aborts kernel init before the
      // reset hook can fire. A proper survivor test would need to seed
      // a row through the real envelope, which means a one-shot kernel
      // boot just for the encryption — separate scope. For now the
      // cleanup contract is asserted by what gets wiped, not what
      // survives.
    } finally {
      await k.destroy().catch(() => {});
    }

    // Force-reset.
    const cap = captureStreams();
    const code = await runAdminResetBootstrapCommand({
      argv: ['--force'],
      env: {},
      stdout: cap.stdout,
      stderr: cap.stderr,
      databaseOverride: { connectionString },
    });
    expect(code).toBe(0);

    // Verify every seeded row is gone.
    const k2 = new Kysely<{
      auth_better_v1_users: { id: string };
      auth_better_v1_sessions: { id: string };
      agents_v1_agents: { agent_id: string };
      storage_postgres_v1_kv: { key: string };
    }>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: 1 }),
      }),
    });
    try {
      const users = await k2.selectFrom('auth_better_v1_users').selectAll().execute();
      const sessions = await k2.selectFrom('auth_better_v1_sessions').selectAll().execute();
      const agents = await k2.selectFrom('agents_v1_agents').selectAll().execute();
      const credentialKeys = await sql<{ key: string }>`
        SELECT key FROM storage_postgres_v1_kv WHERE key LIKE 'credential:%'
      `.execute(k2);
      expect(users).toEqual([]);
      expect(sessions).toEqual([]);
      expect(agents).toEqual([]);
      expect(credentialKeys.rows).toEqual([]);
    } finally {
      await k2.destroy().catch(() => {});
    }
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
