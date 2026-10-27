import { expect, it, vi } from 'vitest';
import { SafeToolError } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { runTickOnce } from '../tick.js';
import type { RoutinesStore } from '../store.js';
import type { StoredRoutine } from '../types.js';

it('re-arms a busy schedule without overwriting a concurrent terminal run time', async () => {
  const now = new Date('2031-01-01T00:01:00Z');
  const row: StoredRoutine = {
    ...RoutineDefinitionSchema.parse({name:'Job',promptBody:'Review',schedule:{kind:'interval',every:'60s'}}),
    agentId:'a',routineId:'r',revision:'v',ownerUserId:'owner',definitionId:null,definitionUpdatedAt:null,
    nextRunAt:new Date(now.getTime()+5*60_000),lastRunAt:null,lastStatus:null,lastError:null,lastWarning:null,
    task:null,noRecentUpdate:null,steps:[],finishBy:null,finishByTimeZone:null,done:null,
  };
  const advance=vi.fn(async()=>{}),fire=vi.fn();
  await runTickOnce({
    store:{claimDue:async()=>[row],acceptDispatch:async()=>{throw new SafeToolError('busy','routineId');},advance} as unknown as RoutinesStore,
    fire,now,claimBatchSize:50,claimWindowMinutes:5,
  });
  expect(fire).not.toHaveBeenCalled();
  expect(advance).toHaveBeenCalledExactlyOnceWith({agentId:'a',routineId:'r',expectedRevision:'v',nextRunAt:now});
});
