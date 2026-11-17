import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext, type ToolCall } from '@ax/core';
import * as C from '@ax/routines-contract';
import { registerRoutineTools } from '../tools.js';
import type { RoutinesStore } from '../store.js';

// TASK-1122. An outsider's turn (`source: 'external'`: a channel turn by
// someone with no access to the agent) changes none of the agent's routines.
// The turn runs as the person who connected the channel, and routine consent
// is theirs, so without this an outsider's text could become a routine that
// runs later, unattended, as them. Reads stay. Docker-free: a bare bus, spies
// for every service the tools call, and a store that records every method
// anything asks it for.

/** What the model reads for the refusal: `safeToolMessage('forbidden', 'input')`. */
const FORBIDDEN = 'This operation is not allowed for this person and agent. Field: input';

/** One valid input per write tool, so a refusal here is never the input's fault. */
const WRITES = {
  routine_create: { requestId: 'r1', definition: { name: 'Daily', promptBody: 'Check outstanding work.', trigger: { kind: 'interval', every: '1h' } } },
  routine_update: { requestId: 'r2', routineId: 'rt_1', expectedRevision: 'rev_1', patch: { enabled: false } },
  routine_delete: { requestId: 'r3', routineId: 'rt_1', expectedRevision: 'rev_1' },
  routine_fire_now: { requestId: 'r3', routineId: 'rt_1', expectedRevision: 'rev_1' },
} as const;
const WRITE_TOOLS = Object.keys(WRITES) as (keyof typeof WRITES)[];

const turn = (fields: Pick<AgentContext, 'source' | 'audience'>): AgentContext =>
  makeAgentContext({ agentId: 'a', userId: 'connector', conversationId: 'c', sessionId: 's', ...fields });
/** What channel-slack stamps on an outsider's turn. */
const outsider = turn({ source: 'external', audience: 'shared' });
const callOf = (name: string, input: unknown): ToolCall => ({ id: `call-${name}`, name, input });

async function harness() {
  const bus = new HookBus();
  const spies = {
    resolve: vi.fn(async () => ({ agent: { ownerType: 'team', ownerId: 't1' } })),
    canManage: vi.fn(async () => ({ allowed: true })),
    rejectUnstarted: vi.fn(async () => ({ recorded: true })),
    authorize: vi.fn(async () => ({ authorizationId: 'auth', requestId: 'r1' })),
    list: vi.fn(async () => ({ routines: [] })),
  };
  bus.registerService('tool:register', 'test', async () => ({}));
  bus.registerService('agents:resolve', 'test', spies.resolve);
  bus.registerService('agents:can-manage-routines', 'test', spies.canManage);
  bus.registerService('decisions:reject-unstarted-routine-call', 'test', spies.rejectUnstarted);
  bus.registerService('decisions:authorize-routine-call', 'test', spies.authorize);
  bus.registerService('routines:list', 'test', spies.list);
  // Every store method is a spy that answers null (no receipt, no routine) and
  // records its name, so "the store was never asked" covers methods this file
  // doesn't know about too.
  const storeCalls: string[] = [];
  const store = new Proxy({} as RoutinesStore, {
    get: (_target, method) => typeof method === 'string' && method !== 'then'
      ? vi.fn(async () => { storeCalls.push(method); return null; })
      : undefined,
  });
  await registerRoutineTools({ bus, store, now: () => new Date(0) });
  const untouched = () => {
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(storeCalls).toEqual([]);
  };
  return { bus, spies, storeCalls, untouched };
}

describe('an outsider’s turn can’t change the agent’s routines (TASK-1122)', () => {
  it.each(WRITE_TOOLS)('an outsider’s %s is refused at pre-call before any ACL, store or decisions call', async name => {
    expect(C.RoutineToolInputSchemas[name].safeParse(WRITES[name]).success).toBe(true);
    const h = await harness();
    const result = await h.bus.fire('tool:pre-call', outsider, callOf(name, WRITES[name]));
    expect(result).toMatchObject({ rejected: true, reason: FORBIDDEN, source: '@ax/routines' });
    h.untouched();
  });

  it.each(WRITE_TOOLS)('an outsider’s %s is refused at execute before any ACL, store or decisions call', async name => {
    const h = await harness();
    await expect(h.bus.call(`tool:execute:${name}`, outsider, callOf(name, WRITES[name])))
      .rejects.toMatchObject({ toolCode: 'forbidden', field: 'input' });
    h.untouched();
  });

  it.each(WRITE_TOOLS)('an outsider’s malformed %s is refused, not validated', async name => {
    const h = await harness();
    const call = callOf(name, {});
    expect(C.RoutineToolInputSchemas[name].safeParse(call.input).success).toBe(false);
    expect(await h.bus.fire('tool:pre-call', outsider, call)).toMatchObject({ rejected: true, reason: FORBIDDEN });
    await expect(h.bus.call(`tool:execute:${name}`, outsider, call)).rejects.toMatchObject({ toolCode: 'forbidden', field: 'input' });
    h.untouched();
  });

  it('a source this build doesn’t know is refused too', async () => {
    const h = await harness();
    const unknown = turn({ source: 'visitor' as never, audience: 'shared' });
    const call = callOf('routine_create', WRITES.routine_create);
    expect(await h.bus.fire('tool:pre-call', unknown, call)).toMatchObject({ rejected: true, reason: FORBIDDEN });
    await expect(h.bus.call('tool:execute:routine_create', unknown, call)).rejects.toMatchObject({ toolCode: 'forbidden', field: 'input' });
    h.untouched();
  });

  it.each([
    ['routine_list', {}],
    ['routine_get', { routineId: 'rt_1' }],
  ] as const)('an outsider can still read routines: %s passes pre-call', async (name, input) => {
    const h = await harness();
    expect(await h.bus.fire('tool:pre-call', outsider, callOf(name, input))).toMatchObject({ rejected: false });
    expect(h.spies.resolve).toHaveBeenCalledTimes(1);
  });

  it('an outsider can still list routines', async () => {
    const h = await harness();
    await expect(h.bus.call('tool:execute:routine_list', outsider, callOf('routine_list', {}))).resolves.toEqual({ routines: [] });
    expect(h.spies.list).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a member’s channel turn', turn({ source: 'user', audience: 'shared' })],
    ['a routine run', turn({ source: 'routine' })],
    ['an unsourced turn', turn({})],
  ] as const)('%s passes this gate', async (_label, ctx) => {
    const h = await harness();
    await h.bus.fire('tool:pre-call', ctx, callOf('routine_create', WRITES.routine_create));
    // Past the gate, the create goes on to ask who may manage routines.
    expect(h.spies.resolve).toHaveBeenCalledTimes(1);
  });
});
