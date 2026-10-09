import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { SafeToolError } from '@ax/core';
import {
  applyRoutinePatch, durationToSeconds, RoutineDeleteOutputSchema,
  type RoutineCreateInput, type RoutineUpdateInput, type RoutineDeleteInput, type RoutineDeleteOutput,
  type RoutineKey, type RoutineSecretInput, type RoutineUpsertDefaultInput, type RoutineDefinition
} from '@ax/routines-contract';
import type { RoutinesDatabase, RoutinesDefinitionsRow, DefaultRoutinesRow, RoutinesFiresRow } from './migrations.js';
import type { StoredRoutine, AcceptedDispatch, DispatchOutcome, FireRow, FireSource, FireStatus } from './types.js';
import { createRequestHash, updateRequestHash, deleteRequestHash, dispatchRequestHash, credentialRef, editableDefinition, hasHmac, inputHash, nextRun, opaqueId, parseStoredRoutine, schedulingChanged, validateDefinition } from './definition.js';
import { AcceptedDispatchSchema, DispatchOutcomeSchema } from './dispatch.js';

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
  acceptDispatch(input: AcceptDispatchInput): Promise<AcceptedDispatch | null>;
  finishDispatch(input: { dispatchId: string; outcome: DispatchOutcome }): Promise<boolean>;
  advance(input: RoutineKey & { expectedRevision: string; nextRunAt: Date | null; lastRunAt: Date; lastStatus: FireStatus; lastError: string | null }): Promise<void>;
  claimDue(input: { now: Date; limit: number; claimWindowMinutes: number }): Promise<StoredRoutine[]>;
  recentFires(input: RoutineKey & { limit?: number }): Promise<FireRow[]>;
  recentFiresForAgent(input: { agentId: string; limit?: number; before?: Date }): Promise<FireRow[]>;
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
function definitionColumns(d: RoutineDefinition) {
  return {
    name: d.name, description: d.description, prompt_body: d.promptBody, enabled: d.enabled,
    trigger_kind: d.trigger.kind, trigger_spec: d.trigger as unknown, active_hours: d.activeHours as unknown,
    silence_token: d.silenceToken, silence_max: d.silenceMaxChars, conversation: d.conversation, spec_hash: inputHash(d)
  };
}
function rowToRoutine(row: Selectable<RoutinesDefinitionsRow>): StoredRoutine {
  return parseStoredRoutine({
    agentId: row.agent_id, routineId: row.routine_id, revision: row.revision, ownerUserId: row.owner_user_id,
    name: row.name, description: row.description, promptBody: row.prompt_body, enabled: row.enabled, trigger: row.trigger_spec,
    activeHours: row.active_hours, silenceToken: row.silence_token, silenceMaxChars: row.silence_max, conversation: row.conversation,
    definitionId: row.definition_id, definitionUpdatedAt: row.definition_updated_at, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status, lastError: row.last_error, lastWarning: row.last_warning
  });
}
function rowToFire(r: Selectable<RoutinesFiresRow>): FireRow {
  return {
    id: Number(r.id), agentId: r.agent_id, routineId: r.routine_id, firedAt: r.fired_at, triggerSource: r.trigger_source,
    conversationId: r.conversation_id, status: r.status, error: r.error, renderedPrompt: r.rendered_prompt, warning: r.warning
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
async function receiptTransaction<T>(db: DB, key: OperationKey, effect: (trx: Transaction<RoutinesDatabase>) => Promise<T>): Promise<T> {
  try {
    return await db.transaction().execute(async trx => {
      if (!await lockLiveAgent(trx, key.agentId)) throw new SafeToolError('not-found', 'routineId');
      await trx.insertInto('routines_v1_requests').values({
        agent_id: key.agentId, owner_user_id: key.actorUserId, operation: key.operation,
        request_id: key.requestId, input_hash: key.inputHash, result: null, routine_id: null
      }).onConflict(oc => oc.doNothing()).execute();
      const receipt = await receiptQuery(trx, key).forUpdate().executeTakeFirstOrThrow();
      if (receipt.input_hash !== key.inputHash) throw new SafeToolError('request-conflict', 'requestId');
      if (receipt.result !== null) return parseReceipt(key.operation, receipt.result) as T;
      const result = await effect(trx);
      // SQL NULL means pending; JSON null is not used as a settled dispatch receipt.
      if (result === null) { await trx.deleteFrom('routines_v1_requests').where('agent_id', '=', key.agentId).where('owner_user_id', '=', key.actorUserId).where('operation', '=', key.operation).where('request_id', '=', key.requestId).execute(); return result; }
      await trx.updateTable('routines_v1_requests').set({ result: JSON.stringify(result) }).where('agent_id', '=', key.agentId)
        .where('owner_user_id', '=', key.actorUserId).where('operation', '=', key.operation).where('request_id', '=', key.requestId).execute();
      return parseReceipt(key.operation, result) as T;
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'routines_v1_webhook_path_unique') throw new SafeToolError('webhook-path-conflict', 'trigger.path');
    throw error;
  }
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
/** Effects must be bounded by the hook bus timeout; no transaction handle crosses that boundary. */
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
          routine_id: opaqueId('routine'), revision: opaqueId('rev'), owner_user_id: input.ownerUserId, next_run_at: nextRun(definition, input.now),
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
        try { next = applyRoutinePatch(editableDefinition(current), input.patch); } catch { throw new SafeToolError('validation', 'input'); }
        if (hasHmac(next)) await assertNoCleanup(trx, current);
        if (hasHmac(current) && !hasHmac(next)) await queueCleanup(trx, current);
        const row = await trx.updateTable('routines_v1_definitions').set({
          ...definitionColumns(next), revision: opaqueId('rev'), updated_at: input.now,
          next_run_at: schedulingChanged(current, next) ? nextRun(next, input.now) : current.nextRunAt
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
      return receiptTransaction(db, operationKey(input, 'dispatch', dispatchRequestHash(input)), async trx => {
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
      });
    },
    async finishDispatch(input) {
      const outcome = DispatchOutcomeSchema.parse(input.outcome);
      return db.transaction().execute(async trx => {
        const candidate = await trx.selectFrom('routines_v1_dispatches').select('agent_id').where('dispatch_id', '=', input.dispatchId).executeTakeFirst();
        if (!candidate || !await lockLiveAgent(trx, candidate.agent_id)) return false;
        const dispatch = await trx.selectFrom('routines_v1_dispatches').selectAll().where('dispatch_id', '=', input.dispatchId).forUpdate().executeTakeFirst();
        if (!dispatch || dispatch.completed_at) return false;
        await trx.insertInto('routines_v1_fires').values({
          agent_id: dispatch.agent_id, routine_id: dispatch.routine_id, dispatch_id: dispatch.dispatch_id,
          fired_at: dispatch.accepted_at, trigger_source: dispatch.trigger_source, conversation_id: outcome.conversationId, status: outcome.status,
          error: outcome.error, rendered_prompt: outcome.renderedPrompt === null ? null : truncateUtf8(outcome.renderedPrompt, 65536), warning: outcome.warning
        }).execute();
        await trx.updateTable('routines_v1_dispatches').set({ completed_at: new Date() }).where('dispatch_id', '=', input.dispatchId).execute();
        await trx.updateTable('routines_v1_definitions').set({ last_run_at: dispatch.accepted_at, last_status: outcome.status, last_error: outcome.error, last_warning: outcome.warning })
          .where('agent_id', '=', dispatch.agent_id).where('routine_id', '=', dispatch.routine_id).where('revision', '=', dispatch.revision)
          .where(eb => eb.or([eb('last_run_at', 'is', null), eb('last_run_at', '<=', dispatch.accepted_at)])).execute();
        return true;
      });
    },
    async advance(input) {
      await db.updateTable('routines_v1_definitions').set({ next_run_at: input.nextRunAt, last_run_at: input.lastRunAt, last_status: input.lastStatus, last_error: input.lastError })
        .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).where('revision', '=', input.expectedRevision).execute();
    },
    async withLockedWebhookSecret(input, effect) {
      return db.transaction().execute(async trx => {
        const row = await lockRoutine(trx, input);
        if (!hasHmac(row)) throw new SafeToolError('validation', 'trigger.hmac');
        await assertNoCleanup(trx, row);
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
      `.execute(db);
      const r = row.rows[0];
      if (!r) throw new Error('upsertDefault: INSERT … RETURNING returned no row');
      return { defaultRoutineId: r.default_routine_id, created: r.created };
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
      await db.deleteFrom('default_routines_v1')
        .where('default_routine_id', '=', defaultRoutineId)
        .execute();
    },

    async materializeMissing(input) {
      if (input.agents.length === 0) return;
      await db.transaction().execute(async trx => {
        const liveAgents = [];
        for (const agent of [...input.agents].sort((a, b) => a.agentId.localeCompare(b.agentId))) {
          if (await lockLiveAgent(trx, agent.agentId)) liveAgents.push(agent);
        }
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
           SET owner_user_id = a.owner_user_id
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
