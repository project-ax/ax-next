# TASK-1056: bounded connects for the other Postgres clients, and a statement timeout on both pools. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Postgres that accepts a connection and never answers fails each of our three remaining clients within 5 s, instead of hanging forever. Those clients are session-postgres's pool, session-postgres's LISTEN client and eventbus-postgres's LISTEN client. And a pooled statement that runs, or waits for a lock, longer than 30 s is cancelled by the database, so its connection comes back usable instead of being held forever.

**Architecture:** Constructor options only, plus validated config fields in #1129's shape.
- **Connects:** pg's `connectionTimeoutMillis`, on session-postgres's `pg.Pool` and on both standalone `pg.Client`s. Defaults to 5 000.
- **Statements:** Postgres's server-side `statement_timeout`, sent in the startup packet through pg's `statement_timeout` option. It goes on the two pools only (database-postgres's shared pool and session-postgres's pool). Defaults to 30 000.
- **LISTEN clients** get the connect bound only.
- **Not exempt:** migrations and lock waits. A long migration lifts the bound for itself with `SET LOCAL statement_timeout = 0` inside its own transaction.

**Tech Stack:** TypeScript, pg 8.20.0 / pg-pool 3.13.0, Kysely 0.28.17, vitest 5, testcontainers (`postgres:16-alpine`), `node:net`.

**Spec:** the TASK-1056 card. Decisions, alternatives and follow-ups: `.claude/memory/decisions/2026-11-05-TASK-1056.md`.

## Premise check

Read at 75ad36aa7. Then **MEASURED** with throwaway probes: the worktree's own `pg`, a `node:net` server that accepts and never writes, and a throwaway `postgres:16-alpine`.

- **True: three clients have no connect bound.** They are session-postgres's pool (`packages/session-postgres/src/plugin.ts:726-729`), its LISTEN client (`:742`, connected in `init` at `:759`, after the migration at `:758`), and eventbus-postgres's client (`packages/eventbus-postgres/src/listener.ts:59`). A bare `pg.Client` against the silent server is still connecting after 2 s, and `end()` doesn't settle it. With `connectionTimeoutMillis: 300`, `connect()` rejects at ~302 ms with `Error('timeout expired')`. That error has no code and no cause, and no `'error'` event follows it. That's pg's own Client message. pg-pool's is `Connection terminated due to connection timeout`, so the message tells you which client timed out.
- **True: session-postgres hangs at boot.** Its init went through a proxy that forwards only the first connection. The migration ran on exactly **one** pool connection. The LISTEN client opened the second, and init was still pending after 3 s. Destroying the sockets made init reject at once.
- **Refuted for eventbus: shutdown does not stall.** Its `shutdown()` returned in 0 ms, because the client field is still `null` mid-connect. Instead, two emits shared the one hung attempt and were still pending after 4.5 s, with no log line and no retry. The bus's 120 s call timeout eventually releases callers, but the listener never reconnects. So eventbus is dead until the host restarts.
- **True: nothing bounds a running statement.** No package, preset or chart sets `statement_timeout`, `query_timeout` or any `SET`. `packages/database-postgres/SECURITY.md:29` says so.
- **Server-side `statement_timeout` works the way we need.** Probe results, set to 300 ms:
  - `pg_sleep(2)` through Kysely rejects at ~321 ms. The error is a `DatabaseError` with code `57014` and message `canceling statement due to statement timeout`.
  - The next query on the same `max: 1` pool runs on the **same backend pid** in 1 ms.
  - Inside a transaction, Kysely rolls back and the connection is still usable.
  - A `pg_advisory_xact_lock` wait is cancelled the same way, at ~313 ms.
  - `SET LOCAL statement_timeout = 0` lifts the bound for that transaction only.
  - An idle LISTEN client with it set still received a NOTIFY after 1.5 s, and stayed queryable.
- **Refuted: client-side `query_timeout` doesn't return a usable connection.** It rejects at ~302 ms with a code-less `Query read timeout`. But the server keeps running the statement, and the next query on that pooled connection fails with `Query read timeout` too.

## Global Constraints

- **Connect bounds:**
  - Default `5_000` ms.
  - Fields: session-postgres `checkoutTimeoutMs`, which feeds its pool and its LISTEN client; eventbus-postgres `connectTimeoutMs`.
- **Statement bound:**
  - Default `30_000` ms.
  - Field `statementTimeoutMs`, on database-postgres and session-postgres only. Never on a LISTEN client.
- **Valid values.** Every new field takes a whole number of ms from `1` to `2_147_483_647`. Anything else throws `PluginError({ code: 'invalid-config', plugin: <package name> })`:
  - database-postgres throws from `init`, next to `resolveCheckoutTimeoutMs`.
  - session-postgres and eventbus-postgres throw from the factory, next to their `validateConnectionString` call.
- **No plumbing.** No preset, chart or env wiring. The defaults reach production through `presets/k8s/src/index.ts` unchanged.
- **Not exempt: migrations and lock waits.** Don't add `SET`/`RESET` to any migration runner, and don't add `lock_timeout`, `idle_in_transaction_session_timeout`, `keepAlive` or `query_timeout`. (Decisions rows 2-4.)
- **Files to leave alone.** TASK-1058 is editing them in parallel.
  - The error listeners and log lines: database-postgres `plugin.ts:88-127`, session-postgres `plugin.ts:730-737` and `:743-750`.
  - The test files `database-postgres/src/__tests__/checkout-timeout.test.ts` and `error-handlers.test.ts`, and `session-postgres/src/__tests__/error-handlers.test.ts`.
  - New tests go in new files. The one exception is Task 3's one-line edit to eventbus's `listener-reconnect.test.ts`.
- **Expect a rebase over TASK-1058.** Likely touch points are the config-interface JSDoc and `database-postgres/SECURITY.md:27`. Keep both sides.
- **Docker.**
  - Set `DOCKER_HOST` explicitly (CLAUDE.md).
  - Container start-slot timeouts are environmental: rerun the file.
  - No explicit `beforeAll`/`afterAll` timeouts. TASK-575's guard refuses ones above the package's 60 s `hookTimeout`. The per-test timeouts below are fine.
- **Every new silent server or proxy socket gets `socket.on('error', () => {})`.** pg resets the socket on timeout, and an unhandled `'error'` crashes the worker. Close servers through a promise, because `server.close()` returns the server.

## Review Focus

1. **A statement stuck inside a transaction.** Expected: 57014, the transaction rolls back, and the same connection serves the next caller. Pinned by Task 1 tests 1-2 and Task 2's statement test.
2. **A LISTEN connection idle for hours.** It must keep receiving notifications. Pinned by Task 2's defaults test: the LISTEN client's startup packet carries no `statement_timeout`.
3. **An upgrade migration on a big table that runs past 30 s.** Expected: boot fails with `57014` on every try until a fix ships, and rolling back the image is the recovery. No test can size this. The reviewer should confirm that no migration in this branch's base is near the bound; the audit found each one guarded or small at today's sizes. The recovery recipe is pinned by Task 1's `SET LOCAL` test, and documented in SECURITY.md and the field's JSDoc.
4. **A config value that switches a bound off.** For example `0`: pg skips a falsy `statement_timeout`. Expected: refused at boot or construction. Pinned in every task.
5. **A waiter behind a slow but legitimate lock holder.** For example, routines' webhook admission holds row and advisory locks across `blob:put`. Expected: the waiter fails after 30 s instead of waiting forever. The tick retries next tick, and the webhook answers 503. An agent purge logs and drops, as it already does for any error. There's no deterministic test. Treat a new `57014` in CI as a real long hold, not a flake.

---

### Step 0: commit the planner's outputs

```bash
git add docs/plans/2026-11-05-task-1056-pg-connect-statement-timeouts.md .claude/memory/decisions/2026-11-05-TASK-1056.md
git commit -m "[TASK-1056] plan + decisions: bounded pg connects and a statement timeout"
```

### Task 1: `@ax/database-postgres` cancels a statement after 30 s [tier: integration]

**Files:**
- Modify `packages/database-postgres/src/plugin.ts`:
  - the constants (after `:34`)
  - the config interface (after `checkoutTimeoutMs`, `:39-45`)
  - `init` (`:74`, and the `new pg.Pool({...})` options at `:78-87`)
  - a new helper after `resolveCheckoutTimeoutMs` (`:166-176`)
- Create: `packages/database-postgres/src/__tests__/statement-timeout.test.ts`
- Modify: `packages/database-postgres/SECURITY.md:27` (its last sentence) and `:29` (the whole bullet)

**Interfaces:**
- Produces `DatabasePostgresConfig.statementTimeoutMs?: number` (default `30_000`). Task 2 copies its shape (no import: invariant 2).

- [ ] **Step 1: Write the failing tests in the new file**

Module-scope helpers:
- `unblock`, `harnesses`, the `afterEach` (unblock first, then close) and `instance(config)`: copy them from `checkout-timeout.test.ts:22-41`.
- `errorOf(p: Promise<unknown>): Promise<unknown>` returns `p.then(() => undefined, (e: unknown) => e)`.
- `holdAdvisoryLock(connectionString: string, key: number): Promise<() => Promise<void>>`. It opens a raw `pg.Client`, runs `BEGIN`, then `SELECT pg_advisory_xact_lock($1)`. It returns an idempotent `release` (`ROLLBACK`, then `end()`) and pushes the same `release` onto `unblock`.
- Measure durations with `performance.now()`.

```ts
describe('statement timeout, config', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])(
    'refuses statementTimeoutMs %s at boot', async (value) => {
      await expect(createTestHarness({ plugins: [createDatabasePostgresPlugin({
        connectionString: 'postgres://ax@127.0.0.1:1/ax', statementTimeoutMs: value as number,
      })] })).rejects.toMatchObject({ name: 'PluginError', code: 'invalid-config', plugin: '@ax/database-postgres' });
    });
  // These pass on the unfixed plugin too; they guard the ends of the range.
  it.each([1, 2_147_483_647])('accepts statementTimeoutMs %s', async (value) => {
    await instance({ connectionString: 'postgres://ax@127.0.0.1:1/ax', statementTimeoutMs: value });
  });
});

describe('statement timeout, against a real database', () => {
  // beforeAll/afterAll: startTestContainer(new PostgreSqlContainer('postgres:16-alpine')) and
  // stopPostgresContainer, as checkout-timeout.test.ts:138-149 does.

  it('a statement that runs past the timeout fails with 57014, and the same connection serves the next query', async () => {
    const db = await instance({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000, statementTimeoutMs: 300 });
    const pid = async () => (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)).rows[0]!.pid;
    const before = await pid();
    const started = performance.now();
    const err = await errorOf(sql`SELECT pg_sleep(5)`.execute(db));
    const waited = performance.now() - started;
    expect(err).toMatchObject({ code: '57014', message: 'canceling statement due to statement timeout' });
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(3_000);
    expect(await pid()).toBe(before); // returned to the pool, usable, not replaced
  }, 15_000);

  it('a wait for an advisory lock is bounded too, and the lock is taken once its holder lets go', async () => {
    const db = await instance({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000, statementTimeoutMs: 300 });
    const release = await holdAdvisoryLock(connectionString, 1056);
    const lock = () => db.transaction().execute(async (trx) => { await sql`SELECT pg_advisory_xact_lock(1056)`.execute(trx); });
    const started = performance.now();
    expect(await errorOf(lock())).toMatchObject({ code: '57014' });
    expect(performance.now() - started).toBeLessThan(3_000);
    await release();
    await expect(lock()).resolves.toBeUndefined();
  }, 15_000);

  it('SET LOCAL statement_timeout = 0 lifts the bound for one transaction only (the migration recipe)', async () => {
    const db = await instance({ connectionString, statementTimeoutMs: 300 });
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = 0`.execute(trx);
      await sql`SELECT pg_sleep(0.6)`.execute(trx);
    });
    expect(await errorOf(sql`SELECT pg_sleep(0.6)`.execute(db))).toMatchObject({ code: '57014' });
  }, 15_000);

  it('defaults to 30 seconds', async () => {
    const db = await instance({ connectionString });
    const { rows } = await sql<{ setting: string }>`SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`.execute(db);
    expect(rows[0]?.setting).toBe('30000');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/database-postgres exec vitest run src/__tests__/statement-timeout.test.ts`

Expected:
- **The seven refusals FAIL:** boot resolves.
- **The two accepts PASS.**
- **The sleep test FAILS:** `err` is `undefined`, because the sleep finished after 5 s.
- **The lock test FAILS with `Test timed out in 15000ms`.** The teardown's `ROLLBACK` frees the stuck wait.
- **The recipe test FAILS:** the second sleep resolves.
- **The default test FAILS:** `'0'` is not `'30000'`.

Keep this output for the PR body.

- [ ] **Step 3: Implement it in `plugin.ts`**

- **Constants:** `const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;` and `const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;`. Give the second a comment: Postgres refuses a larger `statement_timeout`, which would fail every connect. New lines only; don't edit `:32-34`.
- **`DatabasePostgresConfig.statementTimeoutMs?: number`.** Its JSDoc says:
  - how long one statement on a pooled connection may run, waiting for a lock included, before Postgres cancels it with SQLSTATE `57014`;
  - the connection stays usable, and a surrounding transaction rolls back;
  - it's a whole number of ms from 1 to 2147483647, default 30000, and maps to pg's `statement_timeout`, which is sent at connect time;
  - a statement that legitimately needs longer, such as a migration on a big table, runs inside a transaction that starts with `SET LOCAL statement_timeout = 0`.
- **`function resolveStatementTimeoutMs(value: unknown): number`.** It goes after `resolveCheckoutTimeoutMs` and has the same shape and range. The message is `` `${PLUGIN_NAME}: statementTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_STATEMENT_TIMEOUT_MS}` ``.
- **`init`:**
  - after `:74`, add `const statementTimeoutMs = resolveStatementTimeoutMs(config.statementTimeoutMs);`.
  - in the Pool options, after `connectionTimeoutMillis: checkoutTimeoutMs,`, add `statement_timeout: statementTimeoutMs,`.
  - put a short `TASK-1056` comment above it. It says the database cancels a statement after this long, a lock wait included, and the connection stays usable. Without it, a stuck statement holds its pool slot forever. Nothing on this pool is exempt; see SECURITY.md.

- [ ] **Step 4: Run and see them pass**

- `pnpm --filter @ax/database-postgres exec vitest run src/__tests__/statement-timeout.test.ts`: all PASS.
- `pnpm --filter @ax/database-postgres test`: PASS.
- `pnpm --filter @ax/database-postgres build`: exit 0. This type-checks `src` and refreshes `dist`, which dependents' tests load.

- [ ] **Step 5: Update `SECURITY.md`** (keep the file's voice)

- **`:27`:** replace its last sentence ("It doesn't bound a query that's already running; see the statement-timeout bullet below for that gap.") with one that says a query that's already running is bounded by the statement timeout below.
- **`:29`:** replace the bullet with **Statement timeout: 30 s (`statementTimeoutMs`).** It says:
  - every pooled connection opens with Postgres's `statement_timeout` set. A statement that runs, or waits for a lock, longer than 30 s is cancelled by the database with `57014`. The connection stays usable, and a surrounding transaction rolls back.
  - without it, a stuck statement held its connection forever, and a pile of them starved the pool.
  - lock waits are bounded on purpose: a waiter that has waited 30 s is stuck behind a holder that's stuck.
  - nothing on this pool is exempt, migrations included. Today's finish far inside 30 s. A statement that legitimately needs longer lifts the bound inside its own transaction with `SET LOCAL statement_timeout = 0`.
  - we don't use pg's client-side `query_timeout`. It gives up on the caller but leaves the statement running and the connection busy, so the next caller on that connection fails too.
  - **known limit:** the database enforces this. If the network to it dies mid-statement, the cancel never arrives, and TCP keepalive isn't configured.

- [ ] **Step 6: Commit**

```bash
git add packages/database-postgres/src/plugin.ts packages/database-postgres/src/__tests__/statement-timeout.test.ts packages/database-postgres/SECURITY.md
git commit -m "[TASK-1056] database-postgres: the database cancels a pooled statement after 30 s, and the connection stays usable"
```

### Task 2: `@ax/session-postgres` bounds its connects and its statements [tier: integration]

**Files:**
- Modify `packages/session-postgres/src/plugin.ts`:
  - constants after `PLUGIN_NAME` (`:56`)
  - `SessionPostgresConfig` (`:58-68`; the new fields go after `poolMax`)
  - a helper after `validateConnectionString` (`:669-685`)
  - the factory (`:689`)
  - `new pg.Pool` (`:726-729`) and `new pg.Client` (`:742`)
- Create: `packages/session-postgres/src/__tests__/timeouts.test.ts`

**Interfaces:**
- Produces `SessionPostgresConfig.checkoutTimeoutMs?: number` (default `5_000`) and `statementTimeoutMs?: number` (default `30_000`).
- Consumes nothing from Task 1. It mirrors the shape with this package's own code.

- [ ] **Step 1: Write the failing tests in the new file**

Module-scope helpers:
- `unblock`, `harnesses` and the `afterEach`: unblock first, then `h.close({ onError: () => {} })`.
- `logger: Logger`: a no-op with `debug`/`info`/`warn`/`error`/`child`, passed to every plugin so tests don't write to stdout.
- `boot(config: SessionPostgresConfig): Promise<TestHarness>`: `createTestHarness` with one session-postgres plugin, pushed onto `harnesses`.
- `errorOf` (Task 1's), and `thrownBy(fn: () => unknown): unknown`, which returns what `fn` throws, or `undefined`.
- `silentServer()`: copy it from `database-postgres/src/__tests__/checkout-timeout.test.ts:43-60`.
- `proxy(forward: number): Promise<{ url: string; acceptedAt: number[]; startup: Array<Record<string, string>> }>`:
  - a `node:net` server on `127.0.0.1:0`.
  - each accepted socket pushes `performance.now()` onto `acceptedAt` and records its parsed startup packet in `startup` (see `parseStartup` below).
  - the first `forward` connections are piped both ways to `container.getHost()`:`container.getPort()`. Later ones are never answered.
  - every socket, upstream included, gets an `'error'` no-op and is destroyed by an `unblock` entry, which then closes the server through a promise.
  - `url` is the container's user, password and database at the proxy's port.
- `parseStartup(chunk: Buffer): Record<string, string>`: the length is `chunk.readInt32BE(0)`. Split `chunk.subarray(8, length - 1)` on `'\0'` into key/value pairs. pg sends no SSL request here, so the first chunk is the StartupMessage; loopback delivers it whole.
- `holdTableLock(): Promise<() => Promise<void>>`: a raw `pg.Client` runs `BEGIN`, then `LOCK TABLE session_postgres_v1_sessions IN ACCESS EXCLUSIVE MODE`. It returns an idempotent `release` (`ROLLBACK`, then `end()`), also pushed onto `unblock`.

```ts
describe('connect timeout, against a database that never answers', () => {
  it("the pool's first connection fails once checkoutTimeoutMs passes, so init fails", async () => {
    const connectionString = await silentServer();
    const started = performance.now();
    await expect(boot({ connectionString, checkoutTimeoutMs: 300, logger }))
      .rejects.toThrow('Connection terminated due to connection timeout'); // pg-pool's message: the pool timed out
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(3_000);
  }, 10_000);

  it('waits 5 seconds when checkoutTimeoutMs is not set', async () => {
    // Same as above, without checkoutTimeoutMs: waited ≥ 4_900 and < 10_000.
  }, 20_000);
});

describe.each(['checkoutTimeoutMs', 'statementTimeoutMs'] as const)('%s at construction', (field) => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])('refuses %s', (value) => {
    expect(thrownBy(() => createSessionPostgresPlugin({ connectionString: 'postgres://ax@127.0.0.1:1/ax', [field]: value } as SessionPostgresConfig)))
      .toMatchObject({ name: 'PluginError', code: 'invalid-config', plugin: '@ax/session-postgres' });
  });
  it.each([1, 2_147_483_647])('accepts %s', (value) => { // vacuous before the fix; guards the range ends
    expect(thrownBy(() => createSessionPostgresPlugin({ connectionString: 'postgres://ax@127.0.0.1:1/ax', [field]: value } as SessionPostgresConfig))).toBeUndefined();
  });
});

describe('against a real database', () => {
  // beforeAll/afterAll: one postgres:16-alpine via startTestContainer / stopPostgresContainer.
  // `connectionString` = container.getConnectionUri(). beforeAll also boots and closes one plugin with
  // the defaults, so the schema exists and later boots' migrations are no-ops, even under a 300 ms bound.

  it("the LISTEN client's connect fails once checkoutTimeoutMs passes, so init fails", async () => {
    const p = await proxy(1); // the migration's one pool connection gets through; the LISTEN client's doesn't
    const err = await errorOf(boot({ connectionString: p.url, checkoutTimeoutMs: 1_000, logger }));
    const rejectedAt = performance.now();
    expect(String((err as Error | undefined)?.message)).toContain('timeout expired'); // pg Client's own message, not pg-pool's
    expect(p.acceptedAt).toHaveLength(2);
    const waited = rejectedAt - p.acceptedAt[1]!;
    expect(waited).toBeGreaterThanOrEqual(800);
    expect(waited).toBeLessThan(3_000);
  }, 15_000);

  it('the LISTEN client waits 5 seconds when checkoutTimeoutMs is not set', async () => {
    // Same as above without checkoutTimeoutMs: waited ≥ 4_800 and < 10_000.
  }, 20_000);

  it('a statement that runs past statementTimeoutMs fails with 57014, and the only connection serves the next call', async () => {
    const h = await boot({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000, statementTimeoutMs: 300, logger });
    const release = await holdTableLock(); // after boot: the migration creates the table
    const call = () => h.bus.call('session:resolve-token', h.ctx(), { token: 'task-1056-no-such-token' });
    const started = performance.now();
    const err = await errorOf(call());
    expect((err as { cause?: { code?: string } } | undefined)?.cause?.code).toBe('57014'); // the bus wraps the DatabaseError
    expect(performance.now() - started).toBeLessThan(3_000);
    await release();
    await expect(call()).resolves.toBeNull(); // poolMax 1: the cancelled statement's connection came back usable
  }, 15_000);

  it('defaults: the pool connects with a 30 s statement_timeout, the LISTEN client with none', async () => {
    const p = await proxy(Number.POSITIVE_INFINITY);
    await boot({ connectionString: p.url, logger });
    expect(p.startup).toHaveLength(2); // [0] = the pool (the migration runs first), [1] = the LISTEN client
    expect(p.startup[0]).toMatchObject({ statement_timeout: '30000' });
    expect(p.startup[1]).not.toHaveProperty('statement_timeout');
  }, 15_000);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/session-postgres exec vitest run src/__tests__/timeouts.test.ts`

Expected:
- **These FAIL with `Test timed out`:** the two silent-server tests, the two LISTEN tests and the statement test. The teardown frees each one: destroying the sockets makes init reject, and the `ROLLBACK` frees the locked read.
- **The 14 refusals FAIL:** nothing is thrown.
- **The accepts PASS.**
- **The defaults test FAILS:** `startup[0]` has no `statement_timeout`.

Keep this output for the PR body.

- [ ] **Step 3: Implement it in `plugin.ts`**

- **Constants after `PLUGIN_NAME`:** `DEFAULT_CHECKOUT_TIMEOUT_MS = 5_000`, `DEFAULT_STATEMENT_TIMEOUT_MS = 30_000` and `MAX_TIMEOUT_MS = 2_147_483_647`. Add a comment: Node turns a longer timer into 1 ms, and Postgres refuses a longer `statement_timeout`.
- **`SessionPostgresConfig`**, after `poolMax`:
  - **`checkoutTimeoutMs?: number`.** Its JSDoc says how long a caller waits for a pooled connection, including a new one the database has to answer. The LISTEN client's connect at boot gets the same bound. It's a whole number of ms from 1 to 2147483647, default 5000, and maps to pg's `connectionTimeoutMillis`.
  - **`statementTimeoutMs?: number`.** Same meaning as database-postgres's: the pool only, `57014`, default 30000. The LISTEN client gets none, because waiting for a notification isn't a statement.
- **`function resolveTimeoutMs(field: 'checkoutTimeoutMs' | 'statementTimeoutMs', value: unknown, fallback: number): number`**, after `validateConnectionString`:
  - `undefined` returns `fallback`.
  - a safe integer from 1 to `MAX_TIMEOUT_MS` is returned as is.
  - anything else throws `PluginError({ code: 'invalid-config', plugin: PLUGIN_NAME, message: \`${PLUGIN_NAME}: ${field} must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}\` })`.
- **The factory**, after `validateConnectionString(config.connectionString);`: resolve both fields once, as `checkoutTimeoutMs` and `statementTimeoutMs` locals. Both constructors use these locals.
- **`new pg.Pool({...})`:** add `connectionTimeoutMillis: checkoutTimeoutMs,` and `statement_timeout: statementTimeoutMs,`. Put a `TASK-1056` comment above them: same reasons as database-postgres's two options.
- **`new pg.Client({...})`:** becomes `new pg.Client({ connectionString: config.connectionString, connectionTimeoutMillis: checkoutTimeoutMs })`. Its comment says:
  - without the bound, a database that never answers hangs `init` forever.
  - no `statement_timeout` here, on purpose. This client only runs LISTEN, UNLISTEN and `pg_notify`, and waiting for notifications isn't a statement.
- **Leave alone** both `'error'` listeners and every log line.

- [ ] **Step 4: Run and see them pass**

- `pnpm --filter @ax/session-postgres exec vitest run src/__tests__/timeouts.test.ts`: all PASS.
- `pnpm --filter @ax/session-postgres test`: PASS.
- `pnpm --filter @ax/session-postgres build`: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/session-postgres/src/plugin.ts packages/session-postgres/src/__tests__/timeouts.test.ts
git commit -m "[TASK-1056] session-postgres: its pool and LISTEN client give up connecting after 5 s, and its statements after 30 s"
```

### Task 3: `@ax/eventbus-postgres` gives up a silent connect after 5 s [tier: integration]

**Files:**
- Modify `packages/eventbus-postgres/src/listener.ts`:
  - the header comment (`:4-14`)
  - `ListenerOptions` (`:18-21`)
  - `connect()` (`:59`)
- Modify `packages/eventbus-postgres/src/plugin.ts`:
  - constants (after `:32`)
  - `EventbusPostgresConfig` (`:34-43`)
  - the factory (`:73`)
  - `new Listener` (`:93-96`)
  - a helper after `validateConnectionString` (`:195-210`)
- Modify: `packages/eventbus-postgres/src/__tests__/listener-reconnect.test.ts:49-52`
- Create: `packages/eventbus-postgres/src/__tests__/connect-timeout.test.ts`
- Modify: `packages/eventbus-postgres/SECURITY.md:30-34` ("Dedicated client + reconnect")

**Interfaces:**
- Produces:
  - `EventbusPostgresConfig.connectTimeoutMs?: number` (default `5_000`).
  - `ListenerOptions.connectTimeoutMs: number`. It's **required**, so no construction is silently unbounded.

- [ ] **Step 1: Write the failing tests in the new file**

Module-scope helpers:
- `unblock`, `harnesses` and the `afterEach`: unblock first, then close.
- `harness(plugin: Plugin): Promise<TestHarness>`: `createTestHarness({ plugins: [plugin] })`, pushed onto `harnesses`.
- `recordingLogger()`: copy `makeRecordingLogger` from `listener-reconnect.test.ts:28-43`.
- `thrownBy` (Task 2's).
- `silentServer(): Promise<{ url: string; accepted: () => number }>`. It's TASK-1049's silent server, plus a count of accepted connections.

```ts
describe('connect timeout, against a database that never answers', () => {
  it('an emit fails once connectTimeoutMs passes, and the listener tries again', async () => {
    const s = await silentServer();
    const log = recordingLogger();
    const h = await harness(createEventbusPostgresPlugin({ connectionString: s.url, connectTimeoutMs: 300, logger: log.logger }));
    const started = performance.now();
    await expect(h.bus.call('eventbus:emit', h.ctx(), { channel: 'task1056', payload: {} })).rejects.toThrow('timeout expired');
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(waited).toBeLessThan(3_000);
    expect(log.records.filter((r) => r.msg === 'eventbus_postgres_listener_connect_failed')).toHaveLength(1);
    // The existing backoff (1 s first) runs again; before the bound, nothing ever retried.
    await expect.poll(() => s.accepted(), { timeout: 3_000 }).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('waits 5 seconds when connectTimeoutMs is not set', async () => {
    // As above with only { connectionString, logger }: waited ≥ 4_900 and < 10_000.
  }, 20_000);

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])('refuses connectTimeoutMs %s at construction', (value) => {
    expect(thrownBy(() => createEventbusPostgresPlugin({ connectionString: 'postgres://ax@127.0.0.1:1/ax', connectTimeoutMs: value as number })))
      .toMatchObject({ name: 'PluginError', code: 'invalid-config', plugin: '@ax/eventbus-postgres' });
  });
  it.each([1, 2_147_483_647])('accepts connectTimeoutMs %s', (value) => { // vacuous before the fix
    expect(thrownBy(() => createEventbusPostgresPlugin({ connectionString: 'postgres://ax@127.0.0.1:1/ax', connectTimeoutMs: value }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/eventbus-postgres exec vitest run src/__tests__/connect-timeout.test.ts`

Expected:
- **The two timing tests FAIL with `Test timed out`.** Destroying the sockets in teardown frees the hung connect.
- **The seven refusals FAIL.**
- **The accepts PASS.**

Keep this output for the PR body.

- [ ] **Step 3: Implement it**

- **`listener.ts`:**
  - `ListenerOptions` gains `connectTimeoutMs: number`, documented as the bound on one connect attempt (pg's `connectionTimeoutMillis`).
  - `connect()` builds `new pg.Client({ connectionString: this.opts.connectionString, connectionTimeoutMillis: this.opts.connectTimeoutMs })`.
  - Add one sentence to the header comment: a connect the database accepts but never answers fails after `connectTimeoutMs` and joins the same backoff chain. Without the bound it hung forever, and every emit and subscribe waited on it.
  - The catch block, the log line and `scheduleReconnect` stay as they are.
- **`plugin.ts`:**
  - Add `DEFAULT_CONNECT_TIMEOUT_MS = 5_000` and `MAX_CONNECT_TIMEOUT_MS = 2_147_483_647`.
  - Add `EventbusPostgresConfig.connectTimeoutMs?: number`. Its JSDoc mirrors Task 2's `checkoutTimeoutMs`, worded for one connect attempt per (re)connect.
  - Add `function resolveConnectTimeoutMs(value: unknown): number` after `validateConnectionString`. It has Task 1's shape and range, with the message `` `${PLUGIN_NAME}: connectTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_CONNECT_TIMEOUT_MS}` ``.
  - In the factory, add `const connectTimeoutMs = resolveConnectTimeoutMs(config.connectTimeoutMs);` after `:73`, and pass it into `new Listener({...})`.
- **`listener-reconnect.test.ts:49-52`:** add `connectTimeoutMs: 1_000` to the `new Listener({...})`. The option is now required. Port 1 refuses at once, so the test is unchanged.
- **`SECURITY.md` "Dedicated client + reconnect":**
  - add a sentence: a connect the database accepts but never answers now fails after `connectTimeoutMs` (5 s) with pg's `timeout expired`, logs the same connect-failed line, and joins the same backoff. Before, one silent attempt hung forever and nothing retried.
  - while there, replace that paragraph's line citations (`listener.ts:84`, `:96-98`) with the names (`scheduleReconnect()`). The citations had already drifted.

- [ ] **Step 4: Run and see them pass**

- `pnpm --filter @ax/eventbus-postgres exec vitest run src/__tests__/connect-timeout.test.ts`: all PASS.
- `pnpm --filter @ax/eventbus-postgres test`: PASS. That includes `listener-reconnect.test.ts`, and the Docker-backed `plugin.test.ts`.
- `pnpm --filter @ax/eventbus-postgres build`: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/eventbus-postgres/src/listener.ts packages/eventbus-postgres/src/plugin.ts packages/eventbus-postgres/src/__tests__/connect-timeout.test.ts packages/eventbus-postgres/src/__tests__/listener-reconnect.test.ts packages/eventbus-postgres/SECURITY.md
git commit -m "[TASK-1056] eventbus-postgres: a connect the database never answers fails after 5 s and the listener retries"
```

## Before the PR

- **Write a patterns shard** (`target=$(scripts/memory-write-target.sh --shard patterns TASK-1056)`, then `mkdir -p "$(dirname "$target")"`). It has three rows:
  - **A pooled statement's bound is Postgres's `statement_timeout`, sent through pg's `statement_timeout` option.** The error is `57014`, and the connection stays usable. A long migration lifts the bound with `SET LOCAL statement_timeout = 0` in its own transaction. pg's client-side `query_timeout` leaves the statement running and the pooled connection busy, so the next caller fails too (measured).
  - **To make a SECOND client's connect hang while the first works, use a `node:net` proxy.** Forward the first N connections to the container and never answer the rest. To read a connection's connect-time settings, parse its StartupMessage at the proxy. See `session-postgres/src/__tests__/timeouts.test.ts`.
  - **Every Postgres client now has a connect bound (TASK-1056).** This supersedes `patterns/2026-11-05-TASK-1049.md` row 2's "a pool built elsewhere … still has the gap".
- **Run the gates:**
  - `pnpm build` and `pnpm lint`.
  - the full gate: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
  - grep both logs for `57014`, `canceling statement` and `timeout expired`. Any hit outside the new files means a dependent's test holds a lock or a statement for more than 30 s. That's Review Focus 5: investigate it, don't rerun.
- **PR body:**
  - **Premise check:** the premise check above, in short.
  - **Red runs:** the `Test timed out` and failed-assertion lines from each task's Step 2. That's the card's "fails (hangs) before its fix" evidence.
  - **Exemptions:** LISTEN clients only, by construction. Migrations and lock waits are not exempt, on purpose; give the one-line reasons and point to decisions row 4.
  - **No boundary review:** no hook or payload change; the fields are construction config.
  - **security-checklist not required:**
    - no sandbox, IPC, plugin-loading, untrusted-input or dependency change.
    - no new connection or destination. Existing connections gain bounds, and no log line is added.
    - the `node:net` servers are test-only and bind `127.0.0.1:0`.
  - **Review Focus:** items 3 and 5, as notes for the reviewer.
  - **Follow-ups:** decisions row 9, (a)-(g).
