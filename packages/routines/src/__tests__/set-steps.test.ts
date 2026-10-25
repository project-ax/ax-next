import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineSetStepsOutput, type RoutineStepOp } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { logged } from './support/report-log.js';
import { registerRoutineServices } from '../services.js';
import type { RoutinesStore } from '../store.js';
import type { StoredStep } from '../types.js';

// TASK-949: `routines:set-steps`, over routines' real store and Postgres. A task's owner changes its steps on its
// task page, whether or not they still manage the agent's tasks. agents:resolve runs first, then the store decides
// ownership under the routine's row lock. The answer is each step, field by field, and a count; the log line carries
// ids and counts, never a step's text.
const f = fixture();

const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
const STAY_ON_TOP = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
type Key = { agentId: string; routineId: string };
/** A task 'owner' owns ('editor' made it). Each create needs its own request id: createInput's default would replay. */
const createTask = (requestId = 'task', definition = GET_DONE) => f.store.createAuthored({ ...createInput(requestId), definition });
const ADD = { op: 'add', text: 'Ask Dana to review billing' } as const;
const changeOf = (row: Key, requestId: string, ops: readonly RoutineStepOp[]) => ({ agentId: row.agentId, routineId: row.routineId, requestId, ops });
const stepsOf = async (row: Key) => (await f.store.findOne(row))?.steps;

/**
 * The hook on a bus whose agents:resolve refuses anyone outside `reach`, over the real store with `store`'s
 * methods swapped in. `order` records agents:resolve and each setSteps, as they run.
 */
function services({ reach = ['owner', 'editor', 'teammate'], allowed = true, store: swapped = {} }: {
  reach?: readonly string[]; allowed?: boolean; store?: Partial<RoutinesStore>;
} = {}) {
  const order: string[] = [];
  const bus = new HookBus();
  bus.registerService<{ agentId: string; userId: string }, unknown>('agents:resolve', 'test', async (_ctx, input) => {
    order.push('agents:resolve');
    if (!reach.includes(input.userId)) throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'not yours' });
    // A team agent: a personal one would make reconcileOwners rewrite every routine's owner.
    return { agent: { id: 'a', ownerType: 'team', ownerId: 'team-1' } };
  });
  bus.registerService('agents:can-manage-routines', 'test', async () => ({ allowed }));
  const store = f.store;
  registerRoutineServices({
    bus, now: () => now,
    store: { ...store, async setSteps(input) { order.push('setSteps'); return store.setSteps(input); }, ...swapped },
  });
  // Each context keeps its own log lines, so a run prints none.
  const as = (userId: string) => logged(makeAgentContext({ userId, agentId: 'a', sessionId: 's' })).ctx;
  const setSteps = (input: unknown, ctx: AgentContext = as('owner')) => bus.call<unknown, RoutineSetStepsOutput>('routines:set-steps', ctx, input);
  return { order, setSteps, as };
}

describe('routines:set-steps (TASK-949)', () => {
  it('the owner adds a step, and it is theirs', async () => {
    const task = await createTask();
    const s = services();
    const answer = await s.setSteps(changeOf(task, 'q1', [ADD]));
    expect(answer).toStrictEqual({ steps: [{ id: expect.stringMatching(/^s[0-9a-z]{6}$/), text: ADD.text, done: false, addedBy: 'person' }], skipped: 0 });
    expect(s.order).toEqual(['agents:resolve', 'setSteps']);
    expect(await stepsOf(task)).toEqual(answer.steps);
  });

  it("only the owner may, whether or not they manage the agent's tasks, and not even who made it", async () => {
    const task = await createTask();
    // The owner, who no longer manages the agent's tasks.
    expect(await services({ allowed: false }).setSteps(changeOf(task, 'q1', [ADD]))).toMatchObject({ skipped: 0 });
    const s = services();
    for (const person of ['teammate', 'editor']) {
      await expect(s.setSteps(changeOf(task, `q-${person}`, [{ op: 'add', text: `From ${person}` }]), s.as(person)), person)
        .rejects.toMatchObject({ toolCode: 'forbidden' });
    }
    expect((await stepsOf(task))?.map(step => step.text)).toEqual([ADD.text]);
  });

  it('someone agents:resolve refuses is refused before the store is asked, though they own the task', async () => {
    const task = await createTask();
    // The task's owner, who can no longer reach the agent.
    const s = services({ reach: [] });
    await expect(s.setSteps(changeOf(task, 'q1', [ADD]))).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.order).toEqual(['agents:resolve']);
    expect(await stepsOf(task)).toEqual([]);
  });

  it('a Done task’s steps are refused as forbidden, and stay as they were (TASK-950)', async () => {
    const task = await createTask();
    const s = services();
    await s.setSteps(changeOf(task, 'q1', [ADD]));
    expect(await f.store.completeTask({
      agentId: task.agentId, routineId: task.routineId, actorUserId: 'owner', requestId: 'done', mayEdit: true, now,
    })).toEqual({ done: true });
    const [added] = (await stepsOf(task))!;
    await expect(s.setSteps(changeOf(task, 'q2', [{ op: 'tick', id: added!.id }])))
      .rejects.toMatchObject({ toolCode: 'forbidden' });
    expect(await stepsOf(task)).toEqual([added]);
  });

  it('a stay-on-top task, a repeat routine and a missing one are not-found', async () => {
    const stayOnTop = await createTask('stay', STAY_ON_TOP);
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const s = services();
    for (const row of [stayOnTop, repeat, { agentId: 'a', routineId: 'rtn_missing' }]) {
      await expect(s.setSteps(changeOf(row, `q-${row.routineId}`, [ADD])), row.routineId)
        .rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
    }
  });

  it('a change the contract refuses is a validation error, and the store is never asked', async () => {
    const task = await createTask();
    const s = services();
    const refused: Array<[label: string, ops: unknown]> = [
      ['a blank text', [{ op: 'add', text: ' ' }]],
      ['51 changes', Array(51).fill(ADD)],
      ['who added it', [{ ...ADD, addedBy: 'person' }]],
    ];
    for (const [label, ops] of refused) {
      await expect(s.setSteps({ agentId: 'a', routineId: task.routineId, requestId: 'q1', ops }), label).rejects.toMatchObject({ toolCode: 'validation' });
    }
    expect(s.order).toEqual([]);
    expect(await stepsOf(task)).toEqual([]);
  });

  it("the answer carries each step's four fields and nothing else", async () => {
    const task = await createTask();
    // A step as a later store might hand it over, with a field this version doesn't show.
    const stored = { id: 's000001', text: 'Export every article', done: true, addedBy: 'agent', note: 'from a later version' } as StoredStep;
    const s = services({ store: { setSteps: async () => ({ steps: [stored], skipped: 1, replayed: false }) } });
    expect(await s.setSteps(changeOf(task, 'q1', [{ op: 'tick', id: 's000001' }])))
      .toStrictEqual({ steps: [{ id: 's000001', text: 'Export every article', done: true, addedBy: 'agent' }], skipped: 1 });
  });

  it('logs one line per change, ids and counts only', async () => {
    const task = await createTask();
    const s = services();
    const KEYS = ['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'ops', 'skipped', 'replayed'];
    const change = changeOf(task, 'q1', [{ op: 'add', text: 'The refund code is QX7731.' }]);
    const entries = (lines: readonly string[]) => lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.msg === 'routines_steps_set');
    const first = logged(s.as('owner'));
    const answer = await s.setSteps(change, first.ctx);
    // The same request again: a replay, logged the same way, and says so (routines_reply_added's rule).
    const retry = logged(s.as('owner'));
    expect(await s.setSteps(change, retry.ctx)).toStrictEqual(answer);
    expect(entries(first.lines)).toEqual([expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId, ops: 1, skipped: 0, replayed: false })]);
    expect(entries(retry.lines)).toEqual([expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId, ops: 1, skipped: 0, replayed: true })]);
    for (const lines of [first.lines, retry.lines]) {
      for (const entry of entries(lines)) for (const key of Object.keys(entry)) expect(KEYS, key).toContain(key);
    }
    expect([...first.lines, ...retry.lines].join('\n')).not.toContain('QX7731');
  });
});
