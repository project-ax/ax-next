import { describe,expect,it,vi } from 'vitest';
import { HookBus } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { createRepeatDeliveryPump } from '../repeat-runtime.js';
import type { RepeatDeliveryStore } from '../repeat-deliveries.js';
import type { RoutinesStore } from '../store.js';
import type { AcceptedDispatch,StoredRoutine } from '../types.js';
const row:StoredRoutine={...RoutineDefinitionSchema.parse({name:'Job',promptBody:'Review',schedule:null,webhook:{kind:'webhook',path:'/hook'}}),agentId:'a',routineId:'r',revision:'v',ownerUserId:'owner',definitionId:null,definitionUpdatedAt:null,nextRunAt:null,lastRunAt:null,lastStatus:null,lastError:null,lastWarning:null,task:null,noRecentUpdate:null,steps:[],finishBy:null,finishByTimeZone:null,done:null};
const accepted:AcceptedDispatch={row,dispatchId:'d',reqId:'req',source:'webhook',acceptedAt:new Date('2026-10-26')};
function fixture(saved=row){
 const bus=new HookBus();bus.registerService('blob:get','test',async()=>({bytes:Buffer.from(JSON.stringify({row:saved,payload:{secret:'PRIVATE'}}))}));
 const claim=vi.fn().mockResolvedValueOnce({deliveryId:'q',blobRef:'a'.repeat(64),accepted}).mockResolvedValue(null);
 const expired=vi.fn(async()=>[] as Array<{dispatch_id:string;agent_id:string;run_as_user_id:string;conversation_id:string|null;executor_released:boolean}>);
 const settle=vi.fn(async()=>{}),finishDispatch=vi.fn(async()=>true),fire=vi.fn(async()=>({status:'ok' as const,error:null,renderedPrompt:null}));
 const pump=createRepeatDeliveryPump({bus,deliveries:{claim,expired,settle,deferRecovery:async()=>{}} as unknown as RepeatDeliveryStore,store:{finishDispatch} as unknown as RoutinesStore,fire,now:()=>new Date('2026-10-26')});
 return{bus,claim,expired,settle,finishDispatch,fire,pump};
}
describe('repeat queue worker authority and uncertain claims',()=>{
 it.each(['running','unknown','unavailable','fence-failed'])('retains capacity when recovery observes %s',async(state)=>{
   const f=fixture();f.claim.mockReset().mockResolvedValue(null);
   f.expired.mockResolvedValue([{dispatch_id:'foreign',agent_id:'a',run_as_user_id:'owner',conversation_id:'c',executor_released:false}]);
   f.bus.registerService('conversations:get-metadata','test',async()=>({activeSessionId:'live-session'}));
   f.bus.registerService('sandbox:session-status','test',async()=>{if(state==='unavailable')throw Error('PRIVATE provider error');return{state:state==='fence-failed'?'stopped':state};});
   const terminate=vi.fn(async()=>{if(state==='fence-failed')throw Error('PRIVATE fence error');return{};});
   f.bus.registerService('session:terminate','test',terminate);
   await f.pump();expect(f.finishDispatch).not.toHaveBeenCalled();
   expect(terminate).toHaveBeenCalledTimes(state==='fence-failed'?1:0);
 });
 it('fences a stopped runner before recovering an expired run with stale conversation pointers',async()=>{
   const f=fixture();f.claim.mockReset().mockResolvedValue(null);
   f.expired.mockResolvedValue([{dispatch_id:'abandoned',agent_id:'a',run_as_user_id:'owner',conversation_id:'c',executor_released:false}]);
   f.bus.registerService('conversations:get-metadata','test',async()=>({activeSessionId:'stale-session'}));
   f.bus.registerService('sandbox:session-status','test',async(_ctx,input)=>{expect(input).toEqual({sessionId:'stale-session'});return{state:'stopped'};});
   const terminate=vi.fn(async()=>{expect(f.finishDispatch).not.toHaveBeenCalled();return{};});
   f.bus.registerService('session:terminate','test',terminate);
   await f.pump();
   expect(terminate).toHaveBeenCalledWith(expect.objectContaining({agentId:'a',userId:'owner'}),{sessionId:'stale-session'});
   expect(f.finishDispatch).toHaveBeenCalledWith(expect.objectContaining({dispatchId:'abandoned',onlyIfExpired:{conversationId:'c'},outcome:expect.objectContaining({status:'error',renderedPrompt:null})}));
 });
 it('joins concurrent drains and invokes the pinned payload once',async()=>{const f=fixture();await Promise.all([f.pump(),f.pump()]);expect(f.fire).toHaveBeenCalledTimes(1);expect(f.fire).toHaveBeenCalledWith(accepted,{secret:'PRIVATE'});});
 it.each([{ownerUserId:'peer'},{promptBody:'Different accepted config'}])('refuses a mismatched blob without reflecting its content',async(over)=>{const f=fixture({...row,...over});await f.pump();expect(f.fire).not.toHaveBeenCalled();expect(f.finishDispatch).toHaveBeenCalledWith({dispatchId:'d',outcome:expect.objectContaining({status:'error',renderedPrompt:null})});expect(JSON.stringify(f.finishDispatch.mock.calls)).not.toContain('PRIVATE');});
 it('does not free a foreign live execution; accounts only a proven inactive one',async()=>{
   const f=fixture();f.claim.mockReset().mockResolvedValue(null);
   f.expired.mockResolvedValue([{dispatch_id:'foreign',agent_id:'a',run_as_user_id:'owner',conversation_id:'c',executor_released:false}]);
   const metadata=vi.fn(async()=>({activeSessionId:'live' as string|null}));f.bus.registerService('conversations:get-metadata','test',metadata);
   await f.pump();expect(f.finishDispatch).not.toHaveBeenCalled();metadata.mockResolvedValue({activeSessionId:null});await f.pump();expect(f.finishDispatch).toHaveBeenCalledTimes(1);expect(f.finishDispatch.mock.calls[0]![0].dispatchId).toBe('foreign');
 });
});
