import { retireAuthoredRoutines } from './retirement-migration.js';
import { sql, type Kysely, type Generated, type ColumnType } from 'kysely';
import type { CheckInMiss, RoutineKind, RoutineReportStatus } from '@ax/routines-contract';
import {
  SKILL_REFLECTION_PROMPT,
  SKILL_REFLECTION_ROUTINE_NAME,
  SKILL_REFLECTION_SEED_HASH,
} from './reflection-prompt.js';

export interface RoutinesDefinitionsRow {
  revision: string;
  enabled: Generated<boolean>;
  agent_id: string;
  routine_id: string;
  owner_user_id: string;
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
  /** Slice 6 — the last recorded fire's skipped-connector warning, or null. */
  last_warning: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  definition_id: string | null;
  definition_updated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** Version 3. Rows written without it, including materialized defaults, are 'repeat'. */
  kind: ColumnType<RoutineKind, RoutineKind | undefined, RoutineKind>;
  good_when: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Version 4 (TASK-907). A task's latest report, written only by `recordReport`,
   * and the notes it keeps between check-ins. NULL until the first report, and
   * NULL again after an edit that changes the routine's kind (`updateAuthored`).
   * `agent_notes` alone is NULL again after the person clears them
   * (`routines:clear-notes`, TASK-910).
   * `task_report_accepted_at` is the reporting run's acceptance time: the run
   * accepted last owns this state. A report never touches `revision` or `updated_at`.
   */
  task_status: ColumnType<RoutineReportStatus | null, RoutineReportStatus | null | undefined, RoutineReportStatus | null>;
  task_update: ColumnType<string | null, string | null | undefined, string | null>;
  task_ask: ColumnType<string | null, string | null | undefined, string | null>;
  task_reported_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  task_report_accepted_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  agent_notes: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Version 6 (TASK-910). The moment the person last cleared the agent notes, or
   * NULL if they never have: no run accepted at or before it may write notes
   * again (`recordReport`). Written only by `clearAgentNotes`; see
   * `addNotesClearedColumn` for why it can be later than the clear itself.
   */
  agent_notes_cleared_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * Version 7 (TASK-930). A task's check-ins in a row that ended without a
   * report, the last one's reason and start (its run's `accepted_at`), and when
   * the host paused the task for them. 0 and NULL when there are none. Written
   * only by `finishDispatch` and `updateAuthored` (a person's Resume, a kind
   * change); nothing an agent sends reaches them. The reason reads back as a
   * plain string: `rowToRoutine` reads one no code knows as `failed`, so a later
   * version's reason still reads after a rollback (TASK-913).
   */
  task_misses_in_a_row: ColumnType<number, number | undefined, number>;
  task_miss_reason: ColumnType<string | null, CheckInMiss | null | undefined, CheckInMiss | null>;
  task_miss_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  task_auto_paused_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface RoutinesFiresRow {
  dispatch_id: Generated<string | null>;
  id: Generated<number>;
  agent_id: string;
  routine_id: string;
  fired_at: ColumnType<Date, Date | undefined, Date>;
  trigger_source: 'tick' | 'webhook' | 'manual';
  conversation_id: string | null;
  status: 'ok' | 'silenced' | 'error';
  error: string | null;
  rendered_prompt: string | null;
  /** Slice 6 — "Gmail isn't signed in on Bob, so this run went without it." */
  warning: ColumnType<string | null, string | null | undefined, string | null>;
  /** Version 4 (TASK-907). The run's report, copied from its dispatch when it finishes; NULL when it made none. */
  report_status: ColumnType<RoutineReportStatus | null, RoutineReportStatus | null | undefined, RoutineReportStatus | null>;
  report_update: ColumnType<string | null, string | null | undefined, string | null>;
  report_ask: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Version 9 (TASK-936). Who the run ran as: its routine's owner when it was accepted
   * (`fire.ts` runs as `accepted.row.ownerUserId`). `acceptDispatch` writes it on the
   * dispatch and `finishDispatch` copies it here. `reconcileOwners` never moves it, and
   * that is the point. Rows from before version 9 read as their routine's owner at the
   * upgrade, the person code before it showed their reports to; a gone routine's rows
   * stay NULL, and NULL means not known. Additive and rollback-safe: older code ignores
   * it, and a re-run stamps only NULL rows (`addRunAsColumns`).
   */
  run_as_user_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface DefaultRoutinesRow {
  default_routine_id: string;
  name: string;
  description: string;
  spec_hash: string;
  trigger_kind: 'interval';
  trigger_spec: unknown;
  interval_seconds: ColumnType<number | string | null, number | null, number | null>;
  active_hours: unknown | null;
  silence_token: string | null;
  silence_max: number;
  conversation: 'per-fire' | 'shared';
  prompt_body: string;
  enabled: boolean;
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

export interface RoutinesRequestsRow {
  agent_id: string; owner_user_id: string; operation: string; request_id: string;
  input_hash: string; result: unknown | null; routine_id: string | null;
  created_at: Generated<Date>;
}
export interface CredentialCleanupRow {
  agent_id: string; routine_id: string; credential_ref: string; owner_user_id: string;
  created_at: Generated<Date>;
}
export interface DispatchesRow {
  dispatch_id: string; agent_id: string; routine_id: string; revision: string;
  req_id: string; accepted_at: Date; completed_at: Date | null;
  trigger_source: 'tick' | 'manual' | 'webhook';
  /** Version 4 (TASK-907). The run's conversation, bound once before its agent starts. */
  conversation_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Version 4 (TASK-907). The run's latest report as JSON, until its fire row takes it. Written as `JSON.stringify(...)`. */
  report: ColumnType<unknown | null, string | null | undefined, string | null>;
  /**
   * Version 9 (TASK-936). Who the run runs as: its routine's owner when it was accepted
   * (`fire.ts` runs as `accepted.row.ownerUserId`). `acceptDispatch` writes it and
   * `finishDispatch` copies it to the fire row. `reconcileOwners` never moves it, and
   * that is the point. Rows from before version 9 read as their routine's owner at the
   * upgrade, the person code before it showed their reports to; a gone routine's rows
   * stay NULL, and NULL means not known. Additive and rollback-safe: older code ignores
   * it, and a re-run stamps only NULL rows (`addRunAsColumns`).
   */
  run_as_user_id: ColumnType<string | null, string | null | undefined, string | null>;
}
/**
 * Version 8 (TASK-931). A person's reply on a task, in their own words. Written
 * only by `addReply`; `request_id` is the client's, for its retries.
 */
export interface RepliesRow {
  reply_id: string; agent_id: string; routine_id: string; author_user_id: string;
  request_id: string; body: string; created_at: Date;
}
export interface RoutinesDatabase {
  routines_v1_retired_agents: { agent_id: string; retired_at: Generated<Date> };
  routines_v1_requests: RoutinesRequestsRow;
  routines_v1_credential_cleanup: CredentialCleanupRow;
  routines_v1_dispatches: DispatchesRow;
  routines_v1_definitions: RoutinesDefinitionsRow;
  routines_v1_fires: RoutinesFiresRow;
  routines_v1_replies: RepliesRow;
  default_routines_v1: DefaultRoutinesRow;
  agent_default_routine_overrides_v1: AgentDefaultRoutineOverridesRow;
}


/** Versioned migration: a completed database never re-runs legacy seed/retirement SQL.
 * Each version runs at most once, in order, in one transaction under one advisory lock.
 */
export async function runRoutinesMigration(db: Kysely<RoutinesDatabase>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`SELECT pg_advisory_xact_lock(18427131)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS routines_schema_versions (version integer PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT now())`.execute(trx);
    const done = async (version: number) => (await sql`SELECT 1 FROM routines_schema_versions WHERE version=${version}`.execute(trx)).rows.length > 0;
    if (!await done(2)) {
      const columns = await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='routines_v1_definitions'`.execute(trx);
      if (columns.rows.some(r => r.column_name === 'path')) await retireAuthoredRoutines(trx);
      else if (columns.rows.length === 0) await createFreshSchema(trx);
      await createLifecycleTables(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (2)`.execute(trx);
    }
    if (!await done(3)) {
      await addTaskColumns(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (3)`.execute(trx);
    }
    if (!await done(4)) {
      await addReportColumns(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (4)`.execute(trx);
    }
    if (!await done(5)) {
      await addConversationIndex(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (5)`.execute(trx);
    }
    if (!await done(6)) {
      await addNotesClearedColumn(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (6)`.execute(trx);
    }
    if (!await done(7)) {
      await addCheckInMissColumns(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (7)`.execute(trx);
    }
    if (!await done(8)) {
      await addRepliesTable(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (8)`.execute(trx);
    }
    if (!await done(9)) {
      await addRunAsColumns(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (9)`.execute(trx);
    }
  });
}

/** Version 9 (TASK-936): who each run ran as, on its dispatch and on its fire row.
 * A run runs as its routine's owner when it is accepted (`fire.ts` runs as
 * `accepted.row.ownerUserId`). `acceptDispatch` writes that person on the
 * dispatch, and `finishDispatch` copies it to the fire row. The fire row is
 * written only when the run ends, perhaps after the routine has moved, so only
 * the accept knows who the run runs as, and the dispatch carries it until then.
 * `reconcileOwners` never moves it, and that is the point: after a change
 * of owner, each run still names the person it ran as, so a read can tell the
 * earlier owner's runs from the new owner's. The backfill reads every existing
 * row as its routine's owner at the upgrade, the person code before this version
 * showed their reports to, so the upgrade itself widens or narrows nothing. A
 * gone routine's rows stay NULL, as do rows that code from before this version
 * writes after a rollback: NULL means not known. Nullable TEXT holding a host-set
 * user id, with no foreign key, CHECK or index. Additive and rollback-safe: code
 * from before this version ignores the columns, and a re-run stamps only NULL
 * rows, so it keeps every value already written, even once the routine has
 * another owner.
 */
async function addRunAsColumns(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_dispatches ADD COLUMN IF NOT EXISTS run_as_user_id TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS run_as_user_id TEXT`.execute(db);
  await sql`
    UPDATE routines_v1_dispatches d SET run_as_user_id = r.owner_user_id
      FROM routines_v1_definitions r
     WHERE d.run_as_user_id IS NULL AND r.agent_id = d.agent_id AND r.routine_id = d.routine_id
  `.execute(db);
  await sql`
    UPDATE routines_v1_fires f SET run_as_user_id = r.owner_user_id
      FROM routines_v1_definitions r
     WHERE f.run_as_user_id IS NULL AND r.agent_id = f.agent_id AND r.routine_id = f.routine_id
  `.execute(db);
}

/** Version 8 (TASK-931): a person's replies on a task, which every later check-in
 * carries (the last 20). Written only by `addReply`, owner-only under the
 * routine's row lock; read only for the routine's current owner, and only the
 * ones they wrote (`recentReplies` joins the routine's owner), so an earlier
 * owner's rows outlive a change of owner unread; deleted with their routine
 * (`deleteAuthored`) or agent (`purgeAgent`), and kept through a change of kind.
 * The named unique key is a retry's: the same person, request and routine is
 * one reply. The index serves `recentReplies`' newest-first read. No foreign
 * key: the store deletes replies itself, and a new foreign key on a shared
 * table has broken other packages' test teardown before. No CHECK on `body`:
 * the length cap lives at the writer (`RoutineReplyTextSchema`), so a later cap
 * can't make stored rows unreadable (TASK-913). Additive: code from before this
 * version never reads the table, and a re-run keeps its rows.
 */
async function addRepliesTable(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS routines_v1_replies (
      reply_id        TEXT        PRIMARY KEY,
      agent_id        TEXT        NOT NULL,
      routine_id      TEXT        NOT NULL,
      author_user_id  TEXT        NOT NULL,
      request_id      TEXT        NOT NULL,
      body            TEXT        NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL,
      CONSTRAINT routines_v1_replies_request_unique UNIQUE (agent_id, routine_id, author_user_id, request_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_replies_by_routine
      ON routines_v1_replies (agent_id, routine_id, created_at DESC)
  `.execute(db);
}

/** Version 7 (TASK-930): a task's check-ins in a row that ended without a report,
 * the last one's reason and start, and when the host paused the task for them.
 * Written only by `finishDispatch` (a miss adds one, a report clears them, the
 * fifth in a row pauses the task) and `updateAuthored` (a person's Resume or a
 * kind change clears them). Additive, with no backfill: existing rows read 0 and
 * NULL (no misses), and code from before this version ignores the columns. Every
 * statement only adds what is missing, so a re-run keeps the columns' values.
 * The reason's CHECK lists the codes as they are at this version (a migration
 * doesn't follow the contract's list), and is named so a later code can swap it;
 * NULL passes it.
 */
async function addCheckInMissColumns(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_misses_in_a_row INTEGER NOT NULL DEFAULT 0`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_miss_reason TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_miss_at TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_auto_paused_at TIMESTAMPTZ`.execute(db);
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'routines_v1_definitions_task_miss_reason_chk'
           AND conrelid = 'routines_v1_definitions'::regclass
      ) THEN
        ALTER TABLE routines_v1_definitions
          ADD CONSTRAINT routines_v1_definitions_task_miss_reason_chk
          CHECK (task_miss_reason IN ('no-report', 'brief-missing', 'brief-unconfirmed', 'brief-too-long', 'interrupted', 'failed'));
      END IF;
    END $$;
  `.execute(db);
}

/** Version 6 (TASK-910): when the person last cleared a task's agent notes.
 * A check-in reads the notes in its check-in message when it starts, so an
 * instruction injected through them can come back in that run's next report.
 * After a clear, `recordReport` refuses notes from any run accepted at or
 * before this moment; the rest of the report still lands. `clearAgentNotes`
 * stores the later of its own clock and the start of the routine's latest
 * open run (GREATEST), so every run that could have read the old notes is
 * covered even if the host clock stepped back between that run's start and
 * the clear. A run that starts in the same millisecond is refused too, the
 * safe direction. Additive and nullable, with no backfill: existing rows read
 * NULL (never cleared), and code from before this version ignores the column.
 */
async function addNotesClearedColumn(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS agent_notes_cleared_at TIMESTAMPTZ`.execute(db);
}

/** Version 5 (TASK-908): every run's conversation, open or finished, is indexed. Memory asks
 * routines about each capture pass's conversation (`isTaskConversation`), ordinary chats
 * included, and TASK-907's index covers open runs only. Additive: no row changes.
 */
async function addConversationIndex(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_dispatches_conversation
      ON routines_v1_dispatches (agent_id, conversation_id) WHERE conversation_id IS NOT NULL
  `.execute(db);
}

/** Version 4 (TASK-907): a run's conversation and report, a task's state, and each fire's report.
 * Every statement only adds what is missing, so existing rows keep their values and read back
 * with no report. NULL passes both CHECKs. Named so a later status can swap them.
 */
async function addReportColumns(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_dispatches ADD COLUMN IF NOT EXISTS conversation_id TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_dispatches ADD COLUMN IF NOT EXISTS report JSONB`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_dispatches_open_conversation
      ON routines_v1_dispatches (agent_id, conversation_id) WHERE completed_at IS NULL
  `.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_status TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_update TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_ask TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_reported_at TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_report_accepted_at TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS agent_notes TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS report_status TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS report_update TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS report_ask TEXT`.execute(db);
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'routines_v1_definitions_task_status_chk'
           AND conrelid = 'routines_v1_definitions'::regclass
      ) THEN
        ALTER TABLE routines_v1_definitions
          ADD CONSTRAINT routines_v1_definitions_task_status_chk
          CHECK (task_status IN ('on-track', 'off-track', 'needs-you'));
      END IF;
    END $$;
  `.execute(db);
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'routines_v1_fires_report_status_chk'
           AND conrelid = 'routines_v1_fires'::regclass
      ) THEN
        ALTER TABLE routines_v1_fires
          ADD CONSTRAINT routines_v1_fires_report_status_chk
          CHECK (report_status IN ('on-track', 'off-track', 'needs-you'));
      END IF;
    END $$;
  `.execute(db);
}

/** Version 3: a routine's kind and its going-well-when. Existing rows become 'repeat'/NULL.
 * Each statement only adds what is missing, so columns that already exist keep their values.
 * default_routines_v1 gets no columns: defaults are always 'repeat', and materialized
 * default rows take this column default.
 */
async function addTaskColumns(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'repeat'`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS good_when TEXT`.execute(db);
  // Named so a later kind can swap it.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'routines_v1_definitions_kind_chk'
           AND conrelid = 'routines_v1_definitions'::regclass
      ) THEN
        ALTER TABLE routines_v1_definitions
          ADD CONSTRAINT routines_v1_definitions_kind_chk
          CHECK (kind IN ('repeat', 'stay-on-top'));
      END IF;
    END $$;
  `.execute(db);
}

async function createLifecycleTables(db: Kysely<RoutinesDatabase>): Promise<void> {
  // Canonical intervals can exceed int32 seconds; stay within the contract's Date bound.
  await sql`ALTER TABLE default_routines_v1 ALTER COLUMN interval_seconds TYPE bigint`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS routines_v1_retired_agents (agent_id text PRIMARY KEY, retired_at timestamptz NOT NULL DEFAULT now())`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS routines_v1_requests (
    agent_id text NOT NULL, owner_user_id text NOT NULL, operation text NOT NULL,
    request_id text NOT NULL, input_hash text NOT NULL, result jsonb, routine_id text,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agent_id,owner_user_id,operation,request_id)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS routines_v1_credential_cleanup (
    agent_id text NOT NULL, routine_id text NOT NULL, credential_ref text NOT NULL,
    owner_user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agent_id,credential_ref)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS routines_v1_dispatches (
    dispatch_id text PRIMARY KEY, agent_id text NOT NULL, routine_id text NOT NULL,
    revision text NOT NULL, req_id text NOT NULL UNIQUE, accepted_at timestamptz NOT NULL,
    completed_at timestamptz, trigger_source text NOT NULL
  )`.execute(db);
  await sql`ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS dispatch_id text UNIQUE`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS routines_v1_webhook_path_unique
    ON routines_v1_definitions (agent_id, (trigger_spec->>'path')) WHERE trigger_kind='webhook'`.execute(db);
}
async function createFreshSchema(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS routines_v1_definitions (
      agent_id        TEXT        NOT NULL,
      routine_id            TEXT        NOT NULL,
      revision TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      owner_user_id   TEXT        NOT NULL,
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
      PRIMARY KEY (agent_id, routine_id)
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
      routine_id            TEXT        NOT NULL,
      fired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      trigger_source  TEXT        NOT NULL CHECK (trigger_source IN ('tick','webhook','manual')),
      conversation_id TEXT,
      status          TEXT        NOT NULL CHECK (status IN ('ok','silenced','error')),
      error           TEXT
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_fires_by_routine
      ON routines_v1_fires (agent_id, routine_id, fired_at DESC)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS routines_v1_fires_by_agent
      ON routines_v1_fires (agent_id, fired_at DESC)
  `.execute(db);

  await sql`
    ALTER TABLE routines_v1_fires
      ADD COLUMN IF NOT EXISTS rendered_prompt TEXT
  `.execute(db);

  await sql`
    ALTER TABLE routines_v1_fires
      ADD COLUMN IF NOT EXISTS warning TEXT
  `.execute(db);

  await sql`
    ALTER TABLE routines_v1_definitions
      ADD COLUMN IF NOT EXISTS last_warning TEXT
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS default_routines_v1 (
      default_routine_id  TEXT        PRIMARY KEY,
      name                TEXT        NOT NULL UNIQUE,
      description         TEXT        NOT NULL,
      spec_hash           TEXT        NOT NULL,
      trigger_kind        TEXT        NOT NULL CHECK (trigger_kind IN ('interval')),
      trigger_spec        JSONB       NOT NULL,
      interval_seconds    BIGINT,
      active_hours        JSONB,
      silence_token       TEXT,
      silence_max         INTEGER     NOT NULL DEFAULT 300 CHECK (silence_max >= 0),
      conversation        TEXT        NOT NULL CHECK (conversation IN ('per-fire','shared')),
      prompt_body         TEXT        NOT NULL,
      enabled             BOOLEAN     NOT NULL DEFAULT true,
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
       conversation, prompt_body)
    VALUES
      ('default-heartbeat-2026-05-19', 'heartbeat',
       'Daily check-in: ask if anything is outstanding.',
       'seed-2026-05-19',
       'interval', ${'{"kind":"interval","every":"24h"}'}::jsonb, 86400,
       'HEARTBEAT_OK', 300, 'shared',
       'If nothing is outstanding, respond with HEARTBEAT_OK and end.')
    ON CONFLICT (name) DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO default_routines_v1
      (default_routine_id, name, description, spec_hash, trigger_kind,
       trigger_spec, interval_seconds, silence_token, silence_max,
       conversation, prompt_body, enabled)
    VALUES
      (${SKILL_REFLECTION_ROUTINE_NAME}, ${SKILL_REFLECTION_ROUTINE_NAME},
       'Autonomously graduate recurring procedures from memory into durable skills.',
       ${SKILL_REFLECTION_SEED_HASH},
       'interval', ${'{"kind":"interval","every":"24h"}'}::jsonb, 86400,
       'REFLECTION_DONE', 4000, 'per-fire',
       ${SKILL_REFLECTION_PROMPT}, false)
    ON CONFLICT (name) DO NOTHING
  `.execute(db);

}
