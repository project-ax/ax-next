# Services-restart races (TASK-1224, TASK-1225, TASK-1226) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three races in the dev-services restart swap (`restart_with_services`, PR #1255): a folded request's stuck web spinner (1224), the old runner handling a moved message (1225), and unconditional rebinds that take the conversation row from a newer request (1226).

**Architecture:** 1224: the `chat:turn-end-hold` answer may now carry the held segment's folded request ids, and `@ax/ipc-core` (still the only emitter) appends them to the continuation's final `chat:turn-end`. 1225: both session backends stop serving claims once a session is terminated, and the swap revokes the old session at the same time as it closes the old proxy instead of after. 1226: `conversations:bind-session` gains an optional strict compare-and-set (`expectedSessionId`), used by the swap's two binds and the fresh path's step-7 bind.

**Tech Stack:** TypeScript, vitest, kysely/Postgres (testcontainers), pnpm workspaces, the AX hook bus.

**Spec:** `docs/plans/2026-11-12-sandbox-service-reach-design.md` (§3.2: the restart is one turn). Card bodies: TASK-1224/1225/1226 (follow-ups from PR #1255). Decisions and rejected alternatives: `.claude/memory/decisions/2026-11-26-TASK-1224.md` — read it before Task 1.

## What the code says (premises checked at e92e67d1d)

- **1224 holds.** A request the runner folded into the held segment is settled `complete` in `continueAfterServiceRestart`'s finally (`orchestrator.ts:3698-3701` → MovableWait `settle`, `:4559-4561`), which fires nothing. Its id was on the held segment's turn-ends, which became `chat:turn-segment-end`; the continuation's `chat:turn-end` comes from a runner that never saw it. So no caller ever hears it end: web "Thinking…" until reload, agent-activity "Working", Slack's 60 s grace.
- **1225 is partly false.** The move (re-queue into the new session) already runs after `session:terminate(old)` resolved (`:3678` before `:3679`), and a terminated token is refused at auth. Real gaps: (a) both backends' `claim-work` still hand a *present* entry to a terminated session; (b) the revocation waits behind the proxy close (up to `PROXY_CLOSE_TIMEOUT_MS` = 10 s); (c) the runner always keeps one inbox read open, so a message routed in during the segment is usually claimed *before* the move, and the old runner runs it right after the held turn-end. (c) can't be undone by any claim stop; the fix makes revocation as early as the rebind allows. Residual in the decisions shard.
- **1226 holds** for three binds: R19 rebind (`:3666-3675`), N2 moved-request bind (`:3641-3650`), fresh-path step 7 (`:5996-6020`; already skipped for a restart by the C1 fix).

## Global Constraints

- Invariants 1, 2, 5 (CLAUDE.md). The only new hook-surface items are the two in **Boundary review** below; no new hook names, IPC actions, routes or dependencies.
- New PluginError code use: `'conflict'` (already used by `conversations:store-runner-session`).
- New log line: `conversation_bind_kept_newer` with `{ site: 'restart-rebind' | 'restart-moved' | 'fresh', sessionId }`, at info. Other bind failures keep their existing warn names (`conversation_bind_failed_restart`, `conversation_bind_failed_fresh`).
- Host-added folded ids obey the wire bounds of `EventTurnEndSchema.foldedReqIds` (`ipc-protocol/src/events.ts:161`): strings of 1–256 chars, at most 64, never the turn-end's own `reqId`.
- Packages resolve each other through `dist/` (`exports` → `./dist`). Run `pnpm build` (= `tsc --build`) once before testing, and again after changing a package that another package's tests import (`@ax/core`, `@ax/chat-orchestrator`, `@ax/session-inmemory`). vitest tolerates type errors, so `pnpm build` is also the type check.
- `--filter` goes before the script: `pnpm --filter @ax/<pkg> exec vitest run <file>`.
- Docker-backed suites (`@ax/conversations`, `@ax/session-postgres`) need `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock`.
- Implementation plans are history: leave `2026-11-23-dev-services-on-demand-plan.md` (its R30 line included) as it is. The two living docs named in Tasks 3 and 5 (this feature's design spec and the current-architecture doc) are fixed, as TASK-1240 did.
- Commit messages start with the card id the task belongs to (`[TASK-1226] …`).

## Review Focus

1. A failing `session:terminate` during the swap must not stop the old proxy close or the swap (a bare `Promise.all` would reject the whole restart) — Task 7 test.
2. A folded id with no waiter (a decision continuation folded into the held segment) must still be named on the final turn-end — Task 5 test.
3. The continuation's two closing turn-ends (tool, then assistant) both carry the ids; a caller must close once — Task 5 tests (orchestrator and ipc-core).
4. A cold spawn whose stale row is cleared during its open (the idle reaper's clear) must still be bound — Task 3 guard test.
5. A request bound to the *same* session during the restart open (channel-web's POST changes only `active_req_id`) must not stop N2 — the existing C1 tests in `restart-with-services.test.ts:913-969` stay green in Task 2.

## Boundary review

**`chat:turn-end-hold` answer gains `foldedReqIds?: string[]`** (Task 4/5)
- *Alternate impl:* any host-driven continuation that ends a runner segment without ending the request (a decision wake-up folded into its request, a mid-turn model switch); each needs the segment's folded requests to end with the request.
- *Leaky names:* none; `foldedReqIds` is already `chat:turn-end` vocabulary.
- *Subscriber risk:* only the hold's owner answers (the orchestrator, only for the continuation's sandbox and the restarting reqId). Callers see the ids as ordinary `foldedReqIds`, which they already treat as untrusted exact matches. A slow or throwing hold subscriber still reads as "not held" and adds nothing.
- *Wire surface:* none (in-process); the runner's `event.turn-end` wire is unchanged.

**`conversations:bind-session` input gains `expectedSessionId?: string | null`** (Task 1)
- *Alternate impl:* any conversation store (Postgres today; an in-memory or SQLite store for the CLI) can express "update if the field is exactly X / is unset".
- *Leaky names:* none; a session id is the hook's existing vocabulary.
- *Subscriber risk:* none (service hook, no event). The `conflict` error only reaches callers that pass the field.
- *Wire surface:* not an IPC action; channel-web's and Slack's calls don't pass it and are unchanged.

## Security note

`security-checklist` is required for the PR (Tasks 4–7: session/IPC claim boundary; runner-written ids re-broadcast on a later turn-end). Expected answers: no new reach. The carried ids are the runner's own list, which would have been broadcast had the segment not been held. The claim and revocation changes only shrink what a terminated sandbox can do.

## File map

- `packages/conversations/src/{types,store,plugin}.ts` — the compare-and-set (Task 1).
- `packages/chat-orchestrator/src/orchestrator.ts` — `compareAndBind` + three call sites (Tasks 2–3), carried folds + hold answer (Task 5), swap revocation (Task 7). `service-sets.ts`, `plugin.ts` — comments.
- `packages/core/src/turn-segment.ts`, `packages/ipc-core/src/handlers/event-turn-end.ts` — the answer field and the merge (Task 4).
- `packages/session-inmemory/src/inbox.ts`, `packages/session-postgres/src/inbox.ts` — no delivery after terminate (Task 6).
- Docs: `docs/plans/2026-11-12-sandbox-service-reach-design.md` (Task 5), `docs/plans/2026-05-24-current-architecture.md` (Task 3), `.changeset/services-restart-races.md` (Task 8).

---

### Task 1: `conversations:bind-session` compare-and-set (TASK-1226) [tier: sensitive]

**Files:**
- Modify: `packages/conversations/src/types.ts:432-462` (`BindSessionInput` + its doc block)
- Modify: `packages/conversations/src/store.ts:311-328` (interface), `:813-842` (`setActiveSession`)
- Modify: `packages/conversations/src/plugin.ts:1947-1982` (`bindSession`)
- Test: `packages/conversations/src/__tests__/lifecycle.test.ts` (Postgres; Docker)

**Interfaces:**
- Produces: `BindSessionInput.expectedSessionId?: string | null` — present: write only if `active_session_id` is exactly that value (`null` = no session bound), else write nothing and throw `PluginError({ code: 'conflict', plugin: '@ax/conversations', hookName: 'conversations:bind-session' })`; omitted: unconditional. Output stays `void`. A missing/foreign/deleted row stays `not-found`, never `conflict`.
- Produces: `store.setActiveSession(args & { expectedSessionId?: string | null }): Promise<'bound' | 'conflict' | 'not-found'>` (was `boolean`).

- [ ] **Step 1: Write the failing tests** in the `'@ax/conversations active_session_id lifecycle (J6)'` describe, using the file's `makeHarness`/`conversations:create` pattern:
  - `'bind-session with a stale expectedSessionId throws conflict and leaves the row alone'` — bind `{s1, r1}`; then bind `{sessionId: 's2', reqId: 'r2', expectedSessionId: 's0'}` rejects with `code: 'conflict'`; `conversations:get` still shows `activeSessionId: 's1', activeReqId: 'r1'`. Same for `expectedSessionId: null` against the bound row. **(red)**
  - `'bind-session with expectedSessionId binds when the row still names it'` — bind `{s1, r1}`, then `{s2, r2, expectedSessionId: 's1'}` → `s2`/`r2`.
  - `'bind-session with expectedSessionId: null binds an unbound row'`.
  - `'bind-session with expectedSessionId on a foreign row is not-found, not conflict'` — ctx `userB` against userA's row.
  - `'bind-session rejects an empty or oversized expectedSessionId'` — `''` and `'x'.repeat(257)` → `code: 'invalid-payload'`.
- [ ] **Step 2: Run, expect the red test to fail** (the stale bind succeeds today):
  `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock pnpm --filter @ax/conversations exec vitest run src/__tests__/lifecycle.test.ts`
- [ ] **Step 3: Implement.** Store: add the condition only when `expectedSessionId !== undefined` (`.where('active_session_id', '=', v)` or `.where('active_session_id', 'is', null)`); on zero updated rows with a condition, re-read `(conversation_id, user_id, deleted_at is null)` to return `'not-found'` vs `'conflict'` (copy `storeRunnerSession`, `store.ts:932-967`). Plugin: validate `undefined | null | requireBoundedString(...)`, map `'conflict'` and `'not-found'` to PluginErrors (message must not name the bound session). Update both doc comments (store interface `:311-316`, types `:432-442`) to describe the conditional bind and the new error; keep `store.test.ts:279` compiling (it ignores the return).
- [ ] **Step 4: Run** the same command plus `pnpm --filter @ax/conversations exec vitest run src/__tests__/store.test.ts src/__tests__/bind-session-runner-type.test.ts` (with `DOCKER_HOST`) and `pnpm build`. Expected: all pass, no type errors.
- [ ] **Step 5: Commit** `[TASK-1226] conversations:bind-session can bind only while the row still names the expected session`

### Task 2: The swap's two binds keep a newer binding (TASK-1226) [tier: sensitive]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:841-852` (mirror `ConversationsBindSessionInput`: add `expectedSessionId?: string | null`), new helper next to `setConversationServiceSet` (`:3382`), R19 bind `:3664-3675`, N2 bind `:3634-3650` and both comments
- Test: `packages/chat-orchestrator/src/__tests__/restart-with-services.test.ts`

**Interfaces:**
- Consumes: Task 1's contract (`expectedSessionId`, `conflict`).
- Produces (used by Task 3): `compareAndBind(ctx: AgentContext, input: { conversationId: string; sessionId: string; reqId: string; runnerType?: string }, opts: { expected: string | null; orUnbound: boolean; site: 'restart-rebind' | 'restart-moved' | 'fresh'; failLog: string; failFields?: Record<string, unknown> }): Promise<void>`. Calls bind with `expectedSessionId: opts.expected`; on a `PluginError` with `code === 'conflict'`, when `orUnbound && expected !== null` tries once more with `expectedSessionId: null`; a final conflict logs `conversation_bind_kept_newer { site, sessionId }` at info; any other error logs `opts.failLog` at warn with `errorLogFields(err)` and `failFields`. Never throws.

- [ ] **Step 1: Teach the harness compare-and-set.** In `setup()`: the `conversations:bind-session` fake records every input in a new `binds` array, calls an optional `opts.onBind?(input, row)` first (lets a test move the row just before a bind lands; a test's hook acts once, since a conflict can bring a second call), then throws `new PluginError({ code: 'conflict', plugin: 'test', message: 'moved on' })` when `input.expectedSessionId !== undefined && row.activeSessionId !== input.expectedSessionId`; otherwise binds as today. Return `binds` from `setup()`.
- [ ] **Step 2: Write the failing tests** (new `describe('TASK-1226: the swap never takes the row from a newer request')`):
  - `'the swap's rebind keeps a newer binding that landed first'` — `onBind` sets `row('conv-1')` to `{ activeSessionId: 's-newer', activeReqId: 'req-9' }` when it sees the R19 bind (`reqId === 'req-1'` and `sessionId !== 's-1'`); run the restart to the note and end the continuation. Expect the row still `{ activeSessionId: 's-newer', activeReqId: 'req-9' }`, `t.logs.some((l) => l.includes('conversation_bind_kept_newer') && l.includes('restart-rebind'))`, `p1` → `{ kind: 'complete', messages: [] }`, `turnErrors` empty. **(red)**
  - `'the moved-request bind keeps a newer binding that landed during the open'` — `openGate: { on: 2 }`, `restartWithQueued(t)`, `endSegment`, wait for the second open, set the row to `{ 's-newer', 'req-9' }`, release, wait for `queued.length === 4`. Expect the row unchanged and a kept-newer log line containing `restart-moved`. **(red)**
  - `'the swap's binds name the session they expect'` — plain `restartWithQueued` run: the R19 entry in `binds` (`reqId === 'req-1'`, new sandbox id) has `expectedSessionId: 's-1'`; the N2 entry (`reqId === 'req-2'`, new sandbox id) has `expectedSessionId: <the new sandbox id>`. **(red)**
  - `'the swap's rebind takes an unbound row'` — `onBind` clears the row to `{ null, null }` just before R19; expect the row `{ <new id>, 'req-1' }` (guard for `orUnbound`).
- [ ] **Step 3: Run, expect the red tests to fail:** `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/restart-with-services.test.ts`
- [ ] **Step 4: Implement** `compareAndBind`, then use it: R19 → `{ expected: pending.sessionId, orUnbound: true, site: 'restart-rebind', failLog: 'conversation_bind_failed_restart' }`; N2 → `{ expected: sessionId /* the new sandbox */, orUnbound: false, site: 'restart-moved', failLog: 'conversation_bind_failed_restart', failFields: { movedReqId: lastMoved } }`. Keep both `bus.hasService` gates. Rewrite the two comments: R19 binds only over the old session or an unbound row; N2 only over the new session, because an unbound row there means a stale writer bound the old session after R19 and that newer request is opening its own sandbox and should own the row.
- [ ] **Step 5: Run** the whole file (C1 and N2 tests included) and `pnpm build`. Expected: all pass.
- [ ] **Step 6: Commit** `[TASK-1226] The services-restart swap keeps a newer request's binding`

### Task 3: The fresh path's step-7 bind keeps a newer binding (TASK-1226) [tier: sensitive]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` — routing (`let priorActivityAt` at `:4003`; candidate read `:4045`; retire bind `:4254-4261`), step 7 `:5984-6020` and its comment
- Modify: `docs/plans/2026-05-24-current-architecture.md:214-216` (item 5)
- Test: `packages/chat-orchestrator/src/__tests__/restart-with-services.test.ts`, `packages/chat-orchestrator/src/__tests__/route-by-conversation.test.ts:313,607`

**Interfaces:**
- Consumes: `compareAndBind` (Task 2).

- [ ] **Step 1: Write the failing tests** (new `describe('TASK-1226: a cold spawn keeps a newer binding')` in `restart-with-services.test.ts`, reusing its rows and `openGate`; no restart involved):
  - `'a cold spawn keeps a newer binding that landed during its open'` — `setup({ openGate: { on: 1, until } })`; `invoke('s-1', 'conv-1', 'req-1')`; wait for the open; set the row to `{ 's-newer', 'req-9' }`; release; wait for the user message to be queued. Expect the row unchanged, a kept-newer log line containing `fresh`, and after `emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant')` the invoke completes. **(red)**
  - `'a cold spawn whose stale row is cleared during its open still binds'` — `rows: { 'conv-1': { activeSessionId: 's-stale', activeReqId: 'req-0' } }` (not alive), gate the open, clear the row to `{ null, null }` mid-open, release. Expect `{ 's-1', 'req-1' }` (guard: Review Focus 4).
  - Update the exact-shape assertions in `route-by-conversation.test.ts`: `:313` (no candidate) expects `expectedSessionId: null`; `:607` (stale `s-stale`) expects `expectedSessionId: 's-stale'`. `:374` (routed) and `:908` (row lookup failed) are unchanged. **(red: the field is absent today)**
- [ ] **Step 2: Run, expect failures:** `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/restart-with-services.test.ts src/__tests__/route-by-conversation.test.ts`
- [ ] **Step 3: Implement.** Declare `let rowSessionSeen: string | null | undefined` beside `priorActivityAt` (undefined = routing never read the row). Set it from the post-C1 `candidate` (`null` when null or empty), and to `ctx.sessionId` right after the retire bind resolves. Step 7 calls `compareAndBind` with `{ expected: rowSessionSeen, orUnbound: true, site: 'fresh', failLog: 'conversation_bind_failed_fresh', failFields: { conversationId, sessionId } }` when `rowSessionSeen !== undefined`, and the plain unconditional bind otherwise (today's code). Keep `runnerType`. Update the step-7 comment and item 5 of the architecture doc: late binds pass `expectedSessionId`, so they never take the row back from a newer request (TASK-1226).
- [ ] **Step 4: Run** the two files plus `src/__tests__/keepalive.test.ts`, then `pnpm build`. Expected: all pass.
- [ ] **Step 5: Commit** `[TASK-1226] A cold spawn's late bind keeps a newer request's binding`

### Task 4: The hold's answer can name folded requests; the emitter appends them (TASK-1224) [tier: sensitive]

**Files:**
- Modify: `packages/core/src/turn-segment.ts:11-26` (contract comment), `:45-52` (`ChatTurnEndHoldPayload`)
- Modify: `packages/ipc-core/src/handlers/event-turn-end.ts:38-44` (header item 2), `:130-183` (`fireEventTurnEnd`, `turnEndHeld`)
- Test: `packages/ipc-core/src/handlers/__tests__/event-turn-end-hold.test.ts`

**Interfaces:**
- Produces: `ChatTurnEndHoldPayload.foldedReqIds?: string[]` — doc: set by the hold's owner on a turn-end it does NOT hold; other requests this turn-end also ends, because they were folded into an earlier, held segment of the same request; the emitter appends them to the broadcast's `foldedReqIds`; ignored when `held` is true.
- Produces: `turnEndHeld` returns `{ held: boolean; foldedReqIds: string[] }`. On the non-held branch, `chat:turn-end` fires with `{ ...payload, foldedReqIds: merged }` when any host id is added, else the payload unchanged. Merge: the runner's ids first, then host ids not already present; host ids that are not strings of 1–256 chars or equal the payload's `reqId` are dropped; at most 64 host ids are added. A rejected/thrown/timed-out hold adds nothing.

- [ ] **Step 1: Write the failing tests** (reuse `ctx`, `record`, `TURN_END`):
  - `'a non-held answer naming folded requests adds them to chat:turn-end'` — the subscriber returns `{ ...p, foldedReqIds: ['req-2'] }`; expect `seen` to equal `[{ hook: 'chat:turn-end', payload: { ...TURN_END, foldedReqIds: ['req-2'] } }]`. **(red)**
  - `'host ids merge after the runner's own, without repeats'` — payload `{ ...TURN_END, foldedReqIds: ['req-3'] }`, answer `['req-2', 'req-3']` → `['req-3', 'req-2']`.
  - `'host ids that are not 1-256-char strings, or the turn's own id, are dropped; at most 64 are added'` — answer `['req-1', '', 7, 'x'.repeat(257), 'req-2']` → `['req-2']`; an answer of 70 distinct valid ids adds the first 64.
  - `'a held answer's ids are ignored'` — answer `{ ...p, held: true, foldedReqIds: ['req-2'] }` → the segment-end payload is exactly `TURN_END`.
- [ ] **Step 2: Run, expect the red test to fail:** `pnpm build && pnpm --filter @ax/ipc-core exec vitest run src/handlers/__tests__/event-turn-end-hold.test.ts`
- [ ] **Step 3: Implement** the field (with the doc above and a line in the file's header comment) and the merge in `event-turn-end.ts`; name the two bounds as module constants with a comment pointing at `EventTurnEndSchema.foldedReqIds`.
- [ ] **Step 4: Run** the step-2 command and `pnpm --filter @ax/ipc-core exec vitest run src/__tests__/service-restart-turn-end.test.ts`. Expected: all pass.
- [ ] **Step 5: Commit** `[TASK-1224] chat:turn-end-hold can carry folded request ids onto a turn-end it does not hold`

### Task 5: The continuation's final turn-end names the held segment's folded requests (TASK-1224) [tier: sensitive]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` — new map beside `openingSessions` (`:3363`); `continueAfterServiceRestart` (`:3593` after `take`, finally `:3689-3708`); `onTurnEndHold` (`:3498-3512`); comments `:3312-3315`, `:3696-3697`
- Modify: `packages/chat-orchestrator/src/service-sets.ts:285-290`, `packages/chat-orchestrator/src/plugin.ts:449-454` (comments)
- Modify: `docs/plans/2026-11-12-sandbox-service-reach-design.md:107-109` (step 4: a message the runner folded into the first segment ends with the turn too; the final turn-end names it)
- Test: `packages/chat-orchestrator/src/__tests__/restart-with-services.test.ts`, `packages/ipc-core/src/__tests__/service-restart-turn-end.test.ts`

**Interfaces:**
- Consumes: Task 4's `ChatTurnEndHoldPayload.foldedReqIds`.
- Produces: `continuationFoldsBySession: Map<string /* new sandbox */, { reqId: string; foldedReqIds: string[] }>`, set right after `serviceRestarts.take` when `pending.foldedReqIds` is non-empty (all of them: a decision continuation has no MovableWait but has a stream), deleted in the finally (only if the entry is still this request's). `onTurnEndHold`: unchanged for a held turn-end; otherwise, when the map has an entry for `payload.sessionId` whose `reqId === payload.reqId`, return `{ ...payload, foldedReqIds: [...entry.foldedReqIds] }`; else `undefined`.

- [ ] **Step 1: Update the harness mirror.** `emitTurnEnd` in `setup()` mirrors ipc-core: on the non-held branch, append `answer.payload.foldedReqIds` to the payload's own list as Task 4 does. The `test/callers` subscriber records `foldedReqIds` on its `turnEnds` entry only when present (existing exact-shape assertions keep passing).
- [ ] **Step 2: Write the failing tests:**
  - Extend `'R30: a message folded into the held segment settles with the restarting turn, never sandbox-terminated'` (`:643`): after the continuation's turn-end, `expect(t.turnEnds.find((e) => e.reqId === 'req-1')?.foldedReqIds).toEqual(['req-2'])`. **(red)**
  - `'TASK-1224: a folded request with no waiter is named too'` — `endSegment('s-1', 'conv-1', 'req-1', ['cont-1'])` with nothing routed; the continuation's turn-end carries `['cont-1']`. **(red)**
  - `'TASK-1224: both closing turn-ends carry the folded ids; a moved request is not named'` — `restartWithQueued` (req-2 queued) plus `endSegment(..., ['req-3'])` after a third invoke `req-3`; the continuation's tool and assistant turn-ends for `req-1` both carry `['req-3']`; `req-2`'s own later turn-end has no `foldedReqIds`.
  - `'TASK-1224: a turn-end from another sandbox gets no ids'` — after the swap, `emitTurnEnd('s-1', 'conv-1', 'req-1', 'assistant')` records no `foldedReqIds` (guard: the answer is keyed on the host-stamped session).
  - In `service-restart-turn-end.test.ts` (real emitter, real orchestrator): give `turnEnd` an optional `foldedReqIds`; add a web-like caller that records `closed:<id>` when `p.reqId === id || p.foldedReqIds?.includes(id)` for `id = 'req-2'`; new `it('a request folded into the held segment is ended by the continuation's turn-end, once')`: route `req-2` in while `req-1` runs, end the segment with `['req-2']`, assert no `closed:req-2` before the continuation's turn-end and exactly one after it (`tool` then `assistant`). **(red)**
- [ ] **Step 3: Run, expect the red tests to fail:** `pnpm build && pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/restart-with-services.test.ts`, and `pnpm --filter @ax/ipc-core exec vitest run src/__tests__/service-restart-turn-end.test.ts`
- [ ] **Step 4: Implement** the map, the set/delete and the `onTurnEndHold` branch; update the five comments and the design doc's step 4.
- [ ] **Step 5: Run** both commands again (rebuild first: the ipc-core test imports the orchestrator's `dist`). Expected: all pass.
- [ ] **Step 6: Commit** `[TASK-1224] A message folded into a restarting turn ends with it: its spinner closes`

### Task 6: A terminated session is never served a claim (TASK-1225) [tier: sensitive]

**Files:**
- Modify: `packages/session-inmemory/src/inbox.ts:105-147` (fast path and `wake`), comment at `packages/session-inmemory/src/plugin.ts:634-637`
- Modify: `packages/session-postgres/src/inbox.ts:197-254` (`wakeWaiter`), `:391-400` (`claim` fast path)
- Test: `packages/session-inmemory/src/__tests__/inbox.test.ts`, `packages/session-inmemory/src/__tests__/plugin.test.ts`, `packages/session-postgres/src/__tests__/plugin.test.ts` (Docker)
- Create: `packages/ipc-core/src/__tests__/service-restart-old-runner.test.ts`

**Interfaces:**
- Produces: `session:claim-work` on a known, terminated session always answers `{ type: 'timeout', cursor }`, whether or not an entry is present at the cursor. Unknown sessions keep `unknown-session`.

- [ ] **Step 1: Write the failing tests:**
  - in-memory `inbox.test.ts`: `'a claim on a terminated session never delivers an entry that is present'` — `queue(s, entry)` at cursor 0, `terminate(s)`, `claim(s, 0, 1000)` → `{ type: 'timeout', cursor: 0 }`. **(red)**
  - in-memory `plugin.test.ts` and postgres `plugin.test.ts`: `'claim-work after session:terminate returns timeout even with an entry at the cursor'` — `session:create` → `session:queue-work` (user-message) → `session:terminate` → `session:claim-work({ cursor: 0, timeoutMs: 0 })` → `{ type: 'timeout', cursor: 0 }`. **(red, both)**
  - ipc-core `service-restart-old-runner.test.ts`, `'after a services restart the old session can neither authenticate nor claim the moved message'`: harness like `service-restart-turn-end.test.ts` but with the real `createSessionInmemoryPlugin()` instead of the `session:*` fakes; the fake `sandbox:open-session` calls the real `session:create` (`workspaceRoot: '/tmp/ax-restart-old-runner'`) and keeps each token; a `session:terminate` subscriber clears the row bound to that session (as `@ax/conversations` does). Flow: invoke `req-1` (s-1 opens), call `restart_with_services`, invoke `req-2` (routed into s-1; sanity: `claim-work(s-1, cursor 1)` returns its user-message), end s-1's segment with `fireEventTurnEnd` (tool, assistant), wait until the new session's inbox has the note at 0 and `req-2` at 1. Then: `session:resolve-token(s-1's token)` → `null`, and `session:claim-work({ sessionId: 's-1', cursor: 1, timeoutMs: 0 })` → `{ type: 'timeout', cursor: 1 }`. End both requests and await them. **(red: today the second call returns req-2's message)**
- [ ] **Step 2: Run, expect failures:** `pnpm build && pnpm --filter @ax/session-inmemory exec vitest run`, `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock pnpm --filter @ax/session-postgres exec vitest run src/__tests__/plugin.test.ts`, `pnpm --filter @ax/ipc-core exec vitest run src/__tests__/service-restart-old-runner.test.ts`
- [ ] **Step 3: Implement.** In-memory: check `state.terminated` before the fast path and first thing in `wake`. Postgres: fetch the entry, THEN `await isTerminated(sessionId)`, then deliver with no await in between, in both the fast path and `wakeWaiter`; do not join the sessions table in the inbox (its design keeps the inbox split-able, `migrations.ts` "no FK" note). Fetch-then-check means any delivery was decided before the terminate committed, and the swap only moves after that commit. Update the comments that say a terminated session's claim "is allowed".
- [ ] **Step 4: Run** the step-2 commands plus the inbox suites `inbox-toctou.test.ts` and `inbox-shutdown-race.test.ts` (postgres, Docker). Expected: all pass.
- [ ] **Step 5: Commit** `[TASK-1225] A terminated session is never handed another inbox entry`

### Task 7: The swap revokes the old session at the same time as it closes the old proxy (TASK-1225) [tier: sensitive]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:3535-3567` (`closeSandboxForServiceRestart` + comment), R30 comment `:3598-3603`
- Test: `packages/chat-orchestrator/src/__tests__/restart-with-services.test.ts`

**Interfaces:**
- Produces: `closeSandboxForServiceRestart` runs `closeProxySession(oldCtx, old, 'retire')` (when `proxy:close-session` exists) and the old session's `session:terminate` concurrently, awaits both, then kills the handle as today. The terminate keeps its own try/catch (`service_restart_terminate_failed`, `spawnModeBySession.delete` on success) so it never rejects.

- [ ] **Step 1: Harness options.** `setup()` gains `proxyCloseGate?: Promise<void>` (the `proxy:close-session` fake records the session id in a new `proxyCloses` array, then awaits the gate) and `terminateFailsFor?: string` (the `session:terminate` fake throws for that id before changing anything). Pass `proxyCloseTimeoutMs: 60_000` to the plugin so the bounded close never times out under a gate.
- [ ] **Step 2: Write the tests:**
  - `'TASK-1225: the swap revokes the old session while its proxy close is still pending'` — gate the close; restart; `endSegment('s-1', ...)`; `await waitFor(() => t.terminated.includes('s-1'), 'old session revoked before its proxy close returns')`; then release, wait for the note, end the continuation; `p1` completes. **(red: today terminate waits for the close)**
  - `'TASK-1225: a moved message is queued only after the old session is revoked'` — in the `session:queue-work` fake, record `terminated.includes('s-1')` for every entry queued to a session other than `s-1`; with `restartWithQueued`, every such record is `true` (guard).
  - `'TASK-1225: a failing terminate still closes the old proxy and the swap completes'` — `terminateFailsFor: 's-1'`; `proxyCloses` contains `'s-1'`, `handles.get('s-1')!.state.kills === 1`, the note is queued, `p1` completes after the continuation's turn-end, and a log line contains `service_restart_terminate_failed` (guard: Review Focus 1).
- [ ] **Step 3: Run, expect the red test to fail:** `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/restart-with-services.test.ts`
- [ ] **Step 4: Implement**, and rewrite the two comments: the close no longer "mirrors the routing retire" (both start together so a slow close can't delay revocation and a hung terminate can't delay the close, TASK-871/878); and the R30 comment must stop implying a non-folded request is unclaimed: the old runner reads ahead, so a moved message may already be in its hands; it is moved anyway so the person gets an answer, and the old runner is revoked one rebind after the segment ends (residual: decisions shard, TASK-1225 rows).
- [ ] **Step 5: Run** the file, then `pnpm build`. Expected: all pass.
- [ ] **Step 6: Commit** `[TASK-1225] A services restart cuts the old sandbox off without waiting for its proxy to close`

### Task 8: Changeset and the full gate [tier: mechanical]

**Files:**
- Create: `.changeset/services-restart-races.md`

- [ ] **Step 1: Write the changeset** (front matter: `'@ax/core': minor`, `'@ax/conversations': minor`, `'@ax/ipc-core': patch`, `'@ax/chat-orchestrator': patch`, `'@ax/session-inmemory': patch`, `'@ax/session-postgres': patch`). One plain-voice paragraph, e.g.: "Three fixes for the moment an agent restarts its sandbox to start dev services. A message the agent answered as part of the reply it was already writing no longer leaves a spinner going after the restart. A message waiting in the old sandbox can't be picked up there once it has moved, and the old sandbox is cut off straight away instead of after its network closes. And a restart, or a sandbox that took a while to start, no longer takes the conversation back from a newer message that already has its own sandbox."
- [ ] **Step 2: Full gate** (all three suites; `--no-bail` so nothing after `auth-better` is skipped):
  `pnpm build && DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`
  Expected: green. A failure outside the touched packages is not "pre-existing" until the same test fails at `origin/main` in a scratch worktree.
- [ ] **Step 3: Commit** `[TASK-1224] Changeset for the services-restart races`

---

## YAGNI pass (cut, with reasons in the decisions shard)

- A non-broadcasting `session:close-inbox` / `session:revoke` hook: a new hook in two backends plus a postgres column, and it still can't touch a message the old runner already pulled ahead.
- Tracking claim cursors so claimed-but-unfolded messages aren't moved: the person's message would fail instead of being answered.
- Holding every old-session turn-end after the segment: the display row and chunks still get through.
- Comparing `active_req_id` in the compare-and-set, or a list of acceptable sessions: transient same-session clobbers only; one strict field plus a second call covers "or unbound".
- Compare-and-set on the routed and retire binds with re-routing: TASK-1227's family (opening tracking for every spawn).
- Routines reading `foldedReqIds`: pre-existing, not a restart bug.

## Residuals (accepted, documented)

- A message the old runner pulled ahead can reach the host only between the held turn-end and the terminate commit (one rebind write plus the terminate); far below a model's first-token latency.
- A row cleared to unbound at R19 (the old pod died that instant) is taken by the restart; one cleared at N2 is left for the newer request that caused it.
- channel-web's POST and Slack still bind unconditionally; a POST that read the old session can bind it after R19. The old session's terminate then clears it and the newer request opens its own sandbox, which N2 and step 7 now leave in place.
