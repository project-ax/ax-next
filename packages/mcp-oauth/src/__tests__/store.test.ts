import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runMcpOAuthMigration,
  type McpOAuthDatabase,
} from '../migrations.js';
import { createMcpOAuthStore } from '../store.js';
import type { ClientRegistration, PendingAuthorization } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<McpOAuthDatabase>[] = [];

function makeKysely(): Kysely<McpOAuthDatabase> {
  const k = new Kysely<McpOAuthDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 4 }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('mcp_oauth_v1_pending').ifExists().execute();
      await k.schema.dropTable('mcp_oauth_v1_clients').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('runMcpOAuthMigration', () => {
  it('is idempotent — runs twice without error', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    await runMcpOAuthMigration(db);
    // Both tables exist and are queryable.
    expect(
      await db.selectFrom('mcp_oauth_v1_clients').selectAll().execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom('mcp_oauth_v1_pending').selectAll().execute(),
    ).toEqual([]);
  });
});

describe('createMcpOAuthStore', () => {
  function makeClient(overrides?: Partial<ClientRegistration>): ClientRegistration {
    return {
      clientKey: 'my-connector|https://auth.example.com',
      clientId: 'client-abc',
      clientSecret: 's3cr3t',
      dynamic: true,
      ...overrides,
    };
  }

  function makePending(overrides?: Partial<PendingAuthorization>): PendingAuthorization {
    return {
      state: 'state-xyz',
      userId: 'u1',
      agentId: 'a1',
      connectorId: 'my-connector',
      slot: 'default',
      codeVerifier: 'verifier-abc',
      authServerUrl: 'https://auth.example.com',
      clientKey: 'my-connector|https://auth.example.com',
      resource: 'https://api.example.com',
      scope: 'read write',
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it('putClient / getClient round-trips clientId, clientSecret, dynamic', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    const client = makeClient();
    await store.putClient(client);

    const got = await store.getClient(client.clientKey);
    expect(got).not.toBeNull();
    expect(got!.clientKey).toBe(client.clientKey);
    expect(got!.clientId).toBe(client.clientId);
    expect(got!.clientSecret).toBe(client.clientSecret);
    expect(got!.dynamic).toBe(true);
  });

  it('putClient upserts — second put overwrites client fields', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    await store.putClient(makeClient({ clientId: 'old-id' }));
    await store.putClient(makeClient({ clientId: 'new-id', clientSecret: undefined }));

    const got = await store.getClient('my-connector|https://auth.example.com');
    expect(got!.clientId).toBe('new-id');
    expect(got!.clientSecret).toBeUndefined();
  });

  it('getClient returns null for unknown key', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    expect(await store.getClient('no-such-key')).toBeNull();
  });

  it('consumePending is single-use — first call returns the row, second returns null', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    const pending = makePending();
    await store.putPending(pending);

    const now = Date.now();
    const ttlMs = 5 * 60 * 1000; // 5 minutes

    // First call: should return the row
    const first = await store.consumePending(pending.state, now, ttlMs);
    expect(first).not.toBeNull();
    expect(first!.state).toBe(pending.state);
    expect(first!.userId).toBe(pending.userId);
    expect(first!.agentId).toBe(pending.agentId);
    expect(first!.connectorId).toBe(pending.connectorId);
    expect(first!.slot).toBe(pending.slot);
    expect(first!.codeVerifier).toBe(pending.codeVerifier);
    expect(first!.authServerUrl).toBe(pending.authServerUrl);
    expect(first!.clientKey).toBe(pending.clientKey);
    expect(first!.resource).toBe(pending.resource);
    expect(first!.scope).toBe(pending.scope);

    // Second call: row is gone, returns null
    const second = await store.consumePending(pending.state, now, ttlMs);
    expect(second).toBeNull();
  });

  it('consumePending returns null for an expired row (now - createdAt > ttlMs)', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    const ttlMs = 5 * 60 * 1000; // 5 minutes
    // Insert with an old createdAt — 10 minutes in the past
    const oldCreatedAt = Date.now() - 10 * 60 * 1000;
    const pending = makePending({ state: 'state-expired' });
    await store.putPending(pending, oldCreatedAt);

    const now = Date.now();
    const result = await store.consumePending(pending.state, now, ttlMs);
    // now - oldCreatedAt ≈ 10min > ttlMs (5min) → expired → null
    expect(result).toBeNull();
  });

  it('consumePending returns null for unknown state', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    expect(await store.consumePending('no-such-state', Date.now(), 60_000)).toBeNull();
  });

  it('getPending returns the row WITHOUT consuming it — a later consumePending still returns it', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    const pending = makePending({ state: 'state-peek' });
    await store.putPending(pending);

    // Peek twice — both succeed, row is NOT deleted.
    const first = await store.getPending(pending.state);
    expect(first).not.toBeNull();
    expect(first!.state).toBe(pending.state);
    expect(first!.userId).toBe(pending.userId);
    expect(first!.codeVerifier).toBe(pending.codeVerifier);
    const second = await store.getPending(pending.state);
    expect(second).not.toBeNull();

    // The atomic single-use consume still finds and burns it.
    const consumed = await store.consumePending(pending.state, Date.now(), 60_000);
    expect(consumed).not.toBeNull();
    expect(consumed!.state).toBe(pending.state);

    // Now both peek and consume return null (row gone).
    expect(await store.getPending(pending.state)).toBeNull();
    expect(await store.consumePending(pending.state, Date.now(), 60_000)).toBeNull();
  });

  it('getPending returns null for unknown state', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    expect(await store.getPending('no-such-state')).toBeNull();
  });

  it('round-trips credScope through put/get/consume', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    await store.putPending({
      state: 'st-cs', userId: 'u', agentId: '', connectorId: 'c', slot: 'S',
      codeVerifier: 'v', authServerUrl: 'https://auth', clientKey: 'c|a',
      resource: 'https://mcp', scope: 'read', credScope: 'user', createdAt: 1000,
    }, 1000);
    expect((await store.getPending('st-cs'))?.credScope).toBe('user');
    expect((await store.consumePending('st-cs', 2000, 600000))?.credScope).toBe('user');
  });
});
