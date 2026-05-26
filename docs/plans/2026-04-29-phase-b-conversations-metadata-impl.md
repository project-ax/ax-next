# Phase B Implementation Plan — `@ax/conversations` metadata schema + new hooks

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land the additive piece of the runner-owned-sessions migration. Add new metadata columns + two new service hooks to `@ax/conversations` so Phase C has surface to wire against. Zero behavior changes for existing callers; the old turns table and old hooks stay alive.

**Architecture:**

- **ALTER TABLE on `conversations_v1_conversations`. No v1 → v2 split, ever.** The existing migrations.ts comment says "forward-only via a future v2 side-table, never an in-place ALTER" — that rule was written for breaking schema splits with production data to preserve. ax-next has no such constraint (greenfield, no rows to migrate), so ALTER in place is the right tool *forever*. Confirmed with Vinay 2026-04-29: don't migrate old tables, don't introduce a v2 schema in Phase E or anywhere else. (Deviation flagged; see I1.)
- **Three new columns, not seven.** Design `§Data shapes` lists `runner_type, runner_session_id, workspace_ref, title, summary, last_turn_preview, last_activity_at`. `title` already exists. `summary` + `last_turn_preview` have no writer until the deferred `@ax/conversation-titles` plugin lands (design D6 / Phase F) — adding them now would be textbook half-wired infrastructure (`patterns.md` anti-pattern). Phase B ships only the columns with a live writer in Phase B itself: `runner_type`, `runner_session_id`, `workspace_ref`, `last_activity_at`. (Deviation flagged; see I2.)
- **`workspace_ref` is TEXT, not JSONB.** Design spec says `workspace_ref JSONB NOT NULL`. Reality: `agents.workspaceRef` is `string | null` (TEXT, regex `^[A-Za-z0-9_./-]+$`, max 256 chars; see `packages/agents/src/store.ts:28-35`). The conversation row freezes a *copy* of the agent's value — same type, same constraints. Nullable to match agents (an agent without a workspaceRef can still own conversations). (Deviation flagged; see I3.)
- **`runner_type` source: new `ConversationsConfig.defaultRunnerType` knob.** No per-agent field for runner-type. MVP is single-runner-per-host (design D5), so `runner_type` is a constant the host plugin-load preset knows. New config field on `@ax/conversations`, defaulting to `'claude-sdk'`. The CLI preset that loads `@ax/conversations` passes the same string the runner plugin uses. (See I4.)
- **`agents:resolve` already returns the agent — no new `agents:get` hook needed.** `conversations:create`'s existing `assertAgentReachable` discards the resolve result. Capture it instead, read `agent.workspaceRef`, freeze onto the row. Zero new bus calls; one less round-trip than the design doc's `§D7` flow implies.
- **`last_activity_at` writer rides the existing `chat:turn-end` subscriber.** The subscriber currently calls `:append-turn` and clears `active_req_id`. Add a third action: bump `last_activity_at` in the same transaction as the turn append. No new subscriber, no new hook, no schedule risk.
- **Two new service hooks.** `conversations:get-metadata` (read-only, returns the metadata projection) and `conversations:store-runner-session` (writes `runner_session_id` once, idempotent). Both register in the same plugin file. Both follow the existing ACL posture (`getByIdNotDeleted` + user_id filter; `agents:resolve` for `get-metadata`; user_id-scoped UPDATE for `store-runner-session`).
- **No caller migration.** Channel-web doesn't change; the runner doesn't change; the orchestrator doesn't change. The new hooks are unreachable from the running system in Phase B — they're surface for Phase C to call into. **This is a half-wired-window opener and the PR notes must say so explicitly** (memory: `feedback_half_wired_window_pattern.md`). The window closes at Phase C.

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package; testcontainers for postgres-backed tests)
- Kysely 0.28.16 + raw `sql\`...\`` for migrations (matches existing migrations.ts pattern)
- pnpm workspace + `pnpm test --filter @ax/conversations` for fast iteration; `pnpm build && pnpm test` for full verification

**Out-of-scope (deferred):**

- **`summary` + `last_turn_preview` columns.** Land in Phase F alongside `@ax/conversation-titles`. Until that plugin exists, these columns are pure dead weight.
- **`agents:get` service hook.** Could be useful as a generalization, but every Phase B caller already has `agents:resolve` available, which returns the agent. Adding `agents:get` now would be a new hook surface earning nothing in Phase B; defer until a caller without an ACL-gate need exists.
- **Caller migration to new hooks.** Channel-web's `GET /conversations/:id/turns` keeps using `conversations:fetch-history`; POST `/chat/messages` keeps appending the user turn before dispatch. Phase D's job, not Phase B's.
- **Renaming the table to `conversations_v2_conversations`.** Not happening — confirmed 2026-04-29 we don't migrate old tables. The `_v1` suffix is now just a stable identifier; future schema changes ALTER in place.
- **`runner:read-transcript` hook.** Phase C ships this — the runner plugin needs to be host-side-loaded for it to register, and the runner plugin doesn't have a host-side surface today (lives entirely in the sandbox subprocess). Phase C builds that surface.
- **Cleanup-on-delete (`runner:delete-session`).** Phase C / open question Q3 in the design doc.
- **Backfill migration for existing conversations.** Greenfield; no production data; existing dev/test conversations get `runner_type=NULL`, `workspace_ref=NULL`, `runner_session_id=NULL`. The Phase C wiring tolerates NULL and re-binds on next access. No backfill SQL.

---

## Reality check — what's already in `@ax/conversations`

Pre-execution survey (run again at Task 1; values here are at plan-write time, 2026-04-29):

| Surface | State | Phase B work |
|---|---|---|
| `conversations_v1_conversations` table | Exists; columns `conversation_id, user_id, agent_id, title, active_session_id, active_req_id, deleted_at, created_at, updated_at` | **ADD** `runner_type, runner_session_id, workspace_ref, last_activity_at` |
| `conversations_v1_turns` table | Exists; alive | **No change** (Phase E drops it) |
| `runConversationsMigration` | `migrations.ts:30-71` | **Append** ALTER TABLE ADD COLUMN IF NOT EXISTS for the four new columns |
| `ConversationsRow` interface | `migrations.ts:77-87` | **Add** the four new fields (`runner_type`, etc.), all nullable |
| `Conversation` interface | `types.ts:49-64` | **Add** the four new fields to the public type |
| `ConversationsConfig` | `types.ts:225` (empty interface) | **Add** `defaultRunnerType: string` |
| `conversations:create` | `plugin.ts:404-426` | **Capture** the agent from `agents:resolve`, freeze `workspaceRef` + `runner_type` onto the new row |
| `conversations:get-metadata` | Does not exist | **REGISTER** new service hook |
| `conversations:store-runner-session` | Does not exist | **REGISTER** new service hook |
| `chat:turn-end` subscriber | `plugin.ts:198-214`, `handleTurnEnd` (`plugin.ts:263-306`) | **Add** `bumpLastActivity()` call in the same path that appends the turn |
| `Conversation` returned by `:get` / `:create` / `:list` | Mapped via `rowToConversation` in `store.ts:95-106` | **Add** the four new fields to the mapper |
| `validateContentBlocks` / `validateRole` / `validateTitle` | `store.ts:46-75` | **Add** `validateRunnerType` + `validateWorkspaceRef` (re-use the regex from `packages/agents/src/store.ts`) |
| Manifest `registers` array | `plugin.ts:76-88` | **Add** the two new hook names |
| Tests under `packages/conversations/src/__tests__/` | Exists (multiple files, testcontainers postgres) | **Add** new tests (or extend existing) for: migration, get-metadata, store-runner-session, create-freezes-workspace-ref, last-activity-at-bumps |

**Survey commands** (Task 1 runs these and pins the count diff):

```bash
pnpm build  # confirm clean baseline
ls packages/conversations/src/__tests__/  # see what test files exist today
rg -n "conversations_v1_conversations\b" packages/conversations/src --no-heading
rg -n "ConversationsConfig\b|defaultRunnerType\b" packages/conversations/src --no-heading
```

---

## Reference material

Files this plan touches (read before editing):

| File | Purpose |
|---|---|
| `packages/conversations/src/migrations.ts` | Add the four new columns + extend `ConversationsRow` |
| `packages/conversations/src/types.ts` | Extend `Conversation` + `ConversationsConfig`; add `MetadataInput`/`MetadataOutput` + `StoreRunnerSessionInput`/`StoreRunnerSessionOutput` |
| `packages/conversations/src/store.ts` | Extend `rowToConversation`; add `getMetadata` / `storeRunnerSession` / `bumpLastActivity` store methods; add validators |
| `packages/conversations/src/plugin.ts` | Register the two new hooks; modify `createConversation` to capture + freeze; modify `handleTurnEnd` to bump `last_activity_at` |
| `packages/conversations/src/index.ts` | Export the new types |
| `packages/agents/src/store.ts:28-35` | Reference: `WORKSPACE_REF_MAX = 256`, `WORKSPACE_REF_RE = /^[A-Za-z0-9_./-]+$/`. **Do not import** — duplicate the constants in `@ax/conversations`'s store, since cross-package imports between non-CLI plugins are forbidden by I2 (architecture-doc invariant). The constants are small enough that duplication is cheaper than a new shared package. |
| `packages/agents/src/types.ts` | Reference: `Agent.workspaceRef: string \| null` |
| `docs/plans/2026-04-29-runner-owned-sessions-design.md` | Authoritative for §Data shapes + §Hook surface (additions). This plan deviates from it on three points (I1, I2, I3 below); each deviation is justified and logged. |

**Reference patterns already in the codebase:**

- Additive ALTER TABLE in a migration: `packages/conversations/src/migrations.ts` is currently CREATE-only; no existing precedent in this package. Cross-reference: `packages/credentials-store-db/src/migrations.ts` does CREATE-only too. (No existing ALTER pattern in ax-next as of plan-write — Phase B is the first. Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` for idempotency, matching the `CREATE TABLE IF NOT EXISTS` posture of the existing CREATE statements.)
- Hook registration with ACL gate: `conversations:get` (`plugin.ts:480-504`) is the canonical shape — `getByIdNotDeleted` + user_id filter → `not-found` if mismatch → `assertAgentReachable` → return.
- Hook registration without ACL gate (host-internal write): `conversations:bind-session` (`plugin.ts:589-617`) — boundary-bounded strings, user_id-scoped UPDATE, `not-found` on miss. `conversations:store-runner-session` follows this shape.
- Boundary review template: `docs/plans/2026-04-29-phase-3-pr-notes.md` § "Boundary review".
- Testcontainers postgres test setup: `packages/conversations/src/__tests__/*.test.ts` (existing pattern; see `pnpm test --filter @ax/conversations` for invocation).
- Per-package test invocation: `pnpm test --filter @ax/conversations`.

---

## Invariants (verified per task)

These reflect the design doc's I-NEW-1..4, ax-next's five invariants (CLAUDE.md), and lessons logged in `.claude/memory/` from prior phases.

- **I1 — Additive ALTER on v1; no v1→v2 split, here or later.** Phase B introduces only nullable columns. The "v2 side-table" rule in the existing migration comment was for breaking schema splits with production data to preserve — ax-next is greenfield (confirmed 2026-04-29) and there is nothing to migrate, so ALTER in place is correct forever. The migration uses `ALTER TABLE conversations_v1_conversations ADD COLUMN IF NOT EXISTS ...` to stay idempotent + re-runnable. Phase E (and any future schema change) keeps the `_v1` table name; the `_v1` is now just a stable identifier, not a version pointer. *Prevents:* speculative versioning churn that earns nothing.
- **I2 — Defer `summary` + `last_turn_preview` to Phase F.** Half-wired infrastructure is forbidden (CLAUDE.md "Half-Wired Code Policy"; `patterns.md` anti-pattern). The columns earn their weight when `@ax/conversation-titles` writes them. Until then they're noise. *Prevents:* a Phase B PR that lands columns nobody touches, drifts from reality before Phase F arrives, and costs review time during Phase F to "remember why we added these."
- **I3 — `workspace_ref` is `TEXT NULL`, matching `agents.workspaceRef`.** Type AND nullability AND validation regex match the upstream type. The conversation row freezes a *copy* of the agent's value at create time; if the agent had `null`, the conversation has `null` — frozen-as-of-create includes "frozen as null." *Prevents:* a type mismatch that would force a backfill on every existing agent that lacks a workspaceRef + a NOT-NULL violation on conversation create for agents without one.
- **I4 — `runner_type` source is new `ConversationsConfig.defaultRunnerType` knob, written at create-time only.** Single source of truth (CLAUDE.md invariant #4): the host preset declares which runner is loaded; the conversations plugin inherits that constant. NOT read from the agent (no agent-level runner-type field), NOT auto-detected, NOT mutable post-create (mirrors I10 from prior phases — frozen-at-create). *Prevents:* a future reshape that adds an agent-level field, which would create a second source of truth for "what runner does this conversation use." If/when a second runner type ships (D5 router pattern), this knob is the natural place to plumb dispatch.
- **I5 — `conversations:create` captures the resolved agent; no new bus call.** `assertAgentReachable` (today's `plugin.ts:369-398`) currently discards `agents:resolve`'s return value. Capture it; pass it through. The `agents:resolve` payload returns `{ agent }` (`packages/agents/src/plugin.ts:203`), which already includes `workspaceRef`. *Prevents:* a redundant `agents:get` hook that earns nothing in Phase B and breaks the "if you can't name an alternate impl, it shouldn't be a hook yet" boundary-review test.
- **I6 — `conversations:get-metadata` returns ONLY the metadata projection — no turns.** The hook is the sidebar's read path. Returning turn content would re-create the lossy projection problem the whole runner-owned-sessions design is solving. The hook returns `{ conversationId, agentId, runnerType, runnerSessionId, workspaceRef, title, lastActivityAt }`. *Prevents:* drift back to the old "host DB has the turns" model.
- **I7 — `conversations:store-runner-session` is once-only-per-conversation, but idempotent.** A re-bind to the SAME runnerSessionId is a no-op success. A re-bind to a DIFFERENT runnerSessionId throws `PluginError({ code: 'conflict' })`. (D7: bind happens once per conversation, lazily, on the very first turn.) *Prevents:* a runner-side bug where two first-turn IPCs fire and silently overwrite the sessionId, leaving an orphan jsonl on disk.
- **I8 — `last_activity_at` is opaque to the host's correctness path.** It exists for sidebar ordering only. NULL is acceptable in tombstone'd rows, in pre-Phase-B conversations, and in conversations that haven't seen a turn yet. The `:list` hook orders by `created_at DESC` today; that doesn't change in Phase B. *Prevents:* a downstream consumer keying off `last_activity_at` for correctness (e.g. "is this row alive?") and breaking when the column is NULL.
- **I9 — Hook payloads carry no backend vocabulary.** No `runnerSessionId` named `sdk_session_id` or `jsonl_path`. No `workspaceRef` named `git_sha` or `gcs_bucket`. The names are runner-agnostic + storage-agnostic. (CLAUDE.md invariant #1; design § "Boundary review".) *Prevents:* the same leak Phase 3 was vigilant about — once a subscriber keys off `sdk_session_id`, renaming it later costs every subscriber.
- **I10 — No half-wired plugins. (Window pattern.)** Phase B opens a half-wired window: the two new hooks have no in-process caller. Per `feedback_half_wired_window_pattern.md`, this is allowed because Phase C (closer) is the next-PR-up — but the PR description MUST include an explicit "WINDOW OPEN — closed by Phase C" section and an alternate-impl named for both hooks. Phase B does NOT merge if Phase C is not the very next phase. *Prevents:* the half-wired window staying open longer than intended.
- **I11 — Migration is forward-only AND re-runnable.** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` is idempotent in postgres ≥ 9.6. The existing CREATE TABLE statements use `IF NOT EXISTS`; Phase B matches that posture. *Prevents:* a re-init in tests (or in dev with a clean db) tripping a duplicate-column error.
- **I12 — All test paths use real postgres via testcontainers.** The package already does this; do not introduce a mock db for the new tests. *Prevents:* mock-vs-prod drift (memory: `feedback_*` — though no specific entry, the broader CLAUDE.md ethos applies). The schema is the contract; mocking it would falsify the contract.
- **I13 — `pnpm build && pnpm test` must pass at every commit boundary.** Phase B has six logical commits (see § "Commit cadence"); each leaves the workspace green. *Prevents:* a wedge between commits that costs review time.
- **I14 — No cross-plugin imports.** `WORKSPACE_REF_RE` and `WORKSPACE_REF_MAX` are duplicated in `@ax/conversations`'s store, NOT imported from `@ax/agents`. (CLAUDE.md invariant #2.) The constants are 2 lines; a shared package would be premature. *Prevents:* the lint-rule violation that would block merge.

---

## Open questions resolved before execution

1. **`workspace_ref` JSONB or TEXT?** **TEXT, NULL allowed.** Matches `agents.workspaceRef` exactly (string regex-validated, max 256 chars). Design doc's "JSONB NOT NULL" is wrong; flagged as deviation I3. (If we ever need structured workspace refs — e.g. `{ type: 'git', url, sha }` — that's a breaking change that earns a v2 split.)
2. **`runner_type` JSONB or TEXT?** **TEXT NULL, max 64 chars (`^[a-z0-9-]+$` regex).** Matches the runner-plugin-name shape. Single value per conversation; no structure to encode.
3. **Add `conversations_v2_conversations` table or ALTER `_v1`?** **ALTER `_v1`. Forever.** See I1. ax-next is greenfield; there's nothing to migrate, ever. The `_v1` suffix becomes a stable name, not a version pointer.
4. **Add `summary` + `last_turn_preview` columns now?** **No.** See I2. Defer to Phase F.
5. **Where does `runner_type` come from?** **`ConversationsConfig.defaultRunnerType`.** See I4.
6. **Does `conversations:create` need a new `runnerType` input field?** **No.** Read from config. The hook's input shape stays `{ userId, agentId, title? }`. (A future reshape can add it when the router pattern lands; D5.)
7. **Does `conversations:create` lookup the agent twice?** **No.** Capture `agents:resolve`'s return value (it includes the agent). See I5.
8. **What's the `conversations:get-metadata` ACL posture?** **Same as `conversations:get` — `getByIdNotDeleted` + user_id filter → `not-found` if mismatch → `assertAgentReachable`.** Both reads are the user's metadata for their agent's conversation; same posture is correct + uniform.
9. **What's the `conversations:store-runner-session` ACL posture?** **`ctx.userId`-scoped UPDATE only — no `agents:resolve`.** This hook is host-internal (called by the runner-plugin's host-side handler in Phase C). The chat-orchestrator already gated the user at `agent:invoke` entry. Re-running the gate would only add latency. **However:** the UPDATE filters by `(conversation_id, user_id)` so a misbehaving caller cannot bind a cross-tenant row, mirroring `bind-session`'s posture (`plugin.ts:589-617`).
10. **Re-binding `runner_session_id` to the same value?** **Idempotent success.** To a different value? **`PluginError({ code: 'conflict' })`.** See I7. The store-method does `UPDATE ... SET runner_session_id = ? WHERE runner_session_id IS NULL OR runner_session_id = ?` and reads `numUpdatedRows`; the plugin layer translates 0-rows-updated into either "already-bound-to-same" (compare-and-success) or "conflict" via a follow-up SELECT.
11. **`last_activity_at` write path: in `:append-turn` SQL or as a separate UPDATE?** **In the same transaction as `:append-turn`.** The store's `appendTurn` already does `UPDATE conversations_v1_conversations SET updated_at = ? WHERE conversation_id = ?` inside the tx (`store.ts:355-359`). Add `last_activity_at = ?` to the same SET clause. Zero new round-trips.
12. **What about `last_activity_at` for the existing test fixture conversations?** **NULL is fine.** I8: it's opaque to the correctness path. Test assertions touching it can use `expect(...).toBeInstanceOf(Date)` or `expect(...).not.toBeNull()` for the assert-set-after-turn-end test.
13. **What's the `conversations:get-metadata` payload's `lastActivityAt` type?** **`string | null` — ISO-8601 if set, else null.** Matches the existing pattern in `Conversation.createdAt: string` (`types.ts:60`).
14. **What does Phase B do about `chat:turn-end` events that arrive WITHOUT `payload.contentBlocks`?** **No `last_activity_at` bump.** Heartbeat turn-ends don't write empty rows today (`plugin.ts:278-279`); Phase B keeps that posture — heartbeats stay heartbeats, no activity timestamp leak.
15. **What does Phase B do about a `conversations:create` call where `agents:resolve` succeeds but the returned agent has no `workspaceRef`?** **`workspace_ref = NULL` on the conversation row.** Frozen-as-of-create includes "frozen as null." Phase C will look up `runner_session_id` first; the workspaceRef lookup happens later (e.g. when the runner needs to read jsonl from a workspace), and `null` cleanly maps to "no workspace, can't read transcript." Channel-web's `runner:read-transcript` call will get an empty `UITurn[]` for these conversations — acceptable for MVP.
16. **Is there a `manifest.calls` change?** **No new entries.** `agents:resolve` and `database:get-instance` are already declared. The new hooks register, they don't call.
17. **Does `:list` ordering change to `last_activity_at DESC`?** **No.** I8: stays `created_at DESC`. A future Phase F PR (or earlier, if the sidebar UX wants it) can switch the ORDER BY clause when `last_activity_at` is reliably populated. Phase B leaves it alone.

---

## Commit cadence

Six logical commits, each leaving `pnpm build && pnpm test` green:

1. **Migration + types** — ALTER TABLE + extend `ConversationsRow` + extend `Conversation` interface + extend `ConversationsConfig`. New nullable fields throughout. Existing tests pass unchanged.
2. **Store wiring** — `rowToConversation` adds the new fields; new validators (`validateRunnerType`, `validateWorkspaceRefForFreeze`); new store methods (`getMetadata`, `storeRunnerSession`, `bumpLastActivity`). Tests for each.
3. **`conversations:create` freezes `workspace_ref` + `runner_type`** — capture `agents:resolve` return value; pass through to store; ConversationsConfig wired through `init()`. Tests for: agent with workspaceRef, agent without, runner_type populated from config.
4. **`conversations:get-metadata` hook** — register + handler + tests (happy path, foreign-user, tombstone, agents:resolve denial).
5. **`conversations:store-runner-session` hook** — register + handler + tests (first bind, re-bind same, re-bind different = conflict, foreign-user = not-found).
6. **`chat:turn-end` subscriber bumps `last_activity_at`** — `handleTurnEnd` calls `bumpLastActivity` after the append. Test: turn-end with content blocks → `last_activity_at` set; heartbeat turn-end → still null; failed `:append-turn` → `last_activity_at` NOT set (the bump rides the same tx).

Each commit has its own message body documenting which I-invariants it touches.

---

## Tasks

### Task 1: Survey + commit baseline (no code)

**Goal:** Confirm the survey in this plan matches reality at execution time. (Memory: `feedback_check_plan_vs_reality.md`.)

**Files:** Read-only. `packages/conversations/src/{plugin,store,types,migrations,index}.ts`, `packages/agents/src/store.ts:28-35`.

**Step 1.1: Run the baseline build**

```bash
pnpm build && pnpm test --filter @ax/conversations
```

Expected: PASS.

**Step 1.2: Verify the surface**

```bash
rg -n "ConversationsConfig\b|defaultRunnerType\b" packages/conversations/src --no-heading
rg -n "runner_type|runner_session_id|workspace_ref|last_activity_at" packages/conversations/src --no-heading
ls packages/conversations/src/__tests__/
```

Expected: zero hits for the new column names; `ConversationsConfig` is the empty interface; test directory has the existing files.

**Step 1.3: Stop if drift**

If the baseline doesn't match, STOP and update the plan. Don't execute against stale assumptions.

**No commit.**

---

### Task 2: Migration — add four new columns

**Goal:** ALTER TABLE adds `runner_type, runner_session_id, workspace_ref, last_activity_at`. Existing tests still pass (nullable columns are transparent).

**Files:**
- Modify: `packages/conversations/src/migrations.ts`
- Test: `packages/conversations/src/__tests__/migrations.test.ts` (create if absent — confirm in Task 1)

**Step 2.1: Write the failing test**

```ts
// migrations.test.ts
import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { withPostgres } from './helpers/postgres.js';  // existing helper; verify path in Task 1
import { runConversationsMigration } from '../migrations.js';

describe('Phase B migration', () => {
  it('adds runner_type, runner_session_id, workspace_ref, last_activity_at columns', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const cols = await sql<{ column_name: string; is_nullable: string; data_type: string }>`
        SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
        WHERE table_name = 'conversations_v1_conversations'
        ORDER BY column_name
      `.execute(db);
      const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
      expect(byName.get('runner_type')).toMatchObject({ is_nullable: 'YES', data_type: 'text' });
      expect(byName.get('runner_session_id')).toMatchObject({ is_nullable: 'YES', data_type: 'text' });
      expect(byName.get('workspace_ref')).toMatchObject({ is_nullable: 'YES', data_type: 'text' });
      expect(byName.get('last_activity_at')).toMatchObject({ is_nullable: 'YES', data_type: 'timestamp with time zone' });
    });
  });

  it('migration is idempotent — re-running does not error', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      await runConversationsMigration(db);  // second run must succeed
    });
  });
});
```

Run: `pnpm test --filter @ax/conversations -- migrations.test`
Expected: FAIL — columns don't exist.

**Step 2.2: Append ALTER statements to the migration**

In `migrations.ts`, after the existing `CREATE INDEX` blocks (around line 70), append:

```ts
  // Phase B (2026-04-29) — runner-owned-sessions metadata. Pure-additive
  // ALTER on v1 (not a v2 side-table) because all four columns are new
  // and nullable; no data migration, no breaking change. The v1 → v2
  // split earns its weight at Phase E when the turns table drops.
  //
  // - runner_type: which runner plugin owns this conversation's transcript.
  //   Populated at create-time from `ConversationsConfig.defaultRunnerType`.
  //   Frozen for the conversation's lifetime (mirrors I10).
  // - runner_session_id: the runner's native session id, captured on the
  //   first turn via `conversations:store-runner-session`. NULL until the
  //   first turn binds.
  // - workspace_ref: frozen copy of agents.workspaceRef at create time.
  //   Same TEXT type, same constraints (regex enforced by validator at
  //   the plugin boundary, not the DB).
  // - last_activity_at: bumped by the chat:turn-end subscriber on every
  //   non-heartbeat turn. Sidebar ordering only — opaque to correctness.
  await sql`
    ALTER TABLE conversations_v1_conversations
      ADD COLUMN IF NOT EXISTS runner_type TEXT,
      ADD COLUMN IF NOT EXISTS runner_session_id TEXT,
      ADD COLUMN IF NOT EXISTS workspace_ref TEXT,
      ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ
  `.execute(db);
```

Also extend `ConversationsRow`:

```ts
export interface ConversationsRow {
  conversation_id: string;
  user_id: string;
  agent_id: string;
  title: string | null;
  active_session_id: string | null;
  active_req_id: string | null;
  // Phase B (2026-04-29) additions — all nullable, populated lazily.
  runner_type: string | null;
  runner_session_id: string | null;
  workspace_ref: string | null;
  last_activity_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
```

**Step 2.3: Run tests**

```bash
pnpm test --filter @ax/conversations
```

Expected: the new test passes; existing tests pass (the new columns are nullable and transparent to existing code paths until Task 3 wires them into `rowToConversation`).

**Step 2.4: Commit**

```bash
git add packages/conversations/src/migrations.ts packages/conversations/src/__tests__/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(conversations): Phase B migration — runner-owned-sessions metadata columns

Adds runner_type, runner_session_id, workspace_ref, last_activity_at to
conversations_v1_conversations. Pure-additive ALTER (all nullable); no
behavior change. Surface for Phase C wiring.

Invariants: I1 (additive ALTER on v1), I3 (workspace_ref TEXT NULL), I8
(last_activity_at opaque), I11 (idempotent migration).

Refs: docs/plans/2026-04-29-runner-owned-sessions-design.md §Data shapes
EOF
)"
```

---

### Task 3: Domain types — extend `Conversation` + `ConversationsConfig`

**Goal:** Public types reflect the new columns. `rowToConversation` wires them through. Existing tests still pass.

**Files:**
- Modify: `packages/conversations/src/types.ts`
- Modify: `packages/conversations/src/store.ts` (function `rowToConversation`)

**Step 3.1: Write the failing test**

Extend an existing types test or add `packages/conversations/src/__tests__/types-shape.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rowToConversation } from '../store.js';  // export it for tests

describe('rowToConversation Phase B fields', () => {
  it('maps runner_type / runner_session_id / workspace_ref / last_activity_at', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const conv = rowToConversation({
      conversation_id: 'cnv_abc',
      user_id: 'u1', agent_id: 'a1', title: null,
      active_session_id: null, active_req_id: null,
      runner_type: 'claude-sdk',
      runner_session_id: 'sess_xyz',
      workspace_ref: 'wsp_local',
      last_activity_at: now,
      deleted_at: null, created_at: now, updated_at: now,
    });
    expect(conv.runnerType).toBe('claude-sdk');
    expect(conv.runnerSessionId).toBe('sess_xyz');
    expect(conv.workspaceRef).toBe('wsp_local');
    expect(conv.lastActivityAt).toBe(now.toISOString());
  });

  it('maps null Phase B fields as null', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const conv = rowToConversation({
      conversation_id: 'cnv_abc',
      user_id: 'u1', agent_id: 'a1', title: null,
      active_session_id: null, active_req_id: null,
      runner_type: null, runner_session_id: null,
      workspace_ref: null, last_activity_at: null,
      deleted_at: null, created_at: now, updated_at: now,
    });
    expect(conv.runnerType).toBeNull();
    expect(conv.runnerSessionId).toBeNull();
    expect(conv.workspaceRef).toBeNull();
    expect(conv.lastActivityAt).toBeNull();
  });
});
```

(`rowToConversation` is currently NOT exported from `store.ts:95`. Either export it for tests, or test indirectly via `getByIdNotDeleted` after an INSERT. Pick the export route — matches the test-friendly posture of `validateContentBlocks` etc. that ARE already exported.)

Run: `pnpm test --filter @ax/conversations -- types-shape.test`
Expected: FAIL — fields don't exist on `Conversation`.

**Step 3.2: Extend `Conversation` interface**

In `types.ts:49-64`:

```ts
export interface Conversation {
  conversationId: string;
  userId: string;
  /** Frozen at create (Invariant I10). Never updated. */
  agentId: string;
  /** Nullable; MVP doesn't auto-generate. */
  title: string | null;
  /** Nullable; cleared in Task 14. */
  activeSessionId: string | null;
  /** Nullable; the in-flight reqId, if any (Invariant J7). */
  activeReqId: string | null;
  /**
   * Phase B (2026-04-29). Frozen at create from
   * `ConversationsConfig.defaultRunnerType`. Mirrors I10 (immutable).
   * Nullable for pre-Phase-B rows.
   */
  runnerType: string | null;
  /**
   * Phase B. The runner's native session id (e.g. SDK sessionId for
   * `@ax/agent-claude-sdk-runner`). Bound on the first turn via
   * `conversations:store-runner-session`. Null until then.
   */
  runnerSessionId: string | null;
  /**
   * Phase B. Frozen copy of `agent.workspaceRef` at conversation create.
   * Mirrors I10. Nullable when the agent had no workspaceRef OR the
   * row predates Phase B.
   */
  workspaceRef: string | null;
  /**
   * Phase B. ISO-8601 string. Bumped by the `chat:turn-end` subscriber
   * on every non-heartbeat turn. Opaque to correctness; sidebar ordering
   * only. Null for pre-Phase-B rows or rows that haven't seen a turn.
   */
  lastActivityAt: string | null;
  /** ISO-8601 string. */
  createdAt: string;
  /** ISO-8601 string. */
  updatedAt: string;
}
```

**Step 3.3: Extend `ConversationsConfig`**

In `types.ts:225` (replacing the empty interface):

```ts
export interface ConversationsConfig {
  /**
   * Phase B (2026-04-29). The runner-plugin name to freeze onto every new
   * conversation row's `runner_type` column. Single-runner-per-host MVP
   * (design D5), so this is a constant the host preset declares. The same
   * string the runner plugin itself reports — keep them in lockstep when
   * a new runner ships (the future `@ax/runner-router` plugin will own
   * dispatch, at which point this knob becomes a default-not-required).
   *
   * Default: `'claude-sdk'`.
   */
  defaultRunnerType?: string;
}
```

**Step 3.4: Wire `rowToConversation`**

In `store.ts:95`, export the function and add the new mappings:

```ts
export function rowToConversation(row: ConversationsRow): Conversation {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    activeSessionId: row.active_session_id,
    activeReqId: row.active_req_id,
    runnerType: row.runner_type,
    runnerSessionId: row.runner_session_id,
    workspaceRef: row.workspace_ref,
    lastActivityAt: row.last_activity_at === null
      ? null
      : row.last_activity_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
```

**Step 3.5: Run tests**

```bash
pnpm test --filter @ax/conversations
pnpm build  # whole-repo build — channel-web / chat-orchestrator may infer Conversation
```

Expected: PASS.

**Step 3.6: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(conversations): expose runnerType/runnerSessionId/workspaceRef/lastActivityAt on Conversation

Extends the Conversation public type + ConversationsConfig.defaultRunnerType
knob. rowToConversation maps the four new DB columns. No writer yet —
Tasks 4-7 wire them.

Invariants: I3 (TEXT NULL workspace_ref), I4 (defaultRunnerType single
source of truth), I8 (lastActivityAt opaque).
EOF
)"
```

---

### Task 4: Validators + store methods (`getMetadata`, `storeRunnerSession`, `bumpLastActivity`)

**Goal:** The store has the methods. No plugin handlers yet.

**Files:**
- Modify: `packages/conversations/src/store.ts`

**Step 4.1: Write failing tests**

New test file `packages/conversations/src/__tests__/store-phase-b.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { withPostgres } from './helpers/postgres.js';
import { runConversationsMigration } from '../migrations.js';
import {
  createConversationStore,
  validateRunnerType,
  validateWorkspaceRefForFreeze,
} from '../store.js';

describe('validateRunnerType', () => {
  it('accepts lowercase + digits + hyphen, 1-64 chars', () => {
    expect(validateRunnerType('claude-sdk')).toBe('claude-sdk');
    expect(validateRunnerType('a')).toBe('a');
    expect(validateRunnerType(null)).toBeNull();
  });
  it('rejects empty / oversize / illegal chars', () => {
    expect(() => validateRunnerType('')).toThrow(/runnerType/);
    expect(() => validateRunnerType('A')).toThrow(/runnerType/);
    expect(() => validateRunnerType('a'.repeat(65))).toThrow(/runnerType/);
    expect(() => validateRunnerType('claude/sdk')).toThrow(/runnerType/);
  });
});

describe('validateWorkspaceRefForFreeze', () => {
  it('mirrors agents/store.ts WORKSPACE_REF_RE', () => {
    expect(validateWorkspaceRefForFreeze('foo/bar.git')).toBe('foo/bar.git');
    expect(validateWorkspaceRefForFreeze(null)).toBeNull();
    expect(() => validateWorkspaceRefForFreeze('foo bar')).toThrow();
  });
});

describe('store.getMetadata', () => {
  it('returns the metadata projection — no turns', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const store = createConversationStore(db);
      const conv = await store.create({ userId: 'u1', agentId: 'a1', title: null });
      const md = await store.getMetadata(conv.conversationId);
      expect(md).toMatchObject({
        conversationId: conv.conversationId,
        userId: 'u1',
        agentId: 'a1',
        runnerType: null,
        runnerSessionId: null,
        workspaceRef: null,
        title: null,
      });
    });
  });
  it('returns null for unknown / tombstoned ids', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const store = createConversationStore(db);
      expect(await store.getMetadata('cnv_unknown')).toBeNull();
      const conv = await store.create({ userId: 'u1', agentId: 'a1', title: null });
      await store.softDelete(conv.conversationId);
      expect(await store.getMetadata(conv.conversationId)).toBeNull();
    });
  });
});

describe('store.storeRunnerSession', () => {
  it('binds runner_session_id idempotently for the same value', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const store = createConversationStore(db);
      const conv = await store.create({ userId: 'u1', agentId: 'a1', title: null });
      const r1 = await store.storeRunnerSession({
        conversationId: conv.conversationId,
        userId: 'u1',
        runnerSessionId: 'sess_abc',
      });
      const r2 = await store.storeRunnerSession({
        conversationId: conv.conversationId,
        userId: 'u1',
        runnerSessionId: 'sess_abc',
      });
      expect(r1).toBe('bound');
      expect(r2).toBe('already-bound-same');
    });
  });
  it('reports conflict when re-binding to a different value', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const store = createConversationStore(db);
      const conv = await store.create({ userId: 'u1', agentId: 'a1', title: null });
      await store.storeRunnerSession({
        conversationId: conv.conversationId, userId: 'u1', runnerSessionId: 'sess_abc',
      });
      const r = await store.storeRunnerSession({
        conversationId: conv.conversationId, userId: 'u1', runnerSessionId: 'sess_OTHER',
      });
      expect(r).toBe('conflict');
    });
  });
  it('returns not-found for foreign user / unknown id', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const store = createConversationStore(db);
      const conv = await store.create({ userId: 'u1', agentId: 'a1', title: null });
      const r1 = await store.storeRunnerSession({
        conversationId: conv.conversationId, userId: 'u-OTHER', runnerSessionId: 'x',
      });
      const r2 = await store.storeRunnerSession({
        conversationId: 'cnv_unknown', userId: 'u1', runnerSessionId: 'x',
      });
      expect(r1).toBe('not-found');
      expect(r2).toBe('not-found');
    });
  });
});

describe('store.bumpLastActivity', () => {
  it('sets last_activity_at + updated_at on a live row', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const store = createConversationStore(db);
      const conv = await store.create({ userId: 'u1', agentId: 'a1', title: null });
      const ok = await store.bumpLastActivity(conv.conversationId, new Date('2026-04-29T13:00:00Z'));
      expect(ok).toBe(true);
      const md = await store.getMetadata(conv.conversationId);
      expect(md?.lastActivityAt).toBe('2026-04-29T13:00:00.000Z');
    });
  });
  it('returns false for tombstone / unknown', async () => {
    await withPostgres(async (db) => {
      await runConversationsMigration(db);
      const store = createConversationStore(db);
      expect(await store.bumpLastActivity('cnv_unknown', new Date())).toBe(false);
    });
  });
});
```

Run: `pnpm test --filter @ax/conversations -- store-phase-b.test`
Expected: FAIL — methods + validators don't exist.

**Step 4.2: Add validators**

In `store.ts`, alongside `validateTitle` etc.:

```ts
const RUNNER_TYPE_MAX = 64;
const RUNNER_TYPE_RE = /^[a-z0-9-]+$/;

// Mirrored from packages/agents/src/store.ts. Cross-plugin imports are
// forbidden (CLAUDE.md invariant #2); duplicating two lines is cheaper
// than a shared package. Keep the values in lockstep when the upstream
// changes.
const FROZEN_WORKSPACE_REF_MAX = 256;
const FROZEN_WORKSPACE_REF_RE = /^[A-Za-z0-9_./-]+$/;

export function validateRunnerType(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw invalid('runnerType must be a string or null');
  }
  if (value.length === 0 || value.length > RUNNER_TYPE_MAX) {
    throw invalid(`runnerType must be 1-${RUNNER_TYPE_MAX} chars`);
  }
  if (!RUNNER_TYPE_RE.test(value)) {
    throw invalid(`runnerType must match ${RUNNER_TYPE_RE.source}`);
  }
  return value;
}

export function validateWorkspaceRefForFreeze(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw invalid('workspaceRef must be a string or null');
  }
  if (value.length === 0 || value.length > FROZEN_WORKSPACE_REF_MAX) {
    throw invalid(`workspaceRef must be 1-${FROZEN_WORKSPACE_REF_MAX} chars`);
  }
  if (!FROZEN_WORKSPACE_REF_RE.test(value)) {
    throw invalid(`workspaceRef must match ${FROZEN_WORKSPACE_REF_RE.source}`);
  }
  return value;
}
```

**Step 4.3: Add store methods + types**

In the same file, define a small metadata type and add three methods:

```ts
export interface ConversationMetadata {
  conversationId: string;
  userId: string;
  agentId: string;
  runnerType: string | null;
  runnerSessionId: string | null;
  workspaceRef: string | null;
  title: string | null;
  lastActivityAt: string | null;
  createdAt: string;
}

export type StoreRunnerSessionResult =
  | 'bound'                // first bind, success
  | 'already-bound-same'   // idempotent re-bind to the same value
  | 'conflict'             // re-bind attempt to a DIFFERENT value
  | 'not-found';           // unknown id / foreign user / tombstone
```

Extend `ConversationStore` interface with:

```ts
  /** Phase B: metadata-only projection for sidebar / runner plugin reads. */
  getMetadata(conversationId: string): Promise<ConversationMetadata | null>;

  /**
   * Phase B: bind `runner_session_id` once per conversation. Idempotent
   * for the same value; conflict on a different value. user_id-scoped so
   * a misbehaving caller cannot bind a cross-tenant row.
   */
  storeRunnerSession(args: {
    conversationId: string;
    userId: string;
    runnerSessionId: string;
  }): Promise<StoreRunnerSessionResult>;

  /**
   * Phase B: bump `last_activity_at`. Subscriber-friendly; returns false
   * on tombstone / unknown / foreign (no scope here — host-internal,
   * called only by the chat:turn-end subscriber that already trusts ctx).
   */
  bumpLastActivity(conversationId: string, at: Date): Promise<boolean>;
```

Add the implementations in `createConversationStore`:

```ts
    async getMetadata(conversationId) {
      const row = await db
        .selectFrom('conversations_v1_conversations')
        .selectAll('conversations_v1_conversations')
        .where('conversation_id', '=', conversationId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        conversationId: row.conversation_id,
        userId: row.user_id,
        agentId: row.agent_id,
        runnerType: row.runner_type,
        runnerSessionId: row.runner_session_id,
        workspaceRef: row.workspace_ref,
        title: row.title,
        lastActivityAt: row.last_activity_at === null
          ? null
          : row.last_activity_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      };
    },

    async storeRunnerSession({ conversationId, userId, runnerSessionId }) {
      // Compare-and-set: write iff the column is NULL, else surface the
      // current value so the plugin layer can distinguish idempotent
      // re-bind from conflict. Single round-trip via a CTE.
      //
      // We also filter (user_id, deleted_at IS NULL) so cross-tenant /
      // tombstoned rows present as not-found uniformly.
      const result = await db
        .updateTable('conversations_v1_conversations')
        .set({
          runner_session_id: runnerSessionId,
          updated_at: new Date(),
        })
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .where('runner_session_id', 'is', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0n) > 0) {
        return 'bound';
      }
      // No row updated. Either the row doesn't exist for this (id, user)
      // OR runner_session_id is already set. Read current state to
      // distinguish.
      const existing = await db
        .selectFrom('conversations_v1_conversations')
        .select(['runner_session_id'])
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (existing === undefined) return 'not-found';
      if (existing.runner_session_id === runnerSessionId) return 'already-bound-same';
      return 'conflict';
    },

    async bumpLastActivity(conversationId, at) {
      const result = await db
        .updateTable('conversations_v1_conversations')
        .set({ last_activity_at: at, updated_at: at })
        .where('conversation_id', '=', conversationId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) > 0;
    },
```

**Step 4.4: Run tests**

```bash
pnpm test --filter @ax/conversations
```

Expected: PASS.

**Step 4.5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(conversations): store methods for Phase B metadata + runner-session bind

Adds validateRunnerType / validateWorkspaceRefForFreeze validators (the
workspaceRef regex is mirrored from @ax/agents per CLAUDE.md invariant
#2 — no cross-plugin imports). New store methods: getMetadata (read-only
projection), storeRunnerSession (idempotent compare-and-set), and
bumpLastActivity (subscriber-friendly UPDATE).

Invariants: I7 (idempotent bind, conflict on mismatch), I9 (no backend
vocab in payloads), I14 (constants duplicated, not imported).
EOF
)"
```

---

### Task 5: `conversations:create` freezes `workspace_ref` + `runner_type`

**Goal:** New rows populate the two frozen columns. Capture `agents:resolve` return value (no new bus call). Wire `defaultRunnerType` from config.

**Files:**
- Modify: `packages/conversations/src/plugin.ts`
- Modify: `packages/conversations/src/store.ts` (extend `ConversationStoreCreateArgs`)
- Test: extend an existing create-conversation test or add `__tests__/create-freezes.test.ts`

**Step 5.1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { withTestPlugin } from './helpers/test-plugin.js';  // existing harness; verify in Task 1

describe('conversations:create — Phase B freezing', () => {
  it('freezes runner_type from config + workspace_ref from the resolved agent', async () => {
    await withTestPlugin({ defaultRunnerType: 'claude-sdk' }, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: 'wsp_demo' });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      expect(conv.runnerType).toBe('claude-sdk');
      expect(conv.workspaceRef).toBe('wsp_demo');
    });
  });

  it('freezes workspace_ref = null when the agent had no workspaceRef', async () => {
    await withTestPlugin({ defaultRunnerType: 'claude-sdk' }, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      expect(conv.workspaceRef).toBeNull();
      expect(conv.runnerType).toBe('claude-sdk');
    });
  });

  it('defaults runner_type to "claude-sdk" when the config knob is omitted', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      expect(conv.runnerType).toBe('claude-sdk');
    });
  });
});
```

(`withTestPlugin` is the existing test harness — verify the entry point + signature in Task 1; the test file may need to be a concrete adaptation.)

Run: `pnpm test --filter @ax/conversations -- create-freezes.test`
Expected: FAIL — `runner_type` / `workspace_ref` come back null.

**Step 5.2: Extend the resolve-agent helper to return the agent**

In `plugin.ts:369-398`, change `assertAgentReachable` so it returns the resolved agent. Today the function calls `bus.call<ResolveInput, unknown>('agents:resolve', ctx, ...)` and discards the response. Replace with:

```ts
interface ResolvedAgent {
  // Mirrors the shape @ax/agents publishes via agents:resolve. We only
  // need workspaceRef for Phase B; the wider shape is intentionally
  // narrowed here so a future field change in @ax/agents doesn't ripple.
  agent: { id: string; workspaceRef: string | null };
}

async function assertAgentReachable(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
  hookName: string,
): Promise<ResolvedAgent['agent']> {
  try {
    const result = await bus.call<ResolveInput, ResolvedAgent>(
      'agents:resolve',
      ctx,
      { agentId, userId },
    );
    return result.agent;
  } catch (err) {
    if (err instanceof PluginError) {
      if (err.code === 'forbidden' || err.code === 'not-found') {
        throw new PluginError({
          code: err.code,
          plugin: PLUGIN_NAME,
          hookName,
          message: err.message,
          cause: err,
        });
      }
    }
    throw err;
  }
}
```

Every existing caller of `assertAgentReachable` is a `void` consumer today — they call `await assertAgentReachable(...)` and ignore the return. TypeScript-wise, returning a value is non-breaking.

**Step 5.3: Wire `createConversation` to freeze**

```ts
async function createConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: CreateInput,
  cfg: ResolvedConversationsConfig,
): Promise<CreateOutput> {
  const title = validateTitle(input.title ?? null);
  // J1: ACL gate BEFORE persisting. Capture the resolved agent so we
  // can freeze its workspaceRef onto the row (mirrors I10 — frozen-at-create
  // immutability). One bus call total — the design doc's "agents:get"
  // dance was unnecessary (I5).
  const agent = await assertAgentReachable(
    bus, ctx, input.agentId, input.userId, 'conversations:create',
  );
  const conv = await store.create({
    userId: input.userId,
    agentId: input.agentId,
    title,
    runnerType: cfg.defaultRunnerType,
    workspaceRef: validateWorkspaceRefForFreeze(agent.workspaceRef),
  });
  return conv;
}
```

**Step 5.4: Resolve config + thread it through**

In `createConversationsPlugin`'s closure, build a resolved-config object:

```ts
interface ResolvedConversationsConfig {
  defaultRunnerType: string;
}

function resolveConfig(input: ConversationsConfig): ResolvedConversationsConfig {
  const dt = input.defaultRunnerType ?? 'claude-sdk';
  return { defaultRunnerType: validateRunnerTypeOrThrow(dt) };
}

function validateRunnerTypeOrThrow(value: string): string {
  const v = validateRunnerType(value);
  if (v === null) {
    throw new Error("ConversationsConfig.defaultRunnerType must not be null");
  }
  return v;
}
```

Modify the export:

```ts
export function createConversationsPlugin(
  config: ConversationsConfig = {},
): Plugin {
  const resolved = resolveConfig(config);
  // ... rest unchanged
  // ... bus.registerService<CreateInput, CreateOutput>(
  //       'conversations:create',
  //       PLUGIN_NAME,
  //       async (ctx, input) =>
  //         createConversation(localStore, bus, ctx, input, resolved),
  //     );
}
```

**Step 5.5: Extend `ConversationStoreCreateArgs` + `store.create`**

In `store.ts`:

```ts
export interface ConversationStoreCreateArgs {
  userId: string;
  agentId: string;
  title: string | null;
  // Phase B additions — both nullable to match the underlying columns.
  runnerType: string | null;
  workspaceRef: string | null;
}
```

And in the `create` impl:

```ts
    async create({ userId, agentId, title, runnerType, workspaceRef }) {
      const id = mintConversationId();
      const now = new Date();
      const row = await db
        .insertInto('conversations_v1_conversations')
        .values({
          conversation_id: id,
          user_id: userId,
          agent_id: agentId,
          title,
          active_session_id: null,
          active_req_id: null,
          runner_type: runnerType,
          runner_session_id: null,
          workspace_ref: workspaceRef,
          last_activity_at: null,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return rowToConversation(row as ConversationsRow);
    },
```

**Step 5.6: Run tests**

```bash
pnpm test --filter @ax/conversations
pnpm build
```

Expected: PASS. Existing tests that called `store.create({ userId, agentId, title })` will fail to compile because of the two new required args — update the existing test fixtures to pass `runnerType: 'claude-sdk', workspaceRef: null` (or add a small test-helper that defaults them). Make the test fixture update part of the same commit.

**Step 5.7: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(conversations): freeze runner_type + workspace_ref at create-time

Captures the resolved agent from agents:resolve (no new bus call) and
freezes its workspaceRef onto the conversation row. runner_type comes
from new ConversationsConfig.defaultRunnerType (defaults 'claude-sdk').
Mirrors I10 (frozen-at-create) for both fields.

Existing test fixtures that called store.create({ userId, agentId, title })
updated to pass runnerType + workspaceRef (compile-time required).

Invariants: I4 (defaultRunnerType single source of truth), I5 (capture
agents:resolve, no new agents:get hook), I9 (no backend vocab).
EOF
)"
```

---

### Task 6: Register `conversations:get-metadata`

**Goal:** New service hook ships with the same ACL posture as `:get`. Returns metadata projection only.

**Files:**
- Modify: `packages/conversations/src/types.ts` (add `GetMetadataInput`/`Output`)
- Modify: `packages/conversations/src/plugin.ts` (register + handler)
- Modify: `packages/conversations/src/index.ts` (export the new types)
- Test: `packages/conversations/src/__tests__/get-metadata.test.ts`

**Step 6.1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { withTestPlugin } from './helpers/test-plugin.js';

describe('conversations:get-metadata', () => {
  it('returns metadata projection (no turns)', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: 'wsp_demo' });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      const md = await bus.call('conversations:get-metadata', ctx, {
        conversationId: conv.conversationId, userId: ctx.userId,
      });
      expect(md).toMatchObject({
        conversationId: conv.conversationId,
        agentId: agent.id,
        runnerType: 'claude-sdk',
        workspaceRef: 'wsp_demo',
        runnerSessionId: null,
      });
      expect((md as Record<string, unknown>).turns).toBeUndefined();
    });
  });

  it('returns not-found for foreign user', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      await expect(
        bus.call('conversations:get-metadata', ctx, {
          conversationId: conv.conversationId, userId: 'u-OTHER',
        }),
      ).rejects.toThrow(PluginError);  // tighten to error-code check if helper supports
    });
  });

  it('returns not-found for tombstoned row', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      await bus.call('conversations:delete', ctx, {
        conversationId: conv.conversationId, userId: ctx.userId,
      });
      await expect(
        bus.call('conversations:get-metadata', ctx, {
          conversationId: conv.conversationId, userId: ctx.userId,
        }),
      ).rejects.toThrow(/not-found/);
    });
  });

  it('returns not-found when agents:resolve denies', async () => {
    // Uses the test harness's agents:resolve mock to inject a forbidden
    // response; verify the conversations layer surfaces 'not-found' (NOT
    // 'forbidden') so existence-leak posture is preserved.
    // (Adjust per your harness; if it doesn't expose this, skip + flag.)
    // TODO: confirm harness API in Task 1.
  });
});
```

Run: `pnpm test --filter @ax/conversations -- get-metadata.test`
Expected: FAIL — hook not registered.

**Step 6.2: Add the input/output types**

In `types.ts` (alongside `GetInput`/`Output`):

```ts
/**
 * Phase B (2026-04-29). Sidebar / runner-plugin metadata read. Returns
 * the projection only — `runner:read-transcript` ships separately
 * (Phase C) and returns `UITurn[]` from the runner's native session
 * format. Combining both into one hook would re-create the lossy
 * projection problem the design solves (I6).
 *
 * ACL: same as `conversations:get` — `(conversation_id, user_id)`
 * pre-filter, then `agents:resolve(agent_id, user_id)`. A foreign row
 * looks identical to "no such row" from the caller's perspective.
 */
export interface GetMetadataInput {
  conversationId: string;
  userId: string;
}
export interface GetMetadataOutput {
  conversationId: string;
  userId: string;
  agentId: string;
  runnerType: string | null;
  runnerSessionId: string | null;
  workspaceRef: string | null;
  title: string | null;
  /** ISO-8601, or null if no turns yet / pre-Phase-B row. */
  lastActivityAt: string | null;
  /** ISO-8601. */
  createdAt: string;
}
```

**Step 6.3: Register the hook + handler**

In `plugin.ts`, extend `manifest.registers`:

```ts
      registers: [
        'conversations:create',
        'conversations:append-turn',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
        'conversations:get-by-req-id',
        'conversations:bind-session',
        'conversations:unbind-session',
        'conversations:fetch-history',
        // Phase B (2026-04-29): runner-owned-sessions metadata reads.
        'conversations:get-metadata',
        // Task 7 below
        'conversations:store-runner-session',
      ],
```

Register inside `init`:

```ts
      bus.registerService<GetMetadataInput, GetMetadataOutput>(
        'conversations:get-metadata',
        PLUGIN_NAME,
        async (ctx, input) =>
          getConversationMetadata(localStore, bus, ctx, input),
      );
```

Handler:

```ts
async function getConversationMetadata(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: GetMetadataInput,
): Promise<GetMetadataOutput> {
  const hookName = 'conversations:get-metadata';
  // Same ACL posture as :get — user_id pre-filter so a foreign row
  // surfaces as 'not-found' (no existence-leak via the agents:resolve
  // denial).
  const md = await store.getMetadata(input.conversationId);
  if (md === null || md.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found', plugin: PLUGIN_NAME, hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(bus, ctx, md.agentId, input.userId, hookName);
  return md;
}
```

**Step 6.4: Export from `index.ts`**

```ts
export type {
  GetMetadataInput,
  GetMetadataOutput,
} from './types.js';
```

**Step 6.5: Run tests**

```bash
pnpm test --filter @ax/conversations
pnpm build
```

Expected: PASS.

**Step 6.6: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(conversations): conversations:get-metadata hook (Phase B)

Read-only metadata projection. Same ACL posture as conversations:get
(user_id pre-filter then agents:resolve). Returns runnerType,
runnerSessionId, workspaceRef, title, lastActivityAt — explicitly NOT
turns (turns ship via runner:read-transcript in Phase C; combining them
would recreate the lossy projection problem the design solves).

Invariants: I6 (no turns in metadata), I9 (no backend vocab).

WINDOW OPEN: hook has no in-process caller until Phase C.
EOF
)"
```

---

### Task 7: Register `conversations:store-runner-session`

**Goal:** Idempotent first-bind hook for the runner sessionId.

**Files:**
- Modify: `packages/conversations/src/types.ts`
- Modify: `packages/conversations/src/plugin.ts`
- Modify: `packages/conversations/src/index.ts`
- Test: `packages/conversations/src/__tests__/store-runner-session.test.ts`

**Step 7.1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { withTestPlugin } from './helpers/test-plugin.js';

describe('conversations:store-runner-session', () => {
  it('binds runner_session_id on first call; idempotent on repeat with same id', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      await bus.call('conversations:store-runner-session', ctx, {
        conversationId: conv.conversationId, runnerSessionId: 'sess_abc',
      });
      // Second call with same id is a no-op success.
      await bus.call('conversations:store-runner-session', ctx, {
        conversationId: conv.conversationId, runnerSessionId: 'sess_abc',
      });
      const md = await bus.call('conversations:get-metadata', ctx, {
        conversationId: conv.conversationId, userId: ctx.userId,
      });
      expect(md.runnerSessionId).toBe('sess_abc');
    });
  });

  it('throws conflict on re-bind to a different runnerSessionId', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      await bus.call('conversations:store-runner-session', ctx, {
        conversationId: conv.conversationId, runnerSessionId: 'sess_abc',
      });
      await expect(
        bus.call('conversations:store-runner-session', ctx, {
          conversationId: conv.conversationId, runnerSessionId: 'sess_OTHER',
        }),
      ).rejects.toThrowError(/conflict/);
    });
  });

  it('throws not-found on foreign user / unknown id / tombstoned row', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      // foreign user
      const otherCtx = fixtures.makeAgentContext({ userId: 'u-OTHER' });
      await expect(
        bus.call('conversations:store-runner-session', otherCtx, {
          conversationId: conv.conversationId, runnerSessionId: 'x',
        }),
      ).rejects.toThrowError(/not-found/);
      // tombstoned
      await bus.call('conversations:delete', ctx, {
        conversationId: conv.conversationId, userId: ctx.userId,
      });
      await expect(
        bus.call('conversations:store-runner-session', ctx, {
          conversationId: conv.conversationId, runnerSessionId: 'x',
        }),
      ).rejects.toThrowError(/not-found/);
    });
  });

  it('rejects empty / oversize runnerSessionId at the boundary', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      await expect(
        bus.call('conversations:store-runner-session', ctx, {
          conversationId: conv.conversationId, runnerSessionId: '',
        }),
      ).rejects.toThrowError(/invalid-payload/);
      await expect(
        bus.call('conversations:store-runner-session', ctx, {
          conversationId: conv.conversationId, runnerSessionId: 'x'.repeat(257),
        }),
      ).rejects.toThrowError(/invalid-payload/);
    });
  });
});
```

Run: `pnpm test --filter @ax/conversations -- store-runner-session.test`
Expected: FAIL — hook not registered.

**Step 7.2: Add the input/output types**

In `types.ts`:

```ts
/**
 * Phase B (2026-04-29). Bind the runner's native session id to a
 * conversation row exactly once. Called by the runner-plugin's host-side
 * IPC handler (Phase C) after the runner subprocess captures
 * `system/init.sessionId` from the SDK.
 *
 * Idempotent for re-binds to the same value (no-op success). Throws
 * `conflict` on a re-bind to a different value — that signals a runner-
 * side bug (two first-turn IPCs fired) AND prevents an orphan jsonl on
 * disk.
 *
 * ACL: `(conversation_id, ctx.userId)` UPDATE-scope only. No
 * `agents:resolve` round-trip — the host has already gated the user at
 * `agent:invoke` entry. A misbehaving caller cannot bind a cross-tenant
 * row because the UPDATE filter rejects mismatched user_id with the
 * uniform `not-found` shape.
 */
export interface StoreRunnerSessionInput {
  conversationId: string;
  runnerSessionId: string;
}
export type StoreRunnerSessionOutput = void;
```

**Step 7.3: Register hook + handler**

In `plugin.ts`:

```ts
      bus.registerService<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        PLUGIN_NAME,
        async (ctx, input) =>
          storeRunnerSessionHandler(localStore, ctx, input),
      );
```

Handler:

```ts
async function storeRunnerSessionHandler(
  store: ConversationStore,
  ctx: AgentContext,
  input: StoreRunnerSessionInput,
): Promise<StoreRunnerSessionOutput> {
  const hookName = 'conversations:store-runner-session';
  const conversationId = requireBoundedString(
    input.conversationId, 'conversationId', hookName,
  );
  const runnerSessionId = requireBoundedString(
    input.runnerSessionId, 'runnerSessionId', hookName,
  );
  const userId = requireBoundedString(ctx.userId, 'ctx.userId', hookName);
  const result = await store.storeRunnerSession({
    conversationId, userId, runnerSessionId,
  });
  switch (result) {
    case 'bound':
    case 'already-bound-same':
      return;
    case 'conflict':
      throw new PluginError({
        code: 'conflict', plugin: PLUGIN_NAME, hookName,
        message: `runner_session_id already bound to a different value for conversation '${conversationId}'`,
      });
    case 'not-found':
      throw new PluginError({
        code: 'not-found', plugin: PLUGIN_NAME, hookName,
        message: `conversation '${conversationId}' not found`,
      });
  }
}
```

**Step 7.4: Run tests**

```bash
pnpm test --filter @ax/conversations
pnpm build
```

Expected: PASS.

**Step 7.5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(conversations): conversations:store-runner-session hook (Phase B)

Idempotent first-bind for runner_session_id. Same value = no-op success;
different value = PluginError({ code: 'conflict' }) which guards against
runner-side bugs that would leave an orphan jsonl on disk.

ACL: (conversation_id, ctx.userId) UPDATE scope only; no agents:resolve
round-trip (mirrors conversations:bind-session posture).

Invariants: I7 (idempotent + conflict-on-mismatch), I9 (no backend
vocab — runnerSessionId is opaque at this layer).

WINDOW OPEN: hook has no in-process caller until Phase C.
EOF
)"
```

---

### Task 8: `chat:turn-end` subscriber bumps `last_activity_at`

**Goal:** Every non-heartbeat turn updates the activity timestamp. Heartbeats stay heartbeats.

**Files:**
- Modify: `packages/conversations/src/plugin.ts` (`handleTurnEnd`)
- Modify: `packages/conversations/src/store.ts` (already has `bumpLastActivity` from Task 4)
- Test: extend the existing turn-end subscriber test or add `__tests__/last-activity.test.ts`

**Step 8.1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { withTestPlugin } from './helpers/test-plugin.js';

describe('chat:turn-end → last_activity_at', () => {
  it('bumps last_activity_at on a turn with content blocks', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      const conversationCtx = fixtures.makeAgentContext({
        userId: ctx.userId, conversationId: conv.conversationId,
      });
      await bus.fire('chat:turn-end', conversationCtx, {
        reqId: 'req-1', role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'hello' }],
      });
      const md = await bus.call('conversations:get-metadata', ctx, {
        conversationId: conv.conversationId, userId: ctx.userId,
      });
      expect(md.lastActivityAt).not.toBeNull();
      expect(new Date(md.lastActivityAt!).getTime()).toBeGreaterThan(0);
    });
  });

  it('does NOT bump last_activity_at on a heartbeat turn-end (no contentBlocks)', async () => {
    await withTestPlugin({}, async ({ bus, ctx, fixtures }) => {
      const agent = await fixtures.createAgent({ workspaceRef: null });
      const conv = await bus.call('conversations:create', ctx, {
        userId: ctx.userId, agentId: agent.id,
      });
      const conversationCtx = fixtures.makeAgentContext({
        userId: ctx.userId, conversationId: conv.conversationId,
      });
      await bus.fire('chat:turn-end', conversationCtx, { reqId: 'req-1' });
      const md = await bus.call('conversations:get-metadata', ctx, {
        conversationId: conv.conversationId, userId: ctx.userId,
      });
      expect(md.lastActivityAt).toBeNull();
    });
  });
});
```

Run: `pnpm test --filter @ax/conversations -- last-activity.test`
Expected: FAIL — bumps don't happen.

**Step 8.2: Wire `handleTurnEnd`**

In `plugin.ts:263-306`, after the successful `:append-turn` call, bump activity. The existing function already has a try/catch for the append; we need to bump activity AFTER append succeeds and only AFTER the heartbeat-skip check has passed:

```ts
async function handleTurnEnd(
  bus: HookBus,
  store: ConversationStore,  // NEW: thread store through
  ctx: AgentContext,
  payload: TurnEndPayload,
): Promise<void> {
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) return;
  const blocks = payload.contentBlocks;
  if (blocks === undefined || blocks.length === 0) return;
  const role = payload.role ?? 'assistant';

  try {
    await bus.call<AppendTurnInput, AppendTurnOutput>(
      'conversations:append-turn',
      ctx,
      { conversationId, userId: ctx.userId, role, contentBlocks: blocks },
    );
  } catch (err) {
    ctx.logger.warn('conversations_auto_append_failed', {
      conversationId, role,
      ...(payload.reqId !== undefined ? { reqId: payload.reqId } : {}),
      err: err instanceof Error ? err : new Error(String(err)),
    });
    // Don't bump activity if the append failed — `last_activity_at` should
    // only reflect persisted activity.
    return;
  }

  // Phase B: bump activity timestamp. Subscriber-must-not-throw posture
  // applies — log + swallow on failure.
  try {
    await store.bumpLastActivity(conversationId, new Date());
  } catch (err) {
    ctx.logger.warn('conversations_bump_last_activity_failed', {
      conversationId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
```

Update the subscribe call site to pass `localStore`:

```ts
      bus.subscribe<TurnEndPayload>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await handleTurnEnd(bus, localStore, ctx, payload);  // store added
          await handleTurnEndClearReqId(localStore, ctx, payload);
          return undefined;
        },
      );
```

**Step 8.3: Run tests**

```bash
pnpm test --filter @ax/conversations
pnpm build
```

Expected: PASS.

**Step 8.4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(conversations): chat:turn-end subscriber bumps last_activity_at

Non-heartbeat turns bump conversations_v1_conversations.last_activity_at.
Heartbeats (turn-end without contentBlocks) stay heartbeats — no row
write. Bump runs after successful :append-turn so the timestamp reflects
persisted activity, not optimistic.

Subscriber-must-not-throw posture preserved: append failure logs +
returns early; bump failure logs + swallows.

Invariants: I8 (last_activity_at opaque to correctness), J7
(subscribers don't throw).
EOF
)"
```

---

### Task 9: PR description + boundary review note + plan reference

**Goal:** Document the half-wired-window opening. Boundary review for both new hooks. PR-description checklist as defined in the design doc and CLAUDE.md.

**Files:**
- New: `docs/plans/2026-04-29-phase-b-pr-notes.md` (parallel to the existing `2026-04-29-phase-3-pr-notes.md`)
- Reference only: `docs/plans/2026-04-29-runner-owned-sessions-design.md`

**Step 9.1: Write the PR notes**

Format from `docs/plans/2026-04-29-phase-3-pr-notes.md`. Sections:

1. **Summary** (2-3 bullets — what shipped).
2. **Boundary review** — `conversations:get-metadata` and `conversations:store-runner-session`. For each: alternate impl, payload-leak audit, subscriber risk, wire surface (none — both are host-internal service hooks).
3. **WINDOW OPEN — closed by Phase C** — explicit half-wired-window section listing the two new hooks with no in-process caller. State: "merged on the assumption that Phase C is the next-PR-up. If Phase C is not next, revert this PR before merging anything else."
4. **Migration safety** — `ALTER TABLE ADD COLUMN IF NOT EXISTS` is idempotent. Greenfield = no production data. Test fixtures updated in lockstep.
5. **Deviations from design doc** — list I1, I2, I3 with one-line justifications: I1 (no v1→v2 split — ever; greenfield, ALTER in place forever), I2 (defer summary/preview to Phase F), I3 (workspace_ref TEXT NULL, not JSONB NOT NULL).
6. **Test coverage** — list each new test file + which behavior it pins.
7. **Reviewer asks** — explicit asks: confirm boundary review fields; confirm window-pattern phrasing; confirm `runnerSessionId` opacity (no SDK-shape leak in field names).

**Step 9.2: No code commit yet — this is documentation only.**

Commit:

```bash
git add docs/plans/2026-04-29-phase-b-pr-notes.md
git commit -m "docs(plans): Phase B PR notes — boundary review + window-open declaration"
```

---

### Task 10: Final verification + open the PR

**Goal:** All tests + build green. Push + open PR with the structured body.

**Step 10.1: Run the full suite**

```bash
pnpm build && pnpm test
```

Expected: PASS.

**Step 10.2: Final boundary review pass (review-yourself, then ship)**

Re-read the boundary-review block in `phase-b-pr-notes.md`. Per the conventions skill:

- Did you name an alternate impl for both new hooks? (`conversations:get-metadata` → a sqlite-backed conversations plugin would register the same name; `conversations:store-runner-session` → same.)
- Any payload field name that only makes sense for postgres / claude-sdk / git? (Spoiler: no. `runnerSessionId` is opaque; `lastActivityAt` is generic.)
- Could a subscriber key off a backend-specific field? (No subscribers — both are service hooks.)
- Wire surface (IPC actions schema)? (None — both are host-internal hook calls.)

If any answer feels weak, fix the field name BEFORE pushing — I9 says rename now (cheap) before subscribers depend on them (expensive).

**Step 10.3: Push + open PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Phase B: @ax/conversations metadata schema + new hooks" --body "$(cat <<'EOF'
## Summary

- ALTER TABLE adds `runner_type`, `runner_session_id`, `workspace_ref`, `last_activity_at` to `conversations_v1_conversations` (nullable).
- New service hooks: `conversations:get-metadata` (sidebar / runner-plugin reads) and `conversations:store-runner-session` (idempotent first-bind).
- `conversations:create` freezes `runner_type` (from new `defaultRunnerType` config) + `workspace_ref` (from `agents:resolve`'s returned agent).
- `chat:turn-end` subscriber bumps `last_activity_at` after successful `:append-turn`. Heartbeats still don't write rows.

See `docs/plans/2026-04-29-phase-b-pr-notes.md` for boundary review and the half-wired-window declaration.

## Test plan

- [ ] `pnpm build && pnpm test` is green.
- [ ] `pnpm test --filter @ax/conversations` is green and includes the 5 new test files.
- [ ] Migration is idempotent (re-runnable test passes).
- [ ] `conversations:get-metadata` returns null `runnerSessionId` for new conversations and the bound value after a `:store-runner-session` call.
- [ ] `:store-runner-session` is idempotent for repeats and rejects with conflict on mismatch.
- [ ] `last_activity_at` bumps on content-bearing turns and stays null on heartbeats.

## Window declaration

WINDOW OPEN — `conversations:get-metadata` and `conversations:store-runner-session` have no in-process caller in this PR. Closed by Phase C (runner-side jsonl handling + runner plugin's host-side `runner:read-transcript` registration). If Phase C is not the next PR up, revert this PR before merging anything else (memory: `feedback_half_wired_window_pattern.md`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Done criteria

- All ten tasks committed; PR pushed and opened.
- `pnpm build && pnpm test` green.
- PR body contains: window-open declaration, boundary review, deviation list, test plan checklist.
- No new lint warnings (`@ax/conversations` already imports `@ax/core`/`@ax/ipc-protocol`/`zod`; no `WORKSPACE_REF_RE` import from `@ax/agents`).
- `.claude/memory/` updated at session end: any "I worked differently than the plan said" insight goes to `meta.md`; project-level "Phase B shipped" pointer goes to auto-memory.

## What this enables (Phase C)

- Runner-plugin host-side surface can register `runner:read-transcript` against this metadata table.
- Runner subprocess can IPC `conversations:store-runner-session` after capturing `system/init.sessionId`.
- Channel-web's eventual `:get-metadata` call (Phase D) has a hook to call.
- The half-wired window closes when those callers land.
