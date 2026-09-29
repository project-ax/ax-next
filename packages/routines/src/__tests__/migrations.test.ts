import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import {
  SKILL_REFLECTION_PROMPT,
  SKILL_REFLECTION_SEED_HASH,
  SKILL_REFLECTION_STRATA_SEED_HASH,
} from '../reflection-prompt.js';

// pg returns BIGINT (OID 20) as string by default; parse as number for test assertions.
pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let connectionString: string;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}, 120_000);

afterAll(async () => {
  await db.destroy();
  if (container) await stopPostgresContainer(container);
}, 60_000);

afterEach(async () => {
  await sql`DROP TABLE IF EXISTS routines_v1_fires`.execute(db);
  await sql`DROP TABLE IF EXISTS routines_v1_definitions`.execute(db);
  // agent_default_routine_overrides_v1 FK-references default_routines_v1, so
  // drop it (CASCADE) before the parent.
  await sql`DROP TABLE IF EXISTS agent_default_routine_overrides_v1 CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS default_routines_v1 CASCADE`.execute(db);
});

describe('runRoutinesMigration', () => {
  it('creates routines_v1_definitions with primary key (agent_id, path)', async () => {
    await runRoutinesMigration(db);
    await db.insertInto('routines_v1_definitions').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md', owner_user_id: 'u1',
      name: 'r', description: 'd', spec_hash: 'h',
      trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
      active_hours: null, silence_token: null, silence_max: 300,
      conversation: 'per-fire', prompt_body: '# x',
      next_run_at: new Date(),
    }).execute();
    await expect(
      db.insertInto('routines_v1_definitions').values({
        agent_id: 'agt_a', path: '.ax/routines/r.md', owner_user_id: 'u1',
        name: 'r2', description: 'd', spec_hash: 'h',
        trigger_kind: 'interval', trigger_spec: { kind: 'interval', every: '60s' },
        active_hours: null, silence_token: null, silence_max: 300,
        conversation: 'per-fire', prompt_body: '# x',
        next_run_at: new Date(),
      }).execute(),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('creates routines_v1_fires with append-only id', async () => {
    await runRoutinesMigration(db);
    const row = await db.insertInto('routines_v1_fires').values({
      agent_id: 'agt_a', path: '.ax/routines/r.md',
      trigger_source: 'tick', status: 'ok',
    }).returningAll().executeTakeFirstOrThrow();
    expect(row.id).toBeGreaterThan(0);
  });

  it('routines_v1_due index excludes null next_run_at', async () => {
    await runRoutinesMigration(db);
    const idxes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'routines_v1_definitions'
    `.execute(db);
    const names = idxes.rows.map((r) => r.indexname);
    expect(names).toContain('routines_v1_due');
  });

  it('routines_v1_fires_by_agent index exists on routines_v1_fires', async () => {
    await runRoutinesMigration(db);
    const idxes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'routines_v1_fires'
    `.execute(db);
    const names = idxes.rows.map((r) => r.indexname);
    expect(names).toContain('routines_v1_fires_by_agent');
  });

  it('is idempotent', async () => {
    await runRoutinesMigration(db);
    await runRoutinesMigration(db);
  });

  it('adds rendered_prompt column to routines_v1_fires', async () => {
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'routines_v1_fires'
    `.execute(db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('rendered_prompt');
  });

  it('default_routines_v1 table has expected schema', async () => {
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'default_routines_v1'
       ORDER BY ordinal_position
    `.execute(db);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName['default_routine_id']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['name']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['trigger_kind']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['trigger_spec']).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(byName['interval_seconds']).toMatchObject({ data_type: 'integer', is_nullable: 'YES' });
    expect(byName['silence_token']).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(byName['silence_max']).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(byName['conversation']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['prompt_body']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['enabled']).toMatchObject({ data_type: 'boolean', is_nullable: 'NO' });
    expect(byName['source_md']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
  });

  it('routines_v1_definitions gained definition_id + definition_updated_at columns', async () => {
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'routines_v1_definitions'
         AND column_name IN ('definition_id', 'definition_updated_at')
    `.execute(db);
    expect(cols.rows).toHaveLength(2);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName['definition_id']).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(byName['definition_updated_at']).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
  });

  it('CHECK constraint forbids default-sourced row with non-null next_run_at', async () => {
    await runRoutinesMigration(db);

    // First, seed a default so the FK resolves.
    await sql`
      INSERT INTO default_routines_v1
        (default_routine_id, name, description, spec_hash, trigger_kind, trigger_spec,
         interval_seconds, silence_max, conversation, prompt_body, source_md)
      VALUES
        ('d-hb', 'heartbeat-test', 'd', 'hash', 'interval', '{"kind":"interval","every":"24h"}'::jsonb,
         86400, 300, 'shared', 'p', 's')
    `.execute(db);

    let caught: unknown;
    try {
      await sql`
        INSERT INTO routines_v1_definitions
          (agent_id, path, owner_user_id, name, description, spec_hash,
           trigger_kind, trigger_spec, silence_max, conversation, prompt_body,
           definition_id, next_run_at)
        VALUES
          ('agent-x', 'default:d-hb', 'admin', 'heartbeat', 'd', 'hash',
           'interval', '{"kind":"interval","every":"24h"}'::jsonb, 300, 'shared', 'p',
           'd-hb', now())
      `.execute(db);
    } catch (e) {
      caught = e;
    }
    // postgres CHECK violation = SQLSTATE 23514
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('first-boot seed of default heartbeat is idempotent', async () => {
    await runRoutinesMigration(db);
    await runRoutinesMigration(db);

    const rows = await sql<{ name: string; trigger_kind: string }>`
      SELECT name, trigger_kind FROM default_routines_v1 WHERE name = 'heartbeat'
    `.execute(db);
    expect(rows.rows).toEqual([{ name: 'heartbeat', trigger_kind: 'interval' }]);
  });

  it('seeds the skill-reflection default OFF and idempotently (TASK-178)', async () => {
    // Double-migrate: ON CONFLICT (name) DO NOTHING must keep exactly one row.
    await runRoutinesMigration(db);
    await runRoutinesMigration(db);

    const rows = await sql<{
      default_routine_id: string;
      name: string;
      enabled: boolean;
      trigger_kind: string;
      interval_seconds: number;
      silence_token: string | null;
      silence_max: number;
      conversation: string;
      prompt_body: string;
      spec_hash: string;
    }>`
      SELECT default_routine_id, name, enabled, trigger_kind, interval_seconds,
             silence_token, silence_max, conversation, prompt_body, spec_hash
        FROM default_routines_v1 WHERE name = 'skill-reflection'
    `.execute(db);

    expect(rows.rows).toHaveLength(1);
    const r = rows.rows[0]!;
    expect(r.default_routine_id).toBe('skill-reflection');
    // Global master switch OFF until an operator flips it post-walk.
    expect(r.enabled).toBe(false);
    expect(r.trigger_kind).toBe('interval');
    expect(r.interval_seconds).toBe(86400); // 24h
    // The silence token MUST match the prompt's REFLECTION_DONE contract.
    expect(r.silence_token).toBe('REFLECTION_DONE');
    expect(r.silence_max).toBe(4000);
    // Each fire gets its own hidden conversation (no cross-fire bleed).
    expect(r.conversation).toBe('per-fire');
    // The seeded body is the canonical reflection meta-prompt verbatim.
    expect(r.prompt_body).toBe(SKILL_REFLECTION_PROMPT);
    expect(r.spec_hash).toBe(SKILL_REFLECTION_SEED_HASH);
  });

  it('skill-reflection seed never clobbers a later operator edit (ON CONFLICT DO NOTHING)', async () => {
    await runRoutinesMigration(db);
    // Simulate the post-walk flip / a manual prompt tweak.
    await db.updateTable('default_routines_v1')
      .set({ enabled: true })
      .where('name', '=', 'skill-reflection')
      .execute();
    // A re-run of the migration (e.g. on the next boot) must NOT reset it.
    await runRoutinesMigration(db);
    const r = await db.selectFrom('default_routines_v1')
      .select('enabled').where('name', '=', 'skill-reflection').executeTakeFirstOrThrow();
    expect(r.enabled).toBe(true);
  });

  // TASK-611: the one-shot swap from the Strata-era seed to the facts prompt,
  // and the re-enable of what TASK-609's boot step switched off.
  describe('skill-reflection facts-memory swap (TASK-611)', () => {
    const OLD_PROMPT = 'old strata prompt reading memory/docs source_conversations';

    /** Put the row back on the Strata-era seed, as a pre-TASK-611 deployment has it. */
    async function asStrataSeed(enabled: boolean): Promise<void> {
      await db.updateTable('default_routines_v1')
        .set({ enabled, spec_hash: SKILL_REFLECTION_STRATA_SEED_HASH, prompt_body: OLD_PROMPT })
        .where('name', '=', 'skill-reflection')
        .execute();
    }

    async function recordReflectionFire(): Promise<void> {
      await db.insertInto('routines_v1_fires').values({
        agent_id: 'agt_a', path: 'default:skill-reflection',
        trigger_source: 'tick', status: 'silenced',
      }).execute();
    }

    async function row() {
      return db.selectFrom('default_routines_v1')
        .selectAll()
        .where('name', '=', 'skill-reflection')
        .executeTakeFirstOrThrow();
    }

    it('re-enables a row TASK-609 switched off (it had fired), swaps the prompt, and is a no-op on re-run', async () => {
      await runRoutinesMigration(db);
      await asStrataSeed(false);
      await recordReflectionFire();
      const before = await row();

      await runRoutinesMigration(db);
      const once = await row();
      expect(once.enabled).toBe(true);
      expect(once.prompt_body).toBe(SKILL_REFLECTION_PROMPT);
      expect(once.spec_hash).toBe(SKILL_REFLECTION_SEED_HASH);
      // Bumped, so refreshStale carries the new prompt to materialized rows.
      expect(once.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());

      await runRoutinesMigration(db);
      expect(await row()).toEqual(once);
    });

    it('leaves a row that never fired OFF (the seed ships OFF) but still swaps its prompt', async () => {
      await runRoutinesMigration(db);
      await asStrataSeed(false);

      await runRoutinesMigration(db);
      const r = await row();
      expect(r.enabled).toBe(false);
      expect(r.prompt_body).toBe(SKILL_REFLECTION_PROMPT);
      expect(r.spec_hash).toBe(SKILL_REFLECTION_SEED_HASH);
    });

    it('keeps a still-ON pre-TASK-609 row ON and swaps its prompt', async () => {
      await runRoutinesMigration(db);
      await asStrataSeed(true);

      await runRoutinesMigration(db);
      const r = await row();
      expect(r.enabled).toBe(true);
      expect(r.prompt_body).toBe(SKILL_REFLECTION_PROMPT);
    });

    it('never touches an operator-edited row, even one that fired and is OFF', async () => {
      await runRoutinesMigration(db);
      await db.updateTable('default_routines_v1')
        .set({ enabled: false, spec_hash: 'operator-hash', source_md: '---\nname: skill-reflection\n---\nmine', prompt_body: 'mine' })
        .where('name', '=', 'skill-reflection')
        .execute();
      await recordReflectionFire();
      const before = await row();

      await runRoutinesMigration(db);
      expect(await row()).toEqual(before);
    });

    it('does not re-enable on a fire of some other routine', async () => {
      await runRoutinesMigration(db);
      await asStrataSeed(false);
      await db.insertInto('routines_v1_fires').values({
        agent_id: 'agt_a', path: 'default:default-heartbeat-2026-05-19',
        trigger_source: 'tick', status: 'ok',
      }).execute();

      await runRoutinesMigration(db);
      expect((await row()).enabled).toBe(false);
    });
  });

  it('drops the ok twin of a silenced fire, keeps everything else, and is a no-op on re-run (TASK-679)', async () => {
    await runRoutinesMigration(db);
    const t = (s: string) => new Date(`2031-01-01T${s}Z`);
    const HB = 'default:default-heartbeat-2026-05-19';
    const rows = [
      // 1: pre-fix silent heartbeat — ok twin (DROP) + silenced (keep)
      { id: 1, agent_id: 'a1', path: HB, fired_at: t('10:00:00'), trigger_source: 'tick', conversation_id: 'c1', status: 'ok' },
      { id: 2, agent_id: 'a1', path: HB, fired_at: t('10:00:11'), trigger_source: 'tick', conversation_id: 'c1', status: 'silenced' },
      // 2: silenced row more than a minute later — not a twin (keep both)
      { id: 3, agent_id: 'a1', path: HB, fired_at: t('11:00:00'), trigger_source: 'tick', conversation_id: 'c1', status: 'ok' },
      { id: 4, agent_id: 'a1', path: HB, fired_at: t('11:02:00'), trigger_source: 'tick', conversation_id: 'c1', status: 'silenced' },
      // 3: another agent's silenced row — not a twin (keep)
      { id: 5, agent_id: 'a2', path: HB, fired_at: t('12:00:00'), trigger_source: 'tick', conversation_id: 'c2', status: 'ok' },
      { id: 6, agent_id: 'a3', path: HB, fired_at: t('12:00:05'), trigger_source: 'tick', conversation_id: 'c2', status: 'silenced' },
      // 4: webhook never wrote a dispatch row — its ok is real (keep)
      { id: 7, agent_id: 'a1', path: 'w.md', fired_at: t('13:00:00'), trigger_source: 'webhook', conversation_id: 'c3', status: 'ok' },
      { id: 8, agent_id: 'a1', path: 'w.md', fired_at: t('13:00:05'), trigger_source: 'webhook', conversation_id: 'c3', status: 'silenced' },
      // 5: pre-fix NON-silent fire — ok + ok; not cleaned (keep both)
      { id: 9, agent_id: 'a1', path: 'r.md', fired_at: t('14:00:00'), trigger_source: 'manual', conversation_id: 'c4', status: 'ok' },
      { id: 10, agent_id: 'a1', path: 'r.md', fired_at: t('14:00:09'), trigger_source: 'manual', conversation_id: 'c4', status: 'ok' },
      // 6: a different conversation (per-fire) — not a twin (keep)
      { id: 11, agent_id: 'a1', path: 'p.md', fired_at: t('15:00:00'), trigger_source: 'tick', conversation_id: 'c5', status: 'ok' },
      { id: 12, agent_id: 'a1', path: 'p.md', fired_at: t('15:00:05'), trigger_source: 'tick', conversation_id: 'c6', status: 'silenced' },
      // 7: pre-fix silent manual fire — ok twin (DROP) + silenced (keep)
      { id: 13, agent_id: 'a1', path: 'm.md', fired_at: t('16:00:00'), trigger_source: 'manual', conversation_id: 'c7', status: 'ok' },
      { id: 14, agent_id: 'a1', path: 'm.md', fired_at: t('16:00:03'), trigger_source: 'manual', conversation_id: 'c7', status: 'silenced' },
    ] as const;
    for (const r of rows) {
      await sql`
        INSERT INTO routines_v1_fires (id, agent_id, path, fired_at, trigger_source, conversation_id, status)
        VALUES (${r.id}, ${r.agent_id}, ${r.path}, ${r.fired_at}, ${r.trigger_source}, ${r.conversation_id}, ${r.status})
      `.execute(db);
    }

    await runRoutinesMigration(db);
    const ids = async () => (await db.selectFrom('routines_v1_fires').select('id')
      .orderBy('id').execute()).map((r) => Number(r.id));
    const after = rows.map((r) => r.id).filter((id) => id !== 1 && id !== 13);
    expect(await ids()).toEqual(after);

    await runRoutinesMigration(db);
    expect(await ids()).toEqual(after);
  });

  it('routines_v1_definitions_default_idx exists', async () => {
    await runRoutinesMigration(db);
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'routines_v1_definitions'
         AND indexname = 'routines_v1_definitions_default_idx'
    `.execute(db);
    expect(r.rows).toHaveLength(1);
  });

  it('agent_default_routine_overrides_v1 has PK (agent_id, default_routine_id) and cascades from default_routines_v1', async () => {
    await runRoutinesMigration(db);
    // PK enforces one override per (agent, default).
    await db.insertInto('agent_default_routine_overrides_v1').values({
      agent_id: 'agt_a', default_routine_id: 'default-heartbeat-2026-05-19',
      owner_user_id: 'u1', enabled: false,
    }).execute();
    await expect(
      db.insertInto('agent_default_routine_overrides_v1').values({
        agent_id: 'agt_a', default_routine_id: 'default-heartbeat-2026-05-19',
        owner_user_id: 'u2', enabled: false,
      }).execute(),
    ).rejects.toThrow(/duplicate|unique/i);

    // FK ON DELETE CASCADE: deleting the default drops its overrides.
    await db.deleteFrom('default_routines_v1')
      .where('default_routine_id', '=', 'default-heartbeat-2026-05-19').execute();
    const remaining = await db.selectFrom('agent_default_routine_overrides_v1')
      .selectAll().where('agent_id', '=', 'agt_a').execute();
    expect(remaining).toEqual([]);
  });

  it('agent_default_routine_overrides_v1 rejects an override for a non-existent default (FK)', async () => {
    await runRoutinesMigration(db);
    await expect(
      db.insertInto('agent_default_routine_overrides_v1').values({
        agent_id: 'agt_a', default_routine_id: 'no-such-default',
        owner_user_id: 'u1', enabled: false,
      }).execute(),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
