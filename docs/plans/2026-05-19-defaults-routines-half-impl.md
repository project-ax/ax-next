# Defaults — routines-half implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin define a global set of "default routines" that fire for every agent — same firing machinery as workspace-authored routines, but the content lives in the host's DB instead of the agent's workspace. Admin edits propagate to every agent on the next tick, with no per-agent sweep on admin write.

**Architecture:** New table `default_routines_v1` is the source of truth. Per-agent state lives as denormalized rows in `routines_v1_definitions` (existing table) with a new `definition_id` FK column; the tick loop materializes missing rows lazily and refreshes stale rows in place. Workspace routines with the same frontmatter `name` shadow the default at claim time (runtime predicate, no DB constraint). The existing `seed-heartbeat` subscriber is deleted and replaced by a first-boot seed of the default heartbeat into `default_routines_v1`.

**Tech Stack:** TypeScript, postgres (via Kysely), Vitest + `@testcontainers/postgresql` for DB tests, `@ax/test-harness` for plugin tests, React + `@testing-library/react` for UI tests.

**Scope:** This plan covers ONLY the routines-half slice of `docs/plans/2026-05-19-defaults-design.md`. The skills-half slice already shipped in PR #101 (merged 2026-05-19). The two slices are independent — no cross-dependencies, no shared invariants.

---

## Brainstorming the hard parts

This is the design's Part B with sharper decisions for each ambiguous lever. Each `HPn` below ends with an explicit decision and the invariant (`I-Rn`) it implies.

### HP1 — Denormalization vs live-JOIN

The design denormalizes parsed fields (`trigger_spec`, `prompt_body`, `silence_token`, etc.) from `default_routines_v1` onto each per-agent row in `routines_v1_definitions`, with `definition_updated_at` as a staleness pointer. Alternative: keep the per-agent row state-only (`last_run_at`, `last_status`, ...) and read parsed fields via JOIN at claim + fire time.

**Tradeoff:** denormalization keeps the claim query shape identical to today's (no JOIN added on the hottest path), at the cost of staleness drift after admin edits.

**Decision:** **denormalize**, mirror the design. Staleness is bounded by the tick interval (≤10s in production, configurable). The cost of a per-tick staleness refresh pass — a single UPDATE statement scoped by `definition_updated_at < d.updated_at` — is negligible: typical case touches 0 rows; admin-edit case touches `(agents × edited-defaults)` rows once, then 0 forever until the next edit. → **I-R1**.

### HP2 — Where does the staleness predicate live?

Once we denormalize, we need two things: (a) refresh stale rows, and (b) don't fire from a stale row.

**Decision:** refresh pass runs BEFORE claim each tick (single SQL UPDATE). Claim SQL also carries a defensive `r.definition_updated_at >= d.updated_at` predicate so even a missed refresh can't fire a stale prompt. The double-cover costs nothing extra (the predicate uses the JOIN that's already there for `d.interval_seconds`). → **I-R6**.

### HP3 — Override mechanic (workspace wins on name collision)

The design proposes: workspace row + default-sourced row coexist; a runtime `NOT EXISTS` predicate in claim SQL filters out the default-sourced row when a same-name workspace row exists for the agent.

**Alternative considered:** a DB UNIQUE constraint on `(agent_id, name)`. Rejected because: (a) the existing PRIMARY KEY is `(agent_id, path)`, not `(agent_id, name)` — adding a UNIQUE constraint would require migrating any historical data with duplicates, which we shouldn't risk; (b) two workspace files in the same agent could (pathologically) have the same frontmatter `name`, and the DB shouldn't crash on that.

**Decision:** **runtime predicate**, not constraint. Existing sync subscriber (`packages/routines/src/sync.ts:handleWorkspaceApplied`) keys workspace rows by `(agent_id, path)` with `path = '.ax/routines/<name>.md'`. Default-sourced rows use `path = 'default:' || default_routine_id`. Path namespaces never collide; name-shadowing is decided at claim time. → **I-R3**.

### HP4 — `path` as a discriminator?

The design encodes default-sourced rows with `path = 'default:' || default_routine_id`. The FK column `definition_id` IS NOT NULL is the *real* discriminator; `path` is convention.

**Decision:** `definition_id IS NULL/NOT NULL` is the source of truth for "is this a default-sourced row?" throughout the codebase. The `default:`-prefixed path is just documentation that helps when reading raw DB dumps. Code paths (claim SQL, advance, recordFire, sync subscriber) MUST key off `definition_id`, NOT `path.startsWith('default:')`. → **I-R4**.

### HP5 — Lazy materialization timing

Design Open Question 2: "every tick or N ticks?" Worst case is a `CROSS JOIN agents × default_routines_v1` scan per tick. At MVP scale (≤10K agents × ≤50 defaults = 500K rows) the `LEFT NOT EXISTS` join is sub-millisecond with `(agent_id, definition_id)` index.

**Decision:** every tick. YAGNI for a gating heuristic at MVP. Add a profile hook if the scan ever shows up in latency monitoring. The materialization runs BEFORE the staleness refresh BEFORE claim within a single tick. → **I-R4**.

### HP6 — `next_run_at` CHECK constraint

Default-sourced rows compute due from `COALESCE(last_run_at, created_at) + interval_seconds`, NOT from `next_run_at`. The design adds `CHECK (definition_id IS NULL OR next_run_at IS NULL)` to enforce this invariant.

**Risk:** the existing `advance()` after-fire path writes `next_run_at` based on `computeNextRunAt(row)`. For default-sourced rows it must write NULL.

**Decision:** add the CHECK constraint, AND fix `tick.ts:computeNextRunAt` to return NULL when `row.definitionId !== null`. Tests pin both directions. → **I-R2**.

### HP7 — Webhook triggers for default routines

The design contemplates webhook-triggered defaults but flags rotation as a follow-up. Webhook routes are currently mounted per-(agent, path) by `handleWorkspaceApplied` and the agent's existing webhook token authenticates the request.

**Hidden complexity:** if a default has `trigger.kind=webhook`, every materialized per-agent row needs a route mounted; on admin edit of the default's trigger (e.g., interval→webhook), every per-agent row needs to gain a route. Idempotent rebind on startup is feasible (Phase C already has the pattern), but the LIVE rebind across all agents on admin edit is new surface and a test burden.

**Decision:** **defer webhook-default support in v1**. `routines:upsert-default` validates `trigger.kind !== 'webhook'`, rejecting with code `default-trigger-webhook-not-supported`. The admin UI's trigger picker omits the webhook option. When a future caller needs it, the path is: (a) add a `default_routines_v1.allows_webhook` boolean (or just lift the check), (b) extend `mountAllWebhookRoutesOnStartup` to include default-sourced rows, (c) add an admin-edit live-rebind subscriber. None of that ships in this PR. → **I-R5**.

### HP8 — Canary scope

Skills-half's canary was orchestrator-level — no DB, no tick, no kind. Routines-half needs to exercise materialize → claim → fire → record. That's a heavier integration test.

**Options:**

a. **In-package**: drive `runTickOnce` directly with a mocked `fire` and assert state transitions. Postgres testcontainer only, ~2 seconds.
b. **Preset-level**: boot the k8s preset's plugin set, register a clock that advances on demand, run a tick, assert.
c. **Kind walk**: full cluster, real agent, real heartbeat firing.

**Decision:** **(a) in-package canary**. The fire path is already independently tested (`fire.test.ts`); we don't need to re-exercise it. The canary specifically pins the new material+refresh+claim+override path. Kind walk lands in a follow-up MANUAL-ACCEPTANCE entry, not gating the PR.

The canary asserts: (1) lazy materialize creates a per-agent row on first tick; (2) a second tick after the interval elapses claims it, fires (mocked OK), records the fire; (3) a workspace routine with the same `name` shadows the default on the next tick — no double-fire; (4) admin edit bumps `default_routines_v1.updated_at` → staleness refresh updates the per-agent row's denormalized copy → next tick fires the new prompt. → **I-R8**.

### HP9 — `agents:created` subscriber deletion vs DB churn

Today's `seed-heartbeat` subscriber writes `.ax/routines/heartbeat.md` into every new agent's workspace via `workspace:apply`. After this PR, new agents get the heartbeat via the materialization pass instead. Existing agents keep their workspace heartbeats (shadow the default by name).

**Concern:** when this PR ships, the subscriber stops firing immediately — but the lazy materialization runs on the NEXT TICK after the agent's first session. Is there a window where a brand-new agent has no heartbeat? Yes — between `agents:created` and the next tick (≤10s). Acceptable: routine machinery is not real-time anyway (heartbeat is 24h cadence).

**Concern 2:** if the admin DELETES the seeded heartbeat from `default_routines_v1` and then the migration re-runs (e.g., DB rebuild from scratch), the `ON CONFLICT (name) DO NOTHING` re-seeds it. That's intentional: the seed represents "what we ship by default"; admins who delete it on production accept the cost of re-deleting after rebuilds.

**Decision:** delete `seed-heartbeat.ts` + `heartbeat-template.ts` + the `agents:created` subscriber registration in the same PR that ships the materialize pass. Seed lives in `runRoutinesMigration` as `INSERT INTO default_routines_v1 ... ON CONFLICT (name) DO NOTHING`. → **I-R7**.

### HP10 — Admin UI surface for editing trigger spec

A workspace routine's trigger is encoded in YAML frontmatter that the user edits as text. For default routines, the admin uses the same surface (a textarea for the full `.md`) — same `@ax/validator-routine` parser validates. Decision: re-use `source_md` storage column + the existing routine textarea editor (analogous to how the skills admin re-used the SKILL.md textarea). Webhook-trigger choice is hidden in the trigger spec instructions (or the parser rejects it per **I-R5**). → no separate invariant; just consistent with skills-half admin UX.

---

## Invariants

The PR must satisfy these at merge time:

- **I-R1** — `default_routines_v1` is the source of truth for default-routine content. Per-agent `routines_v1_definitions` rows with `definition_id IS NOT NULL` are denormalized copies that self-heal via the tick's staleness refresh pass.
- **I-R2** — Default-sourced rows have `next_run_at IS NULL` (DB CHECK constraint enforces). The tick computes due from `COALESCE(last_run_at, created_at) + interval_seconds`. `computeNextRunAt` in `tick.ts` returns NULL when the row is default-sourced.
- **I-R3** — Workspace routines win on `name` collision. Implemented as a runtime NOT EXISTS predicate in claim SQL — NOT a DB constraint. Same-name workspace row + default-sourced row coexist; only one fires.
- **I-R4** — Materialization is lazy: a single INSERT … SELECT … ON CONFLICT DO NOTHING per tick, scoped to (agent × default) pairs that don't yet have a row. `definition_id IS NULL/NOT NULL` is the discriminator; `path = 'default:<id>'` is convention not contract.
- **I-R5** — v1 defaults are `trigger.kind in ('interval','cron')` only. `routines:upsert-default` rejects `webhook` with code `default-trigger-webhook-not-supported` and the admin UI omits the option. Webhook-default support is a documented follow-up.
- **I-R6** — Per tick, the order is: (1) materialize missing rows, (2) refresh stale rows (UPDATE where `r.definition_updated_at < d.updated_at`), (3) claim. Claim SQL ALSO filters stale rows (`r.definition_updated_at >= d.updated_at`) as belt + suspenders.
- **I-R7** — `seed-heartbeat.ts`, `heartbeat-template.ts`, and the `agents:created` subscriber registration are DELETED in the same PR. The default heartbeat is seeded by `runRoutinesMigration` via `INSERT INTO default_routines_v1 (...) ON CONFLICT (name) DO NOTHING`. Existing agents' workspace `heartbeat.md` files continue to win by name.
- **I-R8** — Half-wired window CLOSED in this PR. Table + ALTER + hooks + tick passes + admin UI + canary integration test all ship together. The canary asserts the four state transitions (materialize, refresh, claim, override).
- **I-R9** — Stripped-preset compatibility: the new admin hooks are registered by `@ax/routines` and surfaced via `@ax/routines-admin-routes`. A preset that doesn't load `@ax/routines-admin-routes` simply doesn't expose the admin endpoints; the tick loop still runs (it depends only on the table existence + the host `@ax/routines` plugin).
- **I-R10** — `routines:list-defaults` failure (DB transient) is non-fatal at admin-route level — returns 500 with a logged error, the admin UI surfaces a retry banner. Failure inside the tick loop's materialize/refresh passes does not crash the tick — caught + logged, next tick retries (idempotent).

---

## File structure

**Create:**

- `packages/routines/src/defaults.ts` — pure-function helpers for parsing default-routine `.md`, computing `interval_seconds`, building the materialize SQL parameters. Test-friendly seam.
- `packages/routines/src/__tests__/defaults.test.ts` — unit tests for the helpers.
- `packages/routines/src/__tests__/tick-defaults.test.ts` — focused tests for the new tick passes (materialize, refresh, claim with mixed rows, override).
- `packages/routines/src/__tests__/canary-defaults.test.ts` — end-to-end canary (materialize → claim → fire → override → admin-edit roundtrip).
- `packages/channel-web/src/components/admin/DefaultRoutinesSection.tsx` — UI subsection.
- `packages/channel-web/src/components/admin/DefaultRoutineEditor.tsx` — single textarea editor + parsed preview, modeled after `SkillEditor.tsx`.
- `packages/channel-web/src/components/admin/__tests__/DefaultRoutinesSection.test.tsx`
- `packages/channel-web/src/components/admin/__tests__/DefaultRoutineEditor.test.tsx`
- `packages/channel-web/src/lib/default-routines.ts` — typed wrappers around `/admin/routines/defaults*`.

**Modify:**

- `packages/routines/src/migrations.ts` — new table `default_routines_v1`; ALTER `routines_v1_definitions` add `definition_id` + `definition_updated_at`; CHECK constraint; new index; first-boot heartbeat seed.
- `packages/routines/src/types.ts` — new hook payload types (`RoutinesListDefaultsInput/Output`, `RoutinesGetDefaultInput/Output`, `RoutinesUpsertDefaultInput/Output`, `RoutinesDeleteDefaultInput/Output`); extend `RoutineRow` with `definitionId: string | null`.
- `packages/routines/src/index.ts` — re-export new types.
- `packages/routines/src/store.ts` — extend `RoutinesStore` with default-routine CRUD (`upsertDefault`, `getDefault`, `listDefaults`, `deleteDefault`, `materializeMissing`, `refreshStale`) and an extended `claimDue` that handles default-sourced rows; row mapping returns `definitionId`.
- `packages/routines/src/tick.ts` — extend `runTickOnce` to call `materializeMissing` + `refreshStale` BEFORE `claimDue`; fix `computeNextRunAt` to return NULL for default-sourced rows.
- `packages/routines/src/plugin.ts` — register `routines:list-defaults` / `routines:get-default` / `routines:upsert-default` / `routines:delete-default` hooks; reject `webhook` trigger kind; remove the `agents:created` subscriber.
- `packages/routines-admin-routes/src/routes.ts` — 4 new admin routes for default CRUD.
- `packages/routines-admin-routes/src/plugin.ts` — register the new route paths in the routes table.
- `packages/channel-web/src/components/routines/RoutinesModal.tsx` — embed the new `DefaultRoutinesSection` above the per-agent table.

**Delete:**

- `packages/routines/src/seed-heartbeat.ts`
- `packages/routines/src/heartbeat-template.ts`
- `packages/routines/src/__tests__/seed-heartbeat.test.ts` (if it exists — confirm before deletion).

---

## Task 1: Branch + baseline

**Files:** None modified.

- [ ] **Step 1: Create branch**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/defaults-routines-half
git status
```

Expected: clean tree on the new branch.

- [ ] **Step 2: Baseline build / test / lint**

```bash
pnpm install
pnpm build
pnpm -F @ax/routines test
pnpm -F @ax/routines-admin-routes test
pnpm -F @ax/channel-web test
pnpm -F @ax/preset-k8s test
pnpm lint
```

All green. Note the existing test counts so we can verify the diff later.

If anything is red on baseline, STOP and surface it before continuing.

---

## Task 2: Migration — `default_routines_v1` + ALTER `routines_v1_definitions` + heartbeat seed

**Files:**
- Modify: `packages/routines/src/migrations.ts`
- Test: `packages/routines/src/__tests__/migrations.test.ts` (look at whether one exists; if not, create it modeled on `packages/skills/src/__tests__/migrations.test.ts`)

This is the load-bearing schema change. Multi-statement migration; each statement is idempotent.

- [ ] **Step 1: Write failing test**

Append (or create) tests verifying:

1. Table `default_routines_v1` exists with expected columns and CHECK constraint that `interval_seconds IS NOT NULL` iff `trigger_kind = 'interval'`.
2. `routines_v1_definitions` has new columns `definition_id TEXT` (nullable FK to `default_routines_v1.default_routine_id` ON DELETE CASCADE) and `definition_updated_at TIMESTAMPTZ` (nullable).
3. CHECK constraint `definition_id IS NULL OR next_run_at IS NULL` (default-sourced rows have NULL next_run_at).
4. Index `routines_v1_definitions_default_idx ON (definition_id, last_run_at) WHERE definition_id IS NOT NULL`.
5. Migration is idempotent — running twice doesn't throw.
6. Re-running the migration on a populated `default_routines_v1` (heartbeat already seeded) does NOT duplicate the seed.

```ts
  it('default_routines_v1 table has expected schema', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'default_routines_v1'
       ORDER BY ordinal_position
    `.execute(db);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName['default_routine_id']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['name']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['trigger_kind']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['trigger_spec']).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(byName['interval_seconds']).toMatchObject({ data_type: 'integer', is_nullable: 'YES' });
    expect(byName['silence_token']).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(byName['silence_max']).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(byName['conversation']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['prompt_body']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName['enabled']).toMatchObject({ data_type: 'boolean', is_nullable: 'NO' });
    expect(byName['source_md']).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
  });

  it('routines_v1_definitions gained definition_id + definition_updated_at columns', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'routines_v1_definitions'
         AND column_name IN ('definition_id', 'definition_updated_at')
    `.execute(db);
    expect(cols.rows).toHaveLength(2);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName['definition_id']).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(byName['definition_updated_at']).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
  });

  it('CHECK constraint forbids default-sourced row with non-null next_run_at', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);

    // First, seed a default so the FK resolves.
    await sql`
      INSERT INTO default_routines_v1
        (default_routine_id, name, description, spec_hash, trigger_kind, trigger_spec,
         interval_seconds, silence_max, conversation, prompt_body, source_md)
      VALUES
        ('d-hb', 'heartbeat', 'd', 'hash', 'interval', '{"kind":"interval","every":"24h"}'::jsonb,
         86400, 300, 'shared', 'p', 's')
    `.execute(db);

    let caught: unknown;
    try {
      await sql`
        INSERT INTO routines_v1_definitions
          (agent_id, path, author_user_id, name, description, spec_hash,
           trigger_kind, trigger_spec, silence_max, conversation, prompt_body,
           definition_id, next_run_at)
        VALUES
          ('agent-x', 'default:d-hb', 'admin', 'heartbeat', 'd', 'hash',
           'interval', '{"kind":"interval","every":"24h"}'::jsonb, 300, 'shared', 'p',
           'd-hb', now())
      `.execute(db);
    } catch (e) {
      caught = e;
    }
    // postgres CHECK violation = SQLSTATE 23514
    expect((caught as { code?: string } | undefined)?.code).toBe('23514');
  });

  it('first-boot seed of default heartbeat is idempotent', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    await runRoutinesMigration(db);

    const rows = await sql<{ name: string; trigger_kind: string }>`
      SELECT name, trigger_kind FROM default_routines_v1 WHERE name = 'heartbeat'
    `.execute(db);
    expect(rows.rows).toEqual([{ name: 'heartbeat', trigger_kind: 'interval' }]);
  });

  it('routines_v1_definitions_default_idx exists', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'routines_v1_definitions'
         AND indexname = 'routines_v1_definitions_default_idx'
    `.execute(db);
    expect(r.rows).toHaveLength(1);
  });
```

- [ ] **Step 2: Run failing tests**

```bash
pnpm -F @ax/routines test -- migrations.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Extend the migration**

Edit `packages/routines/src/migrations.ts`. After the existing `runRoutinesMigration` body, add:

```ts
  await sql`
    CREATE TABLE IF NOT EXISTS default_routines_v1 (
      default_routine_id  TEXT        PRIMARY KEY,
      name                TEXT        NOT NULL UNIQUE,
      description         TEXT        NOT NULL,
      spec_hash           TEXT        NOT NULL,
      trigger_kind        TEXT        NOT NULL CHECK (trigger_kind IN ('interval','cron')),
      trigger_spec        JSONB       NOT NULL,
      interval_seconds    INTEGER,
      active_hours        JSONB,
      silence_token       TEXT,
      silence_max         INTEGER     NOT NULL DEFAULT 300 CHECK (silence_max >= 0),
      conversation        TEXT        NOT NULL CHECK (conversation IN ('per-fire','shared')),
      prompt_body         TEXT        NOT NULL,
      enabled             BOOLEAN     NOT NULL DEFAULT true,
      source_md           TEXT        NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((trigger_kind = 'interval') = (interval_seconds IS NOT NULL))
    )
  `.execute(db);

  await sql`
    ALTER TABLE routines_v1_definitions
      ADD COLUMN IF NOT EXISTS definition_id TEXT
        REFERENCES default_routines_v1 (default_routine_id) ON DELETE CASCADE
  `.execute(db);

  await sql`
    ALTER TABLE routines_v1_definitions
      ADD COLUMN IF NOT EXISTS definition_updated_at TIMESTAMPTZ
  `.execute(db);

  // CHECK constraints aren't covered by ADD COLUMN IF NOT EXISTS for the
  // existing table — add via a DO block guarded on pg_catalog to keep
  // idempotency.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'routines_v1_default_next_run_at_chk'
      ) THEN
        ALTER TABLE routines_v1_definitions
          ADD CONSTRAINT routines_v1_default_next_run_at_chk
          CHECK (definition_id IS NULL OR next_run_at IS NULL);
      END IF;
    END $$;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_definitions_default_idx
      ON routines_v1_definitions (definition_id, last_run_at)
     WHERE definition_id IS NOT NULL
  `.execute(db);

  // First-boot seed of the default heartbeat. Idempotent via UNIQUE(name).
  // The spec_hash is computed from a fixed string so re-running the
  // migration after an admin edit doesn't fight the admin's content (the
  // ON CONFLICT DO NOTHING never updates an existing row).
  await sql`
    INSERT INTO default_routines_v1
      (default_routine_id, name, description, spec_hash, trigger_kind,
       trigger_spec, interval_seconds, silence_token, silence_max,
       conversation, prompt_body, source_md)
    VALUES
      ('default-heartbeat-2026-05-19', 'heartbeat',
       'Daily check-in: ask if anything is outstanding.',
       'seed-2026-05-19',
       'interval', '{"kind":"interval","every":"24h"}'::jsonb, 86400,
       'HEARTBEAT_OK', 300, 'shared',
       'If nothing is outstanding, respond with HEARTBEAT_OK and end.',
       ${HEARTBEAT_SEED_MD})
    ON CONFLICT (name) DO NOTHING
  `.execute(db);
```

You'll need `HEARTBEAT_SEED_MD` declared as a top-level const in `migrations.ts` — the full `.md` body of the heartbeat default. Copy from the existing `heartbeat-template.ts` content (still in tree at this point), inline it as a string literal. (We'll delete `heartbeat-template.ts` in Task 10.)

Also extend `RoutinesDefinitionsRow` to include the new columns:

```ts
export interface RoutinesDefinitionsRow {
  // ... existing fields
  definition_id: string | null;
  definition_updated_at: Date | null;
}
```

And add the new table type:

```ts
export interface DefaultRoutinesRow {
  default_routine_id: string;
  name: string;
  description: string;
  spec_hash: string;
  trigger_kind: 'interval' | 'cron';
  trigger_spec: unknown;
  interval_seconds: number | null;
  active_hours: unknown | null;
  silence_token: string | null;
  silence_max: number;
  conversation: 'per-fire' | 'shared';
  prompt_body: string;
  enabled: boolean;
  source_md: string;
  created_at: Date;
  updated_at: Date;
}

export interface RoutinesDatabase {
  routines_v1_definitions: RoutinesDefinitionsRow;
  routines_v1_fires: RoutinesFiresRow;
  default_routines_v1: DefaultRoutinesRow;
}
```

- [ ] **Step 4: Re-run tests**

```bash
pnpm -F @ax/routines test -- migrations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/migrations.ts \
        packages/routines/src/__tests__/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(routines): default_routines_v1 + extend routines_v1_definitions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Types — new hook payloads + extend RoutineRow

**Files:**
- Modify: `packages/routines/src/types.ts`
- Modify: `packages/routines/src/index.ts`

- [ ] **Step 1: Edit `types.ts`**

Add at the bottom of `types.ts`:

```ts
import type { TriggerSpec, ActiveHours } from '@ax/validator-routine';

export interface DefaultRoutineSummary {
  defaultRoutineId: string;
  name: string;
  description: string;
  trigger: TriggerSpec;
  enabled: boolean;
  updatedAt: string;
}

export interface DefaultRoutineDetail extends DefaultRoutineSummary {
  sourceMd: string;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  activeHours: ActiveHours | null;
  promptBody: string;
}

export type RoutinesListDefaultsInput = Record<string, never>;
export interface RoutinesListDefaultsOutput {
  defaults: DefaultRoutineSummary[];
}

export interface RoutinesGetDefaultInput {
  defaultRoutineId: string;
}
export type RoutinesGetDefaultOutput = DefaultRoutineDetail;

export interface RoutinesUpsertDefaultInput {
  sourceMd: string;
  enabled?: boolean;
}
export interface RoutinesUpsertDefaultOutput {
  defaultRoutineId: string;
  created: boolean;
}

export interface RoutinesDeleteDefaultInput {
  defaultRoutineId: string;
}
export type RoutinesDeleteDefaultOutput = Record<string, never>;
```

Extend the existing `RoutineRow` (find it in `types.ts`) with:

```ts
export interface RoutineRow {
  // ... existing fields
  definitionId: string | null;
  definitionUpdatedAt: Date | null;
}
```

- [ ] **Step 2: Re-export from `index.ts`**

Add the new types to the existing `export type { ... }` block.

- [ ] **Step 3: Build**

```bash
pnpm -F @ax/routines build
```

Expected: errors in store.ts about missing `definitionId`/`definitionUpdatedAt` on RoutineRow constructors (the `rowToRoutine` helper). Those get fixed in Task 4.

- [ ] **Step 4: Commit**

```bash
git add packages/routines/src/types.ts packages/routines/src/index.ts
git commit -m "$(cat <<'EOF'
feat(routines): payload types for default-routine CRUD + RoutineRow extension

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Store — default-routine CRUD + materialize + refresh + extended claim

**Files:**
- Modify: `packages/routines/src/store.ts`
- Test: append to `packages/routines/src/__tests__/store.test.ts`

This is the biggest task — split it into TDD sub-cycles per method.

### 4a. `rowToRoutine` returns `definitionId`

- [ ] **Step 1: Find `rowToRoutine` in store.ts** and extend the return shape to include `definitionId: row.definition_id` and `definitionUpdatedAt: row.definition_updated_at`. Also extend the row interface in the `sql<{ ... }>` template literal in `claimDue` to include those columns.

- [ ] **Step 2: Run tests, build should be green again**:

```bash
pnpm -F @ax/routines build
pnpm -F @ax/routines test -- store.test.ts
```

### 4b. `upsertDefault`, `getDefault`, `listDefaults`, `deleteDefault`

- [ ] **Step 1: Add failing tests**

Append to `store.test.ts`:

```ts
  it('upsertDefault + listDefaults round-trip', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const store = createRoutinesStore(db);

    const r = await store.upsertDefault({
      name: 'my-default',
      description: 'd',
      specHash: 'h1',
      trigger: { kind: 'interval', every: '1h' },
      intervalSeconds: 3600,
      activeHours: null,
      silenceToken: 'TOK',
      silenceMax: 300,
      conversation: 'shared',
      promptBody: 'p',
      sourceMd: '---\nname: my-default\n---\n',
    });
    expect(r.created).toBe(true);
    expect(typeof r.defaultRoutineId).toBe('string');

    const list = await store.listDefaults();
    // The heartbeat seed is also present — at least 2 defaults total.
    expect(list.map((d) => d.name)).toContain('my-default');
    expect(list.map((d) => d.name)).toContain('heartbeat');
  });

  it('upsertDefault rejects duplicate name as expected (unique constraint)', async () => {
    // Two upserts with the same name from different upsert calls should
    // update, not duplicate.
    const db = makeKysely();
    await runRoutinesMigration(db);
    const store = createRoutinesStore(db);

    await store.upsertDefault({
      name: 'twice', description: 'a', specHash: 'h1',
      trigger: { kind: 'interval', every: '1h' }, intervalSeconds: 3600,
      activeHours: null, silenceToken: null, silenceMax: 300,
      conversation: 'shared', promptBody: 'p1',
      sourceMd: 'a',
    });
    const r2 = await store.upsertDefault({
      name: 'twice', description: 'b', specHash: 'h2',
      trigger: { kind: 'interval', every: '2h' }, intervalSeconds: 7200,
      activeHours: null, silenceToken: null, silenceMax: 300,
      conversation: 'shared', promptBody: 'p2',
      sourceMd: 'b',
    });
    expect(r2.created).toBe(false);
    const d = await store.getDefault(r2.defaultRoutineId);
    expect(d?.description).toBe('b');
    expect(d?.intervalSeconds).toBe(7200);
  });

  it('deleteDefault cascades to per-agent rows', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const store = createRoutinesStore(db);

    const { defaultRoutineId } = await store.upsertDefault({
      name: 'cascade-test', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '1h' }, intervalSeconds: 3600,
      activeHours: null, silenceToken: null, silenceMax: 300,
      conversation: 'shared', promptBody: 'p',
      sourceMd: 's',
    });

    // Insert a per-agent row referencing the default.
    await db.insertInto('routines_v1_definitions').values({
      agent_id: 'agent-x',
      path: `default:${defaultRoutineId}`,
      author_user_id: '@ax/routines/defaults',
      name: 'cascade-test',
      description: 'd',
      spec_hash: 'h',
      trigger_kind: 'interval',
      trigger_spec: { kind: 'interval', every: '1h' } as unknown,
      active_hours: null,
      silence_token: null,
      silence_max: 300,
      conversation: 'shared',
      prompt_body: 'p',
      next_run_at: null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      definition_id: defaultRoutineId,
      definition_updated_at: new Date(),
    }).execute();

    await store.deleteDefault(defaultRoutineId);

    const remaining = await db
      .selectFrom('routines_v1_definitions')
      .select('agent_id')
      .where('agent_id', '=', 'agent-x')
      .execute();
    expect(remaining).toEqual([]);
  });
```

- [ ] **Step 2: Run failing tests**

Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement the methods in `store.ts`**

Extend `RoutinesStore`:

```ts
export interface UpsertDefaultInput {
  defaultRoutineId?: string;
  name: string;
  description: string;
  specHash: string;
  trigger: TriggerSpec;
  intervalSeconds: number | null;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  sourceMd: string;
}

export interface DefaultRoutineDetailRow {
  defaultRoutineId: string;
  name: string;
  description: string;
  trigger: TriggerSpec;
  intervalSeconds: number | null;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  enabled: boolean;
  sourceMd: string;
  updatedAt: Date;
}

export interface RoutinesStore {
  // ... existing methods
  upsertDefault(input: UpsertDefaultInput): Promise<{ defaultRoutineId: string; created: boolean }>;
  getDefault(defaultRoutineId: string): Promise<DefaultRoutineDetailRow | null>;
  listDefaults(): Promise<DefaultRoutineDetailRow[]>;
  deleteDefault(defaultRoutineId: string): Promise<void>;
}
```

Implement (id derived from `name` if not supplied, hash-suffixed; or use a ULID — match the design's `default-heartbeat-2026-05-19` style → use a stable function `defaultIdFor(name) = 'default-' + slug(name) + '-' + datestamp`, or for the v1 admin upsert path, generate a ULID at creation time and reuse on update by looking up the existing row by `name`).

The handler:

```ts
async upsertDefault(input) {
  const existing = await db
    .selectFrom('default_routines_v1')
    .select(['default_routine_id'])
    .where('name', '=', input.name)
    .executeTakeFirst();
  if (existing === undefined) {
    const id = input.defaultRoutineId ?? `default-${input.name}-${Date.now()}`;
    await db.insertInto('default_routines_v1').values({
      default_routine_id: id,
      name: input.name,
      description: input.description,
      spec_hash: input.specHash,
      trigger_kind: input.trigger.kind,
      trigger_spec: input.trigger as unknown,
      interval_seconds: input.intervalSeconds,
      active_hours: input.activeHours as unknown,
      silence_token: input.silenceToken,
      silence_max: input.silenceMax,
      conversation: input.conversation,
      prompt_body: input.promptBody,
      enabled: true,
      source_md: input.sourceMd,
    }).execute();
    return { defaultRoutineId: id, created: true };
  }
  await db.updateTable('default_routines_v1')
    .set({
      description: input.description,
      spec_hash: input.specHash,
      trigger_kind: input.trigger.kind,
      trigger_spec: input.trigger as unknown,
      interval_seconds: input.intervalSeconds,
      active_hours: input.activeHours as unknown,
      silence_token: input.silenceToken,
      silence_max: input.silenceMax,
      conversation: input.conversation,
      prompt_body: input.promptBody,
      source_md: input.sourceMd,
      updated_at: sql`now()`,
    })
    .where('default_routine_id', '=', existing.default_routine_id)
    .execute();
  return { defaultRoutineId: existing.default_routine_id, created: false };
},
```

`getDefault`, `listDefaults`, `deleteDefault` follow the same pattern as the existing skills-store equivalents. `deleteDefault` is just `DELETE FROM default_routines_v1 WHERE default_routine_id = ?` — ON DELETE CASCADE handles `routines_v1_definitions`.

- [ ] **Step 4: Re-run tests, confirm PASS**

```bash
pnpm -F @ax/routines test -- store.test.ts
pnpm -F @ax/routines build
```

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(routines): store default-routine CRUD + RoutineRow.definitionId

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 4c. `materializeMissing` + `refreshStale`

- [ ] **Step 1: Add failing tests**

```ts
  it('materializeMissing creates one row per (agent, default) pair, idempotent', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const store = createRoutinesStore(db);

    // Seed an agents table stub (or just insert agent_id values directly
    // — materializeMissing reads from an agents source, see step 3
    // below for the exact contract).
    // ... (test setup depending on the API shape chosen below)

    const before = Date.now();
    await store.materializeMissing({ agentIds: ['agent-x'], now: new Date() });
    const after = await db.selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agent-x')
      .where('definition_id', 'is not', null)
      .execute();
    expect(after).toHaveLength(1);
    expect(after[0]?.next_run_at).toBeNull();
    expect(after[0]?.definition_updated_at).not.toBeNull();
    expect(after[0]?.path).toMatch(/^default:/);

    // Idempotent — second call doesn't duplicate.
    await store.materializeMissing({ agentIds: ['agent-x'], now: new Date() });
    const again = await db.selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agent-x')
      .where('definition_id', 'is not', null)
      .execute();
    expect(again).toHaveLength(1);
  });

  it('refreshStale updates denormalized fields when default has changed', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const store = createRoutinesStore(db);

    // Setup: materialize for an agent.
    await store.materializeMissing({ agentIds: ['agent-x'], now: new Date() });
    const before = await db.selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agent-x')
      .executeTakeFirstOrThrow();

    // Admin edits the heartbeat — change prompt_body.
    await db.updateTable('default_routines_v1')
      .set({ prompt_body: 'NEW PROMPT', updated_at: sql`now() + interval '1 second'` })
      .where('name', '=', 'heartbeat')
      .execute();

    // Refresh.
    await store.refreshStale({ now: new Date() });

    const after = await db.selectFrom('routines_v1_definitions')
      .selectAll()
      .where('agent_id', '=', 'agent-x')
      .executeTakeFirstOrThrow();
    expect(after.prompt_body).toBe('NEW PROMPT');
    expect(after.definition_updated_at).not.toEqual(before.definition_updated_at);
  });
```

- [ ] **Step 2: Run failing tests, confirm FAIL**

- [ ] **Step 3: Implement**

Note on the `agentIds` parameter: the tick loop has no direct view into the agents table (`@ax/agents` owns it). The cleanest seam: the tick loop calls a service hook `agents:list-ids` returning all agent ids, then passes them to `materializeMissing`. If `agents:list-ids` doesn't exist yet (likely doesn't), add it to `@ax/agents` in this task — it's a small additive read hook. ALTERNATIVELY: `materializeMissing` reads from `agents_v1_agents` directly via SQL, breaking the no-cross-plugin-table-reads convention. Discuss with the user before that path.

**Decision needed at impl time:** which seam? Recommend `agents:list-ids` (clean) over SQL cross-read (invariant violation).

`materializeMissing` shape (assuming the agent-ids seam):

```ts
async materializeMissing(input: { agentIds: string[]; now: Date }) {
  if (input.agentIds.length === 0) return;
  // ON CONFLICT (agent_id, path) DO NOTHING — concurrent materializers safe.
  await sql`
    INSERT INTO routines_v1_definitions
      (agent_id, path, author_user_id, name, description, spec_hash,
       trigger_kind, trigger_spec, active_hours, silence_token, silence_max,
       conversation, prompt_body, next_run_at, definition_id, definition_updated_at,
       created_at, updated_at)
    SELECT
      a.agent_id, 'default:' || d.default_routine_id, '@ax/routines/defaults',
      d.name, d.description, d.spec_hash,
      d.trigger_kind, d.trigger_spec, d.active_hours, d.silence_token, d.silence_max,
      d.conversation, d.prompt_body, NULL,
      d.default_routine_id, d.updated_at,
      ${input.now}, ${input.now}
    FROM (SELECT unnest(${input.agentIds}::text[]) AS agent_id) a
    CROSS JOIN default_routines_v1 d
    WHERE d.enabled
      AND NOT EXISTS (
        SELECT 1 FROM routines_v1_definitions r
         WHERE r.agent_id = a.agent_id
           AND r.definition_id = d.default_routine_id
      )
    ON CONFLICT (agent_id, path) DO NOTHING
  `.execute(db);
}

async refreshStale(input: { now: Date }) {
  // Refresh all default-sourced rows whose copy is older than the source.
  await sql`
    UPDATE routines_v1_definitions r
       SET name = d.name,
           description = d.description,
           spec_hash = d.spec_hash,
           trigger_kind = d.trigger_kind,
           trigger_spec = d.trigger_spec,
           active_hours = d.active_hours,
           silence_token = d.silence_token,
           silence_max = d.silence_max,
           conversation = d.conversation,
           prompt_body = d.prompt_body,
           definition_updated_at = d.updated_at,
           updated_at = ${input.now}
      FROM default_routines_v1 d
     WHERE r.definition_id = d.default_routine_id
       AND (r.definition_updated_at IS NULL
            OR r.definition_updated_at < d.updated_at)
  `.execute(db);
}
```

- [ ] **Step 4: Re-run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(routines): store.materializeMissing + refreshStale

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 4d. Extend `claimDue` for default-sourced rows

- [ ] **Step 1: Add failing test**

```ts
  it('claimDue picks up default-sourced rows whose last_run_at + interval is due', async () => {
    const db = makeKysely();
    await runRoutinesMigration(db);
    const store = createRoutinesStore(db);

    // Use a default with a 1-second interval.
    const { defaultRoutineId } = await store.upsertDefault({
      name: 'quick', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '1s' }, intervalSeconds: 1,
      activeHours: null, silenceToken: null, silenceMax: 300,
      conversation: 'shared', promptBody: 'p', sourceMd: 's',
    });

    await store.materializeMissing({ agentIds: ['agent-x'], now: new Date() });
    // Set last_run_at 5 seconds ago so it's due now.
    await db.updateTable('routines_v1_definitions')
      .set({ last_run_at: new Date(Date.now() - 5_000) })
      .where('agent_id', '=', 'agent-x')
      .where('definition_id', '=', defaultRoutineId)
      .execute();

    const claimed = await store.claimDue({
      now: new Date(),
      limit: 10,
      claimWindowMinutes: 1,
    });
    expect(claimed.some((r) => r.definitionId === defaultRoutineId)).toBe(true);
  });

  it('claimDue excludes default-sourced rows shadowed by same-name workspace row', async () => {
    // ... materialize, then insert a workspace row with name='quick',
    // assert claimDue returns the workspace row only.
  });

  it('claimDue excludes stale default-sourced rows (definition_updated_at < d.updated_at)', async () => {
    // ... materialize, then bump default's updated_at without refresh,
    // assert claimDue returns nothing for that row.
  });
```

- [ ] **Step 2: Run failing tests, confirm FAIL**

- [ ] **Step 3: Extend `claimDue`**

Existing claim SQL queries `routines_v1_definitions` directly. Extend to UNION ALL with default-sourced rows:

```ts
async claimDue(input) {
  const rows = await sql<...>`
    WITH due AS (
      -- Workspace rows: existing path.
      SELECT agent_id, path
        FROM routines_v1_definitions
       WHERE definition_id IS NULL
         AND next_run_at IS NOT NULL
         AND next_run_at <= ${input.now}
         AND trigger_kind IN ('interval', 'cron')

      UNION ALL

      -- Default-sourced rows: computed-due, override-respecting, staleness-filtered.
      SELECT r.agent_id, r.path
        FROM routines_v1_definitions r
        JOIN default_routines_v1 d ON d.default_routine_id = r.definition_id
       WHERE r.definition_id IS NOT NULL
         AND d.enabled
         AND d.trigger_kind = 'interval'
         AND (r.definition_updated_at IS NOT NULL
              AND r.definition_updated_at >= d.updated_at)
         AND COALESCE(r.last_run_at, r.created_at)
             + (d.interval_seconds || ' seconds')::interval <= ${input.now}
         AND NOT EXISTS (
           SELECT 1 FROM routines_v1_definitions w
            WHERE w.agent_id = r.agent_id
              AND w.definition_id IS NULL
              AND w.name = r.name
         )
       ORDER BY r.last_run_at NULLS FIRST
       LIMIT ${input.limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE routines_v1_definitions r
       SET next_run_at = CASE
         WHEN r.definition_id IS NULL
           THEN r.next_run_at + (${input.claimWindowMinutes} || ' minutes')::interval
         ELSE r.next_run_at  -- default-sourced rows keep NULL next_run_at
       END
      FROM due
     WHERE r.agent_id = due.agent_id AND r.path = due.path
    RETURNING r.*
  `.execute(db);
  return rows.rows.map(rowToRoutine);
}
```

Cron path: the existing `engineFor + computeNextRunAt` handles cron at advance time. Default-sourced cron uses the same engine — but for claim-time pre-filter, cron's `next_run_at` is precomputed by `engineFor` during materialize and updated on advance. For default-sourced cron, we DON'T precompute; we rely on `engineFor` at advance-time. **Decision: v1 default routines support `interval` only**. Update **I-R5** accordingly: `default_routines_v1.trigger_kind CHECK (trigger_kind IN ('interval'))` — drop `cron` from v1 too, since the design's "cron" path is more complex (croner evaluator in claim SQL) and not load-bearing for the heartbeat seed.

> Update Task 2's migration accordingly: `CHECK (trigger_kind = 'interval')` instead of `('interval', 'cron')`. Update I-R5 to "interval only in v1 — cron AND webhook deferred."

- [ ] **Step 4: Re-run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(routines): claimDue picks up default-sourced rows (interval-only v1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tick loop — materialize + refresh BEFORE claim; advance returns NULL for default-sourced

**Files:**
- Modify: `packages/routines/src/tick.ts`
- Test: append to existing `packages/routines/src/__tests__/tick.test.ts` (look for it; create if absent)

- [ ] **Step 1: Add failing tests**

```ts
  it('runTickOnce materializes missing rows before claiming', async () => {
    // Seed an agent ID via the agents:list-ids stub (or direct setup).
    // Run a tick. Assert the per-agent default row exists.
    // ...
  });

  it('runTickOnce refreshes stale rows before claiming', async () => {
    // ...
  });

  it('computeNextRunAt returns NULL for default-sourced rows', async () => {
    // Pure-function test of the helper.
    // ...
  });
```

- [ ] **Step 2: Implement**

Extend `runTickOnce` to call `materializeMissing` + `refreshStale` BEFORE `claimDue`. The agent IDs come from a new service hook call:

```ts
// At top of runTickOnce:
const { agentIds } = await bus.call<Record<string, never>, { agentIds: string[] }>(
  'agents:list-ids', /* ctx */, {},
);
await input.store.materializeMissing({ agentIds, now: input.now });
await input.store.refreshStale({ now: input.now });
```

Adding `agents:list-ids` to `@ax/agents` is a small additive change — but it's a cross-package edit. Document it in the PR description as scope creep necessary for I-R4 (lazy materialization needs the agent list).

`computeNextRunAt` fix:

```ts
function computeNextRunAt(row: RoutineRow, originalNextRunAt: Date | null, now: Date): Date | null {
  // Default-sourced rows always have NULL next_run_at — claim is computed
  // from last_run_at + interval each tick.
  if (row.definitionId !== null) return null;
  // ... existing logic
}
```

- [ ] **Step 3: Add `agents:list-ids` to `@ax/agents`**

In `packages/agents/src/plugin.ts`, register a new hook:

```ts
bus.registerService<Record<string, never>, { agentIds: string[] }>(
  'agents:list-ids',
  PLUGIN_NAME,
  async () => ({ agentIds: await store.listAllIds() }),
);
```

Add `listAllIds` to `packages/agents/src/store.ts`. Update `@ax/agents`' `manifest.registers`. Test: simple round-trip.

- [ ] **Step 4: Run all routines tests, confirm PASS**

- [ ] **Step 5: Commit (two commits — one per package)**

```bash
git add packages/agents/src/plugin.ts packages/agents/src/store.ts packages/agents/src/__tests__/
git commit -m "feat(agents): agents:list-ids service hook"

git add packages/routines/src/tick.ts packages/routines/src/__tests__/tick.test.ts
git commit -m "feat(routines): tick loop materializes + refreshes default-sourced rows"
```

---

## Task 6: Plugin — register `routines:*-default` hooks; reject webhook trigger

**Files:**
- Modify: `packages/routines/src/plugin.ts`
- Test: append to `packages/routines/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
  it('routines:list-defaults returns the seeded heartbeat default', async () => { /* ... */ });
  it('routines:upsert-default with interval trigger persists', async () => { /* ... */ });
  it('routines:upsert-default rejects webhook trigger with code default-trigger-webhook-not-supported', async () => { /* ... */ });
  it('routines:upsert-default rejects cron trigger with code default-trigger-cron-not-supported (v1 interval-only)', async () => { /* ... */ });
  it('routines:delete-default cascades', async () => { /* ... */ });
  it('plugin manifest.registers includes the four new hooks', () => { /* assert */ });
```

- [ ] **Step 2: Implement**

Add to `manifest.registers`:

```ts
'routines:list-defaults', 'routines:get-default', 'routines:upsert-default', 'routines:delete-default',
```

Register the four handlers. `routines:upsert-default` calls `parseRoutineRow` (existing helper) to validate the `.md`, then enforces trigger-kind rules:

```ts
bus.registerService<RoutinesUpsertDefaultInput, RoutinesUpsertDefaultOutput>(
  'routines:upsert-default', PLUGIN_NAME,
  async (_ctx, input) => {
    const parsed = parseRoutineRow(Buffer.from(input.sourceMd));
    if (!parsed.ok) {
      throw new PluginError({
        code: 'invalid-routine-md',
        plugin: PLUGIN_NAME,
        message: parsed.reason,
      });
    }
    if (parsed.fields.trigger.kind === 'webhook') {
      throw new PluginError({
        code: 'default-trigger-webhook-not-supported',
        plugin: PLUGIN_NAME,
        message: 'default routines do not support webhook triggers in v1',
      });
    }
    if (parsed.fields.trigger.kind === 'cron') {
      throw new PluginError({
        code: 'default-trigger-cron-not-supported',
        plugin: PLUGIN_NAME,
        message: 'default routines support interval triggers only in v1',
      });
    }
    const intervalSeconds = durationToSeconds(parsed.fields.trigger.every) ?? 0;
    if (intervalSeconds <= 0) {
      throw new PluginError({
        code: 'invalid-interval',
        plugin: PLUGIN_NAME,
        message: `interval must resolve to a positive duration`,
      });
    }
    return store.upsertDefault({
      name: parsed.fields.name,
      description: parsed.fields.description,
      specHash: parsed.specHash,
      trigger: parsed.fields.trigger,
      intervalSeconds,
      activeHours: parsed.fields.activeHours ?? null,
      silenceToken: parsed.fields.silenceToken ?? null,
      silenceMax: parsed.fields.silenceMaxChars,
      conversation: parsed.fields.conversation,
      promptBody: parsed.fields.promptBody,
      sourceMd: input.sourceMd,
    });
  },
);
```

- [ ] **Step 3: Re-run tests, confirm PASS**

- [ ] **Step 4: Commit**

```bash
git add packages/routines/src/plugin.ts packages/routines/src/__tests__/plugin.test.ts
git commit -m "feat(routines): register routines:*-default hooks (interval-only v1)"
```

---

## Task 7: Delete `seed-heartbeat.ts` + `heartbeat-template.ts` + `agents:created` subscriber

**Files:**
- Delete: `packages/routines/src/seed-heartbeat.ts`
- Delete: `packages/routines/src/heartbeat-template.ts`
- Delete: `packages/routines/src/__tests__/seed-heartbeat.test.ts` (if exists)
- Modify: `packages/routines/src/plugin.ts` (remove the `agents:created` subscriber registration AND the `agents:created` entry from `manifest.subscribes`)
- Modify: `packages/routines/src/index.ts` (remove any re-exports of the deleted symbols)

- [ ] **Step 1: Move the heartbeat content inline into migrations.ts**

If you haven't already done so in Task 2, copy the body of `heartbeat-template.ts` (HEARTBEAT_TEMPLATE constant) into a local constant in `migrations.ts` — that's what the first-boot seed inserts as `source_md`.

- [ ] **Step 2: Delete the files**

```bash
git rm packages/routines/src/seed-heartbeat.ts packages/routines/src/heartbeat-template.ts
[ -f packages/routines/src/__tests__/seed-heartbeat.test.ts ] && git rm packages/routines/src/__tests__/seed-heartbeat.test.ts
```

- [ ] **Step 3: Strip from plugin.ts**

Remove the `createSeedHeartbeatSubscriber` import and call. Remove `'agents:created'` from `manifest.subscribes`. Update plugin.test.ts manifest assertion to match (remove `'agents:created'`).

- [ ] **Step 4: Run tests, confirm PASS**

```bash
pnpm -F @ax/routines test
pnpm -F @ax/routines build
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/routines/
git commit -m "$(cat <<'EOF'
chore(routines): delete seed-heartbeat subscriber (replaced by default_routines_v1 seed)

The agents:created subscriber that wrote .ax/routines/heartbeat.md
into every new agent's workspace is replaced by a first-boot row in
default_routines_v1. Existing agents with workspace heartbeats keep
firing them; the override mechanic shadows the default by name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Admin routes — 4 new HTTP routes for default-routine CRUD

**Files:**
- Modify: `packages/routines-admin-routes/src/routes.ts`
- Modify: `packages/routines-admin-routes/src/plugin.ts`
- Test: append to `packages/routines-admin-routes/src/__tests__/routes.test.ts`

- [ ] **Step 1: Add failing tests**

Modeled on the existing per-agent routine tests. Cover:
- `GET /admin/routines/defaults` → 200 + list
- `GET /admin/routines/defaults/:id` → 200 + detail
- `POST /admin/routines/defaults` → 201, persists; invalid YAML → 400
- `POST /admin/routines/defaults` with webhook trigger → 400 with code `default-trigger-webhook-not-supported`
- `PUT /admin/routines/defaults/:id` → 200, updates
- `DELETE /admin/routines/defaults/:id` → 204

- [ ] **Step 2: Implement handlers** in `routes.ts` (modeled on the per-agent CRUD path), register at `/admin/routines/defaults` (list/create), `/admin/routines/defaults/:id` (get/put/delete) in `plugin.ts`'s route table.

Body schema (zod):

```ts
const upsertDefaultBodySchema = z.object({
  sourceMd: z.string().min(1).max(64 * 1024),
}).strict();
```

Error-code mapping: extend `writeServiceError` to handle the new codes (`invalid-routine-md`, `default-trigger-webhook-not-supported`, `default-trigger-cron-not-supported`, `invalid-interval`) → 400.

- [ ] **Step 3: Run tests, confirm PASS**

- [ ] **Step 4: Commit**

```bash
git add packages/routines-admin-routes/src/ \
        packages/routines-admin-routes/src/__tests__/
git commit -m "feat(routines-admin-routes): /admin/routines/defaults* CRUD"
```

---

## Task 9: Channel-web wire client + admin UI

**Files:**
- Create: `packages/channel-web/src/lib/default-routines.ts` (modeled on `lib/skills.ts`)
- Create: `packages/channel-web/src/components/admin/DefaultRoutineEditor.tsx` (modeled on `SkillEditor.tsx`)
- Create: `packages/channel-web/src/components/admin/DefaultRoutinesSection.tsx`
- Modify: `packages/channel-web/src/components/routines/RoutinesModal.tsx` to embed `<DefaultRoutinesSection />` above the per-agent table.
- Test: `packages/channel-web/src/components/admin/__tests__/DefaultRoutineEditor.test.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/DefaultRoutinesSection.test.tsx`

The shape is parallel to the skills admin work in PR #101. The `DefaultRoutineEditor` is a textarea editor with a parsed preview pane; the section shows a table of defaults with edit/delete buttons.

Existing shadcn primitives suffice — no new install. Use semantic tokens.

- [ ] **Step 1: TDD per component, modeled on skills-half Task 8/9**
- [ ] **Step 2: Wire into RoutinesModal**
- [ ] **Step 3: Full build + test green**

```bash
pnpm -F @ax/channel-web build
pnpm -F @ax/channel-web test
```

- [ ] **Step 4: Commit (one or two commits, by component)**

---

## Task 10: Canary acceptance test

**Files:**
- Create: `packages/routines/src/__tests__/canary-defaults.test.ts`

The single end-to-end test that closes I-R8. Asserts:
1. Materialize creates a per-agent default-sourced row on first tick.
2. After the interval elapses (advanced clock), a second tick claims + fires (mock `fire` returns OK) + records.
3. A workspace routine with the same `name` shadows the default — next tick fires the workspace row only.
4. Admin edit of the default's prompt_body bumps `updated_at`; next tick's refresh updates the per-agent row's denormalized copy.

- [ ] **Step 1: Write the test** (no implementation needed — Tasks 4-6 already exist).
- [ ] **Step 2: Run, confirm PASS.**
- [ ] **Step 3: Commit**

```bash
git add packages/routines/src/__tests__/canary-defaults.test.ts
git commit -m "test(routines): canary — defaults materialize → claim → fire → override"
```

---

## Task 11: Preset wiring sanity check + plugin manifest assertions

**Files:**
- Verify: `presets/k8s/src/__tests__/preset.test.ts` — does it pin individual routines registers? If yes, add the 4 new hooks. If no (asserts plugin names only), no change.
- Verify: `presets/k8s/src/__tests__/acceptance.test.ts` PLUGINS_TO_DROP — confirm `@ax/routines` remains in the loaded set (it already does — workspace routines need the tick).

If the preset hook-set assertion exists, extend it. Otherwise skip.

- [ ] **Step 1: Grep + decide**
- [ ] **Step 2: If needed, edit + commit:**

```bash
git add presets/k8s/src/__tests__/preset.test.ts
git commit -m "test(preset-k8s): pin routines:*-default hooks in static assertion"
```

---

## Task 12: Full build / test / lint + security-checklist + PR

- [ ] **Step 1: Full check**

```bash
pnpm build
pnpm test
pnpm lint
```

All green.

- [ ] **Step 2: Security-checklist pass**

Invoke `security-checklist`. This PR touches:
- **Sandbox**: new admin hooks (`auth:require-admin`-gated). New `agents:list-ids` hook — read-only, returns agent IDs (no PII, no capabilities). No new spawn / network / FS surface.
- **Injection**: default-routine `prompt_body` lands as a chat turn in the agent's context. Same trust profile as today's workspace routines — admin-curated content. The new `source_md` storage is admin-write-only.
- **Supply chain**: no new deps (default-routine UI reuses existing shadcn primitives).

Walk the three threat models and write the structured note for the PR body.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/defaults-routines-half
gh pr create --title "feat(routines): default-attached routines (routines-half of defaults design)" \
             --body "..."
```

PR body includes:
- Summary (3-5 bullets)
- I-R1..I-R10 invariants with how each is satisfied
- Boundary review (cross-cutting hook surface — new `routines:*-default` hooks + `agents:list-ids`)
- Security review
- Half-wired window: CLOSED
- Test plan (counts + manual-acceptance items for the kind walk)

- [ ] **Step 4: Update memory**

Add `project_defaults_routines_half_pr<N>.md`.

---

## Out of scope (intentionally)

- **Cron-triggered default routines** — design Open Question 5 + HP7. Deferred until a default needs it; requires the croner evaluator in claim SQL.
- **Webhook-triggered default routines** — HP7 + I-R5. Deferred until a default needs it; requires per-default tokens + live rebind on admin edit.
- **Per-team / per-tenant scoped defaults** — design Non-goal. Add a `scope` column later.
- **Per-agent opt-out from a default** — design Non-goal. The override mechanic (workspace routine with same name) is the only opt-out.
- **Admin "drift" indicator UI** — design Open Question 4. The "47/47 agents have heartbeat" annotation. Useful but not load-bearing.
- **Default-routine webhook token rotation per default** — design Non-goal at MVP.
- **Workspace routine → default routine "promote" flow** — design Follow-up.

---

## Self-review checklist (do this before declaring the plan ready)

**Spec coverage** — each design section maps to at least one task:

- Design Part B Storage → Task 2 ✓
- Hook surface (`routines:*-default`) → Task 6 ✓
- Tick: materialize + staleness refresh + extended claim → Tasks 4c, 4d, 5 ✓
- Override semantics → Task 4d (claim NOT EXISTS predicate) ✓
- Heartbeat migration / subscriber deletion → Tasks 2, 7 ✓
- Admin UI → Task 9 ✓
- Canary (I-R8) → Task 10 ✓
- Open Questions: addressed in HP1-HP10 ✓ (cron + webhook deferred → I-R5)

**Placeholder scan** — no "TBD", no "TODO". The `agents:list-ids` cross-package addition is named explicitly (Task 5 Step 3).

**LOC estimate** — design predicted ~700-900 LOC. Plan covers: migration (~80), store (~250), tick (~80), plugin (~80), admin-routes (~150), channel-web (~250), tests (~400). Total ~1300 LOC — heavier than the design estimate due to the canary test + the agents:list-ids carve-out. Acceptable.

**Brainstorming decisions** — each `HPn` ends with an explicit decision and an `I-Rn` it implies. Decisions made: interval-only v1 (HP7+HP5 collapsed into I-R5); denormalize (HP1 → I-R1); runtime predicate not constraint (HP3 → I-R3); CHECK constraint + tick.ts fix (HP6 → I-R2); in-package canary (HP8 → I-R8); delete subscriber + seed in migration (HP9 → I-R7); `definition_id` as discriminator (HP4 → I-R4).

**Open issue worth flagging** — Task 5 introduces a new `agents:list-ids` service hook on `@ax/agents` to avoid a cross-plugin SQL read. This is a small additive change but lives in another package; the PR description should call it out. Alternative: have `materializeMissing` accept a `Kysely<unknown>` and query `agents_v1_agents` directly — rejected per I4 (one source of truth per concept; @ax/agents owns the table).

---

## Sequencing notes

- Tasks 1–4d build the data layer; Tasks 5–6 wire the tick + plugin; Task 7 deletes legacy; Tasks 8–9 add admin surface; Tasks 10–11 close half-wired; Task 12 ships.
- The plan can be partially executed and paused after any commit boundary; intermediate states are coherent.
- Two cross-package changes (`agents:list-ids` in `@ax/agents`, route registration in `@ax/routines-admin-routes`) are flagged in their respective tasks. Neither needs to ship in a separate PR — they're load-bearing for this slice.
