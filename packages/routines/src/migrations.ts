import { sql, type Kysely, type Generated, type ColumnType } from 'kysely';

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

export interface RoutinesDatabase {
  routines_v1_definitions: RoutinesDefinitionsRow;
  routines_v1_fires: RoutinesFiresRow;
  default_routines_v1: DefaultRoutinesRow;
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
}
