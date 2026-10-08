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
  runConnectorsMigration,
  type ConnectorDatabase,
} from '../migrations.js';
import { createAuthoredConnectorsStore } from '../authored-store.js';
import type { Capabilities } from '../types.js';

// ---------------------------------------------------------------------------
// Authored-connector draft store (TASK-94) against a real postgres container.
// Covers: upsert lands pending, the all-owners pending read + clear-by-id, and
// per-(owner, agent) isolation. Slice 2c removed the per-agent `list` and the
// `activate` flip with the in-chat card; `active` rows still exist from before,
// so `markActive` writes one the way the old flip did.
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
    // TASK-150 — the store's CapabilitiesSchema defaults services to [] on
    // parse; set it here so the read-back round-trip assertions stay exact.
    services: [],
  };
}

/** The drafts stored for one (owner, agent), any status, read straight from
 *  the table in connector_id order. */
async function rowsOf(db: Kysely<ConnectorDatabase>, owner: string, agent: string) {
  const rows = await db
    .selectFrom('connectors_v1_authored')
    .selectAll()
    .where('owner_user_id', '=', owner)
    .where('agent_id', '=', agent)
    .orderBy('connector_id', 'asc')
    .execute();
  return rows.map((r) => ({
    connectorId: r.connector_id,
    name: r.name,
    usageNote: r.usage_note,
    keyMode: r.key_mode,
    status: r.status,
    proposal: r.capability_proposal as unknown as Capabilities,
  }));
}

/** A legacy `active` row, as the removed in-chat approval left it. */
async function markActive(
  db: Kysely<ConnectorDatabase>,
  owner: string,
  agent: string,
  connectorId: string,
): Promise<void> {
  await db
    .updateTable('connectors_v1_authored')
    .set({ status: 'active' })
    .where('owner_user_id', '=', owner)
    .where('agent_id', '=', agent)
    .where('connector_id', '=', connectorId)
    .execute();
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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
    expect(await store.listPendingAll(() => {})).toEqual([]);
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
  it('upsert lands a PENDING draft with the proposal', async () => {
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

    const drafts = await rowsOf(db, 'u', 'a');
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

  it('listPendingAll returns every owner’s PENDING drafts (system read), each carrying owner + agent', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    await store.upsert({ ownerUserId: 'u', agentId: 'a2', connectorId: 'linear', name: 'Linear', usageNote: '', keyMode: 'personal', proposal: caps() });
    await store.upsert({ ownerUserId: 'other', agentId: 'a1', connectorId: 'linear', name: 'Linear too', usageNote: '', keyMode: 'workspace', proposal: caps() });
    await store.upsert({ ownerUserId: 'u', agentId: 'a1', connectorId: 'gmail', name: 'Gmail', usageNote: '', keyMode: 'personal', proposal: caps() });
    await store.upsert({ ownerUserId: 'u', agentId: 'a1', connectorId: 'slack', name: 'Slack', usageNote: '', keyMode: 'personal', proposal: caps() });
    // An ACTIVE draft is not pending: it must not appear.
    await markActive(db, 'u', 'a1', 'slack');

    const pending = await store.listPendingAll(() => {});
    // Deterministic order: connector_id, then owner, then agent.
    expect(pending.map((d) => ({ connectorId: d.connectorId, ownerUserId: d.ownerUserId, agentId: d.agentId }))).toEqual([
      { connectorId: 'gmail', ownerUserId: 'u', agentId: 'a1' },
      { connectorId: 'linear', ownerUserId: 'other', agentId: 'a1' },
      { connectorId: 'linear', ownerUserId: 'u', agentId: 'a2' },
    ]);
    expect(pending.every((d) => d.status === 'pending')).toBe(true);
    expect(pending[0]!.proposal).toEqual(caps());
  });

  it('listPendingAll skips a draft with a malformed proposal, reports it, and still returns the good ones', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);
    await store.upsert({ ownerUserId: 'u', agentId: 'a1', connectorId: 'linear', name: 'Linear', usageNote: '', keyMode: 'personal', proposal: caps() });
    // One user's corrupt row (hand-edited / older shape) must not empty the
    // queue for every admin.
    await sql`
      INSERT INTO connectors_v1_authored
        (owner_user_id, agent_id, connector_id, name, usage_note, key_mode, capability_proposal, status)
      VALUES ('bad-owner', 'a9', 'broken', 'Broken', '', 'personal', '{"allowedHosts": 5}'::jsonb, 'pending')
    `.execute(db);

    const skipped: Array<{ ownerUserId: string; connectorId: string; err: unknown }> = [];
    const pending = await store.listPendingAll((draft, err) => skipped.push({ ...draft, err }));

    expect(pending.map((d) => d.connectorId)).toEqual(['linear']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ ownerUserId: 'bad-owner', connectorId: 'broken' });
    expect(String((skipped[0]!.err as Error).message)).toMatch(/malformed capability_proposal/);
  });

  it('clearAllById removes every draft with that id across owners and agents, any status', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);

    await store.upsert({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'linear', name: 'L', usageNote: '', keyMode: 'personal', proposal: caps() });
    await store.upsert({ ownerUserId: 'u2', agentId: 'a9', connectorId: 'linear', name: 'L', usageNote: '', keyMode: 'personal', proposal: caps() });
    await store.upsert({ ownerUserId: 'u1', agentId: 'a2', connectorId: 'linear', name: 'L', usageNote: '', keyMode: 'personal', proposal: caps() });
    await markActive(db, 'u1', 'a2', 'linear');
    // A different id stays.
    await store.upsert({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'gmail', name: 'G', usageNote: '', keyMode: 'personal', proposal: caps() });

    expect(await store.clearAllById('linear')).toEqual({ cleared: 3 });
    expect(await rowsOf(db, 'u1', 'a1')).toHaveLength(1);
    expect(await rowsOf(db, 'u1', 'a2')).toEqual([]);
    expect(await rowsOf(db, 'u2', 'a9')).toEqual([]);
    // Again: nothing left to clear.
    expect(await store.clearAllById('linear')).toEqual({ cleared: 0 });
  });

  it('clearAllById refuses an empty id before any statement runs', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);
    await store.upsert({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'linear', name: 'L', usageNote: '', keyMode: 'personal', proposal: caps() });
    await expect(store.clearAllById('')).rejects.toThrow(/connectorId/);
    expect(await rowsOf(db, 'u1', 'a1')).toHaveLength(1);
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
    // A legacy approved row (pending → active, before slice 2c).
    await markActive(db, 'u', 'a', 'linear');

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
    const drafts = await rowsOf(db, 'u', 'a');
    expect(drafts[0]).toMatchObject({ name: 'Linear v2', keyMode: 'workspace', status: 'pending' });
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

    expect((await rowsOf(db, 'u1', 'a1')).map((d) => d.name)).toEqual(['U1 Linear']);
    expect((await rowsOf(db, 'u1', 'a2')).map((d) => d.name)).toEqual(['U1 A2 Linear']);
    expect((await rowsOf(db, 'u2', 'a1')).map((d) => d.name)).toEqual(['U2 Linear']);

    // Re-proposing u1/a1's draft must not touch u1/a2 or u2/a1.
    await store.upsert({
      ownerUserId: 'u1',
      agentId: 'a1',
      connectorId: 'linear',
      name: 'U1 Linear v2',
      usageNote: '',
      keyMode: 'personal',
      proposal: caps(),
    });
    expect((await rowsOf(db, 'u1', 'a2')).map((d) => d.name)).toEqual(['U1 A2 Linear']);
    expect((await rowsOf(db, 'u2', 'a1')).map((d) => d.name)).toEqual(['U2 Linear']);
  });
});

// TASK-718 — deleting an agent removes every authored draft keyed on it. The
// table has no FK to the agents table (cross-plugin FKs are banned), so the
// `agents:deleted` subscriber is the only thing that ever clears it.
describe('AuthoredConnectorsStore.deleteAllForAgent (TASK-718)', () => {
  async function seed(
    store: ReturnType<typeof createAuthoredConnectorsStore>,
    agentId: string,
    owners: string[],
    connectorIds: string[],
  ): Promise<void> {
    for (const ownerUserId of owners) {
      for (const connectorId of connectorIds) {
        await store.upsert({
          ownerUserId,
          agentId,
          connectorId,
          name: `${ownerUserId}/${connectorId}`,
          usageNote: '',
          keyMode: 'personal',
          proposal: caps(),
        });
      }
    }
  }

  async function count(db: Kysely<ConnectorDatabase>, agentId: string): Promise<number> {
    const res = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM connectors_v1_authored WHERE agent_id = ${agentId}
    `.execute(db);
    return res.rows[0]!.n;
  }

  it('deletes every draft keyed on the agent, across owners, connectors and statuses', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);
    // A team agent: drafts for several owner users, several connectors.
    await seed(store, 'agt_A', ['u1', 'u2', 'u3'], ['linear', 'notion']);
    // One draft already approved: an `active` row is still the agent's row.
    await markActive(db, 'u2', 'agt_A', 'notion');
    expect(await count(db, 'agt_A')).toBe(6);

    const removed = await store.deleteAllForAgent('agt_A');

    expect(removed).toEqual({ removed: 6 });
    expect(await count(db, 'agt_A')).toBe(0);
  });

  it("leaves other agents' drafts (including an id sharing a prefix) and the live registry untouched", async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);
    await seed(store, 'agt_A', ['u1', 'u2'], ['linear']);
    await seed(store, 'agt_B', ['u1', 'u2'], ['linear', 'notion']);
    await seed(store, 'agt_A2', ['u1'], ['linear']);
    // connectors_v1_connectors has NO agent column: it is the user's own
    // registry, not the agent's data, so the purge must not reach it.
    await sql`
      INSERT INTO connectors_v1_connectors
        (owner_user_id, connector_id, name, key_mode, capabilities)
      VALUES ('u1', 'linear', 'Linear', 'personal', ${JSON.stringify(caps())}::jsonb)
    `.execute(db);

    await store.deleteAllForAgent('agt_A');

    expect(await count(db, 'agt_A')).toBe(0);
    expect(await count(db, 'agt_B')).toBe(4);
    expect(await count(db, 'agt_A2')).toBe(1);
    const live = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM connectors_v1_connectors
    `.execute(db);
    expect(live.rows[0]!.n).toBe(1);
  });

  it('is idempotent: an agent with no drafts removes nothing and does not throw', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);
    await seed(store, 'agt_B', ['u1'], ['linear']);

    expect(await store.deleteAllForAgent('agt_never_had_rows')).toEqual({ removed: 0 });
    expect(await count(db, 'agt_B')).toBe(1);
  });

  it('refuses an empty agent id and deletes nothing (an empty key must never run a delete)', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createAuthoredConnectorsStore(db);
    // A row whose agent_id IS the empty string is the bait: a naive
    // `WHERE agent_id = ''` would remove it.
    await seed(store, '', ['u1'], ['linear']);
    await seed(store, 'agt_B', ['u1'], ['linear']);

    await expect(store.deleteAllForAgent('')).rejects.toThrow(/agentId/);

    expect(await count(db, '')).toBe(1);
    expect(await count(db, 'agt_B')).toBe(1);
  });
});
