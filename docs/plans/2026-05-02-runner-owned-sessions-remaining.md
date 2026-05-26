# Runner-owned sessions — Phase C–F remaining work

**Status:** Working note (gitignored)
**Date:** 2026-05-02
**Refs:** `2026-04-29-runner-owned-sessions-design.md` (the original design), `2026-05-01-workspace-redesign-design.md` (the redesign that subsumed parts of Phase C)

---

## Context

Two overlapping design docs are in flight:

- **Runner-owned sessions** (2026-04-29) shifts transcript ownership from the host postgres DB into runner-native files inside the workspace. Six phases A–F.
- **Workspace redesign** (2026-05-01) reshapes the storage tier, sandbox layout, and validator hooks. Five phases 1–5.

Phase 3 of the workspace redesign accidentally ate ~60% of Phase C of the runner-owned-sessions design — the `git-status`-at-turn-end mechanism captures any byte the agent writes to `/permanent`, including jsonl, so the original "fetch transcript via IPC" plumbing the parked branch was building is now dead code.

This doc enumerates the remaining work to complete Phases C–F of the runner-owned-sessions design as it stands today.

---

## State as of 2026-05-02

**Workspace redesign:**

| Phase | Status | Evidence |
|---|---|---|
| 1 (storage tier) | ✅ Shipped | PR #30 |
| 2 (host plugin + preset wiring) | ✅ Shipped | PR #31 |
| 3 (bundle wire + git-status diff + skill validator) | ✅ Shipped | PR #32, merge `35c8502` |
| 4 (identity validator) | ⏳ Pending | — |
| 5 (legacy decom) | ⏳ Pending | — |

**Runner-owned sessions:**

| Phase | Status | Notes |
|---|---|---|
| A (HOME-redirect spike) | ✅ Done | spike validated D1; no production change yet |
| B (conversations metadata + hooks) | ✅ Shipped | PR #29; `conversations:store-runner-session` hook surface exists, no callers |
| C (runner jsonl handling) | ⏳ ~60% subsumed by workspace redesign Phase 3; three small items still TODO |
| D (channel-web cutover) | ⏳ Pending; smaller than originally planned |
| E (delete replay code) | ⏳ Pending; gated on D |
| F (title plugin) | ⏳ Deferred-anytime; ships independently |

The parked branch `feat/phase-c-pr-a-runner-read-transcript` (5 commits) has been moot since Phase 3 of the workspace redesign shipped — `runner:read-transcript` IPC is obsolete because the host can read from the storage tier directly via `workspace:read`. **The branch should be deleted.**

---

## Phase C residue — three small items

### C-1. HOME redirect for the SDK

**Why it matters:** Phase 3 of the workspace redesign shipped `git-status`-at-turn-end on `/permanent`. That mechanism captures every byte the agent writes there — including `.claude/projects/<sessionId>.jsonl` — IF the SDK actually writes the jsonl into `/permanent`. Today it doesn't, because:

- `packages/sandbox-k8s/src/pod-spec.ts:81` sets `HOME=/nonexistent` for the entire pod (correct for git paranoia: prevents `git init`/`commit` from reading user-global config).
- `packages/agent-claude-sdk-runner/src/main.ts:344-369` invokes `query({ ..., cwd: env.workspaceRoot })` but doesn't override `HOME` for the SDK. So the SDK inherits `HOME=/nonexistent` and its jsonl writes have nowhere to land.

**Net:** the workspace redesign's jsonl-gap closure is theoretical right now. Pipes are in place; nothing flows through them.

**Fix shape:**

The runner needs to spawn the SDK with `HOME=<workspace-root>` (or specifically `<workspace-root>/.ax/sessions-home/` if we want to isolate SDK state from agent project files). The git binary in the same pod still needs paranoid HOME (`/nonexistent`), but that's already the case because `sandbox-k8s/pod-spec.ts` sets the pod-level HOME, and the runner can override it ONLY for the SDK subprocess via `query({ env: { ..., HOME: ... } })`.

Concrete change:
- `packages/agent-claude-sdk-runner/src/main.ts:344-369` — extend the `env` passed to `query()` with `HOME: env.workspaceRoot` (or a subdir).
- Add a test that the SDK's session jsonl ends up under `/permanent/...` after a turn — easiest path is an integration test booting a stub SDK that writes a known file under `~/.claude/projects/<sessionId>.jsonl`, then asserting `git status --porcelain` shows it.
- Update `packages/sandbox-k8s/src/pod-spec.ts` comments to clarify pod-level HOME stays `/nonexistent` for git paranoia; the runner overrides per-subprocess for the SDK.

**Risk:** the SDK may write more than just jsonl under HOME (`.claude.json`, `.claude/backups/`, `.claude/policy-limits.json`). Phase A's spike noted this. Two options:
- (a) Accept all of it into the workspace (jsonl + auxiliary). Visible in workspace history; arguably useful for audit.
- (b) Send the SDK to a dedicated subdir (`~/.ax/sessions-home/.claude/projects/`) and have the runner symlink or copy just the jsonl into the canonical `.ax/sessions/` path.

**Recommend (a) for MVP** — auxiliary files in the workspace history is fine; we can split later if it becomes noisy.

**Estimated size:** 1 commit, ~20 lines + integration test.

### C-2. SessionId capture + bind

**Why it matters:** the host needs to know the SDK's internal session id so the conversation row in postgres can hold a stable pointer. Today `conversations:store-runner-session` exists as a hook (Phase B shipped it at `conversations/plugin.ts:240, 758`) but **no caller invokes it** — confirmed by grep.

**Fix shape:**

When the SDK emits its first `system/init` message, it includes `session_id`. The runner's turn loop needs to:

1. Pattern-match on the message stream for the `system/init` shape.
2. Extract `session_id`.
3. Call (over IPC) the host's `conversations:store-runner-session` (or whatever the IPC action is named — Phase B may have wired it under a different name; check `ipc-protocol/src/`).

Concrete change:
- `packages/agent-claude-sdk-runner/src/main.ts` — add a handler in the message-iteration loop that detects `system/init` and IPCs the sessionId to host once per session.
- IPC schema for the store-runner-session action — verify it exists in `ipc-protocol/`; if not, add it (mirroring `conversation.fetch-history` shape).
- Test: integration test asserting after one turn, the conversation row's `runner_session_id` column is populated.

**Risk:** `system/init` may not be the first message in all SDK paths (resume vs. fresh). Check the SDK's docs or behavior; capture-on-first-init-or-resume.

**Estimated size:** 1 commit, ~50 lines + test.

### C-3. Env-driven resume

**Why it matters:** today, `packages/agent-claude-sdk-runner/src/main.ts:187-199` calls `conversation.fetch-history` and replays user/tool turns into the SDK's prompt iterator. Comments at lines 178-185 explicitly note this is a workaround because `resume(sessionId)` was never wired. The workaround re-spends LLM tokens on every restart.

**Fix shape:**

Once C-2 ships and `runner_session_id` is populated, second-and-later runner spawns can:

1. Read `runner_session_id` from `session.get-config` response (the hook already returns it per `conversations/types.ts:69`).
2. If non-null, pass it to the SDK via `query({ resume: <sessionId> })` instead of replaying turns.
3. Skip the `conversation.fetch-history` round-trip entirely.

Concrete change:
- `packages/agent-claude-sdk-runner/src/main.ts:128-134` — extend `SessionGetConfigResponse` to include `runnerSessionId` if it isn't already.
- Lines 164-199 — if `runnerSessionId !== null`, use `resume:` and skip the fetch-history block.
- Lines 281+ comments — update to reflect resume IS now wired.
- Test: integration test where a runner restart on an existing conversation calls `resume` instead of `fetch-history`.

**Risk:** SDK's `resume(sessionId)` may not exist in the version we depend on, or may have different semantics. Verify against `@anthropic-ai/claude-agent-sdk` first. If not available, this stays blocked until the SDK ships it (or we open a feature request).

**Estimated size:** 1 commit, ~30 lines + test (assuming SDK supports it).

### C-4. Delete the parked branch

`feat/phase-c-pr-a-runner-read-transcript` (5 commits) is moot. None of its content carries over since the IPC route is dead. Delete after confirming no one is referencing it.

```bash
git branch -D feat/phase-c-pr-a-runner-read-transcript
```

**Estimated size:** 1 line.

---

## Phase D — channel-web cutover

### What changes

**Stop appending:** `chat-orchestrator/src/plugin.ts:77` declares `subscribes: ['chat:end', 'chat:turn-end']` and `conversations/src/plugin.ts:131` declares `subscribes: ['chat:turn-end', 'session:terminate']` — both subscribe to `chat:turn-end`, with the conversations plugin appending to `conversation_turns` via `appendTurn`. After Phase D, the conversations plugin's `chat:turn-end` subscriber drops the `appendTurn` call (or removes the subscription entirely if nothing else needs it).

**Switch reads:** today's path:

```
GET /api/chat/conversations/:id
  → routes-chat.ts:424
  → bus.call('conversations:get', ...)
  → fetchTurns from conversation_turns table
```

After Phase D:

```
GET /api/chat/conversations/:id
  → routes-chat.ts:424
  → bus.call('conversations:get', ...)
  → bus.call('workspace:read', { path: '.ax/sessions/<sessionId>.jsonl' })
  → parse SDK's native format → universal UITurn[]
```

The native-format parser is the same one the parked branch was building (`packages/agent-claude-sdk-runner-host/`). The package shape lives; only the IPC plumbing in it gets dropped.

### Sub-tasks

- **D-1.** Drop `appendTurn` from conversations plugin's `chat:turn-end` subscriber. Keep the subscriber if `last_activity_at` bump is still needed (it is — sidebar ordering).
- **D-2.** Add the host-side native-format parser. Likely a new package `@ax/runner-claude-sdk-format` or fold into an existing one. Inputs: jsonl bytes from `workspace:read`. Output: `UITurn[]`.
- **D-3.** Pivot `conversations:get` (or add a new `conversations:get-transcript` hook) to:
  1. Look up `runner_session_id` from the conversation row.
  2. `workspace:read` the jsonl.
  3. Run through the parser.
  4. Return `UITurn[]`.
- **D-4.** Update channel-web's `history-adapter.ts` to consume the new shape (likely no change if `Turn[]` and `UITurn[]` are wire-compatible; otherwise migrate).
- **D-5.** Canary test: open a conversation, send a turn, close runner, reload conversation in browser — turns visible without the appendTurn write path.

**Blocker:** all of D depends on C-1 (HOME redirect) actually putting jsonl under `/permanent`. Without C-1, `workspace:read` returns "not found" for every transcript path.

**Estimated size:** 5–8 commits, one PR.

---

## Phase E — delete replay code

After Phase D is live and soaked, delete:

- `conversation.fetch-history` IPC action (`ipc-core/src/dispatcher.ts:78`, `ipc-core/src/handlers/conversation-fetch-history.ts`).
- `conversations:fetch-history` hook + `fetchHistory` function (`conversations/src/plugin.ts:218, 819`).
- Replay-from-DB block in runner (`agent-claude-sdk-runner/src/main.ts:164-199`).
- `conversations:append-turn` hook + `appendTurn` function (`conversations/src/plugin.ts:158, 539, 565`).
- `appendTurn` from the store interface (`conversations/src/store.ts:270, 424`).
- `conversation_turns` table — DROP via a new migration.

Update the store types (`conversations/src/types.ts:271-274`) to drop the replay-related fields.

**Estimated size:** 4–6 commits, one PR. Mechanical; test suite catches regressions.

---

## Phase F — title plugin

Standalone optional plugin `@ax/conversation-titles` that:

- Subscribes to `chat:turn-end` (or a new `conversations:turn-recorded` hook).
- After N turns or on first user message, generates a title via a small LLM call.
- Calls `conversations:set-title` (new hook surface).

Doesn't gate anything else. Ships independently. Could go before Phase D/E if user-facing impact justifies.

**Estimated size:** 1 PR, 2–3 commits.

---

## Sequencing graph

```
                               ┌───────────────────────────────┐
Phase 3 of                     │  C-1 HOME redirect            │
workspace ──────────────────►  │  C-2 sessionId capture+bind   │
redesign                       │  C-3 env-driven resume        │
(shipped)                      │  C-4 delete parked branch     │
                               └─────────────┬─────────────────┘
                                             │
                                             ▼
                               ┌───────────────────────────────┐
                               │  Phase D — channel-web cutover │
                               │  (read pivots to workspace,    │
                               │   write side drops appendTurn) │
                               └─────────────┬─────────────────┘
                                             │
                                             ▼
                               ┌───────────────────────────────┐
                               │  Phase E — delete replay code  │
                               │  (mechanical cleanup)          │
                               └───────────────────────────────┘

                               ┌───────────────────────────────┐
                               │  Phase F — title plugin        │
Anytime, parallel ───────────► │  (independent, optional)      │
                               └───────────────────────────────┘
```

**Critical-path hypothesis:** C-1 → D → E. C-2 + C-3 are required for the resume optimization but don't gate Phase D's read-side cutover (D only needs C-1 to put jsonl under /permanent and the runner_session_id to be findable for the read-side lookup — which means C-2 IS needed for D's read path to find the right jsonl). So the ordering is: C-1 + C-2 first (parallel-safe), then D, then E. C-3 is parallel-safe alongside D/E but earns its keep most when E lands and the fallback replay is gone.

---

## Risks & open questions

1. **SDK `resume(sessionId)` availability.** C-3 depends on the `@anthropic-ai/claude-agent-sdk` exposing this. Verify before committing to C-3's shape; if not available, C-3 is blocked.

2. **HOME redirect side effects (C-1).** SDK writes auxiliary files (`.claude.json`, etc.) under HOME. They'll show up in workspace history. Acceptable for MVP; revisit if it becomes noisy.

3. **`conversations:get` semantic shift (D-3).** Today it returns DB-shaped turns; after Phase D it returns jsonl-derived turns. Subscribers (channel-web's history-adapter) may need to handle either shape during migration. Two-step plan: (a) add a new `conversations:get-transcript` hook returning the new shape, (b) migrate channel-web to it, (c) drop the old `conversations:get`'s turn-fetch and rename. Avoids a flag day.

4. **Title generation timing (F).** If F ships before D, the title plugin has no transcript to summarize until E lands and the source-of-truth shifts. F probably wants to wait until after D, OR consume turns from the wire (chat:turn-end) directly so it's source-agnostic.

5. **Phase 4 / Phase 5 of the workspace redesign are still pending.** Phase 4 (identity validator) is independent of all of the above. Phase 5 (legacy decom) shouldn't touch any of the runner-owned-sessions code paths. They can land in any order relative to C-F.

6. **Concurrent jsonl writes during turn execution.** SDK writes to jsonl as it processes; `git-status`-at-turn-end happens after the turn completes. Race-free in the common case; verify there's no SDK background write that races against the bundle creation.

---

## Estimated total

- C-1 + C-2 + C-3 + C-4: ~3 small PRs (one per item, except C-4 which folds into one of them). 1–2 days each.
- D: 1 medium PR. 3–5 days.
- E: 1 small PR. 1–2 days.
- F: 1 small PR. 2 days.

**Total: ~2 weeks of focused work** to land C–E in order; F whenever.
