import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createApprovedCapsStore } from '../approved-caps-store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<SkillsDatabase>[] = [];

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
      await k.schema.dropTable('skills_v1_approved_caps').ifExists().execute();
    } catch {
      /* */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

// The store no longer has a write path (skills:approved-caps-set is gone — rows
// are legacy data that still display and revoke). Tests seed those legacy rows
// directly.
function withSeed(db: Kysely<SkillsDatabase>) {
  const store = createApprovedCapsStore(db);
  async function set(input: {
    ownerUserId: string;
    agentId: string;
    skillId?: string;
    connectorId?: string;
    kind: 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
    value: string;
    detail?: unknown;
  }): Promise<void> {
    await db
      .insertInto('skills_v1_approved_caps')
      .values({
        owner_user_id: input.ownerUserId,
        agent_id: input.agentId,
        skill_id: input.skillId ?? '',
        connector_id: input.connectorId ?? '',
        cap_kind: input.kind,
        cap_value: input.value,
        cap_detail: input.detail === undefined ? null : input.detail,
        created_at: new Date(),
      } as never)
      .execute();
  }
  return { ...store, set };
}

async function freshStore() {
  const db = makeKysely();
  await runSkillsMigration(db);
  return withSeed(db);
}

describe('skills approved-caps store', () => {
  const key = { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' };

  it('list returns [] for a skill with no approvals', async () => {
    const s = await freshStore();
    expect(await s.list(key)).toEqual([]);
  });

  it('a seeded row is listed', async () => {
    const s = await freshStore();
    await s.set({ ...key, kind: 'host', value: 'api.linear.app' });
    expect(await s.list(key)).toEqual([{ kind: 'host', value: 'api.linear.app' }]);
  });

  it('list returns multiple kinds for one skill, sorted by (kind, value)', async () => {
    const s = await freshStore();
    await s.set({ ...key, kind: 'slot', value: 'LINEAR_API_KEY', detail: { kind: 'api-key', account: 'linear' } });
    await s.set({ ...key, kind: 'host', value: 'api.linear.app' });
    await s.set({ ...key, kind: 'npm', value: '@linear/sdk' });
    expect(await s.list(key)).toEqual([
      { kind: 'host', value: 'api.linear.app' },
      { kind: 'npm', value: '@linear/sdk' },
      { kind: 'slot', value: 'LINEAR_API_KEY' },
    ]);
  });

  it('clear removes one entry (idempotent)', async () => {
    const s = await freshStore();
    await s.set({ ...key, kind: 'host', value: 'api.linear.app' });
    expect(await s.clear({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ cleared: true });
    expect(await s.clear({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ cleared: false });
    expect(await s.list(key)).toEqual([]);
  });

  it('is scoped: user/agent/skill never bleed', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'uA', agentId: 'a1', skillId: 'linear', kind: 'host', value: 'h' });
    expect(await s.list({ ownerUserId: 'uB', agentId: 'a1', skillId: 'linear' })).toEqual([]);
    expect(await s.list({ ownerUserId: 'uA', agentId: 'a2', skillId: 'linear' })).toEqual([]);
    expect(await s.list({ ownerUserId: 'uA', agentId: 'a1', skillId: 'other' })).toEqual([]);
  });
});

// TASK-93 — the SAME wall, attributed to a connector ref instead of a skill ref.
describe('skills approved-caps store — connector subjects', () => {
  const ckey = { ownerUserId: 'u1', agentId: 'a1', connectorId: 'salesforce' };

  it('list returns [] for a connector with no approvals', async () => {
    const s = await freshStore();
    expect(await s.list(ckey)).toEqual([]);
  });

  it('connector seed→list→revoke round-trips', async () => {
    const s = await freshStore();
    await s.set({ ...ckey, kind: 'host', value: 'api.salesforce.com' });
    expect(await s.list(ckey)).toEqual([{ kind: 'host', value: 'api.salesforce.com' }]);
    expect(await s.clear({ ...ckey, kind: 'host', value: 'api.salesforce.com' })).toEqual({
      cleared: true,
    });
    expect(await s.clear({ ...ckey, kind: 'host', value: 'api.salesforce.com' })).toEqual({
      cleared: false,
    });
    expect(await s.list(ckey)).toEqual([]);
  });

  it('connector list returns multiple kinds sorted by (kind, value)', async () => {
    const s = await freshStore();
    await s.set({ ...ckey, kind: 'slot', value: 'SFDC_API_KEY', detail: { kind: 'api-key' } });
    await s.set({ ...ckey, kind: 'host', value: 'api.salesforce.com' });
    await s.set({ ...ckey, kind: 'pypi', value: 'simple-salesforce' });
    expect(await s.list(ckey)).toEqual([
      { kind: 'host', value: 'api.salesforce.com' },
      { kind: 'pypi', value: 'simple-salesforce' },
      { kind: 'slot', value: 'SFDC_API_KEY' },
    ]);
  });

  // The empty-string sentinel keeps a skill grant and a connector grant of the
  // SAME id in disjoint keyspaces — they must never bleed into each other.
  it('a skill grant and a connector grant with the same id do not collide', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', kind: 'host', value: 'skill-host' });
    await s.set({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'linear', kind: 'host', value: 'connector-host' });
    expect(await s.list({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' })).toEqual([
      { kind: 'host', value: 'skill-host' },
    ]);
    expect(await s.list({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'linear' })).toEqual([
      { kind: 'host', value: 'connector-host' },
    ]);
  });

  it('connector rows are per-user isolated (uA never sees uB)', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'uA', agentId: 'a1', connectorId: 'salesforce', kind: 'host', value: 'h' });
    expect(await s.list({ ownerUserId: 'uB', agentId: 'a1', connectorId: 'salesforce' })).toEqual([]);
    expect(await s.list({ ownerUserId: 'uA', agentId: 'a2', connectorId: 'salesforce' })).toEqual([]);
    expect(await s.list({ ownerUserId: 'uA', agentId: 'a1', connectorId: 'other' })).toEqual([]);
  });
});

// TASK-93 — the migration upgrades an old (connector_id-less) table in place and
// is safe to run twice.
describe('skills approved-caps migration idempotency', () => {
  it('runs twice without error and the connector keyspace works', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    await runSkillsMigration(db); // re-run must be a no-op, not a constraint error
    const s = withSeed(db);
    await s.set({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'c1', kind: 'npm', value: 'pkg' });
    expect(await s.list({ ownerUserId: 'u1', agentId: 'a1', connectorId: 'c1' })).toEqual([
      { kind: 'npm', value: 'pkg' },
    ]);
  });
});
