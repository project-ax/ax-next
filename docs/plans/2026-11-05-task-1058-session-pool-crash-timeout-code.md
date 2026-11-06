# TASK-1058 — session-postgres checked-out crash, checkout-timeout code, code-only routines lines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** If Postgres ends a session-postgres client that is checked out, the host keeps running and writes one line of codes. A starved database-postgres pool's checkout timeout carries the code `db-checkout-timeout`. Every routines error line outside `tick.ts` writes codes only.

**Architecture:** session-postgres copies `@ax/database-postgres`'s per-client listener from TASK-1048 (pg-pool `'acquire'`/`'release'`, a `WeakMap`), and its three background lines go through `faultLogFields`. database-postgres passes Kysely a small `{ connect, end }` adapter around its `pg.Pool`. When `connect()` rejects with one of pg-pool's two timeout errors, the adapter sets `code` on that same error object and rethrows it. Ten routines sites swap `err`/`err.message` for `...faultLogFields(err)`. Three self-made errors carry a code, so those lines keep the fact they would otherwise lose.

**Tech Stack:** TypeScript, pg 8.20.0 / pg-pool 3.13.0, kysely 0.28.17, vitest 5, testcontainers `postgres:16-alpine`.

`<private-ip>` below stands for the RFC1918 literal the tests use (kept out of `docs/` by `no-deployment-specifics-committed.test.js`).

> **Revised in review:** the two pg-pool timeouts got separate codes, `db-checkout-timeout` (a queued caller) and `db-connect-timeout` (an unanswered new connection). Where this plan says "exactly `db-checkout-timeout`" for both, the code and `.claude/memory/decisions/2026-11-05-TASK-1058.md` are authoritative.

**Spec:** board card TASK-1058, plus "What was checked" below. Decisions with rationale and alternatives: `.claude/memory/decisions/2026-11-05-TASK-1058.md`.

## What was checked

At 75ad36aa7, from the code, and **measured** with a throwaway probe. The probe used the worktree's built (unfixed) dist against `postgres:16-alpine` and ran 3 times, with the same result every time:

| Scenario | Uncaught `'error'` | Lines | After |
|---|---|---|---|
| A. session-postgres, `session:create` killed while its INSERT waits on a lock | **1** (`Connection terminated unexpectedly`) = the host crash | none | the call rejects with `PluginError{code:'unknown'}`; the next `session:create` works |
| B. session-postgres, every backend killed (the existing test) | 0 | `session_postgres_pool_error` ×1 (`57P01`), `session_postgres_listen_client_error` ×2 (`57P01`, then the code-less close). All three carry the raw message | — |
| C. a pool with TASK-1048's listener, INSERT killed inside a transaction | 0 | the listener sees exactly 1 event, `{name:'Error'}` | the pool answers |
| D. a pool without the listener, a lone INSERT (no transaction) killed | 0 | pool line `{name:'Error'}` | the pool answers |
| E. a pool without the listener, INSERT killed inside a transaction | **1** | none | the pool answers |

- **Confirmed: the card's crash.** A crash needs a client that is still checked out when its socket closes. A transaction has one: Kysely's ROLLBACK keeps the client checked out (A, E). A lone statement gets released before the close, and pg-pool's idle listener catches it (D). By reading `pg/lib/client.js`, an abrupt drop (RST, pod kill) also emits `'error'` mid-statement while the client is checked out. Both of session-postgres's transactions are exposed: `store.create` (`session:create`) and `store.deleteForAgent` (the `agents:deleted` purge).
- **Confirmed: raw pool lines.** The pool line logs the raw error, and so does the LISTEN client's line (B).
- **Confirmed: timeouts carry no code.** pg-pool rejects a queued caller with `new Error('timeout exceeded when trying to connect')` (`pg-pool/index.js:224`). It rejects a new connection with `new Error('Connection terminated due to connection timeout', { cause })` (`:276`). Neither has a code. Kysely rethrows the same object (`PostgresDriver.acquireConnection`, `DefaultConnectionProvider`, `RuntimeDriver`), and `faultLogFields` reads any identifier-shaped `err.code` (`core/src/fault-code.ts:91`). No product code matches either message today.
- **Adjusted: the routines list.** `decisions/2026-11-05-TASK-1049.md` row 7 counts 10 raw lines outside `tick.ts`. There are 11 sites. It missed `fire.ts:274-277`, where `logFault` writes the whole error (message and stack) for non-webhook fires as `routines_fire_failed` / `routines_fire_invoke_failed`. TASK-1031 did that on purpose: `fire.test.ts:123-133` asserts `err: { message: 'PRIVATE pg text at <private-ip>' }` reaches the log. This plan converts it (Task 4). The PR body must say so.
- **Out of scope (follow-ups):**
  - The three stderr lines in `tick.ts`: the card limits itself to lines outside it.
  - session-postgres's two `agents:deleted` lines (`plugin.ts:1003`, `:1019`).
  - routines-admin-routes' two `console.warn` lines (`plugin.ts:94`, `:119`).
  - Tagging session-postgres's own pool timeouts: that pool has no `connectionTimeoutMillis` until TASK-1056 lands.

## Global Constraints

- Leave session-postgres's `new pg.Pool({...})` (`plugin.ts:726-729`) and `new pg.Client({...})` (`:742`) byte-identical. TASK-1056 owns the constructor options, and this branch will rebase over it.
- A converted line carries ids plus `faultLogFields(err)`. Never `err`, `err.message`, `String(err)` or a stack.
- No cross-plugin runtime imports (invariant 2). session-postgres copies the listener, it doesn't import it. Tests may import `@ax/database-postgres`.
- The three stderr lines in `tick.ts` stay byte-identical.
- The code is exactly `db-checkout-timeout`. pg-pool's message text stays unchanged.
- Routines tests load `@ax/database-postgres` from `dist/`. Rebuild it (`pnpm --filter @ax/database-postgres build`) after changing its `src`.
- Docker tests need `DOCKER_HOST=unix:///var/run/docker.sock` set on the command.
- `pnpm --filter <pkg>` goes before the script name.
- No new per-hook test timeout above the package's 60 s `hookTimeout` (TASK-575 guard).

## Review Focus

1. A connect failure that isn't a timeout (`ECONNREFUSED`, an auth `28P01`) keeps its own code. A "tag every connect rejection" shortcut would mislabel it. → Task 2 test.
2. An idle pooled client that dies is logged by the pool line only, never by a client line too, so the listener must come off at release. → Task 1, the tightened test.
3. After a dropped checked-out session, the caller still sees the failure, and the next call gets a fresh connection. → Task 1, the new test.
4. Once the message is gone, a capture-check deadline must still read differently from a database failure. → Task 3, the capture test (`code: 'timeout'`).
5. A report write that fails keeps its SQLSTATE in the code-only line. → Task 5 (`causeCode: '23514'`).

## Files

| File | Task | Change |
|---|---|---|
| `packages/session-postgres/src/plugin.ts` | 1 | per-client listener; 3 lines code-only; comments + `logger` JSDoc |
| `packages/session-postgres/src/__tests__/error-handlers.test.ts` | 1 | new crash test; tighten the existing one |
| `packages/database-postgres/src/plugin.ts` | 2 | tag adapter; `checkoutTimeoutMs` JSDoc |
| `packages/database-postgres/SECURITY.md:27` | 2 | one sentence on the code |
| `packages/database-postgres/src/__tests__/checkout-timeout.test.ts` | 2 | assert the code; refused-connection guard |
| `packages/routines/src/__tests__/tick-checkout-timeout.test.ts:104` | 2 | the election line carries the code |
| `packages/routines/src/plugin.ts` (6 sites), `capture.ts` | 3 | code-only; the deadline error gets `code: 'timeout'` |
| `packages/routines/src/__tests__/plugin.test.ts`, `checkin.test.ts`, `capture.test.ts` | 3 | new and updated tests |
| `packages/routines/src/fire.ts` | 4 | `logFault` codes only; `:474` stderr codes |
| `packages/routines/src/__tests__/fire.test.ts` | 4 | updated and new tests |
| `packages/routines/src/tools.ts`, `store.ts` | 5 | report lines code-only; write errors carry their SQLSTATE as `code` |
| `packages/routines/src/__tests__/support/report-log.ts`, `report-tool.test.ts`, `report-store.test.ts`, `set-steps-store.test.ts` | 5 | updated tests |

## Before Task 1

- [ ] Commit the planner's two outputs: this plan and `.claude/memory/decisions/2026-11-05-TASK-1058.md`.
- [ ] `DOCKER_HOST=unix:///var/run/docker.sock` goes on every test command below that starts a container (session-postgres, database-postgres's real-database describe, routines).

---

### Task 1: session-postgres survives a dropped checked-out session, and its background lines are code-only [tier: sensitive]

**Files:**
- Modify: `packages/session-postgres/src/plugin.ts`. Change the import block `:1-7`, the `logger` JSDoc `:61-66`, and the init block `:730-750`. Lines `:726-729` and `:742` stay untouched.
- Test: `packages/session-postgres/src/__tests__/error-handlers.test.ts`

**Interfaces:**
- Produces three `bgLogger.error(name, faultLogFields(err))` lines:
  - `session_postgres_pool_error`: an idle pooled client failed (pg-pool's `pool.on('error')`).
  - `session_postgres_client_error`: a checked-out client failed. Only that client's first event is logged.
  - `session_postgres_listen_client_error`: the LISTEN client failed (every event, as today).

- [ ] **Step 1: Write the failing crash test.** Add it to `error-handlers.test.ts`, which already has `makeRecordingLogger`, `harnesses` and the table-dropping `afterEach`.

```ts
it("survives Postgres ending a checked-out client's session mid-transaction: one code-only line, no crash (TASK-1058)", async () => {
  const { records, logger } = makeRecordingLogger();
  const h = await createTestHarness({ plugins: [createSessionPostgresPlugin({ connectionString, logger })] });
  harnesses.push(h);
  // `locker` holds the table lock in an open transaction; `admin` polls and kills.
  // Polling from inside the locker's transaction would read a stale pg_stat_activity snapshot.
  const locker = new pg.Client({ connectionString });
  const admin = new pg.Client({ connectionString });
  await locker.connect();
  await admin.connect();
  // Stands in for the host: production has no uncaughtException handler, and vitest
  // reports nothing while another listener exists, so this list is the only witness.
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => { unhandled.push(err); };
  process.on('uncaughtException', onUnhandled);
  process.on('unhandledRejection', onUnhandled);
  let outcome: unknown;
  try {
    const lockerPid = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE session_postgres_v1_sessions IN ACCESS EXCLUSIVE MODE');
    // session:create's transaction: BEGIN, then an INSERT that waits behind the lock on a checked-out client.
    const created = h.bus.call('session:create', h.ctx(), { sessionId: 's-dropped', workspaceRoot: '/tmp/ws' })
      .then(() => 'created', (err: unknown) => err);
    let waiter = 0;
    await expect.poll(async () => {
      const { rows } = await admin.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [lockerPid]);
      waiter = rows[0]?.pid ?? 0;
      return rows.length;
    }, { timeout: 10_000 }).toBe(1);
    // The INSERT gets the 57P01. Kysely's ROLLBACK keeps the client checked out while its socket closes.
    await admin.query('SELECT pg_terminate_backend($1, 10000)', [waiter]);
    outcome = await created;
    await new Promise((r) => setTimeout(r, 200)); // room for a second line, if one were coming
  } finally {
    process.off('uncaughtException', onUnhandled);
    process.off('unhandledRejection', onUnhandled);
    await locker.query('ROLLBACK').catch(() => {});
    await locker.end().catch(() => {});
    await admin.end().catch(() => {});
  }
  expect(unhandled).toEqual([]);
  expect(outcome).toBeInstanceOf(Error); // the caller still sees the failure
  // pg-pool dropped the dead client at release, so the pool still answers.
  await expect(h.bus.call('session:create', h.ctx(), { sessionId: 's-after', workspaceRoot: '/tmp/ws' }))
    .resolves.toMatchObject({ sessionId: 's-after' });
  expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
    ['error', 'session_postgres_client_error', { name: 'Error' }],
  ]);
}, 30_000);
```

The one line is `{ name: 'Error' }`, with no SQLSTATE. A session that dies mid-query hands its 57P01 to the query, so the only `'error'` event is the socket closing (probe C, TASK-1048 row 18).

- [ ] **Step 2: Tighten the existing test** (`survives a forced socket termination on the LISTEN client`). Rename it to `idle and LISTEN connections a terminated backend drops log codes only, no crash (TASK-1058)`. Replace the fixed 500 ms wait and the final assertions with:

```ts
const lines = (msg: string) => records.filter((r) => r.msg === msg).map((r) => r.bindings);
await expect.poll(() => lines('session_postgres_listen_client_error').length, { timeout: 10_000 }).toBe(2);
await new Promise((r) => setTimeout(r, 200));
// (process.off(...) as today, then:)
expect(unhandled).toEqual([]);
expect(records.every((r) => r.level === 'error')).toBe(true);
// Idle-pool and LISTEN lines only: a checked-out listener left on after release would add a client line.
expect(new Set(records.map((r) => r.msg))).toEqual(new Set(['session_postgres_pool_error', 'session_postgres_listen_client_error']));
// The LISTEN client reports the server's error, then the socket closing.
expect(lines('session_postgres_listen_client_error')).toStrictEqual([{ code: '57P01', name: 'error' }, { name: 'Error' }]);
// pg-pool reports each idle pooled client once (init's migration leaves one).
const pool = lines('session_postgres_pool_error');
expect(pool.length).toBeGreaterThanOrEqual(1);
for (const b of pool) expect(b).toStrictEqual({ code: '57P01', name: 'error' });
```

The new-Set check passes on the unfixed code: it is a forward guard for Review Focus 2. The red in Step 3 comes from the code-only assertions.

- [ ] **Step 3: Run, and confirm both tests fail for the right reason.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/session-postgres exec vitest run src/__tests__/error-handlers.test.ts`
  - Expected: both FAIL.
    - The new test fails at `expect(unhandled).toEqual([])`, which receives `[Error: Connection terminated unexpectedly]`. That is the crash, as in probe A.
    - The tightened test fails on the LISTEN bindings, which receive `[{ err: … }, { err: … }]`.

- [ ] **Step 4: Implement in `plugin.ts`.**
  - Import `faultLogFields` from `@ax/core`.
  - `pool.on('error')` logs `bgLogger.error('session_postgres_pool_error', faultLogFields(err))`.
  - Right after it, before `kysely = new Kysely(...)`, add the per-client listener. Copy `packages/database-postgres/src/plugin.ts:110-127` (WeakMap keyed by `pg.PoolClient`, one listener per client, a `reported` flag, attached on `'acquire'`, removed on `'release'`) with the line name `session_postgres_client_error`.
  - `listenClient.on('error')` logs `bgLogger.error('session_postgres_listen_client_error', faultLogFields(err))`.
  - Comments:
    - Rewrite `:730-732` to say the pool listener covers idle clients only.
    - Give the new block a comment that says: it is the same gap and the same fix as `@ax/database-postgres` (TASK-1048). pg-pool removes its idle listener at checkout, and Kysely adds none. session-postgres's transactions (`session:create`, the `agents:deleted` purge) keep a client checked out through Kysely's ROLLBACK while the socket closes, and an abrupt drop does the same mid-statement. Codes only, because a driver's message can carry a host, a user or a query value.
  - Rewrite the `logger` JSDoc (`:61-66`) to name the three lines, say "codes only (`faultLogFields`)", and keep the default `reqId=session-postgres-bg`.

- [ ] **Step 5: Run the package suite.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/session-postgres test`
  - Expected: PASS. That includes `agents-deleted.test.ts`, whose two lines this task doesn't touch.

- [ ] **Step 6: Commit.**
  - Run: `git add packages/session-postgres/src/plugin.ts packages/session-postgres/src/__tests__/error-handlers.test.ts`
  - Commit message: `fix(session-postgres): a dropped checked-out session no longer crashes the host; background lines are code-only (TASK-1058)`

---

### Task 2: a database-postgres checkout timeout carries `code: 'db-checkout-timeout'` [tier: integration]

**Files:**
- Modify: `packages/database-postgres/src/plugin.ts`. Constants go next to `:32-34`, the `checkoutTimeoutMs` JSDoc is `:39-44`, the dialect is `:128-130`, and the new function goes after `resolveCheckoutTimeoutMs`.
- Modify: `packages/database-postgres/SECURITY.md:27`
- Test: `packages/database-postgres/src/__tests__/checkout-timeout.test.ts`, `packages/routines/src/__tests__/tick-checkout-timeout.test.ts:104`

**Interfaces:**
- Produces: when a checkout on the `db` from `database:get-instance` times out, it rejects with pg-pool's own `Error`. The message, `cause` and class are unchanged, and the error now has `code: 'db-checkout-timeout'`. Behind a service hook the bus wraps it as usual (`PluginError{code:'unknown'}`, `causeCode: 'db-checkout-timeout'`).

- [ ] **Step 1: Write the failing assertions.**
  - In `checkout-timeout.test.ts`, change each of the three timeout expectations (`:88-90`, `:102-104`, `:155-157`) from `rejects.toThrow('<message>')` to `rejects.toMatchObject({ message: '<message>', code: 'db-checkout-timeout' })`, with the same two messages as today.
  - Add one test to the "never answers" describe (import `type AddressInfo` from `node:net`):

```ts
// Passes on the unfixed plugin too: it guards against tagging every connect failure.
it('a refused connection keeps its own code: only a timeout is tagged (TASK-1058)', async () => {
  const closed = createServer(); // a port nothing listens on: bind one, note it, close it
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const db = await instance({ connectionString: silentServerUrlFor(port), checkoutTimeoutMs: 300 });
  await expect(sql`SELECT 1`.execute(db)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});
```

`silentServerUrlFor(port)` stands for the URL shape `silentServer()` already returns, with this port. Inline it or extract a tiny helper.

  - In `tick-checkout-timeout.test.ts:104`, the expected entry becomes `{ code: 'db-checkout-timeout', name: 'Error', consecutiveFailures: 1, retryInMs: 2_000, level: 'warn', msg: 'routines_tick_election_failed' }`. This is the card's "a checkout timeout logs its code".

- [ ] **Step 2: Confirm the dist is untagged, then run both reds.**
  - Run: `grep -c db-checkout-timeout packages/database-postgres/dist/plugin.js`. Expected: `0`.
    - Rebuild first if `dist/` is missing.
    - Never run this red after building a tagged dist. The routines red needs the untagged one.
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/database-postgres exec vitest run src/__tests__/checkout-timeout.test.ts`
    - Expected: the three timeout tests FAIL, because the received error has no `code`. The refused-connection test PASSES.
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/tick-checkout-timeout.test.ts`
    - Expected: the first test FAILS, because the entry has no `code`.

- [ ] **Step 3: Implement in `plugin.ts`.**
  - `const CHECKOUT_TIMEOUT_CODE = 'db-checkout-timeout';`
  - `const CHECKOUT_TIMEOUT_MESSAGES: ReadonlySet<string>` holds exactly `'timeout exceeded when trying to connect'` and `'Connection terminated due to connection timeout'`. Its comment names pg-pool 3.13.0's `index.js:224` (a caller queued behind a full pool) and `:276` (a new connection not answered in time), and says `checkout-timeout.test.ts` pins both against the real pool, so a pg-pool upgrade that rewords them fails there.
  - `function tagCheckoutTimeout(err: unknown): never`:
    - When `err` is an `Error` whose `message` is in the set and whose `code` is `undefined`, set `code` to `CHECKOUT_TIMEOUT_CODE` on that same object.
    - Either way, rethrow `err`.
    - Mutate in place, don't wrap: the message, stack, cause and class stay pg-pool's, and the bus keeps wrapping it as `unknown` (decisions row 5).
  - The dialect becomes `new PostgresDialect({ pool: { connect: () => pool.connect().catch(tagCheckoutTimeout), end: () => pool.end() } })`, with a comment that Kysely checks connections out through `connect()` alone. The TASK-1048 `'acquire'`/`'release'` listeners stay on the real `pool`.
  - The `checkoutTimeoutMs` JSDoc says the error carries `code: 'db-checkout-timeout'`.
  - In `SECURITY.md:27`, after "…the database never answers.", add one sentence: the error carries `code: 'db-checkout-timeout'`, so a code-only log line tells pool starvation from a database fault.

- [ ] **Step 4: Go green on the database-postgres suite.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/database-postgres test`
  - Expected: PASS.

- [ ] **Step 5: Rebuild, then go green on the routines test.**
  - Run: `pnpm --filter @ax/database-postgres build`, then `grep -c db-checkout-timeout packages/database-postgres/dist/plugin.js`. Expected: ≥ 1.
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/tick-checkout-timeout.test.ts`
  - Expected: PASS.

- [ ] **Step 6: Commit.**
  - Run: `git add packages/database-postgres/src/plugin.ts packages/database-postgres/SECURITY.md packages/database-postgres/src/__tests__/checkout-timeout.test.ts packages/routines/src/__tests__/tick-checkout-timeout.test.ts`
  - Commit message: `feat(database-postgres): a checkout timeout carries code db-checkout-timeout (TASK-1058)`

---

### Task 3: routines subscriber lines are code-only (`plugin.ts` ×6, `capture.ts`) [tier: integration]

**Files:**
- Modify: `packages/routines/src/plugin.ts` at `:159-162`, `:181-183`, `:255-257`, `:282-285`, `:303-306` and `:324-326`.
- Modify: `packages/routines/src/capture.ts` at `:51-53` and `:64`.
- Test: `packages/routines/src/__tests__/plugin.test.ts`, `checkin.test.ts`, `capture.test.ts`

**Interfaces:** none new. Each line keeps its name and its ids. `err` is replaced by `...faultLogFields(err)`.

Shared test values (define them in each test file that uses them; no new support module):

```ts
const PRIVATE = () => Object.assign(new Error('PRIVATE pg text at <private-ip>'), { code: '57P01' });
/** The one `msg` line: these ids, the injected error's codes, nothing else, and no message text anywhere. */
function expectOneCodeOnly(lines: readonly string[], msg: string, ids: Record<string, unknown>): void {
  const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.msg === msg);
  expect(entries).toEqual([{ level: 'warn', ts: expect.any(String), reqId: expect.any(String), msg, ...ids, code: '57P01', name: 'Error' }]);
  expect(lines.join('\n')).not.toMatch(/PRIVATE|<private-ip>/);
}
```

- [ ] **Step 1: Write the failing tests in `plugin.test.ts`.**
  - Add a new `describe('failure lines carry codes only (TASK-1058)')`. It uses the file's `h`, `create` and `fireInput`, `logged` from `./support/report-log.js`, and `failQueries` from `./support/fail-query.js`.
  - Restore every `failQueries` in a `finally`.
  - Make the bus throw with the pass-through spy (template: `report-tool.test.ts:532-536`):

```ts
const callThrough = h.bus.call.bind(h.bus);
vi.spyOn(h.bus, 'call').mockImplementation(async (hook, ctx, input) => {
  if (<hook to fail>) throw PRIVATE();
  return callThrough(hook, ctx, input);
});
```

  It also catches `callJoined`. `afterEach` already calls `vi.restoreAllMocks()`.
  - The four tests:
    1. **`a purge that fails for a deleted agent`**
       - Use `h = await createRoutineHarness()` and `const { ctx, lines } = logged(h.owner)`.
       - `failQueries(/insert into "routines_v1_retired_agents"/, PRIVATE())` (store.ts:1726, the purge's fence), then `await h.bus.fire('agents:deleted', ctx, { agentId: h.agentId })`.
       - Assert `expectOneCodeOnly(lines, 'routines_remove_for_deleted_agent_failed', { agentId: h.agentId })`.
    2. **`a connectors-skipped payload that throws when read`**
       - Fire `chat:connectors-skipped` with a `logged(h.owner)` ctx and the payload `{ get reqId(): string { throw PRIVATE(); }, connectors: [] }`. This is the only input that reaches that catch (exploration of `stashConnectorsSkipped`).
       - Assert `expectOneCodeOnly(lines, 'routines_connectors_skipped_failed', {})`.
    3. **`drop-turn and hide failures on a silenced turn`**
       - Use the existing silenced-turn setup (`definition` with `silenceToken: 'QUIET'`, default `per-fire`). The invoke fires `chat:turn-end` with `logged(ctx).ctx`, `turnId: 'turn'` and text `QUIET`, and keeps its `lines`.
       - The spy throws `PRIVATE()` for `conversations:drop-turn` and for `conversations:hide`.
       - After `routines:fire-now`, `expect.poll` until the silenced row lands (`recentFires(row).length === 1`, which proves the run is still recorded).
       - Assert `expectOneCodeOnly` for `routines_drop_turn_failed` and for `routines_hide_failed`, each with `{ conversationId: expect.any(String) }`.
    4. **`a turn-end whose run can't be recorded`**
       - Use the file's `create()`. Its silence token is `QUIET`, so a turn ending `done` takes the main (not silenced) path.
       - Inside the invoke: `failQueries(/insert into "routines_v1_fires"/, PRIVATE())`, then fire `chat:turn-end` (text `done`) with a `logged(ctx)` ctx. Restore in `finally` and resolve a `done` promise (pattern `plugin.test.ts:50-60`).
       - Await `done`. No row is written, so don't poll for one.
       - Assert `expectOneCodeOnly(lines, 'routines_turn_end_handler_failed', {})`. The `reqId` binding is reserved and dropped by the logger.

- [ ] **Step 2: Write the failing belt test in `checkin.test.ts`.** Put it next to the belt tests (`:204-222`):

```ts
it("the belt: a run that can't be recorded logs its codes, not its message (TASK-1058)", async () => {
  h = await createCheckInHarness();
  const task = await create(TASK_DEFINITION, 'task');
  let warn: ReturnType<typeof vi.spyOn> | undefined;
  let restore = () => {};
  try {
    await h.checkIn(task, 'run', async (ctx) => {
      warn = vi.spyOn(ctx.logger, 'warn');           // the same ctx goes to chat:turn-end
      restore = failQueries(/insert into "routines_v1_fires"/, PRIVATE());
    }, { landed: null });                            // never landed → the belt branch
  } finally { restore(); }
  expect(warn).toHaveBeenCalledWith('routines_turn_end_handler_failed', { reqId: expect.any(String), code: '57P01', name: 'Error' });
});
```

`toHaveBeenCalledWith` with an exact object fails while an `err` key is present. Ignore the `routines_check_in_brief_unconfirmed` line, which comes first.

- [ ] **Step 3: Update `capture.test.ts`.**
  - `:52` becomes `toHaveBeenCalledWith('routines_capture_check_failed', { agentId: 'agent', code: 'timeout', name: 'Error' })`.
  - In the "refuses when the lookup throws" test (`:80-86`), inject `Object.assign(new Error('PRIVATE pg text at <private-ip>'), { code: '57P01' })`. Line `:85` becomes `toHaveBeenCalledWith('routines_capture_check_failed', { agentId: 'agent', code: '57P01', name: 'Error' })`.
  - Leave the "a logger that throws" test as is.

- [ ] **Step 4: Run, and confirm the failures.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/plugin.test.ts src/__tests__/checkin.test.ts src/__tests__/capture.test.ts`
  - Expected: the 7 new or changed tests FAIL, because each line still carries `err: 'PRIVATE pg text at <private-ip>'` (or the deadline text). Everything else PASSES.
  - If a new test fails any other way, the trigger isn't reaching the catch. Fix the test before touching `src`.

- [ ] **Step 5: Implement.**
  - In `plugin.ts`, at each of the six sites, replace `err: err instanceof Error ? err.message : String(err)` with `...faultLogFields(err)`. Keep each line's ids. `faultLogFields` is already imported at `:1`.
  - In `capture.ts`:
    - The deadline rejects with `Object.assign(new Error(\`capture check took longer than ${deadlineMs} ms\`), { code: 'timeout' })`.
    - The warn becomes `{ agentId: ctx.agentId, ...faultLogFields(err) }`.
    - Import `faultLogFields` from `@ax/core`.
    - `'timeout'` is the bus's own code for the same kind of failure, and it keeps a deadline distinguishable from a database error.

- [ ] **Step 6: Run the routines suite.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines test`
  - Expected: PASS.

- [ ] **Step 7: Commit.**
  - Run: `git add packages/routines/src/plugin.ts packages/routines/src/capture.ts packages/routines/src/__tests__/plugin.test.ts packages/routines/src/__tests__/checkin.test.ts packages/routines/src/__tests__/capture.test.ts`
  - Commit message: `fix(routines): subscriber failure lines carry codes only (TASK-1058)`

---

### Task 4: routines fire lines are code-only (`logFault`, the recording-failed stderr line) [tier: mechanical]

This task reverses TASK-1031's "its message only the log" for non-webhook fires. Say so in the commit body and the PR body.

**Files:**
- Modify: `packages/routines/src/fire.ts` at `:270-286` (`logFault` and its comment) and `:474-476`.
- Test: `packages/routines/src/__tests__/fire.test.ts`

**Interfaces:** `logFault(event, err, level)` keeps its signature. Its line is `{ agentId, routineId, source, ...faultLogFields(err) }` for every source, and it never carries `err` or `errUnreadable`.

- [ ] **Step 1: Write the failing tests in `fire.test.ts`.**
  - `:122-133`:
    - Change the comment to "TASK-1031: a hook failure's code reaches the owner. TASK-1058: the log gets its codes too, never its message."
    - Rename the test to `records a hook failure as fixed words and its code, and logs codes only`.
    - Keep the stored-text assertions, then assert `expect(logged[0]).toMatchObject({ level: 'error', code: 'forbidden', routineId: h.row.routineId })`, `expect(logged[0]).not.toHaveProperty('err')` and `expect(lines.join('\n')).not.toMatch(/PRIVATE|<private-ip>/)`.
  - `:156-167` (hostile `message` getter): the log line becomes `expect(logged[0]).toMatchObject({ code: 'forbidden' })` and `expect(logged[0]).not.toHaveProperty('errUnreadable')`.
  - New test, for `:474`:

```ts
it("a run that can't be recorded after its invoke writes codes, not the message, to stderr (TASK-1058)", async () => {
  const h = await setup({
    finish: async () => { throw Object.assign(new Error('PRIVATE pg text at <private-ip>'), { code: '57P01' }); },
    invoke: async () => ({ kind: 'terminated', reason: 'stopped' }),
  });
  const diagnostic = captureExpectedStderr((m) => m.startsWith('[ax/routines] '));
  try {
    await h.fire(h.accepted);
    await expect.poll(() => diagnostic.messages.some((m) => m.includes('recording failed fire'))).toBe(true);
  } finally { diagnostic.restore(); }
  expect(diagnostic.messages).toContain(`[ax/routines] recording failed fire for a/${h.row.routineId} failed: {"code":"57P01","name":"Error"}\n`);
  expect(diagnostic.messages.join('')).not.toMatch(/PRIVATE|<private-ip>/);
});
```

- [ ] **Step 2: Run, and confirm the failures.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/fire.test.ts`
  - Expected: the 3 tests FAIL.
    - The first has an `err` key with PRIVATE in it.
    - The second has `errUnreadable: true`.
    - The third gets the message instead of codes.

- [ ] **Step 3: Implement in `fire.ts`.**
  - `logFault` logs `fields` alone (ids, `source`, `...faultLogFields(err)`) inside one best-effort `try { … } catch { }`. The `errUnreadable` retry goes away: no `err` means the logger never reads the error's getters, and `faultLogFields` never throws.
  - Rewrite the comment above it: codes only for every source (TASK-1058; it was the whole error for non-webhook fires, TASK-1031). Keep "a failed log line must not cost the run its row".
  - At `:474-476`, the non-webhook branch writes `JSON.stringify(faultLogFields(err))` instead of the message. This is the text-line form http-server and auth-better use.
  - Keep the webhook branch's fixed phrase `app update accounting unavailable` (TASK-971).
  - Import `faultLogFields` if it isn't already (it is, for `runFailedText`).

- [ ] **Step 4: Run the routines suite.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines test`
  - Expected: PASS. That includes `repeat-fire-privacy.test.ts` and `fire.test.ts`'s webhook test.

- [ ] **Step 5: Commit.**
  - Run: `git add packages/routines/src/fire.ts packages/routines/src/__tests__/fire.test.ts`
  - Commit message: `fix(routines): fire failure lines carry codes only (TASK-1058)`
  - Commit body: "supersedes TASK-1031's non-webhook `err`".

---

### Task 5: routines report lines are code-only, and a failed write keeps its SQLSTATE as `code` [tier: integration]

This task reverses TASK-907's deliberate "the hook's message" (`decisions/2026-10-21-TASK-907.md:38`, `:42`). Say so in the commit body.

**Files:**
- Modify: `packages/routines/src/tools.ts` at `:36-48` (`reportFailed` and its JSDoc) and `:69-74`.
- Modify: `packages/routines/src/store.ts:993-1006` (`reportWriteError`, `stepsWriteError`).
- Test: `packages/routines/src/__tests__/support/report-log.ts`, `report-tool.test.ts`, `report-store.test.ts`, `set-steps-store.test.ts`

**Interfaces:**
- `reportWriteError(dispatchId, error)` and `stepsWriteError(routineId, error)` return the same message as today. When `sqlState(error)` isn't null, the returned `Error` also has `code: <that SQLSTATE>`.
- `expectOneFailure(lines, ids, fault: Record<string, string>, leaks: RegExp, label)` replaces the old `why: RegExp, secret: RegExp` parameters.

- [ ] **Step 1: Write the failing tests.**
  - `report-log.ts`:
    - `FAILURE_LOG_KEYS` swaps `'err'` for `'code', 'causeCode', 'name', 'causeName', 'hookName', 'plugin'`. Its doc comment says "codes (TASK-1058)" instead of "the hook's message".
    - `expectOneFailure` asserts `expect(failures, label).toEqual([expect.objectContaining({ level: 'warn', ...ids, ...fault })])`, keeps the allowed-keys loop, and asserts `expect(lines.join('\n'), label).not.toMatch(leaks)`.
  - `report-tool.test.ts:517` (a refused write) becomes `expectOneFailure(write.lines, ids, { code: 'unknown', causeCode: '23514', hookName: 'routines:report', plugin: '@ax/routines' }, /SECRET|Could not save/, 'a refused write')`.
  - `report-tool.test.ts:526` (a failed fence) becomes `expectOneFailure(fence.lines, ids, { code: 'unknown', causeCode: '42P01', hookName: 'routines:report', plugin: '@ax/routines' }, /SECRET|retired_agents/, 'a failed fence')`.
  - `report-tool.test.ts:302-325` (lookup):
    - Rename the test to `…the ids and the database's codes, none of the report`.
    - `expected` becomes `{ level: 'warn', stage: 'lookup', agentId, conversationId, code: '42P01', name: 'error' }`.
    - `keys` swaps `'err'` for `'code', 'name'`.
    - The leak check becomes `not.toMatch(/SECRET|routines_v1_dispatches/)`.
  - `report-store.test.ts:432`: add `expect(error).toMatchObject({ code: '22P02' })`.
  - `set-steps-store.test.ts:317`: add `expect(failure).toMatchObject({ code: '23514' })`.

pg's `DatabaseError` names itself `error`, lowercase (TASK-1048, measured). The write error's `causeName` is `Error`. The fence's `causeName` is `error`. The allowed-keys loop admits both.

- [ ] **Step 2: Run, and confirm the failures.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/report-tool.test.ts src/__tests__/report-store.test.ts src/__tests__/set-steps-store.test.ts`
  - Expected: FAIL.
    - The lines still carry `err`.
    - The two write errors have no `code`.
  - If a code differs from the plan, find out why before you change an expectation. For example, if the hook converts the fence failure to something else, record the real shape in the decisions shard.

- [ ] **Step 3: Implement.**
  - `tools.ts`:
    - `reportFailed` logs `{ agentId, conversationId, ...run, ...faultLogFields(error) }`.
    - The lookup line logs `{ stage: 'lookup', agentId, conversationId, ...faultLogFields(error) }`.
    - Rewrite the JSDoc (`:36-43`) and the comment at `:69-71`: the operator gets the run, its task and the failure's codes. The SQLSTATE travels as the write error's `code`, so it shows as `causeCode` behind the bus. No message is logged.
  - `store.ts`: both write-error helpers attach `code` when `sqlState(error)` isn't null. Add a comment that a code-only line keeps the SQLSTATE that way (TASK-1058).

- [ ] **Step 4: Run the routines suite.**
  - Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/routines test`
  - Expected: PASS.

- [ ] **Step 5: Commit.**
  - Run: `git add packages/routines/src/tools.ts packages/routines/src/store.ts packages/routines/src/__tests__/support/report-log.ts packages/routines/src/__tests__/report-tool.test.ts packages/routines/src/__tests__/report-store.test.ts packages/routines/src/__tests__/set-steps-store.test.ts`
  - Commit message: `fix(routines): report failure lines carry codes only; write errors carry their SQLSTATE (TASK-1058)`
  - Commit body: "supersedes TASK-907's `err`".

---

## After the tasks

- [ ] **Memory.** Write `.claude/memory/patterns/2026-11-05-TASK-1058.md` (path from `scripts/memory-write-target.sh --shard patterns TASK-1058`, after `mkdir -p` of its directory). Its rows:
  1. session-postgres's pool now has TASK-1048's listener and writes `session_postgres_client_error`. This supersedes the last sentence of `patterns/2026-11-05-TASK-1048.md:3`.
  2. A database-postgres checkout timeout carries `code: 'db-checkout-timeout'`. This supersedes `patterns/2026-11-05-TASK-1049.md:4`. Pools built elsewhere don't tag.
  3. A dropped session crashes only if the client is still checked out when its socket closes: a transaction (Kysely's ROLLBACK), or an abrupt drop. A lone statement is released first. The repro recipe: `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` from a second client, find the waiter through `pg_blocking_pids`, then `pg_terminate_backend(pid, 10000)`. In the same query, pg_stat_activity's row fields lag `pg_blocking_pids`.
  4. Routines lines outside `tick.ts` are code-only. The known exception is `tick.ts`'s three stderr lines.
  
  Never edit a root archive or an existing shard line (R1/R2).
- [ ] **Gate.**
  - `pnpm build`
  - `pnpm lint`
  - `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/session-postgres test`
  - the same for `@ax/database-postgres` and `@ax/routines`
  - `pnpm test:eslint-rules`
  - `pnpm test:scripts`
  
  CI's affected-packages job covers the other `database:get-instance` consumers. Use `pnpm -r --no-bail run test` (CLAUDE.md) if you run the whole repo.
- [ ] **PR body must say:**
  - Tasks 4 and 5 supersede TASK-1031 (non-webhook `logFault` detail) and TASK-907 (report-line message).
  - A routine run that failed on a starved pool now reads "This run failed because of a problem on our side (code: db-checkout-timeout)." `runFailedText` shows host codes by design (TASK-1031).
  - Rebase note: TASK-1056 edits session-postgres's constructor lines and maybe `SessionPostgresConfig`. Our hunks are adjacent but separate.
  - The follow-ups below.

## Follow-ups (not this PR)

1. Once TASK-1056 sets `connectionTimeoutMillis` on session-postgres's pool, its timeouts carry no code. Give that pool the same adapter; whichever card lands second does it.
2. The three stderr lines in `tick.ts` (`materialize/refresh error`, `fire failed for`, `tick error`) go code-only. This was deferred by TASK-1041 row 5.
3. session-postgres's `session_postgres_terminate_for_deleted_agent_failed` and `session_postgres_purge_for_deleted_agent_failed` log the raw `err`. `agents-deleted.test.ts:381` pins it.
4. routines-admin-routes `plugin.ts:94`, `:119` write an unregister error's message with `console.warn`.
