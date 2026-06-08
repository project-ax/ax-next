# TASK-177 — generic per-agent default-routine override (default enabled)

**Epic:** skill-crystallization (PR-B)
**Package:** `@ax/routines` (a generic routines capability, NOT a skills concern)
**Design authority:** `docs/plans/2026-06-08-skill-crystallization-design.md`
**Date:** 2026-06-08

> Note: the dispatch referenced a separate `…-implementation-plan.md` (PR-B) that does
> not exist in the repo. The card scope is fully self-contained and pre-answers the
> boundary review; the design doc supplies architecture context. This file is the PR-B
> plan, derived from the card + design.

## Why

Today every enabled row in `default_routines_v1` materializes one per-agent row in
`routines_v1_definitions` for every personal agent (see `store.materializeMissing`).
There is no way to turn a single default OFF for a single agent — it's all or nothing
(the admin-level `default_routines_v1.enabled` flag toggles it for *everyone*).

`skill-reflection` (TASK-178) is the first default routine a user will reasonably want
to disable per-agent ("don't auto-write skills for *this* agent"). This card adds a
generic per-agent on/off for *any* default routine, **default-ENABLED** so there is
zero compatibility risk to the existing heartbeat default ("absence of an override row
= enabled").

## Approach (locked decisions)

- **Additive table `agent_default_routine_overrides_v1`** keyed `(agent_id, default_routine_id)`,
  storing only explicit *disables*. Absence of a row ⇒ enabled. This keeps the default
  ON and means existing materialized rows are untouched on migration.
- **Gate `materializeMissing`**: when cross-joining agents × enabled defaults, skip any
  `(agent, default)` pair that has a disable override. Default ON.
- **`removeMaterializedDefault(agentId, defaultRoutineId)`**: the materialized row in
  `routines_v1_definitions` has **no enabled/active flag** (checked the schema — there
  is none; rows are present-or-absent). So we **DELETE** the `(agent, default)` row.
  Fire history lives in `routines_v1_fires`, which has **no FK** to definitions
  (confirmed in migrations.ts comment + the cascade test), so deleting the definition
  row preserves fire history regardless. The card's "prefer flag-flip if a flag exists"
  resolves to DELETE here because no such flag exists.
- **Two new service hooks** (storage-agnostic, owner-scoped, NOT IPC actions):
  - `routines:set-agent-default-enabled` — payload `{ agentId, defaultRoutineId, enabled }`.
    Auth: caller must own `agentId` (reuse `agents:resolve` ACL gate, which throws
    `forbidden`/`not-found` for non-owners). `enabled=false` ⇒ write disable override +
    `removeMaterializedDefault` (de-materialize). `enabled=true` ⇒ remove the override
    row + `materializeMissing` for that one agent (re-materialize). Idempotent.
  - `routines:list-agent-defaults` — payload `{ agentId }` (owner-scoped) → returns
    `{ defaults: { defaultRoutineId, name, enabled }[] }`, one entry per known default
    reflecting this agent's per-agent state (enabled unless a disable override exists).

## Tasks

1. **Migration + types** — add `agent_default_routine_overrides_v1` table (additive
   `CREATE TABLE IF NOT EXISTS`) + the `AgentDefaultRoutineOverridesRow` interface and
   `RoutinesDatabase` entry. PK `(agent_id, default_routine_id)`. Columns:
   `agent_id, default_routine_id, owner_user_id, enabled, updated_at`. FK on
   `default_routine_id → default_routines_v1(default_routine_id) ON DELETE CASCADE`
   (so deleting a default cleans up its overrides — matches existing cascade discipline).
   Test: migration is idempotent; table present after migrate.

2. **Store methods** — add to `RoutinesStore`:
   - `setAgentDefaultEnabled({ agentId, defaultRoutineId, ownerUserId, enabled })` —
     upsert (enabled=true ⇒ delete override row; enabled=false ⇒ insert/update a
     disable row).
   - `isAgentDefaultEnabled({ agentId, defaultRoutineId })` → boolean (absent ⇒ true).
   - `disabledDefaultIdsForAgent(agentId)` → `string[]` of disabled default ids.
   - `removeMaterializedDefault({ agentId, defaultRoutineId })` — DELETE the per-agent
     materialized row (`definition_id = defaultRoutineId`).
   Gate `materializeMissing` SQL to exclude disabled `(agent, default)` pairs via a
   `NOT EXISTS` against the override table where `enabled = false`.
   Tests (store.test.ts, testcontainers PG): absent=enabled; disable persists +
   de-materializes; re-enable removes override + re-materializes; `materializeMissing`
   skips a disabled default for that agent only (other agents still get it).

3. **Hooks** — register `routines:set-agent-default-enabled` +
   `routines:list-agent-defaults` in plugin.ts; add the I/O interfaces + `returns`
   zod schemas in types.ts; export from index.ts. Set hook resolves the agent via
   `agents:resolve` ({ agentId, userId: ctx.userId }) for the owner ACL + to obtain
   `agent.ownerId` to stamp the re-materialized row's owner. Add `agents:resolve` to
   the manifest `calls`. Tests (service-hooks.test.ts): set hook auth-scoped to owner
   (non-owner ⇒ forbidden); list reflects per-agent state; disable→list shows
   enabled:false; re-enable→list shows enabled:true.

4. **Whole-branch gate + review** — `pnpm build && pnpm -r run test` (routines filter
   first, then full) + lint; ax-code-reviewer; security-checklist note (new table +
   auth-scoped hooks = access-control boundary).

## Boundary review (for the PR body)

- **Alternate impl:** the override store could be Postgres (current), an in-memory map
  for a single-replica dev preset, or a per-agent workspace file. The hooks expose only
  `{ agentId, defaultRoutineId, enabled }` + `{ defaultRoutineId, name, enabled }` — no
  table/column/FK vocab leaks.
- **Leaky field names:** none. (`defaultRoutineId` is the public default id already used
  by `routines:list-defaults`/`routines:get-default`; not a backend-specific token.)
- **Subscriber risk:** these are request/response service hooks with no subscribers
  keying off backend fields.
- **Wire surface:** NOT IPC actions (no `channel-web` action schema). If a later admin
  UI surfaces the toggle it routes through the existing routines admin IPC, out of scope
  here.

## YAGNI

- No admin UI in this card (design item #3 "per-agent enable toggle in admin" is a later
  consumer — TASK-179). This card ships the generic capability + hooks + tests only.
- No re-enable "restore prior last_run_at" — re-materialize starts fresh (next_run_at
  NULL, last_run_at NULL ⇒ fires on next due window), which matches first-materialize
  semantics. Acceptable: a re-enabled default behaves like a freshly-materialized one.
