# TASK-1150: a reply that is still running is never cut off (Slack Allow, web re-POST, idle reaper, failed grant read) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four ways TASK-1127 left for a running reply to be cut off:

- **F3:** the idle reaper, and `connectors:deleted`, no longer end a session while its conversation binds a request to it (a decision continuation).
- **Minor 1:** a skill grant whose row read fails still restarts the conversation's warm session at its next turn.
- **F1:** channel-slack binds an Allow's continuation to its conversation, as channel-web does, so the host can see it.
- **F2:** channel-web's resume after Connect waits for a reply that is still running instead of replacing it.

**Architecture:** Three packages. No hook signature changes; one manifest change.
- `@ax/chat-orchestrator` (Tasks 1–2): each warm session remembers the conversation and user it was opened for. The reaper reads that conversation's row before it reaps, and holds off while the row binds a request to the session, for 15 minutes at most (Task 1b). A grant whose row read fails marks that conversation's warm sessions.
- `@ax/channel-slack` (Task 3): the Allow binds the continuation's reqId (`conversations:get`, then `conversations:bind-session`, a new optional call).
- `@ax/channel-web` (Task 4): `resumeParkedTurn` follows the conversation's live reply (`liveReqId`) to its end, up to 60 s, before re-sending. Past that it sends nothing, and the row says so.

**Tech Stack:** TypeScript, vitest (fake timers for the reaper tests), `@ax/test-harness`, React Testing Library (channel-web).

**Spec:** card TASK-1150, drawn from `.claude/memory/decisions/2026-11-17-TASK-1127.md`: the rows "Known residual: the host can't see a Slack continuation", "Follow-ups" F1/F2/F3, and "Builder, review round 2" Minor 1. The planner's decisions, the refuted brief claims and the rejected alternatives are in `.claude/memory/decisions/2026-11-18-TASK-1150.md`; read it. Tasks 1–3 append their security-checklist rows there.

## The problem, measured (code read at `29840a695`)

- **F3, the idle reaper.**
  - `onTurnEnd` arms `armReapTimer(ctx, idleWindowMs)` at every warm turn end (`orchestrator.ts:4970-4986`). Only a routed `agent:invoke` clears it (`:3323`), plus `onAgentDeleted` (`:2714`).
  - @ax/decisions wakes a decision continuation with `session:queue-work` (`decisions/src/delivery.ts:186-195`). The continuation never passes `agent:invoke`, so the timer armed at the held turn's end keeps running.
  - When the timer fires, it queues `cancel` and force-kills after `idleGraceMs` (`:2247-2270`), whatever is running. So a continuation still running 5 minutes after the held turn ended is killed 10 s later.
  - `onConnectorDeleted` reads "reaper armed" as idle (`:2653-2662`). It closes a running continuation's proxy session and reaps it at once.
- **Minor 1, a failed grant read.** `activeAliveSession` answers `null` on every lookup failure (`:5271-5277`). `retireOrMarkForSkillGrant` then returns `'none'` unless a turn was in flight (`:5217-5219`). The idle session is neither ended nor marked, so the next turn routes into it without the skill.
- **F1, Slack continuations.**
  - The Allow passes its minted `continuationReqId` only to `decisions:approve` (`channel-slack/src/decision-answer.ts:340-363`). Nothing in channel-slack binds it. channel-web binds at approve time (`routes-workspace.ts:5878-5923`, `:7268-7272`).
  - So the host sees no binding for a Slack continuation:
    - a skill Allow ends it (TASK-1127's busy check);
    - the 15-minute cap's `agent:interrupt` answers `interrupted: false` (`orchestrator.ts:5108-5109`);
    - F3's fix couldn't see it either.
- **F2, the web re-POST.**
  - `GrantRow` enables Connect mid-turn (`GrantRow.tsx:645`). After the grant, `resumeAfterGrant` (`WorkspaceShell.tsx:707-758`) calls `resumeParkedTurn` (`workspace-resume.ts:130-161`), which re-POSTs the last user text at once.
  - The grant marked the busy session (TASK-1127), and routing retires a busy marked session under its running turn (`orchestrator.ts:3123-3130`). The reply is cut off as `sandbox-terminated`, and @ax/conversations saves that error into the thread.
- **Who clears a continuation's binding.**
  - @ax/conversations compare-clears `active_req_id` on the continuation's own `chat:turn-end` (`conversations/src/plugin.ts:1293-1332`). The woken runner emits under the entry's reqId, and the IPC listener stamps the session's conversationId on the ctx.
  - `session:terminate` clears the row (`:1338-1356`).
  - Nothing clears a continuation that never starts. It stays bound until the next turn binds, or the session ends. The same is true for channel-web today.

## Design (decided; the alternatives are in the decisions shard)

- **F3: a turn is running when the conversation's row binds a request to this session.**
  - `WarmEntry` gains `conversationId: string | undefined`, `userId: string` (the spawning ctx's, fixed for the session's life) and `reapGen: number`.
  - Before it reaps, the timer reads `conversations:get({ conversationId, userId })` using the entry's two fields. A turn is running when `row.activeSessionId === sessionId && typeof row.activeReqId === 'string' && row.activeReqId.length > 0`.
    - Running: log `keepalive_reap_deferred {sessionId}` and re-arm a full `idleWindowMs`, or only what is left of the hold when that is shorter (Task 1b); never 0.
    - Past the hold's bound (Task 1b): warn `keepalive_reap_hold_expired {sessionId}`, then reap.
    - Not running, no conversation on the entry, or no `conversations:get` on the bus: reap as today.
    - A read that throws: warn `keepalive_reap_check_failed {sessionId, err}`, then reap as today.
  - `clearReapTimers` bumps `reapGen`. The reap snapshots it before the read. It is dropped if the counter changed, or if the entry is gone (`warmSessions.get(sessionId) !== entry`): a turn that started, a re-arm, an agent delete or an exit owns the session now.
  - `onConnectorDeleted`: a session whose idle timer is armed goes through the same check (`armReapTimer({ ...ctx, sessionId }, 0)`).
    - Its proxy session is closed at once, as before TASK-1150, whenever no routed turn runs there: idle timer armed, grace timer armed, or the reaper's row read in flight (Task 1b; Task 1 first moved this close into the reap, which let a continuation keep its proxy session until it ended). `reapNow` closes too (idempotent), for the turn-end reap.
    - So a running continuation loses its proxy session (every credential it had) at the delete, and its calls fail upstream; it is not cancelled or killed until it ends. Only a routed turn keeps the key until it ends (TASK-833).
  - The deleted-connector reap at a turn end (in `onTurnEnd`) skips the check: `armReapTimer(ctx, 0, { force: true })`, as today. It keeps its direct close too, ahead of the forced reap (review Major 1): `clearReapTimers` from a turn routed in before that 0 ms timer fires would otherwise cancel the close with the reap.
    - This keeps TASK-833's bound: the key stays usable until the end of the routed turn running at the delete, and never into a turn that starts after it.
  - **The hold is bounded (Task 1b):** `reapHoldMaxMs` (orchestrator config, default 15 min, the cap channel-slack puts on a woken continuation's reply) in total, counted from the first hold (`WarmEntry.heldSince`) and started over when a turn starts or ends on the session (the routed path's clear, `onTurnEnd`) or the row binds a different request (`WarmEntry.heldReqId`, review Minor 2), never by the reaper's own re-arm. A hold re-reads after at least `REAP_HOLD_RECHECK_MIN_MS` (1 s), so a 0 ms idle window can't spin (review Nit 6). The host can't tell a running continuation from a stale binding (a refused turn, TASK-1063; a wake-up that never ran; a failed compare-clear), so past the bound the session is reaped anyway. A cooperative runner usually exits first, at its own 15-minute inbox floor (`agent-runner-core/src/inbox-loop.ts:40-42`, `run-runner.ts:1055-1063`); the bound is the host-side guarantee. See the decisions shard.
- **Minor 1: a failed read marks the conversation's warm sessions.**
  - `activeAliveSession` answers `'lookup-failed'` from its catch. Its other `null`s stay.
  - `retireOrMarkForSkillGrant` then marks every warm session with `entry.conversationId === conversationId && entry.userId === userId`, skipping any already marked. It logs `skill_grant_restart_deferred {sessionId}` for each one it marks.
  - It returns `'marked'` if it found such a session or flagged a turn, else `'none'`.
- **F1: channel-slack binds the continuation.**
  - In the Allow branch, right after `startFollowing` and under the same condition (`out.streamReqId === continuationReqId`), `startBinding` runs.
  - It reads `conversations:get({ conversationId, userId })` for the prompt's own conversation and user, then calls `conversations:bind-session({ conversationId, sessionId: activeSessionId, reqId: continuationReqId })`. Both use the answer's ctx, which is the prompt's user: `bind-session` scopes on `ctx.userId`.
  - Never awaited. A failure logs `slack_prompt_failed {installId, kind: 'decision', stage: 'bind', code}`, and the answer stands.
  - No live session: nothing is bound.
  - `conversations:bind-session` joins `optionalCalls`. `conversations:get` is already there.
- **F2: the web resume waits for a reply that's still running.**
  - `resumeParkedTurn` already reads the agent detail. When the detail's `liveReqId` is a non-empty string, it follows that turn with `workspaceApi.streamReply(liveReqId, { resume: true, signal, … })`. It waits for `onDone`, `onError` or a rejection, up to `RESUME_WAIT_MS = 60_000`, then re-sends as today.
  - Still going at 60 s: nothing is sent, the result is `{ resumed: false, reason: 'still-running' }`, and the row says `GRANT_NOT_RESUMED_BUSY`.
  - No `agent:interrupt`: the reply the person is watching gets to finish.
  - `resumeAfterGrant` picks between staging the reply and showing a toast from `routeNow.current`: the answer can now land after a wait.

## Global Constraints

- No hook, payload or IPC change, so no boundary review (only existing hooks are used). Say so in the PR body.
- One manifest change: channel-slack's `optionalCalls` gains `conversations:bind-session`. Pin it in BOTH `packages/channel-slack/src/__tests__/plugin.test.ts:547-610` and `presets/k8s/src/__tests__/preset.test.ts:1287-1356`.
- Tasks 1, 1b, 2 and 3 each get a security-checklist walk, and each appends its row to `.claude/memory/decisions/2026-11-18-TASK-1150.md`.
- The orchestrator's new reads use host-written values only: the entry's spawn-time `conversationId` and `userId`, and the conversation row. Nothing a runner sends.
- New state stays in memory, single-replica, and bounded by the warm-session map.
- Log names, exactly: `keepalive_reap_deferred` (info), `keepalive_reap_check_failed` (warn), `keepalive_reap_hold_expired` (warn, Task 1b), `skill_grant_restart_deferred` (existing), and `slack_prompt_failed` with stage `bind`.
- Commands put `--filter` before the script: `pnpm --filter @ax/chat-orchestrator test`. For one file: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/keepalive.test.ts -t "<name>"`. Same shape for `@ax/channel-slack`, `@ax/channel-web` and `@ax/preset-k8s`.
- `tsc` excludes `__tests__` in chat-orchestrator and channel-slack, so their `build` checks only product code. channel-web's `tsc --build` DOES type-check its tests: run `pnpm --filter @ax/channel-web build`.
- `packages/channel-slack/src/__tests__/plugin.test.ts` starts Postgres in its top-level `beforeAll` (`:354-355`). Set `DOCKER_HOST` before running even its manifest pin (CLAUDE.md, "Docker-backed tests").
- Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Memory:
  - New rows go only in `.claude/memory/decisions/2026-11-18-TASK-1150.md` and the new `.claude/memory/context/2026-11-18-TASK-1150.md`.
  - Never touch a root archive, and never edit or delete an existing memory line.
  - Check with `scripts/memory-append-check.sh`.
- User-facing prose (copy, changesets, PR body) follows the CLAUDE.md voice. channel-web copy uses curly apostrophes (’), as `grant-copy.ts` does.
- TASK-1135 (one prompt for a connector-reaching skill) is being built in parallel on channel-slack's skill-prompt path. Keep Task 3 to the decision Allow's binding.
  - Expect conflicts only in the two manifest pins, the tail of `plugin.ts`'s optionalCalls, and the Slack design doc §5.6/§6. On rebase, keep both sides.
  - Name TASK-1135 in the handoff if anything overlapped.

## Review Focus

1. **A turn that starts while the reaper is still reading the row** must not get a `cancel` queued under it. Pinned by Task 1, test K5.
2. **A continuation bound when a connector is deleted** loses its proxy session at once, but isn't cancelled until it ends; so does a session whose reaper is reading the row, while a turn routed in during that read keeps its key until it ends. A continuation bound while a deleted-connector turn is ending doesn't hold that turn's reap. Pinned by K6, K11, K12 (Task 1b) and K7.
3. **A failed read must fail toward today's reap**, never toward holding the session. Pinned by Task 1, K4.
4. **A Slack Allow whose conversation has no live session any more** reads the row and binds nothing. Pinned by Task 3, S3.
5. **The web's wait on a reply whose binding is stale** sits on keepalives. The 60 s bound ends it: the busy sentence shows and nothing is re-sent. Pinned by Task 4, W3 and W6.
6. **A binding nothing clears holds a session for `reapHoldMaxMs` at most**, and only a real turn starts that clock over. Pinned by Task 1b, K9 and K10.

## Files

| File | Change | Task |
|---|---|---|
| `packages/chat-orchestrator/src/orchestrator.ts` | `WarmEntry` `:2217-2230`; `clearReapTimers`/`armReapTimer` `:2232-2271`, plus new `reapNow`, `reapUnlessTurnRunning`, `turnBoundTo`; `onConnectorDeleted` `:2618-2666`; comment on the routed path's clear `:3316-3322`; `warmSessions.set` `:4583-4585`; `onTurnEnd`'s keepAlive branch `:4970-4987` | 1 |
| `packages/chat-orchestrator/src/plugin.ts` | comment on the conditionally-called peers `:142-169` | 1 |
| `packages/chat-orchestrator/src/__tests__/keepalive.test.ts` | new describe (K1, K2, K4, K5); TASK-833 `setup` row gains `activeReqId`; K6, K7 | 1 |
| `packages/chat-orchestrator/src/orchestrator.ts`, `plugin.ts`, `__tests__/keepalive.test.ts` | `reapHoldMaxMs` config + boot check; `WarmEntry.heldSince`/`reapReading`; `resetReapHold`; the bound in `reapUnlessTurnRunning`; `onConnectorDeleted`'s close; K6 changed, K9–K12, config rejects | 1b |
| `packages/chat-orchestrator/src/orchestrator.ts` | `retireOrMarkForSkillGrant` `:5189-5242`; `activeAliveSession` `:5244-5279`; new `markWarmSessionsOf`; comment on the routed end mark `:3453-3455` | 2 |
| `packages/chat-orchestrator/src/__tests__/skill-grant-running-turn.test.ts` | `grant()` takes an optional userId; G1, G2, G3 | 2 |
| `packages/channel-slack/src/decision-answer.ts` | header `:15-26`; Allow branch `:350-363`; `startBinding` beside `startFollowing` `:379-394` | 3 |
| `packages/channel-slack/src/plugin.ts` | `optionalCalls` `:229-256`; header `:122-127` | 3 |
| `packages/channel-slack/src/__tests__/decision-answer.test.ts` | `fake()` gains opt-in conversations fakes; S1–S5 | 3 |
| `packages/channel-slack/src/__tests__/plugin.test.ts`, `presets/k8s/src/__tests__/preset.test.ts` | manifest pins | 3 |
| `packages/channel-web/src/lib/workspace-resume.ts` | header `:1-38`; `lastUserText` doc `:83-102`; `ResumeFailure`, `GrantResume`, `RESUME_WAIT_MS`, the wait, `grantResumeFor`, `resumeParkedTurn` | 4 |
| `packages/channel-web/src/lib/grant-copy.ts` | `GRANT_NOT_RESUMED_BUSY`; doc `:200-212` | 4 |
| `packages/channel-web/src/components/workspace/GrantRow.tsx` | `stalled` `:169`, `:327`, `:492`; comment `:307-309` | 4 |
| `packages/channel-web/src/components/workspace/WorkspaceShell.tsx` | `resumeAfterGrant` and its doc `:675-758` | 4 |
| `packages/channel-web/src/lib/__tests__/workspace-resume.test.ts`, `src/components/workspace/__tests__/WorkspaceGrantResume.test.tsx`, `src/components/workspace/__tests__/GrantRow.test.tsx` | W1–W7 | 4 |
| `packages/chat-orchestrator/src/orchestrator.ts` | comments that Tasks 3–4 make stale: `:3123-3132`, `:5165-5180`, `:5205-5207` | 5 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §5.6 `:489-492`; §6 `:775-786` | 5 |
| `docs/plans/2026-05-24-current-architecture.md` | `:230-234` | 5 |
| `.changeset/skill-grant-running-turn.md` | its residuals paragraph | 5 |
| `.changeset/continuation-cutoff.md`, `.claude/memory/context/2026-11-18-TASK-1150.md` | new | 5 |

---

### Task 1: The idle reaper holds off while the conversation binds a request to the session [tier: sensitive]

> **Superseded in part by Task 1b** (a review finding, built after Task 1): the hold below has no bound, and `onConnectorDeleted`'s idle branch only arms, so K6 expected a running continuation to keep its proxy session. Task 1b bounds the hold and closes the proxy session at the delete again; K6's expectation changed with it. The steps below are kept as Task 1 was built.

Needs the **security-checklist** walk (Step 6).

**Interfaces:**
- Produces `WarmEntry.conversationId: string | undefined` and `WarmEntry.userId: string`, which Task 2 reads. Both are set at `warmSessions.set` from the spawning `ctx`.
- `armReapTimer(ctx: AgentContext, delayMs: number = idleWindowMs, opts: { force?: boolean } = {}): void`.

- [ ] **Step 1: Write the failing tests**

  **A new top-level describe in `keepalive.test.ts`:** `describe('TASK-1150: the idle reaper holds off while the conversation binds a request to the session', …)`.

  Its harness is `reaperSetup(o: { failRead?: boolean; holdFirstRead?: Promise<void> } = {})`. Copy the services and fake-timer pattern of `'keepalive idle reaper: queues a graceful cancel, then force-kills after grace'` (`:298-349`). Copy the routed second turn's services from `:53-120`. Then add:
  - **One row** `{ activeSessionId, activeReqId }`. `conversations:bind-session` writes both fields; `conversations:get` answers the row for any conversation id.
  - **`endTurn(sessionId, reqId)`:** the file's `fireTurnEnd`, but its ctx (reqId `'ipc-fresh'`) logs into the harness's `logs`. The reaper logs, and reads the row, on the ctx of the turn end that armed it. The file-level `fireTurnEnd` writes its logs nowhere, so the new tests must not use it.
  - **The reaper's reads** are the `conversations:get` calls made on that turn-end ctx (`c.reqId === 'ipc-fresh'`). The harness:
    - counts them (`reads()`);
    - makes them throw when `failRead` is set;
    - with `holdFirstRead`, copies the row and THEN holds the first read, so the read answers with the row as it was when read.
  - **Recordings:** `queued` entries as `{ sessionId, type }`, the handle's kills (`kills()`), and `logs`.
  - **Config:** `keepAlive: true, idleWindowMs: 1_000, idleGraceMs: 500, chatTimeoutMs: 5_000`.
  - **`firstTurn()`:** turn 1 opens `s-1` in `conv-1` (invoke, `endTurn('s-1', 'req-1')`, `advanceTimersByTimeAsync(0)`, then await the invoke). It then sets `row.activeReqId = null`, as the store's compare-clear would. After it, `s-1` is warm, the row names it with nothing bound, and the reaper is armed.
  - **`invoke(sessionId, reqId)`:** an `agent:invoke` in `conv-1`.

  Tests. Each runs inside `vi.useFakeTimers()` with `finally { vi.useRealTimers() }`, ends with `forceExit()`, and uses `cancels(r)` for the session ids of the `cancel` entries in `queued`:

  ```ts
  it('K1: a continuation still running when the idle window ends keeps its session; once it ends, the session is reaped', async () => {
    // r = await reaperSetup()
    await r.firstTurn();
    r.row.activeReqId = 'cont-1'; // a channel binds the continuation an approval woke: no agent:invoke
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancels(r)).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.kills()).toBe(0);
    expect(r.logs.filter((l) => l.msg === 'keepalive_reap_deferred')).toEqual([
      expect.objectContaining({ sessionId: 's-1' }),
    ]);
    r.row.activeReqId = null; // the continuation ends: the store clears its binding,
    r.endTurn('s-1', 'cont-1'); // and its turn end re-arms the reaper
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancels(r)).toEqual(['s-1']);
    await vi.advanceTimersByTimeAsync(500);
    expect(r.kills()).toBe(1);
  });

  it('K2: a request bound to another session does not hold this one', async () => {
    await r.firstTurn();
    r.row.activeSessionId = 's-9';
    r.row.activeReqId = 'req-9';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancels(r)).toEqual(['s-1']);
  });

  it('K4: a row that cannot be read is reaped as before, and the reaper says so', async () => {
    // r = await reaperSetup({ failRead: true })
    await r.firstTurn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancels(r)).toEqual(['s-1']);
    expect(r.logs.find((l) => l.msg === 'keepalive_reap_check_failed')).toMatchObject({ sessionId: 's-1' });
  });

  it('K5: a turn routed in while the reaper is still reading the row keeps its session', async () => {
    // r = await reaperSetup({ holdFirstRead }), releaseRead resolves holdFirstRead
    await r.firstTurn();
    await vi.advanceTimersByTimeAsync(1_000); // the window ends; the reaper's read is held (nothing bound when read)
    expect(r.reads()).toBe(1);
    const t2 = r.invoke('s-2', 'req-2'); // routed into s-1
    await vi.advanceTimersByTimeAsync(0);
    expect(r.queued).toContainEqual({ sessionId: 's-1', type: 'user-message' });
    releaseRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancels(r)).toEqual([]);
    r.endTurn('s-1', 'req-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(await t2).toEqual({ kind: 'complete', messages: [] });
  });
  ```

  **In the TASK-833 describe:** `setup`'s `conv` gains `activeReqId: null as string | null`, `conversations:get` answers `activeReqId: conv.activeReqId`, and `setup` returns `conv`. Bind-session leaves `activeReqId` alone, so every existing test still reads `null`. Each new test ends with `for (const hk of t.handles) hk.forceExit();`.

  ```ts
  it('K6: deleting a connector while a decision continuation runs leaves it its proxy session; it is reaped when the continuation ends', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    t.conv.activeReqId = 'cont-1';
    t.state.effective = [];
    await t.deleteConnector('linear', LINEAR_NS);
    await t.settle();
    expect(t.queued.filter((q) => q.type === 'cancel')).toEqual([]);
    expect(t.proxyCloses).not.toContain('s-1');
    t.conv.activeReqId = null;
    fireTurnEnd(t.h.bus, 's-1', 'cont-1');
    await t.settle();
    expect(t.queued).toContainEqual({ sessionId: 's-1', type: 'cancel' });
    expect(t.proxyCloses).toContain('s-1');
    expect(linearStillInjected(t)).toEqual([]);
  });

  it('K7: a continuation bound while a deleted-connector turn is ending does not hold that reap', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1', async () => {
      t.state.effective = [];
      await t.deleteConnector('linear', LINEAR_NS);
      t.conv.activeReqId = 'cont-1'; // approved while the turn ran
    });
    await t.settle();
    expect(t.queued).toContainEqual({ sessionId: 's-1', type: 'cancel' });
    expect(t.proxyCloses).toContain('s-1');
  });
  ```

- [ ] **Step 2: Run them, and confirm they fail for the right reason**

  Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/keepalive.test.ts -t "TASK-1150|K6|K7"`

  Expected on unchanged code:
  - K1 fails: `cancels` is `['s-1']` after the first window.
  - K4 fails: nothing logs `keepalive_reap_check_failed`.
  - K5 fails: `reads()` is 0, because today's reaper reads nothing.
  - K6 fails: a cancel is queued and the proxy closed right after the delete.
  - K2 and K7 pass. They pin what must not change.

- [ ] **Step 3: Implement it in `orchestrator.ts`**

  - `WarmEntry` gets the three fields, and its comment states the reap rule. `warmSessions.set` fills `conversationId: ctx.conversationId, userId: ctx.userId, reapGen: 0`.
  - `clearReapTimers` bumps `entry.reapGen`.
  - Move today's callback body into `function reapNow(ctx, sessionId, entry): void`. It first runs `if (connectorDeletedSessions.has(sessionId)) closeProxyForDeletedConnector(ctx, sessionId);`, then the existing cancel and grace kill, unchanged.
  - `armReapTimer(ctx, delayMs, { force })`: the timer sets `entry.idleTimer = null`. Then `force` → `reapNow`, else `void reapUnlessTurnRunning(ctx, sessionId, entry)`.
  - `async function turnBoundTo(ctx, sessionId, entry): Promise<boolean>`: the Design's rule. It returns `false` with no conversation on the entry, or no `conversations:get` on the bus. It calls `conversations:get` with `{ conversationId: entry.conversationId, userId: entry.userId }`.
  - `async function reapUnlessTurnRunning(ctx, sessionId, entry): Promise<void>`. Never throws.
    1. Snapshot `entry.reapGen`.
    2. Call `turnBoundTo`. On a throw, warn `keepalive_reap_check_failed {sessionId, err}` and treat it as not running.
    3. Return if the counter changed or the entry is gone.
    4. Running: info `keepalive_reap_deferred {sessionId}`, then `armReapTimer(ctx, idleWindowMs)`. Otherwise `reapNow`.
  - `onTurnEnd`'s keepAlive branch: the deleted-connector arm becomes `armReapTimer(ctx, 0, { force: true })`. Drop its `closeProxyForDeletedConnector` call, since `reapNow` closes. Its comment (`:4979-4980`) says the reap closes the proxy session, and is forced: a continuation bound by then doesn't hold it (TASK-833's bound).
  - `onConnectorDeleted`: keep the grace-timer close. The idle-timer branch only arms, `armReapTimer({ ...ctx, sessionId }, 0)`, with no direct close.
    - Rewrite its header ("A session mid-turn is not interrupted", `:2621-2622`) and the note "Idle = the reaper is armed" (`:2653-2655`): a running decision continuation also has the reaper armed. The reap reads the row first, and keeps the session, and its proxy session, until the continuation ends, as for a routed turn.
  - Comments:
    - `WarmEntry`'s "reaped by the idle timer (Task 5)…" (`:2217-2219`) gains the hold.
    - The routed path's "cancel any pending idle reap" (`:3316-3322`) also cancels a reap that is still reading the row (the generation check).
  - `plugin.ts`, in the comment on the conditionally-called peers: the idle reaper reads `conversations:get` too, for a session opened for a conversation (TASK-1150), and without it reaps as before.

- [ ] **Step 4: Run them, and confirm they pass; then the package**

  Re-run Step 2's command: all pass. Then:
  - `pnpm --filter @ax/chat-orchestrator test`
  - `pnpm --filter @ax/chat-orchestrator build`
  - `pnpm exec eslint packages/chat-orchestrator`

  Every existing test should pass unchanged. Each existing reaper test either reads `activeReqId: null` or has no `conversations:get`, and `agent-deleted.test.ts:256` relies on "no conversation → reap". The fake-timer test at `:298` still kills at 1500 ms, because vitest's fake timers flush the read's microtasks.

- [ ] **Step 5: Mutants**

  Restore each one with `git checkout HEAD -- packages/chat-orchestrator/src/orchestrator.ts`, and check that `git status --short` is empty before the next. Predicted kills:

  | Mutant | Killed by |
  |---|---|
  | no hold | K1, K5, K6 |
  | ignore `activeSessionId` | K2 |
  | a failed read holds instead of reaping | K4 |
  | no generation check | K5 |
  | `force` ignored at the turn end | K7 |
  | the idle branch of `onConnectorDeleted` still closes directly | K6 |
  | `reapNow` without the deleted-connector close | K6, K7 (plus the existing `:763` and `:805`) |

  Record the results in the decisions shard.

- [ ] **Step 6: security-checklist**

  Walk it against the Task 1 diff, then append the row. The expected outcome is no new reach; verify each point:
  - **Sandbox:** a session lives longer only while the conversation's row binds a request to it. That binding is host-written (a channel at approve time, or the orchestrator); a runner never writes it.
  - **A runner keeping the hold:** it can do so only by never ending its continuation. A routed turn already allows that today: the routed path clears the reaper and re-arms it only at a turn end.
  - **Stale bindings:** they end at the runner's 15-minute inbox floor. A runner that ignores the floor lives to the pod ceiling, as one that never ends a routed turn does today.
  - **TASK-833:** a deleted connector's key stays usable until the end of a turn running, or bound, at the delete. It never reaches a turn that starts at a deleted-connector turn end (K7).
  - **Injection:** the read takes the entry's spawn-time ids, and the logs carry a host-minted sessionId.
  - **Supply chain:** no dependency change.

- [ ] **Step 7: Commit** — `[TASK-1150] chat-orchestrator: the idle reaper holds off while a continuation runs`

### Task 1b: The hold is bounded, and a continuation the host can't verify gets no grace with a deleted key [tier: sensitive]

A security review of Task 1 (MEDIUM, fail-open): the deferral re-armed a full window every time the row looked bound, with no bound, and the host can't tell a live continuation from a stale binding (the "F3 residual" row). So a connector-deleted session with a stale binding kept the deleted key until its runner exited on its own (TASK-877 removed exactly that dependence), and any stale binding lost the host-side kill. Needs the **security-checklist** walk.

- **Bound the hold.** New config `reapHoldMaxMs` (default 15 min; a finite number ≥ 0, else refused at init). `WarmEntry.heldSince` is set at the first hold, reset by `resetReapHold` from the routed path's clear and from `onTurnEnd` (a real turn), never by the reaper's own re-arm. A hold re-arms `min(max(idleWindowMs, 1 s), what is left)`, and a different bound request restarts the clock (review round 1); past the bound: warn `keepalive_reap_hold_expired {sessionId}`, then `reapNow`.
- **No credential grace at a delete.** `onConnectorDeleted` closes the proxy session at once for every session not running a routed turn: idle timer armed, grace timer armed, or `WarmEntry.reapReading` (set before the reaper's row read, cleared after it and by `clearReapTimers`). The reap still goes through the row check, so a running continuation isn't cancelled until it ends; it loses its proxy session (every credential it had) and its calls fail upstream. A routed turn keeps TASK-833's bound. `reapNow`'s close stays (idempotent).
- **Tests** (`keepalive.test.ts`): K6 changed (closed at the delete, before any reap; no cancel or kill until the continuation's turn end). New: K9 (a binding that never clears is reaped exactly at the bound, logs `keepalive_reap_hold_expired`), K10 (a turn end starts the hold over), K11 (a delete during the reaper's row read closes at once), K12 (a turn routed in during that read keeps its key through a delete until it ends), and `reapHoldMaxMs` = Infinity, NaN, −1 refused at init.

### Task 2: A grant whose row read fails still restarts the conversation's session [tier: sensitive]

Needs the **security-checklist** walk (Step 6).

**Interfaces:**
- Consumes `WarmEntry.conversationId` and `WarmEntry.userId` from Task 1.
- `activeAliveSession(ctx, conversationId, userId): Promise<{ sessionId: string; activeReqId: string | null } | null | 'lookup-failed'>`.
- `markWarmSessionsOf(ctx: AgentContext, conversationId: string, userId: string): boolean`. It returns true when a warm session of that conversation and user is marked, now or already.

- [ ] **Step 1: Write the failing tests**

  In `skill-grant-running-turn.test.ts`, inside the existing describe. In the harness, `grant(skillId, conversationId = 'conv-1', userId = 'test-user')`, and `grantInput` takes the userId.

  ```ts
  it.each([
    ['catalog', 'notes', { attached: true }],
    ['authored', 'my-draft', { applied: true, respawned: true }],
  ] as const)("G1: the %s grant can't read the conversation while its session is idle: it marks it, and the next turn restarts with the skill", async (kind, skillId, expected) => {
    const x = await makeHarness({ failGrantLookup: true });
    await prelude(x);
    expect(await (kind === 'catalog' ? x.grant(skillId) : x.grantAuthored(skillId))).toEqual(expected);
    expect(x.counters.terminates).toEqual([]);
    expect(x.logs.filter((l) => l.msg === 'skill_grant_restart_deferred')).toEqual([
      expect.objectContaining({ sessionId: 's-1' }),
    ]);
    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(x.counters.terminates).toEqual(['s-1']);
    expect(x.counters.opens).toBe(2);
    expect(installedIds(x.counters.openInputs[1]!)).toContain(skillId);
  });

  it.each([
    ['another conversation', 'conv-2', 'test-user'],
    ['another person', 'conv-1', 'someone-else'],
  ] as const)("G2: a grant that can't read the row marks only its own person's sessions of its own conversation: %s", async (_name, conversationId, userId) => {
    const x = await makeHarness({ failGrantLookup: true });
    await prelude(x);
    await x.grant('notes', conversationId, userId);
    x.endTurnSoon('s-1', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(x.counters.opens).toBe(1);
    expect(x.counters.terminates).toEqual([]);
  });

  it('G3: a grant while a cold-spawned session is up but its turn is not bound yet (a Slack turn): the turn marks it as it ends', async () => {
    // makeHarness({ holdBind: { reqId: 'req-1', release } }); the row starts empty, since Slack binds nothing at POST
    const t1 = x.invoke('s-1', 'req-1');
    await x.entered.bind; // s-1 is up (warm); the row doesn't name it yet
    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(x.logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toBeUndefined();
    releaseBind();
    await x.queued('req-1');
    await x.endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] });
    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(x.counters.terminates).toEqual(['s-1']);
    expect(installedIds(x.counters.openInputs[1]!)).toContain('notes');
  });
  ```

- [ ] **Step 2: Run them, and confirm they fail**

  Run: `pnpm --filter @ax/chat-orchestrator exec vitest run src/__tests__/skill-grant-running-turn.test.ts -t "G1|G2|G3"`

  Expected:
  - Both G1 cases fail: the next turn is routed into `s-1` (`terminates` is `[]`, `opens` is 1). The authored case also answers `respawned: false`.
  - G2 and G3 pass. They pin the filter, and the existing turn-end mark that G3 keeps pinned.

- [ ] **Step 3: Implement it**

  - `activeAliveSession`'s catch returns `'lookup-failed'` and keeps its warn.
  - `retireOrMarkForSkillGrant` handles `'lookup-failed'` right after the lookup, per the Design.
  - Add `markWarmSessionsOf` beside `markIfSkillGrantFlagged`.
  - Comments:
    - `activeAliveSession` (`:5244-5252`): replace "That does NOT self-correct … (TASK-1127 residual; a follow-up tracks …)" with what happens now. A failed read answers `'lookup-failed'`, and the grant marks the conversation's warm sessions, those opened for that user.
    - `retireOrMarkForSkillGrant`'s header: add one sentence after the paragraph "An idle session whose terminate fails is marked too": "So are the conversation's warm sessions when the row can't be read at all (TASK-1150): that read is the one that tells idle from busy." Its return doc: `'marked'` also covers "a failed read found a warm session of the conversation".
    - The flag comment's fragment "a failed lookup finds no session at all," becomes "a failed lookup can't tell which session serves the conversation (its warm sessions are marked instead),". Change only that fragment: Task 5 edits another sentence of this comment.
    - The routed end mark's comment (`:3453-3455`), "(the grant's row lookup failed; it marks it directly otherwise)", becomes "(belt and braces: since TASK-1150 a grant whose read fails marks the conversation's warm sessions itself)".

- [ ] **Step 4: Run them, and confirm they pass; then the package**

  Re-run the 3 new tests, then the whole file. Then `pnpm --filter @ax/chat-orchestrator test`, the package build, and eslint.

- [ ] **Step 5: Mutants**

  | Mutant | Killed by |
  |---|---|
  | the scan never runs (today's `'none'`) | both G1 cases |
  | the scan ignores conversationId | G2, "another conversation" |
  | the scan ignores userId | G2, "another person" |
  | the scan marks but returns `'none'` | G1, authored |

  New expected survivor among TASK-1127's mutants: M4 (no routed end mark). On a failed read the grant now marks the routed turn's session itself, so `:677` no longer reaches the end mark. M7′ (no fresh end mark) stays killed, by G3. Note both in the decisions row.

- [ ] **Step 6: security-checklist**

  Append the row. Expected: no new reach.
  - A mark only restarts a session at its next routed turn, on the existing retire-and-spawn path.
  - The scan covers only warm sessions this host opened for exactly that conversation and that user, both recorded at spawn. So a grant whose own ACL'd read failed can't mark another person's session (G2), even from a caller that skipped its ownership check.
  - Injection: none. The ids are host-minted, and the one log carries a host-minted sessionId.
  - Supply chain: none.

- [ ] **Step 7: Commit** — `[TASK-1150] chat-orchestrator: a grant whose row read fails marks the conversation's sessions`

### Task 3: channel-slack binds an Allow's continuation to its conversation [tier: sensitive]

Needs the **security-checklist** walk (Step 6): this task changes a manifest and writes host state on the click path.

**Interfaces:** none for other tasks.

- [ ] **Step 1: Write the failing tests**

  **In `decision-answer.test.ts`:**
  - `fake()` gains an opt-in `conversations?: { activeSessionId?: string | null; get?: () => unknown; bind?: (input: Record<string, unknown>) => unknown }`. When it's present, `fake()` registers `conversations:get` and `conversations:bind-session`, unless `without` names them.
    - `conversations:get`'s default answer is `{ conversation: { conversationId: PROMPT.conversationId, userId: PROMPT.userId, agentId: PROMPT.agentId, activeSessionId: o.conversations.activeSessionId ?? 'sess_warm', activeReqId: null } }`. Use `?? 'sess_warm'` only when the key is absent; an explicit `null` stays null.
    - Record `convGets` and `binds`, each as `{ ctx, input }`.
  - Opt-in keeps every existing test as it is, including the exact line count in the logs test (`:806-840`).
  - A new describe: `describe("Allow binds the continuation it follows to the conversation, as the web app's approve does (TASK-1150)", …)`.
    - **S1** "binds the minted id to the conversation's live session, as the prompt's user, after the follower has started":
      ```ts
      const answer = await f.click('allow');
      expect(answer).toEqual({ line: COPY.decisionAllowed, settle: true });
      await vi.waitFor(() => expect(f.binds).toHaveLength(1));
      const minted = f.approves[0]!.input['continuationReqId'];
      expect(f.convGets.map((c) => c.input)).toEqual([{ conversationId: 'conv_mel_support', userId: 'usr_mel' }]);
      expect(f.binds[0]!.input).toEqual({ conversationId: 'conv_mel_support', sessionId: 'sess_warm', reqId: minted });
      expect(f.binds[0]!.ctx.userId).toBe('usr_mel');
      expect(readsWhenFollowStarted).toBe(0); // a `follow` option records f.convGets.length when it is called
      ```
    - **S2** `it.each` "binds nothing when nothing is followed", over three cases: the host made the call (`{ ...inert('executed'), executed: true, path: 'host-replays' }`), a stream under another id (`handedToAgent('req-someoneelse1')`), and a Deny. After the click and one macrotask (`await new Promise((r) => setTimeout(r, 0))`), `convGets` and `binds` are both `[]`.
    - **S3** "a conversation with no live session: it is read, nothing is bound" (`activeSessionId: null`). `vi.waitFor` one `convGets` entry, then one macrotask; `binds` is `[]`.
    - **S4** `it.each` "a read or a bind that fails: logged by code, and the answer and the follower stand". The two cases are `get: () => { throw fault(); }` and `bind: () => { throw fault(); }`. Expect the `decisionAllowed` answer, one entry in `follows`, and `await vi.waitFor(() => expect(f.logged('slack_prompt_failed')).toEqual([{ installId: INSTALL_ID, kind: 'decision', stage: 'bind', code: 'store-unavailable' }]))`.
    - **S5** `it.each` "a kernel without conversations:get, or without conversations:bind-session: nothing is read or bound, and the answer stands" (`without: [hook]`).

  **The pins.** In `plugin.test.ts` (`:593-597`) and `preset.test.ts` (`:1338-1341`), append after the skill pair:
  ```ts
  // A continuation an Allow woke is bound to its conversation, as the web app binds it (TASK-1150).
  {
    hook: 'conversations:bind-session',
    degradation: "an Allow's continuation isn't bound to its conversation, so a skill Allow or the idle reaper can end it, and the 15-minute cap can't stop it",
  },
  ```

- [ ] **Step 2: Run them, and confirm they fail**

  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/decision-answer.test.ts`: S1 fails (no bind, so `waitFor` times out), S3 fails (no read), S4 fails (no `bind` log). S2 and S5 pass.
  - `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/preset.test.ts -t "channel-slack"` fails.
  - With `DOCKER_HOST` set, `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts -t "manifest pins"` fails.

- [ ] **Step 3: Implement it**

  - **`decision-answer.ts`:**
    - Add `startBinding(bus, ctx, prompt, reqId, failed)` next to `startFollowing`, with the same shape: never awaited, and `.catch` → `failed('bind', logCode(err))`.
    - Its async body:
      1. Return unless both services are on the bus.
      2. Read `conversations:get` `{ conversationId: prompt.conversationId, userId: prompt.userId }` on `ctx`.
      3. Read `conversation.activeSessionId` with `isRecord`/`typeof`, since it is another plugin's answer.
      4. When it is a non-empty string, call `conversations:bind-session` `{ conversationId: prompt.conversationId, sessionId, reqId }` on `ctx`.
    - Call it right after `startFollowing`, inside the same `streamReqId === continuationReqId` branch.
    - Add the constants `CONVERSATION = 'conversations:get'` and `BIND = 'conversations:bind-session'` beside `APPROVE`/`DISMISS`/`GET`.
  - **Header bullet (`:15-26`).** After "the thread starts following the agent's next turn right away", add: "and binds that id to the conversation's live session (`conversations:bind-session`), as channel-web's approve route does. That binding is how the host sees the turn running: a skill Allow during it marks the session instead of ending it, the idle reaper holds off, and the cap's stop reaches it. @ax/conversations clears it when the turn ends. Best-effort and never awaited: a failure is logged (stage `bind`), and the turn runs unbound, as before."
  - **`plugin.ts`:** add the optionalCalls entry (the pins' text) with a one-line comment. In the header's Allow sentence (`:122-127`), "the agent's next turn is followed into the thread" becomes "…is followed into the thread and bound to the conversation".

- [ ] **Step 4: Run them, and confirm they pass**

  Re-run Step 2's three commands. Then:
  - `pnpm --filter @ax/channel-slack test` (needs `DOCKER_HOST`)
  - `pnpm --filter @ax/channel-slack build`
  - `pnpm --filter @ax/preset-k8s test`
  - `pnpm exec eslint packages/channel-slack presets/k8s`

- [ ] **Step 5: Mutants**

  | Mutant | Killed by |
  |---|---|
  | no bind | S1 |
  | bind before the follower | S1's order check |
  | bind on every Allow | S2 |
  | bind with a null session | S3 |
  | bind under another user's ctx (e.g. `userId: ''`) | S1's `ctx.userId` |
  | swallow without logging | S4 |

- [ ] **Step 6: security-checklist**

  Append the row. Expected: no new reach.
  - The new optional call writes the conversation's binding only for the prompt's own user and conversation, both recorded by the host when the prompt was posted.
  - It writes only after the click gate has re-proved the clicker, and after decisions handed the approval to the agent under the id minted here.
  - `bind-session` scopes on `ctx.userId`, so a cross-tenant write is impossible. It is host-only, never an IPC action.
  - The binding only makes the host treat that conversation as busy: a grant marks it, the reaper holds off, and Stop reaches it.
  - Nothing from the click, the message or the card is used.
  - Logs carry codes only.
  - Supply chain: a manifest list grows; the producer is the existing @ax/conversations. No dependency change.

- [ ] **Step 7: Commit** — `[TASK-1150] channel-slack: bind an Allow's continuation to its conversation`

### Task 4: The web's resume after Connect waits for a reply that's still running [tier: integration]

No security-checklist. This is client-side only: the same reads and POST as today, plus one more read of a stream the page already reads (`/api/chat/stream/:reqId`, which the host ACLs).

**Interfaces:**
- In `workspace-resume.ts`:
  - `export const RESUME_WAIT_MS = 60_000`.
  - `ResumeFailure` gains `'still-running'`, and `GrantResume` gains `'reply-when-done'`.
  - `export function grantResumeFor(reason: ResumeFailure): GrantResume`: `'read-only'` → `'reply-elsewhere'`, `'still-running'` → `'reply-when-done'`, anything else → `false`.
- `GRANT_NOT_RESUMED_BUSY`, in `grant-copy.ts`.

- [ ] **Step 1: Write the failing tests**

  **`workspace-resume.test.ts`** (`detail()` takes an optional `liveReqId`; `ASK` is `'file my open Linear issues'`):
  - **W1** "waits for a reply still being written in that conversation, then re-sends":
    - Mock `streamReply` to capture `(reqId, handlers)` and return a promise that stays pending.
    - Start `resumeParkedTurn` without awaiting it, then flush.
    - `expect(send).not.toHaveBeenCalled()`, and `expect(stream).toHaveBeenCalledWith('req-ask', expect.objectContaining({ resume: true, signal: expect.any(AbortSignal) }))`.
    - Call `handlers.onDone()`. The result is `{ resumed: true, reqId: 'req-resume', conversationId: 'cnv-1', text: ASK }`, `send` was called once, and the captured signal is aborted.
  - **W2** "a reply that ends in an error has ended too: it re-sends", via `handlers.onError('x')`, on real timers.
  - **W2b** "a stream that can't be read at all doesn't hold the re-send": `streamReply` rejects.
  - **W3** "a reply still going when we stop waiting: nothing is re-sent, and the stream is let go", on fake timers:
    - `advanceTimersByTimeAsync(RESUME_WAIT_MS - 1)` leaves it pending.
    - Advance 1 more: the result is `{ resumed: false, reason: 'still-running' }`, `send` was not called, and the signal is aborted.
  - **W4** "nothing in flight (`liveReqId: null`): re-sends at once and follows nothing". `stream` is not called.
  - `grantResumeFor`: the three mappings.

  **`GrantRow.test.tsx`:**
  - Widen the type of `row`'s `onGranted` parameter to `(grant: WorkspaceGrant) => Promise<GrantResume>`. channel-web's tsc type-checks tests.
  - **W6** "a grant that landed while the agent was still busy says so, keeps the row, and Got it clears it":
    - `onGranted` resolves `'reply-when-done'`.
    - `findByText(GRANT_NOT_RESUMED_BUSY)` finds it, and `GRANT_NOT_RESUMED` is absent.
    - `onResolved` is not called until "Got it" is clicked.

  **`WorkspaceGrantResume.test.tsx`**, in 'a grant answered in the thread':
  - The `streamMock` implementation in `beforeEach` awaits its script (`await script(h)`), so a script can hold its stream open. The existing scripts return nothing and are unaffected.
  - **W5** "Connect while the asking reply is still streaming: it finishes first, then the message is re-sent and its answer lands".
    - The `req-ask` script keeps every handler it is given, and fires `onPermissionRequest(linearSkill())` on the first. It returns a promise that the test resolves on release. On release, it sets `threads['cnv-1'] = stoppedThread()`, drops `liveReqId`, and calls `onDone()` on every kept handler.
    - While it runs, `threads['cnv-1']` is `[{ kind: 'user', id: 't1', text: ASK }]`, and the `cnv-1` detail carries `liveReqId: 'req-ask'`.
    - Script `req-resume` as the file's first test does, and set it BEFORE `connect()`.
    - Then:
      ```ts
      connect();
      await waitFor(() => expect(streamMock).toHaveBeenCalledWith('req-ask', expect.objectContaining({ resume: true })));
      expect(sendMock).toHaveBeenCalledTimes(1);
      release();
      await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
      expect(sendMock).toHaveBeenLastCalledWith({ agentId: 'a-quill', conversationId: 'cnv-1', text: ASK });
      expect(await screen.findByText(ANSWER)).toBeInTheDocument();
      expect(toastSpy).not.toHaveBeenCalled();
      ```
  - **W7** "the person moves to Today while the asking reply finishes: the resumed turn is announced, not staged for the panel they left".
    - Use W5's setup.
    - Once the wait has started (the `req-ask` call with `resume: true`), run `fireEvent.click(screen.getByRole('button', { name: /^Today/ }))` and `await screen.findByRole('heading', { name: 'Today' })`.
    - Release. Then `await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2))` and `await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: grantResumedTitle('Quill') }))`.
    - `streamMock` is never called with `'req-resume'`.

- [ ] **Step 2: Run them, and confirm they fail**

  Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/workspace-resume.test.ts src/components/workspace/__tests__/WorkspaceGrantResume.test.tsx src/components/workspace/__tests__/GrantRow.test.tsx`

  Expected:
  - W1 and W3 fail: the message is re-sent at once.
  - W5 fails: there is no resume stream, and the second send comes right after Connect.
  - W6 fails: there's no `GRANT_NOT_RESUMED_BUSY` export.
  - The `grantResumeFor` tests fail: it isn't exported.
  - W2, W2b and W4 pass.
  - W7 can only fail for the right reason once the wait exists. Check it after Step 3's `workspace-resume.ts` work: it must fail then (the stale `route` stages the reply, so there's no toast). It passes after the `routeNow` change.

- [ ] **Step 3: Implement it**

  - **`workspace-resume.ts`:**
    - Add the types, `RESUME_WAIT_MS` and `grantResumeFor`.
    - Add a module-private `waitForTurnEnd(reqId: string, timeoutMs: number): Promise<boolean>`. It resolves true on `onDone`, `onError` or a rejection of `streamReply`, and false at the timeout. It aborts its controller either way and never rejects. Its content handlers are no-ops.
    - In `resumeParkedTurn`, keep the detail's `liveReqId`. After the `nothing-to-resume` check and before the POST, wait when it is a non-empty string. If the wait returns false, return `{ resumed: false, reason: 'still-running' }`.
    - Stale lines (rule 5):
      - The header (`:4-21`), "the model says it has asked, and the TURN ENDS … there is no current turn to give it to", now says: the turn normally ends a moment after the card, but Connect is live while it is still running. Then the resume follows that reply to its end (up to `RESUME_WAIT_MS`) before re-sending. A re-send into the busy session would restart the session under the reply and cut it off: TASK-1127 marks the session, and routing retires a marked session even mid-turn.
      - The `lastUserText` doc (`:91-93`), "a resume that worked only for a grant answered before the turn finished — which is never", becomes "…before the turn finished, which does happen: Connect is live mid-turn (TASK-1150)".
      - The `still-running` doc: "a reply was still being written in that conversation when we stopped waiting; re-sending then would have replaced it, so nothing was sent."
  - **`grant-copy.ts`**, after `GRANT_NOT_RESUMED_ELSEWHERE`:
    ```ts
    /**
     * TASK-1150 — the grant landed while the agent was still writing a reply in
     * that conversation, and it was still going when we stopped waiting
     * (`RESUME_WAIT_MS`). Sending the message again then would have replaced
     * that reply, so we didn't. Same action as `GRANT_NOT_RESUMED`, once the
     * reply is done.
     */
    export const GRANT_NOT_RESUMED_BUSY =
      'Connected. The agent may still be working on a reply, so we didn’t interrupt it. ' +
      'Once it’s done, send it a message and it will carry on with this connection in place.';
    ```
    The doc headed "ONE SENTENCE FOR EVERY `ResumeFailure`" (`:200-212`) gets a sentence naming the two reasons that have their own sentence (`read-only`, `still-running`).
  - **`GrantRow.tsx`:**
    - `stalled` becomes `false | 'here' | 'elsewhere' | 'busy'`, and `'reply-when-done'` maps to `'busy'`.
    - The sentence picks `GRANT_NOT_RESUMED_BUSY` for `'busy'`.
    - The comment at `:307-309`, "The skill is attached and the warm session retired", becomes "The skill is attached, and the session restarts with it (now if idle, at its next turn if a reply is running)".
  - **`WorkspaceShell.tsx` `resumeAfterGrant`:**
    - `if (!result.resumed) return grantResumeFor(result.reason);`
    - Use `routeAgentId(routeNow.current)` instead of `routeAgentId(route)`, and drop `route` from the deps.
    - Its doc gains: a reply still running is followed to its end first, so the answer can land after the person has moved on. That's why it reads where they are now (`routeNow`).

- [ ] **Step 4: Run them, and confirm they pass**

  Re-run Step 2's command. Then:
  - `pnpm --filter @ax/channel-web test`
  - `pnpm --filter @ax/channel-web build` (it type-checks the tests)
  - `pnpm exec eslint packages/channel-web/src`

- [ ] **Step 5: Mutants**

  | Mutant | Killed by |
  |---|---|
  | no wait | W1, W3, W5 |
  | the wait ignores `onError` | W2, which then fails on its test timeout |
  | the wait ignores a rejection | W2b |
  | no abort on the way out | the signal checks in W1 and W3 |
  | re-send at the timeout instead of stopping | W3 |
  | `'still-running'` mapped to `false` | the `grantResumeFor` test |
  | GrantRow ignores `'busy'` | W6 |
  | `route` instead of `routeNow.current` | W7 |

- [ ] **Step 6: Commit** — `[TASK-1150] channel-web: the resume after Connect waits for a reply that is still running`

### Task 5: Comments, docs, changesets and memory [tier: mechanical]

**Files:** listed in the table above. Line numbers have moved since earlier tasks: search for each exact old text.

- [ ] **Step 1: orchestrator.ts comments that Tasks 3–4 make stale**

  (a) The routing's B3 note. Replace the comment lines from "This usually runs between turns, but not always." to "…for the mark.)" with:
  ```ts
              // This usually runs between turns, but not always. A turn routed
              // here while the session still runs another one retires it under
              // that turn: a second tab, or a Slack message after the grace
              // period or the cap already ended its reply. The running turn
              // ends `sandbox-terminated`, and a continuation just stops.
              // channel-web's re-POST after a skill Connect waits for a running
              // reply to end first, and sends nothing if it outlasts the wait
              // (TASK-1150). (The routine-turn and mode-change reasons fire
              // only on an idle session, see above. A routine turn routed into
              // a busy session that's marked still retires it, for the mark.)
  ```
  (b) In `retireOrMarkForSkillGrant`'s header, replace the comment lines from "  //   - the row's `activeReqId` is bound:" to "…supersedes the running turn and gets the skill." with:
  ```ts
    //   - the row's `activeReqId` is bound: the host's durable "a turn may be
    //     running", read the same way by agent:interrupt and the idle reaper.
    //     It is the only signal for a decision continuation, which has no
    //     agent:invoke: channel-web and (TASK-1150) channel-slack bind its
    //     reqId at approve time. A stale binding (a refused turn, TASK-1063)
    //     reads as busy too: that session restarts at its next turn instead of
    //     now, which loses nothing.
    //
    // The routing retires a marked session at its next routed turn even while
    // it is still busy (a second tab, or a Slack message after its reply's
    // grace period or cap). channel-web's re-POST after a skill Connect waits
    // for a running reply to end first (TASK-1150), so it normally meets an
    // idle session.
  ```
  (c) In the flag comment, "A turn routed in while it is still running retires it under that turn (the supersede the web's re-POST relies on), so a spare mark can cost a running turn." becomes "A turn routed in while it is still running retires it under that turn, so a spare mark can cost a running turn." Rewrap only those lines.

- [ ] **Step 2: Slack design §5.6 and §6** (`docs/plans/2026-11-09-channel-slack-design.md`)

  §5.6: the sentence "…so the first words aren't missed." (`:492`) is followed by: "The Allow also binds the continuation's request to the conversation, as the web app's approve does (TASK-1150), so the host sees it running: a skill Allow during it marks the session instead of ending it, the idle reaper holds off, and the 15-minute cap's stop reaches it." Keep the paragraph's 5-space indentation, and rewrap to its width.

  §6: replace the two bullets "**A skill Allow retires the conversation's warm session**…" and "**A skill Allow can still end a woken continuation.**…(follow-up)." (`:775-786`) with:
  ```markdown
  - **A skill Allow retires the conversation's warm session**, as the web
    app's Connect does. Since TASK-1127 it ends the session at once only when
    it's idle. While a turn is running there (a reply, one still starting up
    its sandbox, or a woken continuation), it marks the session instead, as
    `skills:proposed` does: the running reply finishes, and the next message
    restarts the session with the skill.
  - **A woken continuation is bound to its conversation** (TASK-1150). The
    Allow binds its request at approve time, as channel-web's
    `bindContinuationTurn` does, and @ax/conversations clears it when the
    continuation's turn ends. That binding is how the host sees it running: a
    skill Allow marks the session instead of ending it, the idle reaper holds
    off, and the cap's stop reaches it. A wake-up that never runs (refused,
    say) leaves its request bound until the next message or the session's
    end, so the reaper holds that idle session until the runner's own
    15-minute idle floor ends it, and for 15 minutes at most: the host can't
    tell that binding from a running continuation, so past that it reaps the
    session anyway.
  ```

- [ ] **Step 3: Architecture doc** (`docs/plans/2026-05-24-current-architecture.md:232-234`)

  After "…and a per-session idle reaper (graceful cancel → force kill) collects it later." add: "It holds off while the conversation's row binds a request to that session (`active_req_id`), for 15 minutes at most (`reapHoldMaxMs`): a decision continuation runs without an `agent:invoke`, and that binding is how the host sees it (TASK-1150)."

- [ ] **Step 4: Changesets**

  In `.changeset/skill-grant-running-turn.md`: delete " (more on that below)" and the whole paragraph that starts "Two things we haven't fixed yet." Both residuals are fixed here, and the changeset is unreleased. If the file is gone because a release consumed it, skip this.

  Create `.changeset/continuation-cutoff.md`:
  ```markdown
  ---
  '@ax/chat-orchestrator': patch
  '@ax/channel-slack': patch
  '@ax/channel-web': patch
  ---

  A reply the agent is still writing no longer gets cut off by an approval that lands in the middle of it.

  - In the web app, clicking Connect while the agent is still answering now lets that answer finish first. Then your message goes again, with the new connection in place. If the agent is still busy a minute later, we leave it be and tell you to send it a message once it's done.
  - In Slack, the reply the agent writes after you Allow one of its requests is now tracked like any other reply. Allowing a skill while it runs lets it finish (your next message gets the skill), and the 15-minute limit can actually stop it now.
  - A sandbox that's been quiet for five minutes is no longer shut down while the agent is still working on something you approved. That work gets up to 15 more minutes: we can't always tell it apart from a leftover, so we don't wait forever.
  - Deleting a connector still takes its key away right away, even from work like that. Same reason: we'd rather that work's next calls fail than keep a key you deleted. A normal reply that's mid-answer keeps it until it's done, as before.
  - If AX can't read the conversation for a moment while you allow a skill, your next message still gets it.
  ```

- [ ] **Step 5: Memory**

  Run `ctxt=$(scripts/memory-write-target.sh --shard context TASK-1150); mkdir -p "$(dirname "$ctxt")"`. Don't name the variable `path`. Then write:
  ```markdown
  # TASK-1150 — continuations, the idle reaper and the web's resume (context)

  - 2026-11-18 — **Both channels now bind a decision continuation's reqId at approve time.** channel-slack's Allow (`decision-answer.ts` `startBinding`, once `decisions:approve` hands the approval to the agent under the minted id) reads `conversations:get` and calls `conversations:bind-session`, as channel-web's `bindContinuationTurn` does. @ax/conversations compare-clears it on the continuation's own `chat:turn-end`. CORRECTS `context/2026-11-17-TASK-1127.md`, row "The host can't see a decision continuation" ("channel-slack doesn't. `sessionBusy` and the idle reaper are both blind to it"): the grant's busy check, the idle reaper and `agent:interrupt` all see a bound continuation now. Nothing clears a continuation that never starts (a refused wake-up): it stays bound until the next turn binds or the session ends, on both channels.
  - 2026-11-18 — **The idle reaper holds off while the conversation binds a request to the session.** Before it reaps, it reads the row (`conversations:get`, with the conversation and user kept on the session's `WarmEntry`), and re-arms while `activeSessionId` is that session and `activeReqId` is set (log `keepalive_reap_deferred`), for `reapHoldMaxMs` (15 min) in total at most, counted from the first hold and started over only by a turn starting or ending there; past it, it reaps anyway (`keepalive_reap_hold_expired`). A failed read reaps as before (`keepalive_reap_check_failed`). A generation counter drops a reap whose read was overtaken by a turn start. `connectors:deleted` closes the proxy session at once for every session not running a routed turn (reaper armed, grace under way, or the reaper's row read in flight), a running continuation included, and sends an armed one through the same check for the reap. The deleted-connector reap at a turn end is forced (TASK-833's bound). A stale binding holds an idle session until the runner's own 15-minute inbox floor ends it, or the hold's bound does.
  - 2026-11-18 — **The web's resume after Connect waits for a reply that is still running** (`workspace-resume.ts`, `RESUME_WAIT_MS` 60 s, following the detail's `liveReqId` stream). Past the wait it sends nothing, and the row says `GRANT_NOT_RESUMED_BUSY`. CORRECTS `context/2026-11-17-TASK-1127.md`, row 2's "That's how the web's re-POST supersedes a running turn": it no longer does. The routing still retires a busy marked session under a running turn, for a second tab or a Slack message after its reply's grace period or cap.
  - 2026-11-18 — **A skill grant whose row read fails marks the conversation's warm sessions** (those this host opened for that conversation and user), so the next turn restarts with the skill. Before, it did nothing unless a turn was in flight (TASK-1127 review round 2, Minor 1).
  ```

- [ ] **Step 6: Check**

  Run: `scripts/memory-append-check.sh && pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/chat-orchestrator build`

  Expected: everything passes, and the guard reports only additions.

- [ ] **Step 7: Commit** — `[TASK-1150] docs, changesets and memory for continuations that are no longer cut off`

---

## For the PR body

- **No hook-surface change.** One manifest change: channel-slack's `optionalCalls` gains `conversations:bind-session` (pinned in channel-slack's plugin test and in the k8s preset test). No boundary review, since it's an existing hook.
- **Security note:** from Tasks 1, 1b, 2 and 3, in the decisions shard (Task 1b's row corrects Task 1's on the hold and the delete).
- **Residuals:**
  - A stale binding holds an idle session past 5 minutes. Causes: a refused turn, a wake-up that never ran, or a failed compare-clear. The runner's own 15-minute idle floor normally ends it; the host reaps it anyway 15 minutes after its first hold (`reapHoldMaxMs`, Task 1b), and a deleted connector's key is gone from it at the delete.
  - A busy marked session is still retired under a running turn for a second tab, a Slack message after its reply's grace period or cap, or a message during a Slack continuation.
  - Slack's read-then-bind has the same millisecond race as channel-web's.
  - Answering a grant from Today while a later turn runs waits for that turn, then re-sends the last user text.
- **Overlap:** TASK-1135 (built in parallel) touches the same manifest pins and Slack design sections.
- **Optional kind re-check:**
  - **Slack:** Allow a held call 3–4 minutes after its reply ended, and give the continuation enough work to run past the 5-minute mark. Expected: the pod stays up, the host logs `keepalive_reap_deferred`, and the reply finishes.
  - **Web:** click Connect on a skill card while the asking reply is still streaming. Expected: the reply completes, then the message re-sends, with no error card.
