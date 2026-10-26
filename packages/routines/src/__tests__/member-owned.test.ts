import { afterEach, describe, expect, it } from 'vitest';
import { makeAgentContext, type AgentContext } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { createRoutinesStore } from '../store.js';
import { preflightRoutineCall } from '../tools.js';

let h: RoutineHarness;
afterEach(async () => { await h?.close(); });
const definition = (kind: 'repeat' | 'stay-on-top' = 'repeat') => RoutineDefinitionSchema.parse({
  name: 'My task', promptBody: 'Check the queue.', trigger: { kind: 'interval', every: '1h' }, kind,
  goodWhen: kind === 'repeat' ? null : 'No work is waiting.',
});
const ctx = (user: AgentContext) => makeAgentContext({ ...user, agentId: h.teamAgentId, conversationId: 'member-chat' });
const create = (user: AgentContext, kind: 'repeat' | 'stay-on-top' = 'repeat') => h.bus.call<unknown, RoutineView>('routines:create', ctx(user), {
  agentId: h.teamAgentId, requestId: `create-${kind}`, definition: definition(kind),
});

describe('member-owned tasks on a team agent', () => {
  it.each(['repeat', 'stay-on-top'] as const)('keeps %s creation, controls and private state with its creator', async kind => {
    h = await createRoutineHarness();
    const row = await create(h.teamMember, kind);
    const key = { agentId: h.teamAgentId, routineId: row.routineId, expectedRevision: row.revision };
    expect(row).toMatchObject({ ownedByCaller: true, permissions: { edit: true, stop: true, fire: true, manageSecret: true } });
    expect((await createRoutinesStore(h.db).findOne(key))?.ownerUserId).toBe('member');
    const peer = makeAgentContext({ ...h.teamMember, userId: 'peer' });
    const otherView = await h.bus.call<unknown, RoutineView>('routines:get', ctx(peer), { agentId: key.agentId, routineId: key.routineId });
    expect(otherView).toMatchObject({ ownedByCaller: false, task: null, steps: [], permissions: { edit: false, stop: false, fire: false, manageSecret: false } });
    for (const user of [peer, h.teamAdmin]) {
      await expect(h.bus.call('routines:update', ctx(user), { ...key, requestId: 'edit', patch: { promptBody: 'Different work' } })).rejects.toMatchObject({ toolCode: 'forbidden' });
      await expect(h.bus.call('routines:fire-now', ctx(user), { ...key, requestId: 'fire' })).rejects.toMatchObject({ toolCode: 'forbidden' });
      await expect(h.bus.call('routines:set-webhook-secret', ctx(user), { ...key, operation: 'set', secret: new Uint8Array([1]) })).rejects.toMatchObject({ toolCode: 'forbidden' });
    }
    await expect(h.bus.call('routines:update', ctx(peer), { ...key, requestId: 'stop', patch: { enabled: false } })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:delete', ctx(peer), { ...key, requestId: 'delete' })).rejects.toMatchObject({ toolCode: 'forbidden' });
    const stopped = await h.bus.call<unknown, RoutineView>('routines:update', ctx(h.teamAdmin), { ...key, requestId: 'admin-stop', patch: { enabled: false } });
    expect(stopped).toMatchObject({ enabled: false, ownedByCaller: false, permissions: { stop: true, edit: false, fire: false } });
    await expect(h.bus.call('routines:update', ctx(h.teamAdmin), { ...key, expectedRevision: stopped.revision, requestId: 'resume', patch: { enabled: true } })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:delete', ctx(h.teamAdmin), { ...key, expectedRevision: stopped.revision, requestId: 'admin-delete' })).resolves.toMatchObject({ deleted: true });
  });

  it('does not reuse an administrator’s stop receipt after demotion', async () => {
    h = await createRoutineHarness();
    const row = await create(h.owner);
    const input = { agentId: h.teamAgentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'stop', patch: { enabled: false } };
    const admin = ctx(h.teamAdmin);
    await h.bus.call('routines:update', admin, input);
    h.setTeamRole('admin', 'member');
    await expect(h.bus.call('routines:update', admin, input)).rejects.toMatchObject({ toolCode: 'forbidden' });
    const { agentId: _agentId, ...toolInput } = input;
    await expect(preflightRoutineCall({ bus: h.bus, store: createRoutinesStore(h.db), ctx: admin, call: { id: 'stop-again', name: 'routine_update', input: toolInput } })).rejects.toMatchObject({ toolCode: 'forbidden' });
    const current = await h.bus.call<unknown, RoutineView>('routines:get', admin, { agentId: input.agentId, routineId: input.routineId });
    await expect(h.bus.call('routines:delete', admin, { agentId: input.agentId, routineId: input.routineId, expectedRevision: current.revision, requestId: 'delete' })).rejects.toMatchObject({ toolCode: 'forbidden' });
  });

  it('invokes as the member creator and rechecks membership before the next dispatch', async () => {
    const invoked: string[] = [];
    h = await createRoutineHarness({ invoke: async (runCtx, bus) => {
      invoked.push(runCtx.userId);
      await bus.fire('chat:turn-end', runCtx, { reqId: runCtx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
      return { kind: 'complete' };
    } });
    const row = await create(h.teamMember);
    const input = { agentId: h.teamAgentId, routineId: row.routineId, expectedRevision: row.revision };
    await h.bus.call('routines:fire-now', ctx(h.teamMember), { ...input, requestId: 'first' });
    await expect.poll(() => invoked).toEqual(['member']);
    await expect.poll(async () => (await createRoutinesStore(h.db).recentFires({ ...input, actorUserId: 'member' }))[0]?.status).toBe('ok');
    h.setTeamRole('member', null);
    const store = createRoutinesStore(h.db);
    const accepted = await store.acceptDispatch({ ...input, actorUserId: 'member', requestId: 'late-webhook', source: 'webhook', now: new Date() });
    expect(accepted).not.toBeNull();
    // The actual fire.ts path must re-resolve the saved owner, even for an already accepted webhook.
    const { createFireRoutine } = await import('../fire.js');
    const fire = createFireRoutine({ bus: h.bus, store, pending: new Map(), purgeAgent: async () => {} });
    try { expect(await fire(accepted!.accepted)).toMatchObject({ status: 'error' }); }
    finally { await fire.shutdown(); }
    expect(invoked).toEqual(['member']);
  });
});
