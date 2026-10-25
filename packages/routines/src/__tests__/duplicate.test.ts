import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineDuplicateOutput } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { logged } from './support/report-log.js';
import { registerRoutineServices } from '../services.js';
import type { RoutinesStore } from '../store.js';
import type { DuplicateResult } from '../types.js';

// TASK-953: `routines:duplicate`, over routines' real store and Postgres. A task's owner copies it from its task page,
// when they may manage the agent's tasks: routines:create's rule, plus `edit` on the source. agents:resolve runs first,
// then the service reads the source, and the store decides the owner again under its locks. The answer is the copy's
// id alone; the log line carries ids and whether it was a retry, never the task's name or steps.
const f = fixture();

const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
type Key = { agentId: string; routineId: string };
/** A task 'owner' owns ('editor' made it). Each create needs its own request id: createInput's default would replay. */
const createTask = (requestId = 'task', definition = GET_DONE) => f.store.createAuthored({ ...createInput(requestId), definition });
const copyOf = (row: Key, requestId = 'copy') => ({ agentId: row.agentId, routineId: row.routineId, requestId });
/** Every routine on the agent, by id. */
const routineIds = async () => (await f.store.list({ agentId: 'a' })).map(row => row.routineId).sort();

/**
 * The hook on a bus whose agents:resolve refuses anyone outside `reach`, over the real store with `store`'s
 * methods swapped in. `order` records agents:resolve and each duplicateAuthored, as they run.
 */
function services({ reach = ['owner', 'editor', 'teammate'], allowed = true, store: swapped = {} }: {
  reach?: readonly string[]; allowed?: boolean; store?: Partial<RoutinesStore>;
} = {}) {
  const order: string[] = [];
  const bus = new HookBus();
  bus.registerService<{ agentId: string; userId: string }, unknown>('agents:resolve', 'test', async (_ctx, input) => {
    order.push('agents:resolve');
    if (!reach.includes(input.userId)) throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'not yours' });
    // A team agent: a personal one would make reconcileOwners rewrite every routine's owner, and a copy the agent owner's.
    return { agent: { id: 'a', ownerType: 'team', ownerId: 'team-1' } };
  });
  bus.registerService('agents:can-manage-routines', 'test', async () => ({ allowed }));
  const store = f.store;
  registerRoutineServices({
    bus, now: () => now,
    store: { ...store, async duplicateAuthored(input) { order.push('duplicateAuthored'); return store.duplicateAuthored(input); }, ...swapped },
  });
  // Each context keeps its own log lines, so a run prints none.
  const as = (userId: string) => logged(makeAgentContext({ userId, agentId: 'a', sessionId: 's' })).ctx;
  const duplicate = (input: unknown, ctx: AgentContext = as('owner')) => bus.call<unknown, RoutineDuplicateOutput>('routines:duplicate', ctx, input);
  return { order, duplicate, as };
}

describe('routines:duplicate (TASK-953)', () => {
  it("the owner copies a task, and the answer is the copy's id alone", async () => {
    const task = await createTask();
    const s = services();
    const answer = await s.duplicate(copyOf(task));
    expect(answer).toStrictEqual({ routineId: expect.stringMatching(/^rtn_/) });
    expect(answer.routineId).not.toBe(task.routineId);
    expect(s.order).toEqual(['agents:resolve', 'duplicateAuthored']);
    // The caller's, on a team agent, as routines:create's routine is: not the team's.
    expect(await f.store.findOne({ agentId: 'a', routineId: answer.routineId }))
      .toMatchObject({ ownerUserId: 'owner', enabled: false, name: 'Copy of Move the help docs' });
  });

  it('the same request again answers the same copy; another request makes another', async () => {
    const task = await createTask();
    const s = services();
    const first = await s.duplicate(copyOf(task, 'q1'));
    // A press whose answer never came, pressed again.
    expect(await s.duplicate(copyOf(task, 'q1'))).toStrictEqual(first);
    const second = await s.duplicate(copyOf(task, 'q2'));
    expect(second.routineId).not.toBe(first.routineId);
    expect(await routineIds()).toEqual([task.routineId, first.routineId, second.routineId].sort());
  });

  it("only the task's owner who may manage the agent's tasks copies it, and the store is never asked otherwise", async () => {
    const task = await createTask();
    // The owner, who no longer manages the agent's tasks: refused as routines:create refuses, before the task is read,
    // so a missing one is the same refusal.
    const unmanaged = services({ allowed: false });
    for (const row of [task, { agentId: 'a', routineId: 'rtn_missing' }]) {
      await expect(unmanaged.duplicate(copyOf(row, `q-${row.routineId}`)), row.routineId)
        .rejects.toMatchObject({ toolCode: 'forbidden', field: 'input' });
    }
    expect(unmanaged.order).toEqual(['agents:resolve', 'agents:resolve']);
    // Someone who manages the agent's tasks and sees the task but doesn't own it; and the person who made it.
    const s = services();
    for (const person of ['teammate', 'editor']) {
      await expect(s.duplicate(copyOf(task, `q-${person}`), s.as(person)), person).rejects.toMatchObject({ toolCode: 'forbidden', field: 'input' });
    }
    expect(s.order).toEqual(['agents:resolve', 'agents:resolve']);
    expect(await routineIds()).toEqual([task.routineId]);
  });

  it('someone agents:resolve refuses is refused before anything is read', async () => {
    const task = await createTask();
    // The task's owner, who can no longer reach the agent.
    const s = services({ reach: [] });
    await expect(s.duplicate(copyOf(task))).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.order).toEqual(['agents:resolve']);
    expect(await routineIds()).toEqual([task.routineId]);
  });

  it('a repeat routine and a missing task are not-found', async () => {
    // The caller's own repeat routine: they may edit it, so the store is asked, and refuses a kind that has no copy.
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const s = services();
    await expect(s.duplicate(copyOf(repeat))).rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
    expect(s.order).toEqual(['agents:resolve', 'duplicateAuthored']);
    // A missing one is refused by the service's own read, before the store is asked.
    const missing = services();
    await expect(missing.duplicate(copyOf({ agentId: 'a', routineId: 'rtn_missing' }))).rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
    expect(missing.order).toEqual(['agents:resolve']);
    expect(await routineIds()).toEqual([repeat.routineId]);
  });

  it('a default is forbidden, as routines:update refuses it, and the store is never asked', async () => {
    const { defaultRoutineId } = await f.store.upsertDefault({ ...createInput().definition, name: 'copy-check', trigger: { kind: 'interval', every: '60s' } });
    await f.store.materializeMissing({ agents: [{ agentId: 'a', ownerUserId: 'owner' }], now });
    const materialized = (await f.store.list({ agentId: 'a' })).find(row => row.definitionId === defaultRoutineId)!;
    expect(materialized.ownerUserId).toBe('owner');
    const before = await routineIds();
    const s = services();
    // No one edits a default (routinePermissions), not even its owner. The store's own not-found is the locked re-check.
    await expect(s.duplicate(copyOf(materialized))).rejects.toMatchObject({ toolCode: 'forbidden', field: 'input' });
    expect(s.order).toEqual(['agents:resolve']);
    expect(await routineIds()).toEqual(before);
  });

  it('an input the contract refuses is a validation error, and nothing is asked', async () => {
    const task = await createTask();
    const s = services();
    const refused: Array<[label: string, input: unknown]> = [
      ['a name of its own', { ...copyOf(task), name: 'Mine' }],
      ['an empty request id', copyOf(task, '')],
      ['no request id', { agentId: 'a', routineId: task.routineId }],
    ];
    for (const [label, input] of refused) {
      await expect(s.duplicate(input), label).rejects.toMatchObject({ toolCode: 'validation' });
    }
    expect(s.order).toEqual([]);
    expect(await routineIds()).toEqual([task.routineId]);
  });

  it("the store's refusals under its locks are the service's own", async () => {
    // The task changed hands, or stopped being a task, between the service's read and the store's lock.
    const task = await createTask();
    const refusals = [['forbidden', { toolCode: 'forbidden', field: 'input' }], ['not-found', { toolCode: 'not-found', field: 'routineId' }]] as const;
    for (const [refusal, expected] of refusals) {
      const s = services({ store: { duplicateAuthored: async () => refusal } });
      await expect(s.duplicate(copyOf(task)), refusal).rejects.toMatchObject(expected);
    }
  });

  it("answers the copy's id alone, whatever else the store hands over", async () => {
    // A real task: the service reads it before the store is asked.
    const task = await createTask();
    const s = services({ store: { duplicateAuthored: async () => ({ routineId: 'rtn_x', replayed: false, name: 'Copy of Move the help docs' }) as DuplicateResult } });
    expect(await s.duplicate(copyOf(task))).toStrictEqual({ routineId: 'rtn_x' });
  });

  it('logs one line per copy, ids only, and says when it was a retry', async () => {
    const task = await createTask('task', { ...GET_DONE, name: 'Refund QX7731' });
    // A step holds the code too.
    expect(await f.store.setSteps({ agentId: 'a', routineId: task.routineId, actorUserId: 'owner', requestId: 'step', ops: [{ op: 'add', text: 'Send refund QX7731' }] }))
      .toMatchObject({ skipped: 0 });
    const s = services();
    const KEYS = ['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'copyId', 'replayed'];
    const entries = (lines: readonly string[]) => lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.msg === 'routines_task_duplicated');
    const first = logged(s.as('owner'));
    const answer = await s.duplicate(copyOf(task), first.ctx);
    // The same request again: a replay, logged the same way, and says so (routines_steps_set's rule).
    const retry = logged(s.as('owner'));
    expect(await s.duplicate(copyOf(task), retry.ctx)).toStrictEqual(answer);
    const line = { level: 'info', agentId: 'a', routineId: task.routineId, copyId: answer.routineId };
    expect(entries(first.lines)).toEqual([expect.objectContaining({ ...line, replayed: false })]);
    expect(entries(retry.lines)).toEqual([expect.objectContaining({ ...line, replayed: true })]);
    for (const lines of [first.lines, retry.lines]) {
      for (const entry of entries(lines)) for (const key of Object.keys(entry)) expect(KEYS, key).toContain(key);
    }
    // The copy holds the code, in its name and its step; no line does.
    expect(await f.store.findOne({ agentId: 'a', routineId: answer.routineId }))
      .toMatchObject({ name: 'Copy of Refund QX7731', steps: [{ text: 'Send refund QX7731' }] });
    expect([...first.lines, ...retry.lines].join('\n')).not.toContain('QX7731');
  });
});
