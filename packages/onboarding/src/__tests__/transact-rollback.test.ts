import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createAgentsPlugin } from '@ax/agents';
import { createOnboardingPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

async function dropTables(): Promise<void> {
  const k = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
  });
  try {
    await sql`DROP TABLE IF EXISTS bootstrap_state`.execute(k);
    await sql`DROP TABLE IF EXISTS storage_postgres_v1_kv`.execute(k);
    await sql`DROP TABLE IF EXISTS agents_v1_agents`.execute(k);
  } finally {
    await k.destroy().catch(() => {});
  }
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  await dropTables();
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

async function bootStack(): Promise<TestHarness> {
  process.env.AX_CREDENTIALS_KEY = '0'.repeat(64); // 32 bytes hex for test
  const h = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => {
        throw new Error('auth:require-user not expected in this test');
      },
      'auth:create-bootstrap-user': async () => ({ userId: 'admin-id' }),
      'auth:complete-bootstrap-user': async () => ({}),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createAgentsPlugin(),
      createOnboardingPlugin({
        baseUrl: 'http://localhost:8080',
        envOverride: { AX_BOOTSTRAP_TOKEN: 'test-token' },
        stdoutWriter: () => {},
        tokenFileWriter: async () => {},
      }),
    ],
  });
  harnesses.push(h);
  return h;
}

describe('@ax/onboarding — db:transact cross-plugin rollback (I9)', () => {
  it('credentials:set + agents:create + bootstrap:complete rolls back atomically on throw', async () => {
    const h = await bootStack();

    const initialCreds = await h.bus.call<
      { scope: string },
      { credentials: unknown[] }
    >('credentials:list', h.ctx(), { scope: 'global' });

    const initialAgents = await h.bus.call<
      { userId: string; teamIds: string[] },
      { agents: unknown[] }
    >('agents:list-for-user', h.ctx(), { userId: 'admin-id', teamIds: [] });

    await expect(
      h.bus.call('db:transact', h.ctx(), {
        run: async ({ tx }: { tx: unknown }) => {
          await h.bus.call('credentials:set', h.ctx(), {
            scope: 'global',
            ownerId: null,
            ref: 'tx-test',
            kind: 'api-key',
            payload: new TextEncoder().encode('sk-tx-test'),
            tx,
          });
          await h.bus.call('agents:create', h.ctx(), {
            actor: { userId: 'admin-id', isAdmin: true },
            input: {
              displayName: 'Tx Test Agent',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'claude-sonnet-4-6',
              visibility: 'personal',
            },
            tx,
          });
          await h.bus.call('bootstrap:complete', h.ctx(), { tx });
          throw new Error('rollback please');
        },
      }),
    ).rejects.toThrow(/rollback please/);

    const finalCreds = await h.bus.call<
      { scope: string },
      { credentials: unknown[] }
    >('credentials:list', h.ctx(), { scope: 'global' });
    expect(finalCreds.credentials.length).toBe(initialCreds.credentials.length);

    const finalAgents = await h.bus.call<
      { userId: string; teamIds: string[] },
      { agents: unknown[] }
    >('agents:list-for-user', h.ctx(), { userId: 'admin-id', teamIds: [] });
    expect(finalAgents.agents.length).toBe(initialAgents.agents.length);

    const status = await h.bus.call<unknown, { status: string }>(
      'bootstrap:status',
      h.ctx(),
      {},
    );
    expect(status.status).not.toBe('completed');
  });
});
