import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
  if (container) await container.stop();
});

async function freshStore() {
  const db = makeKysely();
  await runSkillsMigration(db);
  return createApprovedCapsStore(db);
}

describe('skills approved-caps store', () => {
  const key = { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' };

  it('list returns [] for a skill with no approvals', async () => {
    const s = await freshStore();
    expect(await s.list(key)).toEqual([]);
  });

  it('set then list returns the entry; set is idempotent', async () => {
    const s = await freshStore();
    expect(await s.set({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ created: true });
    expect(await s.set({ ...key, kind: 'host', value: 'api.linear.app' })).toEqual({ created: false });
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
