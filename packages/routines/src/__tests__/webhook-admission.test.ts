import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, SafeToolError, registerBlobPutFacade, reject } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { createHmac } from 'node:crypto';
import { createWebhookRouter, type HttpRequest } from '../webhook-handler.js';
import type { StoredRoutine } from '../types.js';
import type { RoutinesStore } from '../store.js';
import type { RepeatDeliveryStore } from '../repeat-deliveries.js';
const row: StoredRoutine = { ...RoutineDefinitionSchema.parse({name:'Hook',promptBody:'Review',webhook:{kind:'webhook',path:'/hook',events:['push'],hmac:{header:'sig',algorithm:'sha256'}},schedule:null}),agentId:'a',routineId:'r',revision:'v',ownerUserId:'owner',definitionId:null,definitionUpdatedAt:null,nextRunAt:null,lastRunAt:null,lastStatus:null,lastError:null,lastWarning:null,task:null,noRecentUpdate:null,steps:[],finishBy:null,finishByTimeZone:null,done:null };
function fixture(result: 'accepted'|'duplicate'|'full'|'missing'='accepted', sourceRow = row, vault: () => Promise<string> = async () => 'secret') {
  const bus=new HookBus(),writes=vi.fn(async()=>({sha256:'a'.repeat(64),size:1}));
  bus.registerService('agents:resolve-by-webhook-token','test',async()=>({agent:{id:'a'}}));
  bus.registerService('credentials:get','test',vault);
  bus.registerService('blob:put-internal','test',writes); registerBlobPutFacade(bus,'test');
  const admit=vi.fn(async(_input:unknown,persist:(bytes:Uint8Array,owner:string)=>Promise<unknown>)=> { if(result==='accepted')await persist(new Uint8Array([1]),'owner'); return result; });
  const pump=vi.fn(async()=>{});
  const observeWebhook=vi.fn(async()=>true);
  const handler=createWebhookRouter({bus,store:{webhookGeneration:async()=> 'generation',observeWebhook,findWebhook:async()=>sourceRow,findWebhookByToken:async()=>null} as unknown as RoutinesStore,deliveries:{admit} as unknown as RepeatDeliveryStore,pump,now:()=>new Date('2026-10-26')});
  return {bus,writes,admit,pump,handler,observeWebhook};
}
function request(over:Partial<HttpRequest>={}):HttpRequest {
  const body=Buffer.from('{"private":"payload"}');
  return {path:'/webhooks/token/hook',rawPath:'/webhooks/token/hook',params:{token:'token','*':'hook'},body,headers:{'content-type':'application/json','x-github-event':'push','x-github-delivery':'delivery-1',sig:createHmac('sha256','secret').update(body).digest('hex')},...over};
}
function response(){const state={code:0,ended:false};const res={status(code:number){state.code=code;return res;},end(){state.ended=true;},json(){state.ended=true;}};return{state,res};}
const plain:StoredRoutine={...row,webhook:{kind:'webhook',path:'/hook',events:['push']}};
const unsigned=()=>request({headers:{'content-type':'application/json','x-github-event':'push','x-github-delivery':'delivery-1'}});
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
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({row,deliveryId:'delivery-1',payload:{private:'payload'},address:{kind:'legacy',token:'token',generation:'generation'},signature:{app:'other',timestamp:false}}),expect.any(Function),expect.any(Function));
    expect(f.pump).toHaveBeenCalledTimes(result==='accepted'?1:0);
  });
  it('uses the existing quota facade as the pinned creator and never acknowledges its veto',async()=>{
    const f=fixture();let actor='';f.bus.subscribe('blob:pre-put','quota',async ctx=>{actor=ctx.userId;return reject({reason:'PRIVATE quota detail'});});
    const r=response();await f.handler(request(),r.res);expect(r.state.code).toBe(429);expect(actor).toBe('owner');expect(f.writes).not.toHaveBeenCalled();
  });
  it('does not acknowledge a Slack handshake authenticated before setup changed',async()=>{
    const f=fixture('accepted',{...row,webhook:{kind:'webhook',path:'/hook',hmac:{app:'slack'}}});
    f.observeWebhook.mockResolvedValueOnce(false);
    const body=Buffer.from('{"type":"url_verification","challenge":"private-challenge"}'),timestamp=String(new Date('2026-10-26').getTime()/1000);
    const signature=createHmac('sha256','secret').update(`v0:${timestamp}:`).update(body).digest('hex');
    const r=response();await f.handler(request({body,headers:{'content-type':'application/json','x-slack-request-timestamp':timestamp,'x-slack-signature':`v0=${signature}`}}),r.res);
    expect(r.state.code).toBe(404);expect(f.admit).not.toHaveBeenCalled();
    expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({observation:'verified',signature:{app:'slack',timestamp:true}}),expect.any(Function));
  });
  describe('the saved secret decides (TASK-1026)',()=>{
    const missing=async():Promise<string>=>{throw new PluginError({plugin:'@ax/credentials',code:'credential-not-found',message:'no credential'});};
    it('accepts an unsigned update when no secret is saved, recording no signature',async()=>{
      const f=fixture('accepted',plain,missing),r=response();await f.handler(unsigned(),r.res);
      expect(r.state.code).toBe(202);
      expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({signature:null}),expect.any(Function),expect.any(Function));
    });
    // TASK-1027: a setting saved before TASK-1026 is parsed and ignored. Only a saved secret turns checks on.
    it('ignores a signature setting saved earlier: with no secret saved, an update is accepted unchecked',async()=>{
      expect(row.webhook?.hmac).toEqual({header:'sig',algorithm:'sha256'});
      const f=fixture('accepted',row,missing);
      for(const make of [()=>request(),unsigned]){
        const r=response();await f.handler(make(),r.res);
        expect(r.state.code).toBe(202);
      }
      expect(f.admit).toHaveBeenCalledTimes(2);
      expect(f.admit).toHaveBeenNthCalledWith(1,expect.objectContaining({signature:null}),expect.any(Function),expect.any(Function));
      expect(f.admit).toHaveBeenNthCalledWith(2,expect.objectContaining({signature:null}),expect.any(Function),expect.any(Function));
      expect(f.observeWebhook).not.toHaveBeenCalled();
    });
    it.each([
      ['an unsigned update, once a secret is saved',plain,async()=>'secret',unsigned,'signature'],
      ['a wrongly signed update, once a secret is saved',plain,async()=>'secret',()=>request({headers:{...request().headers,sig:createHmac('sha256','wrong').update(request().body).digest('hex')}}),'signature'],
      ['any update when the vault answers with an empty secret',plain,async()=>'',()=>request(),'secret'],
      ['a Slack URL check that did not verify as Slack, with no secret saved',plain,missing,()=>request({body:Buffer.from('{"type":"url_verification","challenge":"c"}')}),'secret'],
      ['a Slack URL check signed as another app',plain,async()=>'secret',()=>{const body=Buffer.from('{"type":"url_verification","challenge":"c"}');return request({body,headers:{...request().headers,sig:createHmac('sha256','secret').update(body).digest('hex')}});},'signature'],
    ] as const)('refuses %s',async(_name,source,vault,make,reason)=>{
      const f=fixture('accepted',source,vault),r=response();await f.handler(make(),r.res);
      expect(r.state.code).toBe(401);
      expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({observation:reason}),expect.any(Function));
      expect(f.admit).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
    });
    /** A vault that fails with `failure`, recording the handler's secret-read warnings from the context it was called with. */
    const failing=(failure:()=>never)=>{
      const warnings:Array<{message:string;fields:unknown}>=[];
      const vault=(async(ctx:{logger:{warn:(message:string,fields?:Record<string,unknown>)=>void}})=>{
        const warn=ctx.logger.warn.bind(ctx.logger);
        ctx.logger.warn=(message,fields)=>{if(message==='routines_webhook_secret_fetch_failed')warnings.push({message,fields});else warn(message,fields);};
        return failure();
      }) as unknown as ()=>Promise<string>;
      return {vault,warnings};
    };
    const vaultError=(code:string)=>()=>{throw new PluginError({plugin:'@ax/credentials',code,message:'PRIVATE vault detail'});};
    // A vault outage is the host's problem, not the sender's: a 503 the app retries, never a 401 it gives up on.
    it.each([
      ['a slow vault','timeout',vaultError('timeout')],
      ['no vault loaded','no-service',vaultError('no-service')],
      // The bus wraps a plain thrown Error (a lost database connection, say) as code `unknown`.
      ['a failure the bus reports as unknown','unknown',()=>{throw new Error('PRIVATE vault detail');}],
    ] as const)('asks the sender to retry when the secret can’t be read: %s',async(_name,code,failure)=>{
      const {vault,warnings}=failing(failure);
      const f=fixture('accepted',plain,vault),r=response();await f.handler(request(),r.res);
      expect(r.state.code).toBe(503);
      expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({observation:'unavailable'}),expect.any(Function));
      expect(warnings).toEqual([{message:'routines_webhook_secret_fetch_failed',fields:{agentId:'a',routineId:'r',code}}]);
      expect(f.admit).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
    });
    // A saved secret that can't be used won't fix itself on a retry: a 401 whose status tells the owner to save it again.
    it.each(['decrypt-failed','invalid-ciphertext','invalid-envelope','unsupported-credential-kind'])('refuses, asking for the secret again, when the saved secret is unusable: %s',async code=>{
      const {vault,warnings}=failing(vaultError(code));
      const f=fixture('accepted',plain,vault),r=response();await f.handler(request(),r.res);
      expect(r.state.code).toBe(401);
      expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({observation:'secret'}),expect.any(Function));
      expect(warnings).toEqual([{message:'routines_webhook_secret_fetch_failed',fields:{agentId:'a',routineId:'r',code}}]);
      expect(f.admit).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
    });
    // Unreachable through a real HookBus (it wraps every throw as a plugin error), but a bus that hands
    // back a bare Error must still fail closed as `secret`, never as a retry or an unsigned acceptance.
    it('refuses as secret, logging no code, when the secret read fails with something that is not a plugin error',async()=>{
      const f=fixture('accepted',plain,async()=>'secret'),r=response(),warnings:unknown[]=[];
      const real=f.bus.callJoined.bind(f.bus);
      vi.spyOn(f.bus,'callJoined').mockImplementation((async(name:string,ctx:{logger:{warn:(message:string,fields?:Record<string,unknown>)=>void}},input:unknown)=>{
        if(name!=='credentials:get')return real(name,ctx as never,input);
        ctx.logger.warn=(message,fields)=>{if(message==='routines_webhook_secret_fetch_failed')warnings.push({message,fields});};
        throw new Error('PRIVATE vault detail');
      }) as never);
      await f.handler(request(),r.res);
      expect(r.state.code).toBe(401);
      expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({observation:'secret'}),expect.any(Function));
      expect(warnings).toEqual([{message:'routines_webhook_secret_fetch_failed',fields:{agentId:'a',routineId:'r'}}]);
      expect(f.admit).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
    });
  });
  it('keeps an already committed admission acknowledged when the pump fails',async()=>{
    const f=fixture();f.pump.mockRejectedValueOnce(new Error('PRIVATE body'));const r=response();await f.handler(request(),r.res);expect(r.state.code).toBe(202);
  });
});
// Each 503 the sender retries logs a code an operator can search for. Never the failure's message, which
// can quote the request: `createLogger` prints an Error field with its message and stack.
describe('a 503 logs its code, never its message (TASK-1027)',()=>{
  afterEach(()=>{vi.restoreAllMocks();});
  /** TASK-1024's capture: the default logger writes each entry to stdout as one JSON line. */
  function captureStdout():()=>string{
    const lines:string[]=[];
    vi.spyOn(process.stdout,'write').mockImplementation((chunk:unknown)=>{lines.push(String(chunk));return true;});
    return ()=>lines.join('');
  }
  /** The captured entries named `msg`, without the `ts` and `reqId` every entry carries. */
  const entries=(logged:string,msg:string)=>logged.split('\n').filter(l=>l.startsWith('{"')).map(l=>JSON.parse(l) as Record<string,unknown>)
    .filter(entry=>entry.msg===msg).map(entry=>Object.fromEntries(Object.entries(entry).filter(([key])=>key!=='ts'&&key!=='reqId')));
  const failure=(code:string,message:string)=>new PluginError({plugin:'@ax/routines',code,message});
  const pluginFault={name:'PluginError',plugin:'@ax/routines'};
  const safeTool=()=>new SafeToolError('unavailable','input');
  const safeToolFields={code:'unavailable',name:'PluginError',plugin:'@ax/core'};
  /** What the bus throws when a service fails: `unknown`, with the real failure as its cause. */
  const busWrap=()=>new PluginError({plugin:'@ax/blob-fs',hookName:'blob:put',code:'unknown',message:'PRIVATE wrap',cause:Object.assign(new Error('PRIVATE cause'),{code:'ENOSPC'})});
  const busWrapFields={code:'unknown',causeCode:'ENOSPC',name:'PluginError',causeName:'Error',hookName:'blob:put',plugin:'@ax/blob-fs'};
  it.each([
    ['a plugin error',failure('timeout','PRIVATE observe detail'),{code:'timeout',...pluginFault}],
    ['a database error',Object.assign(new Error('PRIVATE row detail'),{code:'40P01'}),{code:'40P01',name:'Error'}],
    ['an error with no code',new Error('PRIVATE detail'),{name:'Error'}],
    ['a SafeToolError',safeTool(),safeToolFields],
  ] as const)('logs %s when a refusal can’t be recorded',async(_name,error,fields)=>{
    const logged=captureStdout(),f=fixture('accepted',plain);f.observeWebhook.mockRejectedValueOnce(error);
    const r=response();await f.handler(unsigned(),r.res);
    expect(r.state.code).toBe(503);
    expect(logged()).not.toContain('PRIVATE');
    expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({observation:'signature'}),expect.any(Function));
    // Exactly these fields: with no code to log, the entry has no `code` at all.
    expect(entries(logged(),'routines_webhook_observe_failed')).toStrictEqual([{msg:'routines_webhook_observe_failed',level:'warn',agentId:'a',routineId:'r',observation:'signature',...fields}]);
  });
  it('logs when a too-large update’s refusal can’t be recorded, before any secret read',async()=>{
    const logged=captureStdout(),vault=vi.fn(async()=>'secret'),f=fixture('accepted',plain,vault);
    f.observeWebhook.mockRejectedValueOnce(failure('timeout','PRIVATE observe detail'));
    // This refusal comes before the secret read, so its log must not reach for a context declared after it (a TDZ ReferenceError).
    const r=response();await expect(f.handler(request({body:Buffer.alloc(1024*1024+1)}),r.res)).resolves.toBeUndefined();
    expect(r.state.code).toBe(503);
    expect(logged()).not.toContain('PRIVATE');
    expect(vault).not.toHaveBeenCalled();
    expect(entries(logged(),'routines_webhook_observe_failed')).toStrictEqual([{msg:'routines_webhook_observe_failed',level:'warn',agentId:'a',routineId:'r',observation:'too-large',code:'timeout',...pluginFault}]);
  });
  it('logs when a verified Slack address check can’t be recorded',async()=>{
    const logged=captureStdout(),f=fixture('accepted',{...row,webhook:{kind:'webhook',path:'/hook'}});
    f.observeWebhook.mockRejectedValueOnce(failure('unknown','PRIVATE observe detail'));
    const body=Buffer.from('{"type":"url_verification","challenge":"private-challenge"}'),timestamp=String(new Date('2026-10-26').getTime()/1000);
    const signature=createHmac('sha256','secret').update(`v0:${timestamp}:`).update(body).digest('hex');
    const r=response();await f.handler(request({body,headers:{'content-type':'application/json','x-slack-request-timestamp':timestamp,'x-slack-signature':`v0=${signature}`}}),r.res);
    expect(r.state.code).toBe(503);
    expect(logged()).not.toContain('PRIVATE');
    expect(entries(logged(),'routines_webhook_observe_failed')).toStrictEqual([{msg:'routines_webhook_observe_failed',level:'warn',agentId:'a',routineId:'r',observation:'verified',code:'unknown',...pluginFault}]);
  });
  it('logs a failed admission’s code and still records it as unavailable',async()=>{
    const logged=captureStdout(),f=fixture('accepted',plain);
    f.admit.mockRejectedValueOnce(busWrap());
    const r=response();await f.handler(request(),r.res);
    expect(r.state.code).toBe(503);
    expect(logged()).not.toContain('PRIVATE');
    expect(entries(logged(),'routines_webhook_admission_failed')).toStrictEqual([{msg:'routines_webhook_admission_failed',level:'warn',agentId:'a',routineId:'r',...busWrapFields}]);
    expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({observation:'unavailable'}),expect.any(Function));
  });
  it('logs nothing for a quota refusal',async()=>{
    const logged=captureStdout(),f=fixture('accepted',plain);
    f.admit.mockRejectedValueOnce(Object.assign(new Error('PRIVATE quota detail'),{code:'rejected'}));
    const r=response();await f.handler(request(),r.res);
    expect(r.state.code).toBe(429);
    expect(logged()).not.toContain('PRIVATE');
    expect(entries(logged(),'routines_webhook_admission_failed')).toEqual([]);
  });
  // Not a 503: the update is already admitted, so the sender gets its 202 and only the log says the drain failed.
  describe('the drain after an accepted repeat update logs its code too (TASK-1033)',()=>{
    it.each([
      ['a plugin error',failure('timeout','PRIVATE drain detail'),{code:'timeout',...pluginFault}],
      ['a database error',Object.assign(new Error('PRIVATE drain detail'),{code:'40P01'}),{code:'40P01',name:'Error'}],
      ['an error with no code',new Error('PRIVATE drain detail'),{name:'Error'}],
      ['a SafeToolError',safeTool(),safeToolFields],
    ] as const)('logs %s from a failed drain without its message, still answering 202',async(_name,error,fields)=>{
      const logged=captureStdout(),f=fixture('accepted',plain);
      f.pump.mockRejectedValueOnce(error);
      const r=response();await f.handler(request(),r.res);
      expect(r.state.code).toBe(202);
      expect(logged()).not.toContain('PRIVATE');
      expect(entries(logged(),'repeat_queue_drain_failed')).toStrictEqual([{msg:'repeat_queue_drain_failed',level:'warn',agentId:'a',routineId:'r',...fields}]);
    });
  });
});
