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
  schedule_spec: unknown | null;
  webhook_spec: unknown | null;
  /** Private setup state: never project into StoredRoutine, receipts or payload blobs. */
  webhook_address_token: Generated<string | null>;
  webhook_legacy_enabled: Generated<boolean>;
  active_hours: unknown | null;
  silence_token: string | null;
  silence_max: number;
  conversation: 'per-fire' | 'shared';
  prompt_body: string;
  next_run_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_run_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** The last recorded fire's status. Written by `finishDispatch`; cleared by a change of owner (`reconcileOwners`, TASK-936). */
  last_status: 'ok' | 'silenced' | 'error' | null;
  /** The last recorded fire's error. Written by `finishDispatch`; cleared by a change of owner (`reconcileOwners`, TASK-936). */
  last_error: string | null;
  /** Slice 6 — the last recorded fire's skipped-connector warning, or null. Cleared by a change of owner (`reconcileOwners`, TASK-936). */
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
   * NULL again after an edit that changes the routine's kind (`updateAuthored`)
   * or a change of owner (`reconcileOwners`, TASK-936).
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
   * only by `finishDispatch`, `updateAuthored` (a person's Resume, a kind
   * change) and `reconcileOwners` (a change of owner, TASK-936), the last two
   * only clearing them; nothing an agent sends reaches them. The reason reads
   * back as a plain string: `rowToRoutine` reads one no code knows as `failed`,
   * so a later version's reason still reads after a rollback (TASK-913).
   */
  task_misses_in_a_row: ColumnType<number, number | undefined, number>;
  task_miss_reason: ColumnType<string | null, CheckInMiss | null | undefined, CheckInMiss | null>;
  task_miss_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  task_auto_paused_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * Version 10 (TASK-952). The latest report's reading: one number the agent
   * read and the label it gave it, agent-written. Written only by
   * `recordReport`, with the report under its guard, and NULL when that report
   * had none; cleared by a change of kind or of owner (`NO_TASK_STATE`). The
   * value reads back as any double, NaN and infinities included, so a read takes
   * it through `readingOf` (store.ts).
   */
  task_reading_value: ColumnType<number | null, number | null | undefined, number | null>;
  task_reading_label: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Version 10 (TASK-952). The `task_reported_at` of the report the reading came
   * with, written by `recordReport` beside it (NULL with no reading) and cleared
   * by `NO_TASK_STATE`. A read shows the reading only while the two match, so a
   * report from code before version 10 shows no older reading (`addReadingColumns`).
   */
  task_reading_reported_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * Version 11 (TASK-948). A "get-done" task's checklist: a JSON list of
   * `{ id, text, done, addedBy }`, `[]` until its agent drafts it or its owner
   * adds a step. Written by `recordReport` (the agent's changes) and `setSteps`
   * (the person's, TASK-949), both as `JSON.stringify(...)` of what
   * `changeStoredSteps` hands them, which keeps the entries this version can't
   * read; set back to `[]` by a change of kind (`updateAuthored`) or of owner
   * (`reconcileOwners`, TASK-936), through `NO_TASK_STATE`. Read leniently
   * (`storedSteps`), so one odd value can't stop a read or the tick.
   */
  task_steps: ColumnType<unknown, string | undefined, string>;
  /**
   * Version 12 (TASK-951). A "get-done" task's finish date, `YYYY-MM-DD` as
   * TEXT, set only by a person (`setFinishBy`); NULL when it has none. Cleared
   * by a change of kind (`updateAuthored`, `NO_FINISH_BY`) and kept by a change
   * of owner (`reconcileOwners`). Its CHECK holds only the format, so a read
   * takes it through the contract's whole rule (`storedFinishBy`, store.ts).
   */
  finish_by: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Version 14 (TASK-955). The time zone a "get-done" task's finish date was
   * set from, as the person's browser reported it, stored as sent. Written only
   * by `setFinishBy`, beside the date; NULL when the browser sent none and
   * whenever there is no date. Cleared with the date by a change of kind
   * (`NO_FINISH_BY`) and kept with it by a change of owner. Read through the
   * contract's zone rule (`storedFinishByTimeZone`, store.ts), and only beside a
   * date that reads.
   */
  finish_by_time_zone: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Version 13 (TASK-950). A "get-done" task's claim that it's done: the
   * `task_reported_at` of the report that made it, written by `recordReport`
   * beside that report (NULL when it made none), and cleared by `completeTask`,
   * `reopenTask` and a change of kind or of owner (`NO_TASK_STATE`). A read shows
   * the claim only while the two match (`taskState`), so a report from code
   * before version 13 takes it back (`addDoneColumns`).
   */
  task_done_claimed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * Version 13 (TASK-950). When a person marked a "get-done" task done, and who.
   * Written by `completeTask`; cleared by `reopenTask`, `updateAuthored` (every
   * edit but one that leaves a Done task off), ax's pause after missed check-ins
   * (`missesAfterRun`) and a change of kind or of owner (`NO_TASK_STATE`). Read
   * only through `doneOf` (store.ts): Done needs the task off, its kind
   * get-done and its completer its owner.
   */
  task_completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  task_completed_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
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
   * Version 10 (TASK-952). The run's reading, copied from its dispatch by
   * `finishDispatch` beside a report it could read, and through the same rule as
   * every read (`readingOf`); NULL otherwise. Agent-written.
   */
  report_reading_value: ColumnType<number | null, number | null | undefined, number | null>;
  report_reading_label: ColumnType<string | null, string | null | undefined, string | null>;
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
  executor_id: ColumnType<string | null, string | null | undefined, string | null>;
  executor_released: ColumnType<boolean, boolean | undefined, boolean>;
  lease_expires_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  delivery_id: ColumnType<string | null, string | null | undefined, string | null>;
  dispatch_id: string; agent_id: string; routine_id: string; revision: string;
  req_id: string; accepted_at: Date; completed_at: Date | null;
  trigger_source: 'tick' | 'manual' | 'webhook';
  /** Version 16 (TASK-919). Accepted kind, immutable; NULL means history cannot prove it. */
  kind: ColumnType<string | null, string | null | undefined, string | null>;
  /** Version 4 (TASK-907). The run's conversation, bound once before its agent starts. */
  conversation_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Version 4 (TASK-907). The run's latest report as JSON, until its fire row takes it. Written as `JSON.stringify(...)`. */
  report: ColumnType<unknown | null, string | null | undefined, string | null>;
  /**
   * Version 10 (TASK-952). The reading the run's latest report sent, beside its
   * JSON and never in it. Written by `recordReport` (NULL when that report had
   * none), and cleared by `finishDispatch` once the fire row takes it, as `report` is.
   */
  report_reading_value: ColumnType<number | null, number | null | undefined, number | null>;
  report_reading_label: ColumnType<string | null, string | null | undefined, string | null>;
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
export interface RepeatDeliveryRow {
  sequence_id: Generated<number>; delivery_id: string; agent_id: string; routine_id: string; owner_user_id: string;
  accepted_at: Date; expires_at: Date; github_id_hash: string | null; configuration_hash: string;
  blob_ref: string | null; byte_length: number; dispatch_id: string | null; invalidated_reason: string | null; completed_at: Date | null;
}
export interface RoutinesDatabase {
  routines_v1_deliveries: RepeatDeliveryRow;
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
    if (!await done(10)) {
      await addReadingColumns(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (10)`.execute(trx);
    }
    if (!await done(11)) {
      await addGetDoneSteps(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (11)`.execute(trx);
    }
    if (!await done(12)) {
      await addFinishByColumn(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (12)`.execute(trx);
    }
    if (!await done(13)) {
      await addDoneColumns(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (13)`.execute(trx);
    }
    if (!await done(14)) {
      await addFinishByTimeZoneColumn(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (14)`.execute(trx);
    }
    if (!await done(15)) {
      await splitAuthoredWakeMethods(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (15)`.execute(trx);
    }
    if (!await done(16)) {
      await addDispatchKindColumn(trx);
      await sql`INSERT INTO routines_schema_versions (version) VALUES (16)`.execute(trx);
    }
    if (!await done(17)) {
      await sql`ALTER TABLE routines_v1_dispatches ADD COLUMN executor_id text, ADD COLUMN executor_released boolean NOT NULL DEFAULT false, ADD COLUMN lease_expires_at timestamptz, ADD COLUMN delivery_id text`.execute(trx);
      await sql`CREATE TABLE routines_v1_deliveries (
        sequence_id bigserial PRIMARY KEY, delivery_id text NOT NULL UNIQUE,
        agent_id text NOT NULL, routine_id text NOT NULL, owner_user_id text NOT NULL,
        accepted_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        github_id_hash text, configuration_hash text NOT NULL,
        blob_ref text, byte_length bigint NOT NULL CHECK(byte_length>=0),
        dispatch_id text UNIQUE, invalidated_reason text, completed_at timestamptz
      )`.execute(trx);
      await sql`CREATE UNIQUE INDEX routines_v1_delivery_dedupe ON routines_v1_deliveries(agent_id,routine_id,github_id_hash) WHERE github_id_hash IS NOT NULL`.execute(trx);
      await sql`CREATE INDEX routines_v1_active_admission ON routines_v1_dispatches(agent_id,routine_id) WHERE completed_at IS NULL`.execute(trx);
      await sql`CREATE INDEX routines_v1_delivery_expiry ON routines_v1_deliveries(expires_at) WHERE completed_at IS NOT NULL`.execute(trx);
      await sql`CREATE INDEX routines_v1_delivery_owner ON routines_v1_deliveries(owner_user_id)`.execute(trx);
      await sql`CREATE INDEX routines_v1_delivery_waiting ON routines_v1_deliveries(sequence_id) WHERE completed_at IS NULL AND dispatch_id IS NULL`.execute(trx);
      await sql`INSERT INTO routines_schema_versions(version) VALUES(17)`.execute(trx);
    }
    if (!await done(18)) {
      await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS webhook_address_token text, ADD COLUMN IF NOT EXISTS webhook_legacy_enabled boolean`.execute(trx);
      // Only jobs already configured at upgrade inherit the old shared address.
      await sql`UPDATE routines_v1_definitions SET webhook_legacy_enabled=(webhook_spec IS NOT NULL) WHERE webhook_legacy_enabled IS NULL`.execute(trx);
      await sql`ALTER TABLE routines_v1_definitions ALTER COLUMN webhook_legacy_enabled SET DEFAULT false, ALTER COLUMN webhook_legacy_enabled SET NOT NULL`.execute(trx);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS routines_v1_webhook_address_token ON routines_v1_definitions(webhook_address_token) WHERE webhook_address_token IS NOT NULL`.execute(trx);
      await sql`INSERT INTO routines_schema_versions(version) VALUES(18)`.execute(trx);
    }
  });
}

/** Version 16 (TASK-919). A run's accepted kind never follows its mutable
 * definition. Older rows remain unknown unless settled dispatch receipts
 * explicitly and consistently prove the kind for this exact accepted run.
 * No default: an older binary can still insert, but its unknown run refuses
 * memory capture. The version lock serializes both the column and backfill.
 */
async function addDispatchKindColumn(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_dispatches ADD COLUMN IF NOT EXISTS kind TEXT`.execute(db);
  await sql`
    WITH proven AS (
      SELECT d.dispatch_id, min(q.result #>> '{row,kind}') AS kind
        FROM routines_v1_dispatches d
        JOIN routines_v1_requests q
          ON q.agent_id = d.agent_id AND q.operation = 'dispatch'
         AND q.result->>'dispatchId' = d.dispatch_id
         AND q.result->>'reqId' = d.req_id
         AND q.result #>> '{row,agentId}' = d.agent_id
         AND q.result #>> '{row,routineId}' = d.routine_id
         AND q.result #>> '{row,revision}' = d.revision
       WHERE d.kind IS NULL
       GROUP BY d.dispatch_id
      HAVING count(DISTINCT q.result #>> '{row,kind}') = 1
         AND bool_and(COALESCE(
           jsonb_typeof(q.result #> '{row,kind}') = 'string'
           AND q.result #>> '{row,kind}' IN ('repeat','stay-on-top','get-done'), false))
    )
    UPDATE routines_v1_dispatches d SET kind = proven.kind
      FROM proven WHERE d.dispatch_id = proven.dispatch_id AND d.kind IS NULL
  `.execute(db);
}

/** Version 15 replaces authored trigger storage; catalog defaults remain interval-only.
 * Run with the host quiescent (the current deployment uses Recreate): old binaries
 * cannot use these replaced columns. The existing migration transaction/lock makes
 * the conversion atomic, preserving identities, credentials and scheduling dates.
 */
async function splitAuthoredWakeMethods(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS schedule_spec JSONB,
    ADD COLUMN IF NOT EXISTS webhook_spec JSONB`.execute(db);
  const legacy = await sql`SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='routines_v1_definitions' AND column_name='trigger_spec'`.execute(db);
  if (legacy.rows.length !== 0) {
    await sql`UPDATE routines_v1_definitions SET
      schedule_spec=CASE WHEN trigger_kind IN ('interval','cron') THEN trigger_spec ELSE NULL END,
      webhook_spec=CASE WHEN trigger_kind='webhook' THEN trigger_spec ELSE NULL END`.execute(db);
    await sql`DROP INDEX IF EXISTS routines_v1_webhook_path_unique`.execute(db);
    await sql`ALTER TABLE routines_v1_definitions DROP COLUMN trigger_kind, DROP COLUMN trigger_spec`.execute(db);
  }
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS routines_v1_webhook_path_unique
    ON routines_v1_definitions (agent_id, (webhook_spec->>'path')) WHERE webhook_spec IS NOT NULL`.execute(db);
}

/** Version 12 (TASK-951): a "get-done" task's finish date, which only a person
 * sets (`setFinishBy`, store.ts). TEXT holding `YYYY-MM-DD`, not `date`:
 * pg-types 2.2.0 parses a `date` (OID 1082) into a JS `Date` at the host's local
 * midnight, which moves the day in some host time zones, and nothing here sets a
 * type parser. The named CHECK holds the format only; the rule's range and
 * real-date checks stay at the writer (`RoutineFinishBySchema`), so a later rule
 * can't make stored rows unreadable (TASK-913), and a read takes whatever the
 * rule refuses as no date (`storedFinishBy`, store.ts). It is written with
 * `[0-9]`, never a backslash-d: Kysely's `sql` tag sends the template's cooked
 * text, where that escape arrives as a plain `d`, and the CHECK would then
 * refuse every real date. NULL means none and passes it. Additive, with no
 * backfill: existing rows read NULL, and a re-run keeps the column's values and
 * its one CHECK. Rollback-safe: code from before this version never names the
 * column, and receipts leave the date out (`receiptCopy`, store.ts). One edge:
 * that code's `updateAuthored` doesn't clear the date on a change of kind, so a
 * task taken get-done, stay-on-top, then get-done again under it shows its old
 * date again after rolling forward.
 */
async function addFinishByColumn(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS finish_by TEXT`.execute(db);
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'routines_v1_definitions_finish_by_chk'
           AND conrelid = 'routines_v1_definitions'::regclass
      ) THEN
        ALTER TABLE routines_v1_definitions
          ADD CONSTRAINT routines_v1_definitions_finish_by_chk
          CHECK (finish_by IS NULL OR finish_by ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
      END IF;
    END $$;
  `.execute(db);
}

/** Version 14 (TASK-955): the time zone a "get-done" task's finish date was set
 * from, which the person's browser sends with the date (`setFinishBy`,
 * store.ts). TEXT and nullable, with no default and no CHECK of either kind.
 * No format CHECK: SQL can't say "a zone `Intl` knows", so the writer and every
 * read apply the contract's rule instead (`RoutineTimezoneSchema`; a read takes
 * a zone it refuses as none, `storedFinishByTimeZone`). No coupling CHECK with
 * `finish_by` (a zone only beside a date) either: code from before this version
 * clears the date alone, and its Remove date and its change of kind must still
 * succeed after a rollback. No backfill: existing dates read NULL, so a task with
 * no zone of its own keeps counting its date on UTC's calendar until the date is
 * saved again. A re-run keeps every value. Rollback-safe: code from before this
 * version never names the column, a date it sets keeps whatever zone the row
 * held, and a zone it leaves without a date is ignored on read.
 */
async function addFinishByTimeZoneColumn(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS finish_by_time_zone TEXT`.execute(db);
}

/** Version 13 (TASK-950): a "get-done" task's claim that it's done, and its
 * completion. The claim is the time of the report that made it
 * (`task_done_claimed_at`, that report's `task_reported_at`), and a read shows
 * it only while the two match (`taskState`): code from before this version,
 * after a rollback, writes reports and moves owners without touching it, so a
 * report or owner move there takes the claim back rather than show it beside a
 * report that never said done (TASK-952's stamp, for the same window). The
 * completion is when a person marked the task done and who, read only through
 * `doneOf` (store.ts). Code from before this version ignores the three
 * columns, so a Done task reads there as a paused one: the tick doesn't claim
 * it, Check now is refused, and its agent's reads work. A person may resume it
 * there, and the completion stays, but this version reads a running task as not
 * Done (`doneOf` needs it off), and its next pause here, a person's or ax's,
 * clears it. A pause made there leaves it, so a Done task that code resumed and
 * paused again reads as Done once more after rolling forward. An owner move there leaves a completion whose completer isn't the new
 * owner, so it reads as a plain pause. Code from before this version never
 * looks up a `'complete'` receipt. Nullable, with no default, no backfill and
 * no foreign key (a new foreign key on a shared table has broken other
 * packages' test teardown before): additive, existing rows read unclaimed and
 * not Done, and a re-run keeps every value.
 */
async function addDoneColumns(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_done_claimed_at TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_completed_at TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_completed_by_user_id TEXT`.execute(db);
}

/** Version 11 (TASK-948): the "get-done" kind and its checklist. The kind
 * check, which version 3 named so a later kind could swap it, is swapped:
 * dropped if it exists, then added with "get-done", in one statement. Every
 * existing row reads an empty checklist, the column's default. Additive, and a
 * re-run is a no-op: it puts back the same check, and the column keeps every
 * value already written. Code from before this version ignores the column, and
 * the new check still allows every kind it knows, but it can't read a get-done
 * row (its `RoutineKindSchema` refuses the kind). That agent's `routines:list`
 * and `routines:get` fail, and since its `claimDue` maps every claimed row
 * through `rowToRoutine`, one due get-done row fails the whole tick batch: every
 * routine claimed beside it is pushed a claim window and skipped. So before
 * rolling back below this version, delete every get-done task. Pausing one
 * keeps the tick safe, since a paused row isn't claimed, but not its agent's
 * list.
 */
async function addGetDoneSteps(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`
    ALTER TABLE routines_v1_definitions
      DROP CONSTRAINT IF EXISTS routines_v1_definitions_kind_chk,
      ADD CONSTRAINT routines_v1_definitions_kind_chk CHECK (kind IN ('repeat', 'stay-on-top', 'get-done')),
      ADD COLUMN IF NOT EXISTS task_steps JSONB NOT NULL DEFAULT '[]'::jsonb
  `.execute(db);
}

/** Version 10 (TASK-952): a report's optional reading, one number the agent read
 * at a check-in and the label it gave it, on the task (its latest report's), on
 * the run's dispatch until it finishes, and on the run's fire row. A reading has
 * columns of its own, never keys in the dispatch's `report` JSON: code from before
 * this version reads that JSON with a strict schema and would drop the whole
 * report (card decision 4). `task_reading_reported_at` is the `task_reported_at`
 * of the report the reading came with, and a read shows the reading only while
 * the two match. Code from before this version, after a rollback, writes reports
 * and moves owners without touching these columns, so a report it writes never
 * shows an older report's reading, an earlier owner's included (TASK-952
 * decisions row 3). No CHECK: stored values aren't re-checked (TASK-913), so a
 * read takes them leniently instead (`readingOf`, store.ts). Additive and
 * nullable, with no backfill: existing rows read back with no reading, code
 * from before this version ignores the columns, and a re-run keeps their values.
 */
async function addReadingColumns(db: Kysely<RoutinesDatabase>): Promise<void> {
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_reading_value DOUBLE PRECISION`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_reading_label TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS task_reading_reported_at TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE routines_v1_dispatches ADD COLUMN IF NOT EXISTS report_reading_value DOUBLE PRECISION`.execute(db);
  await sql`ALTER TABLE routines_v1_dispatches ADD COLUMN IF NOT EXISTS report_reading_label TEXT`.execute(db);
  await sql`ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS report_reading_value DOUBLE PRECISION`.execute(db);
  await sql`ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS report_reading_label TEXT`.execute(db);
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
 * fifth in a row pauses the task), `updateAuthored` (a person's Resume or a
 * kind change clears them) and `reconcileOwners` (a change of owner clears
 * them, TASK-936). Additive, with no backfill: existing rows read 0 and
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
  // Older-version repair runs may revisit this helper after v15 replaced the columns.
  const legacy = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='routines_v1_definitions' AND column_name='trigger_spec'`.execute(db);
  if (legacy.rows.length !== 0) await sql`CREATE UNIQUE INDEX IF NOT EXISTS routines_v1_webhook_path_unique
    ON routines_v1_definitions (agent_id, (trigger_spec->>'path')) WHERE trigger_kind='webhook'`.execute(db);
  else await sql`CREATE UNIQUE INDEX IF NOT EXISTS routines_v1_webhook_path_unique
    ON routines_v1_definitions (agent_id, (webhook_spec->>'path')) WHERE webhook_spec IS NOT NULL`.execute(db);
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
