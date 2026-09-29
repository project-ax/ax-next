import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createAgentPurgeStore } from '../agent-purge-store.js';

// TASK-718 — deleting an agent must take the @ax/skills rows keyed on it with
// it. Every table below carries an `agent_id` column and no FK to the agents
// table (cross-plugin FKs are banned), so nothing else ever removes them.

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<SkillsDatabase>[] = [];

/** Every skills table keyed on `agent_id`. The purge must empty ALL of them. */
const AGENT_KEYED_TABLES = [
  'skills_v1_user_attachments',
  'skills_v1_quarantine',
  'skills_v1_authored',
  'skills_v1_approved_caps',
] as const;

/** Tables with NO agent column — the purge must never touch them. */
const NOT_AGENT_KEYED_TABLES = ['skills_v1_skills', 'skills_v1_user_skills'] as const;

function makeKysely(): Kysely<SkillsDatabase> {
  const k = new Kysely<SkillsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
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
      for (const t of [...AGENT_KEYED_TABLES, ...NOT_AGENT_KEYED_TABLES]) {
        await sql`DROP TABLE IF EXISTS ${sql.table(t)}`.execute(k);
      }
      await sql`DROP FUNCTION IF EXISTS skills_test_boom()`.execute(k);
    } catch {
      /* */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

async function fresh() {
  const db = makeKysely();
  await runSkillsMigration(db);
  return { db, store: createAgentPurgeStore(db) };
}

/**
 * Seed one row per (owner, skill) in EVERY agent-keyed table for `agentId`.
 * approved_caps gets both a skill-subject and a connector-subject grant.
 */
async function seedAgent(
  db: Kysely<SkillsDatabase>,
  agentId: string,
  owners: string[],
  skillIds: string[],
): Promise<void> {
  for (const owner of owners) {
    for (const skill of skillIds) {
      await sql`
        INSERT INTO skills_v1_user_attachments (owner_user_id, agent_id, skill_id)
        VALUES (${owner}, ${agentId}, ${skill})
      `.execute(db);
      await sql`
        INSERT INTO skills_v1_quarantine (owner_user_id, agent_id, skill_id, reason)
        VALUES (${owner}, ${agentId}, ${skill}, 'scan hit')
      `.execute(db);
      await sql`
        INSERT INTO skills_v1_authored (owner_user_id, agent_id, skill_id, manifest_yaml)
        VALUES (${owner}, ${agentId}, ${skill}, 'name: x')
      `.execute(db);
      await sql`
        INSERT INTO skills_v1_approved_caps
          (owner_user_id, agent_id, skill_id, connector_id, cap_kind, cap_value)
        VALUES
          (${owner}, ${agentId}, ${skill}, '', 'host', 'api.example.com'),
          (${owner}, ${agentId}, '', ${skill}, 'host', 'api.example.com')
      `.execute(db);
    }
  }
}

async function seedUnrelated(db: Kysely<SkillsDatabase>): Promise<void> {
  await sql`
    INSERT INTO skills_v1_skills (skill_id, description, manifest_yaml, body_md)
    VALUES ('global-skill', 'd', 'name: g', 'body')
  `.execute(db);
  await sql`
    INSERT INTO skills_v1_user_skills (owner_user_id, skill_id, description, manifest_yaml, body_md)
    VALUES ('u1', 'user-skill', 'd', 'name: u', 'body')
  `.execute(db);
}

async function count(
  db: Kysely<SkillsDatabase>,
  table: string,
  agentId?: string,
): Promise<number> {
  const res =
    agentId === undefined
      ? await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(db)
      : await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE agent_id = ${agentId}
        `.execute(db);
  return res.rows[0]!.n;
}

async function countsFor(db: Kysely<SkillsDatabase>, agentId: string) {
  const out: Record<string, number> = {};
  for (const t of AGENT_KEYED_TABLES) out[t] = await count(db, t, agentId);
  return out;
}

describe('skills agent-purge store (TASK-718)', () => {
  it('deletes every row keyed on the agent, across owners and skills, in all four tables', async () => {
    const { db, store } = await fresh();
    // A team agent: several owner users, several skill ids.
    await seedAgent(db, 'agt_A', ['u1', 'u2', 'u3'], ['linear', 'github']);

    const before = await countsFor(db, 'agt_A');
    // 3 owners x 2 skills; approved_caps carries a skill AND a connector grant.
    expect(before).toEqual({
      skills_v1_user_attachments: 6,
      skills_v1_quarantine: 6,
      skills_v1_authored: 6,
      skills_v1_approved_caps: 12,
    });

    const removed = await store.deleteAllForAgent('agt_A');

    expect(await countsFor(db, 'agt_A')).toEqual({
      skills_v1_user_attachments: 0,
      skills_v1_quarantine: 0,
      skills_v1_authored: 0,
      skills_v1_approved_caps: 0,
    });
    expect(removed).toEqual({
      userAttachments: 6,
      quarantine: 6,
      authored: 6,
      approvedCaps: 12,
    });
  });

  it("leaves other agents' rows and the non-agent tables untouched", async () => {
    const { db, store } = await fresh();
    await seedAgent(db, 'agt_A', ['u1', 'u2'], ['linear']);
    await seedAgent(db, 'agt_B', ['u1', 'u2'], ['linear', 'github']);
    // An id that merely STARTS with A's must not be swept up by a prefix match.
    await seedAgent(db, 'agt_A2', ['u1'], ['linear']);
    await seedUnrelated(db);

    const bBefore = await countsFor(db, 'agt_B');
    const a2Before = await countsFor(db, 'agt_A2');

    await store.deleteAllForAgent('agt_A');

    expect(await countsFor(db, 'agt_A')).toEqual({
      skills_v1_user_attachments: 0,
      skills_v1_quarantine: 0,
      skills_v1_authored: 0,
      skills_v1_approved_caps: 0,
    });
    expect(await countsFor(db, 'agt_B')).toEqual(bBefore);
    expect(await countsFor(db, 'agt_A2')).toEqual(a2Before);
    for (const t of NOT_AGENT_KEYED_TABLES) {
      expect(await count(db, t)).toBe(1);
    }
  });

  it('is idempotent: purging an agent with no rows removes nothing and does not throw', async () => {
    const { db, store } = await fresh();
    await seedAgent(db, 'agt_B', ['u1'], ['linear']);
    const bBefore = await countsFor(db, 'agt_B');

    const removed = await store.deleteAllForAgent('agt_never_had_rows');

    expect(removed).toEqual({ userAttachments: 0, quarantine: 0, authored: 0, approvedCaps: 0 });
    expect(await countsFor(db, 'agt_B')).toEqual(bBefore);
  });

  it('refuses an empty agent id and deletes nothing (an empty key must never run a delete)', async () => {
    const { db, store } = await fresh();
    // A row whose agent_id IS the empty string: a naive `WHERE agent_id = ''`
    // would remove it. The guard must throw before any statement runs.
    await seedAgent(db, '', ['u1'], ['linear']);
    await seedAgent(db, 'agt_B', ['u1'], ['linear']);
    const emptyBefore = await countsFor(db, '');
    const bBefore = await countsFor(db, 'agt_B');

    await expect(store.deleteAllForAgent('')).rejects.toThrow(/agentId/);

    expect(await countsFor(db, '')).toEqual(emptyBefore);
    expect(await countsFor(db, 'agt_B')).toEqual(bBefore);
  });

  // ONE transaction: a failure in ANY of the four deletes must roll back the
  // others, so a retry starts from the same state instead of stranding a
  // half-purged agent. Order-independent: make each table in turn the one that
  // blows up and check that ALL four still hold their rows.
  for (const boomTable of AGENT_KEYED_TABLES) {
    it(`rolls every delete back when the delete on ${boomTable} fails`, async () => {
      const { db, store } = await fresh();
      await seedAgent(db, 'agt_A', ['u1', 'u2'], ['linear']);
      const before = await countsFor(db, 'agt_A');

      await sql`
        CREATE FUNCTION skills_test_boom() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql
      `.execute(db);
      await sql`
        CREATE TRIGGER skills_test_boom BEFORE DELETE ON ${sql.table(boomTable)}
        FOR EACH ROW EXECUTE FUNCTION skills_test_boom()
      `.execute(db);

      await expect(store.deleteAllForAgent('agt_A')).rejects.toThrow(/boom/);

      expect(await countsFor(db, 'agt_A')).toEqual(before);
    });
  }
});
