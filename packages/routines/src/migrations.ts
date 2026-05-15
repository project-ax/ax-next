import { sql, type Kysely, type Generated, type ColumnType } from 'kysely';

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
}

export interface RoutinesDatabase {
  routines_v1_definitions: RoutinesDefinitionsRow;
  routines_v1_fires: RoutinesFiresRow;
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
}
