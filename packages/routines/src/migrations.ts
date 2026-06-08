import { sql, type Kysely, type Generated, type ColumnType } from 'kysely';
import { SKILL_REFLECTION_PROMPT } from './reflection-prompt.js';

// Heartbeat default seed content — mirrors heartbeat-template.ts (which is
// deleted in Task 7; keep both in sync until then).
const HEARTBEAT_SEED_MD: string = [
  '---',
  'name: heartbeat',
  "description: daily check-in; says HEARTBEAT_OK and goes quiet when nothing's outstanding",
  'trigger:',
  '  kind: interval',
  '  every: "24h"',
  'conversation: shared',
  'silenceToken: HEARTBEAT_OK',
  '---',
  "If nothing's outstanding for you to report on, just say `HEARTBEAT_OK` and nothing else. Otherwise, give a one-paragraph summary.",
  '',
].join('\n');

export interface RoutinesDefinitionsRow {
  agent_id: string;
  path: string;
  author_user_id: string;
  name: string;
  description: string;
  spec_hash: string;
  trigger_kind: 'interval' | 'cron' | 'webhook';
  trigger_spec: unknown;
  active_hours: unknown | null;
  silence_token: string | null;
  silence_max: number;
  conversation: 'per-fire' | 'shared';
  prompt_body: string;
  next_run_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_run_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_status: 'ok' | 'silenced' | 'error' | null;
  last_error: string | null;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  definition_id: string | null;
  definition_updated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface RoutinesFiresRow {
  id: Generated<number>;
  agent_id: string;
  path: string;
  fired_at: ColumnType<Date, Date | undefined, Date>;
  trigger_source: 'tick' | 'webhook' | 'manual';
  conversation_id: string | null;
  status: 'ok' | 'silenced' | 'error';
  error: string | null;
  rendered_prompt: string | null;
}

export interface DefaultRoutinesRow {
  default_routine_id: string;
  name: string;
  description: string;
  spec_hash: string;
  trigger_kind: 'interval';
  trigger_spec: unknown;
  interval_seconds: number | null;
  active_hours: unknown | null;
  silence_token: string | null;
  silence_max: number;
  conversation: 'per-fire' | 'shared';
  prompt_body: string;
  enabled: boolean;
  source_md: string;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

// Per-agent override of a default routine. ABSENCE of a row means the
// default is ENABLED for that agent (the default-ON invariant — zero
// heartbeat compat risk). A row with enabled=false is an explicit disable;
// enabled=true rows are never written (re-enabling DELETEs the row), but the
// column exists so the table can carry a future "explicit enable" semantic
// without a migration.
export interface AgentDefaultRoutineOverridesRow {
  agent_id: string;
  default_routine_id: string;
  owner_user_id: string;
  enabled: boolean;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface RoutinesDatabase {
  routines_v1_definitions: RoutinesDefinitionsRow;
  routines_v1_fires: RoutinesFiresRow;
  default_routines_v1: DefaultRoutinesRow;
  agent_default_routine_overrides_v1: AgentDefaultRoutineOverridesRow;
}

export async function runRoutinesMigration(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS routines_v1_definitions (
      agent_id        TEXT        NOT NULL,
      path            TEXT        NOT NULL,
      author_user_id  TEXT        NOT NULL,
      name            TEXT        NOT NULL,
      description     TEXT        NOT NULL,
      spec_hash       TEXT        NOT NULL,
      trigger_kind    TEXT        NOT NULL CHECK (trigger_kind IN ('interval','cron','webhook')),
      trigger_spec    JSONB       NOT NULL,
      active_hours    JSONB,
      silence_token   TEXT,
      silence_max     INTEGER     NOT NULL DEFAULT 300 CHECK (silence_max >= 0),
      conversation    TEXT        NOT NULL CHECK (conversation IN ('per-fire','shared')),
      prompt_body     TEXT        NOT NULL,
      next_run_at     TIMESTAMPTZ,
      last_run_at     TIMESTAMPTZ,
      last_status     TEXT        CHECK (last_status IN ('ok','silenced','error')),
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, path)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_due
      ON routines_v1_definitions (next_run_at)
     WHERE next_run_at IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS routines_v1_fires (
      id              BIGSERIAL   PRIMARY KEY,
      agent_id        TEXT        NOT NULL,
      path            TEXT        NOT NULL,
      fired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      trigger_source  TEXT        NOT NULL CHECK (trigger_source IN ('tick','webhook','manual')),
      conversation_id TEXT,
      status          TEXT        NOT NULL CHECK (status IN ('ok','silenced','error')),
      error           TEXT
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_fires_by_routine
      ON routines_v1_fires (agent_id, path, fired_at DESC)
  `.execute(db);

  await sql`
    ALTER TABLE routines_v1_fires
      ADD COLUMN IF NOT EXISTS rendered_prompt TEXT
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS default_routines_v1 (
      default_routine_id  TEXT        PRIMARY KEY,
      name                TEXT        NOT NULL UNIQUE,
      description         TEXT        NOT NULL,
      spec_hash           TEXT        NOT NULL,
      trigger_kind        TEXT        NOT NULL CHECK (trigger_kind IN ('interval')),
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

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'routines_v1_default_next_run_at_chk'
           AND conrelid = 'routines_v1_definitions'::regclass
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

  // Per-agent override of a default routine (TASK-177). Additive + default-ON:
  // absence of a row = enabled. Only explicit disables are stored. FK
  // ON DELETE CASCADE so deleting a default cleans up its overrides
  // (mirrors the routines_v1_definitions.definition_id cascade). owner_user_id
  // records who owned the agent at toggle time (audit / re-materialize source).
  await sql`
    CREATE TABLE IF NOT EXISTS agent_default_routine_overrides_v1 (
      agent_id            TEXT        NOT NULL,
      default_routine_id  TEXT        NOT NULL
        REFERENCES default_routines_v1 (default_routine_id) ON DELETE CASCADE,
      owner_user_id       TEXT        NOT NULL,
      enabled             BOOLEAN     NOT NULL,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, default_routine_id)
    )
  `.execute(db);

  await sql`
    INSERT INTO default_routines_v1
      (default_routine_id, name, description, spec_hash, trigger_kind,
       trigger_spec, interval_seconds, silence_token, silence_max,
       conversation, prompt_body, source_md)
    VALUES
      ('default-heartbeat-2026-05-19', 'heartbeat',
       'Daily check-in: ask if anything is outstanding.',
       'seed-2026-05-19',
       'interval', ${'{"kind":"interval","every":"24h"}'}::jsonb, 86400,
       'HEARTBEAT_OK', 300, 'shared',
       'If nothing is outstanding, respond with HEARTBEAT_OK and end.',
       ${HEARTBEAT_SEED_MD})
    ON CONFLICT (name) DO NOTHING
  `.execute(db);

  // skill-reflection default routine (TASK-178, skill-crystallization PR-C).
  // Seeded with the GLOBAL master switch OFF (enabled=false): the routine is
  // reachable + tested (the @ax/skills crystallization canary) but does not
  // materialize/fire for any agent until an operator flips it on once via
  // routines:upsert-default, after the manual-acceptance walk validates the
  // loop on the cluster. This is a deliberate rollout gate / kill-switch, NOT
  // half-wiring (the window closes when the walk flips it on).
  //
  // - conversation 'per-fire': each fire gets its own hidden conversation, so
  //   one reflection turn never leaks state into the next (matches the design's
  //   hidden per-fire reflection turn).
  // - silence_token 'REFLECTION_DONE': a no-op pass ends with exactly this
  //   token (the prompt's Step 1/Step 4 contract) and is recorded `silenced`,
  //   never surfaced to the user. Kept in sync with SKILL_REFLECTION_PROMPT.
  // - interval 24h (86400s): matches the heartbeat precedent and staggers each
  //   agent's fire by its materialization time (no 3am herd) — refines the
  //   design's "nightly cron" open-decision to interval, per the plan.
  // - silence_max 4000: the reflection turn's reasoning is longer than
  //   heartbeat's terse check-in; a higher silence budget avoids truncating a
  //   legitimate REFLECTION_DONE pass.
  // ON CONFLICT (name) DO NOTHING — idempotent re-runs (the UNIQUE name
  // constraint), and never clobbers an operator's later edits to the row.
  await sql`
    INSERT INTO default_routines_v1
      (default_routine_id, name, description, spec_hash, trigger_kind,
       trigger_spec, interval_seconds, silence_token, silence_max,
       conversation, prompt_body, source_md, enabled)
    VALUES
      ('skill-reflection', 'skill-reflection',
       'Autonomously graduate recurring procedures from memory into durable skills.',
       'seed-2026-06-08',
       'interval', ${'{"kind":"interval","every":"24h"}'}::jsonb, 86400,
       'REFLECTION_DONE', 4000, 'per-fire',
       ${SKILL_REFLECTION_PROMPT}, 'seed', false)
    ON CONFLICT (name) DO NOTHING
  `.execute(db);

  // PR #105 backfill: drop default-sourced rows materialized with the
  // synthetic system-actor string. fire.ts passes author_user_id to
  // agents:resolve's ACL gate, which rejects '@ax/routines/defaults'
  // as forbidden. Targeted DELETE is safe because routines_v1_fires
  // has no FK to definitions, and the next tick re-materializes each
  // row with the real owner via agents:list-personal-owners.
  await sql`
    DELETE FROM routines_v1_definitions
     WHERE author_user_id = '@ax/routines/defaults'
       AND definition_id IS NOT NULL
  `.execute(db);
}
