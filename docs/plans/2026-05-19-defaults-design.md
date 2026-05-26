# Default skills + routines — design

**Status:** Proposed
**Date:** 2026-05-19
**Related:**
- `docs/plans/2026-05-17-skill-install-workflow-design.md` — the existing skill-install workflow this design builds on (Phase 0 + Phase 1 shipped in PRs #95/#96/#99).
- `packages/skills/` — the `@ax/skills` plugin (admin-managed installed skills, table `skills_v1_skills`).
- `packages/routines/` — the `@ax/routines` plugin (workspace-defined routines, table `routines_v1_definitions`).
- `packages/agents/src/types.ts` — `Agent.skillAttachments: SkillAttachment[]` (per-agent skill linkage shipped with Phase 1).
- `packages/routines/src/seed-heartbeat.ts` — current single-routine seed pattern on `agents:created`, becomes vestigial under this design.
- `CLAUDE.md` invariants 1, 3, 4, 5 (storage-agnostic hooks, no half-wired plugins, one source of truth, capabilities minimized).

---

## Goal

Let an admin define a **default set of skills and routines** that every agent receives without per-agent setup, and have edits to those defaults propagate to every agent on each agent's next session/tick — with no per-agent sweep on admin write.

Skills are content the SDK loads from filesystem; routines are content the host runs on a schedule and delivers as chat turns. The two halves of this design share a mental model ("admin curates, every agent gets it") but otherwise diverge.

### Non-goals (deferred)

- **Per-team, per-owner, or per-tenant defaults.** v1 is global only. The data model can additively grow a `scope` column later without breaking the v1 read paths.
- **Capability-bearing default skills.** Skills declaring `capabilities.credentials` cannot be `default_attached` in v1. Capability-bearing defaults require per-agent credential bindings, which is its own UX problem — added later via a `default_bindings` column on `skills_v1_skills` when motivated.
- **Per-agent opt-out from a default.** No `disabled_defaults` list per agent. If a default shouldn't apply to some agent, it shouldn't be a default — re-attach explicitly to the agents that want it. v1 supports overriding a default routine by writing a workspace routine with the same name; that's the only opt-out mechanic.
- **Filesystem materialization of routine defaults.** Routines are host-consumed, not model-consumed. The agent gains no `file_read` introspection of default routines. Symmetry with workspace routines is sacrificed deliberately.
- **Admin "Defaults" cross-cutting tab.** Defaults live in their kind's existing admin surface (`/admin/skills` for skills, `/admin/routines` for routines).

---

## How this lands the invariants

| Invariant | How this design satisfies it |
|---|---|
| **I1** — Transport/storage-agnostic hooks | New hook `skills:list-defaults` returns `ResolvedSkill[]`, the same shape `skills:resolve` already returns. No `default_attached_at`, no row ids leaking through. The routines side reuses existing `routines:list/recent-fires/fire-now` — default-sourced rows are indistinguishable from workspace-sourced rows at the hook surface except for a `source` discriminator that callers may ignore. |
| **I3** — No half-wired plugins | Each PR (skills-half, routines-half) ships its piece end-to-end. Skills-half: column + hook + orchestrator union + admin checkbox + canary acceptance test in same PR. Routines-half: tables + claim SQL + sync deletion + admin sub-section + canary acceptance test in same PR. CLI + k8s preset wired same PR. |
| **I4** — One source of truth | Default-skill content lives only in `skills_v1_skills`. Default-routine content lives only in `default_routines_v1`. Per-agent skill attachment lives only on the agent record's `skillAttachments` JSONB (Phase 1 surface). Per-agent routine firing state lives only in `routines_v1_definitions`. Nothing is duplicated. |
| **I5** — Capabilities explicit and minimized | Skill defaults are restricted to instruction-only (no `capabilities.credentials`) in v1 — the agent can't gain credential access via "everyone gets this" by default. Routine defaults inherit the same `agent:invoke` boundary as workspace routines; no new capability surface. The host-side default store is admin-write-only, gated by `auth:require-admin`. |

---

## Vocabulary

- **Default skill** — a row in `skills_v1_skills` with `default_attached = true`. Auto-resolved at session-open by the orchestrator and union'd with the agent's explicit `skillAttachments`. Same materialization path as Phase 1 installed skills (`$HOME/.ax/session/skills/<skill_id>/SKILL.md`).
- **Default routine** — a row in `default_routines_v1`. Materialized lazily at tick time as a state-only row in `routines_v1_definitions` per agent. Shares all the firing machinery with workspace routines.
- **Workspace routine override** — when an agent's workspace contains a routine `.md` whose frontmatter `name` matches a default routine, the workspace row "wins" — at workspace-sync time the per-agent default state row for that name is removed.
- **Heartbeat migration** — the current `seed-heartbeat` subscriber that writes `.ax/routines/heartbeat.md` into each new agent's workspace at `agents:created` is replaced by a first-boot seed of `default_routines_v1` with the same heartbeat content. The subscriber is deleted in the routines-half PR.

---

## Part A — Skill defaults

### Storage

One new column on the existing table:

```sql
ALTER TABLE skills_v1_skills
  ADD COLUMN default_attached BOOLEAN NOT NULL DEFAULT false;
```

No new tables, no new rows, no FKs. The existing skill manifest, body, and version are reused.

**CHECK constraint** to enforce v1 instruction-only defaults:

```sql
-- A default-attached skill cannot declare credential slots.
-- Enforced at upsert time by parsing manifest_yaml.capabilities.credentials,
-- and as a runtime guard in skills:upsert.
-- (Not a DB-level constraint because parsing YAML in postgres is overkill.)
```

The constraint is enforced in `skills:upsert` validation in `@ax/skills` (manifest parser already runs there) and in the admin UI (checkbox disabled with tooltip).

### Hook surface

One new service hook, registered by `@ax/skills`:

```ts
type SkillsListDefaultsInput = Record<string, never>;
interface SkillsListDefaultsOutput {
  skills: ResolvedSkill[];  // same shape skills:resolve returns
}
```

Returns all skills with `default_attached = true`, in the same `ResolvedSkill` shape (`{ id, capabilities, bodyMd, manifestYaml }`) the orchestrator already knows how to consume. Order is stable (by `skill_id` ASC).

The existing `skills:resolve(skillIds)` is untouched — kept narrow and explicit.

### Orchestrator change

At `chat-orchestrator/src/orchestrator.ts:806-875` the orchestrator already does:

```ts
attachments = agent.skillAttachments
if (attachments.length > 0 && bus.hasService('skills:resolve')) {
  { skills: resolvedSkills } = await bus.call('skills:resolve', { skillIds })
}
// ... build installedSkillsForSandbox from resolvedSkills
```

Extend with:

```ts
let defaultSkills: ResolvedSkill[] = []
if (bus.hasService('skills:list-defaults')) {
  ({ skills: defaultSkills } = await bus.call('skills:list-defaults', {}))
}

// Union — explicit attachments win on id collision (their bindings matter,
// but v1 defaults have no bindings, so this is mostly future-proofing).
const explicitIds = new Set(resolvedSkills.map(s => s.id))
const unioned = [
  ...resolvedSkills,
  ...defaultSkills.filter(s => !explicitIds.has(s.id))
]

// installedSkillsForSandbox built from `unioned` instead of resolvedSkills.
```

Same downstream — `installedSkillsForSandbox` flows into `sandbox:open-session` as today.

### Failure modes

- `skills:list-defaults` throws → log + treat as empty list (defaults are non-essential, agents should still load). Distinguish from `skill-resolve-failed` (which terminates the session because an explicit attachment couldn't be resolved).
- `skills:list-defaults` not registered (`@ax/skills` not in preset) → silent no-op via the `bus.hasService` guard, same shape as the existing `skills:resolve` guard.

### Admin UI

`/admin/skills/:id` edit view gains a checkbox:

```
[ ] Default-attached to all agents
    Adds this skill to every agent at session start, without per-agent
    setup. Only available for instruction-only skills (no credential
    slots declared).
```

Checkbox `disabled` with the tooltip "Capability-bearing skills must be attached per agent" when `capabilities.credentials.length > 0`.

The list view's "Used by" column annotates default-attached rows: `2 agents (+ all by default)` or `default-attached` for skills with no explicit attachments.

### Update propagation

Admin edits SKILL.md content → `skills_v1_skills.body_md` + `manifest_yaml` + `updated_at` updated → next session's `skills:list-defaults` call returns new content → sandbox materializes new bytes at `$HOME/.ax/session/skills/<skill_id>/SKILL.md`. Zero per-agent state, zero sweeps, zero cron-style background work.

---

## Part B — Routine defaults

### Storage

One new table owned by `@ax/routines`:

```sql
CREATE TABLE default_routines_v1 (
  default_routine_id  TEXT        PRIMARY KEY,             -- ULID
  name                TEXT        NOT NULL UNIQUE,         -- matches frontmatter name; used for override matching
  description         TEXT        NOT NULL,
  spec_hash           TEXT        NOT NULL,
  trigger_kind        TEXT        NOT NULL CHECK (trigger_kind IN ('interval','cron','webhook')),
  trigger_spec        JSONB       NOT NULL,                -- e.g. {"kind":"interval","every":"24h"}
  interval_seconds    INTEGER,                             -- denormalized from trigger_spec.every via durationToSeconds; non-null iff trigger_kind = 'interval'
  active_hours        JSONB,
  silence_token       TEXT,
  silence_max         INTEGER     NOT NULL DEFAULT 300 CHECK (silence_max >= 0),
  conversation        TEXT        NOT NULL CHECK (conversation IN ('per-fire','shared')),
  prompt_body         TEXT        NOT NULL,
  enabled             BOOLEAN     NOT NULL DEFAULT true,
  source_md           TEXT        NOT NULL,                -- original .md content for admin display + round-trip edits
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((trigger_kind = 'interval') = (interval_seconds IS NOT NULL))
);
```

The `interval_seconds` column is computed at upsert time by the existing `durationToSeconds()` helper in `@ax/validator-routine`. Stored explicitly so the claim SQL can compare directly without parsing JSON or interpreting duration strings.

The column set mirrors `routines_v1_definitions` for parsed fields plus `source_md` for the unparsed original.

**Extension to `routines_v1_definitions`** — one nullable FK column:

```sql
ALTER TABLE routines_v1_definitions
  ADD COLUMN definition_id TEXT REFERENCES default_routines_v1 (default_routine_id) ON DELETE CASCADE;

CREATE INDEX routines_v1_definitions_default_idx
  ON routines_v1_definitions (definition_id, last_run_at)
  WHERE definition_id IS NOT NULL;
```

**Row shape contract:**

- **Workspace-sourced row** (`definition_id IS NULL`): unchanged from today. All parsed fields populated. `path` is the workspace file path (`.ax/routines/<name>.md`). `next_run_at` driven by sync.
- **Default-sourced row** (`definition_id IS NOT NULL`): `path = 'default:' || default_routine_id`. Parsed fields (`trigger_kind`, `trigger_spec`, `prompt_body`, `name`, `description`, `silence_*`, `conversation`, `active_hours`) are populated as a denormalized copy from the default at materialization time (read via JOIN at claim time would also work — see "Why denormalize parsed fields" below). `next_run_at` is **always NULL** — claim SQL computes it from `last_run_at` and the default's trigger.

**CHECK constraint** to keep the invariant honest:

```sql
ALTER TABLE routines_v1_definitions
  ADD CONSTRAINT default_row_has_null_next_run_at CHECK (
    definition_id IS NULL OR next_run_at IS NULL
  );
```

**Override mechanic** — by runtime predicate, not constraint. A workspace row and a default-sourced row with the same `name` can coexist in `routines_v1_definitions`; the default-sourced row is filtered out at claim time and at materialization time when a same-name workspace row exists for the agent. No change to the existing sync subscriber — it continues to upsert workspace rows by `(agent_id, path)`. This avoids touching existing sync behavior or adding a constraint that would break if two workspace files in the same agent ever shared a frontmatter `name`.

```sql
-- Helper predicate used in claim SQL and materialization SQL:
--   workspace row with the same name exists for this agent
WHERE NOT EXISTS (
  SELECT 1 FROM routines_v1_definitions w
   WHERE w.agent_id = r.agent_id
     AND w.definition_id IS NULL  -- workspace
     AND w.name = r.name
)
```

When the agent deletes their workspace override, the default-sourced row (which was always there, just filtered) becomes claimable again on the next tick. No re-materialization needed.

### Why denormalize parsed fields onto default-sourced rows?

The alternative is "default-sourced rows hold only state; parsed fields are read via JOIN at claim time." That works and avoids drift, but at claim time we'd join across two tables on every tick. Denormalizing keeps the existing claim query shape and indices intact. The cost is: when the admin edits a default's trigger schedule, every existing default-sourced state row's denormalized copy goes stale until refreshed.

To handle that without a sweep:

- Default-sourced rows track `default_routines_v1.updated_at` via a `definition_updated_at TIMESTAMPTZ` column on `routines_v1_definitions` (denormalized, set at materialization).
- Claim SQL adds a predicate: only claim default-sourced rows whose `definition_updated_at >= default_routines_v1.updated_at`.
- Rows that are stale are not claimed; the tick loop's lazy materializer re-renders them in place (UPDATE setting all parsed fields + `definition_updated_at = default_routines_v1.updated_at`).
- This is per-row, on-demand, in the tick loop. No sweep. Crash-safe: a partially-refreshed table just has more rows that the next tick will refresh.

This is the "version pointer" pattern: defaults have an `updated_at`; per-agent rows track which version they're synced to; reads compare and self-heal.

### Crash safety across admin edits

| Event | Persisted change | Crash-window state |
|---|---|---|
| Edit content (`prompt_body`, `silence_token`, etc.) | UPDATE 1 row in `default_routines_v1` (sets `updated_at`) | Atomic; per-agent rows now stale until next tick re-materializes |
| Edit trigger schedule | UPDATE 1 row in `default_routines_v1` (sets `updated_at`) | Atomic; per-agent rows stale; tick loop refreshes lazily |
| Edit trigger kind (e.g., interval → webhook) | UPDATE 1 row + webhook route re-bind on startup (idempotent, Phase C pattern) | Webhook rebind is reconstructed from DB at startup; crash mid-rebind = next startup reconstructs |
| Add new default | INSERT 1 row in `default_routines_v1` | First-fire state row materializes lazily when tick loop encounters the (agent, default) pair |
| Disable a default (`enabled = false`) | UPDATE 1 row | Claim SQL skips disabled defaults; existing state rows orphaned, purged on next tick or via background sweep job (idempotent) |
| Delete a default | DELETE 1 row | ON DELETE CASCADE removes all per-agent state rows in one statement |

No multi-row sweep on any path. The only multi-row work is `ON DELETE CASCADE`, which postgres handles atomically.

### Claim SQL shape

The existing `claimDue` reads:

```sql
WITH due AS (
  SELECT agent_id, path
    FROM routines_v1_definitions
   WHERE next_run_at IS NOT NULL
     AND next_run_at <= now()
   ORDER BY next_run_at ASC
   LIMIT $batch
   FOR UPDATE SKIP LOCKED
)
UPDATE routines_v1_definitions r
   SET next_run_at = r.next_run_at + ($claimWindowMinutes || ' minutes')::interval
  FROM due ...
```

Extended to also pick up default-sourced rows whose computed-from-last_run_at indicates due:

```sql
WITH due AS (
  -- workspace rows: existing predicate
  SELECT agent_id, path
    FROM routines_v1_definitions
   WHERE definition_id IS NULL
     AND next_run_at IS NOT NULL
     AND next_run_at <= now()

  UNION ALL

  -- default-sourced rows (interval): computed-due, override-respecting
  SELECT r.agent_id, r.path
    FROM routines_v1_definitions r
    JOIN default_routines_v1 d ON d.default_routine_id = r.definition_id
   WHERE r.definition_id IS NOT NULL
     AND d.enabled
     AND d.trigger_kind = 'interval'
     AND r.definition_updated_at >= d.updated_at  -- skip stale; tick refreshes them on a separate pass
     AND COALESCE(r.last_run_at, r.created_at)
         + (d.interval_seconds || ' seconds')::interval <= now()
     AND NOT EXISTS (                              -- name-shadowed by workspace override
       SELECT 1 FROM routines_v1_definitions w
        WHERE w.agent_id = r.agent_id
          AND w.definition_id IS NULL
          AND w.name = r.name
     )

  ORDER BY ... LIMIT $batch
  FOR UPDATE SKIP LOCKED
)
UPDATE ... FROM due ...
```

For cron-triggered default rows we keep the existing pattern: coarse SQL pre-filter on `COALESCE(last_run_at, created_at) <= now() - 1 minute`, then in-process `croner` evaluation before claiming. The Phase C `croner` pin already handles this for workspace cron and the code path is shared.

For webhook-triggered default rows there is no claim-time work — webhook fires are driven by HTTP requests, the webhook handler resolves the per-agent state row via the same `(agent_id, definition_id)` lookup it already uses for `agents:resolve-by-webhook-token`. Webhook token strategy: each default-sourced state row gets its own token at materialization time; admin token rotation per default routine is a follow-up (existing per-agent `agents:rotate-webhook-token` flow rotates ALL of an agent's routine tokens together — sufficient for v1).

### Lazy materialization

The tick loop, before its existing claim pass, runs a cheap "materialize missing rows" pass:

```sql
INSERT INTO routines_v1_definitions
  (agent_id, path, author_user_id, name, description, spec_hash,
   trigger_kind, trigger_spec, active_hours, silence_token, silence_max,
   conversation, prompt_body, next_run_at, definition_id, definition_updated_at,
   created_at, updated_at)
SELECT
  a.agent_id, 'default:' || d.default_routine_id, '@ax/routines/defaults' AS author_user_id,
  d.name, d.description, d.spec_hash,
  d.trigger_kind, d.trigger_spec, d.active_hours, d.silence_token, d.silence_max,
  d.conversation, d.prompt_body, NULL AS next_run_at,
  d.default_routine_id, d.updated_at,
  now(), now()
FROM agents_v1_agents a
CROSS JOIN default_routines_v1 d
WHERE d.enabled
  AND NOT EXISTS (
    SELECT 1 FROM routines_v1_definitions r
     WHERE r.agent_id = a.agent_id
       AND r.definition_id = d.default_routine_id  -- already materialized for this (agent, default)
  )
ON CONFLICT (agent_id, path) DO NOTHING;
```

This is a single statement per tick, scoped to "agents without a row for some default." Postgres handles the conflict from the unique `(agent_id, name)` index, so concurrent materialization from multiple workers is safe.

**Why on tick, not on `agents:created`?**
1. Avoids the seed-on-create write storm if N defaults exist.
2. Single mechanism instead of two (no special creation-time path).
3. New defaults added by admin are materialized automatically without a separate trigger.
4. Crash-safe: if the tick crashes mid-materialization, the next tick picks up where it left off (ON CONFLICT DO NOTHING idempotent).

Cost: a CROSS JOIN'd LEFT NOT EXISTS scan once per tick. For the expected scale (≤ 10K agents × ≤ 50 defaults) this is sub-millisecond with the existing indices.

**Staleness refresh pass** runs in the same tick:

```sql
UPDATE routines_v1_definitions r
   SET name = d.name, description = d.description, spec_hash = d.spec_hash,
       trigger_kind = d.trigger_kind, trigger_spec = d.trigger_spec,
       active_hours = d.active_hours, silence_token = d.silence_token,
       silence_max = d.silence_max, conversation = d.conversation,
       prompt_body = d.prompt_body,
       definition_updated_at = d.updated_at,
       updated_at = now()
  FROM default_routines_v1 d
 WHERE r.definition_id = d.default_routine_id
   AND r.definition_updated_at < d.updated_at;
```

Again single-statement, idempotent, crash-safe.

### Override semantics (workspace wins)

When `@ax/routines`' existing sync subscriber processes `workspace:applied` and finds a new workspace routine at `.ax/routines/foo.md`, it parses the frontmatter, extracts `name`, and upserts:

```sql
INSERT INTO routines_v1_definitions (agent_id, path, name, ...) VALUES (...)
ON CONFLICT (agent_id, name) DO UPDATE SET ...
```

The new unique `(agent_id, name)` index ensures the workspace row replaces any default-sourced row with the same `name`. If the agent later deletes their workspace routine, the next tick's lazy materializer re-creates the default-sourced row.

Edge case: a workspace routine and a default share a name but have different trigger kinds (e.g., default heartbeat is `interval`, agent writes a workspace `cron` heartbeat). The workspace row simply takes over. The agent has chosen a different schedule; that's fine.

Edge case: the agent's workspace routine has malformed YAML, the validator rejects the write (existing veto), the agent's `.md` never makes it to `routines_v1_definitions`, the default-sourced row remains. Good.

### Heartbeat migration

In the routines-half PR:

1. `seed-heartbeat.ts` and `heartbeat-template.ts` are deleted. The `agents:created` subscriber is removed from `routines/src/plugin.ts`.
2. The new migration `runRoutinesMigration` step inserts a single row into `default_routines_v1` if the table is empty:
   ```sql
   INSERT INTO default_routines_v1
     (default_routine_id, name, description, spec_hash, trigger_kind,
      trigger_spec, interval_seconds, silence_token, silence_max,
      conversation, prompt_body, source_md, ...)
   VALUES
     ('default-heartbeat-2026-05-19', 'heartbeat', 'daily check-in', ...,
      'interval', '{"kind":"interval","every":"24h"}'::jsonb, 86400,
      'HEARTBEAT_OK', 300, 'shared',
      'If nothing''s outstanding...', '<full .md bytes>')
   ON CONFLICT (name) DO NOTHING;
   ```
3. Existing agents whose `.ax/routines/heartbeat.md` was seeded from the old subscriber keep their workspace routine; it overrides the default by `name`. No data loss; behavior is unchanged for them.
4. New agents get the default heartbeat materialized lazily on first tick. Behavior is unchanged for them too.

### Admin UI

`/admin/routines` (Phase D modal in `channel-web`) gains a "Default routines" sub-section above the per-agent table:

```
┌─ Default routines ────────────────────────────────────────────────┐
│  Applied to every agent at tick time. Edits propagate to all      │
│  agents on their next tick.                                       │
│                                                                   │
│  [ + New default routine ]                                        │
│                                                                   │
│  ┌─────────────┬───────────────────┬──────────┬────────┐          │
│  │ Name        │ Trigger           │ Enabled  │ Used   │          │
│  ├─────────────┼───────────────────┼──────────┼────────┤          │
│  │ heartbeat   │ interval / 24h    │ ☑        │ 47/47  │          │
│  └─────────────┴───────────────────┴──────────┴────────┘          │
└───────────────────────────────────────────────────────────────────┘
```

"Used" shows `<materialized>/<total agents>` so admin can spot agents whose workspace overrides have shadowed the default.

Edit view is a single textarea with the `.md` content (same shape as the per-agent routine editor). On save, the routes call `routines:upsert-default` (new service hook), which parses + validates the frontmatter using the existing `@ax/validator-routine` and writes to `default_routines_v1`. Webhook trigger kind is allowed; webhook routes per-(agent, default) re-bind on startup.

Hooks added (registered by `@ax/routines`, surfaced via `@ax/routines-admin-routes`):

- `routines:list-defaults` — admin list view
- `routines:get-default` — admin edit view
- `routines:upsert-default` — admin save
- `routines:delete-default` — admin delete

All `auth:require-admin`-gated at the HTTP layer.

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Admin (browser, channel-web SPA)                                     │
│                                                                      │
│   /admin/skills (existing)                                           │
│     edit view gains:  [ ] Default-attached to all agents             │
│                                                                      │
│   /admin/routines (existing Phase D modal)                           │
│     new sub-section:  Default routines [ + New ] [edit] [delete]    │
└──────────────────────────────────────────────────────────────────────┘
                                  │
┌──────────────────────────────────────────────────────────────────────┐
│ Host process                                                         │
│                                                                      │
│   @ax/skills (extended)                                              │
│   ├── schema: skills_v1_skills.default_attached BOOLEAN              │
│   ├── new hook: skills:list-defaults  (returns ResolvedSkill[])      │
│   └── validation: upsert rejects default_attached + capability slots │
│                                                                      │
│   @ax/routines (extended)                                            │
│   ├── new table:     default_routines_v1                             │
│   ├── schema delta:  routines_v1_definitions.definition_id (FK)      │
│   │                  routines_v1_definitions.definition_updated_at   │
│   ├── new hooks:     routines:list-defaults / get-default /          │
│   │                  upsert-default / delete-default                 │
│   ├── tick loop:     +materialize pass, +staleness refresh pass      │
│   ├── claim SQL:     UNION ALL workspace + default-sourced           │
│   ├── seed-heartbeat DELETED; first-boot seed of default_routines_v1 │
│   └── webhook routes: include default-sourced rows on startup mount  │
│                                                                      │
│   @ax/chat-orchestrator (extended)                                   │
│   └── session-open: after skills:resolve, call skills:list-defaults  │
│                     and union into installedSkills (dedup by id)     │
│                                                                      │
│   @ax/routines-admin-routes (extended)                               │
│   └── HTTP routes for /admin/routines/defaults[/:id]                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Trust model

- **Default skills** are admin-curated and instruction-only in v1. Same trust level as today's installed skills' bodies — operator-trusted content that lands in the agent's context. No path for an end user or agent to mutate them.
- **Default routines** are admin-curated. The `prompt_body` lands as a chat turn into the agent — same trust as the body of a workspace routine the agent itself wrote, except it's the operator's content not the agent's.
- **Workspace override** of default routines: when the agent writes `.ax/routines/heartbeat.md`, the `workspace:pre-apply` veto path (existing) and `@ax/validator-routine` parse + validate the file. The override path doesn't grant new capabilities — workspace routines were always able to define schedules in `.ax/routines/`.
- **Webhook tokens for default routines** are per-(agent, default), generated at materialization time. Compromise of one token reveals one (agent, default) pair; rotation is via existing `agents:rotate-webhook-token` (agent-level rotation covers all of the agent's routines, default-sourced included).

The `security-checklist` skill should run when extending the validator and the orchestrator union — both touch boundaries where the threat models (prompt injection via skill body, supply chain via what gets default-attached) apply. Plan an explicit security-checklist pass in the impl plan task list.

---

## Open questions

These can be resolved during impl, not blockers:

1. **Should `skills:list-defaults` cache?** Admin edits are rare; orchestrator calls happen once per session-open. A simple in-process cache with TTL or invalidation via `defaults:changed` event reduces DB load. Probably YAGNI for v1 — DB hit is cheap.

2. **Should the routine materialization pass run on every tick or N ticks?** Worst case it's a CROSS JOIN scan once per tick. At MVP scale, every tick is fine. If profiling shows it's hot, gate behind a "materialization due?" check (e.g., `default_routines_v1.MAX(updated_at) > last_materialization_at`).

3. **Webhook token rotation per default?** v1 leaves rotation to the per-agent `agents:rotate-webhook-token` flow (rotates all agent's tokens). A `/admin/routines/defaults/:id/rotate-tokens` endpoint that bumps every agent's token for that default is a possible follow-up. Likely not needed at MVP.

4. **Admin "drift" indicator UI.** The "Used 47/47" annotation requires a hook that joins `default_routines_v1` × `agents_v1_agents` to count materialized rows. Useful for the admin to see "47/47 agents have heartbeat (no overrides)" vs "32/47 agents have it (15 have workspace overrides)." Could ship in v1 or follow-up.

5. **Cross-`UPDATE-while-claimed` correctness for default rows.** Existing `claimDue` uses `FOR UPDATE SKIP LOCKED` + per-row `next_run_at` bump for the claim window. Default-sourced rows have NULL `next_run_at`, so the claim-window bump is a no-op. Idempotency: each tick re-evaluates claim from `last_run_at`, so a process death between claim and recordFire causes the routine to fire again on the next tick. Acceptable for at-least-once semantics already established for workspace rows; document explicitly.

---

## Impact / change list

Approximate scope for sizing two impl plans:

### Skills-half PR

- **Modify** `packages/skills/src/migrations.ts` — add `default_attached` column.
- **Modify** `packages/skills/src/store.ts` — `getDefaults()` method.
- **Modify** `packages/skills/src/plugin.ts` — register `skills:list-defaults` hook; gate upsert when `default_attached` + capabilities.
- **Modify** `packages/skills/src/admin-routes.ts` — accept `defaultAttached` flag on POST/PUT.
- **Modify** `packages/skills/src/manifest.ts` — validation: reject `default_attached: true` with non-empty `capabilities.credentials`.
- **Modify** `packages/chat-orchestrator/src/orchestrator.ts` — call `skills:list-defaults`, union into `installedSkillsForSandbox`.
- **Modify** `packages/channel-web/src/admin/skills/*` — checkbox + tooltip.
- **Tests** — store, plugin, orchestrator union, admin route, validator.
- **Canary acceptance test** — `default_attached = true` instruction skill is visible to a fresh agent's SDK turn at `$HOME/.ax/session/skills/<id>/SKILL.md`.
- **No new package, no new table.** ~300-400 LOC.

### Routines-half PR

- **Modify** `packages/routines/src/migrations.ts` — `default_routines_v1` table + `routines_v1_definitions` deltas + first-boot heartbeat seed.
- **Modify** `packages/routines/src/store.ts` — default CRUD + materialization + staleness refresh.
- **Modify** `packages/routines/src/tick.ts` — materialization pass before claim, staleness pass.
- **`packages/routines/src/sync.ts`** — no change. Workspace override is a runtime NOT EXISTS predicate in claim SQL; no constraint-driven deletion needed.
- **Modify** `packages/routines/src/plugin.ts` — register `routines:*-default` hooks; webhook startup mount includes default-sourced rows.
- **Modify** `packages/routines/src/seed-heartbeat.ts` — DELETE this file and the subscriber registration.
- **Modify** `packages/routines-admin-routes/src/` — admin routes for defaults.
- **Modify** `packages/channel-web/src/admin/routines/*` — default routines sub-section.
- **Tests** — store materialization, claim with mixed rows, staleness refresh, workspace override of default, heartbeat migration roundtrip.
- **Canary acceptance test** — first-boot seeded heartbeat default fires for a fresh agent on a hostpath-tested branch.
- ~700-900 LOC.

---

## Follow-ups (out of these PRs)

- **Capability-bearing default skills** with `default_bindings JSONB` column on `skills_v1_skills`. Admin sets a default credential ref for each slot; agents inherit unless they explicitly attach with their own bindings.
- **Per-agent opt-out from a default**. A `defaults_opt_out` array on the agent record (or a small table); the orchestrator/tick loop filters by it.
- **Per-team / per-owner scoped defaults**. Add `scope` + `scope_id` columns; the orchestrator/tick loop joins teams membership.
- **Default-routine token rotation per default**. Admin-side bulk rotation of all agents' tokens for a default.
- **Default materialization performance**. Profile the tick-time materialization+refresh passes; gate them behind a "is anything stale?" check if needed.
- **Workspace skill → default skill "promote" flow**. An admin reviews an agent-authored skill and promotes it to a default.

---

## Next step

Once this design is approved, produce an impl plan via the `writing-plans` skill at `docs/plans/2026-05-19-defaults-impl.md`. The plan should be split into two independent slices (skills-half, routines-half) that can ship in either order.
