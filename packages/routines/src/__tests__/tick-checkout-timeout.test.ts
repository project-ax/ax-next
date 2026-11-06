import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createLogger } from '@ax/core';
import { createTestHarness, startTestContainer, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
import { systemClock } from '../clock.js';
import { runTickLoop } from '../tick.js';
import type { AcceptedDispatch } from '../types.js';
import { createInput, now } from './store-fixture.js';

// ---------------------------------------------------------------------------
// TASK-1049: the tick loop on database-postgres's own pool, with a checkout
// that really times out. The pool has one connection and the test holds it, so
// the election's checkout queues behind it and pg-pool's timeout fires.
//
// This file starts its own container: fixture() doesn't expose its URI. It
// loads @ax/database-postgres from dist, so rebuild that package after any
// change to its src.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let setup: Kysely<RoutinesDatabase>; // a plain pool: migrations and seed rows never go through the one-connection pool
let harness: TestHarness;
let db: Kysely<RoutinesDatabase>;
const unblock: Array<() => void> = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  const connectionString = container.getConnectionUri();
  setup = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }) });
  await runRoutinesMigration(setup);
  // 1 000 ms, not shorter: the bound also covers opening this pool's real connection.
  harness = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000 })],
  });
  const got = await harness.bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', harness.ctx(), {});
  db = got.db as Kysely<RoutinesDatabase>;
}, 120_000);

afterEach(() => {
  for (const f of unblock.splice(0)) f();
});

afterAll(async () => {
  await harness?.close();
  await setup?.destroy();
  if (container) await stopPostgresContainer(container);
}, 60_000);

const due = new Date(now.getTime() + 60_000);
const result = { status: 'ok' as const, error: null, renderedPrompt: 'done', recordedAtTurnEnd: true };

/** A core logger that keeps its JSON lines; entries() drops ts and reqId. */
function recordingLogger() {
  const lines: string[] = [];
  const logger = createLogger({ reqId: 'tick-checkout-test', writer: line => { lines.push(line); } });
  const entries = () => lines.map(line => { const { ts: _ts, reqId: _reqId, ...entry } = JSON.parse(line) as Record<string, unknown>; return entry; });
  return { logger, entries, text: () => lines.join('\n') };
}

/** Check out the pool's only connection and keep it until `release()`. */
async function holdOnlyConnection(
  conn: Kysely<RoutinesDatabase>,
): Promise<{ release: () => void; holder: Promise<void> }> {
  let held!: () => void;
  const heldP = new Promise<void>(resolve => { held = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = conn.connection().execute(async () => { held(); await gate; });
  unblock.push(release);
  // If the hold's own connect fails, fail now with that error.
  await Promise.race([heldP, holder]);
  return { release, holder };
}

describe('tick loop on a pool whose checkout times out', () => {
  it("keeps scheduling after the pool times out the election's checkout, and logs it once in codes only (TASK-1049)", async () => {
    const row = await createRoutinesStore(setup).createAuthored(createInput());
    const { release, holder } = await holdOnlyConnection(db);
    const controller = new AbortController();
    const sleeps: number[] = [];
    let failedAfterMs = -1;
    const fire = vi.fn(async (_d: AcceptedDispatch) => result);
    const log = recordingLogger();
    const started = performance.now();
    await runTickLoop({
      db, fire, logger: log.logger,
      clock: { now: () => due, sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) { failedAfterMs = performance.now() - started; release(); await holder; }
        if (sleeps.length >= 2) controller.abort();
      } },
      signal: controller.signal, tickIntervalMs: 2_000, electionRetryMs: 50_000, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    expect(failedAfterMs).toBeGreaterThanOrEqual(900);
    expect(failedAfterMs).toBeLessThan(3_000);
    expect(sleeps).toEqual([2_000, 2_000]); // the wait after the timed-out election, then the elected ticker's own tick
    expect(fire).toHaveBeenCalledOnce();
    expect(fire.mock.calls[0]![0].row.routineId).toBe(row.routineId);
    expect(log.entries()).toStrictEqual([{ name: 'Error', consecutiveFailures: 1, retryInMs: 2_000, level: 'warn', msg: 'routines_tick_election_failed' }]);
    expect(log.text()).not.toContain('timeout exceeded');
  }, 15_000);

  it('a shutdown that starts while the election waits for a connection ends once the checkout times out (TASK-1049)', async () => {
    await holdOnlyConnection(db);
    const controller = new AbortController();
    const log = recordingLogger();
    const loop = runTickLoop({
      db, fire: vi.fn(async () => result), logger: log.logger, clock: systemClock,
      signal: controller.signal, tickIntervalMs: 600_000, electionRetryMs: 600_000, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    controller.abort(); // what routines' shutdown does (plugin.ts:406)
    const abortedAt = performance.now();
    await loop;
    const took = performance.now() - abortedAt;
    // The contract is the ceiling: shutdown ends well inside the pod's 30 s grace.
    // The floor only proves the hold really held. It also records today's limit
    // (the abort alone can't end a pending checkout); if a later change makes the
    // election checkout honour abort, lower the floor rather than keep it.
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(3_000);
    expect(log.text()).not.toContain('timeout exceeded');
  }, 15_000);
});
