import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createUserAttachmentsStore } from '../user-attachments-store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<SkillsDatabase>[] = [];

function makeKysely(): Kysely<SkillsDatabase> {
  const k = new Kysely<SkillsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
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
      await k.schema.dropTable('skills_v1_user_attachments').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('createUserAttachmentsStore', () => {
  it('upsert inserts then updates; listForUserAgent is scoped + ordered', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createUserAttachmentsStore(db);

    const first = await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } });
    expect(first).toEqual({ created: true });
    await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', credentialBindings: {} });

    // Re-upsert the same (user, agent, skill) replaces the bindings; created:false.
    const again = await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref2' } });
    expect(again).toEqual({ created: false });

    const list = await store.listForUserAgent('u1', 'a1');
    expect(list).toEqual([
      { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref2' } },
      { skillId: 'linear', credentialBindings: {} },
    ]);
  });

  it('scopes by (user, agent): user B and agent a2 never bleed into a1/u1', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createUserAttachmentsStore(db);

    await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: {} });
    await store.upsert({ ownerUserId: 'u1', agentId: 'a2', skillId: 'linear', credentialBindings: {} });
    await store.upsert({ ownerUserId: 'u2', agentId: 'a1', skillId: 'slack', credentialBindings: {} });

    const u1a1 = await store.listForUserAgent('u1', 'a1');
    expect(u1a1.map((a) => a.skillId)).toEqual(['github']);

    // Cross-scope reads return nothing for a (user, agent) pair with no rows.
    const u2a2 = await store.listForUserAgent('u2', 'a2');
    expect(u2a2).toEqual([]);
  });

  it('round-trips a multi-key credential bindings JSONB map', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createUserAttachmentsStore(db);

    await store.upsert({
      ownerUserId: 'u1',
      agentId: 'a1',
      skillId: 'multi',
      credentialBindings: { A_TOKEN: 'refA', B_TOKEN: 'refB' },
    });

    const list = await store.listForUserAgent('u1', 'a1');
    expect(list).toEqual([
      { skillId: 'multi', credentialBindings: { A_TOKEN: 'refA', B_TOKEN: 'refB' } },
    ]);
  });
});
