import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { createLogger } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createTestHarness, startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import type { Clock } from '../clock.js';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
import { runTickLoop } from '../tick.js';
import type { AcceptedDispatch } from '../types.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { failQueries } from './support/fail-query.js';
import { createInput, now, resetRoutineTables } from './store-fixture.js';

// TASK-1048: Postgres ends the tick leader's session between two ticks (a
// restart, a failover, an admin's pg_terminate_backend). This file runs the
// real database plugin, not `fixture()`: that builds a raw pg.Pool with no
// 'error' listener at all, so it can't show whether a dropped connection
// crashes the host.

let container: StartedPostgreSqlContainer;
let connectionString: string;
let harness: Awaited<ReturnType<typeof createTestHarness>>;
let db: Kysely<RoutinesDatabase>;
const dbLines: string[] = []; // the database plugin's own log, as JSON lines
beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
  const logger = createLogger({ reqId: 'database-test', writer: (line) => { dbLines.push(line); } });
  harness = await createTestHarness({ plugins: [createDatabasePostgresPlugin({ connectionString, logger })] });
  ({ db } = await harness.bus.call<unknown, { db: Kysely<RoutinesDatabase> }>('database:get-instance', harness.ctx(), {}));
  await runRoutinesMigration(db);
}, 120_000);
beforeEach(async () => { await resetRoutineTables(db); dbLines.length = 0; });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await harness?.close(); if (container) await stopPostgresContainer(container); }, 60_000);

const due = new Date(now.getTime() + 60_000); // createInput()'s 60 s interval: first due a minute after it is saved
const result = { status: 'ok' as const, error: null, renderedPrompt: 'done', recordedAtTurnEnd: true };
const entries = (lines: string[]) => lines.map((line) => { const { ts: _ts, reqId: _reqId, ...entry } = JSON.parse(line) as Record<string, unknown>; return entry; });
const CLIENT_LINE = { level: 'error', msg: 'database_postgres_client_error', code: '57P01', name: 'error' };

/** A clock whose sleeps wait for the test, so a session can be ended between two ticks. */
function gatedClock(start: Date) {
  let current = start;
  const sleeps: number[] = [];
  let wake: (() => void) | undefined;
  const clock: Clock = {
    now: () => current,
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      sleeps.push(ms);
      const finish = () => { signal.removeEventListener('abort', finish); wake = undefined; resolve(); };
      if (signal.aborted) return finish();
      wake = finish;
      signal.addEventListener('abort', finish, { once: true });
    }),
  };
  return { clock, sleeps, setNow(to: Date) { current = to; }, wake() { wake?.(); } };
}

/** Sessions holding a granted advisory lock. While the loop waits, the tick's is the only one. */
async function lockHolders(admin: pg.Client): Promise<number[]> {
  return (await admin.query<{ pid: number }>(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted`)).rows.map((r) => r.pid);
}

async function startLoop() {
  // Stands in for the host. Production has no uncaughtException handler, so an
  // 'error' nobody listens for ends the process. vitest stays quiet while
  // another listener exists, so this list is the only witness.
  // The listeners go on after the last setup step that can throw, and come
  // off in stop() before it waits for the loop, so neither a failed setup nor
  // a hung loop leaves them hiding errors from the rest of the file.
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => { uncaught.push(err); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  const stderr = captureExpectedStderr((message) => message.startsWith('[ax/routines]'));
  const tickLines: string[] = [];
  const logger = createLogger({ reqId: 'tick-test', writer: (line) => { tickLines.push(line); } });
  const gate = gatedClock(now);
  const fire = vi.fn(async (_d: AcceptedDispatch) => result);
  const controller = new AbortController();
  const loop = runTickLoop({
    db, fire, getAgents: async () => [], logger, clock: gate.clock, signal: controller.signal,
    tickIntervalMs: 5_000, electionRetryMs: 50_000, claimBatchSize: 50, claimWindowMinutes: 5,
  });
  return {
    uncaught, stderr, gate, fire, admin, tickLog: () => entries(tickLines), tickText: () => tickLines.join('\n'),
    /** The one lock holder once the loop has begun its `n`th wait. */
    async leaderWhileWaiting(n: number) {
      await expect.poll(() => gate.sleeps.length).toBe(n);
      const holders = await lockHolders(admin);
      expect(holders).toHaveLength(1);
      return holders[0]!;
    },
    /** Ends a session the way a failover or an admin does, then waits until its client has heard. */
    async endSession(pid: number) {
      // With a timeout, Postgres answers only once that backend has exited, so
      // its advisory lock is gone before the loop can run the election again.
      const { rows } = await admin.query<{ ended: boolean }>('SELECT pg_terminate_backend($1, 10000) AS ended', [pid]);
      expect(rows).toEqual([{ ended: true }]);
      await expect.poll(() => dbLines.length + uncaught.length).toBeGreaterThan(0);
    },
    async stop() {
      controller.abort();
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
      try { await loop; } finally { await admin.end(); }
    },
  };
}

describe('tick leader when Postgres ends its session (TASK-1048)', () => {
  it('survives, logs one code-only line, re-elects and fires a due routine on a later tick', async () => {
    const row = await createRoutinesStore(db).createAuthored(createInput('session-loss'));
    const run = await startLoop();
    try {
      const oldLeader = await run.leaderWhileWaiting(1); // the first tick ran at `now`: nothing was due
      await run.endSession(oldLeader);
      run.gate.setNow(due);
      run.gate.wake();
      await expect.poll(() => run.gate.sleeps.length).toBe(2);
      expect(run.uncaught).toEqual([]);
      expect(entries(dbLines)).toStrictEqual([CLIENT_LINE]);
      expect(run.tickLog()).toEqual([]);
      expect(run.stderr.messages).toEqual([]);
      const holders = await lockHolders(run.admin);
      expect(holders).toHaveLength(1);
      expect(holders[0]).not.toBe(oldLeader);
      expect(run.fire).toHaveBeenCalledOnce();
      expect(run.fire.mock.calls[0]![0].row.routineId).toBe(row.routineId);
    } finally { await run.stop(); }
  });

  it('rides out a restart: the first re-election fails, waits one tick, then recovers (with TASK-1041)', async () => {
    const row = await createRoutinesStore(db).createAuthored(createInput('session-loss-restart'));
    const run = await startLoop();
    try {
      const oldLeader = await run.leaderWhileWaiting(1);
      await run.endSession(oldLeader);
      // Postgres is still coming back: the first election after the step-down fails.
      const restore = failQueries(/pg_try_advisory_lock/, Object.assign(new Error('PRIVATE the database system is starting up'), { code: '57P03' }));
      try {
        run.gate.setNow(due);
        run.gate.wake();
        await expect.poll(() => run.gate.sleeps.length).toBe(2);
      } finally { restore(); }
      expect(run.uncaught).toEqual([]);
      // One tick, whether it is TASK-1041's first backoff or a leader's tick;
      // the tick log below is what shows an election failed.
      expect(run.gate.sleeps[1]).toBe(5_000);
      expect(run.tickLog()).toStrictEqual([{ level: 'warn', msg: 'routines_tick_election_failed', code: '57P03', name: 'Error', consecutiveFailures: 1, retryInMs: 5_000 }]);
      run.gate.wake();
      await expect.poll(() => run.gate.sleeps.length).toBe(3);
      expect(entries(dbLines)).toStrictEqual([CLIENT_LINE]);
      expect(run.stderr.messages).toEqual([]);
      expect(`${dbLines.join('\n')}\n${run.tickText()}`).not.toContain('PRIVATE');
      const holders = await lockHolders(run.admin);
      expect(holders).toHaveLength(1);
      expect(holders[0]).not.toBe(oldLeader);
      expect(run.fire).toHaveBeenCalledOnce();
      expect(run.fire.mock.calls[0]![0].row.routineId).toBe(row.routineId);
    } finally { await run.stop(); }
  });
});
