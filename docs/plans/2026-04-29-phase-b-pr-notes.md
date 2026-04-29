# Phase B — PR notes

**Branch:** `feat/phase-b-conversations-metadata`
**Plan:** `docs/plans/2026-04-29-phase-b-conversations-metadata-impl.md`
**Design doc:** `docs/plans/2026-04-29-runner-owned-sessions-design.md`
**Predecessor:** Phase A (spike merged 2026-04-29) — verified the runner subprocess can redirect HOME so the SDK writes its native session files into the per-conversation workspace. Phase B opens the host-side surface for those files; Phase C closes it.

## What lands

The additive piece of the runner-owned-sessions migration. Four metadata columns + two new service hooks land on `@ax/conversations`. Zero behavior changes for existing callers; the old turns table and old hooks stay alive.

| Slice | Change |
|---|---|
| `migrations.ts` | `ALTER TABLE conversations_v1_conversations ADD COLUMN IF NOT EXISTS runner_type TEXT, runner_session_id TEXT, workspace_ref TEXT, last_activity_at TIMESTAMPTZ` — all nullable. Pure-additive. Re-runnable. |
| `types.ts` (`Conversation`) | Adds `runnerType`, `runnerSessionId`, `workspaceRef`, `lastActivityAt` (all `string \| null`). |
| `types.ts` (`ConversationsConfig`) | New `defaultRunnerType?: string` knob (default `'claude-sdk'`). Single-runner-per-host MVP (design D5). |
| `store.ts` | New validators: `validateRunnerType`, `validateWorkspaceRefForFreeze`. New methods: `getMetadata` (read-only projection), `storeRunnerSession` (idempotent compare-and-set), `bumpLastActivity` (subscriber-friendly UPDATE). `ConversationStoreCreateArgs` gains optional `runnerType` + `workspaceRef`. |
| `plugin.ts` (`createConversation`) | Captures the resolved agent from `agents:resolve` (no new bus call) and freezes its `workspaceRef` onto the new row. `runner_type` comes from the new config knob. |
| `plugin.ts` (new hooks) | `conversations:get-metadata` (same ACL posture as `:get`). `conversations:store-runner-session` (idempotent first-bind, conflict on mismatch). |
| `plugin.ts` (`chat:turn-end` subscriber) | Bumps `last_activity_at` after a successful `:append-turn`. Heartbeats stay heartbeats. |
| `index.ts` | Public exports: `GetMetadataInput`/`Output`, `StoreRunnerSessionInput`/`Output`, `ConversationMetadata`, `StoreRunnerSessionResult`, `validateRunnerType`, `validateWorkspaceRefForFreeze`. |

Per-package test count: 13 test files / 90 tests, up from 6 / 58 at branch fork. Five new test files: `migrations.test.ts`, `types-shape.test.ts`, `store-phase-b.test.ts`, `create-freezes.test.ts`, `get-metadata.test.ts`, `store-runner-session.test.ts`, `last-activity.test.ts`.

## WINDOW OPEN — closed by Phase C

Both new service hooks have **no in-process caller** in this PR:

- `conversations:get-metadata` — Phase C wires the runner plugin's host-side surface, which calls this for sidebar reads (and again per-turn for transcript reads alongside `runner:read-transcript`).
- `conversations:store-runner-session` — Phase C wires the runner plugin's host-side IPC handler, which receives the runner subprocess's first-turn session-id capture and calls this hook to bind it to the conversation row.

Per memory `feedback_half_wired_window_pattern.md`: this is allowed because Phase C is the next-PR-up. **If Phase C is not the next PR, revert this PR before merging anything else** — a half-wired window left open across phases drifts into reality, and the columns + hooks here have no value without their callers.

The `chat:turn-end` last-activity bump and `conversations:create` freezing both DO have in-process callers (the existing turn-end subscriber and the live `:create` handler), so those parts are fully wired today.

## Boundary review — `conversations:get-metadata`

- **Alternate impl this hook could have:** a sqlite-backed `@ax/conversations-sqlite` plugin would register the same hook name with the same input/output shape. Single-replica dev shouldn't need to bring in postgres.
- **Payload field names that might leak:** none. `runnerType`, `runnerSessionId`, `workspaceRef`, `title`, `lastActivityAt`, `createdAt` are all storage-agnostic and runner-agnostic. No `pg_*`, no `sdk_session_id`, no `jsonl_path`.
- **Subscriber risk:** none — service hook with no subscribers. The eventual sidebar consumer (channel-web in Phase D) will read the projection; the eventual runner-plugin consumer (Phase C) will read `workspaceRef` + `runnerSessionId`.
- **Wire surface (IPC):** none. Host-internal hook only.

## Boundary review — `conversations:store-runner-session`

- **Alternate impl this hook could have:** a sqlite-backed `@ax/conversations-sqlite` plugin would register the same hook with the same shape. The compare-and-set semantics translate cleanly across SQL backends.
- **Payload field names that might leak:** none. `conversationId` is generic; `runnerSessionId` is opaque (no `sdk_session_id`, no `claude_session_uuid`). The same field name will carry an OpenAI Codex session id when `@ax/agent-codex-cli-runner` ships.
- **Subscriber risk:** none — service hook with no subscribers. (The runner plugin in Phase C *calls* this hook; it does not subscribe to it.)
- **Wire surface (IPC):** none. Host-internal hook only. The runner subprocess emits a separate IPC event (`event.runner-session-bound`) which the runner plugin's host-side handler translates into this `conversations:*` call.

## Migration safety

- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` is idempotent in postgres ≥ 9.6. The migration test `re-running does not error` pins this.
- ax-next is greenfield — no production data to backfill. Existing dev/test conversations get `runner_type = NULL`, `workspace_ref = NULL`, `runner_session_id = NULL`, `last_activity_at = NULL`. Phase C tolerates NULL on read and re-binds on next access.
- `pnpm build && pnpm test` is green. Each of the eight commits leaves the workspace green at its boundary (I13).

## Deviations from design doc

| | Design says | This PR ships | Why |
|---|---|---|---|
| **I1** | "v2 side-table, never an in-place ALTER" (existing migration comment) | ALTER `conversations_v1_conversations` in place; no v1→v2 split, here OR in any future schema change. | The old comment was written for breaking schema splits with production data to preserve. ax-next is greenfield (confirmed with Vinay 2026-04-29). The `_v1` suffix is now a stable identifier, not a version pointer. |
| **I2** | Seven new columns: `runner_type, runner_session_id, workspace_ref, title, summary, last_turn_preview, last_activity_at` | Four new: `runner_type, runner_session_id, workspace_ref, last_activity_at`. (`title` already existed.) | `summary` + `last_turn_preview` have no writer until `@ax/conversation-titles` lands in Phase F. Adding them now would be textbook half-wired infrastructure — they'd drift before Phase F arrives. |
| **I3** | `workspace_ref JSONB NOT NULL` | `workspace_ref TEXT NULL`, regex `^[A-Za-z0-9_./-]+$`, max 256. | Matches `agents.workspaceRef` exactly. JSONB NOT NULL would force a backfill on every existing agent that lacks a workspaceRef + a NOT-NULL violation on conversation create for those agents. If we ever need structured workspace refs (`{type:'git', url, sha}`), that's a breaking change that earns its own migration. |

## Invariants verified (from impl plan)

| | What | Where verified |
|---|---|---|
| I1 | Additive ALTER on v1; no v1→v2 split | `migrations.test.ts` — column shape + idempotency + pre-Phase-B-row survival |
| I2 | Defer `summary` + `last_turn_preview` to Phase F | This PR doesn't touch them; design § Data shapes notes the deferral |
| I3 | `workspace_ref TEXT NULL` matching `agents.workspaceRef` | `store-phase-b.test.ts` `validateWorkspaceRefForFreeze` (regex + bounds); `create-freezes.test.ts` (frozen-as-of-create includes "frozen as null") |
| I4 | `runner_type` from `ConversationsConfig.defaultRunnerType` | `create-freezes.test.ts` — default + custom override + null-config behavior |
| I5 | `:create` captures `agents:resolve` return; no new bus call | `plugin.ts` `assertAgentReachable` returns the agent; `create-freezes.test.ts` exercises the freeze path with one mock call per create |
| I6 | `:get-metadata` returns ONLY the projection — no turns | `get-metadata.test.ts` `(md as Record).turns).toBeUndefined()` |
| I7 | `:store-runner-session` idempotent same / conflict different / not-found foreign | `store-runner-session.test.ts` — four cases pinned |
| I8 | `last_activity_at` opaque to correctness; bumped only on persisted activity | `last-activity.test.ts` — heartbeat skip + content-block bump + `ctx.conversationId === undefined` skip |
| I9 | Hook payloads carry no backend vocabulary | Boundary review §§ above |
| I10 | Half-wired window opened, declared, closed by Phase C | "WINDOW OPEN — closed by Phase C" § above |
| I11 | Migration is forward-only AND re-runnable | `migrations.test.ts` "migration is idempotent" |
| I12 | All test paths use real postgres via testcontainers | All 5 new test files use `PostgreSqlContainer` directly or via `createTestHarness` + `createDatabasePostgresPlugin` |
| I13 | `pnpm build && pnpm test` green at every commit boundary | Each of the 8 commits ran `pnpm build && pnpm test --filter @ax/conversations` clean |
| I14 | No cross-plugin imports — `WORKSPACE_REF_RE` duplicated | `store.ts` `FROZEN_WORKSPACE_REF_RE` is a 2-line copy with a comment pointing at the upstream constant |

## Out-of-scope (deferred)

These were called out as Phase B non-goals in the impl plan and remain so:

- **`summary` + `last_turn_preview` columns.** Phase F alongside `@ax/conversation-titles`.
- **`agents:get` service hook.** Every Phase B caller already has `agents:resolve` available; defer until a caller without an ACL-gate need exists.
- **Caller migration to new hooks.** Channel-web's `GET /conversations/:id/turns` keeps using `conversations:fetch-history`; POST `/chat/messages` keeps appending the user turn before dispatch. Phase D.
- **Renaming the table to `conversations_v2_conversations`.** Not happening — confirmed 2026-04-29.
- **`runner:read-transcript` hook.** Phase C ships this.
- **Cleanup-on-delete (`runner:delete-session`).** Phase C / open question Q3 in the design doc.
- **Backfill for existing dev/test conversations.** Greenfield; no production data; existing rows get `NULL` and Phase C tolerates it.
- **`:list` order-by `last_activity_at DESC`.** Stays `created_at DESC` until `last_activity_at` is reliably populated. A future Phase F PR (or earlier) can switch.

## Stats

- 8 commits on the branch (one per logical task).
- 1 package touched (`@ax/conversations`).
- Test count: 58 → 90 (+32) in `@ax/conversations`. 5 new test files.
- `pnpm build` clean; `pnpm test` clean repo-wide.

## Reviewer asks

1. **Boundary review**: confirm both new hooks pass the four checks (alternate impl named, no leaking field names, no subscriber risk, no IPC surface). The hook shapes here are the inter-plugin API for everything Phase C+ builds on top.
2. **Window-pattern phrasing**: confirm the "WINDOW OPEN — closed by Phase C" section is sufficient, OR that it should explicitly list the two hooks (it does).
3. **`runnerSessionId` opacity**: confirm the field name is opaque enough that a future `@ax/agent-codex-cli-runner` shipping a different session-id scheme can use the same hook without renames.
4. **Deviations I1/I2/I3**: confirm the rationale; particularly I1 — we're committing to "ALTER v1 in place forever" and that needs your explicit OK because it changes the original migration.ts comment's stated rule.

## Follow-ups (don't block this PR)

- **Phase C** — runner subprocess writes its native session files under the conversation's workspace (via the HOME-redirect verified in Phase A); the runner plugin's host-side surface registers `runner:read-transcript` and the IPC handler that calls `conversations:store-runner-session`. Closes the half-wired window opened by this PR.
- **Phase D** — channel-web migrates `GET /conversations/:id/turns` to use `conversations:get-metadata` + `runner:read-transcript`.
- **Phase E** — drop `conversations_v1_turns` table + `conversations:append-turn` + `conversations:fetch-history` once Phase D's migration has settled.
- **Phase F** — `@ax/conversation-titles` plugin adds `summary` + `last_turn_preview` columns + writer.
