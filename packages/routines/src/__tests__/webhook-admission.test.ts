import { describe, expect, it, vi } from 'vitest';
import { HookBus, registerBlobPutFacade, reject } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { createHmac } from 'node:crypto';
import { createWebhookRouter, type HttpRequest } from '../webhook-handler.js';
import type { StoredRoutine } from '../types.js';
import type { RoutinesStore } from '../store.js';
import type { RepeatDeliveryStore } from '../repeat-deliveries.js';
const row: StoredRoutine = { ...RoutineDefinitionSchema.parse({name:'Hook',promptBody:'Review',webhook:{kind:'webhook',path:'/hook',events:['push'],hmac:{header:'sig',algorithm:'sha256'}},schedule:null}),agentId:'a',routineId:'r',revision:'v',ownerUserId:'owner',definitionId:null,definitionUpdatedAt:null,nextRunAt:null,lastRunAt:null,lastStatus:null,lastError:null,lastWarning:null,task:null,noRecentUpdate:null,steps:[],finishBy:null,finishByTimeZone:null,done:null };
function fixture(result: 'accepted'|'duplicate'|'full'|'missing'='accepted') {
  const bus=new HookBus(),writes=vi.fn(async()=>({sha256:'a'.repeat(64),size:1}));
  bus.registerService('agents:resolve-by-webhook-token','test',async()=>({agent:{id:'a'}}));
  bus.registerService('credentials:get','test',async()=> 'secret');
  bus.registerService('blob:put-internal','test',writes); registerBlobPutFacade(bus,'test');
  const admit=vi.fn(async(_input:unknown,persist:(bytes:Uint8Array,owner:string)=>Promise<unknown>)=> { if(result==='accepted')await persist(new Uint8Array([1]),'owner'); return result; });
  const pump=vi.fn(async()=>{});
  const handler=createWebhookRouter({bus,store:{findWebhook:async()=>row} as unknown as RoutinesStore,deliveries:{admit} as unknown as RepeatDeliveryStore,pump,now:()=>new Date('2026-10-26')});
  return {bus,writes,admit,pump,handler};
}
function request(over:Partial<HttpRequest>={}):HttpRequest {
  const body=Buffer.from('{"private":"payload"}');
  return {path:'/webhooks/token/hook',rawPath:'/webhooks/token/hook',params:{token:'token','*':'hook'},body,headers:{'content-type':'application/json','x-github-event':'push','x-github-delivery':'delivery-1',sig:createHmac('sha256','secret').update(body).digest('hex')},...over};
}
function response(){const state={code:0,ended:false};const res={status(code:number){state.code=code;return res;},end(){state.ended=true;}};return{state,res};}
describe('authenticated webhook durable admission',()=>{
  it('validates signatures, bodies and filtering before any dedupe admission',async()=>{
    const f=fixture();
    for(const headers of [{...request().headers,sig:'invalid'},{...request().headers,'x-github-event':'ignored','x-github-delivery':'bad/id'}]){
      const r=response();await f.handler(request({headers}),r.res);expect(r.state.code).toBe(headers.sig==='invalid'?401:204);
    }
    expect(f.admit).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
  });
  it('rejects oversize bodies and invalid IDs without reserving an ID',async()=>{
    const f=fixture();const large=response();await f.handler(request({body:Buffer.alloc(1024*1024+1)}),large.res);expect(large.state.code).toBe(413);
    const invalid=response();await f.handler(request({headers:{...request().headers,'x-github-delivery':'x'.repeat(129)}}),invalid.res);expect(invalid.state.code).toBe(400);expect(f.admit).not.toHaveBeenCalled();
  });
  it.each([['accepted',202],['duplicate',202],['full',429],['missing',404]] as const)('answers %s truthfully',async(result,code)=>{
    const f=fixture(result),r=response();await f.handler(request(),r.res);expect(r.state.code).toBe(code);
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({row,deliveryId:'delivery-1',payload:{private:'payload'}}),expect.any(Function));
    expect(f.pump).toHaveBeenCalledTimes(result==='accepted'?1:0);
  });
  it('uses the existing quota facade as the pinned creator and never acknowledges its veto',async()=>{
    const f=fixture();let actor='';f.bus.subscribe('blob:pre-put','quota',async ctx=>{actor=ctx.userId;return reject({reason:'PRIVATE quota detail'});});
    const r=response();await f.handler(request(),r.res);expect(r.state.code).toBe(429);expect(actor).toBe('owner');expect(f.writes).not.toHaveBeenCalled();
  });
  it('keeps an already committed admission acknowledged when the pump fails',async()=>{
    const f=fixture();f.pump.mockRejectedValueOnce(new Error('PRIVATE body'));const r=response();await f.handler(request(),r.res);expect(r.state.code).toBe(202);
  });
});
