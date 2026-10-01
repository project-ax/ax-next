import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
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
import type { PendingAuthorization } from '../types.js';

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
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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

  it('adds nullable client_id / client_secret to a pending table created before TASK-696, keeping its rows', async () => {
    const db = makeKysely();
    // The pre-TASK-696 shape: no client_id / client_secret columns.
    await sql`
      CREATE TABLE mcp_oauth_v1_pending (
        state           TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        connector_id    TEXT NOT NULL,
        slot            TEXT NOT NULL,
        code_verifier   TEXT NOT NULL,
        auth_server_url TEXT NOT NULL,
        client_key      TEXT NOT NULL,
        resource        TEXT NOT NULL,
        scope           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`.execute(db);
    await sql`
      INSERT INTO mcp_oauth_v1_pending
        (state, user_id, agent_id, connector_id, slot, code_verifier, auth_server_url, client_key, resource)
      VALUES ('st-old', 'u', 'a', 'c', 's', 'v', 'https://auth', 'c|https://auth', 'https://mcp')`.execute(db);

    await runMcpOAuthMigration(db);
    await runMcpOAuthMigration(db); // idempotent on the upgraded shape too

    const row = await db
      .selectFrom('mcp_oauth_v1_pending')
      .selectAll()
      .where('state', '=', 'st-old')
      .executeTakeFirstOrThrow();
    expect(row.client_id).toBeNull();
    expect(row.client_secret).toBeNull();
    expect(row.issuer_required).toBe(false);
  });
});

describe('createMcpOAuthStore', () => {
  it('persists issuer identification support through both peek and consume', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);
    const pending = makePending({ issuerRequired: true });
    await store.putPending(pending);
    expect(await store.getPending(pending.state)).toMatchObject({ issuerRequired: true });
    expect(await store.consumePending(pending.state, Date.now(), 60_000)).toMatchObject({ issuerRequired: true });
  });

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
      credScope: 'agent',
      createdAt: Date.now(),
      ...overrides,
    };
  }

  // `mcp_oauth_v1_clients` is a READ-ONLY legacy fallback now: nothing writes it
  // (the store has no putClient), but a token blob / pending row from before
  // TASK-696 still resolves its client through it. A row inserted straight into
  // the table stands in for one written by the old code.
  it('getClient still reads a legacy row (inserted directly), mapping a NULL secret to undefined', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    await db
      .insertInto('mcp_oauth_v1_clients')
      .values([
        { client_key: 'k-conf|https://auth.example.com', client_id: 'client-abc', client_secret: 's3cr3t', dynamic: true, created_at: new Date() },
        { client_key: 'k-pub|https://auth.example.com', client_id: 'client-pub', client_secret: null, dynamic: false, created_at: new Date() },
      ])
      .execute();

    const conf = await store.getClient('k-conf|https://auth.example.com');
    expect(conf).toEqual({
      clientKey: 'k-conf|https://auth.example.com',
      clientId: 'client-abc',
      clientSecret: 's3cr3t',
      dynamic: true,
    });
    const pub = await store.getClient('k-pub|https://auth.example.com');
    expect(pub!.clientId).toBe('client-pub');
    expect(pub!.clientSecret).toBeUndefined();
    expect(pub!.dynamic).toBe(false);
  });

  it('the store no longer exposes putClient (nothing may overwrite the shared client row)', () => {
    const store = createMcpOAuthStore(makeKysely());
    expect('putClient' in store).toBe(false);
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
    // credScope round-trips (default-case 'agent' from makePending).
    expect(first!.credScope).toBe(pending.credScope);
    expect(first!.credScope).toBe('agent');

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
    // credScope survives a peek (default-case 'agent' from makePending).
    expect(first!.credScope).toBe('agent');
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

  // --- TASK-696: the pending row carries the client the authorization started with ---

  it('round-trips the pending row\'s own client (clientId + clientSecret) through put/get/consume', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    await store.putPending(makePending({ state: 'st-client', clientId: 'dcr-cid', clientSecret: 'dcr-secret' }));

    const peeked = await store.getPending('st-client');
    expect(peeked?.clientId).toBe('dcr-cid');
    expect(peeked?.clientSecret).toBe('dcr-secret');
    const consumed = await store.consumePending('st-client', Date.now(), 60_000);
    expect(consumed?.clientId).toBe('dcr-cid');
    expect(consumed?.clientSecret).toBe('dcr-secret');
  });

  it('a public client round-trips clientId with NO clientSecret key', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    await store.putPending(makePending({ state: 'st-pub', clientId: 'public-cid' }));

    const got = await store.getPending('st-pub');
    expect(got?.clientId).toBe('public-cid');
    expect('clientSecret' in got!).toBe(false);
    const raw = await db
      .selectFrom('mcp_oauth_v1_pending')
      .select(['client_id', 'client_secret'])
      .where('state', '=', 'st-pub')
      .executeTakeFirstOrThrow();
    expect(raw).toEqual({ client_id: 'public-cid', client_secret: null });
  });

  it('a row with NULL client_id (written before TASK-696) comes back WITHOUT clientId/clientSecret keys', async () => {
    const db = makeKysely();
    await runMcpOAuthMigration(db);
    const store = createMcpOAuthStore(db);

    // No clientId on the domain object -> NULL columns.
    await store.putPending(makePending({ state: 'st-legacy' }));

    for (const got of [
      await store.getPending('st-legacy'),
      await store.consumePending('st-legacy', Date.now(), 60_000),
    ]) {
      expect(got).not.toBeNull();
      expect('clientId' in got!).toBe(false);
      expect('clientSecret' in got!).toBe(false);
    }
  });

  describe('purgeExpiredPending', () => {
    const NOW = 1_700_000_000_000;
    const TTL = 10 * 60_000;

    it('deletes only rows created before the cutoff', async () => {
      const db = makeKysely();
      await runMcpOAuthMigration(db);
      const store = createMcpOAuthStore(db);

      await store.putPending(makePending({ state: 'st-old', clientId: 'old-cid', clientSecret: 'old-secret' }), NOW - TTL - 1);
      await store.putPending(makePending({ state: 'st-older' }), NOW - 5 * TTL);
      await store.putPending(makePending({ state: 'st-edge' }), NOW - TTL); // exactly at the cutoff: kept
      await store.putPending(makePending({ state: 'st-fresh' }), NOW - 1_000);

      await store.purgeExpiredPending(NOW - TTL);

      expect(await store.getPending('st-old')).toBeNull();
      expect(await store.getPending('st-older')).toBeNull();
      expect(await store.getPending('st-edge')).not.toBeNull();
      expect(await store.getPending('st-fresh')).not.toBeNull();
      const left = await db.selectFrom('mcp_oauth_v1_pending').select('state').orderBy('state').execute();
      expect(left.map((r) => r.state)).toEqual(['st-edge', 'st-fresh']);
    });

    it('is a no-op on an empty table and never touches the legacy clients table', async () => {
      const db = makeKysely();
      await runMcpOAuthMigration(db);
      const store = createMcpOAuthStore(db);
      await db
        .insertInto('mcp_oauth_v1_clients')
        .values({ client_key: 'k|a', client_id: 'cid', client_secret: null, dynamic: true, created_at: new Date(0) })
        .execute();

      await expect(store.purgeExpiredPending(NOW)).resolves.toBeUndefined();

      expect(await store.getClient('k|a')).not.toBeNull();
    });
  });

  // TASK-718 — deleting an agent must drop its in-flight OAuth handshakes. The
  // pending row carries the PKCE verifier and, for a confidential client, its
  // secret in plaintext, so leaving it behind for a deleted agent is worse than
  // clutter. Keyed on `agent_id` ALONE (a team agent's connect can be started
  // by several people). `mcp_oauth_v1_clients` has no `agent_id` column at all
  // (it is keyed by `${connectorId}|${authServerUrl}` and shared by every
  // agent), so it is deliberately out of reach of this method.
  describe('deleteAllForAgent (TASK-718)', () => {
    it('deletes every pending handshake for the agent — any user, any cred scope — and nothing else', async () => {
      const db = makeKysely();
      await runMcpOAuthMigration(db);
      const store = createMcpOAuthStore(db);
      await store.putPending(makePending({ state: 'g1', agentId: 'agt_gone', userId: 'u1' }));
      await store.putPending(
        makePending({
          state: 'g2',
          agentId: 'agt_gone',
          userId: 'u2',
          credScope: 'user',
          clientId: 'cid',
          clientSecret: 'plaintext-secret',
        }),
      );
      await store.putPending(makePending({ state: 'g3', agentId: 'agt_gone', userId: 'u3' }), Date.now() - 60 * 60_000);
      await store.putPending(makePending({ state: 'k1', agentId: 'agt_kept', userId: 'u1' }));
      await store.putPending(makePending({ state: 'k2', agentId: 'agt_kept', userId: 'u2', credScope: 'user' }));
      // The legacy shared client row: not agent-keyed, so it must survive.
      await db
        .insertInto('mcp_oauth_v1_clients')
        .values({ client_key: 'k|a', client_id: 'cid', client_secret: null, dynamic: true, created_at: new Date(0) })
        .execute();

      expect(await store.deleteAllForAgent('agt_gone')).toEqual({ deleted: 3 });

      for (const s of ['g1', 'g2', 'g3']) expect(await store.getPending(s)).toBeNull();
      for (const s of ['k1', 'k2']) expect(await store.getPending(s)).not.toBeNull();
      expect(await store.getClient('k|a')).not.toBeNull();
    });

    it('is a no-op the second time', async () => {
      const db = makeKysely();
      await runMcpOAuthMigration(db);
      const store = createMcpOAuthStore(db);
      await store.putPending(makePending({ state: 'g1', agentId: 'agt_gone' }));
      await store.putPending(makePending({ state: 'k1', agentId: 'agt_kept' }));
      await store.deleteAllForAgent('agt_gone');

      expect(await store.deleteAllForAgent('agt_gone')).toEqual({ deleted: 0 });
      expect(await store.getPending('k1')).not.toBeNull();
    });

    it('refuses an empty agentId — never runs a delete with an empty key', async () => {
      const db = makeKysely();
      await runMcpOAuthMigration(db);
      const store = createMcpOAuthStore(db);
      await store.putPending(makePending({ state: 'k1', agentId: 'agt_kept' }));

      for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
        await expect(store.deleteAllForAgent(bad)).rejects.toThrow(/agentId is required/);
      }
      expect(await store.getPending('k1')).not.toBeNull();
    });
  });
});
