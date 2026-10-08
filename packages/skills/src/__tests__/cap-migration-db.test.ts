import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { AgentContext, HookBus, Logger } from '@ax/core';
import { parseSkillManifest } from '@ax/skills-parser';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { migrateSkillCapabilitiesToConnectors } from '../cap-migration.js';

// Only admins define connectors. The legacy cap migration still strips the
// `capabilities:` block so manifests parse, but it must NOT create a connector.

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<SkillsDatabase>[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    for (const t of ['skills_v1_user_skills', 'skills_v1_skills']) {
      await k.schema.dropTable(t).ifExists().execute().catch(() => {});
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const LEGACY = [
  'name: github',
  'description: GitHub helper.',
  'version: 2',
  'capabilities:',
  '  allowedHosts:',
  '    - api.github.com',
  '  credentials:',
  '    - slot: GITHUB_TOKEN',
  '      kind: api-key',
].join('\n');

interface LogCall {
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function harness() {
  const busCalls: string[] = [];
  const warns: LogCall[] = [];
  const logger = {
    debug() {},
    info() {},
    error() {},
    warn(msg: string, bindings?: Record<string, unknown>) {
      warns.push({ msg, bindings });
    },
    child() {
      return logger;
    },
  } as unknown as Logger;
  // A bus that offers connectors:upsert/get as live services: if the migration
  // still reached for them, busCalls would record it.
  const bus = {
    hasService: () => true,
    call: async (hook: string) => {
      busCalls.push(hook);
      if (hook === 'connectors:get') throw new Error('not-found');
      return {};
    },
  } as unknown as HookBus;
  return { bus, ctx: { logger } as unknown as AgentContext, busCalls, warns };
}

describe('migrateSkillCapabilitiesToConnectors (no connector creation)', () => {
  it('strips the legacy block from global + user rows, creates no connector, logs the dropped reach', async () => {
    const db = new Kysely<SkillsDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
    });
    opened.push(db);
    await runSkillsMigration(db);
    await db
      .insertInto('skills_v1_skills')
      .values({ skill_id: 'github', description: 'd', manifest_yaml: LEGACY, body_md: 'b' } as never)
      .execute();
    await db
      .insertInto('skills_v1_user_skills')
      .values({ owner_user_id: 'u1', skill_id: 'github', description: 'd', manifest_yaml: LEGACY, body_md: 'b' } as never)
      .execute();

    const h = harness();
    await migrateSkillCapabilitiesToConnectors(db, h.ctx);

    // No connector hook is touched.
    expect(h.busCalls).toEqual([]);

    // Manifests parse now, with no connector reference invented.
    for (const row of [
      await db.selectFrom('skills_v1_skills').select('manifest_yaml').executeTakeFirstOrThrow(),
      await db.selectFrom('skills_v1_user_skills').select('manifest_yaml').executeTakeFirstOrThrow(),
    ]) {
      expect(row.manifest_yaml).not.toContain('capabilities');
      const parsed = parseSkillManifest(row.manifest_yaml);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.connectors).toEqual([]);
    }

    // The dropped reach is logged with ids only (no hosts, slots or secrets).
    const dropped = h.warns.filter((w) => w.msg === 'skills_cap_migration_reach_dropped');
    expect(dropped.map((w) => w.bindings)).toEqual([
      { skillId: 'github', ownerUserId: 'system' },
      { skillId: 'github', ownerUserId: 'u1' },
    ]);
  });
});
