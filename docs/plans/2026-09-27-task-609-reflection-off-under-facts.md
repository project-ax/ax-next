# TASK-609 — skill-reflection is off under facts memory (until TASK-608)

## Why

`SKILL_REFLECTION_PROMPT` (`@ax/routines`) gates crystallization on Strata's
`memory/docs/<category>/<slug>.md` `source_conversations` frontmatter. Facts memory
has no equivalent: `memory_recall` and the `/memory` export show dates and never
conversation ids. Swapping tool names into the prompt would quietly change what
the gate means. Owner ruling (2026-09-27, Vinay): turn skill-reflection **off**
under the facts-memory preset until TASK-608 deletes Strata. The k8s (Strata)
preset keeps its prompt and behaviour unchanged. A facts-native recurrence
signal is its own card.

## Mechanism (no new hook)

The routines plugin already reads the GLOBAL `default_routines_v1.enabled` flag
in both materialization (`materializeMissing … WHERE d.enabled`) and the tick
claim (`default_due … AND d.enabled`). So "off" means that flag is false.

1. `RoutinesConfig.forceDisabledDefaults?: readonly string[]`: default-routine
   **names** the deployment forces off. It is generic, so no memory vocabulary
   goes into routines.
   - At init, after `runRoutinesMigration`, `disableDefaultRoutines(db, names)`
     sets `enabled = false` for those names only (`WHERE name = ANY(...) AND
     enabled`) and deletes their materialized per-agent rows. It is idempotent:
     a second run changes nothing.
   - `routines:upsert-default` refuses `enabled: true` for a forced name
     (`default-disabled-by-deployment`) and writes `enabled: false` on any
     other upsert of it, so a spec re-upsert after `delete-default` cannot come
     back ON.
2. `SKILL_REFLECTION_ROUTINE_NAME` is exported from `@ax/routines`, and the
   seed uses it.
3. `@ax/preset-memory` replaces the k8s base's `@ax/routines` with
   `createRoutinesPlugin({ forceDisabledDefaults: [SKILL_REFLECTION_ROUTINE_NAME] })`.
   `@ax/preset-k8s` is **not edited**, so Strata stays byte-for-byte what it was.

## Tests

- routines `plugin.test.ts` (Postgres):
  - An existing deployment with reflection flipped ON and materialized for
    agents boots forced: the flag goes false, the per-agent reflection rows are
    gone, and heartbeat's flag and rows are untouched. A re-boot is a no-op.
    `materializeMissing` for a new agent seeds heartbeat and not reflection.
  - Without the option, a flipped-ON reflection and its rows survive a boot
    (the Strata / k8s path).
  - Under the option, upsert with `enabled: true` is refused. After
    delete-default, a spec upsert lands with `enabled` false.
- preset-memory canary: `routines:upsert-default` with `enabled: true` for
  skill-reflection is refused on the real assembly.
- preset-memory unit: the assembly has exactly one `@ax/routines`.

## YAGNI

- No prompt edit. The Strata prompt is correct for Strata, and facts agents
  never receive it.
- No change to `list-agent-defaults` or the UI toggle. Its behaviour with
  global-off is already what the seed ships with, so this is a follow-up.
