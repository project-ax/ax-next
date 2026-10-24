import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from 'kysely';
import { SafeToolError } from '@ax/core';
import {
  applyRoutinePatch, CheckInMissSchema, durationToSeconds, isTaskKind, ROUTINE_REPLIES_MAX_LIMIT, RoutineDeleteOutputSchema, RoutineFinishBySchema, TASK_AUTO_PAUSE_AFTER_MISSES,
  type CheckInMiss, type RoutineCreateInput, type RoutineUpdateInput, type RoutineDeleteInput, type RoutineDeleteOutput,
  type RoutineKey, type RoutineSecretInput, type RoutineUpsertDefaultInput, type RoutineDefinition, type RoutineStepOp,
  RoutineCheckInViewSchema, type RoutineCheckInView
} from '@ax/routines-contract';
import type { RoutinesDatabase, RoutinesDefinitionsRow, DefaultRoutinesRow, RoutinesFiresRow } from './migrations.js';
import type { StoredRoutine, StoredNoRecentUpdate, StoredReading, StoredStep, StoredTaskState, AcceptedDispatch, AddReplyResult, DispatchMiss, DispatchOutcome, DispatchReport, FireReport, FireRow, FireSource, FireStatus, OpenCheckInLookup, RecordedSteps, RecordReportInput, ReportRefusal, SetStepsResult, StoredReply } from './types.js';
import { createRequestHash, updateRequestHash, deleteRequestHash, dispatchRequestHash, credentialRef, editableDefinition, hasHmac, inputHash, nextRun, opaqueId, parseStoredRoutine, schedulingChanged, validateDefinition, validationError } from './definition.js';
import { AcceptedDispatchSchema, DispatchOutcomeSchema, DispatchReportSchema } from './dispatch.js';
import { changeStoredSteps, storedSteps, StepsReceiptSchema } from './steps.js';

type DB = Kysely<RoutinesDatabase>;
type Actor = { actorUserId: string };
export type CleanupJob = { agentId: string; routineId: string; credentialRef: string; ownerUserId: string };
export type AcceptDispatchInput = RoutineKey & Actor & { expectedRevision: string; source: FireSource; requestId: string; now: Date };
export type OperationKey = { agentId: string; actorUserId: string; operation: string; requestId: string; inputHash: string };
export type DefaultRoutineDetailRow = RoutineDefinition & { defaultRoutineId: string; updatedAt: Date };
export interface RoutinesStore {
  createAuthored(input: RoutineCreateInput & Actor & { ownerUserId: string; now: Date }): Promise<StoredRoutine>;
  updateAuthored(input: RoutineUpdateInput & Actor & { now: Date; stopOnly: boolean }): Promise<StoredRoutine>;
  deleteAuthored(input: RoutineDeleteInput & Actor & { now: Date }): Promise<RoutineDeleteOutput>;
  list(input: { agentId: string }): Promise<StoredRoutine[]>;
  findOne(input: RoutineKey): Promise<StoredRoutine | null>;
  findWebhook(input: { agentId: string; path: string }): Promise<StoredRoutine | null>;
  acceptDispatch(input: AcceptDispatchInput): Promise<{ accepted: AcceptedDispatch; replayed: boolean } | null>;
  interruptAbandonedDispatches(): Promise<number>;
  getDispatchOutcome(input: { agentId: string; dispatchId: string }): Promise<DispatchOutcome | null>;
  /**
   * Records a run's end, once; false when it had already ended, is gone, or its
   * agent is retired. Every run of every routine ends here, so TASK-930 counts a
   * task's missed check-ins here too, and pauses the task at the fifth in a row
   * (`missesAfterRun`). Runs that overlap count in the order they started, as
   * `recordReport` keeps reports, whatever order they finish in. It writes the
   * count; `updateAuthored` (a person's Resume, a kind change) and
   * `reconcileOwners` (a change of owner, TASK-936) only start it over.
   * TASK-936: the fire row takes who the run ran as from its dispatch, and a run
   * that ran as someone who no longer owns the routine leaves the count alone,
   * as `recordReport` refuses its report; one with no record of who it ran as
   * (accepted by code from before version 9) counts as before.
   */
  finishDispatch(input: { dispatchId: string; outcome: DispatchOutcome }): Promise<boolean>;
  /** TASK-907. Records an open run's conversation, once. Throws `RUN_CLOSED` when the run has finished, is gone, or its agent is retired. */
  bindDispatchConversation(input: { dispatchId: string; conversationId: string }): Promise<void>;
  /** TASK-907. The one open run of this agent in this conversation, or why there's none: no open run, more than one, or one whose routine is gone. Takes no lock. */
  findOpenDispatchByConversation(input: { agentId: string; conversationId: string }): Promise<OpenCheckInLookup>;
  /**
   * TASK-907. The one writer of a task's report, and one of the two writers of
   * a get-done task's checklist (TASK-949: `setSteps` is the other; both keep
   * entries this version can't read): `updateAuthored` (a kind change) and
   * `reconcileOwners` (a change of owner, TASK-936) only clear them. Nothing is
   * written, and the answer says why, unless the run is an open check-in, bound
   * to the report's conversation, of a task (`TASK_KINDS`) its actor owns, on a
   * live agent. TASK-952: the report's reading, or its absence, lands with it,
   * on the run and under the same guard on the task. A report's step changes
   * apply as the agent's, in order, by id, under the routine's row lock,
   * whatever order overlapping runs report in (`changeStoredSteps`); a task
   * that is no longer get-done skips them all. The answer is `'recorded'` when
   * the report sent no step changes, and counts those that applied and those
   * skipped when it did.
   */
  recordReport(input: RecordReportInput): Promise<'recorded' | RecordedSteps | ReportRefusal>;
  /**
   * TASK-910. The person clears a task's agent notes. Owner only, decided under
   * the routine's row lock. No run accepted at or before the clear can write
   * notes again (`recordReport`). Touches nothing else in the row.
   */
  clearAgentNotes(input: RoutineKey & { actorUserId: string; now: Date }): Promise<'cleared' | 'not-found' | 'forbidden'>;
  /**
   * TASK-951. A person sets a "get-done" task's finish date, or removes it with
   * null. Owner only, decided under the agent fence and the routine's row lock,
   * so a change of kind that commits first makes it `not-found`: a task that
   * isn't get-done, a missing routine and a retired agent all are. It writes
   * `finish_by` alone, so the revision, the spec hash and `updated_at` stay, and
   * keeps no receipt: the same date set twice is the same write. The caller
   * checks the date (`RoutineSetFinishByInputSchema`); the column's CHECK
   * refuses anything not written `YYYY-MM-DD`, and every read takes a value the
   * contract's rule refuses as none.
   */
  setFinishBy(input: RoutineKey & Actor & { finishBy: string | null }): Promise<{ finishBy: string | null } | 'not-found' | 'forbidden'>;
  /**
   * TASK-931. A person's reply on a task. Owner only, decided under the agent
   * fence and the routine's row lock, so a reply can't land on a routine being
   * deleted: it waits, then finds no row. A repeat routine, a missing one and a
   * retired agent are `not-found`. The same `requestId` again, from the same
   * person on the same routine, stores nothing and answers `replayed` with the
   * first reply's id; the first text is kept. Either way `row` is the routine as
   * read under the lock. Replies outlive a change of kind or of owner, and go
   * with their routine (`deleteAuthored`) or agent (`purgeAgent`). The text is
   * the person's, checked by the caller (`RoutineReplyTextSchema`).
   */
  addReply(input: RoutineKey & Actor & { requestId: string; text: string; now: Date }): Promise<AddReplyResult>;
  /**
   * TASK-931. The replies `actorUserId` wrote on a routine they own now, newest
   * first (ties by reply id). None when the routine is gone or someone else owns
   * it. So a read returns only the current owner's own words, and only to them:
   * once `reconcileOwners` moves a routine, the earlier owner's replies stay
   * stored but reach neither the new owner nor a check-in run as them, and read
   * again only if the routine returns to their author. One statement, so the
   * owner can't change between the check and the read. `limit` is clamped to
   * 1-50. The text is person-written.
   */
  recentReplies(input: RoutineKey & Actor & { limit: number }): Promise<StoredReply[]>;
  /**
   * TASK-949. A person's changes to a get-done task's steps, from its task page.
   * Owner only, decided under the agent fence and the routine's row lock, which
   * `recordReport` takes too, so a change and a report that overlap both land:
   * whichever waits re-reads the steps the other wrote. A missing routine, and
   * one that isn't get-done, is `not-found`; someone else's is `forbidden`. The
   * changes apply as the person's, in order, by id (`changeStoredSteps`): they
   * may tick, reword or remove any step, and their add, like a step whose words
   * they change, is theirs. A change that can't apply is skipped and counted;
   * `steps` is the list after them all. The same `requestId` again, from the
   * same person with the same changes, changes nothing: it answers the first
   * try's count with the steps as they are now, the owner checked again under
   * the lock. The receipt keeps that count and never a step's text. The same
   * `requestId` with other changes, or on another routine, throws
   * `request-conflict`, and a retired agent throws `not-found`
   * (`receiptTransaction`). Never moves the routine's revision, spec hash or
   * updated time: the steps are task state.
   */
  setSteps(input: RoutineKey & Actor & { requestId: string; ops: readonly RoutineStepOp[] }): Promise<SetStepsResult>;
  advance(input: RoutineKey & { expectedRevision: string; nextRunAt: Date | null; lastRunAt: Date }): Promise<void>;
  claimDue(input: { now: Date; limit: number; claimWindowMinutes: number }): Promise<StoredRoutine[]>;
  /**
   * A routine's runs, newest first; `limit` is clamped to 1-200. TASK-936: a
   * live routine's runs only when they ran as its current owner, so after a
   * change of owner the earlier owner's runs reach no one until the routine
   * returns to them; every run of a routine that's gone. Each row carries the
   * owner read in the same statement (`routineOwnerUserId`, `historyQuery`).
   */
  recentFires(input: RoutineKey & { limit?: number }): Promise<FireRow[]>;
  /** An agent's runs, newest first, older than `before` when it's given, under `recentFires`' rule. */
  recentFiresForAgent(input: { agentId: string; limit?: number; before?: Date }): Promise<FireRow[]>;
  /**
   * TASK-908. A routine's latest reports, for its next check-in's message:
   * finished runs with a report, newest first, however many runs without one
   * came in between. TASK-936: read as `recentReplies` reads replies, the
   * reports of runs that ran as `actorUserId`, on a routine they own now. None
   * when the routine is gone or someone else owns it, so an earlier owner's
   * reports reach neither a new owner nor a check-in run as them, and read
   * again only if the routine returns to them. One statement, so the owner
   * can't change between the check and the read. `limit` is clamped to 1-10.
   * The text is agent-written, each report's reading too (TASK-952).
   */
  recentReports(input: RoutineKey & Actor & { limit: number }): Promise<Array<{ firedAt: Date; report: FireReport }>>;
  /**
   * TASK-908. Whether `conversationId` is a task check-in's conversation on
   * `agentId`: some run of that agent, open or finished, is bound to it, and
   * its routine isn't a repeat routine, or is gone. Read from routines' own
   * dispatch rows, so the answer survives a host restart mid-check-in.
   */
  isTaskConversation(input: { agentId: string; conversationId: string }): Promise<boolean>;
  /**
   * TASK-932. Which of these conversations are check-ins of a task `actorUserId`
   * owns, on `agentId`, for Today's labels: exactly one run of that agent, open or
   * finished, is bound to it, and that run's routine still exists, isn't a repeat
   * routine and is theirs. A conversation several runs shared is left out,
   * whatever their routines. The kind and owner are read now, not at run time.
   * Reads the routine's id and name only, so a row another read couldn't parse
   * still answers, and a name the contract refuses leaves out only its own entry.
   * One read, no lock, through version 5's index.
   */
  tasksForConversations(input: { agentId: string; actorUserId: string; conversationIds: readonly string[] }): Promise<RoutineCheckInView[]>;
  findOperationReceipt(input: OperationKey): Promise<unknown | null>;
  withLockedWebhookSecret(input: RoutineSecretInput, effect: () => Promise<void>): Promise<{ saved: true }>;
  pendingCleanup(input: { limit: number }): Promise<CleanupJob[]>;
  runCredentialCleanup(key: { agentId: string; credentialRef: string }, effect: (job: CleanupJob) => Promise<void>): Promise<boolean>;
  purgeAgent(agentId: string): Promise<void>;
  upsertDefault(input: RoutineUpsertDefaultInput): Promise<{ defaultRoutineId: string; created: boolean }>;
  getDefault(defaultRoutineId: string): Promise<DefaultRoutineDetailRow | null>;
  listDefaults(): Promise<DefaultRoutineDetailRow[]>;
  deleteDefault(defaultRoutineId: string): Promise<void>;
  materializeMissing(input: { agents: ReadonlyArray<{ agentId: string; ownerUserId: string }>; now: Date }): Promise<void>;
  refreshStale(input: { now: Date }): Promise<void>;
  /**
   * TASK-397. Moves every routine of each of these user-owned agents to the
   * agent's owner, at a new revision. TASK-936: in the same statement it clears
   * each one's task state (`NO_TASK_STATE`, which a change of kind clears too),
   * whatever its kind, because a task's state is its owner's: the report, its
   * ask, the agent notes and the missed check-ins came from runs as the earlier
   * owner, with what only they can reach. One statement, so no read finds the
   * new owner beside the old state. `enabled`, the schedule and
   * `agent_notes_cleared_at` stay, so a task ax paused for misses stays paused,
   * now as a plain pause. A get-done task's finish date stays: unlike a change
   * of kind, a change of owner doesn't touch it (TASK-951).
   * The last run's status, error and warning are cleared as well (they
   * describe a run only the earlier owner can see, and name what only they
   * could reach); its time stays. A change of kind keeps them.
   * Replies stay where they are: a read returns only the replies the current
   * owner wrote (`recentReplies`, TASK-931). Runs stay stored too, each with who
   * it ran as, which this never moves. While the routine lives, its history
   * lists only the runs that ran as its current owner (`recentFires`,
   * `recentFiresForAgent`), and a check-in reads only the reports of runs that
   * ran as its own person, while that person owns the routine
   * (`recentReports`), so the earlier owner's runs list for no one until the
   * routine returns to them. Once the routine is deleted, all its runs list
   * again, with no report.
   */
  reconcileOwners(input: { agents: ReadonlyArray<{ agentId: string; ownerUserId: string }> }): Promise<number>;
  setAgentDefaultEnabled(input: { agentId: string; defaultRoutineId: string; ownerUserId: string; enabled: boolean }): Promise<void>;
  isAgentDefaultEnabled(input: { agentId: string; defaultRoutineId: string }): Promise<boolean>;
  disabledDefaultIdsForAgent(agentId: string): Promise<string[]>;
  removeMaterializedDefault(input: { agentId: string; defaultRoutineId: string }): Promise<void>;
}
/**
 * `isTaskConversation`'s one query, exported so a test can check the planner
 * reads it through version 5's index.
 */
export function taskConversationQuery(db: Kysely<RoutinesDatabase>, input: { agentId: string; conversationId: string }) {
  return db.selectFrom('routines_v1_dispatches as d')
    .leftJoin('routines_v1_definitions as r', join => join.onRef('r.agent_id', '=', 'd.agent_id').onRef('r.routine_id', '=', 'd.routine_id'))
    .select('d.dispatch_id')
    .where('d.agent_id', '=', input.agentId).where('d.conversation_id', '=', input.conversationId)
    .where(eb => eb.or([eb('r.kind', 'is', null), eb('r.kind', '!=', 'repeat')]))
    .limit(1);
}
/**
 * `tasksForConversations`' one query, exported so a test can check the planner
 * reads it through version 5's index. Each conversation reads at most two of
 * its dispatch rows: one is a single run, two means several shared it. A
 * shared conversation gains a row every run, forever, so a plain join would
 * read them all on every Today load. Runs are counted before the routine's kind
 * and owner are checked, so a second run makes a conversation ambiguous whatever
 * its routine. The inner query states the partial index's own predicate
 * (`conversation_id IS NOT NULL`), so the planner can always use it.
 */
export function tasksForConversationsQuery(input: { agentId: string; actorUserId: string; conversationIds: readonly string[] }) {
  return sql<{ conversation_id: string; routine_id: string; name: string }>`
    SELECT c.conversation_id, r.routine_id, r.name
      FROM unnest(${[...input.conversationIds]}::text[]) AS c(conversation_id)
     CROSS JOIN LATERAL (
           SELECT count(*) AS runs, min(d.routine_id) AS routine_id
             FROM (SELECT routine_id
                     FROM routines_v1_dispatches
                    WHERE agent_id = ${input.agentId}
                      AND conversation_id = c.conversation_id
                      AND conversation_id IS NOT NULL
                    LIMIT 2) d
           ) bound
      JOIN routines_v1_definitions r
        ON r.agent_id = ${input.agentId} AND r.routine_id = bound.routine_id
     WHERE bound.runs = 1
       AND r.kind <> 'repeat'
       AND r.owner_user_id = ${input.actorUserId}
  `;
}
function definitionColumns(d: RoutineDefinition) {
  return {
    name: d.name, description: d.description, prompt_body: d.promptBody, enabled: d.enabled,
    trigger_kind: d.trigger.kind, trigger_spec: d.trigger as unknown, active_hours: d.activeHours as unknown,
    silence_token: d.silenceToken, silence_max: d.silenceMaxChars, conversation: d.conversation,
    kind: d.kind, good_when: d.goodWhen, spec_hash: inputHash(d)
  };
}
/**
 * TASK-952. A stored reading, read leniently (TASK-913): a finite number and a
 * non-empty label make one; a NaN, an infinity (both legal in DOUBLE PRECISION,
 * and pg parses them to numbers) or a half-set pair (a rollback, a hand edit)
 * reads as none, so claimDue can't fail on it.
 */
function readingOf(value: number | null, label: string | null): StoredReading | null {
  return typeof value === 'number' && Number.isFinite(value) && typeof label === 'string' && label.length > 0 ? { value, label } : null;
}
/**
 * TASK-907. A task's state is its latest report, so it's there only when the
 * report's status, update and time all are. A row with only some of them (a
 * rollback, a hand edit) reads as never reported rather than failing every read
 * of it, claimDue's included (TASK-913). TASK-952: its reading shows only when
 * it came with this report (`task_reading_reported_at` is this report's time):
 * code from before version 10 writes a report without touching the reading, and
 * the reading it leaves is an earlier report's.
 */
function taskState(row: Selectable<RoutinesDefinitionsRow>): StoredTaskState | null {
  if (row.task_status === null || row.task_update === null || row.task_reported_at === null) return null;
  const ownReading = row.task_reading_reported_at !== null && row.task_reading_reported_at.getTime() === row.task_reported_at.getTime();
  return {
    status: row.task_status, update: row.task_update, ask: row.task_ask, agentNotes: row.agent_notes, reportedAt: row.task_reported_at,
    reading: ownReading ? readingOf(row.task_reading_value, row.task_reading_label) : null,
  };
}
/**
 * TASK-930. A task's missed check-ins, read leniently (TASK-913): a count of at
 * least one and a miss time make a miss, so a row with no count, a count below
 * one or no time (a rollback, a hand edit) reads as none, as `taskState` reads a
 * partly-set report. A reason no code knows (a later version's, after a
 * rollback) or none at all reads `failed`. claimDue parses every due row, so one
 * odd row can't stop the tick for everyone.
 */
function noRecentUpdate(row: Selectable<RoutinesDefinitionsRow>): StoredNoRecentUpdate | null {
  const inARow = row.task_misses_in_a_row;
  if (!Number.isInteger(inARow) || inARow < 1 || row.task_miss_at === null) return null;
  const reason = CheckInMissSchema.safeParse(row.task_miss_reason);
  return { inARow, reason: reason.success ? reason.data : 'failed', at: row.task_miss_at, autoPausedAt: row.task_auto_paused_at };
}
/**
 * TASK-907. A task's state belongs to the kind it was reported under, so an edit
 * that changes a routine's kind sets these in the same statement. A task turned
 * into a repeat routine and back starts over: the latest report, its ask and the
 * notes it held before the edit don't come back to the task, so it shows no
 * state and its next check-in has no notes. Its runs' fire rows are history and
 * stay, though, so that check-in's message still lists the reports those runs
 * made (never their asks), as `recentReports` reads them. TASK-908 decisions row
 * 21 (earlier reports after a kind round trip) accepts that: the text is the
 * routine's own, and both kind changes needed the person's yes.
 *
 * "Starts over" is about what is stored, not about runs. A run still open from
 * before the round trip (stay-on-top, repeat, stay-on-top) is a live check-in of
 * the same routine, and clearing `task_report_accepted_at` lets it report into
 * the restarted task. That is accepted: the report is still that routine's own,
 * and it lands on that run too.
 *
 * TASK-930: its missed check-ins start over with the rest (`NO_MISSES`), a pause
 * for them included. `enabled` isn't touched, so a task ax paused stays paused
 * through a kind change; only a Resume runs it again.
 *
 * TASK-936: a change of owner sets these too, in the statement that moves the
 * routine (`reconcileOwners`), whatever its kind, because a task's state is its
 * owner's. There too `enabled` isn't touched, so a task ax paused stays paused,
 * now as a plain pause. Unlike a kind round trip, a run still open from before
 * the move can't report into the new owner's task: it runs as the earlier
 * owner, and `recordReport` refuses a report whose actor doesn't own the
 * routine.
 *
 * TASK-952: the latest report's reading goes with it, its value, label and
 * stamp, so a kind change or a change of owner clears it too. The runs keep
 * theirs on their fire rows, as they keep their reports.
 *
 * TASK-948: a get-done task's checklist is task state too, so a change of kind
 * or of owner starts it over: `task_steps` goes back to `[]`, written as the
 * JSON text the column parses. Steps the agent added can carry what only the
 * earlier owner could reach.
 *
 * TASK-951: a get-done task's finish date isn't here. A change of kind clears
 * it beside these (`NO_FINISH_BY`); a change of owner, which writes these too,
 * keeps it.
 */
const NO_MISSES = { task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null } as const;
const NO_TASK_STATE = {
  task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null,
  task_reading_value: null, task_reading_label: null, task_reading_reported_at: null,
  task_steps: '[]',
  ...NO_MISSES,
} as const;
/**
 * TASK-951. A change of kind clears a task's finish date, as it starts the task
 * over (TASK-907). A change of owner doesn't: the date is about the work, not
 * text from the earlier owner's runs, so it's not in `NO_TASK_STATE`, which
 * `reconcileOwners` also writes.
 */
const NO_FINISH_BY = { finish_by: null } as const;
/**
 * TASK-930. The hash `updateAuthored` stores for this row paused by a person: of
 * its definition with `enabled` false. `finishDispatch` runs in plugin init
 * (`interruptAbandonedDispatches`, with no catch), so a stored definition that
 * today's checks refuse keeps its stored hash rather than stop the host booting.
 * `kept` says it did, so `finishDispatch` can say so after commit, in ids only.
 */
function pausedSpecHash(row: Selectable<RoutinesDefinitionsRow>): { hash: string; kept: boolean } {
  try { return { hash: inputHash({ ...editableDefinition(rowToRoutine(row)), enabled: false }), kept: false }; }
  catch { return { hash: row.spec_hash, kept: true }; }
}
type MissesWrite = { columns: Updateable<RoutinesDefinitionsRow> } & ({ paused: false } | { paused: true; keptHash: boolean });
/**
 * TASK-930. What a finished run does to its task's missed check-ins, given the
 * routine's row as `finishDispatch` locked it before writing anything. Null
 * leaves them as they are: for a repeat routine, and while the task is paused for
 * them (`task_auto_paused_at` set and not enabled), so a run that started before
 * the pause (a Check now beside the fifth check-in) can't count past it, or clear
 * it by reporting. Only a person's Resume or a kind change (`updateAuthored`),
 * or a change of owner (`reconcileOwners`, TASK-936), ends that. Keyed on
 * `enabled` too: a row resumed without a reset (code from before version 7,
 * after a rollback) counts again, and can pause again.
 *
 * Runs that overlap (a Check now beside a scheduled check-in) answer in the
 * order they started, whatever order they finish in, as `recordReport` keeps
 * the report of the run accepted last. A report is saved when the agent sends
 * it, before its run finishes, and answers from then on. So null too for a run
 * without a report once a run that started after it has reported
 * (`task_report_accepted_at`), finished or not. A run without a report counts
 * on from the misses after a report whose run is still open, not from the
 * count, which that run hasn't trimmed yet (`reportStillOpen`), still capped at
 * the count plus one, so a Resume's fresh start holds; it doesn't count itself
 * when it started in the same instant as that report, whose run finishes after
 * it, and with no misses after that report, it clears them. A run that reported
 * behind a newer miss (`task_miss_at`) leaves that miss, with its reason and
 * start, but ends the misses before it: the count drops to the runs that
 * started after it and finished without a report, if that's fewer
 * (`unansweredAfter`). The newer miss's own run is one of them, so that's at
 * least one, unless a hand edit or a rollback left a miss time no such run
 * backs, or a count below one; then the report clears them. A run without a
 * report behind a newer miss still counts, but keeps that miss's reason and
 * start, so `task_miss_at` never moves back. So whenever a miss is counted (the
 * only place a pause is decided), the count is exactly the misses that started
 * after the latest saved report. It is never short. It can lag: a report saved
 * after a newer miss finished leaves the misses before it counted until the
 * next run finishes, and an older run's late report trims from its own start,
 * so it keeps the misses a newer report, its run still open, already answers,
 * until that run finishes. A person can see that, but nothing pauses on it. It
 * can also run long when a Resume or a kind change starts it over while runs
 * overlap, since a fire row doesn't say which side of it its run finished on.
 *
 * A run that reported clears them. Any other run missed, whatever its status:
 * one more in a row, with its start (the fire row's time) and its reason, the one
 * its caller classified for an `error` run (`failed` when it gave none), else
 * `no-report`. The fifth in a row pauses a running task the way a person's pause
 * does (design §7's cost bound): not enabled, a new revision, so an edit, Check
 * now or tick held against the old one is refused, the paused definition's hash,
 * no next run, and `updated_at`, at the instant `task_auto_paused_at` records.
 */
async function missesAfterRun(
  trx: Transaction<RoutinesDatabase>,
  row: Selectable<RoutinesDefinitionsRow>,
  run: { reported: boolean; status: FireStatus; miss: DispatchMiss | undefined; acceptedAt: Date },
  now: Date,
): Promise<MissesWrite | null> {
  if (row.kind === 'repeat' || (row.task_auto_paused_at !== null && !row.enabled)) return null;
  // recordReport's order: a run started after this one has already answered.
  const newerMiss = row.task_miss_at !== null && row.task_miss_at > run.acceptedAt;
  if (run.reported) {
    if (!newerMiss) return { columns: NO_MISSES, paused: false };
    // The misses before this report end; the ones after it, the newer miss's own included, stay.
    const kept = await unansweredAfter(trx, row, run.acceptedAt, Math.max(0, row.task_misses_in_a_row));
    return { columns: kept === 0 ? NO_MISSES : { task_misses_in_a_row: kept }, paused: false };
  }
  const reportAt = row.task_report_accepted_at;
  if (reportAt !== null && reportAt > run.acceptedAt) return null;
  // A count below zero (a hand edit) starts again at one.
  const upTo = Math.max(0, row.task_misses_in_a_row) + 1;
  // A saved report whose run is still open has answered the misses that started before it, though
  // its run hasn't trimmed them yet: count the ones after it. This run's fire row, just written, is
  // one, unless it started in the same instant as that report, whose run finishes after it.
  const inARow = reportAt !== null && await reportStillOpen(trx, row, reportAt) ? await unansweredAfter(trx, row, reportAt, upTo) : upTo;
  // None after it: that open report answers every miss counted, this one included.
  if (inARow === 0) return { columns: NO_MISSES, paused: false };
  const reason: CheckInMiss = run.status === 'error' ? run.miss ?? 'failed' : 'no-report';
  const counted = newerMiss ? { task_misses_in_a_row: inARow }
    : { task_misses_in_a_row: inARow, task_miss_reason: reason, task_miss_at: run.acceptedAt };
  if (inARow < TASK_AUTO_PAUSE_AFTER_MISSES || !row.enabled) return { columns: counted, paused: false };
  const specHash = pausedSpecHash(row);
  return {
    columns: {
      ...counted, enabled: false, revision: opaqueId('rev'), spec_hash: specHash.hash,
      next_run_at: null, updated_at: now, task_auto_paused_at: now,
    },
    paused: true, keptHash: specHash.kept,
  };
}
/**
 * TASK-930. Whether a run of the routine that started at `at` is still open with
 * a saved report: the task's report (`task_report_accepted_at`), whose run
 * hasn't finished, so hasn't cleared or trimmed the misses before it yet. Its
 * `report` is set by `recordReport` and cleared when the run finishes.
 * `routines_v1_dispatches_open_conversation` narrows the scan to the agent's
 * open runs. `completed_at IS NULL` is redundant with `report IS NOT NULL`
 * logically, but it's what lets that partial index apply, so it stays.
 */
async function reportStillOpen(trx: Transaction<RoutinesDatabase>, row: Selectable<RoutinesDefinitionsRow>, at: Date): Promise<boolean> {
  return await trx.selectFrom('routines_v1_dispatches').select('dispatch_id')
    .where('agent_id', '=', row.agent_id).where('completed_at', 'is', null).where('routine_id', '=', row.routine_id)
    .where('accepted_at', '=', at).where('report', 'is not', null).limit(1).executeTakeFirst() !== undefined;
}
/**
 * TASK-930. How many of the routine's runs that started after `after` have
 * finished without a report, but no more than `atMost`: a run's fire row is
 * written when it finishes, with its start as `fired_at`, so the run that
 * started at `after` isn't one. A row with only part of a report has none, as
 * `rowToFire` reads it. Through `routines_v1_fires_by_routine`, returning at most
 * `atMost` rows, in `finishDispatch`'s transaction with the routine's row locked.
 * Leaving out runs that reported is defensive: a count our code writes never
 * holds more misses than the runs after the latest report that finished without
 * one, so only a hand-edited or rolled-back count reaches past them.
 */
async function unansweredAfter(trx: Transaction<RoutinesDatabase>, row: Selectable<RoutinesDefinitionsRow>, after: Date, atMost: number): Promise<number> {
  const fires = await trx.selectFrom('routines_v1_fires').select('id')
    .where('agent_id', '=', row.agent_id).where('routine_id', '=', row.routine_id).where('fired_at', '>', after)
    .where(eb => eb.or([eb('report_status', 'is', null), eb('report_update', 'is', null)]))
    .limit(atMost).execute();
  return fires.length;
}
/**
 * TASK-951. A stored finish date, read through the contract's whole rule
 * (TASK-913). The column's CHECK holds the format only, so a day no calendar has
 * (`2026-02-30`, `2026-13-45`: a hand edit) or one outside the rule's years (a
 * later version's) reads as none. Taken as it is, V8 would roll the first over
 * into March, and `Intl.DateTimeFormat` would throw on the second wherever the
 * date is spelled. One odd row can't fail a read either: claimDue maps every
 * due row through here.
 */
function storedFinishBy(value: string | null): string | null {
  return RoutineFinishBySchema.safeParse(value).success ? value : null;
}
function rowToRoutine(row: Selectable<RoutinesDefinitionsRow>): StoredRoutine {
  return parseStoredRoutine({
    agentId: row.agent_id, routineId: row.routine_id, revision: row.revision, ownerUserId: row.owner_user_id,
    name: row.name, description: row.description, promptBody: row.prompt_body, enabled: row.enabled, trigger: row.trigger_spec,
    activeHours: row.active_hours, silenceToken: row.silence_token, silenceMaxChars: row.silence_max, conversation: row.conversation,
    kind: row.kind, goodWhen: row.good_when, definitionId: row.definition_id, definitionUpdatedAt: row.definition_updated_at, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status, lastError: row.last_error, lastWarning: row.last_warning, task: taskState(row),
    noRecentUpdate: noRecentUpdate(row), steps: storedSteps(row.task_steps), finishBy: storedFinishBy(row.finish_by),
  });
}
/**
 * TASK-936. The one query both history reads (`recentFires`,
 * `recentFiresForAgent`) build on: fire rows, each with its routine's owner read
 * in the same statement, so which runs list and who may read their reports
 * (`fireViews`) can't disagree across a change of owner. A live routine's runs
 * list only when they ran as its current owner, so after a move the earlier
 * owner's runs reach no one, and list again only if the routine returns to
 * them. One with no record of who it ran as (written by code from before
 * version 9) lists for no one while its routine lives. Every run of a routine
 * that's gone lists, as before, with no owner, so it shows no report.
 */
function historyQuery(db: DB) {
  return db.selectFrom('routines_v1_fires as f')
    .leftJoin('routines_v1_definitions as r', join => join.onRef('r.agent_id', '=', 'f.agent_id').onRef('r.routine_id', '=', 'f.routine_id'))
    .selectAll('f').select('r.owner_user_id as routine_owner_user_id')
    .where(eb => eb.or([eb('r.routine_id', 'is', null), eb('f.run_as_user_id', '=', eb.ref('r.owner_user_id'))]));
}
function rowToFire(r: Selectable<RoutinesFiresRow> & { routine_owner_user_id: string | null }): FireRow {
  return {
    id: Number(r.id), agentId: r.agent_id, routineId: r.routine_id, firedAt: r.fired_at, triggerSource: r.trigger_source,
    conversationId: r.conversation_id, status: r.status, error: r.error, renderedPrompt: r.rendered_prompt, warning: r.warning,
    // Nested, so no column name reaches the view. A row with only part of a report has none (TASK-907, TASK-913).
    // TASK-952: its reading, read leniently like every reading.
    report: r.report_status === null || r.report_update === null ? null
      : { status: r.report_status, update: r.report_update, ask: r.report_ask, reading: readingOf(r.report_reading_value, r.report_reading_label) },
    routineOwnerUserId: r.routine_owner_user_id,
  };
}
function defaultRowToDetail(row: Selectable<DefaultRoutinesRow>): DefaultRoutineDetailRow {
  return {
    ...validateDefinition({
      name: row.name, description: row.description, promptBody: row.prompt_body, enabled: row.enabled,
      trigger: row.trigger_spec, activeHours: row.active_hours, silenceToken: row.silence_token, silenceMaxChars: row.silence_max, conversation: row.conversation
    }),
    defaultRoutineId: row.default_routine_id, updatedAt: row.updated_at
  };
}
function parseReceipt(operation: string, value: unknown): unknown {
  if (operation === 'create' || operation === 'update') return parseStoredRoutine(value);
  if (operation === 'delete') return RoutineDeleteOutputSchema.parse(value);
  if (operation === 'dispatch') return AcceptedDispatchSchema.nullable().parse(value);
  if (operation === 'set-steps') return StepsReceiptSchema.parse(value);
  throw new Error('Unknown routine receipt operation');
}
/**
 * TASK-907. What a receipt keeps of its result: all of it but a task's state. A
 * receipt lives as long as its request row, and the state is agent-written text
 * (a report, the agent's notes) that the task row already holds, once, where a
 * person can see and clear it. TASK-930: the task's missed check-ins stay out
 * too. They're the task's, not the request's, and move on without it.
 * TASK-948: so do a get-done task's steps, beside the report and the misses:
 * agent- or person-written text the task row already holds, once.
 * TASK-951: so does a get-done task's finish date, not because it's agent text
 * (a person sets it) but for the reason that follows.
 * All four keys are left out, not stored as null or `[]`, so code from before
 * each field (whose strict schema has no such key) still reads the receipt
 * after a rollback; the schema's defaults fill them in on read. So an exact
 * replay answers with `task: null`, `noRecentUpdate: null`, `steps: []` and
 * `finishBy: null`: a replay answers from its receipt, never from a fresh read.
 * The live answer is the effect's own, state and all, so `acceptDispatch`'s
 * `accepted.row` still holds the task's state, misses, steps and finish date as
 * it read them under the row lock. A replayed accept starts no run (the tick
 * and the webhook mint a request per dispatch, and every caller skips
 * `replayed`), so no run reads a receipt's row.
 * TASK-949: `set-steps`' result is its count alone (`{ skipped }`), stored as
 * it is. Its steps leave `setSteps` beside the receipt, never through it, and a
 * replay reads them again under the routine's row lock.
 */
function receiptCopy(operation: string, result: unknown): unknown {
  if (operation === 'create' || operation === 'update') return withoutTaskState(result as StoredRoutine);
  if (operation === 'dispatch') {
    const accepted = result as AcceptedDispatch;
    return { ...accepted, row: withoutTaskState(accepted.row) };
  }
  return result;
}
function withoutTaskState({ task: _task, noRecentUpdate: _misses, steps: _steps, finishBy: _finishBy, ...routine }: StoredRoutine): Omit<StoredRoutine, 'task' | 'noRecentUpdate' | 'steps' | 'finishBy'> { return routine; }
function receiptQuery(db: DB, key: OperationKey) {
  return db.selectFrom('routines_v1_requests').selectAll().where('agent_id', '=', key.agentId)
    .where('owner_user_id', '=', key.actorUserId).where('operation', '=', key.operation).where('request_id', '=', key.requestId);
}
/** Shared lifecycle fence allows routine concurrency; purge uses the same key exclusively.
 * The durable tombstone prevents a request authorized before deletion from recreating data.
 */
async function lockLiveAgent(db: DB, agentId: string): Promise<boolean> {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${agentId}, 18427132))`.execute(db);
  return !await db.selectFrom('routines_v1_retired_agents').select('agent_id').where('agent_id', '=', agentId).executeTakeFirst();
}
/** Routines-owned default controls fence. Dispatch and materialization read under
 * a shared lock; catalog and override writers hold it exclusively through commit.
 * Order: agent lifecycle fence (when present) → default controls → receipts/rows.
 * Catalog/refresh never acquire an agent fence after taking this lock. A single
 * catalog fence deliberately favors simple stop semantics over parallel writers.
 */
async function lockDefaultControls(db: DB, write = false): Promise<void> {
  if (write) await sql`SELECT pg_advisory_xact_lock(18427133)`.execute(db);
  else await sql`SELECT pg_advisory_xact_lock_shared(18427133)`.execute(db);
}
/**
 * Runs `effect` once per request: the agent fence, then the request's row,
 * locked, then the effect, whose result settles the receipt (`receiptCopy`).
 * The same request again answers from the receipt; other input under the same
 * id is a `request-conflict`. `onReplay` runs on that replay, in the
 * transaction, after the request row's lock: `setSteps` (TASK-949) reads the
 * steps again under the routine's row lock there, so a replay answers them as
 * they are now. A throw from the effect rolls the request's row back with
 * everything else, so a refusal keeps no receipt; one from `onReplay` leaves
 * the receipt as it was.
 */
async function receiptTransaction<T>(db: DB, key: OperationKey, effect: (trx: Transaction<RoutinesDatabase>) => Promise<T>, onReplay?: (trx: Transaction<RoutinesDatabase>) => Promise<void>): Promise<T> {
  try {
    return await db.transaction().execute(async trx => {
      if (!await lockLiveAgent(trx, key.agentId)) throw new SafeToolError('not-found', 'routineId');
      if (key.operation === 'dispatch') await lockDefaultControls(trx);
      await trx.insertInto('routines_v1_requests').values({
        agent_id: key.agentId, owner_user_id: key.actorUserId, operation: key.operation,
        request_id: key.requestId, input_hash: key.inputHash, result: null, routine_id: null
      }).onConflict(oc => oc.doNothing()).execute();
      const receipt = await receiptQuery(trx, key).forUpdate().executeTakeFirstOrThrow();
      if (receipt.input_hash !== key.inputHash) throw new SafeToolError('request-conflict', 'requestId');
      if (receipt.result !== null) { await onReplay?.(trx); return parseReceipt(key.operation, receipt.result) as T; }
      const result = await effect(trx);
      // SQL NULL means pending; JSON null is not used as a settled dispatch receipt.
      if (result === null) { await trx.deleteFrom('routines_v1_requests').where('agent_id', '=', key.agentId).where('owner_user_id', '=', key.actorUserId).where('operation', '=', key.operation).where('request_id', '=', key.requestId).execute(); return result; }
      await trx.updateTable('routines_v1_requests').set({ result: JSON.stringify(receiptCopy(key.operation, result)) }).where('agent_id', '=', key.agentId)
        .where('owner_user_id', '=', key.actorUserId).where('operation', '=', key.operation).where('request_id', '=', key.requestId).execute();
      return parseReceipt(key.operation, result) as T;
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'routines_v1_webhook_path_unique') throw new SafeToolError('webhook-path-conflict', 'trigger.path');
    throw error;
  }
}
/** TASK-907. fire.ts records this as the fire's error when the bind fails. */
export const RUN_CLOSED = 'The routine run closed before it could start.';
/**
 * A run's stored report, for its fire row. SQL NULL (or a JSON null) is no
 * report. Anything else the schema refuses is unreadable and also becomes no
 * report: `interruptAbandonedDispatches` finishes runs during plugin init, so a
 * throw here would stop the host booting.
 */
function storedReport(value: unknown): { report: DispatchReport | null; unreadable: boolean } {
  if (value === null || value === undefined) return { report: null, unreadable: false };
  const parsed = DispatchReportSchema.safeParse(value);
  return parsed.success ? { report: parsed.data, unreadable: false } : { report: null, unreadable: true };
}
/** A refused write's SQLSTATE, or null when its error carries none: the one field of it a scrubbed error keeps. */
function sqlState(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
}
/**
 * A refused write can quote what it was sent (Postgres puts it in the error's
 * `where` or `detail`), and a report's text is the agent's. Keep only the run's
 * id and the SQLSTATE, and drop the original error.
 */
function reportWriteError(dispatchId: string, error: unknown): Error {
  const code = sqlState(error);
  return new Error(`Could not save the report for dispatch ${dispatchId}${code === null ? '' : ` (SQLSTATE ${code})`}.`);
}
/** TASK-949. `reportWriteError`'s rule for a person's step changes, whose text is theirs: only the routine's id and the SQLSTATE. */
function stepsWriteError(routineId: string, error: unknown): Error {
  const code = sqlState(error);
  return new Error(`Could not save the steps for routine ${routineId}${code === null ? '' : ` (SQLSTATE ${code})`}.`);
}
/**
 * TASK-949. Why `setSteps` changed nothing. Thrown inside its receipt's
 * transaction, never returned from it, so the request's row rolls back with it:
 * `receiptTransaction` stores whatever its effect returns as a settled receipt.
 */
class StepsRefused extends Error {
  constructor(readonly reason: 'not-found' | 'forbidden') { super(reason); }
}
function operationKey(input: RoutineKey & Actor & { requestId: string }, operation: string, hash: string): OperationKey {
  return { agentId: input.agentId, actorUserId: input.actorUserId, operation, requestId: input.requestId, inputHash: hash };
}
async function lockRoutine(db: DB, input: RoutineKey & { expectedRevision: string }): Promise<StoredRoutine> {
  const row = await db.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
  if (!row) throw new SafeToolError('not-found', 'routineId');
  if (row.revision !== input.expectedRevision) throw new SafeToolError('revision-conflict', 'expectedRevision');
  return rowToRoutine(row);
}
async function assertNoCleanup(db: DB, key: RoutineKey): Promise<void> {
  const job = await db.selectFrom('routines_v1_credential_cleanup').select('credential_ref').where('agent_id', '=', key.agentId).where('credential_ref', '=', credentialRef(key)).forUpdate().executeTakeFirst();
  if (job) throw new SafeToolError('cleanup-pending', 'trigger.hmac');
}
async function queueCleanup(db: DB, row: StoredRoutine): Promise<void> {
  if (!hasHmac(row)) return;
  await db.insertInto('routines_v1_credential_cleanup').values({
    agent_id: row.agentId, routine_id: row.routineId,
    credential_ref: credentialRef(row), owner_user_id: row.ownerUserId
  }).onConflict(oc => oc.doNothing()).execute();
}
function jobFromRow(r: { agent_id: string; routine_id: string; credential_ref: string; owner_user_id: string }): CleanupJob {
  return { agentId: r.agent_id, routineId: r.routine_id, credentialRef: r.credential_ref, ownerUserId: r.owner_user_id };
}
/**
 * Credential callbacks must confirm actual effect settlement or cancellation before
 * resolving or rejecting, so their locks remain held while side effects can occur.
 * HookBus.call timeouts do not cancel handlers and cannot provide this guarantee.
 * No transaction handle crosses the callback boundary.
 */
export function createRoutinesStore(db: DB): RoutinesStore {
  return {
    async createAuthored(input) {
      const definition = validateDefinition(input.definition);
      return receiptTransaction(db, {
        agentId: input.agentId, actorUserId: input.actorUserId, operation: 'create', requestId: input.requestId,
        inputHash: createRequestHash(input)
      }, async trx => {
        const row = await trx.insertInto('routines_v1_definitions').values({
          ...definitionColumns(definition), agent_id: input.agentId,
          routine_id: opaqueId('rtn'), revision: opaqueId('rev'), owner_user_id: input.ownerUserId, next_run_at: nextRun(definition, input.now),
          last_run_at: null, last_status: null, last_error: null, definition_id: null, definition_updated_at: null, created_at: input.now, updated_at: input.now
        }).returningAll().executeTakeFirstOrThrow();
        return rowToRoutine(row);
      });
    },
    async updateAuthored(input) {
      if (input.stopOnly && (Object.keys(input.patch).length !== 1 || input.patch.enabled !== false)) throw new SafeToolError('forbidden', 'input');
      return receiptTransaction(db, operationKey(input, 'update', updateRequestHash(input)), async trx => {
        const current = await lockRoutine(trx, input);
        if (current.definitionId !== null) throw new SafeToolError('forbidden', 'routineId');
        let next: RoutineDefinition;
        try { next = applyRoutinePatch(editableDefinition(current), input.patch); } catch (error) { throw validationError(error); }
        if (hasHmac(next)) await assertNoCleanup(trx, current);
        if (hasHmac(current) && !hasHmac(next)) await queueCleanup(trx, current);
        const row = await trx.updateTable('routines_v1_definitions').set({
          ...definitionColumns(next), revision: opaqueId('rev'), updated_at: input.now,
          next_run_at: schedulingChanged(current, next) ? nextRun(next, input.now) : current.nextRunAt,
          ...(next.kind === current.kind ? {} : { ...NO_TASK_STATE, ...NO_FINISH_BY }),
          // TASK-930: a Resume starts the count over, whoever paused the task. No other edit does:
          // shortening instructions that were too long leaves the task paused, and counted.
          ...(!current.enabled && next.enabled ? NO_MISSES : {}),
        })
          .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).returningAll().executeTakeFirstOrThrow();
        return rowToRoutine(row);
      });
    },
    async deleteAuthored(input) {
      return receiptTransaction(db, operationKey(input, 'delete', deleteRequestHash(input)), async trx => {
        const current = await lockRoutine(trx, input);
        if (current.definitionId !== null) throw new SafeToolError('forbidden', 'routineId');
        await queueCleanup(trx, current);
        const pending = await trx.selectFrom('routines_v1_credential_cleanup').select('credential_ref').where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).executeTakeFirst();
        // TASK-931: after the row lock, so a reply that took it first is in by now, and one still
        // waiting on it finds no routine (addReply).
        await trx.deleteFrom('routines_v1_replies').where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).execute();
        await trx.deleteFrom('routines_v1_definitions').where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).execute();
        return { deleted: true as const, cleanupPending: pending !== undefined };
      });
    },
    async findOperationReceipt(key) {
      const row = await receiptQuery(db, key).executeTakeFirst();
      if (!row) return null;
      if (row.input_hash !== key.inputHash) throw new SafeToolError('request-conflict', 'requestId');
      return row.result === null ? null : parseReceipt(key.operation, row.result);
    },
    async findWebhook(input) {
      const row = await db.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', input.agentId).where('trigger_kind', '=', 'webhook')
        .where(sql<string>`trigger_spec->>'path'`, '=', input.path).executeTakeFirst();
      return row ? rowToRoutine(row) : null;
    },
    async acceptDispatch(input) {
      let replayed = false;
      const accepted = await receiptTransaction(db, operationKey(input, 'dispatch', dispatchRequestHash(input)), async trx => {
        const raw = await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
        if (!raw || raw.revision !== input.expectedRevision || !raw.enabled) return null;
        if (raw.definition_id !== null) {
          const source = await trx.selectFrom('default_routines_v1').selectAll().where('default_routine_id', '=', raw.definition_id).executeTakeFirst();
          if (!source?.enabled || !raw.definition_updated_at || raw.definition_updated_at < source.updated_at) return null;
          const shadow = await trx.selectFrom('routines_v1_definitions').select('routine_id').where('agent_id', '=', input.agentId).where('definition_id', 'is', null).where('name', '=', raw.name).executeTakeFirst();
          if (shadow) return null;
          const override = await trx.selectFrom('agent_default_routine_overrides_v1').select('enabled').where('agent_id', '=', input.agentId).where('default_routine_id', '=', raw.definition_id).executeTakeFirst();
          if (override?.enabled === false) return null;
        }
        const result: AcceptedDispatch = { dispatchId: opaqueId('dispatch'), reqId: opaqueId('routine_run'), row: rowToRoutine(raw), source: input.source, acceptedAt: input.now };
        await trx.insertInto('routines_v1_dispatches').values({
          dispatch_id: result.dispatchId, agent_id: input.agentId, routine_id: input.routineId,
          revision: raw.revision, req_id: result.reqId, accepted_at: input.now, completed_at: null, trigger_source: input.source,
          // TASK-936: who the run runs as, the owner read under this row lock (fire.ts runs as
          // accepted.row.ownerUserId), never the actor who asked for it. Nothing moves it later.
          run_as_user_id: raw.owner_user_id,
        }).execute();
        return result;
      }, async () => { replayed = true; });
      return accepted === null ? null : { accepted, replayed };
    },
    async interruptAbandonedDispatches() {
      // Startup only, before any new dispatch accepts work in this single-host runtime.
      const rows = await db.selectFrom('routines_v1_dispatches').select('dispatch_id').where('completed_at', 'is', null).execute();
      let interrupted = 0;
      for (const row of rows) if (await this.finishDispatch({ dispatchId: row.dispatch_id, outcome: {
        status: 'error', error: 'The routine run was interrupted by a host restart.',
        conversationId: null, renderedPrompt: null, warning: null, miss: 'interrupted',
      } })) interrupted++;
      return interrupted;
    },
    async getDispatchOutcome(input) {
      const row = await db.selectFrom('routines_v1_fires').selectAll()
        .where('agent_id', '=', input.agentId).where('dispatch_id', '=', input.dispatchId).executeTakeFirst();
      return row ? DispatchOutcomeSchema.parse({ status: row.status, conversationId: row.conversation_id,
        error: row.error, renderedPrompt: row.rendered_prompt, warning: row.warning }) : null;
    },
    async finishDispatch(input) {
      const outcome = DispatchOutcomeSchema.parse(input.outcome);
      let unreadable = false;
      let paused = null as (RoutineKey & { keptHash: boolean }) | null;
      const finished = await db.transaction().execute(async trx => {
        const candidate = await trx.selectFrom('routines_v1_dispatches').select('agent_id').where('dispatch_id', '=', input.dispatchId).executeTakeFirst();
        if (!candidate || !await lockLiveAgent(trx, candidate.agent_id)) return false;
        const dispatch = await trx.selectFrom('routines_v1_dispatches').selectAll().where('dispatch_id', '=', input.dispatchId).forUpdate().executeTakeFirst();
        if (!dispatch || dispatch.completed_at) return false;
        // TASK-930: the routine's row, locked before anything here writes to it, so two runs that
        // finish at once count one after the other. recordReport's order (agent fence, dispatch row,
        // definition row), and nothing locks a dispatch row after a definition row, so it adds no
        // deadlock. A deleted routine has no row, and its run isn't counted.
        const definition = await trx.selectFrom('routines_v1_definitions').selectAll()
          .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).forUpdate().executeTakeFirst();
        const stored = storedReport(dispatch.report);
        unreadable = stored.unreadable;
        // TASK-952: a reading goes with its report, so only beside one this code could read, and
        // through the same rule as every read.
        const reading = stored.report === null ? null : readingOf(dispatch.report_reading_value, dispatch.report_reading_label);
        const finishedAt = new Date();
        await trx.insertInto('routines_v1_fires').values({
          agent_id: dispatch.agent_id, routine_id: dispatch.routine_id, dispatch_id: dispatch.dispatch_id,
          fired_at: dispatch.accepted_at, trigger_source: dispatch.trigger_source, conversation_id: outcome.conversationId, status: outcome.status,
          error: outcome.error, rendered_prompt: outcome.renderedPrompt === null ? null : truncateUtf8(outcome.renderedPrompt, 65536), warning: outcome.warning,
          report_status: stored.report?.status ?? null, report_update: stored.report?.update ?? null, report_ask: stored.report?.ask ?? null,
          report_reading_value: reading?.value ?? null, report_reading_label: reading?.label ?? null,
          // TASK-936: copied from the dispatch, not read from the routine, which may have moved since the accept.
          run_as_user_id: dispatch.run_as_user_id,
        }).execute();
        // The fire row has the report and its reading now; one copy of the text is enough (TASK-907).
        await trx.updateTable('routines_v1_dispatches').set({ completed_at: finishedAt, report: null, report_reading_value: null, report_reading_label: null })
          .where('dispatch_id', '=', input.dispatchId).execute();
        await trx.updateTable('routines_v1_definitions').set({ last_run_at: dispatch.accepted_at, last_status: outcome.status, last_error: outcome.error, last_warning: outcome.warning })
          .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).where('revision', '=', dispatch.revision)
          .where(eb => eb.or([eb('last_run_at', 'is', null), eb('last_run_at', '<=', dispatch.accepted_at)])).execute();
        // TASK-930: the missed check-ins, only now. The pause mints a new revision, so before the
        // update above it would make that update skip the fifth run's own status and error. No
        // revision clause here: an edit during a check-in can't drop its miss, as it can't its report.
        // TASK-936: none for a run that ran as someone who no longer owns the routine. Like its refused
        // report, it can't touch the new owner's task. A run with no record of who it ran as (accepted
        // by code from before version 9) counts as before.
        const ranAsAnother = definition !== undefined && dispatch.run_as_user_id !== null && dispatch.run_as_user_id !== definition.owner_user_id;
        const misses = definition === undefined || ranAsAnother ? null : await missesAfterRun(trx, definition, {
          reported: stored.report !== null, status: outcome.status, miss: outcome.miss, acceptedAt: dispatch.accepted_at,
        }, finishedAt);
        if (misses !== null) {
          await trx.updateTable('routines_v1_definitions').set(misses.columns)
            .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).execute();
          if (misses.paused) paused = { agentId: dispatch.agent_id, routineId: dispatch.routine_id, keptHash: misses.keptHash };
        }
        return true;
      });
      // After commit, so a rolled-back finish doesn't claim a drop. Only the id: the text is the agent's.
      if (finished && unreadable) process.stderr.write(`[ax/routines] dropped an unreadable report for dispatch ${input.dispatchId}\n`);
      // After commit too, so a rolled-back finish paused nothing. Ids only: why a definition no longer
      // reads is in its stored text, which can be the agent's.
      if (finished && paused !== null) {
        process.stderr.write(`[ax/routines] auto-paused task ${paused.agentId}/${paused.routineId} after ${TASK_AUTO_PAUSE_AFTER_MISSES} check-ins without a report\n`);
        if (paused.keptHash) process.stderr.write(`[ax/routines] auto-paused task ${paused.agentId}/${paused.routineId} kept its stored definition hash: its definition no longer reads\n`);
      }
      return finished;
    },
    async bindDispatchConversation(input) {
      await db.transaction().execute(async trx => {
        const candidate = await trx.selectFrom('routines_v1_dispatches').select('agent_id').where('dispatch_id', '=', input.dispatchId).executeTakeFirst();
        if (!candidate || !await lockLiveAgent(trx, candidate.agent_id)) throw new Error(RUN_CLOSED);
        // Once bound, a run stays in its conversation.
        const bound = await trx.updateTable('routines_v1_dispatches').set({ conversation_id: input.conversationId })
          .where('dispatch_id', '=', input.dispatchId).where('agent_id', '=', candidate.agent_id).where('completed_at', 'is', null)
          .where(eb => eb.or([eb('conversation_id', 'is', null), eb('conversation_id', '=', input.conversationId)]))
          .executeTakeFirst();
        if (bound.numUpdatedRows !== 1n) throw new Error(RUN_CLOSED);
      });
    },
    async findOpenDispatchByConversation(input) {
      // A left join: a run whose routine was deleted is still an open run in
      // this conversation, so it still makes the conversation ambiguous.
      const rows = await db.selectFrom('routines_v1_dispatches as d')
        .leftJoin('routines_v1_definitions as r', join => join.onRef('r.agent_id', '=', 'd.agent_id').onRef('r.routine_id', '=', 'd.routine_id'))
        .select(['d.dispatch_id', 'd.routine_id', 'r.kind', 'r.owner_user_id'])
        .where('d.agent_id', '=', input.agentId).where('d.conversation_id', '=', input.conversationId).where('d.completed_at', 'is', null)
        .limit(2).execute();
      const [row] = rows;
      if (row === undefined) return { run: null, reason: 'no-open-run' };
      if (rows.length > 1) return { run: null, reason: 'ambiguous' };
      if (row.kind === null || row.owner_user_id === null) return { run: null, reason: 'routine-gone' };
      return { run: { dispatchId: row.dispatch_id, routineId: row.routine_id, kind: row.kind, ownerUserId: row.owner_user_id } };
    },
    async isTaskConversation(input) {
      // A left join: a run whose routine was deleted still counts (`kind` is
      // null), the safe direction for memory capture. Memory asks this for
      // every capture pass, ordinary chats included, so it reads through
      // version 5's `routines_v1_dispatches_conversation` index.
      return (await taskConversationQuery(db, input).executeTakeFirst()) !== undefined;
    },
    async tasksForConversations(input) {
      const conversationIds = [...new Set(input.conversationIds)];
      if (conversationIds.length === 0) return [];
      const { rows } = await tasksForConversationsQuery({ ...input, conversationIds }).execute(db);
      // Columns, not rowToRoutine: a definition another read can't parse still names its check-in. An
      // entry the contract refuses (a name a later rule turned away, a hand edit) costs only its own
      // label, where the hook's return check would fail the whole answer (TASK-913).
      return rows.flatMap(row => {
        const view = { conversationId: row.conversation_id, routineId: row.routine_id, name: row.name };
        return RoutineCheckInViewSchema.safeParse(view).success ? [view] : [];
      });
    },
    async recordReport(input) {
      return db.transaction().execute(async (trx): Promise<'recorded' | RecordedSteps | ReportRefusal> => {
        // finishDispatch's order (agent fence, dispatch row, definition row), so the two serialize.
        if (!await lockLiveAgent(trx, input.agentId)) return 'agent-retired';
        const dispatch = await trx.selectFrom('routines_v1_dispatches').select(['dispatch_id', 'agent_id', 'routine_id', 'accepted_at', 'completed_at', 'conversation_id'])
          .where('dispatch_id', '=', input.dispatchId).where('agent_id', '=', input.agentId).forUpdate().executeTakeFirst();
        // The whole binding, under the run's row lock: open, and bound to the conversation the report came from.
        // Compared here rather than in the WHERE, so a refusal can say which of the two it was (TASK-907).
        if (!dispatch || dispatch.completed_at !== null) return 'run-closed';
        if (dispatch.conversation_id !== input.conversationId) return 'not-bound';
        const definition = await trx.selectFrom('routines_v1_definitions').select(['kind', 'owner_user_id', 'agent_notes_cleared_at', 'task_steps'])
          .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).forUpdate().executeTakeFirst();
        if (!definition) return 'routine-gone';
        // An explicit allowlist (TASK-948): a write path refuses a kind it doesn't know.
        if (!isTaskKind(definition.kind)) return 'kind';
        if (definition.owner_user_id !== input.actorUserId) return 'owner';
        const { status, update, ask } = input.report;
        // TASK-952: left out or null, this report has no reading, so the task's latest has none either.
        const reading = input.reading ?? null;
        // TASK-910: a run accepted at or before the person last cleared the notes read the notes
        // they cleared, so it can't write any back. The rest of its report lands as usual.
        const clearedAt = definition.agent_notes_cleared_at;
        const writesNotes = input.notes !== undefined && (clearedAt === null || clearedAt.getTime() < dispatch.accepted_at.getTime());
        // TASK-948: the report's step changes, applied as the agent to the checklist as read under the row
        // lock, so reports that overlap compose: one waiting on the lock re-reads the list the other just
        // wrote. A task that is no longer get-done (a kind change landed after the tool checked the kind)
        // skips them all, writes no checklist, and its report still lands.
        const changes = input.steps === undefined ? null
          : definition.kind === 'get-done' ? changeStoredSteps(definition.task_steps, input.steps, 'agent')
          : { steps: [], applied: 0, skipped: input.steps.length, write: null };
        try {
          // A later report in the same check-in replaces this one, reading and all. The JSON keeps
          // its three keys: the reading has columns of its own (card decision 4).
          await trx.updateTable('routines_v1_dispatches').set({
            report: JSON.stringify({ status, update, ask }),
            report_reading_value: reading?.value ?? null, report_reading_label: reading?.label ?? null,
          }).where('dispatch_id', '=', dispatch.dispatch_id).execute();
          // The run accepted last owns the task's state, whatever order the runs report in. There's
          // no revision clause, so an edit during the check-in can't drop its report, and the state
          // never moves revision, spec_hash or updated_at. TASK-952: the reading is stamped with its
          // report's time, which is what lets a read show it (taskState).
          await trx.updateTable('routines_v1_definitions').set({
            task_status: status, task_update: update, task_ask: ask,
            task_reported_at: input.now, task_report_accepted_at: dispatch.accepted_at,
            task_reading_value: reading?.value ?? null, task_reading_label: reading?.label ?? null,
            task_reading_reported_at: reading === null ? null : input.now,
            ...(writesNotes ? { agent_notes: input.notes } : {}),
          }).where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id)
            .where(eb => eb.or([eb('task_report_accepted_at', 'is', null), eb('task_report_accepted_at', '<=', dispatch.accepted_at)])).execute();
          // A step change is an edit by id, not a snapshot like the status, so there's no accepted-at
          // clause: an older overlapping run's ticks still land. Like the state, the checklist never
          // moves revision, spec_hash or updated_at. TASK-949: the write keeps the stored entries this
          // version can't read (changeStoredSteps).
          if (changes !== null && changes.write !== null) {
            await trx.updateTable('routines_v1_definitions').set({ task_steps: JSON.stringify(changes.write) })
              .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).execute();
          }
        } catch (error) {
          throw reportWriteError(dispatch.dispatch_id, error);
        }
        return changes === null ? 'recorded' : { outcome: 'recorded', applied: changes.applied, skipped: changes.skipped };
      });
    },
    async clearAgentNotes(input) {
      return db.transaction().execute(async trx => {
        // The agent fence, then the definition row. The open runs are read without a lock, so this
        // can't deadlock with recordReport (fence, dispatch row, definition row): a report waiting
        // on this row re-reads it once the clear commits, and sees the new stamp.
        if (!await lockLiveAgent(trx, input.agentId)) return 'not-found';
        const row = await trx.selectFrom('routines_v1_definitions').select('owner_user_id')
          .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
        if (!row) return 'not-found';
        if (row.owner_user_id !== input.actorUserId) return 'forbidden';
        // Never earlier than the start of any run still open, whatever this host's clock says. A run
        // reads the notes when acceptDispatch takes this row lock, so every run that read the old
        // notes is either still open, and counted here, or finished, and can't report any more
        // (migrations.ts, addNotesClearedColumn). No other column moves.
        await trx.updateTable('routines_v1_definitions').set({
          agent_notes: null,
          agent_notes_cleared_at: sql<Date>`GREATEST(${input.now}::timestamptz, (
            SELECT max(accepted_at) FROM routines_v1_dispatches
             WHERE agent_id = ${input.agentId} AND routine_id = ${input.routineId} AND completed_at IS NULL))`,
        }).where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).execute();
        return 'cleared';
      });
    },
    async setFinishBy(input) {
      return db.transaction().execute(async (trx): Promise<{ finishBy: string | null } | 'not-found' | 'forbidden'> => {
        // clearAgentNotes' order: the agent fence, then the routine's row. acceptDispatch and recordReport
        // take the two in that order too, so this adds no deadlock.
        if (!await lockLiveAgent(trx, input.agentId)) return 'not-found';
        const row = await trx.selectFrom('routines_v1_definitions').select(['kind', 'owner_user_id'])
          .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
        // An explicit allowlist: only a get-done task has a finish date, so a kind this code doesn't know gets none.
        // Read under the row lock, so a change of kind that commits while this waits is seen here.
        if (!row || row.kind !== 'get-done') return 'not-found';
        if (row.owner_user_id !== input.actorUserId) return 'forbidden';
        // The date alone: no revision, spec_hash or updated_at, so an edit, Check now or Pause held against the
        // current revision still lands. No receipt either: the same date set twice is the same write.
        await trx.updateTable('routines_v1_definitions').set({ finish_by: input.finishBy })
          .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).execute();
        return { finishBy: input.finishBy };
      });
    },
    async addReply(input) {
      return db.transaction().execute(async (trx): Promise<AddReplyResult> => {
        // clearAgentNotes' order: the agent fence, then the routine's row. acceptDispatch and
        // recordReport take the two in that order too, so this adds no deadlock.
        if (!await lockLiveAgent(trx, input.agentId)) return 'not-found';
        const raw = await trx.selectFrom('routines_v1_definitions').selectAll()
          .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
        // `repeat`, not "anything but stay-on-top", so a later task kind takes replies with no change here.
        if (!raw || raw.kind === 'repeat') return 'not-found';
        if (raw.owner_user_id !== input.actorUserId) return 'forbidden';
        const row = rowToRoutine(raw);
        const added = await trx.insertInto('routines_v1_replies').values({
          reply_id: opaqueId('reply'), agent_id: input.agentId, routine_id: input.routineId, author_user_id: input.actorUserId,
          request_id: input.requestId, body: input.text, created_at: input.now,
        }).onConflict(oc => oc.columns(['agent_id', 'routine_id', 'author_user_id', 'request_id']).doNothing())
          .returning('reply_id').executeTakeFirst();
        if (added !== undefined) return { outcome: 'added', replyId: added.reply_id, row };
        // A retry: the first try's reply stands, text and all.
        const first = await trx.selectFrom('routines_v1_replies').select('reply_id')
          .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId)
          .where('author_user_id', '=', input.actorUserId).where('request_id', '=', input.requestId).executeTakeFirstOrThrow();
        return { outcome: 'replayed', replyId: first.reply_id, row };
      });
    },
    async setSteps(input) {
      // Inside receiptTransaction, so after the agent fence and the request's row: acceptDispatch's and
      // updateAuthored's order. recordReport takes the fence, the run's row, then this row, and nothing locks a
      // request row after a routine's, so this adds no deadlock.
      const locked = async (trx: Transaction<RoutinesDatabase>) => {
        const row = await trx.selectFrom('routines_v1_definitions').select(['kind', 'owner_user_id', 'task_steps'])
          .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
        // An explicit allowlist (TASK-948): only a get-done task has steps.
        if (!row || row.kind !== 'get-done') throw new StepsRefused('not-found');
        if (row.owner_user_id !== input.actorUserId) throw new StepsRefused('forbidden');
        return row;
      };
      // The steps leave through here, never through the receipt, and so does whether this was a replay.
      let steps: StoredStep[] = [];
      let replayed = false;
      try {
        const key = operationKey(input, 'set-steps', inputHash({ agentId: input.agentId, routineId: input.routineId, ops: input.ops }));
        const { skipped } = await receiptTransaction(db, key, async trx => {
          const changes = changeStoredSteps((await locked(trx)).task_steps, input.ops, 'person');
          if (changes.write !== null) {
            try {
              // A report's rule (recordReport): no revision, spec_hash or updated_at, since the steps are task
              // state, so a change can't turn the page's next Check now into a revision conflict.
              await trx.updateTable('routines_v1_definitions').set({ task_steps: JSON.stringify(changes.write) })
                .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).execute();
            } catch (error) {
              throw stepsWriteError(input.routineId, error);
            }
          }
          steps = changes.steps;
          // All the receipt keeps (receiptCopy, parseReceipt).
          return { skipped: changes.skipped };
        }, async trx => {
          // A replay: the owner checked again, and the steps as they are now, beside the first try's count.
          steps = storedSteps((await locked(trx)).task_steps);
          replayed = true;
        });
        return { steps, skipped, replayed };
      } catch (error) {
        if (error instanceof StepsRefused) return error.reason;
        throw error;
      }
    },
    async advance(input) {
      await db.updateTable('routines_v1_definitions').set({ next_run_at: input.nextRunAt, last_run_at: input.lastRunAt })
        .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).where('revision', '=', input.expectedRevision).execute();
    },
    async withLockedWebhookSecret(input, effect) {
      return db.transaction().execute(async trx => {
        const row = await lockRoutine(trx, input);
        await assertNoCleanup(trx, row);
        if (!hasHmac(row)) throw new SafeToolError('validation', 'trigger.hmac');
        await effect();
        return { saved: true as const };
      });
    },
    async pendingCleanup(input) {
      return (await db.selectFrom('routines_v1_credential_cleanup').selectAll().orderBy('created_at').limit(Math.max(1, Math.min(input.limit, 200))).execute()).map(jobFromRow);
    },
    async runCredentialCleanup(key, effect) {
      return db.transaction().execute(async trx => {
        // Discovery is not authority. Lock the definition first, then re-read the current job.
        const candidate = await trx.selectFrom('routines_v1_credential_cleanup').select('routine_id').where('agent_id', '=', key.agentId).where('credential_ref', '=', key.credentialRef).executeTakeFirst();
        if (!candidate) return false;
        await trx.selectFrom('routines_v1_definitions').select('routine_id').where('agent_id', '=', key.agentId).where('routine_id', '=', candidate.routine_id).forUpdate().execute();
        const job = await trx.selectFrom('routines_v1_credential_cleanup').selectAll().where('agent_id', '=', key.agentId).where('credential_ref', '=', key.credentialRef).forUpdate().executeTakeFirst();
        if (!job) return false;
        await effect(jobFromRow(job));
        await trx.deleteFrom('routines_v1_credential_cleanup').where('agent_id', '=', key.agentId).where('credential_ref', '=', key.credentialRef).execute();
        return true;
      });
    },
    async purgeAgent(agentId) {
      await db.transaction().execute(async trx => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${agentId}, 18427132))`.execute(trx);
        await trx.insertInto('routines_v1_retired_agents').values({ agent_id: agentId }).onConflict(oc => oc.doNothing()).execute();
        // Dispatch first matches finishDispatch's order and prevents late history resurrection.
        await trx.deleteFrom('routines_v1_dispatches').where('agent_id', '=', agentId).execute();
        const rows = await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', agentId).forUpdate().execute();
        for (const row of rows) await queueCleanup(trx, rowToRoutine(row));
        // TASK-931. The exclusive fence above keeps addReply out until this commits.
        await trx.deleteFrom('routines_v1_replies').where('agent_id', '=', agentId).execute();
        await trx.deleteFrom('routines_v1_definitions').where('agent_id', '=', agentId).execute();
        await trx.deleteFrom('agent_default_routine_overrides_v1').where('agent_id', '=', agentId).execute();
        await trx.deleteFrom('routines_v1_fires').where('agent_id', '=', agentId).execute();
        await trx.deleteFrom('routines_v1_requests').where('agent_id', '=', agentId).execute();
      });
    },
    async claimDue(input) {
      const rows = await sql<Selectable<RoutinesDefinitionsRow>>`
        WITH workspace_due AS (
          SELECT agent_id, routine_id
            FROM routines_v1_definitions
           WHERE definition_id IS NULL AND enabled
             AND next_run_at IS NOT NULL
             AND next_run_at <= ${input.now}
             AND trigger_kind IN ('interval', 'cron')
           ORDER BY next_run_at ASC
           LIMIT ${input.limit}
           FOR UPDATE SKIP LOCKED
        ),
        default_due AS (
          SELECT r.agent_id, r.routine_id
            FROM routines_v1_definitions r
            JOIN default_routines_v1 d ON d.default_routine_id = r.definition_id
           WHERE r.definition_id IS NOT NULL
             AND d.enabled AND r.enabled
             AND NOT EXISTS (SELECT 1 FROM agent_default_routine_overrides_v1 o WHERE o.agent_id=r.agent_id AND o.default_routine_id=r.definition_id AND NOT o.enabled)
             AND d.trigger_kind = 'interval'
             AND r.definition_updated_at IS NOT NULL
             AND r.definition_updated_at >= d.updated_at
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
           FOR UPDATE OF r SKIP LOCKED
        ),
        due AS (
          SELECT agent_id, routine_id FROM workspace_due
          UNION ALL
          SELECT agent_id, routine_id FROM default_due
          -- total cap across both branches; per-branch LIMITs bound lock acquisition
          LIMIT ${input.limit}
        )
        UPDATE routines_v1_definitions r
           SET next_run_at = CASE
             WHEN r.definition_id IS NULL
               THEN r.next_run_at + (${input.claimWindowMinutes} || ' minutes')::interval
             ELSE r.next_run_at
           END
          FROM due
         WHERE r.agent_id = due.agent_id AND r.routine_id = due.routine_id
        RETURNING r.*
      `.execute(db);
      return rows.rows.map(rowToRoutine);
    },

    async recentFires(input) {
      const limit = Math.min(200, Math.max(1, input.limit ?? 20));
      const rows = await historyQuery(db)
        .where('f.agent_id', '=', input.agentId)
        .where('f.routine_id', '=', input.routineId)
        .orderBy('f.fired_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(rowToFire);
    },

    async recentFiresForAgent(input) {
      const limit = Math.min(200, Math.max(1, input.limit ?? 20));
      let q = historyQuery(db).where('f.agent_id', '=', input.agentId);
      if (input.before !== undefined) q = q.where('f.fired_at', '<', input.before);
      const rows = await q
        .orderBy('f.fired_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(rowToFire);
    },

    async recentReports(input) {
      const limit = Math.min(10, Math.max(1, input.limit));
      // recentReplies' rule (TASK-936): the join keeps a run only while the person it ran as owns its
      // routine, and the reader must be that person. A routine that's gone keeps none. Filtered before
      // the limit, so another person's newer reports can't crowd the reader's out. Every column is
      // qualified: agent_id and routine_id are on both tables, and Postgres refuses a bare one (42702).
      const rows = await db
        .selectFrom('routines_v1_fires as f')
        .innerJoin('routines_v1_definitions as r', join => join
          .onRef('r.agent_id', '=', 'f.agent_id')
          .onRef('r.routine_id', '=', 'f.routine_id')
          .onRef('r.owner_user_id', '=', 'f.run_as_user_id'))
        .select(['f.fired_at', 'f.report_status', 'f.report_update', 'f.report_ask', 'f.report_reading_value', 'f.report_reading_label'])
        .where('f.agent_id', '=', input.agentId)
        .where('f.routine_id', '=', input.routineId)
        .where('f.run_as_user_id', '=', input.actorUserId)
        .where('f.report_status', 'is not', null)
        .where('f.report_update', 'is not', null)
        .orderBy('f.fired_at', 'desc')
        .orderBy('f.id', 'desc')
        .limit(limit)
        .execute();
      // The query already skips a row with only part of a report (rowToFire's rule); this narrows the types.
      return rows.flatMap(r => r.report_status === null || r.report_update === null ? [] : [{
        firedAt: r.fired_at,
        report: { status: r.report_status, update: r.report_update, ask: r.report_ask, reading: readingOf(r.report_reading_value, r.report_reading_label) },
      }]);
    },

    async recentReplies(input) {
      const limit = Math.min(ROUTINE_REPLIES_MAX_LIMIT, Math.max(1, input.limit));
      // The join keeps a reply only while its author owns its routine, and the reader must be that
      // author: the current owner's own replies, to the current owner. A routine that's gone keeps none.
      // Filtered before the limit, so another person's newer replies can't crowd the owner's out.
      const rows = await db
        .selectFrom('routines_v1_replies as rp')
        .innerJoin('routines_v1_definitions as r', join => join
          .onRef('r.agent_id', '=', 'rp.agent_id')
          .onRef('r.routine_id', '=', 'rp.routine_id')
          .onRef('r.owner_user_id', '=', 'rp.author_user_id'))
        .select(['rp.reply_id', 'rp.author_user_id', 'rp.body', 'rp.created_at'])
        .where('rp.agent_id', '=', input.agentId)
        .where('rp.routine_id', '=', input.routineId)
        .where('rp.author_user_id', '=', input.actorUserId)
        .orderBy('rp.created_at', 'desc')
        .orderBy('rp.reply_id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(r => ({ replyId: r.reply_id, authorUserId: r.author_user_id, text: r.body, sentAt: r.created_at }));
    },

    async list(input) {
      const q = db.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', input.agentId);
      const rows = await q.orderBy('agent_id').orderBy('routine_id').execute();
      return rows.map(rowToRoutine);
    },

    async findOne(input) {
      const row = await db
        .selectFrom('routines_v1_definitions')
        .selectAll()
        .where('agent_id', '=', input.agentId)
        .where('routine_id', '=', input.routineId)
        .executeTakeFirst();
      return row === undefined ? null : rowToRoutine(row as Parameters<typeof rowToRoutine>[0]);
    },

    async upsertDefault(input) {
      const id = opaqueId('default');
      const definition = validateDefinition({ ...input, enabled: input.enabled ?? true });
      const insertEnabled = input.enabled ?? true;
      const enabledUpdateFragment =
        input.enabled === undefined ? sql`` : sql`enabled = EXCLUDED.enabled,`;
      return db.transaction().execute(async trx => {
        await lockDefaultControls(trx, true);
        const row = await sql<{ default_routine_id: string; created: boolean }>`
          INSERT INTO default_routines_v1
            (default_routine_id, name, description, spec_hash, trigger_kind, trigger_spec,
             interval_seconds, active_hours, silence_token, silence_max, conversation,
             prompt_body, enabled)
          VALUES
            (${id}, ${input.name}, ${input.description}, ${inputHash(definition)},
             ${input.trigger.kind}, ${JSON.stringify(input.trigger)}::jsonb,
             ${durationToSeconds(input.trigger.every)}, ${input.activeHours === null ? null : JSON.stringify(input.activeHours)}::jsonb,
             ${input.silenceToken}, ${input.silenceMaxChars}, ${input.conversation},
             ${input.promptBody}, ${insertEnabled})
          ON CONFLICT (name) DO UPDATE SET
            description = EXCLUDED.description,
            spec_hash = EXCLUDED.spec_hash,
            trigger_kind = EXCLUDED.trigger_kind,
            trigger_spec = EXCLUDED.trigger_spec,
            interval_seconds = EXCLUDED.interval_seconds,
            active_hours = EXCLUDED.active_hours,
            silence_token = EXCLUDED.silence_token,
            silence_max = EXCLUDED.silence_max,
            conversation = EXCLUDED.conversation,
            prompt_body = EXCLUDED.prompt_body,
            ${enabledUpdateFragment}
            updated_at = now()
          RETURNING default_routine_id, (xmax = 0) AS created
        `.execute(trx);
        const r = row.rows[0];
        if (!r) throw new Error('upsertDefault: INSERT … RETURNING returned no row');
        return { defaultRoutineId: r.default_routine_id, created: r.created };
      });
    },

    async getDefault(defaultRoutineId) {
      const row = await db
        .selectFrom('default_routines_v1')
        .selectAll()
        .where('default_routine_id', '=', defaultRoutineId)
        .executeTakeFirst();
      return row === undefined ? null : defaultRowToDetail(row);
    },

    async listDefaults() {
      const rows = await db
        .selectFrom('default_routines_v1')
        .selectAll()
        .orderBy('name')
        .execute();
      return rows.map(defaultRowToDetail);
    },

    async deleteDefault(defaultRoutineId) {
      await db.transaction().execute(async trx => {
        await lockDefaultControls(trx, true);
        await trx.deleteFrom('default_routines_v1')
          .where('default_routine_id', '=', defaultRoutineId).execute();
      });
    },

    async materializeMissing(input) {
      if (input.agents.length === 0) return;
      await db.transaction().execute(async trx => {
        const liveAgents = [];
        for (const agent of [...input.agents].sort((a, b) => a.agentId.localeCompare(b.agentId))) {
          if (await lockLiveAgent(trx, agent.agentId)) liveAgents.push(agent);
        }
        await lockDefaultControls(trx);
        const defaults = await trx.selectFrom('default_routines_v1').select('default_routine_id').execute();
        const pairs = liveAgents.flatMap(a => defaults.map(d => ({ ...a, defaultId: d.default_routine_id, revision: opaqueId('rev') })));
        const agentIds = pairs.map(a => a.agentId);
        const ownerIds = pairs.map(a => a.ownerUserId);
        const defaultIds = pairs.map(a => a.defaultId);
        const revisions = pairs.map(a => a.revision);
        await sql`
        INSERT INTO routines_v1_definitions
          (agent_id, routine_id, owner_user_id, name, description, spec_hash,
           trigger_kind, trigger_spec, active_hours, silence_token, silence_max,
           conversation, prompt_body, next_run_at, definition_id, definition_updated_at,
           created_at, updated_at, revision, enabled)
        SELECT
          a.agent_id, 'default:' || d.default_routine_id, a.owner_user_id,
          d.name, d.description, d.spec_hash,
          d.trigger_kind, d.trigger_spec, d.active_hours, d.silence_token, d.silence_max,
          d.conversation, d.prompt_body, NULL,
          d.default_routine_id, d.updated_at,
          ${input.now}, ${input.now}, a.revision, d.enabled
        FROM unnest(${agentIds}::text[], ${ownerIds}::text[], ${defaultIds}::text[], ${revisions}::text[])
          AS a(agent_id, owner_user_id, default_id, revision)
        JOIN default_routines_v1 d ON d.default_routine_id=a.default_id
        WHERE d.enabled
          AND NOT EXISTS (
            SELECT 1 FROM routines_v1_definitions r
             WHERE r.agent_id = a.agent_id
               AND r.definition_id = d.default_routine_id
          )
          -- TASK-177: skip (agent, default) pairs the agent owner has
          -- explicitly disabled. Absence of an override row = enabled, so
          -- this NOT EXISTS keeps the default-ON behavior for every pair
          -- without an override.
          AND NOT EXISTS (
            SELECT 1 FROM agent_default_routine_overrides_v1 o
             WHERE o.agent_id = a.agent_id
               AND o.default_routine_id = d.default_routine_id
               AND o.enabled = false
          )
        ON CONFLICT (agent_id, routine_id) DO NOTHING
      `.execute(trx);
      });
    },

    async refreshStale(input) {
      await db.transaction().execute(async trx => {
        await lockDefaultControls(trx);
        const rows = await trx.selectFrom('routines_v1_definitions as r').innerJoin('default_routines_v1 as d', 'd.default_routine_id', 'r.definition_id')
          .selectAll('r').select(['d.updated_at as source_updated_at']).where(eb => eb.or([eb('r.definition_updated_at', 'is', null), eb('r.definition_updated_at', '<', eb.ref('d.updated_at'))])).forUpdate('r').execute();
        for (const row of rows) {
          const source = await trx.selectFrom('default_routines_v1').selectAll().where('default_routine_id', '=', row.definition_id!).executeTakeFirstOrThrow();
          await trx.updateTable('routines_v1_definitions').set({
            name: source.name, description: source.description, spec_hash: source.spec_hash,
            trigger_kind: source.trigger_kind, trigger_spec: source.trigger_spec, active_hours: source.active_hours,
            silence_token: source.silence_token, silence_max: source.silence_max, conversation: source.conversation,
            prompt_body: source.prompt_body, enabled: source.enabled, revision: opaqueId('rev'),
            definition_updated_at: source.updated_at, updated_at: input.now
          })
            .where('agent_id', '=', row.agent_id).where('routine_id', '=', row.routine_id).execute();
        }
      });
    },

    async reconcileOwners(input) {
      if (input.agents.length === 0) return 0;
      const agentIds = input.agents.map((a) => a.agentId);
      const ownerIds = input.agents.map((a) => a.ownerUserId);
      // TASK-936: the task state goes in the statement that moves the routine, from the one list a
      // change of kind clears too. A get-done task's finish date isn't in it, so it stays (TASK-951,
      // NO_FINISH_BY). Each column name is one of NO_TASK_STATE's own keys, never input,
      // and each value is bound. The last run's status, error and warning go too: they describe a run
      // only the earlier owner can now see, the error and warning name connectors only they could
      // reach, and a run of the new owner's that fails early carries the routine's last warning into
      // its own fire row (fire.ts). Its time stays, since default-routine scheduling keys off
      // last_run_at.
      const res = await sql`
        UPDATE routines_v1_definitions r
           SET owner_user_id = a.owner_user_id,
               revision = 'rev_' || replace(gen_random_uuid()::text, '-', ''),
               updated_at = now(),
               last_status = NULL,
               last_error = NULL,
               last_warning = NULL,
               ${sql.join(Object.entries(NO_TASK_STATE).map(([column, value]) => sql`${sql.ref(column)} = ${value}`))}
          FROM unnest(${agentIds}::text[], ${ownerIds}::text[])
            AS a(agent_id, owner_user_id)
         WHERE r.agent_id = a.agent_id
           AND r.owner_user_id IS DISTINCT FROM a.owner_user_id
      `.execute(db);
      return Number(res.numAffectedRows ?? 0);
    },

    async setAgentDefaultEnabled(input) {
      await db.transaction().execute(async trx => {
        if (!await lockLiveAgent(trx, input.agentId)) throw new SafeToolError('not-found', 'routineId');
        await lockDefaultControls(trx, true);
        const source = await trx.selectFrom('default_routines_v1').select('default_routine_id').where('default_routine_id', '=', input.defaultRoutineId).forKeyShare().executeTakeFirst();
        if (!source) throw new SafeToolError('not-found', 'routineId');
        if (input.enabled) {
          // Enabled is the default (absence = on) — drop any disable row.
          await trx.deleteFrom('agent_default_routine_overrides_v1')
            .where('agent_id', '=', input.agentId)
            .where('default_routine_id', '=', input.defaultRoutineId)
            .execute();
          return;
        }
        await sql`
        INSERT INTO agent_default_routine_overrides_v1
          (agent_id, default_routine_id, owner_user_id, enabled, updated_at)
        VALUES
          (${input.agentId}, ${input.defaultRoutineId}, ${input.ownerUserId}, false, now())
        ON CONFLICT (agent_id, default_routine_id) DO UPDATE SET
          owner_user_id = EXCLUDED.owner_user_id,
          enabled = EXCLUDED.enabled,
          updated_at = now()
      `.execute(trx);
      });
    },

    async isAgentDefaultEnabled(input) {
      const row = await db
        .selectFrom('agent_default_routine_overrides_v1')
        .select(['enabled'])
        .where('agent_id', '=', input.agentId)
        .where('default_routine_id', '=', input.defaultRoutineId)
        .executeTakeFirst();
      return row === undefined ? true : row.enabled;
    },

    async disabledDefaultIdsForAgent(agentId) {
      const rows = await db
        .selectFrom('agent_default_routine_overrides_v1')
        .select(['default_routine_id'])
        .where('agent_id', '=', agentId)
        .where('enabled', '=', false)
        .execute();
      return rows.map((r) => r.default_routine_id);
    },

    async removeMaterializedDefault(input) {
      await db.deleteFrom('routines_v1_definitions')
        .where('agent_id', '=', input.agentId)
        .where('definition_id', '=', input.defaultRoutineId)
        .execute();
    },

  };
}
function truncateUtf8(value: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(value).length <= maxBytes) return value;
  let out = ''; let bytes = 3;
  for (const point of value) { const size = enc.encode(point).length; if (bytes + size > maxBytes) break; out += point; bytes += size; }
  return `${out}…`;
}
