import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { SafeToolError } from '@ax/core';
import {
  applyRoutinePatch, CheckInMissSchema, durationToSeconds, RoutineDeleteOutputSchema,
  type RoutineCreateInput, type RoutineUpdateInput, type RoutineDeleteInput, type RoutineDeleteOutput,
  type RoutineKey, type RoutineSecretInput, type RoutineUpsertDefaultInput, type RoutineDefinition,
  RoutineCheckInViewSchema, type RoutineCheckInView
} from '@ax/routines-contract';
import type { RoutinesDatabase, RoutinesDefinitionsRow, DefaultRoutinesRow, RoutinesFiresRow } from './migrations.js';
import type { StoredRoutine, StoredNoRecentUpdate, StoredTaskState, AcceptedDispatch, DispatchOutcome, DispatchReport, FireRow, FireSource, OpenCheckInLookup, RecordReportInput, ReportRefusal } from './types.js';
import { createRequestHash, updateRequestHash, deleteRequestHash, dispatchRequestHash, credentialRef, editableDefinition, hasHmac, inputHash, nextRun, opaqueId, parseStoredRoutine, schedulingChanged, validateDefinition, validationError } from './definition.js';
import { AcceptedDispatchSchema, DispatchOutcomeSchema, DispatchReportSchema } from './dispatch.js';

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
  /**
   * TASK-907. Who owns each of these routines now, for deciding who may see a
   * run's report. A routine that's gone has no entry. Reads only the owner, so a
   * row another read couldn't parse can't fail a history read.
   */
  routineOwners(input: { agentId: string; routineIds: readonly string[] }): Promise<Map<string, string>>;
  findWebhook(input: { agentId: string; path: string }): Promise<StoredRoutine | null>;
  acceptDispatch(input: AcceptDispatchInput): Promise<{ accepted: AcceptedDispatch; replayed: boolean } | null>;
  interruptAbandonedDispatches(): Promise<number>;
  getDispatchOutcome(input: { agentId: string; dispatchId: string }): Promise<DispatchOutcome | null>;
  finishDispatch(input: { dispatchId: string; outcome: DispatchOutcome }): Promise<boolean>;
  /** TASK-907. Records an open run's conversation, once. Throws `RUN_CLOSED` when the run has finished, is gone, or its agent is retired. */
  bindDispatchConversation(input: { dispatchId: string; conversationId: string }): Promise<void>;
  /** TASK-907. The one open run of this agent in this conversation, or why there's none: no open run, more than one, or one whose routine is gone. Takes no lock. */
  findOpenDispatchByConversation(input: { agentId: string; conversationId: string }): Promise<OpenCheckInLookup>;
  /**
   * TASK-907. The one writer of a task's state. `'recorded'`, or why nothing was
   * written: the run must be an open check-in, bound to the report's
   * conversation, of a stay-on-top task its actor owns, on a live agent.
   */
  recordReport(input: RecordReportInput): Promise<'recorded' | ReportRefusal>;
  /**
   * TASK-910. The person clears a task's agent notes. Owner only, decided under
   * the routine's row lock. No run accepted at or before the clear can write
   * notes again (`recordReport`). Touches nothing else in the row.
   */
  clearAgentNotes(input: RoutineKey & { actorUserId: string; now: Date }): Promise<'cleared' | 'not-found' | 'forbidden'>;
  advance(input: RoutineKey & { expectedRevision: string; nextRunAt: Date | null; lastRunAt: Date }): Promise<void>;
  claimDue(input: { now: Date; limit: number; claimWindowMinutes: number }): Promise<StoredRoutine[]>;
  recentFires(input: RoutineKey & { limit?: number }): Promise<FireRow[]>;
  recentFiresForAgent(input: { agentId: string; limit?: number; before?: Date }): Promise<FireRow[]>;
  /**
   * TASK-908. A routine's latest reports, for its next check-in's message:
   * finished runs with a report, newest first, however many runs without one
   * came in between. `limit` is clamped to 1-10. The text is agent-written.
   */
  recentReports(input: RoutineKey & { limit: number }): Promise<Array<{ firedAt: Date; report: DispatchReport }>>;
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
 * TASK-907. A task's state is its latest report, so it's there only when the
 * report's status, update and time all are. A row with only some of them (a
 * rollback, a hand edit) reads as never reported rather than failing every read
 * of it, claimDue's included (TASK-913).
 */
function taskState(row: Selectable<RoutinesDefinitionsRow>): StoredTaskState | null {
  if (row.task_status === null || row.task_update === null || row.task_reported_at === null) return null;
  return { status: row.task_status, update: row.task_update, ask: row.task_ask, agentNotes: row.agent_notes, reportedAt: row.task_reported_at };
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
 */
const NO_TASK_STATE = {
  task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null,
} as const;
function rowToRoutine(row: Selectable<RoutinesDefinitionsRow>): StoredRoutine {
  return parseStoredRoutine({
    agentId: row.agent_id, routineId: row.routine_id, revision: row.revision, ownerUserId: row.owner_user_id,
    name: row.name, description: row.description, promptBody: row.prompt_body, enabled: row.enabled, trigger: row.trigger_spec,
    activeHours: row.active_hours, silenceToken: row.silence_token, silenceMaxChars: row.silence_max, conversation: row.conversation,
    kind: row.kind, goodWhen: row.good_when, definitionId: row.definition_id, definitionUpdatedAt: row.definition_updated_at, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status, lastError: row.last_error, lastWarning: row.last_warning, task: taskState(row),
    noRecentUpdate: noRecentUpdate(row),
  });
}
function rowToFire(r: Selectable<RoutinesFiresRow>): FireRow {
  return {
    id: Number(r.id), agentId: r.agent_id, routineId: r.routine_id, firedAt: r.fired_at, triggerSource: r.trigger_source,
    conversationId: r.conversation_id, status: r.status, error: r.error, renderedPrompt: r.rendered_prompt, warning: r.warning,
    // Nested, so no column name reaches the view. A row with only part of a report has none (TASK-907, TASK-913).
    report: r.report_status === null || r.report_update === null ? null : { status: r.report_status, update: r.report_update, ask: r.report_ask }
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
  throw new Error('Unknown routine receipt operation');
}
/**
 * TASK-907. What a receipt keeps of its result: all of it but a task's state. A
 * receipt lives as long as its request row, and the state is agent-written text
 * (a report, the agent's notes) that the task row already holds, once, where a
 * person can see and clear it. TASK-930: the task's missed check-ins stay out
 * too. They're the task's, not the request's, and move on without it.
 * Both keys are left out, not stored as null, so code from before each field
 * (whose strict schema has no such key) still reads the receipt after a
 * rollback; `.default(null)` fills them in on read. So an exact replay answers
 * with `task: null` and `noRecentUpdate: null`: a replay answers from its
 * receipt, never from a fresh read. The live answer is the effect's own, state
 * and all, so `acceptDispatch`'s `accepted.row` still holds the task's state and
 * misses as it read them under the row lock.
 */
function receiptCopy(operation: string, result: unknown): unknown {
  if (operation === 'create' || operation === 'update') return withoutTaskState(result as StoredRoutine);
  if (operation === 'dispatch') {
    const accepted = result as AcceptedDispatch;
    return { ...accepted, row: withoutTaskState(accepted.row) };
  }
  return result;
}
function withoutTaskState({ task: _task, noRecentUpdate: _misses, ...routine }: StoredRoutine): Omit<StoredRoutine, 'task' | 'noRecentUpdate'> { return routine; }
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
async function receiptTransaction<T>(db: DB, key: OperationKey, effect: (trx: Transaction<RoutinesDatabase>) => Promise<T>, onReplay?: () => void): Promise<T> {
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
      if (receipt.result !== null) { onReplay?.(); return parseReceipt(key.operation, receipt.result) as T; }
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
/**
 * A refused write can quote what it was sent (Postgres puts it in the error's
 * `where` or `detail`), and a report's text is the agent's. Keep only the run's
 * id and the SQLSTATE, and drop the original error.
 */
function reportWriteError(dispatchId: string, error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  return new Error(`Could not save the report for dispatch ${dispatchId}${code === null ? '' : ` (SQLSTATE ${code})`}.`);
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
          ...(next.kind === current.kind ? {} : NO_TASK_STATE),
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
          revision: raw.revision, req_id: result.reqId, accepted_at: input.now, completed_at: null, trigger_source: input.source
        }).execute();
        return result;
      }, () => { replayed = true; });
      return accepted === null ? null : { accepted, replayed };
    },
    async interruptAbandonedDispatches() {
      // Startup only, before any new dispatch accepts work in this single-host runtime.
      const rows = await db.selectFrom('routines_v1_dispatches').select('dispatch_id').where('completed_at', 'is', null).execute();
      let interrupted = 0;
      for (const row of rows) if (await this.finishDispatch({ dispatchId: row.dispatch_id, outcome: {
        status: 'error', error: 'The routine run was interrupted by a host restart.',
        conversationId: null, renderedPrompt: null, warning: null,
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
      const finished = await db.transaction().execute(async trx => {
        const candidate = await trx.selectFrom('routines_v1_dispatches').select('agent_id').where('dispatch_id', '=', input.dispatchId).executeTakeFirst();
        if (!candidate || !await lockLiveAgent(trx, candidate.agent_id)) return false;
        const dispatch = await trx.selectFrom('routines_v1_dispatches').selectAll().where('dispatch_id', '=', input.dispatchId).forUpdate().executeTakeFirst();
        if (!dispatch || dispatch.completed_at) return false;
        const stored = storedReport(dispatch.report);
        unreadable = stored.unreadable;
        await trx.insertInto('routines_v1_fires').values({
          agent_id: dispatch.agent_id, routine_id: dispatch.routine_id, dispatch_id: dispatch.dispatch_id,
          fired_at: dispatch.accepted_at, trigger_source: dispatch.trigger_source, conversation_id: outcome.conversationId, status: outcome.status,
          error: outcome.error, rendered_prompt: outcome.renderedPrompt === null ? null : truncateUtf8(outcome.renderedPrompt, 65536), warning: outcome.warning,
          report_status: stored.report?.status ?? null, report_update: stored.report?.update ?? null, report_ask: stored.report?.ask ?? null,
        }).execute();
        // The fire row has the report now; one copy of the text is enough (TASK-907).
        await trx.updateTable('routines_v1_dispatches').set({ completed_at: new Date(), report: null }).where('dispatch_id', '=', input.dispatchId).execute();
        await trx.updateTable('routines_v1_definitions').set({ last_run_at: dispatch.accepted_at, last_status: outcome.status, last_error: outcome.error, last_warning: outcome.warning })
          .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).where('revision', '=', dispatch.revision)
          .where(eb => eb.or([eb('last_run_at', 'is', null), eb('last_run_at', '<=', dispatch.accepted_at)])).execute();
        return true;
      });
      // After commit, so a rolled-back finish doesn't claim a drop. Only the id: the text is the agent's.
      if (finished && unreadable) process.stderr.write(`[ax/routines] dropped an unreadable report for dispatch ${input.dispatchId}\n`);
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
      return db.transaction().execute(async trx => {
        // finishDispatch's order (agent fence, dispatch row, definition row), so the two serialize.
        if (!await lockLiveAgent(trx, input.agentId)) return 'agent-retired';
        const dispatch = await trx.selectFrom('routines_v1_dispatches').select(['dispatch_id', 'agent_id', 'routine_id', 'accepted_at', 'completed_at', 'conversation_id'])
          .where('dispatch_id', '=', input.dispatchId).where('agent_id', '=', input.agentId).forUpdate().executeTakeFirst();
        // The whole binding, under the run's row lock: open, and bound to the conversation the report came from.
        // Compared here rather than in the WHERE, so a refusal can say which of the two it was (TASK-907).
        if (!dispatch || dispatch.completed_at !== null) return 'run-closed';
        if (dispatch.conversation_id !== input.conversationId) return 'not-bound';
        const definition = await trx.selectFrom('routines_v1_definitions').select(['kind', 'owner_user_id', 'agent_notes_cleared_at'])
          .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).forUpdate().executeTakeFirst();
        if (!definition) return 'routine-gone';
        if (definition.kind !== 'stay-on-top') return 'kind';
        if (definition.owner_user_id !== input.actorUserId) return 'owner';
        const { status, update, ask } = input.report;
        // TASK-910: a run accepted at or before the person last cleared the notes read the notes
        // they cleared, so it can't write any back. The rest of its report lands as usual.
        const clearedAt = definition.agent_notes_cleared_at;
        const writesNotes = input.notes !== undefined && (clearedAt === null || clearedAt.getTime() < dispatch.accepted_at.getTime());
        try {
          // A later report in the same check-in replaces this one.
          await trx.updateTable('routines_v1_dispatches').set({ report: JSON.stringify({ status, update, ask }) })
            .where('dispatch_id', '=', dispatch.dispatch_id).execute();
          // The run accepted last owns the task's state, whatever order the runs report in. There's
          // no revision clause, so an edit during the check-in can't drop its report, and the state
          // never moves revision, spec_hash or updated_at.
          await trx.updateTable('routines_v1_definitions').set({
            task_status: status, task_update: update, task_ask: ask,
            task_reported_at: input.now, task_report_accepted_at: dispatch.accepted_at,
            ...(writesNotes ? { agent_notes: input.notes } : {}),
          }).where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id)
            .where(eb => eb.or([eb('task_report_accepted_at', 'is', null), eb('task_report_accepted_at', '<=', dispatch.accepted_at)])).execute();
        } catch (error) {
          throw reportWriteError(dispatch.dispatch_id, error);
        }
        return 'recorded';
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
      const rows = await db
        .selectFrom('routines_v1_fires')
        .selectAll()
        .where('agent_id', '=', input.agentId)
        .where('routine_id', '=', input.routineId)
        .orderBy('fired_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(rowToFire);
    },

    async recentFiresForAgent(input) {
      const limit = Math.min(200, Math.max(1, input.limit ?? 20));
      let q = db
        .selectFrom('routines_v1_fires')
        .selectAll()
        .where('agent_id', '=', input.agentId);
      if (input.before !== undefined) q = q.where('fired_at', '<', input.before);
      const rows = await q
        .orderBy('fired_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(rowToFire);
    },

    async recentReports(input) {
      const limit = Math.min(10, Math.max(1, input.limit));
      const rows = await db
        .selectFrom('routines_v1_fires')
        .select(['fired_at', 'report_status', 'report_update', 'report_ask'])
        .where('agent_id', '=', input.agentId)
        .where('routine_id', '=', input.routineId)
        .where('report_status', 'is not', null)
        .where('report_update', 'is not', null)
        .orderBy('fired_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      // The query already skips a row with only part of a report (rowToFire's rule); this narrows the types.
      return rows.flatMap(r => r.report_status === null || r.report_update === null ? []
        : [{ firedAt: r.fired_at, report: { status: r.report_status, update: r.report_update, ask: r.report_ask } }]);
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

    async routineOwners(input) {
      if (input.routineIds.length === 0) return new Map();
      const rows = await db.selectFrom('routines_v1_definitions').select(['routine_id', 'owner_user_id'])
        .where('agent_id', '=', input.agentId).where('routine_id', 'in', [...input.routineIds]).execute();
      return new Map(rows.map(row => [row.routine_id, row.owner_user_id]));
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
      const res = await sql`
        UPDATE routines_v1_definitions r
           SET owner_user_id = a.owner_user_id,
               revision = 'rev_' || replace(gen_random_uuid()::text, '-', ''),
               updated_at = now()
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
