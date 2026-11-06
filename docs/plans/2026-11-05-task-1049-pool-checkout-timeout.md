# TASK-1049: a bounded wait for a shared-pool connection. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A caller that can't get a connection from `@ax/database-postgres`'s shared pool within 5 s gets an ordinary error instead of waiting forever. The routines tick loop then logs one code-only line and retries, and host shutdown can't hang on a checkout any more.

**Architecture:** One pg-pool option, `connectionTimeoutMillis`, set from a new validated `DatabasePostgresConfig.checkoutTimeoutMs` (default 5 000). pg-pool applies it to both ways a checkout hangs: waiting behind a full pool, and opening a new connection the database never answers. TASK-1041's election guard (`packages/routines/src/tick.ts:260-273`) already turns a rejected checkout into one `faultLogFields` warn line plus a capped backoff, so routines only needs tests.

**Tech Stack:** TypeScript, pg 8.20.0 / pg-pool 3.13.0, Kysely 0.28.17, vitest 5, testcontainers (`postgres:16-alpine`), `node:net`.

**Spec:** the TASK-1049 card. Decisions and rejected alternatives are in `.claude/memory/decisions/2026-11-05-TASK-1049.md`.

## Premise check

Checked by reading the code at fa778af8d. Four throwaway probes then **MEASURED** the pool and the tick loop. Each used the worktree's own `pg` against a `node:net` server that accepts connections and never answers, with no Docker:
- **Today's pool (no timeout):** after 3 s, both the new connection and a caller queued behind it are still pending. `pool.end()` is still pending after 1 s. Once the server's sockets are destroyed, the new connection rejects, but **the queued caller never settles, even though the pool has ended and has no clients left.**
- **With `connectionTimeoutMillis: 300`, `max: 1`:**
  - The queued caller rejects at 305 ms with `timeout exceeded when trying to connect`. It has no cause, no `code`, and `faultLogFields` → `{"name":"Error"}`.
  - The new connection rejects at 308 ms with `Connection terminated due to connection timeout`. Its cause is `Connection terminated unexpectedly`, it has no `code`, and `faultLogFields` → `{"name":"Error","causeName":"Error"}`.
  - Afterwards `totalCount` and `waitingCount` are both 0.
- **Through the tick loop:** a third probe ran routines' built `runTickLoop` on a Kysely over that bounded pool. The election's checkout timed out at 307 ms. The loop wrote exactly one line, `{"name":"Error","causeName":"Error","consecutiveFailures":1,"retryInMs":1000,"level":"warn","msg":"routines_tick_election_failed"}` (ts and reqId dropped), with no message text, then slept the 1 000 ms backoff and ended on abort. That probe took the new-connection path. Task 2's held connection takes the queued path, so its line has no `causeName`.
- **Abort while queued** (a fourth probe, `systemClock`): the election checkout is queued behind the pool's only connection (`waitingCount` 1) when the abort lands.
  - With the bound, the loop ends 280 ms after the abort, having written 1 line.
  - Without it, the loop is still running 3 000 ms after the abort, with 0 lines.

Only the kernel step (routines is `joined`, so the host waits for it until SIGKILL) is checked by reading alone. What the reading found:

- **True: the wait is unbounded.** `packages/database-postgres/src/plugin.ts:65-68` builds `new pg.Pool({ connectionString, max })` without `connectionTimeoutMillis`. No production code in the repo sets that option; `git grep` finds it only in routines test fixtures. In pg-pool 3.13.0, a falsy value means a caller queued behind a full pool gets no timer (`node_modules/.pnpm/pg-pool@3.13.0_pg@8.20.0/node_modules/pg-pool/index.js:206-208`), and neither does a new connection (`:250`). `pool.end()` never rejects queued callers: `_pulseQueue`'s ending branch (`:133-145`) only drops idle clients. So a queued caller keeps waiting even after the pool has ended.
- **True: the wait can outlast the 30 s grace period.** The grace period is `deploy/charts/ax-next/values.yaml:109`, used by `templates/host/deployment.yaml:39`. The kernel gives each plugin's `shutdown()` 10 s (`packages/core/src/bootstrap.ts:6`). Routines, though, is `shutdownMode: 'joined'` (`packages/routines/src/plugin.ts:48`), so the kernel keeps waiting for it (`bootstrap.ts:218`). Its shutdown runs `abortCtl.abort(); await tickLoop;` (`plugin.ts:406-407`). The abort can't end a pending checkout, because neither Kysely nor pg-pool accepts a signal. A hung election checkout therefore holds the whole shutdown until SIGKILL.
- **True: a timed-out checkout reaches TASK-1041's path.** Kysely's `DefaultConnectionProvider.provideConnection` awaits `acquireConnection()` (which calls `pool.connect()`) before its `try` (`kysely@0.28.17/dist/esm/driver/default-connection-provider.js`). The rejection therefore comes out of `db.connection().execute(...)` and lands in `tick.ts:260`'s catch. That catch runs `logger.warn('routines_tick_election_failed', …)`, then the backoff, then a retry.
- **Adjusted: the line is code-only, but it has no code.** pg-pool throws plain `Error`s. A queued caller gets `new Error('timeout exceeded when trying to connect')` (`index.js:224`). A new connection gets `new Error('Connection terminated due to connection timeout', { cause })` (`:276`), and its cause carries no code either. `faultLogFields` (`packages/core/src/fault-code.ts:54-76`) reads only codes and class names, so the line says `name: 'Error'`, plus `causeName: 'Error'` for a new connection. That is still exactly one line, with no message in it. Tagging the error with a code is a follow-up, not part of this card (decisions row 6).
- **Refuted: the optional code-only conversion isn't cheap.** Outside `tick.ts`, routines has 10 lines that write raw error text: `capture.ts:64`, `fire.ts:475`, `plugin.ts:161,182,256,284,305,325` and `tools.ts:46,73`. (`fire.ts:465` logs the fixed run text, not the error.) Only three of them have tests: `capture.ts:64` (`capture.test.ts`) and `tools.ts:46,73` (`report-tool.test.ts` with `support/report-log.ts`, which expects the hook's message on purpose). Each of the other seven would need a new test that injects a private message, as TASK-1041 and TASK-1044 did. There's also `database_postgres_pool_error` (`database-postgres/src/plugin.ts:73-77`, right beside TASK-1048's edit) and session-postgres's two pool lines. That's a card of its own (decisions row 7).

## Global Constraints

- **Default and range.** The default checkout timeout is `5_000` ms. The config field is `checkoutTimeoutMs`: a whole number of ms from `1` to `2_147_483_647`. Boot refuses anything else with `PluginError({ code: 'invalid-config', plugin: '@ax/database-postgres' })`.
- **No plumbing.** No preset, chart or env wiring for the new field. Nothing sets `poolMax` from env either.
- **Files to leave alone.** Don't edit these:
  - `packages/routines/src/tick.ts` and the `pool.on('error')` listener with the comment above it (`plugin.ts:69-77`). The card names both as TASK-1048's.
  - `packages/routines/src/__tests__/tick.test.ts` and `packages/database-postgres/src/__tests__/error-handlers.test.ts`. They test exactly that code, so TASK-1048 will likely edit them next.
  - `packages/routines/src/__tests__/store-fixture.ts`. It's shared test support, and those tests use it.

  New tests go in new files.
- **Rebuild before routines tests.** Routines tests load `@ax/database-postgres` from its built `dist`: the package `exports` point there and there's no vitest alias. After any change under `packages/database-postgres/src`, run `pnpm --filter @ax/database-postgres build` before a routines test, or that test runs the old code.
- **Docker.** Docker-backed tests need an explicit `DOCKER_HOST` (CLAUDE.md, "Docker-backed tests"). The silent-server and boot tests in Task 1 don't need Docker. Docker start-slot timeouts under parallel builders are environmental: rerun the failed file.
- **Out of scope** (follow-ups in the decisions shard):
  - a query that's already running and never answers. That needs a statement timeout.
  - session-postgres's own pool and LISTEN client, and eventbus-postgres's client. Same gap, other packages.
  - tagging pg-pool's errors with a code.
  - the code-only conversion.

## Review Focus

1. **A caller that timed out must never get a connection later.** If the pool handed the next free connection to a caller that had already given up, that slot would be gone for good. Expected: the next caller gets it. Pinned in Task 1: with `poolMax: 1`, the query after the timeout must succeed.
2. **Shutdown starts while the election is waiting.** The abort alone can't end the wait. Expected: the loop ends as soon as the checkout times out, well inside 30 s. Pinned in Task 2, test 2.
3. **A database that accepts the connection and then says nothing.** For example, a hung Postgres, or a proxy whose upstream is gone. Expected: the same bound as a full pool. Pinned in Task 1 by the silent server.
4. **A config value that switches the bound off or breaks it.** pg reads `0` as "no timeout", and Node turns any delay over 2147483647 ms into 1 ms. Expected: boot refuses both. Pinned in Task 1.
5. **A loaded but healthy host whose callers wait more than 5 s for a connection.** They now get errors instead of slow answers. There's no deterministic test for this. 104 test files boot `createDatabasePostgresPlugin` with the default, and 23 packages depend on it directly, so CI's affected-packages run covers it broadly. Treat a new `timeout exceeded when trying to connect` failure there as real pool starvation (memory: "flaky test may be a real bug"), not as a flake to rerun.

---

### Task 1: `@ax/database-postgres` bounds the wait for a connection [tier: integration]

**Files:**
- Modify: `packages/database-postgres/src/plugin.ts`:
  - the config interface (`:33-43`)
  - constants next to `PLUGIN_NAME` (`:31`)
  - `init` (`:61-68`)
  - a new helper after `validateConnectionString` (`:99-114`)
- Create: `packages/database-postgres/src/__tests__/checkout-timeout.test.ts`
- Modify: `packages/database-postgres/SECURITY.md`:
  - `:22-28` ("Pool sizing and resource limits")
  - `:39` (the first "Known limits" bullet)

**Interfaces:**
- Produces: `DatabasePostgresConfig.checkoutTimeoutMs?: number`. Task 2 calls `createDatabasePostgresPlugin({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000 })`.

- [ ] **Step 1: Write the failing tests in the new file**

Put these helpers at module scope:
- `unblock: Array<() => void | Promise<void>>` and `harnesses: TestHarness[]`. `afterEach` empties both as it runs them, unblocking first: `for (const f of unblock.splice(0)) await f();`, then `for (const h of harnesses.splice(0)) await h.close();`.
  - The order matters: a pool can't end while one of its connections is held or still connecting.
  - The `splice(0)` matters too. Without it, the next teardown re-runs an old entry, for example closing a server that has already stopped.
- `instance(config: DatabasePostgresConfig): Promise<Kysely<unknown>>`. It boots `createTestHarness({ plugins: [createDatabasePostgresPlugin(config)] })`, pushes the harness onto `harnesses`, and returns `db` from `database:get-instance`. Use the call shape from `plugin.test.ts:45-49`.
- `silentServer(): Promise<string>`. A `node:net` server on `127.0.0.1`, port `0`, that accepts connections and never writes anything.
  - Track the accepted sockets.
  - Give each socket `socket.on('error', () => {})`. The client resets the socket when it times out, and an unhandled `'error'` would crash the worker.
  - Push onto `unblock` a function that destroys every socket and then awaits `new Promise<void>(r => server.close(() => r()))`. A bare `await server.close()` waits for nothing, because `close()` returns the server, not a promise.
  - Return `postgres://ax:unused@127.0.0.1:<port>/ax`.
- `holdOnlyConnection(db): Promise<{ release: () => void; holder: Promise<void> }>`.
  - Start `holder = db.connection().execute(async () => { held(); await gate; })`.
  - Push the gate's `release` onto `unblock`, then `await Promise.race([held, holder])`. If the hold's own connect fails, the test then fails at once with that error, instead of a 15 s timeout plus an unhandled rejection.
  - Return `release` and `holder`.
- Measure every duration with `performance.now()`.

```ts
describe('checkout timeout, against a database that never answers', () => {
  it('a new connection the database never answers fails once the timeout passes', async () => {
    const db = await instance({ connectionString: await silentServer(), checkoutTimeoutMs: 300 });
    const started = performance.now();
    await expect(sql`SELECT 1`.execute(db)).rejects.toThrow('Connection terminated due to connection timeout');
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(3_000);
  }, 10_000);

  it('waits 5 seconds when checkoutTimeoutMs is not set', async () => {
    const db = await instance({ connectionString: await silentServer() });
    // Same rejection as above; then:
    expect(waited).toBeGreaterThanOrEqual(4_900);
    expect(waited).toBeLessThan(10_000);
  }, 20_000);

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])(
    'refuses checkoutTimeoutMs %s at boot', async (value) => {
      await expect(createTestHarness({ plugins: [createDatabasePostgresPlugin({
        connectionString: 'postgres://ax@127.0.0.1:1/ax', checkoutTimeoutMs: value as number,
      })] })).rejects.toMatchObject({ name: 'PluginError', code: 'invalid-config', plugin: '@ax/database-postgres' });
    });

  it.each([1, 2_147_483_647])('accepts checkoutTimeoutMs %s', async (value) => {
    // Boots; the pool is lazy, so nothing connects.
    await instance({ connectionString: 'postgres://ax@127.0.0.1:1/ax', checkoutTimeoutMs: value });
  });
});

describe('checkout timeout, against a real database', () => {
  // beforeAll / afterAll: start postgres:16-alpine with startTestContainer and stop it
  // with stopPostgresContainer, as plugin.test.ts:17-37 does.
  it('a caller waiting for the only connection fails once the timeout passes, and the pool still serves afterwards', async () => {
    const db = await instance({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000 });
    const { release, holder } = await holdOnlyConnection(db);
    const started = performance.now();
    await expect(sql`SELECT 1`.execute(db)).rejects.toThrow('timeout exceeded when trying to connect');
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(3_000);
    release();
    await holder;
    // A caller that gave up must not have taken the slot:
    expect((await sql<{ one: number }>`SELECT 1::int AS one`.execute(db)).rows[0]?.one).toBe(1);
  }, 15_000);
});
```

Why the values differ between the two `describe`s:
- **A pool that talks to the container uses 1 000 ms, not 300 ms.** The bound also covers opening that pool's first real connection inside `holdOnlyConnection`: TCP, the SCRAM login and `readyForQuery`. On a loaded CI runner that can take longer than 300 ms. The repo's other real-database pools use 1 500–2 000 ms for the same reason (`routines/src/__tests__/repeat-admission-pool.test.ts:9`, `task-events-store.test.ts:10`, `webhook-address-store.test.ts:9`).
- **The silent-server tests keep 300 ms**, because nothing real connects there.

The 3 000 ms ceiling is deliberately below the 5 000 ms default, so a plugin that ignored the configured value would fail it. The two error messages are pg-pool 3.13.0's own, and they tell you which path ran: the queued caller or the new connection.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @ax/database-postgres exec vitest run src/__tests__/checkout-timeout.test.ts`
Expected:
- The three timing tests FAIL with `Test timed out in …ms`, because the pool waits forever.
- All seven refusal cases FAIL, because boot resolves.
- The two accept cases PASS.

The `afterEach` order lets the run finish anyway: releasing the gate or destroying the sockets frees the stuck calls.

- [ ] **Step 3: Implement it in `plugin.ts`**

- `DatabasePostgresConfig` gains `checkoutTimeoutMs?: number`. Its doc comment says:
  - how long a caller waits for a connection before the call fails with pg's timeout error. That covers a free connection, one another caller hands back, or a new one the database has to answer.
  - it's a whole number of ms from 1 to 2147483647, with a default of 5 000.
  - it maps to pg's `connectionTimeoutMillis`.
- Add `const DEFAULT_CHECKOUT_TIMEOUT_MS = 5_000;` and `const MAX_TIMER_DELAY_MS = 2_147_483_647;` next to `PLUGIN_NAME`.
- Add `function resolveCheckoutTimeoutMs(value: unknown): number` after `validateConnectionString`:
  - `undefined` → the default
  - a safe integer in `[1, MAX_TIMER_DELAY_MS]` → that value. Check `typeof value === 'number'` first, because `Number.isSafeInteger` doesn't narrow `unknown`.
  - anything else → throw `new PluginError({ code: 'invalid-config', plugin: PLUGIN_NAME, message: \`${PLUGIN_NAME}: checkoutTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMER_DELAY_MS}\` })`

  It has the same shape as `validateConnectionString`, and the same range as http-server's `resolveBodyStreamIdleTimeout` (TASK-1016).
- In `init`:
  - On the line after `validateConnectionString(config.connectionString);`, add `const checkoutTimeoutMs = resolveCheckoutTimeoutMs(config.checkoutTimeoutMs);`.
  - In the `new pg.Pool({...})` options, after `max`, add `connectionTimeoutMillis: checkoutTimeoutMs,`. Put a short `TASK-1049` comment above it that says:
    - pg's default of 0 waits forever, both behind a full pool and on a new connection the database never answers.
    - a hung wait can hold host shutdown past the pod's 30 s grace period.
    - 5 s is far above a normal wait and below the kernel's 10 s per-plugin shutdown deadline.
- Change nothing from the `pool.on('error')` comment down to `kysely = …` (TASK-1048's).

- [ ] **Step 4: Run the tests and see them pass**

Run: `pnpm --filter @ax/database-postgres exec vitest run src/__tests__/checkout-timeout.test.ts`. Expected: every test PASSES.
Run: `pnpm --filter @ax/database-postgres test`. Expected: PASS.
Run: `pnpm --filter @ax/database-postgres build`. Expected: exit 0. This type-checks `src` and refreshes `dist`, which Task 2 needs.

- [ ] **Step 5: Update `SECURITY.md`** (keep the file's voice)

- **"Pool sizing and resource limits":** add a bullet after "Default of 10": **Checkout timeout: 5 s (`checkoutTimeoutMs`).** It should say:
  - a caller that can't get a connection within 5 s gets an error instead of waiting. That happens when every connection is checked out, or when a new connection is opened and the database never answers.
  - without the timeout, pg waits forever, and a hung wait could hold the host's shutdown past the pod's 30 s grace period.
  - 5 s sits far above a normal wait and below the kernel's 10 s per-plugin shutdown deadline.
  - it doesn't bound a query that's already running. The statement-timeout bullet below still covers that.
- **"Known limits":** replace the stale `:39` bullet ("No connection draining on shutdown … when the kernel gains a plugin-shutdown lifecycle"). The new bullet says:
  - `shutdown()` destroys the Kysely instance. That ends the pool, and ending the pool waits for checked-out connections to come back.
  - the kernel gives this 10 s, then the host exits, which cuts off a long-running query.
  - a caller still waiting for a connection gets the checkout timeout. pg doesn't reject waiting callers when the pool ends.
- Leave `:19`'s "(none today)" alone. The pool error line it's wrong about belongs to the code-only follow-up, which rewrites that line.

- [ ] **Step 6: Commit**

```bash
git add packages/database-postgres/src/plugin.ts packages/database-postgres/src/__tests__/checkout-timeout.test.ts packages/database-postgres/SECURITY.md
git commit -m "[TASK-1049] database-postgres: a caller waits at most 5 s for a pool connection"
```

### Task 2: routines rides out a real checkout timeout and still shuts down [tier: integration]

**Files:**
- Create: `packages/routines/src/__tests__/tick-checkout-timeout.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's `checkoutTimeoutMs`.
  - `runTickLoop`, with the input TASK-1041 left it (`tick.ts:192-212`).
  - `runRoutinesMigration` (`../migrations.js`).
  - `createRoutinesStore(db, executorId?)` (`store.ts:1071`).
  - `createInput` and `now` (`./store-fixture.js`).
  - `systemClock` (`../clock.js`).

- [ ] **Step 1: Write the tests**

The file sets up its own container at module scope. Don't use `fixture()`: it doesn't expose its URI, and editing `store-fixture.ts` is off limits (see Global Constraints).
- **`beforeAll`** (120 000 ms):
  1. Start `postgres:16-alpine` with `startTestContainer`.
  2. Build `setup`, a Kysely on a plain `pg.Pool` as `store-fixture.ts:14` builds it, and run `runRoutinesMigration(setup)`. Migrations and seed rows never go through the one-connection pool.
  3. Boot `createTestHarness({ plugins: [createDatabasePostgresPlugin({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000 })] })`. Take `db` from `database:get-instance` and cast it to `Kysely<RoutinesDatabase>`, as `routines/src/plugin.ts:122` does.

  Use 1 000 ms, not 300 ms: the bound also covers opening this pool's real connection to the container. Task 1 explains why.
- **`afterEach`:** `for (const f of unblock.splice(0)) f();`, where `unblock: Array<() => void>`.
- **`afterAll`** (60 000 ms), in this order: the harness's `close()`, then `setup.destroy()`, then `stopPostgresContainer`.
- **Helpers:**
  - `recordingLogger()`, copied from `tick.test.ts:29-34`.
  - `const due = new Date(now.getTime() + 60_000)`.
  - `result`, as in `tick.test.ts:12`.
  - `holdOnlyConnection(db): Promise<{ release: () => void; holder: Promise<void> }>`. It starts `holder = db.connection().execute(async () => { held(); await gate; })`, pushes the gate's `release` onto `unblock`, then awaits `Promise.race([held, holder])`. When it returns, the pool's only connection is checked out. If that connect fails instead, the test fails at once with the connect's own error. It returns `release` and `holder`. Task 1's file has the same helper; copy it, since test files don't import each other.

```ts
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
  expect(took).toBeGreaterThanOrEqual(900); // the abort alone can't end a pending checkout
  expect(took).toBeLessThan(3_000);
  expect(log.text()).not.toContain('timeout exceeded');
}, 15_000);
```

Test 2 deliberately doesn't pin how many lines the loop writes. TASK-1041 accepted that a shutdown during a failed election writes one extra warn line (its decisions shard, "Per-task review" row), and TASK-1048 may change that.

- [ ] **Step 2: Prove the tests fail against the unfixed pool**

The routines test reads `database-postgres`'s `dist`, and Task 1 has already rebuilt it.
1. Delete the `connectionTimeoutMillis: checkoutTimeoutMs,` line from `packages/database-postgres/src/plugin.ts`. It still compiles, because the base tsconfig doesn't set `noUnusedLocals`.
2. Run `pnpm --filter @ax/database-postgres build`.
3. Run `pnpm --filter @ax/routines exec vitest run src/__tests__/tick-checkout-timeout.test.ts`. Expected: both tests FAIL with `Test timed out in 15000ms`.
4. Put the line back exactly as it was and rebuild database-postgres.
5. Run `git diff packages/database-postgres`. Expected: empty.

- [ ] **Step 3: Run the tests and see them pass**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/tick-checkout-timeout.test.ts`. Expected: both tests PASS.
Run: `pnpm --filter @ax/routines test`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/routines/src/__tests__/tick-checkout-timeout.test.ts
git commit -m "[TASK-1049] routines: the tick loop rides out a pool checkout timeout and still shuts down"
```

## Before the PR

- Write a patterns shard (`scripts/memory-write-target.sh --shard patterns TASK-1049`) with two reusable tricks:
  - To make a pg checkout genuinely hang without Docker, point the pool at a `node:net` server that accepts connections and never writes. With `max: 1`, a second caller is queued too. Give each server socket an `'error'` listener.
  - A routines test that boots `@ax/database-postgres` runs that package's built `dist`. Rebuild it after changing its `src`, or the test runs the old code.
- Run `pnpm build`, `pnpm lint`, and the full gate: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Plain `pnpm -r run test` stops at the first failing package (CLAUDE.md).
- PR body:
  - The premise check above, in short.
  - The red-run output from Task 1 Step 2 and Task 2 Step 2: the `Test timed out` lines. That's the card's "fails before the fix" evidence.
  - **No boundary review:** no hook or payload changes. `DatabasePostgresConfig` is construction config.
  - **security-checklist not required:**
    - no sandbox, IPC, plugin-loading, untrusted-input or dependency change. `node:net` is a test-only built-in.
    - the change bounds a resource wait.
    - the only log line involved is TASK-1041's code-only line, and Task 2 pins it with `not.toContain('timeout exceeded')`.
  - Review Focus 5 as a note for the reviewer.
  - The follow-ups from the decisions shard (rows 6-8).
