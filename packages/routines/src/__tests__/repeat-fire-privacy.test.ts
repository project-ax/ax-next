import { expect, it, vi } from 'vitest';
import { HookBus } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { createFireRoutine } from '../fire.js';
import type { AcceptedDispatch } from '../types.js';

it('keeps a queued app body out of fire diagnostics and pending history', async () => {
  const bus=new HookBus();
  bus.registerService('agents:resolve','test',async()=>({agent:{id:'a'}}));
  bus.registerService('conversations:create','test',async()=>({conversationId:'c'}));
  const invoke=vi.fn(async()=>{throw new Error('PRIVATE body from provider');});
  bus.registerService('agent:invoke','test',invoke);
  const accepted:AcceptedDispatch={dispatchId:'d',reqId:'req',source:'webhook',acceptedAt:new Date(),row:{
    ...RoutineDefinitionSchema.parse({name:'Job',promptBody:'Review {{payload.title}}',webhook:{kind:'webhook',path:'/hook'}}),
    agentId:'a',routineId:'r',revision:'v',ownerUserId:'owner',definitionId:null,definitionUpdatedAt:null,
    nextRunAt:null,lastRunAt:null,lastStatus:null,lastError:null,lastWarning:null,task:null,noRecentUpdate:null,steps:[],finishBy:null,finishByTimeZone:null,done:null,
  }};
  const finishDispatch=vi.fn(async()=>true);
  const fire=createFireRoutine({bus,pending:new Map(),store:{finishDispatch,bindDispatchConversation:async()=>{},recentReports:async()=>[],recentReplies:async()=>[]},purgeAgent:async()=>{}});
  const output=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
  try {
    expect((await fire(accepted,{title:'PRIVATE app title'})).renderedPrompt).toBeNull();
    await fire.shutdown();
    expect(invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:'owner'}),{message:{role:'user',content:'Review PRIVATE app title'}});
    expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE');
    expect(JSON.stringify(finishDispatch.mock.calls)).not.toContain('PRIVATE');
  } finally {await fire.shutdown();output.mockRestore();}
});
