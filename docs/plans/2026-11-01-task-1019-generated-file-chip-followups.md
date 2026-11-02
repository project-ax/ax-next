# TASK-1019 Generated-file chip follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn that fails rechecks its agent-file chips, so a file the agent deleted reads "No longer available" without waiting for the next turn to land. The comments and design doc stop describing the held-approval path as reachable, because no shipped configuration can reach it.

**Architecture:** The UI part is one new counter in `AgentView`. `onError` bumps it, and the chip recheck key adds it to the existing durable-read count. Nothing else changes, because a landed turn and a stopped turn already re-read. The rest is a docs/comments pass plus one tool-policy test line that pins the fact this plan rests on (`artifact_publish` is not a setting anyone can change). It points at the decisions shard, so whoever changes that rule finds the dormant held path and its known gaps.

**Tech Stack:** TypeScript, React + vitest + Testing Library (channel-web), vitest (tool-policy).

**Spec:** card TASK-1019; `docs/plans/2026-10-29-agent-files-simplification-design.md` §12 (the TASK-1012 and TASK-1017 as-built entries); decisions `.claude/memory/decisions/2026-11-01-TASK-1012.md`, `.claude/memory/decisions/2026-11-01-TASK-1017.md`, `.claude/memory/decisions/2026-11-01-TASK-1019.md`.

## What the code says (verified 2026-11-01 at f95683dbc)

**The card's premise does not hold for items 1, 2, 3 and 5.** In every shipped configuration, the automatic-attach gate call (`run-runner.ts:1343-1349`) can only come back `allow`, or fail closed. Here is why:

- `@ax/tool-policy`'s rule for `artifact_publish` is `artifacts.publish`, and its verdict is `allow` (`packages/tool-policy/src/rules.ts:296-304`).
- A per-agent stored verdict is consulted only for `isOverridableKey` tools (`plugin.ts:714-717`). Those are `ABILITY_TOOLS`, which is `['web_search', 'web_extract', 'Bash']` (`verdicts.ts:74`), plus `mcp.*` keys. channel-web's abilities are the same three (`webSearch` / `readPages` / `runCode`, `lib/workspace-types.ts:1015`, `server/routes-workspace.ts:1441-1445`). No person and no admin can set "publish a file for you to open" to Ask first or Never.
- The rule table option is "Tests only — production uses BUILTIN_RULES" (`plugin.ts:236`), and `presets/k8s/src/index.ts:1106-1110` passes no rules.
- `@ax/decisions` holds a call only on a policy `hold` (`pre-call.ts:229-245`). The other `tool:pre-call` subscribers are `agent-activity` (observe only) and `routines` (routine tools only).

So the held path is dormant. The runner's `resolveHeld`, its held map, the HELD note and the approved/declined model notes (TASK-1017) are reached only by test fakes. TASK-1012's reason for keeping the gate ("a person who set the agent's 'publish a file for you to open' to ask/never") was never true.

Here is each item:

1. **Cold-session approval — dropped.** No automatic attach is ever held, so nothing is ever approved cold. The design for this, if publishing becomes a setting, is in the TASK-1019 decisions shard (a read-only `tool.held-calls` IPC action backed by a `decisions:held-for-conversation` hook).
2. **N held files, N cards — dropped**, for the same reason. The shard records the design: one gate call per batch of ≤32 files, with input `{files: [keys]}`.
3. **Declined copy — dropped.** A person declining a card never sees "attach them again". The runner adds no note on a dismissal, and the card's receipt reads "You turned this down. It did not publish a file for you to open, and nothing ran." (`decisions/src/templates.ts:306-309`). The only `denied` that can happen is a gate that failed closed: `tool-policy:evaluate` throws, `@ax/decisions` answers `GATE_FAILURE_SENTENCE`, and the runner maps that to `denied`. For that failure, "Ask the agent to attach them again" is the right advice.
4. **Failed turns never recheck — confirmed, fixed below.** `onError` (`AgentView.tsx:925-957`) re-reads nothing. The shell's `version` moves only through `onChanged` (`WorkspaceShell.tsx:1071-1074`), so `threadReads` stays where it was. A *stopped* turn already re-reads: through `onDone` (`:896-923`), or through the stop fallback's `load()` (`:1053-1062`). Keying on `turnsEnded` (done + failed) would recheck every landed turn twice, and it would break the pinned test "checks once on mount and once when the turn lands, not while it streams" (`__tests__/AgentView.test.tsx:1727-1766`).
5. **Model-free approval turn — not worth it (moot).** Nothing is ever held. If it is ever revived, the SSE stream needs fixing first. The reason is in the shard: a turn-end emitted within milliseconds of the delivery would usually reach the host before the continuation stream attaches, and "Thinking…" would never clear.

## Global Constraints

- No hook, IPC, schema or dependency change. Boundary review: N/A, and the PR body says so.
- `security-checklist`: not required. Task 1 only changes *when* the browser re-asks an existing metadata route (same ACL, reads no bytes, no new data). Task 2 is comments, docs and test data. The PR body says so.
- The two existing chip tests in `AgentView.test.tsx` ("checks once on mount and once when the turn lands…" and "rechecks after a landed turn even when the re-read keeps the thread length") stay **unchanged** and green.
- Sibling TASK-1016 is editing channel-web's download code. The only line this plan touches near it is the one-line `recheckKey` prop doc in `GeneratedFileChip.tsx`. If it conflicts on rebase, keep both edits.
- Per-package tests: `pnpm --filter <pkg> test` (the filter goes before the script). channel-web's `tsc` includes its tests: `pnpm --filter @ax/channel-web exec tsc --noEmit -p .`. The full gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Handoff (builder → auto-ship): return the follow-up and learning in "Out of scope" below. Do not write the board.

## Review Focus

1. **A turn fails after the agent deleted a file.** The chip says "No longer available" with no thread re-read. Pinned by Task 1's new test.
2. **A turn lands.** Each chip still checks exactly once more, not twice. Pinned by the two existing tests staying unchanged.
3. **The recheck after a failed turn gets a 503 or a network error.** The chip stays downloadable. This is already pinned by `GeneratedFileChip.test.tsx` ("a status that is not 404 or 400 leaves the chip downloadable"). Task 1 adds nothing there.
4. **A past (read-only) conversation is open.** Its key stays `pastThread.length`, and a failure in the live thread does not touch it. Task 1 keeps the `past ? … :` branch as it is.
5. **Someone later makes publishing an ability.** Holds become real, and so do the cold-approval and one-card-per-file gaps. Pinned by Task 2's tool-policy test, whose comment points at the shard.

---

### Task 1: A failed turn rechecks its chips `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentView.tsx` (state beside `threadReads` at :669-677; `onError` at :925-931; the `fileRecheckKey` prop and its comment at :1815-1821)
- Modify (comments only): `packages/channel-web/src/components/workspace/AgentConversation.tsx:341-353` (`Props.fileRecheckKey`) and `:1065-1069`; `packages/channel-web/src/components/workspace/GeneratedFileChip.tsx:32`
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentView.test.tsx`, in `describe('file chip status checks')` (:1724)

**Interfaces:**
- Produces: `fileRecheckKey={past ? pastThread.length : threadReads + failedTurns}`. Both counters only ever go up by one, so the sum moves whenever either does.

- [ ] **Step 1: Write the failing test**, inside `describe('file chip status checks', …)`. Copy the harness of the test at :1727.

```tsx
it('rechecks when a turn fails, without re-reading the thread', async () => {
  const agentFile = {
    attachmentId: null, agentFilePath: 'plan.pdf', displayName: 'plan.pdf', mediaType: 'application/pdf', sizeBytes: 10,
  };
  // Still there when the chip mounts; gone by the time the failed turn ends.
  const statusChecks = vi.fn(async (url: string): Promise<Response> => {
    if (!url.includes('/status/user-files/')) throw new Error(`unexpected fetch ${url}`);
    return statusChecks.mock.calls.length === 1
      ? new Response(JSON.stringify({ available: true }), { headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: 'file-not-found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', statusChecks);
  const reply = { kind: 'agent' as const, id: 't1', text: 'Here is the plan.', at: '', attachments: [agentFile] };
  agentMock.mockResolvedValue(detail({ thread: [reply] }));
  sendMock.mockResolvedValue({ conversationId: 'c-now', reqId: 'r1' } as never);
  let handlers: Parameters<typeof workspaceApi.streamReply>[1] | null = null;
  let finish: () => void = () => {};
  streamMock.mockImplementation(async (_reqId, h) => {
    handlers = h;
    await new Promise<void>((resolve) => { finish = resolve; });
  });

  renderView();
  await waitFor(() => expect(statusChecks).toHaveBeenCalledOnce());
  const reads = agentMock.mock.calls.length;

  const box = await screen.findByPlaceholderText('Message Quill');
  fireEvent.change(box, { target: { value: 'Delete it.' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(handlers).not.toBeNull());
  await act(async () => { handlers!.onError('The runner went away.'); finish(); });

  await waitFor(() => expect(statusChecks).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('No longer available')).toBeTruthy();
  // A failed turn re-reads nothing: the recheck came from the turn ending.
  expect(agentMock.mock.calls.length).toBe(reads);
});
```

- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- AgentView`. Expected: the new test FAILS. `statusChecks` stays at 1 call, because `onError` never moves the key.

- [ ] **Step 3: Implement** in `AgentView.tsx`:
  - Add `const [failedTurns, setFailedTurns] = useState(0);` beside `threadReads`. Extend the comment at :669-677 to say what it does. A failed turn ends with no durable re-read: `onError` keeps the thread as it was, so Resend works. The agent may have deleted a file before the turn broke, so a failure moves the chip key too. A landed or stopped turn is not counted, because its re-read already moves `threadReads`, and counting both would check twice per turn (TASK-1019).
  - In `onError`, add `setFailedTurns((n) => n + 1);` next to `setTurnsEnded((n) => n + 1);`.
  - Pass `fileRecheckKey={past ? pastThread.length : threadReads + failedTurns}`. Update the comment above it at :1815-1820 to say "each successful durable read, and each turn that failed".
  - Fix the stale docs, which say only landed turns or durable reads move the key. In `AgentConversation.tsx:342-349`, `AgentView` passes "a count of successful DURABLE thread reads, plus one for each turn that failed (a failure re-reads nothing)". In `:1065-1068`, "…once that turn has ended, landed or failed". In `GeneratedFileChip.tsx:32`, use `/** Changes when the thread is re-read or a turn fails, so an agent-file chip checks its file again. */`.

- [ ] **Step 4: Run** `pnpm --filter @ax/channel-web test -- AgentView GeneratedFileChip`, then `pnpm --filter @ax/channel-web exec tsc --noEmit -p .`. Expected: PASS, with both existing chip tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/workspace/AgentView.tsx packages/channel-web/src/components/workspace/AgentConversation.tsx packages/channel-web/src/components/workspace/GeneratedFileChip.tsx packages/channel-web/src/components/workspace/__tests__/AgentView.test.tsx
git commit -m "[TASK-1019] File chips recheck after a turn that fails, not only after a re-read"
```

---

### Task 2: Say the held-approval path is dormant, and pin why `[tier: mechanical]`

**Files:**
- Modify: `packages/tool-policy/src/__tests__/verdicts.test.ts:201-214`
- Modify (comments only): `packages/agent-runner-core/src/run-runner.ts:1324-1332` and `:1066-1067`; `packages/agent-runner-core/src/generated-files.ts:225-226`
- Modify: `docs/plans/2026-10-29-agent-files-simplification-design.md` §12 (:394, and a new paragraph after :416)

**Interfaces:** none. No code behaviour changes.

- [ ] **Step 1: Pin the premise.** In `it('refuses every static rule a person must not be able to touch — cannot loosen WebFetch', …)`, add `'artifact_publish'` to the list with this comment above it:

```ts
      // TASK-1019: publishing is not a setting. While this holds, the runner's
      // held automatic-attach path (agent-runner-core generated-files.ts,
      // TASK-1017) is dormant. Making publishing an ability makes it live, along
      // with two gaps it still has: approving after the session went cold attaches
      // nothing, and N new files raise N cards. Their design is in
      // .claude/memory/decisions/2026-11-01-TASK-1019.md.
      'artifact_publish',
```

  Run `pnpm --filter @ax/tool-policy test -- verdicts`. Expected: PASS. It already holds. It is a tripwire, not a fix.

- [ ] **Step 2: Fix the stale "person's setting" comment** at `run-runner.ts:1324-1332`. Replace that paragraph with:

```ts
  // Each chip still goes through the policy gate a model's own artifact_publish
  // call gets, so an automatic chip is allowed exactly when an explicit publish
  // would be. Today that gate can only allow or fail closed: `@ax/tool-policy`'s
  // `artifacts.publish` rule is `allow`, and publishing is not one of the
  // abilities a person can switch (TASK-1019). The held branch is kept so the
  // gate means the same if that rule ever changes: a held call is attached only
  // after the person approves it AND the gate itself then allows the identical
  // call, which the runner re-sends when it pulls the approval, ahead of the
  // turn that answer opens (TASK-1017, see `nextMessage`). A refused call
  // attaches nothing. The gate's `updatedInput` is ignored on purpose: a
  // reference names the file the turn created, never a substitute.
```

  In the `decision-resolved` comment, right after "…an automatic attach of a new file." (:1066-1067), insert: `Dormant today: no shipped rule holds artifact_publish (TASK-1019), so this branch runs only if that rule changes.`. In `generated-files.ts`, append to the `trackGeneratedFiles` doc (:225-226): `Dormant today (TASK-1019): @ax/tool-policy's artifacts.publish rule is allow and is not a setting anyone can change, so in production the gate allows or fails closed, and the held path runs only in tests or if that rule changes.`

- [ ] **Step 3: Design doc §12.** In the TASK-1017 bullet (:394), insert `(Dormant in every shipped configuration; see TASK-1019 below.)` right after `**As built (TASK-1017):**`. After the bullet's last line (:416, "…keeps refusing `:`."), add:

```markdown
- **As built (TASK-1019):** the automatic-attach gate can only allow or fail
  closed in every shipped configuration. `@ax/tool-policy`'s
  `artifacts.publish` rule is `allow`. Publishing is not one of the abilities a
  person can switch (`ABILITY_TOOLS`: `web_search`, `web_extract`, `Bash`), and
  production always loads the built-in rule table. So the TASK-1017
  held-approval path, and its cold-session residual, are dormant. They run only
  in tests or if that rule changes. A denied automatic attach is a gate that
  failed closed, and "Ask the agent to attach them again" is the right advice
  there. Chips now also recheck their file after a turn that fails, which
  re-reads nothing.
```

- [ ] **Step 4: Run** `pnpm --filter @ax/tool-policy test` and `pnpm --filter @ax/agent-runner-core exec tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-policy/src/__tests__/verdicts.test.ts packages/agent-runner-core/src/run-runner.ts packages/agent-runner-core/src/generated-files.ts docs/plans/2026-10-29-agent-files-simplification-design.md
git commit -m "[TASK-1019] Say the held auto-attach path is dormant: publishing is not a setting"
```

---

## Out of scope (return in the handoff; auto-ship files the cards)

- **Follow-up (a decision for Vinay):** should "publish a file for you to open" become a person-settable ability (Ask first / Never)? If yes, file a card. It would add `artifact_publish` to `ABILITY_TOOLS` and the channel-web abilities, then build TASK-1019's planned design (shard row 3): one card per batch of ≤32 files, and boot-time adoption through `tool.held-calls`. If no, consider removing TASK-1017's dormant held-approval code (`resolveHeld`, the held map, the HELD and approved/declined notes, and their tests).
- **Learning:** in production, `artifact_publish` is always `allow` and no setting can change it. Any "held auto-attach" work is moot until it becomes an ability. TASK-1012's decisions row saying a person can set it to ask/never is false.
