import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { registerRoutineServices } from '../services.js';
import type { AcceptedDispatch } from '../types.js';
import { fixture, createInput, now } from './store-fixture.js';

const f = fixture();
const ctx = (userId = 'owner') => makeAgentContext({ userId, agentId: 'a', sessionId: 's' });
async function setup(kind: 'stay-on-top' | 'get-done' | 'repeat' = 'stay-on-top') {
  const row = await f.store.createAuthored({ ...createInput(), definition: RoutineDefinitionSchema.parse({
    name: 'Support', promptBody: 'Check support.', kind, goodWhen: kind === 'repeat' ? null : 'No waiting tickets.',
    schedule: { kind: 'interval', every: '1h' }, webhook: null,
  }) });
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test', async () => ({ agent: { id: 'a', ownerType: 'team', ownerId: 't' } }));
  bus.registerService('agents:can-manage-routines', 'test', async () => ({ allowed: true }));
  const dispatched: AcceptedDispatch[] = [];
  registerRoutineServices({ bus, store: f.store, now: () => now, dispatch: async accepted => {
    dispatched.push(accepted);
    await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c${dispatched.length}` });
    return { status: 'ok' };
  } });
  const input = { agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, requestId: 'check' };
  const fire = (request = input, user = 'owner') => bus.call('routines:fire-now', ctx(user), request);
  await fire();
  return { row, input, fire, dispatched };
}

describe('Check now retry after host restart (TASK-964)', () => {
  it.each(['stay-on-top', 'get-done'] as const)('%s retries one interrupted check-in and then replays the running replacement', async kind => {
    const s = await setup(kind);
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    await expect(s.fire()).resolves.toEqual({ status: 'ok' });
    expect(s.dispatched).toHaveLength(2);
    expect(s.dispatched[1]!.dispatchId).not.toBe(s.dispatched[0]!.dispatchId);
    await s.fire();
    expect(s.dispatched).toHaveLength(2);
  });

  it('concurrent retries start only one replacement', async () => {
    const s = await setup();
    await f.store.interruptAbandonedDispatches();
    await Promise.all([s.fire(), s.fire(), s.fire()]);
    expect(s.dispatched).toHaveLength(2);
  });

  it('allows at most three replacements per original request', async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) {
      expect(await f.store.interruptAbandonedDispatches()).toBe(1);
      await s.fire();
      expect(s.dispatched).toHaveLength(Math.min(i + 2, 4));
    }
  });

  it.each(['running', 'finished', 'failed', 'reported'] as const)('%s runs are acknowledged without starting another', async state => {
    const s = await setup();
    const dispatchId = s.dispatched[0]!.dispatchId;
    if (state === 'reported') {
      expect(await f.store.recordReport({ agentId: 'a', dispatchId, conversationId: 'c1', actorUserId: 'owner',
        report: { status: 'on-track', update: 'Read everything.', ask: null }, now })).toBe('recorded');
      await f.store.interruptAbandonedDispatches();
    } else if (state !== 'running') {
      await f.store.finishDispatch({ dispatchId, outcome: { status: state === 'failed' ? 'error' : 'ok',
        conversationId: 'c1', error: state === 'failed' ? 'Setup failed.' : null, renderedPrompt: null, warning: null } });
    }
    await s.fire();
    expect(s.dispatched).toHaveLength(1);
  });

  it('keeps Repeat retries as acknowledgements, without repeating possible side effects', async () => {
    const s = await setup('repeat');
    await f.store.interruptAbandonedDispatches();
    await s.fire();
    expect(s.dispatched).toHaveLength(1);
  });

  it('keeps root request conflicts and owner checks before recovery', async () => {
    const s = await setup();
    await f.store.interruptAbandonedDispatches();
    await expect(s.fire({ ...s.input, expectedRevision: 'different' })).rejects.toMatchObject({ toolCode: 'request-conflict' });
    await expect(s.fire(s.input, 'outsider')).rejects.toMatchObject({ toolCode: 'forbidden' });
    expect(s.dispatched).toHaveLength(1);
  });

  it.each([false, true])('a changed definition (paused=%s) requires a fresh confirmed press', async paused => {
    const s = await setup();
    await f.store.interruptAbandonedDispatches();
    await f.store.updateAuthored({ ...s.input, actorUserId: 'owner', requestId: 'edit',
      patch: paused ? { enabled: false } : { promptBody: 'Changed instructions.' }, now, stopOnly: false });
    await expect(s.fire()).rejects.toMatchObject({ toolCode: 'revision-conflict' });
    expect(s.dispatched).toHaveLength(1);
  });
});
