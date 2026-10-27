import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, now, createInput } from './store-fixture.js';
import { createRoutinesStore } from '../store.js';
import { createRepeatDeliveryStore } from '../repeat-deliveries.js';
import { TASK_EVENT_LIMITS } from '../task-events.js';
import type { StoredRoutine } from '../types.js';
const f=fixture({max:3,connectionTimeoutMillis:2000});
const at=(minutes:number)=>new Date(now.getTime()+minutes*60_000);
async function task(kind:'stay-on-top'|'get-done'='stay-on-top') {
  return f.store.createAuthored({...createInput(),definition:RoutineDefinitionSchema.parse({name:'Support',promptBody:'Keep tickets answered.',goodWhen:'No ticket waits.',kind,schedule:{kind:'interval',every:'1h'},webhook:{kind:'webhook',path:'/support',respondWithin:'5m'}})});
}
const blobs=new Map<string,string>();
async function persist(bytes:Uint8Array) {const sha256=createHash('sha256').update(bytes).digest('hex');blobs.set(sha256,Buffer.from(bytes).toString());return {sha256,size:bytes.length};}
const admit=(row:StoredRoutine,n:number,received=now,payload:unknown={n})=>f.store.admitTaskEvent({row,payload,deliveryId:`id-${n}`,now:received},persist);
async function accept(row:StoredRoutine,id='run',when=at(5),executor='one') {
  const result=await createRoutinesStore(f.db,executor).acceptDispatch({...row,actorUserId:'owner',expectedRevision:row.revision,source:'tick',requestId:id,now:when});
  expect(result).not.toBeNull();return result!.accepted;
}
const events=(row:StoredRoutine,id:string)=>f.store.taskEventsForDispatch({agentId:row.agentId,dispatchId:id,actorUserId:'owner'});
const rows=()=>f.db.selectFrom('routines_v1_task_events').selectAll().orderBy('sequence_id').execute();
async function report(row:StoredRoutine,id:string) {await f.store.bindDispatchConversation({dispatchId:id,conversationId:id});return f.store.recordReport({agentId:row.agentId,dispatchId:id,conversationId:id,actorUserId:'owner',report:{status:'on-track',update:'Checked.',ask:null},now:at(6)});}
const finish=(id:string,status:'ok'|'error'='ok')=>f.store.finishDispatch({dispatchId:id,outcome:{status,error:status==='error'?'Failed.':null,conversationId:id,renderedPrompt:null,warning:null}});

describe('durable task update inbox',()=>{
  it.each(['stay-on-top','get-done'] as const)('persists %s before acknowledgment, keeps full bytes and dedupes across a fresh host',async kind=>{
    const row=await task(kind);const large={n:1,body:'é'.repeat(4000)};
    expect(await admit(row,1,now,large)).toBe('accepted');
    const stored=(await rows())[0]!;expect(blobs.get(stored.blob_ref!)).toBe(JSON.stringify(large));
    expect(JSON.stringify(stored)).not.toContain('é');
    expect(await createRoutinesStore(f.db,'two').admitTaskEvent({row,payload:large,deliveryId:'id-1',now:at(1)},vi.fn(persist))).toBe('duplicate');
    expect(await rows()).toHaveLength(1);
    expect((await f.store.findOne(row))?.nextRunAt).toEqual(at(5));
  });
  it('persists20 oldest exact assignments, full reads are bound to current owner/conversation, and late updates stay for the next run',async()=>{
    const row=await task();for(let i=0;i<23;i++)expect(await admit(row,i)).toBe('accepted');
    const run=await accept(row);const batch=await events(row,run.dispatchId);
    expect(batch).toHaveLength(20);expect(batch.map(e=>JSON.parse(blobs.get(e.blobRef)!).n)).toEqual(Array.from({length:20},(_,i)=>i));
    await f.store.bindDispatchConversation({dispatchId:run.dispatchId,conversationId:'bound'});
    const key={agentId:row.agentId,conversationId:'bound',actorUserId:'owner',eventId:batch[0]!.eventId};
    expect(await f.store.readTaskEvent(key)).toEqual(batch[0]);
    for(const override of [{conversationId:'other'},{agentId:'other'},{actorUserId:'peer'},{eventId:'unknown'}]) expect(await f.store.readTaskEvent({...key,...override})).toBeNull();
    expect(await admit(row,23,at(6))).toBe('accepted');
    expect(await events(row,run.dispatchId)).toEqual(batch);
    expect(await f.store.recordReport({agentId:row.agentId,dispatchId:run.dispatchId,conversationId:'bound',actorUserId:'owner',report:{status:'on-track',update:'Checked.',ask:null},now:at(6)})).toBe('recorded');
    expect((await rows()).filter(e=>e.consumed_at===null)).toHaveLength(4);
    expect(await finish(run.dispatchId)).toBe(true);
    expect((await f.store.findOne(row))!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now()+1000);
    const next=await accept(row,'next',at(7));expect((await events(row,next.dispatchId)).map(e=>JSON.parse(blobs.get(e.blobRef)!).n)).toEqual([20,21,22,23]);
  });
  it('a failed check-in releases its exact batch without consuming it, and retries before newer arrivals',async()=>{
    const row=await task();await admit(row,1);const run=await accept(row);const seen=await events(row,run.dispatchId);
    await admit(row,2,at(6));expect(await finish(run.dispatchId,'error')).toBe(true);
    expect((await rows()).every(e=>e.consumed_at===null && e.dispatch_id===null)).toBe(true);
    const retry=await accept(row,'retry',at(10));const batch=await events(row,retry.dispatchId);
    expect(batch[0]!.eventId).toBe(seen[0]!.eventId);expect(batch[1]!.mayBeOwnChange).toBe(true);
  });
  it('a rejected report retains assignments; an accepted report consumes exactly once even if turn end fails',async()=>{
    const row=await task();await admit(row,1);const run=await accept(row);await f.store.bindDispatchConversation({dispatchId:run.dispatchId,conversationId:run.dispatchId});
    const key={agentId:row.agentId,dispatchId:run.dispatchId,conversationId:run.dispatchId,actorUserId:'peer',report:{status:'on-track' as const,update:'Checked.',ask:null},now:at(6)};
    expect(await f.store.recordReport(key)).toBe('owner');expect((await rows())[0]!.consumed_at).toBeNull();
    expect(await f.store.recordReport({...key,actorUserId:'owner'})).toBe('recorded');await finish(run.dispatchId,'error');
    expect((await rows())[0]!.consumed_at).not.toBeNull();expect((await rows())[0]!.blob_ref).toBeNull();
    expect(await admit(row,1,at(8))).toBe('duplicate');
  });
  it('never evicts unseen expired entries and refuses over quota before storing or acknowledging',async()=>{
    const row=await task();await admit(row,1);
    await sql`INSERT INTO routines_v1_task_events(event_id,agent_id,routine_id,owner_user_id,received_at,expires_at,delivery_id_hash,blob_ref,byte_length) SELECT 'filled-'||i,${row.agentId},${row.routineId},${row.ownerUserId},${now},${now},NULL,${'0'.repeat(64)},1 FROM generate_series(1,${TASK_EVENT_LIMITS.pendingPerRoutine-1}) i`.execute(f.db);
    const before=await rows();const write=vi.fn(persist);
    expect(await f.store.admitTaskEvent({row,payload:{},deliveryId:'new',now:at(8*24*60)},write)).toBe('full');expect(write).not.toHaveBeenCalled();expect(await rows()).toEqual(before);
  });
  it('drops no-id ledger rows on a report while retaining bounded durable delivery identifiers',async()=>{
    const row=await task();await f.store.admitTaskEvent({row,payload:{no:'id'},deliveryId:null,now},persist);await admit(row,1);
    const run=await accept(row);await report(row,run.dispatchId);expect(await rows()).toHaveLength(1);expect((await rows())[0]!.delivery_id_hash).not.toBeNull();
  });
  it('serializes all task sources across hosts and does not interrupt another live executor at startup',async()=>{
    const row=await task();const first=await accept(row);await f.store.bindDispatchConversation({dispatchId:first.dispatchId,conversationId:'active'});
    for(const source of ['tick','manual','webhook'] as const) await expect(createRoutinesStore(f.db,'two').acceptDispatch({...row,actorUserId:'owner',expectedRevision:row.revision,requestId:`other-${source}`,source,now:at(6)})).rejects.toMatchObject({toolCode:'busy'});
    expect(await createRoutinesStore(f.db,'two').interruptAbandonedDispatches()).toBe(0);
    expect(await f.store.findOpenDispatchByConversation({agentId:row.agentId,conversationId:'active'})).toHaveProperty('run.dispatchId',first.dispatchId);
    await createRepeatDeliveryStore(f.db,'one').release();expect(await createRoutinesStore(f.db,'two').interruptAbandonedDispatches()).toBe(1);
    expect((await accept(row,'after-release',at(8),'two')).dispatchId).not.toBe(first.dispatchId);
  });
  it('only expires a leased task when the unchanged lease and observed conversation still match',async()=>{
    const row=await task();const run=await accept(row);await f.store.bindDispatchConversation({dispatchId:run.dispatchId,conversationId:'active'});
    await sql`UPDATE routines_v1_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE dispatch_id=${run.dispatchId}`.execute(f.db);
    const expired={dispatchId:run.dispatchId,onlyIfExpired:{conversationId:'active'},outcome:{status:'error' as const,error:'Stopped.',conversationId:null,renderedPrompt:null,warning:null}};
    await createRepeatDeliveryStore(f.db,'one').renew();expect(await f.store.finishDispatch(expired)).toBe(false);
    await sql`UPDATE routines_v1_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE dispatch_id=${run.dispatchId}`.execute(f.db);
    expect(await f.store.finishDispatch({...expired,onlyIfExpired:{conversationId:'wrong'}})).toBe(false);expect(await f.store.finishDispatch(expired)).toBe(true);
  });
  it('resets the full safety interval after manual checks and batches in-run arrivals after the response window',async()=>{
    const row=await task();const run=await accept(row,'manual',at(10));expect((await f.store.findOne(row))?.nextRunAt).toEqual(at(70));
    await admit(row,1,at(11));expect((await f.store.findOne(row))?.nextRunAt).toEqual(at(16));
    await report(row,run.dispatchId);await finish(run.dispatchId);expect((await f.store.findOne(row))?.nextRunAt).toEqual(at(16));
  });
  it('queues owner replies durably through a busy check-in and clears their request on the next accepted check-in',async()=>{
    const row=await task();const run=await accept(row);
    expect(await f.store.requestTaskCheckIn({...row,actorUserId:'peer',now:at(6)})).toBe('missing');
    expect(await f.store.requestTaskCheckIn({...row,actorUserId:'owner',now:at(6)})).toBe('queued');
    expect(await createRoutinesStore(f.db,'two').hasTaskCheckInRequest(row)).toBe(true);
    await report(row,run.dispatchId);await finish(run.dispatchId);
    expect((await f.store.findOne(row))!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now()+1000);
    await accept(row,'queued',at(7));expect(await f.store.hasTaskCheckInRequest(row)).toBe(false);
  });
  it('clears old inbox reach on owner/kind changes, deletion and agent purge and copies no app connection',async()=>{
    const row=await task();await admit(row,1);const copied=await f.store.duplicateAuthored({...row,actorUserId:'owner',ownerUserId:'owner',requestId:'copy',now});expect(typeof copied).toBe('object');
    if(typeof copied==='object')expect((await f.store.findOne({agentId:row.agentId,routineId:copied.routineId}))?.webhook).toBeNull();
    await f.store.reconcileOwners({agents:[{agentId:row.agentId,ownerUserId:'next'}]});expect(await rows()).toHaveLength(0);
    const current=(await f.store.findOne(row))!;await admit(current,2);await f.store.updateAuthored({...current,actorUserId:'next',expectedRevision:current.revision,requestId:'kind',now,stopOnly:false,patch:{kind:'repeat',goodWhen:null,webhook:{kind:'webhook',path:'/support'}}});expect(await rows()).toHaveLength(0);
    const again=await f.store.createAuthored({...createInput('second'),definition:RoutineDefinitionSchema.parse({name:'Second',promptBody:'Keep tickets answered.',goodWhen:'No ticket waits.',kind:'stay-on-top',schedule:{kind:'interval',every:'1h'},webhook:{kind:'webhook',path:'/second'}})});await admit(again,3);await f.store.purgeAgent(again.agentId);expect(await rows()).toHaveLength(0);
  });
});
