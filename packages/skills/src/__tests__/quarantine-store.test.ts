import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createSkillsQuarantineStore } from '../quarantine-store.js';

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
      await k.schema.dropTable('skills_v1_quarantine').ifExists().execute();
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
  return createSkillsQuarantineStore(db);
}

describe('skills quarantine store', () => {
  it('get returns not-quarantined for an unknown skill', async () => {
    const s = await freshStore();
    expect(await s.get({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' })).toEqual({
      quarantined: false,
    });
  });

  it('set then get returns the reason; set overwrites the reason', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', reason: 'first' });
    expect(await s.get({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' })).toEqual({
      quarantined: true,
      reason: 'first',
    });
    await s.set({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', reason: 'second' });
    expect(await s.get({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' })).toEqual({
      quarantined: true,
      reason: 'second',
    });
  });

  it('clear removes the flag (idempotent)', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', reason: 'x' });
    expect(await s.clear({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' })).toEqual({
      cleared: true,
    });
    expect(await s.get({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' })).toEqual({
      quarantined: false,
    });
    expect(await s.clear({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' })).toEqual({
      cleared: false,
    });
  });

  it('is scoped: user A / agent a1 never see user B / agent a2', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'uA', agentId: 'a1', skillId: 'linear', reason: 'A' });
    expect(await s.get({ ownerUserId: 'uB', agentId: 'a1', skillId: 'linear' })).toEqual({
      quarantined: false,
    });
    expect(await s.get({ ownerUserId: 'uA', agentId: 'a2', skillId: 'linear' })).toEqual({
      quarantined: false,
    });
  });

  it('list returns all quarantined skills for a (user, agent), sorted by skill_id', async () => {
    const s = await freshStore();
    await s.set({ ownerUserId: 'u1', agentId: 'a1', skillId: 'zeta', reason: 'z' });
    await s.set({ ownerUserId: 'u1', agentId: 'a1', skillId: 'alpha', reason: 'a' });
    await s.set({ ownerUserId: 'u1', agentId: 'a2', skillId: 'other', reason: 'o' });
    const items = await s.list({ ownerUserId: 'u1', agentId: 'a1' });
    expect(items.map((i) => i.skillId)).toEqual(['alpha', 'zeta']);
    expect(items[0]).toMatchObject({ skillId: 'alpha', reason: 'a' });
    expect(typeof items[0]!.lastFlaggedAt).toBe('string');
    expect(items[0]!.lastFlaggedAt.length).toBeGreaterThan(0);
  });
});
