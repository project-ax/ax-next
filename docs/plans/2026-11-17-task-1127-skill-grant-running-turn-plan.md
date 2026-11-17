# TASK-1127: a skill grant never ends a turn that is running — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent:apply-capability-grant` ends the conversation's sandbox session right away only when no turn is in flight there. So does `agent:apply-authored-capability-grant` when it's given a conversation. While a turn is in flight, the grant marks the session to restart at its next turn instead. That turn finishes, and the next turn starts with the skill attached. A grant on an idle session behaves as it does today.

**Architecture:** `@ax/chat-orchestrator` only, plus docs. Both grant hooks call one new helper, `retireOrMarkForSkillGrant`. "In flight" means one of two things: an `agent:invoke` for that conversation is still inside `runAgentInvoke` (a new in-memory registry), or the conversation row has a bound `active_req_id`.

- **Busy:** `respawnSessions.add`. That's the mark `skills:proposed` already uses, and the routing already retires a marked session at its next turn.
- **Idle:** `session:terminate`, as today.
- **Cold spawn:** the turn isn't bound to the conversation yet, so the grant flags it, and the turn marks its own session when it completes.

No hook, payload, IPC or manifest change.

**Tech Stack:** TypeScript, vitest, `@ax/test-harness`, `@ax/chat-orchestrator` (host plugin).

**Spec:** the card, TASK-1127. It was filed from the TASK-1095 whole-branch review and is recorded in `docs/plans/2026-11-09-channel-slack-design.md` §6 `:683-689`. Its acceptance: "a grant during a running turn lets that turn finish and the next turn starts with the skill attached; a grant on an idle session behaves as today." Planner decisions, refuted brief claims and rejected alternatives are in `.claude/memory/decisions/2026-11-17-TASK-1127.md`; read it. Tasks 1 and 2 append their security-checklist rows there.

## The problem, measured (code read at `60021d7ec`)

- **Both grant hooks end whatever session is alive.** `applyCapabilityGrant` (`orchestrator.ts:4943-4958`) and `applyAuthoredCapabilityGrant` (`:5128-5152`) call `session:terminate` on what `activeAliveSession` (`:5039-5063`) finds. That function checks that the session is alive and warm. It never checks whether a turn is running.
- **What a terminate does to a running turn.**
  - `session:terminate` revokes the session: the store marks it terminated, blocked inbox reads wake, and the event fires (`session-postgres/src/plugin.ts:1166-1178`). It doesn't kill the pod.
  - The runner's next posts get 401 and are dropped. It exits at its next inbox pull, and claude-sdk pulls ahead, so that happens mid-turn. The turn's output is lost.
  - An `agent:invoke` waiter on the session gets `chat:turn-error` `sandbox-terminated` (`onSessionTerminate`, `:1976-1990`), and `@ax/conversations` saves that into the thread.
  - A decision continuation has no waiter, so its follower just waits. In Slack, that's up to the 15-minute cap.
- **When it happens.**
  - **Slack:** a skill prompt is posted after the reply that raised it ends (`channel-slack/src/turn.ts:878-892`), and it stays answerable for 24 h (`limits.ts:176-180`). So Allow often lands during the person's next reply, which runs in the same session.
  - **Web:** Connect is enabled mid-turn (`channel-web/src/components/workspace/GrantRow.tsx:645`). After a successful grant, `resumeAfterGrant` (`WorkspaceShell.tsx:707-758` → `workspace-resume.ts:130-161`) re-POSTs the last message at once. It doesn't wait for `done`.
- **The safe pattern already exists.** `onSkillsProposed` (`:2073-2093`) only marks `respawnSessions`. The routing retires a marked session at its next turn (`:2953`, `:3021-3136`).
- **The line that made the terminate look safe:** `:4946-4947`, "No live waiter exists for a finished keepAlive turn, so onSessionTerminate fires no turn-error." It assumes the grant always lands after the turn ends. And `:4909-4910` ("web: chat.regenerate") has been stale since TASK-360 deleted that UI.
- **The gap next to it.** During a cold spawn, the row doesn't name the new session until `conversations:bind-session` (`:4573-4597`). That comes after `sandbox:open-session`, about 10 s on k8s.
  - A grant in that window finds no live session, so it does nothing.
  - The spawn had already read its skills (`:3761-3819`), so the new session never gets the skill. The next message routes into it anyway, right after Slack said "Send your message again and I'll use it."
  - In Slack this is the common case: a prompt answered minutes later meets a reaped session, so the reply that's running is a cold spawn.

## Design (decided; alternatives are in the decisions shard)

- **Busy** = `invokeInFlightFor(conversationId)` OR the row's `activeReqId` is a non-empty string.
  - `invokeInFlightFor(conversationId)` is true while an `agent:invoke` for that conversation sits between `runAgentInvoke`'s first instruction and its `finally`.
  - Covers: a routed turn that's running; one still being assembled or cold-spawning; one routed but not yet bound (`:3230-3263`); a decision continuation that channel-web bound (`routes-workspace.ts:5878-5923`).
  - Doesn't cover: a Slack continuation. It has no `agent:invoke`, and channel-slack never binds its reqId. Known residual, follow-up F1.
  - A stale binding reads as busy (a refused turn, TASK-1063, or an undone approval). That session then restarts at its next turn instead of now, which loses nothing.
- **Busy → mark:** `respawnSessions.add(sessionId)`, and log `skill_grant_restart_deferred {sessionId}`.
- **Idle → terminate**, exactly as today, with the same warn event names on failure.
- **Cold spawn:**
  - Both callers attach first. The grant then adds every in-flight invoke of its conversation to `skillGrantDuringReqIds`, before its first await.
  - A fresh-spawn turn that completes with its session kept warm marks that session if its reqId was flagged.
- **Routing:** unchanged, except that the log reason `skills-proposed` becomes `skills-changed`.
  - It still retires a marked session even when that session is busy. That's how the web's re-POST gets the skill: the re-POSTed turn supersedes the running one, as today.
  - Slack serializes message turns per conversation (`router.ts:571-573`, `turn-queue.ts:68-77`), so there the next message normally meets an idle session.
- **`respawned`** (the authored output): true when the session was ended now or marked to restart at its next turn. Nothing reads it today, and its type doesn't change; the meaning goes on the type.

## Global Constraints

- No hook, payload, IPC or manifest change, so no boundary review. Say so in the PR body, along with the one-line `respawned` meaning.
- The new code reads only host-minted or host-written values: `ctx.reqId`, `ctx.conversationId`, the grant's input, and the conversation row. It reads nothing a runner sends.
- New state is in memory, single-replica and bounded. `invokeConversationByReqId` and `skillGrantDuringReqIds` drop their entry in `runAgentInvoke`'s `finally`, the same posture as `pendingMessageReqIds` (`:1783-1799`).
- Keep the warn event names `apply_capability_grant_retire_failed` and `authored_grant_retire_failed`.
- Commands:
  - `--filter` goes before the script: `pnpm --filter @ax/chat-orchestrator test`.
  - One file: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/skill-grant-running-turn.test.ts -t "<name>"`.
  - `tsc` excludes `__tests__` here, so the build doesn't type-check tests. Still run `pnpm --filter @ax/chat-orchestrator build`; it checks the product code.
- Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. `@ax/auth-better` needs `DOCKER_HOST`; see CLAUDE.md.
- Memory:
  - New rows go only in `.claude/memory/decisions/2026-11-17-TASK-1127.md` and `.claude/memory/context/2026-11-17-TASK-1127.md`.
  - Never touch a root archive. Never edit or delete a memory line.
  - Check with `scripts/memory-append-check.sh` (default base `origin/main`).
- User-facing prose (the changeset, the PR body): CLAUDE.md voice. Package names in backticks only.

## Review Focus

1. **A grant while the running turn is still starting its sandbox.** The row doesn't name its session yet. The turn finishes, and the next turn restarts with the skill. Pinned by Task 2.
2. **A routed turn between its routing decision and its bind.** It has no waiter and no bound reqId yet. The grant must not end the session it's about to queue into. Pinned by Task 1, test C.
3. **A decision continuation the web bound** (`active_req_id` set, no `agent:invoke`) is marked, not ended. Pinned by Task 1, test D. A Slack continuation isn't covered (F1); the PR says so.
4. **One grant costs one restart.** After the restart, the next turn routes into the new session. Pinned by Task 1, test A.
5. **The idle path is unchanged:** the session ends at once, and the next turn spawns fresh with the skill. Pinned by Task 1, test B, and by the two existing one-shot grant files, which must pass unchanged.

## Files

| File | Change | Task |
|---|---|---|
| `packages/chat-orchestrator/src/orchestrator.ts` | registry and `invokeInFlightFor` after `:1799`; wrapper `:2663-2697`; `activeAliveSession` `:5036-5063` also returns the row's binding; new `retireOrMarkForSkillGrant`; both grant hooks `:4906-4961` and `:5128-5153`; routing reason `:3072-3073`; comments `:305-313`, `:323-325`, `:2067-2071`, `:2229-2235`, `:3031-3035`, `:3112-3113` | 1 |
| `packages/chat-orchestrator/src/orchestrator.ts` | `skillGrantDuringReqIds`, flagging inside the helper, the fresh-path mark after `:4731` | 2 |
| `packages/chat-orchestrator/src/plugin.ts` | comment `:262-269` | 1 |
| `packages/chat-orchestrator/src/__tests__/skill-grant-running-turn.test.ts` | new: harness and tests A–E; Task 2 adds the held open and test F | 1, 2 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §5.6 `:489-493`, §6 `:681-689` | 3 |
| `.changeset/skill-grant-running-turn.md` | new | 3 |
| `.claude/memory/context/2026-11-17-TASK-1127.md` | new shard | 3 |

**Left alone on purpose:**
- `__tests__/apply-capability-grant.test.ts` and `__tests__/apply-authored-capability-grant.test.ts`. They use a one-shot harness with no turns, they keep pinning the idle path, and they must pass unchanged.
- All channel-web and channel-slack code (follow-ups F1 and F2).

---

### Task 1: A skill grant marks a busy session instead of ending it [tier: sensitive]

Needs the **security-checklist** walk (step 6).

**Files:**
- Create: `packages/chat-orchestrator/src/__tests__/skill-grant-running-turn.test.ts`
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (lines in the Files table)
- Modify: `packages/chat-orchestrator/src/plugin.ts:262-269` (comment)

**Interfaces:**
- Produces, inside `createOrchestrator` (Task 2 uses these):
  - `const invokeConversationByReqId = new Map<string, string>()`: reqId → `ctx.conversationId`.
  - `function invokeInFlightFor(conversationId: string): boolean`
  - `async function activeAliveSession(ctx: AgentContext, conversationId: string, userId: string): Promise<{ sessionId: string; activeReqId: string | null } | null>`
  - `async function retireOrMarkForSkillGrant(ctx: AgentContext, conversationId: string, userId: string, retireFailedLog: 'apply_capability_grant_retire_failed' | 'authored_grant_retire_failed'): Promise<'retired' | 'marked' | 'none'>`
- Produces, in the test file: `makeHarness(opts?: { holdBind?: { reqId: string; release: Promise<void> } })` (step 1). Task 2 adds the `holdFirstOpen` option.

- [ ] **Step 1: Write the harness and the failing tests**

  **Where the harness comes from:**
  - Model it on `orchestrator.test.ts:7830-7913` (`makeKeepaliveHarness`), and the turn-end helper on `keepalive.test.ts:42-50`.
  - Config: `createChatOrchestratorPlugin({ runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000, keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000 })`.
  - Agent: `orchestrator.test.ts`'s `TEST_AGENT` shape (`id: 'test-agent'`, `runner: 'claude-sdk'`). Conversation `'conv-1'`, user `'test-user'`.
  - Every ctx the harness makes (turns, turn-ends, grants) logs into one shared `logs: Array<Record<string, unknown>>`, with `writer: (line) => logs.push(JSON.parse(line))`, as at `orchestrator.test.ts:601-604`.
  - Close each harness with `await h.close({ onError: () => {} })`.

  **What `makeHarness` returns:**
  - `h`
  - `conv: { activeSessionId: string | null; activeReqId: string | null }`: the one row.
  - `counters: { opens: number; terminates: string[]; openInputs: Array<{ installedSkills?: Array<{ id: string }> }> }`
  - `turnErrors: Array<{ reqId: string; reason: string }>`: every `chat:turn-error` payload, from `h.bus.subscribe`.
  - `logs`
  - `entered: { bind: Promise<void> }`: resolves when the held bind is entered.
  - `invoke(sessionId: string, reqId: string): Promise<AgentOutcome>`: `agent:invoke` on `conv-1` with `{ role: 'user', content: 'hi' }`.
  - `queued(reqId: string): Promise<void>`: resolves once `session:queue-work` has received that reqId's `user-message`.
  - `endTurn(sessionId: string, reqId: string): Promise<void>`: clears `conv.activeReqId` if it equals `reqId`, as `@ax/conversations` does (`conversations/src/plugin.ts:1300-1332`). Then it runs `await h.bus.fire('chat:turn-end', <ctx with that sessionId and conversationId 'conv-1'>, { reason: 'user-message-wait', reqId })`.
  - `endTurnSoon(sessionId, reqId): void`: the same inside `setImmediate`. Call it before awaiting a turn that should simply complete.
  - `grant(skillId: string)`: calls `agent:apply-capability-grant` with `{ conversationId: 'conv-1', userId: 'test-user', agentId: 'test-agent', skillId }`.
  - `grantAuthored(skillId: string)`: the same input, sent to `agent:apply-authored-capability-grant`.

  **Services:**

  | Hook | Mock |
  |---|---|
  | `agents:resolve` | `{ agent: { ...TEST_AGENT } }` |
  | `session:queue-work` | Record `user-message` reqIds, resolve `queued()` waiters, return `{ cursor: 0 }`. |
  | `session:terminate` | Push to `terminates`, drop from `live`. If `conv.activeSessionId` is that session, set both row fields to null (as `clearBySessionId` does). Return `{}`. |
  | `session:is-alive` | `{ alive: live.has(sessionId) }` |
  | `conversations:get` | The row, with `agentId: 'test-agent'` and `activeSessionId` / `activeReqId` taken from `conv`. |
  | `conversations:bind-session` | If `opts.holdBind?.reqId === input.reqId`, resolve `entered.bind` and await `opts.holdBind.release`. Then `conv.activeSessionId = input.sessionId`, `conv.activeReqId = input.reqId`, `live.add(input.sessionId)`. |
  | `sandbox:open-session` | `opens += 1`, push the input, return `{ runnerEndpoint: 'unix:///tmp/m.sock', handle }`. The handle's `kill` resolves `exited`. |
  | `proxy:open-session`, `proxy:close-session` | As at `orchestrator.test.ts:7890-7896`. |
  | `skills:attach-for-user` | Add `skillId` to `attached` if it's absent. Return `{ created: <it was absent> }`. |
  | `skills:list-user-attachments` | `{ attachments: attached.map((skillId) => ({ skillId, credentialBindings: {} })) }` |
  | `skills:resolve` | ``{ skills: skillIds.map((id) => ({ id, manifestYaml: `name: ${id}\n`, bodyMd: 'b', connectors: [] })) }`` |
  | `agents:resolve-authored-skills` | `{ skills: [{ id: 'my-draft', description: 'd', connectors: [], bodyMd: 'b', manifestYaml: 'name: my-draft\n', files: [], status: draftStatus }] }`, with `draftStatus` starting at `'pending'`. |
  | `skills:authored-activate` | Set `draftStatus = 'active'`, return `{ activated: true }`. |

  `installedIds(i) = (i.installedSkills ?? []).map((s) => s.id)`.

  **The prelude** used by A–E is `endTurnSoon('s-1', 'req-1'); await invoke('s-1', 'req-1');`. Afterwards `s-1` is warm, the row names it, and its binding is cleared.

  Tests go in `describe('TASK-1127: a skill grant never ends a turn that is running', …)`.

  **A.** `it('a grant during a running turn lets it finish; the next turn restarts with the skill')`
  ```ts
  // prelude
  const t2 = invoke('s-2', 'req-2');              // routed into s-1
  await queued('req-2');                           // in s-1's inbox: running
  expect(await grant('notes')).toEqual({ attached: true });
  expect(counters.terminates).toEqual([]);
  await endTurn('s-1', 'req-2');
  expect(await t2).toEqual({ kind: 'complete', messages: [] });
  expect(turnErrors).toEqual([]);
  endTurnSoon('s-3', 'req-3');
  await invoke('s-3', 'req-3');
  expect(counters.terminates).toEqual(['s-1']);
  expect(counters.opens).toBe(2);
  expect(installedIds(counters.openInputs[0]!)).not.toContain('notes');
  expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toMatchObject({ sessionId: 's-1' });
  expect(logs.find((l) => l.msg === 'stale_session_respawn')).toMatchObject({ sessionId: 's-1', reason: 'skills-changed' });
  endTurnSoon('s-3', 'req-4');                    // one grant, one restart
  await invoke('s-4', 'req-4');
  expect(counters.opens).toBe(2);
  ```

  **B.** `it('a grant on an idle session ends it at once, as before')`
  ```ts
  // prelude
  expect(await grant('notes')).toEqual({ attached: true });
  expect(counters.terminates).toEqual(['s-1']);
  expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toBeUndefined();
  endTurnSoon('s-2', 'req-2');
  await invoke('s-2', 'req-2');
  expect(counters.opens).toBe(2);
  expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  ```

  **C.** `it('a turn routed to the session but not yet bound to the conversation counts as running')`, with `makeHarness({ holdBind: { reqId: 'req-2', release } })`. The test makes the hold itself: `let releaseBind!: () => void; const release = new Promise<void>((r) => { releaseBind = r; });`.
  ```ts
  // prelude
  const t2 = invoke('s-2', 'req-2');
  await entered.bind;                              // routed to s-1: no waiter, no binding yet
  await grant('notes');
  expect(counters.terminates).toEqual([]);
  releaseBind();
  await queued('req-2');
  await endTurn('s-1', 'req-2');
  expect(await t2).toEqual({ kind: 'complete', messages: [] });
  endTurnSoon('s-3', 'req-3');
  await invoke('s-3', 'req-3');
  expect(counters.terminates).toEqual(['s-1']);
  expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  ```

  **D.** `it('a request bound to the conversation without an agent:invoke (a decision continuation) counts as running')`
  ```ts
  // prelude
  conv.activeReqId = 'cont-1';                     // channel-web binds a continuation at approve time
  await grant('notes');
  expect(counters.terminates).toEqual([]);
  await endTurn('s-1', 'cont-1');                  // the continuation ends
  endTurnSoon('s-2', 'req-2');
  await invoke('s-2', 'req-2');
  expect(counters.terminates).toEqual(['s-1']);
  expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  ```

  **E.** `it('the authored grant marks a busy session too, and reports that it will restart')`
  ```ts
  // prelude; then t2 and queued('req-2') as in A
  expect(await grantAuthored('my-draft')).toEqual({ applied: true, respawned: true });
  expect(counters.terminates).toEqual([]);
  await endTurn('s-1', 'req-2');
  expect(await t2).toEqual({ kind: 'complete', messages: [] });
  endTurnSoon('s-3', 'req-3');
  await invoke('s-3', 'req-3');
  expect(counters.terminates).toEqual(['s-1']);
  expect(installedIds(counters.openInputs[0]!)).not.toContain('my-draft');
  expect(installedIds(counters.openInputs[1]!)).toContain('my-draft');
  ```

- [ ] **Step 2: Run, and check the failures**

  Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/skill-grant-running-turn.test.ts`

  Expected:
  - A, C, D and E FAIL: `terminates` is `['s-1']` right after the grant.
  - B PASSES: it guards the idle path.

  If B fails, fix the harness, not the product code. The likely cause is that the prelude's binding wasn't cleared.

- [ ] **Step 3: Implement** in `orchestrator.ts`:

  1. **The registry**, after `stopRequestedReqIds` (`:1799`): add `invokeConversationByReqId` and `invokeInFlightFor`. The comment says:
     - what it holds;
     - why a grant needs it: it has to see a turn that the session-level signals can't see yet (one being assembled or cold-spawning, or one routed but not yet bound);
     - that it's bounded by the wrapper's `finally`;
     - that it's single-replica, like the maps above it.
  2. **`runAgentInvoke`** (`:2663-2697`):
     - Next to `pendingMessageReqIds.add`, before any await: `if (ctx.conversationId !== undefined) invokeConversationByReqId.set(ctx.reqId, ctx.conversationId);`
     - In the `finally`: `invokeConversationByReqId.delete(ctx.reqId);`
  3. **`activeAliveSession`** (`:5036-5063`):
     - Return `{ sessionId: candidate, activeReqId: conv.conversation.activeReqId }` instead of the bare id.
     - In its comment, change "(retire / live-widen)" to "(end or mark)", and note that it also hands back the row's bound request.
  4. **New `retireOrMarkForSkillGrant`**, just above `activeAliveSession`, with the signature from Interfaces. The order matters:
     ```ts
     const live = await activeAliveSession(ctx, conversationId, userId);
     if (live === null) return 'none';
     // Asked AFTER the lookup's awaits, so a turn that started meanwhile counts.
     const bound = live.activeReqId !== null && live.activeReqId.length > 0;
     if (invokeInFlightFor(conversationId) || bound) {
       respawnSessions.add(live.sessionId);
       ctx.logger.info('skill_grant_restart_deferred', { sessionId: live.sessionId });
       return 'marked';
     }
     try {
       await bus.call('session:terminate', ctx, { sessionId: live.sessionId });
       return 'retired';
     } catch (err) {
       ctx.logger.warn(retireFailedLog, {
         conversationId,
         err: err instanceof Error ? err : new Error(String(err)),
       });
       return 'none';
     }
     ```
     Its comment covers:
     - **Why.** A session reads skills only at spawn. Ending it under a turn loses that turn: the runner's posts get 401, `sandbox-terminated` is saved into the thread, and a continuation's follower just waits.
     - **What busy means.** The two signals and what each one covers. A stale binding reads as busy and costs nothing. A Slack continuation is invisible, and that's F1's job.
     - **The routing still retires a marked session at its next routed turn, even if that session is still busy.** The web's re-POST relies on that.
  5. **`applyCapabilityGrant`:**
     - Replace its step 4 (`:4943-4958`) with `await retireOrMarkForSkillGrant(ctx, input.conversationId, input.userId, 'apply_capability_grant_retire_failed');`.
     - Rewrite the header (`:4906-4910`):
       - It ends the conversation's session when the session is idle, and marks it when a turn is in flight.
       - On re-issuing: after a successful Connect, channel-web's workspace re-POSTs the person's last message (`resumeAfterGrant`). Slack asks them to send it again.
       - Drop the "No live waiter…" sentence.
  6. **`applyAuthoredCapabilityGrant`** (`:5128-5153`):
     - When `convId !== undefined`: `respawned = (await retireOrMarkForSkillGrant(ctx, convId, input.userId, 'authored_grant_retire_failed')) !== 'none'`.
     - Fix its comment the same way as in item 5.
  7. **Type docs:**
     - `ApplyAuthoredCapabilityGrantInput.conversationId` (`:305-313`): "whose warm session this grant retires" becomes "whose session this grant ends (idle) or marks to restart at its next turn (a turn in flight)".
     - Add a doc line on `ApplyAuthoredCapabilityGrantOutput` (`:323-325`): `respawned` is true when the conversation's session was ended now or marked to restart at its next turn, and false when there was none or ending it failed.
  8. **Routing:**
     - Change the reason `'skills-proposed'` to `'skills-changed'` (`:3073`).
     - At `:3031-3035`, "Safe HERE (between turns)…" becomes: it usually is between turns. A turn routed here while the session still runs another one retires it under that turn: a second tab, channel-web's re-POST right after a skill Connect, or a Slack message after the grace period or the cap already ended its reply. That turn ends `sandbox-terminated`, and a continuation just stops. For the re-POST that's the point: it supersedes the running turn and gets the skill.
     - At `:3112-3113`, "Nothing of the old session is in flight: these reasons fire between turns" gets the same correction, as one sentence pointing up to `:3031`.
  9. **`respawnSessions`** comment (`:2229-2235`): add its second producer, a skill grant that lands while a turn is in flight (`retireOrMarkForSkillGrant`, TASK-1127).
  10. **`onSkillsProposed`** comment (`:2067-2071`): "applyAuthoredCapabilityGrant already terminates on approve" becomes "the approval grant ends an idle session or marks a busy one".
  11. **`plugin.ts:262-269`:** "retire the conversation's warm session so the next turn re-spawns and resumes" becomes "end the conversation's session when idle, or mark it to restart at its next turn while a turn is in flight (TASK-1127)".

- [ ] **Step 4: Run, and check that everything passes**

  - Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/skill-grant-running-turn.test.ts`. Expected: A–E PASS.
  - Run: `pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/chat-orchestrator build`. Expected: PASS, with both existing grant files unchanged.

- [ ] **Step 5: Mutants**

  Commit step 3 first. Predict which tests each mutant kills, then run the file. Restore with `git checkout HEAD -- packages/chat-orchestrator/src/orchestrator.ts`, and check that `git status --short` is clean between mutants.

  | Mutant | Predicted to fail |
  |---|---|
  | M1: always terminate (no busy branch) | A, C, D, E |
  | M2: always mark (no terminate) | B |
  | M3: busy without `invokeInFlightFor` | C |
  | M4: busy without the bound reqId | D |
  | M5: `respawned` only for `'retired'` | E |

  A survivor means a test is missing. Add it before moving on.

- [ ] **Step 6: Run the security-checklist walk**

  Append its row to the decisions shard. The expected result is no new reach. Note two things:
  - A host allowed "for now" (`proxy:add-host`) on a busy session now lasts until that session's next turn.
  - The new code reads no runner-written field.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/chat-orchestrator/src .claude/memory/decisions/2026-11-17-TASK-1127.md
  git commit -m "[TASK-1127] chat-orchestrator: a skill grant marks a busy session instead of ending it"
  ```

---

### Task 2: A grant during a cold spawn still reaches the new session [tier: sensitive]

Needs the **security-checklist** walk (step 6).

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Modify: `packages/chat-orchestrator/src/__tests__/skill-grant-running-turn.test.ts`

**Interfaces:**
- Consumes from Task 1: `invokeConversationByReqId`, `retireOrMarkForSkillGrant`, and `makeHarness`.
- Produces: `const skillGrantDuringReqIds = new Set<string>()`, which holds reqIds of in-flight invokes that a grant landed during.

- [ ] **Step 1: Add the held open and test F**

  Add the harness option `holdFirstOpen?: Promise<void>`. The first `sandbox:open-session` call resolves `entered.open`, then awaits that promise. As in test C, the test makes the hold itself and keeps its resolver as `releaseOpen`. The open is held after the turn has read its skills (`:3761-3819`) and registered its waiter (`:4380`), and before `conversations:bind-session` (`:4573`).

  ```ts
  it('a grant while the turn is still starting its sandbox: the turn finishes, the next one restarts with the skill', async () => {
    const t1 = invoke('s-1', 'req-1');
    await entered.open;                             // skills read, sandbox opening, the row names no session
    expect(await grant('notes')).toEqual({ attached: true });
    expect(counters.terminates).toEqual([]);
    releaseOpen();
    await queued('req-1');
    await endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] });
    expect(installedIds(counters.openInputs[0]!)).not.toContain('notes');  // read before the attach
    endTurnSoon('s-2', 'req-2');
    await invoke('s-2', 'req-2');
    expect(counters.opens).toBe(2);
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });
  ```

- [ ] **Step 2: Run, and check the failure**

  Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/skill-grant-running-turn.test.ts -t "starting its sandbox"`

  Expected: FAIL. `opens` is 1, because turn 2 routes into `s-1`, which never got the skill. Task 1's code doesn't help here: during the open, the row names no live session, so the grant returns `'none'`.

- [ ] **Step 3: Implement**

  1. Declare `skillGrantDuringReqIds` next to the registry, and delete its entry in `runAgentInvoke`'s `finally`.
  2. In `retireOrMarkForSkillGrant`, add a flagging step as the very first thing, synchronously, before `activeAliveSession`:
     - Add every reqId in `invokeConversationByReqId` whose conversation is this one, and remember whether any was flagged.
     - When `live === null`, return `flagged ? 'marked' : 'none'`.
     - The comment explains the order. Flagging before the first await means a turn that ends while the grant looks up the row was still flagged. Both callers attach before calling, so a turn that starts after the flags reads the skill.
  3. In the fresh path, right after `const keepWarm = …` (`:4731`), add `if (keepWarm && skillGrantDuringReqIds.has(ctx.reqId)) respawnSessions.add(sessionId);`. The comment explains two things:
     - Why: while this session was being assembled and opened, the conversation wasn't bound to it, so a grant couldn't find it, and the skills it read may predate the attach.
     - Why only a warm session: a killed one restarts anyway, and a mark on it could outlive its `session:terminate`.

- [ ] **Step 4: Run, and check that everything passes**

  Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/skill-grant-running-turn.test.ts && pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/chat-orchestrator build`

  Expected: A–F PASS, and the package passes.

- [ ] **Step 5: Mutants** (same procedure as Task 1)

  | Mutant | Predicted to fail |
  |---|---|
  | M6: no flagging | F |
  | M7: no fresh-path mark | F |
  | M8: mark regardless of `keepWarm` | nothing (expected) |

  M8 surviving is expected: it guards against a leaked mark on a dead session, and nothing outside can observe that. Record it in the shard.

- [ ] **Step 6: Run the security-checklist walk**

  Append its row to the decisions shard. The expected result is no new reach: only host-minted ids, and bounded state.

- [ ] **Step 7: Commit**

  `[TASK-1127] chat-orchestrator: a grant during a cold spawn reaches the new session`

---

### Task 3: Docs, changeset and memory [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`
- Create: `.changeset/skill-grant-running-turn.md`
- Create: `.claude/memory/context/2026-11-17-TASK-1127.md`

- [ ] **Step 1: Slack design §5.6**

  At `:491-493`, replace the sentence "It attaches the skill for that person and retires the conversation's warm session, so nothing reruns the message: the reply asks them to send it again." with:

  > It attaches the skill for that person and retires the conversation's warm session: at once when it's idle, or when a reply is still running there, once the next message arrives (TASK-1127). Nothing reruns the message: the reply asks them to send it again.

  Keep the paragraph's indentation.

- [ ] **Step 2: Slack design §6**

  Replace the two bullets at `:681-689` ("A skill Allow retires…" and "A skill Allow can end a reply that is running…") with:

  ```markdown
  - **A skill Allow retires the conversation's warm session**, as the web
    app's Connect does. Since TASK-1127 it ends the session at once only when
    it's idle. While a turn is running there (a reply, one still starting up,
    or a continuation the web app bound), it marks the session instead, as
    `skills:proposed` does: the running reply finishes, and the next message
    restarts the session with the skill.
  - **A skill Allow can still end a woken continuation.** Slack never binds a
    continuation's request to the conversation (the web app does, at approve
    time), and a continuation has no `agent:invoke` waiter, so the host can't
    tell it's running. Allow during one ends it, and its follower waits out
    the cap. Fix: bind it, as channel-web's `bindContinuationTurn` does
    (follow-up).
  - **A message routed into a marked session that's still busy restarts it
    under the running turn.** Slack's lanes make that rare: it takes a reply
    that the cap or the grace period already ended while the agent kept
    going, or a message sent while a woken continuation runs.
  ```

- [ ] **Step 3: Changeset**

  Write `.changeset/skill-grant-running-turn.md`:

  ```markdown
  ---
  '@ax/chat-orchestrator': patch
  ---

  Allowing a skill while the agent is still replying no longer cuts the reply off. Before, the Allow ended the conversation's sandbox on the spot, so a reply that was halfway through was lost. Now the reply finishes, and your next message starts with the skill. If nothing is running, the sandbox restarts right away, as before.

  Two things we haven't fixed yet. In Slack, a reply the agent writes after you approve one of its requests can still be cut off by a skill Allow, because AX can't tell yet that this kind of reply is running. And in the web app, Connect still sends your last message again straight away, which replaces a reply that was still running.
  ```

- [ ] **Step 4: Memory**

  `target=$(scripts/memory-write-target.sh --shard context TASK-1127); mkdir -p "$(dirname "$target")"`. Don't name the variable `path`. Write this:

  ```markdown
  # TASK-1127 — skill grants and running turns (context)

  - 2026-11-17 — **A skill grant can land while a turn is running, on both channels.** Web: Connect is enabled mid-turn (`GrantRow.tsx:645`), and `resumeAfterGrant` re-POSTs the last user text at once, without waiting for `done` (`WorkspaceShell.tsx:707-758`, `workspace-resume.ts:130-161`). Slack: a skill prompt is answerable for 24 h, so Allow often lands during a later reply. CORRECTS `patterns.md:1144` (TASK-374), which has the grant landing after `done`. CORRECTS `context.md:183`: chat's `resumeActions`/`runtime.tsx` were deleted in TASK-360, and the workspace has re-issued the turn since TASK-374.
  - 2026-11-17 — **Since TASK-1127, a grant ends the conversation's session only when no turn is in flight.** A turn is in flight when an `agent:invoke` for the conversation is still in `runAgentInvoke`, or `active_req_id` is bound. Otherwise the grant marks the session (`respawnSessions`, log `skill_grant_restart_deferred`), and a cold-spawning turn marks its own session when it completes. The routing retires a marked session at its next routed turn even while it's busy (log reason `skills-changed`). That's how the web's re-POST supersedes a running turn.
  - 2026-11-17 — **`session:terminate` doesn't kill a pod.** It revokes the session and wakes blocked inbox reads (`session-postgres/src/plugin.ts:1166-1178`). The runner's posts then get 401, and it exits at its next inbox pull (claude-sdk pulls ahead, so mid-turn). Killing a pod is `handle.kill()`. So a terminate under a running turn loses the turn's output, not just its stream.
  - 2026-11-17 — **The host can't see a decision continuation.** It has no `agent:invoke` and no waiter. Only channel-web binds its reqId to `active_req_id` (`routes-workspace.ts` `bindContinuationTurn`); channel-slack doesn't. `sessionBusy` and the idle reaper are both blind to it.
  ```

- [ ] **Step 5: Check**

  Run: `scripts/memory-append-check.sh && pnpm --filter @ax/chat-orchestrator test`

  Expected: both pass. The guard reports only additions.

- [ ] **Step 6: Commit**

  `[TASK-1127] docs, changeset and memory for skill grants during a running turn`

---

## For the PR body

- **No hook-surface change.** One output meaning moves: `respawned` is now also true when the session was marked to restart at its next turn. Nothing reads it.
- **Security note:** from Tasks 1 and 2.
- **Residuals:**
  - A Slack continuation can still be ended by a skill Allow (F1).
  - On the web, the immediate re-POST still supersedes a running turn (F2).
- **Follow-ups to file:**
  - **F1 (channel-slack):** bind a continuation's reqId at approve time, as channel-web does. That also lets the cap's Stop reach it.
  - **F2 (channel-web):** the resume after Connect re-POSTs while the asking turn may still be running. Stop it first, or wait for `done`, and fix `workspace-resume.ts:84-93` there.
  - **F3 (chat-orchestrator, already broken):** the idle reaper can reap a continuation that's still running, and `onConnectorDeleted` treats "reaper armed" as idle too.
  - The oldest-waiter fallback is already TASK-1126.
- **Optional kind re-check:** in Slack, Allow a skill prompt while a later reply is still streaming. Expected: the reply finishes, the pod stays up, the host logs `skill_grant_restart_deferred`, and the next message's turn logs `stale_session_respawn` with reason `skills-changed`.
