import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { Logger } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import pg from 'pg';
import { createConnectorsPlugin } from '../plugin.js';
import type { InstallAuthoredInput, InstallAuthoredOutput } from '../types.js';

// TASK-718 — `@ax/agents` fires `agents:deleted { agentId, ownerId, ownerType }`
// AFTER the agent row is gone. `connectors_v1_authored` is keyed
// `(owner_user_id, agent_id, connector_id)` with no FK to the agents table
// (cross-plugin FKs are banned), so this subscriber is the only thing that ever
// removes a deleted agent's authored connector drafts.

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const clients: pg.Client[] = [];

interface LogCall {
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function captureLogger() {
  const calls: Record<'info' | 'warn' | 'error', LogCall[]> = { info: [], warn: [], error: [] };
  const rec =
    (level: 'info' | 'warn' | 'error') =>
    (msg: string, bindings?: Record<string, unknown>): void => {
      calls[level].push({ msg, bindings });
    };
  const logger: Logger = {
    debug() {},
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child() {
      return logger;
    },
  };
  return { logger, calls };
}

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), createConnectorsPlugin()],
  });
  harnesses.push(h);
  return h;
}

async function pgClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  clients.push(c);
  return c;
}

/** Drafts written through the real `connectors:install-authored` write path. */
async function seedDrafts(
  h: TestHarness,
  agentId: string,
  owners: string[],
  connectorIds: string[],
): Promise<void> {
  for (const ownerUserId of owners) {
    for (const connectorId of connectorIds) {
      await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
        'connectors:install-authored',
        h.ctx({ userId: ownerUserId }),
        {
          ownerUserId,
          agentId,
          connectorId,
          name: connectorId,
          hosts: ['api.example.com'],
          slots: [{ slot: 'API_KEY', kind: 'api-key' }],
          usageNote: '',
          keyMode: 'personal',
        },
      );
    }
  }
}

async function draftCount(c: pg.Client, agentId: string): Promise<number> {
  const r = await c.query(
    'SELECT count(*)::int AS n FROM connectors_v1_authored WHERE agent_id = $1',
    [agentId],
  );
  return r.rows[0].n as number;
}

async function liveCount(c: pg.Client): Promise<number> {
  const r = await c.query('SELECT count(*)::int AS n FROM connectors_v1_connectors');
  return r.rows[0].n as number;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.end().catch(() => {});
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_authored');
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
    await cleanup.query('DROP FUNCTION IF EXISTS connectors_test_boom()');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const deletedPayload = (agentId: string) => ({ agentId, ownerId: 'u1', ownerType: 'user' });

describe('@ax/connectors agents:deleted subscriber (TASK-718)', () => {
  it('manifest.subscribes lists agents:deleted', () => {
    expect(createConnectorsPlugin().manifest.subscribes).toContain('agents:deleted');
  });

  it("removes every authored draft keyed on the deleted agent and leaves other agents' drafts and the live registry", async () => {
    const h = await makeHarness();
    const c = await pgClient();
    // A team agent: drafts for several owner users, several connectors.
    await seedDrafts(h, 'agt_A', ['u1', 'u2', 'u3'], ['linear', 'notion']);
    await seedDrafts(h, 'agt_B', ['u1', 'u2'], ['linear']);
    // connectors_v1_connectors has no agent column: the user's own registry.
    await c.query(
      `INSERT INTO connectors_v1_connectors
         (owner_user_id, connector_id, name, key_mode, capabilities)
       VALUES ('u1','linear','Linear','personal',
               '{"allowedHosts":[],"credentials":[],"mcpServers":[],"packages":{"npm":[],"pypi":[]},"services":[]}'::jsonb)`,
    );
    expect(await draftCount(c, 'agt_A')).toBe(6);

    const { logger, calls } = captureLogger();
    await h.bus.fire('agents:deleted', h.ctx({ logger }), deletedPayload('agt_A'));

    expect(await draftCount(c, 'agt_A')).toBe(0);
    expect(await draftCount(c, 'agt_B')).toBe(2);
    expect(await liveCount(c)).toBe(1);

    // The success log carries the row count so an operator can see the purge.
    expect(calls.error).toEqual([]);
    const info = calls.info.find((l) => l.msg === 'connectors_purged_for_deleted_agent');
    expect(info?.bindings).toMatchObject({ agentId: 'agt_A', removed: 6 });
  });

  it('a second delete event for the same agent is a no-op that logs no error', async () => {
    const h = await makeHarness();
    const c = await pgClient();
    await seedDrafts(h, 'agt_A', ['u1'], ['linear']);
    await seedDrafts(h, 'agt_B', ['u1'], ['linear']);

    await h.bus.fire('agents:deleted', h.ctx(), deletedPayload('agt_A'));
    expect(await draftCount(c, 'agt_A')).toBe(0);

    const { logger, calls } = captureLogger();
    await h.bus.fire('agents:deleted', h.ctx({ logger }), deletedPayload('agt_A'));

    expect(calls.error).toEqual([]);
    expect(calls.warn).toEqual([]);
    expect(await draftCount(c, 'agt_A')).toBe(0);
    expect(await draftCount(c, 'agt_B')).toBe(1);
  });

  it('logs an error and keeps the drafts when the purge fails; the event does not throw', async () => {
    const h = await makeHarness();
    const c = await pgClient();
    await seedDrafts(h, 'agt_A', ['u1', 'u2'], ['linear']);
    await c.query(`
      CREATE FUNCTION connectors_test_boom() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql
    `);
    await c.query(`
      CREATE TRIGGER connectors_test_boom BEFORE DELETE ON connectors_v1_authored
      FOR EACH ROW EXECUTE FUNCTION connectors_test_boom()
    `);

    const { logger, calls } = captureLogger();
    await expect(
      h.bus.fire('agents:deleted', h.ctx({ logger }), deletedPayload('agt_A')),
    ).resolves.toBeDefined();

    const err = calls.error.find((l) => l.msg === 'connectors_purge_for_deleted_agent_failed');
    expect(err).toBeDefined();
    expect(err?.bindings).toMatchObject({ agentId: 'agt_A' });
    expect(String(err?.bindings?.err)).toContain('boom');
    expect(await draftCount(c, 'agt_A')).toBe(2);
    expect(calls.info.find((l) => l.msg === 'connectors_purged_for_deleted_agent')).toBeUndefined();
  });

  // A payload the plugin cannot trust must never turn into a delete. The seeded
  // draft with agent_id = '' is the bait: a naive `WHERE agent_id = ''` would
  // remove it.
  const MALFORMED: Array<[string, unknown]> = [
    ['null payload', null],
    ['missing agentId', { ownerId: 'u1', ownerType: 'user' }],
    ['empty agentId', { agentId: '', ownerId: 'u1', ownerType: 'user' }],
    ['non-string agentId', { agentId: 42, ownerId: 'u1', ownerType: 'user' }],
  ];
  for (const [label, payload] of MALFORMED) {
    it(`deletes nothing and warns for a malformed payload (${label})`, async () => {
      const h = await makeHarness();
      const c = await pgClient();
      // The install hook rejects an empty agentId, so the bait row goes in raw.
      await c.query(
        `INSERT INTO connectors_v1_authored
           (owner_user_id, agent_id, connector_id, name, key_mode, capability_proposal, status)
         VALUES ('u1','','linear','Linear','personal','{}'::jsonb,'pending')`,
      );
      await seedDrafts(h, 'agt_B', ['u1'], ['linear']);

      const { logger, calls } = captureLogger();
      await h.bus.fire('agents:deleted', h.ctx({ logger }), payload as never);

      expect(await draftCount(c, '')).toBe(1);
      expect(await draftCount(c, 'agt_B')).toBe(1);
      expect(
        calls.warn.some((l) => l.msg === 'connectors_purge_invalid_agents_deleted_payload'),
      ).toBe(true);
      expect(calls.error).toEqual([]);
    });
  }
});
