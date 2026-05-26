# Runner-owned sessions — design

**Date:** 2026-04-29
**Status:** Design draft, implementation pending
**Author:** Vinay Pulim (with Claude)
**Supersedes (partial):** the host-as-source-of-truth transcript model in `2026-04-23-week-10-12-handoff.md` (Tasks 3, 9, 15)

## Goal

Move conversation transcript ownership out of the host DB and into the runner's native session storage inside the workspace. The host keeps a thin metadata table for sidebar / list views; full transcripts live in the runner's on-disk format (e.g. `.claude/projects/<cwd>/<sessionId>.jsonl` for the Claude SDK runner) and are persisted by the workspace plugin.

This eliminates replay (token-quadratic in one-shot mode), eliminates the duplicate-yield bug at the channel-web → orchestrator → runner boundary, and gives the host UI full block fidelity for free.

## Why

### What's broken today

1. **Replay is wasteful.** The runner can't use the SDK's `resume(sessionId)` because the host doesn't track the SDK session id. Instead, on every fresh runner spawn for an existing conversation, the runner fetches the full transcript from `@ax/conversations` and yields every prior user turn back into the SDK's prompt iterator — generating an assistant response per yielded turn. In one-shot runner mode (default for the CLI, plausibly default elsewhere), every follow-up message respawns a runner. Cost is **quadratic** in the number of turns: a 50-turn conversation pays for ~1275 model calls instead of 50.

2. **Duplicate user-turn yield (Codex finding 1).** On a fresh-session-with-conversation path, channel-web appends the user turn to the host DB before dispatch, the orchestrator queues the same message into the runner's inbox via `session:queue-work`, and the runner's replay-at-boot then yields the just-appended turn AGAIN from history. The model is invoked twice for the active turn, and a duplicate assistant turn lands in the conversation row.

3. **Host-DB transcripts are a lossy projection.** `@ax/conversations` stores `ContentBlock[]` per turn — a deliberate subset of what the SDK actually emits. The SDK's jsonl stores thinking signatures, tool-use lineage, request ids, token usage, hook outputs, file-history snapshots, etc. Anything not in the canonical projection is dropped. This makes faithful resume impossible (which is why the runner regenerates from user-side context — see #1).

### What the SDK already gives us

The Claude Agent SDK supports clean session resume:

```typescript
query({
  prompt: "next user message",
  options: { resume: sessionId }
})
```

The sessionId is captured from the `system/init` message at first turn (`message.sessionId`). On resume, the SDK loads the full conversation state from its jsonl and continues — no token replay, no host reconstruction.

The jsonl format already carries everything the UI could want (verified by inspection of `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/*.jsonl`):
- `text`, `thinking` (with `signature`), `tool_use`, `tool_result` content blocks
- model id, request id, full token-usage stats, cache stats
- system messages: `init`, `stop_hook_summary`, `turn_duration`
- hook outputs, file-history snapshots, last-prompt markers

This is strictly richer than `@ax/conversations`'s `ContentBlock[]` projection. We've been writing a lossy summary alongside the SDK's lossless one.

### The insight

Each runner already has a native session format inside the workspace:
- `agent-claude-sdk-runner` → `.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
- `agent-native-runner` (pi coding) → `.pi/agent/sessions/...`
- Future runners → whatever format their underlying agent uses

Letting the runner own its session in its native format, persisted via the workspace plugin, removes the host-side transcript table entirely. The host only needs metadata (id, title, agent binding, last-activity timestamp) — the kind of thing a sidebar query needs.

## Scope

### In scope
- Runner plugin owns transcript storage in its native format, inside the workspace.
- `@ax/conversations` shrinks to a metadata table — same row-per-conversation, but no `turns` table.
- New service hook `runner:read-transcript` (host-side, runner-plugin-owned) returns universal `UITurn[]`.
- SDK's `resume(sessionId)` replaces the runner's replay-at-boot code.
- HOME-redirect for the SDK so jsonl lands inside the workspace.
- `workspaceRef` freezes onto the conversation row at creation time (mirroring I10's session-agent immutability).

### Out of scope
- LLM-generated titles. Tracked as deferred in §"Deferred work"; doesn't gate the migration.
- Multi-runner-type dispatch. Single runner plugin per host for the MVP; router pattern is a clean follow-up.
- Full-text search across history. The host has no `turns` table, so cross-conversation grep needs a separate index. Deferred.
- Cross-runner transcript portability. The host doesn't translate between runner formats; each runner plugin owns its own.

## Architecture

```
┌─ host DB (postgres) ──────────────────────────┐
│ @ax/conversations: thin metadata + ACL gate  │
│   conversation row only — NO turns table     │
└───────────────────────────────────────────────┘
       ▲
       │ list / search / sidebar
       │
┌─ channel-web ─────────────────────────────────┐
│ GET /conversations          → conversations:list           │
│ GET /conversations/:id/turns → runner:read-transcript      │
│ POST /chat/messages         → agent:invoke                 │
└───────────────────────────────────────────────┘
                        │
                        ▼
┌─ runner plugin (host-side, e.g. claude-sdk) ──┐
│ runner:read-transcript                        │
│   reads jsonl via workspace:read,             │
│   parses into UITurn[]                        │
└───────────────────────────────────────────────┘
                        │ persists via
                        ▼
┌─ workspace plugin (workspace-git-http) ───────┐
│ persists workspace tree (incl. session jsonl) │
└───────────────────────────────────────────────┘
                        ▲
                        │
┌─ runner sandbox (subprocess, ephemeral) ──────┐
│ SDK writes <workspace>/.claude/projects/…    │
│ HOME redirected to workspace root             │
│ first turn: captures sdkSessionId from init  │
│ subsequent: query({ resume: sdkSessionId })  │
└───────────────────────────────────────────────┘

                ┌─ deferred ─┐
                │ @ax/conversation-titles    │
                │   subscribes chat:turn-end │
                │   LLM titler → set-title   │
                └────────────────────────────┘
```

### Component responsibilities

**`@ax/conversations`** — metadata + ACL gate
- Owns the `conversations` row table (see §"Data shapes").
- Registers `conversations:create`, `conversations:get`, `conversations:list`, `conversations:get-metadata`, `conversations:set-title`, `conversations:bind-session`, `conversations:delete`, `conversations:store-runner-session`.
- **Drops:** `conversations:append-turn`, `conversations:fetch-history`, the `conversation_turns` table.
- ACL gating via `agents:resolve` stays unchanged. Tenant scoping (Week 9.5) stays unchanged.

**Runner plugin (e.g. `@ax/agent-claude-sdk-runner`)** — host-side
- Registers `runner:read-transcript` (and, eventually, `runner:delete-session` for cleanup-on-conversation-delete).
- The hook handler runs on the host process, NOT in a sandbox subprocess. No IPC required for reads.
- Implementation: load conversation metadata → resolve workspace ref → read jsonl via `workspace:read` → parse into `UITurn[]`.
- Knows the runner's native format because it's the same plugin that configures the sandbox spawn.

**Runner sandbox** — subprocess, per-chat
- The SDK writes its native session format directly. We don't intermediate.
- Receives `HOME=<workspace-root>` in env so the SDK lands files inside the workspace.
- First turn: captures `system/init.sessionId`, sends it back to the host via a one-shot IPC (`session.bind-runner-session`). Host writes it to `conversations.runner_session_id`.
- Subsequent spawns: orchestrator passes the stored `runnerSessionId` via env; runner calls `query({ resume: runnerSessionId, prompt: <new user message> })`.

**Workspace plugin (`workspace-git-http`)**
- Already persists the workspace tree. Session files now ride along with everything else.
- `workspace:read` is the read API the runner plugin uses — keeps the runner plugin storage-backend-agnostic (git today, GCS or whatever tomorrow).

**`channel-web`**
- POST `/api/chat/messages`: stops appending the user turn before dispatch. Just dispatches `agent:invoke`. The runner persists into its jsonl as part of normal SDK operation.
- GET `/api/conversations`: calls `conversations:list` for the sidebar.
- GET `/api/conversations/:id/turns`: calls `runner:read-transcript`. Returns `UITurn[]`.

**`@ax/conversation-titles`** — deferred
- Subscribes to `chat:turn-end`. After first user message (or message-count threshold), calls a small LLM to generate a title; calls `conversations:set-title` to persist.
- Independent of runner type — title generation is a "summarize a conversation" task that doesn't need to know the runner's native format. The subscriber receives the universal `UITurn` view of the latest turn from `chat:turn-end`'s payload.

## Data shapes

### Conversation row (host DB, post-migration)

```sql
CREATE TABLE conversations_v2_conversations (
  conversation_id      UUID PRIMARY KEY,
  user_id              TEXT NOT NULL,
  agent_id             TEXT NOT NULL,

  -- Runner identity. Frozen at conversation creation; mirrors I10
  -- (session-agent immutability).
  runner_type          TEXT NOT NULL,    -- 'claude-sdk' | 'native' | …
  runner_session_id    TEXT,             -- nullable until first turn binds
  workspace_ref        JSONB NOT NULL,   -- frozen copy of agent.workspaceRef

  -- Sidebar projection. Maintained via subscribers; not load-bearing for
  -- chat correctness.
  title                TEXT,
  summary              TEXT,
  last_turn_preview    TEXT,
  last_activity_at     TIMESTAMPTZ NOT NULL,

  -- Routing (existing).
  active_session_id    TEXT,
  active_req_id        TEXT,

  created_at           TIMESTAMPTZ NOT NULL,
  deleted_at           TIMESTAMPTZ
);
```

The `conversation_turns` table goes away entirely.

### Universal UI turn

```ts
// Reuses the existing ContentBlock schema from @ax/conversations.
export interface UITurn {
  role: 'user' | 'assistant' | 'tool';
  contentBlocks: ContentBlock[];
  turnIndex: number;
  timestamp: string;
}
```

Each runner plugin's `runner:read-transcript` implementation produces this shape from its native format. Channel-web renders directly from this.

### Hook surface (additions)

```ts
// Service hook — registered by the runner plugin (one per host, MVP).
'runner:read-transcript' (
  ctx: AgentContext,
  input: { conversationId: string; range?: { afterTurnIndex?: number; limit?: number } }
) → { turns: UITurn[]; hasMore: boolean }

// Service hook — registered by @ax/conversations.
'conversations:get-metadata' (
  ctx,
  { conversationId, userId }
) → { conversationId, agentId, runnerType, runnerSessionId, workspaceRef, … }

// Service hook — registered by @ax/conversations.
// Called by the orchestrator (or by the runner via IPC) after first-turn
// system/init lands.
'conversations:store-runner-session' (
  ctx,
  { conversationId, runnerSessionId }
) → void

// Service hook — deferred, registered by @ax/conversation-titles.
'conversations:set-title' (
  ctx,
  { conversationId, title }
) → void
```

### Hook surface (removals)

- `conversations:append-turn` — gone. The runner's SDK persists turns to jsonl directly.
- `conversations:fetch-history` — gone. Replaced by `runner:read-transcript`.

## Key design decisions

### D1: HOME redirect for SDK storage location

The Claude Agent SDK writes to `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. We need it inside the workspace.

**Approach:** sandbox passes `HOME=<workspace-root>` in the runner subprocess env. The SDK then writes to `<workspace-root>/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`, which the workspace plugin persists naturally.

**Why:** simpler than a bind-mount; works for both subprocess and k8s sandboxes. The runner already sets `cwd: env.workspaceRoot` (`main.ts:316`), so `<sanitized-cwd>` is stable across spawns.

**Verify before relying on:** small spike — set HOME, run a one-turn `query()`, check the jsonl lands at the expected path. Then run a second `query({ resume: sessionId })` against the same HOME and assert the SDK picks up the prior context.

**Alternate approach considered:** bind-mounting `~/.claude/projects/<cwd>` to a workspace path. Rejected — more sandbox-specific plumbing, doesn't generalize cleanly to k8s.

### D2: Runner plugin (host-side) handles transcript reads, not the sandbox

The plugin lives in the host process and is always available. The sandbox is ephemeral. Reading transcripts must work for closed conversations (no live sandbox), and sidebar rendering must not require subprocess startup.

Pure file I/O on the host via `workspace:read`. No IPC, no subprocess.

The active-sandbox lag is accepted: if a sandbox is mid-turn, its latest unflushed text doesn't show in a transcript read. The streaming path (SSE `event.stream-chunk`) handles in-flight rendering; transcript reads handle "what's persisted." Convergence at turn-end. Drain-on-read is rejected as too complex for the boundary it'd close.

### D3: `workspaceRef` freezes onto the conversation row

The agent's `workspaceRef` could change after a conversation is created (re-pointing the agent at a different workspace). If we always dereferenced via the agent, old transcripts would suddenly become unreadable.

Mirror I10 (session-agent immutability): copy the agent's workspaceRef onto the conversation row at create time. Older conversations stay readable even if the agent's pointer moves.

### D4: Runner plugin (host-side) parses native format → universal `UITurn[]`

Format knowledge stays co-located with the runner that produced the format. `@ax/agent-claude-sdk-runner` knows jsonl. `@ax/agent-native-runner` knows pi sessions. Channel-web sees only `UITurn[]` and never has to learn either format.

### D5: Single runner plugin per host (MVP); router pattern as follow-up

Service hooks are exclusive — only one plugin can register `runner:read-transcript`. With multiple runner plugins loaded, that's a boot-time collision.

For the MVP, only one runner plugin loads. Trivial. Defers the dispatch problem until it's actually needed.

When a second runner ships in production, add an `@ax/runner-router` plugin: registers the unified `runner:read-transcript`, dispatches to runner-typed hooks (`runner.claude-sdk:read-transcript`, `runner.native:read-transcript`) based on `conversation.runner_type`. The plugin manifest gets a `runner.type` field so the router builds its dispatch table structurally rather than by string concatenation. Caller code (channel-web) doesn't change — same hook name, only registration plumbing under it.

### D6: Title generation in a separate plugin (deferred)

Title generation is a "summarize a conversation" task — runner-agnostic. Putting it in the runner couples it to LLM-call ergonomics that should evolve independently (cheap model? prompt? when-to-regenerate?). A standalone subscriber on `chat:turn-end` keeps it tidy.

Stub the column now; add the plugin later. Doesn't gate the migration.

### D7: First-turn flow — runner reports its sessionId back to host

Orchestrator opens a fresh sandbox. Runner spawns, calls `query({ prompt: msg })` (no `resume` on first turn). Captures `system/init.sessionId`. Sends it back via a one-shot IPC `session.bind-runner-session`. The corresponding host-side handler fires `conversations:store-runner-session` to persist. Subsequent spawns receive the runnerSessionId via env at boot.

The bind happens once per conversation, lazily, on the very first turn. Subsequent turns reuse the stored value.

## Migration sequence

The migration is a series of small PRs, each shippable on its own. The order matters because we want to keep `pnpm build && pnpm test` green at every step.

### Phase A: HOME-redirect spike

Tiny exploratory PR. Set HOME on the runner subprocess to a temp workspace path; run a one-turn `query`; assert the jsonl lands at the predicted path; run a second `query({ resume: sessionId })`; assert it picks up context.

Goal: validate D1 before committing the whole design to it. This is the load-bearing fact.

### Phase B: Conversations metadata schema + new hooks

Add the new columns (`runner_type`, `runner_session_id`, `workspace_ref`, `title`, `summary`, `last_turn_preview`, `last_activity_at`) to the existing conversations table. Add `conversations:get-metadata`, `conversations:store-runner-session` hooks. Keep the old turns table and old hooks alive — no caller switches yet.

This is a pure additive change. No behavior changes; no caller migrations.

### Phase C: Runner-side jsonl handling

Runner subprocess: HOME redirect (from Phase A), `system/init` capture, IPC back to host to bind the sessionId, env-driven `resume` on subsequent spawns.

Runner plugin (host-side): register `runner:read-transcript`. Implementation reads jsonl via `workspace:read`, parses to `UITurn[]`.

Replay code stays in place; we're not deleting it yet. Both paths are operative side-by-side. Tests pin: a fresh-session resume path sees the same turns whether it goes through replay (old) or `runner:read-transcript` (new).

### Phase D: Channel-web reads via new path

`GET /api/conversations/:id/turns` switches from `conversations:fetch-history` to `runner:read-transcript`. POST `/api/chat/messages` stops appending the user turn before dispatch.

This is the user-visible cutover. The duplicate-yield bug (Codex finding 1) goes away as a side effect — there's no longer a turn to be in two places.

Tests: assert that channel-web's transcript view renders thinking blocks, tool calls, and tool results from the jsonl.

### Phase E: Delete replay code, fetch-history hook, append-before-dispatch

Now that no caller depends on replay, rip it out. `userMessages()` in the runner becomes inbox-only. `conversations:fetch-history` and the IPC handler go away. `conversations:append-turn` goes away. The conversation_turns table gets dropped.

Pure deletion PR. Smallest possible diff after the previous phases laid the groundwork.

This phase also closes I-NEW-1 through I-NEW-4 (see §"Invariants").

### Phase F: Title plugin (deferred, parallel)

Optional, can ship before, during, or after E. Just adds new behavior; doesn't gate anything.

## Open questions

### Q1: How does the orchestrator pass `runnerSessionId` to the runner subprocess on resume?

Most natural answer: env var. The `sandbox:open-session` payload already accepts owner/agentConfig fields; adding `runnerSessionId?: string` to the input shape and threading it into the runner env is small. Runner reads it at boot, calls `query({ resume })` if set.

### Q2: Workspace concurrency for shared agent workspaces

If `agent.workspaceRef` is shared across all conversations of an agent, two runners writing simultaneously share `<workspace>/.claude/projects/<cwd>/`. Different jsonl files per session id, so file-level no conflict; workspace-commit-level concurrency is handled by `workspace-git-http`'s optimistic concurrency.

The harder question — concurrent writes to user code files in a shared workspace — exists today and is unaffected by this design. Solving it (per-conversation branches? per-agent trunk + merging? lock?) is a separate workspace-plugin design decision.

### Q3: Cleanup on conversation delete

Soft-deletes (`deleted_at` set) leave the jsonl in place — users sometimes restore. Hard-deletes need to remove the jsonl too. Add `runner:delete-session` to the runner plugin's hook surface; `conversations:delete` fires a subscriber `conversation:on-delete` (or calls the service hook directly) so the runner plugin can clean up its file.

### Q4: Search across history

Without a `turns` table, full-text search across all conversations means scanning every jsonl in every workspace — slow at scale. If we need this, we add a host-side search index (e.g. a `searchable_turns` table maintained by a subscriber on `chat:turn-end`, or a separate index store). This is a clean follow-up because the host is no longer the source of truth — the index can lag without breaking correctness.

### Q5: Is HOME-redirect actually safe for everything the SDK reads/writes?

The runner already sets `settingSources: []` (SDK isolation mode — no `~/.claude/CLAUDE.md`, no project settings, no user prefs). But the SDK might still write things outside `projects/` under HOME (cache, telemetry, etc.). A workspace-rooted HOME would mean those files end up persisted in the workspace too. Probably fine — we want a clean per-session HOME anyway — but worth checking during Phase A.

## Invariants (this design adds)

- **I-NEW-1.** Transcripts live in the runner's native on-disk format inside the workspace. The host DB never stores turn content.
- **I-NEW-2.** The runner plugin (host-side, always loaded) handles `runner:read-transcript`. The sandbox subprocess is not involved in reads.
- **I-NEW-3.** `workspaceRef` is frozen onto the conversation row at creation time, mirroring I10 (session-agent immutability).
- **I-NEW-4.** First-turn flow is the only path that mints a `runnerSessionId`; subsequent spawns always resume via env-passed id.

## Boundary review (per `ax-conventions`)

### `runner:read-transcript`

- **Alternate impl this hook could have:** `agent-native-runner` for pi coding agent — different on-disk format, same `UITurn[]` output. Concrete second impl exists in the design.
- **Payload field names that might leak:** `conversationId` is a kernel-level primitive. `range.afterTurnIndex` is a generic pagination concept, not runner-specific. None leak.
- **Subscriber risk:** none — service hook with one registrar.
- **Wire surface:** read calls flow channel-web → host hook bus → runner plugin. No IPC out to a sandbox; no schema needed in `ipc-schemas`. The runner-side IPC for `session.bind-runner-session` (Phase C) lives in the runner plugin's directory per convention.

### `conversations:get-metadata`

- **Alternate impl:** none today; this is a thin wrapper around the metadata table. Belongs as a hook because callers (router plugin in the future, runner plugin) shouldn't import `@ax/conversations` directly.
- **Payload leakage:** `runnerSessionId` is opaque at this layer (string). `workspaceRef` is the existing `WorkspaceRef` type. Nothing git-shaped, postgres-shaped, or filesystem-shaped.
- **Subscriber risk:** none — service hook.

### `conversations:store-runner-session`

- **Alternate impl:** any metadata store. Postgres today, sqlite or kv-store tomorrow.
- **Payload leakage:** `runnerSessionId` is opaque to host. No leakage.
- **Subscriber risk:** an `audit-log` subscriber might want to observe the bind — but that's an additive subscriber on a future event, not a service-hook concern.

## Relationship to other in-flight work

- **Codex finding 1 (duplicate user-turn yield):** evaporates at Phase D. No bandaid needed in the meantime — the design supersedes the duplication path entirely.
- **Codex findings 2/3/4:** independent. Hook bus enforcement (finding 2), workspace facade (finding 3), and manifest-source-of-truth (finding 4) all proceed on their own tracks.
- **Phase 6 PR-A (legacy plugin deletion, shipped):** unaffected. This design works on top of the post-PR-A surface.
- **Future Phase 7 / multi-tenant:** unaffected. Tenant scoping stays in `@ax/conversations`'s shrunken metadata table.

## Out-of-band notes

- The migration assumes no production user data to migrate. If conversations exist in the DB at cutover, write a migration that derives `runnerType` (constant, since one runner type is loaded) and leaves `runnerSessionId` null — old conversations get re-bound on next access. Old transcript data in the dropped table is lost; if that matters, dump it first.
- The `conversation-titles` plugin is the natural place to also generate `summary` and `last_turn_preview`. Or those can be cheap projections done in a `chat:turn-end` subscriber inside `@ax/conversations` itself, since they don't require an LLM call.
