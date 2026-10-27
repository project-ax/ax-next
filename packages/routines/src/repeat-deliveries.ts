import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { BlobRef } from '@ax/core';
import { repeatConfigurationHash, opaqueId } from './definition.js';
import { lockLiveAgent, rowToRoutine } from './store.js';
import type { RepeatDeliveryRow, RoutinesDatabase } from './migrations.js';
import type { AcceptedDispatch, StoredRoutine } from './types.js';
import { githubDeliveryId, repeatQueueFits, REPEAT_DELIVERY_LIMITS as LIMIT } from './repeat-limits.js';
type DB = Kysely<RoutinesDatabase>;
const configurationHash = repeatConfigurationHash;
export type RepeatDeliveryStatus = { active: number; waiting: number };
export type DeliveryClaim = { deliveryId: string; blobRef: string; accepted: AcceptedDispatch };

const admissionTails = new WeakMap<DB, Promise<void>>();
async function serializeAdmission<T>(db: DB, run: () => Promise<T>): Promise<T> {
  const previous = admissionTails.get(db);
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  admissionTails.set(db, tail);
  // Payload storage may query this same pool. Wait before opening a transaction,
  // so lock contenders cannot take every connection storage needs to finish.
  // SQL locks still own cross-host deduplication and quota decisions.
  await previous;
  try { return await run(); }
  finally {
    release();
    if (admissionTails.get(db) === tail) admissionTails.delete(db);
  }
}

/** SQL owns admission/claims; the blob facade owns bytes and their existing quota accounting. */
export function createRepeatDeliveryStore(db: DB, executorId: string) {
  return {
    async admit(input: { row: StoredRoutine; payload: unknown; deliveryId: string | null; now: Date }, persist: (bytes: Uint8Array, owner: string) => Promise<{ sha256: string; size: number }>): Promise<'accepted' | 'duplicate' | 'full' | 'missing'> {
      const id = githubDeliveryId(input.deliveryId ?? undefined);
      const hash = id === null ? null : createHash('sha256').update(id).digest('hex');
      return serializeAdmission(db, () => db.transaction().execute(async trx => {
        if (!await lockLiveAgent(trx, input.row.agentId)) return 'missing';
        // Same owner across agents/tasks: task creation cannot evade aggregate admission.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.row.ownerUserId},18427134))`.execute(trx);
        const raw = await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id','=',input.row.agentId).where('routine_id','=',input.row.routineId).forUpdate().executeTakeFirst();
        if (!raw || raw.revision !== input.row.revision || raw.owner_user_id !== input.row.ownerUserId || raw.kind !== 'repeat' || raw.webhook_spec === null) return 'missing';
        await trx.deleteFrom('routines_v1_deliveries').where('completed_at','is not',null).where('expires_at','<=',input.now).where('agent_id','=',raw.agent_id).where('routine_id','=',raw.routine_id).execute();
        if (hash !== null && await trx.selectFrom('routines_v1_deliveries').select('delivery_id').where('agent_id','=',raw.agent_id).where('routine_id','=',raw.routine_id).where('github_id_hash','=',hash).executeTakeFirst()) return 'duplicate';
        if (!raw.enabled) return 'missing';
        const row = rowToRoutine(raw);
        const bytes = Buffer.from(JSON.stringify({ row, payload: input.payload }));
        const owner = await trx.selectFrom('routines_v1_deliveries').select(eb => [eb.fn.countAll<string>().as('ids'), sql<string>`count(*) FILTER(WHERE blob_ref IS NOT NULL)`.as('pending'), sql<string>`coalesce(sum(byte_length),0)`.as('bytes')]).where('owner_user_id','=',row.ownerUserId).executeTakeFirstOrThrow();
        const task = await trx.selectFrom('routines_v1_deliveries').select(eb => [eb.fn.countAll<string>().as('ids'), sql<string>`count(*) FILTER(WHERE completed_at IS NULL AND dispatch_id IS NULL)`.as('waiting')]).where('agent_id','=',row.agentId).where('routine_id','=',row.routineId).executeTakeFirstOrThrow();
        if (!repeatQueueFits({ waiting: Number(task.waiting), ownerPending: Number(owner.pending), ownerBytes: Number(owner.bytes), incomingBytes: bytes.length }) || (hash !== null && (Number(owner.ids) >= LIMIT.idsPerOwner || Number(task.ids) >= LIMIT.idsPerRoutine))) return 'full';
        const stored = await persist(bytes, row.ownerUserId);
        if (!/^[a-f0-9]{64}$/.test(stored.sha256) || stored.size !== bytes.length) throw new Error('App update storage did not confirm its bytes.');
        await trx.insertInto('routines_v1_deliveries').values({ delivery_id: opaqueId('delivery'), agent_id: row.agentId, routine_id: row.routineId, owner_user_id: row.ownerUserId,
          accepted_at: input.now, expires_at: new Date(input.now.getTime()+LIMIT.retentionMs), github_id_hash: hash, configuration_hash: configurationHash(row), blob_ref: stored.sha256, byte_length: bytes.length, dispatch_id: null, invalidated_reason: null, completed_at: null }).execute();
        return 'accepted';
      }));
    },
    async claim(now: Date, skipped=0): Promise<DeliveryClaim | null> {
      // Skip paused/busy heads before the batch limit, without holding queue locks before definition locks.
      const candidates = await sql<Selectable<RepeatDeliveryRow>>`SELECT q.* FROM routines_v1_deliveries q LEFT JOIN routines_v1_definitions r USING(agent_id,routine_id)
        WHERE q.completed_at IS NULL AND q.dispatch_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM routines_v1_deliveries older WHERE older.agent_id=q.agent_id AND older.routine_id=q.routine_id AND older.completed_at IS NULL AND older.dispatch_id IS NULL AND older.sequence_id<q.sequence_id)
          AND (q.invalidated_reason IS NOT NULL OR r.routine_id IS NULL OR r.owner_user_id<>q.owner_user_id OR r.kind<>'repeat' OR r.webhook_spec IS NULL OR
            (r.enabled AND (SELECT count(*) FROM routines_v1_dispatches d WHERE d.agent_id=q.agent_id AND d.routine_id=q.routine_id AND d.completed_at IS NULL)<${LIMIT.active}))
        ORDER BY q.sequence_id LIMIT 1`.execute(db);
      const candidate = candidates.rows[0]; if (!candidate) return null;
      let cancelled=false;
      const claimed=await db.transaction().execute(async trx => {
        if (!await lockLiveAgent(trx,candidate.agent_id)) return null;
        const raw = await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id','=',candidate.agent_id).where('routine_id','=',candidate.routine_id).forUpdate().executeTakeFirst();
        const q = await trx.selectFrom('routines_v1_deliveries').selectAll().where('delivery_id','=',candidate.delivery_id).forUpdate().executeTakeFirst();
        if (!q || q.completed_at || q.dispatch_id) return null;
        const current = raw ? rowToRoutine(raw) : null;
        if (q.invalidated_reason || !current || current.ownerUserId !== q.owner_user_id || current.kind !== 'repeat' || current.webhook === null || configurationHash(current) !== q.configuration_hash) {
          await trx.insertInto('routines_v1_fires').values({ agent_id:q.agent_id,routine_id:q.routine_id,dispatch_id:opaqueId('cancelled_delivery'),fired_at:q.accepted_at,trigger_source:'webhook',status:'error',error:'This app update was cancelled because the job changed.',conversation_id:null,rendered_prompt:null,warning:null,run_as_user_id:q.owner_user_id }).execute();
          await trx.updateTable('routines_v1_deliveries').set({completed_at:now,blob_ref:null,byte_length:0,invalidated_reason:'job-changed'}).where('delivery_id','=',q.delivery_id).execute();
          cancelled=true;
          return null;
        }
        if (!current.enabled) return null;
        const active = await trx.selectFrom('routines_v1_dispatches').select(eb => eb.fn.countAll<string>().as('n')).where('agent_id','=',q.agent_id).where('routine_id','=',q.routine_id).where('completed_at','is',null).executeTakeFirstOrThrow();
        if (Number(active.n)>=LIMIT.active) return null;
        const accepted: AcceptedDispatch = { dispatchId:opaqueId('dispatch'),reqId:opaqueId('routine_run'),row:current,source:'webhook',acceptedAt:q.accepted_at };
        await trx.insertInto('routines_v1_dispatches').values({dispatch_id:accepted.dispatchId,agent_id:q.agent_id,routine_id:q.routine_id,revision:current.revision,req_id:accepted.reqId,accepted_at:q.accepted_at,trigger_source:'webhook',kind:'repeat',run_as_user_id:q.owner_user_id,completed_at:null,delivery_id:q.delivery_id,executor_id:executorId,lease_expires_at:sql<Date>`clock_timestamp()+interval '120 seconds'`}).execute();
        await trx.updateTable('routines_v1_deliveries').set({dispatch_id:accepted.dispatchId}).where('delivery_id','=',q.delivery_id).execute();
        return {deliveryId:q.delivery_id,blobRef:q.blob_ref!,accepted};
      });
      return cancelled && skipped<LIMIT.waitingPerRoutine ? this.claim(now,skipped+1):claimed;
    },
    async settle(now: Date) {
      await sql`UPDATE routines_v1_deliveries q SET completed_at=d.completed_at,blob_ref=NULL,byte_length=0 FROM routines_v1_dispatches d WHERE q.dispatch_id=d.dispatch_id AND q.completed_at IS NULL AND d.completed_at IS NOT NULL`.execute(db);
      await sql`WITH expired AS (SELECT delivery_id FROM routines_v1_deliveries WHERE completed_at IS NOT NULL AND (github_id_hash IS NULL OR expires_at<=${now}) ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM routines_v1_deliveries q USING expired WHERE q.delivery_id=expired.delivery_id`.execute(db);
    },
    async status(key: {agentId:string;routineId:string}, owner: string): Promise<RepeatDeliveryStatus> {
      const row = await db.selectFrom('routines_v1_definitions').select('owner_user_id').where('agent_id','=',key.agentId).where('routine_id','=',key.routineId).executeTakeFirst();
      if (row?.owner_user_id !== owner) return {active:0,waiting:0};
      const active = await db.selectFrom('routines_v1_dispatches').select(eb=>eb.fn.countAll<string>().as('n')).where('agent_id','=',key.agentId).where('routine_id','=',key.routineId).where('completed_at','is',null).executeTakeFirstOrThrow();
      const waiting = await db.selectFrom('routines_v1_deliveries').select(eb=>eb.fn.countAll<string>().as('n')).where('agent_id','=',key.agentId).where('routine_id','=',key.routineId).where('owner_user_id','=',owner).where('completed_at','is',null).where('dispatch_id','is',null).executeTakeFirstOrThrow();
      return {active:Number(active.n),waiting:Number(waiting.n)};
    },
    async references(candidates: string[]): Promise<BlobRef[]> {
      if (!candidates.length) return [];
      const rows = await db.selectFrom('routines_v1_deliveries').select(['blob_ref','owner_user_id']).where('blob_ref','in',candidates).execute();
      return rows.map(row=>({sha256:row.blob_ref!,userIds:[row.owner_user_id]}));
    },
    async renew() { await sql`UPDATE routines_v1_dispatches SET lease_expires_at=clock_timestamp()+interval '120 seconds' WHERE executor_id=${executorId} AND NOT executor_released AND completed_at IS NULL`.execute(db); },
    async release() { await db.updateTable('routines_v1_dispatches').set({executor_released:true}).where('executor_id','=',executorId).where('completed_at','is',null).execute(); },
    async deferRecovery(dispatchId:string) { await sql`UPDATE routines_v1_dispatches SET lease_expires_at=clock_timestamp()+interval '10 seconds' WHERE dispatch_id=${dispatchId} AND completed_at IS NULL AND NOT executor_released AND lease_expires_at<=clock_timestamp()`.execute(db); },
    async expired() {
      return db.selectFrom('routines_v1_dispatches').select(['dispatch_id','agent_id','run_as_user_id','conversation_id','executor_released']).where('kind','=','repeat').where('completed_at','is',null).where(sql<boolean>`executor_released OR lease_expires_at<=clock_timestamp()`).orderBy('lease_expires_at').limit(100).execute();
    },
  };
}
export type RepeatDeliveryStore = ReturnType<typeof createRepeatDeliveryStore>;
