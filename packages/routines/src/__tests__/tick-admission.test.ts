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

it('leaves a task timer and concurrent app nudge to its locked acceptance transaction', async () => {
  const now = new Date('2031-01-01T00:01:00Z');
  const row: StoredRoutine = {
    ...RoutineDefinitionSchema.parse({ name: 'Task', promptBody: 'Keep up', kind: 'stay-on-top', goodWhen: 'All clear', schedule: { kind: 'interval', every: '1h' } }),
    agentId: 'a', routineId: 'r', revision: 'v', ownerUserId: 'owner', definitionId: null, definitionUpdatedAt: null,
    nextRunAt: new Date(now.getTime() + 5 * 60_000), lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null,
    task: null, noRecentUpdate: null, steps: [], finishBy: null, finishByTimeZone: null, done: null,
  };
  const advance = vi.fn(async () => {}), fire = vi.fn(async () => ({ status: 'ok' as const, error: null, renderedPrompt: null }));
  const accepted = { dispatchId: 'd', reqId: 'req', row, source: 'tick' as const, acceptedAt: now };
  await runTickOnce({
    store: { claimDue: async () => [row], acceptDispatch: async () => ({ accepted, replayed: false }), advance } as unknown as RoutinesStore,
    fire, now, claimBatchSize: 50, claimWindowMinutes: 5,
  });
  expect(advance).not.toHaveBeenCalled();
  expect(fire).toHaveBeenCalledExactlyOnceWith(accepted);
});

it('does not overwrite a finishing task timer after a busy accept', async () => {
  const now = new Date('2031-01-01T00:01:00Z');
  const row = { ...RoutineDefinitionSchema.parse({ name: 'Task', promptBody: 'Keep up', kind: 'stay-on-top', goodWhen: 'All clear', schedule: { kind: 'interval', every: '1h' } }),
    agentId: 'a', routineId: 'r', revision: 'v', ownerUserId: 'owner', definitionId: null, definitionUpdatedAt: null,
    nextRunAt: new Date(now.getTime() + 5 * 60_000), lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null,
    task: null, noRecentUpdate: null, steps: [], finishBy: null, finishByTimeZone: null, done: null };
  const advance = vi.fn(), fire = vi.fn();
  await runTickOnce({ store: { claimDue: async () => [row], acceptDispatch: async () => { throw new SafeToolError('busy', 'routineId'); }, advance } as unknown as RoutinesStore, fire, now, claimBatchSize: 50, claimWindowMinutes: 5 });
  expect(advance).not.toHaveBeenCalled();
  expect(fire).not.toHaveBeenCalled();
});

it.each([false, true])('keeps app checks in work hours while an explicit queued reply can run now: requested=%s', async requested => {
  const now = new Date('2031-01-01T00:01:00Z');
  const row = { ...RoutineDefinitionSchema.parse({ name: 'Task', promptBody: 'Keep up', kind: 'stay-on-top', goodWhen: 'All clear', schedule: { kind: 'interval', every: '1h' }, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } }),
    agentId: 'a', routineId: 'r', revision: 'v', ownerUserId: 'owner', definitionId: null, definitionUpdatedAt: null,
    nextRunAt: new Date(now.getTime() + 5 * 60_000), lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null,
    task: null, noRecentUpdate: null, steps: [], finishBy: null, finishByTimeZone: null, done: null };
  const advance = vi.fn(), fire = vi.fn();
  const accepted = { dispatchId: 'd', reqId: 'req', row, source: 'tick' as const, acceptedAt: now };
  await runTickOnce({ store: { claimDue: async () => [row], hasTaskCheckInRequest: async () => requested, acceptDispatch: async () => ({ accepted, replayed: false }), advance } as unknown as RoutinesStore, fire, now, claimBatchSize: 50, claimWindowMinutes: 5 });
  if (requested) { expect(fire).toHaveBeenCalledExactlyOnceWith(accepted); expect(advance).not.toHaveBeenCalled(); }
  else {
    expect(fire).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledExactlyOnceWith({ agentId: 'a', routineId: 'r', expectedRevision: 'v', nextRunAt: new Date('2031-01-01T09:00:00Z') });
  }
});
