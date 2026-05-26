# Phase 7 Implementation Plan — kernel & protocol cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Final tidy-up of the kernel and wire protocol after the Phase 6 plugin deletion. Three sub-slices: (A) drop the `@ax/audit-log` subscription on `chat:end` so the plugin observes only `event.http-egress`; (B) narrow `AgentMessage.role` from `'user' | 'assistant' | 'system'` to `'user' | 'assistant'`; (C) delete kernel-type and IPC-protocol orphans that survived Phase 6 (`LlmRequest`, `LlmResponse`, `LlmCallRequestSchema`, `LlmCallResponseSchema`).

**Architecture:** Phase 7 is pure deletion + one subscription change. No new hooks, no new packages, no new IPC actions. Each slice lands as 1–2 bisect-friendly commits inside one PR. The PR is small enough (~300 LOC delta) that splitting into three PRs would be more ceremony than the diff justifies, but the slice ordering (A → B → C) keeps each commit independently revertable if anything goes sideways.

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- pnpm workspace + tsconfig refs
- No new dependencies; no IPC schema additions

---

## Out-of-scope (deferred)

- **`@ax/agent-runner-core` merge into `@ax/agent-claude-sdk-runner`.** Separate slice. The SDK runner still imports `IpcClient`, `DiffAccumulator`, `createDiffAccumulator`, `SessionInvalidError`, and `toWireChanges` from runner-core. Phase 5/6/7 all defer this.
- **`@ax/tool-dispatcher` merge into `@ax/mcp-client`.** Separate slice. The catalog's `tool:register` / `tool:list` registrations still serve `@ax/mcp-client`'s tool registration pathway.
- **Deletion of `ToolCall`, `ToolDescriptor`, `ToolPreCall*`, `ToolExecuteHost*`.** The pre-execution survey confirms these are load-bearing at HEAD (see Reality check below). Phase 7 explicitly does NOT delete them. Future cleanup, when the host MCP server's tool envelope and `tool:pre-call` payload type are also retired, can revisit.
- **Collapsing `cfg.sandbox` and `cfg.storage` single-value enums.** Phase 6 noted these as candidates; out of scope here. They're config-shape cleanup, not kernel/protocol cleanup.
- **README narrative rewrite.** Phase 7 updates the stale `chat:end`/`llm:call`/`LlmRequest` examples and the audit-log subscription line. A wider docs sweep (the prose around `chat:start → llm:pre-call → llm:call`) is a separate writing pass — Phase 7 only fixes the lines whose code references stop being valid.
- **`landing/install.html` stale prose.** Same logic — public-facing docs sweep is a separate task.

---

## Reality check — design candidates vs. HEAD

Memory `feedback_check_plan_vs_reality.md`: the design doc's deletion list (Section 5) names types that are STILL LOAD-BEARING at HEAD. Phase 7 does NOT silently skip — it documents the deviation and ships only the truly orphaned cuts.

| Design doc says delete | HEAD reality | Phase 7 verdict |
|---|---|---|
| `ChatMessage` from `@ax/core` | **Already deleted.** Zero hits in production code. | Confirm via grep; no work. |
| `LlmRequest` from `@ax/core` (`packages/core/src/types.ts:20`) | **Truly orphaned.** Only refs are `__tests__/types.test.ts:7` (existence-assert) + README example. | **DELETE.** |
| `LlmResponse` from `@ax/core` (`packages/core/src/types.ts:25`) | **Truly orphaned.** Same as above. | **DELETE.** |
| `LlmCallRequestSchema` / `LlmCallResponseSchema` from `@ax/ipc-protocol` (`actions.ts:66, 75`) | **Orphaned at HEAD.** No IPC handler in `packages/ipc-core/src/handlers/` registers `llm.call`; `@ax/ipc-server`'s plugin manifest declares `calls: ['session:resolve-token', 'session:claim-work', 'tool:list']` — no `llm:call`. Phase 6 retired the host-side `llm:call` plugin path. | **DELETE.** Tests in `packages/ipc-protocol/src/__tests__/schemas.test.ts:37-65` (the `describe('llm.call')` block) delete with the schemas. |
| `ToolCall` from `@ax/core` (`types.ts:8`) | **LOAD-BEARING.** Bus payload type for `tool:pre-call` (`packages/ipc-core/src/handlers/tool-pre-call.ts:35`, `packages/cli/src/__tests__/{chat-pipeline,mcp-stdio}.e2e.test.ts`), and `LocalToolExecutor` type in `packages/agent-runner-core/src/local-dispatcher.ts:1`. | **KEEP.** Document in survey. |
| `ToolDescriptor` from `@ax/core` (`types.ts:30`) | **LOAD-BEARING.** Used by the host MCP server (`packages/agent-claude-sdk-runner/src/host-mcp-server.ts:33, 41, 105`) and the tool-dispatcher catalog (`packages/tool-dispatcher/src/{plugin,catalog,scope}.ts`). | **KEEP.** |
| `ToolPreCallRequest/Response` from `@ax/ipc-protocol` (`actions.ts:92, 97`) | **LOAD-BEARING.** Wire schema for the `tool.pre-call` IPC action; consumed by `packages/ipc-core/src/handlers/tool-pre-call.ts` and `packages/agent-runner-core/src/ipc-client.ts:11, 70`. | **KEEP.** |
| `ToolExecuteHostRequest/Response` from `@ax/ipc-protocol` (`actions.ts:116, 121`) | **LOAD-BEARING.** Wire schema for the `tool.execute-host` IPC action; consumed by `packages/ipc-core/src/handlers/tool-execute-host.ts` and the SDK runner's host MCP server (`host-mcp-server.ts:32`, `packages/agent-runner-core/src/ipc-client.ts:9, 71`). Phase 6 carve-out called this out explicitly. | **KEEP.** |
| `AgentMessage.role: 'system'` | **NOT consumed in production.** Production grep for `role: ['"]system['"]` returns only `packages/core/src/__tests__/types.test.ts:12` (existence-assert) and a `ConversationFetchHistoryTurn` test (`role: 'system'` on `ConversationFetchHistoryTurnSchema`, which has `tool` too — different schema, different roles). The conversations/channel-web `userId: 'system'` matches are an unrelated `userId` field. | **NARROW.** |
| `@ax/audit-log` subscribes to BOTH `chat:end` AND `event.http-egress` | **Confirmed.** `packages/audit-log/src/plugin.ts:38-55` (chat:end) and `:65-89` (http-egress). Row keys differ (`chat:${reqId}` vs. `egress:${scope}:${ts}:${uuid}`); no row-continuity migration needed. | **DROP `chat:end`.** |
| `@ax/ipc-server` drops deleted IPC actions | **Nothing to drop in `@ax/ipc-server`.** The plugin only registers `ipc:start` / `ipc:stop` services. The IPC action handlers live in `@ax/ipc-core/src/handlers/`, and there is no `llm-call.ts` handler at HEAD — Phase 6 already retired it. The remaining schemas `LlmCallRequest/Response` are deleted as part of Slice C. | **VERIFY no work; document in survey.** |

The pattern is exactly what Phase 6's carve-out predicted (line 21: "Some are still used by `@ax/agent-claude-sdk-runner` … Phase 7 audits which are truly orphaned"). Slice C cuts the actual orphans; the rest stays.

---

## Slicing decision: one PR, three slices

The user's brief asked us to decide between one bundled PR or three small ones. Recommend **one PR with three slice-commits (plus survey + final-verification commits)** for these reasons:

- **Each slice is small.** Slice A is a single-file deletion of a subscriber block (~20 LOC). Slice B touches ~10 sites mechanically. Slice C deletes ~70 LOC across 4 files. Three PRs would be more ceremony than content.
- **Shared theme.** All three are kernel/protocol cleanup. One reviewer pass, one CI run, one set of acceptance criteria.
- **Bisect-friendly anyway.** Each slice is its own commit (or commit-pair, when a deletion follows a consumer cleanup). If a slice breaks, `git revert <slice-commit>` rolls back exactly that slice.
- **Phase pattern matches Phase 6 PR-A.** Phase 6 bundled 8 package deletions with commit pairs in one PR; reviewer was happy with that shape and the bisect story.

If during execution any slice surfaces unexpected churn (e.g., `AgentMessage` role narrowing reveals a third-party consumer in `landing/`), surface it — don't silently expand scope. Memory `feedback_targeted_followup_commits.md` says targeted follow-up commits beat amends; same principle applies here.

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Why |
|---|---|
| `packages/audit-log/src/plugin.ts` | Slice A. Delete the `chat:end` subscriber block (lines ~38-55). Keep the `event.http-egress` subscriber. |
| `packages/audit-log/src/__tests__/audit-log.test.ts` (or current name) | Slice A. Drop tests that assert `chat:end` rows; keep tests for `event.http-egress` rows. |
| `packages/audit-log/package.json` (manifest if it exists) | Slice A. Update plugin manifest's `subscribes:` to `['event.http-egress']` only. |
| `packages/core/src/types.ts:3-6` | Slice B. Narrow `AgentMessage.role` from 3 → 2 enum values. |
| `packages/core/src/types.ts:20-28` | Slice C. Delete `LlmRequest` and `LlmResponse` interfaces. |
| `packages/core/src/__tests__/types.test.ts` | Slices B + C. Delete the `system` role assertion (Slice B) and the `LlmRequest/LlmResponse` existence assertion (Slice C, line ~7). |
| `packages/ipc-protocol/src/actions.ts:20-23` | Slice B. Narrow `AgentMessageSchema` enum from 3 → 2 values. |
| `packages/ipc-protocol/src/actions.ts:57-86` | Slice C. Delete the `LlmCallRequestSchema` / `LlmCallResponseSchema` block. Keep the `Shared shapes` block above and the `tool.pre-call` block below. |
| `packages/ipc-protocol/src/__tests__/schemas.test.ts:3-4, 37-65` | Slice C. Delete the `LlmCallRequestSchema`/`LlmCallResponseSchema` imports and the `describe('llm.call', …)` block. |
| `packages/conversations/src/plugin.ts:99` (and similar) | Slice B. The `userId: 'system'` matches are NOT `role: 'system'` — verify in the survey, no edit needed. |
| `README.md:13-25, 56, 68-95, 146-153` | Slices A + C. Drop the stale `LlmRequest`/`LlmResponse` example (Slice C). Update the audit-log line from `subscribes to chat:end` to `subscribes to event.http-egress` (Slice A). The wider `chat:start → llm:pre-call → llm:call` prose stays for the readme-rewrite slice (out of scope). |
| `packages/agent-claude-sdk-runner/src/main.ts:208` | Slice B verification. `chatEndHistory: AgentMessage[]` — the array type narrows automatically when `AgentMessage` does. Confirm no `role: 'system'` ever populates it (it doesn't — the SDK runner only pushes user/assistant). |
| `packages/cli/src/commands/serve.ts:365` | Slice B verification. `const chatMessage: AgentMessage = { role: 'user', … }`. No `system` use; no edit needed. |
| `packages/session-postgres/src/{inbox,plugin,migrations}.ts` | Slice B verification. `AgentMessage`-typed JSONB column. Migration shape unchanged because role is a string column at the storage layer; only the TypeScript enum tightens. |

**Reference patterns in the codebase to mirror:**

- Hard-cut deletion precedent: Phase 6 PR-A (`packages/llm-anthropic/`, etc.) — same shape: re-grep before each task; commit-pair pattern (consumer first, definition second).
- Subscriber drop precedent: nothing in ax-next has retired a subscriber yet, so Slice A sets the pattern. Mirror Phase 6's "delete the block + delete the test that asserted it" rhythm.

**Pre-execution greps the executor MUST re-run before Task 1:**

```bash
# Confirm the four deletion targets are still in the state this plan describes.
grep -n "ChatMessage" packages/core/src/types.ts                          # Expected: zero hits
grep -n "LlmRequest\|LlmResponse" packages/core/src/types.ts              # Expected: lines 20, 25
grep -n "LlmCallRequestSchema\|LlmCallResponseSchema" packages/ipc-protocol/src/actions.ts  # Expected: lines 66, 75

# Confirm the load-bearing types are still load-bearing — DO NOT silently delete.
rg -n "from ['\"]@ax/core['\"]" --no-heading -g '!node_modules' -g '!dist' | rg "ToolCall\b|ToolDescriptor"
rg -n "ToolPreCall|ToolExecuteHost" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'

# Confirm AgentMessage's `system` role is truly orphan in production code.
rg -n "role: ['\"]system['\"]" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/' -g '!design_handoff_tide/'
# Expected: only test files (types.test.ts, schemas.test.ts:479 — note schemas.test.ts:479 is
# ConversationFetchHistoryTurnSchema, NOT AgentMessage; verify it before touching).

# Confirm the audit-log subscribes to BOTH chat:end and event.http-egress at HEAD.
grep -n "chat:end\|event.http-egress" packages/audit-log/src/plugin.ts

# Confirm @ax/ipc-server has nothing left to drop (no llm:call handler).
ls packages/ipc-core/src/handlers/                  # Expected: no llm-call.ts
grep -n "calls:" packages/ipc-server/src/plugin.ts  # Expected: ['session:resolve-token', 'session:claim-work', 'tool:list']

# Phase 7 self-marker grep — should be ZERO hits anywhere except docs/plans.
rg -n "Phase 7 deletes|Phase 7 narrows" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'
```

If any deviation surfaces, STOP and reconcile in the reality-check section before continuing. Memory `feedback_check_plan_vs_reality.md`.

---

## Invariants (verified per task)

PR-A's I1–I22 (carried via Phase 6.6) carry forward where they apply. Phase 7 adds I23–I27.

**Carry-forwards from PR-A / Phase 6.6 (still in force):**

- **I1** — `chat:end` fires exactly once per `agent:invoke`. Slice A drops a *subscriber*, not the *fire site*. The orchestrator still fires; only audit-log stops listening. *Prevents:* a slice-A regression that accidentally retires the event itself.
- **I7** — `proxy:close-session` fires once per `proxy:open-session`. Phase 7 doesn't touch the proxy lifecycle.
- **I9** — `pnpm build` + `pnpm test` clean across the workspace at every commit. Phase 7 commits stay bisect-friendly.
- **I10** — No new half-wired plugins or hooks. Phase 7 is pure deletion + one subscription drop. Window-pattern note: Slice A retires the `chat:end` subscription; if any preset's acceptance test ASSERTED the chat:end audit row, that test changes in the same commit as the subscriber drop. **No half-wired window** — the deletion and its test consequences land together.
- **I12** — `AgentInvokeInput` shape unchanged. Phase 7 narrows `AgentMessage.role`, not the input envelope.
- **I15** — No retained package imports any deletion target. Verified by post-deletion greps in the final task.
- **I17** — Deterministic lockfile. Phase 7 has no `package.json` edits, so lockfile shouldn't change. Verify.
- **I18** — Orchestrator's `'proxy-not-loaded'` and `'proxy-hooks-misconfigured'` paths stay distinct.

**New (Phase 7-specific):**

- **I23 — `AgentMessage.role` is exactly `'user' | 'assistant'` after Slice B.** Verified by `grep -n "role: 'system'" packages/core/src/types.ts packages/ipc-protocol/src/actions.ts` returning zero hits, and by the `__tests__/types.test.ts` assertion that ONLY accepts the two roles. *Prevents:* a stranded `'system'` literal that compiles only because TypeScript's enum widening is forgiving.
- **I24 — `@ax/audit-log` declares `subscribes: ['event.http-egress']` only after Slice A.** Verified by inspection of the plugin manifest and by a unit test that fires `chat:end` and asserts NO storage row was written. *Prevents:* a partial drop where the subscriber block is deleted but the manifest still lists `chat:end` (lying about what the plugin observes).
- **I25 — `@ax/core` exports list matches Section 5 of the design doc after Slice C.** No `LlmRequest`, no `LlmResponse`, no `ChatMessage`. Verified by a `packages/core/src/__tests__/exports.test.ts`-style snapshot or a literal grep. *Prevents:* a stranded export that makes the design doc lie about kernel surface.
- **I26 — `@ax/ipc-protocol` wire schemas have no `llm.call` block after Slice C.** Verified by `grep -n "llm.call\|LlmCall" packages/ipc-protocol/src/actions.ts` returning zero hits. *Prevents:* dead schemas that future readers spend time tracing back to a deleted handler.
- **I27 — Audit-log row keys for `event.http-egress` rows are unchanged.** Existing `egress:${scope}:${timestamp}:${uuid}` shape stays. Slice A only drops the OTHER subscriber; storage continuity for the http-egress rows is preserved. *Prevents:* a refactor-the-keys-while-we're-here drift that breaks consumers reading historical rows.

---

## Open questions resolved before execution

1. **One PR or three?** **One PR**, three slices, each as 1–2 commits. See "Slicing decision" above. If the executor finds reason to split mid-flight (e.g., Slice B reveals a consumer that wants its own PR for review reasons), surface it — don't expand silently.

2. **Slice ordering?** **A → B → C.**
   - Slice A (audit-log subscription) is the smallest blast radius (one file + tests in one package). Lands first to prove the subscriber-drop pattern.
   - Slice B (AgentMessage narrowing) touches multiple consumer sites mechanically; lands in the middle so kernel-type deletion (Slice C) doesn't churn the same files.
   - Slice C (kernel-type deletion) lands last because it has the most files and the strictest grep gates.

3. **Does Slice A need to update preset acceptance tests?** **Audit during Task 1.** The k8s preset acceptance and multi-tenant-acceptance tests subscribe to `chat:end` themselves (in their own recorder plugins) — those subscriptions stay. The audit-log assertion in `presets/k8s/src/__tests__/acceptance.test.ts:325-333` checks that audit-log writes a row on `chat:end` — Slice A removes that behavior, so the test asserts the OPPOSITE after Slice A: no chat:end row, only http-egress rows. **Update the test in the same commit as the subscriber drop.**

4. **Does Slice B need a migration for stored `AgentMessage` data?** **No.** `@ax/session-postgres`'s JSONB `payload` column stores arbitrary JSON; the role is a string at the database layer. TypeScript narrowing happens at the type-check boundary only. Existing rows with `role: 'system'` (if any — survey will check) round-trip as untyped JSON. The narrowing's safety claim is "no production code path ever WRITES `role: 'system'`" — the survey verifies that.

5. **What does Slice C do with `packages/ipc-protocol/src/__tests__/schemas.test.ts:479`?** It's a `ConversationFetchHistoryTurn`, not an `AgentMessage` — different schema, different role enum (`'user' | 'assistant' | 'tool'`). **Leave it.** Slice B doesn't touch `ConversationFetchHistoryTurnSchema`.

6. **Does Phase 7 update the design doc's Section 5 / Section 6?** **No** — leave the design doc untouched. Document deviations (the "still load-bearing" types) in PR notes after merge, mirroring Phase 6's pattern. The design doc is a snapshot; PR notes are the running record.

7. **Does Slice C drop anything in `@ax/ipc-server`?** **No work expected.** `@ax/ipc-server` has nothing tied to the deleted schemas. Survey confirms; Final-verification step records.

8. **README updates?** Touch only the lines that reference deleted/changed code:
   - Line 20: `subscribes to chat:end` → `subscribes to event.http-egress`
   - Lines 68-73: drop the `LlmRequest`/`LlmResponse` example block (or rewrite it for a still-live hook — pick whichever requires less prose work; the drop is acceptable since the example doesn't carry weight elsewhere).
   - The wider `chat:start → llm:pre-call → llm:call → ...` narrative stays. Out of scope.

9. **Bisect granularity for Slice C?** **One commit.** All three deletions (`LlmRequest`/`LlmResponse` from `@ax/core`, `LlmCallRequest/Response` schemas from `@ax/ipc-protocol`, the `describe('llm.call')` test block) drop in lockstep — they're conceptually one removal of the `llm.call` wire surface. A commit pair would split the kernel from the protocol unnecessarily.

10. **What if the survey finds an unexpected `role: 'system'` literal in production code?** STOP. Memory `feedback_check_plan_vs_reality.md`: surface the deviation in the reality-check section, decide whether the consumer migrates to `role: 'user'` (most likely — system prompts in modern model APIs go through the SDK's `systemPrompt` config, not message roles), or whether Phase 7's narrowing is premature and Slice B drops back to a separate plan. Don't silently coerce or skip.

---

## Tasks

### Task 1: Pre-execution survey + baseline confirmation

**Goal:** Verify the workspace is at PR #25's HEAD and the deletion / narrowing inventory still matches this plan's expectations. Memory `feedback_check_plan_vs_reality.md`.

**Files:** Read-only.

**Step 1.1: Confirm baseline**

```bash
git log --oneline main -1   # Expected: "Merge pull request #25 …" (Phase 6.6)
pnpm build
pnpm test
```

Expected: clean build; ~1610+ tests passing across the workspace (Phase 6.6's stat). If anything is red at baseline, STOP and fix before Phase 7 — don't conflate pre-existing breakage with Phase 7's diff.

**Step 1.2: Re-run Reality-check greps**

Run every grep in the "Pre-execution greps" section above. Expected hit profile:

- `ChatMessage` in `packages/core/src/types.ts`: zero hits.
- `LlmRequest`, `LlmResponse` in `packages/core/src/types.ts`: lines 20, 25.
- `LlmCallRequestSchema`, `LlmCallResponseSchema` in `packages/ipc-protocol/src/actions.ts`: lines 66, 75.
- `ToolCall`, `ToolDescriptor` consumers in production code: as catalogued in Reality check.
- `ToolPreCall*`, `ToolExecuteHost*` consumers: as catalogued.
- `role: 'system'` in production code: zero hits (only test files).
- `chat:end` and `event.http-egress` subscriber blocks both present in `packages/audit-log/src/plugin.ts`.
- `@ax/ipc-server`'s `calls:` declares no `llm:call`.

If any count differs, STOP and reconcile.

**Step 1.3: Confirm the audit-log test files exist and identify which assertions retire**

```bash
ls packages/audit-log/src/__tests__/
grep -n "chat:end\|event.http-egress" packages/audit-log/src/__tests__/*.test.ts | head -40
grep -n "audit-log\|chat:end" presets/k8s/src/__tests__/acceptance.test.ts | head -20
```

Capture the line ranges of `chat:end`-asserting tests in audit-log and in the k8s preset acceptance — those are the tests Slice A's commit needs to update.

**Step 1.4: No commit** — read-only verification.

---

### Task 2 (Slice A): Drop `@ax/audit-log`'s `chat:end` subscription

**Goal:** Audit-log observes only `event.http-egress` after this commit. The `chat:end` subscriber block, the `chat:end` row writer, the manifest `subscribes:` entry, and the tests that asserted the row all delete in one bisect-friendly commit.

**Files:**
- Modify: `packages/audit-log/src/plugin.ts` (drop the `chat:end` subscriber block, lines ~38-55; update the manifest if present)
- Modify: `packages/audit-log/src/__tests__/*.test.ts` (drop tests that assert `chat:` rows from `chat:end`; keep tests for `egress:` rows)
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts` (update the audit-log row assertion — see Open question 3)

**Step 2.1: Write the failing test (TDD — invert)**

Add a new test asserting the *new* behavior: when `chat:end` fires, audit-log writes NO row.

```ts
// packages/audit-log/src/__tests__/audit-log-chat-end-not-observed.test.ts
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { auditLogPlugin } from '../plugin.js';

describe('audit-log no longer subscribes to chat:end', () => {
  it('does not write a row when chat:end fires', async () => {
    const h = await createTestHarness({ plugins: [auditLogPlugin()] });
    // Fire chat:end with a complete outcome.
    await h.bus.fire('chat:end', h.makeCtx(), {
      outcome: { kind: 'complete', messages: [] },
    });
    // No `chat:*` keys should exist in storage.
    const keys = await h.storage.listKeys('chat:');
    expect(keys).toEqual([]);
  });

  it('still writes a row when event.http-egress fires', async () => {
    const h = await createTestHarness({ plugins: [auditLogPlugin()] });
    await h.bus.fire('event.http-egress', h.makeCtx(), {
      sessionId: 's1', userId: 'u1', method: 'POST', host: 'api.anthropic.com',
      path: '/v1/messages', status: 200, requestBytes: 100, responseBytes: 200,
      durationMs: 50, credentialInjected: true, classification: 'llm',
      timestamp: Date.now(),
    });
    const keys = await h.storage.listKeys('egress:');
    expect(keys.length).toBe(1);
  });
});
```

Run:

```bash
pnpm --filter @ax/audit-log test
```

Expected: the first test FAILS (audit-log still writes a `chat:*` row); the second test PASSES.

**Step 2.2: Drop the `chat:end` subscriber + manifest entry**

In `packages/audit-log/src/plugin.ts`:

1. Delete the entire `bus.subscribe<{ outcome: AgentOutcome }>('chat:end', …)` block (~17 LOC).
2. Update the manifest `subscribes:` array from `['chat:end', 'event.http-egress']` to `['event.http-egress']`.
3. The `import type { AgentContext, AgentOutcome, Plugin }` statement: drop `AgentOutcome` if no other line uses it. (`AgentContext` stays — the http-egress subscriber's first arg is typed as `AgentContext`.)

**Step 2.3: Drop tests that asserted the old behavior**

In `packages/audit-log/src/__tests__/`:

- Delete tests that asserted `chat:${reqId}` rows are written. These will FAIL after Step 2.2 unless removed.
- Keep all tests covering `event.http-egress` row writes.

**Step 2.4: Update the k8s preset acceptance test**

`presets/k8s/src/__tests__/acceptance.test.ts` currently asserts (around line 325-333) that audit-log wrote a `chat:${reqId}` row after `chat:end`. After Slice A, that assertion is wrong.

Update the test to:
- Either drop the audit-log row assertion entirely (the recorder subscriber on `chat:end` is enough proof the event fired)
- Or assert the NEW behavior: an `egress:` row exists if the script's chat path included an http-egress event (it doesn't — stub runner makes no upstream calls — so the test asserts ZERO `chat:*` AND ZERO `egress:*` rows).

Pick the simpler option (drop the audit-log row assertion in the canary; keep the chat:end recorder).

**Step 2.5: Run + commit**

```bash
pnpm --filter @ax/audit-log build
pnpm --filter @ax/audit-log test
pnpm --filter @ax/preset-k8s test
```

Expected: PASS.

```bash
git add packages/audit-log/src/plugin.ts \
        packages/audit-log/src/__tests__/ \
        presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "refactor(audit-log): drop chat:end subscription, observe only event.http-egress [Phase 7]"
```

**Step 2.6: I24 verification**

```bash
grep -n "chat:end" packages/audit-log/src/plugin.ts
# Expected: zero hits.
grep -n "subscribes:" packages/audit-log/src/plugin.ts
# Expected: ['event.http-egress']
```

---

### Task 3 (Slice B): Narrow `AgentMessage.role` to `'user' | 'assistant'`

**Goal:** `AgentMessage.role` accepts exactly two values after this commit. The kernel type and the wire schema narrow together, in lockstep.

**Files:**
- Modify: `packages/core/src/types.ts:3-6` (drop `'system'` from the role union)
- Modify: `packages/core/src/__tests__/types.test.ts` (drop the `system` role assertion)
- Modify: `packages/ipc-protocol/src/actions.ts:20-23` (drop `'system'` from `AgentMessageSchema`'s enum)
- (Optional) verification only: `packages/agent-claude-sdk-runner/src/main.ts:208`, `packages/cli/src/commands/serve.ts:365`, `packages/session-postgres/src/{inbox,plugin}.ts`

**Step 3.1: Write the failing test (TDD)**

Add a TS-level assertion that `role: 'system'` is now a TYPE error:

```ts
// packages/core/src/__tests__/types.test.ts
describe('AgentMessage role narrowing (Phase 7)', () => {
  it('accepts user and assistant roles', () => {
    const u: AgentMessage = { role: 'user', content: 'hi' };
    const a: AgentMessage = { role: 'assistant', content: 'hello' };
    expect(u.role).toBe('user');
    expect(a.role).toBe('assistant');
  });

  it('rejects the system role at the wire layer', () => {
    // Runtime check: the schema must reject role: 'system'.
    const r = AgentMessageSchema.safeParse({ role: 'system', content: 'be brief' });
    expect(r.success).toBe(false);
  });

  // No TS-level negative assertion (TS doesn't expose @ts-expect-error
  // semantics for type-level rejection cleanly inside vitest); the schema
  // assertion above is the load-bearing one. The kernel-side type narrows
  // at the same time, so the schema check covers both layers.
});
```

Run:

```bash
pnpm --filter @ax/core test
pnpm --filter @ax/ipc-protocol test
```

Expected: the schema test FAILS (current schema accepts `'system'`).

**Step 3.2: Narrow the kernel type**

In `packages/core/src/types.ts`:

```ts
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}
```

In `packages/core/src/__tests__/types.test.ts`: delete the line that asserts `const system: AgentMessage = { role: 'system', content: '…' };`.

**Step 3.3: Narrow the wire schema**

In `packages/ipc-protocol/src/actions.ts:20-23`:

```ts
export const AgentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});
```

**Step 3.4: Verify consumers don't break**

```bash
pnpm build
pnpm test
```

Expected: clean across all packages. The SDK runner's `chatEndHistory: AgentMessage[]` array narrows automatically; the `cli/src/commands/serve.ts` literal `{ role: 'user', content: message }` already uses the live-allowed role; `session-postgres`'s JSONB pass-through doesn't enforce the union at the storage layer.

If anything fails, STOP — surface in the reality-check section, fix the consumer in the same commit (don't add a follow-up commit for an unexpected `role: 'system'` literal — that's a Slice B prerequisite, not a Slice B follow-up).

**Step 3.5: Commit**

```bash
git add packages/core/src/types.ts \
        packages/core/src/__tests__/types.test.ts \
        packages/ipc-protocol/src/actions.ts \
        packages/ipc-protocol/src/__tests__/schemas.test.ts
git commit -m "refactor(core,ipc-protocol): narrow AgentMessage.role to user|assistant [Phase 7]"
```

**Step 3.6: I23 verification**

```bash
rg -n "role: ['\"]system['\"]" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/' -g '!design_handoff_tide/'
# Expected: zero hits in production code; only ConversationFetchHistoryTurn tests
# (which are NOT AgentMessage and stay).
grep -n "'user'\|'assistant'\|'system'" packages/core/src/types.ts
# Expected: only 'user' and 'assistant' on the role line.
```

---

### Task 4 (Slice C): Delete `LlmRequest` / `LlmResponse` / `LlmCall*Schema`

**Goal:** Drop the final orphans of the deleted `llm.call` wire surface. Kernel exports list matches Section 5 of the design doc after this commit.

**Files:**
- Modify: `packages/core/src/types.ts` (drop the `LlmRequest` and `LlmResponse` interfaces, lines ~20-28)
- Modify: `packages/core/src/__tests__/types.test.ts` (drop the `LlmRequest/LlmResponse callers still type-check; Phase 7 narrows` line and any related assertion, around line 7)
- Modify: `packages/ipc-protocol/src/actions.ts` (drop the `// llm.call` comment block + `LlmCallRequestSchema` + `LlmCallResponseSchema`, lines ~57-86)
- Modify: `packages/ipc-protocol/src/__tests__/schemas.test.ts` (drop the `LlmCallRequestSchema`/`LlmCallResponseSchema` imports on lines 3-4 and the `describe('llm.call', …)` block on lines 37-65)
- Modify: `README.md:68-95` (drop the stale `LlmRequest`/`LlmResponse` example; minimal edit — preserve the surrounding "Try a tiny example" prose if reasonable, otherwise drop the whole code block)

**Step 4.1: Write the failing test**

This is a deletion, so the "test" is a grep gate. Add a temporary check (inline in the commit message or as a one-shot in the verification step) — no new test file.

```bash
# Should fail at HEAD; pass after Step 4.2-4.4.
grep -n "LlmRequest\|LlmResponse\|LlmCall" packages/core/src/ packages/ipc-protocol/src/ \
  | grep -v __tests__/.*types.test.ts:.*Phase 7 narrows \
  | grep -v node_modules
# Expected after deletion: only matches in tests that were intentionally kept (none expected).
```

**Step 4.2: Delete the kernel types**

In `packages/core/src/types.ts`:

Delete the `LlmRequest` interface (lines ~20-23) and the `LlmResponse` interface (lines ~25-28). Leave the surrounding `AgentMessage`, `ToolCall`, `ToolResult`, `ToolDescriptor`, and `AgentOutcome` types untouched.

In `packages/core/src/__tests__/types.test.ts`: delete any `LlmRequest`/`LlmResponse` references (existence-assertion line, comment about Phase 7 narrows, any imports).

**Step 4.3: Delete the wire schemas**

In `packages/ipc-protocol/src/actions.ts`:

Delete the entire `// ----- llm.call -----` comment block and the `LlmCallRequestSchema` + `LlmCallRequest` type + `LlmCallResponseSchema` + `LlmCallResponse` type (lines ~57-86). Leave the `// Shared shapes` block above and the `// tool.pre-call` block below untouched.

In `packages/ipc-protocol/src/__tests__/schemas.test.ts`:

Delete the `LlmCallRequestSchema` and `LlmCallResponseSchema` imports (lines 3-4) and the entire `describe('llm.call', …)` block (lines 37-65). Other describes (`describe('tool.pre-call', …)`, `describe('AgentMessageSchema', …)`, etc.) stay.

**Step 4.4: Update README**

In `README.md`:

- Lines 68-95: Drop the code block that imports and registers `LlmRequest`/`LlmResponse`. Replace with a short note pointing readers to `agent:invoke` as the current entry point, or simply delete the block — the surrounding "Try a tiny example" prose can stand without it.
- Line 20 (audit-log line): change `subscribes to chat:end` → `subscribes to event.http-egress`. (This is the README half of Slice A; bundling it here keeps the README delta in one commit.)

The wider "fires `chat:start`, routes through `llm:pre-call` → `llm:call` → `llm:post-call` …" prose (line 56) stays — that's the broader docs sweep, out of scope.

**Step 4.5: Run + commit**

```bash
pnpm build
pnpm test
```

Expected: clean across all packages.

```bash
git add packages/core/src/types.ts \
        packages/core/src/__tests__/types.test.ts \
        packages/ipc-protocol/src/actions.ts \
        packages/ipc-protocol/src/__tests__/schemas.test.ts \
        README.md
git commit -m "refactor(core,ipc-protocol): delete Llm{Request,Response,Call*Schema} orphans [Phase 7]"
```

**Step 4.6: I25 + I26 verification**

```bash
# I25: kernel exports clean.
grep -n "LlmRequest\|LlmResponse\|ChatMessage" packages/core/src/types.ts packages/core/src/index.ts
# Expected: zero hits.

# I26: wire schemas clean.
grep -n "llm.call\|LlmCall" packages/ipc-protocol/src/actions.ts
# Expected: zero hits.

# Workspace-wide gate: no consumer left dangling.
rg -n "\bLlmRequest\b|\bLlmResponse\b|LlmCallRequestSchema|LlmCallResponseSchema" \
   --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/' -g '!design_handoff_tide/'
# Expected: zero hits (or only README prose, if any survived the cut).
```

---

### Task 5: Final verification + boundary review note

**Goal:** Confirm the workspace is green, every Phase 7 invariant holds, and there's nothing left half-wired. Compose the boundary-review block for the PR description.

**Step 5.1: Full workspace build + test**

```bash
pnpm build
pnpm test
```

Expected: ~1610+ tests passing (Phase 6.6 baseline + the new Phase 7 unit tests minus the deleted `chat:end` audit-log tests and the deleted `llm.call` schema tests; net should be roughly flat or slightly higher).

**Step 5.2: Phase 7 invariant audit**

```bash
# I23 — AgentMessage role narrowed.
grep -n "role: ['\"]system['\"]" packages/core/src/types.ts packages/ipc-protocol/src/actions.ts
# Expected: zero hits.

# I24 — audit-log subscribes only to event.http-egress.
grep -n "chat:end" packages/audit-log/src/plugin.ts
grep -n "subscribes:" packages/audit-log/src/plugin.ts
# Expected: zero chat:end hits; subscribes: ['event.http-egress'].

# I25 — kernel exports clean.
grep -n "LlmRequest\|LlmResponse\|ChatMessage" packages/core/src/types.ts
# Expected: zero hits.

# I26 — wire schemas clean.
grep -n "LlmCall\|llm.call" packages/ipc-protocol/src/actions.ts
# Expected: zero hits.

# I15 carry-forward — no retained imports of deletion targets.
rg -n "from ['\"]@ax/core['\"]" --no-heading -g '!node_modules' -g '!dist' \
  | rg "LlmRequest|LlmResponse|ChatMessage"
# Expected: zero hits.
```

**Step 5.3: Boundary review block (for PR description)**

Phase 7 doesn't add new hooks. The single contract change is `AgentMessage.role` narrowing (Slice B), which is a kernel-type narrowing — not a hook surface change.

```markdown
## Boundary review — AgentMessage.role narrowing

- **Alternate impl this contract could have:** the role enum is a kernel-type union, not a hook signature. Future runners satisfy the schema; there's no "alternate impl" since this isn't a service-hook contract.
- **Payload field names that might leak:** none. `role` is generic and matches every model provider's vocabulary (Anthropic, OpenAI, Gemini all use `role: 'user' | 'assistant'` plus a separate system-prompt mechanism).
- **Subscriber risk:** none — `AgentMessage` is a pure data type, not a fired event.
- **Wire surface:** `AgentMessageSchema` in `@ax/ipc-protocol` narrows in lockstep. No backwards-compat concern: there's no production code path that ever wrote `role: 'system'` (survey-confirmed); old persisted JSONB rows (if any) round-trip as untyped JSON at the storage layer.

## Boundary review — audit-log subscription drop

- **Alternate impl this hook could have:** `chat:end` is still a fired event with other valid subscribers (the orchestrator's recorder in tests, future per-PR debugging plugins). Audit-log just opts out.
- **Payload field names that might leak:** N/A — no schema change.
- **Subscriber risk:** N/A — we're REMOVING a subscriber.
- **Wire surface:** unchanged.
```

**Step 5.4: I17 lockfile audit**

```bash
git diff main..HEAD pnpm-lock.yaml | head -5
# Expected: empty (no package.json edits in Phase 7).
```

If the lockfile changed unexpectedly, reconcile.

**Step 5.5: No commit** — verification + PR-description prep only.

---

## Acceptance criteria (verified before merge)

| | Criterion | How verified |
|---|---|---|
| I1 | `chat:end` fires exactly once per `agent:invoke` | k8s preset acceptance test still asserts via its recorder subscriber (independent of audit-log) |
| I7 | `proxy:close-session` fires once per `proxy:open-session` | Phase 7 doesn't touch proxy lifecycle; existing tests pass |
| I9 | Workspace clean per commit | Per-task `pnpm build` + `pnpm test` |
| I10 | No new half-wired plugins | Phase 7 is pure deletion + one subscription drop; no infrastructure additions |
| I12 | `AgentInvokeInput` shape unchanged | `git diff main..HEAD packages/chat-orchestrator/src/orchestrator.ts` shows zero `AgentInvokeInput` edits |
| I15 | No retained imports of deletion targets | Task 5.2 grep gate |
| I17 | Deterministic lockfile | Task 5.4 diff is empty |
| I18 | Orchestrator gating paths stay distinct | Existing tests still pass |
| I23 | `AgentMessage.role` is `'user' \| 'assistant'` | Task 3.6 grep + schema test |
| I24 | `@ax/audit-log` subscribes only to `event.http-egress` | Task 2.6 grep + new test asserts no `chat:*` row written on `chat:end` |
| I25 | `@ax/core` exports list matches Section 5 | Task 4.6 grep |
| I26 | `@ax/ipc-protocol` has no `llm.call` schemas | Task 4.6 grep |
| I27 | Audit-log `egress:` row keys unchanged | Existing http-egress tests still pass with the same key shape |

---

## Phase 6 / 6.6 lessons feeding into Phase 7

| Lesson | How it shapes Phase 7 |
|---|---|
| **`feedback_check_plan_vs_reality.md`** — Phase 5/6 surveys caught load-bearing types the design doc said to delete. | The Reality check section above documents three load-bearing categories (`ToolCall`, `ToolDescriptor`, `ToolPreCall*`/`ToolExecuteHost*`) the executor must NOT delete. Survey reconfirms before any cut. |
| **`feedback_targeted_followup_commits.md`** — small follow-up commits beat amends. | Each slice (A, B, C) is its own commit. If a slice surfaces an unexpected consumer, the fix is its OWN commit in the same PR, not an amend. |
| **`feedback_minor_issues_non_blocking.md`** — reviewer Minor + ship = ship. | Phase 7 is "Final tidy-up" per the design doc. Don't gate on cosmetic drift — ship when the four invariants (I23–I26) hold and CI is green. |
| **`feedback_plan_revision_after_rollback.md`** — number invariants explicitly. | Phase 7 has 13 invariants on the table (I1, I7, I9, I10, I12, I15, I17, I18 carry-forwards + I23–I27 new). Each I23–I27 earns its slot — see Acceptance criteria. |
| **`feedback_half_wired_window_pattern.md`** — close windows in the same PR. | Slice A drops the `chat:end` subscriber AND the test that asserted the row, in the SAME commit. Slice B narrows kernel + wire schema, in the SAME commit. Slice C drops the kernel types + wire schemas + tests + README example, in the SAME commit. **No half-wired window.** |
| **Phase 6 PR-A reviewer feedback — explicit assertions over structural implication.** | Slice A's new test asserts EXPLICITLY: "fire `chat:end`, then assert no `chat:*` storage row exists." Not "if the subscriber is missing then by structural implication no row is written." |
| **Phase 6 PR-A reviewer feedback — drop dead seams, don't leave them.** | Slice C deletes the `LlmCall*` schema test block in lockstep with the schemas. No dead `describe('llm.call')` left orphaned in the test file. |

---

## Estimated landing

- **Tasks:** 5 (1 read-only survey + 3 substantive slices + 1 verification).
- **Commits:** 3 substantive (one per slice) + 0 follow-ups expected = 3 commits on the branch. If a slice surfaces unexpected consumer churn, +1 follow-up commit per slice; cap at 5.
- **Files touched:** ~10 (5 in `@ax/audit-log`, 3 in `@ax/core` + `@ax/ipc-protocol`, plus tests and README).
- **LOC delta:** approximately **−250 LOC, +50 LOC = net −200 LOC**. (Slice A: −20 plugin, +25 test = +5; Slice B: −5 type/schema, +20 test = +15; Slice C: −60 schemas + tests + README example, +5 verification = −55. Roughly.)
- **Risk:** **Low.** All three slices are pure deletion or narrowing. The hardest landing risk is a surprise `role: 'system'` literal in a consumer the survey misses — Slice B's TS-level narrowing surfaces that immediately as a build failure on the offending consumer file.
- **Predecessors:** Phase 6 PR-A (PR #24) + Phase 6.6 (PR #25), both merged. Hard dependency on PR #25 because Slice A's preset acceptance test edit assumes the Phase 6.6 stub-runner shape.
- **Successors:**
  - **`@ax/agent-runner-core` merge into the SDK runner** — separate slice (deferred since Phase 5).
  - **`@ax/tool-dispatcher` merge into `@ax/mcp-client`** — separate slice.
  - **`cfg.sandbox` / `cfg.storage` single-value collapse** — separate slice.
  - **README + landing-page narrative refresh** — separate writing pass; Phase 7 only fixed the lines whose code references stopped being valid.

---

## Out-of-scope reminder

Phase 7 does NOT:

- Delete `ToolCall`, `ToolDescriptor`, `ToolPreCall*`, or `ToolExecuteHost*` from any package — the survey confirmed they're load-bearing.
- Modify `@ax/agent-claude-sdk-runner/src/main.ts` beyond the zero-change baseline (the `chatEndHistory: AgentMessage[]` array narrows automatically when the type does — no edit).
- Change `@ax/chat-orchestrator` (the `'proxy-not-loaded'` outcome and the `chat:end` fire site stay).
- Add new IPC actions or hook signatures.
- Touch `@ax/tool-dispatcher`'s catalog ownership.
- Restore any deleted package.
- Change `@ax/ipc-server`'s plugin manifest (already clean — Phase 6 retired the `llm.call` action handler).
- Rewrite README narrative beyond the four lines whose code references stop being valid in this PR.
