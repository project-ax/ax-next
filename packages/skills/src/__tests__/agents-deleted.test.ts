import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import type { Logger } from '@ax/core';
import pg from 'pg';
import { createSkillsPlugin } from '../plugin.js';
import { blobStoreFakeServices } from './_blob-fake.js';

// TASK-718 — `@ax/agents` fires `agents:deleted { agentId, ownerId, ownerType }`
// AFTER the agent row is gone. Every skills table keyed on `agent_id` has no FK
// to the agents table (cross-plugin FKs are banned), so this subscriber is the
// only thing that ever removes them.

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const clients: pg.Client[] = [];

const AGENT_KEYED_TABLES = [
  'skills_v1_user_attachments',
  'skills_v1_quarantine',
  'skills_v1_authored',
  'skills_v1_approved_caps',
] as const;

const ALL_TABLES = [
  'skills_v1_catalog_requests',
  'skills_v1_user_attachments',
  'skills_v1_skill_files',
  'skills_v1_user_skills',
  'skills_v1_skills',
  'skills_v1_quarantine',
  'skills_v1_approved_caps',
  'skills_v1_authored',
];

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
    services: {
      ...blobStoreFakeServices(),
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => ({ user: { id: 'admin', isAdmin: true } }),
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createSkillsPlugin()],
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
    for (const t of ALL_TABLES) await cleanup.query(`DROP TABLE IF EXISTS ${t}`);
    await cleanup.query('DROP FUNCTION IF EXISTS skills_test_boom()');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

/** One row per (owner, skill) in every agent-keyed table for `agentId`. */
async function seedAgent(
  c: pg.Client,
  agentId: string,
  owners: string[],
  skillIds: string[],
): Promise<void> {
  for (const owner of owners) {
    for (const skill of skillIds) {
      await c.query(
        'INSERT INTO skills_v1_user_attachments (owner_user_id, agent_id, skill_id) VALUES ($1,$2,$3)',
        [owner, agentId, skill],
      );
      await c.query(
        `INSERT INTO skills_v1_quarantine (owner_user_id, agent_id, skill_id, reason)
         VALUES ($1,$2,$3,'scan hit')`,
        [owner, agentId, skill],
      );
      await c.query(
        `INSERT INTO skills_v1_authored (owner_user_id, agent_id, skill_id, manifest_yaml)
         VALUES ($1,$2,$3,'name: x')`,
        [owner, agentId, skill],
      );
      await c.query(
        `INSERT INTO skills_v1_approved_caps
           (owner_user_id, agent_id, skill_id, connector_id, cap_kind, cap_value)
         VALUES ($1,$2,$3,'','host','api.example.com'),
                ($1,$2,'',$3,'host','api.example.com')`,
        [owner, agentId, skill],
      );
    }
  }
}

async function countsFor(c: pg.Client, agentId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of AGENT_KEYED_TABLES) {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE agent_id = $1`, [agentId]);
    out[t] = r.rows[0].n as number;
  }
  return out;
}

const EMPTY_COUNTS = {
  skills_v1_user_attachments: 0,
  skills_v1_quarantine: 0,
  skills_v1_authored: 0,
  skills_v1_approved_caps: 0,
};

const deletedPayload = (agentId: string) => ({ agentId, ownerId: 'u1', ownerType: 'user' });

describe('@ax/skills agents:deleted subscriber (TASK-718)', () => {
  it('manifest.subscribes lists agents:deleted', () => {
    expect(createSkillsPlugin().manifest.subscribes).toContain('agents:deleted');
  });

  it('removes every row keyed on the deleted agent from every agent-keyed table', async () => {
    const h = await makeHarness();
    const c = await pgClient();
    // A team agent: rows for several owner users and several skills.
    await seedAgent(c, 'agt_A', ['u1', 'u2', 'u3'], ['linear', 'github']);
    await seedAgent(c, 'agt_B', ['u1', 'u2'], ['linear']);
    // Not agent-keyed: must survive.
    await c.query(
      `INSERT INTO skills_v1_user_skills (owner_user_id, skill_id, description, manifest_yaml, body_md)
       VALUES ('u1','user-skill','d','name: u','body')`,
    );
    await c.query(
      `INSERT INTO skills_v1_skills (skill_id, description, manifest_yaml, body_md)
       VALUES ('global-skill','d','name: g','body')`,
    );
    const bBefore = await countsFor(c, 'agt_B');
    expect((await countsFor(c, 'agt_A')).skills_v1_approved_caps).toBe(12);

    const { logger, calls } = captureLogger();
    await h.bus.fire('agents:deleted', h.ctx({ logger }), deletedPayload('agt_A'));

    expect(await countsFor(c, 'agt_A')).toEqual(EMPTY_COUNTS);
    expect(await countsFor(c, 'agt_B')).toEqual(bBefore);
    expect(
      (await c.query('SELECT count(*)::int AS n FROM skills_v1_user_skills')).rows[0].n,
    ).toBe(1);
    expect((await c.query('SELECT count(*)::int AS n FROM skills_v1_skills')).rows[0].n).toBe(1);

    // The success log carries the row counts so an operator can see the purge.
    expect(calls.error).toEqual([]);
    const info = calls.info.find((l) => l.msg === 'skills_purged_for_deleted_agent');
    expect(info?.bindings).toMatchObject({
      agentId: 'agt_A',
      userAttachments: 6,
      quarantine: 6,
      authored: 6,
      approvedCaps: 12,
    });
  });

  it('a second delete event for the same agent is a no-op that logs no error', async () => {
    const h = await makeHarness();
    const c = await pgClient();
    await seedAgent(c, 'agt_A', ['u1'], ['linear']);
    await seedAgent(c, 'agt_B', ['u1'], ['linear']);
    const bBefore = await countsFor(c, 'agt_B');

    await h.bus.fire('agents:deleted', h.ctx(), deletedPayload('agt_A'));
    expect(await countsFor(c, 'agt_A')).toEqual(EMPTY_COUNTS);

    const { logger, calls } = captureLogger();
    await h.bus.fire('agents:deleted', h.ctx({ logger }), deletedPayload('agt_A'));

    expect(calls.error).toEqual([]);
    expect(calls.warn).toEqual([]);
    expect(await countsFor(c, 'agt_A')).toEqual(EMPTY_COUNTS);
    expect(await countsFor(c, 'agt_B')).toEqual(bBefore);
  });

  it('logs an error and leaves ALL rows in place when the purge fails; the event does not throw', async () => {
    const h = await makeHarness();
    const c = await pgClient();
    await seedAgent(c, 'agt_A', ['u1', 'u2'], ['linear']);
    const before = await countsFor(c, 'agt_A');
    // Make the purge fail partway: the last table's delete raises.
    await c.query(`
      CREATE FUNCTION skills_test_boom() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql
    `);
    await c.query(`
      CREATE TRIGGER skills_test_boom BEFORE DELETE ON skills_v1_authored
      FOR EACH ROW EXECUTE FUNCTION skills_test_boom()
    `);

    const { logger, calls } = captureLogger();
    await expect(
      h.bus.fire('agents:deleted', h.ctx({ logger }), deletedPayload('agt_A')),
    ).resolves.toBeDefined();

    const err = calls.error.find((l) => l.msg === 'skills_purge_for_deleted_agent_failed');
    expect(err).toBeDefined();
    expect(err?.bindings).toMatchObject({ agentId: 'agt_A' });
    expect(String(err?.bindings?.err)).toContain('boom');
    // One transaction: the earlier deletes rolled back with the failed one.
    expect(await countsFor(c, 'agt_A')).toEqual(before);
    expect(calls.info.find((l) => l.msg === 'skills_purged_for_deleted_agent')).toBeUndefined();
  });

  // A payload the plugin cannot trust must never turn into a delete. The seeded
  // rows with agent_id = '' are the bait: a naive `WHERE agent_id = ''` (or a
  // `WHERE agent_id = undefined`-shaped bug) would remove them.
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
      await seedAgent(c, '', ['u1'], ['linear']);
      await seedAgent(c, 'agt_B', ['u1'], ['linear']);
      const emptyBefore = await countsFor(c, '');
      const bBefore = await countsFor(c, 'agt_B');

      const { logger, calls } = captureLogger();
      await h.bus.fire('agents:deleted', h.ctx({ logger }), payload as never);

      expect(await countsFor(c, '')).toEqual(emptyBefore);
      expect(await countsFor(c, 'agt_B')).toEqual(bBefore);
      expect(calls.warn.some((l) => l.msg === 'skills_purge_invalid_agents_deleted_payload')).toBe(
        true,
      );
      expect(calls.error).toEqual([]);
    });
  }
});
