# TASK-1059: a transcript row is written late, or its turn says so, but never dropped quietly. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the shared pool is briefly starved (TASK-1049's 5 s checkout timeout), conversation display rows still get written, because `conversations:append-event` retries a checkout that never got a connection. A row that is finally given up gets exactly one `error` line with codes only. If that row was the person's own message, the turn ends before it runs and says so.

**Architecture:** All four writers of the display log (the redisplay source of truth) go through one hook, `conversations:append-event`. Its handler runs the existence check and the append on **one pinned connection per attempt**. It retries only when Kysely never called back, which means no connection was handed over and nothing reached the database. It makes 3 attempts in all, waiting 250 ms and then 1 000 ms between them. The callers keep their own give-up lines, now `error` with `faultLogFields`. The orchestrator ends the turn with `conversation:message-not-saved` when the person's message can't be saved, and routines and channel-web learn that reason in the same PR.

**Tech Stack:** TypeScript, Kysely 0.28.17, pg 8.20.0 / pg-pool 3.13.0 (through `@ax/database-postgres`), vitest 5, testcontainers `postgres:16-alpine`.

**Spec:** the TASK-1059 card. Decisions and rejected alternatives are in `.claude/memory/decisions/2026-11-05-TASK-1059.md`.

**Before Task 1:** commit this plan and that decisions shard on their own (`[TASK-1059] plan + planner decisions`). The planner writes them and the builder commits them.

## Premise check

Read at 75ad36aa7. Three things were then **MEASURED** by read-only runs and throwaway probes (decisions rows 17-19):
- On the real kysely + pg stack, a failed checkout rejects without ever calling back.
- `faultLogFields` gives the exact fields the tests below expect.
- Today's `event_persist_failed` line carries the database's message on stdout.

- **True:** three host-side writes catch, log and drop the row. The raw `err` they log includes the database's message.
  - `chat-orchestrator/src/orchestrator.ts:4947-4958` writes the person's own message: warn `orchestrator_persist_user_turn_failed`, and the turn runs on.
  - `conversations/src/plugin.ts:1166-1171` writes the turn-error card: warn `conversations_persist_turn_error_failed`.
  - `conversations/src/plugin.ts:1210-1215` writes the approval card: warn `conversations_persist_permission_card_failed`.
- **Missed by the card, and the largest:** the runner's tool and assistant turns.
  - ipc-core awaits the append before the 202 and answers 500 when it throws (`ipc-core/src/dispatcher.ts:489-503`).
  - The runner sends `event.turn-end` through `IpcClient.event()`, which makes **one** attempt with a 10 s timeout and never uses `withRetry` (`ipc-protocol/src/ipc-client.ts:1092-1109`). The runner then swallows the error (`agent-runner-core/src/run-runner.ts:1510,1548,1580`).
  - So any persist failure loses that turn's row, and nothing outside this hook can save it.
  - The dispatch brief's "IpcClient retries 5xx under a ~2-min deadline" is refuted twice over. `event()` doesn't retry at all, and `withRetry` caps 5xx at 3 retries (`ipc-client.ts:291,880-884`).
- **What made that look true (rule 5), fixed in Task 6:**
  - `ipc-core/src/handlers/event-turn-end.ts:79-82` says "the store retries … never a silent drop".
  - `ipc-core/src/dispatcher.ts:477-488` says `event.chat-end` persists too (gone since TASK-995) and that the row is "never silent".
  - `ipc-protocol/src/ipc-client.ts:63-64` and `:155-164` say 5xx retries run to the wall-clock deadline.
- **One hook, two checkouts today:** the handler checks the conversation exists (`plugin.ts:919`), then `store.appendEvent` opens its own transaction (`store.ts:1096`). Each step waits up to 5 s on a starved pool.
- **Why "did Kysely call back?" is the right test.** `db.connection().execute(cb)` acquires the connection before it calls `cb` (`DefaultConnectionProvider.provideConnection`). `PostgresDriver.acquireConnection` is just `pool.connect()`, and database-postgres sets no connection hooks.
  - So a failure before `cb` starts proves nothing reached the database.
  - A failure after it might follow a COMMIT that landed.
  - pg-pool's errors are plain, codeless `Error`s (TASK-1049, measured). TASK-1058 is adding a code in database-postgres. **This card reads neither the message nor a code, so it doesn't depend on TASK-1058.**
- **Ending the user's turn is safe for a turn already running** (Explore, verified):
  - The refusal's `ctx.sessionId` is always a placeholder: `channel-web routes-chat.ts:642` and `routines fire.ts:245`.
  - No `chat:end` or `chat:turn-error` subscriber terminates a session or clears `active_session_id`.
  - SSE streams close by reqId.
  - The template refusal is `orchestrator.ts:3097-3127` (TASK-989).
- **Out of scope:** the resume transcript (`session.append-`/`.replace-transcript`).
  - People never see it: redisplay reads only `conversations_v1_events` (`plugin.ts:1537`).
  - It is already retried: 3 times on a 5xx, and the next ship re-sends (`run-runner.ts:1459-1468,1476-1496`).

## Global Constraints

- **Retry only before hand-over.** Retry an append only when no connection was handed over. Never retry once the pinned callback has started.
- **Waits:** exactly `[250, 1_000]` ms, so 3 attempts. A module constant, not a plugin option.
- **One connection.** Inside the retried callback, use only the pinned connection (`createConversationStore(pinned)`), never the pool-level `db`. On a one-connection pool, a nested checkout waits out the checkout timeout, and that failure (after hand-over) is not retried.
- **Codes only in logs.** Every changed log line carries `faultLogFields(err)` from `@ax/core` plus ids and numbers: `conversationId`, `attempt`, `retryInMs`, `hook`. Never `err`, `err.message` or `String(err)`. Reason: the bus copies the inner message into its wrap (`core/src/hook-bus.ts:442`), and the core logger prints an Error's message (`core/src/context.ts:101-112`).
- **Capture logs with the real logger.** A test that asserts a message is absent captures through `createLogger({ reqId, writer })`. A hand-rolled logger turns an `Error` binding into `{}` under `JSON.stringify`, so its check passes on unfixed code.
- **`toMatchObject` for log entries, never `toStrictEqual`.** TASK-1058 (in flight) gives the pool's checkout-timeout error `code: 'db-checkout-timeout'` and keeps its message, cause and class. Once it lands, the retry line gains `code`, and the give-up lines gain `causeCode`. Each test still asserts `not.toHaveProperty('err')` and the absence of message text.
- **Exact strings:**
  - New reason: `conversation:message-not-saved`.
  - New retry line: `conversations_append_event_retrying`.
  - Label: `Your message didn’t reach the agent. That’s on us, not you — try again in a moment.` (U+2019 apostrophes and a U+2014 dash, like the file around it).
- **Nothing structural:** no hook signature change, no new hook, no new dependency, no migration. Don't edit `packages/database-postgres` (TASK-1058's), `session-postgres` or `eventbus-postgres` (TASK-1056's).
- **Docker:** set an explicit `DOCKER_HOST` (CLAUDE.md). Locally that is `DOCKER_HOST=unix:///var/run/docker.sock`, which links to OrbStack's socket; the sibling builders use the same. Conversations and routines tests load `@ax/database-postgres` from `dist`. Check that #1129 is in it: `grep -c connectionTimeoutMillis packages/database-postgres/dist/plugin.js` should print 1 or more; rebuild that package if it doesn't. Docker start-slot timeouts are environmental: rerun the file.
- **Tests that run a package's `dist`.** `packages/ipc-core/src/__tests__/dispatcher.test.ts` runs ipc-core's own `dist`: it gets there through `@ax/ipc-server`, which imports `@ax/ipc-core`. After editing ipc-core's `src`, run `pnpm --filter @ax/ipc-core build` before that test (Task 6, Step 4). Tasks 1-5 import their code under test from `src`.
- **Hook timeouts:** no explicit hook timeout above a package's config (TASK-575 guard). For conversations, `beforeAll(…, 120_000)` is the most allowed.
- **Commits** start with `[TASK-1059]`.

## Review Focus

1. **A write that reached the database and then failed is retried.** That would duplicate a row in the source of truth. Expected: no retry, ever, after hand-over. Pinned in Task 1: unit test "never retries once the connection was handed over", and integration test (d), an invalid kind.
2. **A pool that stays starved through every attempt.** Expected: 3 attempts, nothing written, two retry lines, then exactly one code-only `error` line from the caller. Pinned in Task 1 (c) and Task 2 (e)/(f).
3. **A second message sent while the first turn is still running, whose save fails.** Expected: only the new turn ends. Nothing is routed or queued, and no session is terminated. Pinned in Task 3: a live session on the conversation, a counting `session:terminate`, and zero `conversations:get`/queue-work/bind calls.
4. **The database's text (a host, a user, a query value) reaches a log line through an Error binding.** Expected: never. Pinned in Tasks 1, 2, 3 and 6, each through real logger serialization.
5. **Sustained starvation delays what the person sees live.** No deterministic test; this is a note for the reviewer.
   - `HookBus.fire` runs subscribers in order, and the conversations persist subscribers run before channel-web's per-connection SSE subscribers (`sse.ts:551-584`). So a live error or approval card waits for its persist: up to about 16 s now, about 10 s before.
   - The runner logs `ipc_event_refused` at its 10 s `event()` timeout, while the host may still save the row afterwards.
   - Both are accepted in decisions row 10 and follow-up (b).

## File map

| File | Task | Change |
|---|---|---|
| `packages/conversations/src/checkout-retry.ts` | 1 | new: `withCheckoutRetry`, `CHECKOUT_RETRY_DELAYS_MS` |
| `packages/conversations/src/plugin.ts` | 1, 2 | the append handler uses the helper; comments; the two subscribers' give-up lines |
| `packages/conversations/src/store.ts` | 1 | comments only (`:406-414`, `:1087-1088`) |
| `packages/conversations/src/__tests__/checkout-retry.test.ts` | 1 | new, no Docker |
| `packages/conversations/src/__tests__/append-event-checkout-retry.test.ts` | 1, 2 | new, real Postgres |
| `packages/chat-orchestrator/src/orchestrator.ts` | 3 | the refusal, `persistUserDisplayTurn` returns `boolean`, comments |
| `packages/chat-orchestrator/src/__tests__/route-by-conversation.test.ts` | 3 | `ctxWith` takes a logger; one test |
| `packages/chat-orchestrator/src/__tests__/turn-error-discipline.test.ts` | 3 | count 17 → 18 |
| `packages/routines/src/fire.ts`, `__tests__/fire.test.ts` | 4 | `conversation:` prefix |
| `packages/channel-web/src/lib/turn-error-labels.ts`, `lib/__tests__/turn-error-labels.test.ts` | 5 | label |
| `packages/ipc-core/src/dispatcher.ts`, `handlers/event-turn-end.ts`, `__tests__/dispatcher.test.ts` | 6 | code-only line, comments |
| `packages/ipc-protocol/src/ipc-client.ts` | 6 | comments only |

---

### Task 1: `conversations:append-event` retries a checkout that never got a connection [tier: sensitive]

**security-checklist: yes.** The retried write carries runner-originated display frames, which are untrusted. The expected answer is N/A everywhere: the payload is untouched and nothing gains reach.

**Files:**
- Create: `packages/conversations/src/checkout-retry.ts`
- Create: `packages/conversations/src/__tests__/checkout-retry.test.ts`
- Create: `packages/conversations/src/__tests__/append-event-checkout-retry.test.ts`
- Modify: `packages/conversations/src/plugin.ts`:
  - the `@ax/core` import (`:1-7`, add `faultLogFields`)
  - the manifest comment (`:271-279`)
  - `init` (`:325-332`; keep the cast db in a `const` the closure can capture. Don't read the module-level `let db`: `shutdown()` sets it to `undefined` (`:615`), and a `TypeError` from it inside the retry would look like a failed checkout and be retried)
  - the registration and its comment (`:455-468`)
  - `appendEvent` (`:892-932`)
- Modify: `packages/conversations/src/store.ts`, comments only: `appendEvent`'s interface doc (`:406-414`) and CONTRACT assumption 2's last sentence (`:1087-1088`).

**Interfaces:**
- Produces (internal to `@ax/conversations`):
  ```ts
  export const CHECKOUT_RETRY_DELAYS_MS: readonly number[]; // [250, 1_000]
  export interface CheckoutRetryOptions {
    /** Called before each wait: the failure, the attempt that failed (1-based), the wait. */
    onRetry(err: unknown, attempt: number, retryInMs: number): void;
    delaysMs?: readonly number[]; // default CHECKOUT_RETRY_DELAYS_MS
    sleep?: (ms: number) => Promise<void>; // default: a setTimeout promise
  }
  export function withCheckoutRetry<DB, T>(
    db: Pick<Kysely<DB>, 'connection'>,
    op: (pinned: Kysely<DB>) => Promise<T>,
    opts: CheckoutRetryOptions,
  ): Promise<T>;
  ```
- Produces (log): `conversations_append_event_retrying` at `warn`, with `{ conversationId, attempt, retryInMs, ...faultLogFields(err) }`.
- Produces (test helpers that Task 2 reuses, in `append-event-checkout-retry.test.ts`): `boot()`, `createConv(h, userId)`, `holdOnlyConnection(db): Promise<() => void>`, `captureLog(onEntry?)`.

- [ ] **Step 1: Write the helper's unit tests** in `checkout-retry.test.ts`. They need no Docker. Use a fake `db` whose `connection().execute(cb)` throws a fresh `Error` (message `no connection <n>`) for each of the first `refusals` checkouts *without* calling `cb`, and otherwise calls `cb(pinned)` with a sentinel `pinned`. Cast it `as unknown as Pick<Kysely<unknown>, 'connection'>`, and record `onRetry` calls and `sleep` waits.
  - `retries a checkout that never handed over a connection, then returns what op returned`: with refusals 1, the result is `'ok'` and `op` saw the sentinel. `onRetry` calls equal `[[firstFailure, 1, 250]]`, waits equal `[250]`, and there were 2 checkouts.
  - `gives up after three checkouts and rethrows the last failure`: refusals are unlimited. It `rejects.toBe(thirdFailure)`. `onRetry` attempts and waits are `[1, 250]` then `[2, 1_000]`, and waits equal `[250, 1_000]`. `op` was never called, and there were 3 checkouts.
  - `never retries once the connection was handed over`: refusals 0, and `op` throws `boom`. It `rejects.toBe(boom)`, `op` was called once, and there were no `onRetry` calls and no waits.
  - `waits 250 ms, then 1 s`: `expect(CHECKOUT_RETRY_DELAYS_MS).toEqual([250, 1_000])`.

- [ ] **Step 2: Run it.** `pnpm --filter @ax/conversations exec vitest run src/__tests__/checkout-retry.test.ts`. Expected: FAIL, because `../checkout-retry.js` can't be resolved.

- [ ] **Step 3: Implement `checkout-retry.ts`.** The doc comment must say three things:
  - Why "did Kysely call back?" is exact: it acquires before it calls back (kysely 0.28.17 `DefaultConnectionProvider`).
  - Why it never retries after hand-over: a COMMIT can land and still reject, and a 23505 is a bug (`store.ts:1062-1064`).
  - Why it doesn't match error text: pg-pool's errors have no code, and TASK-1058 may change them.

  This is the algorithm, and the flag must be set before `op` runs. Set `const delays = opts.delaysMs ?? CHECKOUT_RETRY_DELAYS_MS` and `const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))` first:
  ```ts
  for (let attempt = 1; ; attempt++) {
    let handedOver = false;
    try {
      return await db.connection().execute((pinned) => {
        handedOver = true;
        return op(pinned);
      });
    } catch (err) {
      const retryInMs = delays[attempt - 1];
      if (handedOver || retryInMs === undefined) throw err;
      opts.onRetry(err, attempt, retryInMs);
      await sleep(retryInMs);
    }
  }
  ```

- [ ] **Step 4: Run the unit tests again.** Same command. Expected: PASS (4 tests).

- [ ] **Step 5: Write the integration tests** in `append-event-checkout-retry.test.ts`.
  - **Setup, copied from `display-events.test.ts`:** a per-file container (`startTestContainer(new PostgreSqlContainer('postgres:16-alpine'))` in `beforeAll(…, 120_000)`) and the `agents:resolve` stub. Don't drop any tables: each test makes its own conversation.
  - **Module-scope helpers:**
    - `boot()` boots `createDatabasePostgresPlugin({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000 })` and `createConversationsPlugin({ purgeSweepIntervalMs: 0 })`. Turning the sweep off matters: its startup pass would take the only connection 5 s after boot. Then it reads `db` from `database:get-instance`.
    - `holdOnlyConnection(db)` starts `db.connection().execute(async () => { held(); await gate; })`. It awaits `Promise.race([heldP, holder])`, so a failed connect fails the test at once, pushes `release` onto a module `releases` array, and returns `release`.
    - `captureLog(onEntry?)` returns `{ logger, lines, entries(msg) }`. The logger is `createLogger({ reqId: 'task-1059', writer })` from `@ax/core`. The writer pushes each line and calls `onEntry(JSON.parse(line))`.
    - `afterEach` releases every hold (`releases.splice(0)`), then closes the harnesses with `{ onError: () => {} }`.

  **Tests.** The release gate comes from the retry line itself, so no timing guesses are needed.
  - (a) `a checkout that fails once is retried, and the row is written once`:
    - Hold the connection. `captureLog` releases the hold when it sees `conversations_append_event_retrying`.
    - `h.bus.call('conversations:append-event', h.ctx({ conversationId, logger }), { conversationId, kind: 'turn', role: 'assistant', payload: { blocks: [{ type: 'text', text: 'hi back' }] } })` resolves.
    - `conversations:get` turns' `contentBlocks` equal `[[{ type: 'text', text: 'hi back' }]]`, which also proves there is no duplicate.
    - There is exactly one retry entry, matching `{ level: 'warn', conversationId, attempt: 1, retryInMs: 250, name: 'Error' }`.
    - `lines.join('\n')` doesn't contain `timeout exceeded`.
  - (b) `a turn error whose first checkout fails still reaches the display log`:
    - Same hold and release. `h.bus.fire('chat:turn-error', h.ctx({ userId, conversationId, logger }), { reqId: 'r-1', reason: 'chat-run-timeout' })`.
    - After the fire returns, call `release()` as well. Once the retry line has released the hold this does nothing, but on unfixed code no retry line is ever written, and without it the read below would wait out the hold instead of showing the missing event.
    - `conversations:get` has exactly one `turn-error` display event, whose `payload` matches `{ reqId: 'r-1', error: 'chat-run-timeout' }`.
    - There is one retry entry and no `conversations_persist_turn_error_failed` entry.
  - (c) `a pool that never frees up gives up after three checkouts and writes nothing`:
    - Hold and never release during the call.
    - The call rejects with a `PluginError` whose `code` is `'unknown'` and whose `(cause as Error).message` is `'timeout exceeded when trying to connect'`. That is the real pool's error, not a hand-made one.
    - The retry entries' `[attempt, retryInMs]` are `[[1, 250], [2, 1_000]]`.
    - Then `release()`, and `conversations:get` turns equal `[]`.
  - (d) `a write that fails after it got its connection is not retried`:
    - No hold. The input `{ conversationId, kind: 'not-a-kind' as never, payload: {} }` rejects and matches `{ code: 'invalid-payload' }`. The store's `validateEventKind` throws inside the pinned callback.
    - There are no retry entries.

- [ ] **Step 6: Run against the unfixed handler.** `pnpm --filter @ax/conversations exec vitest run src/__tests__/append-event-checkout-retry.test.ts`.
  - Expected: (a), (b) and (c) FAIL. (a) rejects with the pool's timeout, (b) has no turn-error event, and (c) has zero retry entries.
  - (d) passes; it is a forward guard, proven in Step 9.
  - Save the output for the PR. This is the card's "fails before the fix".

- [ ] **Step 7: Wire the handler.**
  - The signature becomes `appendEvent(db: Kysely<ConversationDatabase>, ctx: AgentContext, input: AppendEventInput): Promise<AppendEventOutput>`. The registration passes the `const` db captured in `init`; other handlers keep `localStore`.
  - `requireBoundedString` stays outside the retry.
  - Inside `withCheckoutRetry(db, async (pinned) => { … }, { onRetry })`, call `createConversationStore(pinned)`, then today's existence check (debug line unchanged) and `await store.appendEvent(…)`. The op returns nothing, not the seq: the hook's output is `void`, and `agent-deleted.test.ts:425-441` asserts `resolves.toBeUndefined()`.
  - `onRetry` writes the warn line from the Interfaces block.
  - Add a comment at the call: "everything here runs on `pinned`; a second checkout from in here waits out the checkout timeout on a one-connection pool".

- [ ] **Step 8: Run again, then the whole package.** Run Step 6's command, then `pnpm --filter @ax/conversations test`. Expected: all PASS, including `agent-deleted.test.ts` (TASK-718's skip, now on the pinned connection) and `display-events.test.ts`.

- [ ] **Step 9: Mutation check.** Follow yolo-ship Phase 4 › *Mutation testing*: commit first, then use its restore block, never a bare `git checkout --`.
  - Drop `handedOver ||` from the helper. The unit test `never retries once the connection was handed over` and (d) must FAIL. Restore the line.
  - Then make `op` use the pool-level `db` instead of `pinned` for the existence check. (a) must FAIL, because the nested checkout times out after hand-over. Restore it.

- [ ] **Step 10: Fix the comments this task makes wrong.**
  - `plugin.ts:271-279` and `:455-463` say the hook is fed only by this plugin's subscribers. Name all four callers: ipc-core's `event.turn-end` persist, the orchestrator's user turn, and the two subscribers. Add one line on the TASK-1059 retry.
  - `store.ts:406-414` says "single statement", "contention-free" and "only … subscribers". Say instead: one append under the per-conversation advisory lock (see the CONTRACT comment), returning the seq; its only caller is the append-event handler.
  - `store.ts:1087-1088`: the only caller runs it on a pinned connection that is not inside a transaction.

- [ ] **Step 11: Commit.** `git commit -m "[TASK-1059] conversations: append-event retries a checkout that never got a connection"`

### Task 2: the turn-error and approval-card subscribers log a lost row once, as an error, in codes [tier: mechanical]

**Files:**
- Modify: `packages/conversations/src/plugin.ts`: `persistTurnError`'s catch (`:1166-1171`) and `persistPermissionCard`'s (`:1210-1215`). In each doc comment, add one sentence: "the hook retries a checkout that never got a connection; a row still lost is logged once at error, codes only".
- Modify: `packages/conversations/src/__tests__/append-event-checkout-retry.test.ts` (append).

**Interfaces:**
- Consumes: Task 1's test helpers.
- Produces (log): `conversations_persist_turn_error_failed` and `conversations_persist_permission_card_failed` at `error`, each with `{ conversationId, ...faultLogFields(err) }`.

- [ ] **Step 1: Write the failing tests.** Hold the only connection for the whole fire, then `release()`.
  - (e) `a turn error the pool never lets through is logged once, as an error, in codes`:
    - Fire `chat:turn-error` with `{ reqId: 'r-1', reason: 'chat-run-timeout' }`.
    - `entries('conversations_persist_turn_error_failed')` has length 1, and its entry matches `{ level: 'error', conversationId, code: 'unknown', name: 'PluginError', causeName: 'Error', hookName: 'conversations:append-event', plugin: '@ax/conversations' }`. Also assert `not.toHaveProperty('err')`.
    - There are 2 retry entries, and `lines.join('\n')` doesn't contain `timeout exceeded`.
  - (f) `an approval card the pool never lets through is logged once, as an error, in codes`: the same, firing `chat:permission-request` with `display-events.test.ts`'s skill card (`{ kind: 'skill', skillId: 'linear', description: 'Linear skill', hosts: ['api.linear.app'], slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] }`). Expect `conversations_persist_permission_card_failed`.

- [ ] **Step 2: Run them.** `pnpm --filter @ax/conversations exec vitest run src/__tests__/append-event-checkout-retry.test.ts -t "logged once"`. Expected: FAIL. The level is `warn`, and the line carries `err` with "service hook 'conversations:append-event' threw: timeout exceeded…".

- [ ] **Step 3: Implement.** In both catches, write `ctx.logger.error(<same name>, { conversationId, ...faultLogFields(err) })`.

- [ ] **Step 4: Run again.** The same command, then `pnpm --filter @ax/conversations test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "[TASK-1059] conversations: a display card that can't be saved is logged once, as an error, in codes"`

### Task 3: a message that can't be saved ends its turn before anything runs [tier: integration]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`:
  - the `@ax/core` import (`:1-19`, add `faultLogFields`)
  - the call site and its comment (`:2667-2680`)
  - `persistUserDisplayTurn` and its header comment (`:4901-4959`)
- Modify: `packages/chat-orchestrator/src/__tests__/route-by-conversation.test.ts`: `ctxWith` (`:187-200`) gains `logger?: Logger`, defaulting to today's silent `createLogger`. Add one test.
- Modify: `packages/chat-orchestrator/src/__tests__/turn-error-discipline.test.ts:121`: `17` → `18`.

**Interfaces:**
- Produces: the terminated reason `conversation:message-not-saved`.
  - On `chat:turn-error` it is `{ reqId, reason }` with no `detail`.
  - On `chat:end` it is `{ outcome: { kind: 'terminated', reason } }` with no `error`, because a `chat:end` subscriber could log it raw.
  - Tasks 4 and 5 match it as a string literal; there is no import.
- Produces: `persistUserDisplayTurn(bus, ctx, message): Promise<boolean>`. It returns `true` when the message was saved or there was nothing to save (no `conversationId`, the hook not registered, nothing displayable). It returns `false` when the save failed, after logging `orchestrator_persist_user_turn_failed` at `error` with `{ conversationId, ...faultLogFields(err) }`.

- [ ] **Step 1: Write the failing test** `TASK-1059) a message that cannot be saved ends the turn before it is routed`. Model it on the queue-work failure test (`:564-600`).
  - **Setup:**
    - `buildMocks({ conversations: { 'conv-ns': { activeSessionId: 's-live' } }, liveSessions: new Set(['s-live']) })`.
    - Override `conversations:append-event` to throw `new Error('PRIVATE row text from 10.0.0.7')`, and `session:terminate` with a counting stub.
    - Add probe subscribers that collect `chat:turn-error` and `chat:end` payloads.
    - Collect lines with `createLogger({ reqId: 'req-NS', writer })`.
    - Boot the orchestrator with `chatTimeoutMs: 1_000`, as the template does. On unfixed code the turn routes into `s-live` and nothing ends it, so the red run waits for that timeout.
  - **Call:** `agent:invoke` with `ctxWith({ sessionId: 'placeholder-ns', conversationId: 'conv-ns', reqId: 'req-NS', logger })` and `{ message: { role: 'user', content: 'hello' } }`.
  - **Assertions:**
    - The outcome `toEqual({ kind: 'terminated', reason: 'conversation:message-not-saved' })`.
    - The turn errors `toEqual([{ reqId: 'req-NS', reason: 'conversation:message-not-saved' }])`, and the ends `toEqual([{ outcome }])`.
    - `trace.conversationsGet` is 0, `trace.queueWork` and `trace.bindSession` equal `[]`, `trace.sandboxOpen` is 0, and the terminate count is 0.
    - Exactly one parsed line has `msg === 'orchestrator_persist_user_turn_failed'`. It matches `{ level: 'error', conversationId: 'conv-ns', code: 'unknown', name: 'PluginError', causeName: 'Error', hookName: 'conversations:append-event', plugin: 'mock' }` and has no `err`.
    - `lines.join('\n')` doesn't contain `PRIVATE`.

- [ ] **Step 2: Run it.** `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/route-by-conversation.test.ts -t "TASK-1059"`. Expected: FAIL after about 1 s. The turn queues into `s-live` (`trace.queueWork` has one entry), waits for a `chat:end` that never comes, and ends `terminated` with `chat-run-timeout` (`orchestrator.ts:3025-3040`), not `conversation:message-not-saved`. The warn line carries `PRIVATE`. Without `chatTimeoutMs: 1_000` the wait would be the 10-minute default (`:1175`), and the test would die at vitest's 5 s default instead, because this package sets no `testTimeout`.

- [ ] **Step 3: Implement.**
  - `persistUserDisplayTurn` returns `boolean` as described in Interfaces.
  - At the call site, `if (!(await persistUserDisplayTurn(…)))`:
    - build `const outcome: AgentOutcome = { kind: 'terminated', reason: 'conversation:message-not-saved' }`
    - `await fireTurnError(ctx, ctx.reqId, outcome.reason)`
    - `await fireChatEvent('chat:end', ctx, { outcome })`
    - `return outcome`

    This is the identity refusal's shape (`:3117-3126`). Keep the outcome literal within 40 lines of the `chat:end` fire, as the discipline scan requires.
  - Comment the reason with its two readers: routines `refusedBeforeAssembly` and channel-web `turn-error-labels.ts`.
  - Rewrite the two comments that say "best-effort … the chat still runs" (`:2676-2679`, `:4915-4918`) to the new rule. The hook already retried a checkout that never got a connection. A message still not saved ends the turn here, before routing or spawning, because a reply to a message missing from the transcript is the gap the person would find on reload.

- [ ] **Step 4: Run again, then the whole package.** Run Step 2's command, then `pnpm --filter @ax/chat-orchestrator test`. Expected: PASS. `turn-error-discipline.test.ts` passes only with the count at 18 and the new exit surfaced.

- [ ] **Step 5: Commit.** `git commit -m "[TASK-1059] chat-orchestrator: a message that can't be saved ends its turn before anything runs"`

### Task 4: routines keeps a routine's warning when its message couldn't be saved [tier: mechanical]

**Files:**
- Modify: `packages/routines/src/fire.ts:160-172`. Add `|| reason.startsWith('conversation:')` to `refusedBeforeAssembly`. In its doc comment, add: a message the orchestrator couldn't save (`conversation:message-not-saved`, TASK-1059) is also refused before routing.
- Modify: `packages/routines/src/__tests__/fire.test.ts:260`. Add `'conversation:message-not-saved'` to the "preserves the previous warning for a pre-assembly gate" `it.each` list, and nowhere else. The "keeps the host code" list (`:296-298`) would pass already, since the reason has the host-code shape, so leave it alone.

**Sibling overlap:** TASK-1058's Task 4 (in flight) rewrites `fire.ts:274-277` and `:474` (the stderr line this `it.each` body asserts) and updates `fire.test.ts`. Keep this task to the one array entry and the prefix. If a rebase conflicts, keep their body and our entry.

**Interfaces:**
- Consumes: Task 3's reason literal.

- [ ] **Step 1: Add the case.**
- [ ] **Step 2: Run it.** `pnpm --filter @ax/routines exec vitest run src/__tests__/fire.test.ts -t "message-not-saved"` (needs Docker). Expected: FAIL, because the warning is cleared (`warning` is not `'Previous warning'`).
- [ ] **Step 3: Implement** the prefix and the comment.
- [ ] **Step 4: Run again,** then `pnpm --filter @ax/routines test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "[TASK-1059] routines: a message that couldn't be saved is a pre-assembly refusal"`

### Task 5: channel-web says what happened when a message couldn't be saved [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/lib/turn-error-labels.ts`. Add an `ERROR_LABELS` entry after `'system-prompt:identity-unavailable'` (`:150-156`) with a TASK-1059 comment. The comment says: the turn never started, the words are still behind Resend (so the headline's "Nothing you sent was lost" stays true), and a retry can work.
- Modify: `packages/channel-web/src/lib/__tests__/turn-error-labels.test.ts`. Add a new `describe` after TASK-989's (`:206-221`).

**Interfaces:**
- Consumes: Task 3's reason literal.

This is a copy-only map entry. The strip, its headline and Resend already exist, so there is no component or shadcn work.

- [ ] **Step 1: Write the failing test** `turnErrorText — the person’s message could not be saved (TASK-1059)`, with `const text = turnErrorText('conversation:message-not-saved')`:
  - it is not `DEFAULT_TURN_ERROR` and matches `/didn’t reach the agent/`
  - it matches `/on us/` and `/try again/`
  - it doesn't contain `message-not-saved` or `conversation:`
- [ ] **Step 2: Run it.** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/turn-error-labels.test.ts`. Expected: FAIL, because the default line comes back.
- [ ] **Step 3: Implement** the entry with the exact label from Global Constraints.
- [ ] **Step 4: Run again.** Then run `pnpm --filter @ax/channel-web build`, because channel-web's `tsc` includes its test files. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "[TASK-1059] channel-web: say plainly when a message didn't reach the agent"`

### Task 6: the turn-end persist's give-up line is code-only, and its comments stop promising "never silent" [tier: sensitive]

**security-checklist: yes.** This edits the IPC dispatcher's failure branch. The expected answer is N/A everywhere: the 500 body, validation, auth and the wire are unchanged, and the only change narrows a log line to codes.

**Files:**
- Modify: `packages/ipc-core/src/dispatcher.ts`:
  - `:2`: import `faultLogFields`.
  - `:477-488`: rewrite the comment.
  - `:492-495`: the line becomes `ctx.logger.error('event_persist_failed', { hook: pathname, ...faultLogFields(err) })`.
- Modify: `packages/ipc-core/src/handlers/event-turn-end.ts:79-82`: the doc comment.
- Modify: `packages/ipc-protocol/src/ipc-client.ts`: comments only.
  - `:63-64`: the policy list. Split it into three lines: connection errors retry with exponential backoff until `maxElapsedMs`; a 5xx gets at most `MAX_5XX_RETRIES` (3) quick retries; `event()` makes one attempt (10 s), is never retried, and callers log and move on.
  - `:155-164`: the `maxElapsedMs` doc. Only connection-level errors use the window; a 5xx gets the fixed cap.
- Test: `packages/ipc-core/src/__tests__/dispatcher.test.ts`. Add a sibling right after the persist-failure test (`:959-1015`).

**Interfaces:**
- Consumes: nothing from earlier tasks. It is independent of Tasks 1-5.
- Produces (log): `event_persist_failed` at `error`, with `{ hook: pathname, ...faultLogFields(err) }`. The 500 body is unchanged.

**The truth both ipc-core comments must state** (replacing "the store retries the seq-allocation race" and "never silent / never a silent drop"):
- Only `event.turn-end` has a persist step. `event.chat-end`'s went with TASK-995.
- The conversations hook already retried a checkout that never got a connection (TASK-1059). A failure that's left gets a 500, never a false 202.
- The runner's `event()` sends once and swallows a non-2xx (agent-runner-core `closeTurn`), so the row is then lost, and `event_persist_failed` is its only record.
- The line is codes only, because the bus copies the database's message into its wrap.
- The broadcast is skipped on this path. That is pre-existing and listed as a follow-up.

- [ ] **Step 1: Write the failing test** `POST /event.turn-end — a persist failure logs one code-only line (TASK-1059)`.
  - Set up like `:959-1015`, but the stub throws `new Error('PRIVATE row text from 10.0.0.7')`.
  - Capture `process.stdout` with `captureWrites` from `ipc-http/src/__tests__/listener.test.ts:276-287`. It spies on `write`, records `String(chunk)` and calls through. The listener's ctx uses the default stdout logger (`ipc-server/src/listener.ts:190`). Restore the spy afterwards.
  - The status is 500.
  - Exactly one parsed line has `msg === 'event_persist_failed'`. It matches `{ level: 'error', hook: '/event.turn-end', code: 'unknown', name: 'PluginError', causeName: 'Error', hookName: 'conversations:append-event', plugin: 'mock' }` and has no `err`.
  - No captured chunk contains `PRIVATE`.
- [ ] **Step 2: Run it.** `pnpm --filter @ax/ipc-core exec vitest run src/__tests__/dispatcher.test.ts -t "code-only"`. Expected: FAIL, because `err.message` carries `PRIVATE`.
- [ ] **Step 3: Implement** the line and the three comments.
- [ ] **Step 4: Rebuild ipc-core.** Run `pnpm --filter @ax/ipc-core build`. This test never imports `../dispatcher.js`. It reaches the dispatcher through `createListener` from `@ax/ipc-server`, whose listener imports `dispatch` from `@ax/ipc-core`, which resolves to `dist`, and `packages/ipc-core/vitest.config.ts` sets no alias. Without the rebuild the test runs the old code and stays red, so don't start "fixing" the source. The repo has hit this trap before (`mistakes.md:286`, TASK-223). Step 2's red run is valid only because `dist` still matched base then.
- [ ] **Step 5: Run again,** then `pnpm --filter @ax/ipc-core test` and `pnpm --filter @ax/ipc-protocol test`. Expected: PASS.
- [ ] **Step 6: Run security-checklist** for Tasks 1 and 6 and keep its note for the PR body.
- [ ] **Step 7: Commit.** `git commit -m "[TASK-1059] ipc-core: a lost turn-end row is logged in codes; the comments stop saying it can't be lost"`

## Before the PR

- **Write a patterns shard** (`scripts/memory-write-target.sh --shard patterns TASK-1059`; `mkdir -p` its directory) with these rows:
  - `IpcClient.event()` never retries: one attempt, 10 s. The runner swallows a non-2xx on `event.turn-end`, so a host persist has to be made durable on the host.
  - To retry a Postgres write without a duplicate, retry only when `db.connection().execute(cb)` never called `cb`. The helper is `conversations/src/checkout-retry.ts`.
  - A test that asserts a message is absent must capture through `createLogger({ writer })`. An Error in a hand-rolled logger's bindings `JSON.stringify`s to `{}`.
  - **Supersedes archive `decisions.md:1068`:** a 5xx is capped at 3 retries (100/200/400 ms). Only connection errors run to the 2-min `maxElapsedMs`.
- **Gate:** `pnpm build`, `pnpm lint`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Plain `pnpm -r run test` stops at the first failing package (CLAUDE.md).
- **Fetch first.** Before the PR, fetch and look at main's log. If TASK-1058 or TASK-1056 merged, rebase, rebuild `@ax/database-postgres`, and rerun conversations, ipc-core and routines.
  - TASK-1058 edits database-postgres (the `db-checkout-timeout` code) and routines' `fire.ts`/`fire.test.ts` (see Task 4).
  - TASK-1056 adds a 30 s `statement_timeout` to the shared pool, lock waits included. An append that waits that long on its advisory lock then fails after hand-over, and is correctly not retried.
- **PR body:**
  - The premise check, in short, including the runner path the card missed.
  - The red runs: Task 1 Step 6, and Step 2 of Tasks 2, 3, 4 and 6.
  - **Boundary review:** no hook signature changes. The new reason value `conversation:message-not-saved` on `chat:turn-error` and `chat:end` has no backend vocabulary, and both readers (routines, channel-web) change in this PR.
  - The security-checklist note (Tasks 1 and 6).
  - For operators, the give-up lines, all at `error` with codes only: `event_persist_failed`, `orchestrator_persist_user_turn_failed`, `conversations_persist_turn_error_failed`, `conversations_persist_permission_card_failed`. Each retry adds a `conversations_append_event_retrying` warn.
  - Review Focus 5 as a reviewer note, and the decisions shard's follow-ups (row 13).
