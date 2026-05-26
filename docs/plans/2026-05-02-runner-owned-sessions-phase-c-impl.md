# Runner-owned sessions — Phase C implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Land the four small Phase C residue items so the workspace redesign's jsonl-gap closure (shipped in workspace Phase 3 / PR #32) actually flows through end-to-end. After this PR, the SDK's session jsonl lands under `/permanent/.ax/sessions/<sessionId>.jsonl`, the host's conversation row holds the sessionId, and the runner uses SDK `resume(sessionId)` instead of replaying turns from postgres.

**Architecture:** Three small wiring changes on the runner side (HOME redirect for the SDK subprocess, `system/init` capture + IPC bind, `resume()` adoption) plus a tiny new IPC action (`conversation.store-runner-session`) bridging the runner to the existing `conversations:store-runner-session` bus hook (Phase B shipped the surface; Phase C closes the half-wired window). Plus delete the parked branch.

**Tech stack:** TypeScript (Node 20+), Vitest, `@anthropic-ai/claude-agent-sdk`, `zod` for IPC schemas. No new runtime deps.

**Refs:**
- `docs/plans/2026-05-02-runner-owned-sessions-remaining.md` (summary)
- `docs/plans/2026-04-29-runner-owned-sessions-design.md` (original design)
- `docs/plans/2026-05-01-workspace-redesign-design.md` (the redesign that subsumed the rest of Phase C)

---

## Open questions (need user decision before code)

### Q1. HOME target — workspace root or isolated subdir?

Options:
- (a) `HOME = env.workspaceRoot` (typically `/permanent/workspace`). SDK writes `.claude/projects/...` directly into the workspace. Auxiliary SDK files (`.claude.json`, `.claude/backups/`, etc.) ALSO land in the workspace and get captured by `git-status`.
- (b) `HOME = path.join(env.workspaceRoot, '.ax/sessions-home')`. SDK writes to a dedicated subdir. Cleaner separation; auxiliary files don't pollute the agent's project area.

**Recommend (a).** Auxiliary files in workspace history is acceptable for MVP — they're small, the `.ax/` filter in workspace:pre-apply doesn't subscribe validators to them anyway, and (b) requires a separate symlink/copy step to surface jsonl in a stable path. We can split in a follow-up if it becomes noisy.

### Q2. Does `@anthropic-ai/claude-agent-sdk` support `query({ resume: sessionId })`?

Verify before C-3. Check the package's exported `Options` type for a `resume` field. If absent, C-3 is blocked until the SDK ships it; in that case, ship C-1 + C-2 + C-4 alone and document C-3 as deferred.

**Recommend: verify before starting C-3.** A 30-second check (`grep -n "resume" node_modules/@anthropic-ai/claude-agent-sdk/dist/...`) settles it. Don't proceed with C-3 if absent — just remove the task and ship the rest.

### Q3. Where does `conversation.store-runner-session` IPC action's input shape come from?

The bus hook `conversations:store-runner-session` already exists (`packages/conversations/src/plugin.ts:240`) and takes `StoreRunnerSessionInput`. The new IPC action wraps it. Two options:

- (a) Mirror `conversation.fetch-history`'s pattern: zod schema in `actions.ts`, response in `ipc-client.ts`, timeout in `timeouts.ts`, handler in `ipc-core/handlers/`.
- (b) Tunnel through an existing IPC action.

**Recommend (a).** Mirrors the established pattern, easy to test, no schema-tunneling weirdness. The IPC action is one-shot per session (fires on first SDK init), low traffic.

If any of these recommendations are wrong, flag before coding starts.

---

## File layout after this PR

```
packages/
├── agent-claude-sdk-runner/
│   ├── src/
│   │   └── main.ts                          # MODIFIED — HOME override, system/init handler, resume path
│   └── __tests__/                            # MODIFIED — integration tests for each
├── ipc-protocol/
│   ├── src/
│   │   ├── actions.ts                       # MODIFIED — add ConversationStoreRunnerSession{Request,Response}Schema
│   │   ├── ipc-client.ts                    # MODIFIED — register the response schema
│   │   ├── timeouts.ts                      # MODIFIED — add per-action timeout
│   │   └── __tests__/schemas.test.ts        # MODIFIED — schema test cases
└── ipc-core/
    └── src/
        ├── dispatcher.ts                    # MODIFIED — register handler
        └── handlers/
            └── conversation-store-runner-session.ts   # NEW
```

Plus: branch `feat/phase-c-pr-a-runner-read-transcript` deleted locally.

---

## Bite-sized TDD tasks

Order: C-2 IPC plumbing → C-2 runner wiring → C-1 HOME redirect → C-3 resume → C-4 branch cleanup.

C-2 first because C-3 depends on `runner_session_id` being populated by C-2; C-1 in the middle because the integration test for C-1 happens to need C-2's wiring (otherwise no jsonl exists to verify the path resolves correctly). C-4 last because it's a 1-second cleanup with no dependencies.

### Task 1: Add IPC schemas for `conversation.store-runner-session`

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts`
- Modify: `packages/ipc-protocol/src/ipc-client.ts`
- Modify: `packages/ipc-protocol/src/timeouts.ts`
- Modify: `packages/ipc-protocol/src/__tests__/schemas.test.ts`

**Step 1: Write the failing schema test**

Mirror the shape of the existing `'conversation.fetch-history'` test block in `schemas.test.ts:445`. Add a parallel `describe('conversation.store-runner-session', ...)` with cases for:
- Valid request (`{ conversationId: string, runnerSessionId: string }`) parses.
- Missing `conversationId` rejects.
- Missing `runnerSessionId` rejects.
- Empty `conversationId` rejects.
- Empty `runnerSessionId` rejects.
- Response shape `{ ok: true }` parses.
- `ipc-client.ts`'s response-schema map includes the new key.

Run: `pnpm --filter @ax/ipc-protocol test` → FAIL (schemas not defined).

**Step 2: Add the schemas**

In `actions.ts`, mirror `ConversationFetchHistory{Request,Response}Schema`'s pattern (around line 290). New schemas:

```ts
export const ConversationStoreRunnerSessionRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    runnerSessionId: z.string().min(1),
  })
  .strict();

export const ConversationStoreRunnerSessionResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export type ConversationStoreRunnerSessionRequest = z.infer<
  typeof ConversationStoreRunnerSessionRequestSchema
>;
export type ConversationStoreRunnerSessionResponse = z.infer<
  typeof ConversationStoreRunnerSessionResponseSchema
>;
```

In `timeouts.ts:31`, add `'conversation.store-runner-session': 5_000`.

In `ipc-client.ts:78`, add `'conversation.store-runner-session': ConversationStoreRunnerSessionResponseSchema`.

Run: `pnpm --filter @ax/ipc-protocol test` → PASS.

**Step 3: Commit**

```bash
git add packages/ipc-protocol/src/actions.ts packages/ipc-protocol/src/ipc-client.ts packages/ipc-protocol/src/timeouts.ts packages/ipc-protocol/src/__tests__/schemas.test.ts
git commit -m "feat(ipc-protocol): conversation.store-runner-session schemas"
```

### Task 2: Wire `conversation.store-runner-session` IPC handler on the host

**Files:**
- Create: `packages/ipc-core/src/handlers/conversation-store-runner-session.ts`
- Modify: `packages/ipc-core/src/dispatcher.ts`
- Create: `packages/ipc-core/src/handlers/__tests__/conversation-store-runner-session.test.ts`

**Step 1: Write the failing handler test**

Read `packages/ipc-core/src/handlers/conversation-fetch-history.ts` and its test for shape reference. Mirror it. The handler:
- Receives `{ conversationId, runnerSessionId }`.
- Calls `bus.call('conversations:store-runner-session', ctx, input)`.
- Returns `{ ok: true }` on success.
- Maps the bus hook's `PluginError` (`already-bound` if a different sessionId was already stored) to a 409, missing conversation to 404, validation to 400.

Test cases:
- Happy path: bus call succeeds → 200 + `{ ok: true }`.
- 409 on `already-bound` PluginError.
- 404 on `not-found` PluginError.
- 400 on validation PluginError.
- Generic 500 on unknown error.

Run: `pnpm --filter @ax/ipc-core test` → FAIL.

**Step 2: Implement the handler**

```ts
// packages/ipc-core/src/handlers/conversation-store-runner-session.ts
import { ConversationStoreRunnerSessionRequestSchema, type ConversationStoreRunnerSessionResponse } from '@ax/ipc-protocol';
import type { IpcHandler } from '../types.js';
import { validationError, logInternalError } from './shared.js';

export const conversationStoreRunnerSessionHandler: IpcHandler = async (req, ctx) => {
  const parsed = ConversationStoreRunnerSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(`conversation.store-runner-session: ${parsed.error.message}`);
  }
  try {
    await ctx.bus.call('conversations:store-runner-session', ctx, parsed.data);
    return { status: 200, body: { ok: true } satisfies ConversationStoreRunnerSessionResponse };
  } catch (err) {
    // Map PluginError codes to HTTP. Reuse the same mapping helpers used by
    // conversation-fetch-history.
    return mapPluginError(err, ctx, 'conversation.store-runner-session');
  }
};
```

(Copy the exact `mapPluginError` import path / shared helpers from `conversation-fetch-history.ts:1-40`.)

In `dispatcher.ts`, mirror the `fetch-history` registration (lines 27 + 78):

```ts
import { conversationStoreRunnerSessionHandler } from './handlers/conversation-store-runner-session.js';
...
ACTIONS.set('/conversation.store-runner-session', { method: 'POST', handler: conversationStoreRunnerSessionHandler });
```

Run: `pnpm --filter @ax/ipc-core test` → PASS.

**Step 3: Commit**

```bash
git add packages/ipc-core/src/handlers/conversation-store-runner-session.ts packages/ipc-core/src/dispatcher.ts packages/ipc-core/src/handlers/__tests__/conversation-store-runner-session.test.ts
git commit -m "feat(ipc-core): conversation.store-runner-session handler"
```

### Task 3: Capture SDK system/init in the runner and IPC the sessionId

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` (or whichever test exists)

**Step 1: Write the failing integration test**

Use the runner's existing test harness. Mock the SDK to emit a `{ type: 'system', subtype: 'init', session_id: 'sdk-test-session-123' }` message as the first message in the iterator, then `{ type: 'assistant', ... }` and `{ type: 'result', ... }`. Stub the IPC client to record calls. Assert exactly one call to `conversation.store-runner-session` with `{ conversationId: <ctx.conversationId>, runnerSessionId: 'sdk-test-session-123' }`.

Edge cases:
- `conversationId === null` (no conversation row, e.g. canary chat): no call to `store-runner-session`.
- Multiple `system/init` messages (resume case): only the FIRST one fires the IPC; subsequent ones no-op (the conversation row already has a runnerSessionId — let the host's PluginError surface differently).
- IPC failure: log to stderr, continue (don't kill the chat).

Run: tests fail.

**Step 2: Add the system/init handler**

In `main.ts:387-` (the `for await (const msg of queryIter)` block), add a branch BEFORE the `'assistant'` branch:

```ts
let runnerSessionIdSent = false;

for await (const msg of queryIter) {
  if (msg.type === 'system' && msg.subtype === 'init' && !runnerSessionIdSent) {
    runnerSessionIdSent = true;  // Set BEFORE the await so a re-entrant init can't double-fire.
    if (conversationId !== null) {
      try {
        await client.call('conversation.store-runner-session', {
          conversationId,
          runnerSessionId: msg.session_id,
        });
      } catch (err) {
        process.stderr.write(
          `runner: conversation.store-runner-session failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        // Non-fatal. The conversation just won't get the resume optimization
        // on next restart; it'll fall back to fetch-history replay.
      }
    }
    continue;
  }
  if (msg.type === 'assistant') {
    // ... existing block
  }
  // ... existing other branches
}
```

Note: the SDK's exact message shape is `{ type: 'system', subtype: 'init', session_id: string, ... }`. Verify against `node_modules/@anthropic-ai/claude-agent-sdk/dist/.../types.d.ts` before committing.

Run: tests pass.

**Step 3: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts packages/agent-claude-sdk-runner/src/__tests__/
git commit -m "feat(claude-sdk-runner): capture system/init session_id and bind to conversation"
```

### Task 4: HOME redirect for the SDK subprocess

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/` (integration test)

**Step 1: Write the failing integration test**

The test boots the runner pointing at a stub SDK that writes a known file `~/.claude/projects/<sessionId>.jsonl` with content `<some bytes>`. After one turn, assert `existsSync(<workspaceRoot>/.claude/projects/<sessionId>.jsonl) === true` and the bytes match.

This proves HOME is set such that the SDK's writes land in the workspace.

Run: tests fail (HOME=/nonexistent → SDK can't write).

**Step 2: Override HOME in the SDK invocation**

In `main.ts:344-385`, the `query({ ..., options: { ..., env: proxyStartup.anthropicEnv } })` block. The `env` field is what gets passed to the SDK subprocess. Extend it:

```ts
options: {
  env: {
    ...proxyStartup.anthropicEnv,
    HOME: env.workspaceRoot,  // Phase C-1: SDK writes ~/.claude/projects/<sessionId>.jsonl
                              // into the workspace where git-status captures it.
                              // Pod-level HOME stays /nonexistent for git paranoia;
                              // this override applies only to the SDK subprocess.
  },
  cwd: env.workspaceRoot,
  ...
}
```

Add a comment block above explaining the WHY (sandbox-k8s pod sets HOME=/nonexistent for git paranoia at the pod level; the SDK needs HOME pointed at the workspace so its native session jsonl lands where git-status sees it; the runner-process git operations still use the pod-level HOME=/nonexistent inherited from `process.env` because we don't override their env).

Run: tests pass.

**Step 3: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts packages/agent-claude-sdk-runner/src/__tests__/
git commit -m "feat(claude-sdk-runner): HOME redirect for SDK subprocess"
```

### Task 5: Verify SDK exposes `resume(sessionId)` (gating Task 6)

Quick check before writing C-3 code:

```bash
grep -rn "resume" node_modules/@anthropic-ai/claude-agent-sdk/dist/ | grep -v ".map" | head -10
```

Look for `resume?: string` or similar in the `Options` type.

**If present:** continue to Task 6.
**If absent:** stop. Skip Task 6 entirely; move to Task 7 (branch deletion). Document in the PR description: "C-3 (env-driven resume) is deferred — SDK doesn't yet expose `resume()`. Will revisit when it does."

This is a CHECK, not a commit.

### Task 6: Use SDK `resume(sessionId)` instead of replay-from-DB

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/` (integration test)

**Step 1: Write the failing integration test**

Test case: a conversation row with a non-null `runner_session_id` triggers `resume:` mode in the SDK invocation, and the runner does NOT call `conversation.fetch-history`. Use a stub SDK that records its `Options` argument and a stub IPC client that records calls.

Assertions:
- `query()` is called with `options.resume === <stored-sessionId>`.
- No call to `conversation.fetch-history` was made.
- For a conversation row WITHOUT `runner_session_id`: existing fetch-history-and-replay path runs (regression check).

Run: tests fail.

**Step 2: Plumb runner_session_id through `session.get-config` response**

Read `packages/ipc-protocol/src/actions.ts` for the `SessionGetConfigResponse` schema. Verify `runnerSessionId: z.string().nullable()` is already present. If not, add it (Phase B should have done this; if not, mirror the existing `conversationId` field's nullable shape).

**Step 3: Add the resume branch in main.ts**

In `main.ts:128-134`:
```ts
const cfg = ...;
agentConfig = cfg.agentConfig;
conversationId = typeof cfg.conversationId === 'string' ? cfg.conversationId : null;
const runnerSessionId = typeof cfg.runnerSessionId === 'string' ? cfg.runnerSessionId : null;
```

Then in `main.ts:164-199` (the replay block):

```ts
let replayTurns: ConversationFetchHistoryTurn[] = [];
if (runnerSessionId === null && conversationId !== null) {
  // No prior runner session — fall back to fetch-history replay.
  try {
    const resp = (await client.call('conversation.fetch-history', { conversationId })) as ConversationFetchHistoryResponse;
    replayTurns = resp.turns;
  } catch (err) {
    process.stderr.write(`runner: conversation.fetch-history failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
```

Then in the `query({ options: { ... } })` block (line 346):
```ts
options: {
  env: { ...proxyStartup.anthropicEnv, HOME: env.workspaceRoot },
  cwd: env.workspaceRoot,
  ...(runnerSessionId !== null ? { resume: runnerSessionId } : {}),
  ...
}
```

Update the `userMessages()` generator to skip emitting replay turns when `runnerSessionId !== null` (since the SDK will resume internally and emitting old turns would double-replay them).

Update comments at lines 178-185 to reflect that resume IS now wired.

Run: tests pass.

**Step 4: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts packages/agent-claude-sdk-runner/src/__tests__/ packages/ipc-protocol/src/actions.ts
git commit -m "feat(claude-sdk-runner): use SDK resume(sessionId) when runner_session_id present"
```

### Task 7: Delete the parked branch

```bash
git branch -D feat/phase-c-pr-a-runner-read-transcript
```

Verify the branch is gone:
```bash
git branch | grep phase-c
# (no output expected)
```

This is NOT a commit on the Phase C branch — just local cleanup. Mention it in the PR description as a housekeeping note.

### Task 8: PR description

**File to create (gitignored, working note):** `docs/plans/2026-05-02-runner-owned-sessions-phase-c-pr-body.md`

Compose against the standard PR template:
- Summary: HOME redirect lands jsonl in `/permanent`; sessionId capture+bind populates the conversation row; resume() replaces replay; parked branch deleted.
- Boundary review: new IPC action `conversation.store-runner-session` mirrors `conversation.fetch-history` posture. ACL: bus-side `conversations:store-runner-session` already runs `agents:resolve` gate (Phase B's posture). No new payload fields leak.
- Test plan: integration tests across runner + ipc-core + ipc-protocol; canary-acceptance test asserting jsonl lands in workspace after one turn.
- Half-wired window CLOSED: `conversations:store-runner-session` (Phase B) is now reachable from the runner via `conversation.store-runner-session` IPC.

**Commit:** None (PR body, not committed).

---

## Test plan

After all tasks land:

- [ ] `pnpm build` — clean.
- [ ] `pnpm --filter @ax/ipc-protocol test` — schemas pass.
- [ ] `pnpm --filter @ax/ipc-core test` — handler passes.
- [ ] `pnpm --filter @ax/agent-claude-sdk-runner test` — runner integration tests pass.
- [ ] `pnpm --filter @ax/preset-k8s test` — full preset acceptance (the existing `local` and `git-protocol` cases still pass; ideally extended to assert jsonl-in-workspace post-turn).
- [ ] Manual canary in kind: deploy with `workspace.backend=git-protocol`, send a chat turn, kubectl-exec into the storage tier pod, confirm `<workspaceId>.git/refs/heads/main` has a commit whose tree contains `.claude/projects/<sessionId>.jsonl`.

---

## Boundary review (per CLAUDE.md)

For the new IPC action `conversation.store-runner-session`:

- **Alternate impl this hook could have:** the IPC action wraps a bus hook; alternate impl is "the bus hook is called directly" (which it can't be, because the runner is a separate process from the host). The IPC layer is the only way the runner can reach the host bus.
- **Payload field names that might leak:** `conversationId`, `runnerSessionId` — generic. The `runnerSessionId` is SDK-shaped (a UUID-like string today) but the wire treats it as an opaque string. Not a leak.
- **Subscriber risk:** N/A — the bus hook is service-shaped, no subscribers.

For the runner's HOME override:

- **Alternate impl:** isolated subdir vs. workspace root (resolved by Q1 above). The choice is documented in the source comment so a future engineer knows why.
- **Payload field names:** N/A (no hook surface change).

---

## Migration & rollback

This is a runner-only change plus one small IPC action. No data migration. Rollback is a revert.

**Caveat:** once Task 6 ships, runners on conversations with `runner_session_id` set will use `resume()`. If we revert Task 6, those conversations fall back to fetch-history replay — which still works. So Task 6 is safely revertable without data loss.

Tasks 1+2 (IPC action) are additive; Tasks 3+4+6 modify runner behavior. If anything goes wrong in production, revert in reverse order.

---

## What I want from you before I start

Three sign-offs:

1. **Q1 (HOME target).** Workspace root vs. isolated subdir — recommended workspace root. OK?
2. **Q2 (SDK resume support).** I'll verify before Task 6; if absent, I'll skip Task 6 and document. OK?
3. **Q3 (IPC action shape).** New action mirroring `conversation.fetch-history` pattern — recommended. OK?

After those, I'll start at Task 1.
