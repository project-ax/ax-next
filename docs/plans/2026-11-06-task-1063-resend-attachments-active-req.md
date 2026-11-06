# TASK-1063: Resend after a refused turn brings the files back, and a refused turn's reqId stays bound on purpose. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a turn is refused before the person's message was saved (`conversation:message-not-saved`, a `chat:start` veto, an `agents:resolve` refusal), Resend sends the words and the files. A refused turn's `active_req_id` is left bound, on purpose: tests pin that, and the comments that said otherwise are corrected.

**Architecture:** There are two halves to the Resend fix, and neither works alone.
- **Server.** `attachments:commit` answers with the stored row when the id is already committed into the same conversation by the same person, even after the staged row is gone.
- **Client.** `workspace-api` works out a `messageNotSaved` hint from the refusal's reason code, and AgentView then lets Resend spend the files again.

The card's second fix, clearing `active_req_id` on every refusal, is not built. Why:
- the bound reqId is what lets a stream that opens after a fast refusal still replay that refusal;
- it blocks nothing, because the next POST rebinds it.

A route-level forward guard pins all of this.

**Tech Stack:** TypeScript, React 19 + vitest/jsdom (channel-web), Kysely + Postgres testcontainers (attachments, channel-web routes), `@ax/core` HookBus.

**Spec:** the TASK-1063 card. Evidence, decisions and rejected alternatives are in `.claude/memory/decisions/2026-11-06-TASK-1063.md`. Read rows 2, 3, 7 and 8 before Tasks 1 and 4.

**Before Task 1:** commit this plan and that decisions shard on their own (`[TASK-1063] plan + planner decisions`).

## Premise check

Read at a8fe20cdb. Every test command below was also run at base (decisions row 1, MEASURED).

- **Part 1 is CONFIRMED, but the client can't fix it alone.**
  - `send` sets `sent.resendable = false` the moment the POST returns 202 (`AgentView.tsx:1288`). Resend only passes files while that flag is true (`:1843`), and a not-saved refusal always arrives after a 202.
  - The flag was deliberate (TASK-353). The staged upload is deleted on commit (`attachments/src/handlers.ts:254`), so a second commit of the same id finds nothing (`:189-197`) and the route answers 400 `attachment-not-found` (`routes-chat.ts:600-602`).
  - So turning the flag back on alone would make Resend a button that always fails. Task 1 is the server half.
- **Part 2 is TRUE as a fact and REFUTED as a harm.**
  - A refused turn does leave `active_req_id` on its reqId.
  - It can't block the next turn. The next POST's bind overwrites it without a condition (`conversations/src/store.ts:777`), and routing reads only `activeSessionId` (`orchestrator.ts:2750`).
  - HTTP refusals (auth, validation, agent, conversation, attachments, bind) all happen before the reqId is minted (`routes-chat.ts:627`), so they bind nothing.
  - **Clearing it would cause a regression.** The stream GET resolves its conversation through `active_req_id` (`sse.ts:178`) before it can replay a buffered refusal (`sse.ts:362-387`, built by TASK-22 for exactly these fast refusals). A cleared id turns a late GET into a 404, and the person reads "We could not find that. It may have been deleted." (`http.ts:57`) instead of "You've reached your daily usage limit…".
  - Details are in decisions rows 7 and 8.
- **Part 3 (live-card wait) is deferred.** It is bounded, it happens only under sustained starvation, and each known fix breaks something (row 10). No task.
- **What made the card look true (rule 5).** Each of these lines is fixed in the task that owns it:
  - `orchestrator.ts:2696-2700`: "one known leftover … nothing clears it".
  - `conversations/src/plugin.ts:1281-1283`: "a reload reattaches to a stream that never ends". No client does that today: no client code reads `activeReqId`. The chat UI, which carried it, was deleted on 2026-09-26 (#751), before this line was written on 2026-10-04 (#926).
  - `orchestrator.ts:4671-4672`: true about null, and read backwards as "non-null means in flight".
  - The comments that say naming a committed id again earns `attachment-not-found`: `turn-error-labels.ts:157-160`, `AgentView.tsx:494-499, 506-518, 534-540, 1831-1839`, `AgentView.test.tsx:1076-1087`, `routes-chat.test.ts:2267`.

## Global Constraints

- **Exact names.**
  - The classifier is `turnErrorMessageNotSaved(reason: string | null | undefined): boolean`.
  - The hint field is `messageNotSaved: true`.
  - The onError type is `(message: string, hints?: { opensConnectors?: true; messageNotSaved?: true }) => void`. `hints` is omitted entirely when neither field applies; existing tests assert `undefined`.
- **The unsaved set, exactly.** Prefix `chat:start:`, prefix `agent-resolve:`, and the exact string `conversation:message-not-saved`. Nothing else: not `system-prompt:*`, not `chat-run-dispatch-failed`.
- **Commit refusal text.** Every no-staged-row miss throws the error an unknown id already gets: `PluginError({ code: 'not-found', plugin: PLUGIN_NAME, hookName: 'attachments:commit', message: \`attachmentId '${input.attachmentId}' not found or expired\` })`. That covers unknown ids, other-conversation ids and other-person ids.
- **What doesn't change.** No hook signature change, new hook, wire/SSE change, new dependency, migration or UI component. Copy changes only in comments, so no shadcn work.
- **`active_req_id` is not cleared** anywhere new. Don't add a clear on `chat:turn-error`, `chat:end` or an orchestrator refusal (decisions row 8).
- **Tests that run a package's `dist`.** channel-web resolves `@ax/attachments` through its `exports` (`./dist/index.js`). channel-web's vitest config has no `@ax/*` alias, so `routes-chat.test.ts` runs attachments' **dist**.
  - Run Task 1's route test red **before** rebuilding attachments.
  - Run `pnpm --filter @ax/attachments build` before its green run.
- **Docker.** `export DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000` before attachments `commit.test.ts` and channel-web `routes-chat.test.ts`. At base they take about 92 s and 53 s. Start-slot timeouts are environmental: rerun the file.
- **Commands.** `pnpm --filter <pkg> exec vitest run <file> [-t "<name>"]` (filter before the script).
- **Typecheck and waiting.**
  - channel-web's `tsc` includes its test files, so run `pnpm --filter @ax/channel-web build` after every task that touches channel-web.
  - Wait with `vi.waitFor`, never a fixed sleep or a counted loop (`pnpm test:scripts` guards this). The 50 ms sleep in the existing attachment_ref tests is not a pattern to copy.
- **Hook timeouts.** No explicit hook timeout above a package's config (TASK-575 guard).
- **Commits** start with `[TASK-1063]`. Comments are short and plain, and tag `TASK-1063`.

## Review Focus

1. **A Resend aimed at another conversation** (a new chat, or `conversationRef` cleared after a 404). Expected: refused with `attachment-not-found`, and the file row stays where it was. Pinned in Task 1, tests (b) and (e).
2. **Another person names someone's committed id.** Expected: exactly the not-found an unknown id gets, with nothing saying the file exists elsewhere. Pinned in Task 1, test (c).
3. **A failure after the save** (`system-prompt:identity-unavailable`, a dropped stream). Expected: Resend sends only the words, so the file is never attached twice. Pinned by Task 2's negatives and the kept AgentView test at `:1088`.
4. **A fast refusal whose stream opens late, then the next message.** Expected: the person reads their refusal, not "couldn't find", and the next message binds and dispatches normally. Pinned by Task 4's guard and its mutant.
5. **The orchestrator moves the user-turn save above `chat:start`/`agents:resolve`.** Expected: a test fails, because the client would then resend files for a message that was saved. Pinned by Task 2's producer guard and its mutant.

## File map

| File | Task | Change |
|---|---|---|
| `packages/attachments/src/handlers.ts` | 1 | the no-staged-row branch; two comments |
| `packages/attachments/src/__tests__/commit.test.ts` | 1 | three tests |
| `packages/channel-web/src/__tests__/server/routes-chat.test.ts` | 1, 4 | two attachment tests and a comment (1); a `refuseWith` mock option and a guard (4) |
| `packages/channel-web/src/lib/turn-error-labels.ts`, `lib/__tests__/turn-error-labels.test.ts` | 2 | classifier; label comment |
| `packages/channel-web/src/lib/workspace-api.ts`, `lib/__tests__/workspace-api-stream-error.test.ts` | 2 | hint |
| `packages/chat-orchestrator/src/__tests__/route-by-conversation.test.ts` | 2 | producer-order guard |
| `packages/channel-web/src/components/workspace/AgentView.tsx`, `__tests__/AgentView.test.tsx` | 3 | re-arm the files; comments |
| `packages/chat-orchestrator/src/orchestrator.ts`, `packages/conversations/src/plugin.ts`, `packages/channel-web/src/server/sse.ts` | 4 | comments only |

---

### Task 1: a file already filed under this conversation can be named again by its owner [tier: sensitive]

**security-checklist: required.** `attachments:commit` is the gate that makes an upload this person's file in this conversation. I expect N/A on sandbox escape, prompt injection and supply chain. Access control is answered by tests (b), (c) and (e): no new reach, and one not-found for every other case.

**Files:**
- Modify: `packages/attachments/src/handlers.ts`:
  - `createCommitHandler` (`:184-270`): the `if (!row)` branch (`:190-197`)
  - the doc comment (`:173-183`)
  - the temp-outlived comment (`:231-235`)
- Test: `packages/attachments/src/__tests__/commit.test.ts`: three tests after "refuses to commit an id already committed to another conversation" (`:212`).
- Test: `packages/channel-web/src/__tests__/server/routes-chat.test.ts`:
  - two tests at the end of `describe('POST /api/chat/messages — attachment_ref handling')` (`:2276`)
  - the comment line `:2267`

**Interfaces:**
- Produces: the `attachments:commit` signature is unchanged. When no staged row exists for `attachmentId` but `store.getFileById` returns a row with `conversationId === input.conversationId` and `userId === ctx.userId`, it returns that row's `CommitOutput` (`{ attachmentId: id, filename: displayName, sha256, mediaType, sizeBytes }`, the same shape as the temp-outlived branch). It calls no `blob:put` and deletes nothing. Every other miss throws the not-found from Global Constraints.

- [ ] **Step 1: Write the unit tests** in `commit.test.ts`, reusing `freshSetup`, `stage`, `makeBusWithBlob` and `makeCtx`:
  - (a) `TASK-1063: naming a committed id again in the same conversation, after its staged upload is gone, answers with the stored row`:
    - Stage `a-again` for `u-1`.
    - `first = await handler(makeCtx('u-1'), { attachmentId: 'a-again', conversationId: 'c-1' })`.
    - `expect(await store.getTemp('a-again')).toBeNull()`.
    - `second = await handler(makeCtx('u-1'), { attachmentId: 'a-again', conversationId: 'c-1' })`.
    - `expect(second).toStrictEqual(first)` and `expect(puts).toHaveLength(1)`.
    - `attachments_v1_files` holds exactly `[{ attachment_id: 'a-again' }]`.
  - (b) `TASK-1063: …in another conversation it is still not found, and the first row stands`:
    - Stage, then commit into `c-1`.
    - A commit as `u-1` into `c-2` `rejects.toMatchObject({ code: 'not-found' })`.
    - `(await store.getFileById(id))?.conversationId` is `'c-1'`.
  - (c) `TASK-1063: …by another person it is refused exactly like an unknown id`:
    - Stage `a-mine` for `u-1` and commit it into `c-1`.
    - `const err = await handler(makeCtx('u-2'), { attachmentId: 'a-mine', conversationId: 'c-1' }).catch((e: unknown) => e)`.
    - `expect(err).toBeInstanceOf(PluginError)` and `expect(err).toMatchObject({ code: 'not-found', message: "attachmentId 'a-mine' not found or expired" })`.
    - Then `handler(makeCtx('u-2'), { attachmentId: 'a-unknown', conversationId: 'c-1' })` rejects with `message: "attachmentId 'a-unknown' not found or expired"`.
- [ ] **Step 2: Write the route tests** in `routes-chat.test.ts`. Boot with `includeAttachments: true`, as `'rewrites an attachment_ref into an id block'` does (`:2287`), and stage via `attachments:store-temp` the same way.
  - (d) `TASK-1063: a resend that names a file already sent in this conversation is accepted and carries it again`:
    - POST 1 `{ conversationId: null, agentId: 'agt_test', contentBlocks: [{ type: 'text', text: 'have a look' }, { type: 'attachment_ref', attachmentId }] }` → 202 → `C`.
    - `await vi.waitFor(() => expect(booted.chatRunCaptures).toHaveLength(1))`.
    - POST 2 with `conversationId: C` and the same blocks → `expect(r.status).toBe(202)`.
    - `vi.waitFor` until there are 2 captures.
    - `expect(captures[1]!.input.message.contentBlocks).toStrictEqual(captures[0]!.input.message.contentBlocks)` and `expect(captures[1]!.ctx.conversationId).toBe(C)`.
  - (e) `TASK-1063: …but not in another conversation`:
    - POST 1 as above, then wait for 1 capture.
    - POST 2 with `conversationId: null` and the same blocks → 400 `{ error: 'attachment-not-found' }`.
    - `booted.chatRunCaptures` still has length 1. The route answers before it dispatches, so no wait is needed.
  - Fix the comment at `:2267` to: `attachmentId neither staged nor already committed to this conversation by this person → 400 attachment-not-found`.
- [ ] **Step 3: Run red, against base dist.**
  - `grep -c "TASK-1063" packages/attachments/dist/handlers.js` prints `0`. It also exits 1, which is the expected state. tsc keeps comments, so this probe works (MEASURED at base).
  - `pnpm --filter @ax/attachments exec vitest run src/__tests__/commit.test.ts -t "TASK-1063"`: (a) FAILS with not-found "not found or expired"; (b) and (c) pass (guards).
  - `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-chat.test.ts -t "TASK-1063"`: (d) FAILS with status 400; (e) passes.
- [ ] **Step 4: Implement** in `createCommitHandler`. When `getTemp` returns nothing, look the id up with `deps.store.getFileById` and answer as in Interfaces; otherwise throw the unchanged not-found.
  - Comment the branch: the usual state after a successful commit; what it makes possible (Resend after a refusal that came before the save, TASK-1063); why it grants nothing new (same conversation, same person; one not-found for everything else).
  - Rewrite the doc comment (`:173-183`) to state the rule once: committing an id already committed into the same conversation by the same person answers with the row as stored, whether or not its staged row survived. The `:231-235` comment then describes its branch as the rarer twin.
  - A small shared `toCommitOutput(row)` is fine.
- [ ] **Step 5: Rebuild and run green.**
  - `pnpm --filter @ax/attachments build`, then `grep -c "TASK-1063" packages/attachments/dist/handlers.js` (≥ 1).
  - Step 3's two commands: all PASS.
  - Then `pnpm --filter @ax/attachments test`, and `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-chat.test.ts`: PASS. At base the attachments suite is 12 files and 132 tests. Its `attachments_janitor_failed` "db blew up" warn lines are the janitor tests' expected output.
- [ ] **Step 6: Mutant checks** (throwaway; rebuild dist for the route test each time).
  - Drop the `conversationId` comparison: (b) and (e) fail.
  - Drop the `userId` comparison: (c) fails.
  - Revert, rebuild, rerun green.
- [ ] **Step 7:** `pnpm --filter @ax/channel-web build` (tsc includes tests). Then run `security-checklist` and keep its note for the PR.
- [ ] **Step 8: Commit.** `git commit -m "[TASK-1063] attachments: a file already filed under this conversation can be named again by its owner"`

### Task 2: channel-web knows which refusals left the message unsaved [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/turn-error-labels.ts`:
  - add `turnErrorMessageNotSaved` after `turnErrorOpensConnectors` (`:189-191`)
  - rewrite the TASK-1059 label comment (`:157-160`)
- Modify: `packages/channel-web/src/lib/workspace-api.ts`:
  - `StreamHandlers.onError` and its doc (`:1072-1080`)
  - the error-frame branch (`:2236-2237`) and its import
- Test: `packages/channel-web/src/lib/__tests__/turn-error-labels.test.ts`: a new `describe` after TASK-1059's (`:224`).
- Test: `packages/channel-web/src/lib/__tests__/workspace-api-stream-error.test.ts`: hoist `fixFrom` out of the TASK-796 `describe` (`:120-133`) so a new `describe` can share it.
- Test: `packages/chat-orchestrator/src/__tests__/route-by-conversation.test.ts`: one `it.each` guard next to `TASK-66) persists the user turn …` (`:860`).

**Interfaces:**
- Produces: `export function turnErrorMessageNotSaved(reason: string | null | undefined): boolean` (the set from Global Constraints).
- Produces: `StreamHandlers.onError` with the type from Global Constraints. Task 3 reads `hints?.messageNotSaved`.

- [ ] **Step 1: Classifier tests**, in `describe('turnErrorMessageNotSaved — refusals that left the person’s message unsaved (TASK-1063)')`:
  - `it.each(['conversation:message-not-saved', 'chat:start:usage-limit-daily', 'chat:start:usage-check-unavailable', 'chat:start:blocked', 'agent-resolve:internal', 'agent-resolve:forbidden'])` → `true`.
  - `it.each(['system-prompt:identity-unavailable', 'chat-run-timeout', 'chat-run-dispatch-failed', 'runner-boot-failed', 'connector-needs-reconnect', 'conversation:something-else', 'chat:start', 'agent-resolve', '', 'toString'])` → `false`.
  - `null` and `undefined` → `false`.
- [ ] **Step 2: Stream tests**, in `describe('streamReply — a refusal that left the message unsaved (TASK-1063)')`:
  - `fixFrom([{ error: 'conversation:message-not-saved' }])`: the message is `ERROR_LABELS['conversation:message-not-saved']`, and `fix` `toEqual({ messageNotSaved: true })`.
  - `'chat:start:usage-limit-daily'`: `fix` `toEqual({ messageNotSaved: true })`.
  - `'system-prompt:identity-unavailable'`: `fix` is `undefined`.
  - The existing TASK-796 cases stay as written. In particular `connector-needs-reconnect` is still exactly `{ opensConnectors: true }`.
- [ ] **Step 3: Producer guards.** Write two plain `it`s, not an `it.each`, because their setup runs at different moments:
  - `TASK-1063) a chat:start veto saves no user turn, so channel-web may resend its files`. Subscribe `h.bus.subscribe('chat:start', 'blocker', async () => reject({ reason: 'blocked' }))` AFTER `createTestHarness`, as in `orchestrator.test.ts:202`. The reason must match `/^chat:start:/`.
  - `TASK-1063) an agents:resolve refusal saves no user turn, so channel-web may resend its files`. Set `mocks.services['agents:resolve'] = async () => { throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'nope' }); }` BEFORE `createTestHarness`, as the TASK-1059 test's override is (`:615`). The reason must match `/^agent-resolve:/`.
  - Both use `buildMocks({ conversations: { 'conv-g': { activeSessionId: null } }, liveSessions: new Set() })`.
  - Import `reject` and `PluginError` from `@ax/core` if the file doesn't already.
  - Invoke with `ctxWith({ sessionId: 'placeholder-g', conversationId: 'conv-g', reqId: 'req-g' })` and `{ message: { role: 'user', content: 'hi' } }`.
  - Assert in each that the outcome is `terminated`, its reason matches the regex, and `mocks.trace.appendEvent` `toEqual([])`.
  - The TASK-66 test beside it is the positive control: it shows append-event is called once the turn gets past these gates.
- [ ] **Step 4: Run red.**
  - `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/turn-error-labels.test.ts src/lib/__tests__/workspace-api-stream-error.test.ts`: FAIL (the classifier isn't exported; `fix` is `undefined`).
  - Both producer guards pass at base (they are forward guards): `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/route-by-conversation.test.ts -t "TASK-1063"`.
- [ ] **Step 5: Implement.**
  - The classifier's comment names the order it depends on: the orchestrator's `runAgentInvokeTurn` runs `chat:start`, then `agents:resolve`, then saves the person's message (today `orchestrator.ts:2564`, `:2601`, `:2703`). Name the steps in the comment, not the line numbers. Their files are committed, but no saved message names them, so Resend must send them again. The guard in `route-by-conversation.test.ts` fails if the save moves.
  - In `streamReply`, build `hints` from both helpers. Call `onError(text, hints)` only when at least one field is set, otherwise `onError(text)`.
  - Update the `onError` doc: `hints` says what else the reason means; the code still never leaves this module.
  - Rewrite the label comment (`:157-160`) to: the turn never started, a retry can work, and Resend carries all of it, words and files (TASK-1063).
- [ ] **Step 6: Mutant check** (throwaway). Move the `persistUserDisplayTurn` block (`orchestrator.ts:2678-2711`) above step 1. Both producer guards FAIL (one append each). Revert.
- [ ] **Step 7: Run green.** Step 4's commands PASS. Then run `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__`, because both modules are shared (87 files, 1550 tests at base). Then `pnpm --filter @ax/channel-web build`.
- [ ] **Step 8: Commit.** `git commit -m "[TASK-1063] channel-web: say which refusals left the message unsaved"`

### Task 3: Resend after such a refusal sends the files again [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentView.tsx`:
  - `onError` (`:1033-1065`)
  - the `SentTurn` docs (`:484-518`) and its `resendable` field doc (`:534-540`)
  - `send`'s post-POST comment (`:1280-1287`)
  - the Resend button comment (`:1831-1839`)
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentView.test.tsx`:
  - a new test after `'resends only the words when the file already reached the conversation'` (`:1088-1134`)
  - that test's comment (`:1076-1087`)

**Interfaces:**
- Consumes: Task 2's `hints?.messageNotSaved`.

- [ ] **Step 1: Write the test** `resends the file with the words when the turn was refused before the message was saved (TASK-1063)`. Copy the `:1088` test's setup: `sendMock` resolves `{ conversationId: 'c-now', reqId: 'r1' }`, upload `att-1` `notes.pdf`. Then:
  - `streamMock.mockImplementation(async (_reqId: string, h: { onError: (m: string, hints?: { messageNotSaved?: true }) => void }) => { h.onError(ERROR_LABELS['conversation:message-not-saved']!, { messageNotSaved: true }); })`. Import `ERROR_LABELS` from `@/lib/turn-error-labels`.
  - Send. Then `await screen.findByText(/didn’t reach the agent/)`.
  - `sendMock.mockClear()`, `sendMock.mockResolvedValue({ conversationId: 'c-now', reqId: 'r2' })`, `streamMock.mockResolvedValue(undefined as never)`.
  - Click `Resend`.
  - `await waitFor(() => expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c-now', text: 'have a look at this', attachmentIds: ['att-1'] })))`.
- [ ] **Step 2: Run red.** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/AgentView.test.tsx -t "resends"`. The new test FAILS because the second call has no `attachmentIds`. The three existing `resends` tests (`:619`, `:1032`, `:1088`) pass.
- [ ] **Step 3: Implement.** In `onError`, when `hints?.messageNotSaved === true`, call `setSent((prev) => (prev === null ? prev : { ...prev, resendable: true }))`. Add a two-line comment: nothing of this message was saved, so its files reach the conversation only through Resend, and the commit accepts them again in the same conversation (Task 1).
  - This also re-arms a turn the shell sent from the home composer (`pendingReply`, `:1253-1258`). That is intended: the shell's POST committed those files into the same `conversationId` that `conversationRef` now holds. Same code path, so no separate test.
- [ ] **Step 4: Rewrite the comments** that Task 1 made false.
  - Why `resendable` goes false after a POST lands: the file is now in a saved message, and naming it again would attach it twice. The one exception is a refusal that came before the save (`messageNotSaved`).
  - The "WHAT THE REJECTED CASE DOES *NOT* GUARANTEE" paragraph. In an EXISTING conversation, re-naming ids already committed into it is accepted now, so only the ref that failed fails again. A brand-new chat still 400s on Resend, as it does today. The failed POST created the conversation (`routes-chat.ts:497-511`) and committed the earlier refs into it, but a 400 carries no `conversationId`, so `conversationRef` stays null. Resend then opens a second conversation, where those refs are not found.
  - `send`'s post-POST comment (`:1280-1287`): the ids are not offered again unless the turn is then refused before the save (see `onError`).
  - The Resend button comment.
  - The `:1076-1087` test comment: replace "Naming it again would earn a 400 `attachment-not-found` … can never work" with "the file is already in a saved message, so sending it again would put it in the conversation twice".
  - That test's assertions stay unchanged.
- [ ] **Step 5: Run green.** Step 2's command: all PASS. Then `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/AgentView` (a path filter that matches all six `AgentView*.test.tsx` files, including the Resend gating in `AgentViewStop.test.tsx`). Then run the whole folder, `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__` (81 files, 1939 tests at base), because WorkspaceShell's tests render AgentView too. Then `pnpm --filter @ax/channel-web build`.
- [ ] **Step 6: Commit.** `git commit -m "[TASK-1063] channel-web: Resend after a refusal before the save sends the files too"`

### Task 4: a refused turn keeps its reqId bound on purpose; pin it and correct the lines that said otherwise [tier: integration]

**Files:**
- Test: `packages/channel-web/src/__tests__/server/routes-chat.test.ts`:
  - `BootArgs.refuseWith?: string` (`:321-350`), passed through to `chatRunMockPlugin` (`:210-255`)
  - a guard `it.each` after the TASK-498 `4c` test (`:860`)
- Modify (comments only):
  - `packages/chat-orchestrator/src/orchestrator.ts:2696-2700` and `:4671-4672`
  - `packages/conversations/src/plugin.ts:1281-1283`
  - `packages/channel-web/src/server/sse.ts:362-372`

- [ ] **Step 1: Mock option.** Give `chatRunMockPlugin` a third parameter, `refuseWith?: string`, and pass `args.refuseWith` from `boot`. When it is set, the mock captures as today, then:
  - fires `chat:turn-error` `{ reqId: ctx.reqId, reason: refuseWith }` on its bus;
  - fires `chat:end` `{ outcome }`;
  - returns `outcome = { kind: 'terminated', reason: refuseWith }`.

  That is the orchestrator's pre-routing exit shape (`orchestrator.ts:2703-2711`).
- [ ] **Step 2: Write the guard** `TASK-1063: a turn %s leaves its reqId bound, replays to a late stream, and the next turn starts normally`. Use `it.each` over `['refused inside agent:invoke', { refuseWith: 'conversation:message-not-saved' }, 'conversation:message-not-saved']` and `['whose agent:invoke call rejected', { dispatchRejects: true }, 'chat-run-dispatch-failed']`. Boot userA with the mode's option and add a `chat:turn-error` spy after boot, as `expectRejectedDispatchFiresTurnError` does (`:797-835`). Then:
  1. POST 1 `{ conversationId: null, agentId: 'agt_test', contentBlocks: [{ type: 'text', text: 'first' }] }` → 202 → `C`, `R1`.
  2. `await vi.waitFor(() => expect(fired).toEqual([{ reqId: R1, reason }]), { timeout: 30_000, interval: 5 })`.
  3. `conversations:get` `{ conversationId: C, userId: 'userA' }` via `booted.harness.ctx({ userId: 'userA' })` → `conversation.activeReqId` is `R1`.
  4. Late stream: `const late = await fetch(\`http://127.0.0.1:${booted.port}/api/chat/stream/${R1}\`, { signal: AbortSignal.timeout(5_000) })`. Expect status 200, and `await late.text()` contains `` `"error":"${reason}"` ``. The replay closes the stream, so `text()` resolves. The timeout only matters if a regression leaves the stream open. The file runs under `@vitest-environment node`, so Node's `AbortSignal` works with its `fetch`.
  5. An HTTP refusal binds nothing: POST `{ conversationId: C, agentId: 'agt_test', contentBlocks: [{ type: 'attachment', attachmentId: 'x', filename: 'x.pdf', mediaType: 'application/pdf', sizeBytes: 1 }] }` → 400 `{ error: 'invalid-content-block' }`, and `activeReqId` is still `R1`.
  6. The next turn: POST 2 `{ conversationId: C, …text 'second' }` → 202 → `R2`.
     - `R2` is not `R1`, and `activeReqId` is `R2`.
     - `vi.waitFor` until there are 2 captures.
     - `booted.chatRunCaptures[1]!.ctx` `toMatchObject({ conversationId: C, reqId: R2 })`.
     - In both modes POST 2 is refused too. Wait for its turn error: `await vi.waitFor(() => expect(fired).toHaveLength(2), { timeout: 30_000, interval: 5 })`. Its persist then finishes before `afterEach` drops the tables, with no teardown race.
  7. The old id is retired: `fetch(…/api/chat/stream/${R1})` → 404.

  Head the test with a short comment. It is a FORWARD GUARD that passes on the code it was written against. It exists because TASK-1063 found that clearing the reqId when a turn is refused turns step 4 into a 404. `sse.ts` step 2 resolves the stream through `active_req_id` before step 4a-bis can replay, so the person would read "couldn't find" instead of their refusal.
- [ ] **Step 3: Run it.** `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-chat.test.ts -t "TASK-1063: a turn"`. Expected: both cases PASS at base.
- [ ] **Step 4: Mutant proof** (throwaway, not committed). Insert the clear AFTER step 3's `activeReqId` assertion and BEFORE step 4's fetch. Otherwise step 3 fails first, and the run proves nothing about the replay. Open a `pg.Client` on `connectionString` (as `countConversations` does, `:591`) and run `UPDATE conversations_v1_conversations SET active_req_id = NULL WHERE conversation_id = $1` with `[C]`. This is the clear the card proposed. Both cases must FAIL on step 4's status (404, because `sse.ts:178` looks the stream up by `active_req_id`). Revert.
- [ ] **Step 5: Correct the comments** (comments only; keep each short).
  - `orchestrator.ts:2696-2700`. Replace "One known leftover … this turn never has one." with:
    - this refusal leaves `active_req_id` on its reqId, like every refusal after channel-web's POST-time bind, and that is on purpose;
    - the stream GET resolves the conversation by it, so a stream that opens after the refusal still replays it (channel-web `sse.ts` step 4a-bis);
    - it holds up nothing: the next POST rebinds it, and ending the bound session clears it.
  - `orchestrator.ts:4671-4672`. Keep the null sentence and add: non-null doesn't prove a turn is running, because a turn refused before it ran keeps its reqId bound until the next message. The interrupt below then reaches whatever that session is running, if anything; an idle runner drops it.
  - `conversations/src/plugin.ts:1281-1283`. Replace "Clear it too, or a reload reattaches to a stream that never ends." with: clear it too, so the row stops naming a turn that has ended, because `agent:interrupt` and the usage-limits suspend sweep treat a bound reqId as a turn that may be running.
  - `sse.ts` 4a-bis (`:362-372`). Add: this replay works only because a refused turn's reqId stays bound. Step 2 resolves the stream through `active_req_id`, so a refusal that cleared it would get a 404 here instead (TASK-1063, pinned in `routes-chat.test.ts`).
- [ ] **Step 6: Run green.**
  - Step 3's command.
  - `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/turn-error-discipline.test.ts`. The count stays 18: the edits are comments above the outcome literal.
  - `pnpm --filter @ax/conversations build`.
  - `pnpm --filter @ax/channel-web build`.
- [ ] **Step 7: Commit.** `git commit -m "[TASK-1063] a refused turn keeps its reqId bound on purpose: pin it, and fix the comments that said otherwise"`

---

## Closing

- **Full gate**, with Docker exported: `pnpm build`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. If lint exits 1, judge your change with `pnpm exec eslint <changed files>`: stale nested worktrees can fail the workspace-wide run.
- **Memory.** Write a patterns shard: `target=$(scripts/memory-write-target.sh --shard patterns TASK-1063)`, then `mkdir -p "$(dirname "$target")"`. Two rows:
  - (1) A refused turn's `active_req_id` stays bound on purpose. The stream GET resolves by it, so a late stream still replays the refusal. The next POST rebinds it. Don't clear it at refusal.
  - (2) `attachments:commit` is idempotent per (id, conversation, owner). Resend may name a committed id again in the same conversation. AgentView re-arms files only for `turnErrorMessageNotSaved` reasons.
- **PR notes.**
  - The security note from Task 1.
  - "No boundary review: no hook signature changed. `attachments:commit`'s input and output are the same; its meaning widens as Task 1 describes."
  - The part-2 refutation with decisions rows 7 and 8.
  - Part 3 deferred (row 10).
  - Follow-ups (row 15): post-save failures that never reached the runner; the suspend sweep's count; the stale `acceptance-e2e.test.ts:368-371` comment.
