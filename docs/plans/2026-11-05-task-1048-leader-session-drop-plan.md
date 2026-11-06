# TASK-1048: Postgres ending the leader's session no longer crashes the host or stops the scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Postgres ends a session that a caller has checked out (a restart, a failover, an admin's `pg_terminate_backend`), the host logs one code-only line instead of crashing. If that session was the routines tick leader's, the leader steps down before its next tick and the election runs again on a fresh connection, so routines keep firing.

**Architecture:** `@ax/database-postgres` attaches an `'error'` listener to each pooled client while the client is checked out, by listening to pg-pool's `'acquire'` and `'release'` events. pg-pool's own listener covers idle time, so this covers exactly the rest. The listener logs `database_postgres_client_error` once per client with `faultLogFields`, and the existing idle-time `database_postgres_pool_error` line becomes code-only too. In `runTickLoop` (tick.ts), the leader runs `SELECT 1` on its pinned session after each sleep between ticks. If the query fails, the leader breaks out of its inner loop: the existing `finally` releases, pg-pool discards the dead client, and the outer loop runs the election again at once.

**Tech Stack:** TypeScript, pg 8.20.0 + pg-pool 3.13.0 + kysely 0.28.17 (testcontainers `postgres:16-alpine`), vitest 5.0.3, `@ax/core` (`faultLogFields`, `createLogger`).

**Spec:** the card (condensed below) and `.claude/memory/decisions/2026-11-05-TASK-1048.md`, which records every decision with its rationale and the alternatives turned down. Row numbers below refer to that file.

## Spec

The card asks for two parts that ship together:

- `database-postgres`: a per-client `'error'` listener on every checked-out or pinned client, so a dropped connection is logged in codes only (`faultLogFields`) and never crashes the process.
- `routines` leader: when the pinned session is lost, step down and let the election run again.
- Acceptance: a DB test terminates the leader's backend. The process survives, one code-only log line is written, a new leader is elected, and a due routine fires on a later tick. The test must be shown to fail (crash) before the fix.

Planning settled the following:

1. Premise confirmed at fa778af8d and **measured again** [row 1]. A checked-out client that is idle between queries throws two uncaught `'error'` events when its backend is terminated: 57P01, then `Connection terminated unexpectedly`. Running `SELECT 1` on that client then rejects within about 1 ms (`not queryable`). The problem is broader than the card says: **any** client still checked out when its socket closes crashes the host. That includes an in-flight query, a transaction, and blob-gc's sweep lock. The database-postgres half fixes all of them.
2. The listener is attached on `'acquire'` and detached on `'release'`, so it is the exact complement of pg-pool's idle listener [row 2]. It logs only the first event per client [row 3]. Measured: an idle kill writes only the pool's line, and a client released before its socket closes writes nothing more.
3. `database_postgres_pool_error` changes to `faultLogFields` here too [row 4]. Lines 65-73 of plugin.ts stay untouched for TASK-1049.
4. Detection is a `SELECT 1` probe after each sleep. On failure the leader steps down and re-elects at once [row 5]. The step-down writes no line of its own. The acceptance's "one code-only log line" is `database_postgres_client_error` [row 6].
5. Each test captures `uncaughtException` itself. vitest 5.0.3 reports nothing while another listener exists, so the capture is what makes "crashes" an assertion [row 7]. The crash proof for the acceptance test rebuilds the base commit's database-postgres, because routines tests import it from `dist/` [row 8].
6. Rule 5: the card was measured, and no stale line made it look true. The two lines this work would leave wrong get fixed in Task 1: `packages/database-postgres/SECURITY.md:19` ("(none today)") and the `logger` JSDoc. The TASK-104 archive note (`.claude/memory/patterns.md:144`) gets a superseding shard row in the Wrap-up [row 10].

## Global Constraints

- **TASK-1049** edits `packages/database-postgres/src/plugin.ts` lines 65-68 (the `new pg.Pool({...})` options). Leave lines 62-73 byte-identical. Only line 1, lines 36-41 and lines 74-76 change, plus the new block inserted after line 77. **TASK-1047** owns `packages/auth-better`.
- Exact log names: `database_postgres_client_error` and `database_postgres_pool_error`, both at `error`, both with bindings exactly `faultLogFields(err)`. Never pass `err`, `err.message`, `String(err)` or `logDetail(err)`: a driver's message can carry a host, a user or a query value.
- The step-down writes no log line. tick.ts's existing stderr lines (`materialize/refresh error:`, `fire failed for`, `tick error:`) and the tests that pin them stay byte-identical.
- `runTickLoop`'s signature does not change. No hook change, no migration, no new dependency, no new config.
- Routines tests load `@ax/database-postgres` from its `dist/` (`packages/routines/vitest.config.ts` has no alias). Run `pnpm --filter @ax/database-postgres build` after every change to it, before you run a routines test.
- Container tests need an explicit `DOCKER_HOST` (CLAUDE.md). Every command below writes it as `DOCKER_HOST=<daemon>`.
- Commands are written as if run from the worktree root, and each Bash call starts a fresh shell. So the placeholders are spelled out, not set as variables. `<daemon>` is the Docker socket URL you use. `<scratch>` is the absolute path of a `TASK-1048/` directory inside your session scratchpad. Create it once with `mkdir -p <scratch>` before the first red run.
- **Before Task 1, commit the planner's two outputs.** The planner writes them and does not commit: `git add docs/plans/2026-11-05-task-1048-leader-session-drop-plan.md .claude/memory/decisions/2026-11-05-TASK-1048.md && git commit -m "[TASK-1048] plan and planning decisions"`.
- `packages/routines` and `packages/database-postgres` keep tests out of `tsc`, so lint every touched test file (`no-unused-vars` is an error in tests).
- Every new or tightened test is run red before its fix, and the red output goes in the PR body (card acceptance, Bug Fix Policy). Save red output as `<scratch>/red-*.txt`.
- No RFC1918 address anywhere under `docs/` (`pnpm test:scripts` rejects it). Memory rows go to `.claude/memory/<kind>/2026-11-05-TASK-1048.md` shards only.
- The full gate is `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` (CLAUDE.md: the plain `pnpm test` stops at the first failing package).

## Review Focus

1. **A Postgres restart drops every connection at once.** Each idle client writes one `database_postgres_pool_error`, a checked-out client writes one `database_postgres_client_error`, both carry codes only, and nothing crashes. Pinned by both Task 1 tests (exact `toStrictEqual` on bindings).
2. **A dying client emits two events** (the server's 57P01, then the socket closing). It must write one line, not two. Pinned by Task 1's checked-out test.
3. **A checked-out listener left attached after release** would log an idle failure a second time. Pinned by Task 1's tightened idle test: its client was checked out once before it went idle.
4. **A session that still answers keeps its leadership.** The probe must not step down on a healthy session. Expect one election across three ticks, one probe before each tick after the first, and none at shutdown. Pinned by Task 2's new `tick.test.ts` test.
5. **The database is still down when the leader steps down** (a restart takes seconds). The re-election fails, logs TASK-1041's `routines_tick_election_failed`, waits one tick, then recovers. It must not loop hot or end. Pinned by Task 2's restart variant.

## File map

| File | Change | Task |
|---|---|---|
| `packages/database-postgres/src/plugin.ts` | checked-out listener, code-only pool line, `logger` JSDoc | 1 |
| `packages/database-postgres/SECURITY.md:19` | "What we log": the two code-only lines | 1 |
| `packages/database-postgres/src/__tests__/error-handlers.test.ts` | tighten idle test, add checked-out test | 1 |
| `packages/routines/src/tick.ts` | probe after each sleep, `sessionAnswers`, comment at :219 | 2 |
| `packages/routines/src/__tests__/store-fixture.ts` | extract `resetRoutineTables` from `fixture()`'s `beforeEach` | 2 |
| `packages/routines/src/__tests__/tick-session-loss.test.ts` | new: acceptance + restart variant on the real database plugin | 2 |
| `packages/routines/src/__tests__/tick.test.ts` | new: a healthy session keeps leadership | 2 |

---

### Task 1: database-postgres logs a dropped checked-out connection in codes instead of crashing the host [tier: sensitive]

**Files:**
- Modify: `packages/database-postgres/src/plugin.ts` (line 1, lines 36-41, lines 74-76, new block after line 77)
- Modify: `packages/database-postgres/SECURITY.md:19`
- Test: `packages/database-postgres/src/__tests__/error-handlers.test.ts`

**Interfaces:**
- Consumes: `faultLogFields(err: unknown): FaultLogFields` from `@ax/core`.
- Produces: the line `database_postgres_client_error` at `error` on the plugin's `logger`, with bindings `faultLogFields(err)`. For a terminated session that is exactly `{ code: '57P01', name: 'error' }` (pg-protocol's DatabaseError sets `name` to `'error'`; measured). `database_postgres_pool_error` gets the same binding shape. `DatabasePostgresConfig` and `database:get-instance` are unchanged.

- [ ] **Step 1: Tighten the idle test.** In `'survives a forced backend termination on the pool (logs, no crash)'`, replace the `poolErrors` filter and its `toBeGreaterThanOrEqual(1)` (lines 110-113) with:

```ts
    // TASK-1048: codes only, and only the pool's line. This client was checked
    // out once (the warm-up query) before it went idle, so a checked-out
    // listener still attached after release would add a second line here.
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'database_postgres_pool_error', { code: '57P01', name: 'error' }],
    ]);
```

- [ ] **Step 2: Add the checked-out test** in the same `describe`, reusing the file's `makeRecordingLogger`, `opened`, `connectionString`, `sql` and `pg`:

```ts
  it("survives Postgres ending a checked-out client's session: one code-only line, no crash (TASK-1048)", async () => {
    const { records, logger } = makeRecordingLogger();
    const h = await createTestHarness({ plugins: [createDatabasePostgresPlugin({ connectionString, logger })] });
    const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', h.ctx(), {});
    opened.push(db);
    // Stands in for the host. Production has no uncaughtException handler, so
    // an 'error' nobody listens for ends the process. vitest stays quiet while
    // another listener exists, so this list is the only witness.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => { unhandled.push(err); };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    let probe: unknown;
    try {
      await db.connection().execute(async (conn) => {
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(conn);
        const admin = new pg.Client({ connectionString });
        await admin.connect();
        try { await admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]); }
        finally { await admin.end().catch(() => {}); }
        // The server's 57P01, then the socket closing: both land while the client is checked out.
        await expect.poll(() => records.length + unhandled.length, { timeout: 10_000 }).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, 200));
        probe = await sql`SELECT 1`.execute(conn).then(() => 'answered', (err: unknown) => err);
      });
      // pg-pool dropped the dead client at release, and the pool still answers.
      expect((await sql<{ one: number }>`SELECT 1::int AS one`.execute(db)).rows).toEqual([{ one: 1 }]);
    } finally {
      process.off('uncaughtException', onUnhandled);
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(probe).toBeInstanceOf(Error); // the caller still sees the failure
    expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
      ['error', 'database_postgres_client_error', { code: '57P01', name: 'error' }],
    ]);
  }, 30_000);
```

- [ ] **Step 3: Run both red.**

Run: `DOCKER_HOST=<daemon> pnpm --filter @ax/database-postgres exec vitest run src/__tests__/error-handlers.test.ts 2>&1 | tee <scratch>/red-task1.txt`
Expected: 2 failed. The idle test's diff shows `{ err: … }` where `{ code: '57P01', name: 'error' }` is expected. The checked-out test fails at `expect(unhandled).toEqual([])`, listing two errors: `terminating connection due to administrator command` (code 57P01) and `Connection terminated unexpectedly`. That second failure is the host crash.

- [ ] **Step 4: Implement in `plugin.ts`.**
  - Line 1: add `faultLogFields` to the `@ax/core` import.
  - Lines 74-76: make the body `bgLogger.error('database_postgres_pool_error', faultLogFields(err));`.
  - Insert this block after line 77, before `kysely = new Kysely…`. The ordering is the whole design, so copy it as written:

```ts
      // TASK-1048: pg-pool listens for a client's 'error' only while the client
      // is idle in the pool. It removes that listener at checkout and puts it
      // back at release. A checked-out client whose session Postgres ends (a
      // restart, a failover, pg_terminate_backend) emits 'error' with nobody
      // listening, and Node turns that into an uncaught exception that ends the
      // host. Kysely adds no listener. So a checked-out client gets one for
      // exactly as long as pg-pool's is off ('acquire' fires before pg-pool
      // removes its own; 'release' fires after it puts it back). The caller
      // still sees the failure: its queries reject, and pg-pool drops the dead
      // client at release. A dying client emits twice (the server's error,
      // then the socket closing); only the first, which carries the SQLSTATE,
      // is logged. Codes only: a driver's message can carry a host, a user or
      // a query value.
      const checkedOutListeners = new WeakMap<pg.PoolClient, (err: Error) => void>();
      pool.on('acquire', (client) => {
        let listener = checkedOutListeners.get(client);
        if (listener === undefined) {
          let reported = false;
          listener = (err) => {
            if (reported) return;
            reported = true;
            bgLogger.error('database_postgres_client_error', faultLogFields(err));
          };
          checkedOutListeners.set(client, listener);
        }
        client.on('error', listener);
      });
      pool.on('release', (_err, client) => {
        const listener = checkedOutListeners.get(client);
        if (listener !== undefined) client.removeListener('error', listener);
      });
```

  - Lines 36-41 (the `logger` JSDoc, from `/**` to `*/` just above `logger?: Logger;`) become: "Optional logger for background connection failures (e.g., a postgres restart in k8s): `database_postgres_pool_error` when an idle pooled connection fails, and `database_postgres_client_error` when a checked-out one does (TASK-1048). Both carry `faultLogFields` codes only. Defaults to a stdout JSON logger tagged `reqId=database-postgres-bg`. Without these listeners, an unhandled 'error' would crash the process."
  - `SECURITY.md:19` becomes: "**What we log.** Nothing about it. The plugin writes two background lines through its `logger` (default: stdout JSON, `reqId=database-postgres-bg`): `database_postgres_pool_error` when an idle pooled connection fails, and `database_postgres_client_error` when a checked-out one does (TASK-1048). Both carry `faultLogFields` codes only, never the message, the stack or the connection string. If a future change adds connection logging, mask the password with the `pg-connection-string` parser before logging."

- [ ] **Step 5: Run green.**

Run: `DOCKER_HOST=<daemon> pnpm --filter @ax/database-postgres test`
Expected: every test passes (`error-handlers.test.ts` 2/2, `plugin.test.ts` unchanged).

- [ ] **Step 6: Build and lint. The build also refreshes the dist that Task 2 imports.**

Run: `pnpm --filter @ax/database-postgres build && pnpm exec eslint packages/database-postgres/src && grep -c database_postgres_client_error packages/database-postgres/dist/plugin.js`
Expected: no tsc or eslint output, and a count of 1 or more.

- [ ] **Step 7: Commit.**

```bash
git add packages/database-postgres/src/plugin.ts packages/database-postgres/SECURITY.md packages/database-postgres/src/__tests__/error-handlers.test.ts
git commit -m "[TASK-1048] database-postgres: a dropped checked-out connection logs one code-only line instead of crashing the host"
```

---

### Task 2: the tick leader steps down when Postgres ends its session, and re-elects [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/tick.ts`: the comment at :219, the probe after :253, `sessionAnswers` beside `releaseAdvisoryLock` (:294)
- Modify: `packages/routines/src/__tests__/store-fixture.ts:17`
- Create: `packages/routines/src/__tests__/tick-session-loss.test.ts`
- Test: `packages/routines/src/__tests__/tick.test.ts` (one new test)

**Interfaces:**
- Consumes (Task 1): `createDatabasePostgresPlugin({ connectionString, logger })` from `@ax/database-postgres` (dist, rebuilt in Task 1 Step 6). It writes `{ level: 'error', msg: 'database_postgres_client_error', code: '57P01', name: 'error' }` when a checked-out session is terminated.
- Produces: `export async function resetRoutineTables(db: Kysely<RoutinesDatabase>): Promise<void>` in `store-fixture.ts`, and a tick.ts-internal `async function sessionAnswers(db: Kysely<RoutinesDatabase>): Promise<boolean>`, which is not exported. `runTickLoop` is unchanged.

- [ ] **Step 1: Extract `resetRoutineTables`.** Move the two statements of `fixture()`'s `beforeEach` (the `TRUNCATE …` list and the `DELETE FROM default_routines_v1 …`) verbatim into the exported `resetRoutineTables(db)`, and have that `beforeEach` call it. The file already imports `Kysely` and `sql`. The fixture-based suites run unchanged in Step 8.

- [ ] **Step 2: Write `tick-session-loss.test.ts`.** It uses its own container and the real database plugin. `fixture()` builds a raw `pg.Pool` with no listeners, so it cannot prove the crash is fixed. Imports: `afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi` from vitest; `PostgreSqlContainer`/`StartedPostgreSqlContainer`; `type Kysely`; `pg`; `createLogger` (`@ax/core`); `createDatabasePostgresPlugin`; `createTestHarness`, `startTestContainer`, `stopPostgresContainer`; `type Clock` (`../clock.js`); `runRoutinesMigration`, `type RoutinesDatabase`; `createRoutinesStore`; `runTickLoop`; `type AcceptedDispatch`; `captureExpectedStderr`; `failQueries`; `createInput`, `now`, `resetRoutineTables` (`./store-fixture.js`).

```ts
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
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => { uncaught.push(err); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  const stderr = captureExpectedStderr((message) => message.startsWith('[ax/routines]'));
  const tickLines: string[] = [];
  const logger = createLogger({ reqId: 'tick-test', writer: (line) => { tickLines.push(line); } });
  const gate = gatedClock(now);
  const fire = vi.fn(async (_d: AcceptedDispatch) => result);
  const admin = new pg.Client({ connectionString });
  await admin.connect();
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
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await expect.poll(() => dbLines.length + uncaught.length).toBeGreaterThan(0);
    },
    async stop() {
      controller.abort();
      await loop;
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
      await admin.end();
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
      expect(run.gate.sleeps[1]).toBe(5_000); // TASK-1041's first backoff: one tick
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
```

- [ ] **Step 3: Write the healthy-session test in `tick.test.ts`** (Review Focus 4). Put it next to the existing loop tests and add `import pg from 'pg'`. It runs on `f.db`, where nothing kills a session.

```ts
  it('keeps leadership while its session answers: one election across three ticks (TASK-1048)', async () => {
    const controller = new AbortController();
    let sleeps = 0;
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    const cleanup = vi.fn(async () => {});
    const log = recordingLogger();
    await runTickLoop({
      db: f.db, fire: vi.fn(async () => result), cleanup, logger: log.logger,
      clock: { now: () => due, sleep: async () => { if (++sleeps >= 3) controller.abort(); } },
      signal: controller.signal, tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 50, claimWindowMinutes: 5,
    });
    const sent = queries.mock.calls.map(([text]) => String(text));
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(sent.filter((text) => text.includes('pg_try_advisory_lock'))).toHaveLength(1);
    expect(sent.filter((text) => text.trim() === 'SELECT 1')).toHaveLength(2); // before ticks 2 and 3; none at shutdown
    expect(log.entries()).toEqual([]);
  });
```

- [ ] **Step 4: The card's crash proof, before any tick.ts change.** Rebuild the base commit's database-postgres, run the new file, then put Task 1 back. These are three separate commands. Run (c) even though (b) fails, because (b) is expected to fail.

(a) Swap in the pre-fix plugin. This refuses to start unless Task 1 is committed, because (c)'s checkout would otherwise discard it. Expected: the last line prints `0`, and the command exits 1, because `grep -c` does that on a zero count.

```bash
git diff --quiet HEAD -- packages/database-postgres && git show fa778af8d:packages/database-postgres/src/plugin.ts > packages/database-postgres/src/plugin.ts && pnpm --filter @ax/database-postgres build && grep -c database_postgres_client_error packages/database-postgres/dist/plugin.js
```

(b) Run the new file against it.

```bash
DOCKER_HOST=<daemon> pnpm --filter @ax/routines exec vitest run src/__tests__/tick-session-loss.test.ts 2>&1 | tee <scratch>/red-acceptance-crash.txt
```

Expected: 2 failed, both at `expect(run.uncaught).toEqual([])`. Each lists a 57P01 `terminating connection due to administrator command` and a `Connection terminated unexpectedly`. That is the host crash.

(c) Put Task 1 back. Expected: a count of 1 or more, then nothing from `git status`.

```bash
git checkout HEAD -- packages/database-postgres/src/plugin.ts && pnpm --filter @ax/database-postgres build && grep -c database_postgres_client_error packages/database-postgres/dist/plugin.js && git status --short packages/database-postgres
```

- [ ] **Step 5: Run red with Task 1 in place.**

Run: `DOCKER_HOST=<daemon> pnpm --filter @ax/routines exec vitest run src/__tests__/tick-session-loss.test.ts src/__tests__/tick.test.ts 2>&1 | tee <scratch>/red-task2.txt`
Expected: 3 failed, everything else in `tick.test.ts` passes.
- The first acceptance test fails at `expect(run.stderr.messages).toEqual([])`. It received `[ax/routines] materialize/refresh error: Client has encountered a connection error and is not queryable` and `[ax/routines] tick error: …not queryable`, because the leader ticked on its dead session.
- The restart variant fails at the tick-log assertion (received `[]`), because no election ever runs again.
- The healthy-session test fails because the probe count is 0 and 2 was expected.

- [ ] **Step 6: Implement in `tick.ts`.**
  - In the comment that starts at :219, replace its first sentence, `Connection-pin the elected ticker's whole lifetime.`, with `Connection-pin the elected ticker's whole term (it ends at shutdown, or when Postgres ends the session: TASK-1048 below).` The rest of that comment stays, re-wrapped if needed.
  - Directly after `await input.clock.sleep(input.tickIntervalMs, input.signal);` (:253), still inside the inner `while`:

```ts
            // TASK-1048: Postgres can end this session at any time (a restart,
            // a failover, an admin's pg_terminate_backend), and the advisory
            // lock goes with it. A client whose session is gone fails every
            // query, so a leader that never checked would fail every tick
            // until the host restarted. So before the next tick, the session
            // must answer. If it can't, step down: the finally below tries the
            // unlock (it fails quietly on a dead client), execute() hands the
            // client back, pg-pool drops it, and the loop above runs the
            // election again at once on a fresh connection. Nothing is logged
            // here: the database plugin logs a dropped connection, in codes.
            if (!input.signal.aborted && !(await sessionAnswers(pinned))) break;
```

  - Beside `releaseAdvisoryLock`: `/** TASK-1048: whether the pinned session still answers. A leader whose session doesn't steps down. */ async function sessionAnswers(db: Kysely<RoutinesDatabase>): Promise<boolean>`. It runs ``sql`SELECT 1`.execute(db)``, returns `true` if that resolves, and returns `false` from a `catch` that swallows the error.
  - Nothing else changes. The callback still returns `true` after the `finally`, which is what makes the outer loop re-elect without a wait. The outer `catch` and the backoff from TASK-1041 are untouched.

- [ ] **Step 7: Run green.**

Run: `DOCKER_HOST=<daemon> pnpm --filter @ax/routines exec vitest run src/__tests__/tick-session-loss.test.ts src/__tests__/tick.test.ts`
Expected: all pass. The existing loop tests in `tick.test.ts` pass unchanged: `cleanup` is still called twice, there are still 2 diagnostics, and `log.entries()` is still `[]`.

- [ ] **Step 8: Run the full package suites, then build and lint.**

Run: `DOCKER_HOST=<daemon> pnpm --filter @ax/routines test && DOCKER_HOST=<daemon> pnpm --filter @ax/database-postgres test && pnpm --filter @ax/routines build && pnpm exec eslint packages/routines/src/tick.ts packages/routines/src/__tests__/tick-session-loss.test.ts packages/routines/src/__tests__/tick.test.ts packages/routines/src/__tests__/store-fixture.ts`
Expected: green, and no tsc or eslint output. A Docker start-slot timeout of about 40 s is environmental: rerun the files that failed.

- [ ] **Step 9: Commit.**

```bash
git add packages/routines/src/tick.ts packages/routines/src/__tests__/tick-session-loss.test.ts packages/routines/src/__tests__/tick.test.ts packages/routines/src/__tests__/store-fixture.ts
git commit -m "[TASK-1048] routines: the tick leader steps down and re-elects when Postgres ends its session"
```

---

## Wrap-up (builder, after both tasks; not a plan task)

- **Patterns shard** `.claude/memory/patterns/2026-11-05-TASK-1048.md`. Commit it on this branch with the PR. Add any builder decisions as new rows in the decisions shard, never in a root archive:
  1. Since TASK-1048, `@ax/database-postgres` logs a checked-out client's dropped connection as `database_postgres_client_error`. Its `pool.on('error')` line (`database_postgres_pool_error`) covers idle clients only. Both are code-only. This supersedes reading the TASK-104 archive note (`patterns.md:144`) as "the plugin pool never crashes": before TASK-1048, a checked-out client whose session ended took the host down. A raw `new pg.Pool` test pool (routines' `fixture()`) still has neither listener, so a test that kills a session builds its db through `createDatabasePostgresPlugin` (see `tick-session-loss.test.ts`).
  2. To prove "no crash" in a DB test, capture `uncaughtException`/`unhandledRejection` for the test's duration and assert the list is empty. vitest 5 reports nothing while another listener exists, so without that capture a crash shows up only as a run-level "Unhandled Error".
  3. Routines tests import workspace deps such as `@ax/database-postgres` from `dist/`, so rebuild a changed dependency first.
  4. The tick leader runs `SELECT 1` on its pinned session after every sleep between ticks and steps down if it fails. A test that counts the loop's statements sees one probe per tick after the first.
- **PR body:** the three red outputs (`red-task1.txt`, `red-acceptance-crash.txt`, `red-task2.txt`). State that security-checklist is not required: nothing changes in a sandbox, IPC, plugin loading, a dependency or untrusted-input handling, and the change narrows log content to codes pinned by exact-equality tests. State that boundary review is not applicable (no hook change). Note the TASK-1049 overlap from decisions row 4: this PR converts `database_postgres_pool_error`, so TASK-1049 should skip that optional item, and on a rebase conflict in that hunk keep main's version if the two are identical. List the follow-ups from decisions row 11: session-postgres's second pool has the same gap, and blob-gc's sweep lock is now covered.
