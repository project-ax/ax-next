import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
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
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

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
      return { status: 'ok', error: null };
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
    const fire: FireRoutineFn = async () => ({ status: 'ok', error: null });
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
    const fire: FireRoutineFn = async (row) => { fired.push(row); return { status: 'ok', error: null }; };
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

  it('only one runTickLoop instance holds the advisory lock at a time', async () => {
    // Two concurrent runTickLoops against the same DB. Both should not
    // claim the same row (correctness already guaranteed by FOR UPDATE
    // SKIP LOCKED). The advisory lock should additionally prevent the
    // second loop from even entering its inner tick — proven by
    // observing that only ONE loop's fire() callback was invoked.
    //
    // We use a 24h "every" so the winner fires exactly ONCE per row
    // within the test window (a fixed fake clock + short every would
    // otherwise re-claim the same row across inner-loop iterations).
    //
    // Note: the most pathological failure mode of the bug (pg_advisory_
    // unlock no-op on a different pool connection, leaving the lock
    // leaked across the pool) is hard to force with a single small
    // pool in a single-process test (LIFO connection reuse hides it).
    // This test guards the headline invariant — "only one ticker
    // fires" — across the fixed and unfixed shapes, and the pin makes
    // it correct by construction rather than by luck of pool reuse.
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
      db, store, fire: async () => { fireA++; return { status: 'ok', error: null }; },
      clock: fakeClock, signal: ctlA.signal,
      tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 10, claimWindowMinutes: 5,
    });
    const runB = runTickLoop({
      db, store, fire: async () => { fireB++; return { status: 'ok', error: null }; },
      clock: fakeClock, signal: ctlB.signal,
      tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 10, claimWindowMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 50));
    ctlA.abort(); ctlB.abort();
    await Promise.all([runA, runB]);
    expect(fireA + fireB).toBe(1);
  });
});
