# TASK-937 A retried reply after a host restart, and a deadline for the task page's requests: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reply retried after a host restart cut its check-in off starts one more check-in instead of nothing, and every request the task page waits on gives up after 8 seconds, so a hung request ends as an ordinary failure and the page gets its buttons and its re-reads back.

**Architecture:** Two independent halves. Routines (Tasks 1-2): the store learns to tell a check-in the restart sweep cut off before it reported (`getDispatchOutcome` answers `miss: 'interrupted'`, recognized by the sweep's own fixed error, `RUN_INTERRUPTED`) and to find the check-in a request started whatever the routine's revision is now (`acceptedDispatchId`); `replyCheckIn` then walks a reply's check-ins, each restart keyed on the reply and the check-in it replaces (`reply:<replyId>:after:<dispatchId>`), so retries at once still start one between them, up to 3 restarts per reply. channel-web (Tasks 3-4): an opt-in `withRequestTimeout` in `lib/http.ts` bounds a whole request (fetch, status, body) with an `AbortController`; the nine requests to a task's own address and every `routineApi` request use it, at `REQUEST_TIMEOUT_MS = 8_000`, under the page's 10 s re-read. No schema change (routines stays at version 13), no hook-signature change, no new copy.

**Tech Stack:** TypeScript, Kysely on Postgres 16 (testcontainers), vitest 5 with fake timers, jsdom 26, @testing-library/react (`renderHook`).

**Spec:** the TASK-937 card (restated and checked under Premises), `docs/plans/2026-10-20-agent-tasks-design.md` (replies: line 240, line 689, decision rows 1020-1024). Decisions behind this plan: `.claude/memory/decisions/2026-10-25-TASK-937.md`.

## Premises, checked against 9832ad50b

**True.**
- Item 1: `replyCheckIn` (`packages/routines/src/services.ts:197-222`) accepts under `reply:<replyId>` and answers `replayed` on a replayed receipt or a `request-conflict`, whatever became of that check-in. Its doc (`:187-195`) says so. A retry after the restart sweep (`store.ts:941-950`) finished the check-in as interrupted starts nothing; the reply box then says "Sent. {agent} started checking in." and the page spins "Checking in now..." for 5 minutes over a check-in that isn't running.
- The sweep runs in routines' init before its services register (`plugin.ts:114`, `:309`), and the chart runs one host with a Recreate rollout, so a check-in a service sees open (no fire row) really is running on this host.
- Item 2: a `workspaceApi.task()` that never settles keeps `refreshing` true, so `busy` (`TaskPage.tsx:456`) disables Check now and Pause, and keeps `loudInFlight` set, so `refreshQuietly` reads nothing (`workspace-task.ts:179`) and the poll stops. A hung Check now, Pause or Resume (`routineApi`, `TaskPage.tsx:374-378`) keeps `acting` set, with the same effect.

**Refined.**
- No fire row stores a miss reason (`finishDispatch`'s insert, `store.ts:978-986`); TASK-930 keeps only the task's latest miss on the definition. The sweep's error text (unchanged since #985, written by nothing else) is the one per-run mark of an interruption, so Task 1 exports it as `RUN_INTERRUPTED` and `getDispatchOutcome` recognizes it. No migration.
- On a `request-conflict` (the routine's revision moved since that check-in was accepted: an edit, a Pause and Resume) the service never learns which check-in it was. Task 1 adds a read that finds it whatever the revision.
- `httpFetch` also carries the chat SSE stream (`workspace-api.ts:2147`), the memory-events stream (`:2072`) and file downloads, which a default deadline would cut off, and it returns an unread `Response`, so a deadline there couldn't cover the body. The deadline is opt-in per request, wrapped around the code that reads the body (`req`, `request`).
- A precedent exists: TASK-933 races the Tasks list read against `TASKS_READ_TIMEOUT_MS = 15_000` (`workspace-tasks.ts:49`). That read keeps its own race; this card doesn't touch it. 15 s is too long here: the page re-reads every 10 s (`TASK_POLL_INTERVAL_MS`, `use-task-poll.ts:24`), and a re-read that hangs past the next one is dropped uncounted, so TASK-931's "the third failed quiet read says so" could never fire for a hung host.

**Refuted (the dispatch brief, not the card).**
- "A run that finished or failed normally already read the reply." A run that failed in setup (`fire.ts:191-283`) never read it. Such a run isn't restarted because its failure is its own recorded outcome, shown under Updates, and would likely recur; and an interrupted run may have read it (cut off mid-turn), which is why the rule is "cut off before it reported".
- "Fake stores in tests may need the new method." Every routines test spreads the real store under `Partial<RoutinesStore>` overrides.

**What made the card look true (rule 5).** Accurate docs of today's gap that this card makes false: `services.ts:187-195` and `:416-417`, `packages/routines-contract/src/services.ts:113-121`, `packages/routines/src/types.ts:91-105`, `reply.test.ts:11-16`, the design doc's line 689 and decision row 1021, and TASK-931 decisions rows 30 and 32 (memory rows are superseded by this card's shard, never edited). Tasks 1, 2 and 5 fix each.

## Global Constraints

- Base: origin/main 9832ad50b or later. Routines schema stays at version 13: no migration.
- No service-hook signature or subscriber payload change, so no boundary review. `routines:reply` and `routines:reopen` keep their four answers (`started`, `paused`, `not-allowed`, `replayed`); only docs change in `@ax/routines-contract`. `acceptedDispatchId` and `getDispatchOutcome` are store methods inside `@ax/routines`.
- `RUN_INTERRUPTED` is exactly `'The routine run was interrupted by a host restart.'`: existing rows carry that text, and tests assert it literally (`report-store.test.ts:319`, `misses-store.test.ts:378`).
- No new user-facing copy and no UI change. `RequestTimeoutError`'s message reaches the console only: ASCII, no request path.
- Log lines unchanged: `routines_reply_added` already logs `{ checkIn, replayed }` with ids only.
- One file: `pnpm --filter <pkg> exec vitest run <path>`. `pnpm --filter <pkg> test -- <file>` runs the whole package.
- Docker-backed: every `packages/routines/src/__tests__/*.test.ts` that calls `fixture()` (all routines tests this plan touches). Locally `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`, checked first with `timeout 15 docker info`. If Docker hangs, name each skipped suite in the handoff; CI's postgres:16 run is the gate. channel-web's tests need no Docker.
- channel-web type-checks its tests (`tsc --build` includes them), and `@typescript-eslint/no-unused-vars` is an error in test files: after Tasks 3 and 4 run `pnpm --filter @ax/channel-web exec tsc --build` and lint the changed files.
- Run the tasks one at a time in one worktree: channel-web's `tsc --build` recompiles routines and the contract.
- Parallel cards: TASK-935 (routines fire/report code) and TASK-944 (remote response body caps). Keep the routines diff to the spots each task names. If either merges first, rebase and re-run every suite the tasks name.

## Review Focus

1. Two retries of the same reply land at once after a restart: exactly one new check-in starts and the other answers `replayed`. Task 2 runs them together.
2. The person edited the task, or paused and resumed it, between the cut-off check-in and the retry: the retry still starts one more, at the new revision. Task 2 pins it.
3. The check-in reported, then the restart cut its turn off: the reply was read and answered, so no second model run starts. Tasks 1 and 2 pin it.
4. A host that keeps hanging: the poll's quiet re-reads each fail before the next replaces them, and the third in a row says the page couldn't refresh. Task 4 pins it, with `REQUEST_TIMEOUT_MS < TASK_POLL_INTERVAL_MS`.
5. A slow request that isn't a task-page request (the Tasks list, a chat stream, a download) is never cut off by this deadline. Task 4 pins the Tasks list keeping no deadline; `httpFetch` itself doesn't change.

## Security

`security-checklist` is not required. Nothing here touches a sandbox boundary, IPC, plugin loading or a dependency, or adds a path for untrusted content. The restart starts a check-in only for the task's owner (as every reply does), at most 3 per reply, and re-sends text that was screened when stored and is already in every check-in's message. The client change only stops waiting sooner. Say so in the PR's security note.

---

### Task 1: The store knows a check-in a host restart cut off, and which check-in a request started [tier: integration]

**Files:**
- Modify: `packages/routines/src/store.ts`: the `RoutinesStore` interface (`:29-31`: a doc on `getDispatchOutcome`, then `acceptedDispatchId`); `RUN_INTERRUPTED` beside `RUN_CLOSED` (`:773-774`); `interruptAbandonedDispatches` (`:941-950`); `getDispatchOutcome` (`:951-956`); `acceptedDispatchId` right after it.
- Modify, docs only: `packages/routines/src/types.ts:91-105` (`DispatchMiss`, `DispatchOutcome.miss`).
- Test: `packages/routines/src/__tests__/report-store.test.ts` (the test at `:314`, two new tests after it) (Docker)
- Test: `packages/routines/src/__tests__/dispatch.test.ts` (one new test at the end of `describe('durable dispatch')`, `:7-55`) (Docker)

**Interfaces:**
- Produces: `export const RUN_INTERRUPTED = 'The routine run was interrupted by a host restart.'` in `store.ts`.
- Produces: `getDispatchOutcome(input: { agentId: string; dispatchId: string }): Promise<DispatchOutcome | null>`, same signature. Its answer carries `miss: 'interrupted'` exactly when the fire row's `status` is `'error'`, its `error` is `RUN_INTERRUPTED` and it holds no report (`report_status` or `report_update` NULL, `rowToFire`'s rule, `store.ts:658`); otherwise no `miss` key at all.
- Produces: `acceptedDispatchId(input: { agentId: string; actorUserId: string; requestId: string }): Promise<string | null>` on `RoutinesStore`: the `dispatchId` in the committed `dispatch` receipt for that agent, actor and request id, whatever input hash it was accepted with; null when none committed.

- [ ] **Step 1: Write the failing tests**

`report-store.test.ts` imports `RUN_INTERRUPTED` from `../store.js` and uses the file's `accept`, `finish`, `taskInput` helpers.
- In `'a host restart after the report keeps it on the run'` (`:314`), after the sweep: `expect(await f.store.getDispatchOutcome({ agentId: 'a', dispatchId: run.dispatchId })).not.toHaveProperty('miss');` (it reported before the restart).
- New `it('a run a host restart cut off before it reported reads back as interrupted (TASK-937)')`:

```ts
const row = await f.store.createAuthored(taskInput('cut-off'));
const run = await accept(row, 'cut-off-fire');
expect(await f.store.getDispatchOutcome({ agentId: 'a', dispatchId: run.dispatchId })).toBeNull();
expect(await f.store.interruptAbandonedDispatches()).toBe(1);
expect(await f.store.getDispatchOutcome({ agentId: 'a', dispatchId: run.dispatchId })).toStrictEqual({
  status: 'error', conversationId: null, error: RUN_INTERRUPTED, renderedPrompt: null, warning: null, miss: 'interrupted',
});
```

- New `it('a run that ended on its own reads back with no miss, whatever its finish said (TASK-937)')`: one task, two runs (`accept(row, 'own-error')`, `accept(row, 'own-ok')`). Finish the first with `{ status: 'error', error: 'The check-in ran out of time.', conversationId: null, renderedPrompt: null, warning: null, miss: 'failed' }`, the second with `finish(...)`. Both outcomes `not.toHaveProperty('miss')`; the first's `status` is `'error'`.

`dispatch.test.ts`, new `it('acceptedDispatchId finds the check-in a request started, whatever the revision is now (TASK-937)')`, with the file's `accept` helper (actor `'editor'`):
- `const row = await f.store.createAuthored(createInput());` `const started = (await f.store.acceptDispatch(accept(row, 'r1')))!.accepted;` `const key = { agentId: 'a', actorUserId: 'editor', requestId: 'r1' };`
- `acceptedDispatchId(key)` is `started.dispatchId`.
- `const disabled = await f.store.updateAuthored({ ...accept(row), patch: { enabled: false }, requestId: 'disable', stopOnly: true });` (a new revision): `acceptedDispatchId(key)` is still `started.dispatchId`.
- `acceptDispatch(accept(disabled, 'r2'))` is null (refused, so no receipt): `acceptedDispatchId({ ...key, requestId: 'r2' })` is null.
- `{ ...key, actorUserId: 'owner' }` and `{ ...key, requestId: 'never-sent' }` are null.

- [ ] **Step 2: Run them to see them fail (Docker)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/report-store.test.ts src/__tests__/dispatch.test.ts`
Expected: the two interruption tests and the receipt test FAIL (`RUN_INTERRUPTED` is undefined, no `miss`, `acceptedDispatchId` is not a function); the `:314` guard passes already.

- [ ] **Step 3: Implement**

- `RUN_INTERRUPTED`, doc in substance: TASK-937. The restart sweep's error, and the one mark a fire row keeps of a run a host restart cut off; `getDispatchOutcome` recognizes it, and nothing else writes it. Changing the text makes runs interrupted before the change read as ended on their own (a retry then answers `replayed`).
- `interruptAbandonedDispatches` writes `RUN_INTERRUPTED` instead of the literal.
- `getDispatchOutcome` adds `...(cutOff ? { miss: 'interrupted' as const } : {})` to the object it parses, `cutOff` being the rule in Interfaces.
- `acceptedDispatchId`: one select on `routines_v1_requests` by its primary key (`agent_id`, `owner_user_id = actorUserId`, `operation = 'dispatch'`, `request_id`), reading only ``sql<string | null>`result->>'dispatchId'` ``; answer it when it is a non-empty string, else null. No lock, no fence, no hash check. Reading only the id keeps an older receipt's row shape from failing the read.
- Interface docs, in substance. `getDispatchOutcome`: a run's end as its fire row recorded it, or null while it is open; TASK-937: `miss` is `'interrupted'` for a run the restart sweep finished before it reported, the one reason a fire row can still show. `acceptedDispatchId`: TASK-937, the check-in an accepted request started, whatever the routine's revision was at the accept, or null when no accept under that id committed (a refused accept leaves no receipt); read-only, and a concurrent accept under the same id is still serialized by `acceptDispatch`'s own receipt.
- `types.ts`: `DispatchMiss` keeps "set by the code that recorded it, which knows" and adds that a fire row keeps no reason, so `getDispatchOutcome` gives back only `interrupted`, recognized by the sweep's own fixed error (`RUN_INTERRUPTED`), which nothing else writes. `DispatchOutcome.miss`: read for a task's `error` run that left no report (TASK-930), and by `replyCheckIn` to tell a check-in a host restart cut off (TASK-937).

- [ ] **Step 4: Run them, and the suites that read the sweep or the outcome (Docker)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/report-store.test.ts src/__tests__/dispatch.test.ts src/__tests__/tools.test.ts src/__tests__/misses-store.test.ts src/__tests__/fire.test.ts`
Expected: PASS, five files. Then `pnpm --filter @ax/routines build`: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/types.ts packages/routines/src/__tests__/report-store.test.ts packages/routines/src/__tests__/dispatch.test.ts
git commit -m "[TASK-937] routines: the store tells a check-in a host restart cut off, and finds the check-in a request started"
```

---

### Task 2: A retried reply starts one more check-in after a host restart cut its check-in off [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/services.ts`: `REPLY_CHECK_IN_RESTARTS` after `RECENT_REPLIES_DEFAULT_LIMIT` (`:17-18`); `replyCheckIn` and its doc (`:181-222`), split into the walk and a private `acceptReplyCheckIn`; the `reply` hook's comment (`:416-417`).
- Modify, docs only: `packages/routines-contract/src/services.ts:107-123`.
- Test: `packages/routines/src/__tests__/reply.test.ts` (header `:11-16`; a new `describe` after `describe('routines:reply (TASK-931)')`) (Docker)

**Interfaces:**
- Consumes (Task 1): `store.acceptedDispatchId`, and `store.getDispatchOutcome`'s `miss: 'interrupted'`.
- Produces: `export const REPLY_CHECK_IN_RESTARTS = 3;` in `services.ts`.

- [ ] **Step 1: Write the failing tests**

A new `describe('routines:reply after a host restart cut its check-in off (TASK-937)')`, using the file's `createTask`, `services`, `replyTo`, `keyOf`, `dispatchReceipts`, `storedReplies`, `logged`. Import `REPLY_CHECK_IN_RESTARTS` from `../services.js` and `TASK_AUTO_PAUSE_AFTER_MISSES` from `@ax/routines-contract`. In each test `const task = await createTask(); const s = services(); const input = replyTo(task, 'q1', 'Are the refunds still stuck?');` and `const first = await s.reply(input);` answers `started`; `s.dispatched[0]!.dispatchId` is that first check-in's `dispatchId`.

- `it('a retry starts one more check-in, keyed on the reply and the one cut off, and a retry after that replays it')`: `const cutOff = s.dispatched[0]!.dispatchId;` then `interruptAbandonedDispatches()` is 1. A retry through `logged(s.as('owner'))` answers `{ replyId: first.replyId, checkIn: 'started' }`; `s.dispatched` has 2, the second `toMatchObject({ source: 'manual', row: expect.objectContaining({ routineId: task.routineId, revision: task.revision }) })`; `dispatchReceipts()` equals `[{ owner_user_id: 'owner', request_id: 'reply:' + first.replyId }, { owner_user_id: 'owner', request_id: 'reply:' + first.replyId + ':after:' + cutOff }]`; the retry's log lines include `expect.objectContaining({ msg: 'routines_reply_added', checkIn: 'started', replayed: true })`. One more retry answers `replayed`; `s.dispatched` still 2; `storedReplies()` has 1.
- `it('two retries at once start one check-in between them')`: after the sweep, `const answers = await Promise.all([s.reply(input), s.reply(input)]);` `answers.map(a => a.checkIn).sort()` equals `['replayed', 'started']`; `s.dispatched` 2; `dispatchReceipts()` 2.
- `it.each` over three ways the first check-in ends, each a separate test (fresh database), answering `replayed` on the retry with `s.dispatched` still 1:
  - `'finished'`: `f.store.finishDispatch({ dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: null, warning: null } })`.
  - `'failed on its own'`: the same with `status: 'error', error: 'The check-in ran out of time.', miss: 'failed'`.
  - `'reported, then cut off'`: `bindDispatchConversation({ dispatchId, conversationId: 'c1' })`; `recordReport({ agentId: 'a', dispatchId, conversationId: 'c1', actorUserId: 'owner', report: { status: 'on-track', update: 'Read your reply.', ask: null }, now })` resolves `'recorded'`; then `interruptAbandonedDispatches()` is 1.
- `it('a cut-off check-in starts one more even after the task changed since')`: after the sweep, `const edited = await f.store.updateAuthored({ ...keyOf(task), expectedRevision: task.revision, actorUserId: 'owner', requestId: 'edit', patch: { goodWhen: 'Nothing waits a day.' }, now, stopOnly: false });`. The retry answers `started`, and `s.dispatched[1]!.row.revision` is `edited.revision`. (The existing `:139` test, the same edit over a check-in still open, keeps answering `replayed`.)
- `it('stops after REPLY_CHECK_IN_RESTARTS restarts: the retry after that replays')`: first `expect(REPLY_CHECK_IN_RESTARTS + 1).toBeLessThan(TASK_AUTO_PAUSE_AFTER_MISSES);` (every cut-off check-in is a miss, so this stays the bound's test, not the auto-pause's). Then `REPLY_CHECK_IN_RESTARTS` times: the sweep is 1 and a retry answers `started`. Then the sweep is 1 and a retry answers `replayed`; `s.dispatched` has `REPLY_CHECK_IN_RESTARTS + 1`.

The header comment (`:11-16`) adds that a retry after a host restart cut the check-in off before it reported starts one more (TASK-937).

- [ ] **Step 2: Run them to see them fail (Docker)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/reply.test.ts`
Expected: the first, second, fourth and fifth new tests FAIL (the retry answers `replayed`); the three `it.each` cases pass already.

- [ ] **Step 3: Implement the walk**

`acceptReplyCheckIn(ctx, allowed, row, requestId, send)` is today's body from `let result` to `return 'started'` (`:200-221`), with `requestId` in place of `` `reply:${replyId}` `` and nothing else changed. `replyCheckIn` keeps its two checks first and walks:

```ts
let requestId = `reply:${replyId}`;
for (let restarts = 0; ; restarts++) {
  const earlier = await store.acceptedDispatchId({ agentId: row.agentId, actorUserId: ctx.userId, requestId });
  if (earlier === null) return acceptReplyCheckIn(ctx, allowed, row, requestId, send);
  if (restarts === REPLY_CHECK_IN_RESTARTS) return 'replayed';
  const outcome = await store.getDispatchOutcome({ agentId: row.agentId, dispatchId: earlier });
  if (outcome?.miss !== 'interrupted') return 'replayed';
  requestId = `reply:${replyId}:after:${earlier}`;
}
```

Docs, in substance (they replace the sentences listed under Premises):
- `REPLY_CHECK_IN_RESTARTS`: TASK-937, how many check-ins a host restart may cut off for one reply before a retry stops starting more; the walk is finite anyway, and this keeps a crash loop from starting runs that die.
- `replyCheckIn`: keep the TASK-931 paragraph's order rule and "keyed on the reply, never sharing a receipt with a Check now press". Then: a replayed reply walks the check-ins it started. A retry after the reply was stored but before its check-in was accepted starts that check-in. A retry after it was accepted finds it (its receipt, whatever the routine's revision was then) and answers `replayed` while it runs or once it ended on its own: finished, failed (its failure is under Updates, and Check now tries again) or reported. If a host restart cut it off before it reported (the sweep's `RUN_INTERRUPTED`), the retry starts one more, keyed on the reply and the check-in it replaces, so retries at once start one between them, up to `REPLY_CHECK_IN_RESTARTS`. Check now's own retry doesn't do this. `started` means accepted, not finished.
- The `reply` hook's comment (`:416-417`): keyed on the reply, so retries start one between them, and one more only after a host restart cut it off (`replyCheckIn`).
- The contract (`:107-123`): `started` also answers a retry that starts one more because a host restart cut the earlier check-in off before it reported. `replayed`: an earlier try with this `requestId` already started a check-in that is still running or ended on its own (its update, or why it failed, is under Updates), or this reply's check-in has already been restarted three times. The closing sentence: the same `requestId` again stores nothing new and starts a second check-in only after a host restart cut the first one off before it reported; retries at the same moment still start one between them.

- [ ] **Step 4: Run the reply, reopen and service suites (Docker)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/reply.test.ts src/__tests__/done.test.ts src/__tests__/services.test.ts src/__tests__/service-hooks.test.ts src/__tests__/return-schemas.test.ts`
Expected: PASS, five files (`done.test.ts` holds Not yet and Reopen, which share `replyCheckIn`). Then `pnpm --filter @ax/routines-contract build && pnpm --filter @ax/routines build`: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/services.ts packages/routines/src/__tests__/reply.test.ts packages/routines-contract/src/services.ts
git commit -m "[TASK-937] routines: a reply retried after a host restart cut its check-in off starts one more"
```

---

### Task 3: `withRequestTimeout`, one request with a deadline from start to finish [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/http.ts`: `REQUEST_TIMEOUT_MS`, `RequestTimeoutError` and `withRequestTimeout` after `isConfirmedRefusal` (`:138-140`); one paragraph in `httpFetch`'s doc (`:142-151`).
- Create: `packages/channel-web/src/lib/__tests__/http-request-timeout.test.ts`

**Interfaces:**
- Produces: `export const REQUEST_TIMEOUT_MS = 8_000;`
- Produces: `export class RequestTimeoutError extends Error { readonly path: string; readonly timeoutMs: number; constructor(path: string, timeoutMs: number) }`, `name` `'RequestTimeoutError'`, message `` `The request didn't answer within ${timeoutMs} ms.` ``. Not an `HttpError`.
- Produces: `export async function withRequestTimeout<T>(path: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

`beforeEach(() => vi.useFakeTimers())`; `afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); })`. Set up each `expect(...).rejects` before advancing timers, so no rejection goes unhandled.
- `it('rejects with a RequestTimeoutError at the deadline when the request never answers, and aborts its signal with it')`: `run` keeps its signal and returns `new Promise<never>(() => {})`; deadline 1000. At 999 ms it hasn't settled and the signal isn't aborted; at 1000 it rejects with an instance of `RequestTimeoutError` matching `{ path: '/x', timeoutMs: 1000 }`, the signal is aborted, and `signal.reason` is that same error.
- `it('the timeout wins over the rejection its own abort causes')`: `run` rejects with `new DOMException('aborted', 'AbortError')` from its signal's `abort` event; the result rejects with a `RequestTimeoutError`, not the `DOMException`.
- `it('answers as the request does before the deadline, and leaves no timer behind')`: `run` resolves `'ok'`; it resolves `'ok'`, `vi.getTimerCount()` is 0, the signal isn't aborted.
- `it('a request that fails before the deadline fails as it did, and leaves no timer behind')`: `run` rejects with `new HttpError('/x', 500)`; it rejects with that same error; `vi.getTimerCount()` is 0.
- `it('a timeout reads as no answer: unconfirmed, a failed read, the could-not-reach sentence')`: for `new RequestTimeoutError('/x', 1000)`, `isConfirmedRefusal` is false, `toReadOutcome` (from `../read-register`) is `'failed'`, and `userFacingMessage(e, 'test')` is `HTTP_FAILED` (silence `console.warn`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/http-request-timeout.test.ts`
Expected: FAIL, the three exports don't exist.

- [ ] **Step 3: Implement**

One `AbortController` and one timer per call. The timer callback rejects the deadline promise first and only then calls `controller.abort(error)`, so `Promise.race([run(controller.signal), deadline])` settles with the timeout even when the abort makes `run` reject at once. Clear the timer in `finally`. Docs, in substance. `REQUEST_TIMEOUT_MS`: TASK-937, the deadline for a request a person waits on, for callers that opt in (the requests to a task's own address and every routine request); under the task page's 10 s re-read (`TASK_POLL_INTERVAL_MS`), so a re-read that hangs fails before the next replaces it and three in a row say so; many times what those routes take. `RequestTimeoutError`: no answer in time, which reads as a dropped connection does (a failed read; an unconfirmed write keeps its request id); no path in the message. `withRequestTimeout`: wrap the whole request, the body read included. The `httpFetch` paragraph: no deadline of its own, because it also carries the chat stream and downloads, which must never be cut off; a caller that wants one wraps the request in `withRequestTimeout`.

- [ ] **Step 4: Run them, and the other http tests**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/http-request-timeout.test.ts src/lib/__tests__/http-confirmed-refusal.test.ts`
Expected: PASS. Then `pnpm --filter @ax/channel-web exec tsc --build` and `pnpm exec eslint packages/channel-web/src/lib/http.ts packages/channel-web/src/lib/__tests__/http-request-timeout.test.ts`: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/http.ts packages/channel-web/src/lib/__tests__/http-request-timeout.test.ts
git commit -m "[TASK-937] channel-web: withRequestTimeout bounds one request, body included, with an AbortController"
```

---

### Task 4: The task page's requests and every routine request give up after 8 seconds [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-api.ts`: `req` (`:839-867`); a module-private `taskReq` after `taskCheckinPath` (`:777-779`); the nine task functions (`:1210-1360`).
- Modify: `packages/channel-web/src/lib/routines.ts`: `request` (`:118-138`).
- Modify, docs only: `packages/channel-web/src/lib/workspace-task.ts:18-29` (header).
- Test: `packages/channel-web/src/lib/__tests__/workspace-api-task.test.ts` (header `:1-10`; two new `describe`s at the end)
- Test: `packages/channel-web/src/__tests__/routines-client.test.ts` (one new test)

**Interfaces:**
- Consumes (Task 3): `withRequestTimeout`, `RequestTimeoutError`, `REQUEST_TIMEOUT_MS` from `./http`.
- Produces: `req`'s init becomes `{ method?: string; body?: unknown; storageFull?: string; timeoutMs?: number }`. With `timeoutMs` set, the whole of `req` (fetch, the `storageFull` read, `res.json()`) runs inside `withRequestTimeout('/api/workspace' + path, timeoutMs, signal => ...)`, the signal passed to `httpFetch`; without it, exactly as today.
- Produces: `taskReq<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>`, which is `req<T>(path, { ...init, timeoutMs: REQUEST_TIMEOUT_MS })`. `task`, `taskCheckin`, `clearTaskNotes`, `sendTaskReply`, `completeTask`, `reopenTask`, `setTaskSteps`, `setTaskFinishBy` and `duplicateTask` call `taskReq` instead of `req`. `tasks` (the list) keeps `req` and its own 15 s race in `useTasks`.
- Produces: `request` in `routines.ts` runs inside `withRequestTimeout(path, REQUEST_TIMEOUT_MS, ...)`, passing the signal to `httpFetch`, and turns a `RequestTimeoutError` into `RoutineApiError(0)`, as it already does a fetch that throws. Every other error passes through as today.

- [ ] **Step 1: Write the failing tests**

In `workspace-api-task.test.ts` (it runs the real `workspaceApi` over a `fetch` spy and holds the `DETAIL` fixture). Both new describes use `vi.useFakeTimers()` with `vi.useRealTimers()` in their own `afterEach`, a hung fetch `vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}))`, and silence `console.warn`.

`describe('a request to a task that never answers (TASK-937)')`:
- `it.each` over the nine task functions, each called with ids and a valid body (`sendTaskReply`'s, `reopenTask`'s and `duplicateTask`'s with a request id): at `REQUEST_TIMEOUT_MS - 1` it hasn't settled; at `REQUEST_TIMEOUT_MS` it rejects with an instance of `RequestTimeoutError`; the `signal` in the fetch's init is aborted.
- `it('the tasks list keeps its own deadline, not this one')`: `workspaceApi.tasks()` hasn't settled at `REQUEST_TIMEOUT_MS`, and its fetch init carries no `signal`.

`describe('useTask over a read that never answers (TASK-937)')`, with `renderHook` and `act` from `@testing-library/react`, `useTask` from `../workspace-task` and `TASK_POLL_INTERVAL_MS` from `../use-task-poll`. Answer the first read with `DETAIL` (as `respondWith` does) and the rest with a hung fetch; flush and advance with `await act(async () => vi.advanceTimersByTimeAsync(ms))`, the pattern of TASK-933's `describe('a read that never settles')` (`workspace-tasks.test.ts:308-330`), which also pins its deadline against another constant.
- `it('a refresh that never answers ends at the deadline: buttons back, the failure said, quiet re-reads read again')`: mount, read `DETAIL`, then `act(() => result.current.refresh())`. `refreshing` is true and a `refreshQuietly()` starts no fetch (2 calls so far). At `REQUEST_TIMEOUT_MS - 1` still `refreshing`; at `REQUEST_TIMEOUT_MS` the state is `ready` with `refreshing: false` and `refreshFailed: true`, and a `refreshQuietly()` now starts a third fetch.
- `it('quiet re-reads that never answer count as failed ones: the third in a row says so')`: from a ready page, three rounds of `refreshQuietly()` and `REQUEST_TIMEOUT_MS`; after the second round `refreshFailed` is false, after the third it is true.
- `it('the deadline is under the poll interval, so a hung re-read fails before the next one replaces it')`: `expect(REQUEST_TIMEOUT_MS).toBeLessThan(TASK_POLL_INTERVAL_MS)`.

The file's header gains a line for the TASK-937 describes.

In `routines-client.test.ts`, `it('a routine request that never answers fails at the deadline as RoutineApiError(0), its fetch aborted (TASK-937)')`, with fake timers and the hung fetch: `routineApi.fireNow({ agentId: 'a', routineId: 'r', expectedRevision: 'rev', requestId: 'press-1' })` hasn't settled at `REQUEST_TIMEOUT_MS - 1` and at `REQUEST_TIMEOUT_MS` rejects with a `RoutineApiError` whose `status` is 0; the fetch's `signal` is aborted.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/workspace-api-task.test.ts src/__tests__/routines-client.test.ts`
Expected: the nine task cases, both hook tests that advance to the deadline and the routines test FAIL (nothing settles); the Tasks-list and interval tests pass already.

- [ ] **Step 3: Implement as in Interfaces**

The `workspace-task.ts` header gains, in substance: an ordinary refresh can't hang (TASK-937): every request to a task's address gives up at `REQUEST_TIMEOUT_MS`, so `refreshing` and the quiet re-reads' wait end with it, and a re-read that hangs fails before the next one replaces it, so it counts toward the three.

- [ ] **Step 4: Run every suite that reads these clients**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/workspace-api-task.test.ts src/lib/__tests__/workspace-api-task-checkin.test.ts src/lib/__tests__/workspace-api-tasks.test.ts src/lib/__tests__/workspace-task.test.ts src/lib/__tests__/workspace-tasks.test.ts src/__tests__/routines-client.test.ts src/__tests__/fire-now-control.test.tsx src/__tests__/routines-list.test.tsx`
Expected: PASS. If an existing test compares a task or routine request's fetch init exactly, match it with `expect.objectContaining` (the init now carries `signal`); none does at 9832ad50b. Then `pnpm --filter @ax/channel-web test` (the whole package, no Docker), `pnpm --filter @ax/channel-web exec tsc --build`, and lint the changed files: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/workspace-api.ts packages/channel-web/src/lib/routines.ts packages/channel-web/src/lib/workspace-task.ts packages/channel-web/src/lib/__tests__/workspace-api-task.test.ts packages/channel-web/src/__tests__/routines-client.test.ts
git commit -m "[TASK-937] channel-web: the task page's requests and every routine request give up after 8 seconds"
```

---

### Task 5: The design doc says so [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`: line 689 and two rows appended to the decision log (after line 1045).

- [ ] **Step 1: Edit**

- Line 689: replace "Each reply starts at most one check-in, under the usual limits (TASK-931)." with, in substance: "Each reply starts at most one check-in, plus one more after each check-in of it a host restart cut off before it reported (up to three), under the usual limits (TASK-931, TASK-937)."
- Append, in the log's format (row 1021 stays as written; the first new row supersedes it for this case):
  - `| 2026-10-25 | Decided | A reply retried after a host restart cut its check-in off before it reported starts one more check-in, keyed on the reply and the check-in it replaces, so retries at once still start one; at most three per reply. A check-in that ran to its end, failed on its own or reported first isn't started again. Supersedes the 2026-10-23 "a retry starts at most one" row for that case. Check now's own retry still starts nothing then (TASK-937). |`
  - `| 2026-10-25 | Decided | A task page's requests (its read, Check now, Pause, Resume, replies and every other change to the task) give up after 8 seconds, under its 10-second re-read, so a hung request ends as a failure the page already words, its buttons come back, and a host that keeps hanging is said after three re-reads (TASK-937). |`

- [ ] **Step 2: Check**

Run: `git diff -U0 -- docs/plans/2026-10-20-agent-tasks-design.md`
Expected: one changed line and two added rows, nothing else.

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "[TASK-937] design: a reply's retry after a restart, and the task page's request deadline"
```

---

## Out of scope (name these in the PR as follow-ups)

- **Check now's retry after a host restart** (`routines:fire-now` replays `{ status: 'ok' }`; `TaskPage`'s `pending` keeps the request id after an unconfirmed press) starts nothing, the same gap. Its replay is also the agent tool's recovery path (DBROUTINES-7), so it gets its own card.
- **A `replayed` reply whose check-in already ended** still starts the page's 5-minute "Checking in now..." (the poll waits for a check-in that wasn't there at the press). Pre-existing; a client or wire change.

## Final gate

```bash
pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
pnpm lint
```

Expected: every suite passes and lint is clean (`pnpm -r --no-bail run test` covers `@ax/routines`, `@ax/routines-contract` and `@ax/channel-web`; name any Docker-backed suite that couldn't run). Commit this plan and `.claude/memory/decisions/2026-10-25-TASK-937.md` with the work.
