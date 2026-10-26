import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { RoutineDefinitionSchema, type RoutinePatch } from '@ax/routines-contract';
import { registerRoutineServices } from '../services.js';
import { registerRoutineTools } from '../tools.js';
import { updateRequestHash } from '../definition.js';
import type { OperationKey, RoutinesStore } from '../store.js';
import type { StoredRoutine } from '../types.js';

/** A persisted actor-scoped receipt; actual service and tool handlers decide its authority. */
async function recoveryHarness({ owner = 'teammate', after = { allowed: true, stopOthers: false }, responseLost = false, patch = { enabled: false } }: {
  owner?: string; after?: { allowed: boolean; stopOthers: boolean }; responseLost?: boolean; patch?: RoutinePatch;
} = {}) {
  const bus = new HookBus();
  let authority = { allowed: true, stopOthers: true };
  const settlements: unknown[] = [];
  const refusals: unknown[] = [];
  let lostResponses = 0;
  const actor = 'previous-admin';
  const row: StoredRoutine = {
    ...RoutineDefinitionSchema.parse({ name: 'Teammate task', promptBody: 'Check the queue.', trigger: { kind: 'interval', every: '1h' }, enabled: false }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    agentId: 'team-agent', routineId: 'saved-task', revision: 'stopped-revision', ownerUserId: owner,
    definitionId: null, definitionUpdatedAt: null, nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null,
    task: null, noRecentUpdate: null, steps: [], finishBy: null, finishByTimeZone: null, done: null,
  };
  const input = { routineId: row.routineId, expectedRevision: 'original-revision', requestId: 'persisted-operation', patch };
  const findReceipt = vi.fn(async (key: OperationKey) => {
    expect(key).toMatchObject({ agentId: row.agentId, actorUserId: actor, operation: 'update', requestId: input.requestId,
      inputHash: updateRequestHash({ ...input, agentId: row.agentId }) });
    return row;
  });
  const store = { findOperationReceipt: findReceipt } as unknown as RoutinesStore;
  bus.registerService('agents:resolve', 'test', async () => ({ agent: { id: row.agentId, ownerType: 'team', ownerId: 'team' } }));
  bus.registerService('agents:can-manage-routines', 'test', async () => authority);
  bus.registerService('tool:register', 'test', async () => ({}));
  const authorize = vi.fn(async (ctx, { call }) => {
    // Preparation saw the earlier authority. The service and recovery must use this current answer.
    authority = after;
    ctx.state.set('decisions:routine-execution', { authorizationId: 'authorization', requestId: call.input.requestId, fingerprint: 'fingerprint', outcome: null });
    return { authorizationId: 'authorization', requestId: call.input.requestId };
  });
  bus.registerService('decisions:authorize-routine-call', 'test', authorize);
  bus.registerService('decisions:settle-routine-call', 'test', async (_ctx, result) => { settlements.push(result); });
  registerRoutineServices({ bus, store, now: () => new Date() });
  await registerRoutineTools({ bus, store, now: () => new Date() });
  const originalJoined = bus.callJoined.bind(bus);
  vi.spyOn(bus, 'callJoined').mockImplementation(async (name, ...args) => {
    try {
      const result = await originalJoined(name, ...args);
      if (name === 'routines:update' && responseLost) { lostResponses++; throw new Error('response lost after the persisted result'); }
      return result;
    } catch (error) {
      if (name === 'routines:update' && error !== null && typeof error === 'object' && 'toolCode' in error) refusals.push(error.toolCode);
      throw error;
    }
  });
  const ctx = makeAgentContext({ userId: actor, agentId: row.agentId, sessionId: 'session' });
  return {
    settlements, refusals, findReceipt, authorize, lostResponses: () => lostResponses,
    execute: () => bus.call('tool:execute:routine_update', ctx, { id: 'call', name: 'routine_update', input }),
    direct: () => bus.call('routines:update', ctx, { ...input, agentId: row.agentId }),
  };
}

describe('current row authority during routine effect recovery', () => {
  it('does not convert a live stop refusal into success when an admin is demoted after preparation', async () => {
    const h = await recoveryHarness();
    await expect(h.execute()).rejects.toMatchObject({ toolCode: 'forbidden' });
    expect(h.refusals).toEqual(['forbidden']);
    expect(h.settlements).toEqual([{ authorizationId: 'authorization', outcome: 'failed', failureCode: 'forbidden' }]);
    await expect(h.direct()).rejects.toMatchObject({ toolCode: 'forbidden' });
  });
  it('does not recover an owner edit when current management authority is refused', async () => {
    const h = await recoveryHarness({ owner: 'previous-admin', after: { allowed: false, stopOthers: false } });
    await expect(h.execute()).rejects.toMatchObject({ toolCode: 'forbidden' });
    expect(h.settlements).toEqual([{ authorizationId: 'authorization', outcome: 'failed', failureCode: 'forbidden' }]);
  });
  it('still recovers a legitimate privileged stop after its response is lost', async () => {
    const h = await recoveryHarness({ after: { allowed: true, stopOthers: true }, responseLost: true });
    await expect(h.execute()).resolves.toMatchObject({ ownedByCaller: false, permissions: { edit: false, stop: true } });
    expect(h.lostResponses()).toBe(1);
    expect(h.findReceipt).toHaveBeenCalledTimes(3);
    expect(h.settlements).toEqual([{ authorizationId: 'authorization', outcome: 'succeeded' }]);
  });
  it('still recovers the ordinary owner’s full edit after demotion and a lost response', async () => {
    const h = await recoveryHarness({ owner: 'previous-admin', responseLost: true, patch: { description: 'Updated' } });
    await expect(h.execute()).resolves.toMatchObject({ ownedByCaller: true, description: 'Updated', permissions: { edit: true } });
    expect(h.lostResponses()).toBe(1);
    expect(h.settlements).toEqual([{ authorizationId: 'authorization', outcome: 'succeeded' }]);
  });
  it.each([{ enabled: false, name: 'Teammate task' }, { enabled: false, description: 'Updated' }])('requires edit authority when a stop includes other fields: %j', async patch => {
    const h = await recoveryHarness({ patch, after: { allowed: true, stopOthers: true } });
    await expect(h.execute()).rejects.toMatchObject({ toolCode: 'forbidden' });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.settlements).toEqual([]);
  });
});
