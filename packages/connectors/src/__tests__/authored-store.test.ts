import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runConnectorsMigration,
  type ConnectorDatabase,
} from '../migrations.js';
import { createAuthoredConnectorsStore } from '../authored-store.js';
import type { Capabilities } from '../types.js';

// ---------------------------------------------------------------------------
// Authored-connector draft store (TASK-94) against a real postgres container.
// Covers: upsert lands pending, list, idempotent status-guarded activate,
// clear, and per-(owner, agent) isolation.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<ConnectorDatabase>[] = [];

function makeKysely(): Kysely<ConnectorDatabase> {
  const k = new Kysely<ConnectorDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 4 }),
    }),
  });
  opened.push(k);
  return k;
}

function caps(): Capabilities {
  return {
    allowedHosts: ['api.linear.app'],
    credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('connectors_v1_authored').ifExists().execute();
      await k.schema.dropTable('connectors_v1_connectors').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('runConnectorsMigration — authored table', () => {
  it('is idempotent and creates a queryable authored table', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);
    expect(await store.list('u', 'a')).toEqual([]);
  });

  it('enforces status / key_mode CHECK constraints at the DB level', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    await expect(
      db
        .insertInto('connectors_v1_authored')
        .values({
          owner_user_id: 'u',
          agent_id: 'a',
          connector_id: 'c',
          name: 'n',
          usage_note: '',
          key_mode: 'personal',
          capability_proposal: JSON.stringify(caps()) as unknown as object,
          status: 'nope',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('createAuthoredConnectorsStore', () => {
  it('upsert lands a PENDING draft; list reads it back with the proposal', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    const { created } = await store.upsert({
      ownerUserId: 'u',
      agentId: 'a',
      connectorId: 'linear',
      name: 'Linear',
      usageNote: 'Drive the Linear API',
      keyMode: 'personal',
      proposal: caps(),
    });
    expect(created).toBe(true);

    const drafts = await store.list('u', 'a');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      connectorId: 'linear',
      name: 'Linear',
      usageNote: 'Drive the Linear API',
      keyMode: 'personal',
      status: 'pending',
    });
    expect(drafts[0]!.proposal).toEqual(caps());
  });

  it('listPendingForUser returns only PENDING drafts across the user’s agents, each carrying agentId', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    // Two pending drafts under different agents + one that gets activated.
    await store.upsert({ ownerUserId: 'u', agentId: 'a2', connectorId: 'linear', name: 'Linear', usageNote: '', keyMode: 'personal', proposal: caps() });
    await store.upsert({ ownerUserId: 'u', agentId: 'a1', connectorId: 'gmail', name: 'Gmail', usageNote: '', keyMode: 'personal', proposal: caps() });
    await store.upsert({ ownerUserId: 'u', agentId: 'a1', connectorId: 'slack', name: 'Slack', usageNote: '', keyMode: 'personal', proposal: caps() });
    // A different user's pending draft must NOT leak.
    await store.upsert({ ownerUserId: 'other', agentId: 'a1', connectorId: 'notion', name: 'Notion', usageNote: '', keyMode: 'personal', proposal: caps() });
    // Activate one of u's drafts — it's approved, so it must drop off the pending list.
    await store.activate({ ownerUserId: 'u', agentId: 'a1', connectorId: 'slack' });

    const pending = await store.listPendingForUser('u');
    // Deterministic order: connector_id asc (gmail, linear), each with its agentId.
    expect(pending.map((d) => ({ connectorId: d.connectorId, agentId: d.agentId, status: d.status }))).toEqual([
      { connectorId: 'gmail', agentId: 'a1', status: 'pending' },
      { connectorId: 'linear', agentId: 'a2', status: 'pending' },
    ]);
    expect(pending[0]!.proposal).toEqual(caps());
  });

  it('re-propose REPLACES the row (created:false) and re-opens the gate to pending', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    await store.upsert({
      ownerUserId: 'u',
      agentId: 'a',
      connectorId: 'linear',
      name: 'Linear',
      usageNote: '',
      keyMode: 'personal',
      proposal: caps(),
    });
    // Approve it (pending → active).
    expect(await store.activate({ ownerUserId: 'u', agentId: 'a', connectorId: 'linear' }))
      .toEqual({ activated: true });

    // A re-propose with a new name resets to pending (the gate re-opens).
    const { created } = await store.upsert({
      ownerUserId: 'u',
      agentId: 'a',
      connectorId: 'linear',
      name: 'Linear v2',
      usageNote: '',
      keyMode: 'workspace',
      proposal: caps(),
    });
    expect(created).toBe(false);
    const drafts = await store.list('u', 'a');
    expect(drafts[0]).toMatchObject({ name: 'Linear v2', keyMode: 'workspace', status: 'pending' });
  });

  it('activate is status-guarded + idempotent (only a pending row flips)', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    await store.upsert({
      ownerUserId: 'u',
      agentId: 'a',
      connectorId: 'linear',
      name: 'Linear',
      usageNote: '',
      keyMode: 'personal',
      proposal: caps(),
    });
    // First flip succeeds; second is a no-op (already active).
    expect(await store.activate({ ownerUserId: 'u', agentId: 'a', connectorId: 'linear' }))
      .toEqual({ activated: true });
    expect(await store.activate({ ownerUserId: 'u', agentId: 'a', connectorId: 'linear' }))
      .toEqual({ activated: false });
    expect((await store.list('u', 'a'))[0]!.status).toBe('active');

    // Activating a non-existent draft flips nothing.
    expect(await store.activate({ ownerUserId: 'u', agentId: 'a', connectorId: 'nope' }))
      .toEqual({ activated: false });
  });

  it('clear removes the draft (reject path)', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    await store.upsert({
      ownerUserId: 'u',
      agentId: 'a',
      connectorId: 'linear',
      name: 'Linear',
      usageNote: '',
      keyMode: 'personal',
      proposal: caps(),
    });
    expect(await store.clear({ ownerUserId: 'u', agentId: 'a', connectorId: 'linear' }))
      .toEqual({ cleared: true });
    expect(await store.list('u', 'a')).toEqual([]);
    // Clearing again is a no-op.
    expect(await store.clear({ ownerUserId: 'u', agentId: 'a', connectorId: 'linear' }))
      .toEqual({ cleared: false });
  });

  it('drafts are isolated per (owner, agent)', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    await store.upsert({
      ownerUserId: 'u1',
      agentId: 'a1',
      connectorId: 'linear',
      name: 'U1 Linear',
      usageNote: '',
      keyMode: 'personal',
      proposal: caps(),
    });
    await store.upsert({
      ownerUserId: 'u1',
      agentId: 'a2',
      connectorId: 'linear',
      name: 'U1 A2 Linear',
      usageNote: '',
      keyMode: 'personal',
      proposal: caps(),
    });
    await store.upsert({
      ownerUserId: 'u2',
      agentId: 'a1',
      connectorId: 'linear',
      name: 'U2 Linear',
      usageNote: '',
      keyMode: 'personal',
      proposal: caps(),
    });

    expect((await store.list('u1', 'a1')).map((d) => d.name)).toEqual(['U1 Linear']);
    expect((await store.list('u1', 'a2')).map((d) => d.name)).toEqual(['U1 A2 Linear']);
    expect((await store.list('u2', 'a1')).map((d) => d.name)).toEqual(['U2 Linear']);

    // Activating u1/a1's draft must not touch u1/a2 or u2/a1.
    await store.activate({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'linear' });
    expect((await store.list('u1', 'a2'))[0]!.status).toBe('pending');
    expect((await store.list('u2', 'a1'))[0]!.status).toBe('pending');
  });
});
