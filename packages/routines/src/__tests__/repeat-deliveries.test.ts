import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { createRoutinesStore } from '../store.js';
import { createRepeatDeliveryStore } from '../repeat-deliveries.js';
import { createHash } from 'node:crypto';
const f = fixture();
const blobs = new Map<string, Uint8Array>();
const persist = async (bytes: Uint8Array) => { const sha256 = createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256, bytes); return { sha256, size: bytes.length }; };
const queue = () => createRepeatDeliveryStore(f.db, 'test-executor');
async function row(name = 'Repeat', owner = 'owner', agentId = 'a') {
  return f.store.createAuthored({ ...createInput(name), agentId, ownerUserId: owner, definition: RoutineDefinitionSchema.parse({ name, promptBody: 'Review {{payload.title}}', schedule: { kind: 'interval', every: '60s' }, webhook: { kind: 'webhook', path: `/${name}` } }) });
}
describe('durable repeat admission across real connections', () => {
  it('atomically caps all dispatch sources at three and refuses without a receipt', async () => {
    const r = await row();
    const stores = Array.from({ length: 9 }, () => createRoutinesStore(f.db));
    const results = await Promise.allSettled(stores.map((s, i) => s.acceptDispatch({ ...r, expectedRevision: r.revision, actorUserId: 'owner', source: ['manual', 'tick', 'webhook'][i % 3] as 'manual', requestId: `run-${i}`, now })));
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(x => x.status === 'rejected')).toHaveLength(6);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_requests WHERE operation='dispatch'`.execute(f.db)).rows[0]!.n).toBe(3);
  });
  it('deduplicates concurrent IDs, survives a new store and claims each item only once in FIFO order', async () => {
    const r = await row();
    const admissions = await Promise.all(Array.from({ length: 6 }, () => queue().admit({ row: r, payload: { title: 'private' }, deliveryId: 'same', now }, persist)));
    expect(admissions.filter(x => x === 'accepted')).toHaveLength(1);
    expect(admissions.filter(x => x === 'duplicate')).toHaveLength(5);
    await queue().admit({ row: r, payload: { title: 'second' }, deliveryId: 'second', now }, persist);
    const claims = await Promise.all(Array.from({ length: 6 }, () => queue().claim(now)));
    const accepted = claims.filter(x => x !== null);
    // Contenders may lose the head lock; a subsequent pass claims the next one.
    const next = await queue().claim(now); if (next) accepted.push(next);
    expect(new Set(accepted.map(x => x.deliveryId)).size).toBe(2);
    expect((await queue().status(r, 'owner')).waiting).toBe(0);
    expect(await queue().claim(now)).toBeNull();
  });
  it('retains overflow and rejects a full queue without poisoning ID retries', async () => {
    const r = await row();
    for (let i = 0; i < 32; i++) expect(await queue().admit({ row: r, payload: { i }, deliveryId: `id-${i}`, now }, persist)).toBe('accepted');
    expect(await queue().admit({ row: r, payload: {}, deliveryId: 'retry', now }, persist)).toBe('full');
    const first = (await queue().claim(now))!;
    await f.store.finishDispatch({ dispatchId: first.accepted.dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: 'PRIVATE', warning: null } });
    await queue().settle(now);
    expect(await queue().admit({ row: r, payload: {}, deliveryId: 'retry', now }, persist)).toBe('accepted');
    expect((await f.store.recentFires({ ...r, actorUserId: 'owner' }))[0]!.renderedPrompt).toBeNull();
  });
  it('claims FIFO and keeps deliveries without an ID independent', async () => {
    const r=await row();
    for(const title of ['first','second','second'])expect(await queue().admit({row:r,payload:{title},deliveryId:null,now},persist)).toBe('accepted');
    const titles=[];
    for(let i=0;i<3;i++){
      const claim=(await queue().claim(now))!;
      titles.push(JSON.parse(Buffer.from(blobs.get(claim.blobRef)!).toString()).payload.title);
    }
    expect(titles).toEqual(['first','second','second']);
    expect((await queue().status(r,'owner')).active).toBe(3);
  });
  it('bounds owner bytes across tasks and rolls back admission on storage refusal', async () => {
    const a = await row('a'), b = await row('b');
    const large = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 7; i++) expect(await queue().admit({ row: a, payload: large, deliveryId: `${i}`, now }, persist)).toBe('accepted');
    expect(await queue().admit({ row: b, payload: large, deliveryId: 'too-large', now }, persist)).toBe('full');
    await expect(queue().admit({ row: b, payload: {}, deliveryId: 'quota', now }, async () => { throw new Error('quota'); })).rejects.toThrow('quota');
    expect(await queue().admit({ row: b, payload: {}, deliveryId: 'quota', now }, persist)).toBe('accepted');
  });
  it('keeps a paused queue, resumes unchanged config, and safely accounts for edited private inputs', async () => {
    let r = await row();
    await queue().admit({ row: r, payload: { secret: 'PRIVATE' }, deliveryId: 'one', now }, persist);
    r = await f.store.updateAuthored({ ...r, expectedRevision: r.revision, actorUserId: 'owner', requestId: 'pause', patch: { enabled: false }, now, stopOnly: true });
    expect(await queue().claim(now)).toBeNull();
    expect(await queue().admit({row:r,payload:{},deliveryId:'one',now},persist)).toBe('duplicate');
    expect(await queue().admit({row:r,payload:{},deliveryId:'new-paused',now},persist)).toBe('missing');
    r = await f.store.updateAuthored({ ...r, expectedRevision: r.revision, actorUserId: 'owner', requestId: 'resume', patch: { enabled: true }, now, stopOnly: false });
    expect(await queue().claim(now)).not.toBeNull();
    await queue().admit({ row: r, payload: { secret: 'PRIVATE' }, deliveryId: 'two', now }, persist);
    await f.store.updateAuthored({ ...r, expectedRevision: r.revision, actorUserId: 'owner', requestId: 'edit', patch: { promptBody: 'Different instructions' }, now, stopOnly: false });
    expect(await queue().claim(now)).toBeNull();
    expect((await queue().status(r, 'owner')).waiting).toBe(0);
    const history = await f.store.recentFires({ ...r, actorUserId: 'owner' });
    expect(JSON.stringify(history)).not.toContain('PRIVATE');
    expect(history.some(x => x.status === 'error')).toBe(true);
  });
  it('keeps IDs in each task namespace and expires settled metadata after seven days', async () => {
    const a = await row('a'), b = await row('b');
    for (const r of [a,b]) expect(await queue().admit({ row: r, payload: {}, deliveryId: 'same', now }, persist)).toBe('accepted');
    const claimed = (await queue().claim(now))!;
    await f.store.finishDispatch({ dispatchId: claimed.accepted.dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: null, warning: null } });
    await queue().settle(new Date(now.getTime() + 8 * 86400_000));
    expect(await queue().admit({ row: a, payload: {}, deliveryId: 'same', now: new Date(now.getTime() + 8 * 86400_000) }, persist)).toBe('accepted');
  });
});

describe('repeat admission lifecycle and metadata ceilings',()=>{
  it('enforces owner-wide delivery counts across tasks without blocking another owner',async()=>{
    const a=await row('a'),b=await row('b'),c=await row('c','owner','other-agent'),peer=await row('peer','peer');
    for(const r of [a,b])for(let i=0;i<32;i++)expect(await queue().admit({row:r,payload:{i},deliveryId:null,now},persist)).toBe('accepted');
    expect(await queue().admit({row:c,payload:{},deliveryId:'retry',now},persist)).toBe('full');
    expect(await queue().admit({row:peer,payload:{},deliveryId:'retry',now},persist)).toBe('accepted');
  });
  it('does not evict unexpired dedupe metadata to accept a new ID',async()=>{
    const r=await row();await queue().admit({row:r,payload:{},deliveryId:'existing',now},persist);
    await sql`INSERT INTO routines_v1_deliveries(delivery_id,agent_id,routine_id,owner_user_id,accepted_at,expires_at,github_id_hash,configuration_hash,byte_length,completed_at)
      SELECT 'seed-'||n,${r.agentId},${r.routineId},'owner',${now},${new Date(now.getTime()+7*86400_000)},md5(n::text)||md5(n::text),'seed',0,${now} FROM generate_series(1,2047)n`.execute(f.db);
    expect(await queue().admit({row:r,payload:{},deliveryId:'new',now},persist)).toBe('full');
    expect(await queue().admit({row:r,payload:{},deliveryId:'existing',now},persist)).toBe('duplicate');
  });
  it('bounds settled ID metadata for one owner across agents and tasks',async()=>{
    const r=await row();
    await sql`INSERT INTO routines_v1_deliveries(delivery_id,agent_id,routine_id,owner_user_id,accepted_at,expires_at,github_id_hash,configuration_hash,byte_length,completed_at)
      SELECT 'seed-'||n,'other-agent','task-'||(n/1000),'owner',${now},${new Date(now.getTime()+7*86400_000)},md5(n::text)||md5(n::text),'seed',0,${now} FROM generate_series(1,10000)n`.execute(f.db);
    expect(await queue().admit({row:r,payload:{},deliveryId:'new',now},persist)).toBe('full');
  });
  it.each(['owner','kind','webhook'] as const)('accounts for %s invalidation without invoking or revealing accepted private payloads',async(change)=>{
    const r=await row();await queue().admit({row:r,payload:{secret:'PRIVATE'},deliveryId:'private',now},persist);
    if(change==='owner')await f.store.reconcileOwners({agents:[{agentId:r.agentId,ownerUserId:'peer'}]});
    else await f.store.updateAuthored({...r,expectedRevision:r.revision,actorUserId:'owner',requestId:'invalidate',patch:change==='kind'?{kind:'stay-on-top',goodWhen:'Queue clear.',schedule:{kind:'interval',every:'15m'},webhook:null}:{webhook:null},now,stopOnly:false});
    expect(await queue().claim(now)).toBeNull();
    const stored=(await sql<{blob_ref:string|null;completed_at:Date|null}>`SELECT blob_ref,completed_at FROM routines_v1_deliveries`.execute(f.db)).rows[0]!;
    expect(stored.blob_ref).toBeNull();expect(stored.completed_at).not.toBeNull();
    expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM routines_v1_dispatches`.execute(f.db)).rows[0]!.n).toBe(0);
    expect(JSON.stringify((await sql`SELECT error,rendered_prompt FROM routines_v1_fires`.execute(f.db)).rows)).not.toContain('PRIVATE');
  });
  it('deletion and agent retirement release only their queued references',async()=>{
    const a=await row('a'),b=await row('b');for(const r of [a,b])await queue().admit({row:r,payload:{secret:'PRIVATE'},deliveryId:'one',now},persist);
    await f.store.deleteAuthored({...a,actorUserId:'owner',expectedRevision:a.revision,requestId:'delete'});
    expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM routines_v1_deliveries`.execute(f.db)).rows[0]!.n).toBe(1);
    await f.store.purgeAgent(a.agentId);
    expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM routines_v1_deliveries`.execute(f.db)).rows[0]!.n).toBe(0);
  });
  it('keeps a live foreign repeat reservation during another host startup and stamps immutable repeat kind',async()=>{
    const r=await row();await queue().admit({row:r,payload:{},deliveryId:'one',now},persist);const claim=(await queue().claim(now))!;
    expect(await createRoutinesStore(f.db,'foreign-host').interruptAbandonedDispatches()).toBe(0);
    const raw=await f.db.selectFrom('routines_v1_dispatches').select(['kind','executor_id']).where('dispatch_id','=',claim.accepted.dispatchId).executeTakeFirstOrThrow();
    expect(raw).toEqual({kind:'repeat',executor_id:'test-executor'});expect(await queue().claim(now)).toBeNull();
  });
  it('rechecks heartbeat and conversation binding under the recovery lock',async()=>{
    const r=await row();await queue().admit({row:r,payload:{},deliveryId:'one',now},persist);const claim=(await queue().claim(now))!;
    const interrupted={status:'error' as const,error:'Interrupted',conversationId:null,renderedPrompt:null,warning:null};
    await f.db.updateTable('routines_v1_dispatches').set({lease_expires_at:new Date(0)}).where('dispatch_id','=',claim.accepted.dispatchId).execute();
    expect(await queue().expired()).toHaveLength(1);
    await queue().renew();
    expect(await f.store.finishDispatch({dispatchId:claim.accepted.dispatchId,onlyIfExpired:{conversationId:null},outcome:interrupted})).toBe(false);
    await f.db.updateTable('routines_v1_dispatches').set({lease_expires_at:new Date(0)}).where('dispatch_id','=',claim.accepted.dispatchId).execute();
    await f.store.bindDispatchConversation({dispatchId:claim.accepted.dispatchId,conversationId:'bound-after-observation'});
    expect(await f.store.finishDispatch({dispatchId:claim.accepted.dispatchId,onlyIfExpired:{conversationId:null},outcome:interrupted})).toBe(false);
    expect(await f.store.finishDispatch({dispatchId:claim.accepted.dispatchId,onlyIfExpired:{conversationId:'bound-after-observation'},outcome:interrupted})).toBe(true);
  });
  it('releases only the shutting-down executor reservations',async()=>{
    const r=await row();await queue().admit({row:r,payload:{},deliveryId:'one',now},persist);const own=(await queue().claim(now))!;
    const foreign=(await createRoutinesStore(f.db,'foreign-host').acceptDispatch({...r,expectedRevision:r.revision,actorUserId:'owner',source:'manual',requestId:'foreign',now}))!;
    await queue().release();
    const released=await f.db.selectFrom('routines_v1_dispatches').select(['dispatch_id','executor_released']).orderBy('dispatch_id').execute();
    expect(released.find(x=>x.dispatch_id===own.accepted.dispatchId)?.executor_released).toBe(true);
    expect(released.find(x=>x.dispatch_id===foreign.accepted.dispatchId)?.executor_released).toBe(false);
    expect((await queue().expired()).map(x=>x.dispatch_id)).toEqual([own.accepted.dispatchId]);
  });
});
