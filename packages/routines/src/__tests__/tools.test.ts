import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAgentContext, SafeToolError, type ToolCall } from '@ax/core';
import { RoutineDefinitionSchema, RoutineViewSchema, type RoutineView } from '@ax/routines-contract';
import { sql } from 'kysely';
import { createRoutinesStore } from '../store.js';
import { createRoutineHarness, materializePersonalDefaults, type RoutineHarness } from './support/routine-harness.js';

const definition = RoutineDefinitionSchema.parse({ name: 'Daily', promptBody: 'Check outstanding work.', trigger: { kind: 'interval', every: '1h' } });
let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });
const actor = () => makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'conversation' });
const createCall = (requestId = 'new'): ToolCall => ({ id: 'call', name: 'routine_create', input: { requestId, definition } });
async function approve(call: ToolCall, scope = 'once', advance = true) {
  const ctx = actor();
  await h.bus.fire('tool:pre-call', ctx, call);
  const { decisions } = await h.bus.call<unknown, { decisions: Array<{ id: string; call: ToolCall }> }>('decisions:list', ctx, { userId: ctx.userId });
  const decision = decisions.find(d => d.call.input.requestId === call.input.requestId)!;
  await h.bus.call('decisions:approve', ctx, { decisionId: decision.id, userId: ctx.userId, approvalScope: scope });
  if (advance) h.advance(11_000);
  return decision.id;
}
const execute = (call: ToolCall) => h.bus.call<ToolCall, RoutineView>(`tool:execute:${call.name}`, actor(), call);
describe('routine tools through real policy, decisions, agents and database', () => {
  it('registers seven strict host tools without workspace flush or identity inputs', async () => {
    h = await createRoutineHarness();
    expect(h.descriptors.map(d => d.name).sort()).toEqual(['routine_create','routine_delete','routine_fire_now','routine_get','routine_list','routine_report','routine_update']);
    for (const d of h.descriptors) {
      expect(d.executesIn).toBe('host'); expect(d).not.toHaveProperty('flushWorkspace');
      expect(d.inputSchema).toMatchObject({ additionalProperties: false });
      for (const field of ['actor','agentId','ownerUserId','admin','ref','source','payload','secret']) expect(JSON.stringify(d.inputSchema)).not.toContain(`"${field}"`);
    }
  });
  it('rejects direct creation without approval and creates no definition', async () => {
    h = await createRoutineHarness();
    await expect(execute(createCall())).rejects.toMatchObject({ toolCode: 'approval-required' });
    expect((await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', actor(), { agentId: h.agentId })).routines.filter(r => r.origin === 'authored')).toHaveLength(0);
  });
  it('holds before writing and executes an exact approved retry once with safe projections', async () => {
    h = await createRoutineHarness(); await materializePersonalDefaults(h); const call = createCall();
    await approve(call);
    expect((await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', actor(), { agentId: h.agentId })).routines.filter(r => r.origin === 'authored')).toHaveLength(0);
    const row = await execute(call); expect(RoutineViewSchema.parse(row)).toEqual(row);
    expect(await execute(call)).toEqual(row);
    expect(row).not.toHaveProperty('ownerUserId');
  });
});


describe('routine tool validation and durable execution', () => {
  it('rejects malformed input and stale edits before creating decisions', async () => {
    h = await createRoutineHarness();
    for (const input of [{ ...createCall().input as object, ownerUserId: 'admin' }, { requestId: 'bad', definition: { ...definition, trigger: { kind: 'interval', every: '1s' } } }]) {
      await expect(h.bus.fire('tool:pre-call', actor(), { id: 'bad', name: 'routine_create', input })).resolves.toMatchObject({ rejected: true });
    }
    const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
    const stale = { id: 'edit', name: 'routine_update', input: { requestId: 'edit', routineId: row.routineId, expectedRevision: 'stale', patch: { name: 'Changed' } } };
    expect(await h.bus.fire('tool:pre-call', actor(), stale)).toMatchObject({ rejected: true });
    await expect(execute(stale)).rejects.toMatchObject({ toolCode: 'revision-conflict' });
    expect(await h.bus.call('decisions:list', actor(), { userId: h.owner.userId })).toMatchObject({ decisions: [] });
  });
  it('repeats ACL after approval and refuses endpoint/name substitution', async () => {
    h = await createRoutineHarness();
    const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
    const fire = { id: 'fire', name: 'routine_fire_now', input: { requestId: 'fire', routineId: row.routineId, expectedRevision: row.revision } };
    await approve(fire);
    await expect(h.bus.call('tool:execute:routine_delete', actor(), fire)).rejects.toMatchObject({ toolCode: 'validation' });
    const create = createCall(); await approve(create);
    await sql`UPDATE agents_v1_agents SET owner_id='other' WHERE agent_id=${h.agentId}`.execute(h.db);
    await expect(execute(create)).rejects.toThrow();
    expect((await createRoutinesStore(h.db).list({ agentId: h.agentId })).filter(row => row.definitionId === null)).toHaveLength(1);
  });
  it('does not reconcile ownership in preflight; routine_get produces a new editable revision', async () => {
    h = await createRoutineHarness(); const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
    await sql`UPDATE agents_v1_agents SET owner_id='admin' WHERE agent_id=${h.agentId}`.execute(h.db);
    const admin = makeAgentContext({ ...actor(), userId: 'admin' });
    const edit = { id: 'edit', name: 'routine_update', input: { requestId: 'edit', routineId: row.routineId, expectedRevision: row.revision, patch: { name: 'Changed' } } };
    expect(await h.bus.fire('tool:pre-call', admin, edit)).toMatchObject({ rejected: true });
    expect((await createRoutinesStore(h.db).findOne({ agentId: h.agentId, routineId: row.routineId }))?.revision).toBe(row.revision);
    const current = await h.bus.call<unknown, RoutineView>('tool:execute:routine_get', admin, { id: 'get', name: 'routine_get', input: { routineId: row.routineId } });
    expect(current.revision).not.toBe(row.revision);
  });
  it('keeps preflight errors closed under DB outage and corrupted SafeToolError properties', async () => {
    h = await createRoutineHarness();
    const original = h.bus.call.bind(h.bus);
    for (const error of [new Error('SECRET infrastructure'), Object.assign(new SafeToolError('revision-conflict', 'expectedRevision'), { message: 'SECRET', toolCode: 'SECRET', field: 'SECRET' })]) {
      const spy = vi.spyOn(h.bus, 'call').mockImplementation(async (name, ctx, input) => {
        if (name === 'agents:resolve') throw error;
        return original(name, ctx, input);
      });
      const rejection = await h.bus.fire('tool:pre-call', actor(), createCall());
      expect(JSON.stringify(rejection)).not.toContain('SECRET'); expect(rejection).toMatchObject({ rejected: true });
      await expect(execute(createCall())).rejects.toMatchObject({ toolCode: 'unavailable', field: 'input' });
      spy.mockRestore();
    }
    expect(await h.bus.call('decisions:list', actor(), { userId: h.owner.userId })).toMatchObject({ decisions: [] });
  });
  it('creates, reads, patches and deletes without workspace effects; normal pre-call retries reuse approval', async () => {
    h = await createRoutineHarness();
    const callSpy = vi.spyOn(h.bus, 'call'); const call = createCall(); await approve(call);
    const row = await execute(call);
    expect(await h.bus.fire('tool:pre-call', actor(), call)).toEqual({ rejected: false, payload: call });
    expect(await execute(call)).toEqual(row);
    const update = { id: 'edit', name: 'routine_update', input: { requestId: 'edit', routineId: row.routineId, expectedRevision: row.revision, patch: { description: 'Edited', silenceToken: null, enabled: false } } };
    await approve(update); const changed = await execute(update); expect(changed).toMatchObject({ enabled: false, description: 'Edited', name: row.name });
    expect(await execute({ id: 'get', name: 'routine_get', input: { routineId: row.routineId } })).toEqual(changed);
    const del = { id: 'delete', name: 'routine_delete', input: { requestId: 'delete', routineId: row.routineId, expectedRevision: changed.revision } };
    await approve(del); expect(await execute(del)).toEqual({ deleted: true, cleanupPending: false });
    expect(await h.bus.fire('tool:pre-call', actor(), del)).toEqual({ rejected: false, payload: del });
    expect(await execute(del)).toEqual({ deleted: true, cleanupPending: false });
    expect(callSpy.mock.calls.some(([name]) => name.startsWith('workspace:'))).toBe(false);
  });
  it('isolates concurrent authorization contexts and recovers committed CRUD after lost response', async () => {
    h = await createRoutineHarness(); await materializePersonalDefaults(h); const a = createCall('a'), b = createCall('b'); await approve(a); await approve(b);
    const shared = actor(); const contexts: unknown[] = [];
    const original = h.bus.callJoined.bind(h.bus);
    const spy = vi.spyOn(h.bus, 'callJoined').mockImplementation(async (name, ctx, input) => {
      if (name === 'routines:create') {
        contexts.push(ctx); await original(name, ctx, input); throw new Error('SECRET lost reply');
      }
      return original(name, ctx, input);
    });
    const rows = await Promise.all([a,b].map(call => h.bus.call('tool:execute:routine_create', shared, call)));
    expect(rows).toHaveLength(2); expect(contexts[0]).not.toBe(contexts[1]);
    expect(shared.state.has('decisions:routine-execution')).toBe(false);
    expect((await createRoutinesStore(h.db).list({ agentId: h.agentId })).filter(r => r.definitionId === null)).toHaveLength(2);
    spy.mockRestore();
  });
  it('dispatches exact approved fire once and rejects explicit failed dispatch output', async () => {
    h = await createRoutineHarness({ dispatch: true });
    const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
    const call = { id: 'fire', name: 'routine_fire_now', input: { requestId: 'fire', routineId: row.routineId, expectedRevision: row.revision } };
    await approve(call); expect(await execute(call)).toEqual({ status: 'ok' });
    expect(await execute(call)).toEqual({ status: 'ok' }); expect(h.invokeCalls).toHaveLength(1);
    const fail = { ...call, input: { ...call.input, requestId: 'failed-fire' } }; await approve(fail);
    const original = h.bus.callJoined.bind(h.bus);
    vi.spyOn(h.bus, 'callJoined').mockImplementation(async (name, ctx, input) => name === 'routines:fire-now' ? { status: 'error' } : original(name, ctx, input));
    await expect(execute(fail)).rejects.toMatchObject({ toolCode: 'unavailable' });
    const result = await sql<{outcome:string}>`SELECT outcome FROM decisions_v1_routine_authorizations WHERE request_id='failed-fire'`.execute(h.db);
    expect(result.rows[0]?.outcome).toBe('failed');
  });
});


describe('unknown outcomes and exact recovery', () => {
  it('leaves actual host replay pending across commit-ack plus receipt-read outage, then restart recovers exactly once', async () => {
    h = await createRoutineHarness(); h.setAttended(false);
    const call = createCall('lost-ack');
    let originalBinding: unknown;
    let pendingSignal: unknown;
    const original = h.bus.callJoined.bind(h.bus);
    const spy = vi.spyOn(h.bus, 'callJoined').mockImplementation(async (name, ctx, input) => {
      if (name === 'tool:execute:routine_create') {
        try { return await original(name, ctx, input); }
        catch (error) {
          originalBinding = ctx.state.get('decisions:routine-execution');
          const binding = originalBinding as { authorizationId: string };
          pendingSignal = ctx.state.get(`routines:pending-effect:${binding.authorizationId}`);
          throw error;
        }
      }
      const result = await original(name, ctx, input);
      if (name === 'routines:create') {
        await sql`ALTER TABLE routines_v1_requests RENAME TO temporarily_unavailable_requests`.execute(h.db);
        throw new Error('SECRET commit acknowledgment lost');
      }
      return result;
    });
    const id = await approve(call);
    spy.mockRestore();
    expect(originalBinding).toMatchObject({ requestId: 'lost-ack', outcome: null });
    const { outcome: _outcome, ...identity } = originalBinding as Record<string, unknown>;
    expect(pendingSignal).toEqual({ ...identity, agentId: h.agentId, userId: 'owner' });
    const pending = await h.bus.call<unknown, { decision: { routineOutcome: unknown } }>('decisions:get', actor(), { decisionId: id, userId: 'owner' });
    expect(pending.decision.routineOutcome).toBeNull();
    expect((await sql<{outcome:unknown}>`SELECT outcome FROM decisions_v1_routine_authorizations WHERE request_id='lost-ack'`.execute(h.db)).rows[0]?.outcome).toBeNull();
    expect((await createRoutinesStore(h.db).list({ agentId: h.agentId })).filter(row => row.definitionId === null)).toHaveLength(1);
    await sql`ALTER TABLE temporarily_unavailable_requests RENAME TO routines_v1_requests`.execute(h.db);
    h = await h.restart(); h.advance(16 * 60_000);
    await h.bus.call('decisions:sweep', actor(), {});
    const after = await h.bus.call<unknown, { decision: { routineOutcome: unknown } }>('decisions:get', actor(), { decisionId: id, userId: 'owner' });
    expect(after.decision.routineOutcome).toBe('succeeded');
    expect((await createRoutinesStore(h.db).list({ agentId: h.agentId })).filter(row => row.definitionId === null)).toHaveLength(1);
  });
  it('does not turn acceptance-only dispatch receipt into success or reinvoke it after crash', async () => {
    h = await createRoutineHarness({ dispatch: true });
    const store = createRoutinesStore(h.db);
    const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
    const call = { id: 'fire', name: 'routine_fire_now', input: { requestId: 'interrupted', routineId: row.routineId, expectedRevision: row.revision } };
    await approve(call);
    // Model a host crash after durable acceptance and before invoking the turn.
    await h.bus.call('decisions:authorize-routine-call', actor(), { call });
    const accepted = await store.acceptDispatch({ ...call.input, agentId: h.agentId, actorUserId: 'owner', now: new Date(), source: 'manual' });
    h = await h.restart();
    await expect(execute(call)).rejects.toMatchObject({ toolCode: 'unavailable' });
    expect(h.invokeCalls).toHaveLength(0);
    expect((await createRoutinesStore(h.db).getDispatchOutcome({ agentId: h.agentId, dispatchId: accepted!.accepted.dispatchId }))?.status).toBe('error');
    expect((await sql<{outcome:unknown}>`SELECT outcome FROM decisions_v1_routine_authorizations WHERE request_id='interrupted'`.execute(h.db)).rows[0]?.outcome).toBe('failed');
    expect(h.invokeCalls).toHaveLength(0);
  });
});

 describe('dispatch outcome proofs', () => {
  it.each(['ok', 'silenced', 'error'] as const)('recovers caught dispatch %s without invoking twice', async status => {
    h = await createRoutineHarness({ dispatch: true });
    const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
    const call = { id: 'fire', name: 'routine_fire_now', input: { requestId: 'recover-fire', routineId: row.routineId, expectedRevision: row.revision } };
    await approve(call);
    const original = h.bus.callJoined.bind(h.bus);
    vi.spyOn(h.bus, 'callJoined').mockImplementation(async (name, ctx, input) => {
      if (name !== 'routines:fire-now') return original(name, ctx, input);
      const store = createRoutinesStore(h.db);
      const accepted = await store.acceptDispatch({ ...call.input, agentId: h.agentId, actorUserId: 'owner', now: new Date(), source: 'manual' });
      await store.finishDispatch({ dispatchId: accepted!.accepted.dispatchId, outcome: { status, conversationId: null, error: null, renderedPrompt: null, warning: null } });
      throw new Error('SECRET lost reply');
    });
    if (status === 'error') await expect(execute(call)).rejects.toMatchObject({ toolCode: 'unavailable' });
    else expect(await execute(call)).toEqual({ status: 'ok' });
    expect(h.invokeCalls).toHaveLength(0);
    expect((await sql<{outcome:string}>`SELECT outcome FROM decisions_v1_routine_authorizations WHERE request_id='recover-fire'`.execute(h.db)).rows[0]?.outcome).toBe(status === 'error' ? 'failed' : 'succeeded');
  });
  it('preserves an acknowledged dispatch success when a later turn fails', async () => {
    h = await createRoutineHarness({ dispatch: true });
    const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
    const call = { id: 'fire', name: 'routine_fire_now', input: { requestId: 'acknowledged', routineId: row.routineId, expectedRevision: row.revision } };
    await approve(call);
    expect(await execute(call)).toEqual({ status: 'ok' });
    await sql`UPDATE routines_v1_fires SET status='error' WHERE agent_id=${h.agentId}`.execute(h.db);
    expect(await h.bus.fire('tool:pre-call', actor(), call)).toEqual({ rejected: false, payload: call });
    expect(await execute(call)).toEqual({ status: 'ok' });
    expect(h.invokeCalls).toHaveLength(1);
  });
 });

it('keeps a caught acceptance-only fire pending in its original invocation context', async () => {
  h = await createRoutineHarness({ dispatch: true });
  const row = await h.bus.call<unknown, RoutineView>('routines:create', actor(), { agentId: h.agentId, requestId: 'manual', definition });
  const call = { id: 'fire', name: 'routine_fire_now', input: { requestId: 'uncertain-fire', routineId: row.routineId, expectedRevision: row.revision } };
  await approve(call);
  const original = h.bus.callJoined.bind(h.bus);
  const spy = vi.spyOn(h.bus, 'callJoined').mockImplementation(async (name, ctx, input) => {
    if (name !== 'routines:fire-now') return original(name, ctx, input);
    await createRoutinesStore(h.db).acceptDispatch({ ...call.input, agentId: h.agentId, actorUserId: 'owner', now: new Date(), source: 'manual' });
    throw new Error('SECRET uncertain dispatch');
  });
  const parent = actor();
  await expect(h.bus.call('tool:execute:routine_fire_now', parent, call)).rejects.toMatchObject({ toolCode: 'unavailable' });
  spy.mockRestore();
  const authority = (await sql<{ authorization_id: string; outcome: unknown }>`SELECT authorization_id, outcome FROM decisions_v1_routine_authorizations WHERE request_id='uncertain-fire'`.execute(h.db)).rows[0]!;
  expect(authority.outcome).toBeNull();
  expect(parent.state.get(`routines:pending-effect:${authority.authorization_id}`)).toMatchObject({ requestId: 'uncertain-fire', agentId: h.agentId, userId: 'owner' });
  expect(parent.state.has('decisions:routine-execution')).toBe(false);
  expect(await h.bus.fire('tool:pre-call', actor(), call)).toEqual({ rejected: false, payload: call });
  await expect(execute(call)).rejects.toMatchObject({ toolCode: 'unavailable' });
  expect(h.invokeCalls).toHaveLength(0);
});

it('rejects authored edits to defaults before approval while allowing default reads and approved fire', async () => {
  h = await createRoutineHarness({ dispatch: true });
  const store = createRoutinesStore(h.db);
  await store.materializeMissing({ agents: [{ agentId: h.agentId, ownerUserId: 'owner' }], now: new Date() });
  const row = (await store.list({ agentId: h.agentId })).find(row => row.definitionId !== null)!;
  expect(await execute({ id: 'get', name: 'routine_get', input: { routineId: row.routineId } })).toMatchObject({ origin: 'default' });
  for (const name of ['routine_update', 'routine_delete']) {
    const call = { id: name, name, input: { routineId: row.routineId, requestId: name, expectedRevision: row.revision, ...(name === 'routine_update' ? { patch: { enabled: false } } : {}) } };
    expect((await h.bus.fire('tool:pre-call', actor(), call)).rejected).toBe(true);
    await expect(execute(call)).rejects.toMatchObject({ toolCode: 'forbidden' });
  }
  expect(await h.bus.call('decisions:list', actor(), { userId: 'owner' })).toMatchObject({ decisions: [] });
  const fire = { id: 'fire', name: 'routine_fire_now', input: { requestId: 'default-fire', routineId: row.routineId, expectedRevision: row.revision } };
  await approve(fire);
  expect(await execute(fire)).toEqual({ status: 'ok' });
  expect(h.invokeCalls).toHaveLength(1);
});

it('fails closed before raising a hold when the validation receipt database is unavailable', async () => {
  h = await createRoutineHarness();
  await sql`ALTER TABLE routines_v1_requests RENAME TO temporarily_unavailable_requests`.execute(h.db);
  const call = createCall('db-down');
  const rejected = await h.bus.fire('tool:pre-call', actor(), call);
  expect(rejected.rejected).toBe(true);
  expect(JSON.stringify(rejected)).not.toContain('routines_v1');
  await expect(execute(call)).rejects.toMatchObject({ toolCode: 'unavailable' });
  expect(await h.bus.call('decisions:list', actor(), { userId: 'owner' })).toMatchObject({ decisions: [] });
});


it('settles confirmed absent receipts failed after an ordinary joined pre-commit error', async () => {
  h = await createRoutineHarness();
  h.setAttended(false);
  const call = createCall('pre-commit-failure');
  const original = h.bus.callJoined.bind(h.bus);
  let effectAttempts = 0;
  const spy = vi.spyOn(h.bus, 'callJoined').mockImplementation(async (name, ctx, input) => {
    if (name === 'routines:create') {
      effectAttempts++;
      throw new Error('SECRET database transaction could not start');
    }
    return original(name, ctx, input);
  });
  const id = await approve(call);
  const authority = (await sql<{outcome: string; failure_code: string}>`SELECT outcome, failure_code FROM decisions_v1_routine_authorizations WHERE request_id='pre-commit-failure'`.execute(h.db)).rows[0];
  expect(authority).toEqual({ outcome: 'failed', failure_code: 'unavailable' });
  expect((await sql`SELECT request_id FROM routines_v1_requests WHERE request_id='pre-commit-failure'`.execute(h.db)).rows).toHaveLength(0);
  const result = await h.bus.call<unknown, { decision: { status: string; routineOutcome: string; routineFailureCode: string; replayedAt: unknown } }>('decisions:get', actor(), { decisionId: id, userId: 'owner' });
  expect(result.decision).toMatchObject({ status: 'failed', routineOutcome: 'failed', routineFailureCode: 'unavailable', replayedAt: null });
  expect(JSON.stringify(result)).not.toContain('SECRET');
  await expect(execute(call)).rejects.toMatchObject({ toolCode: 'unavailable', field: 'input' });
  h.advance(16 * 60_000);
  await h.bus.call('decisions:sweep', actor(), {});
  expect(effectAttempts).toBe(1);
  expect((await createRoutinesStore(h.db).list({ agentId: h.agentId })).filter(row => row.definitionId === null)).toHaveLength(0);
  spy.mockRestore();
});
