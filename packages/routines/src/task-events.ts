import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { BlobRef } from '@ax/core';
import { durationToSeconds, isTaskKind } from '@ax/routines-contract';
import type { RoutinesDatabase, TaskEventRow } from './migrations.js';
import type { StoredRoutine } from './types.js';
import { lockLiveAgent, rowToRoutine } from './store.js';
import { nextRun, opaqueId } from './definition.js';
import { serializeAdmission } from './admission-order.js';
import { githubDeliveryId } from './repeat-limits.js';
import { advanceToNextActiveWindow } from './active-hours.js';
import { webhookAddressMatches, type WebhookAddressProof } from './webhook-address.js';
type DB = Kysely<RoutinesDatabase>;
export const TASK_EVENT_LIMITS = Object.freeze({ batch:20, previewBytes:4096, payloadBytes:1024*1024, pendingPerRoutine:256, pendingPerOwner:512, bytesPerOwner:16*1024*1024, idsPerRoutine:4096, idsPerOwner:16384, retentionMs:7*86400_000 });
export type TaskEvent = {eventId:string;receivedAt:Date;blobRef:string;byteLength:number;mayBeOwnChange:boolean};
const eventView = (row: Selectable<TaskEventRow>): TaskEvent => ({eventId:row.event_id,receivedAt:row.received_at,blobRef:row.blob_ref!,byteLength:row.byte_length,mayBeOwnChange:row.may_be_own_change});
const responseMs = (row:StoredRoutine):number => (durationToSeconds(row.webhook?.respondWithin ?? '5m') ?? 300)*1000;
function activeDue(row:StoredRoutine, due:Date):Date|null { return row.activeHours === null ? due : advanceToNextActiveWindow(due,row.activeHours); }

/** Called with the task definition locked. One source of due-ness, consumed by the existing tick. */
export async function nudgeTaskEvents(db:DB, row:StoredRoutine, now:Date, afterRun?:{acceptedAt:Date;reported:boolean;boundary:number|null;requested?:boolean}):Promise<void> {
  if (!isTaskKind(row.kind) || !row.enabled) return;
  const pending=await db.selectFrom('routines_v1_task_events').select(['received_at','sequence_id']).where('agent_id','=',row.agentId).where('routine_id','=',row.routineId).where('owner_user_id','=',row.ownerUserId).where('consumed_at','is',null).where('dispatch_id','is',null).orderBy('sequence_id').limit(1).executeTakeFirst();
  const safety=afterRun ? nextRun(row,afterRun.acceptedAt) : row.nextRunAt;
  let due=safety;
  if (pending) {
    // Already waiting when a reported run started: overflow from its20-entry batch follows immediately.
    const overflow=afterRun?.reported === true && afterRun.boundary !== null && Number(pending.sequence_id)<=afterRun.boundary;
    const previous = afterRun?.acceptedAt ?? row.lastRunAt;
    const batchAt=overflow ? now : new Date(Math.max(pending.received_at.getTime()+responseMs(row), previous === null ? 0 : previous.getTime()+responseMs(row)));
    // Failed runs retry without an immediate failure loop. Their updates remain unconsumed.
    const eventAt=afterRun && !afterRun.reported ? new Date(Math.max(batchAt.getTime(),now.getTime()+60_000)) : batchAt;
    if (due===null || eventAt<due) due=eventAt;
  }
  if (due!==null) due=activeDue(row,due);
  // A queued owner reply is an explicit request, as immediate replies are.
  if (afterRun?.requested) due=now;
  await db.updateTable('routines_v1_definitions').set({next_run_at:due}).where('agent_id','=',row.agentId).where('routine_id','=',row.routineId).execute();
}

export async function assignTaskEvents(db:DB, row:StoredRoutine, dispatchId:string):Promise<number|null> {
  const boundary=await db.selectFrom('routines_v1_task_events').select(eb=>eb.fn.max<number>('sequence_id').as('last')).where('agent_id','=',row.agentId).where('routine_id','=',row.routineId).where('owner_user_id','=',row.ownerUserId).where('consumed_at','is',null).executeTakeFirst();
  const entries=await db.selectFrom('routines_v1_task_events').select('event_id').where('agent_id','=',row.agentId).where('routine_id','=',row.routineId).where('owner_user_id','=',row.ownerUserId).where('consumed_at','is',null).where('dispatch_id','is',null).orderBy('sequence_id').limit(TASK_EVENT_LIMITS.batch).forUpdate().execute();
  if (entries.length) await db.updateTable('routines_v1_task_events').set({dispatch_id:dispatchId}).where('event_id','in',entries.map(e=>e.event_id)).execute();
  return boundary?.last == null ? null : Number(boundary.last);
}
export async function consumeTaskEvents(db:DB,dispatchId:string,now:Date):Promise<void> {
  await db.deleteFrom('routines_v1_task_events').where('dispatch_id','=',dispatchId).where('delivery_id_hash','is',null).execute();
  await db.updateTable('routines_v1_task_events').set({consumed_at:now,blob_ref:null,byte_length:0}).where('dispatch_id','=',dispatchId).where('consumed_at','is',null).execute();
}
export async function releaseTaskEvents(db:DB,dispatchId:string):Promise<void> {
  await db.updateTable('routines_v1_task_events').set({dispatch_id:null}).where('dispatch_id','=',dispatchId).where('consumed_at','is',null).execute();
}

export function createTaskEventStore(db:DB) {
  async function entries(input:{agentId:string;dispatchId:string;actorUserId:string}):Promise<TaskEvent[]> {
    const rows=await db.selectFrom('routines_v1_task_events as e').innerJoin('routines_v1_dispatches as d','d.dispatch_id','e.dispatch_id').innerJoin('routines_v1_definitions as r',join=>join.onRef('r.agent_id','=','e.agent_id').onRef('r.routine_id','=','e.routine_id').onRef('r.owner_user_id','=','e.owner_user_id'))
      .selectAll('e').where('d.agent_id','=',input.agentId).where('d.dispatch_id','=',input.dispatchId).where('d.run_as_user_id','=',input.actorUserId).where('e.owner_user_id','=',input.actorUserId).where('d.completed_at','is',null).where('r.kind','in',['stay-on-top','get-done']).where('e.consumed_at','is',null).orderBy('e.sequence_id').limit(TASK_EVENT_LIMITS.batch).execute();
    return rows.filter(row=>row.blob_ref!==null).map(eventView);
  }
  return {
    async hasTaskCheckInRequest(input:{agentId:string;routineId:string}):Promise<boolean> {
      const row=await db.selectFrom('routines_v1_definitions').select('task_check_in_requested').where('agent_id','=',input.agentId).where('routine_id','=',input.routineId).executeTakeFirst();
      return row?.task_check_in_requested===true;
    },
    async requestTaskCheckIn(input:{agentId:string;routineId:string;actorUserId:string;now:Date}):Promise<'queued'|'missing'> {
      return db.transaction().execute(async trx=>{
        if (!await lockLiveAgent(trx,input.agentId)) return 'missing';
        const raw=await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id','=',input.agentId).where('routine_id','=',input.routineId).forUpdate().executeTakeFirst();
        if (!raw || !isTaskKind(raw.kind) || !raw.enabled || raw.owner_user_id!==input.actorUserId) return 'missing';
        await trx.updateTable('routines_v1_definitions').set({task_check_in_requested:true,next_run_at:input.now}).where('agent_id','=',input.agentId).where('routine_id','=',input.routineId).execute();
        return 'queued';
      });
    },
    async admitTaskEvent(input:{row:StoredRoutine;payload:unknown;deliveryId:string|null;now:Date;address?:WebhookAddressProof},persist:(bytes:Uint8Array,owner:string)=>Promise<{sha256:string;size:number}>,authorizeLegacy?:()=>Promise<boolean>):Promise<'accepted'|'duplicate'|'full'|'missing'> {
      const id=githubDeliveryId(input.deliveryId ?? undefined);
      const hash=id===null ? null : createHash('sha256').update(id).digest('hex');
      const bytes=Buffer.from(JSON.stringify(input.payload));
      if (bytes.length>TASK_EVENT_LIMITS.payloadBytes) return 'full';
      return serializeAdmission(db,()=>db.transaction().execute(async trx=>{
        if (!await lockLiveAgent(trx,input.row.agentId)) return 'missing';
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.row.ownerUserId},18427134))`.execute(trx);
        const raw=await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id','=',input.row.agentId).where('routine_id','=',input.row.routineId).forUpdate().executeTakeFirst();
        if (!raw || !isTaskKind(raw.kind) || raw.webhook_spec===null || raw.revision!==input.row.revision || raw.owner_user_id!==input.row.ownerUserId) return 'missing';
        if (input.address && (!webhookAddressMatches(raw,input.address) || input.address.kind==='legacy' && (!authorizeLegacy || !await authorizeLegacy()))) return 'missing';
        await trx.deleteFrom('routines_v1_task_events').where('owner_user_id','=',raw.owner_user_id).where('consumed_at','is not',null).where('expires_at','<=',input.now).execute();
        if (hash!==null && await trx.selectFrom('routines_v1_task_events').select('event_id').where('agent_id','=',raw.agent_id).where('routine_id','=',raw.routine_id).where('delivery_id_hash','=',hash).executeTakeFirst()) return 'duplicate';
        if (!raw.enabled) return 'missing';
        const owner=await trx.selectFrom('routines_v1_task_events').select(eb=>[eb.fn.countAll<string>().as('ids'),sql<string>`count(*) FILTER(WHERE consumed_at IS NULL)`.as('pending'),sql<string>`coalesce(sum(byte_length),0)`.as('bytes')]).where('owner_user_id','=',raw.owner_user_id).executeTakeFirstOrThrow();
        const task=await trx.selectFrom('routines_v1_task_events').select(eb=>[eb.fn.countAll<string>().as('ids'),sql<string>`count(*) FILTER(WHERE consumed_at IS NULL)`.as('pending')]).where('agent_id','=',raw.agent_id).where('routine_id','=',raw.routine_id).executeTakeFirstOrThrow();
        if (Number(task.pending)>=TASK_EVENT_LIMITS.pendingPerRoutine || Number(owner.pending)>=TASK_EVENT_LIMITS.pendingPerOwner || Number(owner.bytes)+bytes.length>TASK_EVENT_LIMITS.bytesPerOwner || hash!==null && (Number(task.ids)>=TASK_EVENT_LIMITS.idsPerRoutine || Number(owner.ids)>=TASK_EVENT_LIMITS.idsPerOwner)) return 'full';
        const stored=await persist(bytes,raw.owner_user_id);
        if (!/^[a-f0-9]{64}$/.test(stored.sha256) || stored.size!==bytes.length) throw new Error('App update storage did not confirm its bytes.');
        const active=await trx.selectFrom('routines_v1_dispatches').select('dispatch_id').where('agent_id','=',raw.agent_id).where('routine_id','=',raw.routine_id).where('completed_at','is',null).limit(1).executeTakeFirst();
        await trx.insertInto('routines_v1_task_events').values({event_id:opaqueId('update'),agent_id:raw.agent_id,routine_id:raw.routine_id,owner_user_id:raw.owner_user_id,received_at:input.now,expires_at:new Date(input.now.getTime()+TASK_EVENT_LIMITS.retentionMs),delivery_id_hash:hash,blob_ref:stored.sha256,byte_length:bytes.length,dispatch_id:null,consumed_at:null,may_be_own_change:active!==undefined}).execute();
        await nudgeTaskEvents(trx,rowToRoutine(raw),input.now);
        return 'accepted';
      }));
    },
    taskEventsForDispatch:entries,
    async readTaskEvent(input:{agentId:string;conversationId:string;actorUserId:string;eventId:string}):Promise<TaskEvent|null> {
      const runs=await db.selectFrom('routines_v1_dispatches').select('dispatch_id').where('agent_id','=',input.agentId).where('conversation_id','=',input.conversationId).where('run_as_user_id','=',input.actorUserId).where('completed_at','is',null).limit(2).execute();
      if (runs.length!==1) return null;
      return (await entries({agentId:input.agentId,dispatchId:runs[0]!.dispatch_id,actorUserId:input.actorUserId})).find(event=>event.eventId===input.eventId) ?? null;
    },
    async taskEventReferences(candidates:string[]):Promise<BlobRef[]> {
      if (!candidates.length) return [];
      return (await db.selectFrom('routines_v1_task_events').select(['blob_ref','owner_user_id']).where('blob_ref','in',candidates).execute()).map(row=>({sha256:row.blob_ref!,userIds:[row.owner_user_id]}));
    },
  };
}
