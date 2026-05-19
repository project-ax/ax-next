import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';

// Parse BIGINT as Number, matching sync.test.ts pattern (BIGSERIAL returns strings by default).
pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  // CASCADE on default_routines_v1 drops dependent rows in
  // routines_v1_definitions (via FK ON DELETE CASCADE). Then re-seed the
  // heartbeat default so each test gets a clean slate with exactly the
  // seeded default present — matches the post-migration starting state.
  await sql`TRUNCATE default_routines_v1 CASCADE`.execute(db);
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
  await sql`
    INSERT INTO default_routines_v1
      (default_routine_id, name, description, spec_hash, trigger_kind,
       trigger_spec, interval_seconds, silence_token, silence_max,
       conversation, prompt_body, source_md)
    VALUES
      ('default-heartbeat-2026-05-19', 'heartbeat',
       'Daily check-in: ask if anything is outstanding.',
       'seed-2026-05-19',
       'interval', ${'{"kind":"interval","every":"24h"}'}::jsonb, 86400,
       'HEARTBEAT_OK', 300, 'shared',
       'If nothing is outstanding, respond with HEARTBEAT_OK and end.',
       'seed')
    ON CONFLICT (name) DO NOTHING
  `.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

function baseInput(over: Partial<Parameters<ReturnType<typeof createRoutinesStore>['upsert']>[0]> = {}) {
  return {
    agentId: 'agt_a',
    path: '.ax/routines/r.md',
    authorUserId: 'u1',
    name: 'r',
    description: 'd',
    specHash: 'h1',
    trigger: { kind: 'webhook' as const, path: '/r' },
    activeHours: null,
    silenceToken: null,
    silenceMax: 300,
    conversation: 'per-fire' as const,
    promptBody: 'hi',
    nextRunAt: null,
    ...over,
  };
}

describe('RoutinesStore.findOne', () => {
  it('returns the row for an existing (agentId, path)', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput());
    const row = await store.findOne({ agentId: 'agt_a', path: '.ax/routines/r.md' });
    expect(row).not.toBeNull();
    expect(row!.agentId).toBe('agt_a');
    expect(row!.path).toBe('.ax/routines/r.md');
  });

  it('returns null on miss', async () => {
    const store = createRoutinesStore(db);
    expect(await store.findOne({ agentId: 'agt_a', path: '.ax/routines/missing.md' })).toBeNull();
  });

  it('distinguishes rows by both agentId and path', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({ agentId: 'agt_a' }));
    await store.upsert(baseInput({ agentId: 'agt_b' }));
    const a = await store.findOne({ agentId: 'agt_a', path: '.ax/routines/r.md' });
    const b = await store.findOne({ agentId: 'agt_b', path: '.ax/routines/r.md' });
    expect(a!.agentId).toBe('agt_a');
    expect(b!.agentId).toBe('agt_b');
  });
});

describe('RoutinesStore.upsert change-detection', () => {
  it('returns { changed: true } on first insert', async () => {
    const store = createRoutinesStore(db);
    const r = await store.upsert(baseInput({ specHash: 'h1' }));
    expect(r.changed).toBe(true);
  });

  it('returns { changed: true } when spec_hash differs from existing row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({ specHash: 'h1' }));
    const r = await store.upsert(baseInput({ specHash: 'h2' }));
    expect(r.changed).toBe(true);
  });

  it('returns { changed: false } when spec_hash matches existing row', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({ specHash: 'h1' }));
    const r = await store.upsert(baseInput({ specHash: 'h1' }));
    expect(r.changed).toBe(false);
  });
});

describe('RoutinesStore.recordFire', () => {
  it('recordFire round-trips renderedPrompt', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({
      trigger: { kind: 'interval' as const, every: '60s' },
      promptBody: 'hi {{payload.x}}',
    }));
    const id = await store.recordFire({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      triggerSource: 'manual',
      conversationId: 'cnv_1',
      status: 'ok', error: null,
      renderedPrompt: 'hi world',
    });
    expect(id).toBeGreaterThan(0);
    const row = await db
      .selectFrom('routines_v1_fires')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.rendered_prompt).toBe('hi world');
  });

  it('recordFire stores null when renderedPrompt is omitted', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput());
    const id = await store.recordFire({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      triggerSource: 'tick',
      conversationId: null,
      status: 'ok', error: null,
    });
    const row = await db
      .selectFrom('routines_v1_fires')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.rendered_prompt).toBeNull();
  });

  it('recordFire truncates renderedPrompt above 64 KiB (ASCII)', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput());
    const huge = 'a'.repeat(64 * 1024 + 100);
    const id = await store.recordFire({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      triggerSource: 'manual',
      conversationId: null,
      status: 'ok', error: null,
      renderedPrompt: huge,
    });
    const row = await db
      .selectFrom('routines_v1_fires')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.rendered_prompt).not.toBeNull();
    expect(new TextEncoder().encode(row.rendered_prompt!).length)
      .toBeLessThanOrEqual(64 * 1024);
    expect(row.rendered_prompt!.endsWith('…')).toBe(true);
  });

  it('recordFire truncates renderedPrompt by BYTES not chars (UTF-8 multibyte)', async () => {
    // A string of CJK/emoji chars whose CODE-UNIT length stays under
    // 64 KiB but whose UTF-8 BYTE length explodes past it. The old
    // truncation (`raw.length > MAX`) would have passed this through
    // unmodified, producing a multi-hundred-KiB row.
    const store = createRoutinesStore(db);
    await store.upsert(baseInput());
    // '日' is 3 bytes in UTF-8. 30k chars = 90k bytes — well over 64 KiB.
    const huge = '日'.repeat(30_000);
    expect(huge.length).toBeLessThan(64 * 1024); // pre-condition
    const id = await store.recordFire({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      triggerSource: 'manual',
      conversationId: null,
      status: 'ok', error: null,
      renderedPrompt: huge,
    });
    const row = await db
      .selectFrom('routines_v1_fires')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.rendered_prompt).not.toBeNull();
    expect(new TextEncoder().encode(row.rendered_prompt!).length)
      .toBeLessThanOrEqual(64 * 1024);
    expect(row.rendered_prompt!.endsWith('…')).toBe(true);
  });
});

describe('RoutinesStore.recentFires', () => {
  it('recentFires returns fires for one routine in fired_at DESC order, honors limit', async () => {
    const store = createRoutinesStore(db);
    await store.upsert(baseInput({
      trigger: { kind: 'interval' as const, every: '60s' },
    }));
    for (let i = 0; i < 5; i += 1) {
      await store.recordFire({
        agentId: 'agt_a', path: '.ax/routines/r.md',
        triggerSource: 'manual', conversationId: `cnv_${i}`,
        status: 'ok', error: null, renderedPrompt: `prompt ${i}`,
      });
      await new Promise((r) => setTimeout(r, 5)); // ensure distinct fired_at
    }
    const out = await store.recentFires({ agentId: 'agt_a', path: '.ax/routines/r.md', limit: 3 });
    expect(out).toHaveLength(3);
    expect(out[0]!.renderedPrompt).toBe('prompt 4');
    expect(out[2]!.renderedPrompt).toBe('prompt 2');
  });
});

describe('RoutinesStore default-routine CRUD', () => {
  it('upsertDefault + listDefaults round-trip', async () => {
    const store = createRoutinesStore(db);

    const r = await store.upsertDefault({
      name: 'my-default',
      description: 'd',
      specHash: 'h1',
      trigger: { kind: 'interval', every: '1h' },
      intervalSeconds: 3600,
      activeHours: null,
      silenceToken: 'TOK',
      silenceMax: 300,
      conversation: 'shared',
      promptBody: 'p',
      sourceMd: '---\nname: my-default\n---\n',
    });
    expect(r.created).toBe(true);
    expect(typeof r.defaultRoutineId).toBe('string');

    const list = await store.listDefaults();
    // The heartbeat seed is also present — at least 2 defaults total.
    expect(list.map((d) => d.name)).toContain('my-default');
    expect(list.map((d) => d.name)).toContain('heartbeat');
  });

  it('upsertDefault rejects duplicate name as expected (unique constraint)', async () => {
    // Two upserts with the same name from different upsert calls should
    // update, not duplicate.
    const store = createRoutinesStore(db);

    await store.upsertDefault({
      name: 'twice', description: 'a', specHash: 'h1',
      trigger: { kind: 'interval', every: '1h' }, intervalSeconds: 3600,
      activeHours: null, silenceToken: null, silenceMax: 300,
      conversation: 'shared', promptBody: 'p1',
      sourceMd: 'a',
    });
    const r2 = await store.upsertDefault({
      name: 'twice', description: 'b', specHash: 'h2',
      trigger: { kind: 'interval', every: '2h' }, intervalSeconds: 7200,
      activeHours: null, silenceToken: null, silenceMax: 300,
      conversation: 'shared', promptBody: 'p2',
      sourceMd: 'b',
    });
    expect(r2.created).toBe(false);
    const d = await store.getDefault(r2.defaultRoutineId);
    expect(d?.description).toBe('b');
    expect(d?.intervalSeconds).toBe(7200);
  });

  it('deleteDefault cascades to per-agent rows', async () => {
    const store = createRoutinesStore(db);

    const { defaultRoutineId } = await store.upsertDefault({
      name: 'cascade-test', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '1h' }, intervalSeconds: 3600,
      activeHours: null, silenceToken: null, silenceMax: 300,
      conversation: 'shared', promptBody: 'p',
      sourceMd: 's',
    });

    // Insert a per-agent row referencing the default.
    await db.insertInto('routines_v1_definitions').values({
      agent_id: 'agent-x',
      path: `default:${defaultRoutineId}`,
      author_user_id: '@ax/routines/defaults',
      name: 'cascade-test',
      description: 'd',
      spec_hash: 'h',
      trigger_kind: 'interval',
      trigger_spec: { kind: 'interval', every: '1h' } as unknown,
      active_hours: null,
      silence_token: null,
      silence_max: 300,
      conversation: 'shared',
      prompt_body: 'p',
      next_run_at: null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      definition_id: defaultRoutineId,
      definition_updated_at: new Date(),
    }).execute();

    await store.deleteDefault(defaultRoutineId);

    const remaining = await db
      .selectFrom('routines_v1_definitions')
      .select('agent_id')
      .where('agent_id', '=', 'agent-x')
      .execute();
    expect(remaining).toEqual([]);
  });
});
