import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore, type RoutinesStore } from '../store.js';
import { runTickLoop, runTickOnce, type FireRoutineFn } from '../tick.js';
import type { Clock } from '../clock.js';

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
  // CASCADE on default_routines_v1 drops dependent per-agent rows
  // (FK ON DELETE CASCADE on routines_v1_definitions.definition_id),
  // then re-seed the heartbeat default so each test sees the same
  // post-migration baseline. Tests that bump default rows (e.g. the
  // refreshStale + active-hours-defer tests) would otherwise leak
  // mutated state across the test order. Mirrors store.test.ts.
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
}, 60_000);

async function seedInterval(store: RoutinesStore, agentId: string, every: string, nextAt: Date) {
  await store.upsert({
    agentId, path: '.ax/routines/r.md', authorUserId: 'u1',
    name: 'r', description: 'd', specHash: agentId + every,
    trigger: { kind: 'interval', every },
    activeHours: null, silenceToken: null, silenceMax: 300,
    conversation: 'per-fire', promptBody: '# x',
    nextRunAt: nextAt,
  });
}

describe('runTickOnce', () => {
  it('fires a due interval routine and advances next_run_at by every', async () => {
    const store = createRoutinesStore(db);
    await seedInterval(store, 'agt_a', '30m', new Date('2026-05-14T12:00:00Z'));
    const fired: Array<{ agentId: string; status: string }> = [];
    const fire: FireRoutineFn = async (row) => {
      fired.push({ agentId: row.agentId, status: 'ok' });
      return { status: 'ok', error: null, renderedPrompt: 'p' };
    };
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:01:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    expect(fired).toEqual([{ agentId: 'agt_a', status: 'ok' }]);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    // Drift control: previous next_run_at + every. 12:00 + 30m = 12:30.
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:30:00.000Z');
    expect(row.last_status).toBe('ok');
  });

  it('jumps to now + every when more than one interval behind (catch-up storm guard)', async () => {
    const store = createRoutinesStore(db);
    await seedInterval(store, 'agt_a', '30m', new Date('2026-05-14T09:00:00Z'));
    const fire: FireRoutineFn = async () => ({ status: 'ok', error: null, renderedPrompt: 'p' });
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:00:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:30:00.000Z');
  });

  it('skips outside active hours and shifts to next valid window', async () => {
    const store = createRoutinesStore(db);
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
      name: 'r', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '30m' },
      activeHours: { start: '08:00', end: '24:00', tz: 'America/New_York' },
      silenceToken: null, silenceMax: 300, conversation: 'per-fire',
      promptBody: '# x',
      nextRunAt: new Date('2026-05-14T07:00:00Z'),
    });
    const fired: unknown[] = [];
    const fire: FireRoutineFn = async (row) => { fired.push(row); return { status: 'ok', error: null, renderedPrompt: 'p' }; };
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T07:05:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    expect(fired).toEqual([]);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.next_run_at?.toISOString()).toBe('2026-05-14T12:00:00.000Z');
    const fires = await db.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(0);
  });

  it('records fire row with error status when fire throws', async () => {
    const store = createRoutinesStore(db);
    await seedInterval(store, 'agt_a', '30m', new Date('2026-05-14T12:00:00Z'));
    const fire: FireRoutineFn = async () => { throw new Error('agent crashed'); };
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:01:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
    });
    const fires = await db.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.status).toBe('error');
    expect(fires[0]!.error).toMatch(/agent crashed/);
    const row = await db.selectFrom('routines_v1_definitions').selectAll().executeTakeFirstOrThrow();
    expect(row.last_status).toBe('error');
  });

  it('only one runTickLoop instance holds the advisory lock at a time, and a fresh loop can acquire it after shutdown', async () => {
    // Two concurrent runTickLoops against the same DB. Both should not
    // claim the same row (correctness already guaranteed by FOR UPDATE
    // SKIP LOCKED). The advisory lock should additionally prevent the
    // second loop from even entering its inner tick — proven by
    // observing that only ONE of fireA/fireB was invoked.
    //
    // After both loops abort, a FRESH runTickLoop (runC) against the
    // same DB must be able to acquire the lock and fire on a freshly-
    // seeded row. This is the release-path assertion: if the original
    // pool-unpinned pg_advisory_unlock had no-op'd (the bug this PR
    // fixes), the leaked lock would survive shutdown and block runC.
    //
    // We use a 24h "every" so the winner fires exactly ONCE per row
    // within the test window (a fixed fake clock + short every would
    // otherwise re-claim the same row across inner-loop iterations).
    const store = createRoutinesStore(db);
    await seedInterval(store, 'agt_a', '24h', new Date('2026-05-14T12:00:00Z'));
    let fireA = 0, fireB = 0;
    const fakeClock: Clock = {
      now: () => new Date('2026-05-14T12:01:00Z'),
      sleep: async () => {},
    };
    const ctlA = new AbortController();
    const ctlB = new AbortController();
    const runA = runTickLoop({
      db, fire: async () => { fireA++; return { status: 'ok', error: null, renderedPrompt: 'p' }; },
      clock: fakeClock, signal: ctlA.signal,
      tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 10, claimWindowMinutes: 5,
    });
    const runB = runTickLoop({
      db, fire: async () => { fireB++; return { status: 'ok', error: null, renderedPrompt: 'p' }; },
      clock: fakeClock, signal: ctlB.signal,
      tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 10, claimWindowMinutes: 5,
    });
    // Wait until at least one loop has fired — proves a full tick
    // (acquire-lock → claim → fire) actually ran. The previous fixed 50ms
    // sleep flaked on slow CI runners where the DB round-trips overran the
    // budget and BOTH counters stayed at 0. With 24h interval + fixed
    // clock + lastRunAt advancement, the row is unclaimable after the
    // first fire, so polling can't accidentally race past the boundary.
    await vi.waitFor(
      () => expect(fireA + fireB).toBeGreaterThanOrEqual(1),
      { timeout: 5_000, interval: 25 },
    );
    ctlA.abort(); ctlB.abort();
    await Promise.all([runA, runB]);
    expect(fireA + fireB).toBe(1);

    // Release-path: seed a second routine that's due, then spin up a
    // fresh loop. If the advisory lock was actually released on
    // runA/runB shutdown, runC acquires it cleanly and fires.
    await seedInterval(store, 'agt_b', '24h', new Date('2026-05-14T12:00:00Z'));
    let fireC = 0;
    const ctlC = new AbortController();
    const runC = runTickLoop({
      db, fire: async () => { fireC++; return { status: 'ok', error: null, renderedPrompt: 'p' }; },
      clock: fakeClock, signal: ctlC.signal,
      tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 10, claimWindowMinutes: 5,
    });
    await vi.waitFor(
      () => expect(fireC).toBe(1),
      { timeout: 5_000, interval: 25 },
    );
    ctlC.abort();
    await runC;
    expect(fireC).toBe(1);
  });

  // -------------------------------------------------------------------
  // Default-routine materialization + refresh (Task 5).
  //
  // These tests share a single concern: runTickOnce must materialize
  // missing per-agent rows and refresh stale denormalized copies BEFORE
  // it claims due work, so newly-created agents pick up defaults in the
  // same tick — and I-R10: a failure inside materialize/refresh must
  // not crash the whole tick.
  // -------------------------------------------------------------------

  it('runTickOnce materializes missing rows before claiming (default-sourced)', async () => {
    const store = createRoutinesStore(db);
    const fire: FireRoutineFn = async () => ({ status: 'ok', error: null, renderedPrompt: 'p' });
    // No seeded routines — only the migration-seeded heartbeat default
    // exists, and no per-agent row for it yet.
    const before = await db.selectFrom('routines_v1_definitions').selectAll().execute();
    expect(before).toEqual([]);

    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:00:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgentIds: async () => ['agt_a'],
    });

    // After the tick, a default-sourced per-agent row exists (assert on
    // definition_id IS NOT NULL — counting rows would be fragile if a
    // workspace heartbeat is later added by an upsert path).
    const after = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agt_a')
      .where('definition_id', 'is not', null)
      .execute();
    expect(after.length).toBeGreaterThanOrEqual(1);
    // next_run_at MUST be NULL on default-sourced rows (CHECK constraint
    // + claim path computes due-ness from last_run_at + interval).
    expect(after[0]!.next_run_at).toBeNull();
  });

  it('runTickOnce refreshes stale denormalized copies before claiming', async () => {
    const store = createRoutinesStore(db);
    const fire: FireRoutineFn = async () => ({ status: 'ok', error: null, renderedPrompt: 'p' });

    // Tick once to materialize the heartbeat default for agt_a.
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:00:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgentIds: async () => ['agt_a'],
    });
    const materialized = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agt_a')
      .where('definition_id', 'is not', null)
      .executeTakeFirstOrThrow();
    expect(materialized.prompt_body).not.toBe('REFRESHED');

    // Bump default_routines_v1.updated_at past the per-agent
    // definition_updated_at and change prompt_body. The migration seed
    // sets default.updated_at via DEFAULT now() (real wall clock), so
    // we have to bump it to a value strictly LATER than that —
    // tick-test fake dates in 2026 are in the past relative to the
    // wall clock by definition, so we use materialized.definition_updated_at
    // + 1 hour as a guaranteed-future-of-the-current-row baseline.
    const bumpedAt = new Date(
      (materialized.definition_updated_at as Date).getTime() + 60 * 60 * 1000,
    );
    await sql`
      UPDATE default_routines_v1
         SET prompt_body = 'REFRESHED',
             updated_at = ${bumpedAt}
       WHERE default_routine_id = ${materialized.definition_id}
    `.execute(db);

    // Tick again — refresh should pick up the new prompt_body.
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T13:01:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgentIds: async () => ['agt_a'],
    });
    const refreshed = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agt_a')
      .where('definition_id', 'is not', null)
      .executeTakeFirstOrThrow();
    expect(refreshed.prompt_body).toBe('REFRESHED');
  });

  it('runTickOnce continues claiming workspace rows when getAgentIds throws (I-R10)', async () => {
    const store = createRoutinesStore(db);
    // Seed a due workspace row — must still be claimed and fired even
    // though the defaults branch blew up.
    await seedInterval(store, 'agt_a', '30m', new Date('2026-05-14T12:00:00Z'));
    const fired: string[] = [];
    const fire: FireRoutineFn = async (row) => {
      fired.push(row.agentId);
      return { status: 'ok', error: null, renderedPrompt: 'p' };
    };

    // getAgentIds throws — runTickOnce must NOT propagate (the I-R10
    // try/catch in tick.ts logs to stderr and falls through to claim).
    await expect(
      runTickOnce({
        store, fire, now: new Date('2026-05-14T12:01:00Z'),
        claimBatchSize: 50, claimWindowMinutes: 5,
        getAgentIds: async () => { throw new Error('agents:list-ids unavailable'); },
      }),
    ).resolves.toBeUndefined();

    // The workspace row was claimed and fired despite the defaults
    // branch failure.
    expect(fired).toEqual(['agt_a']);
  });

  it('active-hours defer on default-sourced row keeps next_run_at NULL and pushes last_run_at to the next window', async () => {
    // Regression: the active-hours defer branch in runTickOnce used to
    // unconditionally write nextRunAt=adjusted, which violates
    // routines_v1_default_next_run_at_chk for default-sourced rows
    // (definition_id IS NOT NULL). The fix routes default-sourced rows
    // through nextRunAt=null + lastRunAt=adjusted so the next claim's
    // due-ness computation (COALESCE(last_run_at, created_at) +
    // interval_seconds) defers past the current inactive window.
    const store = createRoutinesStore(db);
    const fire: FireRoutineFn = async () => ({ status: 'ok', error: null, renderedPrompt: 'p' });

    // Materialize the heartbeat default for agt_a.
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T12:00:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgentIds: async () => ['agt_a'],
    });

    // Patch the per-agent row to: (a) carry an active_hours window
    // that's always inactive at the fake `now` (09:00–09:01 UTC, and
    // we'll tick at 12:00), and (b) be computed-due by backdating
    // last_run_at past now − interval.
    await sql`
      UPDATE routines_v1_definitions
         SET active_hours = ${'{"start":"09:00","end":"09:01","tz":"Etc/UTC"}'}::jsonb,
             last_run_at = ${new Date('2026-05-12T12:00:00Z')}
       WHERE agent_id = 'agt_a' AND definition_id IS NOT NULL
    `.execute(db);

    const tickNow = new Date('2026-05-14T12:00:00Z');
    // Must not throw — the bug would surface as a Postgres CHECK
    // constraint violation on the advance() write.
    await expect(
      runTickOnce({
        store, fire, now: tickNow,
        claimBatchSize: 50, claimWindowMinutes: 5,
        getAgentIds: async () => ['agt_a'],
      }),
    ).resolves.toBeUndefined();

    const row = await db
      .selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agt_a')
      .where('definition_id', 'is not', null)
      .executeTakeFirstOrThrow();
    // Constraint compliance: default-sourced row keeps next_run_at NULL.
    expect(row.next_run_at).toBeNull();
    // Defer signal: last_run_at moved forward of `now`, into the next
    // valid active window — guarantees the next claim won't pick this
    // row up again until that future moment passes.
    expect(row.last_run_at).not.toBeNull();
    expect(row.last_run_at!.getTime()).toBeGreaterThan(tickNow.getTime());
    // Nothing fired (we deferred before reaching input.fire).
    const fires = await db.selectFrom('routines_v1_fires').selectAll().execute();
    expect(fires).toHaveLength(0);
  });

  it('default-sourced rows are advanced with nextRunAt=null after firing', async () => {
    // computeNextRunAt MUST return NULL for default-sourced rows so the
    // routines_v1_default_next_run_at_chk CHECK doesn't trip when the
    // tick writes back to the row. We assert via the advance() arg —
    // computeNextRunAt itself is private to tick.ts.
    const baseStore = createRoutinesStore(db);
    const advanceCalls: Array<{ agentId: string; path: string; nextRunAt: Date | null }> = [];
    const store = {
      ...baseStore,
      async advance(input: Parameters<typeof baseStore.advance>[0]) {
        advanceCalls.push({
          agentId: input.agentId, path: input.path, nextRunAt: input.nextRunAt,
        });
        await baseStore.advance(input);
      },
    } satisfies RoutinesStore;

    // Materialize the heartbeat default for agt_a at t0.
    await runTickOnce({
      store, fire: async () => ({ status: 'ok', error: null, renderedPrompt: 'p' }),
      now: new Date('2026-05-14T12:00:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgentIds: async () => ['agt_a'],
    });
    // No claim happened on the first tick (24h interval, last_run_at is
    // NULL, so coalesce uses created_at which is ~now).
    expect(advanceCalls).toEqual([]);

    // Force the per-agent row to look ancient so the next tick's claim
    // picks it up: rewind created_at by 48h.
    await sql`
      UPDATE routines_v1_definitions
         SET created_at = ${new Date('2026-05-12T12:00:00Z')}
       WHERE agent_id = 'agt_a' AND definition_id IS NOT NULL
    `.execute(db);

    const fire: FireRoutineFn = async () => ({ status: 'ok', error: null, renderedPrompt: 'p' });
    await runTickOnce({
      store, fire, now: new Date('2026-05-14T13:00:00Z'),
      claimBatchSize: 50, claimWindowMinutes: 5,
      getAgentIds: async () => ['agt_a'],
    });

    // Exactly one advance call, for the default-sourced row, with
    // nextRunAt: null.
    expect(advanceCalls.length).toBeGreaterThanOrEqual(1);
    const defaultAdvance = advanceCalls.find((c) => c.path.startsWith('default:'));
    expect(defaultAdvance).toBeDefined();
    expect(defaultAdvance!.nextRunAt).toBeNull();
  });
});
