# TASK-1041: a failed tick election no longer stops the routines scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the tick loop's leader-election step hits a database error, it logs one code-only line and tries again with a capped backoff. The scheduler never stops for that reason. If the loop ever does end on an error (a bug), plugin.ts says so in codes, not the raw message.

**Architecture:** `runTickLoop` (tick.ts) wraps its `db.connection().execute(...)` call, which holds both the pool checkout and the `pg_try_advisory_lock` query, in a try/catch. A failure is counted and logged through a new injected `logger` (plugin.ts passes `initCtx.logger`) with `faultLogFields`. The loop then sleeps outside `execute`, starting at one tick and doubling up to `electionRetryMs`, and goes round again. An election that completes resets the count. plugin.ts's `.catch` backstop logs `faultLogFields` at error.

**Tech Stack:** TypeScript, kysely 0.28.17 + pg 8.20.0 (testcontainers Postgres), vitest 5, `@ax/core` (`faultLogFields`, `Logger`, `createLogger`).

**Spec:** the card (condensed below) and `.claude/memory/decisions/2026-11-05-TASK-1041.md`, which holds every decision with its rationale and the alternatives turned down.

## Spec

The card asks for:

- A failed election step logs one code-only line (`faultLogFields`).
- The loop keeps going: retry on the next tick, with backoff if it keeps failing.
- A decision on whether a run of consecutive failures should also show up somewhere an operator looks, such as a health signal.
- Acceptance: a tick test where the election query throws once. The loop survives, logs one line, and the next tick fires a due routine. Prove the test fails before the fix.

Planning settled this (decisions rows in brackets):

1. Premise confirmed at 2739cb157. `tick.ts:224-253` has no catch around `execute`. Kysely checks out the connection inside `execute` (`DefaultConnectionProvider.provideConnection`), so a checkout failure and a failed lock query both end `runTickLoop`. Nothing restarts it, and `plugin.ts:384-386` writes the raw error once. Production impact is narrower than the card implies: host replicas are pinned to 1 (`deploy/charts/ax-next/templates/_helpers.tpl:403-408`), so the election normally runs once per boot. [row 1]
2. The guard wraps the whole `execute` call. Backoff is `min(tickIntervalMs × 2^(n−1), electionRetryMs)`: 5, 10, 20, 40, 50, 50 s with the defaults. A completed election resets the count. [rows 2-3]
3. The line is `routines_tick_election_failed` (warn, JSON via the core logger) carrying `faultLogFields(err)`, `consecutiveFailures` and `retryInMs`. [row 4]
4. No health signal. `/health` is a static 200 that serves as the readiness probe, the liveness probe and the GKE LB check, and there is no metrics export. The log line is the operator signal. [row 7]
5. plugin.ts's backstop becomes `routines_tick_loop_died` (error, `faultLogFields`). [row 6]
6. Not in scope: tick.ts's other stderr lines keep their message text (TASK-1038 row 12) [row 5]. A dying pinned connection while this replica leads is a separate failure: inferred host crash, follow-up card [row 8].

## Global Constraints

- Don't edit `packages/routines/src/webhook-handler.ts`, anything in `packages/http-server/` (TASK-1044), or anything in `packages/channel-web/` (TASK-1040).
- New log lines go through the core logger as JSON. They carry `faultLogFields(err)` and the named numbers only. Never pass `err`, `err.message`, `String(err)` or `logDetail(err)`: a driver's message can carry a host, port, user or query value.
- Exact names: `routines_tick_election_failed` at `warn` with bindings `consecutiveFailures` and `retryInMs`. `routines_tick_loop_died` at `error`.
- tick.ts's existing stderr lines (`materialize/refresh error:`, `fire failed for`, `tick error:`) and the tests that pin them stay byte-identical.
- Never sleep inside the `execute` callback for a failure or a lost election. The connection goes back to the pool while the loop waits.
- `packages/routines` keeps tests out of `tsc`. Lint touched test files; `no-unused-vars` is an error in tests.
- `tick.test.ts` starts a Postgres testcontainer (`fixture()`), so set `DOCKER_HOST` explicitly (CLAUDE.md). `repeat-plugin-start.test.ts` needs no Docker.
- Every new test is run red before its fix, and the red output goes in the PR body (card acceptance, Bug Fix Policy).
- No hook change, no migration, no new dependency. Memory rows go to `.claude/memory/<kind>/2026-11-05-TASK-1041.md` shards only.

## Review Focus

1. **Postgres unreachable for minutes or hours** (maintenance, failover). The loop never ends. It warns once per attempt, waits at most `electionRetryMs` between attempts, and schedules again within one wait of recovery. Pinned by Task 1's backoff test (cap) and acceptance test (recovery).
2. **The host shuts down while the loop waits after a failure.** Host shutdown awaits the loop (`plugin.ts:404`). A wait that ran out its 50 s would outlast the pod's 30 s grace period (`values.yaml` `terminationGracePeriodSeconds: 30`) and get the host SIGKILLed mid-shutdown. The wait must end on abort. Pinned by Task 1's shutdown test.
3. **The failure's message carries connection details or query values.** Only identifier-shaped codes reach the log. Pinned by `PRIVATE` text that is injected and asserted absent in Task 1's tests and Task 2's test.
4. **A lost election is not a failure.** Another session holding the lock logs nothing, waits `electionRetryMs`, and ends a failure run, so the next failure starts again at one tick. Pinned by Task 1's backoff test.
5. **A tick that fails while this replica leads is not an election failure.** It keeps its `tick error:` stderr line and its cadence, and adds no election line. Pinned by Task 1's edit to the two existing loop tests (`log.entries()` stays `[]`).

Known and not handled here: the pinned connection dying while this replica leads (decisions row 8, follow-up).

## File map

| File | Change | Task |
|---|---|---|
| `packages/routines/src/tick.ts` | guard + backoff + `logger` input | 1 |
| `packages/routines/src/plugin.ts:376-383` | pass `logger: initCtx.logger` | 1 |
| `packages/routines/src/__tests__/support/fail-query.ts` | new: fail matching statements N times | 1 |
| `packages/routines/src/__tests__/tick.test.ts` | 3 new tests, `logger` on the 2 existing loop tests | 1 |
| `packages/routines/src/plugin.ts:384-386` | backstop logs codes | 2 |
| `packages/routines/src/__tests__/repeat-plugin-start.test.ts` | overridable loop mock + 1 test | 2 |

---

### Task 1: A failed election logs its codes and the loop tries again [tier: sensitive]

Leader election on a pinned connection that holds a session-scoped advisory lock. A sleep or catch in the wrong place holds a pooled connection or the lock. `security-checklist` is not required (decisions row 11).

**Files:**
- Create: `packages/routines/src/__tests__/support/fail-query.ts`
- Modify: `packages/routines/src/__tests__/tick.test.ts` (imports at `:1-5`; helper after `HOSTILE` at `:24`; the two loop tests at `:142-167`; three new `it`s at the end of `describe('DB scheduler')`)
- Modify: `packages/routines/src/tick.ts:1` (import), `:192-209` (`TickLoopInput`), `:213-259` (`runTickLoop`), new private function after it
- Modify: `packages/routines/src/plugin.ts:376-383` (one field)

**Interfaces:**
- Produces (tick.ts, used by plugin.ts here and Task 2's mock):

```ts
export interface TickLoopInput {
  // …existing fields unchanged…
  /** TASK-1041: where a failed election is reported, in codes only. plugin.ts passes its init logger. */
  logger: Pick<Logger, 'warn'>;
  /** How long a replica that lost the election waits before trying again. TASK-1041: also the longest wait after a failed one. */
  electionRetryMs: number;
}
```

- Produces (test support):

```ts
/** Makes the first `times` statements whose SQL matches `match` reject with `error` before they reach Postgres, for every pg client in this test process. Returns the function that puts `query` back; call it in a `finally`. */
export function failQueries(match: RegExp, error: unknown, times?: number): () => void; // times defaults to 1
```

- [ ] **Step 1: Write the support helper.** Model it on `support/slow-database.ts:18-29`, which patches `pg.Client.prototype.query`. While `times` remain, a call whose first argument is a string matching `match` decrements the count and returns `Promise.reject(error)` without calling the original. Every other call goes to the original with the same `this` and arguments. Kysely always calls `client.query(sql, params)`, the promise form. The doc comment says why the helper exists: the card's acceptance needs the real election statement to fail once, with the real pool and Kysely's release-on-throw (`provideConnection`'s `finally`) running for real.

- [ ] **Step 2: Write the failing tests in `tick.test.ts`.** Add imports `createLogger` from `@ax/core`, `systemClock` from `../clock.js`, and `failQueries` from `./support/fail-query.js`. Add this helper after `HOSTILE`:

```ts
/** TASK-1041: a core logger that keeps its JSON lines; entries() drops ts and reqId. */
function recordingLogger() {
  const lines: string[] = [];
  const logger = createLogger({ reqId: 'tick-test', writer: line => { lines.push(line); } });
  const entries = () => lines.map(line => { const { ts: _ts, reqId: _reqId, ...entry } = JSON.parse(line) as Record<string, unknown>; return entry; });
  return { logger, entries, text: () => lines.join('\n') };
}
```

In the two existing loop tests (`keeps the scheduler loop running when a tick fails with %s` and `logs a readable tick failure with its message and keeps the loop running`), create `const log = recordingLogger();`, pass `logger: log.logger`, and add `expect(log.entries()).toEqual([]);` after the existing assertions. Leave their stderr expectations as they are.

Append these three tests to `describe('DB scheduler')`:

```ts
it('keeps scheduling when the election query fails once, and logs it in codes only (TASK-1041)', async () => {
  const row = await f.store.createAuthored(createInput());
  const controller = new AbortController();
  const sleeps: number[] = [];
  const fire = vi.fn(async (_d: AcceptedDispatch) => result);
  const log = recordingLogger();
  const restore = failQueries(/pg_try_advisory_lock/, Object.assign(new Error('PRIVATE election detail at 10.0.0.7'), { code: '57P01' }));
  try {
    await runTickLoop({
      db: f.db, fire, logger: log.logger,
      clock: { now: () => due, sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 2) controller.abort(); } },
      signal: controller.signal, tickIntervalMs: 1000, electionRetryMs: 50_000, claimBatchSize: 50, claimWindowMinutes: 5,
    });
  } finally { restore(); }
  expect(sleeps).toEqual([1000, 1000]); // the wait after the failure, then the elected ticker's own tick
  expect(fire).toHaveBeenCalledOnce();
  expect(fire.mock.calls[0]![0].row.routineId).toBe(row.routineId);
  expect(log.entries()).toStrictEqual([{ code: '57P01', name: 'Error', consecutiveFailures: 1, retryInMs: 1000, level: 'warn', msg: 'routines_tick_election_failed' }]);
  expect(log.text()).not.toContain('PRIVATE');
});
it('backs off from one tick to the election wait while elections fail, and starts over once one answers (TASK-1041)', async () => {
  const controller = new AbortController();
  const refused = () => Promise.reject(Object.assign(new Error('PRIVATE connect detail at 10.0.0.7:5432'), { code: 'ECONNREFUSED' }));
  const outcomes: Array<() => Promise<boolean>> = [refused, refused, refused, refused, async () => false, refused];
  const db = { connection: () => ({ execute: () => outcomes.shift()!() }) } as unknown as Parameters<typeof runTickLoop>[0]['db'];
  const sleeps: number[] = [];
  const log = recordingLogger();
  await runTickLoop({
    db, fire: vi.fn(async () => result), logger: log.logger,
    clock: { now: () => due, sleep: async (ms) => { sleeps.push(ms); if (outcomes.length === 0) controller.abort(); } },
    signal: controller.signal, tickIntervalMs: 1000, electionRetryMs: 3000, claimBatchSize: 50, claimWindowMinutes: 5,
  });
  // Doubling from one tick, capped at the election wait; a lost election waits the election wait and ends the run.
  expect(sleeps).toEqual([1000, 2000, 3000, 3000, 3000, 1000]);
  expect(log.entries().map(e => [e.msg, e.code, e.consecutiveFailures, e.retryInMs])).toEqual([
    ['routines_tick_election_failed', 'ECONNREFUSED', 1, 1000],
    ['routines_tick_election_failed', 'ECONNREFUSED', 2, 2000],
    ['routines_tick_election_failed', 'ECONNREFUSED', 3, 3000],
    ['routines_tick_election_failed', 'ECONNREFUSED', 4, 3000],
    ['routines_tick_election_failed', 'ECONNREFUSED', 1, 1000],
  ]);
  expect(log.text()).not.toContain('PRIVATE');
});
it('stops at once when shut down while waiting after a failed election (TASK-1041)', async () => {
  const controller = new AbortController();
  const db = { connection: () => ({ execute: () => Promise.reject(Object.assign(new Error('PRIVATE'), { code: '57P03' })) }) } as unknown as Parameters<typeof runTickLoop>[0]['db'];
  const log = recordingLogger();
  const loop = runTickLoop({
    db, fire: vi.fn(async () => result), logger: log.logger, clock: systemClock,
    signal: controller.signal, tickIntervalMs: 600_000, electionRetryMs: 600_000, claimBatchSize: 50, claimWindowMinutes: 5,
  });
  await vi.waitFor(() => expect(log.entries()).toHaveLength(1));
  const abortedAt = Date.now();
  controller.abort();
  await loop;
  expect(Date.now() - abortedAt).toBeLessThan(1000);
});
```

- [ ] **Step 3: Run them red against the unchanged tick.ts and save the output for the PR body.**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/tick.test.ts --maxWorkers=1` (with `DOCKER_HOST` set)
Expected:
- the acceptance test FAILS: rejects with `PRIVATE election detail at 10.0.0.7`
- the backoff test FAILS: rejects with `PRIVATE connect detail at 10.0.0.7:5432`
- the shutdown test FAILS: the `waitFor` times out on `[]` (plus an unhandled `57P03` rejection)
- every other test PASSES (the extra `logger` field is ignored at runtime)

- [ ] **Step 4: Implement it in `tick.ts`.** Change the import to `import { faultLogFields, SafeToolError, type Logger } from '@ax/core';`. Add the two documented fields to `TickLoopInput` as in Interfaces. In `runTickLoop`:
  - Keep the pinned callback's body exactly as it is, including the pin comment at `:215-223`.
  - Before the `while`, declare `let failures = 0;` (failed elections in a row).
  - Await `input.db.connection().execute(...)` inside `try`, assigning to a `let acquired: boolean` declared just above it.
  - In `catch (err)`:
    1. `failures += 1`
    2. `const retryInMs = electionBackoffMs(failures, input)`
    3. `input.logger.warn('routines_tick_election_failed', { ...faultLogFields(err), consecutiveFailures: failures, retryInMs })`
    4. `await input.clock.sleep(retryInMs, input.signal)`
    5. `continue`
  - Read the error only through `faultLogFields`.
  - The catch's comment says three things:
    - Nothing restarts this loop, so ending here would stop this replica scheduling until the host restarts.
    - Every tick's own failure is caught inside, so in practice only the checkout and the lock query get here.
    - The line is codes only because a driver's message can carry a host, user or query value.
  - After `execute` resolves: `failures = 0;`, then the existing `if (!acquired)` sleep of `electionRetryMs`, unchanged.

Add after `runTickLoop`:

```ts
/** TASK-1041: the wait after the `failures`th failed election in a row: one tick, doubling, never longer than a lost election's wait. */
function electionBackoffMs(failures: number, input: Pick<TickLoopInput, 'tickIntervalMs' | 'electionRetryMs'>): number {
  return Math.min(input.tickIntervalMs * 2 ** Math.min(failures - 1, 16), input.electionRetryMs);
}
```

In `plugin.ts:376-383` add `logger: initCtx.logger,` to the `runTickLoop({ ... })` input.

- [ ] **Step 5: Run green, typecheck, lint.**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/tick.test.ts --maxWorkers=1`. Expected: all PASS.
Run: `pnpm --filter @ax/routines build`. Expected: exit 0. This fails if plugin.ts doesn't pass `logger`.
Run: `pnpm exec eslint packages/routines/src/tick.ts packages/routines/src/plugin.ts packages/routines/src/__tests__/tick.test.ts packages/routines/src/__tests__/support/fail-query.ts`. Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add packages/routines/src/tick.ts packages/routines/src/plugin.ts packages/routines/src/__tests__/tick.test.ts packages/routines/src/__tests__/support/fail-query.ts
git commit -m "fix(routines): a failed tick election logs its codes and retries instead of stopping the scheduler (TASK-1041)"
```

---

### Task 2: If the scheduler loop ever ends, plugin.ts logs codes, not its message [tier: mechanical]

**Files:**
- Modify: `packages/routines/src/__tests__/repeat-plugin-start.test.ts:11-12` (the `../tick.js` mock), new `it` at the end
- Modify: `packages/routines/src/plugin.ts:384-386`

**Interfaces:**
- Consumes: `runTickLoop` (mocked here; only its rejection matters).

- [ ] **Step 1: Make the loop mock overridable, and write the failing test.** Replace the mock at `:11-12` with a hoisted `vi.fn` that keeps today's behaviour by default, as `drain` does at `:6`:

```ts
const loop=vi.hoisted(()=>({run:vi.fn(({signal}:{signal:AbortSignal})=>new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve())))}));
vi.mock('../tick.js',async original=>({...await original<typeof import('../tick.js')>(),runTickLoop:loop.run}));
```

Append, in the file's style:

```ts
// TASK-1041: runTickLoop rides out its own failures; if it ever ends on one, the line says so with codes, never its message.
it('logs a scheduler loop that ends with its codes and without its message',async()=>{
  const bus=new HookBus();
  bus.registerService('database:get-instance','test',async()=>({db:{}}));
  bus.registerService('tool:register','test',async()=>({}));
  bus.registerService('http:register-route','test',async()=>({unregister:()=>{}}));
  loop.run.mockImplementationOnce(async()=>{throw Object.assign(new Error('PRIVATE loop detail at 10.0.0.7'),{code:'57P01'});});
  const lines:string[]=[];
  const capture=(chunk:unknown)=>{lines.push(String(chunk));return true;};
  const stdout=vi.spyOn(process.stdout,'write').mockImplementation(capture);
  const stderr=vi.spyOn(process.stderr,'write').mockImplementation(capture);
  const interval=vi.spyOn(globalThis,'setInterval');
  const plugin=createRoutinesPlugin();
  try {
    await plugin.init({bus} as Parameters<typeof plugin.init>[0]);
    const died=()=>lines.join('').split('\n').filter(l=>l.startsWith('{"')).map(l=>JSON.parse(l) as Record<string,unknown>)
      .filter(entry=>entry.msg==='routines_tick_loop_died').map(({ts:_ts,reqId:_reqId,...entry})=>entry);
    await vi.waitFor(()=>expect(died()).toStrictEqual([{msg:'routines_tick_loop_died',level:'error',code:'57P01',name:'Error'}]));
    expect(lines.join('')).not.toContain('PRIVATE');
  } finally {
    await plugin.shutdown?.();
    for(const result of interval.mock.results)if(result.type==='return')clearInterval(result.value);
    interval.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
```

- [ ] **Step 2: Run it red and save the output.**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/repeat-plugin-start.test.ts`
Expected: the new test FAILS. `died()` stays `[]` because today's line is raw stderr text: `[ax/routines] tick loop died: Error: PRIVATE loop detail at 10.0.0.7`. The three existing tests PASS.

- [ ] **Step 3: Implement it.** At `plugin.ts:384-386` the catch becomes `(err: unknown) => { initCtx.logger.error('routines_tick_loop_died', faultLogFields(err)); }`. `faultLogFields` is already imported at `:1`. Its comment says two things: runTickLoop retries its own failures, so getting here is a bug. If it happens, this replica schedules nothing until the host restarts.

- [ ] **Step 4: Run green and lint.**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/repeat-plugin-start.test.ts`. Expected: 4 PASS.
Run: `pnpm --filter @ax/routines build && pnpm exec eslint packages/routines/src/plugin.ts packages/routines/src/__tests__/repeat-plugin-start.test.ts`. Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add packages/routines/src/plugin.ts packages/routines/src/__tests__/repeat-plugin-start.test.ts
git commit -m "fix(routines): a scheduler loop that ends logs its codes, not its message (TASK-1041)"
```

---

## Final gate (after Task 2)

```bash
pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
pnpm lint
```

Set `DOCKER_HOST` explicitly for the Docker-backed suites. Grep check (TASK-1038 mistakes row): `git grep -n "tick loop died"` should match nothing outside `docs/plans/` once Task 2 lands.

## PR body material

**Red before green:** paste the outputs of Task 1 Step 3 and Task 2 Step 2.

**Boundary review:** not needed. No hook signature or payload changes. `TickLoopInput` is a function input internal to `@ax/routines`.

**Security note** (checklist not required; decisions row 11):
- Sandbox escape: N/A. No sandbox, IPC, process, file or network-reach change.
- Prompt injection: N/A. No model, tool or user content is read or logged. The new lines carry `faultLogFields` codes and two numbers. Tests inject message text (`PRIVATE … 10.0.0.7`) and assert it never reaches the log.
- Supply chain: no new dependency. `pg` is already a dev dependency for the test helper.

**Impact, stated plainly:** with one host replica (enforced by the chart), the election normally runs once per boot. It also re-runs every 50 s while another session still holds the lock, for example a killed pod's backend that Postgres hasn't reaped. Before this fix, a database blip at either moment stopped all routines on the host until the next restart. The only trace was one raw stderr line, and `/health` kept answering 200.

**Follow-ups to return to auto-ship:**
- (a) **INFERRED, worth a probe first:** the leader's pinned connection has no `'error'` listener. pg-pool removes its idle listener at checkout (`pg-pool/index.js:344`), and neither Kysely nor pg's Client adds one. So Postgres ending that session while the ticker sleeps should throw an unhandled `'error'` event and exit the host, which then restarts and takes every in-flight chat with it. To reproduce on a testcontainer, run `pg_terminate_backend` on the ticker's pid between ticks. The fix needs two parts that ship together:
  - a per-client error listener in `@ax/database-postgres`
  - a step-down in routines when the pinned connection dies. Without it, the leader would log `tick error: Client has encountered a connection error and is not queryable` every tick forever.
- (b) Optional: tick.ts's other stderr lines still print error messages, a choice TASK-1038 row 12 kept on purpose. Applying the code-only rule to every routines log line would be its own card, with six pinned tests to change.
