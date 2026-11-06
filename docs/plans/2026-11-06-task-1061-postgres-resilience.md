# TASK-1061 Postgres resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dropped or vanished Postgres connection no longer leaves the host quietly broken. This plan delivers four changes:
- every pg connection turns on TCP keepalive;
- the shared pool ends transactions left idle;
- session-postgres's LISTEN connection reconnects and LISTENs again;
- an eventbus connect that lands after shutdown closes its client.

**Architecture:** Construction-time pg options only; no hook signature or payload changes.
- `keepAlive: true, keepAliveInitialDelayMillis: 10_000` goes on all four pg constructions.
- `idle_in_transaction_session_timeout` goes on `@ax/database-postgres`'s pool, as a new `idleInTransactionTimeoutMs` field (default 60 000). TASK-1056's connection-string guard is extended to refuse that key too.
- session-postgres gets a `ListenConnection` class. It copies eventbus-postgres's `Listener` reconnect design (no import, per invariant 2), and the inbox binds to it.
- eventbus's `Listener.connect()` ends a client whose connect lands after `shutdown()`.

**Tech Stack:** pg 8.20.0, pg-pool 3.13.0, kysely 0.28.17, Postgres 16 (`postgres:16-alpine` via testcontainers), vitest 5.0.3, Node 24.

**Spec:** the card (quoted below; INFERRED by TASK-1056's builder) plus "Premise, measured". Rationale for every decision: `.claude/memory/decisions/2026-11-06-TASK-1061.md`.

## The card (fix + acceptance, verbatim)

> **Fix.** Enable keepalive (`keepAlive` plus an initial delay) on every pool and client. Set `idle_in_transaction_session_timeout`. Move routines' `blob:put` out of the locked transaction, or bound it. Give the `session-postgres` LISTEN client reconnect with backoff, logging code-only lines. Close an eventbus client whose connect lands after shutdown. Batch the purge `DELETE`s if it's cheap.
>
> **Acceptance.** A test for each: a LISTEN client whose backend is terminated reconnects and receives a later notification; a transaction left idle is ended by the server; an eventbus connect that resolves after shutdown leaves no open client. Prove each test fails before its fix.

## Premise, measured (a8fe20cdb, throwaway scratchpad probes, the worktree's pg 8.20.0 against postgres:16-alpine)

- **P1, session-postgres LISTEN death (today's dist):**
  - The probe terminated the LISTEN backend with a claim parked on `s1`. 3 s later there was still no LISTEN backend: nothing reconnects.
  - `session:queue-work` then rejects with `Client has encountered a connection error and is not queryable`, AFTER its INSERT landed (the row is in the inbox). A claim on a new channel rejects the same way.
  - The parked claim sleeps until its timeout.
  - The log shows exactly two lines: `session_postgres_listen_client_error` `{code:'57P01',name:'error'}`, then `{name:'Error'}`. Shutdown took 0 ms.
  - So the card's "notifications stop with no sign" understates it. The orchestrator turns that rejection into `queue-work-failed` (`chat-orchestrator/src/orchestrator.ts:3023-3038`), so every chat turn fails until a host restart.
  - Before TASK-1048 (#1130) and TASK-1058 (#1133), a Postgres restart crashed the host, and the restart incidentally fixed the LISTEN client. Those cards removed the crash, so the host now survives but chat stays broken. Neither is deployed (prod rev63 is fa778af8d). **Land this card before the next deploy.**
- **P2, idle in transaction through the real `@ax/database-postgres` plugin** (bound set to 500 ms via the URL, which the plugin allows today):
  - A transaction holding `pg_advisory_xact_lock` plus a `FOR UPDATE` row lock that awaits JS for 1.5 s is ended by the server. Both locks are free at ~1 s.
  - Its next statement rejects with `Client has encountered a connection error and is not queryable` (no `code`).
  - Exactly one line is logged: `database_postgres_client_error` `{code:'25P03',name:'error'}` (TASK-1048's listener). No uncaught error, and the pool answers the next query.
  - A session-level advisory lock on a pinned connection idle OUTSIDE a transaction for 1.5 s survives, and another session cannot take it.
  - A 1.2 s statement inside a transaction is not affected.
- **P3, keepalive:**
  - Default pg never calls `net.Socket#setKeepAlive`.
  - With `keepAlive: true, keepAliveInitialDelayMillis: 10000`, both `pg.Client` and `pg.Pool` call `setKeepAlive(true, 10000)` once per connection.
  - A connection-string `?keepalives=0` does NOT override it: pg reads `keepAlive` from the explicit config only (`client.js:81-82`).
- **P4, eventbus leak:**
  - The probe held a connect at a proxy and called `shutdown()`, which returned in 0 ms.
  - After release, `ensureConnected()` RESOLVED, so a waiting `notify()` would run on the leaked client.
  - 500 ms later the server still showed the listener's backend `idle`. The client never closed its socket, and that socket keeps the event loop alive.
- **P5, precedence:** `?idle_in_transaction_session_timeout=0` (or the bare key) silently overrides the explicit option to 0 (off), and `=60000` replaces it. `?options=-c idle_in_transaction_session_timeout=0` does not override it. This is the same behavior TASK-1056 measured for `statement_timeout`.
- **P6, a refused connect:** pg's `connect()` to `127.0.0.1:1` rejects with `faultLogFields` → `{"code":"ECONNREFUSED","name":"Error"}` and emits no client `'error'` event.
- **Sweep (code read, every product transaction):**
  - Six transactions stay open across a non-database wait, all on the shared pool.
  - Four of them wait on other database calls that the database bounds (worst case about 35 s: a 5 s checkout plus a 30 s statement on a second connection): `routines/src/store.ts:1695` `withLockedWebhookSecret` (holds its lock across the credential effect ON PURPOSE, `:1069-1074`), `:1715` `runCredentialCleanup`, `webhook-health.ts:70`, and `storage-postgres/src/plugin.ts:142` `db:transact` (onboarding).
  - Two wait on something with no bound at all: `routines/src/task-events.ts:88` and `repeat-deliveries.ts:38`, through `blob:put` (the S3 client has no request timeout, `blob-store-s3/src/plugin.ts:166-198`; the fs store has none either). Payload ≤ 1 MiB.
  - The routines tick leader (`tick.ts:231`), blob-gc's `withSweepLock` (`blob-gc/src/store.ts:285`) and conversations' append are never inside a transaction across a non-database wait.
  - session-postgres's pool transactions (`store.ts:229`, `:410`) run only their own statements.
- **Not fixed by a server-side bound (refines "bound it"):** routines' `serializeAdmission` (`admission-order.ts:6-20`) is ONE in-process FIFO in front of every webhook admission. A `blob:put` that never settles keeps that queue held after the server has ended the session and freed its locks and pool slot. Moving `blob:put` out of the transaction would not free it either while it stays inside `serializeAdmission`. This becomes a follow-up (bottom of this plan).

## Decisions (one line each; the decisions shard has the rationale and alternatives)

1. **Keepalive:** a module constant `KEEPALIVE_INITIAL_DELAY_MS = 10_000` in each package, `keepAlive: true` on every pool and client, not configurable. Node then probes every 1 s, 10 times (its documented `setKeepAlive` socket options), so a dead peer on an idle socket shows up in about 20 s.
2. **Idle-in-transaction bound:** `@ax/database-postgres` only, `idleInTransactionTimeoutMs`, default **60 000**, a whole number from 1 to 2147483647 (else `invalid-config`), refused in the connection string.
   - 60 s is twice the statement timeout. It is longer than any database-bounded wait a holder makes (≤ ~35 s), so it never breaks `withLockedWebhookSecret`'s deliberate hold. It ends only holders stuck on a wait that nothing else bounds.
   - session-postgres's pool does not get it: nothing there can idle.
   - Never set `idle_session_timeout`: it would end the leader's and blob-gc's pinned sessions.
3. **Routines:** no source edit. The server-side bound is the "bound it" option. TASK-1050 is editing routines' webhook path in parallel.
4. **session-postgres reconnect:** a new `ListenConnection` with eventbus's backoff (1, 2, 4, 8, 16, then 30 s; timer `unref()`ed).
   - A new client becomes live only after it has LISTENed every bound channel.
   - UNLISTEN never opens a connection.
   - An `'error'` from a client that isn't the live one never drops the live one.
   - A connect that lands after shutdown ends its client.
   - Lines: `session_postgres_listen_client_error` (unchanged) and new `session_postgres_listen_connect_failed`, both `faultLogFields` only.
   - No wake-all after a reconnect (YAGNI: every NOTIFY is sent through this connection, after its re-LISTEN).
5. **eventbus leak:** after `client.connect()` resolves, if `shutdown()` has run, end the client (fire-and-forget) and throw `eventbus-postgres listener is shut down`. `shutdown()` stays non-waiting.
6. **Purge batching:** deferred. About 20 packages run per-agent purges, and session-postgres's purge is one atomic transaction by design.

## Global Constraints

- No hook signature, payload or IPC change. New fields are construction config only. No boundary review needed.
- No cross-plugin imports: session-postgres copies, never imports, `@ax/eventbus-postgres`.
- Every new or touched log line binds `faultLogFields(err)` only, never `err`, a message or a connection string.
- Keepalive: `keepAlive: true`, `keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS` (`10_000`) on all four pg constructions. No config field, no env var, no chart value.
- `idleInTransactionTimeoutMs`: database-postgres only. Default `60_000`, range 1..2147483647 whole ms, else `PluginError{code:'invalid-config'}` thrown in `init` (where `statementTimeoutMs` is validated). It maps to pg's `idle_in_transaction_session_timeout`.
- The connection-string guard stays linear. Change only the key comparison (to a `Map` lookup), and leave the existing normalization lines byte-identical: this parser cost TASK-1056 four review rounds and two CodeQL alerts.
- Never set `idle_session_timeout` or pg's `query_timeout` anywhere.
- Reconnect backoff delays are exactly `[1000, 2000, 4000, 8000, 16000, 30000]` ms, with the timer `unref()`ed.
- No edits under `packages/routines/` (TASK-1050 is in flight there).
- Tests: new files where possible, each written and run red before its fix. Container tests use `startTestContainer(new PostgreSqlContainer('postgres:16-alpine'))` and `stopPostgresContainer` from `@ax/test-harness`. Test-only `node:net` servers bind `127.0.0.1:0`. A test proving "no crash" captures `uncaughtException`/`unhandledRejection` for its duration and asserts the list is empty.
- Run Docker-backed tests with `export DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000`. `pnpm --filter <pkg> test`: the filter goes BEFORE the script name.
- These three packages' tests import `src`, so red runs need no rebuild. Routines tests load `@ax/database-postgres` from `dist`, so rebuild it before running them.

## Review Focus

1. **A Postgres restart:** the LISTEN backend dies AND the database refuses connections for a few seconds. The reconnect chain must keep retrying across failed attempts and recover. pg emits no `'error'` for a failed `connect()` (eventbus's old stall), so the catch itself must reschedule. Pinned by Task 4, test 1.
2. **A second caller arriving while a new LISTEN client is still re-LISTENing** must wait. Otherwise its `pg_notify` can go out before the LISTEN and a parked claim misses its wake. Pinned by Task 4, test 4.
3. **Shutdown, or a failed init, while a LISTEN connect or reconnect timer is pending:** no connecting or live client stays open, and no timer fires later. Pinned by Task 4, test 3 and the Task 5 assertion added to `timeouts.test.ts`. Known limit, accepted: a client that emitted `'error'` WITHOUT its socket closing stays open until the process exits. That takes a protocol desync, where pg's `_handleErrorEvent` (`client.js:387-394`) leaves the socket up. The live-client path never ends dropped clients, because an `end()` there would swallow pg's second event. eventbus has the same limit. It is listed under follow-ups.
4. **A terminated backend emits two `'error'` events (57P01, then the close).** The second must not schedule a second reconnect or drop a newer client. Pinned by Task 5's acceptance test (exactly two lines, then a working new LISTEN backend).
5. **A pinned connection idle OUTSIDE a transaction holding a session-level advisory lock** (the routines leader, blob-gc) must survive the new bound. Pinned by Task 3, test 2.

## File map

| File | Change | Task |
|---|---|---|
| `packages/eventbus-postgres/src/listener.ts` | post-connect shutdown check (`:88`); keepalive (`:68-71`) | 1, 2 |
| `packages/eventbus-postgres/src/__tests__/shutdown-race.test.ts` | new | 1 |
| `packages/eventbus-postgres/src/__tests__/keepalive.test.ts` | new | 2 |
| `packages/eventbus-postgres/SECURITY.md` | `:34`, `:91` | 1 |
| `packages/database-postgres/src/plugin.ts` | keepalive; `idleInTransactionTimeoutMs`; guard | 2, 3 |
| `packages/database-postgres/src/__tests__/keepalive.test.ts` | new | 2 |
| `packages/database-postgres/src/__tests__/idle-in-transaction.test.ts` | new | 3 |
| `packages/database-postgres/SECURITY.md` | `:26`, `:30`, `:34`, new bullets | 2, 3 |
| `packages/session-postgres/src/plugin.ts` | keepalive (`:847-856`, `:916-919`); use `ListenConnection` | 2, 5 |
| `packages/session-postgres/src/__tests__/keepalive.test.ts` | new | 2 |
| `packages/session-postgres/src/listen-connection.ts` | new | 4 |
| `packages/session-postgres/src/__tests__/listen-connection.test.ts` | new | 4 |
| `packages/session-postgres/src/inbox.ts` | take a `ListenConnection` | 5 |
| `packages/session-postgres/src/__tests__/listen-reconnect.test.ts` | new (acceptance) | 5 |
| `packages/session-postgres/src/__tests__/inbox-{corruption,shutdown-race,toctou}.test.ts` | build a `ListenConnection` instead of a raw `pg.Client` | 5 |
| `packages/session-postgres/src/__tests__/timeouts.test.ts` | one assertion added at `:294-303` | 5 |
| `.claude/memory/patterns/2026-11-06-TASK-1061.md` | new shard | 6 |

Order: 1, 2, 3 and 4 are independent (4 takes the keepalive delay as an option). 5 needs 2 (the `KEEPALIVE_INITIAL_DELAY_MS` it passes in, and the keepalive test that guards the move) and 4. 6 comes last. Commit this plan and the decisions shard before Task 1.

---

### Task 1: eventbus-postgres: a connect that lands after `shutdown()` closes its client [tier: sensitive]

Concurrency: a `connect()` racing `shutdown()`.

**Files:**
- Modify: `packages/eventbus-postgres/src/listener.ts:67-94` (`connect()`), header comment `:4-18`
- Create: `packages/eventbus-postgres/src/__tests__/shutdown-race.test.ts`
- Modify: `packages/eventbus-postgres/SECURITY.md:34`, `:91`

**Interfaces:**
- Produces: no API change. A `Listener` caller (`ensureConnected`, `notify`, `addSubscriber`) whose connect lands after `shutdown()` now rejects with `Error('eventbus-postgres listener is shut down')`, the same text `ensureConnected()` already throws at `:55`.

- [ ] **Step 1: Write the failing test** (`shutdown-race.test.ts`)

Set up a container in `beforeAll` and stop it in `afterAll`. Keep an `unblock` list drained in `afterEach`, as in `connect-timeout.test.ts`. Write these helpers:
- `holdingProxy(): Promise<{ url: string; accepted(): number; release(): void }>`. A `net` server on `127.0.0.1:0`. For each accepted socket, open an upstream to `container.getHost()`/`container.getPort()`. Pipe client→server bytes immediately. Buffer server→client chunks until `release()`, then flush them and keep piping. Add an `'error'` listener on both sockets, destroy each side when the other closes, and track every socket. The cleanup pushed onto `unblock` destroys every tracked socket BEFORE `server.close()`, as `connect-timeout.test.ts:74-77` does. In the red run the leaked client keeps its proxied socket open, and a bare `server.close()` would wait on it until `afterEach` hits the 60 s hook timeout. `url` is the container URI with host `127.0.0.1` and the proxy's port. (The P4 probe used exactly this proxy.)
- `backends(app: string): Promise<number>`: a fresh admin `pg.Client` runs `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`.
- `recordingLogger()`: copy it from `listener-reconnect.test.ts`.
- `errorOf(p)`: copy it from `session-postgres/src/__tests__/timeouts.test.ts` (resolves to the rejection, or `undefined`).

```ts
it('a connect that lands after shutdown() ends its client, and the caller waiting on it is refused', async () => {
  const { records, logger } = recordingLogger();
  const proxy = await holdingProxy();
  const listener = new Listener({
    connectionString: `${proxy.url}?application_name=evb_shutdown_race`,
    connectTimeoutMs: 5_000,
    logger,
  });
  const emitted = errorOf(listener.notify('evb_shutdown_race', '{}'));
  await expect.poll(() => proxy.accepted()).toBe(1);
  await listener.shutdown();
  proxy.release();
  expect(await emitted).toMatchObject({ message: 'eventbus-postgres listener is shut down' });
  await expect.poll(() => backends('evb_shutdown_race'), { timeout: 5_000 }).toBe(0);
  expect(records).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ax/eventbus-postgres exec vitest run src/__tests__/shutdown-race.test.ts`

Expected: FAIL, with `emitted` resolving `undefined` (the leaked client sent the NOTIFY). If you comment that assertion out, the backend poll times out at 1 instead. Measured in P4.

- [ ] **Step 3: Implement it in `Listener.connect()`**

Right after `await client.connect()` succeeds, outside the existing try/catch and before `this.client = client`:

```ts
if (this.shutdownRequested) {
  void client.end().catch(() => {}); // not awaited: end() can wait on a server that stopped answering
  throw new Error('eventbus-postgres listener is shut down');
}
```

`shutdown()` stays as it is: it does not wait for an in-flight connect. Add one sentence to the header comment (`:4-18`) saying a connect still in flight at shutdown ends its own client when it lands.

- [ ] **Step 4: Run the test and the package**

Run the Step 2 command, then `pnpm --filter @ax/eventbus-postgres test`.

Expected: PASS, including `listener-reconnect`, `connect-timeout` and `plugin`.

- [ ] **Step 5: Fix the two stale SECURITY.md lines**
  - `:34`: keep "`shutdown()` clears the timer, ends the client, and clears the channel map", then add: a connect still in flight when `shutdown()` runs ends its own client as soon as it lands, and anyone waiting on it is refused. Before TASK-1061 that client stayed open and kept the process alive.
  - `:91`: replace the "`shutdown()` is the only escape hatch today … when the kernel gains a plugin-shutdown lifecycle" bullet. The kernel calls `shutdown()` at host stop and gives each plugin 10 s (`packages/core/src/bootstrap.ts:6`).

- [ ] **Step 6: Commit**

```bash
git add packages/eventbus-postgres
git commit -m "[TASK-1061] eventbus-postgres: a connect that lands after shutdown closes its client"
```

---

### Task 2: TCP keepalive on every pg pool and client [tier: integration]

**Files:**
- Modify: `packages/database-postgres/src/plugin.ts`. Add the constant beside `:32-37`, plus pool options at `:119-133` with a comment.
- Modify: `packages/session-postgres/src/plugin.ts`. Add the constant beside `:85-89`, plus pool options at `:847-856` and LISTEN-client options at `:916-919`.
- Modify: `packages/eventbus-postgres/src/listener.ts`. Add the constant, plus client options at `:68-71`.
- Create: `packages/database-postgres/src/__tests__/keepalive.test.ts`, `packages/session-postgres/src/__tests__/keepalive.test.ts`, `packages/eventbus-postgres/src/__tests__/keepalive.test.ts`
- Modify: `packages/database-postgres/SECURITY.md`. Add a bullet after `:28`, and rewrite `:34`.

**Interfaces:**
- Produces: `const KEEPALIVE_INITIAL_DELAY_MS = 10_000;`, module-private in each of the three source files. In session-postgres it lives in `plugin.ts`, and Task 5 passes it to `ListenConnection` as `keepAliveInitialDelayMs`.

- [ ] **Step 1: Write the three failing tests**

They share a pattern. With the container already up, save `const original = net.Socket.prototype.setKeepAlive` and install `vi.spyOn(net.Socket.prototype, 'setKeepAlive').mockImplementation(function (this: net.Socket, ...args) { seen.push([this.remotePort, ...args]); return original.apply(this, args); })`. That records the remote port AT CALL TIME: pg calls `setKeepAlive` on `'connect'`, and Node computes `remotePort` on demand, so it reads `undefined` once the socket has closed (after `h.close()`, or 10 s after `SELECT 1`, when pg-pool closes idle connections). Restore the spy in `finally`. Keep only the `seen` entries whose port is `container.getPort()`; Docker API sockets from testcontainers may also call `setKeepAlive`. Assert on `[enable, delay]` pairs.
  - database-postgres: boot the plugin (copy `instance()` from `statement-timeout.test.ts`), run `` sql`SELECT 1`.execute(db) ``, and expect the kept calls `toStrictEqual([[true, 10_000]])`.
  - session-postgres: boot `createSessionPostgresPlugin({ connectionString, logger })` through `createTestHarness`, and expect `[[true, 10_000], [true, 10_000]]`. Those are the migration's single pool connection and the LISTEN client; TASK-1056 measured exactly these two at boot.
  - eventbus-postgres: boot the plugin, call `` h.bus.call('eventbus:emit', h.ctx(), { channel: 'evb_keepalive', payload: {} }) ``, and expect `[[true, 10_000]]`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/<pkg> exec vitest run src/__tests__/keepalive.test.ts`, once per package.

Expected: FAIL, with `[]` received (P3: pg never calls `setKeepAlive` by default).

- [ ] **Step 3: Add the options**

Add `keepAlive: true, keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS` to `new pg.Pool({...})` in database-postgres, to `new pg.Pool({...})` and `new pg.Client({...})` in session-postgres, and to `new pg.Client({...})` in eventbus. Each gets a one-line comment:
- Why: a peer that vanishes without closing the connection is otherwise never noticed on an idle socket.
- Where it lives: config, not the URL, because pg ignores a URL `keepalives` param.
- Where the 20 s detection figure comes from.

- [ ] **Step 4: Run the tests and the three packages**

Run: the Step 2 commands, then `pnpm --filter @ax/database-postgres test`, `pnpm --filter @ax/session-postgres test`, `pnpm --filter @ax/eventbus-postgres test`.

Expected: PASS.

- [ ] **Step 5: Update database-postgres SECURITY.md**
  - New bullet in "Pool sizing and resource limits", after `:28`: **TCP keepalive: 10 s.** Every pooled connection turns it on. The bullet says who gains:
    - a connection that is checked out and silent for more than 10 s (waiting on a lock or a slow statement), or pinned and quiet (blob-gc's sweep lock during a sweep), notices a database that vanished without closing the connection (a node dies, a NAT forgets the mapping) in about 20 s instead of never;
    - idle pooled connections gain nothing, because pg-pool closes them at 10 s (`:28`), before the first probe;
    - the routines leader's pinned session gains nothing either, because it talks every tick (5 s).

    It is not configurable.
  - `:34` known limit: keepalive notices a dead peer only while the socket is idle. A statement whose bytes were never acknowledged waits on TCP's retransmission timeout instead (about 15 minutes with Linux defaults), and Node can't shorten that (no `TCP_USER_TIMEOUT`).

- [ ] **Step 6: Commit** with `git add` for the three plugin files, the three new tests and SECURITY.md. Message: `[TASK-1061] TCP keepalive on every Postgres pool and client`.

---

### Task 3: the shared pool ends a transaction left idle (`idleInTransactionTimeoutMs`) [tier: sensitive]

Why sensitive: this changes the failure mode of every shared-pool transaction for about 20 plugins. A unit slip (60 instead of 60_000) would kill password hashing mid-sign-up, and the connection-string guard has a bypass history.

**Files:**
- Modify: `packages/database-postgres/src/plugin.ts`: config JSDoc `:60-94`, `init` `:111-133`, guard `:244-280`, plus a resolver next to `:282-297`
- Create: `packages/database-postgres/src/__tests__/idle-in-transaction.test.ts`
- Modify: `packages/database-postgres/SECURITY.md:26`, `:30`, plus a new bullet after the whole statement-timeout block, i.e. after its "Known limit" sub-bullet (`:34` before Task 2 shifts it). Don't insert inside the sub-list.

**Interfaces:**
- Produces: `DatabasePostgresConfig.idleInTransactionTimeoutMs?: number`. The k8s preset passes nothing, so production gets the default with no plumbing.

- [ ] **Step 1: Write the failing tests** (`idle-in-transaction.test.ts`)

Copy `instance()` and `errorOf()` from `statement-timeout.test.ts`, and the recording logger from `error-handlers.test.ts`. Add `tryLock(key)`: a raw `pg.Client` runs `SELECT pg_try_advisory_lock($1) AS ok`, unlocks if it got the lock, and returns `ok`.

**Config** (no container; `postgres://ax@127.0.0.1:1/ax`):
  - `it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '300'])('refuses idleInTransactionTimeoutMs %s at boot')`: rejects `toMatchObject({ name: 'PluginError', code: 'invalid-config', plugin: '@ax/database-postgres', message: expect.stringContaining('idleInTransactionTimeoutMs') })`.
  - `it.each([1, 2_147_483_647])('accepts idleInTransactionTimeoutMs %s')`. A comment says these pass before the change too and guard the ends of the range.
  - `it.each([...])('refuses a connection string that sets the idle-in-transaction timeout itself: %s')`, with the same `toMatchObject` as above. Rows:
    - `?idle_in_transaction_session_timeout=0`
    - `?idle_in_transaction_session_timeout`
    - `?x%zz=1&%69dle_in_transaction_session_timeout=0`
    - `?sslmode=no-verify&idle_in_transaction_session_timeout=60000`

  Each row is measured in P5 (or uses the same pg decode path TASK-1056 pinned) to change the bound.

**Real database** (`describe` with the container):
  1. `'a transaction left idle past the bound is ended by the server, which frees its locks'`:
     ```ts
     const { records, logger } = recordingLogger();
     const db = await instance({ connectionString, idleInTransactionTimeoutMs: 500, logger });
     // capture uncaughtException/unhandledRejection into `unhandled` for the test's duration
     let release!: () => void;
     const gate = new Promise<void>((r) => (release = r)); // stands in for an awaited upload
     const outcome = errorOf(db.transaction().execute(async (trx) => {
       await sql`SELECT pg_advisory_xact_lock(4242)`.execute(trx);
       await gate;
       await sql`SELECT 1`.execute(trx);
     }));
     await expect.poll(() => tryLock(4242), { timeout: 5_000 }).toBe(true);
     release();
     expect(await outcome).toMatchObject({ message: 'Client has encountered a connection error and is not queryable' });
     expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
       ['error', 'database_postgres_client_error', { code: '25P03', name: 'error' }],
     ]);
     expect(unhandled).toEqual([]);
     expect((await sql<{ one: number }>`SELECT 1 AS one`.execute(db)).rows).toEqual([{ one: 1 }]);
     ```
     Call `release()` in a `finally` too, so a red run doesn't hang the file.
  2. `'a session-level advisory lock on a connection idle outside a transaction survives the bound'`. Label it a guard that passes before the change: it pins that we set the idle-IN-transaction timeout, never `idle_session_timeout`. Use `idleInTransactionTimeoutMs: 500` and `db.connection().execute(async (conn) => {...})`:
     - `SELECT pg_try_advisory_lock(77) AS ok` → `true`
     - sleep 1 500 ms
     - `SELECT 1` still answers
     - `tryLock(77)` → `false`
     - then `pg_advisory_unlock(77)`
  3. `'defaults to 60 seconds'`: `SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'` → `'60000'`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/database-postgres exec vitest run src/__tests__/idle-in-transaction.test.ts`

Expected FAILs:
- the bad-value rows: boot succeeds, because the field is ignored;
- the connection-string rows: accepted;
- test 1: the lock poll times out, because the lock stays held while the transaction idles;
- test 3: `'0'`.

Expected PASS: the range-end rows and test 2.

- [ ] **Step 3: Implement it**
  - Add `DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000` and `resolveIdleInTransactionTimeoutMs(value: unknown): number`, mirroring `resolveStatementTimeoutMs`. The error message is `` `${PLUGIN_NAME}: idleInTransactionTimeoutMs must be a whole number of milliseconds from 1 to 2147483647` ``.
  - Call it in `init` beside `:115`, and pass `idle_in_transaction_session_timeout: idleInTransactionTimeoutMs` to `new pg.Pool`. Add a comment: what Postgres does (ends the session with 25P03, and its locks go with it), why 60 s (see the field's JSDoc), and that a session idle outside a transaction is never ended.
  - Field JSDoc: covers what counts (only the gap between statements inside an open transaction), what the caller sees (a code-less "not queryable" error on the next statement; the pool drops the connection; `database_postgres_client_error` logs `25P03`), the range, the default, and why 60 s: twice the statement timeout, longer than any database-bounded wait a holder makes (a nested 5 s checkout plus a 30 s statement), so it ends only holders stuck on something with no bound of its own, such as routines' `blob:put`. It also says a future holder must not legitimately idle near 60 s. It also says to keep this value above `checkoutTimeoutMs + statementTimeoutMs` (35 s at the defaults) if either is raised. Below that sum, `withLockedWebhookSecret`'s deliberate hold (`routines/src/store.ts:1069-1074`: "their locks remain held while side effects can occur") can be cut mid-credential-write. Document this; don't enforce it. Production sets neither field (`presets/k8s/src/index.ts:586-591`), and a boot check would force the tests' pools below the ~1 s connect bound TASK-1049 found flaky.
  - Guard:
    - Rename `refuseStatementTimeoutInConnectionString` to `refuseServerTimeoutsInConnectionString` (one call site, `:113`).
    - Add `const URL_REFUSED_KEYS: ReadonlyMap<string, string> = new Map([['statement_timeout', 'statementTimeoutMs'], ['idle_in_transaction_session_timeout', 'idleInTransactionTimeoutMs']])`.
    - Replace `=== 'statement_timeout'` with a lookup on the normalized key, and throw `` `${PLUGIN_NAME}: connectionString must not set ${key}; use ${field}` ``. The statement-timeout text stays as it is.
    - Every other line of the function stays byte-identical. Update the comment block's first sentences to name both keys.

- [ ] **Step 4: Run the tests and the package**

Run: the Step 2 command, then `pnpm --filter @ax/database-postgres test`.

Expected: PASS everywhere, including all of `statement-timeout.test.ts`'s refusal rows.

- [ ] **Step 5: Update SECURITY.md**
  - `:26` pgBouncer note: the statement timeout AND the idle-in-transaction timeout both ride the startup packet.
  - `:30` "Lock waits are bounded on purpose": waiters give up at 30 s, and a holder that sits idle in its transaction is now ended at 60 s (see the new bullet).
  - New bullet right after the statement-timeout block (its sub-bullets end at the "Known limit" line that Task 2 rewrote; Task 2's insertion shifts the line numbers): **Idle-in-transaction timeout: 60 s (`idleInTransactionTimeoutMs`).** Cover:
    - what happens (25P03, the session ends, locks are released, the caller gets a code-less error, one `database_postgres_client_error` line);
    - why (routines' webhook admissions hold row and advisory locks across `blob:put`, and the S3 client has no request timeout);
    - why 60 s, and to keep it above `checkoutTimeoutMs + statementTimeoutMs` if either is raised;
    - that a connection idle outside a transaction is never ended (the routines leader's and blob-gc's session locks; `idle_session_timeout` is deliberately unset);
    - one home for the value (refused in the connection string; `options` can't override it, measured);
    - the known limit: the JS side of a stuck `blob:put` keeps waiting, so routines' in-process admission queue stays held until the upload settles (follow-up).

- [ ] **Step 6: Commit**

```bash
git add packages/database-postgres
git commit -m "[TASK-1061] database-postgres: Postgres ends a transaction left idle for 60 s, freeing its locks"
```

---

### Task 4: session-postgres: `ListenConnection`, a LISTEN connection that reconnects [tier: sensitive]

Concurrency: a reconnect state machine. connect, error, shutdown and callers interleave.

**Files:**
- Create: `packages/session-postgres/src/listen-connection.ts`
- Create: `packages/session-postgres/src/__tests__/listen-connection.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. The plugin passes the keepalive delay in (Task 5).
- Produces (exact):

```ts
export const LISTEN_CONNECTION_SHUT_DOWN = 'session-postgres LISTEN connection is shut down';
export interface ListenConnectionOptions {
  connectionString: string;
  connectTimeoutMs: number;          // pg connectionTimeoutMillis, per attempt
  keepAliveInitialDelayMs: number;   // pg keepAliveInitialDelayMillis (keepAlive: true always)
  logger: Logger;                    // from @ax/core
}
export interface ListenHooks {
  onNotification(msg: pg.Notification): void;
  /** Channels to LISTEN on a new client before it goes live. Iterated live, not snapshotted. */
  channels(): Iterable<string>;
}
export class ListenConnection {
  constructor(opts: ListenConnectionOptions);
  bind(hooks: ListenHooks): void;                // once; a second call throws Error('ListenConnection.bind called twice')
  ensureConnected(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
  queryIfConnected(text: string): Promise<void>; // never connects; resolves with no live client; swallows errors
  shutdown(): Promise<void>;
}
```

Log lines: `session_postgres_listen_client_error` (error) for every `'error'` event of any client this class made, and `session_postgres_listen_connect_failed` (warn) for each failed attempt that shutdown did not cause. Both take `faultLogFields(err)` only. Don't add a recovery line (TASK-1041 row 9).

- [ ] **Step 1: Write the failing tests** (`listen-connection.test.ts`)

Tests 1 and 2 need no Docker. Tests 3 and 4 share a container in a nested `describe`, and copy `holdingProxy`/`backends` from Task 1's test. Every test calls `shutdown()` in `afterEach`.
  1. `'a failed connect schedules the next attempt, and each failure is one code-only warn line'`:
     - `connectionString: 'postgres://ax:unused@127.0.0.1:1/ax'`, `connectTimeoutMs: 1_000`.
     - `await listen.ensureConnected().catch(() => {})`, then poll up to 3 500 ms for ≥ 2 `session_postgres_listen_connect_failed` records. Every binding is `toStrictEqual({ code: 'ECONNREFUSED', name: 'Error' })`. That value was measured (P6), and pg emits no client `'error'` on a failed connect, so only the catch can reschedule.
     - Then `await listen.shutdown()`, wait 2 500 ms, and check the count is unchanged.
  2. `'queryIfConnected never connects, and query() after shutdown() is refused without connecting'`:
     - Same unreachable URL. `await listen.queryIfConnected('UNLISTEN "x"')` resolves, and records are `[]`.
     - `await listen.shutdown()`. `listen.query('SELECT 1')` rejects `toMatchObject({ message: LISTEN_CONNECTION_SHUT_DOWN })`, and records are still `[]`.
  3. `'a connect that lands after shutdown() ends its client and refuses its caller'`:
     - Task 1's test against `ListenConnection` with `?application_name=session_listen_race`.
     - `ensureConnected()` rejects `{ message: LISTEN_CONNECTION_SHUT_DOWN }`, `backends(...)` polls to 0, and records are `[]`.
  4. `'a caller waits until a new client has LISTENed every bound channel'`:
     - `bind({ onNotification: () => {}, channels: () => ['ch_gate'] })`.
     - Wrap `pg.Client.prototype.query` with `vi.spyOn(...).mockImplementation`. For a string starting with `LISTEN `, set a `listenPending` flag and await a test gate, then call the original; call the original directly for anything else.
     - `const first = listen.ensureConnected()`, then poll for `listenPending`.
     - `const second = listen.query('SELECT 1 AS one')`, tracking settlement in a flag. After 200 ms, expect it still pending.
     - Release the gate, then `await first`. `second` resolves `{ rows: [{ one: 1 }] }`.
     - Restore the spy in `finally`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/session-postgres exec vitest run src/__tests__/listen-connection.test.ts`

Expected: FAIL. The module does not exist ("Failed to load url ../listen-connection.js").

- [ ] **Step 3: Implement `listen-connection.ts`**

The header comment says three things:
- this copies `@ax/eventbus-postgres`'s `Listener` (no cross-plugin imports) and lists the deliberate differences below;
- why LISTEN can't use the pool;
- why there is no `statement_timeout` (move the TASK-1056 comment from `plugin.ts:912-915`).

State: `client: pg.Client | null`, `connecting: Promise<void> | null`, `hooks: ListenHooks | null`, `backoffStep`, `reconnectTimer`, `shutdownRequested`. The ordering is the part the signatures don't determine:

```ts
ensureConnected():
  if shutdownRequested → throw new Error(LISTEN_CONNECTION_SHUT_DOWN)
  if client !== null → return                  // live = connected AND re-LISTENed
  connecting ??= connect().finally(() => { connecting = null })
  return connecting

connect():
  const c = new pg.Client({ connectionString, connectionTimeoutMillis: connectTimeoutMs,
                            keepAlive: true, keepAliveInitialDelayMillis: keepAliveInitialDelayMs })
  c.on('error', (err) => onClientError(c, err)); c.on('notification', (m) => hooks?.onNotification(m))
  try {
    await c.connect()
    for (const ch of hooks?.channels() ?? []) {          // live iteration: a channel dropped mid-loop is skipped
      if (shutdownRequested) break
      await c.query(`LISTEN ${pg.escapeIdentifier(ch)}`)
    }
    if (shutdownRequested) throw new Error(LISTEN_CONNECTION_SHUT_DOWN)
  } catch (err) {
    void c.end().catch(() => {})                         // not awaited
    if (!shutdownRequested) { logger.warn('session_postgres_listen_connect_failed', faultLogFields(err)); scheduleReconnect() }
    throw err
  }
  client = c; backoffStep = 0                            // live only now: no caller can NOTIFY before the re-LISTEN

onClientError(c, err):
  if shutdownRequested → return
  logger.error('session_postgres_listen_client_error', faultLogFields(err))   // every event: a killed backend logs two
  if (client === c) { client = null; scheduleReconnect() }  // the second event, or a stale client, drops nothing
  // Don't end() c here: pg is already closing it, and end() would swallow pg's second event.
```

The rest of the class:
- `scheduleReconnect()` copies eventbus's `:106-124`.
- `query()`: `await ensureConnected()`. Then read `client` once; if it is null (a shutdown raced), throw `LISTEN_CONNECTION_SHUT_DOWN`. Otherwise `return c.query(text, values)`.
- `queryIfConnected()`: read `client`; if it is null, return; otherwise `await c.query(text).catch(() => {})`.
- `shutdown()`: set the flag, clear the timer, null the client and `await c.end().catch(() => {})` on it. Do not wait for an in-flight connect.

- [ ] **Step 4: Run the tests**

Run: the Step 2 command.

Expected: PASS for 1 to 4. Then mutate it: assign `client = c` before the LISTEN loop and confirm test 4 fails (its `second` settles early). Then delete `scheduleReconnect()` from the catch and confirm test 1 fails with exactly one line. Revert both, and record the two mutants in the decisions shard.

- [ ] **Step 5: Commit**

```bash
git add packages/session-postgres/src/listen-connection.ts packages/session-postgres/src/__tests__/listen-connection.test.ts
git commit -m "[TASK-1061] session-postgres: ListenConnection, a LISTEN connection that reconnects with backoff"
```

---

### Task 5: session-postgres: the inbox rides `ListenConnection` (acceptance) [tier: sensitive]

Why sensitive: re-LISTEN ordering, the inbox's TOCTOU-sensitive refcount, and init/shutdown cleanup.

**Files:**
- Modify: `packages/session-postgres/src/inbox.ts`: `InboxOptions` `:140-153`, `createInbox` `:155-184`, `ensureListen` `:272-310`, `queue` `:372-373`, `terminate` `:425-439`
- Modify: `packages/session-postgres/src/plugin.ts`: the header (one sentence naming the reconnect), the `logger` JSDoc `:113-123`, state `:812-816`, LISTEN-client block `:912-927`, init try/catch `:929-952`, `createInbox` call `:954-962`, `shutdown` `:1226-1243`
- Modify: `packages/session-postgres/src/__tests__/inbox-corruption.test.ts:64-83`, `inbox-shutdown-race.test.ts:71-95`, `inbox-toctou.test.ts:71-101`
- Modify: `packages/session-postgres/src/__tests__/timeouts.test.ts:294-303`
- Create: `packages/session-postgres/src/__tests__/listen-reconnect.test.ts`

**Interfaces:**
- Consumes: `ListenConnection`, `ListenHooks`, `LISTEN_CONNECTION_SHUT_DOWN` (Task 4); `KEEPALIVE_INITIAL_DELAY_MS` in `plugin.ts` (Task 2).
- Produces: `InboxOptions.listen: ListenConnection`, which replaces `listenClient: pg.Client`. `createInbox` calls `listen.bind(...)`. `Inbox` itself is unchanged.

- [ ] **Step 1: Write the failing acceptance test** (`listen-reconnect.test.ts`)

Set up the container and the recording logger, and capture unhandled errors as in `error-handlers.test.ts`. Close harnesses and drop both tables in `afterEach`.

```ts
it('a claim parked before its LISTEN backend is terminated is woken by a later queue once the connection comes back', async () => {
  const h = await createTestHarness({ plugins: [createSessionPostgresPlugin({ connectionString, logger })] });
  await h.bus.call('session:create', h.ctx(), { sessionId: 's1', workspaceRoot: '/tmp/ws' });
  await h.bus.call('session:create', h.ctx(), { sessionId: 's2', workspaceRoot: '/tmp/ws' });
  const parked = h.bus.call('session:claim-work', h.ctx(), { sessionId: 's1', cursor: 0, timeoutMs: 20_000 });
  const old = await pollPid(`LISTEN "session_inbox_s1"`);                // admin: SELECT pid FROM pg_stat_activity WHERE query = $1
  await admin.query('SELECT pg_terminate_backend($1, 10000)', [old]);
  await pollPid(`LISTEN "session_inbox_s1"`, { not: old, timeout: 10_000 }); // the re-LISTEN on a new backend
  const queuedAt = Date.now();
  await expect(h.bus.call('session:queue-work', h.ctx(), {
    sessionId: 's1', entry: { type: 'user-message', payload: { role: 'user', content: 'hi' }, reqId: 'r1' },
  })).resolves.toEqual({ cursor: 0 });
  await expect(parked).resolves.toMatchObject({ type: 'user-message', reqId: 'r1', cursor: 1 }); // a delivery returns the NEXT cursor (inbox.ts deliver(); plugin.test.ts:393-400)
  expect(Date.now() - queuedAt).toBeLessThan(5_000);                    // a wake, not the 20 s timeout
  const fresh = h.bus.call('session:claim-work', h.ctx(), { sessionId: 's2', cursor: 0, timeoutMs: 20_000 });
  await pollPid(`LISTEN "session_inbox_s2"`);
  await h.bus.call('session:queue-work', h.ctx(), { sessionId: 's2', entry: { type: 'cancel' } });
  await expect(fresh).resolves.toMatchObject({ type: 'cancel', cursor: 1 });
  expect(unhandled).toEqual([]);
  expect(records.map((r) => [r.level, r.msg, r.bindings])).toStrictEqual([
    ['error', 'session_postgres_listen_client_error', { code: '57P01', name: 'error' }],
    ['error', 'session_postgres_listen_client_error', { name: 'Error' }],
  ]);
}, 60_000);
```

`pollPid(query, { not?, timeout = 5_000 })` uses `expect.poll` on a fresh admin `SELECT pid FROM pg_stat_activity WHERE query = $1 AND pid <> $2` (pass 0 when `not` is unset) and returns the pid. (P1 found the backend this way: `state: 'idle', query: 'LISTEN "session_inbox_s1"'`.)

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ax/session-postgres exec vitest run src/__tests__/listen-reconnect.test.ts`

Expected: FAIL at the re-LISTEN poll; no LISTEN backend ever comes back (P1). If you push past that poll, `queue-work` rejects `Client has encountered a connection error and is not queryable`, and `parked` resolves `{ type: 'timeout' }` at 20 s.

- [ ] **Step 3: Add the no-reconnect-after-failed-init assertion**

In `timeouts.test.ts`'s `"the LISTEN client's connect fails once checkoutTimeoutMs passes, so init fails"` (`:294-303`), after the existing assertions:

```ts
await new Promise((r) => setTimeout(r, 2_500));
expect(p.acceptedAt).toHaveLength(2); // TASK-1061: a failed init leaves no reconnect behind
```

It passes on today's code, which has no reconnect. Its comment says so: it guards the new reconnect.

- [ ] **Step 4: Change the inbox**
  - `InboxOptions.listen: ListenConnection`, with its JSDoc rewritten from `:142-146`: the plugin owns the lifecycle, and the connection reconnects and LISTENs again on its own.
  - In `createInbox`, call `listen.bind({ onNotification: <today's handler body at :176-184>, channels: () => listenedChannels.keys() })` in place of `listenClient.on('notification', …)`.
  - `ensureListen`'s LISTEN at `:288` becomes `listen.query(...)`. The rest of the refcount code at `:274-297` (the synchronous bump before the await, and the rollback on failure) stays byte-identical.
  - `unlistenIfLast`'s UNLISTEN becomes `listen.queryIfConnected(...)`. The re-LISTEN skips channels that are no longer counted.
  - `queue`'s `pg_notify` becomes `listen.query(...)`, which still rejects on failure.
  - `terminate`'s becomes `listen.query(...).catch(() => {})`.
  - Reword the comments at `:303-304` and `:432-433` to name `ListenConnection`. They described a reconnect that didn't exist until now.

- [ ] **Step 5: Change the plugin**
  - `listen = new ListenConnection({ connectionString: config.connectionString, connectTimeoutMs: checkoutTimeoutMs, keepAliveInitialDelayMs: KEEPALIVE_INITIAL_DELAY_MS, logger: bgLogger })` replaces the `new pg.Client` block (`:912-927`, including its `'error'` listener: `ListenConnection` writes the same line).
  - `await listen.ensureConnected()` replaces `listenClient.connect()`. The catch runs `await listen.shutdown()` in place of `listenClient.end()`, so no reconnect timer outlives a failed init.
  - `createInbox({ db: kysely, listen, isTerminated })`.
  - `shutdown()` runs `await listen.shutdown()` after `inbox.shutdown()` and before `kysely.destroy()` (today's order).
  - The `logger` JSDoc lists `session_postgres_listen_connect_failed` (warn) too.

- [ ] **Step 6: Update the three inbox tests**

Each one builds `new ListenConnection({ connectionString, connectTimeoutMs: 5_000, keepAliveInitialDelayMs: 10_000, logger: <noop> })` and `await listen.ensureConnected()`. Cleanup pushes `() => listen.shutdown()`. They call `createInbox({ db, listen, isTerminated })`. `inbox-toctou` wraps `listen.query` exactly the way it wraps `listenClient.query` today, and the corruption helper's returned field becomes `listen`.

- [ ] **Step 7: Run everything in the package**

Run: the Step 2 command, then `pnpm --filter @ax/session-postgres test`.

Expected: PASS. Specifically:
- `error-handlers.test.ts` still sees exactly two LISTEN lines and no `connect_failed` line;
- `timeouts.test.ts` LISTEN connect still rejects `timeout expired` in 800–3 000 ms, and its startup-packet test is unchanged;
- `keepalive.test.ts` (Task 2) still sees two calls, now one of them from `ListenConnection`.

Mutate it: drop `await listen.shutdown()` from init's catch, and confirm the `timeouts.test.ts` assertion fails with 3. Revert.

- [ ] **Step 8: Commit**

```bash
git add packages/session-postgres
git commit -m "[TASK-1061] session-postgres: the LISTEN connection reconnects and re-LISTENs, so chat survives a dropped connection"
```

---

### Task 6: memory shard and the full gate [tier: mechanical]

**Files:**
- Create: `.claude/memory/patterns/2026-11-06-TASK-1061.md` (path from `scripts/memory-write-target.sh --shard patterns TASK-1061`; `mkdir -p` its directory)

- [ ] **Step 1: Write the patterns rows** in the TASK-1058 table format.
  1. Every pg connection has TCP keepalive (10 s, constant per package, not configurable; pg ignores a URL `keepalives`). The test pattern: spy `net.Socket.prototype.setKeepAlive` and filter `mock.contexts` by `remotePort`.
  2. The shared pool's `idleInTransactionTimeoutMs` (60 s). A killed holder gets a code-less "not queryable", and the line carries `25P03`. Session-level locks on idle pinned connections are safe. session-postgres's pool deliberately has no bound. The value is refused in the URL.
  3. session-postgres's LISTEN connection reconnects (`ListenConnection`; its lines; it goes live only after re-LISTEN). This supersedes TASK-1056 decisions row 11(c), and TASK-1058 patterns row 1's implication that the LISTEN line is terminal.
  4. An eventbus connect that lands after shutdown ends its client.
  5. A holding proxy (buffer server→client bytes) lands a connect after `shutdown()` on demand.
- [ ] **Step 2: Commit the shard:** `[TASK-1061] memory: patterns for Postgres keepalive, idle-in-transaction bound, LISTEN reconnect`. Then run `scripts/memory-append-check.sh` (it compares committed HEAD with `origin/main`). Expected: exit 0 (no archive touched, no line deleted).
- [ ] **Step 3: Run the gate**
  - `pnpm build && pnpm lint`
  - `pnpm --filter @ax/eventbus-postgres test && pnpm --filter @ax/database-postgres test && pnpm --filter @ax/session-postgres test`
  - `pnpm --filter @ax/database-postgres build && pnpm --filter @ax/routines test`. Routines is the shared pool's most exposed consumer. Under host load CI is the authority; TASK-1056 row 13 records the measured start-slot noise.
  - `pnpm --filter @ax/preset-k8s test` (canary reachability)
  - `pnpm test:eslint-rules && pnpm test:scripts`
- [ ] **Step 4: Record the gate.** Log each suite's result, and any environmental reruns (start-slot waits, load), as a row in the decisions shard. Commit that row too.

---

## Out of scope (return as follow-up cards)

- **Routines' webhook admission queue behind a stuck `blob:put`.** `serializeAdmission` (`admission-order.ts:6-20`) is one in-process FIFO. This card frees the database locks and the pool slot, but the stuck JS await still holds every later admission in the process. Candidates: a request or idle timeout on the S3 handler (`blob-store-s3/src/plugin.ts:166-198` builds the client with none) and on fs operations, or a deadline on `persist()`'s `blob:put`. This can conflict with TASK-1050, so sequence it after that card.
- **Per-agent purge batching** (TASK-1056 row 11(d)). About 20 packages, and session-postgres's purge is atomic by design. It is only needed if one agent's rows grow past what a 30 s statement can delete.
- **eventbus-postgres's two raw `err` lines** (`listener.ts:82-84`, `:98-100`) should become code-only. Also its `onClientError` nulls `this.client` without checking the client's identity (unreachable today).
- **`session:queue-work` rejects after its INSERT landed** whenever the NOTIFY fails, so a caller sees a failure for a message the runner will still get. Candidate: send `pg_notify` through the pool, or in the INSERT's transaction.
- **A statement sent into a dead network path** waits on TCP retransmission (about 15 min on Linux). This includes the routines leader's `SELECT 1` probe on a black-holed connection. Node exposes no `TCP_USER_TIMEOUT`.
- **Timeout codes for the LISTEN clients' and eventbus's connect errors** (TASK-1056 row 11(e)), and operator knobs (row 11(g), YAGNI).
- **A dropped LISTEN client whose socket never closes** (a pg protocol desync: `'error'` with the socket left up) stays open until the process exits, in both `ListenConnection` and eventbus's `Listener`. Candidate: keep dropped clients in a set, remove each on its `'end'`, and end the rest at `shutdown()` (or end each after a 1 s grace that its `'end'` cancels). This needs a fake server that sends an unexpected message to test.

## Security and boundary notes

- **security-checklist: not required.** Nothing touches a sandbox, IPC, plugin loading, untrusted-content handling or a dependency (pg is already pinned). Reconnects go to the same configured database, and each plugin still holds at most one LISTEN connection. Log lines carry codes only. The URL guard only refuses more. Test servers bind `127.0.0.1:0`. TASK-1048, 1049, 1056 and 1058 made the same call.
- **Boundary review: not required.** No hook signature or payload changes.
- **Invariants 1–6 checked.** Construction config only. Code is copied, not imported. Defaults reach production through the k8s preset with no plumbing, so nothing is half-wired. The inbox stays the one owner of the channel set (`ListenConnection` reads it through `channels()`). No new reach. No UI.
