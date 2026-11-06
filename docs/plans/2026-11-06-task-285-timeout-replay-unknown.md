# TASK-285: a host-tool replay that times out says "we cannot tell", not "Nothing was completed" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the host replays an approved call through a `tool:execute:<name>` executor and the hook bus's timeout trips, the row is written abandoned (`failed` + `replay_abandoned_at`) and reads `ABANDONED_RECEIPT`. An executor that throws still reads `FAILED_RECEIPT` ("…Nothing was completed.").

**Architecture:** One classification branch, the first statement of `replayOnApprove`'s `catch` in `packages/decisions/src/replay.ts`. For a non-routine tool, a `PluginError` whose `code` is `'timeout'` returns `{ executed: false, path: null, error: null, outcomeUnknown: true }`. Everything downstream already exists (TASK-1046):

- `settleReplay` routes `outcomeUnknown` to `store.markOutcomeUnknown`.
- `receiptFor` renders that row as `ABANDONED_RECEIPT`.
- channel-web derives its `outcomeUnknown` flag from the same row shape (`routes-workspace.ts:2818`), and its card copy matches the receipt word for word.

So there is no store, migration, receipt-text, hook-signature or channel-web change. Both callers of `settleReplay` get the fix from that one function: the approve route's immediate replay (`plugin.ts:970`) and the sweep's deferred and delivery-fallback replays (`expiry.ts:155`, `:260`).

**Tech Stack:** TypeScript, vitest with real timers, `@ax/core` `HookBus`.

**Spec:** the TASK-285 card on the board. The precedent is `docs/plans/2026-11-05-task-1046-connector-host-replay.md`. Planner decisions are in `.claude/memory/decisions/2026-11-06-TASK-285.md`.

## Premise, measured on base 44b89da80

A throwaway script (outside the tree) drove a real 20 ms bus timeout on `tool:execute:request_capability` through the built `settleReplay`:

- It wrote `markFailed`, and the receipt was `FAILED_RECEIPT`.
- The receipt's second line was the bus message, `service hook 'tool:execute:request_capability' exceeded 20ms`.
- The log line was error-level `decision_replay_failed`, carrying that message and its stack.
- The tool then finished (`landed = 1`) AFTER the receipt was written.

`withTimeout` (`packages/core/src/util/with-timeout.ts`) races the handler and never cancels it. So the premise holds: "Nothing was completed" is said about work that completes.

The card's own pointers have drifted. This is card-only text, so nothing in the repo needs changing for it:

- `DEFAULT_SERVICE_TIMEOUT_MS` is `hook-bus.ts:55`, not `:18`.
- The timeout helper is at `util/with-timeout.ts`.
- The ceiling is set per hook. `request_capability`, the host tool most often held, registers `timeoutMs: 30_000`.

## Global Constraints

- Change `@ax/decisions` only. Add no changeset (card PRs don't).
- A timeout is `err instanceof PluginError && err.code === 'timeout'`, with `PluginError` from `@ax/core`. Outer and nested look the same: `HookBus.call` re-throws a `PluginError` unchanged (`hook-bus.ts:436-437`), so a nested call's timeout reaches the catch with the same code. The bus is the only producer of a `PluginError` with this code (grep).
- The branch applies only when `routineToolKind(decision.call.name) === null`. Routine tools keep their own path.
- Leave `connector-replay.ts` untouched. It already treats every throw as unknown.
- Reuse `ABANDONED_RECEIPT`. Write no new receipt text and no closed code: `replay_error` stays null.
- The log line is exactly `ctx.logger.warn('decision_replay_unknown', { plugin: PLUGIN_NAME, decisionId: decision.id, tool: decision.call.name, reason: 'timeout' })`. Never log the error's message or stack (the TASK-1046 r2 R4 rule). (Review round 1 added a `hook` field, only when `bus.hasService(err.hookName)`; see the shard.)
- Never run a test that asserts a NON-timeout branch under a short bus-wide `defaultServiceTimeoutMs`. That is a hidden deadline that flakes into the timeout branch (`patterns/2026-09-26-TASK-549.md`). Put the short timeout on the one hook meant to time out, with `registerService(…, { timeoutMs: 20 })`, the pattern core's own tests use (`hook-bus.test.ts:282`).
- Use real timers, not `vi.useFakeTimers()`.

## Review Focus

1. **A timeout from a call nested inside the executor** reaches the catch with the same code, and must read "cannot tell". Pinned by Task 1, test 2.
2. **A routine tool that times out** (`callJoined`) must keep the routine path. The unknown branch in `settleReplay` returns before `decisions:settle-routine-call` (`replay.ts:301-313` vs `:320-327`), so taking it would strand the routine authority. Pinned by Task 1, test 4, and its proof is mutant M1.
3. **An executor that throws anything else** still reads `FAILED_RECEIPT`. The bus wraps a raw throw as `PluginError` code `unknown`. Pinned by the existing `settleReplay — failure` test (`replay.test.ts:244`), and its proof is mutant M2.
4. **The bus's message** quotes the model-authored tool name. It must reach neither the log line nor the row. Pinned by Task 1, tests 1 and 3.
5. **The tool finishing after we gave up** must not rewrite the row, because nothing listens for it. The receipt stays "cannot tell". Pinned by the tail of Task 1, test 1.

---

### Task 1: Classify a bus timeout as an unknown outcome [tier: sensitive]

This is sensitive because it changes what a person is told about an approved, possibly irreversible action. Its tests also race a real timer, and a wrong guard would strand a routine authority.

**Files:**
- Modify: `packages/decisions/src/replay.ts`. That means the `@ax/core` import (`:38-44`), the `catch (err)` at `:189`, and the doc comments at `:63-69`, `:138` and `:291`.
- Test: `packages/decisions/src/__tests__/replay.test.ts`. Add `createLogger` to the `@ax/core` import at `:12`. The new `describe` goes right after `settleReplay — failure`, which ends at `:270`.

**Interfaces:**
- Consumes these, all of which exist today: `ReplayOutcome.outcomeUnknown?: true`, `settleReplay`, `replayOnApprove`, `replayContext`, `store.markOutcomeUnknown`, `receiptFor`, `ABANDONED_RECEIPT`, and `routineToolKind`.
- Produces no new exported names.

- [ ] **Step 1: Write the failing tests**

```ts
describe('settleReplay — a host tool call that timed out (TASK-285)', () => {
  const T_DONE = '2026-08-20T09:02:00.000Z';
  /** Claimed on the immediate path: `executed`, flight stamped. */
  const claimed = (): Decision => base({ replayClaimedAt: T0 });

  it('is failed + replayAbandonedAt, reads ABANDONED_RECEIPT, and the tool can still finish afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let late: Promise<unknown> | undefined;
    let landed = 0;
    const bus = new HookBus();
    bus.registerService(
      'tool:execute:request_capability',
      'test',
      () => (late = gate.then(() => { landed += 1; return { ok: true }; })),
      { timeoutMs: 20 },
    );
    const store = createFakeStore();
    const decision = claimed();
    store.rows.set(decision.id, decision);

    const outcome = await settleReplay({
      store, bus, ctx: replayContext(decision), decision, now: () => new Date(T_DONE),
    });

    expect(outcome).toEqual({ executed: false, path: null, error: null, outcomeUnknown: true });
    const row = store.rows.get(decision.id)!;
    expect(row).toMatchObject({
      status: 'failed', replayAbandonedAt: T_DONE, replayError: null, replayedAt: null, resolvedAt: T0,
    });
    const receipt = receiptFor(row)!;
    expect(receipt).toMatchObject({ outcome: 'failed', receipt: ABANDONED_RECEIPT, error: null });
    expect(receipt.receipt).not.toContain('Nothing was completed');

    // The premise, measured: the bus stopped waiting; it did not stop the tool.
    release();
    await late;
    expect(landed).toBe(1);
    expect(store.rows.get(decision.id)).toEqual(row);
  });

  it('a timeout from a call nested inside the executor is unknown too', async () => {
    const bus = new HookBus();
    bus.registerService('test:slow-effect', 'test', () => new Promise<never>(() => {}), { timeoutMs: 20 });
    bus.registerService('tool:execute:request_capability', 'test', (ctx) =>
      bus.call('test:slow-effect', ctx, {}),
    );
    const store = createFakeStore();
    const decision = claimed();
    store.rows.set(decision.id, decision);

    await settleReplay({ store, bus, ctx: replayContext(decision), decision, now: () => new Date(T_DONE) });

    const row = store.rows.get(decision.id)!;
    expect(row).toMatchObject({ status: 'failed', replayAbandonedAt: T_DONE, replayError: null });
    expect(receiptFor(row)!.receipt).toBe(ABANDONED_RECEIPT);
  });

  it('logs decision_replay_unknown with its reason, never the bus message', async () => {
    const lines: Record<string, unknown>[] = [];
    const decision = claimed();
    const ctx = makeAgentContext({
      sessionId: `decision-replay-${decision.id}`,
      agentId: decision.agentId,
      userId: decision.ownerUserId,
      source: 'routine',
      logger: createLogger({
        reqId: 'req-replay',
        writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });
    const bus = new HookBus();
    bus.registerService('tool:execute:request_capability', 'test', () => new Promise<never>(() => {}), {
      timeoutMs: 20,
    });

    await replayOnApprove({ bus, ctx, decision });

    expect(lines.find((l) => l.msg === 'decision_replay_unknown')).toMatchObject({
      level: 'warn',
      plugin: '@ax/decisions',
      decisionId: 'dec_1',
      tool: 'request_capability',
      reason: 'timeout',
    });
    expect(lines.map((l) => l.msg)).not.toContain('decision_replay_failed');
    // HookBus's message reads "service hook 'tool:execute:request_capability' exceeded 20ms".
    expect(JSON.stringify(lines)).not.toContain('exceeded');
  });

  it('a routine tool that times out keeps the routine path, never outcomeUnknown', async () => {
    const decision = base({ call: { id: 'c', name: 'routine_update', input: {} } });
    const bus = new HookBus();
    // callJoined holds the timeout until the handler settles, so this handler must settle.
    bus.registerService(
      'tool:execute:routine_update',
      'test',
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 60)),
      { timeoutMs: 20 },
    );

    const outcome = await replayOnApprove({ bus, ctx: replayContext(decision), decision });

    expect(outcome.outcomeUnknown).toBeUndefined();
    expect(outcome).toMatchObject({ executed: false, path: null, failureCode: 'unavailable' });
  });
});
```

Do not add a `store.takeApproval(…)` "the yes is spent" assertion. The fake store's `takeApproval` also requires `replayClaimedAt === null` (`fake-store.ts:466`), so on a claimed row it returns null whatever the status, and the assertion proves nothing. The `status: 'failed'` assertion is what pins it.

- [ ] **Step 2: Run the tests and confirm they fail.** This is the card's vacuity check, so record the result in the decisions shard.

Run: `pnpm --filter @ax/decisions exec vitest run src/__tests__/replay.test.ts`

Expected:
- Tests 1–3 FAIL. Test 1's `outcome.error` is the bus message. Test 2's `replayAbandonedAt` is null and its receipt is `FAILED_RECEIPT`. Test 3 has no `decision_replay_unknown` line and does contain `exceeded`.
- Test 4 PASSES. It pins today's routine behavior; mutant M1 in Step 5 is its proof.
- Every pre-existing test passes.

- [ ] **Step 3: Implement**

In `replay.ts`:

1. Add `PluginError` to the `@ax/core` import.
2. Make this the FIRST statement inside `replayOnApprove`'s `catch (err)`, ahead of the `pendingEffect` line:

```ts
if (routineToolKind(decision.call.name) === null && err instanceof PluginError && err.code === 'timeout') {
  ctx.logger.warn('decision_replay_unknown', {
    plugin: PLUGIN_NAME,
    decisionId: decision.id,
    tool: decision.call.name,
    reason: 'timeout',
  });
  return { executed: false, path: null, error: null, outcomeUnknown: true };
}
```

3. Put a short comment above it, in the house voice. It must cover these five points:
   - The bus stopped waiting but did not stop the tool, so the work may still land. "Nothing was completed" would be the lie TASK-253 removed for crashes.
   - It catches an outer or a nested timeout, because the bus re-throws a `PluginError` unchanged.
   - Routine tools are excluded. `callJoined` waits for the effect to settle, then `settleReplay` reads the durable `routineOutcome`. This branch would also skip `decisions:settle-routine-call`.
   - The message is never logged, because it quotes the model-authored tool name.
   - `invalid-return` is not handled here. No `tool:execute:*` registers `returns`, and an executor that returned did not time out.

Three doc fixes in the same file:

- **`ReplayOutcome.outcomeUnknown` (`:65-66`).** After "came back unreadable" add: `; TASK-285: a host tool whose bus call timed out, its own or one nested inside it, while the tool may still be running`.
- **`replayOnApprove` doc (`:138`).** It becomes: "Every outcome — ran, could not run, tried and failed, or ran out of time — comes back as a value".
- **`settleReplay` comment (`:291`).** It becomes: "TASK-1046 / TASK-285 — sent, with no reliable answer: a connector call, or a host tool call the bus stopped waiting on." Keep the rest of the comment.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @ax/decisions exec vitest run src/__tests__/replay.test.ts src/__tests__/receipts.test.ts src/__tests__/connector-replay.test.ts`
Expected: all pass. The base was 93 across these three files; it should now be 97.

Run: `pnpm --filter @ax/decisions build`
Expected: exit 0. Note that `tsc` excludes `__tests__`, so this checks `replay.ts` only.

- [ ] **Step 5: Commit, then run the mutants**

Commit message: `[TASK-285] A host tool replay that times out reads "we cannot tell", not "Nothing was completed"`

Run three mutants. Apply each one, run the Step 4 vitest command, then restore with `git checkout HEAD -- packages/decisions/src/replay.ts`. Check that `git status` is clean before the next one.

| Mutant | Change | Expected |
|---|---|---|
| M1 | Delete `routineToolKind(decision.call.name) === null &&` | test 4 red |
| M2 | Delete `&& err.code === 'timeout'` | `settleReplay — failure` (`:244`) red, plus the two `replayOnApprove — failure is recorded` cases |
| M3 | Delete the whole new `if` block | tests 1–3 red (the card's "revert" check, after implementation) |

Append the measured red counts to the decisions shard.

---

### Task 2: Fix the prose that says only a crash or a connector call ends up abandoned [tier: mechanical]

These edits touch comments only. The replacement text is given verbatim, so apply it as written. Line numbers are from base 44b89da80.

**Files:**
- Modify: `packages/decisions/src/types.ts`, `store.ts`, `receipts.ts`, `templates.ts`, `expiry.ts`

**Interfaces:** none.

- [ ] **Step 1: Apply the seven replacements**

1. **`types.ts:86-93` (the `failed` paragraph of the `DECISION_STATUSES` doc).** Replace the whole paragraph, from "`failed` means" to "(or may not have).", with:
   ```
    * `failed` means the host tried the replay and the tool threw (anything but
    * a timeout); or the host has no report of how the call ended
    * (`replayAbandonedAt`; the receipt then says it cannot tell): the bus stopped
    * waiting on a host tool that may still be running (TASK-285), a connector
    * call got no reliable answer, or the host died mid-flight and the sweep gave
    * up on it; or the connector's service answered that it did not work, so the
    * tool may have run (abandoned too, with `TOOL_ERROR_REPLAY_CODE`; the receipt
    * says it may have done part of it). When it threw, nothing was completed. In
    * every case the standing authorisation is gone, and the agent must raise the
    * call again rather than silently inheriting a yes for an action that did not
    * happen (or may not have).
   ```
2. **`types.ts:306-309` (`Decision.replayAbandonedAt`; the sentence starts with the "And" at the end of `:306`).**
   - Replace: "And `markOutcomeUnknown` (TASK-1046): a host connector call that went out and got no reliable answer — a timeout, a dropped connection, a reply it could not read."
   - With: "And `markOutcomeUnknown`: a host connector call that went out and got no reliable answer — a timeout, a dropped connection, a reply it could not read (TASK-1046) — or a host tool call the bus stopped waiting on, which may still be running (TASK-285)."
3. **`store.ts:333` (`markFailed` doc).**
   - Replace: "The host replay threw."
   - With: "The host replay threw (anything but a timeout: a call the bus stopped waiting on may still land, so it goes to `markOutcomeUnknown`, TASK-285)."
4. **`store.ts:344-346` (`markOutcomeUnknown` doc).**
   - Replace: "The host SENT the call and got no reliable answer (TASK-1046): a connector call that timed out, lost its connection, or came back unreadable. It may or may not have happened."
   - With: "The host SENT the call and got no reliable answer: a connector call that timed out, lost its connection, or came back unreadable (TASK-1046), or a host tool call the bus stopped waiting on (TASK-285; the bus's timeout does not stop the tool). It may or may not have happened."
5. **`receipts.ts:169-171`.**
   - Replace: "Since TASK-1046 the same applies to a host connector call: it was sent and no reliable answer came back (a timeout, a dropped connection), so it is recorded as abandoned and reads as "cannot tell"."
   - With: "Since TASK-1046 the same applies to a host connector call that was sent and got no reliable answer back (a timeout, a dropped connection), and since TASK-285 to a host tool call the bus stopped waiting on, which may still finish: both are recorded as abandoned and read as "cannot tell"."
6. **`templates.ts:370-371` (the first sentence of the `ABANDONED_RECEIPT` doc).**
   - Replace: "The receipt when the host TOOK the call and never came back — it died with the replay in flight, and a later sweep reclaimed the row (TASK-253)."
   - With: "The receipt when the host TOOK the call and has no report of how it ended: it died with the replay in flight and a later sweep reclaimed the row (TASK-253), a connector call it sent got no reliable answer (TASK-1046), or the bus stopped waiting on a host tool that may still be running (TASK-285)."
7. **`expiry.ts:52-53` (the stale line: the `STRANDED_REPLAY_TIMEOUT_MS` derivation).**
   - Replace: "`DEFAULT_SERVICE_TIMEOUT_MS`, 120 s, which nothing in this repo overrides for a tool executor."
   - With: "`DEFAULT_SERVICE_TIMEOUT_MS`, 120 s. A tool executor may register its own `timeoutMs`; none in this repo registers a longer one (several register shorter ones), and one that did would break this derivation."

Re-wrap each block to the file's existing width. Change nothing else.

- [ ] **Step 2: Verify that only comment lines changed**

Run: `git diff -U0 -- packages/decisions/src | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | grep -vE '^[+-]\s*(\*|//|/\*)'`
Expected: no output.

Run: `pnpm --filter @ax/decisions build`
Expected: exit 0.

- [ ] **Step 3: Commit**

Commit message: `[TASK-285] Say where an abandoned row comes from now, and fix the stale 120 s claim in the stranded-flight derivation`

---

## Final verification (whole branch)

- `pnpm --filter @ax/decisions build`
- `pnpm --filter @ax/decisions test`, with `DOCKER_HOST` set. The `store`, `canary`, `routine-authorization` and `agents-deleted` tests start Postgres.
- `pnpm exec eslint packages/decisions/src`
- The repo-wide gate from CLAUDE.md: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`

## Deliberately not in this plan

- **Recording the late result after a timeout.** The bus discards it. Seeing it would need a core API change, and waiting longer would hold the approve request open. "Cannot tell" is the honest ceiling.
- **Its own receipt sentence for a timeout.** TASK-1046 already renders a connector-call timeout as `ABANDONED_RECEIPT`, and channel-web's card says the same words. A second sentence would describe one event two ways and need a closed code, a derived flag and new card copy across two packages.
- **`invalid-return`, routine kinds, and the connector path.** See the Global Constraints and the decisions shard.
- **TASK-286's undo race.** That is a separate card, and it dispatches after this one merges.
- **Security checklist: not required.** There is no sandbox, IPC, plugin-loading or dependency change. The one content-handling change removes a tool-error message from a log line and from the row.
- **Boundary review: not required.** No hook signature or payload changes, and `decisions:approve`'s `error` is already nullable.
